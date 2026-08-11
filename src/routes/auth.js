// ============================================================
// AURA. — Autenticacao
//
// PR35 (2026-04-28): /auth/login, /register e /me agora expoem
// ai_enabled e ai_consent_at no company. useAiAccess do frontend
// usa pra gating do painel IA (Modo Consulta + brief auto). Sem
// esses campos, IA nunca liberava mesmo com UPDATE no banco.
//
// MULTICNPJ Sessao 1 (2026-05-02): politica consolidated-default.
// Quando user tem 2+ empresas ativas, login/me/refresh emitem JWT
// com `company=null, consolidated_view=true`. Frontend renderiza
// painel consolidado por padrao. Telas que precisam de scope
// especifico (PDV/NF-e/Folha) usam <RequireCompanyScope /> que
// abre picker e dispara switchCompany() pra trocar o JWT.
//
// FIX 2026-05-03: resolveDefaultContext e companyCount agora usam
// query PERMISSIVE (`WHERE c.owner_id = $1 OR cm.user_id = $1`) em
// vez de JOIN strict em company_members. Caso edge: empresa criada
// via Multi-CNPJ podia nao ter entry em company_members, fazendo o
// resolveDefaultContext nao ver e o user cair em modo single-company
// com a primary em vez de consolidated. Agora robusto a essa falha
// estrutural (que tambem foi corrigida em userCompanies.js POST).
//
// feat/terms-acceptance (2026-05-14): /auth/register agora exige
// terms_accepted=true no body e persiste terms_accepted_at + terms_version
// na tabela users (migration 114). Qualquer cadastro sem aceite recebe 400.
//
// Track G (2026-06-09): acesso real karate. resolveKarateContext deriva
// federation_id (federacao=company.id; dojo=company.federation_id) e
// karate_role (owner->federation_admin/dojo_owner; demais role_label crus)
// a partir da company primaria. Exposto no JWT (login/refresh/register) e
// no objeto company de /login, /me e /register. Sem migration: a coluna
// companies.federation_id ja existe. requireCompanyAccess inalterado.
//
// FIX 2026-06-15: /me e /login agora expoem extra_seats_granted no objeto
// company (via getExtraSeatsForCompany, defensivo a 42703 -> 0). Era a
// metade que faltou do fix de 13/05: o gate de Equipe (configuracoes.tsx)
// usa company.extra_seats_granted como fallback pra liberar a gestao de
// acessos no Essencial quando ha acesso extra pago. Sem o campo, o
// fallback ficava sempre 0 e o cliente via "A partir do plano Negocio"
// apesar do acesso pago (caso Encanto). Nao toca os SELECTs criticos.
//
// Fase 0 Dojô (2026-06-17): dojo_id propagado no JWT (login/refresh/register)
// e no objeto company de /login, /me e /register. resolveKarateContext
// agora retorna { federation_id, karate_role, dojo_id }. Usado por
// requireDojoAccess (Canal A) para escopar endpoints /dojo/*.
//
// ── F11 Sign Up de dojo (2026-08-11) ────────────────────────
// /auth/register passa a aceitar { vertical:'karate_dojo', federation_id }.
// Antes disso era IMPOSSIVEL um dojo entrar sozinho: o INSERT INTO companies
// nao gravava vertical/vertical_active/federation_id, e o unico caminho era
// PATCH /admin/clients/:cid/karate (adminOnly). Sem os dois campos, o JWT
// nascia sem dojo_id/federation_id e requireDojoAccess devolvia 403
// NOT_DOJO_TOKEN — o sensei nao conseguia nem PEDIR conexao a federacao
// (POST /federation/:id/dojo/connection), que e o passo seguinte da F6.
//
// TRES REGRAS QUE ESTE ARQUIVO NAO PODE VIOLAR:
//  1. karate_dojo_linked_at continua NULO. Criar a conta NAO e estar
//     filiado — a filiacao vem do ACEITE da federacao (F6,
//     karateAffiliationRequestsAdmin.js). Escolher a federacao aqui e
//     DECLARACAO DE INTENCAO: define o roteamento tecnico (federation_id),
//     nao o vinculo. Se este INSERT algum dia setar linked_at, o dojo
//     aparece como filiado sem a federacao ter aprovado nada.
//  2. fpkt_affiliation_id nunca e gerado. O numero FPKT e SEMPRE digitado
//     pela federacao no aceite — "o backend NUNCA gera numero".
//  3. O caminho de varejo e bit-a-bit o mesmo. Sem `vertical` no body,
//     nenhuma query nova roda e vertical/vertical_active/federation_id vao
//     NULL no INSERT (exatamente o que o DEFAULT ja fazia).
//
// E-mail/CNPJ podem coincidir com um dos registros federativos existentes:
// NAO tentamos casar, vincular nem reivindicar nada. Se o CNPJ ja tem
// company, o cadastro de dojo para em 409 (em vez de "entrar" na empresa
// alheia como o fluxo de varejo faz) — a ligacao com o registro da
// federacao acontece depois, no aceite.
// ============================================================
const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');
const { sendSelfServeSignupNotification } = require('../services/mailer');
const { issueVerification } = require('./verification');
const { resolveKarateContext } = require('../config/karateRoles');
const { getExtraSeatsForCompany } = require('../services/extraSeats');

const env        = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;
const ACCESS_TTL  = '1h';
const REFRESH_TTL = '7d';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IS_PROD = env.NODE_ENV === 'production';

// MULTICNPJ: ranking de planos pra calcular plan efetivo no modo consolidado.
const PLAN_RANK = { essencial: 1, negocio: 2, expansao: 3, personalizado: 4 };

// F11: verticais que o proprio cliente pode declarar no cadastro. Lista
// FECHADA de propósito — a regra de onboarding.js ("vertical NUNCA e ativada
// automaticamente ... so a equipe Aura ativa via Gestao Aura") continua
// valendo para todas as outras. A excecao existe porque o dojo precisa do
// par vertical + federation_id ja no primeiro token para conseguir pedir
// filiacao; nenhuma outra vertical tem essa dependencia.
const SELF_SERVE_VERTICALS = new Set(['karate_dojo']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}
function signRefreshToken(payload) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...payload, type: 'refresh', jti }, JWT_SECRET, { expiresIn: REFRESH_TTL });
  return { token, jti };
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function setRefreshCookie(res, refreshToken) {
  res.cookie('aura_refresh', refreshToken, { httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? 'strict' : 'lax', maxAge: REFRESH_TTL_MS, path: '/api/v1/auth' });
}
function clearRefreshCookie(res) { res.clearCookie('aura_refresh', { path: '/api/v1/auth' }); }
async function storeRefreshToken(userId, refreshToken, req) {
  try { await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)', [userId, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), req.ip, (req.headers['user-agent'] || '').substring(0, 200)]); } catch (_) {}
}

// 15/06/2026: anexa extra_seats_granted ao objeto company ja moldado.
// Helper defensivo (captura 42703 pre-migration -> 0). Nunca lanca.
async function withExtraSeats(shaped, companyId) {
  if (!shaped || !companyId) return shaped;
  let extra = 0;
  try { extra = await getExtraSeatsForCompany(companyId); } catch (_) { extra = 0; }
  return { ...shaped, extra_seats_granted: extra };
}

async function resolveDefaultContext(userId, dbConn) {
  const conn = dbConn || db;
  const { rows } = await conn.query(
    `SELECT DISTINCT ON (c.id)
            c.id, c.legal_name, c.plan, c.onboarding_step,
            c.trial_ends_at, c.module_overrides, c.billing_status,
            c.access_code_used, c.vertical_active, c.vertical, c.ai_enabled, c.ai_consent_at,
            c.federation_id,
            c.is_primary, c.created_at,
            CASE
              WHEN c.owner_id = $1 THEN 'owner'
              ELSE COALESCE(cm.role_label, 'member')
            END AS member_role
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, c.is_primary DESC NULLS LAST, c.created_at ASC`,
    [userId]
  );

  rows.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  if (rows.length === 0) {
    return { count: 0, primary: null, consolidated: false, effectivePlan: 'essencial' };
  }
  if (rows.length === 1) {
    return {
      count: 1,
      primary: rows[0],
      consolidated: false,
      effectivePlan: rows[0].plan || 'essencial',
    };
  }

  const maxPlan = rows.reduce((acc, c) => {
    const r = PLAN_RANK[c.plan] || 1;
    return r > acc.rank ? { plan: c.plan, rank: r } : acc;
  }, { plan: 'essencial', rank: 1 });

  return {
    count: rows.length,
    primary: rows[0],
    consolidated: true,
    effectivePlan: maxPlan.plan,
  };
}

function shapeCompany(company, fallbackMemberRole) {
  if (!company) return null;
  const member_role = company.member_role || fallbackMemberRole || 'owner';
  // Track G (acesso real): federation_id + karate_role derivados da company.
  // null fora de karate; federacao->id proprio, dojo->federation_id (pai).
  const karate = resolveKarateContext({ ...company, member_role });
  return {
    id: company.id,
    name: company.legal_name || company.name || company.trade_name,
    plan: company.plan,
    onboarding_step: company.onboarding_step,
    module_overrides: company.module_overrides || {},
    trial_active: !!(company.trial_ends_at && new Date(company.trial_ends_at) > new Date()),
    trial_ends_at: company.trial_ends_at,
    billing_status: company.billing_status || null,
    access_code_used: !!(company.access_code_used),
    vertical_active: company.vertical_active || null,
    vertical: company.vertical || null,
    ai_enabled: !!(company.ai_enabled),
    ai_consent_at: company.ai_consent_at || null,
    member_role,
    federation_id: karate.federation_id,
    karate_role: karate.karate_role,
    dojo_id: karate.dojo_id,
  };
}

// POST /api/v1/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, company_name, phone, cnpj, access_code, terms_accepted, terms_version, self_serve, vertical, federation_id } = req.body;
  const isSelfServe = (self_serve === true || self_serve === 'true');

  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatorios: name, email, password' });
  // Aceite dos Termos obrigatorio — registrado para fins de auditoria juridica (migration 114)
  if (!terms_accepted) return res.status(400).json({ error: 'O aceite dos Termos de Uso e obrigatorio para criar uma conta' });
  if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail invalido' });

  // ── F11: ramo declarado no cadastro (opcional) ─────────────
  // Sem `vertical` no body nada abaixo roda e o fluxo segue identico ao
  // que sempre foi (varejo). Todas as validacoes de dojo sao feitas ANTES
  // de abrir a transacao — nao ha por que hashear senha e inserir usuario
  // para descobrir que a federacao nao foi escolhida.
  const requestedVertical = (typeof vertical === 'string' && vertical.trim()) ? vertical.trim() : null;
  if (requestedVertical && !SELF_SERVE_VERTICALS.has(requestedVertical)) {
    return res.status(400).json({
      error: 'Ramo de atividade indisponivel para autocadastro. Fale com a equipe Aura.',
      code: 'VERTICAL_NOT_SELF_SERVE',
    });
  }
  const isDojoSignup = requestedVertical === 'karate_dojo';
  const dojoFederationId = (typeof federation_id === 'string') ? federation_id.trim() : '';
  if (isDojoSignup && !company_name) {
    return res.status(400).json({
      error: 'Informe o nome do dojo para criar a conta',
      code: 'DOJO_COMPANY_REQUIRED',
    });
  }
  if (isDojoSignup && !UUID_RE.test(dojoFederationId)) {
    return res.status(400).json({
      error: 'Escolha a federacao do seu dojo',
      code: 'FEDERATION_REQUIRED',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.length > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'E-mail ja cadastrado' }); }

    // F11: a federacao escolhida precisa existir e estar ativa. `vertical` e
    // o campo CANONICO de identidade (ver src/config/karateRoles.js). Nao
    // olhamos nada alem disso — nao ha "reivindicacao" de registro aqui.
    if (isDojoSignup) {
      const { rows: feds } = await client.query(
        `SELECT id FROM companies
          WHERE id = $1 AND vertical = 'karate_federation' AND is_active = true`,
        [dojoFederationId]
      );
      if (!feds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Federacao invalida ou indisponivel',
          code: 'FEDERATION_NOT_FOUND',
        });
      }
    }

    let plan = 'essencial', trialDays = 0, discountPct = 0, codeType = null, codeId = null, referrerId = null;
    if (access_code) {
      const { rows: codes } = await client.query('SELECT id, type, plan, discount_pct, trial_days, max_uses, uses, expires_at, is_active, referrer_id FROM access_codes WHERE code = $1', [access_code.toUpperCase().trim()]);
      if (!codes.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo de acesso invalido' }); }
      const ac = codes[0];
      if (!ac.is_active) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo desativado' }); }
      if (ac.uses >= ac.max_uses) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo esgotado' }); }
      if (ac.expires_at && new Date(ac.expires_at) < new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo expirado' }); }
      plan = ac.plan || 'essencial'; trialDays = ac.trial_days || 0; discountPct = ac.discount_pct || 0; codeType = ac.type; codeId = ac.id; referrerId = ac.referrer_id;
      await client.query('UPDATE access_codes SET uses = uses + 1, updated_at = NOW() WHERE id = $1', [ac.id]);
    }

    // Cadastro self-service (site /comecar e app /cadastro): sem codigo de acesso,
    // trial padrao Negocio 7 dias. Cadastros internos (sem a flag) seguem essencial.
    if (!access_code && isSelfServe) {
      plan = 'negocio'; trialDays = 7; codeType = 'self_serve';
    }

    const isStaff = email.toLowerCase().trim().endsWith('@getaura.com.br');
    const password_hash = await bcrypt.hash(password, 12);

    // Persiste aceite dos Termos: terms_accepted_at = momento exato do cadastro, terms_version = versao aceita.
    // Coluna adicionada pela migration 114. terms_version padrao 'v1' caso frontend antigo nao envie.
    const acceptedVersion = (typeof terms_version === 'string' && terms_version.trim()) ? terms_version.trim() : 'v1';
    const { rows: [user] } = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role, is_staff, phone, terms_accepted_at, terms_version)
       VALUES ($1, $2, $3, 'client', $4, $5, NOW(), $6)
       RETURNING id, full_name AS name, email, role, is_staff, email_verified, created_at`,
      [name.trim(), email.toLowerCase().trim(), password_hash, isStaff, phone || null, acceptedVersion]
    );

    let company = null;
    let isNewCompany = false;
    let memberRole = 'owner';
    let skipCompany = !company_name;

    if (!skipCompany && cnpj) {
      const cleanCnpj = cnpj.replace(/\D/g, '');
      if (cleanCnpj.length === 14 || cleanCnpj.length === 11) {
        const { rows: existingCompanies } = await client.query(
          'SELECT id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, module_overrides, billing_status, access_code_used, vertical_active, vertical, ai_enabled, ai_consent_at, federation_id FROM companies WHERE cnpj = $1',
          [cleanCnpj]
        );
        if (existingCompanies.length > 0) {
          company = existingCompanies[0];
          isNewCompany = false;
          memberRole = 'vendedor';
          plan = company.plan;
          console.log('[auth] User ' + email + ' joining existing company ' + company.id + ' via CNPJ ' + cleanCnpj);
        }
      }
    }

    // F11: cadastro de dojo NUNCA entra numa empresa que ja existe. O fluxo
    // de varejo "entra como vendedor" (acima) e aceitavel para uma loja com
    // dois socios; para um dojo seria pior que inutil — a conta nasceria sem
    // ser dona de nada e, se o CNPJ bater com um registro que a federacao ja
    // cadastrou, viraria uma reivindicacao silenciosa de dado alheio.
    if (isDojoSignup && company) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Ja existe uma conta Aura com este CNPJ. Entre com ela ou peca acesso ao responsavel.',
        code: 'CNPJ_ALREADY_REGISTERED',
      });
    }

    if (!skipCompany && !company) {
      isNewCompany = true;
      const trialEndsAt = trialDays > 0 ? new Date(Date.now() + trialDays * 86400000).toISOString() : null;
      // F11: `vertical` e `vertical_active` recebem o MESMO valor ($10) —
      // identidade permanente + modulo ativo — e `federation_id` ($11) e a
      // federacao escolhida. No varejo os tres vao NULL, que e exatamente o
      // que o INSERT sem essas colunas ja gravava.
      //
      // ⚠️ karate_dojo_linked_at e fpkt_affiliation_id NAO aparecem aqui e
      // nao podem aparecer: o vinculo (linked_at) e do ACEITE da federacao e
      // o numero FPKT e sempre digitado por ela. Ver o cabecalho do arquivo.
      const newVertical = isDojoSignup ? 'karate_dojo' : null;
      const newFederationId = isDojoSignup ? dojoFederationId : null;
      const { rows: [newCompany] } = await client.query(
        `INSERT INTO companies (owner_id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, access_code_used, cnpj, phone, vertical, vertical_active, federation_id)
         VALUES ($1, $2, $2, $3, 'cnpj', $4, $5, $6, $7, $8, $8, $9)
         RETURNING id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, module_overrides, access_code_used, vertical_active, vertical, ai_enabled, ai_consent_at, federation_id`,
        [user.id, company_name.trim(), plan, trialEndsAt, access_code || null, cnpj ? cnpj.replace(/\D/g, '') : null, phone || null, newVertical, newFederationId]
      );
      company = newCompany;
    }

    if (company) {
      await client.query(
        'INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, $3, \'active\', true)',
        [company.id, user.id, memberRole]
      );
    }

    if (codeType === 'referral' && referrerId) {
      await client.query('INSERT INTO referrals (referrer_id, referred_user_id, referred_email, code, status, completed_at) VALUES ($1, $2, $3, $4, \'completed\', NOW())', [referrerId, user.id, email.toLowerCase().trim(), access_code.toUpperCase().trim()]);
    }
    await client.query('COMMIT');

    // E-mail de follow-up pra CS quando uma conta self-service e criada (best-effort, nao bloqueia).
    if (isNewCompany && trialDays > 0 && (isSelfServe || codeType === 'trial')) {
      sendSelfServeSignupNotification({
        name: user.name,
        companyName: company.trade_name || company.legal_name,
        email: user.email,
        phone: phone || null,
        cnpj: cnpj || null,
        plan: company.plan,
        trialDays,
        trialEndsAt: company.trial_ends_at,
      }).catch((e) => console.error('[register] self-serve notify email falhou:', e.message));
    }

    // Task Sign Up 03/08: dispara o e-mail de verificacao JA no cadastro
    // (best-effort — nao bloqueia a resposta). A tela de espera do app
    // reaproveita este envio pela janela de idempotencia de 60s do
    // issueVerification, entao nao ha e-mail duplicado.
    if (!user.email_verified && !isStaff) {
      issueVerification(user.id, user.email, user.name)
        .catch((e) => console.error('[register] verification email falhou:', e.message));
    }

    // Track G: contexto karate da company recem-resolvida (member_role local).
    // F11: para o dojo, isso ja devolve dojo_id = company.id e federation_id =
    // a federacao escolhida — que e exatamente o par que requireDojoAccess
    // exige no Canal A. E o que destrava POST /federation/:id/dojo/connection
    // logo depois do cadastro (antes: 403 NOT_DOJO_TOKEN).
    const karateCtx = resolveKarateContext(company ? { ...company, member_role: memberRole } : null);
    const tokenPayload = {
      id: user.id,
      role: user.role,
      plan: company ? company.plan : 'essencial',
      company: company ? company.id : null,
      is_staff: user.is_staff,
      consolidated_view: false,
      federation_id: karateCtx.federation_id,
      karate_role: karateCtx.karate_role,
      dojo_id: karateCtx.dojo_id,
    };
    const accessToken = signAccessToken(tokenPayload);
    const { token: refreshToken } = signRefreshToken({ id: user.id });
    await storeRefreshToken(user.id, refreshToken, req);
    setRefreshCookie(res, refreshToken);
    logAuditAction(user.id, company ? company.id : null, 'register', 'New account: ' + email.toLowerCase().trim() + (skipCompany ? ' (invite flow, no company)' : !isNewCompany ? ' (joined existing company)' : '') + (isDojoSignup ? ' [dojo self-signup, federation=' + dojoFederationId + ', NOT linked]' : '') + ' | terms_version=' + acceptedVersion);

    res.status(201).json({
      token: accessToken, refresh_token: refreshToken, token_expires_in: '1h',
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff, email_verified: user.email_verified || false },
      company: company ? {
        ...company,
        module_overrides: company.module_overrides || {},
        trial_active: !!(company.trial_ends_at),
        trial_ends_at: company.trial_ends_at,
        billing_status: company.billing_status || null,
        access_code_used: !!(company.access_code_used),
        vertical_active: company.vertical_active || null,
        ai_enabled: !!(company.ai_enabled),
        ai_consent_at: company.ai_consent_at || null,
        member_role: memberRole,
        // Empresa recem-criada/associada: 0 acessos extras (consistencia de shape).
        extra_seats_granted: 0,
        federation_id: karateCtx.federation_id,
        karate_role: karateCtx.karate_role,
        dojo_id: karateCtx.dojo_id,
        // F11: explicito no contrato pra o front nunca inferir filiacao a
        // partir de federation_id. Conta criada != dojo filiado.
        karate_dojo_linked_at: null,
      } : null,
      consolidated_view: false,
      company_count: company ? 1 : 0,
      code_applied: access_code ? { type: codeType, plan: plan, discount_pct: discountPct, trial_days: trialDays } : null,
      joined_existing: company ? !isNewCompany : false,
      no_company: skipCompany,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    // Corrida SELECT-then-INSERT (duplo submit / retry de rede): a unique
    // constraint de users.email vira 409 honesto em vez de 500 generico.
    if (err.code === '23505' && /users.*email|email.*users/i.test(err.constraint || err.detail || '')) {
      return res.status(409).json({ error: 'E-mail ja cadastrado' });
    }
    console.error('register error:', err);
    res.status(500).json({ error: 'Erro ao criar conta' });
  }
  finally { client.release(); }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email e password sao obrigatorios' });

  try {
    const { rows } = await db.query(
      'SELECT id, full_name AS name, email, password_hash, role, is_active, is_staff, totp_enabled, email_verified FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Credenciais invalidas' });
    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Conta desativada. Entre em contato com o suporte.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) { logAuditAction(null, null, 'login_failed', 'Failed login for ' + email.toLowerCase().trim(), { ip: req.ip }); return res.status(401).json({ error: 'Credenciais invalidas' }); }
    if (user.totp_enabled) return res.json({ requires_2fa: true, user_id: user.id, message: 'Autenticacao de dois fatores necessaria.' });

    const ctx = await resolveDefaultContext(user.id);
    // Track G: contexto karate da primary (null em modo consolidado, alinhado com company=null).
    const karateCtx = ctx.consolidated ? { federation_id: null, karate_role: null, dojo_id: null } : resolveKarateContext(ctx.primary);

    const tokenPayload = {
      id: user.id,
      role: user.role,
      plan: ctx.effectivePlan,
      company: ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null),
      is_staff: user.is_staff || false,
      consolidated_view: ctx.consolidated,
      federation_id: karateCtx.federation_id,
      karate_role: karateCtx.karate_role,
      dojo_id: karateCtx.dojo_id,
    };
    const accessToken = signAccessToken(tokenPayload);
    const { token: refreshToken } = signRefreshToken({ id: user.id });
    await storeRefreshToken(user.id, refreshToken, req);
    setRefreshCookie(res, refreshToken);
    logAuditAction(user.id, ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null), 'login', 'Login: ' + user.email + (ctx.consolidated ? ' [consolidated]' : ''));

    // 15/06/2026: anexa extra_seats_granted ao company (fallback do gate de Equipe).
    const companyOut = ctx.consolidated
      ? null
      : await withExtraSeats(shapeCompany(ctx.primary, ctx.primary?.member_role), ctx.primary ? ctx.primary.id : null);

    res.json({
      token: accessToken, refresh_token: refreshToken, token_expires_in: '1h',
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff || false, email_verified: user.email_verified || false },
      company: companyOut,
      consolidated_view: ctx.consolidated,
      company_count: ctx.count,
    });
  } catch (err) { console.error('login error:', err); res.status(500).json({ error: 'Erro ao autenticar' }); }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res) => {
  const refreshTokenInput = req.body.refresh_token || req.cookies?.aura_refresh;
  if (!refreshTokenInput) return res.status(400).json({ error: 'refresh_token e obrigatorio' });
  try {
    const decoded = jwt.verify(refreshTokenInput, JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(400).json({ error: 'Token nao e refresh' });
    const tokenHash = hashToken(refreshTokenInput);
    try {
      const { rows } = await db.query('SELECT id, revoked FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2', [tokenHash, decoded.id]);
      if (rows.length > 0 && rows[0].revoked) { clearRefreshCookie(res); return res.status(401).json({ error: 'Refresh token revogado', code: 'REFRESH_REVOKED' }); }
    } catch (_) {}

    const { rows: uRows } = await db.query('SELECT id, role, is_staff FROM users WHERE id = $1 AND is_active = true', [decoded.id]);
    if (!uRows.length) return res.status(401).json({ error: 'Usuario desativado' });
    const user = uRows[0];

    const ctx = await resolveDefaultContext(user.id);
    // Track G: re-resolve contexto karate a cada refresh (TTL 1h mantem fresco).
    const karateCtx = ctx.consolidated ? { federation_id: null, karate_role: null, dojo_id: null } : resolveKarateContext(ctx.primary);

    const newAccessToken = signAccessToken({
      id: user.id,
      role: user.role,
      plan: ctx.effectivePlan,
      company: ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null),
      is_staff: user.is_staff || false,
      consolidated_view: ctx.consolidated,
      federation_id: karateCtx.federation_id,
      karate_role: karateCtx.karate_role,
      dojo_id: karateCtx.dojo_id,
    });
    res.json({
      token: newAccessToken,
      token_expires_in: '1h',
      consolidated_view: ctx.consolidated,
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') { clearRefreshCookie(res); return res.status(401).json({ error: 'Refresh token expirado', code: 'REFRESH_EXPIRED' }); }
    return res.status(401).json({ error: 'Refresh token invalido' });
  }
});

// POST /api/v1/auth/logout
router.post('/logout', async (req, res) => {
  const refreshTokenInput = req.body.refresh_token || req.cookies?.aura_refresh;
  if (!refreshTokenInput) return res.json({ message: 'Logout realizado' });
  try { const decoded = jwt.verify(refreshTokenInput, JWT_SECRET, { ignoreExpiration: true }); const tokenHash = hashToken(refreshTokenInput); try { await db.query('UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1 AND user_id = $2', [tokenHash, decoded.id]); } catch (_) {} logAuditAction(decoded.id, null, 'logout', 'User logged out'); } catch (_) {}
  clearRefreshCookie(res);
  res.json({ message: 'Logout realizado com sucesso' });
});

// POST /api/v1/auth/me
router.post('/me', requireAuth, async (req, res) => {
  try {
    const { rows: uRows } = await db.query(
      'SELECT id, full_name AS name, email, role, is_staff, totp_enabled, email_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!uRows.length) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const u = uRows[0];

    const jwtConsolidated = !!req.user.consolidated_view;
    const jwtCompanyId = req.user.company || null;

    let company = null;
    let memberRole = 'owner';
    if (!jwtConsolidated && jwtCompanyId) {
      const { rows: cRows } = await db.query(
        `SELECT c.id, c.legal_name, c.plan, c.onboarding_step,
                c.trial_ends_at, c.module_overrides, c.billing_status,
                c.access_code_used, c.vertical_active, c.vertical, c.ai_enabled, c.ai_consent_at,
                c.federation_id,
                CASE
                  WHEN c.owner_id = $1 THEN 'owner'
                  ELSE COALESCE(cm.role_label, 'member')
                END AS member_role
           FROM companies c
           LEFT JOIN company_members cm
             ON cm.company_id = c.id
            AND cm.user_id = $1
            AND cm.status = 'active'
            AND cm.is_active = true
          WHERE c.id = $2 AND c.is_active = true
            AND (c.owner_id = $1 OR cm.user_id = $1)`,
        [u.id, jwtCompanyId]
      );
      if (cRows.length) {
        company = cRows[0];
        memberRole = cRows[0].member_role || 'owner';
      }
    }

    const { rows: countRows } = await db.query(
      `SELECT COUNT(DISTINCT c.id)::int AS cnt
         FROM companies c
         LEFT JOIN company_members cm
           ON cm.company_id = c.id
          AND cm.user_id = $1
          AND cm.status = 'active'
          AND cm.is_active = true
        WHERE (c.owner_id = $1 OR cm.user_id = $1)
          AND c.is_active = true`,
      [u.id]
    );
    const companyCount = countRows[0]?.cnt || 0;

    // 15/06/2026: anexa extra_seats_granted ao company (fallback do gate de Equipe).
    const companyOut = company
      ? await withExtraSeats(shapeCompany(company, memberRole), company.id)
      : null;

    res.json({
      user: { id: u.id, name: u.name, email: u.email, role: u.role, is_staff: u.is_staff || false, totp_enabled: u.totp_enabled || false, email_verified: u.email_verified || false },
      company: companyOut,
      consolidated_view: jwtConsolidated,
      company_count: companyCount,
    });
  } catch (err) { console.error('me error:', err); res.status(500).json({ error: 'Erro ao buscar perfil' }); }
});

// SEC-07: 2FA sub-routes
router.use('/', require('./twoFactor'));

module.exports = router;
