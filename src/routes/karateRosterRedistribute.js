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
// praticantes. Roda DEPOIS das decisões — só pega quem sobrou.
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
  for (const d of decisions) {
    if (!d || typeof d !== 'object' || !d.student_id || !['transfer', 'inactivate'].includes(d.action)) {
      return res.status(422).json({
        error: 'Cada item de decisions precisa de student_id e action ("transfer" ou "inactivate")',
        code: 'VALIDATION_ERROR',
      });
    }
    if (d.action === 'transfer' && !d.destination_dojo_id) {
      return res.status(422).json({
        error: 'Decisão de transfer exige destination_dojo_id',
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

    const skipped = [];
    const appliedDecisions = [];
    let transferredCount = 0;
    let inactivatedCount = 0;

    // Cache de nomes de dojôs de destino já validados nesta requisição
    const destDojoCache = new Map();

    for (const decision of decisions) {
      const studentId = decision.student_id;

      // Só mexe em quem está ATUALMENTE no dojô alvo (evita corrida/duplo-clique
      // e decisões para praticantes já movidos por outra requisição).
      const pracRes = await client.query(
        `SELECT id, name, dojo_id, is_active FROM customers
          WHERE id = $1 AND federation_id = $2
          FOR UPDATE`,
        [studentId, federationId]
      );
      if (!pracRes.rows.length) {
        skipped.push({ student_id: studentId, reason: 'PRACTITIONER_NOT_FOUND' });
        continue;
      }
      const prac = pracRes.rows[0];
      if (String(prac.dojo_id || '') !== String(dojoId)) {
        skipped.push({ student_id: studentId, reason: 'NOT_IN_TARGET_DOJO' });
        continue;
      }

      if (decision.action === 'transfer') {
        const destinationDojoId = decision.destination_dojo_id;

        if (String(destinationDojoId) === String(dojoId)) {
          skipped.push({ student_id: studentId, reason: 'DESTINATION_EQUALS_ORIGIN' });
          continue;
        }

        let destDojo = destDojoCache.get(String(destinationDojoId));
        if (destDojo === undefined) {
          const destRes = await client.query(
            `SELECT id, name FROM companies
              WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
              LIMIT 1`,
            [destinationDojoId, federationId]
          );
          destDojo = destRes.rows[0] || null;
          destDojoCache.set(String(destinationDojoId), destDojo);
        }
        if (!destDojo) {
          skipped.push({ student_id: studentId, reason: 'INVALID_DESTINATION_DOJO' });
          continue;
        }

        // UPDATE escopado ao dojô de origem — se outra requisição já moveu o
        // praticante entre o FOR UPDATE acima e aqui, rowCount vem 0.
        const upd = await client.query(
          `UPDATE customers SET dojo_id = $1, updated_at = NOW()
            WHERE id = $2 AND dojo_id = $3`,
          [destinationDojoId, studentId, dojoId]
        );
        if (upd.rowCount === 0) {
          skipped.push({ student_id: studentId, reason: 'NOT_IN_TARGET_DOJO' });
          continue;
        }

        // Histórico imutável (mesmo padrão/colunas de karateTransfers.js)
        try {
          await client.query(
            `INSERT INTO karate_practitioner_transfers
               (practitioner_id, federation_id, origin_dojo_id, destination_dojo_id,
                origin_dojo_name, destination_dojo_name, reason, transferred_at, initiated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)`,
            [
              studentId, federationId, dojoId, destinationDojoId,
              dojoRes.rows[0].name, destDojo.name,
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

        transferredCount++;
        appliedDecisions.push({
          student_id: studentId, action: 'transfer', destination_dojo_id: destinationDojoId,
        });
      } else {
        // inactivate
        const upd = await client.query(
          `UPDATE customers SET is_active = false, updated_at = NOW()
            WHERE id = $1 AND dojo_id = $2`,
          [studentId, dojoId]
        );
        if (upd.rowCount === 0) {
          skipped.push({ student_id: studentId, reason: 'NOT_IN_TARGET_DOJO' });
          continue;
        }
        inactivatedCount++;
        appliedDecisions.push({ student_id: studentId, action: 'inactivate' });
      }
    }

    // 3) Evento de auditoria da redistribuição (best-effort, SAVEPOINT)
    await safeRosterWrite(client, 'redistribute event', () => client.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, 'redistribute', $3::jsonb, $4)`,
      [dojoId, federationId, JSON.stringify(appliedDecisions), actorId]
    ));

    // 4) Inativa o dojô (default true) + cascata para quem sobrou ativo
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
