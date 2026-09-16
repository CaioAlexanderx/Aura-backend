// ============================================================
// AURA. — Linha do tempo e resumo do cliente (Fase 1 CRM)
//
// Usado por GET /companies/:id/customers/:cid/timeline|summary e pelas
// versões consolidadas /me/customers/:cid/timeline|summary.
//
// PAGINAÇÃO (mesmo cursor da history do crediário, src/utils/timelineCursor):
//   cada fonte devolve até limit+1 linhas em ordem (at DESC, key DESC) já
//   filtradas por `(at, key) < cursor`; o merge em JS reordena pelo mesmo
//   par e corta em limit. Como toda fonte respeita a mesma ordem total, o
//   resultado é idêntico ao de uma UNION ordenada — sem o custo de montar
//   uma UNION com colunas heterogêneas.
//
//   - `at` é truncado em milissegundos NO BANCO: o cursor carrega um ISO de
//     JS (ms). Comparar microssegundos do banco com o ms do cursor perderia
//     eventos no mesmo milissegundo.
//   - `key` é md5('<tipo>:<id da linha>')::uuid. Uma venda gera até três
//     eventos (compra, cancelamento, cupom usado) e, sem cancelled_at
//     (legado), a compra e o cancelamento teriam o MESMO (at, id). A chave
//     derivada separa os dois e mantém o cursor no formato `ts|uuid`.
//     O Postgres compara uuid byte a byte, que é a mesma ordem da string hex
//     minúscula — por isso o merge em JS compara as strings.
//
// GATE DE PLANO POR TIPO (armadilhas 3 e 9): compra, troca, cancelamento,
// cupom, avaliação e nota valem para todo plano; mensagem e crediário só
// para empresas Negócio+ (plano lido de companies, nunca do JWT). O GET
// nunca é bloqueado: o tipo travado some da resposta e aparece em
// `locked_types`.
//
// DEFENSIVO: toda fonte trata 42P01 como "sem eventos" (deploy parcial) e as
// colunas opcionais de sales usam cache module-level (armadilha 1).
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');
const { decodeCursor, encodeCursor } = require('../utils/timelineCursor');
const { hasSaleNumberColumn, saleNumberSelect } = require('../utils/saleNumber');
const { phoneMatchCandidates } = require('../utils/phone');
const { creditHistoryEventType, creditHistorySignedAmount } = require('./credit/historyEventType');

const TIMELINE_TYPES = ['compra', 'troca', 'cancelamento', 'crediario', 'cupom', 'mensagem', 'avaliacao', 'nota'];
const PREMIUM_TYPES = ['mensagem', 'crediario'];
const PREMIUM_PLANS = ['negocio', 'expansao', 'personalizado'];
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// Cache module-level de colunas/tabelas opcionais
const optional = {
  salesExtraCols: true,         // is_installment, total_installments, source_type (122c)
  saleItemsSnapshot: true,      // sale_items.product_name_snapshot (018)
  waOutboxDedupeByLog: true,    // wa_marketing_log existe (331)
};

function _resetCaches() {
  optional.salesExtraCols = true;
  optional.saleItemsSnapshot = true;
  optional.waOutboxDedupeByLog = true;
}

class TimelineError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra || {});
  }
}

function isMissing(e) {
  return e && (e.code === '42P01' || e.code === '42703');
}

/** Mesmo valor de md5('<type>:<id>')::uuid no Postgres. */
function derivedKey(type, id) {
  const h = crypto.createHash('md5').update(`${type}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function toIso(v) {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Ordem da linha do tempo: at DESC, key DESC. */
function compareEvents(a, b) {
  const ta = new Date(a.at).getTime();
  const tb = new Date(b.at).getTime();
  if (ta !== tb) return tb - ta;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}

// ── parâmetros ───────────────────────────────────────────────
function parseTimelineQuery(query) {
  const q = query || {};
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  let cursor = null;
  if (q.cursor) {
    cursor = decodeCursor(q.cursor);
    if (!cursor) throw new TimelineError(400, 'cursor invalido');
  }

  let types = TIMELINE_TYPES.slice();
  if (q.types) {
    const requested = [...new Set(String(q.types).split(',').map(s => s.trim()).filter(Boolean))];
    const invalid = requested.filter(t => !TIMELINE_TYPES.includes(t));
    if (invalid.length) {
      throw new TimelineError(400,
        `types invalido(s): ${invalid.join(', ')}. Validos: ${TIMELINE_TYPES.join(', ')}`);
    }
    if (requested.length) types = requested;
  }
  return { limit, cursor, types };
}

// ── escopo ───────────────────────────────────────────────────
async function loadCompanies(companyIds) {
  if (!companyIds.length) return [];
  const { rows } = await db.query(
    `-- tl:companies
     SELECT id, COALESCE(trade_name, legal_name) AS name, plan::text AS plan
       FROM companies
      WHERE id = ANY($1)`,
    [companyIds]
  );
  return rows;
}

function isPremiumPlan(plan) {
  return PREMIUM_PLANS.includes(String(plan || '').toLowerCase());
}

// ── fontes ───────────────────────────────────────────────────
// Cada fonte recebe ctx = { companyIds, customerId, cursor, take, phones }
// e devolve eventos crus { key, at, type, company_id, title, amount, meta, _sale }.

function pageFilter(atExpr, keyExpr, params, cursor) {
  if (!cursor) return '';
  params.push(cursor.createdAt, cursor.id);
  return `AND (${atExpr}, ${keyExpr}) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
}

async function safeRows(sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return rows;
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

const SELLER_EXPR = `COALESCE(NULLIF(s.seller_name, ''), e.name)`;

async function salesRows(tag, kind, whereSql, atExpr, ctx) {
  const saleNumberAvailable = await hasSaleNumberColumn(db);
  const keyExpr = `md5('${kind}:' || s.id::text)::uuid`;
  const atT = `date_trunc('milliseconds', ${atExpr})`;
  const build = (withExtra) => {
    const params = [ctx.companyIds, ctx.customerId];
    const page = pageFilter(atT, keyExpr, params, ctx.cursor);
    const extra = withExtra ? ', s.is_installment, s.total_installments, s.source_type' : '';
    return {
      sql: `-- tl:${tag}
       SELECT ${atT} AS ev_at,
              ${keyExpr} AS ev_key,
              s.id AS sale_id, s.company_id, s.created_at, s.cancelled_at,
              s.total_amount, s.discount_amount, s.payment_method, s.status,
              s.type AS sale_type, s.exchange_of_sale_id, s.coupon_id, s.coupon_code,
              ${SELLER_EXPR} AS seller_name,
              ${saleNumberSelect(saleNumberAvailable, 's')}${extra}
         FROM sales s
         LEFT JOIN employees e ON e.id = s.employee_id
        WHERE s.company_id = ANY($1) AND s.customer_id = $2
          AND ${whereSql}
          ${page}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      params,
    };
  };
  if (optional.salesExtraCols) {
    try {
      const q = build(true);
      return (await db.query(q.sql, q.params)).rows;
    } catch (e) {
      if (e.code !== '42703') throw e;
      optional.salesExtraCols = false;
    }
  }
  const q = build(false);
  return (await db.query(q.sql, q.params)).rows;
}

function saleMeta(r) {
  const meta = {
    sale_id: r.sale_id,
    sale_number: r.sale_number ?? null,
    payment_method: r.payment_method || null,
    seller_name: r.seller_name || null,
    discount_amount: num(r.discount_amount) || 0,
    status: r.status || 'completed',
  };
  if (r.coupon_code) meta.coupon_code = r.coupon_code;
  if (r.is_installment !== undefined) {
    meta.is_installment = !!r.is_installment;
    meta.total_installments = r.total_installments ?? null;
    meta.source_type = r.source_type || null;
  }
  return meta;
}

function saleLabel(base, r) {
  return r.sale_number ? `${base} #${r.sale_number}` : base;
}

const sources = {
  async compra(ctx) {
    const rows = await salesRows('compra', 'compra', `COALESCE(s.type, 'sale') <> 'troca'`, 's.created_at', ctx);
    return rows.map(r => ({
      key: r.ev_key, at: r.ev_at, type: 'compra', company_id: r.company_id,
      title: saleLabel('Compra', r),
      amount: num(r.total_amount),
      meta: saleMeta(r),
      _sale: r.sale_id,
    }));
  },

  async troca(ctx) {
    const rows = await salesRows('troca', 'troca', `s.type = 'troca'`, 's.created_at', ctx);
    return rows.map(r => ({
      key: r.ev_key, at: r.ev_at, type: 'troca', company_id: r.company_id,
      title: saleLabel('Troca', r),
      // Armadilha 5: total_amount da troca é o valor dos itens NOVOS, não
      // entrada de caixa. Fica no meta, não em amount.
      amount: null,
      meta: { ...saleMeta(r), exchange_of_sale_id: r.exchange_of_sale_id || null, new_items_total: num(r.total_amount) },
      _sale: r.sale_id,
      _troca: r.sale_id,
    }));
  },

  async cancelamento(ctx) {
    const rows = await salesRows('cancelamento', 'cancelamento', `s.status = 'cancelled'`,
      'COALESCE(s.cancelled_at, s.created_at)', ctx);
    return rows.map(r => ({
      key: r.ev_key, at: r.ev_at, type: 'cancelamento', company_id: r.company_id,
      title: saleLabel(r.sale_type === 'troca' ? 'Troca cancelada' : 'Venda cancelada', r),
      amount: r.sale_type === 'troca' ? null : num(r.total_amount),
      meta: { ...saleMeta(r), sale_type: r.sale_type || 'sale', sale_created_at: toIso(r.created_at) },
    }));
  },

  async cupom(ctx) {
    const pGen = [ctx.companyIds, ctx.customerId];
    const genKey = `md5('cupom_gerado:' || c.id::text)::uuid`;
    const genAt = `date_trunc('milliseconds', c.created_at)`;
    const genPage = pageFilter(genAt, genKey, pGen, ctx.cursor);
    const generated = await safeRows(
      `-- tl:cupom-gerado
       SELECT ${genAt} AS ev_at, ${genKey} AS ev_key, c.id, c.company_id, c.code, c.source,
              c.discount_type, c.discount_value, c.expires_at, c.current_uses, c.max_uses, c.is_active
         FROM coupons c
        WHERE c.company_id = ANY($1) AND c.customer_id = $2
          ${genPage}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      pGen
    );

    const pUse = [ctx.companyIds, ctx.customerId];
    const useKey = `md5('cupom_usado:' || s.id::text)::uuid`;
    const useAt = `date_trunc('milliseconds', s.created_at)`;
    const usePage = pageFilter(useAt, useKey, pUse, ctx.cursor);
    const used = await safeRows(
      `-- tl:cupom-usado
       SELECT ${useAt} AS ev_at, ${useKey} AS ev_key, s.id AS sale_id, s.company_id,
              s.coupon_id, s.coupon_code, s.discount_amount, s.status
         FROM sales s
        WHERE s.company_id = ANY($1) AND s.customer_id = $2
          AND (s.coupon_id IS NOT NULL OR NULLIF(s.coupon_code, '') IS NOT NULL)
          ${usePage}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      pUse
    );

    return [
      ...generated.map(r => ({
        key: r.ev_key, at: r.ev_at, type: 'cupom', company_id: r.company_id,
        title: `Cupom ${r.code} gerado`,
        amount: null,
        meta: {
          action: 'gerado', coupon_id: r.id, code: r.code, source: r.source || null,
          discount_type: r.discount_type, discount_value: num(r.discount_value),
          expires_at: toIso(r.expires_at), current_uses: r.current_uses ?? 0,
          max_uses: r.max_uses ?? null, is_active: r.is_active !== false,
        },
      })),
      ...used.map(r => ({
        key: r.ev_key, at: r.ev_at, type: 'cupom', company_id: r.company_id,
        title: `Cupom ${r.coupon_code || ''} usado`.replace('  ', ' '),
        amount: num(r.discount_amount),
        meta: {
          action: 'usado', coupon_id: r.coupon_id || null, code: r.coupon_code || null,
          sale_id: r.sale_id, sale_status: r.status || 'completed',
        },
      })),
    ];
  },

  async avaliacao(ctx) {
    const params = [ctx.companyIds, ctx.customerId];
    const key = `md5('avaliacao:' || r.id::text)::uuid`;
    const atExpr = `COALESCE(r.responded_at, r.created_at)`;
    const page = pageFilter(`date_trunc('milliseconds', ${atExpr})`, key, params, ctx.cursor);
    const rows = await safeRows(
      `-- tl:avaliacao
       SELECT date_trunc('milliseconds', ${atExpr}) AS ev_at, ${key} AS ev_key,
              r.id, r.company_id, r.sale_id, r.rating, r.comment
         FROM purchase_reviews r
        WHERE r.company_id = ANY($1) AND r.customer_id = $2
          AND r.rating IS NOT NULL
          ${page}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      params
    );
    return rows.map(r => ({
      key: r.ev_key, at: r.ev_at, type: 'avaliacao', company_id: r.company_id,
      title: `Avaliação ${r.rating}/5`,
      amount: null,
      meta: { review_id: r.id, rating: r.rating, comment: r.comment || null, sale_id: r.sale_id || null },
    }));
  },

  async nota(ctx) {
    const params = [ctx.companyIds, ctx.customerId];
    const key = `md5('nota:' || n.id::text)::uuid`;
    const atExpr = `date_trunc('milliseconds', n.created_at)`;
    const page = pageFilter(atExpr, key, params, ctx.cursor);
    const rows = await safeRows(
      `-- tl:nota
       SELECT ${atExpr} AS ev_at, ${key} AS ev_key, n.id, n.company_id, n.body, n.kind,
              n.author_id, u.full_name AS author_name
         FROM customer_notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.company_id = ANY($1) AND n.customer_id = $2
          ${page}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      params
    );
    return rows.map(r => ({
      key: r.ev_key, at: r.ev_at, type: 'nota', company_id: r.company_id,
      title: r.kind === 'merge' ? 'Cadastros mesclados' : 'Nota',
      amount: null,
      meta: {
        note_id: r.id, body: r.body, kind: r.kind || 'manual',
        author_id: r.author_id || null, author_name: r.author_name || null,
      },
    }));
  },

  // Crediário: mesma classificação da history (credit.js). O débito de uma
  // VENDA não entra — a compra já está na linha do tempo como `compra` com
  // payment_method = crediario; repetir viraria evento duplicado.
  async crediario(ctx) {
    const params = [ctx.premiumCompanyIds, ctx.customerId];
    const key = `md5('crediario:' || t.id::text)::uuid`;
    const atExpr = `date_trunc('milliseconds', t.created_at)`;
    const page = pageFilter(atExpr, key, params, ctx.cursor);
    const rows = await safeRows(
      `-- tl:crediario
       SELECT ${atExpr} AS ev_at, ${key} AS ev_key, t.id, t.company_id, t.sale_id, t.type,
              t.amount, t.payment_method, t.notes
         FROM customer_credit_transactions t
        WHERE t.company_id = ANY($1) AND t.customer_id = $2
          AND NOT (t.type = 'debit' AND t.sale_id IS NOT NULL)
          ${page}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      params
    );
    const titles = {
      manual_debit: 'Lançamento no crediário',
      payment: 'Pagamento do crediário',
      exchange_credit: 'Crédito de troca no crediário',
      refund: 'Estorno no crediário',
      purchase: 'Compra no crediário',
    };
    return rows.map(r => {
      const kind = creditHistoryEventType(r);
      return {
        key: r.ev_key, at: r.ev_at, type: 'crediario', company_id: r.company_id,
        title: titles[kind],
        amount: creditHistorySignedAmount(r),
        meta: {
          transaction_id: r.id, kind, payment_method: r.payment_method || null,
          notes: r.notes || null, sale_id: r.sale_id || null,
        },
      };
    });
  },

  async mensagem(ctx) {
    const ids = ctx.premiumCompanyIds;

    // a) marketing (reativação/aniversário) com o status real da fila
    const pLog = [ids, ctx.customerId];
    const logKey = `md5('mensagem_mkt:' || l.id::text)::uuid`;
    const logAt = `date_trunc('milliseconds', l.created_at)`;
    const logPage = pageFilter(logAt, logKey, pLog, ctx.cursor);
    const marketing = await safeRows(
      `-- tl:mensagem-marketing
       SELECT ${logAt} AS ev_at, ${logKey} AS ev_key, l.id, l.company_id, l.kind, l.segment,
              l.coupon_id, l.wa_outbox_id, COALESCE(o.status, l.status) AS status,
              o.template_name, o.skip_reason
         FROM wa_marketing_log l
         LEFT JOIN wa_outbox o ON o.id = l.wa_outbox_id
        WHERE l.company_id = ANY($1) AND l.customer_id = $2
          ${logPage}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      pLog
    );

    // b) parabéns manual (link wa.me). O envio automático ('wa_api') é
    //    espelho do wa_marketing_log e ficaria duplicado.
    const pBday = [ids, ctx.customerId];
    const bKey = `md5('mensagem_bday:' || b.id::text)::uuid`;
    const bAt = `date_trunc('milliseconds', b.sent_at)`;
    const bPage = pageFilter(bAt, bKey, pBday, ctx.cursor);
    const birthday = await safeRows(
      `-- tl:mensagem-aniversario
       SELECT ${bAt} AS ev_at, ${bKey} AS ev_key, b.id, b.company_id, b.method, b.coupon_id,
              b.birthday_year, b.message
         FROM birthday_messages_sent b
        WHERE b.company_id = ANY($1) AND b.customer_id = $2
          AND b.method IS DISTINCT FROM 'wa_api'
          ${bPage}
        ORDER BY ev_at DESC, ev_key DESC
        LIMIT ${ctx.take}`,
      pBday
    );

    // c) demais mensagens da Cloud API para o telefone do cliente
    //    (cobrança, OS, pedido...). wa_outbox não tem customer_id.
    let outbox = [];
    if (ctx.phones.length) {
      const run = async (dedupe) => {
        const p = [ids, ctx.phones];
        const oKey = `md5('mensagem_wa:' || o.id::text)::uuid`;
        const oAt = `date_trunc('milliseconds', o.created_at)`;
        const oPage = pageFilter(oAt, oKey, p, ctx.cursor);
        return safeRows(
          `-- tl:mensagem-outbox
           SELECT ${oAt} AS ev_at, ${oKey} AS ev_key, o.id, o.company_id, o.kind, o.template_name,
                  o.status, o.skip_reason, o.source_type
             FROM wa_outbox o
            WHERE o.company_id = ANY($1) AND o.to_phone = ANY($2)
              ${dedupe ? 'AND NOT EXISTS (SELECT 1 FROM wa_marketing_log l WHERE l.wa_outbox_id = o.id)' : ''}
              ${oPage}
            ORDER BY ev_at DESC, ev_key DESC
            LIMIT ${ctx.take}`,
          p
        );
      };
      if (optional.waOutboxDedupeByLog) {
        try {
          outbox = await run(true);
        } catch (e) {
          if (e.code !== '42P01') throw e;
          optional.waOutboxDedupeByLog = false;
        }
      }
      if (!optional.waOutboxDedupeByLog) outbox = await run(false);
    }

    const kindTitle = { aniversario: 'Mensagem de aniversário', reativacao: 'Mensagem de reativação' };
    return [
      ...marketing.map(r => ({
        key: r.ev_key, at: r.ev_at, type: 'mensagem', company_id: r.company_id,
        title: kindTitle[r.kind] || 'Mensagem de marketing',
        amount: null,
        meta: {
          channel: 'whatsapp', origin: 'marketing', kind: r.kind, segment: r.segment || null,
          status: r.status || null, template_name: r.template_name || null,
          skip_reason: r.skip_reason || null, coupon_id: r.coupon_id || null,
          wa_outbox_id: r.wa_outbox_id || null,
        },
      })),
      ...birthday.map(r => ({
        key: r.ev_key, at: r.ev_at, type: 'mensagem', company_id: r.company_id,
        title: 'Mensagem de aniversário',
        amount: null,
        meta: {
          channel: 'whatsapp', origin: 'manual', kind: 'aniversario', method: r.method,
          // Link wa.me: a loja abriu a conversa; entrega não é rastreável.
          status: 'aberto_pela_loja', coupon_id: r.coupon_id || null,
          birthday_year: r.birthday_year, message: r.message || null,
        },
      })),
      ...outbox.map(r => ({
        key: r.ev_key, at: r.ev_at, type: 'mensagem', company_id: r.company_id,
        title: 'Mensagem no WhatsApp',
        amount: null,
        meta: {
          channel: 'whatsapp', origin: r.source_type || 'outbox', kind: r.kind,
          status: r.status, template_name: r.template_name || null,
          skip_reason: r.skip_reason || null, wa_outbox_id: r.id,
        },
      })),
    ];
  },
};

// ── enriquecimento da página ─────────────────────────────────
function variantLabel(r) {
  return r.variant_values || r.sku_suffix || null;
}

async function fetchSaleItems(saleIds) {
  if (!saleIds.length) return {};
  const nameExpr = optional.saleItemsSnapshot
    ? `COALESCE(NULLIF(TRIM(si.product_name_snapshot), ''), p.name, 'Produto removido')`
    : `COALESCE(p.name, 'Produto removido')`;
  let rows;
  try {
    ({ rows } = await db.query(
      `-- tl:itens
       SELECT si.sale_id, si.product_id, si.variant_id, ${nameExpr} AS product_name,
              (SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
                 FROM product_variant_values pvv WHERE pvv.variant_id = si.variant_id) AS variant_values,
              pv.sku_suffix, si.quantity, si.unit_price, si.total_price
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         LEFT JOIN product_variants pv ON pv.id = si.variant_id
        WHERE si.sale_id = ANY($1::uuid[])
        ORDER BY si.sale_id, si.id`,
      [saleIds]
    ));
  } catch (e) {
    if (e.code === '42703' && optional.saleItemsSnapshot) {
      optional.saleItemsSnapshot = false;
      return fetchSaleItems(saleIds);
    }
    if (e.code === '42P01') return {};
    throw e;
  }
  const map = {};
  for (const r of rows) {
    (map[r.sale_id] = map[r.sale_id] || []).push({
      product_id: r.product_id,
      variant_id: r.variant_id || null,
      product_name: r.product_name,
      variant: variantLabel(r),
      quantity: num(r.quantity) || 0,
      unit_price: num(r.unit_price) || 0,
      total: num(r.total_price) || 0,
    });
  }
  return map;
}

async function fetchReturnedItems(trocaIds) {
  if (!trocaIds.length) return {};
  try {
    const { rows } = await db.query(
      `-- tl:itens-devolvidos
       SELECT tri.troca_sale_id, tri.product_id, tri.variant_id,
              COALESCE(NULLIF(TRIM(tri.product_name_snapshot), ''), p.name, 'Produto removido') AS product_name,
              (SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
                 FROM product_variant_values pvv WHERE pvv.variant_id = tri.variant_id) AS variant_values,
              pv.sku_suffix, tri.quantity, tri.unit_price
         FROM troca_returned_items tri
         LEFT JOIN products p ON p.id = tri.product_id
         LEFT JOIN product_variants pv ON pv.id = tri.variant_id
        WHERE tri.troca_sale_id = ANY($1::uuid[])`,
      [trocaIds]
    );
    const map = {};
    for (const r of rows) {
      (map[r.troca_sale_id] = map[r.troca_sale_id] || []).push({
        product_id: r.product_id || null,
        variant_id: r.variant_id || null,
        product_name: r.product_name,
        variant: variantLabel(r),
        quantity: num(r.quantity) || 0,
        unit_price: num(r.unit_price) || 0,
      });
    }
    return map;
  } catch (e) {
    if (isMissing(e)) return {};
    throw e;
  }
}

// ── montagem ─────────────────────────────────────────────────
/**
 * Junta os eventos das fontes, ordena e corta a página. Pura (testável).
 * @returns {{ page: object[], hasMore: boolean }}
 */
function mergePage(lists, limit) {
  const all = [].concat(...lists).map(e => ({ ...e, at: toIso(e.at) }));
  all.sort(compareEvents);
  const hasMore = all.length > limit;
  return { page: hasMore ? all.slice(0, limit) : all, hasMore };
}

/**
 * @param {object} opts
 * @param {string[]} opts.companyIds   empresas cujos eventos entram
 * @param {object}   opts.customer     { id, phone, phone_secondary, phone_e164 }
 * @param {object}   opts.query        req.query (cursor, limit, types)
 */
async function buildTimeline({ companyIds, customer, query }) {
  const { limit, cursor, types } = parseTimelineQuery(query);
  const companies = await loadCompanies(companyIds);
  const nameById = new Map(companies.map(c => [c.id, c.name || 'Empresa']));
  const premiumCompanyIds = companies.filter(c => isPremiumPlan(c.plan)).map(c => c.id);

  const lockedTypes = premiumCompanyIds.length ? [] : PREMIUM_TYPES.slice();
  const effectiveTypes = types.filter(t => !lockedTypes.includes(t));

  const ctx = {
    companyIds,
    premiumCompanyIds,
    customerId: customer.id,
    cursor,
    take: limit + 1,
    phones: phoneMatchCandidates(customer.phone_e164, customer.phone, customer.phone_secondary),
  };

  const lists = await Promise.all(effectiveTypes.map(t => sources[t](ctx)));
  const { page, hasMore } = mergePage(lists, limit);

  const saleIds = [...new Set(page.filter(e => e._sale).map(e => e._sale))];
  const trocaIds = [...new Set(page.filter(e => e._troca).map(e => e._troca))];
  const [itemsBySale, returnedByTroca] = await Promise.all([
    fetchSaleItems(saleIds),
    fetchReturnedItems(trocaIds),
  ]);

  const events = page.map((e) => {
    const meta = { ...e.meta };
    if (e.type === 'compra' || e.type === 'troca') meta.items = itemsBySale[e._sale] || [];
    if (e.type === 'troca') meta.returned_items = returnedByTroca[e._troca] || [];
    return {
      id: e.key,
      type: e.type,
      at: e.at,
      company_id: e.company_id,
      company_name: nameById.get(e.company_id) || 'Empresa',
      title: e.title,
      amount: e.amount,
      meta,
    };
  });

  const last = page[page.length - 1];
  return {
    events,
    next_cursor: hasMore && last ? encodeCursor(last.at, last.key) : null,
    types: effectiveTypes,
    locked_types: lockedTypes.filter(t => types.includes(t)),
  };
}

// ── resumo (topo da ficha) ───────────────────────────────────
async function buildSummary({ companyIds, customer }) {
  const companies = await loadCompanies(companyIds);
  const premiumCompanyIds = companies.filter(c => isPremiumPlan(c.plan)).map(c => c.id);

  // Armadilha 5: troca fora da receita; cancelada fora de tudo.
  const { rows: [s] } = await db.query(
    `-- tl:resumo-vendas
     SELECT COUNT(*) FILTER (WHERE COALESCE(type, 'sale') <> 'troca')                     AS purchases,
            COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(type, 'sale') <> 'troca'), 0) AS total_spent,
            COUNT(*) FILTER (WHERE type = 'troca')                                        AS exchanges,
            MIN(created_at) FILTER (WHERE COALESCE(type, 'sale') <> 'troca')              AS first_purchase_at,
            MAX(created_at) FILTER (WHERE COALESCE(type, 'sale') <> 'troca')              AS last_purchase_at,
            COUNT(DISTINCT (created_at AT TIME ZONE 'America/Sao_Paulo')::date)
              FILTER (WHERE COALESCE(type, 'sale') <> 'troca')                            AS purchase_days,
            (MAX(created_at) FILTER (WHERE COALESCE(type, 'sale') <> 'troca') AT TIME ZONE 'America/Sao_Paulo')::date
              - (MIN(created_at) FILTER (WHERE COALESCE(type, 'sale') <> 'troca') AT TIME ZONE 'America/Sao_Paulo')::date
                                                                                           AS span_days,
            (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
              - (MAX(created_at) FILTER (WHERE COALESCE(type, 'sale') <> 'troca') AT TIME ZONE 'America/Sao_Paulo')::date
                                                                                           AS days_since_last
       FROM sales
      WHERE company_id = ANY($1) AND customer_id = $2
        AND COALESCE(status, 'completed') <> 'cancelled'`,
    [companyIds, customer.id]
  );

  const purchases = parseInt(s.purchases, 10) || 0;
  const totalSpent = num(s.total_spent) || 0;
  const purchaseDays = parseInt(s.purchase_days, 10) || 0;
  const spanDays = s.span_days === null || s.span_days === undefined ? null : parseInt(s.span_days, 10);

  let creditBalance = null;
  if (premiumCompanyIds.length) {
    try {
      const { rows } = await db.query(
        `-- tl:resumo-crediario
         SELECT COALESCE(SUM(balance), 0) AS balance
           FROM customer_credit_balances
          WHERE company_id = ANY($1) AND customer_id = $2`,
        [premiumCompanyIds, customer.id]
      );
      creditBalance = num(rows[0] && rows[0].balance) || 0;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }

  let ratingAvg = null;
  let ratingsCount = 0;
  try {
    const { rows } = await db.query(
      `-- tl:resumo-avaliacoes
       SELECT AVG(rating)::numeric(4,2) AS avg, COUNT(*) AS n
         FROM purchase_reviews
        WHERE company_id = ANY($1) AND customer_id = $2 AND rating IS NOT NULL`,
      [companyIds, customer.id]
    );
    ratingsCount = parseInt(rows[0] && rows[0].n, 10) || 0;
    ratingAvg = ratingsCount ? num(rows[0].avg) : null;
  } catch (e) {
    if (!isMissing(e)) throw e;
  }

  return {
    customer_id: customer.id,
    company_ids: companyIds,
    total_spent: Math.round(totalSpent * 100) / 100,
    purchases_count: purchases,
    avg_ticket: purchases ? Math.round((totalSpent / purchases) * 100) / 100 : 0,
    first_purchase_at: toIso(s.first_purchase_at),
    last_purchase_at: toIso(s.last_purchase_at),
    days_since_last_purchase: s.days_since_last === null || s.days_since_last === undefined
      ? null : parseInt(s.days_since_last, 10),
    // Intervalo médio entre dias de compra distintos (duas compras no mesmo
    // dia contam como uma visita).
    avg_days_between_purchases: purchaseDays >= 2 && spanDays !== null
      ? Math.round((spanDays / (purchaseDays - 1)) * 10) / 10 : null,
    exchanges_count: parseInt(s.exchanges, 10) || 0,
    credit_balance: creditBalance,
    credit_locked: premiumCompanyIds.length === 0,
    rating_avg: ratingAvg,
    ratings_count: ratingsCount,
  };
}

module.exports = {
  TIMELINE_TYPES,
  PREMIUM_TYPES,
  PREMIUM_PLANS,
  TimelineError,
  parseTimelineQuery,
  buildTimeline,
  buildSummary,
  mergePage,
  compareEvents,
  derivedKey,
  isPremiumPlan,
  _resetCaches,
};
