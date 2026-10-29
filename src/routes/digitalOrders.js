// ============================================================
// AURA. — Canal Digital: Pedidos (Admin)
// GET    /companies/:id/digital-channel/orders
// GET    /companies/:id/digital-channel/orders/:oid
// PATCH  /companies/:id/digital-channel/orders/:oid/status
// POST   /companies/:id/digital-channel/orders/:oid/approve-payment
// POST   /companies/:id/digital-channel/orders/:oid/reject-payment
// DELETE /companies/:id/digital-channel/orders/:oid    (21/05/2026)
//
// fix (22/05/2026): approve-payment chama notifyPaymentConfirmed para
// enviar e-mail de confirmação ao cliente após aprovação manual do Pix.
//
// 01/09/2026: os mesmos três pontos passam a gravar EVENTO DURÁVEL no sino
// (services/lojaEvents.js). notify.* fala com o CLIENTE (e-mail/push); os
// lojaEvents.emit falam com a LOJISTA e ficam no app até serem lidos —
// antes disso, o que acontecia depois do pedido não aparecia em lugar nenhum.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const notify = require('../services/digitalOrderNotifications');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');
// Cancelar devolve o estoque, so quando houve baixa (19/10/2026).
const { devolverEstoqueDoPedido } = require('../services/devolucaoDoEstoqueDoPedido');
const lojaEvents = require('../services/lojaEvents');
// Pagar na entrega com aceite (tq-44, 29/10/2026).
const aceite = require('../services/aceiteDoPedido');
const { AGUARDANDO_ACEITE, fraseDoPagamento, trocoALevar, usaFluxoComAceite } = require('../services/pagarNaEntrega');
// Aviso a cliente pelo wa.me da lojista, com texto pronto (tq-47).
const { avisoDoPedido, precisaDevolver } = require('../services/avisoDoPedidoNoWhatsapp');

/** Nome da loja como a cliente conhece (nome do site, fantasia ou razao). */
async function nomeDaLoja(cid) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(NULLIF(dcc.site_name, ''), c.trade_name, c.legal_name) AS nome
         FROM companies c
         LEFT JOIN digital_channel_config dcc ON dcc.company_id = c.id
        WHERE c.id = $1 LIMIT 1`, [cid]);
    return (rows[0] && rows[0].nome) || '';
  } catch (_) {
    return '';
  }
}

/** O aviso de um passo (ou do status atual), com o nome da loja. null = nenhum. */
async function avisoComLoja(cid, order, passo) {
  try {
    const base = avisoDoPedido(order, { passo: passo || undefined });
    if (!base) return null;
    return avisoDoPedido(order, { loja: await nomeDaLoja(cid), passo: base.passo });
  } catch (_) {
    return null;
  }
}

/** A loja usa a fila com aceite (formas de pagar na entrega marcadas)? */
async function lojaComAceite(cid) {
  try {
    const { rows } = await db.query(
      `SELECT pay_on_delivery_enabled, pay_on_delivery_methods FROM digital_channel_config WHERE company_id = $1`, [cid]);
    return usaFluxoComAceite(rows[0]);
  } catch (_) {
    return false; // base sem a migration 420
  }
}

// GET — Lista pedidos com filtro por status e paginação
// Fila de pedidos (10/09/2026): consulta e apresentacao em um servico testavel.
const { montarConsultaDaFila, apresentarLinhaDaFila, nomeLegivelDoItem } = require('../services/filaDePedidos');

// Cache por processo: a base ja tem as colunas da migration 420?
let filaComEntrega = true;

router.get('/', async (req, res) => {
  const cid = req.params.id;
  const { status, page = 1, limit = 20, q } = req.query;
  const pagina = Math.max(1, parseInt(page, 10) || 1);
  const porPagina = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pagina - 1) * porPagina;

  try {
    // 10/09/2026: a consulta mora em services/filaDePedidos.js — busca por
    // numero/telefone/texto e foto + nome do primeiro item. A lista antiga
    // so devolvia a contagem de itens e nao tinha busca.
    // tq-44: com as colunas do pagar na entrega (migration 420) quando a
    // base ja as tem; no 42703 segue sem, como antes, e lembra.
    let rows;
    try {
      const consulta = montarConsultaDaFila({ cid, status, q, limit: porPagina, offset, comEntrega: filaComEntrega });
      ({ rows } = await db.query(consulta.sql, consulta.params));
    } catch (e) {
      if (e.code !== '42703' || !filaComEntrega) throw e;
      filaComEntrega = false;
      const consulta = montarConsultaDaFila({ cid, status, q, limit: porPagina, offset });
      ({ rows } = await db.query(consulta.sql, consulta.params));
    }
    const orders = rows.map(apresentarLinhaDaFila);
    const totalFiltrado = rows.length ? Number(rows[0].total_filtrado) || 0 : 0;

    const { rows: counts } = await db.query(`
      SELECT
        COUNT(*)::int                                                 AS total,
        COUNT(*) FILTER (WHERE status = 'pending_payment')::int      AS pending_payment,
        COUNT(*) FILTER (WHERE status = 'awaiting_approval')::int    AS awaiting_approval,
        COUNT(*) FILTER (WHERE status = '${AGUARDANDO_ACEITE}')::int AS aguardando_aceite,
        COUNT(*) FILTER (WHERE status = 'out_for_delivery')::int     AS out_for_delivery,
        COUNT(*) FILTER (WHERE status = 'confirmed')::int            AS confirmed,
        COUNT(*) FILTER (WHERE status = 'preparing')::int            AS preparing,
        COUNT(*) FILTER (WHERE status = 'ready')::int                AS ready,
        COUNT(*) FILTER (WHERE status = 'delivered')::int            AS delivered,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int            AS cancelled,
        COUNT(*) FILTER (WHERE status = 'cancelled' AND payment_status = 'expired')::int AS expired
      FROM digital_orders WHERE company_id = $1
    `, [cid]);

    res.json({
      orders,
      counts: counts[0],
      // tq-47: a loja usa a fila com aceite? O painel mostra Aceitar/Recusar
      // tambem no Pix pago que ainda nao foi aceito.
      fila_com_aceite: await lojaComAceite(cid),
      pagination: {
        page:  pagina,
        limit: porPagina,
        // Total DA BUSCA (antes era sempre o total da empresa).
        total: totalFiltrado,
        pages: Math.ceil(totalFiltrado / porPagina),
      },
    });
  } catch (err) {
    console.error('digital orders list error:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// GET /:oid — Detalhe de um pedido com itens
router.get('/:oid', async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const { rows: orders } = await db.query(
      `SELECT * FROM digital_orders WHERE id = $1 AND company_id = $2`, [oid, cid]
    );
    if (!orders.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    // 10/09/2026: miniatura do produto quando existe (a foto gravada no item
    // e a original, de 1 a 3 MB) e o nome do item com a cor por extenso.
    // product_name continua o gravado; o painel usa product_name_display.
    const { rows: items } = await db.query(
      `SELECT i.id, i.product_id, i.variant_id, i.product_name, i.variant_label,
              COALESCE(p.image_thumb_url, i.product_image, p.image_url) AS product_image,
              i.unit_price, i.quantity, i.subtotal
       FROM digital_order_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.order_id = $1 ORDER BY i.id`, [oid]
    );
    res.json({
      ...orders[0],
      // tq-44: a frase pronta do pagamento na entrega ("Dinheiro. Paga com
      // R$ 100,00: levar R$ 22,00 de troco.") e o troco a levar. null no
      // pedido que nao e de pagar na entrega com forma escolhida.
      pagamento_na_entrega: fraseDoPagamento(orders[0]),
      // tq-47: texto pronto e link wa.me para avisar a cliente do passo atual.
      aviso_whatsapp: await avisoComLoja(cid, orders[0]),
      // Pago online e recusado: a lojista devolve por fora e marca aqui.
      devolver_por_fora: precisaDevolver(orders[0]) && !orders[0].refund_marked_at,
      troco_a_levar: trocoALevar(orders[0]),
      items: items.map((it) => ({ ...it, product_name_display: nomeLegivelDoItem(it.product_name) })),
    });
  } catch (err) {
    console.error('digital order detail error:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// PATCH /:oid/status — Avança status do pedido (admin)
router.patch('/:oid/status', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  const { status, reason } = req.body || {};
  // QA final 28/09/2026: "Cancelar pedido" do painel Studio manda o motivo,
  // que a vitrine mostra a cliente (cancel_reason, migration 359).
  const motivoDoCancelamento = status === 'cancelled' && reason != null && String(reason).trim()
    ? String(reason).trim().substring(0, 200)
    : null;

  const ALLOWED = ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({
      error: `Status inválido. Permitidos: ${ALLOWED.join(', ')}`,
    });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, status, payment_status FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });

    const current = rows[0].status;
    if (current === 'delivered' || current === 'cancelled') {
      return res.status(409).json({ error: `Pedido já finalizado com status "${current}"` });
    }
    // tq-44: o pedido que espera aceite so sai daqui pelo aceite (que baixa
    // o estoque e lanca) ou pela recusa/cancelamento. Avancar o status a
    // mao pularia a baixa e o lancamento.
    if (current === AGUARDANDO_ACEITE && status !== 'cancelled') {
      return res.status(409).json({
        error: 'Este pedido ainda espera o seu aceite. Aceite ou recuse o pedido primeiro.',
      });
    }
    const FLOW = ['pending_payment', 'awaiting_approval', AGUARDANDO_ACEITE, 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
    const curIdx = FLOW.indexOf(current);
    const newIdx = FLOW.indexOf(status);
    if (status !== 'cancelled' && newIdx < curIdx) {
      return res.status(409).json({
        error: `Não é possível voltar de "${current}" para "${status}"`,
      });
    }

    const { rows: updated } = await db.query(`
      UPDATE digital_orders SET
        status       = $1,
        payment_status = CASE
          WHEN $1 = 'confirmed' AND payment_status = 'pending' THEN 'confirmed'
          ELSE payment_status
        END,
        confirmed_at = CASE WHEN $1 = 'confirmed' AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END,
        delivered_at = CASE WHEN $1 = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
        cancelled_at = CASE WHEN $1 = 'cancelled' AND cancelled_at IS NULL THEN NOW() ELSE cancelled_at END,
        cancel_kind  = CASE WHEN $1 = 'cancelled' THEN 'cancelado_pela_loja' ELSE cancel_kind END,
        cancel_reason = CASE WHEN $1 = 'cancelled' THEN $4 ELSE cancel_reason END,
        updated_at   = NOW()
      WHERE id = $2 AND company_id = $3
      RETURNING *
    `, [status, oid, cid, motivoDoCancelamento]);

    // Cancelado: devolve o estoque se o pedido deu baixa (pago, ou pagar na
    // entrega). Esperado ANTES da resposta, para o painel ja ver o saldo
    // certo. Se falhar, o cancelamento continua valendo e o pedido fica com
    // stock_deducted = TRUE — e esse par (cancelled + stock_deducted) e
    // exatamente o que denuncia a devolucao pendente.
    if (status === 'cancelled') {
      await devolverNoCancelamento(oid, updated[0]);
      // Pagar na entrega ja aceito: o lancamento a receber e estornado.
      await aceite.estornarAReceber(updated[0])
        .catch(err => console.error('[orders] estorno do a receber falhou:', oid, err.message));
      // Cancelar quem ainda esperava aceite e recusar: fica registrado assim.
      if (current === AGUARDANDO_ACEITE) updated[0].cancel_kind = await marcarComoRecusado(oid, updated[0]);
    }
    // Entregue: o pagar na entrega foi recebido na porta. Quita o a receber.
    if (status === 'delivered') {
      await aceite.quitarNaEntrega(updated[0])
        .catch(err => console.error('[orders] quitacao na entrega falhou:', oid, err.message));
    }

    // tq-47: saiu para entrega, entregue e recusa trazem o aviso pronto.
    const aviso = ['out_for_delivery', 'delivered'].includes(status) || (status === 'cancelled' && current === AGUARDANDO_ACEITE)
      ? await avisoComLoja(cid, updated[0])
      : null;
    res.json({ order: updated[0], updated: true, ...(aviso ? { aviso_whatsapp: aviso } : {}) });

    if (status === 'confirmed' && current !== 'confirmed') {
      onOrderConfirmed(oid)
        .catch(err => console.error('[orders] onOrderConfirmed error (status patch):', err.message));
    }

    notify.notifyStatusChange(updated[0])
      .catch(err => console.error('[notify] status change error:', err.message));

    // Evento durável no sino. Um por transição — a dedupe_key é por pedido,
    // então reenviar o mesmo status não vira segundo aviso.
    if (status === 'delivered') lojaEvents.emit('loja_pedido_entregue', updated[0]);
    if (status === 'cancelled') lojaEvents.emit('loja_pedido_cancelado', updated[0]);
    if (status === 'confirmed' && current !== 'confirmed') {
      lojaEvents.emit('loja_pedido_pago', updated[0]);
    }

  } catch (err) {
    console.error('digital order status update error:', err);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

/** Cancelamento de pedido que esperava aceite = recusa (cancel_kind). */
async function marcarComoRecusado(oid, linha) {
  try {
    await db.query(
      `UPDATE digital_orders SET cancel_kind = 'recusado_pela_loja' WHERE id = $1`, [oid]);
    return 'recusado_pela_loja';
  } catch (err) {
    console.error('[orders] marcar como recusado falhou:', oid, err.message);
    return linha.cancel_kind;
  }
}

// ============================================================
// POST /:oid/accept — Lojista aceita o pedido de pagar na entrega (tq-44)
// Corpo: { prep_minutes }. Baixa o estoque e lanca a receber, uma vez so.
// ============================================================
router.post('/:oid/accept', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  const { prep_minutes } = req.body || {};
  try {
    const { order, jaAceito } = await aceite.aceitarPedido({ orderId: oid, companyId: cid, prepMinutes: prep_minutes });
    res.json({ order, accepted: true, ja_aceito: jaAceito, aviso_whatsapp: await avisoComLoja(cid, order, 'aceito') });
    if (jaAceito) return;
    notify.notifyStatusChange(order)
      .catch(err => console.error('[notify] accept error:', err.message));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, status: err.statusAtual || undefined });
    }
    console.error('[orders] accept error:', err.message, err.code || '');
    res.status(500).json({
      error: 'Não conseguimos aceitar o pedido agora. Nada foi alterado. Tente de novo em instantes.',
    });
  }
});

// ============================================================
// POST /:oid/refuse — Lojista recusa o pedido que esperava aceite (tq-44)
// Corpo: { reason } (obrigatorio: e o que a cliente vai ler).
// ============================================================
router.post('/:oid/refuse', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  const { reason } = req.body || {};
  try {
    const order = await aceite.recusarPedido({ orderId: oid, companyId: cid, motivo: reason });
    // Regra de todo cancelamento: passa pela devolucao (aqui nao ha baixa).
    await devolverNoCancelamento(oid, order);
    res.json({
      order, refused: true,
      // Pago online: devolver o valor por fora e marcar como devolvido.
      devolver_por_fora: precisaDevolver(order),
      aviso_whatsapp: await avisoComLoja(cid, order, 'recusado'),
    });
    notify.notifyStatusChange(order)
      .catch(err => console.error('[notify] refuse error:', err.message));
    lojaEvents.emit('loja_pedido_cancelado', order);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, status: err.statusAtual || undefined });
    }
    console.error('[orders] refuse error:', err.message, err.code || '');
    res.status(500).json({
      error: 'Não conseguimos recusar o pedido agora. Nada foi alterado. Tente de novo em instantes.',
    });
  }
});

// ============================================================
// POST /:oid/out-for-delivery — Saiu para entrega (tq-47)
// ============================================================
router.post('/:oid/out-for-delivery', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const { order, jaSaiu } = await aceite.saiuParaEntrega({ orderId: oid, companyId: cid });
    res.json({ order, ja_saiu: jaSaiu, aviso_whatsapp: await avisoComLoja(cid, order, 'saiu') });
    if (jaSaiu) return;
    notify.notifyStatusChange(order)
      .catch(err => console.error('[notify] out-for-delivery error:', err.message));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, status: err.statusAtual || undefined });
    }
    console.error('[orders] out-for-delivery error:', err.message, err.code || '');
    res.status(500).json({
      error: 'Não conseguimos marcar a saída agora. Nada foi alterado. Tente de novo em instantes.',
    });
  }
});

// ============================================================
// POST /:oid/refund-marked — "Já devolvi o valor" (tq-47). Pix/cartao pago
// e pedido recusado: a lojista devolve por fora ate existir reembolso no
// gateway (decisao do Caio) e marca aqui.
// ============================================================
router.post('/:oid/refund-marked', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const order = await aceite.marcarDevolvido({ orderId: oid, companyId: cid });
    res.json({ order, devolvido: true });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, status: err.statusAtual || undefined });
    }
    console.error('[orders] refund-marked error:', err.message, err.code || '');
    res.status(500).json({ error: 'Não conseguimos marcar agora. Tente de novo em instantes.' });
  }
});

// ============================================================
// POST /:oid/approve-payment — Lojista aprova pedido aguardando aprovacao
// ============================================================
router.post('/:oid/approve-payment', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT id, status, payment_method, order_number, customer_name, customer_email, company_id
       FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const order = rows[0];
    if (order.status !== 'awaiting_approval' && order.status !== 'pending_payment') {
      return res.status(409).json({
        error: `Pedido nao esta aguardando aprovacao (status atual: ${order.status})`,
      });
    }

    const { rows: updated } = await db.query(`
      UPDATE digital_orders SET
        status = 'confirmed',
        payment_status = 'confirmed',
        confirmed_at = COALESCE(confirmed_at, NOW()),
        updated_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING *
    `, [oid, cid]);

    res.json({ order: updated[0], approved: true });

    onOrderConfirmed(oid)
      .catch(err => console.error('[orders] onOrderConfirmed error (approve-payment):', err.message));

    // Notifica cliente por e-mail que o pagamento foi aprovado pelo lojista
    notify.notifyPaymentConfirmed({ order })
      .catch(err => console.error('[notify] approve-payment confirmed email error:', err.message));

    notify.notifyStatusChange(updated[0])
      .catch(err => console.error('[notify] approve-payment error:', err.message));

    lojaEvents.emit('loja_pedido_pago', updated[0]);

  } catch (err) {
    console.error('[orders] approve-payment error:', err.message);
    res.status(500).json({ error: 'Erro ao aprovar pagamento' });
  }
});

// ============================================================
// POST /:oid/reject-payment — Lojista recusa o pagamento e cancela o pedido
//
// QA 28/09/2026 (LJ-33, P0): respondia 500 em toda tentativa num pedido da
// vitrine Studio. A rota estava certa; quem quebrava era o trigger de
// estorno de insumos (trg_studio_restore_inputs_digital_cancel), com
// "column reference stock_qty is ambiguous" — corrigido na migration 357.
//
// Recusar pagamento so faz sentido enquanto o pedido espera o pagamento
// (Pix aguardando, "ja paguei" ou comprovante para conferir). Pedido pago
// ou em andamento se cancela por "Cancelar pedido" (PATCH /status), que e
// o caminho que o painel ja usa fora dessa situacao. Fora dela: 409 com o
// que fazer, em portugues, e nada gravado.
// ============================================================
/**
 * Devolve o estoque de um pedido recem-cancelado sem derrubar a rota.
 * `linha` e o RETURNING do UPDATE: o marcador e atualizado nela para a
 * resposta nao mostrar stock_deducted = TRUE de um pedido ja devolvido.
 */
async function devolverNoCancelamento(oid, linha) {
  try {
    const r = await devolverEstoqueDoPedido(oid);
    if (r && r.devolvido && linha) linha.stock_deducted = false;
    return r;
  } catch (err) {
    console.error('[orders] devolver estoque no cancelamento falhou (pedido segue cancelado, stock_deducted TRUE):',
      oid, err.message);
    return null;
  }
}

const ESPERANDO_PAGAMENTO = ['pending_payment', 'awaiting_approval'];
const PAGAMENTO_ENTROU = ['confirmed', 'paid', 'received'];

/** Por que este pedido nao pode ter o pagamento recusado (null = pode). */
function motivoParaNaoRecusar(order) {
  const status = String(order.status || '');
  if (status === 'cancelled') return 'Este pedido já está cancelado.';
  if (status === 'delivered') return 'Este pedido já foi entregue e não pode ter o pagamento recusado.';
  if (PAGAMENTO_ENTROU.includes(String(order.payment_status || '').toLowerCase())) {
    return 'O pagamento deste pedido já foi confirmado. Para desfazer a venda, use "Cancelar pedido".';
  }
  if (!ESPERANDO_PAGAMENTO.includes(status)) {
    return 'Este pedido não está esperando pagamento. Para desfazer a venda, use "Cancelar pedido".';
  }
  return null;
}

router.post('/:oid/reject-payment', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  const { reason } = req.body || {};
  try {
    const { rows } = await db.query(
      `SELECT id, status, payment_status FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const motivo = motivoParaNaoRecusar(rows[0]);
    if (motivo) return res.status(409).json({ error: motivo, status: rows[0].status });

    const texto = reason == null ? '' : String(reason).trim().substring(0, 200);
    const noteSuffix = texto
      ? '\n[REJEITADO em ' + new Date().toISOString() + ']: ' + texto
      : '\n[REJEITADO em ' + new Date().toISOString() + ']';

    // O status entra no WHERE: se o pedido mudou entre a leitura e aqui
    // (o webhook confirmou o Pix, a lojista aprovou em outra aba), nada e
    // cancelado por engano.
    //
    // QA final 28/09/2026 (LJ-33/CL-46): tipo e motivo em colunas proprias
    // (migration 359) — a vitrine mostra a cliente "A loja nao confirmou o
    // seu Pix" com o motivo, em vez do texto do Pix vencido. A etapa da
    // producao (studio_production_status) vira 'cancelled' pelo trigger
    // da mesma migration, em qualquer caminho de cancelamento.
    const { rows: updated } = await db.query(`
      UPDATE digital_orders SET
        status = 'cancelled',
        payment_status = 'cancelled',
        cancelled_at = NOW(),
        cancel_kind = 'pagamento_recusado',
        cancel_reason = $4,
        notes = COALESCE(notes, '') || $1,
        updated_at = NOW()
      WHERE id = $2 AND company_id = $3
        AND status IN ('pending_payment', 'awaiting_approval')
      RETURNING *
    `, [noteSuffix, oid, cid, texto || null]);
    if (!updated.length) {
      return res.status(409).json({
        error: 'O pedido mudou enquanto você recusava o pagamento. Atualize a página e confira a situação.',
      });
    }

    // Pedido esperando pagamento nao baixou estoque: na pratica nao devolve
    // nada. Chamado assim mesmo porque a regra e "todo cancelamento passa
    // pela devolucao" — quem decide se houve baixa e o marcador do pedido.
    await devolverNoCancelamento(oid, updated[0]);

    res.json({ order: updated[0], rejected: true });

    notify.notifyStatusChange(updated[0])
      .catch(err => console.error('[notify] reject-payment error:', err.message));

    lojaEvents.emit('loja_pedido_cancelado', updated[0]);

  } catch (err) {
    console.error('[orders] reject-payment error:', err.message, err.code || '');
    res.status(500).json({
      error: 'Não conseguimos recusar o pagamento agora. O pedido não foi alterado. Tente de novo em instantes; se continuar, fale com o suporte da Aura.',
    });
  }
});

// ============================================================
// DELETE /:oid — Exclui pedido permanentemente (apagar pedidos teste/órfãos).
//
// Davi reclamou (21/05/2026) que não conseguia apagar pedidos teste — backend
// só tinha cancel (muda status mas mantém na lista). Esta rota apaga DE FATO.
//
// Proteções (qualquer falha → 409 com mensagem específica):
//   1. Status deve ser cancelled OU pending_payment (jamais confirmados+).
//   2. transaction_id IS NULL — sem lançamento financeiro vinculado.
//   3. stock_deducted = false — sem baixa de estoque.
//   4. confirmed_at IS NULL — nunca foi confirmado (mesmo que tenha voltado a cancelled).
//   5. nfce_id IS NULL — sem nota fiscal emitida.
//
// digital_order_items é limpo automaticamente via ON DELETE CASCADE
// (digital_order_items_order_id_fkey).
//
// Permissão: client OR admin (analyst NÃO pode — ação destrutiva).
// ============================================================
router.delete('/:oid', requireRole('client', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT id, status, transaction_id, stock_deducted, confirmed_at, nfce_id, order_number
       FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const order = rows[0];

    if (!['cancelled', 'pending_payment'].includes(order.status)) {
      return res.status(409).json({
        error: `Pedido não pode ser excluído (status atual: ${order.status}). Cancele o pedido primeiro.`,
      });
    }
    if (order.transaction_id) {
      return res.status(409).json({
        error: 'Pedido tem lançamento financeiro vinculado. Exclua o lançamento no Financeiro antes.',
      });
    }
    if (order.stock_deducted) {
      return res.status(409).json({
        error: 'Pedido já deu baixa no estoque. Use cancelamento (que devolve o estoque) em vez de excluir.',
      });
    }
    if (order.confirmed_at) {
      return res.status(409).json({
        error: 'Pedido foi confirmado em algum momento. Não pode ser excluído — mantenha como cancelado pro histórico.',
      });
    }
    if (order.nfce_id) {
      return res.status(409).json({
        error: 'Pedido tem NFC-e emitida. Cancele a nota antes de excluir.',
      });
    }

    const { rowCount } = await db.query(
      `DELETE FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Pedido nao encontrado' });

    console.log(`[orders] deleted #${order.order_number} (${oid}) for company ${cid}`);
    res.json({ deleted: true, order_number: order.order_number });
  } catch (err) {
    console.error('[orders] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir pedido' });
  }
});

module.exports = router;
module.exports.motivoParaNaoRecusar = motivoParaNaoRecusar;
