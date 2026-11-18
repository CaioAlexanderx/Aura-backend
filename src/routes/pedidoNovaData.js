// ============================================================
// AURA. — "Nova data" do pedido guardado no Caixa (17/11/2026)
//
// PATCH /companies/:id/pedidos/:oid/data  { promised_date: 'YYYY-MM-DD' | null }
//   200 { order, ja_estava }   gravado (ou a mesma data de antes)
//   422 PEDIDO_DATA            sem a chave, data invalida ou que ja passou
//   404 PEDIDO_NAO_ENCONTRADO  nao e pedido do balcao desta loja
//   409 PEDIDO_FECHADO         pedido concluido ou cancelado
//
// Montado em private.js sob /pedidos, DEPOIS de ./pedidosDoBalcao: o
// /companies/:id e o requireCompanyAccess vem de la, como no PATCH /status
// do B3 (no consolidado o app chama a loja DONA do pedido). Sem requirePlan
// (o Pedido e do Essencial). Trava PEDIDO_LIBERADO so nesta rota: desligada,
// 404 como se nao existisse. Regras: services/dataDoPedido.js.
//
// Arquivo proprio para nao brigar no merge com o B4a e o B6, que mexem em
// pedidosDoBalcao.js e pedidoBalcao.js.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const pedidoBalcao = require('../services/pedidoBalcao');
const { mudarDataDoPedido } = require('../services/dataDoPedido');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trava(req, res, next) {
  if (!pedidoBalcao.pedidoLiberado(req)) return res.status(404).json({ error: 'Não encontrado' });
  return next();
}

router.patch('/:oid/data', trava, async (req, res) => {
  const { id: cid, oid } = req.params;
  if (!UUID_RE.test(String(oid))) {
    return res.status(404).json({ error: 'Pedido não encontrado.', code: 'PEDIDO_NAO_ENCONTRADO' });
  }
  try {
    const r = await mudarDataDoPedido(db, {
      companyId: cid,
      orderId: oid,
      body: req.body,
      hoje: pedidoBalcao.hojeSP(),
    });
    return res.json({ order: r.pedido, ja_estava: r.ja_estava });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        ...(err.status_atual ? { status: err.status_atual } : {}),
      });
    }
    // Migration 459 ainda nao aplicada (deploy parcial).
    if (err && (err.code === '42703' || err.code === '42P01')) {
      return res.status(503).json({
        error: 'Os pedidos ainda não estão disponíveis. Tente de novo em instantes.',
        code: 'PEDIDO_INDISPONIVEL',
      });
    }
    console.error('[pedidos:data]', err && err.message, err && err.code);
    return res.status(500).json({
      error: 'Não conseguimos mudar a data do pedido agora. Nada foi alterado. Tente de novo em instantes.',
    });
  }
});

module.exports = router;
