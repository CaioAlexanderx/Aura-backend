// ============================================================
// AURA. — PDV: Lookup de produto por código (BE-15 + PDV-01)
// Suporta: barcode (EAN-13, CODE-128, QR), SKU, nome parcial
// Retorna variantes quando produto tem variantes cadastradas
// ============================================================
const express = require('express');
const router  = require('express').Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { productVisibilityWhere } = require('../utils/companyGroup');
// p-85 (08/11/2026, migration 427): De/Por. Toda resposta do bipe traz
// promo_price, promo_starts_at, promo_ends_at, em_promocao e preco_efetivo
// (a regra unica de services/precoEfetivo.js). `price`, `price_override` e
// `effective_price` continuam sendo o preco NORMAL, como antes: o Caixa
// novo (app p-87) vende pelo preco_efetivo.
const {
  camposDoProduto, camposDaVariante, colunasPromo, colunasPromoNulas, comColunasPromo,
} = require('../services/precoEfetivo');

// Colunas promo_* no SELECT (ou nulas, na base sem a 427).
const promoDe = (com, alias, prefixo = '') => `, ${com ? colunasPromo(alias, prefixo) : colunasPromoNulas(prefixo)}`;
// As mesmas, dentro do json_build_object das variantes.
const promoNoJson = (com) => (com
  ? `,
                  'promo_price', pv.promo_price, 'promo_starts_at', pv.promo_starts_at,
                  'promo_ends_at', pv.promo_ends_at`
  : `,
                  'promo_price', NULL, 'promo_starts_at', NULL, 'promo_ends_at', NULL`);

/** Produto do bipe com os campos De/Por (e as variantes, quando vierem). */
function comPromo(row, agora) {
  const out = { ...row, ...camposDoProduto(row, agora) };
  if (Array.isArray(row.variants)) {
    out.variants = row.variants.map((v) => ({ ...v, ...camposDaVariante(v, row, agora) }));
  }
  return out;
}

// 22/09/2026 — preco no cartao (migration 351). O Caixa precisa de
// products.card_price junto do preco pra decidir o unit_price quando a
// forma e debito/credito. `rodar(col)` monta o SQL com a coluna; base
// atras da 351 da 42703 e a mesma consulta roda sem ela (o produto volta
// sem card_price e o Caixa usa o % da loja). O backend sobe antes da
// migration (CLAUDE.md, armadilha 1) — bipar nao pode cair por isso.
async function comCardPrice(rodar) {
  try {
    return await rodar(', p.card_price');
  } catch (e) {
    if (e.code !== '42703') throw e;
    return rodar('');
  }
}

// 10/10/2026 — produto compartilhado pelo grupo (is_group_shared). A Villa
// Branca da Davi Calçados vende o catálogo da Matriz: o Estoque lista esses
// produtos (products.js), mas o bipe no Caixa só procurava em
// p.company_id=$1 e respondia "não achei" para TODOS eles.
//
// 02/11/2026 — a regra de 10/10 só olhava a dona do grupo (matriz → filial).
// O Estoque é bidirecional: a matriz também lista o compartilhado da filial,
// e o bipe da matriz dizia "não achei" para ele. Agora é a MESMA função do
// Estoque (utils/companyGroup.js). Empresa de fora do grupo nunca entra.
const DA_LOJA_OU_DO_GRUPO = productVisibilityWhere('$1', 'p.');

// O mesmo código pode existir no produto da loja e num compartilhado de
// outra empresa do grupo: o da própria loja ganha (antes da regra
// bidirecional só havia um candidato possível por grupo).
const DA_LOJA_PRIMEIRO = '(p.company_id=$1) DESC';

// O mesmo código de barras pode estar gravado como UPC-A (12 dígitos) e ser
// lido como EAN-13 (com um zero na frente), ou o contrário. Vinha da cópia
// do /scan/:code em pdv.js, que nunca respondeu (removida em 10/10/2026).
function variacoesDoCodigo(code) {
  const alts = new Set([code]);
  if (/^\d{12}$/.test(code)) alts.add('0' + code);
  if (/^\d{13}$/.test(code) && code.startsWith('0')) alts.add(code.slice(1));
  return [...alts];
}

// GET /companies/:id/pdv/scan/:code
// Lookup chamado pelo PDV ao receber código escaneado (jsQR / leitor USB)
router.get('/scan/:code', requireAuth, async (req, res) => {
  const { id: company_id, code } = req.params;
  const cleanCode = (code || '').trim();
  if (!cleanCode) return res.status(400).json({ error: 'Código não informado' });
  const alts = variacoesDoCodigo(cleanCode);

  try {
    const agora = new Date();
    // 1. Match exato por barcode
    let { rows } = await comColunasPromo((com) => comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.description, p.price, p.cost_price,
              p.stock_qty, p.barcode, p.barcode_format, p.category,
              p.sku, p.is_active, p.unit, p.company_id AS stock_company_id${cp}${promoDe(com, 'p')},
              COALESCE(json_agg(
                json_build_object(
                  'id', pv.id, 'sku_suffix', pv.sku_suffix,
                  'price_override', pv.price_override,
                  'stock_qty', pv.stock_qty, 'barcode', pv.barcode,
                  'attributes', (
                    SELECT json_agg(json_build_object('attr', pvval.attribute_name, 'val', pvval.value))
                    FROM product_variant_values pvval WHERE pvval.variant_id=pv.id
                  )${promoNoJson(com)}
                )
              ) FILTER (WHERE pv.id IS NOT NULL), '[]') AS variants
       FROM products p
       LEFT JOIN product_variants pv ON pv.product_id=p.id AND pv.is_active=TRUE
       WHERE ${DA_LOJA_OU_DO_GRUPO} AND p.barcode=ANY($2::text[]) AND p.is_active=TRUE
       GROUP BY p.id
       ORDER BY ${DA_LOJA_PRIMEIRO}
       LIMIT 1`,
      [company_id, alts]
    )));
    if (rows.length) return res.json({ match: 'exact', source: 'barcode', product: comPromo(rows[0], agora) });

    // 2. Match por barcode de variante
    const { rows: varRows } = await comColunasPromo((com) => comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.stock_qty,
              p.barcode, p.category, p.sku, p.is_active, p.unit, p.company_id AS stock_company_id${cp}${promoDe(com, 'p')},
              pv.id AS variant_id, pv.sku_suffix, pv.price_override,
              pv.stock_qty AS variant_stock${promoDe(com, 'pv', 'variant_')}
       FROM product_variants pv
       JOIN products p ON p.id=pv.product_id
       WHERE ${DA_LOJA_OU_DO_GRUPO} AND pv.barcode=ANY($2::text[]) AND pv.is_active=TRUE AND p.is_active=TRUE
       ORDER BY ${DA_LOJA_PRIMEIRO}
       LIMIT 1`,
      [company_id, alts]
    )));
    if (varRows.length) {
      const { variant_promo_price, variant_promo_starts_at, variant_promo_ends_at, ...linha } = varRows[0];
      const daVariante = camposDaVariante({
        price_override: linha.price_override,
        promo_price: variant_promo_price, promo_starts_at: variant_promo_starts_at, promo_ends_at: variant_promo_ends_at,
      }, linha, agora);
      return res.json({
        match: 'exact', source: 'variant_barcode',
        product: comPromo(linha, agora),
        variant_id: linha.variant_id,
        effective_price: linha.price_override || linha.price,
        // 427: o preco que vale agora PARA A VARIANTE bipada (o do produto
        // esta em product.preco_efetivo).
        ...daVariante,
      });
    }

    // 3. Match por SKU
    ({ rows } = await comColunasPromo((com) => comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.stock_qty,
              p.barcode, p.category, p.sku, p.is_active, p.unit, p.company_id AS stock_company_id${cp}${promoDe(com, 'p')}
       FROM products p
       WHERE ${DA_LOJA_OU_DO_GRUPO} AND p.sku=$2 AND p.is_active=TRUE
       ORDER BY ${DA_LOJA_PRIMEIRO} LIMIT 1`,
      [company_id, cleanCode]
    ))));
    if (rows.length) return res.json({ match: 'exact', source: 'sku', product: comPromo(rows[0], agora) });

    // 4. Busca textual por nome/SKU (retorna até 8 sugestões)
    ({ rows } = await comColunasPromo((com) => comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.stock_qty, p.barcode, p.sku, p.category, p.unit, p.company_id AS stock_company_id${cp}${promoDe(com, 'p')}
       FROM products p
       WHERE ${DA_LOJA_OU_DO_GRUPO} AND p.is_active=TRUE
         AND (p.name ILIKE $2 OR p.sku ILIKE $2)
       ORDER BY p.name LIMIT 8`,
      [company_id, `%${cleanCode}%`]
    ))));
    if (rows.length) {
      return res.status(207).json({
        match: 'partial',
        message: 'Nenhum código exato encontrado. Sugestões:',
        suggestions: rows.map((r) => comPromo(r, agora)),
      });
    }

    res.status(404).json({ match: 'none', error: 'Produto não encontrado', code: cleanCode });
  } catch (err) {
    console.error('scanner lookup error:', err);
    res.status(500).json({ error: 'Erro na busca do código' });
  }
});

// GET /companies/:id/pdv/scan/batch
// Body: { codes: ['123','456'] }
// Lookup em lote para carregar múltiplos itens de uma vez
router.post('/scan/batch', requireAuth, async (req, res) => {
  const { codes } = req.body;
  if (!codes?.length) return res.status(400).json({ error: 'codes obrigatório' });
  try {
    const { rows: linhas } = await comColunasPromo((com) => comCardPrice((cp) => db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.stock_qty, p.barcode, p.sku, p.category, p.unit, p.company_id AS stock_company_id${cp}${promoDe(com, 'p')}
       FROM products p
       WHERE ${DA_LOJA_OU_DO_GRUPO} AND p.is_active=TRUE
         AND (p.barcode=ANY($2) OR p.sku=ANY($2))`,
      [req.params.id, codes]
    )));
    const agora = new Date();
    const rows = linhas.map((r) => comPromo(r, agora));
    // Mesmo código na loja e num compartilhado do grupo: o da loja ganha.
    const byCode = {};
    const guardar = (code, p) => {
      const atual = byCode[code];
      if (!atual || (atual.stock_company_id !== req.params.id && p.stock_company_id === req.params.id)) byCode[code] = p;
    };
    rows.forEach(p => {
      if (p.barcode) guardar(p.barcode, p);
      if (p.sku)     guardar(p.sku, p);
    });
    res.json({ found: rows.length, products: byCode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
