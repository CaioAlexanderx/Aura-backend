// ============================================================
// AURA DOJÔ — F8.1: O EXAME DE FAIXA DO DOJÔ (lógica)
//
// ── A REGRA DE NEGÓCIO, CORRIGIDA PELO DONO DO PRODUTO (31/07/2026) ──
//
//   "No exame de faixa (branca até marrom) é o SENSEI que realiza; ele
//    apenas envia o resultado dos aprovados para a federação emitir o
//    certificado. A federação usa banca apenas para exame de faixa preta."
//
// O sistema inteiro assumia o contrário. O cabeçalho de
// src/routes/karateDojoFederativo.js diz literalmente "O DOJÔ NUNCA
// GRADUA" — e isso está CERTO para o dan e ERRADO para os kyus. Este
// service é o lado que faltava: o dojô gradua até o 1º kyu (Marrom 1º
// kyu) e a federação continua sendo a única a homologar faixa preta.
//
// O QUE NÃO MUDA (e este arquivo não toca):
//   karateDojoFederativo.js POST /dojo/belt-exams/:examId/candidates —
//   o dojô SUBMETE candidatos à banca da federação, a banca lança o
//   resultado por karateExams.js. Fluxo de DAN, intocado.
//
// ── ESCALA: UMA SÓ ─────────────────────────────────────────
// Tudo que ordena, rotula ou deduz grau vem de src/utils/karateBeltScale.js
// (F8.0, PR #451). Nenhum mapa de faixa nasce aqui — mapa novo em arquivo
// novo é exatamente a regressão que a F8.0 fechou.
//
// ── ONDE A GRADUAÇÃO É GRAVADA ─────────────────────────────
//   SEMPRE  karate_dojo_belt_exam_results  (migration 264) — ancorado em
//           karate_dojo_students, para o aluno NÃO FEDERADO também ser
//           graduado.
//   SEMPRE  karate_dojo_students.belt_label / belt_order — a faixa do
//           aluno passa a ser CONSEQUÊNCIA da graduação, não um campo
//           que alguém digita.
//   SÓ SE FEDERADO  karate_belt_history com source='exam_dojo' +
//           source_dojo_id — é isto que faz a federação enxergar a
//           graduação e o certificado ficar disponível. Aluno sem
//           practitioner_id não tem a quem a federação emitiria nada;
//           a resposta DIZ isso (federated:false + reason), nunca pula
//           em silêncio.
//
// ── IDEMPOTÊNCIA (karate_belt_history NÃO tem UNIQUE) ──────
// Relançar o resultado do mesmo exame não pode criar uma segunda
// graduação. Duas travas, nesta ordem:
//   1ª  karate_dojo_belt_exam_results tem UNIQUE (exam_id, student_id).
//       O relançamento faz UPDATE da MESMA linha, e se ela já carrega
//       belt_history_id a graduação é REUSADA (nada é inserido).
//   2ª  Se a linha existe sem belt_history_id (primeira execução morreu
//       entre o INSERT do histórico e o UPDATE do resultado), procura-se
//       o gêmeo pela CHAVE NATURAL — (praticante, federação, cor, data do
//       exame, source='exam_dojo', dojô) — e ele é reusado.
// Só depois das duas é que se insere. ON CONFLICT não resolveria: o
// conflito estaria em karate_belt_history, que não tem constraint única
// (e criar uma agora invalidaria as 13.781 linhas históricas, onde
// re-graduação legítima na mesma data existe).
//
// ── TRANSAÇÃO ──────────────────────────────────────────────
// TUDO que pode ser recusado por regra de produto é validado ANTES do
// BEGIN, em leitura pura. Dentro do BEGIN só entram escritas que não têm
// como falhar por motivo de negócio — assim não existe try/catch
// best-effort dentro da transação (tx-poison) nem SAVEPOINT para remendar.
// O pedido de certificado acontece DEPOIS do COMMIT: createOrder usa o
// POOL (db.query), não o client da transação, e já dispara e-mail —
// prendê-lo ao BEGIN transformaria o primeiro DUPLICATE_ORDER em veneno
// para o lote inteiro (mesma decisão de createCertOrdersBatch, F5b).
// ============================================================
'use strict';

const db = require('../config/database');
const scale = require('../utils/karateBeltScale');
const { createOrder } = require('./karateCertificateService');
const { isDojoLinked } = require('./karateDojoLinkStatus');

const MAX_RESULTS = 200;
const MAX_LIST_PAGE = 200;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EXAM_STATUS = ['draft', 'completed', 'cancelled'];

function serviceError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.isServiceError = true;
  if (extra) Object.assign(e, extra);
  return e;
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ============================================================
// Colunas opcionais — probe ÚNICO, fora de qualquer transação
//
// karate_belt_history.source / source_dojo_id nascem na 262 e
// belt_kyu/belt_dan na 264. Um deploy pode ir à frente do banco. Descobrir
// isso por 42703 DENTRO do BEGIN envenenaria a transação; por isso a
// pergunta é feita ANTES, uma vez, ao information_schema.
//
// O cache guarda só o resultado COMPLETO. Enquanto faltar coluna a sonda
// repete — assim o processo se cura sozinho no minuto em que a migration
// rodar, sem restart e sem cadeia de retry.
// ============================================================
const BELT_HISTORY_OPTIONAL_COLS = ['source', 'source_dojo_id', 'belt_kyu', 'belt_dan'];
let _beltHistoryColsCache = null;

async function beltHistoryCols() {
  if (_beltHistoryColsCache) return _beltHistoryColsCache;
  let found = [];
  try {
    const { rows } = await db.query(
      `-- f81:probe-belt-history-cols
       SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'karate_belt_history'
          AND column_name = ANY($1::text[])`,
      [BELT_HISTORY_OPTIONAL_COLS]
    );
    found = rows.map((r) => r.column_name);
  } catch (e) {
    // information_schema não falha em banco sadio; se falhar, degradar para
    // "nenhuma coluna opcional" é mais seguro que derrubar a graduação.
    console.warn('[karateDojoBeltExam] probe de colunas falhou (segue sem as opcionais):', e && e.message);
    found = [];
  }
  const out = {
    source: found.includes('source'),
    source_dojo_id: found.includes('source_dojo_id'),
    belt_kyu: found.includes('belt_kyu'),
    belt_dan: found.includes('belt_dan'),
  };
  if (BELT_HISTORY_OPTIONAL_COLS.every((c) => out[c])) _beltHistoryColsCache = out;
  return out;
}

// Mesma mecânica para as colunas que a 265 acrescenta ao RESULTADO.
const RESULT_OPTIONAL_COLS = ['certificate_requested', 'certificate_order_id'];
let _resultColsCache = null;

async function resultCols() {
  if (_resultColsCache) return _resultColsCache;
  let found = [];
  try {
    const { rows } = await db.query(
      `-- f81:probe-result-cols
       SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'karate_dojo_belt_exam_results'
          AND column_name = ANY($1::text[])`,
      [RESULT_OPTIONAL_COLS]
    );
    found = rows.map((r) => r.column_name);
  } catch (e) {
    console.warn('[karateDojoBeltExam] probe de colunas do resultado falhou:', e && e.message);
    found = [];
  }
  const out = {
    certificate_requested: found.includes('certificate_requested'),
    certificate_order_id: found.includes('certificate_order_id'),
  };
  if (RESULT_OPTIONAL_COLS.every((c) => out[c])) _resultColsCache = out;
  return out;
}

// Exposto só para o teste poder reencenar um banco sem as migrations.
function __resetColumnCache() {
  _beltHistoryColsCache = null;
  _resultColsCache = null;
}

// ============================================================
// A escada — leitura da escala canônica, nunca um mapa novo
// ============================================================

// Rank linear 1..20 (10 kyus + 10 dans) de um degrau da escada FPKT.
// Grau desconhecido degrada para o degrau MAIS BAIXO da cor:
//   • faixa preta sem dan → Preta 1º dan (ainda acima de qualquer kyu);
//   • Marrom sem grau     → Marrom 3º kyu.
// Isso é deliberado e vale para a faixa ATUAL do aluno: recusar a
// graduação porque o GRAU dele é desconhecido transformaria dado faltante
// em pendência — e é justamente o buraco que a 264 deixou marcado para a
// F8.1 fechar PERGUNTANDO ao sensei (762 "Marrom" sem grau em produção).
function ladderRank(level, kyu, dan) {
  const l = scale.normalizeBeltLevel(level);
  if (!l) return null;
  if (l === 'preta') {
    const d = Number.isInteger(dan) && dan >= 1 && dan <= scale.MAX_DAN ? dan : 1;
    const step = scale.FPKT_LADDER.find((s) => s.level === 'preta' && s.dan === d);
    return step ? step.rank : null;
  }
  const color = scale.colorOf(l);
  if (!color || !color.kyus.length) return null;
  const k = color.kyus.indexOf(kyu) !== -1 ? kyu : color.kyus[0];
  const step = scale.FPKT_LADDER.find((s) => s.level === l && s.kyu === k);
  return step ? step.rank : null;
}

// Lê "Marrom 3º kyu" / "Azul Claro" / "azul_claro" / "Preta 2º dan".
// karate_dojo_students.belt_label é TEXTO LIVRE (migration 242, sem CHECK):
// é o que o app grava hoje, e é uma das fontes da faixa atual.
function parseBeltLabel(label) {
  const empty = { level: null, kyu: null, dan: null };
  const raw = trimOrNull(label);
  if (!raw) return empty;

  const norm = (s) =>
    String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_-]+/g, ' ').trim();
  const n = norm(raw);

  // Prefixo mais LONGO que casa — "Azul Escuro" não pode cair em "Azul".
  let color = null;
  for (const c of scale.COLOR_SCALE) {
    const cl = norm(c.label);
    if (n === cl || n.startsWith(cl)) {
      if (!color || norm(color.label).length < cl.length) color = c;
    }
  }
  if (!color) color = scale.colorOf(scale.normalizeBeltLevel(raw));
  if (!color) return empty;

  const deg = scale.parseDegreeFromName(color.level, raw);
  const kyu = deg.kyu != null ? deg.kyu : scale.kyuFromColor(color.level, scale.BELT_SCHEMA_FPKT);
  return { level: color.level, kyu: kyu != null ? kyu : null, dan: deg.dan };
}

function beltView(level, kyu, dan) {
  if (!level) return null;
  return {
    level,
    kyu: kyu != null ? kyu : null,
    dan: dan != null ? dan : null,
    label: scale.beltLabel(level, { kyu, dan }),
    order: scale.levelRankOf(level),
    rank: ladderRank(level, kyu, dan),
  };
}

// ============================================================
// Leituras
// ============================================================

async function loadExam(dojoId, examId) {
  if (!isUuid(examId)) return null;
  const { rows } = await db.query(
    `-- f81:load-exam
     SELECT id, dojo_id, federation_id, exam_date::text AS exam_date, title,
            examiner_name, notes, status, created_by, created_by_name,
            created_at, updated_at
       FROM karate_dojo_belt_exams
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [examId, dojoId]
  );
  return rows[0] || null;
}

function publicExam(row, extra) {
  if (!row) return null;
  return Object.assign(
    {
      id: row.id,
      dojo_id: row.dojo_id,
      federation_id: row.federation_id || null,
      exam_date: row.exam_date || null,
      title: row.title || null,
      examiner_name: row.examiner_name || null,
      notes: row.notes || null,
      status: row.status,
      created_by_name: row.created_by_name || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at !== undefined ? row.completed_at : undefined,
    },
    extra || {}
  );
}

// ── createExam ─────────────────────────────────────────────
async function createExam({ dojoId, federationId, body, createdBy, createdByName }) {
  const b = body || {};
  const errors = [];

  const examDate = trimOrNull(b.exam_date);
  if (!examDate) errors.push('exam_date é obrigatório (YYYY-MM-DD)');
  else if (!isValidDateStr(examDate.slice(0, 10))) errors.push('exam_date inválida (use YYYY-MM-DD)');

  const title = trimOrNull(b.title);
  const examiner = trimOrNull(b.examiner_name);
  const notes = trimOrNull(b.notes);

  if (errors.length) throw serviceError(422, 'VALIDATION_ERROR', errors[0], { errors });

  const { rows } = await db.query(
    `-- f81:insert-exam
     INSERT INTO karate_dojo_belt_exams
       (dojo_id, federation_id, exam_date, title, examiner_name, notes, status, created_by, created_by_name)
     VALUES ($1, $2, $3::date, $4, $5, $6, 'draft', $7, $8)
     RETURNING id, dojo_id, federation_id, exam_date::text AS exam_date, title,
               examiner_name, notes, status, created_by_name, created_at, updated_at`,
    [dojoId, federationId || null, examDate.slice(0, 10), title, examiner, notes, createdBy || null, createdByName || null]
  );
  return publicExam(rows[0], { results_count: 0, approved_count: 0, attachments_count: 0 });
}

// ── updateExam — só enquanto NÃO concluído ──────────────────
// Depois de concluído o exame descreve um fato que já aconteceu; editar
// data/examinador aí em cima mudaria a data de graduação já gravada em
// karate_belt_history sem tocar nela. 409, nunca 422: não é o corpo que
// está errado, é o ESTADO.
async function updateExam({ dojoId, examId, body }) {
  const exam = await loadExam(dojoId, examId);
  if (!exam) throw serviceError(404, 'EXAME_NAO_ENCONTRADO', 'Exame não encontrado neste dojô');
  if (exam.status !== 'draft') {
    throw serviceError(
      409,
      'EXAME_NAO_EDITAVEL',
      exam.status === 'completed'
        ? 'Este exame já foi concluído e não pode mais ser editado'
        : 'Este exame foi cancelado e não pode mais ser editado'
    );
  }

  const b = body || {};
  const sets = [];
  const vals = [];
  const errors = [];

  if (b.exam_date !== undefined) {
    const v = trimOrNull(b.exam_date);
    if (!v || !isValidDateStr(v.slice(0, 10))) errors.push('exam_date inválida (use YYYY-MM-DD)');
    else {
      vals.push(v.slice(0, 10));
      sets.push(`exam_date = $${vals.length}::date`);
    }
  }
  for (const col of ['title', 'examiner_name', 'notes']) {
    if (b[col] === undefined) continue;
    vals.push(trimOrNull(b[col]));
    sets.push(`${col} = $${vals.length}`);
  }
  if (errors.length) throw serviceError(422, 'VALIDATION_ERROR', errors[0], { errors });
  if (!sets.length) return getExam({ dojoId, examId });

  sets.push('updated_at = now()');
  vals.push(examId, dojoId);
  await db.query(
    `-- f81:update-exam
     UPDATE karate_dojo_belt_exams SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}`,
    vals
  );
  return getExam({ dojoId, examId });
}

// ── cancelExam ─────────────────────────────────────────────
// Cancelar NÃO desfaz graduação: karate_belt_history é append-only e a
// faixa do aluno já subiu. Por isso só cancela exame em rascunho — anular
// uma graduação é ato da federação, nunca efeito colateral de um clique.
async function cancelExam({ dojoId, examId }) {
  const exam = await loadExam(dojoId, examId);
  if (!exam) throw serviceError(404, 'EXAME_NAO_ENCONTRADO', 'Exame não encontrado neste dojô');
  if (exam.status === 'completed') {
    throw serviceError(
      409,
      'EXAME_CONCLUIDO',
      'Exame já concluído: as graduações foram registradas e o histórico de faixas é imutável. Cancelar aqui não desfaz graduação.'
    );
  }
  await db.query(
    `-- f81:cancel-exam
     UPDATE karate_dojo_belt_exams SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND dojo_id = $2`,
    [examId, dojoId]
  );
  return getExam({ dojoId, examId });
}

// ── listExams ──────────────────────────────────────────────
async function listExams(dojoId, params) {
  const p = params || {};
  const status = EXAM_STATUS.includes(p.status) ? p.status : null;
  const page = Math.max(parseInt(p.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(p.pageSize, 10) || 50, 1), MAX_LIST_PAGE);

  const vals = [dojoId];
  let where = 'e.dojo_id = $1';
  if (status) {
    vals.push(status);
    where += ` AND e.status = $${vals.length}`;
  }
  vals.push(pageSize, (page - 1) * pageSize);

  const { rows } = await db.query(
    `-- f81:list-exams
     SELECT e.id, e.dojo_id, e.federation_id, e.exam_date::text AS exam_date, e.title,
            e.examiner_name, e.notes, e.status, e.created_by_name, e.created_at, e.updated_at,
            (SELECT count(*) FROM karate_dojo_belt_exam_results r WHERE r.exam_id = e.id)::int
              AS results_count,
            (SELECT count(*) FROM karate_dojo_belt_exam_results r
              WHERE r.exam_id = e.id AND r.result = 'approved')::int AS approved_count
       FROM karate_dojo_belt_exams e
      WHERE ${where}
      ORDER BY e.exam_date DESC, e.created_at DESC
      LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );

  return {
    data: rows.map((r) =>
      publicExam(r, { results_count: Number(r.results_count) || 0, approved_count: Number(r.approved_count) || 0 })
    ),
    page,
    pageSize,
  };
}

// ── getExam — ficha do exame com os resultados ─────────────
async function getExam({ dojoId, examId }) {
  const exam = await loadExam(dojoId, examId);
  if (!exam) throw serviceError(404, 'EXAME_NAO_ENCONTRADO', 'Exame não encontrado neste dojô');

  const cols = await resultCols();
  const certSelect = cols.certificate_requested
    ? 'r.certificate_requested, r.certificate_order_id'
    : 'false AS certificate_requested, NULL::uuid AS certificate_order_id';

  const { rows } = await db.query(
    `-- f81:list-results
     SELECT r.id, r.student_id, r.practitioner_id,
            r.from_belt_level, r.from_belt_kyu, r.from_belt_dan,
            r.to_belt_level, r.to_belt_name, r.to_belt_kyu,
            r.result, r.notes, r.belt_history_id, r.created_at,
            ${certSelect},
            s.full_name AS student_name
       FROM karate_dojo_belt_exam_results r
       LEFT JOIN karate_dojo_students s ON s.id = r.student_id
      WHERE r.exam_id = $1 AND r.dojo_id = $2
      ORDER BY s.full_name ASC NULLS LAST`,
    [examId, dojoId]
  );

  const results = rows.map((r) => ({
    id: r.id,
    student_id: r.student_id,
    name: r.student_name || null,
    practitioner_id: r.practitioner_id || null,
    federated: Boolean(r.practitioner_id),
    result: r.result,
    from_belt: beltView(r.from_belt_level, r.from_belt_kyu, r.from_belt_dan),
    to_belt: r.to_belt_level ? beltView(r.to_belt_level, r.to_belt_kyu, null) : null,
    to_belt_name: r.to_belt_name || null,
    notes: r.notes || null,
    belt_history_id: r.belt_history_id || null,
    certificate: {
      requested: r.certificate_requested === true,
      order_id: r.certificate_order_id || null,
    },
    created_at: r.created_at,
  }));

  return {
    exam: publicExam(exam, {
      results_count: results.length,
      approved_count: results.filter((r) => r.result === 'approved').length,
    }),
    results,
  };
}

// ============================================================
// A faixa ATUAL do aluno — três fontes, vence a MAIS ALTA
//
// Por que três: o aluno pode ter subido pelo dojô (resultado de exame
// anterior), pela federação (karate_current_belt, que inclui import
// histórico e banca) ou ter só o rótulo digitado na ficha (belt_label).
// Ignorar qualquer uma abriria a porta para "graduar de novo para a mesma
// faixa" por caminho diferente do que foi usado da última vez.
//
// Nenhuma fonte = DESCONHECIDA, e desconhecida NÃO bloqueia (ausente é
// neutro). O primeiro exame do dojô sobre um cadastro sem faixa precisa
// funcionar — é literalmente o caso de estreia do recurso.
// ============================================================
async function resolveCurrentBelt(student, federationId) {
  const candidates = [];

  const fromLabel = parseBeltLabel(student.belt_label);
  if (fromLabel.level) candidates.push(Object.assign({ source: 'student_label' }, fromLabel));

  // Último APROVADO do próprio dojô — precisão máxima (cor + grau).
  try {
    const { rows } = await db.query(
      `-- f81:last-dojo-result
       SELECT to_belt_level, to_belt_kyu
         FROM karate_dojo_belt_exam_results
        WHERE student_id = $1 AND result = 'approved'
        ORDER BY created_at DESC
        LIMIT 1`,
      [student.id]
    );
    if (rows.length && rows[0].to_belt_level) {
      candidates.push({
        source: 'dojo_exam',
        level: scale.normalizeBeltLevel(rows[0].to_belt_level),
        kyu: rows[0].to_belt_kyu != null ? Number(rows[0].to_belt_kyu) : null,
        dan: null,
      });
    }
  } catch (e) {
    if (e && e.code !== '42P01' && e.code !== '42703') throw e;
  }

  // Federação: a view canônica. belt_kyu/belt_dan podem não existir ainda
  // (264 pendente) — por isso o grau sai do NOME via karateBeltScale, que
  // implementa exatamente as mesmas regras das funções SQL da 264.
  if (student.practitioner_id && federationId) {
    try {
      const { rows } = await db.query(
        `-- f81:current-belt
         SELECT belt_level, belt_name, belt_schema
           FROM karate_current_belt
          WHERE student_id = $1 AND federation_id = $2
          LIMIT 1`,
        [student.practitioner_id, federationId]
      );
      if (rows.length && rows[0].belt_level) {
        const deg = scale.resolveDegree(rows[0].belt_level, rows[0].belt_name, rows[0].belt_schema);
        candidates.push({
          source: 'federation',
          level: scale.normalizeBeltLevel(rows[0].belt_level),
          kyu: deg.kyu,
          dan: deg.dan,
        });
      }
    } catch (e) {
      if (e && e.code !== '42P01' && e.code !== '42703') throw e;
    }
  }

  let best = null;
  for (const c of candidates) {
    const rank = ladderRank(c.level, c.kyu, c.dan);
    if (rank == null) continue;
    if (!best || rank > best.rank) best = Object.assign({ rank }, c);
  }
  return best; // null = faixa atual desconhecida (não bloqueia)
}

// ============================================================
// Planejamento do lançamento — VALIDAÇÃO PURA, antes do BEGIN
//
// Um item inválido derruba o LOTE INTEIRO (422 com a lista completa de
// erros), em vez de virar "skipped". Isto é deliberado e diverge do idioma
// de lote da F5b (createCertOrdersBatch/enrollBatch), por dois motivos:
//   1. lá o motivo do skip é CIRCUNSTANCIAL e do aluno (não federado, já
//      inscrito) — o sensei não tem o que corrigir no ato;
//   2. aqui o motivo é uma DECISÃO do sensei que ele consegue corrigir na
//      hora (faixa de destino), e concluir o exame pela metade deixaria
//      metade da turma graduada e o exame marcado como concluído.
// Além disso o CHECK do banco (destino ≠ preta) recusaria a linha DENTRO
// da transação, que é exatamente onde não se pode falhar.
// ============================================================
async function planResults({ dojoId, federationId, examId, items }) {
  const exam = await loadExam(dojoId, examId);
  if (!exam) throw serviceError(404, 'EXAME_NAO_ENCONTRADO', 'Exame não encontrado neste dojô');
  if (exam.status === 'cancelled') {
    throw serviceError(409, 'EXAME_CANCELADO', 'Este exame foi cancelado — não é possível lançar resultado');
  }

  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    throw serviceError(422, 'VALIDATION_ERROR', 'Informe results: [{ student_id, result, to_belt_level }]');
  }
  if (list.length > MAX_RESULTS) {
    throw serviceError(422, 'VALIDATION_ERROR', `Máximo de ${MAX_RESULTS} alunos por exame`);
  }

  const errors = [];
  const parsed = [];
  const seen = new Set();

  for (const raw of list) {
    const it = raw || {};
    const sid = it.student_id != null ? String(it.student_id).trim() : '';
    if (!isUuid(sid)) {
      errors.push({ student_id: it.student_id || null, code: 'ID_INVALIDO', message: 'student_id inválido' });
      continue;
    }
    if (seen.has(sid)) {
      errors.push({ student_id: sid, code: 'ALUNO_DUPLICADO', message: 'O mesmo aluno aparece duas vezes no lote' });
      continue;
    }
    seen.add(sid);

    const result = it.result != null ? String(it.result).trim().toLowerCase() : '';
    if (result !== 'approved' && result !== 'failed') {
      errors.push({
        student_id: sid,
        code: 'RESULTADO_INVALIDO',
        message: "result deve ser 'approved' ou 'failed'",
      });
      continue;
    }

    const entry = {
      student_id: sid,
      result,
      notes: trimOrNull(it.notes),
      // Reprovado nunca pede certificado (o CHECK da 265 diz o mesmo).
      certificate_requested: result === 'approved' && (it.request_certificate === true || it.request_certificate === 'true'),
      to: null,
    };

    if (result === 'approved') {
      const level = scale.normalizeBeltLevel(it.to_belt_level);
      if (!level) {
        errors.push({
          student_id: sid,
          code: 'FAIXA_DESTINO_OBRIGATORIA',
          message: 'Informe to_belt_level (faixa de destino) para quem foi aprovado',
        });
        continue;
      }
      if (scale.isBlackBelt(level)) {
        errors.push({
          student_id: sid,
          code: 'TETO_DO_SENSEI',
          message:
            `O dojô gradua até ${scale.DOJO_CEILING.label}. ${scale.DOJO_CEILING_REASON}`,
        });
        continue;
      }
      const color = scale.colorOf(level);
      if (!color || !color.kyus.length || scale.isLegacyOnlyLevel(level)) {
        errors.push({
          student_id: sid,
          code: 'FAIXA_DESCONHECIDA',
          message: 'Faixa de destino fora da escala oficial da FPKT',
        });
        continue;
      }

      let kyu = it.to_belt_kyu != null && it.to_belt_kyu !== '' ? Number(it.to_belt_kyu) : null;
      if (kyu == null) kyu = scale.kyuFromColor(level, scale.BELT_SCHEMA_FPKT);
      if (kyu == null) {
        // Só cai aqui a Marrom: três kyus na MESMA cor. Adivinhar qual
        // seria inventar a graduação de alguém.
        errors.push({
          student_id: sid,
          code: 'GRAU_OBRIGATORIO',
          message: `${color.label} tem ${color.kyus.length} kyus (${color.kyus.join('º, ')}º) — informe to_belt_kyu`,
        });
        continue;
      }
      if (!Number.isInteger(kyu) || color.kyus.indexOf(kyu) === -1) {
        errors.push({
          student_id: sid,
          code: 'GRAU_INVALIDO',
          message: `to_belt_kyu inválido para ${color.label}. Use: ${color.kyus.join(', ')}`,
        });
        continue;
      }
      if (!scale.canDojoGrant({ level, kyu })) {
        errors.push({
          student_id: sid,
          code: 'TETO_DO_SENSEI',
          message: `O dojô gradua até ${scale.DOJO_CEILING.label}. ${scale.DOJO_CEILING_REASON}`,
        });
        continue;
      }

      entry.to = { level, kyu, label: scale.beltLabel(level, { kyu }), rank: ladderRank(level, kyu, null) };
    }

    parsed.push(entry);
  }

  // Carrega os alunos DO DOJÔ numa query só (nunca N+1), sempre escopada
  // pelo dojo_id do TOKEN — aluno de outro dojô não volta e vira erro.
  const ids = parsed.map((p) => p.student_id);
  const studentsById = new Map();
  if (ids.length) {
    const { rows } = await db.query(
      `-- f81:load-students
       SELECT id, full_name, practitioner_id, belt_label, belt_order, status
         FROM karate_dojo_students
        WHERE dojo_id = $1 AND id = ANY($2::uuid[])`,
      [dojoId, ids]
    );
    for (const r of rows) studentsById.set(r.id, r);
  }

  const plan = [];
  for (const entry of parsed) {
    const student = studentsById.get(entry.student_id);
    if (!student) {
      errors.push({
        student_id: entry.student_id,
        code: 'ALUNO_NAO_ENCONTRADO',
        message: 'Aluno não encontrado neste dojô',
      });
      continue;
    }

    const from = await resolveCurrentBelt(student, federationId);

    if (entry.result === 'approved' && from && entry.to.rank != null && entry.to.rank <= from.rank) {
      errors.push({
        student_id: entry.student_id,
        code: 'FAIXA_NAO_SUPERIOR',
        message:
          `${student.full_name}: a faixa de destino (${entry.to.label}) não é superior à faixa atual ` +
          `(${scale.beltLabel(from.level, { kyu: from.kyu, dan: from.dan })}). Graduação é sempre para cima.`,
      });
      continue;
    }

    plan.push(Object.assign({}, entry, { student, from }));
  }

  return { exam, plan, errors };
}

// ============================================================
// Aplicação — UMA transação, só escrita
// ============================================================
async function applyResults({ dojoId, federationId, exam, plan, cols, resCols }) {
  const client = await db.connect();
  const applied = [];
  try {
    await client.query('BEGIN');

    for (const entry of plan) {
      const isApproved = entry.result === 'approved';
      const practitionerId = entry.student.practitioner_id || null;
      const to = entry.to;
      const from = entry.from;

      // 1) O RESULTADO. UNIQUE (exam_id, student_id) da 264 é a 1ª trava de
      //    idempotência: relançar faz UPDATE da mesma linha.
      const certCols = resCols.certificate_requested ? ', certificate_requested' : '';
      const certVals = resCols.certificate_requested ? ', $14' : '';
      const certSet = resCols.certificate_requested ? ', certificate_requested = EXCLUDED.certificate_requested' : '';
      const params = [
        exam.id,
        dojoId,
        entry.student_id,
        practitionerId,
        from ? from.level : null,
        from && from.dan == null ? from.kyu : null,
        from ? from.dan : null,
        isApproved ? to.level : (from ? from.level : 'branca'),
        isApproved ? to.label : (from ? scale.beltLabel(from.level, { kyu: from.kyu, dan: from.dan }) : 'Branca'),
        isApproved ? to.kyu : (from && from.dan == null ? from.kyu : null),
        scale.BELT_SCHEMA_FPKT,
        entry.result,
        entry.notes,
      ];
      if (resCols.certificate_requested) params.push(entry.certificate_requested);

      const upsert = await client.query(
        `-- f81:upsert-result
         INSERT INTO karate_dojo_belt_exam_results
           (exam_id, dojo_id, student_id, practitioner_id,
            from_belt_level, from_belt_kyu, from_belt_dan,
            to_belt_level, to_belt_name, to_belt_kyu,
            belt_schema, result, notes${certCols})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${certVals})
         ON CONFLICT (exam_id, student_id) DO UPDATE
            SET practitioner_id = EXCLUDED.practitioner_id,
                from_belt_level = EXCLUDED.from_belt_level,
                from_belt_kyu   = EXCLUDED.from_belt_kyu,
                from_belt_dan   = EXCLUDED.from_belt_dan,
                to_belt_level   = EXCLUDED.to_belt_level,
                to_belt_name    = EXCLUDED.to_belt_name,
                to_belt_kyu     = EXCLUDED.to_belt_kyu,
                belt_schema     = EXCLUDED.belt_schema,
                result          = EXCLUDED.result,
                notes           = EXCLUDED.notes${certSet}
         RETURNING id, belt_history_id`,
        params
      );
      const resultRow = upsert.rows[0];

      const out = {
        result_id: resultRow.id,
        student_id: entry.student_id,
        name: entry.student.full_name,
        practitioner_id: practitionerId,
        federated: Boolean(practitionerId),
        result: entry.result,
        from_belt: from ? beltView(from.level, from.kyu, from.dan) : null,
        to_belt: isApproved ? beltView(to.level, to.kyu, null) : null,
        belt_history_id: resultRow.belt_history_id || null,
        belt_history: null, // 'created' | 'reused' | null
        belt_history_skipped_reason: null,
        student_belt_updated: false,
        certificate: {
          requested: entry.certificate_requested,
          created: false,
          order_id: null,
          reason: null,
          message: null,
        },
      };

      if (!isApproved) {
        applied.push(out);
        continue;
      }

      // 2) A FAIXA DO ALUNO É CONSEQUÊNCIA DA GRADUAÇÃO.
      //    belt_order recebe o rank CANÔNICO da cor (LEVEL_RANK, 1..9) —
      //    a MESMA escala que a F5b já devolve como belt_order em
      //    listAptos. A coluna é texto livre/inteiro sem CHECK (migr 242) e
      //    só ordena/agrupa; o grau dentro da cor vive no belt_label
      //    ("Marrom 1º kyu"), que é o que a pirâmide de faixas agrupa.
      await client.query(
        `-- f81:update-student-belt
         UPDATE karate_dojo_students
            SET belt_label = $1, belt_order = $2, updated_at = now()
          WHERE id = $3 AND dojo_id = $4`,
        [to.label, scale.levelRankOf(to.level), entry.student_id, dojoId]
      );
      out.student_belt_updated = true;

      // 3) O ESPELHO NA FEDERAÇÃO — só para quem é federado.
      if (!practitionerId) {
        out.belt_history_skipped_reason = 'ALUNO_NAO_FEDERADO';
        applied.push(out);
        continue;
      }
      if (!federationId) {
        out.belt_history_skipped_reason = 'SEM_FEDERACAO';
        applied.push(out);
        continue;
      }

      if (resultRow.belt_history_id) {
        // 1ª trava: já graduado por este exame.
        out.belt_history_id = resultRow.belt_history_id;
        out.belt_history = 'reused';
        applied.push(out);
        continue;
      }

      // 2ª trava: gêmeo pela chave natural (ver cabeçalho).
      const twinConds = ['student_id = $1', 'federation_id = $2', 'lower(belt_level) = lower($3)', 'graduated_at = $4::date'];
      const twinVals = [practitionerId, federationId, to.level, exam.exam_date];
      if (cols.source) twinConds.push("source = 'exam_dojo'");
      if (cols.source_dojo_id) {
        twinVals.push(dojoId);
        twinConds.push(`source_dojo_id = $${twinVals.length}`);
      }
      const twin = await client.query(
        `-- f81:belt-history-twin
         SELECT id FROM karate_belt_history WHERE ${twinConds.join(' AND ')} LIMIT 1`,
        twinVals
      );

      let historyId;
      if (twin.rows.length) {
        historyId = twin.rows[0].id;
        out.belt_history = 'reused';
      } else {
        const hCols = ['student_id', 'federation_id', 'belt_level', 'belt_name', 'belt_schema', 'graduated_at', 'notes', 'created_by'];
        const hVals = [
          practitionerId,
          federationId,
          to.level,
          to.label,
          scale.BELT_SCHEMA_FPKT,
          exam.exam_date,
          entry.notes || `Exame do dojô${exam.title ? ': ' + exam.title : ''}`,
          exam.created_by || null,
        ];
        // exam_id fica NULL de propósito: aquela coluna aponta para
        // karate_belt_exams (o exame DA FEDERAÇÃO). O exame do dojô mora em
        // outra tabela e o vínculo inverso é
        // karate_dojo_belt_exam_results.belt_history_id.
        if (cols.source) {
          hVals.push('exam_dojo');
          hCols.push('source');
        }
        if (cols.source_dojo_id) {
          hVals.push(dojoId);
          hCols.push('source_dojo_id');
        }
        if (cols.belt_kyu) {
          hVals.push(to.kyu);
          hCols.push('belt_kyu');
        }
        const ph = hVals.map((_, i) => (hCols[i] === 'graduated_at' ? `$${i + 1}::date` : `$${i + 1}`));
        const ins = await client.query(
          `-- f81:insert-belt-history
           INSERT INTO karate_belt_history (${hCols.join(', ')})
           VALUES (${ph.join(', ')})
           RETURNING id`,
          hVals
        );
        historyId = ins.rows[0].id;
        out.belt_history = 'created';
      }

      await client.query(
        `-- f81:link-result-history
         UPDATE karate_dojo_belt_exam_results SET belt_history_id = $1 WHERE id = $2`,
        [historyId, resultRow.id]
      );
      out.belt_history_id = historyId;
      applied.push(out);
    }

    // Concluir é idempotente e NÃO remexe completed_at de um exame que já
    // estava concluído (COALESCE) — relançar não reescreve a data original.
    await client.query(
      `-- f81:complete-exam
       UPDATE karate_dojo_belt_exams
          SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
        WHERE id = $1 AND dojo_id = $2`,
      [exam.id, dojoId]
    );

    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* conexão já perdida — o pool descarta */
    }
    throw e;
  } finally {
    client.release();
  }
  return applied;
}

// ============================================================
// Certificados — DEPOIS do COMMIT, um por vez, nunca em transação
//
// DECISÃO: o exame CRIA O PEDIDO DE VERDADE, não uma "intenção pendente".
// A fila de aptos (listAptos) é DERIVADA: graduação sem pedido ativo. Se o
// exame só marcasse intenção, o aluno apareceria ao mesmo tempo como apto
// e como "já pedido" — duas verdades para a mesma pergunta. Criando o
// pedido, ele sai da fila sozinho (NOT EXISTS) e quem o sensei não marcou
// continua lá, pedível pela tela que já existe. Zero conceito novo.
//
// createOrder já faz o dup check por (praticante, faixa) e grava o
// histórico do pedido — é o MESMO caminho de POST /dojo/cert-orders.
// ============================================================
async function requestCertificates({ dojoId, federationId, exam, applied, delivery, createdBy, createdByName, resCols }) {
  const wanted = applied.filter((a) => a.certificate.requested);
  if (!wanted.length) return applied;

  // Certificado é ato FEDERATIVO: não existe para dojô sem conexão. Mesma
  // regra do gate de POST /dojo/cert-orders — mas aqui ele não pode
  // derrubar a GRADUAÇÃO (que é interna e já foi commitada), então vira
  // motivo por aluno em vez de 409 do lote.
  let linked = true;
  try {
    linked = await isDojoLinked(dojoId);
  } catch (e) {
    console.warn('[karateDojoBeltExam] isDojoLinked falhou (segue como conectado):', e && e.message);
  }

  const d = delivery || {};
  for (const a of wanted) {
    if (!a.federated) {
      a.certificate.reason = 'ALUNO_NAO_FEDERADO';
      a.certificate.message =
        'Certificado é emitido pela federação para um PRATICANTE. Este aluno não tem vínculo federativo confirmado — federe-o (número FPKT) e peça o certificado pela fila de aptos.';
      continue;
    }
    if (!a.belt_history_id) {
      a.certificate.reason = 'SEM_GRADUACAO_FEDERATIVA';
      a.certificate.message = 'A graduação não pôde ser registrada na federação — o certificado não foi solicitado.';
      continue;
    }
    if (!linked) {
      a.certificate.reason = 'DOJO_NAO_CONECTADO';
      a.certificate.message =
        'Conecte seu dojô à federação para solicitar certificados. A graduação está registrada e o aluno aparecerá na fila de aptos.';
      continue;
    }

    try {
      const order = await createOrder({
        federationId,
        dojoId, // SEMPRE do token
        practitionerId: a.practitioner_id,
        beltLevel: a.to_belt.level,
        beltName: a.to_belt.label,
        examDate: exam.exam_date,
        examRef: exam.title || 'Exame do dojô',
        nomeImpresso: a.name,
        deliveryType: d.delivery_type === 'mail' ? 'mail' : 'pickup',
        addrCep: d.addr_cep || null,
        addrLogradouro: d.addr_logradouro || null,
        addrNumero: d.addr_numero || null,
        addrComplemento: d.addr_complemento || null,
        addrCidade: d.addr_cidade || null,
        observacao: d.observacao || null,
        createdBy: createdBy || null,
        createdByName: createdByName || null,
      });
      a.certificate.created = true;
      a.certificate.order_id = order.id;

      if (resCols.certificate_order_id) {
        await db
          .query(
            `-- f81:link-result-cert-order
             UPDATE karate_dojo_belt_exam_results SET certificate_order_id = $1 WHERE id = $2`,
            [order.id, a.result_id]
          )
          .catch((e) => console.error('[karateDojoBeltExam] link certificate_order_id:', e && e.message));
      }
    } catch (e) {
      if (e && e.code === 'DUPLICATE_ORDER') {
        a.certificate.reason = 'JA_SOLICITADO';
        a.certificate.message = 'Já existe pedido ativo de certificado para esta graduação.';
        continue;
      }
      if (e && (e.code === 'TABLE_MISSING' || e.code === '42P01')) {
        a.certificate.reason = 'SCHEMA_PENDING';
        a.certificate.message = 'Pedidos de certificado indisponíveis no momento (migration 182 pendente).';
        continue;
      }
      console.error('[karateDojoBeltExam] createOrder falhou:', e && e.code, e && e.message);
      a.certificate.reason = 'ERRO';
      a.certificate.message = 'Não foi possível registrar o pedido de certificado. A graduação está registrada.';
    }
  }
  return applied;
}

// ── submitResults — o ato completo ─────────────────────────
async function submitResults({ dojoId, federationId, examId, body, createdBy, createdByName }) {
  const b = body || {};
  const { exam, plan, errors } = await planResults({
    dojoId,
    federationId,
    examId,
    items: b.results,
  });

  if (errors.length) {
    throw serviceError(422, 'VALIDATION_ERROR', errors[0].message, { errors });
  }

  const cols = await beltHistoryCols();
  const resCols = await resultCols();

  const applied = await applyResults({ dojoId, federationId, exam, plan, cols, resCols });
  await requestCertificates({
    dojoId,
    federationId,
    exam,
    applied,
    delivery: b.delivery,
    createdBy,
    createdByName,
    resCols,
  });

  const approved = applied.filter((a) => a.result === 'approved');
  return {
    exam: publicExam(Object.assign({}, exam, { status: 'completed' })),
    completed: true,
    results: applied,
    summary: {
      total: applied.length,
      approved: approved.length,
      failed: applied.length - approved.length,
      not_federated: approved.filter((a) => !a.federated).length,
      belt_history_created: applied.filter((a) => a.belt_history === 'created').length,
      belt_history_reused: applied.filter((a) => a.belt_history === 'reused').length,
      certificates_requested: applied.filter((a) => a.certificate.requested).length,
      certificates_created: applied.filter((a) => a.certificate.created).length,
    },
    // Aviso de topo: o front não precisa varrer a lista para saber que
    // alguém ficou de fora do lado federativo.
    schema_degraded: !cols.source || !resCols.certificate_requested ? true : undefined,
  };
}

// ── beltLadder — o que o sensei pode escolher ──────────────
// A UI de graduação precisa da lista de destinos possíveis COM grau.
// Deriva de FPKT_LADDER (F8.0): a preta vem marcada como não concedível,
// com o motivo — melhor a UI mostrar e explicar do que esconder e o
// sensei achar que é bug.
function beltLadder() {
  return {
    schema: scale.BELT_SCHEMA_FPKT,
    ceiling: scale.DOJO_CEILING,
    ceiling_reason: scale.DOJO_CEILING_REASON,
    data: scale.FPKT_LADDER.map((s) => ({
      level: s.level,
      color_label: s.color_label,
      kyu: s.kyu,
      dan: s.dan,
      label: s.label,
      rank: s.rank,
      order: scale.levelRankOf(s.level),
      grantable_by_dojo: s.grantable_by_dojo,
    })),
  };
}

module.exports = {
  MAX_RESULTS,
  createExam,
  updateExam,
  cancelExam,
  listExams,
  getExam,
  loadExam,
  planResults,
  submitResults,
  beltLadder,
  // exportados para teste/reuso interno
  parseBeltLabel,
  ladderRank,
  resolveCurrentBelt,
  beltHistoryCols,
  resultCols,
  __resetColumnCache,
};
