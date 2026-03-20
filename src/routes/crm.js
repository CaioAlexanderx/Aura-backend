// ============================================================
// AURA. — Rotas de CRM Expandido (BE-05)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getCustomersRanking, getUpcomingBirthdays, getCustomerProfile } = require('../services/crm');

/**
 * GET /companies/:id/customers/ranking
 * Query params:
 *   period     = week | month | year | custom (padrão: month)
 *   limit      = número máximo de clientes (padrão: 50)
 *   start_date = YYYY-MM-DD
 *   end_date   = YYYY-MM-DD
 */
router.get('/ranking', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', limit = 50, start_date, end_date } = req.query;

    const data = await getCustomersRanking(companyId, {
      period, limit: parseInt(limit), start_date, end_date,
    });

    res.json({ period, total: data.length, customers: data });
  } catch (err) {
    console.error('Erro em GET /customers/ranking:', err.message);
    res.status(500).json({ error: 'Erro ao buscar ranking de clientes' });
  }
});

/**
 * GET /companies/:id/customers/birthdays
 * Query params:
 *   days = número de dias à frente (padrão: 7)
 */
router.get('/birthdays', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { days = 7 } = req.query;

    const daysNum = parseInt(days);
    if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
      return res.status(400).json({
        error: 'days deve ser entre 1 e 365',
      });
    }

    const data = await getUpcomingBirthdays(companyId, daysNum);
    res.json({ days: daysNum, total: data.length, customers: data });
  } catch (err) {
    console.error('Erro em GET /customers/birthdays:', err.message);
    res.status(500).json({ error: 'Erro ao buscar aniversários' });
  }
});

/**
 * GET /companies/:id/customers/:customerId/profile
 * Ficha completa do cliente
 */
router.get('/:customerId/profile', async (req, res) => {
  try {
    const { id: companyId, customerId } = req.params;

    const data = await getCustomerProfile(companyId, customerId);

    if (!data) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }

    res.json(data);
  } catch (err) {
    console.error('Erro em GET /customers/:id/profile:', err.message);
    res.status(500).json({ error: 'Erro ao buscar perfil do cliente' });
  }
});

module.exports = router;
