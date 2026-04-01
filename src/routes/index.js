// ============================================================
// AURA. — Roteador Principal
// ============================================================
const express = require('express');
const router  = express.Router();

const privateCompaniesRouter  = require('./private');
const { publicReviewsRouter } = require('./reviews');
const onboardingRouter        = require('./onboarding');
const accessCodesRouter       = require('./accessCodes');

// ── AUTENTICAÇÃO (pública) ──────────────────────────────────
router.use('/auth', require('./auth'));

// ── VALIDAÇÃO DE CÓDIGOS (pública) ──────────────────────────
router.use('/auth', accessCodesRouter);  // POST /auth/validate-code

// ── REFERRALS (autenticada) ─────────────────────────────────
router.use('/referrals', accessCodesRouter);  // POST /referrals/generate, GET /referrals/mine

// ── ROTAS PRIVADAS POR EMPRESA ──────────────────────────────
router.use('/companies/:id', privateCompaniesRouter);

// ── ADMIN ───────────────────────────────────────────────────
router.use('/admin', require('./admin'));

// ── ROTAS PÚBLICAS ──────────────────────────────────────────
router.use('/reviews', publicReviewsRouter);
router.use('/dental',  require('./dentalSign'));

// Onboarding: rota pública de CNPJ lookup montada via router
router.use('/onboarding', onboardingRouter);

// FOOD — rotas públicas
router.use('/food/table',    require('./foodWaiter'));
router.use('/food/schedule', require('./foodSchedule'));
router.use('/food',          require('./food'));

module.exports = router;
