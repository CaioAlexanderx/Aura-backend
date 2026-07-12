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
router.use('/admin', require('./adminKarate'));
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

// ── AURA KARATÊ — Track F5 (público: webhook de conciliação de pagamento) ──
// Sem auth de empresa — o provedor de pagamento não tem sessão Aura.
// Validação de token/segredo é feita dentro do handler (por federação,
// com fallback de env). Ver src/routes/karateWebhooks.js.
router.use('/webhooks/karate-payments', require('./karateWebhooks'));

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

// Visual Engine F3 (03/07/2026): template visual público pro preview 2D/3D
// do storefront (products.visual_template_key → studio_visual_templates).
// Montado ANTES de studioStorefront — rota específica, sem colisão com o
// catch-all do storefront principal.
router.use('/storefront', require('./studioStorefrontVisual'));

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

// ── AURA KARATÊ — Track E (público: ranking embellável) ──
// Router separado (mantém karatePublic.js intacto). Migrations 168 + 169.
//   GET /public/karate/:slug/seasons                  — temporadas/categorias
//   GET /public/karate/:slug/ranking?season=&category=— ranking (widget)
//   GET /public/karate/:slug/ranking/:season/:category— atalho REST (iframe)
router.use('/public/karate', require('./karatePublicRanking'));

// ── AURA KARATÊ — Fase 0 Dojô (Canal B público: OTP do responsável) ──
// POST /public/karate/:slug/dojo/portal/request-otp
// POST /public/karate/:slug/dojo/portal/verify-otp
router.use('/public/karate', require('./karateDojoPublic'));

// ── AURA KARATÊ — Cascata de status dojô→praticantes + validação de quadro (10/07/2026) ──
// Portal público do sensei (SEM auth — token opaco escopado ao dojô):
//   GET   /public/roster-update/:token                          (missing/counts/progress — G1)
//   GET   /public/roster-update/:token/practitioners/:studentId (ficha completa — G1)
//   PATCH /public/roster-update/:token/practitioners/:studentId (autosave granular, inclui inativar — G1)
//   POST  /public/roster-update/:token
//   POST  /public/roster-update/:token/practitioner
//   GET   /public/roster-update/:token/export
//   GET   /public/roster-update/:token/export-missing (G1)
//   POST  /public/roster-update/:token/import          (G1)
router.use('/public/roster-update', require('./karateRosterPortalPublic'));

// ── AURA KARATÊ — G1: auto-atendimento do PRÓPRIO praticante (12/07/2026) ──
// Token SEPARADO do token do sensei acima (self_service_token — migration
// 225). Só aceita telefone/e-mail do próprio praticante, após 2º fator
// (nascimento ou matrícula). Ver comentário de topo do arquivo para a
// decisão de segurança.
//   GET  /public/roster-self/:token/search?q=nome
//   POST /public/roster-self/:token/update
router.use('/public/roster-self', require('./karateRosterSelfServicePublic'));

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
// Export de dados do dojô (round-trip com o import). Montado ANTES do router
// principal de dojos só por clareza; ambos respondem sob /federation/:id/dojos
// e o caminho /:dojoId/export-data não colide com as rotas de karateDojos.
router.use('/federation/:id/dojos',                require('./karateExportDojo'));
router.use('/federation/:id/dojos',                require('./karateDojos'));
// Redistribuição na inativação de dojô: transfere/inativa praticantes em
// lote e, opcionalmente, inativa o dojô ao final (cascata para quem sobrou).
//   POST /federation/:id/dojos/:dojoId/redistribute   (staffWrite)
router.use('/federation/:id/dojos',                require('./karateRosterRedistribute'));
// Cascata de status dojô→praticantes + validação de quadro (10/07/2026):
//   POST /federation/:id/dojos/:dojoId/request-roster-update  (adminOnly)
//   GET  /federation/:id/dojos/:dojoId/roster-validation      (read)
//   GET  /federation/:id/dojos/roster-progress                 (read — G1 item 7,
//        painel de progresso por dojô para a federação)
router.use('/federation/:id/dojos',                require('./karateRosterValidation'));
// Fase 4: roster do dojô (status + financeiro) — GET /:dojoId/members-standing
router.use('/federation/:id/dojos',                require('./karateDojoRoster'));
// Fase 2: anexos (documentos/imagens) para dojô e praticante. Mesmo router
// montado nas duas bases — ele deduz owner_type ('dojo'/'practitioner') pelo
// req.baseUrl. Paths /:ownerId/documents não colidem com /:dojoId ou
// /:practitionerId (formato de path distinto). Migration 207 (karate_documents).
router.use('/federation/:id/dojos',                require('./karateDocuments'));
router.use('/federation/:id/practitioners',        require('./karateDocuments'));
// dashboard e belt-distribution são expostos pelo karateFederation router
// mas precisam do param :id, então também montamos aqui:
router.use('/federation/:id', require('./karateFederation'));
// Fase 6: Painel + Saúde da rede (standing agregado) — GET /standing/summary
router.use('/federation/:id/standing', require('./karateStandingSummary'));

// ── AURA KARATÊ — Track B (backend financeiro + anuidades) ──
router.use('/federation/:id/financial', require('./karateAnnuities'));
// Fase F3: campanha anual de anuidades + cobrança em lote
router.use('/federation/:id/financial', require('./karateAnnuityCampaign'));
// Fase F4: e-mail de cobrança manual (single+batch) + void-batch.
router.use('/federation/:id/financial', require('./karateAnnuityBilling'));
router.use('/federation/:id/financial', require('./karateAnnuitySummary'));
router.use('/federation/:id/financial', require('./karateExpenses'));
router.use('/federation/:id/financial', require('./karateFees'));
router.use('/federation/:id/financial', require('./karateFinancial'));
// Track P: NFS-e para anuidades de dojô (reusa nuvemfiscal + nfe_documents)
router.use('/federation/:id/financial', require('./karateNfse'));
// Fase 5: valores em aberto segmentados (pretas CPF x dojôs) — GET /open-items
router.use('/federation/:id/financial', require('./karateOpenItems'));

// ── AURA KARATÊ — Track C (backend exames + cursos) ─────────────
// (certificados Track J montado separadamente abaixo)
router.use('/federation/:id', require('./karateRequirements'));
router.use('/federation/:id', require('./karateExams'));
router.use('/federation/:id', require('./karateCourses'));

// ── AURA KARATÊ — Track J (certificados: fluxo de pedido) ─────────
// Substitui o fluxo Track C de emissão sob demanda.
// Migration 182: karate_certificate_orders + karate_certificate_order_history.
// Defensive 42P01: safe to merge antes da migration ser aplicada.
//   POST   /federation/:id/certificate-orders
//   GET    /federation/:id/certificate-orders/mine
//   GET    /federation/:id/certificate-orders
//   GET    /federation/:id/certificate-orders/:orderId
//   PATCH  /federation/:id/certificate-orders/:orderId/status
//   POST   /federation/:id/certificate-orders/batch-status
//   POST   /federation/:id/certificate-orders/:orderId/refuse
router.use('/federation/:id', require('./karateCertificates'));

// ── AURA KARATÊ — Track D (admin: carteirinha digital) ──────────
// Migration 164. Somente DADOS (sem geração de imagem no app).
//   POST /federation/:id/practitioners/:practitionerId/issue-card  (staffWrite)
//   GET  /federation/:id/practitioners/:practitionerId/card        (read)
//   GET  /federation/:id/cards                                     (read)
//   POST /federation/:id/cards/issue-batch                         (adminOnly)
router.use('/federation/:id', require('./karateCards'));

// ── AURA KARATÊ — Track E (admin: competições + ranking) ────────
// Migrations 168 + 169. Contrato docs/karate-fase4-openapi.yaml.
//   GET/POST  /federation/:id/competitions
//   GET/PATCH /federation/:id/competitions/:cid (+ /close)
//   .../categories, .../entries (inscrição + resultado), .../ranking
//   GET       /federation/:id/rankings (temporada, via view)
router.use('/federation/:id', require('./karateCompetitions'));

// ── AURA KARATÊ — Track E+ (admin: biblioteca de categorias reutilizáveis) ──
// Migration 196: karate_competition_category_templates.
//   GET/POST     /federation/:id/category-templates
//   PATCH/DELETE /federation/:id/category-templates/:tid
router.use('/federation/:id', require('./karateCategoryTemplates'));

// ── AURA KARATÊ — Track F (admin: conectividade dojô / Fase 5) ──
// Migrations 170 + 171. Contrato docs/karate-fase5-openapi.yaml.
//   GET/POST /federation/:id/connections (+ /requests)
//   GET/PATCH /federation/:id/connections/:connId
//   POST .../approve, .../reject, .../rotate-token
//   GET  .../events  + POST .../events/:eventId/reprocess
router.use('/federation/:id', require('./karateConnections'));

// ── AURA KARATÊ — Track K (sync real: aplicação idempotente da fila) ──
// Migration 179. Consumidor de karate_sync_events: aplica practitioner/
// attendance/annuity à federação (dedupe em karate_sync_applied).
//   POST /federation/:id/sync/apply   (adminOnly) — drena+aplica a fila
router.use('/federation/:id', require('./karateSyncApply'));

// ── AURA KARATÊ — Track I (régua de lembrete de anuidade + logs) ──
// Migrations 174 + 175. Provider Resend (karateMailer) + motor de régua.
//   GET/PUT /federation/:id/reminder-config   (read / adminOnly)
//   GET     /federation/:id/reminder-log        (read)
//   POST    /federation/:id/reminders/run       (adminOnly, disparo manual)
router.use('/federation/:id', require('./karateReminders'));

// ── AURA KARATÊ — Track N (transferência de praticante entre dojôs) ──
// Migration 180 (karate_practitioner_transfers, append-only/imutável).
//   GET  /federation/:id/practitioners/:practitionerId/transfers  (read)
//   POST /federation/:id/practitioners/:practitionerId/transfer    (staffWrite)
router.use('/federation/:id', require('./karateTransfers'));

// ── AURA KARATÊ — Track H (configurações da federação) ───────────
// Migration 181 (inscricao_municipal + regime_tributario em companies).
//   GET/POST   /federation/:id/settings/members          — equipe FPKT
//   PATCH      /federation/:id/settings/members/:mid/role
//   DELETE     /federation/:id/settings/members/:mid
//   GET/PUT    /federation/:id/settings/flags             — feature flags karatê
//   GET/PUT    /federation/:id/settings/identity          — identidade + fiscal
router.use('/federation/:id', require('./karateSettings'));

// ── AURA KARATÊ — Track M (chaves / brackets) ──
// Migration 183 (karate_brackets, karate_bracket_matches, karate_kata_scores).
// Kumite: bracket eliminatório (generate/lock/get/advance).
// Kata: apuração por bateria (scores, generate-order, advance para final).
//   POST /federation/:id/competitions/:cid/categories/:catId/bracket/generate
//   POST /federation/:id/competitions/:cid/categories/:catId/bracket/lock
//   GET  /federation/:id/competitions/:cid/categories/:catId/bracket
//   POST /federation/:id/competitions/:cid/categories/:catId/bracket/advance
//   GET  /federation/:id/competitions/:cid/categories/:catId/kata-scores
//   PUT  /federation/:id/competitions/:cid/categories/:catId/kata-scores
//   POST /federation/:id/competitions/:cid/categories/:catId/kata-scores/generate-order
//   POST /federation/:id/competitions/:cid/categories/:catId/kata-scores/advance
router.use('/federation/:id', require('./karateBrackets'));

// ── AURA KARATÊ — Track L (Saúde da Rede) ─────────────────
// Sem migration (totalmente derivado de tabelas existentes).
// Guards federation_admin/staff/viewer para leitura; adminOnly para /report/send.
//   GET  /federation/:id/network-health/summary
//   GET  /federation/:id/network-health/afiliacao
//   GET  /federation/:id/network-health/renovacao
//   GET  /federation/:id/network-health/cobertura
//   GET  /federation/:id/network-health/inadimplencia
//   GET  /federation/:id/network-health/projecao-receita
//   GET  /federation/:id/network-health/dormencia
//   GET  /federation/:id/network-health/concentracao
//   GET  /federation/:id/network-health/graduacoes
//   GET  /federation/:id/network-health/relacao-faixas
//   POST /federation/:id/network-health/report/send
// Todos os GET: ?export=csv retorna arquivo CSV.
router.use('/federation/:id/network-health', require('./karateNetworkHealth'));

// ── AURA KARATÊ — Fase 0 Dojô (Canal A+B autenticado: endpoints /dojo/*) ──
// GET /federation/:id/dojo/me  — piloto; fases 1-6 adicionam sub-routers
router.use('/federation/:id', require('./karateDojo'));

// ── AURA KARATÊ — Track Banner (banners promocionais da federação) ──
// Migration 198 (karate_promo_banners). Guards staffWrite (POST) + read (GET) + adminOnly (DELETE).
//   POST   /federation/:id/banners           — upload imagem (multipart ou base64) + cria banner
//   GET    /federation/:id/banners           — lista banners (admin)
//   PATCH  /federation/:id/banners/:bannerId — edita metadados
//   DELETE /federation/:id/banners/:bannerId — remove banner
// Público (em karatePublic.js):
//   POST /public/karate/:slug/lookup         — lookup praticante por CPF, e-mail ou FPKT
//   GET  /public/karate/:slug/banners        — banners ativos (hub/inscricao/ambos)
router.use('/federation/:id', require('./karatePromoBanners'));
router.use('/federation/:id', require('./karateEventCertificates'));

module.exports = router;
