// ============================================================
// AURA. -- Crediario: LISTA DE SALDOS (GET /credit/balances)
//
// Primeiro passo da decomposicao do monolito credit.js: a rota de
// listagem de saldos vive aqui, isolada. Montada em private.js ANTES
// de ./credit, ela atende GET /credit/balances; as demais rotas de
// crediario continuam em ./credit ate a decomposicao completa.
//
// Relato #1 (DESIGN-38): a flag de atraso da lista e calculada por DATA
// (America/Sao_Paulo), nunca herdada de status 'overdue' stale. Defensivo
// a 42703/42P01 (deploy parcial): se credit_installments nao existir ou nao
// tiver as colunas, a lista volta sem atraso em vez de quebrar.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const overdueRule = require('../services/credit/overdue');

// Carencia do SINAL de atraso: late_grace_days so vale quando a loja cobra
// encargos (late_charges_enabled). Defensivo: se a tabela/colunas nao existirem,
// cai em 0 -- atraso a partir do dia seguinte ao vencimento.
async function loadGraceDays(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT late_grace_days, late_charges_enabled FROM credit_plan_configs WHERE company_id = $1`,
      [companyId]
    );
    return overdueRule.signalGraceDays(rows[0]);
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    return 0;
  }
}

async function assertCrediarioEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) { const e = new Error('Empresa nao encontrada'); e.status = 404; throw e; }
  if (rows[0].enabled !== 'true') {
    const e = new Error('Modulo de crediario nao esta habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.');
    e.status = 403; e.code = 'CREDIARIO_DISABLED'; throw e;
  }
}

// GET /balances?only_open=true&q=texto
router.get('/balances', async (req, res) => {
  const onlyOpen = req.query.only_open !== 'false';
  const q = req.query.q ? String(req.query.q).trim() : '';
  try {
    await assertCrediarioEnabled(req.params.id);
    const conditions = ['cb.company_id = $1'];
    const params = [req.params.id];
    let i = 2;
    if (onlyOpen) conditions.push('cb.balance > 0');
    if (q) {
      conditions.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.cpf_cnpj ILIKE $${i})`);
      params.push(`%${q}%`);
      i++;
    }
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.phone, c.cpf_cnpj,
              cb.balance, cb.total_debited, cb.total_paid, cb.last_activity_at
         FROM customer_credit_balances cb
         JOIN customers c ON c.id = cb.customer_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY cb.balance DESC, cb.last_activity_at DESC NULLS LAST
        LIMIT 500`,
      params
    );

    // Atraso pela REGRA UNICA (services/credit/overdue.js): data + carencia +
    // tolerancia de residuo + parcela retroativa vira "a conferir". Nunca le
    // credit_installments.status como fonte de atraso.
    const overdueByCustomer = {};
    try {
      const ids = rows.map((r) => r.id);
      if (ids.length) {
        const graceDays = await loadGraceDays(req.params.id);
        const isOverdue = overdueRule.overdueSql({ graceDays });
        const isToReview = overdueRule.toReviewSql({});
        const { rows: oiRows } = await db.query(
          `SELECT customer_id,
                  MIN(due_date) FILTER (WHERE status IN ('pending','overdue')) AS next_due_date,
                  MIN(due_date) FILTER (WHERE ${isOverdue})                    AS oldest_overdue_date,
                  BOOL_OR(${isOverdue})                                        AS overdue,
                  COUNT(*) FILTER (WHERE ${isToReview})                        AS to_review_count
             FROM credit_installments
            WHERE company_id = $1 AND customer_id = ANY($2::uuid[])
            GROUP BY customer_id`,
          [req.params.id, ids]
        );
        for (const o of oiRows) {
          overdueByCustomer[o.customer_id] = {
            overdue: o.overdue === true,
            next_due_date: o.next_due_date ? String(o.next_due_date).split('T')[0] : null,
            oldest_overdue_date: o.oldest_overdue_date ? String(o.oldest_overdue_date).split('T')[0] : null,
            to_review_count: parseInt(o.to_review_count || 0, 10),
          };
        }
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    const totals = rows.reduce(
      (acc, r) => ({
        total_open:     acc.total_open + Math.max(0, parseFloat(r.balance) || 0),
        customers_open: acc.customers_open + ((parseFloat(r.balance) || 0) > 0 ? 1 : 0),
      }),
      { total_open: 0, customers_open: 0 }
    );
    res.json({
      customers: rows.map(r => ({
        id: r.id, name: r.name, phone: r.phone, cpf_cnpj: r.cpf_cnpj,
        balance: parseFloat(r.balance) || 0,
        total_debited: parseFloat(r.total_debited) || 0,
        total_paid: parseFloat(r.total_paid) || 0,
        last_activity_at: r.last_activity_at,
        overdue:             (overdueByCustomer[r.id] || {}).overdue || false,
        next_due_date:       (overdueByCustomer[r.id] || {}).next_due_date || null,
        // Vencimento mais antigo que REALMENTE conta como atraso (ja com carencia
        // e sem retroativas) -- e a base do aging, nao o next_due_date.
        oldest_overdue_date: (overdueByCustomer[r.id] || {}).oldest_overdue_date || null,
        // Parcelas retroativas vencidas: carne historico a conferir, nao atraso.
        to_review_count:     (overdueByCustomer[r.id] || {}).to_review_count || 0,
      })),
      total_open: parseFloat(totals.total_open.toFixed(2)),
      customers_open: totals.customers_open,
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] balances error:', err.message);
    res.status(500).json({ error: 'Erro ao listar saldos de crediario' });
  }
});

module.exports = router;
