// ============================================================
// AURA DOJÔ — F6: conexão/filiação self-serve do dojô à federação
// Regras de negócio da solicitação (pedido → inbox → aceite → revogação).
//
// Espelha karate_practitioner_requests (H1): o dojô PEDE, a federação
// ACEITA ou RECUSA com motivo. Tabela: karate_affiliation_requests
// (migration 252).
//
// MODELO — os dois vínculos NÃO são a mesma coisa:
//   companies.federation_id         → TÉCNICO (roteamento + requireDojoAccess)
//   companies.karate_dojo_linked_at → VISIBILIDADE (migration 251)
// Um dojô self-serve nasce com o técnico e SEM o de visibilidade: a
// federação não o enxerga (PR #420) e ele não enxerga as superfícies
// federativas (PR #422). É este serviço que fecha o ciclo.
//
// DECISÃO 1 (Caio): o vínculo é setado NO ACEITE, não no pagamento.
//   approve → karate_dojo_linked_at = NOW() e tudo destrava na hora. A
//   anuidade continua no fluxo que já existe (federação lança, dojô paga
//   por PIX, régua cobra).
// DECISÃO 2 (Caio): o número de filiação é SEMPRE digitado pela federação
//   (companies.fpkt_affiliation_id). O backend NUNCA gera número — nem
//   aqui nem em lugar nenhum (nextDojoAffiliationId NÃO é usado neste
//   fluxo de propósito).
// DECISÃO 3 (Caio, 30/07/2026 — F7.4): "Somente a federação pode cancelar
//   esse vínculo. Dojô solicita, federação pode aceitar e POSTERIORMENTE
//   REVOGAR." O ciclo tinha as duas primeiras pontas; revokeAffiliation()
//   é a terceira. Não existe — e não pode passar a existir — nenhum
//   caminho pelo qual o DOJÔ se desconecte sozinho: do lado dele
//   (karateDojoConnection.js) só há GET do estado e POST do pedido.
// DECISÃO 4 (Caio, 31/07/2026 — F7.4): "A INATIVAÇÃO É FEITA PELA PRÓPRIA
//   FEDERAÇÃO." Revogar a filiação e inativar os praticantes eram, na
//   primeira versão desta função, uma coisa só; agora são DOIS ATOS
//   SEPARADOS. revokeAffiliation() apenas REVOGA. Quem inativa é a
//   federação, à mão, pelo caminho que ela já tem (cascadeInactivateDojo,
//   o "Suspender" de karateDojos.js). Ver o bloco de revokeAffiliation.
// DECISÃO 5 (Caio, 10/08/2026 — F11): "O DOJÔ ASSUME O REGISTRO
//   FEDERATIVO." A federação já tem 105 dojôs cadastrados como companies —
//   o REGISTRO FEDERATIVO, com o código FPKT, a filiação e os 9.840
//   praticantes pendurados (104 deles sem nenhum usuário). O sensei que
//   vira cliente NÃO cai nesse registro: ele cria uma conta nova, vazia, e
//   pede vínculo. NO ACEITE, a federação APONTA qual daqueles registros é
//   ele — e a conta do sensei PASSA A SER aquela linha.
//   O apontamento é OPCIONAL: sem ele, o aceite é exatamente o que sempre
//   foi (dojô genuinamente novo). Ver o bloco de approveRequest.
//
// Erros viajam como Error com .status + .code (as rotas só traduzem para
// HTTP). Defensivo 42P01/42703: leitura degrada (vazio + schema_pending),
// escrita devolve 503 SCHEMA_PENDING.
// ============================================================
'use strict';

const db = require('../config/database');
const { getDojoLinkStatus } = require('./karateDojoLinkStatus');
const {
  assumeRegistry,
  writeAssumptionTrail,
} = require('./karateDojoRegistryAssumptionService');

const VALID_STATUS = ['pending', 'approved', 'rejected'];

// Motivo da revogação: mesmo piso do reclaim da F7.4 (5 caracteres). Menos
// que isso não é motivo, é ruído — e este texto fica na trilha para alguém
// ler daqui a seis meses.
const REVOKE_REASON_MIN = 5;

// O apontamento do registro (F11) chega do corpo da requisição e entra em
// query como uuid: um 'abc' viraria 22P02 lá dentro — erro de banco cru,
// 500 e transação abortada por causa de um campo digitado errado. Barrar
// aqui devolve 422 legível ANTES de abrir transação.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.isServiceError = true;
  return err;
}

// Normaliza texto de entrada: undefined/null/'' viram null (ausente é
// NEUTRO, não erro — "dado faltante ≠ pendência").
function text(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// timestamptz → ISO 8601 UTC (mesmo contrato de linked_at em
// karateDojoLinkStatus). Nunca inventa null quando há valor cru.
function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function normalizeStatusFilter(v) {
  return VALID_STATUS.includes(v) ? v : null;
}

// ── Shapes publicados (contrato do front — não renomear) ────
function shapeRequestForDojo(r) {
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    created_at: toIso(r.created_at),
    reviewed_at: toIso(r.reviewed_at),
    rejection_reason: r.rejection_reason || null,
  };
}

function shapeRequestForFederation(r) {
  return {
    id: r.id,
    dojo: { id: r.dojo_id, name: r.dojo_name || null },
    contact_name: r.contact_name,
    contact_phone: r.contact_phone || null,
    contact_email: r.contact_email || null,
    cnpj: r.cnpj || null,
    cpf: r.cpf || null,
    city: r.city || null,
    state: r.state || null,
    students_count: r.students_count != null ? Number(r.students_count) : null,
    notes: r.notes || null,
    status: r.status,
    created_at: toIso(r.created_at),
    reviewed_at: toIso(r.reviewed_at),
    rejection_reason: r.rejection_reason || null,
  };
}

// Contato/identidade da federação para a tela do dojô. Best-effort puro
// (fora de qualquer transação): federação sem slug ou coluna ausente não
// pode derrubar a tela de conexão.
async function getFederationBrief(federationId) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(trade_name, legal_name) AS name, slug
         FROM companies WHERE id = $1 LIMIT 1`,
      [federationId]
    );
    if (!rows.length) return null;
    return { name: rows[0].name || null, slug: rows[0].slug || null };
  } catch (e) {
    console.warn('[karateAffiliationRequestService] federação indisponível (não bloqueia):', e.message);
    return null;
  }
}

// ── GET /dojo/connection ────────────────────────────────────
// status:
//   'approved' — já conectado (karate_dojo_linked_at). Vale MESMO SEM
//                registro de solicitação: todo dojô criado pela federação
//                nasce conectado e nunca pediu nada.
//   'pending' / 'rejected' / 'approved' — do último pedido, quando não
//                conectado.
//   'none'     — sem pedido e sem vínculo: é o dojô self-serve virgem.
//
// Depois de uma REVOGAÇÃO, karate_dojo_linked_at volta a ser NULL e o
// último pedido continua 'approved' (não inventamos status novo — ver
// revokeAffiliation). O dojô então vê 'approved' + linked:false, que é a
// leitura honesta: "seu pedido foi aceito um dia, hoje você não está
// filiado". Pedir de novo continua funcionando (createConnectionRequest só
// barra quem está com o vínculo ATIVO).
async function getConnectionState({ dojoId, federationId }) {
  const link = await getDojoLinkStatus(dojoId);

  let last = null;
  let schemaPending = false;
  try {
    const { rows } = await db.query(
      `SELECT id, status, created_at, reviewed_at, rejection_reason
         FROM karate_affiliation_requests
        WHERE dojo_id = $1 AND federation_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [dojoId, federationId]
    );
    last = (rows && rows[0]) || null;
  } catch (e) {
    if (e.code === '42P01') {
      // Migration 252 pendente: a tela ainda funciona — ela só não tem
      // pedido para mostrar. Quem já está conectado continua 'approved'.
      schemaPending = true;
    } else {
      throw e;
    }
  }

  const federation = await getFederationBrief(federationId);

  let status;
  if (link.linked) status = 'approved';
  else if (last) status = last.status;
  else status = 'none';

  const out = {
    status,
    linked: link.linked,
    linked_at: link.linked_at,
    request: shapeRequestForDojo(last),
    federation,
  };
  if (schemaPending) out.schema_pending = true;
  return out;
}

// ── INSERT compartilhado (dojô self-serve) ──────────────────
// Extraído de createConnectionRequest para reuso interno; hoje só o
// self-serve (POST /dojo/connection) chama este caminho.
async function insertAffiliationRequest({ dojoId, federationId, body, alreadyPendingMessage }) {
  const b = body || {};
  const contact_name = text(b.contact_name, 200);
  const contact_phone = text(b.contact_phone, 40);

  // Só nome e telefone são obrigatórios: sem um jeito de falar com o
  // sensei a federação não consegue analisar nada. Todo o resto é neutro
  // se ausente.
  if (!contact_name) {
    throw httpError(422, 'VALIDATION_ERROR', 'Campo contact_name é obrigatório');
  }
  if (!contact_phone) {
    throw httpError(422, 'VALIDATION_ERROR', 'Campo contact_phone é obrigatório');
  }

  const params = [
    federationId,
    dojoId,
    contact_name,
    contact_phone,
    text(b.contact_email, 200),
    text(b.cnpj, 32),
    text(b.cpf, 32),
    text(b.address, 400),
    text(b.city, 120),
    text(b.state, 8),
    intOrNull(b.students_count),
    text(b.notes, 2000),
  ];

  try {
    const ins = await db.query(
      `INSERT INTO karate_affiliation_requests
         (federation_id, dojo_id, contact_name, contact_phone, contact_email,
          cnpj, cpf, address, city, state, students_count, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (dojo_id) WHERE status = 'pending' DO NOTHING
       RETURNING id, status, created_at`,
      params
    );

    if (ins.rows && ins.rows.length) {
      const row = ins.rows[0];
      return {
        id: row.id,
        status: row.status,
        created_at: toIso(row.created_at),
        already_pending: false,
      };
    }

    // Já havia um pendente — devolve o mesmo (idempotente, espelha o H1).
    const existing = await db.query(
      `SELECT id, status, created_at FROM karate_affiliation_requests
        WHERE dojo_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [dojoId]
    );
    const row = (existing.rows && existing.rows[0]) || null;
    if (!row) {
      // Corrida improvável (o pendente sumiu entre as duas queries):
      // melhor um 409 honesto que uma resposta inventada.
      throw httpError(409, 'CONFLITO', 'Não foi possível registrar a solicitação. Tente novamente.');
    }
    return {
      id: row.id,
      status: row.status,
      created_at: toIso(row.created_at),
      already_pending: true,
      message: alreadyPendingMessage,
    };
  } catch (e) {
    if (e.isServiceError) throw e;
    if (e.code === '42P01' || e.code === '42703') {
      throw httpError(503, 'SCHEMA_PENDING', 'Conexão com a federação ainda não disponível (migração pendente)');
    }
    throw e;
  }
}

// ── POST /dojo/connection (LADO DOJÔ, self-serve) ───────────
// Idempotente por índice único parcial (um pending por dojô): segunda
// submissão devolve o pedido existente com already_pending:true, nunca
// duplica nem erra. Recusado NÃO bloqueia: cria um pedido novo.
async function createConnectionRequest({ dojoId, federationId, body }) {
  const link = await getDojoLinkStatus(dojoId);
  if (link.linked) {
    throw httpError(409, 'JA_CONECTADO', 'Seu dojô já está conectado a esta federação.');
  }

  return insertAffiliationRequest({
    dojoId,
    federationId,
    body,
    alreadyPendingMessage: 'Já existe uma solicitação de conexão pendente para este dojô.',
  });
}

// ── GET /affiliation-requests (inbox da federação) ──────────
// Pendentes primeiro, mais recentes no topo — a fila é para AGIR, então
// o que exige ação vem antes do histórico.
async function listRequests({ federationId, status }) {
  const filter = normalizeStatusFilter(status);
  try {
    const { rows } = await db.query(
      `SELECT r.*, COALESCE(comp.trade_name, comp.legal_name) AS dojo_name
         FROM karate_affiliation_requests r
         LEFT JOIN companies comp ON comp.id = r.dojo_id
        WHERE r.federation_id = $1
          AND ($2::text IS NULL OR r.status = $2)
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC
        LIMIT 200`,
      [federationId, filter]
    );
    const data = (rows || []).map(shapeRequestForFederation);
    return { data, count: data.length };
  } catch (e) {
    if (e.code === '42P01') return { data: [], count: 0, schema_pending: true };
    throw e;
  }
}

// ── GET /affiliation-requests/metrics ───────────────────────
async function requestMetrics({ federationId }) {
  const empty = { pending: 0, approved: 0, rejected: 0, mais_antiga: null };
  try {
    const { rows } = await db.query(
      `SELECT
          count(*) FILTER (WHERE r.status = 'pending')::int  AS pending,
          count(*) FILTER (WHERE r.status = 'approved')::int AS approved,
          count(*) FILTER (WHERE r.status = 'rejected')::int AS rejected,
          min(r.created_at) FILTER (WHERE r.status = 'pending') AS mais_antiga_criada_em
         FROM karate_affiliation_requests r
        WHERE r.federation_id = $1`,
      [federationId]
    );
    const t = (rows && rows[0]) || {};
    const criadaEm = t.mais_antiga_criada_em || null;
    return {
      pending: t.pending || 0,
      approved: t.approved || 0,
      rejected: t.rejected || 0,
      mais_antiga: criadaEm
        ? {
            criada_em: toIso(criadaEm),
            dias: Math.floor((Date.now() - new Date(criadaEm).getTime()) / 86400000),
          }
        : null,
    };
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return { ...empty, schema_pending: true };
    throw e;
  }
}

// ── POST /affiliation-requests/:requestId/approve ───────────
// TRANSAÇÃO ÚNICA: ou o dojô fica conectado COM número e o pedido fica
// approved, ou nada acontece. Nenhum passo best-effort dentro do BEGIN
// (um try/catch que engole erro ali dentro envenenaria a transação e o
// COMMIT viraria ROLLBACK silencioso — armadilha tx-poison).
//
// ── O APONTAMENTO (F11) É OPCIONAL ──────────────────────────
// `targetCompanyId` responde "QUAL dos registros federativos preexistentes
// É este dojô?".
//
//   SEM apontamento → este handler faz exatamente o que sempre fez: é o
//     caminho do dojô genuinamente novo, aquele que não tem registro
//     nenhum na federação. Nenhuma query nova roda, nada é migrado, e ele
//     continua funcionando com a migration 275 NÃO aplicada.
//   COM apontamento → antes de marcar o vínculo, a conta do sensei ASSUME
//     aquele registro (karateDojoRegistryAssumptionService.assumeRegistry,
//     na MESMA transação): o usuário dele vira owner da company do
//     registro, o trabalho que ele já tinha é reapontado, e a company do
//     cadastro é DESATIVADA (nunca apagada). Os praticantes NÃO se movem —
//     eles já estão no registro, é o usuário que se move.
//
// DUAS CONSEQUÊNCIAS que não podem ser esquecidas por quem mexer aqui:
//   • quem recebe o número e o vínculo passa a ser O REGISTRO. Marcar a
//     conta do cadastro deixaria karate_dojo_linked_at numa company
//     is_active=false — vínculo em empresa que não existe mais para
//     ninguém;
//   • a checagem de número duplicado precisa EXCLUIR o registro, não a
//     conta que pediu: o número que a federação digita é, quase sempre,
//     exatamente o que aquele registro JÁ TEM. Excluir a conta nova
//     devolveria FPKT_NUMBER_TAKEN do registro contra ele mesmo.
//
// karate_affiliation_requests.dojo_id NÃO é reapontado, de propósito: ele
// registra QUEM PEDIU, e quem pediu foi a conta nova. Para onde o pedido
// levou está na trilha (karate_dojo_registry_assumptions + roster event
// 'registry_assumed') — é lá que essa pergunta se responde.
async function approveRequest({ federationId, requestId, fpktNumber, actorId, targetCompanyId }) {
  const numero = text(fpktNumber, 60);
  if (!numero) {
    throw httpError(
      422,
      'FPKT_NUMBER_REQUIRED',
      'Campo fpkt_number é obrigatório para aprovar a filiação — o número é emitido pela federação, este sistema nunca gera número.'
    );
  }

  // Apontamento OPCIONAL: ausente é neutro, não erro. Presente e malformado
  // é erro — e barrado antes de qualquer transação (um não-uuid viraria
  // 22P02 dentro do BEGIN).
  const alvo = text(targetCompanyId, 64);
  if (alvo && !UUID_RE.test(alvo)) {
    throw httpError(
      422,
      'TARGET_COMPANY_INVALID',
      'O registro apontado (target_company_id) não é um identificador válido.'
    );
  }

  const client = await db.connect();
  let inTx = false;
  try {
    await client.query('BEGIN');
    inTx = true;

    const cur = await client.query(
      `SELECT id, dojo_id, status FROM karate_affiliation_requests
        WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [requestId, federationId]
    );
    const reqRow = (cur && cur.rows && cur.rows[0]) || null;
    if (!reqRow) {
      throw httpError(404, 'NOT_FOUND', 'Solicitação de filiação não encontrada');
    }
    if (reqRow.status !== 'pending') {
      throw httpError(409, 'JA_RESOLVIDA', 'Solicitação já foi resolvida');
    }

    // Apontar a própria conta que pediu não é assunção: seria a conta se
    // engolindo (e a validação de "registro sem usuário" recusaria com uma
    // mensagem que não explica nada). Se a conta que pediu JÁ É o registro,
    // o aceite é o aceite comum — sem apontamento.
    if (alvo && String(alvo) === String(reqRow.dojo_id)) {
      throw httpError(
        422,
        'TARGET_IS_REQUESTER',
        'O registro apontado é a própria conta que pediu a filiação. Se ela já é o registro federativo, aprove sem apontar nenhum registro.'
      );
    }

    // COM apontamento, o dojô que sai daqui filiado é o REGISTRO.
    const dojoIdEfetivo = alvo || reqRow.dojo_id;

    // Número único DENTRO da federação (mesmo escopo do número de
    // praticante). Exclui o próprio dojô: reaprovar mantendo o mesmo
    // número não pode colidir consigo mesmo — e, com apontamento, "o
    // próprio dojô" é o REGISTRO (que tipicamente já carrega esse número).
    const dup = await client.query(
      `SELECT id FROM companies
        WHERE federation_id = $1 AND fpkt_affiliation_id = $2 AND id <> $3
        LIMIT 1`,
      [federationId, numero, dojoIdEfetivo]
    );
    if (dup.rows && dup.rows.length) {
      throw httpError(409, 'FPKT_NUMBER_TAKEN', 'Número de filiação já em uso nesta federação.');
    }

    // A ASSUNÇÃO (F11) — dentro desta MESMA transação: ou o sensei vira dono
    // do registro E o pedido fica approved, ou nada aconteceu. Ela valida o
    // registro apontado (é desta federação? é dojô? ainda não tem usuário?) e
    // lança erro de serviço com código próprio quando não é.
    let assumption = null;
    if (alvo) {
      assumption = await assumeRegistry(client, {
        federationId,
        requesterCompanyId: reqRow.dojo_id,
        targetCompanyId: alvo,
      });
    }

    // O ACEITE é o que cria a conexão (DECISÃO 1). COALESCE em
    // karate_dojo_linked_at e affiliation_since: reaprovação nunca
    // reescreve a data original do vínculo.
    const upd = await client.query(
      `UPDATE companies
          SET karate_dojo_linked_at = COALESCE(karate_dojo_linked_at, NOW()),
              fpkt_affiliation_id   = $1,
              affiliation_since     = COALESCE(affiliation_since, CURRENT_DATE)
        WHERE id = $2 AND federation_id = $3
      RETURNING id, karate_dojo_linked_at, fpkt_affiliation_id`,
      [numero, dojoIdEfetivo, federationId]
    );
    const comp = (upd && upd.rows && upd.rows[0]) || null;
    if (!comp) {
      throw httpError(404, 'DOJO_NOT_FOUND', 'Dojô da solicitação não encontrado nesta federação');
    }

    await client.query(
      `UPDATE karate_affiliation_requests
          SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1, updated_at = NOW()
        WHERE id = $2`,
      [actorId || null, requestId]
    );

    // Trilha da assunção — best-effort por SAVEPOINT lá dentro: enquanto a
    // migration 275 não for aplicada, 42P01 degrada e o aceite acontece do
    // mesmo jeito (o rastro fica em karate_dojo_roster_events, da 220).
    if (assumption) {
      const trail = await writeAssumptionTrail(client, {
        federationId,
        requestId,
        result: assumption,
        actorId,
        fpktNumber: numero,
      });
      assumption.trail_persisted = trail.trail_persisted;
    }

    await client.query('COMMIT');
    inTx = false;

    const out = {
      ok: true,
      dojo_id: comp.id,
      fpkt_affiliation_id: comp.fpkt_affiliation_id,
      linked_at: toIso(comp.karate_dojo_linked_at),
    };

    if (assumption) {
      out.assumption = assumption;
      // Explícito na resposta: o dojo_id devolvido NÃO é o da conta que
      // pediu. Quem consome isto (front da federação) precisa saber que o
      // alvo mudou sem ter que ler documentação.
      out.requester_company_id = reqRow.dojo_id;
      out.message =
        `Filiação aprovada. A conta do sensei passou a ser o registro ${assumption.to_company_name || ''}`.trim() +
        ' — os praticantes já cadastrados nele continuam onde estavam, e a conta usada no cadastro foi desativada.';
    }

    return out;
  } catch (e) {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch (_) { /* conexão já morta */ }
    }
    if (e.isServiceError) throw e;
    if (e.code === '23505') {
      throw httpError(409, 'FPKT_NUMBER_TAKEN', 'Número de filiação já em uso nesta federação.');
    }
    if (e.code === '42P01' || e.code === '42703') {
      throw httpError(503, 'SCHEMA_PENDING', 'Filiação do dojô ainda não disponível (migração pendente)');
    }
    throw e;
  } finally {
    client.release();
  }
}

// ── POST /affiliation-requests/:requestId/reject ────────────
// NÃO toca karate_dojo_linked_at: recusar não desconecta ninguém (e um
// dojô recusado nunca esteve conectado). Sem transação de propósito — é
// um único UPDATE, autocommit por statement.
async function rejectRequest({ federationId, requestId, reason, actorId }) {
  const motivo = text(reason, 1000);
  if (!motivo) {
    throw httpError(422, 'VALIDATION_ERROR', 'Campo reason é obrigatório (o sensei vê o motivo)');
  }

  try {
    const upd = await db.query(
      `UPDATE karate_affiliation_requests
          SET status = 'rejected', rejection_reason = $1,
              reviewed_at = NOW(), reviewed_by = $2, updated_at = NOW()
        WHERE id = $3 AND federation_id = $4 AND status = 'pending'
      RETURNING id, dojo_id, status, rejection_reason, reviewed_at`,
      [motivo, actorId || null, requestId, federationId]
    );

    if (!upd.rows || !upd.rows.length) {
      const exists = await db.query(
        `SELECT id FROM karate_affiliation_requests WHERE id = $1 AND federation_id = $2`,
        [requestId, federationId]
      );
      if (!exists.rows || !exists.rows.length) {
        throw httpError(404, 'NOT_FOUND', 'Solicitação de filiação não encontrada');
      }
      throw httpError(409, 'JA_RESOLVIDA', 'Solicitação já foi resolvida');
    }

    const row = upd.rows[0];
    return {
      ok: true,
      request_id: row.id,
      dojo_id: row.dojo_id,
      status: row.status,
      rejection_reason: row.rejection_reason,
      reviewed_at: toIso(row.reviewed_at),
    };
  } catch (e) {
    if (e.isServiceError) throw e;
    if (e.code === '42P01') {
      throw httpError(503, 'SCHEMA_PENDING', 'Filiação do dojô ainda não disponível (migração pendente)');
    }
    throw e;
  }
}

// ============================================================
// REVOGAÇÃO DA FILIAÇÃO (F7.4 — ato EXCLUSIVO da federação)
// ============================================================
// AS DUAS ORDENS DO DONO DO PRODUTO, NA ORDEM EM QUE CHEGARAM:
//
//   30/07/2026 — "Somente a federação pode cancelar esse vínculo. Dojô
//     solicita, federação pode aceitar e posteriormente revogar."
//   31/07/2026 — "A INATIVAÇÃO É FEITA PELA PRÓPRIA FEDERAÇÃO."
//
// A segunda corrige a primeira implementação: revogar a filiação e inativar
// os praticantes daquele dojô eram, aqui, UMA transação só. Não são mais.
// São DOIS ATOS SEPARADOS, cada um disparado por uma decisão humana da
// federação:
//
//   ATO 1 — REVOGAR A FILIAÇÃO (esta função)
//           companies.karate_dojo_linked_at = NULL + a trilha do ato.
//           O dojô sai das listagens, contagens, agregados, régua e saúde
//           da rede da federação (todas filtram
//           `karate_dojo_linked_at IS NOT NULL`) e perde as superfícies
//           federativas do lado dele (karateDojoLinkStatus).
//
//   ATO 2 — INATIVAR OS PRATICANTES (NÃO é feito aqui)
//           cascadeInactivateDojo(), o "Suspender" da UI da federação
//           (PATCH /federation/:id/dojos/:dojoId com is_active=false, em
//           karateDojos.js). Esse caminho JÁ EXISTIA antes desta F7.4,
//           continua exatamente como estava, e é INDEPENDENTE da revogação:
//           dá para suspender sem revogar, revogar sem suspender, ou os
//           dois. Este PR não criou caminho novo de inativação e não
//           alterou uma linha de karateDojos.js.
//
// POR QUE SEPARAR — revogar é um fato jurídico do vínculo entre pessoas
// jurídicas; inativar é um juízo sobre CADA praticante, que pode continuar
// treinando, se transferir ou já estar inativo. Amarrar os dois tirava da
// federação a decisão que é dela, e tornava a revogação um ato de efeito
// irreversível em massa (dezenas de fichas) para quem só queria desfazer
// uma filiação.
//
// ── INFORMAÇÃO, NUNCA AÇÃO ──────────────────────────────────
// Para a federação decidir se suspende, a resposta informa quantos
// praticantes ATIVOS aquele dojô ainda tem (`active_practitioners`) — uma
// contagem escalar, lida na mesma transação, best-effort por SAVEPOINT: se
// ela não vier, a revogação acontece do mesmo jeito e o campo vem null.
// É um número na tela, não um gatilho.
//
// ── O QUE A REVOGAÇÃO **NÃO** FAZ ───────────────────────────
//   • NÃO toca customers. Nenhum UPDATE, nenhum is_active, nenhum snapshot.
//     Ver ATO 2 acima: a inativação é da federação, à mão.
//   • NÃO apaga nada. Nem praticante, nem graduação, nem histórico. "Os
//     dados permanecem, some só a condição de filiado ativo."
//   • NÃO toca karate_identity_managed_by / karate_identity_dojo_id.
//     Desfiliar NÃO devolve a gestão da ficha para a federação: o dojô
//     desfiliado continua usando o Aura e continua dono da identidade dos
//     alunos dele (premissa 1 — o fluxo SOBE). Quem devolve a gestão é só a
//     SAÍDA DO AURA (karateDojoExitState: apagado, inativado, vertical
//     desligada).
//   • NÃO limpa fpkt_affiliation_id nem affiliation_since: são o histórico da
//     filiação que existiu, e o número precisa continuar reservado para o dojô
//     dentro da federação.
//   • NÃO mexe em karate_affiliation_requests.status. O CHECK da 252 fecha em
//     (pending|approved|rejected); um 'revoked' seria 23514 e derrubaria a
//     transação inteira. Zero DDL nesta onda — a 264 continua livre. O estado
//     "foi aceito um dia, hoje não está filiado" é legível sem inventar
//     status: request.status='approved' + linked:false (ver getConnectionState).
//
// ── SÓ A FEDERAÇÃO CANCELA (auditado, não presumido) ────────
// Varri o repositório atrás de qualquer caminho pelo qual o DOJÔ se
// desconecte sozinho: NÃO EXISTE, e este PR não cria nenhum.
// karate_dojo_linked_at só era escrito em três lugares, os três setando
// NOW() (approveRequest aqui, POST /dojos de karateDojos.js e o
// PATCH /clients/:cid/karate de adminKarate.js) — era um trinco de mão
// única. Do lado do dojô (karateDojoConnection.js) há apenas GET do estado e
// POST do pedido, e o POST é bloqueado no Canal B (403 PORTAL_READ_ONLY).
// Esta função é a ÚNICA que devolve a coluna para NULL, e a rota que a expõe
// é guards.staffWrite() no escopo /federation/:id.
// (Não confundir com DELETE /dojo/students/:sid/federate, o "desvincular" da
// F7.1: aquilo é o dojô abrindo mão da adoção de UM aluno dele, não a
// filiação do dojô à federação.)
//
// ── TRILHA (sem DDL) ────────────────────────────────────────
// karate_dojo_roster_events.event NÃO tem CHECK (migration 220 — e o
// cabeçalho da 263 registra isso com todas as letras), então o evento
// 'affiliation_revoked' cabe sem tocar em schema. Ele registra O ATO: quem,
// quando, por quê, desde quando o dojô estava filiado e quantos praticantes
// ativos ficaram para a federação avaliar.
// NÃO gravamos mais o snapshot 'inactivate_cascade': aquele evento é o
// contrato de cascadeInactivateDojo()/cascadeReactivateDojo() e passa a ser
// escrito só por quem de fato inativa — a federação, no ATO 2. Gravar um
// snapshot aqui sujaria a restauração daquele caminho com um evento que
// nunca inativou ninguém.
// A escrita da trilha é best-effort por SAVEPOINT (42P01: migration 220
// pendente não pode derrubar a revogação, exatamente como safeRosterWrite em
// karateDojos.js). O núcleo — UPDATE companies — nunca é engolido: erro ali
// aborta a transação, como tem que ser.
// ============================================================

// Espelha safeRosterWrite de karateDojos.js: SAVEPOINT antes, ROLLBACK TO
// SAVEPOINT em 42P01/42703, rethrow em qualquer outro erro. NUNCA um
// try/catch nu dentro do BEGIN (armadilha tx-poison). Devolve o resultado de
// fn(), ou null quando o passo degradou.
async function safeStep(client, label, fn) {
  await client.query('SAVEPOINT sp_affiliation_revoke');
  try {
    const out = await fn();
    await client.query('RELEASE SAVEPOINT sp_affiliation_revoke');
    return out;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) {
      await client.query('ROLLBACK TO SAVEPOINT sp_affiliation_revoke');
      console.warn(`[karateAffiliationRequestService] passo ignorado (schema pendente): ${label}`);
      return null;
    }
    throw e;
  }
}

// revokeAffiliation({ federationId, dojoId, reason, actorId })
//   200 { ok, revoked, dojo_id, dojo_name, was_linked_at, reason,
//         practitioners_changed:false, identity_management_changed:false,
//         active_practitioners }
//   422 REVOKE_REASON_REQUIRED | 404 NOT_FOUND | 409 NAO_CONECTADO
async function revokeAffiliation({ federationId, dojoId, reason, actorId } = {}) {
  if (!dojoId) {
    throw httpError(422, 'VALIDATION_ERROR', 'Campo dojo_id é obrigatório');
  }
  const motivo = text(reason, 1000);
  if (!motivo || motivo.length < REVOKE_REASON_MIN) {
    throw httpError(
      422,
      'REVOKE_REASON_REQUIRED',
      'Informe o motivo da revogação (ele fica registrado na trilha da filiação).'
    );
  }

  const client = await db.connect();
  let inTx = false;
  try {
    await client.query('BEGIN');
    inTx = true;

    // Trava a company DENTRO do escopo da federação e da vertical: revogar
    // filiação de dojô que não é desta federação não é 403, é inexistente.
    const cur = await client.query(
      `SELECT id,
              COALESCE(trade_name, legal_name) AS dojo_name,
              karate_dojo_linked_at
         FROM companies
        WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
        FOR UPDATE`,
      [dojoId, federationId]
    );
    const comp = (cur && cur.rows && cur.rows[0]) || null;
    if (!comp) {
      throw httpError(404, 'NOT_FOUND', 'Dojô não encontrado nesta federação');
    }
    if (comp.karate_dojo_linked_at === null || comp.karate_dojo_linked_at === undefined) {
      // Idempotência honesta: não há vínculo para cancelar. Um 409 explícito
      // é mais útil que um 200 que não revogou nada.
      throw httpError(409, 'NAO_CONECTADO', 'Este dojô não está filiado a esta federação.');
    }

    // INFORMAÇÃO (não ação): quantos praticantes ATIVOS o dojô ainda tem, com
    // o mesmo critério que a federação já usa em karateDojos.js
    // (`COUNT(*) FILTER (WHERE is_active = true)`, com is_active NULL contando
    // como ativo). Escalar, um índice em dojo_id resolve, e best-effort: se
    // degradar, o campo vem null e a revogação acontece do mesmo jeito.
    const cnt = await safeStep(client, 'contagem de praticantes ativos', () => client.query(
      `SELECT COUNT(*)::int AS active_practitioners
         FROM customers
        WHERE dojo_id = $1 AND COALESCE(is_active, true) = true`,
      [dojoId]
    ));
    const raw = cnt && cnt.rows && cnt.rows[0] ? cnt.rows[0].active_practitioners : null;
    const activePractitioners = raw === null || raw === undefined ? null : Number(raw);

    // Trilha — o ATO. actor_id é uuid: um 'staff1' de teste viraria 22P02 e
    // derrubaria a revogação inteira por causa do log; o rastro humano fica
    // no payload (mesma decisão do asUuid de karateStudentIdentityLink).
    const actorUuid =
      actorId && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(actorId))
        ? String(actorId)
        : null;

    await safeStep(client, 'affiliation_revoked event', () => client.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, 'affiliation_revoked', $3::jsonb, $4)`,
      [
        dojoId,
        federationId,
        JSON.stringify([
          {
            reason: motivo,
            actor_id: actorId || null,
            was_linked_at: toIso(comp.karate_dojo_linked_at),
            active_practitioners: activePractitioners,
            note:
              'Revogação da filiação pela federação. Nenhum praticante foi alterado (a inativação é ato ' +
              'próprio da federação, pelo Suspender do dojô), nenhum dado foi apagado e a gestão das fichas ' +
              'NÃO mudou de dono: o dojô continua usando o Aura e continua mantendo a identidade dos alunos dele.',
          },
        ]),
        actorUuid,
      ]
    ));

    // NÚCLEO (único) — o vínculo cai. Esta é a ÚNICA escrita de NULL nesta
    // coluna em todo o repositório, e ela só é alcançável por
    // guards.staffWrite() da federação.
    const off = await client.query(
      `UPDATE companies
          SET karate_dojo_linked_at = NULL, updated_at = NOW()
        WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
      RETURNING id`,
      [dojoId, federationId]
    );
    if (!off.rows || !off.rows.length) {
      throw httpError(404, 'NOT_FOUND', 'Dojô não encontrado nesta federação');
    }

    await client.query('COMMIT');
    inTx = false;

    const quantos =
      activePractitioners === null
        ? ''
        : ` Este dojô ainda tem ${activePractitioners} praticante(s) ativo(s) na sua visão — se for o caso, ` +
          'suspenda o dojô para inativá-los.';

    return {
      ok: true,
      revoked: true,
      dojo_id: dojoId,
      dojo_name: comp.dojo_name || null,
      was_linked_at: toIso(comp.karate_dojo_linked_at),
      reason: motivo,
      // As duas coisas que a revogação NÃO faz, ditas na resposta para não
      // depender de ninguém ler a documentação.
      practitioners_changed: false,
      identity_management_changed: false,
      active_practitioners: activePractitioners,
      message:
        `A filiação do dojô ${comp.dojo_name || ''} foi revogada. Nenhum praticante foi alterado e nenhum dado ` +
        'foi apagado; a gestão das fichas continua com o dojô.' + quantos,
    };
  } catch (e) {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch (_) { /* conexão já morta */ }
    }
    if (e.isServiceError) throw e;
    if (e.code === '42P01' || e.code === '42703') {
      throw httpError(503, 'SCHEMA_PENDING', 'Revogação de filiação ainda não disponível (migração pendente)');
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  getConnectionState,
  createConnectionRequest,
  listRequests,
  requestMetrics,
  approveRequest,
  rejectRequest,
  revokeAffiliation,
  // exportados para teste/reuso
  httpError,
  VALID_STATUS,
  REVOKE_REASON_MIN,
};
