// ============================================================
// AURA KARATÊ — Auth do Portal do Responsável do Dojô (Fase 0 / Canal B)
//
// Espelha karatePortalAuthService (praticante) mas escopado a dojo_id.
// O identificador do responsável é o e-mail do owner da company-dojô
// OU o telefone registrado na company.
//
// MODELO DE PRIVACIDADE (U2):
//   - requestOtp SEMPRE responde genérico; não revela se o contato existe.
//   - verifyOtp valida por (federationId, identifier, código).
//
// Token emitido: JWT { type:'portal', scope:'dojo_portal', dojo_id, federation_id }
// TTL: 30 min.
// ============================================================
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;
const OTP_SECRET = process.env.PORTAL_OTP_SECRET || JWT_SECRET;

const DOJO_TOKEN_TTL = '30m';

let mailer = null;
try { mailer = require('./mailer'); } catch (_) {}

const hashCode = (code) =>
  crypto.createHash('sha256').update(`${code}::${OTP_SECRET}`).digest('hex');

function maskEmail(email) {
  if (!email) return null;
  const [u, d] = String(email).split('@');
  if (!d) return null;
  return `${u.slice(0, 1)}***@${d.slice(0, 1)}***`;
}
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return null;
  return `***${d.slice(-4)}`;
}

/**
 * _findDojoByIdentifier — busca o dojô da federação pelo e-mail do owner
 * OU pelo telefone da company-dojô. Anti-enumeração: sempre O(1) em resultado.
 */
async function _findDojoByIdentifier(federationId, identifier) {
  if (!identifier) return null;
  const isEmail = identifier.includes('@');
  const digits = String(identifier).replace(/\D/g, '');

  const r = await db.query(
    `SELECT c.id AS dojo_id, c.federation_id, c.phone,
            u.email, u.full_name AS contact_name
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.federation_id = $1
        AND c.vertical = 'karate_dojo'
        AND c.is_active = true
        AND (
          ($2::boolean AND u.email IS NOT NULL AND LOWER(u.email) = LOWER($3))
          OR
          (NOT $2::boolean AND LENGTH($4) >= 8
            AND regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') = $4)
        )
      LIMIT 1`,
    [federationId, isEmail, identifier, digits]
  );
  return r.rows[0] || null;
}

/**
 * requestOtp — gera OTP e envia ao responsável do dojô.
 * Sempre retorna resposta genérica (U2 anti-enumeração).
 */
async function requestOtp({ federationId, identifier }) {
  const generic = {
    ok: true,
    message: 'Se houver um dojô cadastrado com este contato, enviaremos um código de acesso.',
  };

  const dojo = await _findDojoByIdentifier(federationId, identifier);
  if (!dojo) return generic;

  // Cooldown anti-spam: 1 envio / 60s por dojô
  const recent = await db.query(
    `SELECT created_at FROM karate_dojo_portal_otps
      WHERE dojo_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'
      ORDER BY created_at DESC LIMIT 1`,
    [dojo.dojo_id]
  );
  if (recent.rows.length) {
    return { ...generic, channel_hint: maskEmail(dojo.email) || maskPhone(dojo.phone) || null };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const channel = dojo.email ? 'email' : (dojo.phone ? 'whatsapp' : 'none');
  const destHint = dojo.email ? maskEmail(dojo.email) : maskPhone(dojo.phone);

  await db.query(
    `INSERT INTO karate_dojo_portal_otps
       (federation_id, dojo_id, channel, destination_hint, code_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '10 minutes', NOW())`,
    [federationId, dojo.dojo_id, channel, destHint, hashCode(code)]
  );

  try {
    if (channel === 'email' && mailer && mailer.sendVerificationEmail) {
      await mailer.sendVerificationEmail(dojo.email, code, dojo.contact_name || 'Responsável');
    } else {
      console.log(`[karateDojoPortalAuth] (dev) OTP ${channel} p/ dojô ${dojo.dojo_id}: ${code}`);
    }
  } catch (e) {
    console.error('[karateDojoPortalAuth] falha ao enviar OTP:', e.message);
  }

  return { ...generic, channel_hint: destHint || null };
}

/**
 * verifyOtp — valida (federationId, identifier, código).
 * Em sucesso, devolve token de portal dojô (scope:'dojo_portal') + dados básicos.
 */
async function verifyOtp({ federationId, identifier, code }) {
  const fail = { ok: false, error: 'Código inválido ou expirado' };
  const dojo = await _findDojoByIdentifier(federationId, identifier);
  if (!dojo) return fail;

  const r = await db.query(
    `SELECT id, code_hash, attempts, max_attempts, expires_at, consumed_at
       FROM karate_dojo_portal_otps
      WHERE dojo_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [dojo.dojo_id]
  );
  if (!r.rows.length) return fail;

  const otp = r.rows[0];
  if (otp.attempts >= otp.max_attempts) {
    await db.query(`UPDATE karate_dojo_portal_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id]);
    return { ok: false, error: 'Número de tentativas excedido. Solicite um novo código.' };
  }

  const provided = hashCode(String(code || '').trim());
  const match = provided.length === otp.code_hash.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(otp.code_hash));

  if (!match) {
    await db.query(`UPDATE karate_dojo_portal_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    return fail;
  }

  await db.query(`UPDATE karate_dojo_portal_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id]);

  const token = signDojoPortalToken({ dojoId: dojo.dojo_id, federationId });
  return {
    ok: true,
    token,
    expires_in: 1800,
    dojo: {
      id: dojo.dojo_id,
      federation_id: dojo.federation_id,
    },
  };
}

function signDojoPortalToken({ dojoId, federationId }) {
  return jwt.sign(
    {
      type: 'portal',
      scope: 'dojo_portal',
      dojo_id: dojoId,
      federation_id: federationId,
    },
    JWT_SECRET,
    { expiresIn: DOJO_TOKEN_TTL }
  );
}

function verifyDojoPortalToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.type !== 'portal' || decoded.scope !== 'dojo_portal') {
    throw new Error('Token de portal de dojô inválido');
  }
  return decoded;
}

module.exports = {
  requestOtp,
  verifyOtp,
  signDojoPortalToken,
  verifyDojoPortalToken,
  _findDojoByIdentifier, // exportado p/ testes
};
