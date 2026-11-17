// ============================================================
// AURA. — Pedidos guardados no Caixa (pedido separado de venda)
//
// Montado em private.js sob /pedidos (o /companies/:id e o
// requireCompanyAccess vem de la). SEM requirePlan no prefixo: o Caixa e de
// todo plano, e a chave do modulo (vendas.pedidos, card B3) e do Essencial
// (pendencia 1 do mockup de 17/11). Por isso NAO mora em
// /digital-channel/orders: aquele prefixo tem requirePlan('negocio') e
// responderia 403 para o Essencial (o requirePlan de um router.use vale para
// todo caminho abaixo dele).
//
// POST /pedidos           → 201 {order} (B1 / p-61a)
//                           200 {order, idempotent_replay} na mesma chave
//
// Trava: PEDIDO_LIBERADO (services/pedidoBalcao.js). Desligada, so a
// equipe Aura usa; para o lojista a rota responde 404 como se nao existisse.
// Regras do pedido e do que ele NAO faz (estoque, caixa, Financeiro, Canal
// Digital): ver o cabecalho de services/pedidoBalcao.js.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const pedidoBalcao = require('../services/pedidoBalcao');

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.order_id ? { order_id: err.order_id } : {}),
    });
  }
  // Migration 459 ainda nao aplicada (deploy parcial).
  if (err && (err.code === '42703' || err.code === '42P01')) {
    return res.status(503).json({
      error: 'Os pedidos ainda não estão disponíveis. Tente de novo em instantes.',
      code: 'PEDIDO_INDISPONIVEL',
    });
  }
  console.error(`[pedidos:${contexto}]`, err && err.message, err && err.code);
  return res.status(500).json({
    error: 'Não deu para guardar o pedido agora. Nada foi cobrado e o carrinho continua como estava. Tente de novo em instantes.',
  });
}

// Trava do recurso: desligada, a rota nao existe para o lojista.
router.use((req, res, next) => {
  if (!pedidoBalcao.pedidoLiberado(req)) return res.status(404).json({ error: 'Não encontrado' });
  return next();
});

router.post('/', async (req, res) => {
  try {
    const r = await pedidoBalcao.guardarPedido({
      companyId: req.params.id,
      userId: req.user && req.user.id,
      body: req.body,
      chave: pedidoBalcao.lerChave(req),
    });
    if (r.repetido) {
      res.set('Idempotent-Replayed', 'true');
      return res.status(200).json({ order: r.pedido, idempotent_replay: true });
    }
    return res.status(201).json({ order: r.pedido });
  } catch (err) {
    return falhar(res, err, 'guardar');
  }
});

module.exports = router;
