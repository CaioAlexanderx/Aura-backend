// ============================================================
// AURA. — ODT-08: Portal do Paciente (geracao do token)
// D-UNIFY: le de customers (is_patient=true). Token armazena customer_id.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');

// :patientId na URL = customer_id
router.post('/portal/generate/:patientId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const cid = req.params.id;
  const customerId = req.params.patientId;
  const daysValid = parseInt(req.query.days) || 30;
  try {
    const { rows: check } = await db.query(
      `SELECT id, name FROM customers
       WHERE id=$1 AND company_id=$2 AND is_patient=true`,
      [customerId, cid]
    );
    if (!check.length) return res.status(404).json({ error: 'Paciente nao encontrado' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + daysValid * 86400000);

    // Invalidate old tokens do mesmo paciente
    await db.query(
      `DELETE FROM dental_portal_tokens
       WHERE customer_id=$1 AND company_id=$2`,
      [customerId, cid]
    );

    await db.query(
      `INSERT INTO dental_portal_tokens (company_id, customer_id, token, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [cid, customerId, token, expiresAt]
    );

    const baseUrl = process.env.APP_URL || 'https://app.getaura.com.br';
    res.json({
      token,
      expires_at: expiresAt,
      url: `${baseUrl}/dental/portal/${token}`,
      patient_name: check[0].name,
    });
  } catch (err) {
    console.error('[dentalPortal generate]', err.message);
    res.status(500).json({ error: 'Erro ao gerar token' });
  }
});

module.exports = router;
