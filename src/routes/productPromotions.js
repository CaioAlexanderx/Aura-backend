// ============================================================
// AURA. — Promocao em lote, De/Por (p-84, 08/11/2026, migration 427)
// Mount: /companies/:id/products  (ANTES de ./products, que tem /:pid curinga)
//
// POST /promotions           previa (dry_run, padrao) ou aplicar.
// POST /promotions/encerrar  encerra agora (limpa os 3 campos); dry_run idem.
// GET  /promotions?status=ativa|agendada|encerrada   lista (pagina Black Friday).
//
// Contrato com o app (p-86/p-87): contrato-de-por.md. Conta pura em
// services/promocaoEmLote.js; preco que vale agora em services/precoEfetivo.js.
//
// Regras:
//   - So produtos ATIVOS e visiveis para a empresa (da empresa ou
//     compartilhado no grupo, bidirecional — mesma regra da listagem).
//     Produto compartilhado e UMA linha: a promocao vale no grupo todo; a
//     previa sinaliza (group_shared / owner_is_other).
//   - Ate 2.000 alvos por chamada (o app divide acima disso).
//   - So grava promo_price/promo_starts_at/promo_ends_at. Nunca muda preco
//     normal, custo, estoque nem codigo.
//   - Aplicar: transacao, linhas travadas (FOR UPDATE) e a conta refeita
//     com elas; audit_log depois do COMMIT (com a promocao substituida, para
//     dar para refazer a mao).
//   - Permissao: quem pode editar produto. O perfil "Estoque so consulta"
//     leva 403 no middleware estoqueSoConsulta (montado antes de todo
//     /products em private.js): escrita fechada e GET /promotions fora das
//     leituras liberadas.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { logAuditAction, contextoDaRequisicao } = require('../middleware/auditLog');
const { productVisibilityWhere } = require('../utils/companyGroup');
const {
  lerPedido, lerPedidoEncerrar, montarPrevia, montarEncerrar, itemPublico,
} = require('../services/promocaoEmLote');

const MIGRATION_PENDING = {
  error: 'A promocao em lote ainda esta sendo instalada. Tente de novo em alguns minutos.',
  code: 'MIGRATION_PENDING',
};
const faltaMigration = (err) => err && (err.code === '42703' || err.code === '42P01');

async function tamanhoDoGrupo(q, cid) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1
      )`,
    [cid]
  );
  return rows[0] ? rows[0].n : 1;
}

/** Produtos e variantes ativas dos alvos. `travar` = FOR UPDATE (aplicar). */
async function lerLinhas(q, cid, alvos, travar) {
  const ids = [...new Set(alvos.map((a) => a.product_id))];
  const { rows: products } = await q(
    `SELECT p.id, p.company_id, p.name, p.sku, p.price, p.cost_price, p.is_group_shared,
            p.promo_price, p.promo_starts_at, p.promo_ends_at
       FROM products p
      WHERE p.is_active = true AND p.id = ANY($2::uuid[]) AND ${productVisibilityWhere('$1', 'p.')}
      ${travar ? 'FOR UPDATE OF p' : ''}`,
    [cid, ids]
  );
  if (!products.length) return { products, variants: [] };
  const { rows: variants } = await q(
    `SELECT pv.id, pv.product_id, pv.price_override, pv.sku_suffix,
            pv.promo_price, pv.promo_starts_at, pv.promo_ends_at,
            COALESCE(
              (SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
                 FROM product_variant_values pvv WHERE pvv.variant_id = pv.id),
              pv.sku_suffix
            ) AS label
       FROM product_variants pv
      WHERE pv.product_id = ANY($1::uuid[]) AND pv.is_active = true
      ${travar ? 'FOR UPDATE OF pv' : ''}`,
    [products.map((p) => p.id)]
  );
  return { products, variants };
}

function resposta(input, previa, extra = {}) {
  return {
    dry_run: input.dryRun,
    items: previa.items.map(itemPublico),
    fora: previa.fora,
    ...extra,
  };
}

// ─── POST /promotions ─────────────────────────────────────
router.post('/promotions', async (req, res) => {
  const cid = req.params.id;
  const agora = new Date();
  const lido = lerPedido(req.body, agora);
  if (lido.error) return res.status(400).json({ error: lido.error, code: lido.code });
  const input = lido.input;

  if (input.dryRun) {
    try {
      const q = (sql, p) => db.query(sql, p);
      const groupSize = await tamanhoDoGrupo(q, cid);
      const { products, variants } = await lerLinhas(q, cid, input.alvos, false);
      const previa = montarPrevia({ products, variants, input, companyId: cid, groupSize, agora });
      return res.json(resposta(input, previa));
    } catch (err) {
      if (faltaMigration(err)) return res.status(503).json(MIGRATION_PENDING);
      console.error('[promotions] previa:', err.message, err.code);
      return res.status(500).json({ error: 'Erro ao calcular a promocao' });
    }
  }

  const client = await db.connect();
  let previa;
  try {
    await client.query('BEGIN');
    const q = (sql, p) => client.query(sql, p);
    const groupSize = await tamanhoDoGrupo(q, cid);
    const { products, variants } = await lerLinhas(q, cid, input.alvos, true);
    previa = montarPrevia({ products, variants, input, companyId: cid, groupSize, agora });
    const prods = previa.items.filter((i) => i.variant_id === null);
    const vars = previa.items.filter((i) => i.variant_id !== null);
    if (prods.length) {
      await q(
        `UPDATE products p
            SET promo_price = v.promo, promo_starts_at = $3, promo_ends_at = $4, updated_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[]) AS v(id, promo)
          WHERE p.id = v.id`,
        [prods.map((i) => i.product_id), prods.map((i) => i._promoCents / 100), input.startsAt, input.endsAt]
      );
    }
    if (vars.length) {
      await q(
        `UPDATE product_variants pv
            SET promo_price = v.promo, promo_starts_at = $3, promo_ends_at = $4, updated_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[]) AS v(id, promo)
          WHERE pv.id = v.id`,
        [vars.map((i) => i.variant_id), vars.map((i) => i._promoCents / 100), input.startsAt, input.endsAt]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (faltaMigration(err)) return res.status(503).json(MIGRATION_PENDING);
    console.error('[promotions] aplicar:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao aplicar a promocao' });
  } finally {
    if (client.release) client.release();
  }

  const items = previa.items;
  if (items.length) {
    const substituidas = items.filter((i) => i.ja_em_promocao);
    logAuditAction(
      req.user?.id || null, cid, 'products.promotion_applied',
      `Promocao em lote (${input.modo}) em ${items.length} itens`,
      {
        modo: input.modo, valor: input.valor, terminacao: input.terminacao,
        starts_at: input.startsAt.toISOString(), ends_at: input.endsAt.toISOString(),
        items_count: items.length, fora_count: previa.fora.length,
        abaixo_do_custo_count: items.filter((i) => i.abaixo_do_custo).length,
        substituidas_count: substituidas.length,
        items: items.map((i) => [i.product_id, i.variant_id, i.preco_de, i.preco_por]),
        substituidas: substituidas.map((i) => [i.product_id, i.variant_id, i.promo_atual.preco,
          i.promo_atual.starts_at, i.promo_atual.ends_at]),
      },
      contextoDaRequisicao(req)
    );
  }
  return res.json(resposta(input, previa, { aplicados: items.length }));
});

// ─── POST /promotions/encerrar ────────────────────────────
router.post('/promotions/encerrar', async (req, res) => {
  const cid = req.params.id;
  const agora = new Date();
  const lido = lerPedidoEncerrar(req.body);
  if (lido.error) return res.status(400).json({ error: lido.error, code: lido.code });
  const input = lido.input;

  if (input.dryRun) {
    try {
      const q = (sql, p) => db.query(sql, p);
      const { products, variants } = await lerLinhas(q, cid, input.alvos, false);
      return res.json({ dry_run: true, ...montarEncerrar({ products, variants, input, agora }) });
    } catch (err) {
      if (faltaMigration(err)) return res.status(503).json(MIGRATION_PENDING);
      console.error('[promotions] previa encerrar:', err.message, err.code);
      return res.status(500).json({ error: 'Erro ao encerrar a promocao' });
    }
  }

  const client = await db.connect();
  let r;
  try {
    await client.query('BEGIN');
    const q = (sql, p) => client.query(sql, p);
    const { products, variants } = await lerLinhas(q, cid, input.alvos, true);
    r = montarEncerrar({ products, variants, input, agora });
    const pids = r.items.filter((i) => i.variant_id === null).map((i) => i.product_id);
    const vids = r.items.filter((i) => i.variant_id !== null).map((i) => i.variant_id);
    if (pids.length) {
      await q(
        `UPDATE products SET promo_price = NULL, promo_starts_at = NULL, promo_ends_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [pids]
      );
    }
    if (vids.length) {
      await q(
        `UPDATE product_variants SET promo_price = NULL, promo_starts_at = NULL, promo_ends_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [vids]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (faltaMigration(err)) return res.status(503).json(MIGRATION_PENDING);
    console.error('[promotions] encerrar:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao encerrar a promocao' });
  } finally {
    if (client.release) client.release();
  }

  if (r.items.length) {
    logAuditAction(
      req.user?.id || null, cid, 'products.promotion_ended',
      `Encerrou a promocao de ${r.items.length} itens`,
      {
        items_count: r.items.length, fora_count: r.fora.length,
        items: r.items.map((i) => [i.product_id, i.variant_id, i.preco_por, i.status]),
      },
      contextoDaRequisicao(req)
    );
  }
  return res.json({ dry_run: false, ...r, encerrados: r.items.length });
});

// ─── GET /promotions ──────────────────────────────────────
const STATUS = ['ativa', 'agendada', 'encerrada'];
// "Agora" vem do servidor ($2), o mesmo relogio de precoEfetivo.js, que e
// quem decide o preco nos outros leitores.
const STATUS_SQL = (a) => `CASE WHEN ${a}.promo_ends_at <= $2::timestamptz THEN 'encerrada'
                               WHEN ${a}.promo_starts_at > $2::timestamptz THEN 'agendada'
                               ELSE 'ativa' END`;
const MAX_LISTA = 20000;

router.get('/promotions', async (req, res) => {
  const cid = req.params.id;
  const agora = new Date();
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !STATUS.includes(status)) {
    return res.status(400).json({ error: 'status deve ser ativa, agendada ou encerrada', code: 'INVALID_INPUT' });
  }
  const lim = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(lim) && lim > 0 ? lim : MAX_LISTA, MAX_LISTA);
  const off = parseInt(req.query.offset, 10);
  const offset = Number.isFinite(off) && off > 0 ? off : 0;

  // Uma linha por item com promocao gravada: o produto, ou a variante (a
  // base da variante e price_override ?? preco do produto).
  const linhas = `
    SELECT p.id AS product_id, NULL::uuid AS variant_id, p.name AS nome, NULL::text AS variant_label,
           p.sku, p.price AS preco_de, p.promo_price AS preco_por, p.promo_starts_at, p.promo_ends_at,
           p.cost_price, p.is_group_shared, p.company_id, ${STATUS_SQL('p')} AS status
      FROM products p
     WHERE p.is_active = true AND p.promo_price IS NOT NULL AND ${productVisibilityWhere('$1', 'p.')}
    UNION ALL
    SELECT p.id, pv.id, p.name,
           COALESCE((SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
                       FROM product_variant_values pvv WHERE pvv.variant_id = pv.id), pv.sku_suffix),
           p.sku, COALESCE(pv.price_override, p.price), pv.promo_price, pv.promo_starts_at, pv.promo_ends_at,
           p.cost_price, p.is_group_shared, p.company_id, ${STATUS_SQL('pv')}
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
     WHERE p.is_active = true AND pv.is_active = true AND pv.promo_price IS NOT NULL
       AND ${productVisibilityWhere('$1', 'p.')}`;

  try {
    const groupSize = await tamanhoDoGrupo((sql, p) => db.query(sql, p), cid);
    const { rows: contas } = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM (${linhas}) l GROUP BY status`, [cid, agora]
    );
    const resumo = { ativa: 0, agendada: 0, encerrada: 0 };
    for (const c of contas) resumo[c.status] = c.n;
    const params = [cid, agora];
    let filtro = '';
    if (status) { params.push(status); filtro = `WHERE l.status = $${params.length}`; }
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT * FROM (${linhas}) l ${filtro}
        ORDER BY l.promo_ends_at DESC, l.nome, l.product_id, l.variant_id NULLS FIRST
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const items = rows.map((r) => {
      const de = num(r.preco_de);
      const por = num(r.preco_por);
      return {
        product_id: r.product_id,
        variant_id: r.variant_id,
        nome: r.nome,
        variant_label: r.variant_label,
        sku: r.sku || null,
        preco_de: de,
        preco_por: por,
        promo_starts_at: r.promo_starts_at,
        promo_ends_at: r.promo_ends_at,
        status: r.status,
        // "Por" acima do "De" (a lojista baixou o preco normal depois): a
        // promocao nao vale, mesmo dentro das datas.
        em_promocao: r.status === 'ativa' && de !== null && por !== null && Math.round(por * 100) < Math.round(de * 100),
        cost_price: num(r.cost_price) || null,
        group_shared: !!r.is_group_shared && groupSize > 1,
        owner_is_other: String(r.company_id) !== String(cid),
      };
    });
    const total = status ? resumo[status] : resumo.ativa + resumo.agendada + resumo.encerrada;
    return res.json({ status, items, total, resumo, limit, offset });
  } catch (err) {
    if (faltaMigration(err)) {
      return res.json({ status, items: [], total: 0, resumo: { ativa: 0, agendada: 0, encerrada: 0 }, limit, offset });
    }
    console.error('[promotions] lista:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao listar as promocoes' });
  }
});

module.exports = router;
