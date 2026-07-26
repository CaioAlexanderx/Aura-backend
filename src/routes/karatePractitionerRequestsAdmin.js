// ============================================================
// AURA KARATÊ — Aprovação/gestão de solicitações de praticante (H1)
// Lado FEDERAÇÃO. Montado sob /federation/:id. Guards de karateRoles.
//
//   GET   /federation/:id/practitioner-requests?status=&dojo_id=
//         — lista com possíveis correspondências JÁ EMBUTIDAS por item
//           (dedup é sugestão, nunca decide sozinha).
//   GET   /federation/:id/practitioner-requests/:requestId
//         — detalhe (payload completo + matches).
//   PATCH /federation/:id/practitioner-requests/:requestId
//         — edita ANTES de aprovar (dado do sensei pode vir errado). Só
//           permitido em status='pendente'.
//   POST  /federation/:id/practitioner-requests/:requestId/approve-create
//         — cria o praticante NO DOJÔ DA SOLICITAÇÃO. Exige fpkt_number no
//           body (OBRIGATÓRIO — sem número não cria; o número é emitido
//           pela federação, nunca por nós). Ativo, faixa alegada semeia o
//           histórico. NÃO gera cobrança, não mexe em terceiros.
//   POST  /federation/:id/practitioner-requests/:requestId/approve-transfer
//         — vincula a um praticante JÁ EXISTENTE e o move para o dojô da
//           solicitação (reusa o padrão de karateTransfers.js — histórico
//           append-only). NÃO gera cobrança.
//   POST  /federation/:id/practitioner-requests/:requestId/reject
//         — rejeita com motivo (obrigatório — o sensei tem que ver).
//
// Auditoria: cada resolução grava resolved_by/resolved_at na própria linha
// da solicitação + um evento em karate_dojo_roster_events (mesmo padrão dos
// demais fluxos de roster — não usa karate_finance_audit_log porque o
// target_type dessa tabela é restrito a 'annuity'/'installment' e isto não
// é ação financeira).
//
// ── F5a (26/07/2026) ─────────────────────────────────────
// A solicitação agora pode ter nascido de um ALUNO do dojô
// (karate_practitioner_requests.student_id, migration 253). Nesse caso a
// aprovação fecha o ciclo: o practitioner_id resultante volta para o aluno
// (karate_dojo_students) na MESMA transação — ver
// linkDojoStudentOnApprove abaixo.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { findPossibleMatches, normalizeFpktNumber, buildDedupKey } = require('../services/karatePractitionerDedup');

// ── Contato do dojô + link do sensei p/ o botão "Avisar no WhatsApp" ────
// (item wa.me pós-rejeição). Telefone do DOJÔ (celular > fixo — WhatsApp
// não funciona em fixo) + URL do link de atualização de quadro do sensei,
// pra mensagem já carregar pra onde ele corrige e reenvia. Aditivo — não
// muda nenhum contrato existente, só acrescenta campos.
//
// companies.phone_mobile é a Migration 230 e karate_dojo_roster_validation
// é a Migration 220: ambas já aplicadas em prod, mas o backend sobe antes
// da migration em deploys parciais (CLAUDE.md #1/#10) — cache module-level,
// desliga na primeira 42703/42P01 e nunca derruba list/detail/reject por
// causa deste extra (best-effort puro).
let HAS_PHONE_MOBILE_COL = true;
let HAS_ROSTER_VALIDATION_TABLE = true;

const APP_URL = process.env.APP_URL || 'https://app.getaura.com.br';
function rosterUpdateUrl(token) {
  return token ? `${APP_URL}/karate/roster-update/${token}` : null;
}

// Best-effort: nunca lança — telefone ausente/coluna ausente vira null,
// nunca erro. Não vaza telefone de terceiros: é o telefone do DOJÔ, que a
// federação já administra (não é dado de praticante/responsável).
async function getDojoContactBestEffort(dojoId) {
  try {
    const { rows } = await db.query(
      `SELECT phone${HAS_PHONE_MOBILE_COL ? ', phone_mobile' : ', NULL::text AS phone_mobile'}
         FROM companies WHERE id = $1 LIMIT 1`,
      [dojoId]
    );
    if (!rows.length) return { phone: null, phone_mobile: null };
    return { phone: rows[0].phone || null, phone_mobile: rows[0].phone_mobile || null };
  } catch (e) {
    if (e.code === '42703' && HAS_PHONE_MOBILE_COL && /phone_mobile/.test(e.message || '')) {
      HAS_PHONE_MOBILE_COL = false;
      return getDojoContactBestEffort(dojoId);
    }
    console.warn('[karatePractitionerRequestsAdmin] contato do dojô indisponível (não bloqueia):', e.message);
    return { phone: null, phone_mobile: null };
  }
}

// Best-effort: URL do link público do sensei (mesmo token usado pelo fluxo
// de reabertura de acesso em reopenDojoRosterAccessBestEffort — aqui só
// LEMOS o token atual, não mexemos em expires_at).
async function getDojoRosterUpdateUrlBestEffort(dojoId) {
  if (!HAS_ROSTER_VALIDATION_TABLE) return null;
  try {
    const { rows } = await db.query(
      `SELECT token FROM karate_dojo_roster_validation WHERE dojo_id = $1 AND token IS NOT NULL LIMIT 1`,
      [dojoId]
    );
    return rows.length ? rosterUpdateUrl(rows[0].token) : null;
  } catch (e) {
    if (e.code === '42P01') {
      HAS_ROSTER_VALIDATION_TABLE = false;
      return null;
    }
    console.warn('[karatePractitionerRequestsAdmin] link do dojô indisponível (não bloqueia):', e.message);
    return null;
  }
}

// Junta os dois helpers acima num único bloco de campos aditivos, usado em
// shapeDetail() (list/detail) e na resposta do reject.
async function dojoWhatsappFieldsBestEffort(dojoId) {
  const [contact, dojo_roster_update_url] = await Promise.all([
    getDojoContactBestEffort(dojoId),
    getDojoRosterUpdateUrlBestEffort(dojoId),
  ]);
  return {
    dojo_phone: contact.phone,
    dojo_phone_mobile: contact.phone_mobile,
    dojo_whatsapp_phone: contact.phone_mobile || contact.phone || null,
    dojo_roster_update_url,
  };
}

async function logRosterEventBestEffort(client, { dojoId, federationId, event, affected, actorId = null }) {
  await client.query('SAVEPOINT sp_practitioner_request_event');
  try {
    await client.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [dojoId, federationId, event, JSON.stringify(affected), actorId]
    );
    await client.query('RELEASE SAVEPOINT sp_practitioner_request_event');
  } catch (e) {
    if (e.code === '42P01') {
      await client.query('ROLLBACK TO SAVEPOINT sp_practitioner_request_event');
      console.warn('[karatePractitionerRequestsAdmin] karate_dojo_roster_events ausente (schema pendente)');
    } else {
      throw e;
    }
  }
}

// Variante SEM transação do caller (ex.: reject, que não abre BEGIN — o
// UPDATE principal já é autocommit por statement). SAVEPOINT exige estar
// dentro de um bloco de transação; usar db.query (pool) direto aqui, sem
// SAVEPOINT nenhum, é o jeito seguro (CLAUDE.md #10 — nunca best-effort
// dentro de BEGIN sem SAVEPOINT; a contrapartida é: fora de BEGIN, um
// try/catch comum já é seguro, SAVEPOINT seria erro 25P01).
async function logRosterEventStandalone({ dojoId, federationId, event, affected, actorId = null }) {
  try {
    await db.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [dojoId, federationId, event, JSON.stringify(affected), actorId]
    );
  } catch (e) {
    if (e.code === '42P01') {
      console.warn('[karatePractitionerRequestsAdmin] karate_dojo_roster_events ausente (schema pendente)');
    } else {
      console.error('[karatePractitionerRequestsAdmin] falha ao gravar roster event (não bloqueia):', e.message);
    }
  }
}

// ── F5a: devolver o praticante ao ALUNO que originou a solicitação ────
// A solicitação criada por POST /dojo/students/:sid/federate carrega
// student_id (migration 253). Aprovar é o momento — e o ÚNICO momento — em
// que a federação CONFIRMA o que o sensei declarou, então é aqui que o
// practitioner_id volta para karate_dojo_students. Dentro da MESMA
// transação do approve: se ficasse para depois do COMMIT, uma falha
// deixaria o aluno "pendente" para sempre com o praticante já criado.
//
// SAVEPOINT (nunca try/catch nu dentro de BEGIN — tx-poison): schema do
// lado do dojô ausente (42703 is_federated / 42P01 karate_dojo_students,
// migrations 253/242 pendentes) NÃO pode derrubar a aprovação, que é o ato
// da FEDERAÇÃO. Fail-open explícito: perde-se o fio de volta (o sensei
// revincula pelo número FPKT em /federate), nunca o praticante.
//
// student_id vem undefined (não erro) quando a migration 253 ainda não
// rodou — SELECT * não falha por coluna ausente na SELECT-list.
async function linkDojoStudentOnApprove(client, { studentId, dojoId, practitionerId }) {
  if (!studentId || !practitionerId) return { linked: false, reason: 'no_student' };

  const SP = 'SAVEPOINT sp_link_dojo_student';
  const attempt = async (withFederatedCol) => {
    await client.query(
      `UPDATE karate_dojo_students
          SET practitioner_id = $1${withFederatedCol ? ', is_federated = true' : ''}, updated_at = now()
        WHERE id = $2 AND dojo_id = $3`,
      [practitionerId, studentId, dojoId]
    );
  };

  await client.query(SP);
  try {
    await attempt(true);
    await client.query('RELEASE SAVEPOINT sp_link_dojo_student');
    return { linked: true };
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
    await client.query('ROLLBACK TO SAVEPOINT sp_link_dojo_student');
    if (e.code === '42P01') {
      console.warn('[karatePractitionerRequestsAdmin] karate_dojo_students ausente (migration 242 pendente) — aluno não vinculado');
      await client.query('RELEASE SAVEPOINT sp_link_dojo_student');
      return { linked: false, reason: 'schema_pending' };
    }
    // 42703: provavelmente is_federated (migration 253 pendente) — grava só
    // o vínculo real, que é o que importa.
    try {
      await attempt(false);
      await client.query('RELEASE SAVEPOINT sp_link_dojo_student');
      console.warn('[karatePractitionerRequestsAdmin] is_federated ausente (migration 253 pendente) — gravado só practitioner_id no aluno');
      return { linked: true, reason: 'partial_schema' };
    } catch (e2) {
      await client.query('ROLLBACK TO SAVEPOINT sp_link_dojo_student');
      await client.query('RELEASE SAVEPOINT sp_link_dojo_student');
      console.warn('[karatePractitionerRequestsAdmin] não foi possível vincular o aluno (não bloqueia a aprovação):', e2.message);
      return { linked: false, reason: 'schema_pending' };
    }
  }
}

// ── Reabrir acesso do dojô ao rejeitar (item 4, H3) ──────────
// O link público do sensei (/public/roster-update/:token/...) é gated por
// karate_dojo_roster_validation.token_expires_at. Esse token EXPIRA
// imediatamente quando o sensei "fecha" o quadro (POST /:token de
// confirmação final seta token_expires_at = NOW() — ver
// karateRosterPortalPublic.js). Se uma solicitação de praticante daquele
// dojô é REJEITADA depois que ele já fechou o quadro, o link morre e ele
// fica sem caminho de volta para ver o motivo e reenviar corrigido.
//
// Ao rejeitar, ESTENDEMOS (nunca encurtamos — GREATEST) tanto o token do
// sensei quanto o self_service_token por mais 14 dias a partir de agora.
// Só faz sentido se já existir uma linha de validação para o dojô (i.e.,
// a federação já pediu atualização de quadro alguma vez e um token foi
// emitido) — não criamos uma linha nova do zero aqui: isso inseriria o
// dojô no painel de progresso de quadro (roster-progress) como se uma
// validação tivesse sido solicitada, o que não é verdade e poluiria
// aquele painel como efeito colateral de uma rejeição de praticante.
// Quem tem acesso via login de dojô (Canal A/B de requireDojoAccess) já
// enxerga a rejeição a qualquer momento via
// GET /federation/:id/dojo/practitioner-requests?status=rejeitada — isto
// aqui cobre especificamente o link público sem login.
//
// Best-effort / defensivo: 42P01 (tabela ausente) e 42703 (colunas
// self_service_* da migration 225 ausentes) nunca derrubam a rejeição em
// si, que já foi persistida antes desta chamada.
async function reopenDojoRosterAccessBestEffort(dojoId) {
  const EXTEND = "NOW() + INTERVAL '14 days'";
  try {
    const { rows } = await db.query(
      `UPDATE karate_dojo_roster_validation
          SET token_expires_at = GREATEST(COALESCE(token_expires_at, NOW()), ${EXTEND}),
              self_service_token_expires_at = GREATEST(COALESCE(self_service_token_expires_at, NOW()), ${EXTEND}),
              updated_at = NOW()
        WHERE dojo_id = $1 AND token IS NOT NULL
      RETURNING token, token_expires_at, self_service_token, self_service_token_expires_at`,
      [dojoId]
    );
    if (!rows.length) return { reopened: false, reason: 'no_validation_row' };
    return {
      reopened: true,
      token_expires_at: rows[0].token_expires_at,
      self_service_token_expires_at: rows[0].self_service_token_expires_at,
    };
  } catch (e) {
    if (e.code === '42703') {
      // Migration 225 (self_service_token*) pendente — reabre só o token do sensei.
      try {
        const { rows } = await db.query(
          `UPDATE karate_dojo_roster_validation
              SET token_expires_at = GREATEST(COALESCE(token_expires_at, NOW()), ${EXTEND}),
                  updated_at = NOW()
            WHERE dojo_id = $1 AND token IS NOT NULL
          RETURNING token, token_expires_at`,
          [dojoId]
        );
        if (!rows.length) return { reopened: false, reason: 'no_validation_row' };
        return { reopened: true, token_expires_at: rows[0].token_expires_at, self_service_token_expires_at: null };
      } catch (e2) {
        console.warn('[karatePractitionerRequestsAdmin] reabrir acesso do dojô falhou (colunas ausentes, não bloqueia):', e2.message);
        return { reopened: false, reason: 'schema_pending' };
      }
    }
    if (e.code === '42P01') {
      console.warn('[karatePractitionerRequestsAdmin] karate_dojo_roster_validation ausente (schema pendente, não bloqueia)');
      return { reopened: false, reason: 'schema_pending' };
    }
    console.error('[karatePractitionerRequestsAdmin] reabrir acesso do dojô falhou (não bloqueia):', e.message);
    return { reopened: false, reason: 'error' };
  }
}

function shapeDetail(r) {
  return {
    id: r.id,
    federation_id: r.federation_id,
    dojo_id: r.dojo_id,
    dojo_name: r.dojo_name || null,
    status: r.status,
    resolution: r.resolution || null,
    reject_reason: r.reject_reason || null,
    full_name: r.full_name,
    birth_date: r.birth_date || null,
    cpf: r.cpf || null,
    rg: r.rg || null,
    phone: r.phone || null,
    email: r.email || null,
    claimed_belt: r.claimed_belt || null,
    fpkt_number_claimed: r.fpkt_number_claimed || null,
    photo_url: r.photo_url || null,
    payload: r.payload || {},
    requested_by_channel: r.requested_by_channel || null,
    requested_by_label: r.requested_by_label || null,
    resolved_practitioner_id: r.resolved_practitioner_id || null,
    // F5a (aditivo): de qual aluno do dojô esta solicitação nasceu (null
    // nas avulsas e em todas as anteriores à migration 253).
    student_id: r.student_id || null,
    created_at: r.created_at,
    resolved_at: r.resolved_at || null,
    resolved_by: r.resolved_by || null,
  };
}

// ── GET listar (com matches embutidos) ─────────────────────
router.get('/practitioner-requests', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const status = ['pendente', 'aprovada', 'rejeitada'].includes(req.query.status) ? req.query.status : null;
  const dojoId = req.query.dojo_id || null;

  try {
    const { rows } = await db.query(
      `SELECT r.*, COALESCE(comp.trade_name, comp.legal_name) AS dojo_name
         FROM karate_practitioner_requests r
         LEFT JOIN companies comp ON comp.id = r.dojo_id
        WHERE r.federation_id = $1
          AND ($2::text IS NULL OR r.status = $2)
          AND ($3::uuid IS NULL OR r.dojo_id = $3)
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [federationId, status, dojoId]
    );

    const data = await Promise.all(rows.map(async (r) => {
      const matches = await findPossibleMatches(db, {
        federationId,
        fullName: r.full_name,
        birthDate: r.birth_date,
        rg: r.rg,
        cpf: r.cpf,
        fpktNumberClaimed: r.fpkt_number_claimed,
      });
      const shaped = { ...shapeDetail(r), possible_matches: matches };
      // Campos do botão "Avisar no WhatsApp" só fazem sentido pra rejeitada
      // (item wa.me pós-rejeição) — evita consultas extras nas demais linhas.
      if (shaped.status !== 'rejeitada') return shaped;
      const dojoFields = await dojoWhatsappFieldsBestEffort(r.dojo_id);
      return { ...shaped, ...dojoFields };
    }));

    return res.json({ data });
  } catch (e) {
    if (e.code === '42P01') return res.json({ data: [] });
    console.error('[karatePractitionerRequestsAdmin] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar solicitações' });
  }
});

// ── GET métricas da fila (H3) ──────────────────────────────
// Rota ESTÁTICA — precisa vir ANTES de '/practitioner-requests/:requestId'
// (Express trataria 'metrics' como :requestId senão).
//
// pendentes              — total de solicitações status='pendente' na federação.
// mais_antiga             — { criada_em, dias } da solicitação pendente mais
//                            velha (null se não há nenhuma pendente). dias é
//                            piso (idade completa em dias, arredondado para
//                            baixo) — para a federação enxergar urgência.
// aguardando_numero_fpkt  — pendentes SEM fpkt_number_claimed (o sensei não
//                            informou nenhum número — sinal forte de que é
//                            uma CRIAÇÃO nova, não transferência, e que a
//                            federação vai ter que emitir o número do zero;
//                            claimed_belt/fpkt_number_claimed são o que o
//                            sensei digitou, nunca autoritativo, mas a
//                            AUSÊNCIA do claim já é um contador útil de
//                            volume de "número a emitir").
// por_dojo                — mesma contagem quebrada por dojô, ordenada pela
//                            mais antiga primeiro (mesmo critério de urgência
//                            da lista principal).
router.get('/practitioner-requests/metrics', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const empty = { pendentes: 0, mais_antiga: null, aguardando_numero_fpkt: 0, por_dojo: [] };

  try {
    const totals = await db.query(
      `SELECT
          count(*) FILTER (WHERE r.status = 'pendente')::int AS pendentes,
          min(r.created_at) FILTER (WHERE r.status = 'pendente') AS mais_antiga_criada_em,
          count(*) FILTER (
            WHERE r.status = 'pendente'
              AND (r.fpkt_number_claimed IS NULL OR btrim(r.fpkt_number_claimed) = '')
          )::int AS aguardando_numero_fpkt
        FROM karate_practitioner_requests r
        WHERE r.federation_id = $1`,
      [federationId]
    );

    const porDojoRes = await db.query(
      `SELECT r.dojo_id,
              COALESCE(comp.trade_name, comp.legal_name) AS dojo_nome,
              count(*)::int AS pendentes,
              min(r.created_at) AS mais_antiga_criada_em
         FROM karate_practitioner_requests r
         LEFT JOIN companies comp ON comp.id = r.dojo_id
        WHERE r.federation_id = $1 AND r.status = 'pendente'
        GROUP BY r.dojo_id, COALESCE(comp.trade_name, comp.legal_name)
        ORDER BY min(r.created_at) ASC`,
      [federationId]
    );

    const diasDesde = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

    const t = totals.rows[0] || {};
    const maisAntigaCriadaEm = t.mais_antiga_criada_em || null;

    return res.json({
      pendentes: t.pendentes || 0,
      mais_antiga: maisAntigaCriadaEm
        ? { criada_em: maisAntigaCriadaEm, dias: diasDesde(maisAntigaCriadaEm) }
        : null,
      aguardando_numero_fpkt: t.aguardando_numero_fpkt || 0,
      por_dojo: porDojoRes.rows.map((r) => ({
        dojo_id: r.dojo_id,
        dojo_nome: r.dojo_nome || null,
        pendentes: r.pendentes,
        mais_antiga_dias: diasDesde(r.mais_antiga_criada_em),
      })),
    });
  } catch (e) {
    if (e.code === '42P01') return res.json(empty);
    console.error('[karatePractitionerRequestsAdmin] metrics error:', e.message);
    return res.status(500).json({ error: 'Erro ao calcular métricas da fila' });
  }
});

// ── GET detalhe ────────────────────────────────────────
router.get('/practitioner-requests/:requestId', ...guards.read(), async (req, res) => {
  const { id: federationId, requestId } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT r.*, COALESCE(comp.trade_name, comp.legal_name) AS dojo_name
         FROM karate_practitioner_requests r
         LEFT JOIN companies comp ON comp.id = r.dojo_id
        WHERE r.id = $1 AND r.federation_id = $2
        LIMIT 1`,
      [requestId, federationId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    }
    const r = rows[0];
    const matches = await findPossibleMatches(db, {
      federationId, fullName: r.full_name, birthDate: r.birth_date,
      rg: r.rg, cpf: r.cpf, fpktNumberClaimed: r.fpkt_number_claimed,
    });
    const shaped = { ...shapeDetail(r), possible_matches: matches };
    // Campos do botão "Avisar no WhatsApp" (item wa.me pós-rejeição) — só
    // preenchidos quando já rejeitada; a federação pode voltar aqui depois,
    // não só no calor do momento do reject.
    if (shaped.status !== 'rejeitada') return res.json(shaped);
    const dojoFields = await dojoWhatsappFieldsBestEffort(r.dojo_id);
    return res.json({ ...shaped, ...dojoFields });
  } catch (e) {
    if (e.code === '42P01') return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    console.error('[karatePractitionerRequestsAdmin] detail error:', e.message);
    return res.status(500).json({ error: 'Erro ao buscar solicitação' });
  }
});

// ── PATCH editar antes de aprovar ──────────────────────────
const EDITABLE_FIELDS = [
  'full_name', 'birth_date', 'cpf', 'rg', 'phone', 'email', 'claimed_belt', 'fpkt_number_claimed',
];

router.patch('/practitioner-requests/:requestId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, requestId } = req.params;
  const b = req.body || {};

  try {
    const cur = await db.query(
      `SELECT id, dojo_id, full_name, birth_date, payload, status FROM karate_practitioner_requests
        WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [requestId, federationId]
    );
    if (!cur.rows.length) {
      return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    }
    const row = cur.rows[0];
    if (row.status !== 'pendente') {
      return res.status(409).json({ error: 'Só é possível editar solicitações pendentes', code: 'ALREADY_RESOLVED' });
    }

    if (b.full_name !== undefined && !String(b.full_name).trim()) {
      return res.status(422).json({ error: 'full_name não pode ficar vazio', code: 'VALIDATION_ERROR' });
    }
    if (b.birth_date !== undefined && b.birth_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.birth_date))) {
      return res.status(422).json({ error: 'birth_date deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
    }

    const sets = [];
    const vals = [];
    let i = 1;
    const changed = {};
    for (const field of EDITABLE_FIELDS) {
      if (b[field] === undefined) continue;
      let v = b[field];
      if (field === 'full_name') v = String(v).trim();
      if (field === 'fpkt_number_claimed') v = v ? normalizeFpktNumber(v) : null;
      if (typeof v === 'string') v = v.trim() || null;
      sets.push(`${field} = $${i}`);
      vals.push(v);
      changed[field] = v;
      i++;
    }

    // Recalcula dedup_key se nome/nascimento mudaram (mantém a idempotência
    // coerente — uma edição não pode furar o índice de dedup pendente).
    const newFullName = changed.full_name !== undefined ? changed.full_name : row.full_name;
    const newBirthDate = changed.birth_date !== undefined ? changed.birth_date : row.birth_date;
    if (changed.full_name !== undefined || changed.birth_date !== undefined) {
      sets.push(`dedup_key = $${i}`);
      vals.push(buildDedupKey(newFullName, newBirthDate));
      i++;
    }

    // payload jsonb também recebe o merge dos campos editados, para não
    // divergir do que a federação vê no detalhe.
    sets.push(`payload = payload || $${i}::jsonb`);
    vals.push(JSON.stringify(changed));
    i++;

    if (!sets.length) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    vals.push(requestId, federationId);
    const upd = await db.query(
      `UPDATE karate_practitioner_requests
          SET ${sets.join(', ')}
        WHERE id = $${i} AND federation_id = $${i + 1} AND status = 'pendente'
      RETURNING *`,
      vals
    );
    if (!upd.rows.length) {
      return res.status(409).json({ error: 'Solicitação não está mais pendente', code: 'ALREADY_RESOLVED' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await logRosterEventBestEffort(client, {
        dojoId: row.dojo_id, federationId, event: 'practitioner_request_edited',
        affected: [{ request_id: requestId, changed_fields: Object.keys(changed) }],
        actorId: (req.user && req.user.id) || null,
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[karatePractitionerRequestsAdmin] edit event error:', e.message);
    } finally {
      client.release();
    }

    return res.json(shapeDetail(upd.rows[0]));
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Já existe outra solicitação pendente igual (mesmo dojô, nome e nascimento)', code: 'DUPLICATE_PENDING' });
    }
    console.error('[karatePractitionerRequestsAdmin] edit error:', e.message);
    return res.status(500).json({ error: 'Erro ao editar solicitação' });
  }
});

// ── POST aprovar como CRIAÇÃO ────────────────────────────
router.post('/practitioner-requests/:requestId/approve-create', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, requestId } = req.params;
  const fpktNumber = req.body && req.body.fpkt_number != null ? normalizeFpktNumber(req.body.fpkt_number) : '';

  if (!fpktNumber) {
    return res.status(422).json({
      error: 'Campo fpkt_number é obrigatório para aprovar como criação — o número é emitido pela federação, este sistema nunca gera número.',
      code: 'FPKT_NUMBER_REQUIRED',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT * FROM karate_practitioner_requests WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [requestId, federationId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    }
    const reqRow = cur.rows[0];
    if (reqRow.status !== 'pendente') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Solicitação já foi resolvida', code: 'ALREADY_RESOLVED' });
    }

    const dupRes = await client.query(
      `SELECT id FROM customers WHERE federation_id = $1 AND karate_registration_number = $2 LIMIT 1`,
      [federationId, fpktNumber]
    );
    if (dupRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Número de matrícula já em uso.', code: 'FPKT_NUMBER_TAKEN' });
    }

    const payload = reqRow.payload || {};
    // Item 9 (revisão Atualização Cadastral, 15/07/2026): a foto anexada
    // na solicitação (karate_practitioner_requests.photo_url, migration
    // 232) vira a foto do praticante na aprovação — mesma coluna que toda
    // foto de praticante já usa (karate_photo_url), sem mecanismo novo.
    // reqRow.photo_url vem undefined (não erro) se a migration 232 ainda
    // não rodou (SELECT * não falha por coluna ausente na SELECT-list) —
    // '|| null' cobre esse caso sem quebrar a aprovação.
    const insertRes = await client.query(
      `INSERT INTO customers
         (company_id, name, cpf_cnpj, rg, birth_date, email, phone,
          is_student, federation_id, dojo_id, karate_registration_number,
          street, number, complement, neighborhood, city, state, zip_code,
          guardian_name, guardian_cpf, guardian_phone, guardian_relationship,
          karate_photo_url,
          is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, true, $1,$8,$9,
               $10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,
               $21,
               true, NOW(), NOW())
       RETURNING id, name, karate_registration_number, dojo_id`,
      [
        federationId, reqRow.full_name, reqRow.cpf, reqRow.rg, reqRow.birth_date, reqRow.email, reqRow.phone,
        reqRow.dojo_id, fpktNumber,
        payload.street || null, payload.number || null, payload.complement || null,
        payload.neighborhood || null, payload.city || null, payload.state || null, payload.zip_code || null,
        payload.guardian_name || null, payload.guardian_cpf || null, payload.guardian_phone || null, payload.guardian_relationship || null,
        reqRow.photo_url || null,
      ]
    );
    const practitioner = insertRes.rows[0];

    // Faixa ALEGADA pelo sensei semeia o histórico — sem validação (a
    // federação decide fora do sistema se pede documentação). graduated_at
    // é NOT NULL na tabela; usamos a data de APROVAÇÃO (hoje), nunca uma
    // data de exame que ninguém informou — o notes deixa isso explícito.
    if (reqRow.claimed_belt) {
      await client.query(
        `INSERT INTO karate_belt_history
           (student_id, federation_id, belt_level, belt_name, graduated_at, notes, created_by, created_at)
         VALUES ($1, $2, $3, $3, CURRENT_DATE, $4, $5, NOW())`,
        [
          practitioner.id, federationId, reqRow.claimed_belt,
          'Faixa alegada pelo sensei na solicitação de cadastro; registrada na data de aprovação (sem validação de faixa).',
          (req.user && req.user.id) || null,
        ]
      );
    }

    await client.query(
      `UPDATE karate_practitioner_requests
          SET status = 'aprovada', resolution = 'created', resolved_practitioner_id = $1,
              resolved_at = NOW(), resolved_by = $2
        WHERE id = $3`,
      [practitioner.id, (req.user && req.user.id) || null, requestId]
    );

    // F5a: se a solicitação nasceu de um ALUNO do dojô, o vínculo volta
    // para ele agora — mesma transação, fail-open por SAVEPOINT.
    const studentLink = await linkDojoStudentOnApprove(client, {
      studentId: reqRow.student_id || null,
      dojoId: reqRow.dojo_id,
      practitionerId: practitioner.id,
    });

    await logRosterEventBestEffort(client, {
      dojoId: reqRow.dojo_id, federationId, event: 'practitioner_request_approved_create',
      affected: [{ request_id: requestId, practitioner_id: practitioner.id, fpkt_number: fpktNumber, student_id: reqRow.student_id || null }],
      actorId: (req.user && req.user.id) || null,
    });

    await client.query('COMMIT');

    return res.status(201).json({
      request_id: requestId,
      status: 'aprovada',
      resolution: 'created',
      student_id: reqRow.student_id || null,
      student_linked: studentLink.linked === true,
      practitioner: {
        id: practitioner.id,
        name: practitioner.name,
        karate_registration_number: practitioner.karate_registration_number,
        dojo_id: practitioner.dojo_id,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Número de matrícula já em uso.', code: 'FPKT_NUMBER_TAKEN' });
    }
    console.error('[karatePractitionerRequestsAdmin] approve-create error:', e.message);
    return res.status(500).json({ error: 'Erro ao aprovar solicitação', detail: e.message });
  } finally {
    client.release();
  }
});

// ── POST aprovar como TRANSFERÊNCIA ────────────────────────
router.post('/practitioner-requests/:requestId/approve-transfer', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, requestId } = req.params;
  const practitionerId = req.body && req.body.practitioner_id;

  if (!practitionerId) {
    return res.status(422).json({ error: 'Campo practitioner_id é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT * FROM karate_practitioner_requests WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [requestId, federationId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    }
    const reqRow = cur.rows[0];
    if (reqRow.status !== 'pendente') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Solicitação já foi resolvida', code: 'ALREADY_RESOLVED' });
    }

    const pracRes = await client.query(
      `SELECT id, name, email, dojo_id FROM customers WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [practitionerId, federationId]
    );
    if (!pracRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado nesta federação', code: 'PRACTITIONER_NOT_FOUND' });
    }
    const prac = pracRes.rows[0];
    const originDojoId = prac.dojo_id || null;
    const destinationDojoId = reqRow.dojo_id;

    let transferRow = null;
    if (String(originDojoId) !== String(destinationDojoId)) {
      const destRes = await client.query(
        `SELECT id, COALESCE(trade_name, legal_name) AS name, email FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
        [destinationDojoId, federationId]
      );
      const destDojo = destRes.rows[0] || null;

      let originDojo = null;
      if (originDojoId) {
        const o = await client.query('SELECT id, COALESCE(trade_name, legal_name) AS name, email FROM companies WHERE id = $1 LIMIT 1', [originDojoId]);
        originDojo = o.rows[0] || null;
      }

      await client.query(`UPDATE customers SET dojo_id = $1, updated_at = NOW() WHERE id = $2`, [destinationDojoId, practitionerId]);

      try {
        const ins = await client.query(
          `INSERT INTO karate_practitioner_transfers
             (practitioner_id, federation_id, origin_dojo_id, destination_dojo_id,
              origin_dojo_name, destination_dojo_name, reason, transferred_at, initiated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)
           RETURNING id, transferred_at, created_at`,
          [
            practitionerId, federationId, originDojoId, destinationDojoId,
            originDojo ? originDojo.name : null, destDojo ? destDojo.name : null,
            'Aprovação de solicitação de praticante (transferência)', (req.user && req.user.id) || null,
          ]
        );
        transferRow = ins.rows[0];
      } catch (e) {
        if (e.code === '42P01') {
          await client.query('ROLLBACK');
          return res.status(503).json({ error: 'Histórico de transferências ainda não disponível (migração pendente)', code: 'MIGRATION_PENDING' });
        }
        throw e;
      }
    }
    // Se já está no dojô da solicitação, não há o que mover — só resolve.

    await client.query(
      `UPDATE karate_practitioner_requests
          SET status = 'aprovada', resolution = 'transferred', resolved_practitioner_id = $1,
              resolved_at = NOW(), resolved_by = $2
        WHERE id = $3`,
      [practitionerId, (req.user && req.user.id) || null, requestId]
    );

    // F5a: mesma regra da aprovação por criação — se veio de um aluno do
    // dojô, o aluno passa a apontar para o praticante transferido.
    const studentLink = await linkDojoStudentOnApprove(client, {
      studentId: reqRow.student_id || null,
      dojoId: destinationDojoId,
      practitionerId,
    });

    await logRosterEventBestEffort(client, {
      dojoId: destinationDojoId, federationId, event: 'practitioner_request_approved_transfer',
      affected: [{ request_id: requestId, practitioner_id: practitionerId, origin_dojo_id: originDojoId, destination_dojo_id: destinationDojoId, student_id: reqRow.student_id || null }],
      actorId: (req.user && req.user.id) || null,
    });

    await client.query('COMMIT');

    return res.status(200).json({
      request_id: requestId,
      status: 'aprovada',
      resolution: 'transferred',
      practitioner_id: practitionerId,
      student_id: reqRow.student_id || null,
      student_linked: studentLink.linked === true,
      transfer: transferRow ? { id: transferRow.id, transferred_at: transferRow.transferred_at } : null,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[karatePractitionerRequestsAdmin] approve-transfer error:', e.message);
    return res.status(500).json({ error: 'Erro ao aprovar transferência', detail: e.message });
  } finally {
    client.release();
  }
});

// ── POST rejeitar ───────────────────────────────────────
router.post('/practitioner-requests/:requestId/reject', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, requestId } = req.params;
  const reason = req.body && req.body.reason != null ? String(req.body.reason).trim() : '';

  if (!reason) {
    return res.status(422).json({ error: 'Campo reason é obrigatório (o sensei vê o motivo)', code: 'VALIDATION_ERROR' });
  }

  try {
    const upd = await db.query(
      `UPDATE karate_practitioner_requests
          SET status = 'rejeitada', resolution = 'rejected', reject_reason = $1,
              resolved_at = NOW(), resolved_by = $2
        WHERE id = $3 AND federation_id = $4 AND status = 'pendente'
      RETURNING id, dojo_id, full_name`,
      [reason.slice(0, 1000), (req.user && req.user.id) || null, requestId, federationId]
    );
    if (!upd.rows.length) {
      const exists = await db.query(`SELECT id FROM karate_practitioner_requests WHERE id = $1 AND federation_id = $2`, [requestId, federationId]);
      if (!exists.rows.length) return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
      return res.status(409).json({ error: 'Solicitação já foi resolvida', code: 'ALREADY_RESOLVED' });
    }
    const row = upd.rows[0];

    await logRosterEventStandalone({
      dojoId: row.dojo_id, federationId, event: 'practitioner_request_rejected',
      affected: [{ request_id: requestId, reason: reason.slice(0, 1000) }],
      actorId: (req.user && req.user.id) || null,
    });

    // Item 4 (H3): rejeitar reabre/estende o acesso do link público do
    // dojô, para o sensei conseguir voltar, ver o motivo e reenviar
    // corrigido mesmo se ele já tinha "fechado" o quadro antes.
    const dojoAccess = await reopenDojoRosterAccessBestEffort(row.dojo_id);

    // Botão "Avisar no WhatsApp" (wa.me simples, click-to-chat — a
    // federação decide se clica; nada automático). Telefone do DOJÔ
    // (celular > fixo) + a MESMA URL do link do sensei que acabou de ser
    // reaberto acima, pra mensagem carregar direto pra onde ele corrige.
    // Best-effort/aditivo: nunca derruba a rejeição, que já foi persistida.
    const dojoFields = await dojoWhatsappFieldsBestEffort(row.dojo_id);

    return res.json({
      request_id: requestId,
      status: 'rejeitada',
      reject_reason: reason,
      dojo_access_reopened: dojoAccess.reopened,
      ...dojoFields,
    });
  } catch (e) {
    if (e.code === '42P01') return res.status(404).json({ error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
    console.error('[karatePractitionerRequestsAdmin] reject error:', e.message);
    return res.status(500).json({ error: 'Erro ao rejeitar solicitação' });
  }
});

module.exports = router;
