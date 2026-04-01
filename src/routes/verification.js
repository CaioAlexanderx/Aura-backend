// ============================================================
// AURA. — BE-VERIFY-01: Email & Phone Verification
//
// POST /auth/send-verification       (email OTP - 6 dígitos)
// POST /auth/verify-email             (valida código)
// POST /auth/send-phone-verification  (phone OTP - 4 dígitos)
// POST /auth/verify-phone             (valida código)
// ============================================================
const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { sendVerificationEmail } = require('../services/mailer');

function generateCode(length) {
  const digits = '0123456789';
  let code = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += digits[bytes[i] % 10];
  }
  return code;
}

// ── POST /auth/send-verification ─────────────────────────────
// Envia código de 6 dígitos por email (contato@getaura.com.br)
router.post('/send-verification', requireAuth, async (req, res) => {
  try {
    const { rows: users } = await db.query(
      'SELECT email, name, email_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!users.length) return res.status(404).json({ error: 'Usu\u00e1rio n\u00e3o encontrado' });

    const user = users[0];
    if (user.email_verified) {
      return res.json({ already_verified: true, message: 'E-mail j\u00e1 verificado' });
    }

    // Rate limit: max 3 codes in 10 min
    const { rows: recent } = await db.query(
      `SELECT COUNT(*) as cnt FROM verification_codes
       WHERE user_id = $1 AND type = 'email' AND created_at > NOW() - INTERVAL '10 minutes'`,
      [req.user.id]
    );
    if (parseInt(recent[0].cnt) >= 3) {
      return res.status(429).json({ error: 'Limite de envios atingido. Aguarde 10 minutos.' });
    }

    const code = generateCode(6);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await db.query(
      `INSERT INTO verification_codes (user_id, type, code, destination, expires_at)
       VALUES ($1, 'email', $2, $3, $4)`,
      [req.user.id, code, user.email, expiresAt]
    );

    await sendVerificationEmail(user.email, code, user.name);

    res.json({
      sent: true,
      destination: user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // ma***@email.com
      expires_in: 600,
    });
  } catch (err) {
    console.error('send-verification error:', err);
    res.status(500).json({ error: 'Erro ao enviar c\u00f3digo de verifica\u00e7\u00e3o' });
  }
});

// ── POST /auth/verify-email ──────────────────────────────────
router.post('/verify-email', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.length !== 6) {
    return res.status(400).json({ error: 'C\u00f3digo de 6 d\u00edgitos obrigat\u00f3rio' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, attempts, max_attempts, expires_at, verified_at
       FROM verification_codes
       WHERE user_id = $1 AND type = 'email' AND code = $2
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, code.trim()]
    );

    if (!rows.length) {
      return res.status(400).json({ valid: false, error: 'C\u00f3digo inv\u00e1lido' });
    }

    const vc = rows[0];

    if (vc.verified_at) {
      return res.json({ valid: true, already_used: true });
    }
    if (vc.attempts >= vc.max_attempts) {
      return res.status(400).json({ valid: false, error: 'Limite de tentativas atingido. Solicite novo c\u00f3digo.' });
    }
    if (new Date(vc.expires_at) < new Date()) {
      return res.status(400).json({ valid: false, error: 'C\u00f3digo expirado. Solicite novo c\u00f3digo.' });
    }

    // Increment attempts
    await db.query(
      'UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1',
      [vc.id]
    );

    // Mark as verified
    await db.query(
      'UPDATE verification_codes SET verified_at = NOW() WHERE id = $1',
      [vc.id]
    );
    await db.query(
      'UPDATE users SET email_verified = true WHERE id = $1',
      [req.user.id]
    );

    res.json({ valid: true, email_verified: true });
  } catch (err) {
    console.error('verify-email error:', err);
    res.status(500).json({ error: 'Erro ao verificar c\u00f3digo' });
  }
});

// ── POST /auth/send-phone-verification ───────────────────────
// Código de 4 dígitos via WhatsApp (futuro) ou SMS
router.post('/send-phone-verification', requireAuth, async (req, res) => {
  try {
    const { rows: users } = await db.query(
      'SELECT phone, phone_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!users.length) return res.status(404).json({ error: 'Usu\u00e1rio n\u00e3o encontrado' });

    const user = users[0];
    if (!user.phone) {
      return res.status(400).json({ error: 'Telefone n\u00e3o cadastrado' });
    }
    if (user.phone_verified) {
      return res.json({ already_verified: true, message: 'Telefone j\u00e1 verificado' });
    }

    // Rate limit: max 3 codes in 10 min
    const { rows: recent } = await db.query(
      `SELECT COUNT(*) as cnt FROM verification_codes
       WHERE user_id = $1 AND type = 'phone' AND created_at > NOW() - INTERVAL '10 minutes'`,
      [req.user.id]
    );
    if (parseInt(recent[0].cnt) >= 3) {
      return res.status(429).json({ error: 'Limite de envios atingido. Aguarde 10 minutos.' });
    }

    const code = generateCode(4);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    await db.query(
      `INSERT INTO verification_codes (user_id, type, code, destination, expires_at)
       VALUES ($1, 'phone', $2, $3, $4)`,
      [req.user.id, code, user.phone, expiresAt]
    );

    // TODO: integrar WhatsApp Business API ou Twilio SMS
    // Por enquanto, log no console (dev mode)
    console.log(`\n\ud83d\udcf1 [PHONE VERIFY] ${user.phone} => Code: ${code}`);

    res.json({
      sent: true,
      destination: user.phone.replace(/(\(\d{2}\) )(\d{3})(.*)/, '$1***$3'), // (12) ***9-0000
      expires_in: 300,
      channel: 'sms', // será 'whatsapp' quando integrado
    });
  } catch (err) {
    console.error('send-phone-verification error:', err);
    res.status(500).json({ error: 'Erro ao enviar c\u00f3digo' });
  }
});

// ── POST /auth/verify-phone ──────────────────────────────────
router.post('/verify-phone', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.length !== 4) {
    return res.status(400).json({ error: 'C\u00f3digo de 4 d\u00edgitos obrigat\u00f3rio' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, attempts, max_attempts, expires_at, verified_at
       FROM verification_codes
       WHERE user_id = $1 AND type = 'phone' AND code = $2
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, code.trim()]
    );

    if (!rows.length) {
      return res.status(400).json({ valid: false, error: 'C\u00f3digo inv\u00e1lido' });
    }

    const vc = rows[0];
    if (vc.verified_at) return res.json({ valid: true, already_used: true });
    if (vc.attempts >= vc.max_attempts) {
      return res.status(400).json({ valid: false, error: 'Limite de tentativas. Solicite novo c\u00f3digo.' });
    }
    if (new Date(vc.expires_at) < new Date()) {
      return res.status(400).json({ valid: false, error: 'C\u00f3digo expirado.' });
    }

    await db.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [vc.id]);
    await db.query('UPDATE verification_codes SET verified_at = NOW() WHERE id = $1', [vc.id]);
    await db.query('UPDATE users SET phone_verified = true WHERE id = $1', [req.user.id]);

    res.json({ valid: true, phone_verified: true });
  } catch (err) {
    console.error('verify-phone error:', err);
    res.status(500).json({ error: 'Erro ao verificar c\u00f3digo' });
  }
});

module.exports = router;
