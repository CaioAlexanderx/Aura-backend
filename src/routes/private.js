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
router.use('/pdv', require('./scanner'));
router.use('/pdv', require('./pdv'));
router.use('/', require('./pdvSettings'));
router.use('/products', require('./productsDuplicates'));
router.use('/products', require('./products'));
router.use('/products', require('./productsRanking'));
router.use('/products', require('./productImage'));
router.use('/products', require('./barcode'));
router.use('/products', require('./labels'));
router.use('/products/:pid/variants', require('./variants'));
router.use('/product-categories', require('./productCategories'));
router.use('/coupons', require('./coupons'));
router.use('/nfce', require('./nfce'));
router.use('/nfe', require('./nfe'));
router.use('/storage', require('./storage'));
router.use('/obligations', require('./fiscalObligations'));
router.use('/obligations', require('./fiscalPdf'));
router.use('/guides', require('./guides'));
router.use('/checklist', require('./checklist').checklistRouter);
router.use('/onboarding', require('./onboarding'));
router.use('/export', require('./exportReports'));
router.use('/', require('./importData'));
router.use('/print', require('./print'));
router.use('/sales/analytics', require('./salesAnalytics'));
router.use('/reviews', require('./reviews').reviewsRouter);
router.use('/modules', require('./modules'));
router.use('/billing', require('./billing'));
router.use('/support', require('./support'));

// -- NEGOCIO+ --

router.use('/customers', requirePlan('negocio', 'expansao'), require('./customers'));
router.use('/customers', requirePlan('negocio', 'expansao'), require('./crm'));
router.use('/customers', requirePlan('negocio', 'expansao'), require('./retention'));
router.use('/customers/ranking-ltv', requirePlan('negocio', 'expansao'), require('./customerRanking'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./employees'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./payslipEmail'));
router.use('/employees/ranking', requirePlan('negocio', 'expansao'), require('./employeesRanking'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./commission'));
router.use('/appointments', requirePlan('negocio', 'expansao'), require('./appointments'));
router.use('/digital-channel', requirePlan('negocio', 'expansao'), require('./digitalChannel'));
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
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalFunnel'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalBilling'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalRepasse'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalPortal'));
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dentalAutomation'));
router.use('/food', requirePlan('negocio', 'expansao'), require('./food'));
router.use('/food/orders', requirePlan('negocio', 'expansao'), require('./foodOrders'));
router.use('/food/deliverers', requirePlan('negocio', 'expansao'), require('./foodDeliverers'));
router.use('/food/reports', requirePlan('negocio', 'expansao'), require('./foodReports'));
router.use('/food/ifood', requirePlan('negocio', 'expansao'), require('./foodIfood'));
router.use('/food/waiter', requirePlan('negocio', 'expansao'), require('./foodWaiter'));
router.use('/food/nfce', requirePlan('negocio', 'expansao'), require('./foodNfce'));
router.use('/food/schedule', requirePlan('negocio', 'expansao'), require('./foodSchedule'));

module.exports = router;
