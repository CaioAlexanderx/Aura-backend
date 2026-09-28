// ============================================================
// AURA. — Aviso do sino já resolvido pelo que aconteceu no pedido
// 28/09/2026 — QA final da vitrine Studio (LJ-29, P2)
//
// Depois de "Recusar pagamento", o grupo "Pedido #00005" do sino seguia
// com o selo "AÇÃO": o "Pagamento a conferir" continuava pedindo mão
// humana (o pedido já estava cancelado) e o "Pedido cancelado" — que a
// PRÓPRIA lojista fez — chegava como 'atencao' ("Confira se há estoque ou
// valor a devolver").
//
// A severidade continua sendo do TIPO (services/lojaEvents.js). Aqui só se
// lê o estado ATUAL do pedido para dizer se o aviso ainda pede alguém:
//
//   pagamento a conferir / comprovante   resolvido quando o pedido saiu da
//                                        espera do pagamento (pago ou
//                                        cancelado, por qualquer caminho)
//   Pix expirado                         resolvido quando o pedido foi pago
//                                        ou a loja o cancelou/recusou — o
//                                        cancelamento automático em si NÃO
//                                        resolve: o aviso existe para a
//                                        lojista chamar a cliente
//   pedido cancelado                     informativo quando foi a loja que
//                                        cancelou ou recusou
//
// Resolvido = `resolved: true` e severity 'info' no item do feed: sai de
// "Precisa de você" e perde o selo. Nada é gravado: é leitura.
// ============================================================
'use strict';

const { cancelamentoDoPedido } = require('./cancelamentoDoPedido');

const ESPERANDO_PAGAMENTO = ['pending_payment', 'awaiting_approval'];
const DA_LOJA = ['pagamento_recusado', 'cancelado_pela_loja'];

/**
 * @param {{ type: string, severity: string }} evento
 * @param {object|null} pedido linha de digital_orders (status,
 *   payment_status, cancel_kind?, notes?) ou null se não achou
 * @returns {{ resolved: boolean, severity: string }}
 */
function estadoDoEvento(evento, pedido) {
  const atual = { resolved: false, severity: evento && evento.severity };
  if (!evento || !pedido) return atual;
  const status = String(pedido.status || '');
  const esperando = ESPERANDO_PAGAMENTO.includes(status);
  const cancelamento = cancelamentoDoPedido(pedido);
  const resolvido = { resolved: true, severity: 'info' };

  switch (evento.type) {
    case 'loja_pagamento_a_conferir':
    case 'loja_comprovante_enviado':
      return esperando ? atual : resolvido;
    case 'loja_pix_expirado':
      if (esperando) return atual;
      if (cancelamento && cancelamento.tipo === 'pix_expirado') return atual;
      return resolvido;
    case 'loja_pedido_cancelado':
      return cancelamento && DA_LOJA.includes(cancelamento.tipo) ? resolvido : atual;
    default:
      return atual;
  }
}

/** Tipos cujo estado depende do pedido — só eles justificam a consulta. */
const TIPOS_QUE_DEPENDEM_DO_PEDIDO = [
  'loja_pagamento_a_conferir', 'loja_comprovante_enviado', 'loja_pix_expirado', 'loja_pedido_cancelado',
];

/**
 * Aplica estadoDoEvento aos itens do feed. `order_id` de cada item é o id
 * do pedido (routes/notifications.js). Falha na consulta devolve os itens
 * como vieram: o sino nunca cai por causa disto.
 */
async function comEstadoDoPedido(db, companyId, eventos) {
  const ids = [...new Set((eventos || [])
    .filter((e) => e.order_id && TIPOS_QUE_DEPENDEM_DO_PEDIDO.includes(e.type))
    .map((e) => String(e.order_id)))];
  if (!ids.length) return eventos;
  let pedidos;
  try {
    const { rows } = await db.query(
      `SELECT d.id, d.status, d.payment_status, d.notes,
              to_jsonb(d)->>'cancel_kind'   AS cancel_kind,
              to_jsonb(d)->>'cancel_reason' AS cancel_reason
         FROM digital_orders d
        WHERE d.company_id = $1 AND d.id::text = ANY($2::text[])`,
      [companyId, ids]
    );
    pedidos = new Map(rows.map((r) => [String(r.id), r]));
  } catch (e) {
    console.error('[eventoResolvido] estado dos pedidos indisponível:', e.message);
    return eventos;
  }
  return eventos.map((e) => {
    const pedido = e.order_id ? pedidos.get(String(e.order_id)) : null;
    if (!pedido) return e;
    const { resolved, severity } = estadoDoEvento(e, pedido);
    return resolved ? { ...e, resolved: true, severity } : e;
  });
}

module.exports = { estadoDoEvento, comEstadoDoPedido, TIPOS_QUE_DEPENDEM_DO_PEDIDO };
