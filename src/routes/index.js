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
router.use('/admin/aura-notas', require('./adminAuraNotas')); // Gestão Aura — NFC-e engine própria (staff)

router.use('/admin/cadences',   require('./adminCadences'));
router.use('/admin/lead-goals', require('./adminLeadGoals'));
router.use('/admin/lead-views', require('./adminLeadViews'));

router.use('/webhooks/asaas',     require('./webhookAsaas'));
// ── AURA DOJÔ — F3b (público: conciliação da subconta Asaas do dojô/BaaS) ──
// Sem auth de empresa. Autentica por header asaas-access-token comparado por
// HASH contra o token da subconta (karate_dojo_baas_accounts.webhook_token_hash,
// migration 244). PAYMENT_RECEIVED/CONFIRMED (externalReference=charge_id) dão
// baixa idempotente; eventos de status de conta atualizam o onboarding;
// PAYMENT_DELETED/estorno nunca regridem cobrança paga. Flag DOJO_BAAS_ENABLED.
router.use('/webhooks/asaas-dojo', require('./karateDojoBaasWebhook'));
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

// K3 (18/08/2026): acompanhamento público da encomenda ("pizza tracker").
// Sem auth — o token é a credencial, igual /aprovacao. Migration 286.
// O link viaja na mensagem de WhatsApp que o checkout já monta na venda.
router.use('/acompanhar',        require('./studioTrackPublic'));

// Studio Camada 1 Fase A (30/05/2026): aceite público do orçamento via link.
// Sem auth — cliente recebe link e abre /orcamento/:token no navegador.
// Migration 138. Espelha a mecânica de /aprovacao.
router.use('/orcamento',         require('./studioQuotePublic'));

// ── AURA DOJÔ — F11 (público: lista de federações para o CADASTRO) ──
// SEM migration. Único caminho público que LISTA federações — todos os
// outros routers /public/karate abaixo partem de um :slug/token de UMA
// federação já conhecida. Usado pelo seletor do passo "Sua empresa" do
// autocadastro (POST /auth/register com vertical='karate_dojo'), quando o
// sensei ainda não tem conta e portanto nenhuma rota autenticada serve.
// Devolve SÓ id + nome (ver comentário de topo de karateFederationsPublic.js).
//
// ⚠️ Montado ANTES dos demais /public/karate: 'federations' é rota estática
// de 1 segmento e nunca pode ser capturada como :slug (mesma armadilha de
// /dojos/roster-progress e /public/karate/dojo).
//   GET /public/karate/federations
router.use('/public/karate', require('./karateFederationsPublic'));

// ── AURA KARATÊ — F0 Aura Dojô (público: claim da conta do dojô) ──
// A federação convida o e-mail do sensei; ele define a senha no link e vira
// o owner REAL da company do dojô (antes: user-sistema
// '!locked-system-no-login', ver karateDojos.js). Migration 240.
// Montado ANTES dos routers /public/karate abaixo (rota estática
// 'dojo-claim' nunca deve ser capturada como :slug).
//   POST /public/karate/dojo-claim/verify    {token}
//   POST /public/karate/dojo-claim/complete  {token, name, password}
router.use('/public/karate/dojo-claim', require('./karateDojoClaimPublic'));

// ── AURA KARATÊ — F0 Canal B (portal do dojô por LINK FIXO revogável) ──
// Token opaco (hash SHA-256+segredo em karate_dojo_portal_links — migration
// 239) enviado em Authorization: Bearer. NÃO substitui o fluxo OTP de
// karateDojoPublic.js (montado abaixo) — a decisão de produto do Canal B
// (ESCOPO 19/06) é link fixo. Montado ANTES dos routers /public/karate pra
// rota fixa /dojo/* nunca ser capturada por padrões /:slug/*.
//   GET  /public/karate/dojo/me
//   GET  /public/karate/dojo/practitioners
//   GET  /public/karate/dojo/annuity
//   POST /public/karate/dojo/annuity/pix
//   GET  /public/karate/dojo/certificates
router.use('/public/karate/dojo', require('./karateDojoPortalPublic'));

// ── AURA KARATÊ — P2.1 (MESA pública do mesário, fora do shell) ──
// Token opaco POR CONVOCAÇÃO (hash SHA-256+segredo em
// karate_competition_officials — migration 302), Authorization: Bearer.
// Escopo = koto ATUAL do mesário (relido a cada request — trocar de koto
// move o acesso junto). Montado ANTES de /public/karate/:slug pelo mesmo
// motivo do portal do dojô (rota fixa nunca capturada por /:slug/*).
//   GET  /public/karate/mesa/me                          — bootstrap (evento+koto+fila)
//   GET/POST/PUT /public/karate/mesa/categories/:catId/* — chave, notas, súmula
router.use('/public/karate/mesa', require('./karateMesaPublic'));

// ── AURA KARATÊ — Track D (público: carteirinha verify + portal + inscrição) ──
// SEM auth de empresa. Auth própria por token/OTP. Migration 164.
//   GET  /public/karate/verify/:token                 — verify carteirinha (mínimo/LGPD)
//   GET  /public/karate/portal/me                      — portal autenticado (OTP→JWT)
//   POST /public/karate/portal/opt-in                  — opt-in portal público (não menores)
//   POST /public/karate/:slug/portal/request-otp       — solicita OTP (genérico)
//   POST /public/karate/:slug/portal/verify-otp        — valida OTP → token de portal
//   GET  /public/karate/:slug/p/:publicToken           — portal público (reduzido)
//   GET  /public/karate/:slug/events                   — agenda pública
//   GET  /public/karate/:slug/inscricao/:eventId       — dados p/ inscrição
//   POST /public/karate/:slug/inscricao/:eventId       — inscrição (exame/curso real; competição 501)
router.use('/public/karate', require('./karatePublic'));

// ── AURA KARATÊ — Track E (público: ranking embelável) ──
// Router separado (mantém karatePublic.js intacto). Migrations 168 + 169.
//   GET /public/karate/:slug/seasons                  — temporadas/categorias
//   GET /public/karate/:slug/ranking?season=&category=— ranking (widget)
//   GET /public/karate/:slug/ranking/:season/:category— atalho REST (iframe)
router.use('/public/karate', require('./karatePublicRanking'));

// ── AURA KARATÊ — P0 Hub de Campeonatos: páginas públicas ──────
// Conferência de inscrições + chaves publicadas (gate por
// conference_published_at / brackets_published_at — 404 PUBLICATION_PENDING
// antes da federação publicar). Substitui o PDF de conferência por e-mail
// e as chaves por WhatsApp.
//   GET /public/karate/:slug/competitions/:cid
//   GET /public/karate/:slug/competitions/:cid/conference
//   GET /public/karate/:slug/competitions/:cid/brackets
//   GET /public/karate/:slug/competitions/:cid/categories/:catId/bracket
router.use('/public/karate', require('./karateCompetitionsPublic'));

// ── AURA KARATÊ — Fase 0 Dojô (Canal B público: OTP do responsável) ──
// POST /public/karate/:slug/dojo/portal/request-otp
// POST /public/karate/:slug/dojo/portal/verify-otp
router.use('/public/karate', require('./karateDojoPublic'));

// ── AURA DOJÔ — F9.1 (público: verificação do certificado PRÓPRIO DO DOJÔ) ──
// Router separado de karatePublic.js (mesmo racional de karateDojoPublic /
// karatePublicRanking / karatePixPublic: vários routers pequenos sob o
// mesmo prefixo). Documento NÃO OFICIAL — a resposta marca
// certificate_type:'dojo' + official:false para nunca ser confundida com
// GET /public/karate/verify/:token (carteirão) nem com o verify do
// certificado OFICIAL da federação (karatePublic.js).
//   GET /public/karate/verify/dojo-cert/:token
router.use('/public/karate', require('./karateDojoCertPublic'));

// ── AURA KARATÊ — Fase F4/PIX: página pública de pagamento (QR + copiar) ──
//   GET /public/karate/pix/:token — valor + competência + BR Code (sem
//       dado pessoal — token stateless, ver karatePixPublicToken.js).
router.use('/public/karate', require('./karatePixPublic'));

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

// ── AURA KARATÊ — Track A (backend cadastros) ────────
// POST /karate/federation/setup (sem escopo de empresa, auth only)
// GET  /federation/:id/dashboard
// GET  /federation/:id/belt-distribution
router.use('/karate', require('./karateFederation'));

// ── AURA DOJÔ — F7.4 (governança da gestão da ficha do praticante) ──
// ⚠️ ORDEM IMPORTA — e aqui ela é o CONTRATO do router, não estilo. Duas das
// rotas dele são INTERCEPTADORES: rodam ANTES do handler real e chamam
// next(). Montado DEPOIS de karatePractitioners/karateDojos, nenhum dos dois
// rodaria (o handler real responde e nunca cede a vez).
//   DELETE /federation/:id/practitioners/:practitionerId — acrescenta à
//     resposta o aviso de que aquela ficha era mantida por um dojô ATIVO e o
//     que aconteceu com o vínculo do aluno. NÃO bloqueia (premissa 2: a
//     federação remove dados).
//   DELETE /federation/:id/dojos/:dojoId — devolve à federação as fichas que
//     aquele dojô mantinha ANTES de a company ser apagada. Sem isso, o
//     ON DELETE SET NULL da FK da migration 262 viola o CHECK
//     customers_karate_identity_coherent e o DELETE inteiro estoura 23514.
// As demais rotas são literais de 2+ segmentos e não colidem com nada:
//   POST /federation/:id/dojos/:dojoId/identity/reclaim (staffWrite + motivo)
//   GET  /federation/:id/identity/exited-dojos          (read)
//   POST /federation/:id/identity/regularize            (staffWrite, ?dry_run=1)
router.use('/federation/:id', require('./karateIdentityGovernance'));

// Praticantes: /import DEVE vir ANTES de /:practitionerId
// para que a string literal 'import' não seja capturada como UUID.
// Ambos montados sob /federation/:id/practitioners
router.use('/federation/:id/practitioners/import', require('./karateImport'));
router.use('/federation/:id/practitioners',        require('./karatePractitioners'));
// Export de dados do dojô (round-trip com o import). Montado ANTES do router
// principal de dojos só por clareza; ambos respondem sob /federation/:id/dojos
// e o caminho /:dojoId/export-data não colide com as rotas de karateDojos.
router.use('/federation/:id/dojos',                require('./karateExportDojo'));
// ⚠️ ORDEM IMPORTA: karateRosterValidation expõe a rota ESTÁTICA
// GET /dojos/roster-progress. karateDojos tem GET /dojos/:dojoId, que é
// curinga e engole qualquer path — o Express tentava usar "roster-progress"
// como UUID e estourava em produção (invalid input syntax for type uuid).
// Rota estática SEMPRE antes da paramétrica.
router.use('/federation/:id/dojos',                require('./karateRosterValidation'));
// F0 Aura Dojô — convite de claim da conta do dojô (owner real):
//   POST/GET/DELETE /federation/:id/dojos/:dojoId/claim-invite
// Paths de 2 segmentos (/:dojoId/claim-invite) não colidem com o curinga
// GET /:dojoId de karateDojos. Migration 240 (não aplicada — defensivo 42P01).
router.use('/federation/:id/dojos',                require('./karateDojoClaim'));
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
// Fase 4: roster do dojô (status + financeiro) — GET /:dojoId/members-standing
router.use('/federation/:id/dojos',                require('./karateDojoRoster'));
// F0 Canal B: gestão do LINK FIXO do portal do dojô (gera/rotaciona/revoga).
// Migration 239 (karate_dojo_portal_links). Path /:dojoId/portal-link não
// colide com /:dojoId de karateDojos (formato distinto).
//   POST   /federation/:id/dojos/:dojoId/portal-link   (staffWrite — devolve token 1x)
//   DELETE /federation/:id/dojos/:dojoId/portal-link   (staffWrite — revoga)
//   GET    /federation/:id/dojos/:dojoId/portal-link   (read — nunca devolve o token)
router.use('/federation/:id/dojos',                require('./karateDojoPortalLink'));
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
// Fase G3: rastro de ações financeiras (quem fez, quando) — GET /audit
router.use('/federation/:id/financial', require('./karateFinanceAuditRead'));

// ── AURA KARATÊ — Track C (backend exames + cursos) ─────
router.use('/federation/:id', require('./karateRequirements'));
router.use('/federation/:id', require('./karateExams'));
router.use('/federation/:id', require('./karateCourses'));

// ── AURA KARATÊ — Track J (certificados: fluxo de pedido) ─────
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

// ── AURA KARATÊ — Track D (admin: carteirinha digital) ─────────
// Migration 164. Somente DADOS (sem geração de imagem no app).
//   POST /federation/:id/practitioners/:practitionerId/issue-card  (staffWrite)
//   GET  /federation/:id/practitioners/:practitionerId/card        (read)
//   GET  /federation/:id/cards                                     (read)
//   POST /federation/:id/cards/issue-batch                         (adminOnly)
// Fila de impressão (migration 233 — sisteminha de gestão A imprimir/Impressa/Entregue):
//   GET  /federation/:id/cards/queue                                (read)
//   POST /federation/:id/cards/queue/mark-printed                   (staffWrite)
//   POST /federation/:id/cards/queue/mark-delivered                 (staffWrite)
//   POST /federation/:id/cards/queue/return-to-queue                (staffWrite)
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

// ── AURA KARATÊ — P0 Hub de Campeonatos: SETUP da competição ────
// Migration 294 (divisões, precificação, ciclo operacional).
//   GET/POST     /federation/:id/competitions/:cid/divisions       (read/staffWrite)
//   PATCH/DELETE /federation/:id/competitions/:cid/divisions/:divId (staffWrite)
//   PATCH        /federation/:id/competitions/:cid/pricing          (staffWrite)
//   GET          /federation/:id/competitions/:cid/delegations      (read)
router.use('/federation/:id', require('./karateCompetitionSetup'));

// ── AURA KARATÊ — P1 Hub: ARBITRAGEM + TERMO DE RESPONSABILIDADE ──
// Migration 298. Cadastro de árbitros/mesários com credencial (A-D),
// convocação/confirmação/escala por koto/presença/multa, e o termo de
// responsabilidade digital por atleta (status por delegação).
//   GET/POST     /federation/:id/officials                      (read/staffWrite)
//   PATCH/DELETE /federation/:id/officials/:officialId           (staffWrite)
//   GET/POST     /federation/:id/competitions/:cid/officials     (read/staffWrite)
//   PATCH/DELETE /federation/:id/competitions/:cid/officials/:rowId (staffWrite)
//   PATCH        /federation/:id/competitions/:cid/waiver-terms  (staffWrite)
//   GET/POST     /federation/:id/competitions/:cid/waivers       (read/staffWrite)
router.use('/federation/:id', require('./karateOfficials'));

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

// ── AURA KARATÊ — H1 (solicitação de criação/transferência de praticante) ──
// Migration 231 (karate_practitioner_requests + índice único federation_id+
// karate_registration_number). O número FPKT é emitido pela FEDERAÇÃO fora
// do sistema — o backend nunca gera/inventa número; só registra na aprovação.
//
// Lado SENSEI (token-gated via requireDojoAccess — Canal A/B, dojo_id
// sempre do token):
//   POST /federation/:id/dojo/practitioner-requests
//   GET  /federation/:id/dojo/practitioner-requests?status=
//   GET  /federation/:id/dojo/practitioner-requests/lookup-fpkt?number=
router.use('/federation/:id', require('./karateDojoPractitionerRequests'));

// ── AURA DOJÔ — F2 (alunos do dojô: registro PRÓPRIO + responsáveis) ──
// Migration 242 (karate_dojo_students + karate_dojo_guardians). DECISÃO
// CENTRAL: o aluno do dojô NÃO escreve em karate_practitioners/customers
// (que são da FEDERAÇÃO) — é registro próprio do dojô; practitioner_id
// fica NULL até o merge/sync com a FPKT ser definido. GETs aceitam Canal
// A e B (portal lê); escrita (POST/PATCH/DELETE) exige Canal A (senão
// 403 PORTAL_READ_ONLY).
//   GET    /federation/:id/dojo/students             (?status=&q=&belt=&tag_id=&summary=1)
//   POST   /federation/:id/dojo/students
//   GET    /federation/:id/dojo/students/:sid        (ficha + responsável)
//   PATCH  /federation/:id/dojo/students/:sid
//   DELETE /federation/:id/dojo/students/:sid        (F3: virará 409 HAS_HISTORY)
//   POST   /federation/:id/dojo/students/import      ({rows:[...]}, máx 500)
//   GET    /federation/:id/dojo/guardians            (+ contagem de alunos)
//   POST   /federation/:id/dojo/guardians
//   PATCH  /federation/:id/dojo/guardians/:gid
router.use('/federation/:id', require('./karateDojoStudents'));

// ── AURA DOJÔ — F3a (motor de mensalidades: planos, assinaturas, cobranças) ──
// Migration 243 (karate_dojo_billing_plans + karate_dojo_subscriptions +
// karate_dojo_charges). CHARGE-BASED: gera-se a cobrança do mês e o aluno
// paga UM PIX por cobrança (Pix Automático só em outubro). Recebedor = chave
// PIX do PRÓPRIO dojô (digital_channel_config do company do dojô, migration
// 088) — BaaS Asaas fica opcional/futuro atrás do karatePaymentProvider.
// GETs aceitam Canal A e B; escrita (POST/PATCH/PUT/DELETE) exige Canal A
// (senão 403 PORTAL_READ_ONLY). Defensivo 42P01 (migration 243 pendente).
//   GET    /federation/:id/dojo/billing/plans
//   POST   /federation/:id/dojo/billing/plans
//   PATCH  /federation/:id/dojo/billing/plans/:pid
//   POST   /federation/:id/dojo/billing/students/:sid/subscribe
//   DELETE /federation/:id/dojo/billing/students/:sid/subscribe
//   GET    /federation/:id/dojo/billing/subscriptions
//   POST   /federation/:id/dojo/billing/generate          ({competence:'YYYY-MM'})
//   GET    /federation/:id/dojo/billing/charges           (?competence=&status=&q=)
//   POST   /federation/:id/dojo/billing/charges/:cid/pix
//   POST   /federation/:id/dojo/billing/charges/:cid/confirm
//   POST   /federation/:id/dojo/billing/charges/:cid/cancel
//   GET    /federation/:id/dojo/billing/config
//   PUT    /federation/:id/dojo/billing/config
// F3b — Conta Aura do dojô (BaaS via subconta Asaas, OPT-IN, flag
// DOJO_BAAS_ENABLED; migration 244 karate_dojo_baas_accounts):
//   GET    /federation/:id/dojo/billing/baas
//   POST   /federation/:id/dojo/billing/baas/activate
//   PUT    /federation/:id/dojo/billing/baas/provider
router.use('/federation/:id', require('./karateDojoBilling'));

// ── AURA DOJÔ — F4 (turmas, matrículas, presença + check-in QR por toggle) ──
// Migration 246 (karate_dojo_classes + karate_dojo_class_enrollments +
// karate_dojo_attendance + karate_dojo_class_settings). Turmas com grade
// semanal (weekdays 0=domingo..6=sábado + HH:MM); matrícula aluno↔turma;
// presença por data (chamada manual = caminho primário; alimenta os
// critérios de exame de faixa — F5). CHECK-IN POR QR é TOGGLE por dojô
// (karate_dojo_class_settings.qr_checkin_enabled, default OFF): token
// STATELESS assinado (HMAC-SHA256, student_id+dojo_id, sem expiração —
// credencial de presença, não de acesso). GETs aceitam Canal A e B; escrita
// exige Canal A (403 PORTAL_READ_ONLY); POST /classes/checkin é Canal A (é o
// dojô escaneando). Defensivo 42P01 (migration 246 pendente). Rotas
// /dojo/students/:sid/{attendance-summary,qr} não colidem com o
// /dojo/students/:sid (1 segmento) de karateDojoStudents.
//   GET/PUT  /federation/:id/dojo/classes/settings                (toggle QR)
//   POST     /federation/:id/dojo/classes/checkin                 (QR — Canal A)
//   GET/POST /federation/:id/dojo/classes
//   PATCH/DELETE /federation/:id/dojo/classes/:cid                (DELETE c/ presença → 409 HAS_HISTORY)
//   GET      /federation/:id/dojo/classes/:cid/students
//   POST     /federation/:id/dojo/classes/:cid/enroll             (409 ALREADY_ENROLLED / 422 inativo)
//   DELETE   /federation/:id/dojo/classes/:cid/enroll/:studentId  (presenças ficam)
//   GET/PUT  /federation/:id/dojo/classes/:cid/attendance         (?date=YYYY-MM-DD / upsert em lote)
//   GET      /federation/:id/dojo/students/:sid/attendance-summary
//   GET      /federation/:id/dojo/students/:sid/qr
router.use('/federation/:id', require('./karateDojoClasses'));

// ── AURA DOJÔ — F11 (tags configuráveis do aluno) ──
// Migration 274 (karate_dojo_tags + karate_dojo_student_tags). Pedido do
// dono do produto: a planilha real do 1º dojô (Areikan, Araraquara/SP, 484
// alunos) tem uma coluna "Academia" (4 locais de treino) que NÃO é modelo
// de "unidade" nem dojô separado — é uma TAG configurável pelo sensei, com
// N tags por aluno (começa em "academia" e cresce para "bolsista",
// "competição" etc). Gerida em Configurações (CRUD completo). Vínculo
// ancorado em karate_dojo_students (nunca em customers — tag é do dojô, e
// aluno não federado também tem tag). Nome único por dojô
// case-insensitive. DELETE só quando a tag nunca foi usada (0 vínculos);
// tag em uso vira 409 TAG_EM_USO — o caminho é desativar (PATCH
// {active:false}), preservando o histórico. GETs aceitam Canal A e B;
// escrita exige Canal A (403 PORTAL_READ_ONLY). Defensivo 42P01 (migration
// 274 pendente). Tag ≠ turma (karateDojoClasses acima): turma tem
// dia/horário e controla presença; tag é rótulo livre. As duas coexistem.
//   GET    /federation/:id/dojo/tags                        (?active=)
//   POST   /federation/:id/dojo/tags
//   PATCH  /federation/:id/dojo/tags/:tid                    (renomear / cor / active)
//   DELETE /federation/:id/dojo/tags/:tid                     (409 TAG_EM_USO se houver vínculo)
//   GET    /federation/:id/dojo/students/:sid/tags
//   POST   /federation/:id/dojo/students/:sid/tags            ({tag_id})
//   DELETE /federation/:id/dojo/students/:sid/tags/:tid
// Filtro na listagem de alunos: GET /federation/:id/dojo/students?tag_id=
// (convive com paginação/busca existentes — ver karateDojoStudentService.js)
router.use('/federation/:id', require('./karateDojoTags'));

// ── AURA DOJÔ — F11.3 (REVISÃO DO PLANTEL HERDADO — lado DOJÔ) ──
// Migration 276 (karate_dojo_roster_reviews + ..._items + ..._notices).
//
// A F11.0–F11.2 (migration 275) fez a conta do sensei PASSAR A SER o
// registro federativo, herdando os praticantes que já apontavam para
// aquela linha. Só que a lista da FPKT está velha: 9.840 praticantes em
// 105 registros, e 74 dojôs marcados como inativos ainda carregam 4.033
// deles. Decisão do dono do produto (10/08/2026): ao assumir o registro o
// sensei REVISA esse plantel e marca quem realmente treina com ele; quem
// ele não reconhece volta para a federação COMO AVISO.
//
// ⚠️ "NÃO RECONHECIDO" NÃO É "INATIVO". O praticante pode ter MUDADO DE
// DOJÔ (karate_practitioner_transfers, 540 linhas). Concluir a revisão NÃO
// INATIVA NINGUÉM — gera avisos, e quem decide (inativar / transferir /
// manter) é a federação, pelo router logo abaixo de
// karateAffiliationRequestsAdmin. A resposta do /complete devolve
// `practitioners_changed:false` para isso ficar no contrato, não só no
// comentário.
//
// VOLUME/RETOMADA: o maior dojô da planilha tem 288 alunos. A listagem é
// paginada com busca, a marcação é EM LOTE (até 500 por chamada) e o
// estado PERSISTE entre sessões — a revisão é criada na primeira marcação
// (nunca num GET) e só fecha no /complete. Reenviar a mesma marcação é
// idempotente; concluir duas vezes não duplica aviso.
//
// SEM gate de conexão, de propósito: plantel herdado só existe para dojô
// que a federação cadastrou, e quem assumiu um registro já está conectado
// por construção. Escrita só Canal A (403 PORTAL_READ_ONLY); GETs A e B.
// Defensivo 42P01 (migration 276 pendente): GETs degradam listando o
// plantel com todo mundo 'pending' + schema_pending; POSTs devolvem 503.
//
// ⚠️ 'roster-review' não colide com nada: /dojo/students, /dojo/tags,
// /dojo/classes, /dojo/own-events etc. são todos prefixos literais
// distintos, e não existe rota /dojo/:algo de 1 segmento paramétrica.
//   GET  /federation/:id/dojo/roster-review            (estado + contagens)
//   GET  /federation/:id/dojo/roster-review/roster     (?q=&status=&review_status=&limit=&offset=)
//   POST /federation/:id/dojo/roster-review/mark       ({practitioner_ids:[], status:'recognized'|'not_recognized'|'pending'})
//   POST /federation/:id/dojo/roster-review/complete   ({pending_policy?:'not_recognized'|'recognized'})
router.use('/federation/:id', require('./karateDojoRosterReview'));

// Lado FEDERAÇÃO (guards de karateRoles — dedup SUGERE, nunca decide):
//   GET   /federation/:id/practitioner-requests?status=&dojo_id=
//   GET   /federation/:id/practitioner-requests/:requestId
//   PATCH /federation/:id/practitioner-requests/:requestId
//   POST  /federation/:id/practitioner-requests/:requestId/approve-create
//   POST  /federation/:id/practitioner-requests/:requestId/approve-transfer
//   POST  /federation/:id/practitioner-requests/:requestId/reject
router.use('/federation/:id', require('./karatePractitionerRequestsAdmin'));

// ── AURA DOJÔ — F6 (conexão/filiação self-serve do dojô à federação) ──
// Migration 252 (karate_affiliation_requests). companies.federation_id é
// vínculo TÉCNICO (roteamento + requireDojoAccess); a VISIBILIDADE para a
// federação é companies.karate_dojo_linked_at (migration 251). Até aqui só
// a federação/admin setava o vínculo — o dojô self-serve ficava invisível
// e sem caminho para pedir. Mesmo formato do H1: pedido → inbox → aceite.
// O ACEITE é o que seta karate_dojo_linked_at (não o pagamento) e o número
// de filiação é SEMPRE digitado pela federação (o backend nunca gera).
//
// Lado DOJÔ (requireDojoAccess; POST só Canal A, Canal B lê):
//   GET  /federation/:id/dojo/connection
//   POST /federation/:id/dojo/connection
router.use('/federation/:id', require('./karateDojoConnection'));
// Lado FEDERAÇÃO (guards de karateRoles). ⚠️ /affiliation-requests/metrics é
// rota ESTÁTICA e já é declarada ANTES de /affiliation-requests/:requestId
// dentro do próprio router (mesma armadilha de /dojos/roster-progress).
//   GET  /federation/:id/affiliation-requests?status=
//   GET  /federation/:id/affiliation-requests/metrics
//   POST /federation/:id/affiliation-requests/:requestId/approve  {fpkt_number}
//   POST /federation/:id/affiliation-requests/:requestId/reject   {reason}
router.use('/federation/:id', require('./karateAffiliationRequestsAdmin'));

// ── AURA DOJÔ — F11.3 (AVISOS DA REVISÃO DO PLANTEL — lado FEDERAÇÃO) ──
// Migration 276. O par do router de revisão montado acima: aqui a FPKT vê
// o que cada dojô comunicou e DECIDE.
//
// O aviso diz uma coisa só: "o sensei do dojô X não reconhece esta pessoa
// como aluno atual dele". Ele NÃO inativa ninguém — a pessoa pode ter
// mudado de dojô. Por isso a listagem traz, lado a lado, o SNAPSHOT do
// momento do aviso e o ESTADO ATUAL do praticante (dojô e is_active de
// hoje, + o derivado practitioner_left_dojo): um praticante que hoje está
// em OUTRO dojô quase sempre é transferência não registrada.
//
// Três decisões, todas humanas e com ator identificado:
//   inactivated → customers.is_active=false (único caminho desta fase que
//                 encosta em is_active);
//   transferred → move o praticante + grava karate_practitioner_transfers
//                 (append-only), no mesmo padrão do approve-transfer;
//   kept        → conferido, fica como está (sem isso a fila nunca esvazia).
// Inativar/transferir são escopados também pelo dojô QUE AVISOU: se a
// pessoa já saiu de lá, 409 PRATICANTE_JA_SAIU_DO_DOJO em vez de mexer em
// quem hoje treina noutro lugar.
//
// ⚠️ /roster-review-notices/metrics é rota ESTÁTICA e já é declarada ANTES
// de /roster-review-notices/:noticeId/... dentro do próprio router (mesma
// armadilha de /dojos/roster-progress).
//   GET  /federation/:id/roster-review-notices           (?decision=&dojo_id=&q=&limit=&offset=)
//   GET  /federation/:id/roster-review-notices/metrics
//   POST /federation/:id/roster-review-notices/:noticeId/decision
//        { decision:'inactivated'|'transferred'|'kept', note?, destination_dojo_id? }
router.use('/federation/:id', require('./karateRosterReviewNoticesAdmin'));

// ── AURA DOJÔ — F5b (as TRÊS trocas federativas dojô ↔ federação) ──
// SEM migration nova: reusa karate_certificate_orders (182, já tem dojo_id
// NOT NULL), karate_belt_exams + karate_belt_exam_candidates (157/192),
// karate_events + karate_event_enrollments (160, curso legado) e
// karate_belt_history / view karate_current_belt (149/229).
//
// REGRA TRANSVERSAL: só participa aluno com practitioner_id NOT NULL — a
// única prova de que a FEDERAÇÃO confirmou o vínculo (migration 253).
// is_federated é a DECLARAÇÃO do sensei e NUNCA autoriza; quem é pulado
// volta com razão acionável (ALUNO_NAO_FEDERADO), nunca sumindo em
// silêncio. Gate de conexão em TODAS as rotas (409 DOJO_NAO_CONECTADO):
// certificado é emitido PELA federação, evento é DA federação e exame é
// julgado pela BANCA — nada disso existe para dojô não conectado.
// Escrita só Canal A (403 PORTAL_READ_ONLY no portal); GETs aceitam A e B.
//
// ⚠️ /dojo/events/:eventId/{enroll,enrollments} têm 3 segmentos e NÃO
// colidem com o GET /dojo/events (1 segmento) de karateDojo.js — mesma
// lógica de /dojo/students/:sid/{attendance-summary,qr} da F4.
//   GET  /federation/:id/dojo/aptos                       (graduações sem pedido)
//   POST /federation/:id/dojo/cert-orders                 ({items:[{student_id, belt_history_id?}]})
//   GET  /federation/:id/dojo/cert-orders                 (?status=&page=&pageSize=)
//   POST /federation/:id/dojo/events/:eventId/enroll      ({student_ids:[uuid]}, idempotente)
//   GET  /federation/:id/dojo/events/:eventId/enrollments
//   POST /federation/:id/dojo/belt-exams/:examId/candidates ({student_ids:[uuid]} — SUBMETE, nunca gradua)
//   GET  /federation/:id/dojo/belt-exams/:examId/candidates
router.use('/federation/:id', require('./karateDojoFederativo'));

// ── AURA DOJÔ — F8.1 (o EXAME DE FAIXA DO DOJÔ) ─────────────
// Migrations 264 (tabelas + teto do sensei no CHECK) e 265 (escolha de
// certificado por aluno + anexo do lote em karate_documents).
//
// REGRA DE NEGÓCIO CORRIGIDA (Caio, 31/07/2026): do 10º kyu ao 1º kyu quem
// examina é o SENSEI; a federação só emite o certificado dos aprovados.
// Banca da federação é EXCLUSIVA de faixa preta. O "O DOJÔ NUNCA GRADUA"
// do cabeçalho de karateDojoFederativo.js continua valendo — mas só para o
// DAN, e o fluxo de candidatos/banca dele NÃO foi tocado.
//
// ⚠️ PREFIXO DISTINTO DE PROPÓSITO: /dojo/belt-exams/:examId/candidates já
// existe na F5b e significa o oposto (submeter candidatos à BANCA). O exame
// do dojô é /dojo/graduation-exams — sem colisão e sem depender da ordem
// de montagem.
//
// SEM gate de conexão: o exame é ato INTERNO do dojô (a 264 deixou
// federation_id nullable justamente porque dojô sem filiação também
// gradua). Só o PEDIDO DE CERTIFICADO é federativo, e a falta de conexão
// volta como motivo POR ALUNO — nunca como 409 que anularia uma graduação
// que já aconteceu. Escrita só Canal A (403 PORTAL_READ_ONLY); GETs A e B.
//   GET    /federation/:id/dojo/belt-ladder                                  (escada FPKT + teto do sensei)
//   POST   /federation/:id/dojo/graduation-exams                             ({exam_date, title?, examiner_name?, notes?})
//   GET    /federation/:id/dojo/graduation-exams                             (?status=&page=&pageSize=)
//   GET    /federation/:id/dojo/graduation-exams/:examId                     (+ resultados + anexos)
//   PATCH  /federation/:id/dojo/graduation-exams/:examId                     (só enquanto draft → 409 se concluído)
//   POST   /federation/:id/dojo/graduation-exams/:examId/cancel
//   POST   /federation/:id/dojo/graduation-exams/:examId/results             ({results:[{student_id, result, to_belt_level, to_belt_kyu?, request_certificate?}]})
//   GET    /federation/:id/dojo/graduation-exams/:examId/attachments
//   POST   /federation/:id/dojo/graduation-exams/:examId/attachments         ({files:[{content, filename, content_type}]})
//   DELETE /federation/:id/dojo/graduation-exams/:examId/attachments/:docId
router.use('/federation/:id', require('./karateDojoBeltExams'));

// ── AURA DOJÔ — F9 (eventos do dojô: curso + seminário + hub unificado) ──
// Migration 269 (karate_dojo_events + karate_dojo_event_enrollments).
//
// Pedido do dono do produto (03/08/2026): "criar evento para exames de
// faixa (Kyu), cursos, seminários, etc., com a estrutura idêntica de
// criação de eventos que já temos na federação." O exame de kyu JÁ EXISTE
// (karate_dojo_belt_exams, F8.1, logo acima) e NÃO é tocado por este
// router — ele tem regra de negócio própria (teto do sensei, ligação com
// karate_belt_history, cascata de certificado) que não se aplica a
// curso/seminário. Este router cobre só o modelo NOVO (curso/seminário) e
// expõe o HUB que junta as duas fontes numa listagem só.
//
// Campeonato do dojô é fase separada (subsistema completo: categorias,
// chaveamento, kata) e NÃO entra aqui — o discriminador `source`/`kind` da
// listagem unificada já deixa espaço para uma terceira fonte entrar depois
// sem quebrar o contrato das duas primeiras (ver migration 269 e
// karateDojoEventService.listEventsHub).
//
// ⚠️ PREFIXO "own-events" (não "events") DE PROPÓSITO: "/dojo/events"
// (1 segmento, karateDojo.js) é a vitrine read-only dos eventos DA
// FEDERAÇÃO, e "/dojo/events/:eventId/enroll" (3 segmentos, F5b logo
// acima) já inscreve em EVENTO DA FEDERAÇÃO por practitioner_id. Reusar
// "events" para o evento PRÓPRIO do dojô colidiria com os dois — mesma
// razão que fez o exame de kyu virar "graduation-exams" em vez de
// "belt-exams". SEM gate de conexão: curso/seminário são atos internos do
// dojô (mesma razão de graduation-exams). Escrita só Canal A (403
// PORTAL_READ_ONLY); GETs aceitam A e B.
//   GET    /federation/:id/dojo/events-hub                          (?kind=&page=&pageSize= — eventos próprios + exame de kyu)
//   POST   /federation/:id/dojo/own-events                          ({kind:'curso'|'seminario', name, event_date, location?, fee_amount?, max_participants?, hours?, description?})
//   GET    /federation/:id/dojo/own-events                          (?kind=&status=&page=&pageSize=)
//   GET    /federation/:id/dojo/own-events/:eventId
//   PATCH  /federation/:id/dojo/own-events/:eventId                 (bloqueado só se cancelado)
//   POST   /federation/:id/dojo/own-events/:eventId/cancel
//   POST   /federation/:id/dojo/own-events/:eventId/enroll          ({student_ids:[uuid]})
//   GET    /federation/:id/dojo/own-events/:eventId/enrollments
//   DELETE /federation/:id/dojo/own-events/:eventId/enrollments/:studentId
router.use('/federation/:id', require('./karateDojoEvents'));

// ── AURA DOJÔ — P0 Hub de Campeonatos: DELEGAÇÃO ────────────────
// Migration 294. O clube inscreve sua delegação (atletas + equipes) num
// campeonato 'open' da federação, vê a cotação composta (taxa única por
// atleta, equipes por prova, isenções por contrapartida) e submete UM
// pedido consolidado. Gate de conexão nas escritas (ato federativo);
// Canal B é somente leitura.
//   GET  /federation/:id/dojo/competitions                        (A+B — vitrine)
//   GET  /federation/:id/dojo/competitions/:cid/categories        (A+B)
//   POST /federation/:id/dojo/competitions/:cid/delegation/quote  (A — dry-run)
//   POST /federation/:id/dojo/competitions/:cid/delegation        (A — submete)
//   GET  /federation/:id/dojo/delegations                         (A+B)
//   GET  /federation/:id/dojo/delegations/:orderId                (A+B)
router.use('/federation/:id', require('./karateDelegations'));

// ── AURA DOJÔ — F9.1 (o CERTIFICADO PRÓPRIO DO DOJÔ) ───────────
// Migration 271 (karate_dojo_certificate_templates + karate_dojo_issued_certificates).
//
// Pedido do dono do produto (04/08/2026): certificado dentro de Eventos,
// idem federação (mesmo editor de layout/logo/selo/título/corpo/assinatura),
// emissão+impressão em massa; a página de certificados vira SOMENTE status
// dos pedidos à federação. Processo: dojô examina → emite o PRÓPRIO
// certificado para os aprovados → pede à federação o certificado OFICIAL
// (fluxo já existente, karateDojoBeltExamService.requestCertificates,
// intocado). Elegibilidade = karate_dojo_belt_exam_results.result='approved'
// do exame do dojô (F8.1, logo acima) — esta tabela NÃO é alterada aqui,
// só lida.
//
// ⚠️ PREFIXO "own-certificates" (não "certificates") DE PROPÓSITO: mesma
// razão de own-events/graduation-exams — /dojo/cert-orders (F5b, acima) já
// significa o PEDIDO OFICIAL à federação. SEM gate de conexão (ato
// interno do dojô). Escrita só Canal A (403 PORTAL_READ_ONLY); GETs A e B.
//   GET    /federation/:id/dojo/certificate-templates
//   POST   /federation/:id/dojo/certificate-templates
//   PATCH  /federation/:id/dojo/certificate-templates/:templateId
//   DELETE /federation/:id/dojo/certificate-templates/:templateId
//   POST   /federation/:id/dojo/certificate-assets                          (selo/assinatura → R2)
//   POST   /federation/:id/dojo/graduation-exams/:examId/own-certificates   (emissão em massa)
//   GET    /federation/:id/dojo/graduation-exams/:examId/own-certificates
//   GET    /federation/:id/dojo/own-certificates                           (status geral)
// Verificação pública: GET /public/karate/verify/dojo-cert/:token (acima).
router.use('/federation/:id', require('./karateDojoCertificates'));

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

// ── AURA KARATÊ — Track L (Saúde da Rede) ─────────
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
