// ============================================================
// AURA. -- Email & Phone Verification
// POST /auth/send-verification       (envia link + codigo por email)
// POST /auth/verify-email            (valida codigo OTP de 6 digitos)
// GET  /auth/confirm-email/:token    (PUBLICO - valida e redireciona)
// POST /auth/send-phone-verification (phone OTP - 4 digitos)
// POST /auth/verify-phone            (valida codigo)
// POST /auth/corrigir-email         (troca o e-mail de quem ainda nao confirmou)
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
const relacionamento = require('../services/relacionamento');
const { contextoDaRequisicao } = require('../middleware/auditLog');
const { porUsuario: limitePorUsuario } = require('../middleware/limiteCorrigirEmail');

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

// tq-80 (24/10/2026): boas-vindas (4.1) só quando o e-mail acabou de ser
// confirmado (o UPDATE devolveu a linha: era false e virou true). Sem
// await: o e-mail nunca atrasa nem derruba a confirmação. Quem recebe
// (dono, fora conta interna/sandbox/Karatê, uma vez por usuário) decide
// services/relacionamento.aoConfirmarEmail.
function aoConfirmar(resultado, userId) {
  if (!resultado || !Array.isArray(resultado.rows) || !resultado.rows.length) return;
  Promise.resolve()
    .then(() => relacionamento.aoConfirmarEmail(userId))
    .catch((err) => console.error('[verify] boas-vindas falhou (seguindo): ' + (err && err.message)));
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
    const confirmou = await db.query(
      'UPDATE users SET email_verified=true WHERE id=$1 AND email_verified IS NOT TRUE RETURNING id', [req.user.id]
    );
    console.log(`[verify] Email confirmed via OTP for user ${req.user.id}`);
    aoConfirmar(confirmou, req.user.id);
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
    const confirmou = await db.query(
      'UPDATE users SET email_verified=true WHERE id=$1 AND email_verified IS NOT TRUE RETURNING id', [vc.user_id]
    );

    console.log(`[verify] Email confirmed for user ${vc.user_id} (${vc.full_name})`);
    aoConfirmar(confirmou, vc.user_id);
    res.redirect(`${APP_URL}/?email_verified=true`);
  } catch (err) {
    console.error('[confirm-email] error:', err.message);
    res.redirect(`${APP_URL}/?verify_error=server`);
  }
});

// -- POST /auth/corrigir-email -- (26/10/2026)
// Quem criou a conta com o e-mail errado (erro de digitacao) nao tinha como
// corrigir: o botao da tela de confirmacao so saia da conta, e recadastrar
// com o e-mail certo nao resolve (com CNPJ a conta nova entra como vendedor
// da empresa que ja existe; com CPF da 409 CPF_ALREADY_REGISTERED).
// Esta rota troca o e-mail SO de quem ainda nao confirmou.
//
// Numa transacao: users.email; companies.email das empresas de que a pessoa
// e dona e que tinham o e-mail antigo; apaga os links e codigos pendentes
// do e-mail antigo (link velho cai em verify_error=invalid, codigo velho
// some); grava no audit_log o antigo e o novo. Depois do COMMIT, o envio
// novo sai pelo mesmo caminho do reenvio (issueVerification) — e-mail nao
// volta atras com ROLLBACK, entao fica fora da transacao. Se o envio
// falhar, a troca vale e a resposta diz sent:false: o app oferece o
// reenvio de sempre (POST /auth/send-verification).
//
// O JWT nao carrega e-mail (so id, role, plan, company...): nao ha token
// novo. A resposta devolve o usuario atualizado e o app troca o e-mail
// mostrado; o /auth/me ja le do banco.
//
// Limite: 5 por hora por IP (src/app.js, antes do apiRouter) e 5 por hora
// por usuario (limitePorUsuario abaixo, antes do handler).
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
// Conta interna (@getaura.com.br) ganha is_staff no cadastro e nao passa
// pela confirmacao; nao se chega nela trocando o e-mail de conta comum.
const DOMINIO_INTERNO = '@getaura.com.br';

function normalizarEmail(bruto) {
  if (typeof bruto !== 'string') return null;
  const email = bruto.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return null;
  const tld = email.slice(email.lastIndexOf('.') + 1);
  if (tld.length < 2) return null;
  return email;
}

router.post('/corrigir-email', requireAuth, limitePorUsuario, async (req, res) => {
  const novo = normalizarEmail(req.body && req.body.email);
  if (!novo) {
    return res.status(400).json({ error: 'Esse e-mail não parece completo. Confira e tente de novo.', code: 'EMAIL_INVALIDO' });
  }
  if (novo.endsWith(DOMINIO_INTERNO)) {
    return res.status(400).json({ error: 'Esse e-mail não pode ser usado aqui. Fale com a gente.', code: 'EMAIL_DOMINIO_RESERVADO' });
  }

  const userId = req.user.id;
  const client = await db.connect();
  let usuario;
  let antigo;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, full_name, email, email_verified, role, is_staff FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }
    usuario = rows[0];
    antigo = usuario.email;
    if (usuario.email_verified) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Seu e-mail já está confirmado. Para trocar, fale com a gente.',
        code: 'EMAIL_JA_CONFIRMADO',
      });
    }
    if (String(antigo || '').toLowerCase() === novo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esse já é o e-mail da sua conta.', code: 'EMAIL_IGUAL' });
    }
    // Sem dizer de quem e: so que o e-mail ja tem conta.
    const { rows: emUso } = await client.query(
      'SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2 LIMIT 1',
      [novo, userId]
    );
    if (emUso.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esse e-mail já tem uma conta na Aura.', code: 'EMAIL_EM_USO' });
    }

    await client.query('UPDATE users SET email = $2, updated_at = NOW() WHERE id = $1', [userId, novo]);
    const { rows: empresas } = await client.query(
      `UPDATE companies SET email = $2
        WHERE owner_id = $1 AND lower(email) = lower($3)
        RETURNING id`,
      [userId, novo, antigo]
    );
    const { rowCount: codigosApagados } = await client.query(
      `DELETE FROM verification_codes
        WHERE user_id = $1 AND type IN ('email', 'email_otp') AND verified_at IS NULL`,
      [userId]
    );
    const ctx = contextoDaRequisicao(req);
    await client.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        empresas.length ? empresas[0].id : null,
        'corrigir_email',
        ('E-mail corrigido antes da confirmacao: ' + antigo + ' -> ' + novo).substring(0, 500),
        JSON.stringify({
          email_antigo: antigo,
          email_novo: novo,
          empresas: empresas.map((e) => e.id),
          codigos_invalidados: codigosApagados || 0,
        }),
        ctx.ip,
        ctx.userAgent,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    // Corrida com outro cadastro no mesmo e-mail: a UNIQUE de users.email.
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Esse e-mail já tem uma conta na Aura.', code: 'EMAIL_EM_USO' });
    }
    console.error('[corrigir-email] error:', err && err.message);
    return res.status(500).json({ error: 'Não deu para trocar o e-mail agora. Tente de novo em instantes.' });
  } finally {
    client.release();
  }

  console.log(`[corrigir-email] user ${userId}: e-mail trocado antes da confirmacao`);
  const envio = await issueVerification(userId, novo, usuario.full_name);
  res.json({
    ok: true,
    user: {
      id: usuario.id,
      name: usuario.full_name,
      email: novo,
      role: usuario.role,
      is_staff: usuario.is_staff || false,
      email_verified: false,
    },
    sent: !!envio.sent,
    reason: envio.sent ? undefined : (envio.reason || 'send_failed'),
    expires_in: envio.sent ? VERIFY_TTL_MIN * 60 : undefined,
    retry_after: DEDUPE_SECONDS,
    otp_available: otpSupported,
  });
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
