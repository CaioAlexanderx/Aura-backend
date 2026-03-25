// ============================================================
// AURA. — Roteador Principal
// ============================================================

const express = require('express');
const router  = express.Router();
const { reviewsRouter, publicReviewsRouter } = require('./reviews');

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
router.use('/companies/:id/pdv',                require('./scanner'));

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

// BE-25-10 — Assinatura via QR+WebSocket (rotas públicas)
router.use('/dental',                           require('./dentalSign'));

// INF-04 — Impressão window.print()
router.use('/companies/:id/print',              require('./print'));

// BE-26 — Guia Assistido Universal
router.use('/companies/:id/guides',             require('./guides'));

// BE-27 — Lançamento em Massa + Importação OFX
// Nota: registrado ANTES do roteador genérico de transactions para evitar conflito
router.use('/companies/:id/transactions',       require('./transactionsBatch'));

// BE-28 — Importação de Dados (clientes, produtos, NF-e XML)
// Registrar em /companies/:id para compartilhar o prefixo correto
router.use('/companies/:id',                    require('./importData'));

module.exports = router;
