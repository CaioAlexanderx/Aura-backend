// ============================================================
// AURA. — O cancelamento do pedido da loja online (28/09/2026)
//
// QA final da vitrine Studio (LJ-33 e LJ-33/CL-46, P1). Duas leituras do
// mesmo fato, num lugar só:
//
// 1. A ETAPA da produção de um pedido cancelado. O pedido da vitrine tem
//    `status` (pedido/pagamento) e `studio_production_status` (produção);
//    cancelar mudava só o primeiro, e o painel Studio — que lê o segundo —
//    seguia com o pedido em "Aguardando arte". A migration 359 corrige na
//    escrita (trigger); aqui a LEITURA também trata `status = 'cancelled'`
//    como etapa 'cancelled', para os pedidos cancelados antes dela.
//
// 2. O TIPO e o MOTIVO do cancelamento, para a vitrine dizer à cliente o
//    que houve. Antes ela lia "O Pix não foi pago em 72 horas" até quando
//    a loja tinha recusado o pagamento cinco minutos depois do pedido.
//    Pedido cancelado antes da 359 não tem cancel_kind: o tipo sai do
//    payment_status ('expired' = job do Pix vencido) e da marca
//    "[REJEITADO em ...]: <motivo>" que o reject-payment sempre gravou nas
//    notas.
//
// O que sai para a cliente: o tipo e o motivo que a LOJA escreveu na
// recusa ou no cancelamento. Nada das notas além disso — elas também
// guardam o recado da cliente e marcas internas.
// ============================================================
'use strict';

const TIPOS = ['pix_expirado', 'pagamento_recusado', 'cancelado_pela_loja'];
const TIPOS_COM_MOTIVO = ['pagamento_recusado', 'cancelado_pela_loja'];

/** Etapa da produção como o painel deve ler (SQL). `a` = alias da tabela/view. */
function sqlDaEtapa(a) {
  const p = a ? `${a}.` : '';
  return `(CASE WHEN ${p}status::text = 'cancelled' THEN 'cancelled' ELSE ${p}studio_production_status::text END)`;
}

/** A mesma regra de sqlDaEtapa, para uma linha já lida. */
function etapaDaProducao(pedido) {
  if (!pedido) return null;
  if (String(pedido.status || '') === 'cancelled') return 'cancelled';
  return pedido.studio_production_status ?? null;
}

const limpo = (v, max = 200) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.substring(0, max) : null;
};

/** O último "[REJEITADO em <data>]: <motivo>" das notas (pedido anterior à 359). */
function motivoDaRecusaNasNotas(notas) {
  const texto = notas == null ? '' : String(notas);
  const re = /\[REJEITADO em [^\]]*\](?::[ \t]*([^\n]*))?/g;
  let achou = null;
  let m;
  while ((m = re.exec(texto)) !== null) achou = { motivo: limpo(m[1]) };
  return achou;
}

/**
 * Tipo e motivo do cancelamento. null quando o pedido não está cancelado.
 * @param {object} pedido linha de digital_orders (status, payment_status,
 *   cancel_kind?, cancel_reason?, notes?)
 * @returns {{ tipo: string, motivo: string|null } | null}
 */
function cancelamentoDoPedido(pedido) {
  if (!pedido || String(pedido.status || '') !== 'cancelled') return null;

  if (TIPOS.includes(pedido.cancel_kind)) {
    const tipo = pedido.cancel_kind;
    let motivo = TIPOS_COM_MOTIVO.includes(tipo) ? limpo(pedido.cancel_reason) : null;
    // Recusa gravada sem cancel_reason (antes da 359): o motivo mora nas notas.
    if (!motivo && tipo === 'pagamento_recusado') {
      const nasNotas = motivoDaRecusaNasNotas(pedido.notes);
      motivo = nasNotas ? nasNotas.motivo : null;
    }
    return { tipo, motivo };
  }

  if (String(pedido.payment_status || '').toLowerCase() === 'expired') {
    return { tipo: 'pix_expirado', motivo: null };
  }
  const recusa = motivoDaRecusaNasNotas(pedido.notes);
  if (recusa) return { tipo: 'pagamento_recusado', motivo: recusa.motivo };
  return { tipo: 'cancelado_pela_loja', motivo: limpo(pedido.cancel_reason) };
}

module.exports = {
  TIPOS,
  sqlDaEtapa,
  etapaDaProducao,
  cancelamentoDoPedido,
  motivoDaRecusaNasNotas,
};
