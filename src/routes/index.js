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
// M-STOCKLINK MSL-04: produtos agregados (nao precisa :id, view consolidada)
router.use('/me', productLinksUserRouter);
// Multi-CNPJ Sessao 2: endpoints /me/* consolidados (Onda 2.1+)
router.use('/me', require('./meAggregates'));
// Financeiro v2 — Insights consolidados multi-CNPJ (04/05/2026).
// Agrega health score, runway e biggest lever de TODAS as empresas do usuario.
router.use('/me/financeiro', require('./financeiroInsights').meRouter);
// Financeiro Fase A (19/05/2026): comparativo consolidado multi-CNPJ.
// Retorna series diarias alinhadas (atual + comparativo) pra grafico sobreposto.
router.use('/me/financeiro', require('./financeiroComparative').meRouter);

// Rotas privadas por empresa
router.use('/companies/:id', privateCompaniesRouter);

// Admin — Central de Comando
router.use('/admin', require('./admin'));
router.use('/admin', require('./adminAccessCodes'));
router.use('/admin', require('./adminPlan'));
router.use('/admin', require('./adminVertical'));
// Fase B1 benchmark (19/05/2026): sub-segmentacao manual via Gestao Aura.
router.use('/admin', require('./adminSubVertical'));
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
router.use('/webhooks/mp',        require('./webhookMp'));        // MP Fase 1 (20/05/2026)

// Storefront publico
router.use('/storefront', require('./storefront'));

// Relatorios publicos (acessados via token JWT enviado no email semanal)
router.use('/reports', require('./publicReports'));

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
// FOOD-10 (Fase 5): rotas publicas extras (POST de pedido pelo slug + zonas).
// Montado ANTES de '/food' principal porque tem rotas mais especificas
// (/menu/public/:slug/order, /zones) que nao conflitam com food.js.
router.use('/food',              require('./foodPublic'));
router.use('/food',              require('./food'));

module.exports = router;
