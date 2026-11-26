// ============================================================
// AURA. — Pedido de orcamento: quitado e entregue (B1b do QA de 26/11/2026)
//
// O pedido que nasce do orcamento aprovado (digital_orders, status
// 'confirmed') nunca passou pela confirmacao da loja online, entao ficava
// para sempre com payment_status 'pending', delivered_at nulo e
// stock_deducted false: a peca entregue nao baixava do estoque.
//
//   QUITAR   quando o recebido (marcos studio_payments 'paid') alcanca o
//            total do pedido, payment_status vira 'paid'. E o valor que o
//            banco montado pelas migrations aceita (enum pending|paid|failed|
//            refunded); em producao a coluna e TEXT e o codigo trata 'paid' e
//            'confirmed' (o que o Pix da loja grava) como pago. Nao mexe em
//            valores nem em lancamentos: o Financeiro continua como esta.
//   ENTREGAR grava delivered_at (uma vez) e baixa o estoque pela MESMA
//            funcao da confirmacao da loja online (baixarEstoqueDoPedido),
//            idempotente por digital_orders.stock_deducted, com o pedido
//            travado (FOR UPDATE). Entregar de novo nao baixa de novo.
//            Entregar com saldo aberto ("Entregar mesmo assim") grava a
//            entrega e baixa o estoque, mas NAO marca pago.
//
// So vale para o fluxo novo do orcamento (financeiroDoOrcamento
// .marcoLancaNoFinanceiro): pedido que saiu de orcamento E ja tem a conta a
// receber ou a trava da frente ligada. O resto segue como antes.
// ============================================================
'use strict';

const financeiroDoOrcamento = require('./financeiroDoOrcamento');
const { baixarEstoqueDoPedido, avisarDepoisDaConfirmacao } = require('./digitalOrderConfirmation');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Valor que a confirmacao do Pix da loja grava em payment_status.
const PAGO = 'paid';

/**
 * Dentro da transacao do recebimento (pedido ja travado): se o que entrou
 * alcanca o total, payment_status 'pending' -> 'confirmed'. So sai de
 * 'pending' (nunca mexe em cancelado, expirado etc.).
 * @returns {Promise<boolean>} true se marcou
 */
async function quitarSeRecebeuTudo(client, { companyId, orderId, total, recebido }) {
  if (!(round2(total) > 0) || !(round2(recebido) + 0.004 >= round2(total))) return false;
  const { rowCount } = await client.query(
    `UPDATE digital_orders
        SET payment_status = $3, updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND payment_status = 'pending'`,
    [orderId, companyId, PAGO]
  );
  return rowCount > 0;
}

/**
 * Entrega do pedido de orcamento: delivered_at + baixa de estoque, numa
 * transacao, com o pedido travado. Chamada ANTES de gravar a etapa
 * 'delivered' (se falhar, a etapa nao muda e a lojista tenta de novo).
 *
 * @param {object} db  pool (com connect/query)
 * @returns {Promise<{aplicou: boolean, baixou?: boolean, jaEntregue?: boolean}>}
 *   aplicou=false: pedido fora do fluxo novo do orcamento (nada foi feito).
 */
async function entregarPedidoDeOrcamento(db, { companyId, orderId }) {
  if (!(await financeiroDoOrcamento.marcoLancaNoFinanceiro(db, companyId, orderId))) {
    return { aplicou: false };
  }
  const client = await db.connect();
  let order;
  let crossedMinimum = [];
  let baixou = false;
  let jaEntregue = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM digital_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [orderId, companyId]
    );
    order = rows[0];
    if (!order || order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { aplicou: false };
    }
    jaEntregue = !!order.delivered_at;
    if (!jaEntregue) {
      await client.query(
        `UPDATE digital_orders SET delivered_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [orderId]
      );
    }
    ({ crossedMinimum, baixou } = await baixarEstoqueDoPedido(client, order));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // Aviso do estoque minimo, fora da transacao (como na confirmacao).
  if (crossedMinimum.length) {
    avisarDepoisDaConfirmacao(order, { clienteNovo: false, nfceFalhou: null, crossedMinimum });
  }
  return { aplicou: true, baixou, jaEntregue };
}

module.exports = { quitarSeRecebeuTudo, entregarPedidoDeOrcamento, PAGO };
