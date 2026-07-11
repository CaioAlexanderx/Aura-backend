// ============================================================
// AURA KARATÊ — Redistribuição na inativação de dojô
// Montado sob /federation/:id/dojos.
//   POST /federation/:id/dojos/:dojoId/redistribute   (staffWrite)
//
// Contexto: ao inativar um dojô, a federação precisa decidir o destino de
// cada praticante — transferir para outro dojô ou inativar junto. Este
// endpoint aplica um LOTE de decisões numa única transação e, ao final,
// opcionalmente inativa o dojô (default true), rodando a MESMA cascata de
// karateDojos.js (cascadeInactivateDojo) para quem sobrou ativo e não foi
// tocado por nenhuma decisão — ninguém fica "esquecido" no dojô inativado.
//
// Reaproveita o padrão de INSERT de karateTransfers.js (mesmas colunas de
// karate_practitioner_transfers) e o padrão de auditoria
// karate_dojo_roster_events de karateDojos.js (evento 'redistribute' aqui;
// 'inactivate_cascade' para o restante, reimplementado inline pois
// cascadeInactivateDojo não é exportada por karateDojos.js).
//
// Escopo estrito: só mexe em praticantes ATUALMENTE no dojô alvo
// (dojo_id = :dojoId). Decisões para praticantes fora do dojô (já
// transferidos/removidos por outra requisição concorrente, ou id inválido)
// entram em skipped[] e nunca são tocadas.
//
// 11/07/2026 — Reescrito para processamento EM LOTE (set-based). O número
// de queries agora é CONSTANTE (não cresce com o nº de praticantes):
// dojôs grandes (ex.: 667 praticantes) faziam ~2.500 queries numa única
// transação e estouravam o timeout do cliente (10s). Agrupamos as decisões
// em memória por destino e usamos ANY($1::uuid[]) + INSERT ... SELECT
// unnest(...) para mover/inativar/gravar histórico em lote. As mutações
// (UPDATE customers) seguem escopadas estritamente a dojo_id = :dojoId
// (origem), igual ao código anterior. A trava/validação de praticantes
// (SELECT ... FOR UPDATE) permanece escopada a federation_id — não a
// dojo_id — de propósito: é assim que o código anterior distinguia
// PRACTITIONER_NOT_FOUND (id nem existe na federação) de
// NOT_IN_TARGET_DOJO (existe, mas está em outro dojô); estreitar essa
// query para dojo_id perderia essa distinção.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

// Mesmo helper best-effort de karateDojos.js: escreve em
// karate_dojo_roster_events sob SAVEPOINT — se a tabela ainda não existir
// (42P01, deploy parcial), faz ROLLBACK TO SAVEPOINT e segue sem derrubar
// a transação principal (redistribuição/cascata em customers já aplicada).
async function safeRosterWrite(client, label, fn) {
  await client.query('SAVEPOINT sp_roster_write');
  try {
    await fn();
    await client.query('RELEASE SAVEPOINT sp_roster_write');
  } catch (e) {
    if (e && e.code === '42P01') {
      await client.query('ROLLBACK TO SAVEPOINT sp_roster_write');
      console.warn(`[karateRosterRedistribute] roster write ignorada (schema pendente): ${label}`);
    } else {
      throw e;
    }
  }
}

// Reimplementação inline da cascata de karateDojos.js.cascadeInactivateDojo
// (não exportada de lá): snapshot de quem ainda está ativo no dojô, evento
// 'inactivate_cascade' (affected = quem estava ativo) e desativa esses
// praticantes. Roda DEPOIS das decisões — só pega quem sobrou. Já era
// O(1) query (não depende de N) — mantida como estava.
async function cascadeInactivateRemaining(client, { dojoId, federationId, actorId }) {
  const snap = await client.query(
    `SELECT id, is_active FROM customers WHERE dojo_id = $1`,
    [dojoId]
  );
  const affected = snap.rows
    .filter((r) => r.is_active !== false) // COALESCE(is_active, true) === true
    .map((r) => ({ student_id: r.id, was_active: true }));

  await safeRosterWrite(client, 'inactivate_cascade event', () => client.query(
    `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
     VALUES ($1, $2, 'inactivate_cascade', $3::jsonb, $4)`,
    [dojoId, federationId, JSON.stringify(affected), actorId]
  ));

  await client.query(
    `UPDATE customers SET is_active = false, updated_at = NOW()
     WHERE dojo_id = $1 AND COALESCE(is_active, true) = true`,
    [dojoId]
  );

  return affected.length;
}

// ── POST /federation/:id/dojos/:dojoId/redistribute ────────
router.post('/:dojoId/redistribute', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const body = req.body || {};
  const actorId = (req.user && req.user.id) || null;

  const decisions = Array.isArray(body.decisions) ? body.decisions : null;
  if (!decisions) {
    return res.status(422).json({ error: 'Campo decisions deve ser um array', code: 'VALIDATION_ERROR' });
  }
  // Validação estrutural mínima (aborta a requisição inteira — não há
  // student_id/action confiável para reportar como skipped). A ausência de
  // destination_dojo_id num "transfer" NÃO aborta mais: vira skipped
  // INVALID_DESTINATION_DOJO item a item (ver loop de agrupamento abaixo).
  for (const d of decisions) {
    if (!d || typeof d !== 'object' || !d.student_id || !['transfer', 'inactivate'].includes(d.action)) {
      return res.status(422).json({
        error: 'Cada item de decisions precisa de student_id e action ("transfer" ou "inactivate")',
        code: 'VALIDATION_ERROR',
      });
    }
  }
  const inactivateDojo = body.inactivate_dojo !== false; // default true

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Valida que o dojô existe nesta federação
    const dojoRes = await client.query(
      `SELECT id, name FROM companies
        WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
        LIMIT 1`,
      [dojoId, federationId]
    );
    if (!dojoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const originDojoName = dojoRes.rows[0].name;

    const skipped = [];
    const appliedDecisions = [];
    let transferredCount = 0;
    let inactivatedCount = 0;

    // Dedup por student_id — a primeira decisão da lista prevalece (um
    // client bem-comportado nunca deveria mandar duplicata; se mandar,
    // decisões repetidas para o mesmo praticante são ignoradas em vez de
    // reaplicadas duas vezes no mesmo lote).
    const seenStudents = new Set();
    const uniqueDecisions = [];
    for (const d of decisions) {
      const key = String(d.student_id);
      if (seenStudents.has(key)) continue;
      seenStudents.add(key);
      uniqueDecisions.push(d);
    }

    // 2) UMA query trava + valida TODOS os praticantes envolvidos.
    // Escopo = federation_id (não dojo_id): é o que permite diferenciar
    // PRACTITIONER_NOT_FOUND de NOT_IN_TARGET_DOJO, igual ao comportamento
    // anterior por-item (SELECT ... WHERE id = $1 AND federation_id = $2).
    const allStudentIds = uniqueDecisions.map((d) => d.student_id);
    const pracRes = allStudentIds.length
      ? await client.query(
          `SELECT id, dojo_id FROM customers
            WHERE id = ANY($1::uuid[]) AND federation_id = $2
            FOR UPDATE`,
          [allStudentIds, federationId]
        )
      : { rows: [] };
    const pracDojoById = new Map(pracRes.rows.map((r) => [String(r.id), r.dojo_id]));

    // Agrupamento em memória: transferGroups (destino -> student_ids) e
    // inactivateIds. Decisões inválidas já viram skipped aqui, sem tocar o
    // banco de novo.
    const transferGroups = new Map(); // destination_dojo_id -> { destinationDojoId, studentIds: [] }
    const inactivateIds = [];

    for (const d of uniqueDecisions) {
      const studentId = d.student_id;
      const key = String(studentId);

      if (!pracDojoById.has(key)) {
        skipped.push({ student_id: studentId, reason: 'PRACTITIONER_NOT_FOUND' });
        continue;
      }
      if (String(pracDojoById.get(key) || '') !== String(dojoId)) {
        skipped.push({ student_id: studentId, reason: 'NOT_IN_TARGET_DOJO' });
        continue;
      }

      if (d.action === 'transfer') {
        const destinationDojoId = d.destination_dojo_id;
        if (!destinationDojoId) {
          skipped.push({ student_id: studentId, reason: 'INVALID_DESTINATION_DOJO' });
          continue;
        }
        if (String(destinationDojoId) === String(dojoId)) {
          skipped.push({ student_id: studentId, reason: 'DESTINATION_EQUALS_ORIGIN' });
          continue;
        }
        const destKey = String(destinationDojoId);
        if (!transferGroups.has(destKey)) {
          transferGroups.set(destKey, { destinationDojoId, studentIds: [] });
        }
        transferGroups.get(destKey).studentIds.push(studentId);
      } else {
        // inactivate
        inactivateIds.push(studentId);
      }
    }

    // 3) UMA query valida TODOS os dojôs de destino de uma vez.
    const destIds = [...transferGroups.keys()];
    const destRes = destIds.length
      ? await client.query(
          `SELECT id, name FROM companies
            WHERE id = ANY($1::uuid[]) AND federation_id = $2 AND vertical = 'karate_dojo'`,
          [destIds, federationId]
        )
      : { rows: [] };
    const destNameById = new Map(destRes.rows.map((r) => [String(r.id), r.name]));

    for (const [destKey, group] of transferGroups) {
      if (!destNameById.has(destKey)) {
        for (const sid of group.studentIds) {
          skipped.push({ student_id: sid, reason: 'INVALID_DESTINATION_DOJO' });
        }
        transferGroups.delete(destKey);
      }
    }

    // 4) Para CADA destino válido (poucos — um por dojô de destino
    // escolhido no lote): um UPDATE em lote + um INSERT em lote no
    // histórico. Isso é O(nº de dojôs de destino distintos), não O(N).
    for (const [, group] of transferGroups) {
      const destName = destNameById.get(String(group.destinationDojoId));

      const upd = await client.query(
        `UPDATE customers SET dojo_id = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[]) AND dojo_id = $3
          RETURNING id`,
        [group.destinationDojoId, group.studentIds, dojoId]
      );
      const movedIds = upd.rows.map((r) => r.id);

      // Defensivo: se por algum motivo nem todos os ids do grupo foram
      // movidos (não deveria acontecer — já estão travados por FOR UPDATE
      // desde o passo 2, dentro da mesma transação), os que sobraram vão
      // para skipped em vez de silenciosamente desaparecer.
      if (movedIds.length !== group.studentIds.length) {
        const movedSet = new Set(movedIds.map(String));
        for (const sid of group.studentIds) {
          if (!movedSet.has(String(sid))) {
            skipped.push({ student_id: sid, reason: 'NOT_IN_TARGET_DOJO' });
          }
        }
      }
      if (!movedIds.length) continue;

      // Histórico imutável em lote (mesmas colunas de karateTransfers.js).
      try {
        await client.query(
          `INSERT INTO karate_practitioner_transfers
             (practitioner_id, federation_id, origin_dojo_id, destination_dojo_id,
              origin_dojo_name, destination_dojo_name, reason, transferred_at, initiated_by)
           SELECT u.id, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8
             FROM unnest($1::uuid[]) AS u(id)`,
          [
            movedIds, federationId, dojoId, group.destinationDojoId,
            originDojoName, destName,
            'Redistribuição por inativação de dojô', actorId,
          ]
        );
      } catch (e) {
        if (e && e.code === '42P01') {
          // Migração 180 pendente: a movimentação de dojô já é válida, mas
          // sem histórico persistível — aborta a transação inteira para não
          // mover praticante sem rastro (mesma postura de karateTransfers.js).
          await client.query('ROLLBACK');
          return res.status(503).json({
            error: 'Histórico de transferências ainda não disponível (migração 180 pendente)',
            code: 'MIGRATION_PENDING',
          });
        }
        throw e;
      }

      transferredCount += movedIds.length;
      for (const sid of movedIds) {
        appliedDecisions.push({
          student_id: sid, action: 'transfer', destination_dojo_id: group.destinationDojoId,
        });
      }
    }

    // 5) Inativações: UMA query em lote.
    if (inactivateIds.length) {
      const updI = await client.query(
        `UPDATE customers SET is_active = false, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND dojo_id = $2
          RETURNING id`,
        [inactivateIds, dojoId]
      );
      inactivatedCount = updI.rowCount;

      if (updI.rows.length !== inactivateIds.length) {
        const inactivatedSet = new Set(updI.rows.map((r) => String(r.id)));
        for (const sid of inactivateIds) {
          if (!inactivatedSet.has(String(sid))) {
            skipped.push({ student_id: sid, reason: 'NOT_IN_TARGET_DOJO' });
          }
        }
      }
      for (const r of updI.rows) {
        appliedDecisions.push({ student_id: r.id, action: 'inactivate' });
      }
    }

    // 6) Evento de auditoria da redistribuição (best-effort, SAVEPOINT)
    await safeRosterWrite(client, 'redistribute event', () => client.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, 'redistribute', $3::jsonb, $4)`,
      [dojoId, federationId, JSON.stringify(appliedDecisions), actorId]
    ));

    // 7) Inativa o dojô (default true) + cascata para quem sobrou ativo
    let dojoInactivated = false;
    if (inactivateDojo) {
      const dojoUpd = await client.query(
        `UPDATE companies SET is_active = false, updated_at = NOW()
          WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
          RETURNING id`,
        [dojoId, federationId]
      );
      if (dojoUpd.rows.length) {
        dojoInactivated = true;
        await cascadeInactivateRemaining(client, { dojoId, federationId, actorId });
      }
    }

    await client.query('COMMIT');

    return res.json({
      transferred: transferredCount,
      inactivated: inactivatedCount,
      dojo_inactivated: dojoInactivated,
      skipped,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[karateRosterRedistribute] redistribute error:', e.message);
    return res.status(500).json({ error: 'Erro ao redistribuir praticantes do dojô', detail: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
