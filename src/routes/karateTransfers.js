// ============================================================
// AURA KARATÊ — Transferência de praticante entre dojôs (Track N)
// Montado sob /federation/:id. Guards de karateRoles.
//   GET    /practitioners/:practitionerId/transfers                (read)
//        — histórico de transferências do praticante
//   POST   /practitioners/:practitionerId/transfer                 (staffWrite)
//        — transfere o praticante para um dojô de destino (mesma federação)
//   PATCH  /practitioners/:practitionerId/transfers/:transferId    (staffWrite)
//        — corrige metadados do registro (motivo, data) — NÃO move dojo_id
//   DELETE /practitioners/:practitionerId/transfers/:transferId    (staffWrite)
//        — exclui o registro de transferência — NÃO reverte customers.dojo_id
//
// Garantias:
//   - Transacional: reatribui customers.dojo_id + grava histórico append-only.
//   - Idempotente / anti-duplo-clique: SELECT ... FOR UPDATE no praticante;
//     se já estiver no destino, retorna 409 sem gravar nova linha.
//   - Histórico de faixas (karate_belt_history) e presenças NÃO são tocados:
//     são chaveados por student_id (= customer), preservados na íntegra.
//   - E-mails (origem + destino) são best-effort: falha de envio NÃO reverte
//     a transferência (enviados após COMMIT).
//   - Defensivo: a tabela 180 pode não existir ainda (42P01) — seguro mergear
//     o código antes da migração ser aplicada.
//
// 25/06/2026 (decisão Caio — liberdade total da federação): editar/excluir o
//   registro histórico por item. A edição corrige só os METADADOS (motivo,
//   data efetiva); NÃO re-executa a movimentação. A exclusão remove o registro
//   mas NÃO reverte o customers.dojo_id atual (a reversão de dojô se faz via
//   nova transferência ou editando a ficha do praticante).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

let sendKarateEmail = null;
try {
  ({ sendKarateEmail } = require('../services/karateMailer'));
} catch (_) { /* mailer ausente em alguns ambientes — segue sem e-mail */ }

// ── GET histórico de transferências do praticante ───────────
router.get('/practitioners/:practitionerId/transfers', ...guards.read(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT t.id,
              t.practitioner_id,
              t.origin_dojo_id,
              t.destination_dojo_id,
              COALESCE(t.origin_dojo_name, orig.name)       AS origin_dojo_name,
              COALESCE(t.destination_dojo_name, dest.name)  AS destination_dojo_name,
              t.reason,
              t.transferred_at,
              t.initiated_by,
              COALESCE(u.full_name, u.email) AS initiated_by_name,
              t.created_at
         FROM karate_practitioner_transfers t
         LEFT JOIN companies orig ON orig.id = t.origin_dojo_id
         LEFT JOIN companies dest ON dest.id = t.destination_dojo_id
         LEFT JOIN users u        ON u.id   = t.initiated_by
        WHERE t.practitioner_id = $1 AND t.federation_id = $2
        ORDER BY t.transferred_at DESC, t.created_at DESC`,
      [practitionerId, federationId]
    );
    return res.json({ data: rows });
  } catch (e) {
    // Tabela ainda não migrada — histórico vazio (não quebra a ficha)
    if (e.code === '42P01') return res.json({ data: [] });
    console.error('[karateTransfers] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar transferências' });
  }
});

// ── POST transferir praticante para outro dojô ─────────────
router.post('/practitioners/:practitionerId/transfer', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const body = req.body || {};
  const destinationDojoId = body.destination_dojo_id || body.dojo_id || null;
  const reason = body.reason ? String(body.reason).trim().slice(0, 1000) : null;
  // Data efetiva opcional (retroativa); default = hoje. Aceita 'YYYY-MM-DD'.
  const transferredAt = (typeof body.transferred_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.transferred_at))
    ? body.transferred_at
    : null;

  if (!destinationDojoId) {
    return res.status(422).json({ error: 'Campo destination_dojo_id é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Trava a linha do praticante (anti-duplo-clique / concorrência)
    const pracRes = await client.query(
      `SELECT id, name, email, dojo_id
         FROM customers
        WHERE id = $1 AND federation_id = $2
        FOR UPDATE`,
      [practitionerId, federationId]
    );
    if (!pracRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado nesta federação', code: 'NOT_FOUND' });
    }
    const prac = pracRes.rows[0];
    const originDojoId = prac.dojo_id || null;

    // 2) Idempotência: já está no destino → não grava nada
    if (originDojoId && String(originDojoId) === String(destinationDojoId)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Praticante já está neste dojô',
        code: 'ALREADY_AT_DESTINATION',
      });
    }

    // 3) Valida que o dojô de destino pertence a esta federação
    const destRes = await client.query(
      `SELECT id, name, email FROM companies
        WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
        LIMIT 1`,
      [destinationDojoId, federationId]
    );
    if (!destRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Dojô de destino não pertence a esta federação', code: 'VALIDATION_ERROR' });
    }
    const destDojo = destRes.rows[0];

    // Dados do dojô de origem (snapshot de nome/e-mail), se houver
    let originDojo = null;
    if (originDojoId) {
      const o = await client.query('SELECT id, name, email FROM companies WHERE id = $1 LIMIT 1', [originDojoId]);
      originDojo = o.rows[0] || null;
    }

    // 4) Reatribui o dojô atual do praticante (histórico de faixas/presença intacto)
    await client.query(
      `UPDATE customers SET dojo_id = $1, updated_at = NOW() WHERE id = $2`,
      [destinationDojoId, practitionerId]
    );

    // 5) Grava o histórico imutável (append-only). Defensivo a 42P01.
    let transferRow = null;
    try {
      const ins = await client.query(
        `INSERT INTO karate_practitioner_transfers
           (practitioner_id, federation_id, origin_dojo_id, destination_dojo_id,
            origin_dojo_name, destination_dojo_name, reason, transferred_at, initiated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9)
         RETURNING id, transferred_at, created_at`,
        [
          practitionerId, federationId, originDojoId, destinationDojoId,
          originDojo ? originDojo.name : null, destDojo.name, reason,
          transferredAt, (req.user && req.user.id) || null,
        ]
      );
      transferRow = ins.rows[0];
    } catch (e) {
      // Migração 180 ainda não aplicada: a reatribuição do dojô é válida, mas
      // não conseguimos persistir o histórico → aborta para não transferir sem rastro.
      await client.query('ROLLBACK');
      if (e.code === '42P01') {
        return res.status(503).json({
          error: 'Histórico de transferências ainda não disponível (migração 180 pendente)',
          code: 'MIGRATION_PENDING',
        });
      }
      throw e;
    }

    await client.query('COMMIT');

    // 6) Notificações best-effort (após COMMIT — falha NÃO reverte a transferência)
    if (sendKarateEmail) {
      const bodyHtmlBase = (lead) => `
        <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 12px;">${lead}</p>
        <p style="font-size:13px;color:#78716c;line-height:21px;margin:0;">
          Praticante: <strong>${prac.name || '—'}</strong><br/>
          De: <strong>${originDojo ? originDojo.name : 'Sem dojô anterior'}</strong><br/>
          Para: <strong>${destDojo.name}</strong>${reason ? `<br/>Motivo: ${reason}` : ''}
        </p>`;
      const recipients = [];
      if (originDojo && originDojo.email) {
        recipients.push({ to: originDojo.email, lead: `O praticante saiu do seu dojô e foi transferido para ${destDojo.name}.` });
      }
      if (destDojo.email) {
        recipients.push({ to: destDojo.email, lead: `Um praticante foi transferido para o seu dojô.` });
      }
      await Promise.all(recipients.map((r) =>
        sendKarateEmail(r.to, {
          subject: `Transferência de praticante — ${prac.name || ''}`.trim(),
          heading: 'Transferência de praticante',
          bodyHtml: bodyHtmlBase(r.lead),
        }).catch((err) => console.error('[karateTransfers] e-mail best-effort falhou:', err.message))
      ));
    }

    return res.status(201).json({
      id: transferRow.id,
      practitioner_id: practitionerId,
      origin_dojo_id: originDojoId,
      destination_dojo_id: destinationDojoId,
      origin_dojo_name: originDojo ? originDojo.name : null,
      destination_dojo_name: destDojo.name,
      reason,
      transferred_at: transferRow.transferred_at,
      created_at: transferRow.created_at,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[karateTransfers] transfer error:', e.message);
    return res.status(500).json({ error: 'Erro ao transferir praticante', detail: e.message });
  } finally {
    client.release();
  }
});

// ── PATCH corrigir metadados de um registro de transferência ──
// Corrige SÓ os metadados do registro (reason/motivo, transferred_at/data).
// NÃO re-executa a movimentação (não toca customers.dojo_id, origin/destination).
router.patch('/practitioners/:practitionerId/transfers/:transferId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId, transferId } = req.params;
  const b = req.body || {};

  const sets = [];
  const vals = [];
  let i = 1;

  if (b.reason !== undefined) {
    // string vazia/null → limpa o motivo (dado ausente é neutro)
    const v = (b.reason === null || String(b.reason).trim() === '') ? null : String(b.reason).trim().slice(0, 1000);
    sets.push(`reason = $${i}`); vals.push(v); i++;
  }
  if (b.transferred_at !== undefined) {
    const v = b.transferred_at != null ? String(b.transferred_at).slice(0, 10) : '';
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return res.status(422).json({ error: 'transferred_at deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
    }
    sets.push(`transferred_at = $${i}::date`); vals.push(v); i++;
  }

  if (!sets.length) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  try {
    // Escopo: o registro pertence a ESTE praticante E a ESTA federação.
    vals.push(transferId, practitionerId, federationId);
    const upd = await db.query(
      `UPDATE karate_practitioner_transfers
          SET ${sets.join(', ')}
        WHERE id = $${i} AND practitioner_id = $${i + 1} AND federation_id = $${i + 2}
      RETURNING id, practitioner_id, origin_dojo_id, destination_dojo_id,
                origin_dojo_name, destination_dojo_name, reason, transferred_at, created_at`,
      vals
    );
    if (!upd.rows.length) {
      return res.status(404).json({ error: 'Transferência não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    return res.json(upd.rows[0]);
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(404).json({ error: 'Transferência não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    console.error('[karateTransfers] update error:', e.message);
    return res.status(500).json({ error: 'Erro ao editar transferência', detail: e.message });
  }
});

// ── DELETE excluir um registro de transferência ──
// Remove a linha do histórico. IMPORTANTE: NÃO reverte o customers.dojo_id
// atual — apagar o rastro não move o praticante de volta. A reversão de dojô
// se faz via nova transferência ou editando a ficha do praticante.
router.delete('/practitioners/:practitionerId/transfers/:transferId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId, transferId } = req.params;
  try {
    const del = await db.query(
      `DELETE FROM karate_practitioner_transfers
        WHERE id = $1 AND practitioner_id = $2 AND federation_id = $3
      RETURNING id`,
      [transferId, practitionerId, federationId]
    );
    if (!del.rows.length) {
      return res.status(404).json({ error: 'Transferência não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    return res.json({ deleted: true, id: transferId });
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(404).json({ error: 'Transferência não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    console.error('[karateTransfers] delete error:', e.message);
    return res.status(500).json({ error: 'Erro ao excluir transferência', detail: e.message });
  }
});

module.exports = router;
