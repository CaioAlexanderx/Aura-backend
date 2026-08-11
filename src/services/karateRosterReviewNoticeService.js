// ============================================================
// AURA DOJÔ — F11.3: os AVISOS do dojô, lado FEDERAÇÃO (migration 276)
//
// O dojô concluiu a revisão do plantel herdado e disse quem ele NÃO
// reconhece como aluno atual. Isto aqui é a fila que a federação usa para
// decidir o que fazer com cada um.
//
// ── ⚠️ POR QUE A DECISÃO É HUMANA ───────────────────────────
// "Não reconhecido" NÃO É "inativo". O praticante pode ter mudado de dojô
// — karate_practitioner_transfers tem 540 linhas, e o modelo prevê isso
// desde a migration 180. O sensei responde "esta pessoa treina comigo?";
// só a federação consegue responder "e então, ela parou, mudou, ou o
// cadastro é que está errado?".
//
// São TRÊS decisões possíveis, e cada uma é um ato diferente:
//   inactivated → customers.is_active = false. O único caminho pelo qual
//                 esta fase encosta em is_active, e sempre com ator
//                 identificado e escopado pelo dojô que avisou.
//   transferred → move o praticante para outro dojô E grava a linha em
//                 karate_practitioner_transfers (append-only), REUSANDO o
//                 mesmo padrão de karatePractitionerRequestsAdmin
//                 .approve-transfer. Transferência sem histórico seria
//                 dado perdido.
//   kept        → a federação conferiu e mantém como está. É decisão
//                 legítima e precisa ser registrável: sem ela, o aviso
//                 ficaria "pendente" para sempre e a fila nunca esvaziaria.
//
// ── ESCOPO DE SEGURANÇA (a parte que evita o dano) ──────────
// Inativar/transferir é escopado por (practitioner_id, federation_id,
// dojo_id-do-aviso). Se o praticante JÁ SAIU daquele dojô entre o aviso e
// a decisão, o UPDATE não pega linha nenhuma e a rota devolve 409
// PRATICANTE_JA_SAIU_DO_DOJO em vez de inativar alguém que hoje treina em
// outro lugar. É a tradução, em SQL, da regra de que o aviso é uma foto do
// passado, não um comando sobre o presente.
//
// Âncoras `-- drr:<nome>` em toda SQL (mock por SQL nos testes, nunca fila
// posicional). Defensivo 42P01 (migration 276 pendente).
// ============================================================
'use strict';

const db = require('../config/database');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DECISIONS = ['inactivated', 'transferred', 'kept'];

const NOTICE_COLS = `n.id, n.review_id, n.dojo_id, n.federation_id, n.practitioner_id,
       n.practitioner_name, n.practitioner_fpkt_number, n.practitioner_was_active,
       n.reason, n.reported_by, n.reported_by_label, n.reported_at,
       n.decision, n.decision_note, n.destination_dojo_id,
       n.decided_by, n.decided_by_label, n.decided_at,
       n.created_at, n.updated_at`;

function svcError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

const isMissingRelation = (e) => !!e && (e.code === '42P01' || e.code === 'TABLE_MISSING');

function shapeNotice(row) {
  return {
    id: row.id,
    review_id: row.review_id,
    dojo_id: row.dojo_id,
    dojo_name: row.dojo_name || null,
    practitioner_id: row.practitioner_id,
    // Snapshot do momento do aviso — continua legível mesmo se a pessoa
    // for transferida/renomeada depois (ver migration 276).
    practitioner_name: row.practitioner_name || null,
    practitioner_fpkt_number: row.practitioner_fpkt_number || null,
    practitioner_was_active: row.practitioner_was_active === true,
    // Estado ATUAL do praticante, quando a listagem conseguiu resolvê-lo:
    // é a diferença entre a foto e o presente, e é o que a federação
    // precisa ver antes de decidir.
    practitioner_current_dojo_id: row.current_dojo_id !== undefined ? row.current_dojo_id : undefined,
    practitioner_current_is_active:
      row.current_is_active !== undefined ? row.current_is_active : undefined,
    practitioner_left_dojo:
      row.current_dojo_id !== undefined && row.current_dojo_id !== null
        ? String(row.current_dojo_id) !== String(row.dojo_id)
        : undefined,
    reason: row.reason,
    reported_at: row.reported_at,
    reported_by: row.reported_by || null,
    reported_by_label: row.reported_by_label || null,
    decision: row.decision,
    decision_note: row.decision_note || null,
    destination_dojo_id: row.destination_dojo_id || null,
    decided_by: row.decided_by || null,
    decided_by_label: row.decided_by_label || null,
    decided_at: row.decided_at || null,
  };
}

function parsePaging({ limit, offset } = {}) {
  const l = parseInt(limit, 10);
  const o = parseInt(offset, 10);
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}

// ?decision=pending|inactivated|transferred|kept — inválido/ausente = TODOS.
function parseDecisionFilter(raw) {
  const v = raw != null ? String(raw).trim().toLowerCase() : '';
  return v === 'pending' || DECISIONS.includes(v) ? v : null;
}

const EMPTY_SUMMARY = Object.freeze({
  total: 0, pending: 0, inactivated: 0, transferred: 0, kept: 0,
});

// ── Listagem da fila ────────────────────────────────────────
// Traz, ao lado do snapshot, o estado ATUAL do praticante (dojô e
// is_active de hoje) — é exatamente o cruzamento que impede a federação de
// inativar alguém que só mudou de dojô.
async function listNotices(federationId, opts = {}) {
  const paging = parsePaging(opts);
  const decision = parseDecisionFilter(opts.decision);
  const dojoId = opts.dojo_id != null && String(opts.dojo_id).trim() !== '' ? String(opts.dojo_id).trim() : null;
  const q = opts.q != null && String(opts.q).trim() !== '' ? `%${String(opts.q).trim()}%` : null;

  const { rows } = await db.query(
    `-- drr:notices-list
     SELECT ${NOTICE_COLS},
            COALESCE(d.trade_name, d.legal_name) AS dojo_name,
            c.dojo_id  AS current_dojo_id,
            c.is_active AS current_is_active,
            COUNT(*) OVER() AS total_count
       FROM karate_dojo_roster_review_notices n
       LEFT JOIN companies d ON d.id = n.dojo_id
       LEFT JOIN customers c ON c.id = n.practitioner_id
      WHERE n.federation_id = $1
        AND ($2::text IS NULL OR n.decision = $2)
        AND ($3::uuid IS NULL OR n.dojo_id = $3)
        AND ($4::text IS NULL
             OR n.practitioner_name ILIKE $4
             OR n.practitioner_fpkt_number ILIKE $4)
      ORDER BY n.reported_at DESC, n.id ASC
      LIMIT $5 OFFSET $6`,
    [federationId, decision, dojoId, q, paging.limit, paging.offset]
  );

  return {
    data: rows.map(shapeNotice),
    count: rows.length ? parseInt(rows[0].total_count, 10) || 0 : 0,
    limit: paging.limit,
    offset: paging.offset,
  };
}

async function getSummary(federationId) {
  const { rows } = await db.query(
    `-- drr:notices-summary
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE decision = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE decision = 'inactivated')::int AS inactivated,
            COUNT(*) FILTER (WHERE decision = 'transferred')::int AS transferred,
            COUNT(*) FILTER (WHERE decision = 'kept')::int AS kept
       FROM karate_dojo_roster_review_notices
      WHERE federation_id = $1`,
    [federationId]
  );
  if (!rows.length) return { ...EMPTY_SUMMARY };
  const r = rows[0];
  return {
    total: Number(r.total) || 0,
    pending: Number(r.pending) || 0,
    inactivated: Number(r.inactivated) || 0,
    transferred: Number(r.transferred) || 0,
    kept: Number(r.kept) || 0,
  };
}

// ── A DECISÃO ───────────────────────────────────────────────
// decision: 'inactivated' | 'transferred' | 'kept'
//   transferred exige destination_dojo_id (um dojô ATIVO desta federação).
//
// Tudo numa transação: o efeito sobre o praticante e o registro da decisão
// no aviso vivem ou morrem juntos. Um aviso marcado como 'inactivated' com
// o praticante ainda ativo seria pior que nenhum registro.
async function decideNotice(federationId, noticeId, { decision, note, destinationDojoId }, actor) {
  const target = decision != null ? String(decision).trim().toLowerCase() : '';
  if (!DECISIONS.includes(target)) {
    throw svcError(
      422,
      'VALIDATION_ERROR',
      "Campo decision deve ser 'inactivated', 'transferred' ou 'kept'"
    );
  }
  const destId = destinationDojoId != null && String(destinationDojoId).trim() !== ''
    ? String(destinationDojoId).trim()
    : null;
  if (target === 'transferred' && !destId) {
    throw svcError(
      422,
      'DESTINATION_REQUIRED',
      'Informe destination_dojo_id para transferir o praticante'
    );
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: locked } = await client.query(
      `-- drr:notice-lock
       SELECT ${NOTICE_COLS}
         FROM karate_dojo_roster_review_notices n
        WHERE n.id = $1 AND n.federation_id = $2
        FOR UPDATE`,
      [noticeId, federationId]
    );
    if (!locked.length) {
      await client.query('ROLLBACK');
      throw svcError(404, 'NOT_FOUND', 'Aviso não encontrado nesta federação');
    }
    const notice = locked[0];
    if (notice.decision !== 'pending') {
      await client.query('ROLLBACK');
      throw svcError(409, 'AVISO_JA_DECIDIDO', 'Este aviso já foi decidido');
    }

    let effect = { practitioner_changed: false };

    if (target === 'inactivated') {
      // Escopado também pelo DOJÔ QUE AVISOU: se a pessoa já saiu de lá
      // entre o aviso e agora, não se inativa ninguém.
      const { rows } = await client.query(
        `-- drr:inactivate-practitioner
         UPDATE customers
            SET is_active = false, updated_at = NOW()
          WHERE id = $1 AND federation_id = $2 AND dojo_id = $3
         RETURNING id, is_active`,
        [notice.practitioner_id, federationId, notice.dojo_id]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        throw svcError(
          409,
          'PRATICANTE_JA_SAIU_DO_DOJO',
          'Este praticante não está mais neste dojô. Confira o cadastro antes de inativar — o aviso é uma foto do passado.'
        );
      }
      effect = { practitioner_changed: true, is_active: false };
    }

    if (target === 'transferred') {
      const { rows: dest } = await client.query(
        `-- drr:transfer-dest
         SELECT id, COALESCE(trade_name, legal_name) AS name
           FROM companies
          WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
          LIMIT 1`,
        [destId, federationId]
      );
      if (!dest.length) {
        await client.query('ROLLBACK');
        throw svcError(422, 'DESTINATION_INVALID', 'Dojô de destino não encontrado nesta federação');
      }
      if (String(destId) === String(notice.dojo_id)) {
        await client.query('ROLLBACK');
        throw svcError(422, 'DESTINATION_IS_ORIGIN', 'O dojô de destino é o mesmo que emitiu o aviso');
      }

      const { rows: origin } = await client.query(
        `-- drr:transfer-origin
         SELECT id, COALESCE(trade_name, legal_name) AS name FROM companies WHERE id = $1 LIMIT 1`,
        [notice.dojo_id]
      );

      const { rows: moved } = await client.query(
        `-- drr:transfer-move
         UPDATE customers
            SET dojo_id = $1, updated_at = NOW()
          WHERE id = $2 AND federation_id = $3 AND dojo_id = $4
         RETURNING id`,
        [destId, notice.practitioner_id, federationId, notice.dojo_id]
      );
      if (!moved.length) {
        await client.query('ROLLBACK');
        throw svcError(
          409,
          'PRATICANTE_JA_SAIU_DO_DOJO',
          'Este praticante não está mais neste dojô. Confira o cadastro antes de transferir.'
        );
      }

      // Histórico append-only — mesmo INSERT de approve-transfer. 42P01
      // aqui derruba a transação inteira DE PROPÓSITO: mover sem registrar
      // a transferência é o tipo de dado que ninguém reconstitui depois.
      try {
        await client.query(
          `-- drr:transfer-log
           INSERT INTO karate_practitioner_transfers
             (practitioner_id, federation_id, origin_dojo_id, destination_dojo_id,
              origin_dojo_name, destination_dojo_name, reason, transferred_at, initiated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)`,
          [
            notice.practitioner_id, federationId, notice.dojo_id, destId,
            origin.length ? origin[0].name : null, dest[0].name,
            'Decisão da federação sobre aviso de revisão do plantel (praticante não reconhecido pelo dojô de origem)',
            (actor && actor.userId) || null,
          ]
        );
      } catch (e) {
        await client.query('ROLLBACK');
        if (isMissingRelation(e)) {
          throw svcError(
            503,
            'MIGRATION_PENDING',
            'Histórico de transferências indisponível — a transferência NÃO foi registrada'
          );
        }
        throw e;
      }

      effect = { practitioner_changed: true, moved_to_dojo_id: destId, moved_to_dojo_name: dest[0].name };
    }

    // 'kept': nada acontece com o praticante. Só o registro de que a
    // federação olhou e decidiu manter — é o que tira o aviso da fila.

    const { rows: updated } = await client.query(
      `-- drr:notice-decide
       UPDATE karate_dojo_roster_review_notices
          SET decision = $3,
              decision_note = $4,
              destination_dojo_id = $5,
              decided_by = $6,
              decided_by_label = $7,
              decided_at = now(),
              updated_at = now()
        WHERE id = $1 AND federation_id = $2 AND decision = 'pending'
       RETURNING id, decision, decision_note, destination_dojo_id, decided_at, decided_by, decided_by_label`,
      [
        noticeId, federationId, target,
        note != null && String(note).trim() !== '' ? String(note).trim().slice(0, 1000) : null,
        target === 'transferred' ? destId : null,
        (actor && actor.userId) || null,
        (actor && actor.label) || null,
      ]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      throw svcError(409, 'AVISO_JA_DECIDIDO', 'Este aviso já foi decidido');
    }

    await logRosterEventBestEffort(client, {
      dojoId: notice.dojo_id,
      federationId,
      event: 'dojo_roster_review_notice_decided',
      affected: [{
        notice_id: noticeId,
        review_id: notice.review_id,
        practitioner_id: notice.practitioner_id,
        decision: target,
        destination_dojo_id: target === 'transferred' ? destId : null,
      }],
      actorId: (actor && actor.userId) || null,
    });

    await client.query('COMMIT');

    return {
      notice: shapeNotice({ ...notice, ...updated[0] }),
      effect,
    };
  } catch (e) {
    if (!e || !e.status) {
      try { await client.query('ROLLBACK'); } catch (_) { /* já rolou */ }
    }
    throw e;
  } finally {
    client.release();
  }
}

// SAVEPOINT, nunca try/catch nu dentro de BEGIN (tx-poison).
async function logRosterEventBestEffort(client, { dojoId, federationId, event, affected, actorId }) {
  await client.query('SAVEPOINT sp_notice_decision_event');
  try {
    await client.query(
      `-- drr:roster-event
       INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [dojoId, federationId || null, event, JSON.stringify(affected), actorId || null]
    );
    await client.query('RELEASE SAVEPOINT sp_notice_decision_event');
  } catch (e) {
    if (isMissingRelation(e)) {
      await client.query('ROLLBACK TO SAVEPOINT sp_notice_decision_event');
      await client.query('RELEASE SAVEPOINT sp_notice_decision_event');
      console.warn('[karateRosterReviewNotice] karate_dojo_roster_events ausente (não bloqueia)');
      return;
    }
    throw e;
  }
}

module.exports = {
  DECISIONS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  EMPTY_SUMMARY,
  svcError,
  isMissingRelation,
  parsePaging,
  parseDecisionFilter,
  shapeNotice,
  listNotices,
  getSummary,
  decideNotice,
};
