// ============================================================
// AURA. — Roteador Principal
// ============================================================
const express = require('express');
const router  = express.Router();

const privateCompaniesRouter  = require('./private');
const { publicReviewsRouter } = require('./reviews');
const onboardingRouter        = require('./onboarding');

// ── AUTENTICAÇÃO (pública) ──────────────────────────────────
router.use('/auth', require('./auth'));

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
