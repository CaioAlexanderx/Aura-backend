// ============================================================
// AURA. — Esqueci minha senha (S1)
// POST /auth/forgot-password  — envia email com link de reset
// POST /auth/reset-password   — valida token e troca a senha
// ============================================================
const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const router  = express.Router();
const db      = require('../config/database');
const { sendPasswordResetEmail } = require('../services/mailer');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const RESET_TTL_MIN = 30; // token valido por 30 minutos
const APP_URL = env.APP_URL || 'https://app.getaura.com.br';

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail e obrigatorio' });

  try {
    // Busca usuario (nao revela se existe ou nao)
    const { rows } = await db.query(
      'SELECT id, full_name FROM users WHERE email = $1 AND is_active = true',
      [email.trim().toLowerCase()]
    );

    if (rows.length > 0) {
      const user = rows[0];

      // Invalidar tokens anteriores nao usados
      await db.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      // Gerar token seguro
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000);

      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      // Enviar email
      const resetUrl = `${APP_URL}/(auth)/reset-password?token=${token}`;
      await sendPasswordResetEmail(email, resetUrl, user.full_name);
    }

    // Sempre retorna sucesso (previne enumeracao de emails)
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
    // Buscar token valido
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

    // Verificar expiracao
    if (new Date(resetToken.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token expirado. Solicite um novo link.' });
    }

    // Atualizar senha
    const hash = await bcrypt.hash(password, 12);
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, resetToken.user_id]
    );

    // Marcar token como usado
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

module.exports = router;
