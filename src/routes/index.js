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
const { userRouter: productLinksUserRouter } = require('./productLinks');

router.use('/auth', require('./auth'));
router.use('/auth', require('./passwordReset'));
router.use('/auth', accessCodesRouter);
router.use('/auth', verificationRouter);
router.use('/auth', require('./myPermissions'));
router.use('/auth', require('./sidebarLayout'));
router.use('/auth', require('./authSwitchCompany'));

router.use('/referrals', accessCodesRouter);
router.use('/invite', require('./invitePublic'));

router.use('/me/companies', require('./userCompanies'));
router.use('/me', productLinksUserRouter);
router.use('/me', require('./meAggregates'));
router.use('/me/financeiro', require('./financeiroInsights').meRouter);
router.use('/me/financeiro', require('./financeiroComparative').meRouter);

router.use('/companies/:id', privateCompaniesRouter);

router.use('/admin', require('./admin'));
router.use('/admin', require('./adminAccessCodes'));
router.use('/admin', require('./adminPlan'));
router.use('/admin', require('./adminVertical'));
router.use('/admin', require('./adminSubVertical'));
router.use('/admin', require('./adminSupport'));
router.use('/admin', require('./adminMetrics'));
router.use('/admin', require('./adminClients360'));
router.use('/admin', require('./adminRevenue'));
router.use('/admin', require('./adminOps'));
router.use('/admin', require('./adminGrowth'));
router.use('/admin/leads', require('./adminLeads'));
router.use('/admin/cadences',   require('./adminCadences'));
router.use('/admin/lead-goals', require('./adminLeadGoals'));
router.use('/admin/lead-views', require('./adminLeadViews'));

router.use('/webhooks/asaas',     require('./webhookAsaas'));
router.use('/webhooks/whatsapp',  require('./webhookWhatsapp'));
router.use('/webhooks/instagram', require('./webhookInstagram'));
router.use('/webhooks/mp',        require('./webhookMp'));

router.use('/storefront', require('./storefront'));
router.use('/reports', require('./publicReports'));

router.use('/reviews',           publicReviewsRouter);
router.use('/dental',            require('./dentalSign'));
router.use('/dental/consent',    require('./dentalConsentPublic'));
router.use('/dental/book',       require('./dentalBooking'));
router.use('/dental-portal',     require('./dentalPortalPublic'));
router.use('/barber/book',       require('./barberBooking'));
router.use('/onboarding',        onboardingRouter);
router.use('/food/table',        require('./foodWaiterPublic'));
router.use('/food/schedule',     require('./foodSchedulePublic'));
router.use('/food',              require('./foodPublic'));
router.use('/food',              require('./food'));

// Aura Studio Fase 5: aprovação pública de arte via wa.me.
// Sem auth — cliente recebe link wa.me e abre /aprovacao/:token no navegador.
// Migration 132. PR Aura-backend#112.
router.use('/aprovacao',         require('./studioApprovalPublic'));

module.exports = router;
