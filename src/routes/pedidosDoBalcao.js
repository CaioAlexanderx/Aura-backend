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
// POST /pedidos           → 201 {order, avisos} (B1 / p-61a; avisos do B2)
//                           200 {order, idempotent_replay} na mesma chave
//                           409 PEDIDO_SEM_SALDO {faltas} sem saldo livre (B2)
//        B4a: lanca a conta "Pedido a receber" pelo valor cheio; o sinal pode
//        vir junto, em `sinal: {amount, method}` (422 PEDIDO_SINAL_MAIOR se
//        passar do total, e nada e gravado).
// POST /pedidos/:oid/sinal {amount, method} + Idempotency-Key (B4a / p-62a)
//                         → 201 {order, sinal, taxa}
//                           200 {order, sinal, idempotent_replay} na mesma chave
//                           409 PEDIDO_SINAL_JA_PAGO (um sinal por pedido)
//                           409 PEDIDO_FECHADO (concluido ou cancelado)
//                           422 PEDIDO_SINAL_MAIOR / _VALOR / _FORMA
//                           409 CAIXA_REQUIRED (B4b): sinal em dinheiro com o
//                               caixa ligado e fechado (tambem no POST /pedidos)
//        method: dinheiro | pix | cartao (credito) | debito. Regras do
//        dinheiro em services/sinalDoPedido.js.
// POST /pedidos/:oid/cancelar (B6 / p-62e)
//        {refund_kind: 'credito'|'devolucao', refund_method: 'dinheiro'|'pix'|'estorno', reason?}
//                         → 200 {order, cancelamento, ja_estava}
//                           409 PEDIDO_JA_CONCLUIDO / CAIXA_REQUIRED (dinheiro com caixa fechado)
//                           422 PEDIDO_DESTINO_DO_SINAL / PEDIDO_DEVOLUCAO_FORMA / CREDITO_EXIGE_CLIENTE
//        Sem sinal, refund_kind nao e pedido. Regras em services/cancelarPedido.js.
// GET  /pedidos           → {orders, situacao, kpis, counts, pagination} (B3)
//        ?situacao=abertos|aguardando|separando|prontos|concluidos|cancelados|todos
//        &atrasados=1 &q= &page= &limit=   (regras em services/listaDePedidos.js)
// GET  /pedidos/:oid      → {order} com itens, sinal_pago e falta (B3)
// PATCH /pedidos/:oid/status {status: 'preparing'|'ready'} → {order} (B3)
//        "Separar" e "Pronto". So para a frente, so no pedido do balcao, sem
//        e-mail, sem sino, sem baixa. Concluir e pela venda (B5a) e cancelar
//        pela rota propria (B6): aqui sao 400. O PATCH /status do Canal recusa
//        o pedido do balcao (B1) e e Negocio; esta rota e de todo plano.
//
// Trava: PEDIDO_LIBERADO (services/pedidoBalcao.js). Desligada, so a
// equipe Aura usa; para o lojista a rota responde 404 como se nao existisse.
// Regras do pedido e do que ele NAO faz (estoque, caixa, Financeiro, Canal
// Digital): ver o cabecalho de services/pedidoBalcao.js.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const pedidoBalcao = require('../services/pedidoBalcao');
const listaDePedidos = require('../services/listaDePedidos');
const sinalDoPedido = require('../services/sinalDoPedido');
const cancelarPedido = require('../services/cancelarPedido');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAO_ENCONTRADO = { error: 'Pedido não encontrado.', code: 'PEDIDO_NAO_ENCONTRADO' };

function falhar(res, err, contexto, mensagem500) {
  if (err && err.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.order_id ? { order_id: err.order_id } : {}),
      ...(err.faltas ? { faltas: err.faltas } : {}),
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
  if (mensagem500) return res.status(500).json({ error: mensagem500 });
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
    // B2: com "vender sem estoque" ligado, o que passou do saldo livre vem
    // em `avisos` (mesmo formato de `faltas` do 409). [] = tudo livre.
    return res.status(201).json({ order: r.pedido, avisos: r.avisos || [] });
  } catch (err) {
    return falhar(res, err, 'guardar');
  }
});

router.get('/', async (req, res) => {
  try {
    const out = await listaDePedidos.listarPedidos(db, {
      empresas: [req.params.id],
      situacao: req.query.situacao,
      atrasados: req.query.atrasados === '1' || req.query.atrasados === 'true',
      busca: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
      hoje: pedidoBalcao.hojeSP(),
    });
    res.set('Cache-Control', 'no-store');
    return res.json(out);
  } catch (err) {
    return falhar(res, err, 'listar', 'Não conseguimos carregar os pedidos agora. Tente de novo em instantes.');
  }
});

router.get('/:oid', async (req, res) => {
  const { id: cid, oid } = req.params;
  if (!UUID_RE.test(String(oid))) return res.status(404).json(NAO_ENCONTRADO);
  try {
    const pedido = await pedidoBalcao.lerPedidoCompleto(db, cid, oid);
    if (!pedido || pedido.origem !== pedidoBalcao.ORIGEM_BALCAO) return res.status(404).json(NAO_ENCONTRADO);
    // sinal_pago, falta e o sinal (forma e data), lidos de studio_payments.
    await sinalDoPedido.comSinal(db, pedido);
    return res.json({ order: pedido });
  } catch (err) {
    return falhar(res, err, 'detalhe', 'Não conseguimos abrir o pedido agora. Tente de novo em instantes.');
  }
});

// B4a (p-62a): o sinal do pedido guardado. Baixa parcial da conta a receber,
// entrada "Sinal de pedido" sem venda, marco em studio_payments.
router.post('/:oid/sinal', async (req, res) => {
  const { id: cid, oid } = req.params;
  if (!UUID_RE.test(String(oid))) return res.status(404).json(NAO_ENCONTRADO);
  try {
    const r = await sinalDoPedido.receberSinal(db, {
      companyId: cid,
      orderId: oid,
      body: req.body,
      chave: pedidoBalcao.lerChave(req),
      userId: req.user && req.user.id,
    });
    const order = await sinalDoPedido.comSinal(db, await pedidoBalcao.lerPedidoCompleto(db, cid, oid));
    if (r.repetido) {
      res.set('Idempotent-Replayed', 'true');
      return res.status(200).json({ order, sinal: r.sinal, idempotent_replay: true });
    }
    return res.status(201).json({ order, sinal: r.sinal, taxa: r.taxa });
  } catch (err) {
    return falhar(res, err, 'sinal', 'Não deu para registrar o sinal agora. Nada foi lançado. Tente de novo em instantes.');
  }
});

// B6 (p-62e): cancelar. O sinal vira credito na ficha ou e devolvido; a
// conta a receber vai a 'cancelled'. Sem e-mail e sem sino.
router.post('/:oid/cancelar', async (req, res) => {
  const { id: cid, oid } = req.params;
  if (!UUID_RE.test(String(oid))) return res.status(404).json(NAO_ENCONTRADO);
  try {
    const r = await cancelarPedido.cancelarPedido(db, {
      companyId: cid,
      orderId: oid,
      body: req.body,
      userId: req.user && req.user.id,
    });
    const order = await sinalDoPedido.comSinal(db, await pedidoBalcao.lerPedidoCompleto(db, cid, oid));
    return res.json({ order, cancelamento: r.cancelamento, ja_estava: r.ja_estava });
  } catch (err) {
    return falhar(res, err, 'cancelar', 'Não deu para cancelar o pedido agora. Nada foi alterado. Tente de novo em instantes.');
  }
});

// Para onde cada situacao pode ir por aqui (so para a frente).
const DE_ONDE = { preparing: ['confirmed'], ready: ['confirmed', 'preparing'] };
const ROTULO = { confirmed: 'aguardando', preparing: 'separando', ready: 'pronto', delivered: 'concluído', cancelled: 'cancelado' };

router.patch('/:oid/status', async (req, res) => {
  const { id: cid, oid } = req.params;
  const status = String((req.body && req.body.status) || '');
  if (!DE_ONDE[status]) {
    return res.status(400).json({
      error: 'Por aqui o pedido só vai para "Separando" (preparing) ou "Pronto" (ready). Para concluir, use o Caixa; para cancelar, Cancelar pedido.',
      code: 'PEDIDO_STATUS_INVALIDO',
    });
  }
  if (!UUID_RE.test(String(oid))) return res.status(404).json(NAO_ENCONTRADO);
  try {
    const { rows } = await db.query(
      `UPDATE digital_orders SET status = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3 AND origem = 'balcao'
          AND status::text = ANY($4::text[])
        RETURNING id`,
      [status, oid, cid, DE_ONDE[status]]
    );
    if (!rows.length) {
      const { rows: atual } = await db.query(
        `SELECT status::text AS status FROM digital_orders WHERE id = $1 AND company_id = $2 AND origem = 'balcao'`,
        [oid, cid]);
      if (!atual.length) return res.status(404).json(NAO_ENCONTRADO);
      if (atual[0].status === status) {
        return res.json({ order: await pedidoBalcao.lerPedidoCompleto(db, cid, oid), ja_estava: true });
      }
      return res.status(409).json({
        error: `Este pedido está ${ROTULO[atual[0].status] || atual[0].status} e não pode ir para ${ROTULO[status]}.`,
        code: 'PEDIDO_STATUS_CONFLITO',
        status: atual[0].status,
      });
    }
    return res.json({ order: await pedidoBalcao.lerPedidoCompleto(db, cid, oid), ja_estava: false });
  } catch (err) {
    return falhar(res, err, 'status', 'Não conseguimos mudar a situação do pedido agora. Nada foi alterado. Tente de novo em instantes.');
  }
});

module.exports = router;
