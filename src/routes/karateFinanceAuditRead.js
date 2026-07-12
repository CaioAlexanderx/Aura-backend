// ============================================================
// AURA KARATÊ — Fase G3: leitura do rastro de ações financeiras
//
//   GET /financial/audit?target_id=&limit=&since=&until=
//
// Devolve as linhas de karate_finance_audit_log da federação, mais
// recentes primeiro. `target_id` (opcional) filtra por UMA parcela/
// anuidade específica — é o que a UI usa pra mostrar o histórico curto
// ao expandir a linha de uma cobrança. `since`/`until` (opcionais, ISO)
// filtram por período. `limit` (opcional, default 50, máx 200).
//
// Guard: adminOnly (mesma trilha das demais rotas financeiras sensíveis).
// Esta rota é PURAMENTE DE LEITURA — não altera nada.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

router.get('/audit', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId } = req.params;
  const { target_id: targetId, since, until } = req.query;

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const conditions = ['federation_id = $1'];
  const params = [federationId];
  let i = 2;

  if (targetId) {
    conditions.push(`target_id = $${i}`);
    params.push(targetId);
    i++;
  }
  if (since) {
    conditions.push(`created_at >= $${i}`);
    params.push(since);
    i++;
  }
  if (until) {
    conditions.push(`created_at <= $${i}`);
    params.push(until);
    i++;
  }

  params.push(limit);

  try {
    const { rows } = await db.query(
      `SELECT id, federation_id, action, target_type, target_id, dojo_id, practitioner_id,
              actor_user_id, actor_label, source, before, after, created_at
       FROM karate_finance_audit_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${i}`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    if (err.code === '42P01') {
      // Migration 227 ainda não aplicada — degrada pra lista vazia (mesmo
      // padrão de schema-guard usado em todo o resto do módulo karatê).
      return res.json({ items: [] });
    }
    console.error('[karateFinanceAuditRead] erro ao listar auditoria:', err.message);
    res.status(500).json({ error: 'Erro ao listar auditoria financeira', detail: err.message });
  }
});

module.exports = router;
