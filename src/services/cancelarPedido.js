// ============================================================
// AURA. — Cancelar o pedido do balcao (B6 / p-62e, 17/11/2026)
//
// POST /companies/:id/pedidos/:oid/cancelar
//   { refund_kind: 'credito' | 'devolucao',
//     refund_method: 'dinheiro' | 'pix' | 'estorno'   (so na devolucao),
//     reason?: string }
//
// O que acontece, numa transacao, com o pedido travado (FOR UPDATE):
//   - o pedido vai a 'cancelled' (cancel_kind 'cancelado_pela_loja',
//     cancel_reason = motivo opcional, refund_kind). A reserva some sozinha:
//     ela e calculada dos pedidos abertos (reservaDoPedido.js);
//   - a conta "Pedido a receber" vai a 'cancelled' (nunca 'confirmed');
//   - com sinal pago, a lojista escolhe o destino dele:
//       CREDITO   credito livre na ficha da cliente, sem venda:
//                 customer_credit_transactions 'payment', metodo
//                 'crediario_credito' (o mesmo do credito da troca: os
//                 relatorios do crediario ja sabem que nao e dinheiro
//                 recebido), sale_id NULL, source 'pedido'. So com cliente
//                 cadastrado. NAO depende de crediario_enabled. O sinal fica
//                 como entrou (o dinheiro ficou na loja).
//       DEVOLUCAO "Devolucao de sinal": lancamento expense confirmado, chave
//                 pedido-devolucao-<pedido>. NUNCA a categoria 'devolucao'
//                 (ela abate o Faturamento, e esta venda nunca existiu). Pela
//                 revisao da Celia ela fica FORA de Despesas
//                 (resultadoDoPeriodo.js) e, no DRE, na mesma linha do sinal
//                 com valor negativo (routes/dre.js): o pedido cancelado
//                 com devolucao fecha em zero.
//                 Em dinheiro: com o caixa ligado, exige caixa aberto (409
//                 CAIXA_REQUIRED, igual a venda) e grava a saida
//                 'devolucao_sinal' na sessao (migration 461). O fechamento
//                 passa a le-la no card B4b. Pix e estorno so registram.
//                 Estorno so para sinal pago no cartao (422 sem cartao).
//   - sem e-mail e sem sino (o pedido do balcao nao avisa a cliente pelo
//     Canal).
//
// Cancelar de novo devolve o pedido como esta (200, ja_estava): nada e
// lancado duas vezes. Pedido concluido (virou venda) nao cancela por aqui:
// desfazer e pela venda.
//
// Taxa da maquininha do sinal (pedido-sinal-taxa-<pedido>), revisao da Celia
// (17/11):
//   - ESTORNO de sinal pago no cartao (credito ou debito): a taxa sai junto,
//     apagada como o cancelamento de venda apaga o pdv-card-fee
//     (routes/sales.js). A adquirente devolve a taxa no estorno; deixa-la
//     seria prejuizo fantasma.
//   - devolucao em dinheiro ou Pix de sinal pago no cartao: a taxa FICA (a
//     loja pagou a maquininha e devolveu o dinheiro por fora).
//   - credito na ficha: a taxa FICA.
//
// Multi-CNPJ: tudo na company_id da loja do pedido. O credito fica na ficha
// da cliente NESTA loja, como o credito da troca (trocaV2.js).
// ============================================================
'use strict';

const { findOwnerScopedCustomer } = require('../utils/customerScope');
const sinalDoPedido = require('./sinalDoPedido');

const CATEGORIA_DEVOLUCAO_SINAL = 'Devolução de sinal';
const CHAVE_DEVOLUCAO = (orderId) => `pedido-devolucao-${orderId}`;
const CHAVE_CREDITO = (orderId) => `pedido-credito-${orderId}`;

const ABERTOS = ['confirmed', 'preparing', 'ready'];
const METODOS_DE_DEVOLUCAO = ['dinheiro', 'pix', 'estorno'];
const ROTULO_DEVOLUCAO = { dinheiro: 'dinheiro', pix: 'Pix', estorno: 'estorno no cartão' };
const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";
const MOTIVO_MAX = 200;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function erro(status, message, code, extra) {
  return Object.assign(new Error(message), { status, code, ...(extra || {}) });
}

function limparMotivo(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? Array.from(s).slice(0, MOTIVO_MAX).join('').trim() : null;
}

/**
 * Le o destino do sinal, sem banco. Devolve { dados: {kind, method} } ou
 * { erro }. `temSinal` = o pedido tem sinal pago (sem sinal, nada e exigido).
 */
function lerDestino(body, temSinal) {
  const b = body || {};
  if (!temSinal) return { dados: { kind: null, method: null } };
  const kind = String(b.refund_kind || '').trim().toLowerCase();
  if (kind === 'credito') return { dados: { kind: 'credito', method: null } };
  if (kind === 'devolucao') {
    const method = String(b.refund_method || '').trim().toLowerCase();
    if (!METODOS_DE_DEVOLUCAO.includes(method)) {
      return { erro: { status: 422, code: 'PEDIDO_DEVOLUCAO_FORMA', message: 'Escolha como devolver o sinal: dinheiro, Pix ou estorno.' } };
    }
    return { dados: { kind: 'devolucao', method } };
  }
  return {
    erro: {
      status: 422, code: 'PEDIDO_DESTINO_DO_SINAL',
      message: 'Este pedido tem sinal. Escolha: deixar como crédito na loja ou devolver o sinal.',
    },
  };
}

// B4b (revisao do Fable): a mesma leitura do sinal (sinalDoPedido.sessaoDoCaixa)
// e da venda: com sessao aberta, a devolucao em dinheiro sai dela mesmo com a
// chave caixa_enabled desligada.
async function caixaDaLoja(client, companyId) {
  return sinalDoPedido.sessaoDoCaixa(client, companyId);
}

/**
 * Cancela o pedido. Devolve { status: 200, ja_estava, cancelamento }.
 * Lanca erro com .status para a rota responder.
 */
async function cancelarPedido(db, { companyId, orderId, body, userId }) {
  const motivo = limparMotivo(body && body.reason);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, order_number, origem, status::text AS status, total, customer_id, refund_kind
         FROM digital_orders WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
      [orderId, companyId]
    );
    const pedido = rows[0];
    if (!pedido || pedido.origem !== 'balcao') throw erro(404, 'Pedido não encontrado.', 'PEDIDO_NAO_ENCONTRADO');
    if (pedido.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { status: 200, ja_estava: true, cancelamento: { refund_kind: pedido.refund_kind || null } };
    }
    if (!ABERTOS.includes(pedido.status)) {
      throw erro(409, 'Este pedido já foi concluído no Caixa. Para desfazer, cancele a venda.', 'PEDIDO_JA_CONCLUIDO',
        { status_atual: pedido.status });
    }

    // 18/11/2026 (revisao do Fable): so o sinal que o pedido gravou
    // (registrarSinal, sempre com forma). Um marco sem forma nao tem dinheiro
    // no Financeiro e nao se devolve nem vira credito.
    const { rows: [s] } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS v,
              BOOL_OR(forma IN ('cartao', 'debito')) AS no_cartao
         FROM studio_payments
        WHERE order_id = $1 AND kind = 'deposit' AND status = 'paid' AND forma IS NOT NULL`, [orderId]);
    const sinal = round2(Number(s && s.v) || 0);
    const sinalNoCartao = !!(s && s.no_cartao);
    const lido = lerDestino(body, sinal > 0);
    if (lido.erro) throw erro(lido.erro.status, lido.erro.message, lido.erro.code);
    const { kind, method } = lido.dados;
    // 18/11/2026 (revisao do Fable): estorno so existe para sinal no cartao.
    // Sinal em dinheiro ou Pix "estornado" sairia sem baixa da gaveta.
    if (kind === 'devolucao' && method === 'estorno' && !sinalNoCartao) {
      throw erro(422, 'Estorno só vale para sinal pago no cartão. Devolva em dinheiro ou Pix.', 'PEDIDO_ESTORNO_SEM_CARTAO');
    }

    const cancelamento = { refund_kind: null, refund_method: null, valor: sinal, credito_id: null, movimento_caixa: false, taxa_estornada: 0 };

    if (kind === 'credito') {
      const cliente = pedido.customer_id
        ? await findOwnerScopedCustomer(client, companyId, pedido.customer_id, 'id')
        : null;
      if (!cliente) {
        throw erro(422,
          'Para deixar o sinal como crédito, o pedido precisa de uma cliente cadastrada. Devolva o sinal de outra forma.',
          'CREDITO_EXIGE_CLIENTE');
      }
      const { rows: [c] } = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, payment_method, notes, source, created_by, idempotency_key)
         VALUES ($1, $2, NULL, 'payment', $3, 'crediario_credito', $4, 'pedido', $5, $6)
         RETURNING id`,
        [companyId, cliente.id, sinal, `Crédito do sinal do pedido ${pedido.order_number} (cancelado)`,
          userId || null, CHAVE_CREDITO(orderId)]
      );
      cancelamento.refund_kind = 'credito';
      cancelamento.credito_id = c.id;
    } else if (kind === 'devolucao') {
      let sessaoId = null;
      if (method === 'dinheiro') {
        const caixa = await caixaDaLoja(client, companyId);
        if (caixa.ligado && !caixa.sessaoId) {
          throw erro(409, 'Abra o caixa antes de devolver o sinal em dinheiro.', 'CAIXA_REQUIRED');
        }
        sessaoId = caixa.sessaoId;
      }
      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
         VALUES ($1, 'expense', 'confirmed', $2, $3, '${CATEGORIA_DEVOLUCAO_SINAL}', ${SP_DATE_NOW}, NOW(), $4, $5)`,
        [companyId, sinal,
          `Devolução do sinal do pedido ${pedido.order_number} (${ROTULO_DEVOLUCAO[method]})`.slice(0, 500),
          userId || null, CHAVE_DEVOLUCAO(orderId)]
      );
      if (sessaoId) {
        await client.query(
          `INSERT INTO caixa_movimentos (company_id, sessao_id, tipo, valor, motivo, created_by)
           VALUES ($1, $2, 'devolucao_sinal', $3, $4, $5)`,
          [companyId, sessaoId, sinal, `Sinal devolvido: pedido ${pedido.order_number}`.slice(0, 200), userId || null]
        );
        cancelamento.movimento_caixa = true;
      }
      // Estorno de sinal pago no cartao: a taxa da maquininha sai junto.
      if (method === 'estorno') {
        const { rows: taxa } = await client.query(
          `DELETE FROM transactions WHERE idempotency_key = $1 AND company_id = $2 RETURNING amount`,
          [sinalDoPedido.CHAVE_TAXA_SINAL(orderId), companyId]
        );
        cancelamento.taxa_estornada = round2(taxa.reduce((a, t) => a + Number(t.amount || 0), 0));
      }
      cancelamento.refund_kind = method;
      cancelamento.refund_method = method;
    }

    // A conta a receber nunca vira receita: vai a 'cancelled'.
    await client.query(
      `UPDATE transactions
          SET status = 'cancelled',
              notes = CASE WHEN COALESCE(notes, '') = '' THEN $1 ELSE notes || ' · ' || $1 END,
              updated_at = NOW()
        WHERE idempotency_key = $2 AND company_id = $3 AND status = 'pending'`,
      ['Pedido cancelado', sinalDoPedido.CHAVE_A_RECEBER(orderId), companyId]
    );

    // cancel_kind gravado aqui: e o tipo certo e evita o CASE do trigger da
    // 359 (que compara payment_status com 'expired').
    await client.query(
      `UPDATE digital_orders
          SET status = 'cancelled',
              cancel_kind = 'cancelado_pela_loja',
              cancel_reason = $1,
              refund_kind = $2,
              refund_marked_at = CASE WHEN $3::boolean THEN NOW() ELSE refund_marked_at END,
              updated_at = NOW()
        WHERE id = $4 AND company_id = $5`,
      [motivo, cancelamento.refund_kind, kind === 'devolucao', orderId, companyId]
    );
    await client.query('COMMIT');
    return { status: 200, ja_estava: false, cancelamento };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  CATEGORIA_DEVOLUCAO_SINAL,
  CHAVE_DEVOLUCAO,
  CHAVE_CREDITO,
  lerDestino,
  limparMotivo,
  cancelarPedido,
};
