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

// ── VALIDAÇÃO DE CÓDIGOS (pública) ──────────────────────────
router.use('/auth', accessCodesRouter);  // POST /auth/validate-code

// ── VERIFICAÇÃO EMAIL/PHONE (autenticada) ───────────────────
router.use('/auth', verificationRouter); // POST /auth/send-verification, /auth/verify-email, etc.

// ── REFERRALS (autenticada) ─────────────────────────────────
router.use('/referrals', accessCodesRouter);  // POST /referrals/generate, GET /referrals/mine

// ── ROTAS PRIVADAS POR EMPRESA ──────────────────────────────
router.use('/companies/:id', privateCompaniesRouter);

// ── ADMIN ───────────────────────────────────────────────────
router.use('/admin', require('./admin'));

// ── WEBHOOKS (públicos, validação HMAC interna) ─────────────
router.use('/webhooks/asaas', require('./webhookAsaas'));

// ── ROTAS PÚBLICAS ──────────────────────────────────────────
router.use('/reviews', publicReviewsRouter);
router.use('/dental',  require('./dentalSign'));
router.use('/dental/book', require('./dentalBooking'));   // D-11: Public dental booking
router.use('/barber/book', require('./barberBooking'));   // B-12: Public barber booking

// Onboarding: rota pública de CNPJ lookup montada via router
router.use('/onboarding', onboardingRouter);

// FOOD — rotas públicas
router.use('/food/table',    require('./foodWaiter'));
router.use('/food/schedule', require('./foodSchedule'));
router.use('/food',          require('./food'));

module.exports = router;
