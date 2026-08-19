const express = require('express');
const { requireAuth, requireCompanyAccess, requirePlan } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(requireAuth);
router.use(requireCompanyAccess());

router.use('/', require('./company'));
router.use('/dashboard', require('./dashboard'));
router.use('/dashboard/sparkline', require('./dashboardSparkline'));
router.use('/commercial-dates', require('./commercialDates'));
router.use('/transactions', require('./transactions'));
router.use('/transactions', require('./transactionsBatch'));
router.use('/transactions/categorize', require('./categorize'));
router.use('/transactions', require('./categorize'));
router.use('/', require('./transactionSale'));
router.use('/prolabore', require('./prolabore'));
router.use('/dre', require('./dre'));
router.use('/financial/history', require('./financialHistory'));
router.use('/financial/analysis', require('./financialAnalysis'));
router.use('/bank', require('./bankReconciliation'));
router.use('/financeiro', require('./financeiroInsights').companyRouter);
router.use('/financeiro', require('./financeiroComparative').companyRouter);
router.use('/pdv', require('./pdv-summary-patch'));
router.use('/pdv', require('./scanner'));
router.use('/pdv', require('./pdv'));
router.use('/', require('./pdvSettings'));
router.use('/caixa', require('./caixa'));
// F0 Bloco B2 (30/07/2026): categoryMigration atende /categories/migration/*
// e /products/brand-candidates + /products/brand/apply, com os caminhos ja
// completos dentro do proprio router -- por isso monta na RAIZ. Tem que vir
// ANTES de todos os mounts de /products: ./products tem GET /:id curinga e
// capturaria 'brand-candidates' como uuid. Rota estatica sempre antes da
// parametrica.
router.use('/', require('./categoryMigration'));
// E1 (F0): GET /catalog/health -- indice de saude do catalogo. Path
// proprio e estatico, sem colisao com os mounts de /products.
router.use('/', require('./catalogHealth'));
// F0 IA de descricao (18/08/2026): TODAS as rotas comecam por
// `descriptions`, que e ESTATICO, e ./products tem GET /:id curinga --
// montar depois faria o Express tratar 'descriptions' como uuid e estourar
// "invalid input syntax for type uuid". Mesma armadilha do Bloco B1 abaixo.
router.use('/products', require('./productDescriptions'));
router.use('/products', require('./productsDuplicates'));
router.use('/products', require('./productsBatch'));
router.use('/products', require('./productsVariations'));
// F0 Bloco B1 (30/07/2026): productLinksRouter expoe /products/unclassified
// e /products/categories/bulk (estaticas) -- tem que montar ANTES de
// require('./products') por causa do GET/PATCH/DELETE /:pid dele.
router.use('/products', require('./productCategories').productLinksRouter);
router.use('/products', require('./products'));
router.use('/products', require('./productsRanking'));
router.use('/products', require('./productImage'));
router.use('/products', require('./variantImage'));
router.use('/products', require('./barcode'));
router.use('/products', require('./labels'));
router.use('/products', require('./danfeImport'));
router.use('/products/:pid/variants', require('./variants'));
router.use('/product-categories', require('./productCategories').categoriesRouter);
router.use('/', require('./productLinks').companyRouter);
router.use('/coupons', require('./coupons'));
router.use('/nfce', require('./nfce'));
router.use('/nfe', require('./nfe'));
router.use('/nfse', require('./nfse'));
router.use('/storage', require('./storage'));
router.use('/obligations', require('./fiscalObligations'));
router.use('/obligations', require('./fiscalPdf'));
router.use('/', require('./obligationsReport'));
router.use('/guides', require('./guides'));
router.use('/checklist', require('./checklist').checklistRouter);
router.use('/onboarding', require('./onboarding'));
router.use('/export', require('./exportReports'));
router.use('/', require('./importData'));
router.use('/print', require('./print'));
router.use('/sales/analytics', require('./salesAnalytics'));
router.use('/sales', require('./sales'));
router.use('/reviews', require('./reviews').reviewsRouter);
router.use('/modules', require('./modules'));
router.use('/billing', require('./billing'));
router.use('/support', require('./support'));
router.use('/customers', require('./customers'));
router.use('/employees', require('./employees'));
// Notificações do app (endomarketing banners + avisos de pedido) — sem gate de plano
router.use('/notifications', require('./notifications'));
// 02/08/2026 — Ranking de vendedores liberado pro Essencial.
//
// O ranking saiu da tela de Folha e virou aba propria em /vendas no app. Ele e
// leitura de VENDA (quem vendeu quanto no periodo), nao de folha de pagamento:
// quem esta no Essencial cadastra vendedores (limite 3) e atribui venda no PDV,
// entao precisa enxergar o resultado disso. Segue a regra da casa de nunca
// bloquear GET de leitura por plano (CLAUDE.md, armadilha 3) e o precedente de
// `clientes`, liberado em 11/05/2026 pelo mesmo motivo.
//
// Continua gateado em Negocio+: folha de fato (payslipEmail), comissoes
// (commission) e metas (goals, no bloco Expansao).
//
// ATENCAO -- a POSICAO deste mount importa e por isso ele subiu pra ca.
// Nao bastava tirar o requirePlan da linha antiga: ela ficava DEPOIS de
//   router.use('/employees', requirePlan('negocio','expansao'), payslipEmail)
// e o requirePlan de um app.use roda pra QUALQUER path abaixo do prefixo --
// inclusive /employees/ranking. Como requirePlan responde 403 direto (nao
// chama next()), o Essencial levava 403 do mount do payslipEmail antes de
// chegar no router de ranking. Mantendo o mount aqui em cima, antes de
// qualquer /employees gateado, a rota fica de fato acessivel.
router.use('/employees/ranking', require('./employeesRanking'));

router.use('/customers', requirePlan('negocio', 'expansao'), require('./crm'));
router.use('/customers', requirePlan('negocio', 'expansao'), require('./retention'));
router.use('/customers/ranking-ltv', requirePlan('negocio', 'expansao'), require('./customerRanking'));
// Decomposicao credit.js (passo 1, 11/06/2026): /balances isolado, montado ANTES de ./credit
// para atender GET /credit/balances com a flag de atraso calculada por data (relato #1).
router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditBalances'));
// Credito Livre (02/08/2026): GET /credit/leads -- clientes que ja compraram no
// crediario e hoje estao zerados, como lead de venda. Mesma razao do /balances
// pra montar ANTES de ./credit: rota estatica antes de qualquer curinga.
router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditLeads'));
router.use('/credit', requirePlan('negocio', 'expansao'), require('./credit'));
router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditInstallments'));
// B4 (11/06/2026): devolucao de venda no crediario -- POST /credit/sales/:saleId/refund
router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditRefund'));
// Item 3 (13/06/2026): unificacao de carne -- GET+POST /credit/customers/:cid/accounts/:accountId/unify
router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditUnify'));
// Item 2 (16/06/2026): renegociacao de parcelas -- GET+POST /credit/customers/:cid/accounts/:accountId/reschedule
router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditReschedule'));
// F2-2B (29/05/2026): preview 360 + quick-customer
router.use('/credit', requirePlan('negocio', 'expansao'), require('./creditPreview'));
// F2-2D (29/05/2026): a receber crediario no Financeiro
router.use('/financial', requirePlan('negocio', 'expansao'), require('./financialReceivables'));
router.use('/birthday', requirePlan('negocio', 'expansao'), require('./birthday'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./payslipEmail'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./commission'));
router.use('/appointments', requirePlan('negocio', 'expansao'), require('./appointments'));
router.use('/digital-channel', requirePlan('negocio', 'expansao'), require('./digitalChannel'));
router.use('/digital-channel/orders', requirePlan('negocio', 'expansao'), require('./digitalOrders'));
router.use('/digital-channel/asaas', requirePlan('negocio', 'expansao'), require('./asaasSubconta'));
router.use('/payment-gateways', requirePlan('negocio', 'expansao'), require('./paymentGateways'));
router.use('/members', requirePlan('negocio', 'expansao'), require('./members'));
router.use('/whatsapp', requirePlan('negocio', 'expansao'), require('./whatsappRoutes'));
router.use('/ai/insights', requirePlan('negocio', 'expansao'), require('./aiInsights'));
router.use('/barbershop', requirePlan('negocio', 'expansao'), require('./barbershop'));
router.use('/barbershop', requirePlan('negocio', 'expansao'), require('./barberTier3'));
router.use('/salon-partners', requirePlan('negocio', 'expansao'), require('./salonPartner'));
router.use('/marketplaces', requirePlan('negocio', 'expansao'), require('./marketplace'));
router.use('/marketplaces', requirePlan('negocio', 'expansao'), require('./marketplaceAuth'));
router.use('/esocial', requirePlan('negocio', 'expansao'), require('./esocial'));

router.use('/ai', requirePlan('negocio', 'expansao'), require('./aiChat'));
router.use('/cashflow', requirePlan('expansao'), require('./cashFlowProjection'));
router.use('/goals', requirePlan('expansao'), require('./salesGoals'));
router.use('/margin', requirePlan('expansao'), require('./productMargin'));
router.use('/dre-simples', requirePlan('expansao'), require('./dreSimples'));
router.use('/alerts', requirePlan('expansao'), require('./smartAlerts'));
router.use('/reactivation', requirePlan('expansao'), require('./customerReactivation'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dental'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalDashboard'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalFunnel'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalBilling'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalRepasse'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalPortal'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalAutomation'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalTissRetentions'));
router.use('/dental/implants',   requirePlan('negocio', 'expansao'), require('./dentalImplants'));
router.use('/dental/ortho',      requirePlan('negocio', 'expansao'), require('./dentalOrtho'));
router.use('/dental/documents',  requirePlan('negocio', 'expansao'), require('./dentalDocuments'));
router.use('/dental/transcribe', requirePlan('negocio', 'expansao'), require('./dentalTranscription'));
router.use('/dental/supplies',   requirePlan('negocio', 'expansao'), require('./dentalSupplies'));
router.use('/food', requirePlan('negocio', 'expansao'), require('./food'));
router.use('/food/orders', requirePlan('negocio', 'expansao'), require('./foodOrdersDispatch'));
router.use('/food/orders', requirePlan('negocio', 'expansao'), require('./foodOrders'));
router.use('/food/deliverers', requirePlan('negocio', 'expansao'), require('./foodDeliverers'));
router.use('/food/dispatch', requirePlan('negocio', 'expansao'), require('./foodDispatch'));
router.use('/food/reports', requirePlan('negocio', 'expansao'), require('./foodReports'));
router.use('/food/ifood', requirePlan('negocio', 'expansao'), require('./foodIfood'));
router.use('/food/waiter', requirePlan('negocio', 'expansao'), require('./foodWaiter'));
router.use('/food/nfce', requirePlan('negocio', 'expansao'), require('./foodNfce'));
router.use('/food/schedule', requirePlan('negocio', 'expansao'), require('./foodSchedule'));
router.use('/food/hub', requirePlan('negocio', 'expansao'), require('./foodHub'));

// Aura Studio: vertical contratada, gateada por plano (negocio+expansao) como
// os demais verticais. Gate restaurado em 10/06/2026 (Onda 1 -- 1.2, decisao
// Caio); requirePlan ja era o padrao de food/dental/etc. O toggle
// pdv_settings.studio_enabled + module_overrides seguem como gate de UI no
// aura-app; aqui o gate de API e por plano, igual aos outros verticais.
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studio'));
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioPainel'));
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioKdsApproval'));
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioBulkHub'));
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioUpload'));
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioBulkConvert'));
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioSaleItemPatch'));
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioMarketplaceListing'));
// Camada 1 — Orçamento + Precificação + Pagamentos (30/05/2026)
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioQuotes'));    // Fase A: Orçamento como entidade
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioPricing'));   // Fase B: Motor de precificação
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioPayments'));  // Fase C: Sinal / pagamento parcial
// Agente B (02/06/2026): status de onboarding derivado (read-only, sem migration)
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioOnboardingStatus'));
// F0 Visual Engine (02/07/2026): templates visuais 2D/3D globais mantidos pela
// Aura (CRUD staff-only) + registro de renders com content_hash (base da
// aprovação formal da F2). Contrato no chat c/ Caio.
router.use('/studio', requirePlan('negocio', 'expansao'), require('./studioVisualTemplates'));

module.exports = router;
