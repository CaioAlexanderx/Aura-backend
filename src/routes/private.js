const express = require('express');
const { requireAuth, requireCompanyAccess, requirePlan } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(requireAuth);
router.use(requireCompanyAccess());

// ── ESSENCIAL (todos os planos) ──────────────────────────────

// Dashboard
router.use('/dashboard', require('./dashboard'));
router.use('/dashboard/sparkline', require('./dashboardSparkline'));

// Financeiro
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

// Onboarding + Export + Import + Print
router.use('/onboarding', require('./onboarding'));
router.use('/export', require('./exportReports'));
router.use('/', require('./importData'));
router.use('/print', require('./print'));

// Analytics + Reviews
router.use('/sales/analytics', require('./salesAnalytics'));
router.use('/reviews', require('./reviews').reviewsRouter);

// ── NEGOCIO+ ─────────────────────────────────────────────────

// BE-REV-08: Plan enforcement — CRM, appointments, members, employees
router.use('/customers', requirePlan('negocio', 'expansao'), require('./crm'));
router.use('/customers', requirePlan('negocio', 'expansao'), require('./retention'));
router.use('/customers/ranking-ltv', requirePlan('negocio', 'expansao'), require('./customerRanking'));

// BE-REV-06: Generic appointments (reusable for any vertical)
router.use('/appointments', requirePlan('negocio', 'expansao'), require('./appointments'));

// BE-REV-05: Canal Digital (mini-site + storefront config)
router.use('/digital-channel', requirePlan('negocio', 'expansao'), require('./digitalChannel'));

// Multi-usuario + Funcionarios
router.use('/members', requirePlan('negocio', 'expansao'), require('./members'));
router.use('/employees/ranking', requirePlan('negocio', 'expansao'), require('./employeesRanking'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./commission'));

// Barbershop (vertical-specific, Negocio+ with add-on)
router.use('/barbershop', requirePlan('negocio', 'expansao'), require('./barbershop'));
router.use('/salon-partners', requirePlan('negocio', 'expansao'), require('./salonPartner'));

// eSocial
router.use('/esocial', requirePlan('negocio', 'expansao'), require('./esocial'));

// ── EXPANSAO ─────────────────────────────────────────────────

// Verticais (require add-on activation via Gestao Aura)
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
