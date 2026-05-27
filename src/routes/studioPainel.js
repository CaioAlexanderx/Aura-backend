// ============================================================
// AURA Studio - Painel agregado
//
// GET /companies/:id/studio/painel?days=N (N in {1,7,30}, default 7)
//
// Endpoint criado em arquivo separado pra nao inflar studio.js (40kb+).
// Toda subquery em try/catch isolado: se uma falhar, log via console.error
// e retorna zeros pra aquele bloco — response inteiro NUNCA quebra.
// (mesma estrategia defensiva de studioKdsApproval.js GET /orders).
//
// Fontes:
// - studio_orders (view 25/05 unindo digital + pdv + marketplace) — vendas,
//   faturamento, ticket, top produtos
// - studio_compositions_summary — custo de insumos por produto (lucro bruto)
// - studio_approval_links — funil de aprovacao
//
// Visibility: cada empresa ve APENAS SEUS pedidos (company_id = req.params.id),
// porque studio_orders view ja filtra digital_orders/sales/marketplace_orders
// por company_id e nao tem is_group_shared. Top produtos JOIN com products
// usa visibilidade canonica (matriz + sub-filial via billing_owner_company_id).
//
// 26/05/2026 — Painel Studio inicial
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// Visibility canonica de products (mesma de studioSaleItemPatch.js / products.js)
// Usada apenas no JOIN com products do "top produtos" — pedidos em si filtram
// por company_id direto.
function productsVisibilityWhere(cidParam) {
  return `(company_id = ${cidParam} OR (
    is_group_shared = true
    AND company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

// Helpers
function pct(numer, denom) {
  if (!denom || denom <= 0) return null;
  return Math.round(((numer - denom) / denom) * 100);
}

function safeDays(input) {
  const n = parseInt(input);
  if (n === 1 || n === 7 || n === 30) return n;
  // Clamp pra valor seguro mais proximo
  if (!n || isNaN(n)) return 7;
  return Math.max(1, Math.min(30, n));
}

const DAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

function formatLabel(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  try {
    const d = new Date(dateStr + 'T12:00:00Z'); // meio-dia UTC pra evitar TZ skew
    return DAY_LABELS_PT[d.getUTCDay()] || '';
  } catch (_) { return ''; }
}

function todayIso() {
  // YYYY-MM-DD no fuso do servidor (Postgres usa CURRENT_DATE no mesmo fuso)
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── GET /studio/painel ─────────────────────────────────────
router.get('/painel', async function(req, res) {
  const cid = req.params.id;
  const days = safeDays(req.query.days);

  // Zeros default — qualquer subquery que falhar mantem esses defaults.
  const out = {
    period_days: days,
    computed_at: new Date().toISOString(),
    kpis: {
      vendas_dia: { total: 0, qty: 0, ticket: 0, delta_pct: null },
      ticket_medio: { value: 0, qty_periodo: 0, total_periodo: 0, delta_pct: null },
      lucro_bruto_mes: {
        value: 0, margem_pct: null, custo_insumos: 0, receita_mes: 0, delta_pct: null,
      },
    },
    faturamento_serie: [],
    top_produtos: [],
    funil_aprovacao: {
      total: 0, pending: 0, approved: 0, changes_requested: 0, expired: 0,
      conversion_first_try_pct: null, avg_response_minutes: null,
    },
  };

  // ─── 1. KPI Vendas Dia (hoje vs ontem) ────────────────────
  // Usa studio_orders view (unifica digital + pdv + marketplace).
  try {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN created_at::date = CURRENT_DATE THEN total_amount ELSE 0 END), 0)::float AS hoje_total,
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int                                   AS hoje_qty,
         COALESCE(SUM(CASE WHEN created_at::date = CURRENT_DATE - INTERVAL '1 day' THEN total_amount ELSE 0 END), 0)::float AS ontem_total
       FROM studio_orders
       WHERE company_id = $1
         AND created_at::date >= CURRENT_DATE - INTERVAL '1 day'
         AND COALESCE(status, 'completed') NOT IN ('cancelled', 'cancelado')`,
      [cid]
    );
    const row = r.rows[0] || {};
    const hojeTotal = parseFloat(row.hoje_total) || 0;
    const hojeQty   = parseInt(row.hoje_qty) || 0;
    const ontemTotal = parseFloat(row.ontem_total) || 0;
    out.kpis.vendas_dia = {
      total:     hojeTotal,
      qty:       hojeQty,
      ticket:    hojeQty > 0 ? Math.round((hojeTotal / hojeQty) * 100) / 100 : 0,
      delta_pct: pct(hojeTotal, ontemTotal),
    };
  } catch (err) {
    console.error('[studio/painel][vendas_dia]', err.message);
  }

  // ─── 2. KPI Ticket Medio (periodo atual vs periodo anterior do mesmo tamanho) ─
  try {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN created_at >= NOW() - ($1 || ' days')::interval THEN total_amount ELSE 0 END), 0)::float AS atual_total,
         COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' days')::interval)::int                                     AS atual_qty,
         COALESCE(SUM(CASE WHEN created_at >= NOW() - (($1::int * 2) || ' days')::interval
                            AND created_at <  NOW() - ($1 || ' days')::interval
                       THEN total_amount ELSE 0 END), 0)::float AS prev_total,
         COUNT(*) FILTER (WHERE created_at >= NOW() - (($1::int * 2) || ' days')::interval
                            AND created_at <  NOW() - ($1 || ' days')::interval)::int AS prev_qty
       FROM studio_orders
       WHERE company_id = $2
         AND created_at >= NOW() - (($1::int * 2) || ' days')::interval
         AND COALESCE(status, 'completed') NOT IN ('cancelled', 'cancelado')`,
      [String(days), cid]
    );
    const row = r.rows[0] || {};
    const atualTotal = parseFloat(row.atual_total) || 0;
    const atualQty   = parseInt(row.atual_qty) || 0;
    const prevTotal  = parseFloat(row.prev_total) || 0;
    const prevQty    = parseInt(row.prev_qty) || 0;
    const atualTicket = atualQty > 0 ? atualTotal / atualQty : 0;
    const prevTicket  = prevQty  > 0 ? prevTotal  / prevQty  : 0;
    out.kpis.ticket_medio = {
      value:         Math.round(atualTicket * 100) / 100,
      qty_periodo:   atualQty,
      total_periodo: Math.round(atualTotal * 100) / 100,
      delta_pct:     pct(atualTicket, prevTicket),
    };
  } catch (err) {
    console.error('[studio/painel][ticket_medio]', err.message);
  }

  // ─── 3. KPI Lucro Bruto Mes (receita - custo de insumos consumidos) ──
  // Receita: studio_orders no mes corrente
  // Custo: SUM(qty_vendida * composition_summary.total_cost) por produto
  // Produtos sem composicao -> custo=0 (lucro=receita desse produto)
  // Comparativo: mes anterior (lucro vs lucro)
  try {
    // 3a. Receita mes atual + mes anterior
    const rec = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN total_amount ELSE 0 END), 0)::float AS receita_atual,
         COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
                            AND created_at <  DATE_TRUNC('month', CURRENT_DATE)
                       THEN total_amount ELSE 0 END), 0)::float AS receita_prev
       FROM studio_orders
       WHERE company_id = $1
         AND created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
         AND COALESCE(status, 'completed') NOT IN ('cancelled', 'cancelado')`,
      [cid]
    );
    const receitaAtual = parseFloat(rec.rows[0]?.receita_atual) || 0;
    const receitaPrev  = parseFloat(rec.rows[0]?.receita_prev)  || 0;

    // 3b. Custo insumos mes atual + mes anterior
    // Soma quantidade vendida * total_cost da composicao do produto.
    // Fonte: digital_order_items + sale_items (cobre os 2 canais com tabelas).
    // Marketplace items vivem em JSONB, ignorado por enquanto (raro pra Studio).
    let custoAtual = 0, custoPrev = 0;
    try {
      const cAtual = await db.query(
        `SELECT COALESCE(SUM(consumo), 0)::float AS custo
           FROM (
             SELECT (oi.quantity * COALESCE(s.total_cost, 0)) AS consumo
               FROM digital_order_items oi
               JOIN digital_orders d ON d.id = oi.order_id
               LEFT JOIN studio_compositions_summary s ON s.product_id = oi.product_id AND s.company_id = d.company_id
              WHERE d.company_id = $1
                AND d.vertical = 'studio'
                AND d.created_at >= DATE_TRUNC('month', CURRENT_DATE)
                AND COALESCE(d.status, 'completed') NOT IN ('cancelled', 'cancelado')
             UNION ALL
             SELECT (si.quantity * COALESCE(s.total_cost, 0)) AS consumo
               FROM sale_items si
               JOIN sales sa ON sa.id = si.sale_id
               LEFT JOIN studio_compositions_summary s ON s.product_id = si.product_id AND s.company_id = sa.company_id
              WHERE sa.company_id = $1
                AND sa.studio_production_status IS NOT NULL
                AND sa.created_at >= DATE_TRUNC('month', CURRENT_DATE)
                AND COALESCE(sa.status, 'completed') NOT IN ('cancelled', 'cancelado')
           ) t`,
        [cid]
      );
      custoAtual = parseFloat(cAtual.rows[0]?.custo) || 0;
    } catch (e) {
      console.error('[studio/painel][custo_atual]', e.message);
    }
    try {
      const cPrev = await db.query(
        `SELECT COALESCE(SUM(consumo), 0)::float AS custo
           FROM (
             SELECT (oi.quantity * COALESCE(s.total_cost, 0)) AS consumo
               FROM digital_order_items oi
               JOIN digital_orders d ON d.id = oi.order_id
               LEFT JOIN studio_compositions_summary s ON s.product_id = oi.product_id AND s.company_id = d.company_id
              WHERE d.company_id = $1
                AND d.vertical = 'studio'
                AND d.created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
                AND d.created_at <  DATE_TRUNC('month', CURRENT_DATE)
                AND COALESCE(d.status, 'completed') NOT IN ('cancelled', 'cancelado')
             UNION ALL
             SELECT (si.quantity * COALESCE(s.total_cost, 0)) AS consumo
               FROM sale_items si
               JOIN sales sa ON sa.id = si.sale_id
               LEFT JOIN studio_compositions_summary s ON s.product_id = si.product_id AND s.company_id = sa.company_id
              WHERE sa.company_id = $1
                AND sa.studio_production_status IS NOT NULL
                AND sa.created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
                AND sa.created_at <  DATE_TRUNC('month', CURRENT_DATE)
                AND COALESCE(sa.status, 'completed') NOT IN ('cancelled', 'cancelado')
           ) t`,
        [cid]
      );
      custoPrev = parseFloat(cPrev.rows[0]?.custo) || 0;
    } catch (e) {
      console.error('[studio/painel][custo_prev]', e.message);
    }

    const lucroAtual = receitaAtual - custoAtual;
    const lucroPrev  = receitaPrev  - custoPrev;
    const margemPct  = receitaAtual > 0 ? Math.round((lucroAtual / receitaAtual) * 100) : null;

    out.kpis.lucro_bruto_mes = {
      value:         Math.round(lucroAtual * 100) / 100,
      margem_pct:    margemPct,
      custo_insumos: Math.round(custoAtual * 100) / 100,
      receita_mes:   Math.round(receitaAtual * 100) / 100,
      delta_pct:     pct(lucroAtual, lucroPrev),
    };
  } catch (err) {
    console.error('[studio/painel][lucro_bruto_mes]', err.message);
  }

  // ─── 4. Faturamento Serie (N pontos: hoje no fim) ────────
  try {
    const r = await db.query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS date_iso,
              COALESCE(SUM(o.total_amount), 0)::float AS value,
              COUNT(o.id)::int AS qty
         FROM generate_series(CURRENT_DATE - (($1::int - 1) || ' days')::interval, CURRENT_DATE, INTERVAL '1 day') d
         LEFT JOIN studio_orders o
                ON o.company_id = $2
               AND o.created_at::date = d::date
               AND COALESCE(o.status, 'completed') NOT IN ('cancelled', 'cancelado')
        GROUP BY d
        ORDER BY d ASC`,
      [String(days), cid]
    );
    const today = todayIso();
    out.faturamento_serie = r.rows.map((row) => ({
      date:     row.date_iso,
      label:    formatLabel(row.date_iso),
      value:    Math.round((parseFloat(row.value) || 0) * 100) / 100,
      qty:      parseInt(row.qty) || 0,
      is_today: row.date_iso === today,
    }));
  } catch (err) {
    console.error('[studio/painel][faturamento_serie]', err.message);
  }

  // ─── 5. Top 5 produtos (revenue desc) ────────────────────
  // Soma quantity/revenue de digital_order_items + sale_items no periodo,
  // JOIN com products pra pegar nome (com visibility canonica pro caso de
  // produto compartilhado matriz).
  try {
    const r = await db.query(
      `WITH itens AS (
         SELECT oi.product_id, oi.product_name, oi.quantity::float AS qty,
                (oi.quantity * oi.unit_price)::float AS revenue
           FROM digital_order_items oi
           JOIN digital_orders d ON d.id = oi.order_id
          WHERE d.company_id = $1
            AND d.vertical = 'studio'
            AND d.created_at >= NOW() - ($2 || ' days')::interval
            AND COALESCE(d.status, 'completed') NOT IN ('cancelled', 'cancelado')
         UNION ALL
         SELECT si.product_id, NULL::text AS product_name, si.quantity::float AS qty,
                (si.quantity * si.unit_price)::float AS revenue
           FROM sale_items si
           JOIN sales sa ON sa.id = si.sale_id
          WHERE sa.company_id = $1
            AND sa.studio_production_status IS NOT NULL
            AND sa.created_at >= NOW() - ($2 || ' days')::interval
            AND COALESCE(sa.status, 'completed') NOT IN ('cancelled', 'cancelado')
       )
       SELECT itens.product_id,
              COALESCE(MAX(p.name), MAX(itens.product_name), 'Produto') AS name,
              SUM(itens.revenue)::float AS revenue,
              SUM(itens.qty)::float     AS qty
         FROM itens
         LEFT JOIN products p
                ON p.id = itens.product_id
               AND ${productsVisibilityWhere('$1')}
        WHERE itens.product_id IS NOT NULL
        GROUP BY itens.product_id
        ORDER BY revenue DESC NULLS LAST
        LIMIT 5`,
      [cid, String(days)]
    );
    out.top_produtos = r.rows.map((row) => ({
      product_id: row.product_id,
      name:       row.name || 'Produto',
      revenue:    Math.round((parseFloat(row.revenue) || 0) * 100) / 100,
      qty:        Math.round((parseFloat(row.qty) || 0) * 100) / 100,
    }));
  } catch (err) {
    console.error('[studio/painel][top_produtos]', err.message);
  }

  // ─── 6. Funil de aprovacao ───────────────────────────────
  try {
    const r = await db.query(
      `SELECT
         COUNT(*)::int                                                              AS total,
         COUNT(*) FILTER (WHERE status = 'pending')::int                            AS pending,
         COUNT(*) FILTER (WHERE status = 'approved')::int                           AS approved,
         COUNT(*) FILTER (WHERE status = 'changes_requested')::int                  AS changes_requested,
         COUNT(*) FILTER (WHERE status = 'expired')::int                            AS expired,
         AVG(CASE WHEN responded_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (responded_at - created_at)) / 60.0
                  ELSE NULL END)::float                                             AS avg_response_minutes
       FROM studio_approval_links
       WHERE company_id = $1
         AND created_at >= NOW() - ($2 || ' days')::interval`,
      [cid, String(days)]
    );
    const row = r.rows[0] || {};
    const total = parseInt(row.total) || 0;
    const approved = parseInt(row.approved) || 0;
    out.funil_aprovacao = {
      total,
      pending:           parseInt(row.pending) || 0,
      approved,
      changes_requested: parseInt(row.changes_requested) || 0,
      expired:           parseInt(row.expired) || 0,
      conversion_first_try_pct: total > 0 ? Math.round((approved / total) * 100) : null,
      avg_response_minutes:     row.avg_response_minutes != null
        ? Math.round(parseFloat(row.avg_response_minutes))
        : null,
    };
  } catch (err) {
    console.error('[studio/painel][funil_aprovacao]', err.message);
  }

  res.json(out);
});

module.exports = router;
