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
// - transactions (canonica do Financeiro — espelha receita/despesa).
//   KPIs financeiros (vendas_dia, ticket_medio, lucro_liquido_mes,
//   faturamento_serie) usam status='confirmed' em regime caixa, mesma
//   logica de /gestao/financeiro e dashboard.js. Filtro de periodo
//   canonico: COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date).
// - sale_items + digital_order_items — detalhe de produtos pro Top 5.
// - studio_approval_links — funil de aprovacao.
//
// Visibility: cada empresa ve APENAS SUAS transactions/items (company_id =
// req.params.id). Top produtos JOIN com products usa visibilidade canonica
// (matriz + sub-filial via billing_owner_company_id).
//
// 26/05/2026 — Painel Studio inicial
// 26/05/2026 — Refator pra transactions (espelhar Financeiro)
// 27/05/2026 — Fix shape: alinhar funil_aprovacao + vendas_dia.value
//              com tipos PainelData / PainelFunilStage do studioApi.ts
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

function stagePct(count, total) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
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
  // Shape identico ao tipo PainelData em studioApi.ts (frontend).
  const out = {
    period_days: days,
    computed_at: new Date().toISOString(),
    kpis: {
      vendas_dia:        { value: 0, delta_pct: null, sub_label: null },
      ticket_medio:      { value: 0, delta_pct: null, sub_label: null },
      lucro_liquido_mes: { value: 0, receita_mes: 0, despesa_mes: 0, margem_pct: null, delta_pct: null },
    },
    faturamento_serie: [],
    faturamento_total: 0,
    top_produtos: [],
    funil_aprovacao: {
      pendentes:  { count: 0, pct: 0 },
      aprovados:  { count: 0, pct: 0 },
      alteracoes: { count: 0, pct: 0 },
      expirados:  { count: 0, pct: 0 },
      total_enviados: 0,
      aprovacao_primeira_pct: null,
      tempo_medio_resposta_min: null,
    },
  };

  // ─── 1. KPI Vendas Dia (hoje vs ontem) ────────────────────
  // Fonte canonica: transactions income confirmed.
  // Periodo por COALESCE(due_date, created_at AT TZ SP) — mesma logica do Financeiro.
  try {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (
           WHERE type='income' AND status='confirmed'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) = CURRENT_DATE
         ), 0)::float AS hoje_total,
         COUNT(*) FILTER (
           WHERE type='income' AND status='confirmed'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) = CURRENT_DATE
         )::int AS hoje_qty,
         COALESCE(SUM(amount) FILTER (
           WHERE type='income' AND status='confirmed'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) = CURRENT_DATE - INTERVAL '1 day'
         ), 0)::float AS ontem_total
       FROM transactions
       WHERE company_id = $1
         AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= CURRENT_DATE - INTERVAL '1 day'`,
      [cid]
    );
    const row = r.rows[0] || {};
    const hojeTotal  = parseFloat(row.hoje_total)  || 0;
    const hojeQty    = parseInt(row.hoje_qty)       || 0;
    const ontemTotal = parseFloat(row.ontem_total)  || 0;
    out.kpis.vendas_dia = {
      value:     Math.round(hojeTotal * 100) / 100,
      delta_pct: pct(hojeTotal, ontemTotal),
      sub_label: null,
    };
  } catch (err) {
    console.error('[studio/painel][vendas_dia]', err.message);
  }

  // ─── 2. KPI Ticket Medio (periodo atual vs periodo anterior do mesmo tamanho) ─
  // Fonte canonica: transactions income confirmed. Janela = days (inclusive hoje).
  try {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (
           WHERE COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
         ), 0)::float AS atual_total,
         COUNT(*) FILTER (
           WHERE COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
         )::int AS atual_qty,
         COALESCE(SUM(amount) FILTER (
           WHERE COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= CURRENT_DATE - ($1::int * 2 - 1) * INTERVAL '1 day'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
         ), 0)::float AS prev_total,
         COUNT(*) FILTER (
           WHERE COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= CURRENT_DATE - ($1::int * 2 - 1) * INTERVAL '1 day'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
         )::int AS prev_qty
       FROM transactions
       WHERE company_id = $2
         AND type='income' AND status='confirmed'`,
      [days, cid]
    );
    const row = r.rows[0] || {};
    const atualTotal  = parseFloat(row.atual_total) || 0;
    const atualQty    = parseInt(row.atual_qty)     || 0;
    const prevTotal   = parseFloat(row.prev_total)  || 0;
    const prevQty     = parseInt(row.prev_qty)      || 0;
    const atualTicket = atualQty > 0 ? atualTotal / atualQty : 0;
    const prevTicket  = prevQty  > 0 ? prevTotal  / prevQty  : 0;
    out.kpis.ticket_medio = {
      value:     Math.round(atualTicket * 100) / 100,
      delta_pct: pct(atualTicket, prevTicket),
      sub_label: null,
    };
  } catch (err) {
    console.error('[studio/painel][ticket_medio]', err.message);
  }

  // ─── 3. KPI Lucro Liquido Mes (receita - despesa, ambas confirmed) ──
  // Fonte canonica: transactions. Receita = income confirmed do mes,
  // Despesa = expense confirmed do mes. Comparativo: mes anterior (lucro vs lucro).
  // Margem = lucro / receita * 100 (null se receita=0).
  try {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (
           WHERE type='income'  AND status='confirmed'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= DATE_TRUNC('month', CURRENT_DATE)
         ), 0)::float AS receita_atual,
         COALESCE(SUM(amount) FILTER (
           WHERE type='expense' AND status='confirmed'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= DATE_TRUNC('month', CURRENT_DATE)
         ), 0)::float AS despesa_atual,
         COALESCE(SUM(amount) FILTER (
           WHERE type='income'  AND status='confirmed'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  DATE_TRUNC('month', CURRENT_DATE)
         ), 0)::float AS receita_prev,
         COALESCE(SUM(amount) FILTER (
           WHERE type='expense' AND status='confirmed'
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
             AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  DATE_TRUNC('month', CURRENT_DATE)
         ), 0)::float AS despesa_prev
       FROM transactions
       WHERE company_id = $1`,
      [cid]
    );
    const row = r.rows[0] || {};
    const receitaAtual = parseFloat(row.receita_atual) || 0;
    const despesaAtual = parseFloat(row.despesa_atual) || 0;
    const receitaPrev  = parseFloat(row.receita_prev)  || 0;
    const despesaPrev  = parseFloat(row.despesa_prev)  || 0;

    const lucroAtual = receitaAtual - despesaAtual;
    const lucroPrev  = receitaPrev  - despesaPrev;
    const margemPct  = receitaAtual > 0 ? Math.round((lucroAtual / receitaAtual) * 100) : null;

    out.kpis.lucro_liquido_mes = {
      value:       Math.round(lucroAtual * 100) / 100,
      receita_mes: Math.round(receitaAtual * 100) / 100,
      despesa_mes: Math.round(despesaAtual * 100) / 100,
      margem_pct:  margemPct,
      delta_pct:   pct(lucroAtual, lucroPrev),
    };
  } catch (err) {
    console.error('[studio/painel][lucro_liquido_mes]', err.message);
  }

  // ─── 4. Faturamento Serie (N pontos: hoje no fim) ────────
  // Fonte canonica: transactions income confirmed agrupado por data competencia
  // (COALESCE due_date, created_at SP), mesma logica do Financeiro.
  try {
    const r = await db.query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS date_iso,
              COALESCE(SUM(t.amount), 0)::float AS value,
              COUNT(t.id)::int AS qty
         FROM generate_series(CURRENT_DATE - (($1::int - 1) || ' days')::interval, CURRENT_DATE, INTERVAL '1 day') d
         LEFT JOIN transactions t
                ON t.company_id = $2
               AND t.type='income' AND t.status='confirmed'
               AND COALESCE(t.due_date, (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date) = d::date
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
    // Total do periodo (soma da serie)
    out.faturamento_total = Math.round(
      out.faturamento_serie.reduce((sum, p) => sum + p.value, 0) * 100
    ) / 100;
  } catch (err) {
    console.error('[studio/painel][faturamento_serie]', err.message);
  }

  // ─── 5. Top 5 produtos (revenue desc) ────────────────────
  // Soma quantity/revenue de digital_order_items + sale_items no periodo,
  // JOIN com products pra pegar nome (com visibility canonica pro caso de
  // produto compartilhado matriz). Fallback gracioso: se vier vazio,
  // mantem [] (frontend tem empty state).
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
  // Shape de retorno: identico a PainelData.funil_aprovacao (studioApi.ts)
  // pendentes/aprovados/alteracoes/expirados: { count, pct } (PainelFunilStage)
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
    const total          = parseInt(row.total)             || 0;
    const pendingCount   = parseInt(row.pending)           || 0;
    const approvedCount  = parseInt(row.approved)          || 0;
    const changesCount   = parseInt(row.changes_requested) || 0;
    const expiredCount   = parseInt(row.expired)           || 0;
    out.funil_aprovacao = {
      pendentes:  { count: pendingCount,  pct: stagePct(pendingCount, total)  },
      aprovados:  { count: approvedCount, pct: stagePct(approvedCount, total) },
      alteracoes: { count: changesCount,  pct: stagePct(changesCount, total)  },
      expirados:  { count: expiredCount,  pct: stagePct(expiredCount, total)  },
      total_enviados:           total,
      aprovacao_primeira_pct:   total > 0 ? Math.round((approvedCount / total) * 100) : null,
      tempo_medio_resposta_min: row.avg_response_minutes != null
        ? Math.round(parseFloat(row.avg_response_minutes))
        : null,
    };
  } catch (err) {
    console.error('[studio/painel][funil_aprovacao]', err.message);
  }

  res.json(out);
});

module.exports = router;
