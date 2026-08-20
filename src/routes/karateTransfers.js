// ============================================================
// AURA KARATÊ — Transferência de praticante entre dojôs (Track N)
// Montado sob /federation/:id. Guards de karateRoles.
//   GET    /practitioners/:practitionerId/transfers                (read)
//        — histórico de transferências do praticante
//   POST   /practitioners/:practitionerId/transfer                 (staffWrite)
//        — transfere o praticante para um dojô de destino (mesma federação)
//   PATCH  /practitioners/:practitionerId/transfers/:transferId    (staffWrite)
//        — corrige metadados do registro (motivo, data) — NÃO move dojo_id.
//          AUDITADO: grava before/after em karate_practitioner_transfer_audit.
//   DELETE /practitioners/:practitionerId/transfers/:transferId    (staffWrite)
//        — VOID (soft-delete): marca voided_* em vez de apagar. A linha
//          permanece (append-only preservado), some da leitura. NÃO reverte
//          customers.dojo_id.
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
//
// 20/08/2026 (follow-up QA Onda 1 — migration 293): a "exclusão" vira VOID
//   (soft-delete: voided_at/by/reason) para preservar o espírito append-only,
//   e a edição passa a ser AUDITADA (before/after em
//   karate_practitioner_transfer_audit). VOID e PATCH rodam em transação com
//   SET LOCAL app.allow_transfer_purge='on' (escape hatch da 221) — sem ele a
//   trigger de imutabilidade da 180 barra o UPDATE. Guard extra: se o registro
//   sendo anulado/editado é o que EXPLICA o customers.dojo_id atual do
//   praticante, exige ?confirm=true (senão 409 EXPLAINS_CURRENT_DOJO).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { recordTransferCorrection } = require('../services/karateTransferAudit');

// Migration 293: colunas de VOID (soft-delete). Cache module-level p/ o
// caso do deploy anteceder a migração (armadilha #1 do CLAUDE.md): a
// primeira leitura que topar 42703 desliga o filtro e não repete o erro.
let HAS_VOID_COLUMNS = true;

// SET LOCAL do escape hatch da 221 — libera a trigger de imutabilidade só
// nesta transação (expira sozinho no COMMIT/ROLLBACK; NUNCA SET global).
async function allowTransferMutation(client) {
  await client.query("SET LOCAL app.allow_transfer_purge = 'on'");
}

// O registro é o que EXPLICA o dojô atual do praticante? (é a transferência
// ativa mais recente E o destino dela é o customers.dojo_id de hoje). Se for,
// anular/reordenar mexe no "porquê" do estado atual — exige confirmação.
async function explainsCurrentDojo(client, federationId, practitionerId, transferRow) {
  const cust = await client.query(
    `SELECT dojo_id FROM customers WHERE id = $1 AND federation_id = $2`,
    [practitionerId, federationId]
  );
  const currentDojo = cust.rows[0] ? cust.rows[0].dojo_id : null;
  if (!currentDojo || String(transferRow.destination_dojo_id) !== String(currentDojo)) return false;

  const latest = await client.query(
    `SELECT id FROM karate_practitioner_transfers
      WHERE practitioner_id = $1 AND federation_id = $2 AND voided_at IS NULL
      ORDER BY transferred_at DESC, created_at DESC
      LIMIT 1`,
    [practitionerId, federationId]
  );
  const latestId = latest.rows[0] ? latest.rows[0].id : null;
  return latestId != null && String(latestId) === String(transferRow.id);
}

let sendKarateEmail = null;
try {
  ({ sendKarateEmail } = require('../services/karateMailer'));
} catch (_) { /* mailer ausente em alguns ambientes — segue sem e-mail */ }

// ── GET histórico de transferências do praticante ───────────
router.get('/practitioners/:practitionerId/transfers', ...guards.read(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  // Só lista transferências ATIVAS: as anuladas (voided_at) somem da ficha.
  const listSql = (withVoidFilter) => `
      SELECT t.id,
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
         ${withVoidFilter ? 'AND t.voided_at IS NULL' : ''}
       ORDER BY t.transferred_at DESC, t.created_at DESC`;
  try {
    let rows;
    try {
      ({ rows } = await db.query(listSql(HAS_VOID_COLUMNS), [practitionerId, federationId]));
    } catch (inner) {
      // Coluna voided_at ausente (deploy antes da migration 293): desliga o
      // filtro e re-tenta sem ele (não repete o erro nas próximas chamadas).
      if (inner.code === '42703' && HAS_VOID_COLUMNS) {
        HAS_VOID_COLUMNS = false;
        ({ rows } = await db.query(listSql(false), [practitionerId, federationId]));
      } else {
        throw inner;
      }
    }
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
// AUDITADO: grava before/after em karate_practitioner_transfer_audit, na MESMA
// transação (correção sem rastro é justamente o que este follow-up impede).
// Guard: se o registro é o que explica o dojô atual do praticante, exige
// ?confirm=true (editar a data pode reordenar qual transferência "vale").
router.patch('/practitioners/:practitionerId/transfers/:transferId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId, transferId } = req.params;
  const b = req.body || {};
  const confirmed = String(req.query.confirm) === 'true';

  // Campos permitidos → colunas + valores validados.
  const patch = {};
  if (b.reason !== undefined) {
    // string vazia/null → limpa o motivo (dado ausente é neutro)
    patch.reason = (b.reason === null || String(b.reason).trim() === '') ? null : String(b.reason).trim().slice(0, 1000);
  }
  if (b.transferred_at !== undefined) {
    const v = b.transferred_at != null ? String(b.transferred_at).slice(0, 10) : '';
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return res.status(422).json({ error: 'transferred_at deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
    }
    patch.transferred_at = v;
  }

  const fields = Object.keys(patch);
  if (!fields.length) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Trava o registro ATIVO (não editamos linha já anulada), escopado por
    // praticante + federação. Captura o "antes" para a auditoria.
    const cur = await client.query(
      `SELECT id, practitioner_id, origin_dojo_id, destination_dojo_id,
              origin_dojo_name, destination_dojo_name, reason, transferred_at, created_at
         FROM karate_practitioner_transfers
        WHERE id = $1 AND practitioner_id = $2 AND federation_id = $3 AND voided_at IS NULL
        FOR UPDATE`,
      [transferId, practitionerId, federationId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transferência não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    const before = cur.rows[0];

    // Guard: é o registro que explica o dojô atual? Exige confirmação.
    if (!confirmed && await explainsCurrentDojo(client, federationId, practitionerId, before)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'EXPLAINS_CURRENT_DOJO',
        error: 'Este é o registro que explica o dojô atual do praticante. Editá-lo pode reordenar o histórico. Reenvie com ?confirm=true para confirmar.',
      });
    }

    // Escape hatch da 221: sem ele a trigger de imutabilidade barra o UPDATE.
    await allowTransferMutation(client);

    const sets = [];
    const vals = [];
    let i = 1;
    if (Object.prototype.hasOwnProperty.call(patch, 'reason')) { sets.push(`reason = $${i}`); vals.push(patch.reason); i++; }
    if (Object.prototype.hasOwnProperty.call(patch, 'transferred_at')) { sets.push(`transferred_at = $${i}::date`); vals.push(patch.transferred_at); i++; }
    vals.push(transferId, practitionerId, federationId);
    const upd = await client.query(
      `UPDATE karate_practitioner_transfers
          SET ${sets.join(', ')}
        WHERE id = $${i} AND practitioner_id = $${i + 1} AND federation_id = $${i + 2}
      RETURNING id, practitioner_id, origin_dojo_id, destination_dojo_id,
                origin_dojo_name, destination_dojo_name, reason, transferred_at, created_at`,
      vals
    );
    const after = upd.rows[0];

    // Rastro atômico do que mudou (só os campos editados).
    const beforeDiff = {};
    const afterDiff = {};
    fields.forEach((f) => { beforeDiff[f] = before[f]; afterDiff[f] = after[f]; });
    await recordTransferCorrection(client, {
      transferId, federationId, practitionerId,
      action: 'patch',
      actorUserId: (req.user && req.user.id) || null,
      before: beforeDiff,
      after: afterDiff,
    });

    await client.query('COMMIT');
    return res.json(after);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    // Schema da 293 ausente (tabela/coluna) → correção não é gravável sem rastro.
    if (e.code === '42P01' || e.code === '42703') {
      return res.status(503).json({
        error: 'Correção de transferências ainda não disponível (migração 293 pendente)',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[karateTransfers] update error:', e.message);
    return res.status(500).json({ error: 'Erro ao editar transferência', detail: e.message });
  } finally {
    client.release();
  }
});

// ── DELETE → VOID (soft-delete) de um registro de transferência ──
// NÃO apaga a linha: marca voided_at/voided_by/void_reason. A linha
// permanece no banco (append-only preservado) e some de toda leitura
// (voided_at IS NULL). IMPORTANTE: NÃO reverte o customers.dojo_id atual —
// anular o rastro não move o praticante de volta; a reversão de dojô se faz
// via nova transferência ou editando a ficha. Guard: se este é o registro que
// explica o dojô atual, exige ?confirm=true.
router.delete('/practitioners/:practitionerId/transfers/:transferId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId, transferId } = req.params;
  const confirmed = String(req.query.confirm) === 'true';
  const rawReason = (req.body && req.body.reason) != null ? req.body.reason
    : (req.query.reason != null ? req.query.reason : null);
  const voidReason = rawReason != null && String(rawReason).trim() !== ''
    ? String(rawReason).trim().slice(0, 1000) : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Trava o registro ATIVO (anular de novo é no-op → 404), escopado por
    // praticante + federação.
    const cur = await client.query(
      `SELECT id, destination_dojo_id, transferred_at, created_at
         FROM karate_practitioner_transfers
        WHERE id = $1 AND practitioner_id = $2 AND federation_id = $3 AND voided_at IS NULL
        FOR UPDATE`,
      [transferId, practitionerId, federationId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transferência não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    const row = cur.rows[0];

    // Guard: é o registro que explica o dojô atual? Exige confirmação — anular
    // deixaria customers.dojo_id "sem explicação" no histórico visível.
    if (!confirmed && await explainsCurrentDojo(client, federationId, practitionerId, row)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'EXPLAINS_CURRENT_DOJO',
        error: 'Este é o registro que explica o dojô atual do praticante. Anulá-lo NÃO move o praticante de volta e deixa o dojô atual sem rastro no histórico. Reenvie com ?confirm=true para confirmar.',
      });
    }

    // Escape hatch da 221: sem ele a trigger de imutabilidade barra o UPDATE.
    await allowTransferMutation(client);

    const upd = await client.query(
      `UPDATE karate_practitioner_transfers
          SET voided_at = NOW(), voided_by = $4, void_reason = $5
        WHERE id = $1 AND practitioner_id = $2 AND federation_id = $3 AND voided_at IS NULL
      RETURNING id, voided_at`,
      [transferId, practitionerId, federationId, (req.user && req.user.id) || null, voidReason]
    );

    // Rastro atômico do VOID.
    await recordTransferCorrection(client, {
      transferId, federationId, practitionerId,
      action: 'void',
      actorUserId: (req.user && req.user.id) || null,
      reason: voidReason,
    });

    await client.query('COMMIT');
    return res.json({ voided: true, id: transferId, voided_at: upd.rows[0] ? upd.rows[0].voided_at : null });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (e.code === '42P01' || e.code === '42703') {
      return res.status(503).json({
        error: 'Anulação de transferências ainda não disponível (migração 293 pendente)',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[karateTransfers] void error:', e.message);
    return res.status(500).json({ error: 'Erro ao anular transferência', detail: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
