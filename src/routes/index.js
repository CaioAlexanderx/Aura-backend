// ============================================================
// AURA. - Roteador Principal
// ============================================================
const express = require('express');
const router  = express.Router();

const privateCompaniesRouter  = require('./private');
const { publicReviewsRouter } = require('./reviews');
const onboardingRouter        = require('./onboarding');
const accessCodesRouter       = require('./accessCodes');
const verificationRouter      = require('./verification');

// Autenticacao (publica)
router.use('/auth', require('./auth'));
router.use('/auth', require('./passwordReset'));
router.use('/auth', accessCodesRouter);
router.use('/auth', verificationRouter);
router.use('/auth', require('./myPermissions'));

// Referrals (autenticada)
router.use('/referrals', accessCodesRouter);

// Convites publicos (aceite sem company access)
router.use('/invite', require('./invitePublic'));

// Rotas privadas por empresa
router.use('/companies/:id', privateCompaniesRouter);

// Admin
router.use('/admin', require('./admin'));
router.use('/admin', require('./adminSupport'));
router.use('/admin', require('./adminMetrics'));

// Webhooks (publicos, validacao interna)
router.use('/webhooks/asaas',     require('./webhookAsaas'));
router.use('/webhooks/whatsapp',  require('./webhookWhatsapp'));

// Storefront publico
router.use('/storefront', require('./storefront'));

// Rotas publicas
router.use('/reviews',           publicReviewsRouter);
router.use('/dental',            require('./dentalSign'));
router.use('/dental/book',       require('./dentalBooking'));
router.use('/barber/book',       require('./barberBooking'));
router.use('/onboarding',        onboardingRouter);
router.use('/food/table',        require('./foodWaiter'));
router.use('/food/schedule',     require('./foodSchedule'));
router.use('/food',              require('./food'));

module.exports = router;
