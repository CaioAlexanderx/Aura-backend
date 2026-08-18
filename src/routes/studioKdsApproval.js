// ============================================================
// AURA Studio · Rotas autenticadas Fase 4 (KDS) + Fase 5 (request approval)
// Arquivo separado pra não inflar studio.js.
// Mount em private.js sob mesmo prefixo /studio.
// Migration 130 (studio_production_status) + 132 (approval_links) + 25/05
// (studio_kds_unified_view_and_trigger — view studio_orders unindo
//  digital_orders + sales personalizaveis).
// 25/05/2026 S-2.5: view tambem une marketplace_orders. PATCH production-status
//   ganha branch source='marketplace' (atualiza studio_production_status_override).
// 26/05/2026: GET /orders defensivo — query simplificada com fallback gracioso
//   pra evitar 500 quando colunas/views faltam em deploys parciais (Settings
//   Studio reload dispara essa rota; bug em prod 26/05).
// 26/05/2026 (segundo fix): subselect de approval estava usando MIN(image_url)
//   — coluna real e mockup_url. MIN() agregado tambem era redundante com
//   LIMIT 1. Trocado por SELECT mockup_url puro com LIMIT 1.
// 30/05/2026 (P1 Camada 1): gate de produção configurável por loja.
//   require_deposit_for_production em studio_settings (opt-in, default false).
//   force:true bypassa o gate e loga. M2: auto-criação do marco de pagamento
//   no convert está em studioQuotes.js.
// 03/07/2026 (Visual Engine F2): POST /orders/:oid/approval aceita render_id
//   (studio_visual_renders.id do render HD gerado pelo motor). Coluna
//   render_id em studio_approval_links (migration 209); defensivo 42703
//   refaz INSERT sem a coluna quando a migration ainda não rodou.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const crypto  = require('crypto');
const db      = require('../config/database');
const { markStudioOnboarding } = require('../utils/studioOnboarding');
const collectionNotice = require('../services/credit/collectionNotice');

// ═══════════════════════════════════════════════════════
// FASE 4: KDS de Produção (atualizado 25/05 — KDS unificado + S-2.5)
// ═══════════════════════════════════════════════════════

// S-0 + S-2.5: awaiting_customization eh status valido + cancelled
const VALID_PRODUCTION_STATUS = [
  'awaiting_customization',
  'pending_art',
  'approved',
  'in_production',
  'ready',
  'delivered',
  'cancelled',
];

// ─── Saldo a receber da encomenda (17/08/2026) ───────────────────────────────
// Venda com sinal (F2): o saldo vive em credit_installments, 1 parcela na data
// combinada. Aqui ele e exposto junto do pedido pra que o Kanban e a lista de
// Pedidos mostrem "quanto ainda tenho a receber desta encomenda" sem precisar
// da tela de Crediario -- vocabulario que nao existe no mercado de
// personalizados (a lojista pensa em encomenda em aberto, nao em fiado).
//
// Enriquecemos AQUI, no endpoint, e nao na view studio_orders: a migration 208
// preserva a view existente em prod de proposito ("View studio_orders ja existe
// -- mantida como esta"), entao alterar a view seria mexer num objeto que o
// versionamento nao controla.
//
// So cobre source='pdv'. O deposito de digital_orders (deposit_required/
// deposit_paid, migration 141) e outro mecanismo, sem parcela e sem id que os
// endpoints de cobranca aceitem -- misturar os dois num campo so confundiria a
// tela e a lojista.
const BALANCE_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT ci.id AS installment_id,
             ROUND((ci.amount_due - COALESCE(ci.covered_amount, 0))::numeric, 2) AS amount,
             ci.due_date,
             (ci.due_date < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) AS is_overdue
        FROM credit_installments ci
       WHERE ci.company_id = o.company_id
         AND ci.sale_id    = o.pdv_sale_id
         AND ci.status NOT IN ('paid', 'cancelled')
         AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
       ORDER BY ci.due_date ASC
       LIMIT 1
    ) bal ON TRUE`;

const BALANCE_COLS = `
              bal.installment_id AS balance_installment_id,
              bal.amount         AS balance_amount,
              bal.due_date       AS balance_due_date,
              CASE WHEN bal.installment_id IS NULL THEN NULL
                   WHEN bal.is_overdue THEN 'overdue'
                   ELSE 'pending' END AS balance_status,`;

// ─── K1 (18/08/2026): a cara do card ────────────────────────────────────────
// Personalizado se vende pelo olho -- um card sem imagem e uma planilha em pe.
// A imagem NAO tem tela, botao nem configuracao: sai do dado que ja existe,
// em cascata, e o app cai no monograma quando nada e encontrado.
//
// Ordem (do mais especifico daquele pedido pro mais generico):
//   1. mockup aprovado/enviado -- so pedido digital (approval_links.order_id
//      aponta pra digital_orders; nao ha sale_id ali)
//   2. render do Visual Engine -- via sale_item (PDV) ou digital_order_item
//   3. foto do produto vendido
//
// Levantamento em prod (18/08): 0 renders e 0 mockups gravados; a cobertura
// real hoje vem toda do nivel 3 e alcanca ~50% dos cards. A cascata cobre os
// niveis 1 e 2 porque eles passam a valer sozinhos quando o Visual Engine e a
// aprovacao rodarem -- sem migration nova nem mudanca de tela.
const CARD_IMAGE_COL = `
              COALESCE(
                (SELECT a.mockup_url FROM studio_approval_links a
                  WHERE a.order_id = o.digital_order_id
                    AND NULLIF(TRIM(a.mockup_url), '') IS NOT NULL
                  ORDER BY a.created_at DESC LIMIT 1),
                (SELECT r.file_url FROM studio_visual_renders r
                   JOIN sale_items si2 ON si2.id = r.sale_item_id
                  WHERE si2.sale_id = o.pdv_sale_id
                    AND NULLIF(TRIM(r.file_url), '') IS NOT NULL
                  ORDER BY (r.kind = 'hd_2d') DESC, r.created_at DESC LIMIT 1),
                (SELECT r.file_url FROM studio_visual_renders r
                   JOIN digital_order_items doi2 ON doi2.id = r.digital_order_item_id
                  WHERE doi2.order_id = o.digital_order_id
                    AND NULLIF(TRIM(r.file_url), '') IS NOT NULL
                  ORDER BY (r.kind = 'hd_2d') DESC, r.created_at DESC LIMIT 1),
                (SELECT p.image_url FROM sale_items si3
                   JOIN products p ON p.id = si3.product_id
                  WHERE si3.sale_id = o.pdv_sale_id
                    AND NULLIF(TRIM(p.image_url), '') IS NOT NULL
                  ORDER BY si3.id LIMIT 1),
                (SELECT p.image_url FROM digital_order_items doi3
                   JOIN products p ON p.id = doi3.product_id
                  WHERE doi3.order_id = o.digital_order_id
                    AND NULLIF(TRIM(p.image_url), '') IS NOT NULL
                  ORDER BY doi3.id LIMIT 1)
              ) AS card_image_url,`;

// promised_date nasce na migration 285 — separado da imagem porque, sem a
// coluna, o subselect derrubaria a query RICA inteira pro fallback slim
// (perdendo item_count, aprovacoes e a propria imagem). Com o guard, o campo
// simplesmente nao aparece ate a migration rodar.
const PROMISED_COL = `
              (SELECT s2.promised_date FROM sales s2 WHERE s2.id = o.pdv_sale_id) AS promised_date,`;

// Campos de saldo nulos — mantem o shape identico nos fallbacks slim/raw, pra
// que o app nunca precise checar se o campo existe.
const NULL_BALANCE = {
  balance_installment_id: null,
  balance_amount:         null,
  balance_due_date:       null,
  balance_status:         null,
};

// K1: mesmo contrato dos campos de saldo — shape estavel nos fallbacks.
const NULL_CARD = {
  card_image_url: null,
  promised_date:  null,
};

// Deploy parcial: se credit_installments nao existir, o LATERAL derrubaria a
// query RICA inteira pro fallback slim (perdendo item_count, aprovacoes etc).
// Cache module-level evita repetir a checagem a cada request (CLAUDE.md #1).
let _instCheckedAt = 0;
let _instAvailable = null;
async function hasInstallmentsTable() {
  const now = Date.now();
  if (_instAvailable !== null && (now - _instCheckedAt) < 60000) return _instAvailable;
  try {
    const r = await db.query(`SELECT to_regclass('public.credit_installments') AS t`);
    _instAvailable = !!r.rows[0]?.t;
  } catch (e) {
    _instAvailable = false;
  }
  _instCheckedAt = now;
  return _instAvailable;
}

// K1: mesma guarda pra sales.promised_date (migration 285).
let _promCheckedAt = 0;
let _promAvailable = null;
async function hasPromisedDate() {
  const now = Date.now();
  if (_promAvailable !== null && (now - _promCheckedAt) < 60000) return _promAvailable;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name = 'promised_date' LIMIT 1`
    );
    _promAvailable = r.rows.length > 0;
  } catch (e) {
    _promAvailable = false;
  }
  _promCheckedAt = now;
  return _promAvailable;
}

// ─── POST /orders/:oid/cobrar-saldo ──────────────────────────────────────────
// Cobranca do saldo da encomenda, INDEPENDENTE do crediario.
//
// 17/08/2026. O Studio nao tem crediario -- nao existe fiado nesse mercado.
// As rotas de /credit ficam atras de assertCrediarioEnabled, entao cobrar por
// la exigiria a lojista ligar um produto que ela nao usa so pra receber uma
// encomenda que ela JA vendeu. Isso nao e degradacao, e bloqueio de
// experiencia: a venda com sinal fecha e o dinheiro fica sem porta de saida.
//
// A separacao e de SUPERFICIE, nao de dado: por baixo continua a mesma parcela
// (vencimento, Pix, baixa de pagamento, estorno no cancelamento e A Receber
// vem de graca). O que nao atravessa e o PRODUTO crediario -- fiado, limite,
// score, carne, renegociacao -- que segue exclusivo do shell Negocio.
//
// Escopo estreito de proposito: recebe o ID do PEDIDO, resolve a parcela a
// partir dele e confere a empresa. Nao aceita installment_id solto, entao esta
// rota nao vira uma porta lateral pro ledger de credito inteiro.
router.post('/orders/:oid/cobrar-saldo', async function(req, res) {
  const cid = req.params.id;
  const oid = req.params.oid;
  const { template = 'encomenda', channel = 'whatsapp' } = req.body || {};

  if (!(await hasInstallmentsTable())) {
    return res.status(409).json({
      error: 'Cobranca de saldo indisponivel neste ambiente.',
      code: 'BALANCE_UNAVAILABLE',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // A parcela sai do PEDIDO: o pedido do Studio de origem PDV e a venda,
    // entao sale_id = oid. Escopo por empresa em todas as pontas.
    const { rows } = await client.query(
      `SELECT ci.*, COALESCE(c.name, c.phone) AS customer_name, c.phone,
              COALESCE(co.trade_name, co.legal_name) AS store_name
         FROM credit_installments ci
         LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ci.company_id
         LEFT JOIN companies co ON co.id = ci.company_id
        WHERE ci.company_id = $1
          AND ci.sale_id = $2
          AND ci.status NOT IN ('paid', 'cancelled')
          AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
        ORDER BY ci.due_date ASC
        LIMIT 1`,
      [cid, oid]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Esta encomenda nao tem saldo em aberto.',
        code: 'NO_OPEN_BALANCE',
      });
    }

    const notice = await collectionNotice.buildNotice(client, {
      companyId: cid, installmentId: rows[0].id, template, channel, row: rows[0],
    });
    await client.query('COMMIT');
    return res.json({ success: true, ...notice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[studio/orders/cobrar-saldo]', err.message);
    return res.status(500).json({ error: 'Erro ao preparar a cobranca do saldo.' });
  } finally { client.release(); }
});

// ─── GET /orders — lista da view studio_orders (digital + pdv + marketplace) ────
// ?with_balance=true — so encomendas com saldo em aberto (aba "A receber").
router.get('/orders', async function(req, res) {
  const { status, days = 30, limit = 200, with_balance } = req.query;
  const cid = req.params.id;
  const safeLimit = Math.min(parseInt(limit) || 200, 500);
  const safeDays  = Math.min(parseInt(days) || 30, 365);
  const statusFilter = (status && VALID_PRODUCTION_STATUS.includes(String(status))) ? String(status) : null;
  const onlyWithBalance = with_balance === 'true' || with_balance === '1';
  const withBalance = await hasInstallmentsTable();
  const withPromised = await hasPromisedDate();

  // ── 1. Tentativa RICA: view completa com subselects (KDS precisa disso) ──
  try {
    const params = [cid];
    let where = `o.company_id = $1`;
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND o.studio_production_status = $${params.length}`;
    }
    where += ` AND o.created_at >= NOW() - INTERVAL '${safeDays} days'`;
    // Aba "A receber": so o que tem saldo em aberto. Sem a tabela de parcelas
    // nao ha o que filtrar -- devolve vazio em vez de listar tudo, que daria a
    // impressao errada de que todo pedido tem saldo.
    if (onlyWithBalance) {
      where += withBalance ? ` AND bal.installment_id IS NOT NULL` : ` AND FALSE`;
    }
    params.push(safeLimit);

    const r = await db.query(
      `SELECT o.id, o.created_at, o.total_amount, o.status,
              o.studio_production_status,
              o.customer_name, o.customer_phone,
              o.display_name,
              o.source,
${CARD_IMAGE_COL}
${withPromised ? PROMISED_COL : ''}
${withBalance ? BALANCE_COLS : ''}
              o.digital_order_id,
              o.pdv_sale_id,
              o.marketplace_order_id,
              o.marketplace_platform,
              o.customization_collected_at,
              CASE
                WHEN o.source = 'digital' THEN
                  (SELECT COUNT(*) FROM digital_order_items oi WHERE oi.order_id = o.digital_order_id)
                WHEN o.source = 'pdv' THEN
                  (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = o.pdv_sale_id)
                WHEN o.source = 'marketplace' THEN
                  (SELECT CASE
                    WHEN mo.items IS NULL THEN 0
                    WHEN jsonb_typeof(mo.items) = 'array' THEN jsonb_array_length(mo.items)
                    ELSE 0
                  END FROM marketplace_orders mo WHERE mo.id = o.marketplace_order_id)
                ELSE 0
              END AS item_count,
              (SELECT a.mockup_url FROM studio_approval_links a
                WHERE a.order_id = o.digital_order_id AND a.status = 'pending'
                ORDER BY a.created_at DESC LIMIT 1) AS pending_approval_url,
              (SELECT COUNT(*) FROM studio_approval_links a
                WHERE a.order_id = o.digital_order_id) AS approval_count
         FROM studio_orders o${withBalance ? BALANCE_LATERAL : ''}
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    let orders = r.rows.map((row) => ({
      ...(withBalance ? null : NULL_BALANCE),
      ...(withPromised ? null : { promised_date: null }),
      ...row,
    }));

    // K1 (18/08/2026): a view studio_orders so traz venda de PDV quando
    // studio_production_status IS NOT NULL -- ou seja, quando o produto e
    // personalizavel e o trigger marcou. Isso esta CERTO pro Kanban: venda sem
    // personalizacao nao tem fabricacao, entao nao e fila de producao.
    //
    // Mas a aba "A receber" le a MESMA rota, e ali o criterio e outro: dinheiro
    // devido e dinheiro devido, tenha arte ou nao. Sem este bloco, uma venda com
    // sinal de produto nao-personalizavel ficaria sem nenhuma tela onde cobrar --
    // o saldo existiria, venceria, e seria invisivel.
    if (onlyWithBalance && withBalance) {
      const extra = await db.query(
        `SELECT s.id, s.created_at, s.total_amount, s.status,
                NULL::text AS studio_production_status,
                cu.name AS customer_name, cu.phone AS customer_phone,
                'PDV-' || LEFT(s.id::text, 8) AS display_name,
                'pdv'::text AS source,
                NULL::uuid AS digital_order_id,
                s.id AS pdv_sale_id,
                NULL::uuid AS marketplace_order_id,
                NULL::text AS marketplace_platform,
                NULL::timestamptz AS customization_collected_at,
                (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
                NULL::text AS pending_approval_url,
                0 AS approval_count,
                (SELECT p.image_url FROM sale_items si3
                   JOIN products p ON p.id = si3.product_id
                  WHERE si3.sale_id = s.id
                    AND NULLIF(TRIM(p.image_url), '') IS NOT NULL
                  ORDER BY si3.id LIMIT 1) AS card_image_url,
                ${withPromised ? 's.promised_date' : 'NULL::date'} AS promised_date,
                bal.installment_id AS balance_installment_id,
                bal.amount         AS balance_amount,
                bal.due_date       AS balance_due_date,
                CASE WHEN bal.is_overdue THEN 'overdue' ELSE 'pending' END AS balance_status
           FROM sales s
           LEFT JOIN customers cu ON cu.id = s.customer_id
           JOIN LATERAL (
             SELECT ci.id AS installment_id,
                    ROUND((ci.amount_due - COALESCE(ci.covered_amount, 0))::numeric, 2) AS amount,
                    ci.due_date,
                    (ci.due_date < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) AS is_overdue
               FROM credit_installments ci
              WHERE ci.company_id = s.company_id
                AND ci.sale_id    = s.id
                AND ci.status NOT IN ('paid', 'cancelled')
                AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
              ORDER BY ci.due_date ASC
              LIMIT 1
           ) bal ON TRUE
          WHERE s.company_id = $1
            AND s.studio_production_status IS NULL
            AND COALESCE(s.status, 'completed') <> 'cancelled'
            AND s.created_at >= NOW() - INTERVAL '${safeDays} days'
          ORDER BY s.created_at DESC
          LIMIT $2`,
        [cid, safeLimit]
      );
      orders = orders.concat(extra.rows);
      orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      orders = orders.slice(0, safeLimit);
    }

    return res.json({ orders });
  } catch (errRich) {
    console.error('[studio/orders:GET][rich]', errRich.message, errRich.code, errRich.stack);
  }

  // ── 2. Fallback SLIM ──
  try {
    const params = [cid];
    let where = `o.company_id = $1`;
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND o.studio_production_status = $${params.length}`;
    }
    where += ` AND o.created_at >= NOW() - INTERVAL '${safeDays} days'`;
    params.push(safeLimit);

    const r = await db.query(
      `SELECT o.id, o.created_at, o.total_amount, o.status,
              o.studio_production_status,
              o.customer_name, o.customer_phone,
              o.source
         FROM studio_orders o
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return res.json({
      orders: r.rows.map((row) => ({
        ...row,
        display_name: row.customer_name,
        digital_order_id: null,
        pdv_sale_id: null,
        marketplace_order_id: null,
        marketplace_platform: null,
        customization_collected_at: null,
        item_count: 0,
        pending_approval_url: null,
        approval_count: 0,
        ...NULL_BALANCE,
        ...NULL_CARD,
      })),
      degraded: 'slim',
    });
  } catch (errSlim) {
    console.error('[studio/orders:GET][slim]', errSlim.message, errSlim.code, errSlim.stack);
  }

  // ── 3. Fallback RAW ──
  try {
    const params = [cid];
    let where = `company_id = $1 AND vertical = 'studio'`;
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND studio_production_status = $${params.length}`;
    }
    where += ` AND created_at >= NOW() - INTERVAL '${safeDays} days'`;
    params.push(safeLimit);

    const r = await db.query(
      `SELECT id, created_at, total_amount, status,
              studio_production_status,
              customer_name, customer_phone
         FROM digital_orders
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return res.json({
      orders: r.rows.map((row) => ({
        ...row,
        display_name: row.customer_name,
        source: 'digital',
        digital_order_id: row.id,
        pdv_sale_id: null,
        marketplace_order_id: null,
        marketplace_platform: null,
        customization_collected_at: null,
        item_count: 0,
        pending_approval_url: null,
        approval_count: 0,
        ...NULL_BALANCE,
        ...NULL_CARD,
      })),
      degraded: 'raw',
    });
  } catch (errRaw) {
    console.error('[studio/orders:GET][raw]', errRaw.message, errRaw.code, errRaw.stack);
    return res.json({ orders: [], degraded: 'empty', error_hint: errRaw.message });
  }
});

// ─── GET /orders/:oid — detalhe source-aware ──────────────────
router.get('/orders/:oid', async function(req, res) {
  try {
    const headRes = await db.query(
      `SELECT * FROM studio_orders
        WHERE id = $1 AND company_id = $2
        LIMIT 1`,
      [req.params.oid, req.params.id]
    );
    if (!headRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const head = headRes.rows[0];

    let items = [];
    if (head.source === 'digital') {
      try {
        const r = await db.query(
          `SELECT id, product_id, product_name, quantity, unit_price, customization
             FROM digital_order_items
            WHERE order_id = $1
            ORDER BY id`,
          [head.digital_order_id]
        );
        items = r.rows;
      } catch (e) { console.error('[studio/orders/:oid][items.digital]', e.message); }
    } else if (head.source === 'pdv') {
      try {
        const r = await db.query(
          `SELECT si.id, si.product_id, p.name AS product_name,
                  si.quantity, si.unit_price,
                  si.customization
             FROM sale_items si
             LEFT JOIN products p ON p.id = si.product_id
            WHERE si.sale_id = $1
            ORDER BY si.id`,
          [head.pdv_sale_id]
        );
        items = r.rows;
      } catch (e) { console.error('[studio/orders/:oid][items.pdv]', e.message); }
    } else if (head.source === 'marketplace') {
      try {
        const r = await db.query(
          `SELECT items, customization_data
             FROM marketplace_orders WHERE id = $1`,
          [head.marketplace_order_id]
        );
        const row = r.rows[0];
        const rawItems = Array.isArray(row?.items) ? row.items : [];
        const custData = row?.customization_data || {};
        items = rawItems.map((it, idx) => ({
          id: `${head.marketplace_order_id}-${idx}`,
          product_id: it.product_id || null,
          product_name: it.product_name || null,
          quantity: it.quantity || 1,
          unit_price: it.unit_price || 0,
          customization: it.product_id ? (custData[it.product_id] || null) : null,
        }));
      } catch (e) { console.error('[studio/orders/:oid][items.marketplace]', e.message); }
    }

    let approvals = [];
    if (head.source === 'digital') {
      try {
        const r = await db.query(
          `SELECT id, token, status, mockup_url, response_note, expires_at, responded_at, created_at
             FROM studio_approval_links
            WHERE order_id = $1
            ORDER BY created_at DESC`,
          [head.digital_order_id]
        );
        approvals = r.rows;
      } catch (e) { console.error('[studio/orders/:oid][approvals]', e.message); }
    }

    res.json({ order: head, items, approvals });
  } catch (err) {
    console.error('[studio/orders/:oid]', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// ─── PATCH /orders/:oid/production-status — source-aware update ───
router.patch('/orders/:oid/production-status', async function(req, res) {
  const { status, force } = req.body;
  if (!VALID_PRODUCTION_STATUS.includes(status)) {
    return res.status(400).json({ error: `status inválido (use: ${VALID_PRODUCTION_STATUS.join(', ')})` });
  }
  try {
    const headRes = await db.query(
      `SELECT source, digital_order_id, pdv_sale_id, marketplace_order_id, customization_collected_at
         FROM studio_orders
        WHERE id = $1 AND company_id = $2
        LIMIT 1`,
      [req.params.oid, req.params.id]
    );
    if (!headRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const head = headRes.rows[0];

    // ── P1 — Gate de produção configurável (Camada 1, 30/05/2026) ─────────
    // Opt-in por loja: require_deposit_for_production em studio_settings.
    // Default = false → produção flui sem restrição (zero quebra).
    // Só aplica pra source='digital' com deposit_required > 0.
    // force: true bypassa o gate (lojista pode forçar manualmente).
    if (status === 'in_production') {
      try {
        const settingsRes = await db.query(
          `SELECT COALESCE((studio_settings->>'require_deposit_for_production')::boolean, false) AS require_deposit
             FROM companies WHERE id = $1`,
          [req.params.id]
        );
        const requireDeposit = settingsRes.rows[0]?.require_deposit === true;

        if (requireDeposit && head.source === 'digital') {
          const depRes = await db.query(
            `SELECT deposit_required, deposit_paid FROM digital_orders WHERE id = $1 LIMIT 1`,
            [head.digital_order_id]
          );
          const ord = depRes.rows[0];
          const hasDepositRequired = ord && parseFloat(ord.deposit_required || '0') > 0;
          const depositPaid = ord?.deposit_paid === true;

          if (hasDepositRequired && !depositPaid) {
            if (!force) {
              return res.status(409).json({
                error: 'deposit_required',
                message: `Sinal de R$ ${parseFloat(ord.deposit_required).toFixed(2)} não recebido. Confirme o sinal antes de iniciar a produção, ou use force: true para forçar.`,
              });
            }
            // M2: loga quem forçou produção sem sinal confirmado
            console.warn(
              `[studio/production-status][FORCED] company=${req.params.id}` +
              ` order=${head.digital_order_id}` +
              ` by=${req.user?.id || 'unknown'}` +
              ` at=${new Date().toISOString()}`
            );
          }
        }
      } catch (gateErr) {
        // Gate não deve travar o fluxo em caso de erro de query
        console.warn('[studio/production-status][gate-check-err]', gateErr.message);
      }
    }
    // ─────────────────────────────────────────────────────────────

    let updated;
    if (head.source === 'digital') {
      const r = await db.query(
        `UPDATE digital_orders
            SET studio_production_status = $1, updated_at = NOW()
          WHERE id = $2 AND company_id = $3 AND vertical = 'studio'
          RETURNING id, studio_production_status`,
        [status, head.digital_order_id, req.params.id]
      );
      updated = r.rows[0];
    } else if (head.source === 'pdv') {
      const r = await db.query(
        `UPDATE sales
            SET studio_production_status = $1, updated_at = NOW()
          WHERE id = $2 AND company_id = $3
          RETURNING id, studio_production_status`,
        [status, head.pdv_sale_id, req.params.id]
      );
      updated = r.rows[0];
    } else if (head.source === 'marketplace') {
      if (status === 'awaiting_customization' && head.customization_collected_at) {
        return res.status(400).json({
          error: 'Personalização já foi coletada; não dá pra voltar pra awaiting_customization. Use o modal Coletar Personalização pra editar a personalização.',
        });
      }
      const statusMap = {
        approved:      'separando',
        in_production: 'separando',
        ready:         'enviado',
        delivered:     'entregue',
        cancelled:     'cancelado',
      };
      const mktStatus = statusMap[status] || null;
      const r = await db.query(
        `UPDATE marketplace_orders
            SET studio_production_status_override = $1,
                ${mktStatus ? `status = '${mktStatus}', ` : ''}
                updated_at = NOW()
          WHERE id = $2 AND company_id = $3 AND vertical = 'studio'
          RETURNING id, studio_production_status_override AS studio_production_status`,
        [status === 'awaiting_customization' ? null : status, head.marketplace_order_id, req.params.id]
      );
      updated = r.rows[0];
    }

    if (!updated) return res.status(404).json({ error: 'Pedido não encontrado pra atualizar' });
    res.json({ ...updated, source: head.source });
  } catch (err) {
    console.error('[studio/orders/production-status]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

// ═══════════════════════════════════════════════════════
// FASE 5: Request approval (wa.me)
// ═══════════════════════════════════════════════════════

function generateToken() {
  return crypto.randomBytes(24).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildWaMeLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const fullDigits = digits.length === 10 || digits.length === 11 ? '55' + digits : digits;
  return `https://wa.me/${fullDigits}?text=${encodeURIComponent(text)}`;
}

router.post('/orders/:oid/approval', async function(req, res) {
  const { mockup_url, customer_phone, custom_message, expires_in_days, render_id } = req.body;
  if (!mockup_url || !/^https?:\/\//.test(mockup_url)) {
    return res.status(400).json({ error: 'mockup_url obrigatório (URL pública do mockup)' });
  }

  const headRes = await db.query(
    `SELECT source, digital_order_id FROM studio_orders
      WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [req.params.oid, req.params.id]
  );
  if (!headRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (headRes.rows[0].source !== 'digital') {
    return res.status(400).json({
      error: 'Aprovação remota só disponível pra pedidos do Canal Digital. Pra venda PDV mostre o mockup presencialmente; pra marketplace use o chat da plataforma.',
    });
  }
  const digitalOrderId = headRes.rows[0].digital_order_id;

  const orderRes = await db.query(
    `SELECT o.id, o.customer_name, o.customer_phone,
            COALESCE(o.customer_data->>'name', o.customer_name) AS display_name,
            c.trade_name, c.legal_name
       FROM digital_orders o
       LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.id = $1 AND o.company_id = $2 AND o.vertical = 'studio'
      LIMIT 1`,
    [digitalOrderId, req.params.id]
  );
  if (!orderRes.rows.length) return res.status(404).json({ error: 'Pedido digital não encontrado' });
  const order = orderRes.rows[0];

  const phone = customer_phone || order.customer_phone || '';
  const customerFirstName = (order.display_name || 'cliente').split(' ')[0];
  const shopName = order.trade_name || order.legal_name || 'nossa loja';

  let token = null;
  for (let i = 0; i < 5; i++) {
    const candidate = generateToken();
    const exists = await db.query(`SELECT 1 FROM studio_approval_links WHERE token = $1 LIMIT 1`, [candidate]);
    if (!exists.rows.length) { token = candidate; break; }
  }
  if (!token) return res.status(500).json({ error: 'Não foi possível gerar token' });

  const expiresInDays = Math.min(Math.max(parseInt(expires_in_days) || 7, 1), 30);
  const approvalUrl = `${process.env.APP_PUBLIC_URL || ''}/aprovacao/${token}`;
  const defaultMsg =
    `Oi ${customerFirstName}! Sua arte do pedido ficou pronta 🎨\n\n` +
    `Dá uma olhada e me confirma se posso imprimir:\n${approvalUrl}\n\n` +
    `_${shopName} · respondemos em até 1h_`;
  const messageText = (custom_message && String(custom_message).trim()) || defaultMsg;

  try {
    // Visual Engine F2: tenta gravar render_id (migration 209). Se a coluna
    // ainda não existe neste ambiente, refaz o INSERT sem ela — o link de
    // aprovação continua funcionando, só sem o vínculo ao render.
    let inserted;
    try {
      const r = await db.query(
        `INSERT INTO studio_approval_links
           (company_id, order_id, token, mockup_url, message_text,
            customer_phone, expires_at, created_by, render_id)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' days')::interval, $8, $9)
         RETURNING id, token, mockup_url, status, expires_at, created_at, render_id`,
        [req.params.id, digitalOrderId, token, mockup_url, messageText,
         phone || null, String(expiresInDays), req.user?.id || null,
         render_id || null]
      );
      inserted = r.rows[0];
    } catch (insErr) {
      if (insErr && insErr.code === '42703') {
        console.warn('[studio/orders/approval:POST] render_id indisponível (migration 209 pendente) — INSERT sem vínculo');
        const r = await db.query(
          `INSERT INTO studio_approval_links
             (company_id, order_id, token, mockup_url, message_text,
              customer_phone, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' days')::interval, $8)
           RETURNING id, token, mockup_url, status, expires_at, created_at`,
          [req.params.id, digitalOrderId, token, mockup_url, messageText,
           phone || null, String(expiresInDays), req.user?.id || null]
        );
        inserted = r.rows[0];
      } else {
        throw insErr;
      }
    }

    await db.query(
      `INSERT INTO studio_approval_revisions
         (approval_id, revision_number, mockup_url, note, created_by_type)
       VALUES ($1, 1, $2, $3, 'shop')`,
      [inserted.id, mockup_url, 'Mockup inicial enviado pra aprovação']
    );

    markStudioOnboarding(db, req.params.id, 'wa');

    res.status(201).json({
      ...inserted,
      approval_url: approvalUrl,
      wa_me_link: buildWaMeLink(phone, messageText),
      message_text: messageText,
    });
  } catch (err) {
    console.error('[studio/orders/approval:POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar link de aprovação' });
  }
});

router.get('/orders/:oid/approval', async function(req, res) {
  try {
    const headRes = await db.query(
      `SELECT source, digital_order_id FROM studio_orders
        WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.oid, req.params.id]
    );
    if (!headRes.rows.length || headRes.rows[0].source !== 'digital') {
      return res.json({ approvals: [] });
    }
    const r = await db.query(
      `SELECT a.*,
              (SELECT json_agg(json_build_object(
                'revision_number', r.revision_number,
                'mockup_url', r.mockup_url,
                'note', r.note,
                'created_by_type', r.created_by_type,
                'created_at', r.created_at
              ) ORDER BY r.revision_number)
               FROM studio_approval_revisions r WHERE r.approval_id = a.id) AS revisions
         FROM studio_approval_links a
        WHERE a.order_id = $1 AND a.company_id = $2
        ORDER BY a.created_at DESC`,
      [headRes.rows[0].digital_order_id, req.params.id]
    );
    res.json({ approvals: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar aprovações' }); }
});

router.post('/approval/:approvalId/cancel', async function(req, res) {
  try {
    const r = await db.query(
      `UPDATE studio_approval_links SET status = 'expired'
        WHERE id = $1 AND company_id = $2 AND status = 'pending'
        RETURNING id`,
      [req.params.approvalId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Aprovação não encontrada ou já respondida' });
    res.json({ cancelled: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao cancelar' }); }
});

module.exports = router;
