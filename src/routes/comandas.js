// ============================================================
// AURA. — Comandas do Caixa (migration 368)
//
// Montado em private.js sob /comandas (o /companies/:id e o
// requireCompanyAccess vem de la).
//
// GET    /comandas                      → {comandas} (so as abertas, com total)
// GET    /comandas/:number              → {comanda} (a ABERTA com esse numero)
// POST   /comandas/:number/items        → 201 {comanda} (abre se nao existir)
// DELETE /comandas/:number/items/:iid   → {comanda}
// POST   /comandas/:number/cancel       → {ok}
//
// A comanda e identificada pelo NUMERO que a loja usa no cartao — e o que o
// operador digita. Fechar NAO passa por aqui: o Caixa cobra o consumo como
// uma venda (POST /pdv/sale com comanda_id) e o gancho
// services/comandaSaleHooks.js fecha a comanda na transacao da venda.
//
// GATE: comanda_enabled em companies.pdv_settings, lido do BANCO (o JWT nunca
// revalida) e so na ESCRITA — desligar a chave com comandas abertas nao pode
// esconder da loja o que ela ainda tem a cobrar (mesma regra do Matcon e do
// historico de caixa).
//
// Sem baixa de estoque aqui: e na venda. Preco e nome ficam congelados no
// lancamento (o cliente consumiu pelo preco daquela hora).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS_PER_CALL = 100;

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

function erro(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  // Migration 368 ainda nao aplicada (deploy parcial).
  if (err && (err.code === '42P01' || err.code === '42703')) {
    return res.status(503).json({ error: 'As comandas ainda não estão disponíveis. Tente de novo em instantes.', code: 'COMANDA_UNAVAILABLE' });
  }
  console.error(`[comandas:${contexto}]`, err && err.message);
  return res.status(500).json({ error: 'Não deu para concluir agora. Tente de novo em instantes.' });
}

async function assertComandaEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'comanda_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) throw erro(404, 'Empresa não encontrada');
  if (rows[0].enabled !== 'true') {
    throw erro(403, 'Ligue "Comandas" em Configurações › Caixa para usar comandas.', 'COMANDA_DISABLED');
  }
}

// "12", " 012 " → 12. Fora de 1..9999 → null.
function numeroDaComanda(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 && n <= 9999 ? n : null;
}

// Valida e normaliza os itens lancados. product_id que nao e uuid vira null
// (o Caixa usa chaves proprias para item sem cadastro).
function normalizarItens(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Adicione pelo menos um produto antes de mandar para a comanda.' };
  }
  if (raw.length > MAX_ITEMS_PER_CALL) return { error: `Mande até ${MAX_ITEMS_PER_CALL} itens por vez.` };
  const items = [];
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
    const pid = it.product_id ? String(it.product_id) : null;
    const vid = it.variant_id ? String(it.variant_id) : null;
    const unit = it.unit == null ? null : String(it.unit).trim().slice(0, 12) || null;
    items.push({
      product_id: pid && UUID_RE.test(pid) ? pid : null,
      variant_id: vid && UUID_RE.test(vid) ? vid : null,
      name, unit, quantity, unit_price: unitPrice,
    });
  }
  return { items };
}

function itemOut(r) {
  const quantity = Number(r.quantity) || 0;
  const unitPrice = Number(r.unit_price) || 0;
  return {
    id: r.id,
    product_id: r.product_id || null,
    variant_id: r.variant_id || null,
    name: r.name || '',
    unit: r.unit || null,
    quantity,
    unit_price: unitPrice,
    total: round2(quantity * unitPrice),
    created_at: r.created_at,
  };
}

function comandaOut(c, itens) {
  const items = (itens || []).map(itemOut);
  return {
    id: c.id,
    number: Number(c.number),
    status: c.status,
    opened_at: c.opened_at,
    items,
    items_count: items.length,
    subtotal: round2(items.reduce((s, it) => s + it.total, 0)),
  };
}

async function carregarAberta(q, companyId, number) {
  const { rows } = await q.query(
    `SELECT id, number, status, opened_at FROM pdv_comandas
      WHERE company_id = $1 AND number = $2 AND status = 'open'`,
    [companyId, number]
  );
  if (!rows.length) return null;
  const { rows: itens } = await q.query(
    `SELECT id, product_id, variant_id, name, unit, quantity, unit_price, created_at
       FROM pdv_comanda_items
      WHERE comanda_id = $1
      ORDER BY seq ASC`,
    [rows[0].id]
  );
  return comandaOut(rows[0], itens);
}

// ─── GET /comandas ───────────────────────────────────────────
router.get('/', async function (req, res) {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.number, c.status, c.opened_at,
              COUNT(i.id)::int AS items_count,
              COALESCE(SUM(i.quantity * i.unit_price), 0) AS subtotal
         FROM pdv_comandas c
         LEFT JOIN pdv_comanda_items i ON i.comanda_id = c.id
        WHERE c.company_id = $1 AND c.status = 'open'
        GROUP BY c.id
        ORDER BY c.number ASC
        LIMIT 500`,
      [req.params.id]
    );
    res.json({
      comandas: rows.map((r) => ({
        id: r.id,
        number: Number(r.number),
        status: r.status,
        opened_at: r.opened_at,
        items_count: Number(r.items_count) || 0,
        subtotal: round2(Number(r.subtotal) || 0),
      })),
    });
  } catch (err) {
    // Sem a 368 a lista e vazia: a tela de quem nunca usou comanda nao quebra.
    if (err && (err.code === '42P01' || err.code === '42703')) return res.json({ comandas: [] });
    falhar(res, err, 'GET:lista');
  }
});

// ─── GET /comandas/:number ───────────────────────────────────
router.get('/:number', async function (req, res) {
  try {
    const number = numeroDaComanda(req.params.number);
    if (!number) return res.status(400).json({ error: 'Informe o número da comanda (1 a 9999).', code: 'COMANDA_NUMBER_INVALID' });
    const comanda = await carregarAberta(db, req.params.id, number);
    if (!comanda) return res.status(404).json({ error: `Não há comanda ${number} aberta.`, code: 'COMANDA_NOT_FOUND' });
    res.json({ comanda });
  } catch (err) {
    falhar(res, err, 'GET:comanda');
  }
});

// ─── POST /comandas/:number/items ────────────────────────────
// Lanca consumo. Abre a comanda se o numero ainda nao estiver aberto.
router.post('/:number/items', async function (req, res) {
  const companyId = req.params.id;
  let client = null;
  try {
    await assertComandaEnabled(companyId);
    const number = numeroDaComanda(req.params.number);
    if (!number) return res.status(400).json({ error: 'Informe o número da comanda (1 a 9999).', code: 'COMANDA_NUMBER_INVALID' });
    const norm = normalizarItens((req.body || {}).items);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const userId = req.user && UUID_RE.test(String(req.user.id || '')) ? req.user.id : null;

    client = await db.connect();
    await client.query('BEGIN');
    // Abre ou reaproveita a aberta. O DO UPDATE trava a linha: dois caixas
    // lancando na mesma comanda ao mesmo tempo caem na MESMA comanda.
    const { rows } = await client.query(
      `INSERT INTO pdv_comandas (company_id, number, opened_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, number) WHERE status = 'open'
       DO UPDATE SET updated_at = NOW()
       RETURNING id, (xmax = 0) AS criada`,
      [companyId, number, userId]
    );
    const comandaId = rows[0].id;
    for (const it of norm.items) {
      await client.query(
        `INSERT INTO pdv_comanda_items
           (comanda_id, company_id, product_id, variant_id, name, unit, quantity, unit_price, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [comandaId, companyId, it.product_id, it.variant_id, it.name, it.unit, it.quantity, it.unit_price, userId]
      );
    }
    const comanda = await carregarAberta(client, companyId, number);
    await client.query('COMMIT');
    client.release();
    client = null;
    res.status(201).json({ comanda, opened: !!rows[0].criada, added: norm.items.length });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    falhar(res, err, 'POST:items');
  } finally {
    if (client) client.release();
  }
});

// ─── DELETE /comandas/:number/items/:iid ─────────────────────
// Tira um lancamento feito por engano. So da comanda ABERTA.
router.delete('/:number/items/:iid', async function (req, res) {
  const companyId = req.params.id;
  try {
    await assertComandaEnabled(companyId);
    const number = numeroDaComanda(req.params.number);
    if (!number || !UUID_RE.test(String(req.params.iid))) {
      return res.status(404).json({ error: 'Item não encontrado nesta comanda.' });
    }
    const { rowCount } = await db.query(
      `DELETE FROM pdv_comanda_items i
        USING pdv_comandas c
        WHERE i.id = $1 AND i.comanda_id = c.id
          AND c.company_id = $2 AND c.number = $3 AND c.status = 'open'`,
      [req.params.iid, companyId, number]
    );
    if (!rowCount) return res.status(404).json({ error: 'Item não encontrado nesta comanda.' });
    const comanda = await carregarAberta(db, companyId, number);
    res.json({ comanda });
  } catch (err) {
    falhar(res, err, 'DELETE:item');
  }
});

// ─── POST /comandas/:number/cancel ───────────────────────────
// Comanda aberta por engano (numero errado). O consumo lancado e descartado;
// nada foi baixado do estoque, entao nao ha o que devolver.
router.post('/:number/cancel', async function (req, res) {
  const companyId = req.params.id;
  try {
    await assertComandaEnabled(companyId);
    const number = numeroDaComanda(req.params.number);
    if (!number) return res.status(400).json({ error: 'Informe o número da comanda (1 a 9999).', code: 'COMANDA_NUMBER_INVALID' });
    const { rows } = await db.query(
      `UPDATE pdv_comandas SET status = 'cancelled', closed_at = NOW()
        WHERE company_id = $1 AND number = $2 AND status = 'open'
        RETURNING id`,
      [companyId, number]
    );
    if (!rows.length) return res.status(404).json({ error: `Não há comanda ${number} aberta.`, code: 'COMANDA_NOT_FOUND' });
    res.json({ ok: true, number });
  } catch (err) {
    falhar(res, err, 'POST:cancel');
  }
});

module.exports = router;
module.exports.numeroDaComanda = numeroDaComanda;
module.exports.normalizarItens = normalizarItens;
