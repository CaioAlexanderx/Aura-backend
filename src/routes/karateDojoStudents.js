// ============================================================
// AURA DOJÔ — F2: Alunos do dojô (registro PRÓPRIO) + responsáveis
//
// Montado sob /federation/:id (padrão karateDojoPractitionerRequests).
// Guard: requireDojoAccess (Canal A = JWT de acesso com dojo_id; Canal B =
// token do portal). REGRA DE CANAL: GETs aceitam A e B; POST/PATCH/DELETE
// exigem Canal A — o portal (B) é somente leitura (403 PORTAL_READ_ONLY).
//
// DECISÃO CENTRAL (F2): o aluno do dojô é registro PRÓPRIO
// (karate_dojo_students, migration 242) — NUNCA escreve em
// karate_practitioners/customers (federação).
//
// F5a (26/07/2026): o SENSEI declara se o aluno é FEDERADO e a FEDERAÇÃO
// confirma. practitioner_id deixou de ser "vínculo futuro" — ele é gravado
// pelo /federate (número FPKT já existente) ou pela aprovação da
// solicitação H1.
//
// F7.1 (30/07/2026) — A PRIMEIRA EXCEÇÃO à regra "não escreve em customers":
// federar passou a ser uma ADOÇÃO. Ao confirmar o vínculo o dojô assume a
// ficha da pessoa na federação (karate_identity_managed_by = 'dojo') e a
// resolução escolhida pelo sensei é gravada nos DOIS lados, numa transação
// só. Toda a lógica mora em services/karateStudentIdentityLink.js.
//
// F7.2 (30/07/2026) — A EXCEÇÃO VIROU REGRA CONTÍNUA: enquanto a ficha
// estiver adotada por ESTE dojô, editar a identidade do aluno (PATCH ou
// import) atualiza o praticante na MESMA transação, com trilha. Nada disso
// mora aqui: o handler só entrega o ATOR e a federação (sempre do token)
// para a trilha; a regra está em services/karateIdentitySync.js.
// O que NUNCA sobe: matrícula FPKT, papéis federativos, is_active, dojo_id
// e faixa — isso é o que a federação EMITE.
//
// F8 (31/07/2026) — A FICHA DO ALUNO GANHA FOTO: reusa EXATAMENTE o
// mecanismo do upload de foto do praticante (uploadToR2, mesmos tipos e
// mesmo limite de 5 MB) e o MESMO caminho de sync contínuo da F7.2 — a
// foto é só mais um campo de identidade (karate_photo_url já estava em
// SYNCED_IDENTITY_COLS desde a migration 262). O responsável também passa
// a subir: ver comentário na rota PATCH /dojo/guardians/:gid.
//
// F11 (09/08/2026) — filtro ?tag_id= na listagem: escopo/paginação/busca
// existentes não mudam de forma; a lógica do filtro (JOIN condicional só
// quando tag_id vem preenchido, pra não exigir a tabela nova em toda
// chamada) vive em karateDojoStudentService.js. Tags em si (CRUD,
// atribuição, contagem por tag) são karateDojoTagService.js /
// karateDojoTags.js — não duplicadas aqui.
//
// Escopo SEMPRE por req.dojoId do guard — nunca do body/query.
// Defensivo 42P01 (migration 242 pendente): GETs de lista devolvem vazio +
// schema_pending; writes e ficha devolvem 503 SCHEMA_PENDING.
//
//   GET    /federation/:id/dojo/students             (?status=&q=&belt=&federated=&tag_id=&summary=1&limit=&offset=)
//   POST   /federation/:id/dojo/students             (422 inválido / menor sem responsável)
//   POST   /federation/:id/dojo/students/import      ({rows:[...]}, máx 500)
//   GET    /federation/:id/dojo/students/:sid        (ficha + responsável)
//   PATCH  /federation/:id/dojo/students/:sid        (F7.2 — sincroniza identidade se adotada)
//   DELETE /federation/:id/dojo/students/:sid        (delete real por ora; F3 → 409 HAS_HISTORY)
//   POST   /federation/:id/dojo/students/:sid/photo       (F8 — upload de foto, sincroniza se adotada)
//   POST   /federation/:id/dojo/students/:sid/federate    (F5a/F7.1 — Canal A)
//   DELETE /federation/:id/dojo/students/:sid/federate    (F5a/F7.1 — Canal A)
//   GET    /federation/:id/dojo/guardians            (+ contagem de alunos vinculados)
//   POST   /federation/:id/dojo/guardians
//   PATCH  /federation/:id/dojo/guardians/:gid       (F8 — sincroniza alunos adotados vinculados a este responsável)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoStudentService');
const identityLink = require('../services/karateStudentIdentityLink');
const { isDojoLinked } = require('../services/karateDojoLinkStatus');
const { uploadToR2 } = require('../utils/r2Storage');

// Canal B (portal do dojô) é SOMENTE LEITURA: o portal existe para
// consulta; alteração de cadastro exige a conta do dojô (Canal A).
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para alterar dados.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    // Ficha da solicitação H1 devolve a lista completa de campos faltando.
    if (e.errors) body.errors = e.errors;
    // F7.1: a conferência devolve TODOS os bloqueios, não só o primeiro —
    // o sensei precisa ver a lista inteira para saber o que corrigir.
    if (e.blockers) body.blockers = e.blockers;
    if (e.legacy_code) body.legacy_code = e.legacy_code;
    return res.status(e.status).json(body);
  }
  if (e && e.code === '23505') {
    // UNIQUE parcial (dojo_id, cpf) — migration 242
    return res.status(409).json({ error: 'Já existe um aluno com este CPF neste dojô', code: 'DUPLICATE_CPF' });
  }
  if (e && e.code === '42P01') {
    return res.status(503).json({ error: 'Alunos do dojô ainda não disponíveis (migration 242 pendente)', code: 'SCHEMA_PENDING' });
  }
  console.error(`[karateDojoStudents] ${ctx}:`, e.message);
  return res.status(500).json({ error: 'Erro interno' });
}

// ?federated=true|false — ausente/inválido = TODOS (nunca filtra por
// engano: "dado faltante ≠ pendência" vale também para filtro de query).
function parseFederatedFilter(raw) {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

// F11: ?tag_id= — ausente/vazio = sem filtro (todos os alunos, com e sem
// tags). Só uma checagem de "veio alguma coisa", sem validar formato de
// UUID aqui — se o id não existir/não pertencer ao dojô, a query do
// service simplesmente não encontra ninguém (lista vazia, não erro).
function parseTagIdFilter(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  return v === '' ? null : v;
}

// Quem está agindo — sempre do TOKEN, nunca do corpo. Vai para a trilha
// de auditoria da F7.1 (adoção) e da F7.2 (sync contínuo).
function actorFrom(req) {
  return {
    userId: (req.user && req.user.id) || null,
    label: (req.user && (req.user.name || req.user.email)) || null,
  };
}

// Contexto que as escritas de aluno passam ao service para a trilha do
// sync. federationId vem do guard (rota montada sob /federation/:id).
function identityCtx(req) {
  return { federationId: req.federationId || null, actor: actorFrom(req) };
}

// ── GET /federation/:id/dojo/students ──
// QA 27/07/2026: o handler lia os filtros mas IGNORAVA o limit (o service
// tinha LIMIT 1000 fixo) — limit=50 e limit=200 devolviam os mesmos 205
// alunos / 105 KB. Agora é paginação de verdade e `count` é o TOTAL sem
// paginação (antes era data.length, que com LIMIT fixo por acaso batia).
// `data`/`count`/`summary` mantêm os nomes que o app já consome.
router.get('/dojo/students', requireDojoAccess, async (req, res) => {
  try {
    const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : null;
    const q = req.query.q != null && String(req.query.q).trim() !== '' ? String(req.query.q).trim() : null;
    const belt = req.query.belt != null && String(req.query.belt).trim() !== '' ? String(req.query.belt).trim() : null;
    const federated = parseFederatedFilter(req.query.federated);
    const tagId = parseTagIdFilter(req.query.tag_id);

    const page = await svc.listStudentsPaged(req.dojoId, {
      status,
      q,
      belt,
      federated,
      tag_id: tagId,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    const payload = {
      data: page.data,
      count: page.count,
      limit: page.limit,
      offset: page.offset,
    };
    if (req.query.summary === '1' || req.query.summary === 'true') {
      payload.summary = await svc.getSummary(req.dojoId);
    }
    return res.json(payload);
  } catch (e) {
    if (e && e.code === '42P01') {
      const paging = svc.parsePaging({ limit: req.query.limit, offset: req.query.offset });
      return res.json({ data: [], count: 0, limit: paging.limit, offset: paging.offset, schema_pending: true });
    }
    console.error('[karateDojoStudents] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar alunos' });
  }
});

// ── POST /federation/:id/dojo/students ──
router.post('/dojo/students', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateStudentPayload(req.body, { partial: false });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const student = await svc.createStudent(req.dojoId, data);
    return res.status(201).json(student);
  } catch (e) {
    return handleWriteError(res, e, 'create student');
  }
});

// ── POST /federation/:id/dojo/students/import ──
// Lote de até 500 linhas JSON já parseadas pelo front. Import é TOLERANTE
// (menor sem responsável entra com warning; campo inválido vira NULL com
// warning; dup de CPF é skipped). Transação única no service.
// Definido ANTES das rotas /:sid (convenção do repo — literal antes de param).
router.post('/dojo/students/import', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.importStudents(req.dojoId, (req.body || {}).rows, identityCtx(req));
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'import students');
  }
});

// ── GET /federation/:id/dojo/students/:sid ──
router.get('/dojo/students/:sid', requireDojoAccess, async (req, res) => {
  try {
    const student = await svc.getStudent(req.dojoId, req.params.sid);
    if (!student) {
      return res.status(404).json({ error: 'Aluno não encontrado neste dojô', code: 'NOT_FOUND' });
    }
    return res.json(student);
  } catch (e) {
    return handleWriteError(res, e, 'get student');
  }
});

// ── PATCH /federation/:id/dojo/students/:sid ──
// F7.2: quando o aluno tem praticante vinculado E a ficha dele na federação
// está adotada por ESTE dojô, alterar a identidade sobe para o praticante
// na mesma transação. A resposta ganha `identity_sync` para o app poder
// dizer "atualizado também na federação" — ou avisar que não subiu.
router.patch('/dojo/students/:sid', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateStudentPayload(req.body, { partial: true });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const student = await svc.updateStudent(req.dojoId, req.params.sid, data, identityCtx(req));
    return res.json(student);
  } catch (e) {
    return handleWriteError(res, e, 'update student');
  }
});

// ── DELETE /federation/:id/dojo/students/:sid ──
// Por ora DELETE REAL (aluno F2 não tem dependências). Quando a F3 criar
// cobranças, deve virar 409 HAS_HISTORY (ver comentário no service).
router.delete('/dojo/students/:sid', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.deleteStudent(req.dojoId, req.params.sid);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'delete student');
  }
});

// ── POST /federation/:id/dojo/students/:sid/photo ──
// F8 — Upload de foto do aluno. REUSA EXATAMENTE o mecanismo do upload de
// foto do praticante (POST /:practitionerId/photo em karatePractitioners.js):
// mesmo helper uploadToR2 (src/utils/r2Storage.js), MESMOS tipos aceitos e
// MESMO limite de tamanho. Nenhum segundo caminho de upload de arquivo.
//
// Body JSON:
//   content      {string}  Imagem em base64 (obrigatório).
//   content_type {string?} MIME. Default: "image/jpeg".
//                          Aceitos: image/jpeg, image/png, image/webp
//                          (mesma lista ALLOWED_TYPES da rota do praticante).
//
// Limite de tamanho: 5 MB — herdado de express.json({ limit: '5mb' }) em
// src/app.js (global, não por rota); acima disso o Express já responde 413
// antes de chegar aqui. Não é um limite novo — é o mesmo que já protege o
// upload do praticante.
//
// Grava karate_dojo_students.karate_photo_url (migration 262, F7.0).
// Diferente da rota do praticante — que só devolve { photo_url } — esta
// devolve a FICHA INTEIRA do aluno, no mesmo shape do PATCH/GET, porque
// karate_photo_url já é um SYNCED_IDENTITY_COLS: se o aluno tem
// practitioner_id e a ficha dele está adotada por este dojô
// (karate_identity_managed_by='dojo'), svc.setStudentPhoto reusa
// updateStudentWithSync — o MESMO mecanismo transacional do PATCH (F7.2) —
// e a foto sobe para a federação. `identity_sync` na resposta diz se subiu.
router.post('/dojo/students/:sid/photo', requireDojoAccess, requireChannelA, async (req, res) => {
  const { content, content_type } = req.body || {};

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({
      error: 'Campo content (imagem em base64) é obrigatório',
      code: 'VALIDATION_ERROR',
    });
  }

  // Mesma lista da rota do praticante — rejeita tipos claramente não-imagem.
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const mime = ((content_type || 'image/jpeg') + '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_TYPES.includes(mime)) {
    return res.status(400).json({
      error: 'Tipo de imagem não suportado: ' + mime + '. Use image/jpeg, image/png ou image/webp.',
      code: 'INVALID_CONTENT_TYPE',
    });
  }
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

  try {
    // Confirma que o aluno existe NESTE dojô antes de gastar um upload no
    // R2 — mesma ordem da rota do praticante (valida, depois sobe).
    const existing = await svc.getStudent(req.dojoId, req.params.sid);
    if (!existing) {
      return res.status(404).json({ error: 'Aluno não encontrado neste dojô', code: 'NOT_FOUND' });
    }

    // Chave própria do aluno do dojô — nunca reusa o namespace
    // 'karate/practitioners/...' da federação (são storages de pessoas
    // diferentes até a adoção existir).
    const key = 'karate/dojo-students/' + req.dojoId + '/' + req.params.sid + '.' + ext;
    const result = await uploadToR2(key, content, mime);
    if (!result.success) {
      console.error('[karateDojoStudents] photo R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no armazenamento da imagem' });
    }

    const student = await svc.setStudentPhoto(req.dojoId, req.params.sid, result.url, identityCtx(req));
    return res.json(student);
  } catch (e) {
    return handleWriteError(res, e, 'upload student photo');
  }
});

// ============================================================
// F5a/F7.1 — FEDERAR / DESFEDERAR o aluno
//
// POST /dojo/students/:sid/federate  (Canal A)
//
//   { fpkt_number }                    → PREVIEW. NÃO GRAVA NADA.
//       200 { preview:true, practitioner, is_transfer, can_link,
//             blockers[], comparison[] }
//       404 FPKT_NUMBER_NOT_FOUND (preservado da F5a)
//
//   { fpkt_number, confirm:true, resolution } → CONFIRMAÇÃO (grava).
//       200 { linked:true, practitioner, applied[], is_transfer }
//       409 CPF_CONFLITANTE | PRATICANTE_JA_VINCULADO
//       503 SCHEMA_PENDING_262 (migration 262 ainda não aplicada)
//
//   { request: true, ... }             → o aluno é NOVO na federação: abre
//       a solicitação H1 (mesma rota/fila de sempre). INALTERADO na F7.1 —
//       ali quem cria o praticante é a federação, e a conferência é a fila
//       de aprovação dela.
//
// POR QUE O PREVIEW EXISTE (produção, 30/07/2026): uma aluna de 12 anos
// (CPF 123..., nascimento 1998) foi vinculada a um praticante nascido em
// 2020, com outro CPF, sem um aviso. O front detectava a divergência de
// nome e pedia "confirme o vínculo" — mas o backend JÁ TINHA GRAVADO.
// Aqui a ordem é mostrar → perguntar → gravar.
//
// ✅ F7.2: svc.federateStudentByFpktNumber e svc.unfederateStudent (as
// versões F5a que ficaram órfãs quando esta rota passou a usar
// identityLink) foram REMOVIDAS do service — era a limpeza que a F7.1
// deixou marcada para depois do #446. svc.federateStudentByRequest, o
// caminho 2 (solicitação H1), continua vivo e é chamado logo abaixo.
// ============================================================
router.post('/dojo/students/:sid/federate', requireDojoAccess, requireChannelA, async (req, res) => {
  const b = req.body || {};

  try {
    // Gate de conexão ANTES de olhar o corpo (mesma decisão do H1, PR #422):
    // federar cria/reivindica algo na FEDERAÇÃO — não existe para um dojô
    // que ainda não se conectou. 409 (conflito de ESTADO), nunca 403.
    // Vale inclusive para o PREVIEW: sem conexão não há o que conferir.
    if (!(await isDojoLinked(req.dojoId))) {
      return res.status(409).json({
        error: 'Conecte seu dojô à federação para federar alunos',
        code: 'DOJO_NAO_CONECTADO',
      });
    }

    const rawNumber = b.fpkt_number != null ? String(b.fpkt_number).trim() : '';
    const wantsRequest = b.request === true || b.request === 'true';

    if (!rawNumber && !wantsRequest) {
      return res.status(422).json({
        error: 'Informe fpkt_number (aluno já federado) ou request: true (solicitar cadastro à federação)',
        code: 'VALIDATION_ERROR',
      });
    }

    // Ausência de `confirm` é PREVIEW. É o default de propósito: um cliente
    // antigo que só manda { fpkt_number } passa a NÃO gravar em vez de
    // gravar sem conferir — falhar para o lado seguro.
    const confirm = b.confirm === true || b.confirm === 'true';

    const result = rawNumber
      ? await identityLink.federateByNumber({
          dojoId: req.dojoId,
          federationId: req.federationId,
          studentId: req.params.sid,
          rawNumber,
          confirm,
          resolution: b.resolution,
          actor: actorFrom(req),
        })
      : await svc.federateStudentByRequest(req.dojoId, req.federationId, req.params.sid, {
          body: b,
          channel: req.dojoAuthChannel || null,
          actorLabel: (req.user && req.user.email) || null,
        });

    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'federate student');
  }
});

// ── DELETE /federation/:id/dojo/students/:sid/federate ──
// Desvincula: is_federated=false, practitioner_id=NULL.
//
// F7.1: passa a DEVOLVER A GESTÃO DA FICHA à federação
// (karate_identity_managed_by='federation', karate_identity_dojo_id=NULL).
// Continua sem apagar NADA em karate_practitioners/customers: o praticante
// segue existindo (número, faixa, histórico) — só volta a ser a FEDERAÇÃO
// quem digita a ficha dele. Excluir praticante é ato da federação, jamais
// efeito colateral de um clique no portal do dojô.
//
// F7.2: devolver a gestão também ENCERRA o sync contínuo — a partir daqui
// o guarda de karateIdentitySync não encontra mais a ficha como adotada
// por este dojô e nenhuma edição do aluno sobe.
//
// SEM gate de conexão de propósito: desfazer uma marcação errada é higiene
// do cadastro INTERNO e não pode depender de estar conectado. Pelo mesmo
// motivo NÃO exige a migration 262 — sem ela o desvínculo acontece e a
// devolução da gestão é pulada (identity_returned:false).
router.delete('/dojo/students/:sid/federate', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await identityLink.unfederateStudent({
      dojoId: req.dojoId,
      studentId: req.params.sid,
      federationId: req.federationId || null,
      actor: actorFrom(req),
    });
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'unfederate student');
  }
});

// ── GET /federation/:id/dojo/guardians ──
router.get('/dojo/guardians', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listGuardians(req.dojoId);
    return res.json({ data, count: data.length });
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoStudents] list guardians error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar responsáveis' });
  }
});

// ── POST /federation/:id/dojo/guardians ──
router.post('/dojo/guardians', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateGuardianPayload(req.body, { partial: false });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const guardian = await svc.createGuardian(req.dojoId, data);
    return res.status(201).json(guardian);
  } catch (e) {
    return handleWriteError(res, e, 'create guardian');
  }
});

// ── PATCH /federation/:id/dojo/guardians/:gid ──
// F8: o responsável de 1 dojô pode ter N alunos (topo do service). Editar o
// responsável agora pode ter o que subir para a federação em cada ficha de
// aluno ADOTADA vinculada a ele — svc.updateGuardian localiza esses alunos
// e sincroniza todos em LOTE, na mesma transação do UPDATE do responsável
// (reusa identitySync.syncStudentsBatch, o mesmo mecanismo do import).
// `identityCtx(req)` é o mesmo contexto {federationId, actor} usado pelas
// escritas de aluno — necessário aqui pela primeira vez porque antes desta
// fase o responsável nunca tinha o que sincronizar.
router.patch('/dojo/guardians/:gid', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateGuardianPayload(req.body, { partial: true });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const guardian = await svc.updateGuardian(req.dojoId, req.params.gid, data, identityCtx(req));
    return res.json(guardian);
  } catch (e) {
    return handleWriteError(res, e, 'update guardian');
  }
});

module.exports = router;
