// ============================================================
// AURA. — SEC-07: Two-Factor Authentication (TOTP)
// Endpoints for setup, verify, disable 2FA
// Uses otpauth URI for Google Authenticator / Authy
// ============================================================

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');

// Generate a base32 secret (compatible with TOTP apps)
function generateSecret(length = 20) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % 32]).join('');
}

// Generate TOTP code for a given secret and time
function generateTOTP(secret, timeStep = 30, digits = 6) {
  const time = Math.floor(Date.now() / 1000 / timeStep);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(0, 0);
  buffer.writeUInt32BE(time, 4);

  // Decode base32 secret
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase()) {
    const val = base32Chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const keyBytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    keyBytes.push(parseInt(bits.substr(i, 8), 2));
  }
  const key = Buffer.from(keyBytes);

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % (10 ** digits);
  return String(code).padStart(digits, '0');
}

// Verify TOTP with +-1 window
function verifyTOTP(secret, token, window = 1) {
  const timeStep = 30;
  const now = Math.floor(Date.now() / 1000 / timeStep);
  for (let i = -window; i <= window; i++) {
    const time = now + i;
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(0, 0);
    buffer.writeUInt32BE(time, 4);

    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of secret.toUpperCase()) {
      const val = base32Chars.indexOf(c);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const keyBytes = [];
    for (let j = 0; j + 8 <= bits.length; j += 8) {
      keyBytes.push(parseInt(bits.substr(j, 8), 2));
    }
    const key = Buffer.from(keyBytes);

    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % (10 ** 6);
    if (String(code).padStart(6, '0') === token) return true;
  }
  return false;
}

// Generate backup codes
function generateBackupCodes(count = 8) {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
}

// POST /auth/2fa/setup — generate secret + QR URI
router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT email, totp_enabled FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario nao encontrado' });
    if (rows[0].totp_enabled) return res.status(400).json({ error: '2FA ja esta ativo' });

    const secret = generateSecret();
    const email = rows[0].email;
    const otpauthUri = `otpauth://totp/Aura:${encodeURIComponent(email)}?secret=${secret}&issuer=Aura&digits=6&period=30`;

    // Store secret (not yet verified)
    await db.query('UPDATE users SET totp_secret=$1 WHERE id=$2', [secret, req.user.id]);

    res.json({
      secret,
      otpauth_uri: otpauthUri,
      message: 'Escaneie o QR code no seu app autenticador (Google Authenticator, Authy) e envie o codigo para /auth/2fa/verify',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao configurar 2FA' });
  }
});

// POST /auth/2fa/verify — verify first code + activate 2FA
router.post('/2fa/verify', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token obrigatorio' });

  try {
    const { rows } = await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario nao encontrado' });
    if (rows[0].totp_enabled) return res.status(400).json({ error: '2FA ja esta ativo' });
    if (!rows[0].totp_secret) return res.status(400).json({ error: 'Execute /auth/2fa/setup primeiro' });

    const valid = verifyTOTP(rows[0].totp_secret, token);
    if (!valid) return res.status(400).json({ error: 'Codigo invalido. Tente novamente.' });

    const backupCodes = generateBackupCodes();
    await db.query(
      'UPDATE users SET totp_enabled=true, totp_verified_at=NOW(), backup_codes=$1 WHERE id=$2',
      [JSON.stringify(backupCodes), req.user.id]
    );

    logAuditAction(req.user.id, null, '2fa_enabled', '2FA TOTP ativado');

    res.json({
      enabled: true,
      backup_codes: backupCodes,
      message: 'IMPORTANTE: Guarde estes codigos de backup em local seguro. Eles nao serao mostrados novamente.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar 2FA' });
  }
});

// POST /auth/2fa/validate — validate code on login
router.post('/2fa/validate', async (req, res) => {
  const { user_id, token } = req.body;
  if (!user_id || !token) return res.status(400).json({ error: 'user_id e token obrigatorios' });

  try {
    const { rows } = await db.query('SELECT totp_secret, totp_enabled, backup_codes FROM users WHERE id=$1', [user_id]);
    if (!rows.length || !rows[0].totp_enabled) return res.status(400).json({ error: '2FA nao configurado' });

    // Try TOTP first
    if (verifyTOTP(rows[0].totp_secret, token)) {
      return res.json({ valid: true });
    }

    // Try backup code
    const codes = rows[0].backup_codes || [];
    const idx = codes.indexOf(token.toUpperCase());
    if (idx >= 0) {
      codes.splice(idx, 1);
      await db.query('UPDATE users SET backup_codes=$1 WHERE id=$2', [JSON.stringify(codes), user_id]);
      logAuditAction(user_id, null, '2fa_backup_used', `Backup code used. ${codes.length} remaining.`);
      return res.json({ valid: true, backup_used: true, remaining_codes: codes.length });
    }

    res.status(400).json({ valid: false, error: 'Codigo invalido' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao validar 2FA' });
  }
});

// DELETE /auth/2fa — disable 2FA
router.delete('/2fa', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token obrigatorio para desativar' });

  try {
    const { rows } = await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length || !rows[0].totp_enabled) return res.status(400).json({ error: '2FA nao esta ativo' });

    if (!verifyTOTP(rows[0].totp_secret, token)) {
      return res.status(400).json({ error: 'Codigo invalido' });
    }

    await db.query(
      'UPDATE users SET totp_enabled=false, totp_secret=NULL, backup_codes=NULL WHERE id=$1',
      [req.user.id]
    );
    logAuditAction(req.user.id, null, '2fa_disabled', '2FA TOTP desativado');
    res.json({ disabled: true, message: '2FA desativado com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desativar 2FA' });
  }
});

module.exports = router;
