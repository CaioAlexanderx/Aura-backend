const express = require('express');
const { requireAuth, requireCompanyAccess, requirePlan } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(requireAuth);
router.use(requireCompanyAccess());

// -- ESSENCIAL (todos os planos) --

router.use('/', require('./company'));
router.use('/dashboard', require('./dashboard'));
router.use('/dashboard/sparkline', require('./dashboardSparkline'));
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
// Financeiro v2: Insights agregados (Health Score / Runway / Biggest Lever).
// Onda 1 (04/05/2026) calcula client-side; este endpoint enriquece com dados do server.
router.use('/financeiro', require('./financeiroInsights').companyRouter);
// FIX 07/05/2026: exclui type='troca' do revenue + expoe trocas_count/trocas_net_received
// + adiciona s.type e s.exchange_of_sale_id na listagem /sales
router.use('/pdv', require('./pdv-summary-patch'));
router.use('/pdv', require('./scanner'));
router.use('/pdv', require('./pdv'));
router.use('/', require('./pdvSettings'));
router.use('/caixa', require('./caixa'));
router.use('/products', require('./productsDuplicates'));
router.use('/products', require('./productsBatch'));
router.use('/products', require('./productsVariations'));
router.use('/products', require('./products'));
router.use('/products', require('./productsRanking'));
router.use('/products', require('./productImage'));
router.use('/products', require('./barcode'));
router.use('/products', require('./labels'));
// 07/05/2026: Importacao de DANFE PDF via IA. Gate de plano dentro da rota
// (Negocio = 50/mes, Expansao = ilimitado).
router.use('/products', require('./danfeImport'));
router.use('/products/:pid/variants', require('./variants'));
router.use('/product-categories', require('./productCategories'));
// M-STOCKLINK MSL-02/03: vincula produtos entre CNPJs do mesmo owner.
// Monta o companyRouter no root porque ele tem rotas /products/:pid/master-sku
// (mergeParams pega o :id da empresa pai do private.js).
router.use('/', require('./productLinks').companyRouter);
router.use('/coupons', require('./coupons'));
router.use('/nfce', require('./nfce'));
router.use('/nfe', require('./nfe'));
router.use('/nfse', require('./nfse'));
router.use('/storage', require('./storage'));
router.use('/obligations', require('./fiscalObligations'));
router.use('/obligations', require('./fiscalPdf'));
router.use('/', require('./obligationsReport')); // PR38: POST /obligations/:code/report
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

// 11/05/2026 -- Clientes basico movido pro Essencial.
// Decisao de produto: cadastro de cliente e commodity (Bling/Tiny/etc
// oferecem no plano de entrada). Limite por plano controlado em customers.js:
//   essencial = 1.000
//   negocio   = 5.000
//   expansao  = ilimitado
// CRM avancado (ranking/retencao/birthdays/crediario) continua Negocio+.
router.use('/customers', require('./customers'));

// 12/05/2026 -- PLAN-02: Employees CRUD basico movido pro Essencial.
// Decisao de produto: cadastro de "vendedor" (nome+cargo) e commodity
// pra atribuir vendas no PDV. CPF, admissao, salario, PIS sao opcionais
// no schema -- so exigidos pela UI da Folha (Negocio+). Limite por plano:
//   essencial = 3 funcionarios ativos
//   negocio   = 50
//   expansao  = ilimitado
// Folha de pagamento real (calculo, holerite, comissao, ranking, eSocial)
// continua Negocio+ via mounts especificos abaixo.
router.use('/employees', require('./employees'));

// -- NEGOCIO+ --

router.use('/customers', requirePlan('negocio', 'expansao'), require('./crm'));
router.use('/customers', requirePlan('negocio', 'expansao'), require('./retention'));
router.use('/customers/ranking-ltv', requirePlan('negocio', 'expansao'), require('./customerRanking'));
// Crediario (fiado) por cliente -- gate igual /customers porque depende
// da existencia do CRUD de cliente. Saldo via view, sem integracao com
// Financeiro/contas a receber. Migration 099.
router.use('/credit', requirePlan('negocio', 'expansao'), require('./credit'));
router.use('/birthday', requirePlan('negocio', 'expansao'), require('./birthday'));
// Folha real: payslip por email, ranking de vendas, comissao -- Negocio+.
// CRUD de employees (acima) ja e Essencial; estes endpoints sao o
// 'processamento financeiro recorrente' que justifica o upgrade.
router.use('/employees', requirePlan('negocio', 'expansao'), require('./payslipEmail'));
router.use('/employees/ranking', requirePlan('negocio', 'expansao'), require('./employeesRanking'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./commission'));
router.use('/appointments', requirePlan('negocio', 'expansao'), require('./appointments'));
router.use('/digital-channel', requirePlan('negocio', 'expansao'), require('./digitalChannel'));
router.use('/digital-channel/orders', requirePlan('negocio', 'expansao'), require('./digitalOrders'));
router.use('/digital-channel/asaas', requirePlan('negocio', 'expansao'), require('./asaasSubconta'));
router.use('/members', requirePlan('negocio', 'expansao'), require('./members'));
router.use('/whatsapp', requirePlan('negocio', 'expansao'), require('./whatsappRoutes'));
router.use('/ai/insights', requirePlan('negocio', 'expansao'), require('./aiInsights'));
router.use('/barbershop', requirePlan('negocio', 'expansao'), require('./barbershop'));
router.use('/barbershop', requirePlan('negocio', 'expansao'), require('./barberTier3'));
router.use('/salon-partners', requirePlan('negocio', 'expansao'), require('./salonPartner'));
router.use('/marketplaces', requirePlan('negocio', 'expansao'), require('./marketplace'));
router.use('/esocial', requirePlan('negocio', 'expansao'), require('./esocial'));

// -- EXPANSAO --

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
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalTissRetentions')); // PR40 Sprint B
router.use('/dental/implants',      requirePlan('negocio', 'expansao'), require('./dentalImplants'));
router.use('/dental/ortho',         requirePlan('negocio', 'expansao'), require('./dentalOrtho'));
router.use('/dental/documents',     requirePlan('negocio', 'expansao'), require('./dentalDocuments'));
router.use('/dental/transcribe',    requirePlan('negocio', 'expansao'), require('./dentalTranscription'));
router.use('/dental/supplies',      requirePlan('negocio', 'expansao'), require('./dentalSupplies'));
router.use('/food', requirePlan('negocio', 'expansao'), require('./food'));
router.use('/food/orders', requirePlan('negocio', 'expansao'), require('./foodOrders'));
router.use('/food/deliverers', requirePlan('negocio', 'expansao'), require('./foodDeliverers'));
router.use('/food/reports', requirePlan('negocio', 'expansao'), require('./foodReports'));
router.use('/food/ifood', requirePlan('negocio', 'expansao'), require('./foodIfood'));
router.use('/food/waiter', requirePlan('negocio', 'expansao'), require('./foodWaiter'));
router.use('/food/nfce', requirePlan('negocio', 'expansao'), require('./foodNfce'));
router.use('/food/schedule', requirePlan('negocio', 'expansao'), require('./foodSchedule'));

module.exports = router;
