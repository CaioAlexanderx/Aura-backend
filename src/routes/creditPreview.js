// ============================================================
// AURA. -- Credit Preview (F2-2B)
// GET  /credit/customers/:cid/preview   -- saldo+score+parcelas (PDV)
// POST /credit/quick-customer           -- cadastro-relampago + limite inline
//
// Montado em private.js:
//   router.use('/credit', requirePlan('negocio','expansao'), require('./creditPreview'));
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { getCustomerCreditPreview } = require('../services/creditLedger');

// GET /companies/:id/credit/customers/:cid/preview
// Preview 360 para PDV checkout: saldo, parcelas abertas, score, limite, over_limit
router.get('/customers/:cid/preview', async (req, res) => {
  try {
    const preview = await getCustomerCreditPreview(req.params.id, req.params.cid);
    res.json(preview);
  } catch (err) {
    console.error('[creditPreview] preview error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar preview do cliente' });
  }
});

// POST /companies/:id/credit/quick-customer
// Cadastro-relampago: cria cliente minimo (nome+telefone) + define credit_limit
// Retorna o preview para PDV continuar o checkout sem sair da tela
router.post('/quick-customer', async (req, res) => {
  const { name, phone, cpf_cnpj, credit_limit } = req.body || {};
  if (!name && !phone) {
    return res.status(400).json({ error: 'Nome ou telefone obrigatorio.' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let customer;
    try {
      const { rows } = await client.query(
        `INSERT INTO customers (company_id, name, phone, cpf_cnpj)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, name || null, phone || null, cpf_cnpj || null]
      );
      customer = rows[0];
    } catch (insertErr) {
      // Conflito de CPF/CNPJ unico -- busca o existente
      if (insertErr.code === '23505') {
        const { rows } = await client.query(
          `SELECT * FROM customers
           WHERE company_id = $1
             AND (phone = $2 OR (cpf_cnpj IS NOT NULL AND cpf_cnpj = $3))
           LIMIT 1`,
          [req.params.id, phone || '', cpf_cnpj || '']
        );
        customer = rows[0];
      } else throw insertErr;
    }

    if (!customer) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Erro ao criar cliente.' });
    }

    // Define credit_limit se fornecido
    if (credit_limit !== undefined && !isNaN(parseFloat(credit_limit))) {
      await client.query(
        `INSERT INTO customer_credit_profiles
           (company_id, customer_id, credit_limit, credit_score, status)
         VALUES ($1, $2, $3, 500, 'active')
         ON CONFLICT (company_id, customer_id) DO UPDATE
           SET credit_limit = $3, updated_at = NOW()`,
        [req.params.id, customer.id, parseFloat(credit_limit)]
      ).catch(e => { if (e.code !== '42P01' && e.code !== '42703') throw e; });
    }

    await client.query('COMMIT');
    const preview = await getCustomerCreditPreview(req.params.id, customer.id);
    res.status(201).json({ customer, preview });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[creditPreview] quick-customer error:', err.message);
    res.status(500).json({ error: 'Erro ao criar cliente.' });
  } finally {
    client.release();
  }
});

module.exports = router;
