// ============================================================
// AURA. — Garantia de Produto (extensao da Ordem de Servico)
//
// Montado em private.js sob /warranties. Schema: migration 365.
//
// POST   /warranties                    → {warranty}   emite (sale_id + itens com dias)
// GET    /warranties?q=&customer=&sale_from=&sale_to=&status=&limit=&offset=
//                                        → {items, total, summary}   (uma linha POR PRODUTO)
// GET    /warranties/terms              → {terms, default_terms, custom}
// GET    /warranties/sale/:saleId       → {warranties}
// GET    /warranties/by-code/:code      → {warranty}   validacao do QR (logado)
// GET    /warranties/:id                → {warranty}
// POST   /warranties/:id/void           → {warranty}   anula (motivo opcional)
// Documento imprimivel: GET /print/warranty/:id (routes/print.js).
//
// GATE: pdv_settings.os_enabled, lido do BANCO (nunca do JWT — armadilha #9)
// e SO NA ESCRITA (POST/void): o lojista que desligar o toggle continua
// enxergando e validando as garantias que ja emitiu (armadilha #3).
//
// Cliente obrigatorio, com nome, CPF e telefone: sem eles o papel nao prova
// nada. Quando falta, 422 CUSTOMER_INCOMPLETE com a lista do que falta, pro
// app abrir o cadastro em vez de mostrar um erro generico.
// ============================================================
const crypto = require('crypto');
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { DEFAULT_WARRANTY_TERMS } = require('../utils/warrantyTerms');
const { findOwnerScopedCustomer, CUSTOMER_NOT_FOUND_BODY } = require('../utils/customerScope');

const MAX_DAYS = 3650;
// Sem 0/O/1/I/L: o codigo e digitavel quando a camera falha.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function httpError(status, message, code, extra) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  if (extra) err.extra = extra;
  return err;
}

function genCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

// Aceita o codigo puro ou a URL inteira do QR (…/g/K7M4Q9XD).
function normalizeCode(raw) {
  const s = String(raw || '').trim().split(/[?#]/)[0];
  const last = s.split('/').filter(Boolean).pop() || '';
  return last.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function assertOsEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'os_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) throw httpError(404, 'Empresa nao encontrada');
  if (rows[0].enabled !== 'true') {
    throw httpError(403, 'Ordem de Servico nao esta habilitada. Ative em Configuracoes > PDV.', 'OS_DISABLED');
  }
}

async function loadTerms(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'warranty_terms' AS t FROM companies WHERE id = $1`,
    [companyId]
  );
  const custom = (rows[0] && rows[0].t || '').trim();
  return { terms: custom || DEFAULT_WARRANTY_TERMS, custom: !!custom };
}

// Status derivado da DATA (dia de Sao Paulo), nunca gravado: vencer e
// consequencia do calendario, e uma coluna gravada ficaria mentindo no dia
// seguinte sem ninguem rodar job.
const STATUS_SQL = `CASE
  WHEN w.voided_at IS NOT NULL THEN 'anulada'
  WHEN wi.expires_on < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'vencida'
  ELSE 'vigente' END`;
const DAYS_LEFT_SQL = `(wi.expires_on - (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)`;

const ITEM_COLS = `wi.id, wi.warranty_id, wi.sale_item_id, wi.product_id, wi.product_name, wi.serial,
  wi.quantity, wi.unit_price, wi.days,
  to_char(wi.starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(wi.expires_on, 'YYYY-MM-DD') AS expires_on,
  ${STATUS_SQL} AS status, ${DAYS_LEFT_SQL} AS days_left`;

async function loadWarranty(q, companyId, where, param) {
  const { rows } = await q.query(
    `SELECT w.*, s.sale_number, s.created_at AS sale_date
       FROM warranties w
       LEFT JOIN sales s ON s.id = w.sale_id
      WHERE w.company_id = $1 AND ${where}`,
    [companyId, param]
  );
  if (!rows.length) return null;
  const { rows: items } = await q.query(
    `SELECT ${ITEM_COLS}
       FROM warranty_items wi JOIN warranties w ON w.id = wi.warranty_id
      WHERE wi.warranty_id = $1
      ORDER BY wi.sort_order, wi.product_name`,
    [rows[0].id]
  );
  return { ...rows[0], items };
}

function handle(res, err, tag) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra || {}) });
  }
  if (err.code === '42P01' || err.code === '42703') {
    return res.status(503).json({ error: 'Modulo de Garantia ainda nao instalado neste ambiente', code: 'WARRANTY_NOT_INSTALLED' });
  }
  console.error(`[warranties] ${tag}:`, err.message);
  return res.status(500).json({ error: 'Erro ao processar garantia' });
}

// ─── POST / ─ emite ──────────────────────────────────────────
router.post('/', async function (req, res) {
  const cid = req.params.id;
  const { sale_id, items, notes } = req.body || {};

  if (!sale_id) return res.status(400).json({ error: 'sale_id obrigatorio' });
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Selecione ao menos um produto com garantia' });
  }
  const pedidos = [];
  const vistos = new Set();
  for (const it of items) {
    const days = parseInt(it && it.days, 10);
    // O item da venda e identificado por sale_item_id OU por product_id
    // (+ variant_id): o PDV so conhece a chave do carrinho, nao o id que o
    // servidor gravou, e a garantia e emitida logo apos o POST /pdv/sale.
    if (!it || (!it.sale_item_id && !it.product_id)) {
      return res.status(400).json({ error: 'sale_item_id ou product_id obrigatorio em cada item' });
    }
    if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
      return res.status(400).json({ error: `Dias de garantia devem ficar entre 1 e ${MAX_DAYS}` });
    }
    const chave = it.sale_item_id || `${it.product_id}:${it.variant_id || ''}`;
    if (vistos.has(chave)) return res.status(400).json({ error: 'Produto repetido na garantia' });
    vistos.add(chave);
    pedidos.push({
      sale_item_id: it.sale_item_id || null,
      product_id: it.product_id || null,
      variant_id: it.variant_id || null,
      days,
      serial: String(it.serial || '').trim().slice(0, 60) || null,
    });
  }

  let client;
  try {
    await assertOsEnabled(cid);

    client = await db.connect();
    await client.query('BEGIN');

    const { rows: sRows } = await client.query(
      `SELECT s.id, s.customer_id,
              (s.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS sale_day,
              to_char((s.created_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS sale_day_txt,
              COALESCE(s.status, 'completed') AS status
         FROM sales s WHERE s.id = $1 AND s.company_id = $2`,
      [sale_id, cid]
    );
    if (!sRows.length) throw httpError(404, 'Venda nao encontrada');
    const sale = sRows[0];
    if (sale.status === 'cancelled') throw httpError(409, 'Venda cancelada nao recebe garantia', 'SALE_CANCELLED');

    if (!sale.customer_id) {
      throw httpError(422, 'Cliente obrigatorio para emitir garantia.', 'CUSTOMER_REQUIRED');
    }
    const { rows: cRows } = await client.query(
      'SELECT id, name, cpf_cnpj, phone FROM customers WHERE id = $1',
      [sale.customer_id]
    );
    const cust = cRows[0];
    const faltam = [];
    if (!cust || !String(cust.name || '').trim()) faltam.push('name');
    if (!cust || String(cust.cpf_cnpj || '').replace(/\D/g, '').length < 11) faltam.push('cpf');
    if (!cust || String(cust.phone || '').replace(/\D/g, '').length < 10) faltam.push('phone');
    if (faltam.length) {
      throw httpError(422, 'Cadastro do cliente incompleto: a garantia exige nome, CPF e telefone.',
        'CUSTOMER_INCOMPLETE', { missing: faltam, customer_id: sale.customer_id });
    }

    // Itens da venda (nome: o produto atual, com o snapshot da venda de fallback).
    const { rows: siRows } = await client.query(
      `SELECT si.id, si.product_id, si.variant_id, si.quantity, si.unit_price,
              COALESCE(p.name, si.product_name_snapshot) AS product_name
         FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
        WHERE si.sale_id = $1
        ORDER BY si.id`,
      [sale_id]
    );
    const usados = new Set();
    for (const p of pedidos) {
      const achado = siRows.find((r) => !usados.has(r.id) && (p.sale_item_id
        ? r.id === p.sale_item_id
        : String(r.product_id) === String(p.product_id)
          && String(r.variant_id || '') === String(p.variant_id || '')));
      if (!achado) throw httpError(404, 'Item nao pertence a esta venda');
      usados.add(achado.id);
      p.sale_item_id = achado.id;
      p.item = achado;
    }
    const pedidoIds = pedidos.map((p) => p.sale_item_id);

    // Um item de venda nao recebe duas garantias vigentes.
    const { rows: dup } = await client.query(
      `SELECT wi.sale_item_id FROM warranty_items wi
         JOIN warranties w ON w.id = wi.warranty_id
        WHERE wi.sale_item_id = ANY($1::uuid[]) AND w.voided_at IS NULL`,
      [pedidoIds]
    );
    if (dup.length) {
      throw httpError(409, 'Algum produto ja tem garantia emitida nesta venda.', 'WARRANTY_ALREADY_ISSUED',
        { sale_item_ids: dup.map((d) => d.sale_item_id) });
    }

    // Numero sequencial por empresa, serializado por lock de transacao.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['warranty:' + cid]);
    const { rows: nRows } = await client.query(
      'SELECT COALESCE(MAX(warranty_number), 0) + 1 AS n FROM warranties WHERE company_id = $1',
      [cid]
    );
    const number = nRows[0].n;

    const { terms } = await loadTerms(cid);

    let wRow = null;
    for (let tent = 0; tent < 5 && !wRow; tent++) {
      await client.query('SAVEPOINT cod');
      try {
        const ins = await client.query(
          `INSERT INTO warranties
             (company_id, warranty_number, code, sale_id, customer_id,
              customer_name, customer_cpf, customer_phone, terms_text, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [cid, number, genCode(), sale_id, cust.id, cust.name.trim(),
            String(cust.cpf_cnpj).replace(/\D/g, ''), String(cust.phone).replace(/\D/g, ''),
            terms, String(notes || '').trim().slice(0, 500) || null, req.user?.id || null]
        );
        wRow = ins.rows[0];
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT cod');
        if (e.code !== '23505' || !/code/.test(String(e.constraint || e.message))) throw e;
      }
    }
    if (!wRow) throw httpError(500, 'Nao foi possivel gerar o codigo da garantia');

    let ordem = 0;
    for (const p of pedidos) {
      const si = p.item;
      await client.query(
        `INSERT INTO warranty_items
           (warranty_id, company_id, sale_item_id, product_id, product_name, serial,
            quantity, unit_price, days, starts_on, expires_on, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$10::date + $9::int,$11)`,
        [wRow.id, cid, si.id, si.product_id, si.product_name || 'Produto', p.serial,
          si.quantity, si.unit_price, p.days, sale.sale_day_txt, ordem++]
      );
    }

    await client.query('COMMIT');
    const full = await loadWarranty(db, cid, 'w.id = $2', wRow.id);
    return res.status(201).json({ warranty: full });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ja abortada */ } }
    return handle(res, err, 'emitir');
  } finally {
    if (client) client.release();
  }
});

// ─── GET / ─ lista (uma linha por produto) ───────────────────
router.get('/', async function (req, res) {
  const cid = req.params.id;
  try {
    const params = [cid];
    const where = ['w.company_id = $1'];
    const q = String(req.query.q || '').trim();
    if (q) {
      params.push(`%${q}%`);
      where.push(`(wi.product_name ILIKE $${params.length} OR wi.serial ILIKE $${params.length})`);
    }
    const customer = String(req.query.customer || '').trim();
    if (customer) {
      params.push(`%${customer}%`);
      const digits = customer.replace(/\D/g, '');
      let cond = `w.customer_name ILIKE $${params.length}`;
      if (digits.length >= 3) { params.push(`%${digits}%`); cond += ` OR w.customer_cpf LIKE $${params.length} OR w.customer_phone LIKE $${params.length}`; }
      where.push(`(${cond})`);
    }
    if (req.query.customer_id) {
      params.push(req.query.customer_id);
      where.push(`w.customer_id = $${params.length}`);
    }
    // "Data de venda": a da venda; garantia sem venda (SET NULL) cai na emissao.
    const saleDay = `((COALESCE(s.created_at, w.created_at)) AT TIME ZONE 'America/Sao_Paulo')::date`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.sale_from || ''))) {
      params.push(req.query.sale_from); where.push(`${saleDay} >= $${params.length}::date`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.sale_to || ''))) {
      params.push(req.query.sale_to); where.push(`${saleDay} <= $${params.length}::date`);
    }
    const status = String(req.query.status || '');
    if (['vigente', 'vencida', 'anulada'].includes(status)) {
      params.push(status); where.push(`${STATUS_SQL} = $${params.length}`);
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const from = `FROM warranty_items wi
       JOIN warranties w ON w.id = wi.warranty_id
       LEFT JOIN sales s ON s.id = w.sale_id
      WHERE ${where.join(' AND ')}`;

    const { rows } = await db.query(
      `SELECT wi.id, wi.warranty_id, w.warranty_number, w.code,
              wi.product_name, wi.serial, wi.quantity, wi.days,
              to_char(wi.starts_on, 'YYYY-MM-DD') AS starts_on,
              to_char(wi.expires_on, 'YYYY-MM-DD') AS expires_on,
              ${STATUS_SQL} AS status, ${DAYS_LEFT_SQL} AS days_left,
              w.customer_id, w.customer_name, w.customer_phone,
              w.sale_id, s.sale_number, COALESCE(s.created_at, w.created_at) AS sale_date, w.created_at
         ${from}
        ORDER BY w.created_at DESC, wi.sort_order
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const { rows: tot } = await db.query(`SELECT COUNT(*)::int AS total ${from}`, params);

    // Resumo sempre da empresa inteira (nao do filtro): e o "painel" do topo.
    const { rows: sum } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE w.voided_at IS NULL AND wi.expires_on >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS vigentes,
              COUNT(*) FILTER (WHERE w.voided_at IS NULL AND wi.expires_on >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
                                AND wi.expires_on <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + 30)::int AS vencendo_30d,
              COUNT(*) FILTER (WHERE w.voided_at IS NULL AND wi.expires_on < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS vencidas
         FROM warranty_items wi JOIN warranties w ON w.id = wi.warranty_id
        WHERE w.company_id = $1`,
      [cid]
    );
    res.json({ items: rows, total: tot[0].total, summary: sum[0] });
  } catch (err) {
    // Leitura sem a migration: lista vazia em vez de erro (deploy parcial).
    if (err.code === '42P01') {
      return res.json({ items: [], total: 0, summary: { vigentes: 0, vencendo_30d: 0, vencidas: 0 }, not_installed: true });
    }
    return handle(res, err, 'listar');
  }
});

// ─── GET /terms ──────────────────────────────────────────────
router.get('/terms', async function (req, res) {
  try {
    const { terms, custom } = await loadTerms(req.params.id);
    res.json({ terms, custom, default_terms: DEFAULT_WARRANTY_TERMS });
  } catch (err) { return handle(res, err, 'terms'); }
});

// ─── GET /customer/:customerId/check ─────────────────────────
// O PDV pergunta ANTES de vender: se o cadastro nao tem CPF/telefone, o
// lojista completa ali mesmo — descobrir so depois do POST /pdv/sale deixaria
// a venda feita e a garantia sem emitir.
router.get('/customer/:customerId/check', async function (req, res) {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.customerId)) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const c = await findOwnerScopedCustomer(db, req.params.id, req.params.customerId, 'id, name, cpf_cnpj, phone');
    if (!c) return res.status(404).json(CUSTOMER_NOT_FOUND_BODY);
    const missing = [];
    if (!String(c.name || '').trim()) missing.push('name');
    if (String(c.cpf_cnpj || '').replace(/\D/g, '').length < 11) missing.push('cpf');
    if (String(c.phone || '').replace(/\D/g, '').length < 10) missing.push('phone');
    res.json({ customer: { id: c.id, name: c.name, cpf_cnpj: c.cpf_cnpj || '', phone: c.phone || '' }, missing, complete: !missing.length });
  } catch (err) { return handle(res, err, 'customer-check'); }
});

// ─── GET /sale/:saleId ───────────────────────────────────────
router.get('/sale/:saleId', async function (req, res) {
  try {
    const { rows } = await db.query(
      'SELECT id FROM warranties WHERE company_id = $1 AND sale_id = $2 ORDER BY created_at',
      [req.params.id, req.params.saleId]
    );
    const out = [];
    for (const r of rows) out.push(await loadWarranty(db, req.params.id, 'w.id = $2', r.id));
    res.json({ warranties: out });
  } catch (err) {
    if (err.code === '42P01') return res.json({ warranties: [] });
    return handle(res, err, 'por venda');
  }
});

// ─── GET /by-code/:code ─ validacao do QR ────────────────────
router.get('/by-code/:code', async function (req, res) {
  try {
    const code = normalizeCode(req.params.code);
    if (code.length < 6) return res.status(404).json({ error: 'Garantia nao encontrada', code: 'WARRANTY_NOT_FOUND' });
    const w = await loadWarranty(db, req.params.id, 'w.code = $2', code);
    if (!w) return res.status(404).json({ error: 'Garantia nao encontrada nesta loja', code: 'WARRANTY_NOT_FOUND' });
    res.json({ warranty: w });
  } catch (err) { return handle(res, err, 'by-code'); }
});

// ─── GET /:id ────────────────────────────────────────────────
router.get('/:wid', async function (req, res) {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.wid)) return res.status(404).json({ error: 'Garantia nao encontrada' });
    const w = await loadWarranty(db, req.params.id, 'w.id = $2', req.params.wid);
    if (!w) return res.status(404).json({ error: 'Garantia nao encontrada' });
    res.json({ warranty: w });
  } catch (err) { return handle(res, err, 'detalhe'); }
});

// ─── POST /:id/void ──────────────────────────────────────────
router.post('/:wid/void', async function (req, res) {
  try {
    await assertOsEnabled(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.wid)) return res.status(404).json({ error: 'Garantia nao encontrada' });
    const { rowCount } = await db.query(
      `UPDATE warranties SET voided_at = NOW(), void_reason = $3
        WHERE id = $1 AND company_id = $2 AND voided_at IS NULL`,
      [req.params.wid, req.params.id, String((req.body || {}).reason || '').trim().slice(0, 300) || null]
    );
    if (!rowCount) return res.status(404).json({ error: 'Garantia nao encontrada ou ja anulada' });
    const w = await loadWarranty(db, req.params.id, 'w.id = $2', req.params.wid);
    res.json({ warranty: w });
  } catch (err) { return handle(res, err, 'anular'); }
});

module.exports = router;
module.exports._test = { normalizeCode, genCode };
