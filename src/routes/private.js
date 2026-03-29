const express = require('express');
const { requireAuth, requireCompanyAccess } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// SEC-01: requireAuth valida JWT, requireCompanyAccess garante
// que o usuário pertence à empresa de :id (previne IDOR)
router.use(requireAuth);
router.use(requireCompanyAccess());

// BE-01 — Analytics de vendas
router.use('/sales/analytics', require('./salesAnalytics'));

// BE-02 — Ranking de funcionários
router.use('/employees/ranking', require('./employeesRanking'));

// BE-03 — Categorias + curva ABC
router.use('/products', require('./productsRanking'));

// BE-04 — Histórico financeiro
router.use('/financial/history', require('./financialHistory'));

// BE-05 + BE-07 — CRM + Retenção
router.use('/customers', require('./crm'));
router.use('/customers', require('./retention'));

// BE-06 — Avaliações internas
router.use('/reviews', require('./reviews').reviewsRouter);

// BE-09 — Multi-usuário RBAC
router.use('/members', require('./members'));

// BE-10 — Obrigações fiscais
router.use('/obligations', require('./fiscalObligations'));

// BE-11 — Módulo Barbearia/Salão
router.use('/barbershop', require('./barbershop'));

// BE-13/15 — Barcode + Labels
router.use('/products', require('./barcode'));
router.use('/products', require('./labels'));

// BE-15 + PDV-01 — Scanner + PDV
router.use('/pdv', require('./scanner'));
router.use('/pdv', require('./pdv'));

// BE-16 — Variantes
router.use('/products/:pid/variants', require('./variants'));

// BE-19/20 — Comissão + Metas
router.use('/employees', require('./commission'));

// BE-22 — Salão Parceiro
router.use('/salon-partners', require('./salonPartner'));

// BE-25 — Módulo Odontologia
router.use('/dental', require('./dental'));

// INF-04 + PDV-01 — Cupom térmico
router.use('/print', require('./print'));

// BE-26 — Guia Assistido Universal
router.use('/guides', require('./guides'));

// BE-27 — Lançamento em Massa + OFX
router.use('/transactions', require('./transactionsBatch'));

// BE-28 — Importação de Dados
router.use('/', require('./importData'));

// BE-29 — eSocial ME
router.use('/esocial', require('./esocial'));

// CORE
router.use('/onboarding', require('./onboarding'));
router.use('/checklist', require('./checklist').checklistRouter);

// FINANCEIRO
router.use('/prolabore', require('./prolabore'));
router.use('/dre', require('./dre'));

// CORE-04 — Categorização automática via IA (Claude Haiku)
router.use('/transactions/categorize', require('./categorize'));
router.use('/transactions', require('./categorize')); // rota /:txId/categorize

// CORE-05 — Exportação PDF + CSV com branding Aura
router.use('/export', require('./exportReports'));

// FOOD SERVICE — privado
router.use('/food', require('./food'));
router.use('/food/orders', require('./foodOrders'));
router.use('/food/deliverers', require('./foodDeliverers'));
router.use('/food/reports', require('./foodReports'));
router.use('/food/ifood', require('./foodIfood'));
router.use('/food/waiter', require('./foodWaiter'));
router.use('/food/nfce', require('./foodNfce'));
router.use('/food/schedule', require('./foodSchedule'));

module.exports = router;
