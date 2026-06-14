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

// ── Leads públicos do site (getaura.com.br via Cloudflare Worker) ──
// POST /api/v1/public/leads -> sales_leads (source='site') -> ProspecaoAdmin
router.use('/public/leads', require('./leadsPublic'));

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
// Endomarketing banners (13/06/2026): CRUD admin de banners de notificação
router.use('/admin', require('./adminNotifications'));
router.use('/admin/leads', require('./adminLeads'));
router.use('/admin/cadences',   require('./adminCadences'));
router.use('/admin/lead-goals', require('./adminLeadGoals'));
router.use('/admin/lead-views', require('./adminLeadViews'));

router.use('/webhooks/asaas',     require('./webhookAsaas'));
router.use('/webhooks/whatsapp',  require('./webhookWhatsapp'));
router.use('/webhooks/instagram', require('./webhookInstagram'));
router.use('/webhooks/mp',        require('./webhookMp'));

// ── AURA KARATÊ — Track F (público: webhook de sync do dojô / Via 1) ──
// Sem auth de empresa. Autentica por federation_sync_token (header
// X-Sync-Token, comparado por hash). Migrations 170 + 171.
//   POST /webhooks/karate-sync/:connId  — registra evento de sync (pending)
router.use('/webhooks/karate-sync', require('./karateSyncWebhook'));

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

// ── AURA KARATÊ — Track D (público: carteirinha verify + portal + inscrição) ──
// SEM auth de empresa. Auth própria por token/OTP. Migration 164.
//   GET  /public/karate/verify/:token                 — verify carteirinha (mínimo/LGPD)
//   GET  /public/karate/portal/me                     — portal autenticado (OTP→JWT)
//   POST /public/karate/portal/opt-in                 — opt-in portal público (não menores)
//   POST /public/karate/:slug/portal/request-otp      — solicita OTP (genérico)
//   POST /public/karate/:slug/portal/verify-otp       — valida OTP → token de portal
//   GET  /public/karate/:slug/p/:publicToken          — portal público (reduzido)
//   GET  /public/karate/:slug/events                  — agenda pública
//   GET  /public/karate/:slug/inscricao/:eventId      — dados p/ inscrição
//   POST /public/karate/:slug/inscricao/:eventId      — inscrição (exame/curso real; competição 501)
router.use('/public/karate', require('./karatePublic'));

// ── AURA KARATÊ — Track E (público: ranking embeddável) ──
// Router separado (mantém karatePublic.js intacto). Migrations 168 + 169.
//   GET /public/karate/:slug/seasons                  — temporadas/categorias
//   GET /public/karate/:slug/ranking?season=&category=— ranking (widget)
//   GET /public/karate/:slug/ranking/:season/:category— atalho REST (iframe)
router.use('/public/karate', require('./karatePublicRanking'));

// ── AURA KARATÊ — Track A (backend cadastros) ──────────────
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
router.use('/federation/:id/financial', require('./karateAnnuities'));
router.use('/federation/:id/financial', require('./karateExpenses'));
router.use('/federation/:id/financial', require('./karateFees'));
router.use('/federation/:id/financial', require('./karateFinancial'));

// ── AURA KARATÊ — Track C (backend exames + certificados) ───
router.use('/federation/:id', require('./karateRequirements'));
router.use('/federation/:id', require('./karateExams'));
router.use('/federation/:id', require('./karateCourses'));
router.use('/federation/:id', require('./karateCertificates'));

// ── AURA KARATÊ — Track D (admin: carteirinha digital) ──────
// Migration 164. Somente DADOS (sem geração de imagem no app).
//   POST /federation/:id/practitioners/:practitionerId/issue-card  (staffWrite)
//   GET  /federation/:id/practitioners/:practitionerId/card        (read)
//   GET  /federation/:id/cards                                     (read)
//   POST /federation/:id/cards/issue-batch                         (adminOnly)
router.use('/federation/:id', require('./karateCards'));

// ── AURA KARATÊ — Track E (admin: competições + ranking) ────
// Migrations 168 + 169. Contrato docs/karate-fase4-openapi.yaml.
//   GET/POST  /federation/:id/competitions
//   GET/PATCH /federation/:id/competitions/:cid (+ /close)
//   .../categories, .../entries (inscrição + resultado), .../ranking
//   GET       /federation/:id/rankings (temporada, via view)
router.use('/federation/:id', require('./karateCompetitions'));

// ── AURA KARATÊ — Track F (admin: conectividade dojô / Fase 5) ──
// Migrations 170 + 171. Contrato docs/karate-fase5-openapi.yaml.
//   GET/POST /federation/:id/connections (+ /requests)
//   GET/PATCH /federation/:id/connections/:connId
//   POST .../approve, .../reject, .../rotate-token
//   GET  .../events  + POST .../events/:eventId/reprocess
router.use('/federation/:id', require('./karateConnections'));

// ── AURA KARATÊ — Track I (régua de lembrete de anuidade + logs) ──
// Migrations 174 + 175. Provider Resend (karateMailer) + motor de régua.
//   GET/PUT /federation/:id/reminder-config   (read / adminOnly)
//   GET     /federation/:id/reminder-log        (read)
//   POST    /federation/:id/reminders/run       (adminOnly, disparo manual)
router.use('/federation/:id', require('./karateReminders'));

module.exports = router;
