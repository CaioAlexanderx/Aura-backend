// ============================================================
// AURA DOJÔ — F6: conexão/filiação self-serve do dojô à federação
// Regras de negócio da solicitação (pedido → inbox → aceite).
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
//
// Erros viajam como Error com .status + .code (as rotas só traduzem para
// HTTP). Defensivo 42P01/42703: leitura degrada (vazio + schema_pending),
// escrita devolve 503 SCHEMA_PENDING.
// ============================================================
'use strict';

const db = require('../config/database');
const { getDojoLinkStatus } = require('./karateDojoLinkStatus');

const VALID_STATUS = ['pending', 'approved', 'rejected'];

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

// ── POST /dojo/connection ───────────────────────────────────
// Idempotente por índice único parcial (um pending por dojô): segunda
// submissão devolve o pedido existente com already_pending:true, nunca
// duplica nem erra. Recusado NÃO bloqueia: cria um pedido novo.
async function createConnectionRequest({ dojoId, federationId, body }) {
  const link = await getDojoLinkStatus(dojoId);
  if (link.linked) {
    throw httpError(409, 'JA_CONECTADO', 'Seu dojô já está conectado a esta federação.');
  }

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
      message: 'Já existe uma solicitação de conexão pendente para este dojô.',
    };
  } catch (e) {
    if (e.isServiceError) throw e;
    if (e.code === '42P01') {
      throw httpError(503, 'SCHEMA_PENDING', 'Conexão com a federação ainda não disponível (migração pendente)');
    }
    throw e;
  }
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
    if (e.code === '42P01') return { ...empty, schema_pending: true };
    throw e;
  }
}

// ── POST /affiliation-requests/:requestId/approve ───────────
// TRANSAÇÃO ÚNICA: ou o dojô fica conectado COM número e o pedido fica
// approved, ou nada acontece. Nenhum passo best-effort dentro do BEGIN
// (um try/catch que engole erro ali dentro envenenaria a transação e o
// COMMIT viraria ROLLBACK silencioso — armadilha tx-poison).
async function approveRequest({ federationId, requestId, fpktNumber, actorId }) {
  const numero = text(fpktNumber, 60);
  if (!numero) {
    throw httpError(
      422,
      'FPKT_NUMBER_REQUIRED',
      'Campo fpkt_number é obrigatório para aprovar a filiação — o número é emitido pela federação, este sistema nunca gera número.'
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

    // Número único DENTRO da federação (mesmo escopo do número de
    // praticante). Exclui o próprio dojô: reaprovar mantendo o mesmo
    // número não pode colidir consigo mesmo.
    const dup = await client.query(
      `SELECT id FROM companies
        WHERE federation_id = $1 AND fpkt_affiliation_id = $2 AND id <> $3
        LIMIT 1`,
      [federationId, numero, reqRow.dojo_id]
    );
    if (dup.rows && dup.rows.length) {
      throw httpError(409, 'FPKT_NUMBER_TAKEN', 'Número de filiação já em uso nesta federação.');
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
      [numero, reqRow.dojo_id, federationId]
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

    await client.query('COMMIT');
    inTx = false;

    return {
      ok: true,
      dojo_id: comp.id,
      fpkt_affiliation_id: comp.fpkt_affiliation_id,
      linked_at: toIso(comp.karate_dojo_linked_at),
    };
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

module.exports = {
  getConnectionState,
  createConnectionRequest,
  listRequests,
  requestMetrics,
  approveRequest,
  rejectRequest,
  // exportados para teste/reuso
  httpError,
  VALID_STATUS,
};
