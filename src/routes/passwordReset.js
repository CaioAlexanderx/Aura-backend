// ============================================================
// AURA. -- Esqueci minha senha (S1)
// POST /auth/forgot-password  -- envia email com link de reset
// POST /auth/reset-password   -- valida token e troca a senha
// DELETE /auth/tokens/cleanup  -- limpa tokens expirados/usados
// ============================================================
const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const router  = express.Router();
const db      = require('../config/database');
const { sendPasswordResetEmail } = require('../services/mailer');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const RESET_TTL_MIN = 30;
const APP_URL = env.APP_URL || 'https://app.getaura.com.br';

// Helper: send email with timeout (never blocks the response)
async function trySendEmail(email, resetUrl, userName) {
  try {
    const emailPromise = sendPasswordResetEmail(email, resetUrl, userName);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Email send timeout (5s)')), 5000)
    );
    await Promise.race([emailPromise, timeout]);
    console.log(`[forgot-password] Email sent to ${email}`);
  } catch (err) {
    console.warn(`[forgot-password] Email failed for ${email}: ${err.message}`);
  }
}

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail e obrigatorio' });

  try {
    const { rows } = await db.query(
      'SELECT id, full_name FROM users WHERE email = $1 AND is_active = true',
      [email.trim().toLowerCase()]
    );

    if (rows.length > 0) {
      const user = rows[0];

      // Invalidate previous tokens
      await db.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000);

      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      // FIX: Expo Router route groups (auth) don't appear in URL
      // Correct: /reset-password?token=...  NOT /(auth)/reset-password
      const resetUrl = `${APP_URL}/reset-password?token=${token}`;
      trySendEmail(email, resetUrl, user.full_name);
    }

    res.json({
      message: 'Se o e-mail estiver cadastrado, voce recebera um link para redefinir sua senha.',
    });
  } catch (err) {
    console.error('[forgot-password]', err.message);
    res.status(500).json({ error: 'Erro ao processar solicitacao' });
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token) return res.status(400).json({ error: 'Token e obrigatorio' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter no minimo 8 caracteres' });
  }

  try {
    const { rows } = await db.query(
      `SELECT prt.id, prt.user_id, prt.expires_at, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token = $1 AND prt.used_at IS NULL`,
      [token]
    );

    if (!rows.length) {
      return res.status(400).json({ error: 'Token invalido ou ja utilizado' });
    }

    const resetToken = rows[0];

    if (new Date(resetToken.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token expirado. Solicite um novo link.' });
    }

    const hash = await bcrypt.hash(password, 12);
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, resetToken.user_id]
    );

    await db.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
      [resetToken.id]
    );

    res.json({ message: 'Senha alterada com sucesso. Faca login com a nova senha.' });
  } catch (err) {
    console.error('[reset-password]', err.message);
    res.status(500).json({ error: 'Erro ao redefinir senha' });
  }
});

// DELETE /auth/tokens/cleanup -- Remove expired/used tokens (admin utility)
router.delete('/tokens/cleanup', async (req, res) => {
  try {
    const r1 = await db.query(
      `DELETE FROM password_reset_tokens WHERE used_at IS NOT NULL OR expires_at < NOW()`
    );
    const r2 = await db.query(
      `DELETE FROM verification_codes WHERE verified_at IS NOT NULL OR expires_at < NOW()`
    );
    res.json({
      deleted: {
        password_reset_tokens: r1.rowCount || 0,
        verification_codes: r2.rowCount || 0,
      },
    });
  } catch (err) {
    console.error('[tokens/cleanup]', err.message);
    res.status(500).json({ error: 'Erro ao limpar tokens' });
  }
});

module.exports = router;
