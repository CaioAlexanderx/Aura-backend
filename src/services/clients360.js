// ============================================================
// AURA. — Clients 360 (consulta única)
//
// 13/10/2026: a consulta do GET /admin/clients-360 saiu de
// routes/adminClients360.js para cá, sem mudar nada nela, para a ficha do
// cliente no painel da Gestão Aura (GET /admin/painel/clientes/:cid/ficha)
// reaproveitar a mesma fonte. Com companyId, traz só aquela empresa.
// ============================================================
'use strict';

const pool = require('../config/database');
const { getExtraSeatsMap } = require('./extraSeats');
const { classifyLifecycle } = require('./clientLifecycle');

// ── Funil do trial (12/10/2026) ───────────────────────────────
// Importou estoque conta planilha/XML de produtos (import_logs module
// 'products', sem as importacoes desfeitas) OU 10+ produtos cadastrados a mao
// — quem digita o estoque tambem passou do degrau.
const IMPORT_MIN_PRODUCTS = 10;

function activationOf(f) {
  return {
    importou: f.imported_rows > 0 || f.prod_count >= IMPORT_MIN_PRODUCTS,
    abriu_caixa: f.caixa_sessions > 0,
    vendeu: f.sale_count > 0 || !!f.first_sale_at,
    viu_checkout: f.checkout_views > 0 || !!f.checkout_viewed_at,
  };
}

// Tabela/coluna ausente (deploy antes da migration) zera o degrau; qualquer
// outro erro sobe, como no resto da rota.
async function optionalRows(sql, params) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows || [];
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return [];
    throw err;
  }
}

async function getFunnelMaps(ids) {
  const caixaMap = new Map();
  const importMap = new Map();
  if (!ids.length) return { caixaMap, importMap };
  const [caixaRows, importRows] = await Promise.all([
    optionalRows(
      `SELECT company_id, COUNT(*) AS caixa_sessions, MAX(opened_at) AS last_caixa_at
         FROM caixa_sessoes
        WHERE company_id = ANY($1)
        GROUP BY company_id`,
      [ids]
    ),
    optionalRows(
      `SELECT company_id, COALESCE(SUM(imported_rows), 0) AS imported_rows
         FROM import_logs
        WHERE company_id = ANY($1) AND module = 'products' AND reverted_at IS NULL
        GROUP BY company_id`,
      [ids]
    ),
  ]);
  for (const r of caixaRows) caixaMap.set(r.company_id, r);
  for (const r of importRows) importMap.set(r.company_id, r.imported_rows);
  return { caixaMap, importMap };
}

async function getTrialModeMap(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await optionalRows(
    `SELECT id, trial_mode, trial_started_by_sale_at
       FROM companies
      WHERE id = ANY($1)`,
    [ids]
  );
  for (const r of rows) map.set(r.id, r);
  return map;
}

async function listarClients360({ companyId = null } = {}) {
  // Gestão Aura lista apenas CLIENTES reais. Dojôs de federação são dados
  // internos (companies com federation_id != id), não contas-cliente — só
  // aparecem aqui se contratarem a Aura Dojô (conta independente futura).
  // Filtro: (federation_id IS NULL OR federation_id = id) mantém a federação
  // (federation_id NULL) e exclui os dojôs-membros. Na ficha (companyId) o
  // filtro não vale: quem pede uma empresa pelo id quer aquela empresa.
  const { rows } = await pool.query(`
    SELECT c.id, c.trade_name, c.legal_name, c.plan, c.is_active,
       c.billing_status, c.billing_cycle, c.module_overrides,
       c.created_at, c.last_active_at, c.tax_regime, c.trial_ends_at,
       c.vertical_active, c.vertical_enabled_at, c.suggested_vertical,
       u.email AS owner_email, u.full_name AS owner_name,
       COALESCE(NULLIF(u.phone, ''), c.phone) AS owner_phone, u.is_staff AS owner_is_staff,
       c.is_sandbox, c.access_code_used,
       (c.asaas_subscription_id IS NOT NULL) AS has_subscription,
       h.score AS health_score, h.risk_level, h.activity_score, h.usage_score, h.payment_score, h.adoption_score,
       (SELECT COUNT(*) FROM transactions WHERE company_id=c.id) AS tx_count,
       (SELECT COUNT(*) FROM products WHERE company_id=c.id) AS prod_count,
       (SELECT COUNT(*) FROM customers WHERE company_id=c.id) AS cust_count,
       (SELECT COUNT(*) FROM sales WHERE company_id=c.id) AS sale_count,
       (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE company_id=c.id AND type='income') AS total_revenue,
       la.last_login_at, la.login_days,
       (SELECT MIN(created_at) FROM sales WHERE company_id=c.id) AS first_sale_at,
       ck.checkout_viewed_at, ck.checkout_views
    FROM companies c
    LEFT JOIN users u ON u.id=c.owner_id
    LEFT JOIN client_health_scores h ON h.company_id=c.id
    LEFT JOIN LATERAL (
      SELECT MAX(a.created_at) AS last_login_at,
             COUNT(DISTINCT (a.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS login_days
        FROM audit_log a
       WHERE a.company_id = c.id AND a.action IN ('login', 'switch_company', 'register')
    ) la ON true
    LEFT JOIN LATERAL (
      SELECT MAX(a.created_at) AS checkout_viewed_at, COUNT(*) AS checkout_views
        FROM audit_log a
       WHERE a.company_id = c.id AND a.action = 'checkout.viewed'
    ) ck ON true
    WHERE ${companyId ? 'c.id = $1' : '(c.federation_id IS NULL OR c.federation_id = c.id)'}
    ORDER BY h.score ASC NULLS LAST, c.created_at DESC
  `, companyId ? [companyId] : []);

  // Defensivo: pega extra_seats_granted via helper opcional.
  // Pre-migration → mapa vazio → todos default 0.
  const seatsMap = await getExtraSeatsMap(rows.map(r => r.id));
  // 12/10/2026: degraus do funil que vivem em tabelas fora do SELECT principal.
  // 13/10/2026: modo do trial (migration 379). Fora do SELECT principal para
  // a coluna ausente virar 'fixo' em vez de derrubar a lista; em paralelo com
  // o funil para não somar uma ida ao banco.
  const [{ caixaMap, importMap }, trialMap] = await Promise.all([
    getFunnelMaps(rows.map(r => r.id)),
    getTrialModeMap(rows.map(r => r.id)),
  ]);


  const now = new Date();
  return rows.map(r => {
    const caixa = caixaMap.get(r.id) || {};
    const funnel = {
      prod_count: parseInt(r.prod_count || 0),
      sale_count: parseInt(r.sale_count || 0),
      first_sale_at: r.first_sale_at || null,
      caixa_sessions: parseInt(caixa.caixa_sessions || 0),
      last_caixa_at: caixa.last_caixa_at || null,
      imported_rows: parseInt(importMap.get(r.id) || 0),
      checkout_viewed_at: r.checkout_viewed_at || null,
      checkout_views: parseInt(r.checkout_views || 0),
    };
    return {
      ...r,
      ...classifyLifecycle(r, now),
      ...funnel,
      trial_mode: (trialMap.get(r.id) || {}).trial_mode || 'fixo',
      started_by_sale_at: (trialMap.get(r.id) || {}).trial_started_by_sale_at || null,
      tx_count: parseInt(r.tx_count || 0),
      cust_count: parseInt(r.cust_count || 0),
      login_days: parseInt(r.login_days || 0),
      total_revenue: parseFloat(r.total_revenue || 0),
      health_score: r.health_score ? parseInt(r.health_score) : null,
      extra_seats_granted: seatsMap.get(r.id) || 0,
      ativacao: activationOf(funnel),
    };
  });
}

module.exports = { listarClients360, activationOf, IMPORT_MIN_PRODUCTS };
