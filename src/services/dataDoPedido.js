// ============================================================
// AURA. — "Nova data" do pedido guardado no Caixa (17/11/2026)
//
// Muda o dia combinado para a cliente buscar (digital_orders.promised_date,
// migration 459) de um pedido do balcao ABERTO (confirmed, preparing, ready).
// Regras (pendencia 5 do mockup de 17/11): o atraso so destaca; ele nunca
// libera a reserva nem cancela. Mudar a data so muda a data:
//   - nao mexe em situacao, estoque, reserva (calculada, B2), sinal nem
//     Financeiro;
//   - sem e-mail para a cliente e sem sino;
//   - data de hoje vale (como no B1); data que ja passou: 422; null tira a
//     data (o pedido fica "sem data", que o B1 ja permite).
//
// Historico: o B3 nao tem tabela de historico do pedido ("O que aconteceu"
// da gaveta e montado no app pelas colunas do pedido). Por isso nada e
// gravado alem de promised_date e updated_at.
//
// Arquivo proprio (e nao dentro de pedidoBalcao.js) para nao brigar no merge
// com os cards do sinal (B4a) e do cancelamento (B6), que mexem la.
// ============================================================
'use strict';

const { hojeSP, lerPedidoCompleto, ORIGEM_BALCAO } = require('./pedidoBalcao');

const ABERTOS = ['confirmed', 'preparing', 'ready'];
const ROTULO = { delivered: 'concluído', cancelled: 'cancelado' };

function erro(status, message, code, extra) {
  return Object.assign(new Error(message), { status, code, ...(extra || {}) });
}

/** 'YYYY-MM-DD' que existe no calendario (mesma regra do B1). */
function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Le o corpo { promised_date: 'YYYY-MM-DD' | null }. Sem banco.
 * Devolve { data } (string ou null) ou lanca erro 422.
 */
function lerNovaData(body, { hoje = hojeSP() } = {}) {
  const b = body || {};
  if (!Object.prototype.hasOwnProperty.call(b, 'promised_date')) {
    throw erro(422, 'Escolha a nova data em que ela vem buscar.', 'PEDIDO_DATA');
  }
  const raw = b.promised_date;
  if (raw === null || raw === '') return { data: null };
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!dataValida(s)) {
    throw erro(422, 'A data em que ela vem buscar está inválida.', 'PEDIDO_DATA');
  }
  if (s < hoje) {
    throw erro(422, 'A data em que ela vem buscar já passou. Escolha hoje ou um dia depois.', 'PEDIDO_DATA');
  }
  return { data: s };
}

/**
 * Grava a nova data. Devolve { pedido, ja_estava }.
 * 404 = nao e pedido do balcao desta loja; 409 = pedido ja concluido ou
 * cancelado (a data nao muda mais).
 */
async function mudarDataDoPedido(q, { companyId, orderId, body, hoje = hojeSP() }) {
  const { data } = lerNovaData(body, { hoje });
  const { rows } = await q.query(
    `UPDATE digital_orders SET promised_date = $1::date, updated_at = NOW()
      WHERE id = $2 AND company_id = $3 AND origem = '${ORIGEM_BALCAO}'
        AND status::text = ANY($4::text[])
        AND promised_date IS DISTINCT FROM $1::date
      RETURNING id`,
    [data, orderId, companyId, ABERTOS]
  );
  if (!rows.length) {
    const { rows: atual } = await q.query(
      `SELECT status::text AS status, promised_date::text AS promised_date
         FROM digital_orders WHERE id = $1 AND company_id = $2 AND origem = '${ORIGEM_BALCAO}'`,
      [orderId, companyId]
    );
    if (!atual.length) throw erro(404, 'Pedido não encontrado.', 'PEDIDO_NAO_ENCONTRADO');
    if (!ABERTOS.includes(atual[0].status)) {
      throw erro(409,
        `Este pedido está ${ROTULO[atual[0].status] || atual[0].status} e a data não muda mais.`,
        'PEDIDO_FECHADO',
        { status_atual: atual[0].status });
    }
    // Aberto e com a mesma data: nada a gravar.
    return { pedido: await lerPedidoCompleto(q, companyId, orderId), ja_estava: true };
  }
  return { pedido: await lerPedidoCompleto(q, companyId, orderId), ja_estava: false };
}

module.exports = { lerNovaData, mudarDataDoPedido, ABERTOS };
