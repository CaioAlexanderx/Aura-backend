// ============================================================
// AURA KARATÊ — Rotas da Tabela de Anuidades (Track B)
//
// GET /financial/fees   — tabela vigente (por porte + CPF)
// PUT /financial/fees   — cria nova vigência (append-only, nunca sobrescreve)
//
// Tabela karate_annual_fees (migration 154):
//   id, federation_id, fee_type (dojo|cpf), size_tier, amount, effective_from
// Vigente = registro com effective_from <= hoje, o mais recente por (fee_type, size_tier).
//
// Guard: adminOnly() — apenas federation_admin pode ajustar a tabela de preços.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

// GET /financial/fees
router.get('/fees', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;

  try {
    // Vigente = por (fee_type, size_tier), o registro com effective_from mais recente <= hoje
    const { rows } = await db.query(
      `SELECT DISTINCT ON (fee_type, size_tier)
         id, fee_type, size_tier, amount, effective_from
       FROM karate_annual_fees
       WHERE federation_id = $1
         AND effective_from <= CURRENT_DATE
       ORDER BY fee_type, size_tier, effective_from DESC`,
      [federationId]
    );

    res.json(rows.map(r => ({
      id: r.id,
      fee_type: r.fee_type,
      size_tier: r.size_tier,
      amount: parseFloat(r.amount),
      effective_from: r.effective_from,
    })));
  } catch (err) {
    console.error('[karateFees] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar tabela de anuidades' });
  }
});

// PUT /financial/fees
// Body: { effective_from: '2027-01-01', fees: [{ fee_type, size_tier, amount }] }
// Append-only: insere nova vigência. Não deleta nem atualiza registros anteriores.
router.put('/fees', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { effective_from, fees } = req.body;

  if (!effective_from || !/^\d{4}-\d{2}-\d{2}$/.test(effective_from)) {
    return res.status(422).json({ error: 'effective_from obrigatorio (formato YYYY-MM-DD)', code: 'VALIDATION_ERROR' });
  }
  if (!Array.isArray(fees) || fees.length === 0) {
    return res.status(422).json({ error: 'fees deve ser array não vazio', code: 'VALIDATION_ERROR' });
  }

  const VALID_FEE_TYPES = ['dojo', 'cpf'];
  const VALID_SIZE_TIERS = ['up_to_40', '41_90', '91_150', 'over_150', null];

  for (const fee of fees) {
    if (!VALID_FEE_TYPES.includes(fee.fee_type)) {
      return res.status(422).json({
        error: `fee_type invalido: ${fee.fee_type}. Use: dojo, cpf`,
        code: 'VALIDATION_ERROR',
      });
    }
    if (fee.fee_type === 'dojo' && !VALID_SIZE_TIERS.includes(fee.size_tier || null)) {
      return res.status(422).json({
        error: `size_tier invalido para fee_type=dojo: ${fee.size_tier}`,
        code: 'VALIDATION_ERROR',
      });
    }
    if (isNaN(Number(fee.amount)) || Number(fee.amount) <= 0) {
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica federação
    const fedRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    const inserted = [];
    for (const fee of fees) {
      const { rows } = await client.query(
        `INSERT INTO karate_annual_fees
           (federation_id, fee_type, size_tier, amount, effective_from, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, fee_type, size_tier, amount, effective_from`,
        [federationId, fee.fee_type, fee.size_tier || null, Number(fee.amount), effective_from]
      );
      inserted.push({
        id: rows[0].id,
        fee_type: rows[0].fee_type,
        size_tier: rows[0].size_tier,
        amount: parseFloat(rows[0].amount),
        effective_from: rows[0].effective_from,
      });
    }

    await client.query('COMMIT');

    res.json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateFees] put error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar tabela de anuidades', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
