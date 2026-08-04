// ============================================================
// AURA. -- Email & Phone Verification
// POST /auth/send-verification       (envia link + codigo por email)
// POST /auth/verify-email            (valida codigo OTP de 6 digitos)
// GET  /auth/confirm-email/:token    (PUBLICO - valida e redireciona)
// POST /auth/send-phone-verification (phone OTP - 4 digitos)
// POST /auth/verify-phone            (valida codigo)
//
// Task Sign Up (03/08/2026) — a espera da confirmacao era o ponto de
// erro mais constante do cadastro. Mudancas:
//  1. O envio agora e AGUARDADO (timeout 8s) e a falha e PROPAGADA:
//     resposta {sent:false, reason} em vez de fingir sucesso.
//  2. Envio falho nao consome cota: os registros inseridos sao
//     apagados no catch, e o rate limit de 5/10min passa a contar
//     apenas envios reais. 429 agora expoe retry_after em segundos.
//  3. Cada envio inclui tambem um CODIGO de 6 digitos (type
//     'email_otp') como caminho paralelo ao link — cobre scanner
//     corporativo, cliente de e-mail que reescreve URL e expiracao.
//     Requer migration 270 (CHECK de type); codigo defensivo abaixo
//     faz fallback para so-link enquanto ela nao estiver aplicada.
//  4. Idempotencia curta: um envio nos ultimos 60s e reaproveitado
//     (StrictMode/duplo-mount da tela de espera e o envio disparado
//     pelo proprio /register nao geram e-mails duplicados).
// ============================================================
const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { sendVerificationLinkEmail } = require('../services/mailer');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const API_URL = env.API_URL;
const APP_URL = env.APP_URL;
const VERIFY_TTL_MIN = 60;
const RESEND_WINDOW_MIN = 10;   // janela do rate limit de reenvio
const RESEND_MAX = 5;           // envios REAIS permitidos na janela
const DEDUPE_SECONDS = 60;      // envio recente e reaproveitado

// Armadilha 1 (CLAUDE.md): schema antes da migration — cache module-level.
// Enquanto a migration 270 (type 'email_otp' no CHECK) nao estiver aplicada,
// caimos no fluxo antigo (so link), sem quebrar nada.
let otpSupported = true;

function generateCode(length) {
  const digits = '0123456789';
  let code = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) code += digits[bytes[i] % 10];
  return code;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * Gera token de link (+ codigo OTP quando suportado), envia o e-mail e
 * SO mantem os registros se o envio funcionou.
 * Retorna { sent, deduped?, reason? }. Nunca lanca.
 * Exportada para o /auth/register disparar o 1o envio no proprio cadastro.
 */
async function issueVerification(userId, email, fullName) {
  try {
    // Idempotencia curta: reaproveita envio dos ultimos 60s.
    const { rows: fresh } = await db.query(
      `SELECT id FROM verification_codes
       WHERE user_id=$1 AND type='email' AND created_at > NOW() - INTERVAL '${DEDUPE_SECONDS} seconds'
       LIMIT 1`, [userId]
    );
    if (fresh.length) return { sent: true, deduped: true };

    const token = crypto.randomBytes(32).toString('hex');
    const otp = generateCode(6);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MIN * 60 * 1000);

    let insertedIds = [];
    let otpInEmail = null;
    if (otpSupported) {
      try {
        const { rows } = await db.query(
          `INSERT INTO verification_codes (user_id, type, code, destination, expires_at)
           VALUES ($1,'email',$2,$4,$5), ($1,'email_otp',$3,$4,$5) RETURNING id`,
          [userId, token, otp, email, expiresAt]
        );
        insertedIds = rows.map(r => r.id);
        otpInEmail = otp;
      } catch (e) {
        if (e.code === '23514') { // CHECK ainda sem 'email_otp' (migration 270 pendente)
          otpSupported = false;
        } else throw e;
      }
    }
    if (!insertedIds.length) {
      const { rows } = await db.query(
        `INSERT INTO verification_codes (user_id, type, code, destination, expires_at)
         VALUES ($1,'email',$2,$3,$4) RETURNING id`,
        [userId, token, email, expiresAt]
      );
      insertedIds = rows.map(r => r.id);
    }

    const confirmUrl = `${API_URL}/auth/confirm-email/${token}`;
    try {
      await withTimeout(sendVerificationLinkEmail(email, confirmUrl, fullName, otpInEmail), 8000);
      console.log(`[verify] Email sent to ${email}`);
      return { sent: true };
    } catch (err) {
      console.warn(`[verify] Email failed for ${email}: ${err.message}`);
      console.log(`[verify] MANUAL LINK: ${confirmUrl}`);
      // Envio falhou: apaga os registros para (a) nao consumir cota de
      // reenvio e (b) nao deixar token/codigo "fantasma" valido no banco.
      try {
        await db.query('DELETE FROM verification_codes WHERE id = ANY($1::uuid[])', [insertedIds]);
      } catch (delErr) {
        console.warn('[verify] cleanup failed:', delErr.message);
      }
      return { sent: false, reason: err.message === 'timeout' ? 'timeout' : 'provider_error' };
    }
  } catch (err) {
    console.error('[issueVerification] error:', err.message);
    return { sent: false, reason: 'internal' };
  }
}

// -- POST /auth/send-verification --
router.post('/send-verification', requireAuth, async (req, res) => {
  try {
    const { rows: users } = await db.query(
      'SELECT email, full_name, email_verified FROM users WHERE id = $1', [req.user.id]
    );
    if (!users.length) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const user = users[0];
    if (user.email_verified) return res.json({ already_verified: true });

    // Rate limit de envio: conta apenas envios REAIS (falhas sao apagadas
    // em issueVerification) e devolve retry_after honesto.
    const { rows: recent } = await db.query(
      `SELECT COUNT(*)::int AS cnt, MIN(created_at) AS oldest
       FROM verification_codes
       WHERE user_id=$1 AND type='email' AND created_at > NOW() - INTERVAL '${RESEND_WINDOW_MIN} minutes'`,
      [req.user.id]
    );
    if (recent[0].cnt >= RESEND_MAX) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(recent[0].oldest).getTime() + RESEND_WINDOW_MIN * 60 * 1000 - Date.now()) / 1000)
      );
      return res.status(429).json({
        error: 'Limite de envios atingido. Aguarde para reenviar.',
        retry_after: retryAfter,
      });
    }

    const destination = user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
    const result = await issueVerification(req.user.id, user.email, user.full_name);

    if (!result.sent) {
      // Verdade de estado: o frontend mostra o erro e oferece "tentar de novo".
      return res.json({ sent: false, reason: result.reason || 'send_failed', destination });
    }

    res.json({
      sent: true,
      deduped: !!result.deduped,
      destination,
      expires_in: VERIFY_TTL_MIN * 60,
      retry_after: DEDUPE_SECONDS,
      otp_available: otpSupported,
    });
  } catch (err) {
    console.error('[send-verification] error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao enviar email de verificacao' });
  }
});

// -- POST /auth/verify-email -- (codigo OTP de 6 digitos do e-mail)
router.post('/verify-email', requireAuth, async (req, res) => {
  const raw = String(req.body?.code ?? '').trim();
  if (!/^\d{6}$/.test(raw)) {
    return res.status(400).json({ valid: false, error: 'Codigo de 6 digitos obrigatorio' });
  }
  try {
    const { rows } = await db.query(
      `SELECT id, code, attempts, max_attempts, expires_at, verified_at
       FROM verification_codes
       WHERE user_id=$1 AND type='email_otp'
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(400).json({ valid: false, error: 'Nenhum codigo ativo. Reenvie o e-mail.' });
    }
    const vc = rows[0];
    if (vc.verified_at) return res.json({ valid: true, already_used: true });
    if (vc.attempts >= vc.max_attempts) {
      return res.status(400).json({ valid: false, error: 'Limite de tentativas. Reenvie o e-mail para gerar outro codigo.' });
    }
    if (new Date(vc.expires_at) < new Date()) {
      return res.status(400).json({ valid: false, error: 'Codigo expirado. Reenvie o e-mail.' });
    }
    if (vc.code !== raw) {
      await db.query('UPDATE verification_codes SET attempts=attempts+1 WHERE id=$1', [vc.id]);
      const left = vc.max_attempts - vc.attempts - 1;
      return res.status(400).json({
        valid: false,
        error: left > 0 ? 'Codigo incorreto. Confira o e-mail mais recente.' : 'Limite de tentativas. Reenvie o e-mail para gerar outro codigo.',
        attempts_left: Math.max(0, left),
      });
    }
    await db.query('UPDATE verification_codes SET verified_at=NOW() WHERE id=$1', [vc.id]);
    await db.query('UPDATE users SET email_verified=true WHERE id=$1', [req.user.id]);
    console.log(`[verify] Email confirmed via OTP for user ${req.user.id}`);
    res.json({ valid: true, email_verified: true });
  } catch (err) {
    console.error('[verify-email] error:', err.message);
    res.status(500).json({ error: 'Erro ao verificar codigo' });
  }
});

// -- GET /auth/confirm-email/:token -- (PUBLIC)
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

    await db.query('UPDATE verification_codes SET verified_at=NOW() WHERE id=$1', [vc.id]);
    await db.query('UPDATE users SET email_verified=true WHERE id=$1', [vc.user_id]);

    console.log(`[verify] Email confirmed for user ${vc.user_id} (${vc.full_name})`);
    res.redirect(`${APP_URL}/?email_verified=true`);
  } catch (err) {
    console.error('[confirm-email] error:', err.message);
    res.redirect(`${APP_URL}/?verify_error=server`);
  }
});

// -- Phone verification --
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
// Reuso pelo /auth/register (1o envio no proprio cadastro, best-effort).
module.exports.issueVerification = issueVerification;
