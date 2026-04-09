// ============================================================
// AURA. — Roteador Principal
// ============================================================
const express = require('express');
const router  = express.Router();

const privateCompaniesRouter  = require('./private');
const { publicReviewsRouter } = require('./reviews');
const onboardingRouter        = require('./onboarding');
const accessCodesRouter       = require('./accessCodes');
const verificationRouter      = require('./verification');

// ── AUTENTICAÇÃO (pública) ──────────────────────────────────
router.use('/auth', require('./auth'));
router.use('/auth', require('./passwordReset'));
router.use('/auth', accessCodesRouter);
router.use('/auth', verificationRouter);

// ── REFERRALS (autenticada) ─────────────────────────────────
router.use('/referrals', accessCodesRouter);

// ── ROTAS PRIVADAS POR EMPRESA ──────────────────────────────
router.use('/companies/:id', privateCompaniesRouter);

// ── ADMIN ───────────────────────────────────────────────────
router.use('/admin', require('./admin'));

// ── WEBHOOKS (públicos, validação interna) ──────────────────
router.use('/webhooks/asaas', require('./webhookAsaas'));
router.use('/webhooks/whatsapp', require('./webhookWhatsapp'));

// ── STOREFRONT PÚBLICO ──────────────────────────────────────
router.use('/storefront', require('./storefront'));

// ── ROTAS PÚBLICAS ──────────────────────────────────────────
router.use('/reviews', publicReviewsRouter);
router.use('/dental',  require('./dentalSign'));
router.use('/dental/book', require('./dentalBooking'));
router.use('/barber/book', require('./barberBooking'));
router.use('/onboarding', onboardingRouter);
router.use('/food/table',    require('./foodWaiter'));
router.use('/food/schedule', require('./foodSchedule'));
router.use('/food',          require('./food'));

module.exports = router;
