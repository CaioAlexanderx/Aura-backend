// ============================================================
// AURA. — Pedido do Canal cancelado devolve o estoque (19/10/2026)
//
// A baixa do pedido do Canal acontece na CONFIRMACAO
// (digitalOrderConfirmation.onOrderConfirmed, passo 2) e marca
// digital_orders.stock_deducted = TRUE. Ate aqui nenhum cancelamento
// devolvia: pedido pago e cancelado deixava o produto "vendido" para
// sempre (no banco, o pedido 00011: Pix confirmado, cancelado 20 h depois,
// estoque nunca devolvido — NAO corrigido aqui, ver PR).
//
// Regra: devolve SO se houve baixa, e o sinal de que houve e o mesmo
// marcador que a baixa grava (stock_deducted). Lido com a linha travada
// (FOR UPDATE), a devolucao o zera na mesma transacao — cancelar duas
// vezes, ou dois cancelamentos ao mesmo tempo, devolvem UMA vez. Se o
// pedido for reconfirmado depois, a baixa volta a acontecer (o marcador
// esta FALSE), e um novo cancelamento devolve de novo: o par fica sempre
// simetrico.
//
// Espelho da baixa: mesmo produto ou variante, mesma quantidade. Item com
// variante devolve na variante (a baixa nao mexe no produto pai). Cada
// devolucao grava a entrada em stock_movements (type 'in',
// reference_type 'digital_order_cancel', reference_id = pedido), com a
// empresa DONA do produto (produto compartilhado do grupo, como no Caixa).
//
// So pedido ja 'cancelled': quem chama muda o status antes (ou na mesma
// transacao) e chama esta funcao. Pedido em outro status nao devolve nada.
// ============================================================
'use strict';

const db = require('../config/database');

const REFERENCIA = 'digital_order_cancel';

/**
 * Devolve ao estoque os itens de um pedido cancelado que teve baixa.
 *
 * @param {string} orderId
 * @param {object} [opts]
 * @param {object} [opts.client] client do pool JA dentro de uma transacao
 *   (o chamador faz BEGIN/COMMIT). Sem ele, a funcao abre a propria.
 * @param {object} [opts.db] pool a usar quando nao vem client (o job injeta
 *   o dele); padrao: config/database.
 * @returns {Promise<{ devolvido: boolean, motivo?: string, itens?: number }>}
 */
async function devolverEstoqueDoPedido(orderId, { client, db: banco } = {}) {
  const proprio = !client;
  const c = client || await (banco || db).connect();
  try {
    if (proprio) await c.query('BEGIN');

    const { rows: pedidos } = await c.query(
      `SELECT id, order_number, status, stock_deducted
         FROM digital_orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    const pedido = pedidos[0];
    let resultado;
    if (!pedido) resultado = { devolvido: false, motivo: 'pedido_nao_encontrado' };
    else if (pedido.status !== 'cancelled') resultado = { devolvido: false, motivo: 'nao_cancelado' };
    else if (pedido.stock_deducted !== true) resultado = { devolvido: false, motivo: 'sem_baixa' };

    if (resultado) {
      if (proprio) await c.query('COMMIT');
      return resultado;
    }

    const { rows: itens } = await c.query(
      `SELECT product_id, variant_id, quantity FROM digital_order_items WHERE order_id = $1`,
      [orderId]
    );

    const nota = `Cancelamento do pedido #${pedido.order_number ?? ''} da loja online`.trim();
    let devolvidos = 0;
    for (const item of itens) {
      const qtd = Number(item.quantity);
      if (!Number.isFinite(qtd) || qtd <= 0) continue;

      let produtoId = item.product_id || null;
      if (item.variant_id) {
        const { rows } = await c.query(
          `UPDATE product_variants SET stock_qty = stock_qty + $1
            WHERE id = $2
        RETURNING product_id`,
          [qtd, item.variant_id]
        );
        if (!rows.length) continue; // variante apagada: nada a devolver
        produtoId = produtoId || rows[0].product_id;
      } else if (item.product_id) {
        const { rowCount } = await c.query(
          `UPDATE products SET stock_qty = stock_qty + $1, updated_at = NOW()
            WHERE id = $2`,
          [qtd, item.product_id]
        );
        if (!rowCount) continue; // produto apagado
      } else {
        continue;
      }
      devolvidos++;

      if (produtoId) {
        await c.query(
          `INSERT INTO stock_movements
             (product_id, company_id, type, quantity, reference_id, reference_type, notes)
           SELECT p.id, p.company_id, 'in', $2, $3, '${REFERENCIA}', $4
             FROM products p WHERE p.id = $1`,
          [produtoId, qtd, orderId, item.variant_id ? `${nota} (variação)` : nota]
        );
      }
    }

    await c.query(
      `UPDATE digital_orders SET stock_deducted = FALSE WHERE id = $1`,
      [orderId]
    );

    if (proprio) await c.query('COMMIT');
    return { devolvido: true, itens: devolvidos };
  } catch (err) {
    if (proprio) {
      try { await c.query('ROLLBACK'); } catch (_) { /* conexao ja caiu */ }
    }
    throw err;
  } finally {
    if (proprio && typeof c.release === 'function') c.release();
  }
}

module.exports = { devolverEstoqueDoPedido, REFERENCIA };
