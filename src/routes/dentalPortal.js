// ============================================================
// AURA. — ODT-08: Portal do Paciente (público, sem login)
// POST /dental/portal/generate/:patientId — gera token
// GET  /dental/portal/:token — dados do paciente
// POST /dental/portal/:token/confirm/:aid — confirma consulta
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');

// Generate portal token (authenticated — dentist generates for patient)
router.post('/portal/generate/:patientId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const cid = req.params.id;
  const pid = req.params.patientId;
  const daysValid = parseInt(req.query.days) || 30;
  try {
    const { rows: check } = await db.query(
      'SELECT id, full_name FROM dental_patients WHERE id=$1 AND company_id=$2', [pid, cid]);
    if (!check.length) return res.status(404).json({ error: 'Paciente nao encontrado' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + daysValid * 86400000);

    // Invalidate old tokens
    await db.query('DELETE FROM dental_portal_tokens WHERE patient_id=$1 AND company_id=$2', [pid, cid]);

    await db.query(
      `INSERT INTO dental_portal_tokens (company_id, patient_id, token, expires_at)
       VALUES ($1,$2,$3,$4)`, [cid, pid, token, expiresAt]);

    const baseUrl = process.env.APP_URL || 'https://app.getaura.com.br';
    res.json({
      token, expires_at: expiresAt,
      url: `${baseUrl}/dental/portal/${token}`,
      patient_name: check[0].full_name,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao gerar token' }); }
});

module.exports = router;
