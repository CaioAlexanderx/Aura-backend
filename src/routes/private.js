const express = require('express');
const { requireAuth, requireCompanyAccess, requirePlan } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(requireAuth);
router.use(requireCompanyAccess());

// ── ESSENCIAL (todos os planos) ──────────────────────────────

// PERF-01: Dashboard agregado
router.use('/dashboard', require('./dashboard'));

// BE-REV-02: Sparkline standalone
router.use('/dashboard/sparkline', require('./dashboardSparkline'));

// Financeiro core
router.use('/transactions', require('./transactionsBatch'));
router.use('/transactions/categorize', require('./categorize'));
router.use('/transactions', require('./categorize'));
router.use('/prolabore', require('./prolabore'));
router.use('/dre', require('./dre'));
router.use('/financial/history', require('./financialHistory'));

// PDV + Estoque
router.use('/pdv', require('./scanner'));
router.use('/pdv', require('./pdv'));
router.use('/products', require('./productsRanking'));
router.use('/products', require('./barcode'));
router.use('/products', require('./labels'));
router.use('/products/:pid/variants', require('./variants'));

// Contabilidade
router.use('/obligations', require('./fiscalObligations'));
router.use('/guides', require('./guides'));
router.use('/checklist', require('./checklist').checklistRouter);

// Onboarding
router.use('/onboarding', require('./onboarding'));

// Export + Import + Print
router.use('/export', require('./exportReports'));
router.use('/', require('./importData'));
router.use('/print', require('./print'));

// Sales analytics + Reviews
router.use('/sales/analytics', require('./salesAnalytics'));
router.use('/reviews', require('./reviews').reviewsRouter);

// ── NEGOCIO+ ─────────────────────────────────────────────────

// CRM + Ranking LTV
router.use('/customers', requirePlan('negocio', 'expansao'), require('./crm'));
router.use('/customers', requirePlan('negocio', 'expansao'), require('./retention'));
router.use('/customers/ranking-ltv', requirePlan('negocio', 'expansao'), require('./customerRanking'));

// Multi-usuário
router.use('/members', requirePlan('negocio', 'expansao'), require('./members'));

// BE-REV-04: Ranking funcionários com link PDV
router.use('/employees/ranking', requirePlan('negocio', 'expansao'), require('./employeesRanking'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./commission'));

// Agendamento
router.use('/barbershop', requirePlan('negocio', 'expansao'), require('./barbershop'));
router.use('/salon-partners', requirePlan('negocio', 'expansao'), require('./salonPartner'));
router.use('/esocial', requirePlan('negocio', 'expansao'), require('./esocial'));

// ── EXPANSAO ─────────────────────────────────────────────────

router.use('/dental', requirePlan('negocio', 'expansao'), require('./dental'));
router.use('/food', requirePlan('negocio', 'expansao'), require('./food'));
router.use('/food/orders', requirePlan('negocio', 'expansao'), require('./foodOrders'));
router.use('/food/deliverers', requirePlan('negocio', 'expansao'), require('./foodDeliverers'));
router.use('/food/reports', requirePlan('negocio', 'expansao'), require('./foodReports'));
router.use('/food/ifood', requirePlan('negocio', 'expansao'), require('./foodIfood'));
router.use('/food/waiter', requirePlan('negocio', 'expansao'), require('./foodWaiter'));
router.use('/food/nfce', requirePlan('negocio', 'expansao'), require('./foodNfce'));
router.use('/food/schedule', requirePlan('negocio', 'expansao'), require('./foodSchedule'));

module.exports = router;
