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
//
// tq-47 (29/10/2026) — a fila do pedido:
//   - Pix/cartao pago online ('confirmed', ainda sem aceite) tambem entra
//     na fila: aceitar poe o tempo de preparo (a baixa ja aconteceu no
//     pagamento); recusar cancela, devolve o estoque (rota) e a lojista
//     devolve o valor por fora e marca como devolvido (refund_marked_at).
//   - SAIU PARA ENTREGA: em preparo/pronto -> 'out_for_delivery'.
//
// QUEM E "PAGO ESPERANDO ACEITE" (revisao do #930): accepted_at nasce NULL
// em todo o historico, entao 'confirmed' sem accepted_at NAO basta. Precisa
// de duas coisas: (1) o pedido nasceu numa loja que ja usava a fila
// (digital_orders.aceite_na_fila, gravado no checkout — migration 421), e
// (2) a loja continua com as formas de pagar na entrega marcadas. Pedido
// pago antes de a loja ligar as formas, ou em loja que nunca ligou, segue
// exatamente como hoje (sem Aceitar/Recusar).
// ============================================================
'use strict';

const db = require('../config/database');
const { aplicarConfirmacao, avisarDepoisDaConfirmacao } = require('./digitalOrderConfirmation');
const { AGUARDANDO_ACEITE, pedidoComAceite } = require('./pagarNaEntrega');

/** A loja do pedido usa a fila com aceite hoje (formas marcadas)? SQL. */
const LOJA_COM_ACEITE_SQL = `EXISTS (
  SELECT 1 FROM digital_channel_config dcc
   WHERE dcc.company_id = digital_orders.company_id
     AND dcc.pay_on_delivery_enabled IS TRUE
     AND COALESCE(array_length(dcc.pay_on_delivery_methods, 1), 0) > 0)`;

/** Pago online, nascido na fila e ainda sem aceite — com a loja ainda na fila. */
const PAGO_NA_FILA_SQL = `(status = 'confirmed' AND accepted_at IS NULL
  AND aceite_na_fila IS TRUE AND ${LOJA_COM_ACEITE_SQL})`;

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

    // tq-47: pago online e ainda sem aceite. A baixa e o lancamento ja
    // aconteceram no pagamento (onOrderConfirmed); aceitar so poe o tempo
    // e passa para em preparo. aplicarConfirmacao abaixo e idempotente e
    // so completa o que faltar.
    // So o que nasceu na fila (aceite_na_fila) e com a loja ainda na fila.
    let pagoSemAceite = false;
    if (order.status === 'confirmed' && !order.accepted_at && order.aceite_na_fila === true) {
      const { rows: fila } = await client.query(
        `SELECT ${LOJA_COM_ACEITE_SQL} AS ok FROM digital_orders WHERE id = $1`, [orderId]);
      pagoSemAceite = !!(fila[0] && fila[0].ok);
    }

    if (order.status !== AGUARDANDO_ACEITE && !pagoSemAceite) {
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
  // tq-47: tambem o pago online ainda sem aceite ('confirmed', accepted_at
  // nulo). Esse baixou estoque no pagamento: quem chama devolve
  // (devolverEstoqueDoPedido), como em todo cancelamento.
  const texto = motivo == null ? '' : String(motivo).trim().substring(0, 200);
  if (!texto) throw erro(400, 'Conte para a cliente por que o pedido foi recusado.');

  const { rows } = await (banco || db).query(
    `UPDATE digital_orders SET
        status        = 'cancelled',
        cancelled_at  = NOW(),
        cancel_kind   = 'recusado_pela_loja',
        cancel_reason = $3,
        updated_at    = NOW()
      WHERE id = $1 AND company_id = $2
        AND (status = '${AGUARDANDO_ACEITE}' OR ${PAGO_NA_FILA_SQL})
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
  if (atual[0].status === 'confirmed') {
    throw erro(409, 'Este pedido não está esperando aceite. Para desfazer, use "Cancelar pedido".', { statusAtual: 'confirmed' });
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

/**
 * Saiu para entrega (tq-47): em preparo ou pronto -> 'out_for_delivery'.
 * O status entra no WHERE: dois toques marcam uma vez; o segundo responde
 * a linha como esta (jaSaiu).
 */
async function saiuParaEntrega({ orderId, companyId }, { db: banco } = {}) {
  const { rows } = await (banco || db).query(
    `UPDATE digital_orders SET
        status              = 'out_for_delivery',
        out_for_delivery_at = NOW(),
        updated_at          = NOW()
      WHERE id = $1 AND company_id = $2 AND status IN ('preparing', 'ready')
      RETURNING *`,
    [orderId, companyId]
  );
  if (rows.length) return { order: rows[0], jaSaiu: false };
  const { rows: atual } = await (banco || db).query(
    `SELECT * FROM digital_orders WHERE id = $1 AND company_id = $2`, [orderId, companyId]);
  if (!atual.length) throw erro(404, 'Pedido não encontrado.');
  if (atual[0].status === 'out_for_delivery') return { order: atual[0], jaSaiu: true };
  if (atual[0].status === AGUARDANDO_ACEITE) {
    throw erro(409, 'Aceite o pedido antes de mandar para a entrega.', { statusAtual: atual[0].status });
  }
  throw erro(409, 'Este pedido não está em preparo, então não dá para marcar a saída.', { statusAtual: atual[0].status });
}

/**
 * A lojista devolveu por fora o valor de um pedido pago e recusado
 * (tq-47; reembolso no gateway ainda nao existe — decisao do Caio).
 */
async function marcarDevolvido({ orderId, companyId }, { db: banco } = {}) {
  const { rows } = await (banco || db).query(
    `UPDATE digital_orders SET refund_marked_at = COALESCE(refund_marked_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status = 'cancelled'
      RETURNING *`,
    [orderId, companyId]
  );
  if (rows.length) return rows[0];
  const { rows: atual } = await (banco || db).query(
    `SELECT id, status FROM digital_orders WHERE id = $1 AND company_id = $2`, [orderId, companyId]);
  if (!atual.length) throw erro(404, 'Pedido não encontrado.');
  throw erro(409, 'Só dá para marcar como devolvido um pedido recusado ou cancelado.', { statusAtual: atual[0].status });
}

/**
 * Checkout (tq-47): pedido pago online numa loja que usa a fila nasce
 * marcado para entrar nela. Melhor esforco e fora da transacao do pedido:
 * base sem a migration 421 (42703) segue sem a marca — o pedido continua
 * no fluxo de hoje, nunca quebra.
 */
async function marcarNaFila(orderId, { db: banco } = {}) {
  try {
    await (banco || db).query(
      `UPDATE digital_orders SET aceite_na_fila = TRUE WHERE id = $1`, [orderId]);
    return true;
  } catch (e) {
    if (e.code !== '42703') console.error('[aceite] marcar pedido na fila falhou:', orderId, e.message);
    return false;
  }
}

module.exports = {
  saiuParaEntrega, marcarDevolvido, marcarNaFila, LOJA_COM_ACEITE_SQL,
  aceitarPedido, recusarPedido, quitarNaEntrega, estornarAReceber,
  minutosDePreparo, PREPARO_MIN, PREPARO_MAX, DEPOIS_DO_ACEITE,
};
