// ============================================================
// AURA. — Service: Confirmacao de Pedido do Canal Digital
//
// Centraliza as 4 acoes que rolam quando um pedido digital vira 'confirmed':
//   1. BAIXA DE ESTOQUE: deduz product_variants.stock_qty (se item tem variant)
//      ou products.stock_qty. Idempotente via flag digital_orders.stock_deducted.
//   2. MATCH/CRIA CLIENTE: busca em customers da empresa por phone normalizado
//      (so digitos). Se acha: linka pedido + atualiza counters/last_purchase_at.
//      Se nao: cria novo cliente. Salva customer_id em digital_orders.
//   3. LANCAMENTO FINANCEIRO: cria transaction (income/confirmed/Canal Digital)
//      com idempotency_key = 'digital-order-{order_id}'. Se ja existe, skip.
//      Salva transaction_id em digital_orders.
//   4. NFCe AUTOMATICA (se nfce_requested): emite via nfceEmissionService.
//      Skip silencioso se NFCe nao configurada na empresa. Salva nfce_id.
//
// TUDO DENTRO DE UMA TRANSACAO SQL — atomicidade garantida. Se qualquer
// passo falhar, ROLLBACK e nada parcial fica.
//
// Idempotente: pode ser chamado multiplas vezes pro mesmo pedido sem
// duplicar (cada passo checa o flag/coluna correspondente).
//
// Uso: chamado em 2 pontos:
//   - routes/digitalOrders.js POST /:oid/approve-payment (Pix manual confirmado)
//   - routes/storefront.js   POST /:slug/order (on_delivery — cria ja confirmed)
//
// 01/09/2026 — ESTOQUE BAIXO. A baixa do passo 2 e a unica consequencia da
// venda online que a lojista NAO via em lugar nenhum: o produto atravessava o
// minimo em silencio e ela so descobria no proximo pedido, sem estoque. O
// UPDATE agora devolve o estado pos-baixa e, DEPOIS do COMMIT, emitimos
// 'loja_estoque_baixo' para os que CRUZARAM a linha nesta venda (estavam
// acima do minimo, ficaram no minimo ou abaixo). "Cruzou", e nao "esta
// baixo", porque senao todo pedido seguinte do mesmo produto repetiria o
// aviso ate alguem repor — o sino viraria ruido e ela pararia de olhar.
//
// Fora do COMMIT de proposito: notificar nunca pode derrubar (nem atrasar,
// nem manter transacao aberta durante) o fluxo que baixa estoque e lanca
// financeiro. Vale so para item sem variante — product_variants nao tem
// stock_min, entao para variante nao existe "linha" para cruzar.
// ============================================================
'use strict';

const db = require('../config/database');
const { emitForDigitalOrder } = require('./nfceEmissionService');
const lojaEvents = require('./lojaEvents');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function onOrderConfirmed(orderId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Carrega pedido + items ──────────────────────────────
    const { rows: orders } = await client.query(
      `SELECT * FROM digital_orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!orders.length) {
      await client.query('ROLLBACK');
      console.warn('[orderConfirmation] pedido nao encontrado:', orderId);
      return null;
    }
    const order = orders[0];

    if (order.status !== 'confirmed') {
      // Defensive: so processa se de fato confirmado
      await client.query('ROLLBACK');
      console.warn('[orderConfirmation] pedido nao esta confirmed (status=' + order.status + '):', orderId);
      return null;
    }

    const { rows: items } = await client.query(
      `SELECT * FROM digital_order_items WHERE order_id = $1`, [orderId]);

    // ── 2. BAIXA DE ESTOQUE (idempotente via stock_deducted flag) ──
    // crossedMinimum: produtos que ATRAVESSARAM o estoque minimo nesta venda.
    // Enviado ao sino depois do COMMIT (ver cabecalho).
    const crossedMinimum = [];
    if (!order.stock_deducted) {
      for (const item of items) {
        if (item.variant_id) {
          // Variante: deduz product_variants.stock_qty
          await client.query(
            `UPDATE product_variants
                SET stock_qty = GREATEST(0, stock_qty - $1)
              WHERE id = $2`,
            [item.quantity, item.variant_id]
          );
        } else if (item.product_id) {
          // Produto sem variante: deduz products.stock_qty
          const { rows: after } = await client.query(
            `UPDATE products
                SET stock_qty = GREATEST(0, stock_qty - $1),
                    updated_at = NOW()
              WHERE id = $2
          RETURNING id, name, stock_qty, stock_min`,
            [item.quantity, item.product_id]
          );
          const p = after[0];
          if (p && Number(p.stock_min) > 0 &&
              Number(p.stock_qty) <= Number(p.stock_min) &&
              Number(p.stock_qty) + Number(item.quantity) > Number(p.stock_min)) {
            crossedMinimum.push(p);
          }
        }
      }
      await client.query(
        `UPDATE digital_orders SET stock_deducted = TRUE WHERE id = $1`,
        [orderId]
      );
    }

    // ── 3. MATCH/CRIA CLIENTE (por phone normalizado) ──────────
    let clienteNovo = false;
    let customerId = order.customer_id;
    if (!customerId) {
      const phoneNorm = normalizePhone(order.customer_phone);

      if (phoneNorm) {
        // Tenta achar cliente existente: phone igual (apos normalizar) na mesma empresa
        const { rows: existing } = await client.query(
          `SELECT id, name, email
             FROM customers
            WHERE company_id = $1
              AND regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = $2
            LIMIT 1`,
          [order.company_id, phoneNorm]
        );

        if (existing.length) {
          customerId = existing[0].id;
          // Atualiza name/email se vazios + counters + last_purchase_at
          await client.query(
            `UPDATE customers SET
                name             = CASE WHEN COALESCE(name,'') = '' THEN $1 ELSE name END,
                email            = COALESCE(NULLIF(email, ''), $2),
                total_purchases  = COALESCE(total_purchases, 0) + 1,
                total_spent      = COALESCE(total_spent, 0)     + $3,
                last_purchase_at = NOW(),
                first_purchase_at = COALESCE(first_purchase_at, NOW()),
                updated_at       = NOW()
              WHERE id = $4`,
            [order.customer_name, order.customer_email, order.total, customerId]
          );
        } else {
          // Cria novo cliente
          // 01/09/2026: "nao achei pelo telefone" e literalmente o PRIMEIRO
          // pedido deste cliente. Guardamos a flag e avisamos apos o COMMIT
          // (grupo B — 'loja_novo_cliente').
          clienteNovo = true;
          const { rows: created } = await client.query(
            `INSERT INTO customers (
                company_id, name, phone, email,
                total_purchases, total_spent, last_purchase_at, first_purchase_at,
                is_active, lgpd_consent
              ) VALUES (
                $1, $2, $3, $4,
                1, $5, NOW(), NOW(),
                TRUE, FALSE
              ) RETURNING id`,
            [order.company_id, order.customer_name, order.customer_phone,
             order.customer_email, order.total]
          );
          customerId = created[0].id;
        }

        await client.query(
          `UPDATE digital_orders SET customer_id = $1 WHERE id = $2`,
          [customerId, orderId]
        );
      }
    }

    // ── 4. LANCAMENTO FINANCEIRO (idempotente via idempotency_key) ──
    let transactionId = order.transaction_id;
    if (!transactionId) {
      const idempotencyKey = 'digital-order-' + order.id;

      // Checa se ja existe
      const { rows: existing } = await client.query(
        `SELECT id FROM transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );

      if (existing.length) {
        transactionId = existing[0].id;
      } else {
        const description = 'Pedido digital #' + (order.order_number || order.id.slice(0, 8));
        const paymentMethod = order.payment_method === 'pix' ? 'pix' :
                              order.payment_method === 'on_delivery' ? 'cash' :
                              order.payment_method || null;

        const { rows: created } = await client.query(
          `INSERT INTO transactions (
              company_id, idempotency_key, type, status,
              amount, description, category,
              due_date, paid_at, payment_method
            ) VALUES (
              $1, $2, 'income', 'confirmed',
              $3, $4, 'Canal Digital',
              CURRENT_DATE, NOW(), $5
            ) RETURNING id`,
          [order.company_id, idempotencyKey, order.total, description, paymentMethod]
        );
        transactionId = created[0].id;
      }

      await client.query(
        `UPDATE digital_orders SET transaction_id = $1 WHERE id = $2`,
        [transactionId, orderId]
      );
    }

    // ── 5. NFCe AUTOMATICA (se solicitada) ─────────────────────
    // Emite se cliente marcou checkbox 'Quero CPF na nota' OU informou CPF/CNPJ.
    // Se NFCe nao configurada na empresa, retorna skipped — nao bloqueia pedido.
    let nfceResult = null;
    let nfceFalhou = null;
    const wantsNfce = order.nfce_requested || (order.customer_cpf_cnpj && String(order.customer_cpf_cnpj).trim());
    if (wantsNfce && !order.nfce_id) {
      try {
        nfceResult = await emitForDigitalOrder({ orderId, dbClient: client });
        if (nfceResult.skipped) {
          console.warn('[orderConfirmation] NFCe skipped:', nfceResult.reason, 'order:', orderId);
        }
      } catch (nfceErr) {
        // Nao falha o COMMIT por erro de NFCe — apenas log
        console.error('[orderConfirmation] NFCe emit error:', nfceErr.message);
        // 01/09/2026 (grupo B): este console.error era o unico lugar onde a
        // falha aparecia. O cliente pediu nota no checkout, a nota nao saiu e
        // ninguem ficava sabendo ate ele cobrar. Avisamos apos o COMMIT.
        // `skipped` NAO conta: e a empresa sem NFC-e configurada, que e o
        // caso da maioria — notificar isso seria ruido diario.
        nfceFalhou = nfceErr.message || 'erro na emissao';
      }
    }

    await client.query('COMMIT');

    // Fire-and-forget, ja fora da transacao. Um aviso por PEDIDO listando o
    // que cruzou o minimo (dedupe_key 'loja:estoque_baixo:<order_id>'), e nao
    // um por produto: a lojista quer uma linha "reponha isto", nao tres sinos.
    if (clienteNovo) {
      lojaEvents.emit('loja_novo_cliente', {
        id: orderId, company_id: order.company_id,
        order_number: order.order_number, customer_name: order.customer_name,
        total: order.total, vertical: order.vertical,
      });
    }

    if (nfceFalhou) {
      lojaEvents.emit('loja_nfce_falhou',
        { id: orderId, company_id: order.company_id },
        { body: `O cliente pediu nota fiscal e a emissão falhou (${nfceFalhou}). Emita manualmente antes de entregar.` });
    }

    if (crossedMinimum.length) {
      const lista = crossedMinimum
        .map((p) => `${p.name} (${p.stock_qty} de mínimo ${p.stock_min})`)
        .join('; ');
      lojaEvents.emit('loja_estoque_baixo',
        { id: orderId, company_id: order.company_id },
        { body: `A venda online derrubou ${crossedMinimum.length === 1 ? 'um produto' : crossedMinimum.length + ' produtos'} até o estoque mínimo: ${lista}. Reponha antes de vender de novo.` });
    }

    return { customerId, transactionId, stockDeducted: true, nfce: nfceResult, crossedMinimum };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[orderConfirmation] erro:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { onOrderConfirmed };
