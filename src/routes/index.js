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
const { userRouter: productLinksUserRouter } = require('./productLinks'); // M-STOCKLINK MSL-04

// Autenticacao (publica)
router.use('/auth', require('./auth'));
router.use('/auth', require('./passwordReset'));
router.use('/auth', accessCodesRouter);
router.use('/auth', verificationRouter);
router.use('/auth', require('./myPermissions'));
router.use('/auth', require('./sidebarLayout'));
router.use('/auth', require('./authSwitchCompany')); // Multi-CNPJ M1-03

// Referrals (autenticada)
router.use('/referrals', accessCodesRouter);

// Convites publicos (aceite sem company access)
router.use('/invite', require('./invitePublic'));

// Multi-CNPJ M1-02: endpoints user-level (lista/cria empresas adicionais)
router.use('/me/companies', require('./userCompanies'));
// M-STOCKLINK MSL-04: produtos agregados (não precisa :id, view consolidada)
router.use('/me', productLinksUserRouter);

// Rotas privadas por empresa
router.use('/companies/:id', privateCompaniesRouter);

// Admin — Central de Comando
router.use('/admin', require('./admin'));
router.use('/admin', require('./adminAccessCodes'));
router.use('/admin', require('./adminPlan'));
router.use('/admin', require('./adminVertical'));
router.use('/admin', require('./adminSupport'));
router.use('/admin', require('./adminMetrics'));
router.use('/admin', require('./adminClients360'));
router.use('/admin', require('./adminRevenue'));
router.use('/admin', require('./adminOps'));
router.use('/admin', require('./adminGrowth'));

// Webhooks (publicos, validacao interna)
router.use('/webhooks/asaas',     require('./webhookAsaas'));
router.use('/webhooks/whatsapp',  require('./webhookWhatsapp'));
router.use('/webhooks/instagram', require('./webhookInstagram')); // Hub Social P11 S3

// Storefront publico
router.use('/storefront', require('./storefront'));

// Rotas publicas
router.use('/reviews',           publicReviewsRouter);
router.use('/dental',            require('./dentalSign'));
router.use('/dental/consent',    require('./dentalConsentPublic')); // W2-04: TCLE pad publico
router.use('/dental/book',       require('./dentalBooking'));
router.use('/dental-portal',     require('./dentalPortalPublic'));
router.use('/barber/book',       require('./barberBooking'));
router.use('/onboarding',        onboardingRouter);
router.use('/food/table',        require('./foodWaiter'));
router.use('/food/schedule',     require('./foodSchedule'));
router.use('/food',              require('./food'));

module.exports = router;
