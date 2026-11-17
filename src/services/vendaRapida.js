// ============================================================
// AURA. — Venda do Caixa com menos idas ao banco (cards p-141 a p-144, em etapas;
// 17/11/2026)
//
// O servico e o banco ficam em regioes diferentes: cada `client.query` em
// fila custa ~190 ms (src/config/database.js). A venda de 1 item no PIX
// fazia 16 idas dentro do handleSale, mais 4 por item. Este arquivo junta as
// consultas que podem ir juntas, SEM mudar o que a venda grava nem o que ela
// responde:
//
//   lerProdutos()    todos os produtos e variacoes da venda numa consulta,
//                    com a promocao De/Por e a vendedora junto (p-141).
//                    Antes: 1 por item, +1 por variacao, +2 da promocao,
//                    +1 da vendedora.
//
// O CAMINHO DE SEMPRE CONTINUA NO CODIGO (routes/pdv.js), intocado:
//   - PDV_VENDA_CAMINHO=fila volta a venda inteira para ele, sem deploy de
//     codigo;
//   - cada funcao daqui devolve null quando o caso foge do comum (id que nao
//     e uuid minusculo) e a venda segue pelo caminho de sempre naquele trecho.
//
// UMA DIFERENCA DE PROPOSITO (p-141/p-142): a leitura dos produtos trava as linhas
// de estoque que a venda vai baixar (FOR NO KEY UPDATE, a mesma trava que o
// UPDATE da baixa ja pegava, so que antes da conferencia). Duas vendas
// simultaneas do ultimo item: a segunda espera a primeira, enxerga o saldo
// ja baixado e recebe o 409 de estoque. No caminho de sempre as duas liam o
// saldo antes de qualquer baixa e as duas entravam.
// ============================================================
'use strict';

const { productVisibilityWhere } = require('../utils/companyGroup');
const vendaNaPromocao = require('./vendaNaPromocao');

// So uuid minusculo no formato canonico entra no caminho novo. Qualquer outra
// forma (maiuscula, sem hifen, texto solto) segue pelo caminho de sempre, que
// trata cada uma como sempre tratou.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ehUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function caminhoRapido() {
  return String(process.env.PDV_VENDA_CAMINHO || '').trim().toLowerCase() !== 'fila';
}

// ── lerProdutos ──────────────────────────────────────────────
/**
 * Le, numa consulta, o que o laco de validacao lia item a item:
 *   - o produto (nome, custo, saldo, empresa dona), pela MESMA regra de
 *     visibilidade (utils/companyGroup.js);
 *   - a variacao (saldo, sufixo), so quando e do produto;
 *   - com `comPromocao`, as colunas da promocao De/Por do produto e da
 *     variacao (o que vendaNaPromocao.marcarItens relia depois);
 *   - com `employeeId`, se a vendedora e da empresa.
 *
 * Trava (FOR NO KEY UPDATE) exatamente as linhas que a venda vai baixar: o
 * produto do item sem variacao e a variacao do item com variacao. O saldo
 * devolvido e o da linha travada. As travas sao pegas em ordem de id, os
 * produtos antes das variacoes.
 *
 * Devolve null quando algum id nao e uuid minusculo (a venda valida item a
 * item, como sempre). Senao:
 *   { porItem: [{ p: [linha]|[], v: [linha]|[], marcacao }|null], vendedora }
 *   porItem[i] e null para item sem product_id; `vendedora` e true/false
 *   quando foi conferida aqui e undefined quando nao foi.
 */
async function lerProdutos(client, { companyId, items, employeeId, comPromocao, agora = new Date() }) {
  if (!ehUuid(companyId)) return null;
  const indices = [];
  for (const [idx, item] of items.entries()) {
    if (!item || !item.product_id) continue;
    if (!ehUuid(item.product_id)) return null;
    if (item.variant_id && !ehUuid(item.variant_id)) return null;
    indices.push(idx);
  }
  const porItem = items.map(() => null);
  if (!indices.length) return { porItem, vendedora: undefined };

  const comVendedora = ehUuid(employeeId);
  const params = [
    indices.map((idx) => items[idx].product_id),
    companyId,
    indices.map((idx) => items[idx].variant_id || null),
  ];
  if (comVendedora) params.push(employeeId);

  const { rows } = await client.query(
    `WITH itens AS (
       SELECT i.ord, i.product_id, i.variant_id
         FROM unnest($1::uuid[], $3::uuid[]) WITH ORDINALITY AS i(product_id, variant_id, ord)
     ),
     prod AS (
       SELECT p.id, p.name, p.cost_price, p.stock_qty, p.company_id
              ${comPromocao ? ', p.price, p.promo_price, p.promo_starts_at, p.promo_ends_at' : ''}
         FROM products p JOIN companies c ON c.id = $2
        WHERE p.id IN (SELECT product_id FROM itens) AND ${productVisibilityWhere('$2', 'p.')}
     ),
     trava_p AS (
       SELECT p.id, p.stock_qty
         FROM products p
        WHERE p.id IN (SELECT i.product_id FROM itens i JOIN prod ON prod.id = i.product_id
                        WHERE i.variant_id IS NULL)
        ORDER BY p.id
          FOR NO KEY UPDATE
     ),
     trava_v AS (
       SELECT v.id, v.product_id, v.stock_qty, v.sku_suffix
              ${comPromocao ? ', v.price_override, v.promo_price, v.promo_starts_at, v.promo_ends_at' : ''}
         FROM product_variants v
        WHERE (v.id, v.product_id) IN (SELECT i.variant_id, i.product_id FROM itens i
                                         JOIN prod ON prod.id = i.product_id
                                        WHERE i.variant_id IS NOT NULL)
          -- as travas dos produtos sao pegas antes das travas das variacoes
          AND (SELECT COUNT(*) FROM trava_p) >= 0
        ORDER BY v.id
          FOR NO KEY UPDATE
     )
     SELECT i.ord, prod.name, prod.cost_price,
            COALESCE(tp.stock_qty, prod.stock_qty) AS stock_qty,
            prod.company_id AS stock_company_id,
            tv.id AS variante_id, tv.stock_qty AS variante_stock_qty, tv.sku_suffix AS variante_sku_suffix
            ${comPromocao ? `, prod.price, prod.promo_price, prod.promo_starts_at, prod.promo_ends_at,
            tv.price_override AS variante_price_override, tv.promo_price AS variante_promo_price,
            tv.promo_starts_at AS variante_promo_starts_at, tv.promo_ends_at AS variante_promo_ends_at` : ''}
            ${comVendedora ? ', (SELECT e.id FROM employees e WHERE e.id = $4 AND e.company_id = $2) AS vendedora_id' : ''}
       FROM itens i
       JOIN prod ON prod.id = i.product_id
       LEFT JOIN trava_p tp ON tp.id = i.product_id AND i.variant_id IS NULL
       LEFT JOIN trava_v tv ON tv.id = i.variant_id AND tv.product_id = i.product_id
      ORDER BY i.ord`,
    params
  );

  for (const idx of indices) porItem[idx] = { p: [], v: [], marcacao: comPromocao ? vendaNaPromocao.NULO : null };
  for (const r of rows) {
    const idx = indices[Number(r.ord) - 1];
    const item = items[idx];
    const alvo = porItem[idx];
    alvo.p = [{ name: r.name, cost_price: r.cost_price, stock_qty: r.stock_qty, stock_company_id: r.stock_company_id }];
    if (item.variant_id && r.variante_id) {
      alvo.v = [{ stock_qty: r.variante_stock_qty, sku_suffix: r.variante_sku_suffix }];
    }
    if (comPromocao) {
      // Mesma conta de vendaNaPromocao.marcarItens, com as linhas ja lidas.
      const produto = {
        price: r.price, promo_price: r.promo_price,
        promo_starts_at: r.promo_starts_at, promo_ends_at: r.promo_ends_at,
      };
      if (!item.variant_id) {
        alvo.marcacao = vendaNaPromocao.marcacaoDoItem(produto, null, agora);
      } else if (r.variante_id) {
        alvo.marcacao = vendaNaPromocao.marcacaoDoItem(produto, {
          price_override: r.variante_price_override, promo_price: r.variante_promo_price,
          promo_starts_at: r.variante_promo_starts_at, promo_ends_at: r.variante_promo_ends_at,
        }, agora);
      }
      // Variacao que nao e deste produto: sem marcacao (NULO), como sempre.
    }
  }
  // Sem nenhuma linha, a subconsulta da vendedora nao foi devolvida.
  const vendedora = comVendedora && rows.length ? !!rows[0].vendedora_id : undefined;
  return { porItem, vendedora };
}

module.exports = {
  caminhoRapido,
  ehUuid,
  lerProdutos,
};
