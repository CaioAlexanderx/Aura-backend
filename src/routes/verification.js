// ============================================================
// AURA. -- Email & Phone Verification
// POST /auth/send-verification       (envia link por email)
// GET  /auth/confirm-email/:token    (PUBLICO - valida e redireciona)
// POST /auth/send-phone-verification (phone OTP - 4 digitos)
// POST /auth/verify-phone            (valida codigo)
// ============================================================
const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { sendVerificationLinkEmail } = require('../services/mailer');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const API_URL = env.API_URL || 'https://aura-backend-production-f805.up.railway.app/api/v1';
const APP_URL = env.APP_URL || 'https://app.getaura.com.br';
const VERIFY_TTL_MIN = 60; // link valido por 1 hora

function generateCode(length) {
  const digits = '0123456789';
  let code = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) code += digits[bytes[i] % 10];
  return code;
}

// Fire-and-forget email send with timeout (same pattern as password reset)
async function trySendVerificationEmail(email, confirmUrl, userName) {
  try {
    const p = sendVerificationLinkEmail(email, confirmUrl, userName);
    const t = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
    await Promise.race([p, t]);
    console.log(`[verify] Email sent to ${email}`);
  } catch (err) {
    console.warn(`[verify] Email failed for ${email}: ${err.message}`);
    console.log(`[verify] MANUAL LINK: ${confirmUrl}`);
  }
}

// -- POST /auth/send-verification --
// Gera token UUID, salva no DB, envia email com link de confirmacao
router.post('/send-verification', requireAuth, async (req, res) => {
  try {
    const { rows: users } = await db.query(
      'SELECT email, full_name, email_verified FROM users WHERE id = $1', [req.user.id]
    );
    if (!users.length) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const user = users[0];
    if (user.email_verified) return res.json({ already_verified: true });

    // Rate limit
    const { rows: recent } = await db.query(
      `SELECT COUNT(*) as cnt FROM verification_codes WHERE user_id=$1 AND type='email' AND created_at > NOW() - INTERVAL '10 minutes'`, [req.user.id]
    );
    if (parseInt(recent[0].cnt) >= 5) return res.status(429).json({ error: 'Limite de envios. Aguarde 10 minutos.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MIN * 60 * 1000);

    await db.query(
      `INSERT INTO verification_codes (user_id, type, code, destination, expires_at) VALUES ($1,'email',$2,$3,$4)`,
      [req.user.id, token, user.email, expiresAt]
    );

    const confirmUrl = `${API_URL}/auth/confirm-email/${token}`;
    trySendVerificationEmail(user.email, confirmUrl, user.full_name);

    res.json({
      sent: true,
      destination: user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'),
      expires_in: VERIFY_TTL_MIN * 60,
    });
  } catch (err) {
    console.error('send-verification error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar email de verificacao' });
  }
});

// -- GET /auth/confirm-email/:token --
// PUBLICO: usuario clica no link do email, valida token, redireciona pro app
router.get('/confirm-email/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT vc.id, vc.user_id, vc.expires_at, vc.verified_at, u.full_name
       FROM verification_codes vc JOIN users u ON u.id = vc.user_id
       WHERE vc.code=$1 AND vc.type='email' ORDER BY vc.created_at DESC LIMIT 1`, [token]
    );

    if (!rows.length) {
      return res.redirect(`${APP_URL}/?verify_error=invalid`);
    }
    const vc = rows[0];
    if (vc.verified_at) {
      return res.redirect(`${APP_URL}/?email_verified=true`);
    }
    if (new Date(vc.expires_at) < new Date()) {
      return res.redirect(`${APP_URL}/?verify_error=expired`);
    }

    // Mark verified
    await db.query('UPDATE verification_codes SET verified_at=NOW() WHERE id=$1', [vc.id]);
    await db.query('UPDATE users SET email_verified=true WHERE id=$1', [vc.user_id]);

    console.log(`[verify] Email confirmed for user ${vc.user_id} (${vc.full_name})`);
    res.redirect(`${APP_URL}/?email_verified=true`);
  } catch (err) {
    console.error('confirm-email error:', err.message);
    res.redirect(`${APP_URL}/?verify_error=server`);
  }
});

// -- Phone verification (unchanged) --
router.post('/send-phone-verification', requireAuth, async (req, res) => {
  try {
    const { rows: users } = await db.query('SELECT phone, phone_verified FROM users WHERE id=$1', [req.user.id]);
    if (!users.length) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const user = users[0];
    if (!user.phone) return res.status(400).json({ error: 'Telefone nao cadastrado' });
    if (user.phone_verified) return res.json({ already_verified: true });
    const { rows: recent } = await db.query(
      `SELECT COUNT(*) as cnt FROM verification_codes WHERE user_id=$1 AND type='phone' AND created_at > NOW() - INTERVAL '10 minutes'`, [req.user.id]
    );
    if (parseInt(recent[0].cnt) >= 3) return res.status(429).json({ error: 'Limite de envios. Aguarde 10 minutos.' });
    const code = generateCode(4);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await db.query(`INSERT INTO verification_codes (user_id,type,code,destination,expires_at) VALUES ($1,'phone',$2,$3,$4)`, [req.user.id, code, user.phone, expiresAt]);
    console.log(`\n[PHONE VERIFY] ${user.phone} => Code: ${code}`);
    res.json({ sent: true, destination: user.phone.replace(/(\(\d{2}\) )(\d{3})(.*)/, '$1***$3'), expires_in: 300 });
  } catch (err) { console.error('send-phone-verification error:', err.message); res.status(500).json({ error: 'Erro ao enviar codigo' }); }
});

router.post('/verify-phone', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.length !== 4) return res.status(400).json({ error: 'Codigo de 4 digitos obrigatorio' });
  try {
    const { rows } = await db.query(
      `SELECT id, attempts, max_attempts, expires_at, verified_at FROM verification_codes WHERE user_id=$1 AND type='phone' AND code=$2 ORDER BY created_at DESC LIMIT 1`, [req.user.id, code.trim()]
    );
    if (!rows.length) return res.status(400).json({ valid: false, error: 'Codigo invalido' });
    const vc = rows[0];
    if (vc.verified_at) return res.json({ valid: true, already_used: true });
    if (vc.attempts >= vc.max_attempts) return res.status(400).json({ valid: false, error: 'Limite de tentativas.' });
    if (new Date(vc.expires_at) < new Date()) return res.status(400).json({ valid: false, error: 'Codigo expirado.' });
    await db.query('UPDATE verification_codes SET attempts=attempts+1 WHERE id=$1', [vc.id]);
    await db.query('UPDATE verification_codes SET verified_at=NOW() WHERE id=$1', [vc.id]);
    await db.query('UPDATE users SET phone_verified=true WHERE id=$1', [req.user.id]);
    res.json({ valid: true, phone_verified: true });
  } catch (err) { console.error('verify-phone error:', err.message); res.status(500).json({ error: 'Erro ao verificar codigo' }); }
});

module.exports = router;
