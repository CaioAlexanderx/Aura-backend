// ============================================================
// AURA. — Aceite, recusa e quitacao do pedido de pagar na entrega
// (tq-44, 29/10/2026 — regra aprovada pela Nina em 19/10)
//
//   ACEITE  aguardando_aceite -> preparing (em preparo), com o tempo de
//           preparo. Na MESMA transacao: baixa o estoque, liga/cria a
//           cliente e lanca no Financeiro como A RECEBER na forma escolhida
//           (digitalOrderConfirmation.aplicarConfirmacao com aReceber).
//           Idempotente: a linha e lida com FOR UPDATE e a baixa confere
//           stock_deducted, o lancamento confere a idempotency_key — dois
//           toques, duas abas ou um repeteco da rede baixam UMA vez. O
//           segundo aceite responde "ja aceito", sem erro e sem mexer.
//
//   RECUSA  aguardando_aceite -> cancelled (cancel_kind 'recusado_pela_loja',
//           motivo em cancel_reason). Nao mexe em estoque nem no Financeiro:
//           nada foi baixado nem lancado. O status entra no WHERE: pedido
//           aceito em outra aba nao e recusado por engano.
//
//   ENTREGUE  quita o lancamento a receber (status 'confirmed', paid_at).
//   CANCELADO depois do aceite: o estoque volta pela devolucao de sempre
//           (devolucaoDoEstoqueDoPedido) e o lancamento a receber e
//           estornado (status 'cancelled'). Lancamento ja quitado nao e
//           tocado aqui — dinheiro que entrou sai pelo Financeiro.
//
// Pedido sem resposta NAO cancela sozinho (acrescimo da Nina, 19/10):
// nenhum job olha 'aguardando_aceite'.
// ============================================================
'use strict';

const db = require('../config/database');
const { aplicarConfirmacao, avisarDepoisDaConfirmacao } = require('./digitalOrderConfirmation');
const { AGUARDANDO_ACEITE, pedidoComAceite } = require('./pagarNaEntrega');

/** Tempo de preparo aceito: de 5 minutos a 6 horas. */
const PREPARO_MIN = 5;
const PREPARO_MAX = 360;

/** Status em que o pedido ja passou do aceite. */
const DEPOIS_DO_ACEITE = ['preparing', 'ready', 'out_for_delivery', 'delivered'];

function erro(status, mensagem, extra) {
  const e = new Error(mensagem);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/** "45" -> 45. Fora da faixa ou nao numero -> null. */
function minutosDePreparo(bruto) {
  if (bruto === undefined || bruto === null || bruto === '') return null;
  const n = Math.round(Number(bruto));
  if (!Number.isFinite(n) || n < PREPARO_MIN || n > PREPARO_MAX) return undefined;
  return n;
}

/**
 * Aceita o pedido que espera a lojista.
 *
 * @param {{ orderId: string, companyId: string, prepMinutes?: any }} p
 * @param {{ db?: object }} [deps] pool a usar (o teste injeta o dele)
 * @returns {Promise<{ order: object, jaAceito: boolean }>}
 * @throws erro com .status (400/404/409) e mensagem para a lojista
 */
async function aceitarPedido({ orderId, companyId, prepMinutes }, { db: banco } = {}) {
  const minutos = minutosDePreparo(prepMinutes);
  if (minutos === undefined) {
    throw erro(400, `Escolha um tempo de preparo entre ${PREPARO_MIN} e ${PREPARO_MAX} minutos.`);
  }

  const client = await (banco || db).connect();
  let order;
  let resultado = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM digital_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [orderId, companyId]
    );
    if (!rows.length) throw erro(404, 'Pedido não encontrado.');
    order = rows[0];

    if (order.status !== AGUARDANDO_ACEITE) {
      await client.query('ROLLBACK');
      if (DEPOIS_DO_ACEITE.includes(order.status) && order.accepted_at) {
        return { order, jaAceito: true };
      }
      if (order.status === 'cancelled') {
        throw erro(409, 'Este pedido já foi recusado ou cancelado.', { statusAtual: order.status });
      }
      throw erro(409, 'Este pedido não está esperando aceite.', { statusAtual: order.status });
    }

    const { rows: atualizados } = await client.query(
      `UPDATE digital_orders SET
          status       = 'preparing',
          accepted_at  = NOW(),
          confirmed_at = COALESCE(confirmed_at, NOW()),
          prep_minutes = $3,
          updated_at   = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [orderId, companyId, minutos]
    );
    order = atualizados[0];

    resultado = await aplicarConfirmacao(client, order, { aReceber: pedidoComAceite(order) });

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ja fechada */ }
    throw e;
  } finally {
    client.release();
  }

  // Linha final, com stock_deducted / customer_id / transaction_id.
  const { rows: finais } = await (banco || db).query(
    `SELECT * FROM digital_orders WHERE id = $1`, [orderId]);
  const final = finais[0] || order;
  try { avisarDepoisDaConfirmacao(final, resultado); } catch (_) { /* aviso nunca derruba */ }
  return { order: final, jaAceito: false };
}

/**
 * Recusa o pedido que espera a lojista. Nada a devolver: o pedido nao
 * baixou estoque nem lancou nada.
 *
 * @returns {Promise<object>} a linha cancelada
 */
async function recusarPedido({ orderId, companyId, motivo }, { db: banco } = {}) {
  const texto = motivo == null ? '' : String(motivo).trim().substring(0, 200);
  if (!texto) throw erro(400, 'Conte para a cliente por que o pedido foi recusado.');

  const { rows } = await (banco || db).query(
    `UPDATE digital_orders SET
        status        = 'cancelled',
        cancelled_at  = NOW(),
        cancel_kind   = 'recusado_pela_loja',
        cancel_reason = $3,
        updated_at    = NOW()
      WHERE id = $1 AND company_id = $2 AND status = '${AGUARDANDO_ACEITE}'
      RETURNING *`,
    [orderId, companyId, texto]
  );
  if (rows.length) return rows[0];

  const { rows: atual } = await (banco || db).query(
    `SELECT id, status FROM digital_orders WHERE id = $1 AND company_id = $2`,
    [orderId, companyId]
  );
  if (!atual.length) throw erro(404, 'Pedido não encontrado.');
  if (atual[0].status === 'cancelled') {
    throw erro(409, 'Este pedido já foi recusado ou cancelado.', { statusAtual: 'cancelled' });
  }
  throw erro(409, 'Este pedido já foi aceito. Para desfazer, use "Cancelar pedido".', { statusAtual: atual[0].status });
}

/**
 * Entregue: quita o lancamento a receber do pedido de pagar na entrega.
 * So mexe em lancamento 'pending' ligado ao pedido; pedido sem lancamento
 * ou ja quitado nao muda nada.
 *
 * @returns {Promise<boolean>} true quando quitou agora
 */
async function quitarNaEntrega(order, { db: banco } = {}) {
  if (!pedidoComAceite(order) || !order.transaction_id) return false;
  const { rowCount } = await (banco || db).query(
    `UPDATE transactions SET status = 'confirmed', paid_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status = 'pending'`,
    [order.transaction_id, order.company_id]
  );
  // O pedido tambem passa a "pago". Em separado e sem derrubar a quitacao:
  // no banco montado so pelas migrations (CI) payment_status ainda e o
  // ENUM da 070, sem 'confirmed'; em producao a coluna e texto.
  try {
    await (banco || db).query(
      `UPDATE digital_orders SET payment_status = 'confirmed'
        WHERE id = $1 AND payment_status = 'pending'`,
      [order.id]
    );
  } catch (e) {
    console.warn('[aceite] payment_status do pedido entregue nao mudou:', order.id, e.message);
  }
  return rowCount > 0;
}

/**
 * Cancelado depois do aceite: estorna o lancamento a receber. O estoque
 * volta por devolverEstoqueDoPedido, chamado pela rota como em todo
 * cancelamento.
 *
 * @returns {Promise<boolean>} true quando estornou agora
 */
async function estornarAReceber(order, { db: banco } = {}) {
  if (!pedidoComAceite(order) || !order.transaction_id) return false;
  const { rowCount } = await (banco || db).query(
    `UPDATE transactions SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status = 'pending'`,
    [order.transaction_id, order.company_id]
  );
  return rowCount > 0;
}

module.exports = {
  aceitarPedido, recusarPedido, quitarNaEntrega, estornarAReceber,
  minutosDePreparo, PREPARO_MIN, PREPARO_MAX, DEPOIS_DO_ACEITE,
};
