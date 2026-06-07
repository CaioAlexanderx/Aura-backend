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

// Aura Studio Sub-onda Marketplaces S-3 (25/05/2026):
// Webhooks stub ML + Shopee. Mesmo router, 2 endpoints (/mercadolivre + /shopee).
// Publicos, sem signature validation real (depende do core OAuth).
router.use('/webhooks', require('./webhookMarketplaceStub'));

// Core ML/Shopee F1.B + F2.B (25/05/2026):
// Callback publico OAuth — recebe redirect do ML/Shopee depois que o lojista
// autorizou. GET /api/v1/marketplaces/:platform/callback?code=XXX&state=YYY
// (sem auth — usa state com companyId).
router.use('/marketplaces', require('./marketplaceAuthPublic'));

// Aura Studio Nivel 1 Sub-onda D (25/05/2026):
// Storefront publico Studio. Montado ANTES de /storefront pra que rotas
// /storefront/:slug/studio/* sejam capturadas por studioStorefront e nao
// caiam no catch-all GET /:slug do storefront principal.
router.use('/storefront', require('./studioStorefront'));
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

// Studio Camada 1 Fase A (30/05/2026): aceite público do orçamento via link.
// Sem auth — cliente recebe link e abre /orcamento/:token no navegador.
// Migration 138. Espelha a mecânica de /aprovacao.
router.use('/orcamento',         require('./studioQuotePublic'));

// ── AURA KARATÊ — Track A (backend cadastros) ───────────────
// POST /karate/federation/setup (sem escopo de empresa, auth only)
// GET  /federation/:id/dashboard
// GET  /federation/:id/belt-distribution
router.use('/karate', require('./karateFederation'));

// Praticantes: /import DEVE vir ANTES de /:practitionerId
// para que a string literal 'import' não seja capturada como UUID.
// Ambos montados sob /federation/:id/practitioners
router.use('/federation/:id/practitioners/import', require('./karateImport'));
router.use('/federation/:id/practitioners',        require('./karatePractitioners'));
router.use('/federation/:id/dojos',                require('./karateDojos'));
// dashboard e belt-distribution são expostos pelo karateFederation router
// mas precisam do param :id, então também montamos aqui:
router.use('/federation/:id', require('./karateFederation'));

// ── AURA KARATÊ — Track B (backend financeiro + anuidades) ──
// Guard: adminOnly() em todas as rotas financeiras (RBAC §7.3)
//
// Ordem de montagem: rotas com path literal (/annuities, /fees, /overdue, /expenses, /payments)
// ANTES do router de financial/overview (que usa apenas /overview).
// Evita que :id capture strings literais.
//
// GET  /federation/:id/financial/overview
// GET  /federation/:id/financial/annuities/dojos
// POST /federation/:id/financial/annuities/dojos/:dojoId/charge
// POST /federation/:id/financial/annuities/dojos/:dojoId/pix
// GET  /federation/:id/financial/payments/:intentId/status
// POST /federation/:id/financial/payments/:intentId/confirm
// GET  /federation/:id/financial/annuities/cpf
// POST /federation/:id/financial/annuities/cpf/:practitionerId/charge
// POST /federation/:id/financial/annuities/cpf/:practitionerId/pix
// GET  /federation/:id/financial/fees
// PUT  /federation/:id/financial/fees
// GET  /federation/:id/financial/expenses
// POST /federation/:id/financial/expenses
// GET  /federation/:id/financial/overdue
// POST /federation/:id/financial/overdue/:targetId/remind
router.use('/federation/:id/financial', require('./karateAnnuities'));
router.use('/federation/:id/financial', require('./karateExpenses'));
router.use('/federation/:id/financial', require('./karateFees'));
router.use('/federation/:id/financial', require('./karateFinancial'));

// ── AURA KARATÊ — Track C (backend exames + certificados) ───
// Ordem de montagem:
//   1. karateRequirements: /belt-requirements (literal, sem param)
//   2. karateExams:        /belt-exams (literal, sem param)
//   3. karateCourses:      /courses (literal, sem param)
//   4. karateCertificates: /certificates/:candidateId (param)
//   (practitioners eligibility está dentro de karateExams)
//
// GET  /federation/:id/belt-requirements
// PUT  /federation/:id/belt-requirements          (adminOnly)
// GET  /federation/:id/belt-exams
// POST /federation/:id/belt-exams
// GET  /federation/:id/belt-exams/:examId
// PATCH /federation/:id/belt-exams/:examId
// GET  /federation/:id/belt-exams/:examId/examiners
// POST /federation/:id/belt-exams/:examId/examiners
// POST /federation/:id/belt-exams/:examId/candidates         (201 + eligibility, FPKT #1)
// PATCH /federation/:id/belt-exams/:examId/candidates/:cId  (examResults RBAC)
// POST /federation/:id/belt-exams/:examId/candidates/:cId/correction
// POST /federation/:id/belt-exams/:examId/close             (NÃO emite cert, FPKT #3)
// GET  /federation/:id/practitioners/:pId/eligibility/:belt  (só aviso)
// GET  /federation/:id/courses
// POST /federation/:id/courses
// GET  /federation/:id/courses/:eventId
// POST /federation/:id/courses/:eventId/enroll
// POST /federation/:id/certificates/:candidateId/issue       (sob demanda, FPKT #3)
// GET  /federation/:id/certificates/:candidateId
router.use('/federation/:id', require('./karateRequirements'));
router.use('/federation/:id', require('./karateExams'));
router.use('/federation/:id', require('./karateCourses'));
router.use('/federation/:id', require('./karateCertificates'));

module.exports = router;
