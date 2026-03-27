// ============================================================
// AURA. — Roteador Principal
// ============================================================

const express = require('express');
const router  = express.Router();
const { reviewsRouter, publicReviewsRouter } = require('./reviews');
const { checklistRouter } = require('./checklist');

// BE-01 — Analytics de vendas
router.use('/companies/:id/sales/analytics',    require('./salesAnalytics'));
// BE-02 — Ranking de funcionários
router.use('/companies/:id/employees/ranking',  require('./employeesRanking'));
// BE-03 — Categorias + curva ABC
router.use('/companies/:id/products',           require('./productsRanking'));
// BE-04 — Histórico financeiro
router.use('/companies/:id/financial/history',  require('./financialHistory'));
// BE-05 + BE-07 — CRM + Retenção
router.use('/companies/:id/customers',          require('./crm'));
router.use('/companies/:id/customers',          require('./retention'));
// BE-06 — Avaliações
router.use('/companies/:id/reviews',            reviewsRouter);
router.use('/reviews',                          publicReviewsRouter);
// BE-09 — Multi-usuário RBAC
router.use('/companies/:id/members',            require('./members'));
router.use('/members',                          require('./members'));
// BE-10 — Obrigações fiscais
router.use('/companies/:id/obligations',        require('./fiscalObligations'));
// BE-11 — Módulo Barbearia/Salão
router.use('/companies/:id/barbershop',         require('./barbershop'));
// BE-13/15 — Barcode + Scanner
router.use('/companies/:id/products',           require('./barcode'));
router.use('/companies/:id/products',           require('./labels'));
// BE-15 + PDV-01 — Scanner + PDV
router.use('/companies/:id/pdv',                require('./scanner'));
router.use('/companies/:id/pdv',                require('./pdv'));
// BE-16 — Variantes
router.use('/companies/:id/products/:pid/variants', require('./variants'));
// BE-19/20 — Comissão + Metas
router.use('/companies/:id/employees',          require('./commission'));
// BE-17/18 + FEAT-01 — Gestão Aura
router.use('/admin',                            require('./admin'));
// BE-22 — Salão Parceiro
router.use('/companies/:id/salon-partners',     require('./salonPartner'));
// BE-25 — Módulo Odontologia
router.use('/companies/:id/dental',             require('./dental'));
// BE-25-10 — Assinatura via QR+WebSocket
router.use('/dental',                           require('./dentalSign'));
// INF-04 + PDV-01 — Cupom térmico
router.use('/companies/:id/print',              require('./print'));
// BE-26 — Guia Assistido Universal
router.use('/companies/:id/guides',             require('./guides'));
// BE-27 — Lançamento em Massa + OFX
router.use('/companies/:id/transactions',       require('./transactionsBatch'));
// BE-28 — Importação de Dados
router.use('/companies/:id',                    require('./importData'));
// BE-29 — eSocial ME
router.use('/companies/:id/esocial',            require('./esocial'));

// ── CORE ──────────────────────────────────────────────────────
router.post('/onboarding/cnpj-lookup',          require('./onboarding'));
router.use('/companies/:id/onboarding',         require('./onboarding'));
router.use('/companies/:id/checklist',          checklistRouter);

// ── FINANCEIRO ──────────────────────────────────────────────
router.use('/companies/:id/prolabore',          require('./prolabore'));
router.use('/companies/:id/dre',                require('./dre'));

// ── FOOD SERVICE ──────────────────────────────────────────────
router.use('/companies/:id/food',               require('./food'));
router.use('/companies/:id/food/orders',        require('./foodOrders'));
router.use('/companies/:id/food/deliverers',    require('./foodDeliverers'));
router.use('/companies/:id/food/reports',       require('./foodReports'));
router.use('/companies/:id/food/ifood',         require('./foodIfood'));
router.use('/companies/:id/food/waiter',        require('./foodWaiter'));
router.use('/companies/:id/food/nfce',          require('./foodNfce'));
router.use('/companies/:id/food/schedule',      require('./foodSchedule'));

// Rotas públicas
router.use('/food/table',                       require('./foodWaiter'));
router.use('/food/schedule',                    require('./foodSchedule'));
router.use('/food',                             require('./food'));

module.exports = router;
