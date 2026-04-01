const express = require('express');
const { requireAuth, requireCompanyAccess, requirePlan } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// SEC-01: requireAuth valida JWT, requireCompanyAccess garante
// que o usuário pertence à empresa de :id (previne IDOR)
router.use(requireAuth);
router.use(requireCompanyAccess());

// ── ESSENCIAL (todos os planos) ──────────────────────────────

// Financeiro core
router.use('/transactions', require('./transactionsBatch'));
router.use('/transactions/categorize', require('./categorize'));
router.use('/transactions', require('./categorize'));
router.use('/prolabore', require('./prolabore'));
router.use('/dre', require('./dre'));
router.use('/financial/history', require('./financialHistory'));

// PDV + Estoque (Essencial)
router.use('/pdv', require('./scanner'));
router.use('/pdv', require('./pdv'));
router.use('/products', require('./productsRanking'));
router.use('/products', require('./barcode'));
router.use('/products', require('./labels'));
router.use('/products/:pid/variants', require('./variants'));

// Contabilidade (Essencial)
router.use('/obligations', require('./fiscalObligations'));
router.use('/guides', require('./guides'));
router.use('/checklist', require('./checklist').checklistRouter);

// Onboarding (Essencial)
router.use('/onboarding', require('./onboarding'));

// Export (Essencial)
router.use('/export', require('./exportReports'));

// Import (Essencial)
router.use('/', require('./importData'));

// Print (Essencial)
router.use('/print', require('./print'));

// Sales analytics (Essencial)
router.use('/sales/analytics', require('./salesAnalytics'));

// Reviews (Essencial)
router.use('/reviews', require('./reviews').reviewsRouter);

// ── NEGOCIO+ (CRM, WhatsApp, Canal, Folha, Agendamento) ─────

// SEC-01: CRM requer plano Negocio ou superior
router.use('/customers', requirePlan('negocio', 'expansao'), require('./crm'));
router.use('/customers', requirePlan('negocio', 'expansao'), require('./retention'));

// Multi-usuário RBAC (Negocio+)
router.use('/members', requirePlan('negocio', 'expansao'), require('./members'));

// Ranking funcionários (Negocio+)
router.use('/employees/ranking', requirePlan('negocio', 'expansao'), require('./employeesRanking'));
router.use('/employees', requirePlan('negocio', 'expansao'), require('./commission'));

// Agendamento / Barbershop (Negocio+)
router.use('/barbershop', requirePlan('negocio', 'expansao'), require('./barbershop'));

// Salão parceiro (Negocio+)
router.use('/salon-partners', requirePlan('negocio', 'expansao'), require('./salonPartner'));

// eSocial ME (Negocio+)
router.use('/esocial', requirePlan('negocio', 'expansao'), require('./esocial'));

// ── EXPANSAO (Verticais, IA, Food) ──────────────────────────

// Odontologia (Expansao ou Add-on vertical)
router.use('/dental', requirePlan('negocio', 'expansao'), require('./dental'));

// Food service (Expansao ou Add-on vertical)
router.use('/food', requirePlan('negocio', 'expansao'), require('./food'));
router.use('/food/orders', requirePlan('negocio', 'expansao'), require('./foodOrders'));
router.use('/food/deliverers', requirePlan('negocio', 'expansao'), require('./foodDeliverers'));
router.use('/food/reports', requirePlan('negocio', 'expansao'), require('./foodReports'));
router.use('/food/ifood', requirePlan('negocio', 'expansao'), require('./foodIfood'));
router.use('/food/waiter', requirePlan('negocio', 'expansao'), require('./foodWaiter'));
router.use('/food/nfce', requirePlan('negocio', 'expansao'), require('./foodNfce'));
router.use('/food/schedule', requirePlan('negocio', 'expansao'), require('./foodSchedule'));

module.exports = router;
