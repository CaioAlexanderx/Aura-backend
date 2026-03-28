// ============================================================
// AURA. — Roteador Principal
// fix(B-04): /auth montado com register, login e me
// ============================================================
const express = require('express');
const router  = express.Router();

const privateCompaniesRouter = require('./private');
const { publicReviewsRouter } = require('./reviews');

// ── AUTENTICAÇÃO (pública) ──────────────────────────────────
router.use('/auth', require('./auth'));

// ── ROTAS PRIVADAS POR EMPRESA ──────────────────────────────
router.use('/companies/:id', privateCompaniesRouter);

// ── ADMIN ───────────────────────────────────────────────────
router.use('/admin', require('./admin'));

// ── ROTAS PÚBLICAS ──────────────────────────────────────────
router.use('/reviews', publicReviewsRouter);
router.use('/dental',  require('./dentalSign'));

// Onboarding: lookup público de CNPJ (sem auth)
router.post('/onboarding/cnpj-lookup', require('./onboarding'));

// FOOD — rotas públicas (mesa, cardápio, agendamento)
router.use('/food/table',    require('./foodWaiter'));
router.use('/food/schedule', require('./foodSchedule'));
router.use('/food',          require('./food'));

module.exports = router;
