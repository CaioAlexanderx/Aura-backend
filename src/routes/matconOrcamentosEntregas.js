// ============================================================
// AURA. — Matcon M1: orcamentos e entregas
//
// Montado em private.js sob /matcon (o /companies/:id e o
// requireCompanyAccess vem de la). Schema: migration 352. Contrato:
// docs/CONTRACT_MATCON.md secao M1 (repo do app) e services/matconApi.ts,
// que esta rota espelha nome por nome.
//
// GET    /matcon/quotes?status=&q=&limit=      → {quotes, summary}
// GET    /matcon/quotes/:qid                   → {quote}
// POST   /matcon/quotes                        → 201 {quote}
// PATCH  /matcon/quotes/:qid                   → {quote}
// POST   /matcon/quotes/:qid/sent              → {quote}
// POST   /matcon/quotes/:qid/convert           → {quote, cart}
// GET    /matcon/deliveries?day=&stage=&limit= → {deliveries, summary}
// POST   /matcon/deliveries                    → 201 {delivery}
// PATCH  /matcon/deliveries/:did               → {delivery}
// POST   /matcon/deliveries/:did/split         → {delivered, next}
//
// GATE: matcon_enabled em companies.pdv_settings, lido do BANCO (o JWT
// nunca revalida) e so na ESCRITA — desligar o toggle com 12 entregas na
// rua nao pode esconder da loja o que ela ainda tem que entregar. Mesmo
// desenho do assertOticaEnabled (otica.js). A funcao mora aqui de
// proposito (M3 e M4 estao sendo feitos em paralelo).
//
// DECISOES:
// - "Virar pedido" (convert) NAO cria venda (decisao 22/09 do contrato:
//   evita pedido duplicado). Aprova e devolve o carrinho; a venda nasce no
//   Caixa com quote_id (services/matconSaleHooks.js).
// - SEM RESERVA DE ESTOQUE: o repo nao tem mecanismo de reserva e esta
//   rota nao inventa um. A baixa acontece na venda, como sempre.
// - convert aceita open, expired e approved (ainda sem venda): o botao da
//   esteira aparece pro orcamento vencido tambem, e quem decide se o
//   preco ainda vale e o lojista. Barra lost e o que ja virou venda.
// - Reabrir (PATCH status=open) um orcamento com validade no passado
//   renova a validade (hoje + matcon_quote_valid_days) — senao ele
//   voltaria a vencer no job da noite seguinte.
// - "expired" so o job diario grava (jobs/matconQuoteExpiryJob.js).
// - Datas (valid_until, scheduled_for) saem como 'YYYY-MM-DD' e "hoje" e
//   sempre o dia de Sao Paulo, calculado no banco.
// - Entrega parcial (split): esta entrega fica "delivered" com o que foi;
//   o saldo vira a proxima (sequence + 1, hoje + matcon_default_delivery_days).
//   A soma por item da venda nunca passa do vendido: o maximo de cada item
//   e vendido - ja entregue - o que esta planejado em OUTRA entrega aberta.
// - day=pending ("A entregar", QA 23/09): TODA entrega aberta (nao
//   entregue, nao cancelada), de qualquer data, por scheduled_for e
//   sequence. Antes era so o saldo de pedido com viagem ja entregue, e a
//   entrega nova — marcada pra hoje + matcon_default_delivery_days — nao
//   caia em today, tomorrow, late nem pending: sumia da tela.
//   summary.pending_orders conta os pedidos (vendas distintas) com pelo
//   menos uma entrega aberta. today, tomorrow, late e sem day: iguais.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { findOwnerScopedCustomer, CUSTOMER_NOT_FOUND_BODY } = require('../utils/customerScope');
const { createFirstDelivery, diasDeEntrega } = require('../services/matconSaleHooks');

const SP_TODAY = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const QUOTE_STATUSES = ['open', 'approved', 'lost', 'expired'];
const QUOTE_PATCH_STATUSES = ['open', 'approved', 'lost'];
const STAGES = ['separating', 'ready', 'out', 'delivered'];
const DAYS = ['today', 'tomorrow', 'late', 'pending'];

// ─── Gate do modulo ──────────────────────────────────────────
function erroMatconDesligado() {
  const err = new Error('Ligue "Materiais de construção" em Configurações › Caixa para usar orçamentos e entregas.');
  err.status = 403;
  err.code = 'MATCON_DISABLED';
  return err;
}

// Le pdv_settings inteiro (quem chama usa as chaves de prazo/validade).
async function lerPdvSettings(companyId) {
  const { rows } = await db.query(
    'SELECT pdv_settings FROM companies WHERE id = $1',
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa não encontrada');
    err.status = 404;
    throw err;
  }
  const s = rows[0].pdv_settings;
  return s && typeof s === 'object' ? s : {};
}

// So na escrita. Devolve o pdv_settings pra rota nao ler duas vezes.
async function assertMatconEnabled(companyId) {
  const settings = await lerPdvSettings(companyId);
  if (settings.matcon_enabled !== true && settings.matcon_enabled !== 'true') {
    throw erroMatconDesligado();
  }
  return settings;
}

// Inteiro de pdv_settings dentro de [min, max]; fora disso, o padrao do
// contrato (o front tem os mesmos defaults).
function intSetting(settings, key, def, min, max) {
  const raw = settings ? settings[key] : undefined;
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isInteger(n) || n < min || n > max) return def;
  return n;
}

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[matcon:${contexto}]`, err && err.message);
  return res.status(500).json({ error: 'Não deu para concluir agora. Tente de novo em instantes.' });
}

function erro(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

// ─── Utilitarios ─────────────────────────────────────────────
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

function dataValida(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 'YYYY-MM-DD' de hoje em Sao Paulo (so pra validar entrada; o que vai
// pro banco usa SP_TODAY).
function hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function textoOuNull(v, max) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// ─── Orcamentos ──────────────────────────────────────────────
const QUOTE_COLS = `q.id, q.number, q.status, q.customer_id, q.customer_name, q.customer_phone,
  q.seller_id, q.seller_name, to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
  q.public_token, q.items, q.subtotal, q.discount, q.total, q.notes, q.reference,
  q.approved_at, q.converted_sale_id, q.sent_at, q.created_at, q.updated_at`;

function itemOut(it) {
  return {
    product_id: it && it.product_id ? String(it.product_id) : null,
    name: it && it.name ? String(it.name) : '',
    unit: it && it.unit ? String(it.unit) : null,
    quantity: Number(it && it.quantity) || 0,
    unit_price: Number(it && it.unit_price) || 0,
    discount: Number(it && it.discount) || 0,
  };
}

function quoteOut(r) {
  return {
    id: r.id,
    number: r.number == null ? null : Number(r.number),
    status: r.status,
    customer_id: r.customer_id || null,
    customer_name: r.customer_name || null,
    customer_phone: r.customer_phone || null,
    seller_id: r.seller_id || null,
    seller_name: r.seller_name || null,
    valid_until: r.valid_until,
    public_token: r.public_token,
    items: Array.isArray(r.items) ? r.items.map(itemOut) : [],
    subtotal: Number(r.subtotal) || 0,
    discount: Number(r.discount) || 0,
    total: Number(r.total) || 0,
    notes: r.notes || null,
    reference: r.reference || null,
    approved_at: r.approved_at || null,
    converted_sale_id: r.converted_sale_id || null,
    sent_at: r.sent_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Valida e normaliza os itens do QuoteCreateBody. Preco e quantidade do
// DIA ficam congelados no orcamento (decisao a da 352). product_id que nao
// e uuid vira null: o Caixa usa chaves proprias pra item sem cadastro, e
// isso nao pode travar o "Salvar orcamento".
function normalizarItens(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Adicione pelo menos um produto ao orçamento.' };
  }
  if (raw.length > 300) return { error: 'O orçamento aceita até 300 itens.' };
  const items = [];
  let subtotal = 0;
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] || {};
    const name = String(it.name || '').trim().slice(0, 200);
    if (!name) return { error: `O item ${i + 1} está sem nome.` };
    const quantity = round3(Number(it.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { error: `"${name}": informe uma quantidade maior que zero.` };
    }
    const unitPrice = round2(Number(it.unit_price));
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return { error: `"${name}": preço inválido.` };
    }
    const gross = round2(quantity * unitPrice);
    let discount = it.discount === undefined || it.discount === null || it.discount === '' ? 0 : round2(Number(it.discount));
    if (!Number.isFinite(discount) || discount < 0) {
      return { error: `"${name}": desconto inválido.` };
    }
    discount = Math.min(discount, gross);
    const pid = it.product_id ? String(it.product_id) : null;
    items.push({
      product_id: pid && UUID_RE.test(pid) ? pid : null,
      name,
      unit: textoOuNull(it.unit, 12),
      quantity,
      unit_price: unitPrice,
      discount,
    });
    subtotal += gross - discount;
  }
  return { items, subtotal: round2(subtotal) };
}

function descontoDoOrcamento(raw, subtotal) {
  if (raw === undefined || raw === null || raw === '') return { discount: 0 };
  const d = round2(Number(raw));
  if (!Number.isFinite(d) || d < 0) return { error: 'Desconto inválido.' };
  return { discount: Math.min(d, subtotal) };
}

// Cliente do QuoteCreateBody. customer_id vale se for desta loja ou de
// outra loja ativa do mesmo dono (mesma regra do Caixa). Nome e telefone
// mandados no body prevalecem sobre o cadastro.
async function resolverCliente(companyId, b, atual) {
  let customerId = atual ? atual.customer_id : null;
  let nome = atual ? atual.customer_name : null;
  let fone = atual ? atual.customer_phone : null;

  if (has(b, 'customer_id')) {
    if (b.customer_id) {
      if (!UUID_RE.test(String(b.customer_id))) throw erro(404, CUSTOMER_NOT_FOUND_BODY.error, CUSTOMER_NOT_FOUND_BODY.code);
      const c = await findOwnerScopedCustomer(db, companyId, String(b.customer_id), 'id, name, phone');
      if (!c) throw erro(404, CUSTOMER_NOT_FOUND_BODY.error, CUSTOMER_NOT_FOUND_BODY.code);
      customerId = c.id;
      nome = c.name || nome;
      fone = c.phone || fone;
    } else {
      customerId = null;
    }
  }
  if (has(b, 'customer_name') && b.customer_name !== undefined) {
    nome = textoOuNull(b.customer_name, 120) || (customerId ? nome : null);
  }
  if (has(b, 'customer_phone') && b.customer_phone !== undefined) {
    fone = textoOuNull(b.customer_phone, 30) || (customerId ? fone : null);
  }
  return { customer_id: customerId, customer_name: nome, customer_phone: fone };
}

// seller_id do Caixa e um funcionario (employees) da loja.
async function resolverVendedor(companyId, sellerId) {
  if (!sellerId) return { seller_id: null, seller_name: null };
  if (!UUID_RE.test(String(sellerId))) throw erro(400, 'Vendedor não encontrado nesta loja.');
  const { rows } = await db.query(
    'SELECT id, name FROM employees WHERE id = $1 AND company_id = $2',
    [String(sellerId), companyId]
  );
  if (!rows.length) throw erro(400, 'Vendedor não encontrado nesta loja.');
  return { seller_id: rows[0].id, seller_name: rows[0].name || null };
}

async function carregarOrcamento(companyId, quoteId) {
  if (!UUID_RE.test(String(quoteId))) return null;
  const { rows } = await db.query(
    `SELECT ${QUOTE_COLS} FROM matcon_quotes q WHERE q.id = $1 AND q.company_id = $2`,
    [quoteId, companyId]
  );
  return rows[0] || null;
}

// ─── GET /matcon/quotes ──────────────────────────────────────
router.get('/quotes', async function (req, res) {
  const companyId = req.params.id;
  try {
    const status = String(req.query.status || '').trim();
    if (status && status !== 'all' && !QUOTE_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Filtro de situação inválido.' });
    }
    const busca = String(req.query.q || '').trim().slice(0, 80);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

    const settings = await lerPdvSettings(companyId);
    const warnDays = intSetting(settings, 'matcon_quote_warn_days', 3, 0, 60);

    const cond = ['q.company_id = $1'];
    const vals = [companyId];
    if (status && status !== 'all') {
      vals.push(status);
      cond.push(`q.status = $${vals.length}`);
    }
    if (busca) {
      vals.push(`%${busca}%`);
      const like = `$${vals.length}`;
      const ors = [`q.customer_name ILIKE ${like}`, `q.reference ILIKE ${like}`, `q.customer_phone ILIKE ${like}`];
      if (/^\d{1,9}$/.test(busca)) {
        vals.push(parseInt(busca, 10));
        ors.push(`q.number = $${vals.length}`);
      }
      cond.push(`(${ors.join(' OR ')})`);
    }
    vals.push(limit);

    const { rows } = await db.query(
      `SELECT ${QUOTE_COLS}
         FROM matcon_quotes q
        WHERE ${cond.join(' AND ')}
        ORDER BY q.created_at DESC
        LIMIT $${vals.length}`,
      vals
    );

    // Cabecalho da esteira: sempre da loja inteira (independe do filtro).
    const { rows: sum } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
         COALESCE(SUM(total) FILTER (WHERE status = 'open'), 0) AS open_total,
         COUNT(*) FILTER (WHERE status = 'open' AND valid_until <= ${SP_TODAY} + $2::int)::int AS expiring_count,
         COALESCE(SUM(total) FILTER (WHERE status = 'open' AND valid_until <= ${SP_TODAY} + $2::int), 0) AS expiring_total,
         COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
         COALESCE(SUM(total) FILTER (WHERE status = 'approved'), 0) AS approved_total,
         COUNT(*) FILTER (WHERE status = 'lost')::int AS lost_count,
         COALESCE(SUM(total) FILTER (WHERE status = 'lost'), 0) AS lost_total
       FROM matcon_quotes
      WHERE company_id = $1`,
      [companyId, warnDays]
    );
    const s = sum[0] || {};
    const par = (k) => ({ count: Number(s[`${k}_count`]) || 0, total: round2(Number(s[`${k}_total`]) || 0) });

    res.json({
      quotes: rows.map(quoteOut),
      summary: { open: par('open'), expiring: par('expiring'), approved: par('approved'), lost: par('lost') },
    });
  } catch (err) {
    falhar(res, err, 'GET:quotes');
  }
});

// ─── GET /matcon/quotes/:qid ─────────────────────────────────
router.get('/quotes/:qid', async function (req, res) {
  try {
    const row = await carregarOrcamento(req.params.id, req.params.qid);
    if (!row) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    res.json({ quote: quoteOut(row) });
  } catch (err) {
    falhar(res, err, 'GET:quote');
  }
});

// ─── POST /matcon/quotes ─────────────────────────────────────
router.post('/quotes', async function (req, res) {
  const companyId = req.params.id;
  try {
    const settings = await assertMatconEnabled(companyId);
    const b = req.body || {};

    const norm = normalizarItens(b.items);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const desc = descontoDoOrcamento(b.discount, norm.subtotal);
    if (desc.error) return res.status(400).json({ error: desc.error });

    let validUntil = null;
    if (b.valid_until !== undefined && b.valid_until !== null && b.valid_until !== '') {
      if (!dataValida(b.valid_until)) return res.status(400).json({ error: 'Validade inválida. Use uma data como 2026-10-01.' });
      if (b.valid_until < hojeSP()) return res.status(400).json({ error: 'A validade não pode ser antes de hoje.' });
      validUntil = b.valid_until;
    }
    const validDays = intSetting(settings, 'matcon_quote_valid_days', 7, 1, 365);

    const cliente = await resolverCliente(companyId, b, null);
    const vendedor = await resolverVendedor(companyId, b.seller_id);
    const createdBy = req.user && UUID_RE.test(String(req.user.id || '')) ? req.user.id : null;

    const { rows } = await db.query(
      `INSERT INTO matcon_quotes AS q
         (company_id, status, customer_id, customer_name, customer_phone,
          seller_id, seller_name, valid_until, items, subtotal, discount, total,
          notes, reference, created_by)
       VALUES ($1, 'open', $2, $3, $4, $5,
               COALESCE($6, (SELECT full_name FROM users WHERE id = $14)),
               COALESCE($7::date, ${SP_TODAY} + $8::int),
               $9::jsonb, $10, $11, $12, $13, $15, $14)
       RETURNING ${QUOTE_COLS}`,
      [
        companyId, cliente.customer_id, cliente.customer_name, cliente.customer_phone,
        vendedor.seller_id, vendedor.seller_name,
        validUntil, validDays,
        JSON.stringify(norm.items), norm.subtotal, desc.discount, round2(norm.subtotal - desc.discount),
        textoOuNull(b.notes, 500), createdBy, textoOuNull(b.reference, 200),
      ]
    );
    res.status(201).json({ quote: quoteOut(rows[0]) });
  } catch (err) {
    falhar(res, err, 'POST:quotes');
  }
});

// ─── PATCH /matcon/quotes/:qid ───────────────────────────────
router.patch('/quotes/:qid', async function (req, res) {
  const companyId = req.params.id;
  try {
    const settings = await assertMatconEnabled(companyId);
    const atual = await carregarOrcamento(companyId, req.params.qid);
    if (!atual) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    const b = req.body || {};
    const convertido = !!atual.converted_sale_id;

    const mexeNoDocumento = ['status', 'items', 'discount', 'valid_until'].some((k) => has(b, k));
    if (convertido && mexeNoDocumento) {
      return res.status(409).json({ error: 'Este orçamento já virou pedido. Para mudar, cancele a venda primeiro.' });
    }

    let status = atual.status;
    if (has(b, 'status')) {
      if (!QUOTE_PATCH_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Situação inválida.' });
      status = b.status;
    }

    let items = atual.items;
    let subtotal = Number(atual.subtotal) || 0;
    if (has(b, 'items')) {
      const norm = normalizarItens(b.items);
      if (norm.error) return res.status(400).json({ error: norm.error });
      items = norm.items;
      subtotal = norm.subtotal;
    }
    let discount = Math.min(Number(atual.discount) || 0, subtotal);
    if (has(b, 'discount')) {
      const desc = descontoDoOrcamento(b.discount, subtotal);
      if (desc.error) return res.status(400).json({ error: desc.error });
      discount = desc.discount;
    }

    const hoje = hojeSP();
    let validUntil = atual.valid_until;
    if (has(b, 'valid_until')) {
      if (!dataValida(b.valid_until)) return res.status(400).json({ error: 'Validade inválida. Use uma data como 2026-10-01.' });
      if (b.valid_until < hoje) return res.status(400).json({ error: 'A validade não pode ser antes de hoje.' });
      validUntil = b.valid_until;
    }
    // Reabrir renova a validade vencida (ver cabecalho).
    let renovar = false;
    if (status === 'open' && validUntil < hoje) renovar = true;
    const validDays = intSetting(settings, 'matcon_quote_valid_days', 7, 1, 365);

    const cliente = await resolverCliente(companyId, b, atual);
    const vendedor = has(b, 'seller_id')
      ? await resolverVendedor(companyId, b.seller_id)
      : { seller_id: atual.seller_id, seller_name: atual.seller_name };
    const notes = has(b, 'notes') ? textoOuNull(b.notes, 500) : atual.notes;
    const reference = has(b, 'reference') ? textoOuNull(b.reference, 200) : atual.reference;

    const { rows } = await db.query(
      `UPDATE matcon_quotes q
          SET status = $3::text,
              approved_at = CASE WHEN $3::text = 'approved' THEN COALESCE(q.approved_at, NOW()) ELSE q.approved_at END,
              items = $4::jsonb,
              subtotal = $5,
              discount = $6,
              total = $7,
              valid_until = CASE WHEN $9 THEN ${SP_TODAY} + $10::int ELSE $8::date END,
              customer_id = $11,
              customer_name = $12,
              customer_phone = $13,
              seller_id = $14,
              seller_name = $15,
              notes = $16,
              reference = $17
        WHERE q.id = $1 AND q.company_id = $2
        RETURNING ${QUOTE_COLS}`,
      [
        atual.id, companyId, status, JSON.stringify((items || []).map(itemOut)),
        round2(subtotal), round2(discount), round2(subtotal - discount),
        validUntil, renovar, validDays,
        cliente.customer_id, cliente.customer_name, cliente.customer_phone,
        vendedor.seller_id, vendedor.seller_name, notes, reference,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    res.json({ quote: quoteOut(rows[0]) });
  } catch (err) {
    falhar(res, err, 'PATCH:quote');
  }
});

// ─── POST /matcon/quotes/:qid/sent ───────────────────────────
// So carimba o envio: quem abre o wa.me e o front (useWaVarejo).
router.post('/quotes/:qid/sent', async function (req, res) {
  const companyId = req.params.id;
  try {
    await assertMatconEnabled(companyId);
    if (!UUID_RE.test(String(req.params.qid))) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    const { rows } = await db.query(
      `UPDATE matcon_quotes q SET sent_at = NOW()
        WHERE q.id = $1 AND q.company_id = $2
        RETURNING ${QUOTE_COLS}`,
      [req.params.qid, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    res.json({ quote: quoteOut(rows[0]) });
  } catch (err) {
    falhar(res, err, 'POST:sent');
  }
});

// ─── POST /matcon/quotes/:qid/convert ────────────────────────
router.post('/quotes/:qid/convert', async function (req, res) {
  const companyId = req.params.id;
  try {
    await assertMatconEnabled(companyId);
    if (!UUID_RE.test(String(req.params.qid))) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    // UPDATE condicional: aprova so o que pode virar pedido. Clique duplo
    // e idempotente (approved sem venda continua approved).
    const { rows } = await db.query(
      `UPDATE matcon_quotes q
          SET status = 'approved',
              approved_at = COALESCE(q.approved_at, NOW())
        WHERE q.id = $1 AND q.company_id = $2
          AND q.status <> 'lost'
          AND q.converted_sale_id IS NULL
        RETURNING ${QUOTE_COLS}`,
      [req.params.qid, companyId]
    );
    if (!rows.length) {
      const atual = await carregarOrcamento(companyId, req.params.qid);
      if (!atual) return res.status(404).json({ error: 'Orçamento não encontrado.' });
      if (atual.converted_sale_id) return res.status(409).json({ error: 'Este orçamento já virou pedido.', code: 'QUOTE_ALREADY_CONVERTED' });
      return res.status(409).json({ error: 'Este orçamento está marcado como perdido. Reabra antes de virar pedido.', code: 'QUOTE_LOST' });
    }
    const quote = quoteOut(rows[0]);
    res.json({
      quote,
      cart: quote.items.map((it) => ({
        product_id: it.product_id,
        name: it.name,
        unit: it.unit,
        quantity: it.quantity,
        unit_price: it.unit_price,
      })),
    });
  } catch (err) {
    falhar(res, err, 'POST:convert');
  }
});

// ─── Entregas ────────────────────────────────────────────────
//
// Uma query devolve a entrega pronta pro card: itens com o preco e o
// produto DA VENDA (sale_items), o que ja foi em entregas anteriores e a
// nota da entrega (M2). delivered_before conta so entregas anteriores
// (sequence menor) ja entregues — e o que o card soma com `quantity`
// quando a propria entrega esta delivered.
const DELIVERY_SELECT = `
  SELECT d.id, d.sale_id, s.sale_number, d.sequence, d.stage,
         to_char(d.scheduled_for, 'YYYY-MM-DD') AS scheduled_for,
         d.delivered_by, d.customer_name, d.customer_phone, d.address,
         s.total_amount AS total,
         EXISTS (SELECT 1 FROM matcon_deliveries p
                  WHERE p.sale_id = d.sale_id AND p.cancelled_at IS NULL
                    AND p.stage <> 'delivered') AS has_pending,
         d.public_token, d.out_at, d.delivered_at, d.created_at,
         d.nfe_emission_id, ne.numero AS nfe_number, ne.status AS nfe_status,
         ne.pdf_url AS danfe_url,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'sale_item_id', si.id,
                    'product_id', si.product_id,
                    'unit_price', si.unit_price,
                    'lot_code', NULL,
                    'name', COALESCE(si.product_name_snapshot, pr.name, 'Item'),
                    'unit', pr.unit,
                    'quantity', di.quantity,
                    'sold_quantity', si.quantity,
                    'delivered_before', COALESCE((
                      SELECT SUM(di2.quantity)
                        FROM matcon_delivery_items di2
                        JOIN matcon_deliveries d2 ON d2.id = di2.delivery_id
                       WHERE di2.sale_item_id = si.id
                         AND d2.cancelled_at IS NULL
                         AND d2.stage = 'delivered'
                         AND d2.sequence < d.sequence), 0)
                  ) ORDER BY si.id)
             FROM matcon_delivery_items di
             JOIN sale_items si ON si.id = di.sale_item_id
             LEFT JOIN products pr ON pr.id = si.product_id
            WHERE di.delivery_id = d.id), '[]'::json) AS items
    FROM matcon_deliveries d
    JOIN sales s ON s.id = d.sale_id
    LEFT JOIN nfce_emissions ne ON ne.id = d.nfe_emission_id`;

function deliveryItemOut(it) {
  return {
    sale_item_id: String(it.sale_item_id),
    product_id: it.product_id || null,
    unit_price: Number(it.unit_price) || 0,
    lot_code: it.lot_code || null,
    name: it.name || '',
    unit: it.unit || null,
    quantity: Number(it.quantity) || 0,
    sold_quantity: Number(it.sold_quantity) || 0,
    delivered_before: Number(it.delivered_before) || 0,
  };
}

function deliveryOut(r) {
  return {
    id: r.id,
    sale_id: r.sale_id,
    sale_number: r.sale_number == null ? null : Number(r.sale_number),
    sequence: Number(r.sequence) || 1,
    stage: r.stage,
    scheduled_for: r.scheduled_for,
    delivered_by: r.delivered_by || null,
    customer_name: r.customer_name || null,
    customer_phone: r.customer_phone || null,
    address: r.address || null,
    total: Number(r.total) || 0,
    has_pending: !!r.has_pending,
    public_token: r.public_token,
    items: Array.isArray(r.items) ? r.items.map(deliveryItemOut) : [],
    out_at: r.out_at || null,
    delivered_at: r.delivered_at || null,
    created_at: r.created_at,
    nfe_emission_id: r.nfe_emission_id || null,
    nfe_number: r.nfe_number == null ? null : Number(r.nfe_number),
    nfe_status: r.nfe_status || null,
    danfe_url: r.danfe_url || null,
  };
}

async function carregarEntregas(q, companyId, ids) {
  if (!ids.length) return [];
  const { rows } = await q.query(
    `${DELIVERY_SELECT}
      WHERE d.company_id = $1 AND d.id = ANY($2::uuid[])`,
    [companyId, ids]
  );
  const porId = new Map(rows.map((r) => [String(r.id), deliveryOut(r)]));
  return ids.map((id) => porId.get(String(id)) || null);
}

// ─── GET /matcon/deliveries ──────────────────────────────────
router.get('/deliveries', async function (req, res) {
  const companyId = req.params.id;
  try {
    const day = String(req.query.day || '').trim();
    const stage = String(req.query.stage || '').trim();
    if (day && day !== 'all' && !DAYS.includes(day)) return res.status(400).json({ error: 'Filtro de dia inválido.' });
    if (stage && stage !== 'all' && !STAGES.includes(stage)) return res.status(400).json({ error: 'Filtro de etapa inválido.' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);

    const cond = [
      'd.company_id = $1',
      'd.cancelled_at IS NULL',
      "COALESCE(s.status, 'completed') <> 'cancelled'",
    ];
    const vals = [companyId];
    if (day === 'today') cond.push(`d.scheduled_for = ${SP_TODAY}`);
    else if (day === 'tomorrow') cond.push(`d.scheduled_for = ${SP_TODAY} + 1`);
    else if (day === 'late') cond.push(`d.scheduled_for < ${SP_TODAY} AND d.stage <> 'delivered'`);
    // A entregar: toda entrega aberta, de qualquer data (ver DECISOES).
    else if (day === 'pending') cond.push("d.stage <> 'delivered'");
    if (stage && stage !== 'all') {
      vals.push(stage);
      cond.push(`d.stage = $${vals.length}`);
    }
    vals.push(limit);

    const { rows } = await db.query(
      `${DELIVERY_SELECT}
        WHERE ${cond.join(' AND ')}
        ORDER BY d.scheduled_for ASC, s.sale_number ASC NULLS LAST, d.sequence ASC
        LIMIT $${vals.length}`,
      vals
    );

    const { rows: sum } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE d.stage = 'separating')::int AS separating_count,
         COALESCE(SUM(s.total_amount) FILTER (WHERE d.stage = 'separating'), 0) AS separating_total,
         COUNT(*) FILTER (WHERE d.stage = 'ready')::int AS ready_count,
         COALESCE(SUM(s.total_amount) FILTER (WHERE d.stage = 'ready'), 0) AS ready_total,
         COUNT(*) FILTER (WHERE d.stage = 'out')::int AS out_count,
         COALESCE(SUM(s.total_amount) FILTER (WHERE d.stage = 'out'), 0) AS out_total,
         COUNT(*) FILTER (WHERE d.stage = 'delivered'
           AND (d.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date = ${SP_TODAY})::int AS delivered_today_count,
         COALESCE(SUM(s.total_amount) FILTER (WHERE d.stage = 'delivered'
           AND (d.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date = ${SP_TODAY}), 0) AS delivered_today_total,
         COUNT(DISTINCT d.sale_id) FILTER (WHERE d.stage <> 'delivered')::int AS pending_orders
       FROM matcon_deliveries d
       JOIN sales s ON s.id = d.sale_id
      WHERE d.company_id = $1 AND d.cancelled_at IS NULL
        AND COALESCE(s.status, 'completed') <> 'cancelled'`,
      [companyId]
    );
    const s = sum[0] || {};
    const par = (k) => ({ count: Number(s[`${k}_count`]) || 0, total: round2(Number(s[`${k}_total`]) || 0) });

    res.json({
      deliveries: rows.map(deliveryOut),
      summary: {
        separating: par('separating'),
        ready: par('ready'),
        out: par('out'),
        delivered_today: par('delivered_today'),
        pending_orders: Number(s.pending_orders) || 0,
      },
    });
  } catch (err) {
    falhar(res, err, 'GET:deliveries');
  }
});

// ─── POST /matcon/deliveries ─────────────────────────────────
// 1a entrega de uma venda avulsa do Caixa (a venda com quote_id ja cria
// a sua sozinha). Um pedido tem UMA entrega aberta de cada vez: as
// seguintes nascem do split.
router.post('/deliveries', async function (req, res) {
  const companyId = req.params.id;
  const b = req.body || {};
  let client = null;
  try {
    const settings = await assertMatconEnabled(companyId);
    const saleId = String(b.sale_id || '');
    if (!UUID_RE.test(saleId)) return res.status(400).json({ error: 'Informe a venda da entrega.' });
    let scheduledFor = null;
    if (b.scheduled_for !== undefined && b.scheduled_for !== null && b.scheduled_for !== '') {
      if (!dataValida(b.scheduled_for)) return res.status(400).json({ error: 'Data de entrega inválida. Use uma data como 2026-10-01.' });
      if (b.scheduled_for < hojeSP()) return res.status(400).json({ error: 'A data da entrega não pode ser antes de hoje.' });
      scheduledFor = b.scheduled_for;
    }

    client = await db.connect();
    await client.query('BEGIN');
    const { rows: sales } = await client.query(
      `SELECT id, status, customer_id FROM sales
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [saleId, companyId]
    );
    if (!sales.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Venda não encontrada nesta loja.' });
    }
    if (sales[0].status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta venda foi cancelada.' });
    }
    const { rows: existentes } = await client.query(
      'SELECT id FROM matcon_deliveries WHERE sale_id = $1 AND cancelled_at IS NULL LIMIT 1',
      [saleId]
    );
    if (existentes.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este pedido já tem entrega. Ela está na tela de Entregas.' });
    }

    const nova = await createFirstDelivery(client, {
      companyId,
      saleId,
      customerId: sales[0].customer_id || null,
      userId: req.user && UUID_RE.test(String(req.user.id || '')) ? req.user.id : null,
      scheduledFor,
      deliveryDays: diasDeEntrega(settings),
    });
    await client.query('COMMIT');
    client.release();
    client = null;

    const [delivery] = await carregarEntregas(db, companyId, [nova.id]);
    res.status(201).json({ delivery });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    falhar(res, err, 'POST:deliveries');
  } finally {
    if (client) client.release();
  }
});

// ─── PATCH /matcon/deliveries/:did ───────────────────────────
router.patch('/deliveries/:did', async function (req, res) {
  const companyId = req.params.id;
  try {
    await assertMatconEnabled(companyId);
    if (!UUID_RE.test(String(req.params.did))) return res.status(404).json({ error: 'Entrega não encontrada.' });
    const b = req.body || {};
    const sets = [];
    const vals = [req.params.did, companyId];

    if (has(b, 'stage')) {
      if (!STAGES.includes(b.stage)) return res.status(400).json({ error: 'Etapa inválida.' });
      vals.push(b.stage);
      const p = `$${vals.length}::text`;
      sets.push(`stage = ${p}`);
      // Saiu: carimba a primeira saida. Entregue: carimba a entrega; voltar
      // de "entregue" pra outra etapa limpa o carimbo.
      sets.push(`out_at = CASE WHEN ${p} IN ('out', 'delivered') THEN COALESCE(out_at, NOW()) ELSE out_at END`);
      sets.push(`delivered_at = CASE WHEN ${p} = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE NULL END`);
    }
    if (has(b, 'delivered_by')) {
      vals.push(textoOuNull(b.delivered_by, 120));
      sets.push(`delivered_by = $${vals.length}`);
    }
    if (has(b, 'scheduled_for')) {
      if (!dataValida(b.scheduled_for)) return res.status(400).json({ error: 'Data de entrega inválida. Use uma data como 2026-10-01.' });
      if (b.scheduled_for < hojeSP()) return res.status(400).json({ error: 'A data da entrega não pode ser antes de hoje.' });
      vals.push(b.scheduled_for);
      sets.push(`scheduled_for = $${vals.length}::date`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar.' });

    const { rows } = await db.query(
      `UPDATE matcon_deliveries SET ${sets.join(', ')}
        WHERE id = $1 AND company_id = $2 AND cancelled_at IS NULL
        RETURNING id`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Entrega não encontrada.' });
    const [delivery] = await carregarEntregas(db, companyId, [rows[0].id]);
    res.json({ delivery });
  } catch (err) {
    falhar(res, err, 'PATCH:delivery');
  }
});

// ─── POST /matcon/deliveries/:did/split ──────────────────────
router.post('/deliveries/:did/split', async function (req, res) {
  const companyId = req.params.id;
  const deliveryId = String(req.params.did);
  const b = req.body || {};
  let client = null;
  try {
    const settings = await assertMatconEnabled(companyId);
    if (!UUID_RE.test(deliveryId)) return res.status(404).json({ error: 'Entrega não encontrada.' });
    if (!Array.isArray(b.items) || !b.items.length) {
      return res.status(400).json({ error: 'Informe quanto foi entregue de pelo menos um item.' });
    }
    const pedido = new Map();
    for (const it of b.items) {
      const sid = String((it && it.sale_item_id) || '');
      const qtd = round3(Number(it && it.quantity));
      if (!UUID_RE.test(sid)) return res.status(400).json({ error: 'Um dos itens não é deste pedido.' });
      if (!Number.isFinite(qtd) || qtd < 0) return res.status(400).json({ error: 'Quantidade inválida.' });
      pedido.set(sid, round3((pedido.get(sid) || 0) + qtd));
    }

    client = await db.connect();
    await client.query('BEGIN');
    const { rows: ds } = await client.query(
      `SELECT id, sale_id, stage, customer_name, customer_phone, address
         FROM matcon_deliveries
        WHERE id = $1 AND company_id = $2 AND cancelled_at IS NULL
        FOR UPDATE`,
      [deliveryId, companyId]
    );
    if (!ds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Entrega não encontrada.' });
    }
    const atual = ds[0];
    if (atual.stage === 'delivered') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta entrega já foi registrada como entregue.' });
    }
    // Trava as outras entregas do pedido: dois splits ao mesmo tempo no
    // mesmo pedido fariam a conta do saldo com numeros velhos.
    await client.query(
      'SELECT id FROM matcon_deliveries WHERE sale_id = $1 FOR UPDATE',
      [atual.sale_id]
    );

    const { rows: itens } = await client.query(
      `SELECT si.id AS sale_item_id,
              COALESCE(si.product_name_snapshot, pr.name, 'Item') AS name,
              si.quantity AS sold,
              COALESCE((SELECT SUM(di.quantity)
                          FROM matcon_delivery_items di
                          JOIN matcon_deliveries x ON x.id = di.delivery_id
                         WHERE di.sale_item_id = si.id AND x.cancelled_at IS NULL
                           AND x.stage = 'delivered'), 0) AS delivered,
              COALESCE((SELECT SUM(di.quantity)
                          FROM matcon_delivery_items di
                          JOIN matcon_deliveries x ON x.id = di.delivery_id
                         WHERE di.sale_item_id = si.id AND x.cancelled_at IS NULL
                           AND x.stage <> 'delivered' AND x.id <> $2), 0) AS planned_elsewhere
         FROM matcon_delivery_items mi
         JOIN sale_items si ON si.id = mi.sale_item_id
         LEFT JOIN products pr ON pr.id = si.product_id
        WHERE mi.delivery_id = $2 AND si.sale_id = $1`,
      [atual.sale_id, deliveryId]
    );
    const porItem = new Map(itens.map((r) => [String(r.sale_item_id), r]));

    let totalAgora = 0;
    for (const [sid, qtd] of pedido) {
      const r = porItem.get(sid);
      if (!r) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Um dos itens não faz parte desta entrega.' });
      }
      const max = round3(Number(r.sold) - Number(r.delivered) - Number(r.planned_elsewhere));
      if (qtd > max + 1e-9) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `"${r.name}": o máximo que ainda falta entregar é ${String(Math.max(0, max)).replace('.', ',')}.` });
      }
      totalAgora += qtd;
    }
    if (totalAgora <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Informe quanto foi entregue de pelo menos um item.' });
    }

    // O que foi nesta viagem (item fora do pedido = 0) e o saldo de cada item.
    const sids = [];
    const foi = [];
    const saldoSids = [];
    const saldoQtds = [];
    for (const r of itens) {
      const sid = String(r.sale_item_id);
      const q = pedido.get(sid) || 0;
      sids.push(sid);
      foi.push(q);
      const resto = round3(Number(r.sold) - Number(r.delivered) - Number(r.planned_elsewhere) - q);
      if (resto > 0.0005) {
        saldoSids.push(sid);
        saldoQtds.push(resto);
      }
    }

    await client.query(
      `UPDATE matcon_delivery_items di
          SET quantity = v.q
         FROM unnest($2::uuid[], $3::numeric[]) AS v(sid, q)
        WHERE di.delivery_id = $1 AND di.sale_item_id = v.sid`,
      [deliveryId, sids, foi]
    );
    const quemEntregou = has(b, 'delivered_by') ? textoOuNull(b.delivered_by, 120) : null;
    await client.query(
      `UPDATE matcon_deliveries
          SET stage = 'delivered',
              delivered_at = NOW(),
              out_at = COALESCE(out_at, NOW()),
              delivered_by = COALESCE($2, delivered_by)
        WHERE id = $1`,
      [deliveryId, quemEntregou]
    );

    let nextId = null;
    if (saldoSids.length) {
      const { rows: nx } = await client.query(
        `INSERT INTO matcon_deliveries
           (company_id, sale_id, sequence, stage, scheduled_for,
            customer_name, customer_phone, address, created_by)
         VALUES ($1, $2,
                 (SELECT COALESCE(MAX(sequence), 0) + 1 FROM matcon_deliveries WHERE sale_id = $2),
                 'separating', ${SP_TODAY} + $3::int, $4, $5, $6, $7)
         RETURNING id`,
        [
          companyId, atual.sale_id, diasDeEntrega(settings),
          atual.customer_name, atual.customer_phone, atual.address,
          req.user && UUID_RE.test(String(req.user.id || '')) ? req.user.id : null,
        ]
      );
      nextId = nx[0].id;
      await client.query(
        `INSERT INTO matcon_delivery_items (delivery_id, sale_item_id, quantity)
         SELECT $1, v.sid, v.q FROM unnest($2::uuid[], $3::numeric[]) AS v(sid, q)`,
        [nextId, saldoSids, saldoQtds]
      );
    }
    await client.query('COMMIT');
    client.release();
    client = null;

    const [delivered, next] = await carregarEntregas(db, companyId, nextId ? [deliveryId, nextId] : [deliveryId]);
    res.json({ delivered, next: next || null });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    falhar(res, err, 'POST:split');
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
module.exports.assertMatconEnabled = assertMatconEnabled;
module.exports.normalizarItens = normalizarItens;
module.exports.quoteOut = quoteOut;
module.exports.deliveryOut = deliveryOut;
