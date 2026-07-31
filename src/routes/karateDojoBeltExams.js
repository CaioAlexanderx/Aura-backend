// ============================================================
// AURA DOJÔ — F8.1: O EXAME DE FAIXA DO DOJÔ (rotas)
//
// Montado sob /federation/:id (padrão karateDojoStudents / karateDojoFederativo).
// Guard: requireDojoAccess (Canal A = JWT da conta do dojô com dojo_id;
// Canal B = token do portal). REGRA DE CANAL, a mesma do resto do Aura
// Dojô: GETs aceitam A e B; toda ESCRITA exige Canal A — o portal é
// somente leitura (403 PORTAL_READ_ONLY).
//
//   GET    /federation/:id/dojo/belt-ladder
//   POST   /federation/:id/dojo/graduation-exams
//   GET    /federation/:id/dojo/graduation-exams            (?status=&page=&pageSize=)
//   GET    /federation/:id/dojo/graduation-exams/:examId
//   PATCH  /federation/:id/dojo/graduation-exams/:examId    (só enquanto draft)
//   POST   /federation/:id/dojo/graduation-exams/:examId/cancel
//   POST   /federation/:id/dojo/graduation-exams/:examId/results
//   GET    /federation/:id/dojo/graduation-exams/:examId/attachments
//   POST   /federation/:id/dojo/graduation-exams/:examId/attachments
//   DELETE /federation/:id/dojo/graduation-exams/:examId/attachments/:docId
//
// ── POR QUE "graduation-exams" E NÃO "belt-exams" ──────────
// /dojo/belt-exams/:examId/candidates JÁ EXISTE (karateDojoFederativo.js) e
// significa o OPOSTO: o dojô submetendo candidatos à BANCA DA FEDERAÇÃO.
// Reusar o prefixo colocaria dois atos contrários debaixo do mesmo path e
// dependeria da ordem de montagem para não colidir. Prefixo distinto:
// o exame do DOJÔ é /dojo/graduation-exams.
//
// ── SEM GATE DE CONEXÃO, DE PROPÓSITO ──────────────────────
// Todas as rotas da F5b exigem dojô conectado (409 DOJO_NAO_CONECTADO)
// porque certificado/evento/banca são atos DA FEDERAÇÃO. O exame do dojô
// NÃO é: o sensei gradua os próprios alunos, e a 264 deixou
// karate_dojo_belt_exams.federation_id NULLABLE exatamente por isso ("dojô
// sem filiação também gradua os próprios alunos"). O que depende de
// conexão é só o PEDIDO DE CERTIFICADO — e ali a falta de conexão volta
// como motivo POR ALUNO na resposta, nunca como 409 que anularia uma
// graduação que já aconteceu no tatame.
//
// ── O ANEXO ────────────────────────────────────────────────
// Reusa karate_documents (migration 207) + R2 (src/utils/r2Storage.js) —
// o MESMO mecanismo do anexo de dojô/praticante. owner_type
// 'dojo_belt_exam' (migration 265), owner_id = id do exame: a ficha de
// exame é do LOTE, não de um aluno. Vários arquivos por exame.
//
// dojo_id e federation_id vêm SEMPRE do token (req.dojoId/req.federationId),
// nunca do corpo/query.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoBeltExamService');
const { uploadToR2, getSignedUrl, deleteFromR2, generateDocKey } = require('../utils/r2Storage');

// ── Limites do anexo, e por quê ────────────────────────────
// TAMANHO: 7 MB de base64 (~5 MB binário) — o MESMO teto de
// karateDocuments.js. Um segundo teto para o mesmo bucket, na mesma
// tabela, seria um segundo mecanismo disfarçado de constante.
// QUANTIDADE: 10 por exame, 5 por requisição. O anexo é a ficha do lote
// mais os comprovantes; teto existe para o R2 não virar depósito e para o
// GET do exame não virar uma página de 40 URLs assinadas.
// TIPO: o que sai de um scanner ou de um celular. Nada executável, nada
// de arquivo que o navegador do operador possa abrir como código.
const MAX_BASE64_LENGTH = 7 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 5;
const MAX_FILES_PER_EXAM = 10;
const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];
const OWNER_TYPE = 'dojo_belt_exam';

// Canal B (portal) é SOMENTE LEITURA. Checado ANTES de qualquer db.query:
// lançar graduação é ato do dono da conta e o motivo do 403 não depende de
// estado nenhum do banco.
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error:
        'O portal do dojô é somente leitura. Entre com a conta do dojô para criar exames ou lançar graduações.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function actor(req) {
  return {
    createdBy: (req.user && req.user.id) || null,
    createdByName: (req.user && (req.user.name || req.user.email)) || null,
  };
}

// ── Mapeamento de erro (mesma régua de karateDojoFederativo.js) ──
//   42P01 → a RELAÇÃO não existe: migration pendente de verdade. 503.
//   42703 → coluna ausente numa tabela que EXISTE: quase sempre a NOSSA
//           SQL divergindo do schema. 500 com código próprio e o texto do
//           Postgres — nunca "indisponível no momento", que mandaria o
//           operador esperar uma migration que já rodou.
// Em qualquer caminho: SEMPRE console.error. Escrita que falha em silêncio
// foi a causa do P0 de 27/07 (nenhum pedido de certificado por 3 meses).
function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.error(`[karateDojoBeltExams] ${ctx}: SCHEMA_PENDING (${e.code}):`, e.message);
    return res.status(503).json({
      error: 'Exame do dojô indisponível no momento (migration 264 pendente)',
      code: 'SCHEMA_PENDING',
      pg_code: '42P01',
    });
  }
  if (e && e.code === '42703') {
    console.error(
      `[karateDojoBeltExams] ${ctx}: 42703 — consulta cita coluna inexistente (SQL divergente do schema):`,
      e.message
    );
    return res.status(500).json({
      error: 'Falha ao gravar: uma consulta do servidor não bate com o schema do banco. Nada foi registrado.',
      code: 'SQL_SCHEMA_MISMATCH',
      pg_code: '42703',
      detail: e.message,
    });
  }
  if (e && e.code === '23514') {
    // CHECK do banco. O único que o produto consegue provocar é o
    // karate_dojo_exam_results_no_black_belt_check — e o service já
    // recusa antes. Se chegou aqui, é bug nosso: diga isso.
    console.error(`[karateDojoBeltExams] ${ctx}: 23514 CHECK violado:`, e.message);
    return res.status(422).json({
      error: 'O banco recusou a graduação (restrição de integridade). Nada foi registrado.',
      code: 'CHECK_VIOLATION',
      detail: e.message,
    });
  }
  console.error(`[karateDojoBeltExams] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR', pg_code: (e && e.code) || null });
}

// Leitura degrada (lista vazia + schema_pending) em vez de 5xx — tela em
// branco com aviso é melhor que erro vermelho quando falta migration.
// Mas 42703 numa leitura vai para o log como ERRO, não como aviso.
function handleReadError(res, e, ctx, extra) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.warn(`[karateDojoBeltExams] ${ctx}: schema pendente (${e.code}):`, e.message);
    return res.json(Object.assign({ data: [], count: 0, schema_pending: true }, extra || {}));
  }
  if (e && e.code === '42703') {
    console.error(`[karateDojoBeltExams] ${ctx}: 42703 — SQL divergente do schema:`, e.message);
    return res.json(Object.assign({ data: [], count: 0, schema_pending: true, pg_code: '42703' }, extra || {}));
  }
  console.error(`[karateDojoBeltExams] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

// ============================================================
// 0) A ESCADA — o que o sensei pode conceder
// ============================================================
// Rota ESTÁTICA e de 1 segmento; não colide com /dojo/graduation-exams/*.
router.get('/dojo/belt-ladder', requireDojoAccess, (req, res) => {
  const out = svc.beltLadder();
  return res.json({
    data: out.data,
    count: out.data.length,
    schema: out.schema,
    ceiling: out.ceiling,
    ceiling_reason: out.ceiling_reason,
  });
});

// ============================================================
// 1) CICLO DO EXAME
// ============================================================

// ── POST /dojo/graduation-exams ──
// { exam_date, title?, examiner_name?, notes? } → 201 { exam }
router.post('/dojo/graduation-exams', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const exam = await svc.createExam({
      dojoId: req.dojoId,
      federationId: req.federationId,
      body: req.body,
      ...actor(req),
    });
    return res.status(201).json({ exam });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/graduation-exams');
  }
});

// ── GET /dojo/graduation-exams ──
router.get('/dojo/graduation-exams', requireDojoAccess, async (req, res) => {
  try {
    const out = await svc.listExams(req.dojoId, {
      status: req.query.status,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return res.json({ data: out.data, count: out.data.length, page: out.page, pageSize: out.pageSize });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/graduation-exams');
  }
});

// ── GET /dojo/graduation-exams/:examId ──
router.get('/dojo/graduation-exams/:examId', requireDojoAccess, async (req, res) => {
  try {
    const out = await svc.getExam({ dojoId: req.dojoId, examId: req.params.examId });
    // Anexo é acessório da ficha: se a tabela ainda não existe (207/265
    // pendentes) a ficha do exame NÃO pode cair junto.
    const attachments = await listAttachments(req.federationId, req.params.examId).catch((e) => {
      console.warn('[karateDojoBeltExams] anexos indisponíveis na ficha do exame:', e && e.code, e && e.message);
      return [];
    });
    return res.json({ exam: out.exam, results: out.results, count: out.results.length, attachments });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/graduation-exams/:examId', { exam: null, results: [] });
  }
});

// ── PATCH /dojo/graduation-exams/:examId ── (só enquanto draft)
router.patch('/dojo/graduation-exams/:examId', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const out = await svc.updateExam({ dojoId: req.dojoId, examId: req.params.examId, body: req.body });
    return res.json({ exam: out.exam, results: out.results, count: out.results.length });
  } catch (e) {
    return handleWriteError(res, e, 'PATCH /dojo/graduation-exams/:examId');
  }
});

// ── POST /dojo/graduation-exams/:examId/cancel ──
router.post('/dojo/graduation-exams/:examId/cancel', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const out = await svc.cancelExam({ dojoId: req.dojoId, examId: req.params.examId });
    return res.json({ exam: out.exam, results: out.results, count: out.results.length });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/graduation-exams/:examId/cancel');
  }
});

// ============================================================
// 2) O LANÇAMENTO DO RESULTADO EM LOTE
// ============================================================
// {
//   results: [{ student_id, result:'approved'|'failed',
//               to_belt_level, to_belt_kyu?, request_certificate?, notes? }],
//   delivery?: { delivery_type, addr_* , observacao }   // só p/ certificado
// }
//
// 200 { exam, completed, results[], summary }
// 422 { errors: [{student_id, code, message}] } — NADA gravado.
//
// Diferente dos lotes da F5b, aqui um item inválido recusa o LOTE inteiro
// (ver a justificativa em planResults): a faixa de destino é uma DECISÃO do
// sensei que ele corrige na hora, e um exame meio-concluído deixaria metade
// da turma graduada com o exame marcado como concluído.
router.post('/dojo/graduation-exams/:examId/results', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const out = await svc.submitResults({
      dojoId: req.dojoId,
      federationId: req.federationId,
      examId: req.params.examId,
      body: req.body,
      ...actor(req),
    });
    return res.json(out);
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/graduation-exams/:examId/results');
  }
});

// ============================================================
// 3) ANEXO DO ENVIO À FEDERAÇÃO
// ============================================================

function isMissingTableOrColumn(err) {
  return Boolean(err && (err.code === '42P01' || err.code === '42703'));
}

async function listAttachments(federationId, examId) {
  const { rows } = await db.query(
    `-- f81:list-attachments
     SELECT id, r2_key, filename, content_type, size_bytes, note, uploaded_by, created_at
       FROM karate_documents
      WHERE federation_id = $1 AND owner_type = $2 AND owner_id = $3
      ORDER BY created_at DESC`,
    [federationId, OWNER_TYPE, examId]
  );
  return Promise.all(
    (rows || []).map(async (d) => ({
      id: d.id,
      filename: d.filename,
      content_type: d.content_type || null,
      size_bytes: d.size_bytes != null ? Number(d.size_bytes) : null,
      note: d.note || null,
      uploaded_by: d.uploaded_by || null,
      created_at: d.created_at,
      download_url: await getSignedUrl(d.r2_key),
    }))
  );
}

// O corpo aceita UM arquivo ({content, filename, ...}) ou VÁRIOS
// ({files:[...]}) — a ficha de exame costuma vir junto com o comprovante,
// e obrigar o front a fazer N chamadas para um ato só é atrito à toa.
function normalizeFiles(body) {
  const b = body || {};
  if (Array.isArray(b.files)) return b.files.map((f) => f || {});
  if (b.content || b.filename) return [b];
  return [];
}

function validateFile(f, idx) {
  const where = `arquivo ${idx + 1}`;
  const filename = f && f.filename != null ? String(f.filename).trim() : '';
  if (!filename) return { status: 422, code: 'VALIDATION_ERROR', error: `${where}: filename é obrigatório` };
  if (!f.content || typeof f.content !== 'string') {
    return { status: 422, code: 'VALIDATION_ERROR', error: `${where}: content (base64) é obrigatório` };
  }
  const ct = f.content_type != null ? String(f.content_type).trim().toLowerCase() : '';
  if (!ct) {
    return {
      status: 422,
      code: 'CONTENT_TYPE_OBRIGATORIO',
      error: `${where}: informe content_type (${ALLOWED_CONTENT_TYPES.join(', ')})`,
    };
  }
  if (ALLOWED_CONTENT_TYPES.indexOf(ct) === -1) {
    return {
      status: 422,
      code: 'TIPO_NAO_PERMITIDO',
      error: `${where}: tipo "${ct}" não permitido. Envie PDF ou imagem (${ALLOWED_CONTENT_TYPES.join(', ')})`,
    };
  }
  if (f.content.length > MAX_BASE64_LENGTH) {
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      error: `${where}: excede o tamanho máximo permitido (~5MB)`,
    };
  }
  return { ok: true, filename, content_type: ct, note: f.note != null ? String(f.note).trim() || null : null };
}

// ── GET /dojo/graduation-exams/:examId/attachments ──
router.get('/dojo/graduation-exams/:examId/attachments', requireDojoAccess, async (req, res) => {
  try {
    const exam = await svc.loadExam(req.dojoId, req.params.examId);
    if (!exam) return res.status(404).json({ error: 'Exame não encontrado neste dojô', code: 'EXAME_NAO_ENCONTRADO' });
    const data = await listAttachments(req.federationId, exam.id);
    return res.json({ data, count: data.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/graduation-exams/:examId/attachments');
  }
});

// ── POST /dojo/graduation-exams/:examId/attachments ──
// Aceita durante o rascunho E depois de concluído: a ficha assinada
// costuma ser digitalizada DEPOIS do exame, e recusá-la aí deixaria o
// envio à federação sem comprovante para sempre. Só exame CANCELADO recusa.
router.post('/dojo/graduation-exams/:examId/attachments', requireDojoAccess, requireChannelA, async (req, res) => {
  const files = normalizeFiles(req.body);
  if (!files.length) {
    return res.status(422).json({
      error: 'Envie content + filename, ou files: [{content, filename, content_type}]',
      code: 'VALIDATION_ERROR',
    });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return res.status(422).json({
      error: `Máximo de ${MAX_FILES_PER_REQUEST} arquivos por envio`,
      code: 'VALIDATION_ERROR',
    });
  }

  // Valida TODOS antes de subir qualquer byte: metade dos arquivos no R2 e
  // um 422 na cara do sensei é pior que nenhum arquivo.
  const checked = [];
  for (let i = 0; i < files.length; i++) {
    const v = validateFile(files[i], i);
    if (!v.ok) return res.status(v.status).json({ error: v.error, code: v.code });
    checked.push(Object.assign({}, v, { content: files[i].content }));
  }

  try {
    const exam = await svc.loadExam(req.dojoId, req.params.examId);
    if (!exam) return res.status(404).json({ error: 'Exame não encontrado neste dojô', code: 'EXAME_NAO_ENCONTRADO' });
    if (exam.status === 'cancelled') {
      return res.status(409).json({ error: 'Exame cancelado — não aceita anexo', code: 'EXAME_CANCELADO' });
    }

    let existing = 0;
    try {
      const { rows } = await db.query(
        `-- f81:count-attachments
         SELECT count(*)::int AS n
           FROM karate_documents
          WHERE federation_id = $1 AND owner_type = $2 AND owner_id = $3`,
        [req.federationId, OWNER_TYPE, exam.id]
      );
      existing = Number(rows && rows[0] && rows[0].n) || 0;
    } catch (err) {
      if (!isMissingTableOrColumn(err)) throw err;
      return res.status(503).json({
        error: 'Anexos ainda não disponíveis (migrations 207/265 pendentes)',
        code: 'MIGRATION_PENDING',
      });
    }
    if (existing + checked.length > MAX_FILES_PER_EXAM) {
      return res.status(422).json({
        error: `Este exame já tem ${existing} anexo(s). Máximo de ${MAX_FILES_PER_EXAM} por exame.`,
        code: 'LIMITE_DE_ANEXOS',
      });
    }

    const created = [];
    for (const f of checked) {
      const key = generateDocKey(req.federationId, `karate_dojo_belt_exam_${exam.id}`, f.filename);
      const up = await uploadToR2(key, f.content, f.content_type);
      if (!up.success) {
        console.error('[karateDojoBeltExams] upload R2 falhou:', up.error);
        return res.status(502).json({ error: 'Erro no upload do anexo: ' + up.error, code: 'UPLOAD_FAILED', created });
      }

      let ins;
      try {
        ins = await db.query(
          `-- f81:insert-attachment
           INSERT INTO karate_documents
             (federation_id, owner_type, owner_id, r2_key, filename, content_type, size_bytes, note, uploaded_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
           RETURNING id, filename, content_type, size_bytes, note, uploaded_by, created_at`,
          [
            req.federationId,
            OWNER_TYPE,
            exam.id,
            up.key,
            f.filename,
            f.content_type,
            up.size || null,
            f.note,
            (req.user && req.user.id) || null,
          ]
        );
      } catch (err) {
        if (err && err.code === '23514') {
          // O CHECK de owner_type ainda não conhece 'dojo_belt_exam'.
          // Diagnóstico exato em vez de "erro interno".
          console.error(
            '[karateDojoBeltExams] karate_documents.owner_type recusou dojo_belt_exam (migration 265 pendente)'
          );
          return res.status(503).json({
            error: 'Anexo do exame ainda não disponível (migration 265 pendente)',
            code: 'MIGRATION_PENDING',
            pg_code: '23514',
          });
        }
        if (isMissingTableOrColumn(err)) {
          return res.status(503).json({
            error: 'Anexos ainda não disponíveis (migration 207 pendente)',
            code: 'MIGRATION_PENDING',
          });
        }
        throw err;
      }

      const doc = ins.rows[0];
      const item = {
        id: doc.id,
        filename: doc.filename,
        content_type: doc.content_type || null,
        size_bytes: doc.size_bytes != null ? Number(doc.size_bytes) : null,
        note: doc.note || null,
        uploaded_by: doc.uploaded_by || null,
        created_at: doc.created_at,
      };
      if (up.mock) item.storage_mock = true;
      created.push(item);
    }

    return res.status(201).json({ created: created.length, data: created });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/graduation-exams/:examId/attachments');
  }
});

// ── DELETE /dojo/graduation-exams/:examId/attachments/:docId ──
router.delete(
  '/dojo/graduation-exams/:examId/attachments/:docId',
  requireDojoAccess,
  requireChannelA,
  async (req, res) => {
    try {
      const exam = await svc.loadExam(req.dojoId, req.params.examId);
      if (!exam) {
        return res.status(404).json({ error: 'Exame não encontrado neste dojô', code: 'EXAME_NAO_ENCONTRADO' });
      }

      let docRes;
      try {
        docRes = await db.query(
          `-- f81:load-attachment
           SELECT id, r2_key FROM karate_documents
            WHERE id = $1 AND federation_id = $2 AND owner_type = $3 AND owner_id = $4
            LIMIT 1`,
          [req.params.docId, req.federationId, OWNER_TYPE, exam.id]
        );
      } catch (err) {
        if (isMissingTableOrColumn(err)) {
          return res.status(503).json({ error: 'Anexos ainda não disponíveis', code: 'MIGRATION_PENDING' });
        }
        throw err;
      }
      if (!docRes.rows || !docRes.rows.length) {
        return res.status(404).json({ error: 'Anexo não encontrado', code: 'NOT_FOUND' });
      }

      // Defensivo (mesmo padrão de karateDocuments.js): se o R2 falhar, o
      // metadado ainda sai — um arquivo órfão no bucket é menos ruim que uma
      // linha apontando para algo que o operador não consegue remover.
      try {
        const del = await deleteFromR2(docRes.rows[0].r2_key);
        if (!del.success) console.error('[karateDojoBeltExams] R2 delete falhou (segue removendo metadado):', del.error);
      } catch (err) {
        console.error('[karateDojoBeltExams] R2 delete lançou (segue removendo metadado):', err.message);
      }

      await db.query(
        `-- f81:delete-attachment
         DELETE FROM karate_documents WHERE id = $1`,
        [req.params.docId]
      );
      return res.json({ deleted: true, id: req.params.docId });
    } catch (e) {
      return handleWriteError(res, e, 'DELETE /dojo/graduation-exams/:examId/attachments/:docId');
    }
  }
);

module.exports = router;

// ── Exportado SÓ para teste ────────────────────────────────
// Os limites do anexo são contrato de produto (ver o bloco no topo), mas
// verificar o teto de 7 MB por HTTP obrigaria a montar uma string de 7 MB
// dentro do Jest — e é assim que este repo já derrubou o CI por OOM
// (exit 134, heap limit, zero teste falhando). A regra é testada na
// função pura; o caminho HTTP é testado com os casos baratos.
module.exports.__validateFile = validateFile;
module.exports.__attachmentLimits = {
  MAX_BASE64_LENGTH,
  MAX_FILES_PER_REQUEST,
  MAX_FILES_PER_EXAM,
  ALLOWED_CONTENT_TYPES,
};
