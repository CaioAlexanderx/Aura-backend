// ============================================================
// AURA KARATÊ — Auth do Portal do Praticante (Track D / Fase 3)
//
// MODELO DE PRIVACIDADE (recomendação §0.4 U1, aprovada):
//   - Portal completo (trajetória) é AUTENTICADO por padrão, via OTP
//     (e-mail e/ou WhatsApp). O praticante NÃO é company_member — usa
//     um token de portal próprio (JWT type:'portal'), curto (30 min).
//   - Versão pública compartilhável do portal exige OPT-IN explícito e
//     traz dados reduzidos; MENORES nunca são públicos.
//   - U2 (anti-enumeração): request-otp SEMPRE responde genérico; nunca
//     confirma se o CPF existe. verify-otp valida por (federação, cpf, código).
// ============================================================
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;
const OTP_SECRET = process.env.PORTAL_OTP_SECRET || JWT_SECRET;

const OTP_TTL_MS = 10 * 60 * 1000;     // 10 min
const RESEND_COOLDOWN_MS = 60 * 1000;  // 1 envio/min
const PORTAL_TOKEN_TTL = '30m';

let mailer = null;
try { mailer = require('./mailer'); } catch (_) {}
let whatsapp = null;
try { whatsapp = require('./whatsapp'); } catch (_) {}

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const hashCode = (code) =>
  crypto.createHash('sha256').update(`${code}::${OTP_SECRET}`).digest('hex');

function maskEmail(email) {
  if (!email) return null;
  const [u, d] = String(email).split('@');
  if (!d) return null;
  return `${u.slice(0, 1)}***@${d.slice(0, 1)}***`;
}
function maskPhone(phone) {
  const d = onlyDigits(phone);
  if (d.length < 4) return null;
  return `***${d.slice(-4)}`;
}

async function _findPractitionerByCpf(federationId, cpf) {
  const cpfDigits = onlyDigits(cpf);
  if (cpfDigits.length < 11) return null;
  const r = await db.query(
    `SELECT id, name, email, phone, dojo_id, karate_registration_number
     FROM customers
     WHERE federation_id = $1
       AND regexp_replace(COALESCE(cpf_cnpj,''), '[^0-9]', '', 'g') = $2
     LIMIT 1`,
    [federationId, cpfDigits]
  );
  return r.rows[0] || null;
}

/**
 * requestOtp — gera e envia OTP. SEMPRE retorna resposta genérica (U2).
 * Não revela se o CPF existe. channel preferido: e-mail; fallback WhatsApp.
 */
async function requestOtp({ federationId, cpf }) {
  const generic = {
    ok: true,
    message: 'Se houver um cadastro com este CPF, enviaremos um código de acesso.',
  };

  const p = await _findPractitionerByCpf(federationId, cpf);
  if (!p) return generic; // não cria OTP, não vaza existência

  // Cooldown anti-spam
  const recent = await db.query(
    `SELECT created_at FROM karate_portal_otps
     WHERE student_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'
     ORDER BY created_at DESC LIMIT 1`,
    [p.id]
  );
  if (recent.rows.length) {
    return { ...generic, channel_hint: maskEmail(p.email) || maskPhone(p.phone) || null };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const channel = p.email ? 'email' : (p.phone ? 'whatsapp' : 'none');
  const destHint = p.email ? maskEmail(p.email) : maskPhone(p.phone);

  await db.query(
    `INSERT INTO karate_portal_otps
       (federation_id, student_id, channel, destination_hint, code_hash, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '10 minutes', NOW())`,
    [federationId, p.id, channel, destHint, hashCode(code)]
  );

  // Entrega best-effort — falha de entrega não vaza nem quebra o fluxo
  try {
    if (channel === 'email' && mailer && mailer.sendVerificationEmail) {
      await mailer.sendVerificationEmail(p.email, code, p.name);
    } else if (channel === 'whatsapp') {
      // WhatsApp exige WABA por federação (phoneNumberId+token). Hook deixado
      // para a Track F (automação). Em dev, logamos para teste.
      console.log(`[karatePortalAuth] (dev) OTP WhatsApp p/ ${destHint}: ${code}`);
    } else {
      console.log(`[karatePortalAuth] (dev) OTP sem canal p/ student ${p.id}: ${code}`);
    }
  } catch (e) {
    console.error('[karatePortalAuth] falha ao enviar OTP:', e.message);
  }

  return { ...generic, channel_hint: destHint || null };
}

/**
 * verifyOtp — valida (federação, cpf, código). Em sucesso, devolve token de
 * portal (JWT type:'portal') + dados básicos do praticante.
 */
async function verifyOtp({ federationId, cpf, code }) {
  const fail = { ok: false, error: 'Código inválido ou expirado' };
  const p = await _findPractitionerByCpf(federationId, cpf);
  if (!p) return fail;

  const r = await db.query(
    `SELECT id, code_hash, attempts, max_attempts, expires_at, consumed_at
     FROM karate_portal_otps
     WHERE student_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [p.id]
  );
  if (!r.rows.length) return fail;

  const otp = r.rows[0];
  if (otp.attempts >= otp.max_attempts) {
    await db.query(`UPDATE karate_portal_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id]);
    return { ok: false, error: 'Número de tentativas excedido. Solicite um novo código.' };
  }

  const provided = hashCode(String(code || '').trim());
  const match = provided.length === otp.code_hash.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(otp.code_hash));

  if (!match) {
    await db.query(`UPDATE karate_portal_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    return fail;
  }

  await db.query(`UPDATE karate_portal_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id]);

  const token = signPortalToken({ practitionerId: p.id, federationId });
  return {
    ok: true,
    token,
    expires_in: 1800,
    practitioner: {
      id: p.id,
      name: p.name,
      karate_registration_number: p.karate_registration_number || null,
    },
  };
}

function signPortalToken({ practitionerId, federationId }) {
  return jwt.sign(
    { type: 'portal', scope: 'practitioner_portal', practitioner_id: practitionerId, federation_id: federationId },
    JWT_SECRET,
    { expiresIn: PORTAL_TOKEN_TTL }
  );
}

function verifyPortalToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.type !== 'portal' || decoded.scope !== 'practitioner_portal') {
    throw new Error('Token de portal inválido');
  }
  return decoded;
}

module.exports = {
  requestOtp,
  verifyOtp,
  signPortalToken,
  verifyPortalToken,
  _findPractitionerByCpf, // exportado p/ testes
  onlyDigits,
};
