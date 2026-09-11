// ============================================================
// AURA. — Admin Access Codes (Central de Comando)
// CRUD de codigos de acesso (trial, promo, manual).
// Permite a equipe Aura criar codigos personalizados pra clientes
// direto do painel, sem precisar acessar o Supabase.
// ============================================================

const express = require('express');
const router  = express.Router();

const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

// ── Validacao ─────────────────────────────────────────────────
const CODE_REGEX = /^[A-Z0-9-]{3,20}$/;
const VALID_TYPES = ['trial', 'promo', 'manual'];
const VALID_PLANS = ['essencial', 'negocio', 'expansao', 'personalizado'];

// 11/09/2026 (migration 326): desconto em reais, por varios meses, e trava
// de plano. Regras de combinacao (as mesmas que checkoutCoupon reconfere):
//   - percentual OU reais, nunca os dois
//   - varios meses exige um desconto e nao combina com dias gratis
function validateCreate(body) {
  const {
    code, type, plan,
    trial_days = 0, discount_pct = 0, max_uses = 1,
    expires_at = null,
    discount_value = 0, discount_months = 1, restrict_to_plan = false,
  } = body || {};

  if (!code || typeof code !== 'string') {
    throw new AppError('Codigo eh obrigatorio', 400);
  }
  const normalized = code.trim().toUpperCase();
  if (!CODE_REGEX.test(normalized)) {
    throw new AppError('Codigo invalido. Use 3-20 caracteres: A-Z, 0-9 ou hifen.', 400);
  }
  if (!VALID_TYPES.includes(type)) {
    throw new AppError('Tipo invalido. Use: ' + VALID_TYPES.join(', '), 400);
  }
  if (!VALID_PLANS.includes(plan)) {
    throw new AppError('Plano invalido. Use: ' + VALID_PLANS.join(', '), 400);
  }

  const trialDaysNum = parseInt(trial_days, 10);
  if (Number.isNaN(trialDaysNum) || trialDaysNum < 0 || trialDaysNum > 365) {
    throw new AppError('trial_days deve ser inteiro entre 0 e 365', 400);
  }

  const discountNum = parseInt(discount_pct, 10);
  if (Number.isNaN(discountNum) || discountNum < 0 || discountNum > 100) {
    throw new AppError('discount_pct deve ser inteiro entre 0 e 100', 400);
  }

  const maxUsesNum = parseInt(max_uses, 10);
  if (Number.isNaN(maxUsesNum) || maxUsesNum < 1 || maxUsesNum > 99999) {
    throw new AppError('max_uses deve ser inteiro entre 1 e 99999', 400);
  }

  const discountValueNum = Number(discount_value);
  if (!Number.isFinite(discountValueNum) || discountValueNum < 0 || discountValueNum > 10000) {
    throw new AppError('discount_value deve ser um valor em reais entre 0 e 10000', 400);
  }
  const discountValueRounded = Math.round(discountValueNum * 100) / 100;

  const monthsNum = parseInt(discount_months, 10);
  if (Number.isNaN(monthsNum) || monthsNum < 1 || monthsNum > 24) {
    throw new AppError('discount_months deve ser inteiro entre 1 e 24', 400);
  }

  if (typeof restrict_to_plan !== 'boolean') {
    throw new AppError('restrict_to_plan deve ser true ou false', 400);
  }

  if (discountNum > 0 && discountValueRounded > 0) {
    throw new AppError('Use desconto em percentual OU em reais, nao os dois', 400);
  }
  if (monthsNum > 1 && discountNum === 0 && discountValueRounded === 0) {
    throw new AppError('Desconto por varios meses precisa de discount_pct ou discount_value', 400);
  }
  if (monthsNum > 1 && trialDaysNum > 0) {
    throw new AppError('Desconto por varios meses nao combina com dias gratis', 400);
  }

  let expiresAtDate = null;
  if (expires_at) {
    expiresAtDate = new Date(expires_at);
    if (Number.isNaN(expiresAtDate.getTime())) {
      throw new AppError('expires_at deve ser uma data ISO valida', 400);
    }
    if (expiresAtDate < new Date()) {
      throw new AppError('expires_at nao pode ser no passado', 400);
    }
  }

  return {
    code: normalized,
    type,
    plan,
    trial_days: trialDaysNum,
    discount_pct: discountNum,
    discount_value: discountValueRounded,
    discount_months: monthsNum,
    restrict_to_plan: restrict_to_plan,
    max_uses: maxUsesNum,
    expires_at: expiresAtDate,
  };
}

// O payload usa algum campo da migration 326?
function usesNewColumns(payload) {
  return payload.discount_value > 0 || payload.discount_months > 1 || payload.restrict_to_plan;
}

// ── GET /admin/access-codes ───────────────────────────────────
// Query params:
//   type        trial|promo|manual|referral (opcional, filtra por tipo)
//   is_active   true|false (opcional)
//   q           busca por prefixo de code (case-insensitive)
//   limit       paginacao (default 50, max 200)
router.get('/access-codes', ...adminOnly, asyncHandler(async (req, res) => {
  const { type, is_active, q, limit = 50 } = req.query;
  const params = [];
  const where = [];

  if (type) {
    params.push(type);
    where.push(`type = $${params.length}`);
  }
  if (is_active !== undefined && is_active !== '') {
    params.push(is_active === 'true');
    where.push(`is_active = $${params.length}`);
  }
  if (q) {
    params.push(`%${String(q).toUpperCase()}%`);
    where.push(`code ILIKE $${params.length}`);
  }

  const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
  params.push(limitNum);

  // SELECT *: as colunas da migration 326 aparecem quando existirem, sem
  // quebrar com 42703 antes disso.
  const sql = `
    SELECT *
    FROM access_codes
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query(sql, params);
  res.json({ total: rows.length, codes: rows });
}));

// ── POST /admin/access-codes ──────────────────────────────────
router.post('/access-codes', ...adminOnly, asyncHandler(async (req, res) => {
  const payload = validateCreate(req.body);

  const baseParams = [
    payload.code, payload.type, payload.plan,
    payload.trial_days, payload.discount_pct, payload.max_uses,
    payload.expires_at,
  ];

  try {
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO access_codes (code, type, plan, trial_days, discount_pct, max_uses, expires_at,
                                   discount_value, discount_months, restrict_to_plan)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [...baseParams, payload.discount_value, payload.discount_months, payload.restrict_to_plan]
      ));
    } catch (err) {
      if (err.code !== '42703') throw err;
      // Pre-migration 326: so da para criar o cupom antigo.
      if (usesNewColumns(payload)) {
        throw new AppError('Desconto em reais, por varios meses ou com trava de plano ainda nao disponivel (migration 326 pendente)', 400);
      }
      ({ rows } = await pool.query(
        `INSERT INTO access_codes (code, type, plan, trial_days, discount_pct, max_uses, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        baseParams
      ));
    }
    res.status(201).json({ code: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(`Codigo "${payload.code}" ja existe`, 409);
    }
    throw err;
  }
}));

// ── PATCH /admin/access-codes/:id ─────────────────────────────
// Aceita is_active (boolean) pra ativar/desativar.
// Outros campos nao sao editaveis apos criacao (pra manter
// integridade do historico de uso — melhor criar um novo codigo).
router.patch('/access-codes/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body || {};

  if (is_active === undefined) {
    throw new AppError('Nenhum campo editavel enviado. Use is_active.', 400);
  }
  if (typeof is_active !== 'boolean') {
    throw new AppError('is_active deve ser true ou false', 400);
  }

  const { rows } = await pool.query(
    `UPDATE access_codes
     SET is_active = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [is_active, id]
  );

  if (!rows.length) throw new AppError('Codigo nao encontrado', 404);
  res.json({ code: rows[0] });
}));

module.exports = router;
module.exports.validateCreate = validateCreate;
