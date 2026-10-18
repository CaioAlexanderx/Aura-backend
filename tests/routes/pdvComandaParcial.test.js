// ============================================================
// AURA. -- Testes: comanda com fechamento parcial (card tc-04, migration 392)
//
// O que estes testes travam (criterio de pronto da Nina, 17/10/2026):
//   1. comanda 12 com 4 itens, "dividir por 3": UMA venda com 3 pagamentos
//      que somam o total; a comanda fecha
//   2. "cobrar 2 itens": a venda leva so esses itens; a comanda segue aberta
//      com os outros 2 (GET devolve so os pendentes, parcial: true e o ja
//      cobrado); cobrar os 2 que faltam fecha a comanda
//   3. cancelar a venda daquela parte devolve os itens a comanda (e reabre se
//      ela estava fechada; numero ja reaberto -> 'cancelled', regra da 368)
//   4. o mesmo item cobrado duas vezes: 409, a segunda venda nao fica gravada
//   5. sem comanda_item_ids: igual a hoje (todos os pendentes, comanda fecha)
//   6. linha cobrada em parte (2 de 4 Heineken) e dividida
//   7. item cobrado nao sai pelo DELETE da comanda
//   8. sem a 392 (deploy antes da migration): comanda inteira fecha como
//      hoje; cobranca parcial e 409 COMANDA_PARCIAL_UNAVAILABLE
//
// Banco de mentira em memoria: cada transacao tira uma foto do estado no
// BEGIN e volta a ela no ROLLBACK. Mock por CONTEUDO do SQL.
// O mesmo fluxo no Postgres de verdade fica em
// __tests__/caixa.comandas.banco.test.js (caso 7).
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const pdvRouter = require('../../src/routes/pdv');
const comandasRouter = require('../../src/routes/comandas');
const comandaSaleHooks = require('../../src/services/comandaSaleHooks');
const vendaIdempotente = require('../../src/services/vendaIdempotente');

let db;
beforeAll(() => { db = require('../../src/config/database'); });

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const comandaId = 'cccccccc-1111-4222-8333-444444444444';
const outraComanda = 'cccccccc-1111-4222-8333-555555555555';
const I = {
  heineken: 'a0000000-0000-4000-8000-000000000001',
  fritas: 'a0000000-0000-4000-8000-000000000002',
  caipirinha: 'a0000000-0000-4000-8000-000000000003',
  agua: 'a0000000-0000-4000-8000-000000000004',
};
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
const scoped = express.Router({ mergeParams: true });
scoped.use(requireAuth);
scoped.use(requireCompanyAccess());
scoped.use('/pdv', pdvRouter);
scoped.use('/comandas', comandasRouter);
app.use('/api/v1/companies/:id', scoped);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));

const clone = (x) => JSON.parse(JSON.stringify(x));

// ── Banco de mentira ─────────────────────────────────────────
function fakeDb({ itemVenda = true } = {}) {
  let banco = {
    sales: [],
    saleItems: [],
    salePayments: [],
    comandas: [{ id: comandaId, company_id: cid, number: 12, name: 'João', status: 'open', opened_at: '2026-10-17T20:00:00Z', sale_id: null, service_fee_pct: 0 }],
    items: [
      { id: I.heineken, seq: 1, comanda_id: comandaId, company_id: cid, name: 'Heineken 600 ml', quantity: '4', unit_price: '14', sale_id: null },
      { id: I.fritas, seq: 2, comanda_id: comandaId, company_id: cid, name: 'Porção de fritas', quantity: '1', unit_price: '38', sale_id: null },
      { id: I.caipirinha, seq: 3, comanda_id: comandaId, company_id: cid, name: 'Caipirinha', quantity: '3', unit_price: '18', sale_id: null },
      { id: I.agua, seq: 4, comanda_id: comandaId, company_id: cid, name: 'Água', quantity: '2', unit_price: '6', sale_id: null },
    ],
    seq: 0,
    itemSeq: 100,
  };
  const ref = { get: () => banco };

  const comanda = (id) => banco.comandas.find((c) => c.id === id);
  const item = (id) => banco.items.find((i) => i.id === id);

  // Respostas comuns (transacao ou nao).
  function responder(s, params) {
    if (/to_regclass\('public\.pdv_comandas'\)/.test(s)) return { rows: [{ ok: true }] };
    if (/information_schema\.columns/.test(s) && /pdv_comanda_items/.test(s)) return { rows: [{ item_venda: itemVenda }] };
    if (/pg_attribute/.test(s)) return { rows: [{ ok: false }] }; // sem a coluna name (389): nao importa aqui
    if (/pdv_settings->>'comanda_enabled'/.test(s)) return { rows: [{ enabled: 'true' }] };

    // ── ganchos da venda ──
    if (/FROM pdv_comandas\s+WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/.test(s)) {
      const c = comanda(params[0]);
      return { rows: c && c.company_id === params[1] ? [{ id: c.id, number: c.number, status: c.status }] : [] };
    }
    if (/SELECT id, quantity FROM pdv_comanda_items\s+WHERE comanda_id = \$1 AND sale_id IS NULL/.test(s)) {
      return { rows: banco.items.filter((i) => i.comanda_id === params[0] && !i.sale_id).sort((a, b) => a.seq - b.seq).map((i) => ({ id: i.id, quantity: i.quantity })) };
    }
    if (/^SELECT id, quantity FROM pdv_comanda_items WHERE comanda_id = \$1$/.test(s)) {
      return { rows: banco.items.filter((i) => i.comanda_id === params[0]).map((i) => ({ id: i.id, quantity: i.quantity })) };
    }
    if (/UPDATE pdv_comanda_items SET sale_id = \$1 WHERE comanda_id = \$2 AND sale_id IS NULL/.test(s)) {
      banco.items.filter((i) => i.comanda_id === params[1] && !i.sale_id).forEach((i) => { i.sale_id = params[0]; });
      return { rows: [] };
    }
    if (/SELECT id FROM pdv_comanda_items\s+WHERE comanda_id = \$1 AND id = ANY/.test(s)) {
      return { rows: banco.items.filter((i) => i.comanda_id === params[0] && params[1].includes(i.id) && i.sale_id).map((i) => ({ id: i.id })) };
    }
    if (/UPDATE pdv_comanda_items SET sale_id = \$1 WHERE id = \$2/.test(s)) {
      item(params[1]).sale_id = params[0];
      return { rows: [] };
    }
    if (/UPDATE pdv_comanda_items SET quantity = \$1 WHERE id = \$2/.test(s)) {
      item(params[1]).quantity = String(params[0]);
      return { rows: [] };
    }
    if (/INSERT INTO pdv_comanda_items[\s\S]*SELECT/.test(s)) {
      const o = item(params[2]);
      banco.itemSeq += 1;
      banco.items.push({ ...o, id: `b0000000-0000-4000-8000-${String(banco.itemSeq).padStart(12, '0')}`, seq: banco.itemSeq, quantity: String(params[0]), sale_id: params[1] });
      return { rows: [] };
    }
    if (/UPDATE pdv_comandas\s+SET status = 'closed'/.test(s)) {
      Object.assign(comanda(params[2]), { status: 'closed', sale_id: params[0], service_fee_pct: params[1] });
      return { rows: [] };
    }
    if (/UPDATE sales SET comanda_id/.test(s)) {
      const v = banco.sales.find((x) => x.id === params[1]);
      if (v) v.comanda_id = params[0];
      return { rows: [] };
    }
    // cancelamento
    if (/SELECT id, number, status FROM pdv_comandas\s+WHERE company_id = \$2\s+AND \(sale_id = \$1 OR id IN/.test(s)) {
      const ids = new Set(banco.items.filter((i) => i.sale_id === params[0]).map((i) => i.comanda_id));
      return { rows: banco.comandas.filter((c) => c.company_id === params[1] && (c.sale_id === params[0] || ids.has(c.id))).map((c) => ({ id: c.id, number: c.number, status: c.status })) };
    }
    if (/SELECT id, number, status FROM pdv_comandas\s+WHERE sale_id = \$1 AND company_id = \$2 AND status = 'closed'/.test(s)) {
      return { rows: banco.comandas.filter((c) => c.sale_id === params[0] && c.status === 'closed').map((c) => ({ id: c.id, number: c.number, status: c.status })) };
    }
    if (/UPDATE pdv_comanda_items SET sale_id = NULL WHERE sale_id = \$1/.test(s)) {
      banco.items.filter((i) => i.sale_id === params[0]).forEach((i) => { i.sale_id = null; });
      return { rows: [] };
    }
    if (/SELECT 1 FROM pdv_comandas\s+WHERE company_id = \$1 AND number = \$2 AND status = 'open' AND id <> \$3/.test(s)) {
      return { rows: banco.comandas.filter((c) => c.number === params[1] && c.status === 'open' && c.id !== params[2]).map(() => ({ '?column?': 1 })) };
    }
    if (/UPDATE pdv_comandas SET status = 'cancelled', sale_id = NULL WHERE id = \$1/.test(s)) {
      Object.assign(comanda(params[0]), { status: 'cancelled', sale_id: null });
      return { rows: [] };
    }
    if (/UPDATE pdv_comandas SET status = 'open'/.test(s)) {
      Object.assign(comanda(params[0]), { status: 'open', sale_id: null, service_fee_pct: 0 });
      return { rows: [] };
    }

    // ── rotas das comandas ──
    if (/FROM pdv_comandas\s+WHERE company_id = \$1 AND number = \$2 AND status = 'open'/.test(s)) {
      const c = banco.comandas.find((x) => x.company_id === params[0] && x.number === params[1] && x.status === 'open');
      return { rows: c ? [{ id: c.id, number: c.number, status: c.status, opened_at: c.opened_at }] : [] };
    }
    if (/FROM pdv_comanda_items\s+WHERE comanda_id = \$1( AND sale_id IS NULL)?\s+ORDER BY seq/.test(s)) {
      const soPendentes = /sale_id IS NULL/.test(s);
      return { rows: banco.items.filter((i) => i.comanda_id === params[0] && (!soPendentes || !i.sale_id)).sort((a, b) => a.seq - b.seq) };
    }
    if (/COUNT\(\*\)::int AS count[\s\S]*sale_id IS NOT NULL/.test(s)) {
      const pagos = banco.items.filter((i) => i.comanda_id === params[0] && i.sale_id);
      return { rows: [{ count: pagos.length, subtotal: String(pagos.reduce((t, i) => t + Number(i.quantity) * Number(i.unit_price), 0)) }] };
    }
    if (/FROM pdv_comandas c\s+LEFT JOIN pdv_comanda_items i/.test(s)) {
      const comFiltro = /FILTER/.test(s);
      return {
        rows: banco.comandas.filter((c) => c.company_id === params[0] && c.status === 'open').map((c) => {
          const its = banco.items.filter((i) => i.comanda_id === c.id);
          const pend = comFiltro ? its.filter((i) => !i.sale_id) : its;
          const pagos = its.filter((i) => i.sale_id);
          const soma = (l) => String(l.reduce((t, i) => t + Number(i.quantity) * Number(i.unit_price), 0));
          return {
            id: c.id, number: c.number, status: c.status, opened_at: c.opened_at,
            items_count: pend.length, subtotal: soma(pend),
            ...(comFiltro ? { paid_count: pagos.length, paid_subtotal: soma(pagos) } : {}),
          };
        }),
      };
    }
    if (/DELETE FROM pdv_comanda_items i/.test(s)) {
      const it = banco.items.find((i) => i.id === params[0]);
      const c = it && comanda(it.comanda_id);
      const ok = it && c.company_id === params[1] && c.number === params[2] && c.status === 'open'
        && (!/sale_id IS NULL/.test(s) || !it.sale_id);
      if (ok) banco.items = banco.items.filter((i) => i !== it);
      return { rows: [], rowCount: ok ? 1 : 0 };
    }

    // ── venda (o minimo do handleSale) ──
    if (/SELECT pdv_settings FROM companies/i.test(s)) return { rows: [{ pdv_settings: {} }] };
    if (/FROM caixa_sessoes/i.test(s)) return { rows: [] };
    if (/INSERT INTO sales/i.test(s)) {
      banco.seq += 1;
      const row = {
        id: `5a1e0000-0000-4000-8000-${String(banco.seq).padStart(12, '0')}`, sale_number: banco.seq, company_id: params[0],
        total_amount: String(params[5]), discount_amount: String(params[6]), payment_method: params[7],
        status: 'completed', customer_id: null, employee_id: null, coupon_id: null,
      };
      banco.sales.push(row);
      return { rows: [{ ...row }] };
    }
    if (/INSERT INTO sale_items/i.test(s)) {
      banco.saleItems.push({ sale_id: params[0], quantity: String(params[3]), unit_price: String(params[4]) });
      return { rows: [] };
    }
    if (/INSERT INTO sale_payments/i.test(s)) {
      banco.salePayments.push({ sale_id: params[0], method: params[2], amount: Number(params[3]) });
      return { rows: [] };
    }
    if (/FROM sales WHERE id=\$1 AND company_id=\$2/.test(s)) {
      const v = banco.sales.find((x) => x.id === params[0] && x.company_id === params[1]);
      return { rows: v ? [{ ...v }] : [] };
    }
    if (/UPDATE sales SET status='cancelled'/.test(s)) {
      banco.sales.find((x) => x.id === params[1]).status = 'cancelled';
      return { rows: [] };
    }
    return { rows: [] };
  }

  function novoClient() {
    let foto = null;
    const query = jest.fn(async (sql, params = []) => {
      const s = String(sql || '').trim();
      if (s === 'BEGIN') { foto = clone(banco); return { rows: [] }; }
      if (s === 'COMMIT') { foto = null; return { rows: [] }; }
      if (s === 'ROLLBACK') { if (foto) banco = foto; foto = null; return { rows: [] }; }
      return responder(s, params);
    });
    return { query, release: jest.fn() };
  }

  db.connect.mockImplementation(async () => novoClient());
  db.query.mockImplementation(async (sql, params = []) => responder(String(sql || '').trim(), params));
  return ref;
}

const PRECO = { [I.heineken]: 14, [I.fritas]: 38, [I.caipirinha]: 18, [I.agua]: 6 };
const QTD = { [I.heineken]: 4, [I.fritas]: 1, [I.caipirinha]: 3, [I.agua]: 2 };
function corpoDaVenda(ids, extra = {}) {
  const lista = ids || Object.keys(PRECO);
  return {
    items: lista.map((id) => ({ quantity: QTD[id], unit_price: PRECO[id], product_name_snapshot: id })),
    payment_method: 'pix',
    comanda_id: comandaId,
    ...(ids ? { comanda_item_ids: ids } : {}),
    ...extra,
  };
}
const vender = (body) => request(app).post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth).send(body);
const cancelar = (saleId) => request(app).delete(`/api/v1/companies/${cid}/pdv/sale/${saleId}`).set(adminAuth);
const verComanda = () => request(app).get(`/api/v1/companies/${cid}/comandas/12`).set(adminAuth);
const listar = () => request(app).get(`/api/v1/companies/${cid}/comandas`).set(adminAuth);

beforeEach(() => {
  jest.resetAllMocks();
  comandaSaleHooks._resetCache();
  comandasRouter._resetCache();
  vendaIdempotente._resetCache();
});

describe('comanda: fechamento parcial (392)', () => {
  test('1. dividir por 3: UMA venda com 3 pagamentos que somam o total, e a comanda fecha', async () => {
    const ref = fakeDb();
    const r = await vender(corpoDaVenda(null, {
      payments: [
        { method: 'pix', value: 53.34 },
        { method: 'cartao', value: 53.33 },
        { method: 'dinheiro', value: 53.33 },
      ],
    }));
    expect(r.status).toBe(201);
    const banco = ref.get();
    expect(banco.sales).toHaveLength(1);
    const saleId = banco.sales[0].id;
    expect(Number(banco.sales[0].total_amount)).toBe(160);
    expect(banco.salePayments.map((p) => p.method)).toEqual(['pix', 'cartao', 'dinheiro']);
    expect(banco.salePayments.every((p) => p.sale_id === saleId)).toBe(true);
    expect(Math.round(banco.salePayments.reduce((t, p) => t + p.amount, 0) * 100) / 100).toBe(160);
    expect(banco.comandas[0]).toMatchObject({ status: 'closed', sale_id: saleId });
    expect(banco.items.every((i) => i.sale_id === saleId)).toBe(true);
    expect(r.body.sale.comanda_open).toBeUndefined();
  });

  test('2. cobrar 2 itens: venda so com eles; a comanda segue aberta com os outros 2 e parcial, ate nao sobrar item', async () => {
    const ref = fakeDb();
    const a = await vender(corpoDaVenda([I.fritas, I.agua]));
    expect(a.status).toBe(201);
    expect(a.body.sale.comanda_open).toBe(true);
    let banco = ref.get();
    const vendaA = banco.sales[0].id;
    expect(Number(banco.sales[0].total_amount)).toBe(50);
    expect(banco.comandas[0].status).toBe('open');
    expect(banco.items.filter((i) => i.sale_id === vendaA).map((i) => i.id).sort()).toEqual([I.fritas, I.agua].sort());

    const g = await verComanda();
    expect(g.status).toBe(200);
    expect(g.body.comanda).toMatchObject({ items_count: 2, subtotal: 110, parcial: true, paid_subtotal: 50 });
    expect(g.body.comanda.items.map((i) => i.id)).toEqual([I.heineken, I.caipirinha]);
    const l = await listar();
    expect(l.body.comandas).toEqual([expect.objectContaining({ number: 12, items_count: 2, subtotal: 110, parcial: true, paid_subtotal: 50 })]);

    // o resto: a comanda fecha
    const b = await vender(corpoDaVenda([I.heineken, I.caipirinha]));
    expect(b.status).toBe(201);
    expect(b.body.sale.comanda_open).toBeUndefined();
    banco = ref.get();
    const vendaB = banco.sales[1].id;
    expect(banco.comandas[0]).toMatchObject({ status: 'closed', sale_id: vendaB });
    expect((await verComanda()).status).toBe(404);
  });

  test('3. cancelar a venda da parte devolve os itens; se a comanda ja tinha fechado, reabre', async () => {
    const ref = fakeDb();
    await vender(corpoDaVenda([I.fritas, I.agua]));
    const vendaA = ref.get().sales[0].id;

    // (a) comanda ainda aberta: os itens voltam, a comanda segue aberta
    const c1 = await cancelar(vendaA);
    expect(c1.status).toBe(200);
    let banco = ref.get();
    expect(banco.items.every((i) => i.sale_id === null)).toBe(true);
    expect(banco.comandas[0].status).toBe('open');
    expect((await verComanda()).body.comanda).toMatchObject({ items_count: 4, subtotal: 160, parcial: false, paid_subtotal: 0 });

    // (b) cobra parte, cobra o resto (fecha), cancela a PRIMEIRA: reabre so com ela
    await vender(corpoDaVenda([I.fritas, I.agua]));
    await vender(corpoDaVenda([I.heineken, I.caipirinha]));
    banco = ref.get();
    const [, vendaParte, vendaResto] = banco.sales.map((v) => v.id);
    expect(banco.comandas[0]).toMatchObject({ status: 'closed', sale_id: vendaResto });
    expect((await cancelar(vendaParte)).status).toBe(200);
    banco = ref.get();
    expect(banco.comandas[0]).toMatchObject({ status: 'open', sale_id: null });
    const g = (await verComanda()).body.comanda;
    expect(g.items.map((i) => i.id).sort()).toEqual([I.fritas, I.agua].sort());
    expect(g).toMatchObject({ subtotal: 50, parcial: true, paid_subtotal: 110 });

    // (c) numero 12 reaberto por outra comanda antes do cancelamento: 'cancelled'
    await vender(corpoDaVenda([I.fritas, I.agua]));
    banco = ref.get();
    const vendaFinal = banco.sales[banco.sales.length - 1].id;
    expect(banco.comandas[0].status).toBe('closed');
    banco.comandas.push({ id: outraComanda, company_id: cid, number: 12, status: 'open', opened_at: 'x', sale_id: null });
    expect((await cancelar(vendaFinal)).status).toBe(200);
    banco = ref.get();
    expect(banco.comandas[0].status).toBe('cancelled');
    expect((await verComanda()).body.comanda.id).toBe(outraComanda);
  });

  test('4. o mesmo item cobrado duas vezes: 409 e a segunda venda nao fica gravada', async () => {
    const ref = fakeDb();
    expect((await vender(corpoDaVenda([I.fritas]))).status).toBe(201);
    const r = await vender(corpoDaVenda([I.fritas, I.agua]));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COMANDA_ITEM_ALREADY_CHARGED');
    const banco = ref.get();
    expect(banco.sales).toHaveLength(1);
    expect(item(banco, I.agua).sale_id).toBeNull();

    // id repetido no mesmo pedido, lista vazia e id que nao e uuid: 400
    for (const ids of [[I.agua, I.agua], [], ['x']]) {
      const e = await vender(corpoDaVenda(null, { comanda_item_ids: ids }));
      expect(e.status).toBe(400);
      expect(e.body.code).toBe('COMANDA_ITEMS_INVALID');
    }
    // item que nao e da comanda (tirado nesse meio tempo)
    const nf = await vender(corpoDaVenda(null, { comanda_item_ids: ['a0000000-0000-4000-8000-000000000099'] }));
    expect(nf.status).toBe(409);
    expect(nf.body.code).toBe('COMANDA_ITEM_NOT_FOUND');
    expect(ref.get().sales).toHaveLength(1);
  });

  test('5. sem comanda_item_ids: igual a hoje — todos os pendentes, e a comanda fecha', async () => {
    const ref = fakeDb();
    await vender(corpoDaVenda([I.fritas]));
    const r = await vender(corpoDaVenda(null));
    expect(r.status).toBe(201);
    const banco = ref.get();
    const venda2 = banco.sales[1].id;
    expect(banco.comandas[0]).toMatchObject({ status: 'closed', sale_id: venda2 });
    expect(banco.items.filter((i) => i.sale_id === venda2).map((i) => i.id).sort())
      .toEqual([I.heineken, I.caipirinha, I.agua].sort());
    // e a comanda fechada nao se cobra de novo
    const de = await vender(corpoDaVenda(null));
    expect(de.status).toBe(409);
    expect(de.body.code).toBe('COMANDA_NOT_OPEN');
  });

  test('6. parte de uma linha: 2 das 4 Heineken; a linha e dividida e o resto fica pendente', async () => {
    const ref = fakeDb();
    const r = await vender({
      ...corpoDaVenda([I.heineken]),
      items: [{ quantity: 2, unit_price: 14, product_name_snapshot: 'Heineken' }],
      comanda_item_qty: { [I.heineken]: 2 },
    });
    expect(r.status).toBe(201);
    const banco = ref.get();
    const venda = banco.sales[0].id;
    expect(item(banco, I.heineken)).toMatchObject({ quantity: '2', sale_id: null });
    const cobrada = banco.items.find((i) => i.sale_id === venda);
    expect(cobrada).toMatchObject({ name: 'Heineken 600 ml', quantity: '2', unit_price: '14' });
    const g = (await verComanda()).body.comanda;
    expect(g).toMatchObject({ items_count: 4, subtotal: 132, parcial: true, paid_subtotal: 28 });

    // mais do que tem: 409
    const demais = await vender({ ...corpoDaVenda([I.heineken]), comanda_item_qty: { [I.heineken]: 3 } });
    expect(demais.status).toBe(409);
    expect(demais.body.code).toBe('COMANDA_ITEM_QTY_INVALID');
  });

  test('7. item ja cobrado nao sai pelo DELETE da comanda', async () => {
    fakeDb();
    await vender(corpoDaVenda([I.fritas]));
    const d = await request(app).delete(`/api/v1/companies/${cid}/comandas/12/items/${I.fritas}`).set(adminAuth);
    expect(d.status).toBe(404);
    const ok = await request(app).delete(`/api/v1/companies/${cid}/comandas/12/items/${I.agua}`).set(adminAuth);
    expect(ok.status).toBe(200);
    expect(ok.body.comanda).toMatchObject({ items_count: 2, parcial: true });
  });

  test('8. sem a 392: a comanda inteira fecha como hoje; parcial e 409; o GET nao manda parcial', async () => {
    const ref = fakeDb({ itemVenda: false });
    const g = (await verComanda()).body.comanda;
    expect(g.items_count).toBe(4);
    expect(g).not.toHaveProperty('parcial');
    expect(g).not.toHaveProperty('paid_subtotal');
    expect((await listar()).body.comandas[0]).not.toHaveProperty('parcial');

    const p = await vender(corpoDaVenda([I.fritas, I.agua]));
    expect(p.status).toBe(409);
    expect(p.body.code).toBe('COMANDA_PARCIAL_UNAVAILABLE');
    expect(ref.get().sales).toHaveLength(0);

    // todos os itens inteiros (o app novo sempre manda os ids): fecha como hoje
    const t = await vender(corpoDaVenda(Object.keys(PRECO)));
    expect(t.status).toBe(201);
    expect(ref.get().comandas[0].status).toBe('closed');
    expect(ref.get().items.every((i) => i.sale_id === null)).toBe(true);
  });
});

function item(banco, id) { return banco.items.find((i) => i.id === id); }
