// ============================================================
// AURA. — Roteador Principal
// ============================================================

const express = require('express');
const router = express.Router();

const privateCompaniesRouter = require('./private');
const { publicReviewsRouter } = require('./reviews');

// ── ROTAS PRIVADAS POR EMPRESA ───────────────────────────────
router.use('/companies/:id', privateCompaniesRouter);

// ── ADMIN ────────────────────────────────────────────────────
router.use('/admin', require('./admin'));

// ── ROTAS PÚBLICAS ───────────────────────────────────────────
router.use('/reviews', publicReviewsRouter);
router.use('/dental', require('./dentalSign'));

router.post('/onboarding/cnpj-lookup', require('./onboarding'));

// FOOD — públicas
router.use('/food/table', require('./foodWaiter'));
router.use('/food/schedule', require('./foodSchedule'));
router.use('/food', require('./food'));

module.exports = router;
