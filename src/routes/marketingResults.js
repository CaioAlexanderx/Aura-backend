// ============================================================
// AURA — FASE 1 do CRM: resultado das mensagens de marketing
//
// "42 mensagens → 6 voltaram → R$ 1.870" — o card que fecha o loop que a
// Fase 7/8 abriu (reativação e aniversário pelo WhatsApp oficial): o
// lojista via a mensagem sair e nunca via se ela vendeu algo. A regra de
// atribuição (direta por cupom, estimada por last-touch de 5 dias) mora
// em services/marketingAttribution.js — pura e testável; aqui só o
// contrato HTTP.
//
// requirePlan('negocio','expansao') no mount (private.js): mesma régua
// da reativação (customerReactivation.js) e do aniversário (birthday.js)
// — a mensagem que gerou o resultado já exige um desses planos.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireAuth } = require('../middleware/auth');
const attribution = require('../services/marketingAttribution');

// GET /marketing/results?kind=reactivation|birthday|all&from=&to=
router.get('/results', requireAuth, async (req, res) => {
  try {
    const resultado = await attribution.buildResults(req.params.id, {
      kind: req.query.kind,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(attribution.publicShape(resultado));
  } catch (err) {
    console.error('[marketing/results] GET /results:', err.message);
    res.status(500).json({ error: 'Erro ao calcular o resultado das mensagens' });
  }
});

// GET /marketing/results/by-customer?kind=&from=&to= — top 20 por receita
router.get('/results/by-customer', requireAuth, async (req, res) => {
  try {
    const itens = await attribution.buildByCustomer(req.params.id, {
      kind: req.query.kind,
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ items: itens });
  } catch (err) {
    console.error('[marketing/results] GET /results/by-customer:', err.message);
    res.status(500).json({ error: 'Erro ao montar o detalhe por cliente' });
  }
});

module.exports = router;
