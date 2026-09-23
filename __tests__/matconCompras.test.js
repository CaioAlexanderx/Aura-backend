// ============================================================
// AURA. — Matcon M4: compras (src/routes/matconPurchases.js,
// src/services/matconPurchases.js, migration 354)
//
// O que estes testes travam:
//   1. Regra da sugestao: abaixo do minimo, giro (acaba em ate 14 dias),
//      arredondamento por caixa (purchase_factor), produto sem custo,
//      estoque de variantes e o que NAO entra na lista. Estoque <= minimo
//      entra SEMPRE (regra do Estoque, 23/09), inclusive minimo 0 com
//      estoque zerado — com 1 unidade de compra e reason.
//   2. GET /purchase-suggestions: summary {total_est_cost, items_below_min,
//      suppliers} e a mesma regra do alerta do Estoque (stock_min).
//   3. GET /purchase-orders: lista + summary {draft, sent, received_7d}.
//   4. POST cria rascunho "C-0042" com nome/unidade/custo do produto.
//   5. PATCH: transicoes (draft→sent, sent→received, fechado → 409).
//   6. Gate: escrita com matcon desligado → 403 MATCON_DISABLED; leitura
//      continua aberta.
//   7. Entrada da nota: CNPJ igual ao de um pedido enviado casa os itens
//      por product_id; parcial fica "sent", completo fecha "received".
//   8. import-nfe (importData.js) grava a ultima compra e fecha o pedido.
//
// Router ISOLADO. Mock por CONTEUDO DO SQL, nunca fila posicional (mesmo
// padrao de tests/routes/otica.labFlow.test.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const { requireAuth, requireCompanyAccess } = require('../src/middleware/auth');
const comprasRouter = require('../src/routes/matconPurchases');
const importRouter = require('../src/routes/importData');
const { casarNotaComPedidos } = require('../src/services/matconPurchases');

const montarSugestao = comprasRouter._montarSugestao;

const SECRET = 'aura-test-secret-2026';
const CID = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const P_CIMENTO = '11111111-1111-4111-8111-111111111111';
const P_PISO = '22222222-2222-4222-8222-222222222222';
const P_AREIA = '33333333-3333-4333-8333-333333333333';
const OID = '44444444-4444-4444-8444-444444444444';
const OID2 = '55555555-5555-4555-8555-555555555555';
const CNPJ = '11222333000181';
const AUTH = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/matcon', comprasRouter);
  scoped.use('/', importRouter);
  app.use('/companies/:id', scoped);
  return app;
}
const app = buildApp();

// ── Estado do "banco" ────────────────────────────────────────
let st;

const PRODUTOS = {
  [P_CIMENTO]: { id: P_CIMENTO, name: 'Cimento CP-II 50 kg', unit: 'sc', cost_price: '30.00', purchase_factor: null, last_purchase_unit_cost: '32.9000' },
  [P_PISO]: { id: P_PISO, name: 'Piso 60x60 Bege', unit: 'm²', cost_price: '40.00', purchase_factor: '2.3200', last_purchase_unit_cost: '92.8000' },
  [P_AREIA]: { id: P_AREIA, name: 'Areia média', unit: 'm³', cost_price: '0', purchase_factor: null, last_purchase_unit_cost: null },
};

function pedido(extra = {}) {
  return {
    id: OID, seq: 42, status: 'draft',
    supplier_name: 'Cimentos Ipê', supplier_cnpj: CNPJ, supplier_phone: '11999990000',
    items: [
      { product_id: P_CIMENTO, name: 'Cimento CP-II 50 kg', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 0 },
    ],
    total_est: '1974.00', sent_at: null, received_at: null, received_invoice: null,
    created_at: '2026-09-23T10:00:00.000Z',
    ...extra,
  };
}

function reset() {
  st = {
    matcon: 'true',
    suggestionRows: [],
    order: pedido(),
    sentOrders: [],
    listRows: [],
    summaryRow: { draft_count: 0, draft_total: '0', sent_count: 0, sent_total: '0', rec_count: 0, rec_total: '0' },
    alreadyApplied: false,
  };
}

function rowDoUpdate(base, params, { receipt }) {
  if (receipt) {
    // [id, cid, itemsJson, status, received_invoice]
    return {
      ...base,
      items: JSON.parse(params[2]),
      status: params[3],
      received_at: params[3] === 'received' ? '2026-09-23T12:00:00.000Z' : base.received_at,
      received_invoice: params[4],
    };
  }
  // PATCH: [oid, cid, itemsJson, total, status]
  const status = params[4];
  return {
    ...base,
    items: JSON.parse(params[2]),
    total_est: String(params[3]),
    status,
    sent_at: ['sent', 'received'].includes(status) ? (base.sent_at || '2026-09-23T11:00:00.000Z') : base.sent_at,
    received_at: status === 'received' ? (base.received_at || '2026-09-23T12:00:00.000Z') : base.received_at,
  };
}

function handler(sql, params) {
  const s = String(sql || '');
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/i.test(s)) return { rows: [] };
  if (/pdv_settings->>'matcon_enabled'/.test(s)) return { rows: [{ enabled: st.matcon }] };
  if (/WITH visiveis AS/.test(s)) return { rows: st.suggestionRows };
  if (/INSERT INTO matcon_purchase_order_counters/.test(s)) return { rows: [{ last_number: 42 }] };
  if (/INSERT INTO matcon_purchase_orders/.test(s)) {
    return {
      rows: [{
        id: OID, seq: params[1], status: 'draft',
        supplier_name: params[2], supplier_cnpj: params[3], supplier_phone: params[4],
        items: JSON.parse(params[5]), total_est: String(params[6]),
        sent_at: null, received_at: null, received_invoice: null, created_at: '2026-09-23T10:00:00.000Z',
      }],
    };
  }
  if (/SELECT p\.id, p\.name, p\.unit, p\.cost_price/.test(s)) {
    return { rows: params[1].map((id) => PRODUTOS[id]).filter(Boolean) };
  }
  if (/SELECT p\.id, p\.purchase_factor FROM products/.test(s)) {
    return { rows: params[1].map((id) => PRODUTOS[id]).filter(Boolean) };
  }
  if (/WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/.test(s)) {
    return { rows: st.order && st.order.id === params[0] ? [st.order] : [] };
  }
  if (/UPDATE matcon_purchase_orders\s+SET items\s+= \$3::jsonb,\s+total_est/.test(s)) {
    return { rows: [rowDoUpdate(st.order, params, { receipt: false })] };
  }
  if (/SELECT 1 FROM matcon_purchase_orders/.test(s)) return { rows: st.alreadyApplied ? [{ '?column?': 1 }] : [] };
  if (/status = 'sent' AND supplier_cnpj = \$2/.test(s)) return { rows: st.sentOrders };
  if (/UPDATE matcon_purchase_orders\s+SET items = \$3::jsonb,\s+status = \$4/.test(s)) {
    const base = st.sentOrders.find((o) => o.id === params[0]);
    return { rows: [rowDoUpdate(base, params, { receipt: true })] };
  }
  if (/COUNT\(\*\) FILTER/.test(s)) return { rows: [st.summaryRow] };
  if (/ORDER BY created_at DESC LIMIT 200/.test(s)) return { rows: st.listRows };
  // import-nfe
  if (/SELECT id FROM products WHERE company_id=\$1 AND lower\(name\)=lower\(\$2\)/.test(s)) return { rows: st.nfeExisting ? [{ id: st.nfeExisting }] : [] };
  if (/SELECT id FROM suppliers WHERE cnpj = \$1 AND/.test(s)) return { rows: [{ id: 'sup-1' }] };
  return { rows: [] };
}

beforeEach(() => {
  jest.resetAllMocks();
  reset();
  db.query.mockImplementation((sql, params) => Promise.resolve(handler(sql, params)));
  db.connect.mockImplementation(() => Promise.resolve({ query: db.query, release: jest.fn() }));
});

const callsMatching = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

// ── 1. Regra da sugestao ─────────────────────────────────────
function linha(extra) {
  return {
    id: P_CIMENTO, name: 'Cimento CP-II 50 kg', unit: 'sc',
    stock_qty: '12', stock_min: '40', cost_price: '30.00', purchase_factor: null,
    last_purchase_unit_cost: null, last_supplier_name: null, last_supplier_cnpj: null, last_supplier_phone: null,
    has_variants: false, variants_stock_total: '0', sold_30d: '0',
    ...extra,
  };
}

describe('regra da sugestao (montarSugestao)', () => {
  test('abaixo do minimo sem venda: repor ate 1,5 × minimo', () => {
    const s = montarSugestao(linha({}));
    // max(40 × 1,5, 0) − 12 = 48
    expect(s.suggested_qty).toBe(48);
    expect(s.weekly_sales).toBe(0);
    expect(s.days_to_stockout).toBeNull();
    expect(s.est_cost).toBe(1440); // 48 × custo do cadastro 30
    expect(s._abaixo_do_minimo).toBe(true);
    expect(s.reason).toBe('abaixo_do_minimo');
  });

  test('giro: acima do minimo mas acaba em ate 14 dias -> entra com weekly_sales × 3', () => {
    // vendeu 129 em 30 dias -> 30/semana; estoque 50 (> minimo 10)
    const s = montarSugestao(linha({ stock_qty: '50', stock_min: '10', sold_30d: '129' }));
    expect(s.weekly_sales).toBe(30);
    expect(s.days_to_stockout).toBe(11); // 50 ÷ (30/7) = 11,67
    expect(s.suggested_qty).toBe(40); // max(15, 90) − 50
    expect(s._abaixo_do_minimo).toBe(false);
    expect(s.reason).toBe('vai_acabar');
  });

  describe('estoque <= minimo entra sempre (regra do Estoque, 23/09)', () => {
    test('estoque 0 / minimo 0 / sem venda -> entra com 1 unidade e reason "zerado_sem_minimo"', () => {
      const s = montarSugestao(linha({ stock_qty: '0', stock_min: '0' }));
      expect(s).not.toBeNull();
      expect(s.suggested_qty).toBe(1);
      expect(s.reason).toBe('zerado_sem_minimo');
      expect(s._abaixo_do_minimo).toBe(true);
      expect(s.est_cost).toBe(30);
      expect(s.days_to_stockout).toBeNull();
    });

    test('com purchase_factor, 1 unidade de compra = 1 caixa', () => {
      const s = montarSugestao(linha({ unit: 'm²', stock_qty: '0', stock_min: '0', purchase_factor: '2.3200' }));
      expect(s.suggested_qty).toBe(2.32);
      expect(s.reason).toBe('zerado_sem_minimo');
    });

    test('unidade de medida sem fator: 1 na unidade de venda', () => {
      expect(montarSugestao(linha({ unit: 'm3', stock_qty: '0', stock_min: '0' })).suggested_qty).toBe(1);
    });

    test('estoque negativo e minimo 0: repoe o que falta para zerar (mínimo − estoque)', () => {
      const s = montarSugestao(linha({ stock_qty: '-3', stock_min: '0' }));
      expect(s.suggested_qty).toBe(3);
      expect(s.reason).toBe('zerado_sem_minimo');
    });

    test('estoque positivo e minimo 0 continua fora (0 < estoque, igual ao Estoque)', () => {
      expect(montarSugestao(linha({ stock_qty: '5', stock_min: '0' }))).toBeNull();
    });
  });

  test('acima do minimo e acaba em mais de 14 dias -> fora da lista', () => {
    // 43 em 30 dias -> 10/semana; estoque 25 -> 17 dias
    expect(montarSugestao(linha({ stock_qty: '25', stock_min: '5', sold_30d: '43' }))).toBeNull();
  });

  test('estoque ja no alvo -> fora da lista (suggested_qty <= 0)', () => {
    expect(montarSugestao(linha({ stock_qty: '60', stock_min: '40' }))).toBeNull();
  });

  test('estoque igual ao minimo conta como abaixo (mesma regra do alerta do Estoque: stock <= min)', () => {
    const s = montarSugestao(linha({ stock_qty: '40', stock_min: '40' }));
    expect(s._abaixo_do_minimo).toBe(true);
    expect(s.suggested_qty).toBe(20);
  });

  test('arredonda para cima na caixa (purchase_factor) e custo = ultima nota ÷ fator', () => {
    const s = montarSugestao(linha({
      id: P_PISO, unit: 'm²', stock_qty: '10', stock_min: '20', purchase_factor: '2.3200',
      last_purchase_unit_cost: '92.8000',
    }));
    // max(30, 0) − 10 = 20 m² -> 9 caixas (8,62) -> 20,88 m²
    expect(s.suggested_qty).toBe(20.88);
    // 92,80 a caixa ÷ 2,32 = 40/m² -> 20,88 × 40
    expect(s.est_cost).toBe(835.2);
  });

  test('sem custo nenhum (nem nota nem cadastro) -> est_cost 0, continua na lista', () => {
    const s = montarSugestao(linha({ cost_price: '0', last_purchase_unit_cost: null }));
    expect(s).not.toBeNull();
    expect(s.est_cost).toBe(0);
  });

  test('unidade contada sem fator sobe para o inteiro; unidade de medida fica em decimal', () => {
    // 10 em 30 dias -> 2,3256/semana × 3 = 6,977 − 2 = 4,977
    const saco = montarSugestao(linha({ stock_qty: '2', stock_min: '0', sold_30d: '10' }));
    expect(saco.suggested_qty).toBe(5);
    const areia = montarSugestao(linha({ unit: 'm3', stock_qty: '2', stock_min: '0', sold_30d: '10' }));
    expect(areia.suggested_qty).toBe(4.977);
  });

  test('produto com variantes usa a soma do estoque das variantes', () => {
    const s = montarSugestao(linha({ stock_qty: '0', has_variants: true, variants_stock_total: '30' }));
    expect(s.stock).toBe(30);
    expect(s.suggested_qty).toBe(30);
  });

  test('fornecedor: ultima nota > cadastro (suppliers) > colunas antigas', () => {
    const daNota = montarSugestao(linha({
      last_supplier_name: 'Cimentos Ipê', last_supplier_cnpj: CNPJ, last_supplier_phone: null,
      last_supplier_registry_phone: '1140028922', registry_supplier_name: 'Outro', registry_supplier_cnpj: '99',
    }));
    expect(daNota).toMatchObject({ supplier_name: 'Cimentos Ipê', supplier_cnpj: CNPJ, supplier_phone: '1140028922' });

    const doCadastro = montarSugestao(linha({ registry_supplier_name: 'Depósito X', registry_supplier_cnpj: '11.222.333/0001-81', registry_supplier_phone: '11988887777' }));
    expect(doCadastro).toMatchObject({ supplier_name: 'Depósito X', supplier_cnpj: CNPJ, supplier_phone: '11988887777' });

    const semNada = montarSugestao(linha({}));
    expect(semNada).toMatchObject({ supplier_name: null, supplier_cnpj: null, supplier_phone: null });
  });
});

// ── 2. GET /purchase-suggestions ─────────────────────────────
describe('GET /matcon/purchase-suggestions', () => {
  test('lista, summary e mesma coluna de minimo do Estoque (stock_min); leitura aberta com toggle desligado', async () => {
    st.matcon = 'false';
    st.suggestionRows = [
      linha({ last_supplier_name: 'Cimentos Ipê', last_supplier_cnpj: CNPJ, cost_price: '32.90' }),
      linha({ id: P_PISO, name: 'Piso 60x60', unit: 'm²', stock_qty: '10', stock_min: '20', purchase_factor: '2.32', last_purchase_unit_cost: '92.80', last_supplier_name: 'Cerâmica Sul', last_supplier_cnpj: '99888777000166' }),
      // giro: acima do minimo, acaba em 11 dias, sem fornecedor
      linha({ id: P_AREIA, name: 'Areia', unit: 'm³', stock_qty: '50', stock_min: '10', sold_30d: '129', cost_price: '0' }),
      // fora: tudo ok
      linha({ id: 'x', stock_qty: '100', stock_min: '10' }),
    ];

    const res = await request(app).get(`/companies/${CID}/matcon/purchase-suggestions`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.suggestions.map((s) => s.product_id)).toEqual([P_AREIA, P_CIMENTO, P_PISO]); // quem acaba antes primeiro; sem prazo, por nome
    expect(res.body.suggestions[0]).not.toHaveProperty('_abaixo_do_minimo');
    // 48 × 32,90 + 20,88 × 40 (areia sem custo)
    expect(res.body.summary.total_est_cost).toBeCloseTo(2414.4, 2);
    expect(res.body.summary.items_below_min).toBe(2);
    expect(res.body.summary.suppliers).toBe(3); // Ipê, Cerâmica Sul e "sem fornecedor"

    const [sql] = callsMatching(/WITH visiveis AS/)[0];
    expect(sql).toMatch(/p\.stock_min/);
    expect(sql).toMatch(/COALESCE\(s\.status, 'completed'\) <> 'cancelled'/);
    expect(sql).toMatch(/INTERVAL '30 days'/);
    expect(sql).toMatch(/p\.is_active = true/);
  });

  test('estoque 0 / minimo 0 entra na lista e conta em items_below_min (mesmo numero do Estoque)', async () => {
    st.suggestionRows = [
      linha({}),
      linha({ id: P_PISO, name: 'Rejunte', stock_qty: '0', stock_min: '0', cost_price: '12' }),
    ];
    const res = await request(app).get(`/companies/${CID}/matcon/purchase-suggestions`).set(AUTH);
    expect(res.status).toBe(200);
    const rejunte = res.body.suggestions.find((s) => s.product_id === P_PISO);
    expect(rejunte).toMatchObject({ suggested_qty: 1, reason: 'zerado_sem_minimo', est_cost: 12 });
    expect(res.body.summary.items_below_min).toBe(2);
  });
});

// ── 3. GET /purchase-orders ──────────────────────────────────
describe('GET /matcon/purchase-orders', () => {
  test('lista + summary {draft, sent, received_7d}', async () => {
    st.listRows = [pedido({ status: 'sent', sent_at: '2026-09-22T10:00:00.000Z' })];
    st.summaryRow = { draft_count: 1, draft_total: '120.5', sent_count: 1, sent_total: '1974', rec_count: 2, rec_total: '3000.456' };

    const res = await request(app).get(`/companies/${CID}/matcon/purchase-orders?status=sent`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.orders[0]).toMatchObject({ id: OID, number: 'C-0042', status: 'sent', total_est: 1974 });
    expect(res.body.orders[0].items[0]).toEqual({
      product_id: P_CIMENTO, name: 'Cimento CP-II 50 kg', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 0,
    });
    expect(res.body.summary).toEqual({
      draft: { count: 1, total: 120.5 },
      sent: { count: 1, total: 1974 },
      received_7d: { count: 2, total: 3000.46 },
    });
    const [, params] = callsMatching(/ORDER BY created_at DESC LIMIT 200/)[0];
    expect(params).toEqual([CID, 'sent']);
  });

  test('status=all (o que o front manda sem filtro) nao filtra; status invalido -> 400', async () => {
    const ok = await request(app).get(`/companies/${CID}/matcon/purchase-orders?status=all`).set(AUTH);
    expect(ok.status).toBe(200);
    expect(callsMatching(/ORDER BY created_at DESC LIMIT 200/)[0][1]).toEqual([CID]);

    const bad = await request(app).get(`/companies/${CID}/matcon/purchase-orders?status=aberto`).set(AUTH);
    expect(bad.status).toBe(400);
  });
});

// ── 4. POST /purchase-orders ─────────────────────────────────
describe('POST /matcon/purchase-orders', () => {
  test('cria rascunho C-0042 com nome, unidade e custo estimado do produto', async () => {
    const res = await request(app).post(`/companies/${CID}/matcon/purchase-orders`).set(AUTH).send({
      supplier_name: 'Cimentos Ipê', supplier_cnpj: '11.222.333/0001-81', supplier_phone: '(11) 99999-0000',
      items: [{ product_id: P_CIMENTO, quantity: 60 }, { product_id: P_PISO, quantity: 20.88 }],
    });
    expect(res.status).toBe(201);
    const o = res.body.order;
    expect(o).toMatchObject({ number: 'C-0042', status: 'draft', supplier_cnpj: CNPJ, supplier_phone: '(11) 99999-0000' });
    expect(o.items).toEqual([
      { product_id: P_CIMENTO, name: 'Cimento CP-II 50 kg', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 0 },
      // 92,80 a caixa ÷ 2,32 = 40/m²
      { product_id: P_PISO, name: 'Piso 60x60 Bege', unit: 'm²', quantity: 20.88, unit_cost_est: 40, received_qty: 0 },
    ]);
    expect(o.total_est).toBeCloseTo(2809.2, 2);
    expect(callsMatching(/^\s*COMMIT/)).toHaveLength(1);
  });

  test('produto de fora da loja -> 404; sem itens -> 400; quantidade zero -> 400', async () => {
    const fora = await request(app).post(`/companies/${CID}/matcon/purchase-orders`).set(AUTH)
      .send({ supplier_name: 'X', supplier_cnpj: null, items: [{ product_id: '99999999-9999-4999-8999-999999999999', quantity: 1 }] });
    expect(fora.status).toBe(404);
    expect(callsMatching(/INSERT INTO matcon_purchase_orders/)).toHaveLength(0);

    const vazio = await request(app).post(`/companies/${CID}/matcon/purchase-orders`).set(AUTH).send({ items: [] });
    expect(vazio.status).toBe(400);

    const zero = await request(app).post(`/companies/${CID}/matcon/purchase-orders`).set(AUTH)
      .send({ items: [{ product_id: P_CIMENTO, quantity: 0 }] });
    expect(zero.status).toBe(400);
  });
});

// ── 5. PATCH /purchase-orders/:oid ───────────────────────────
describe('PATCH /matcon/purchase-orders/:oid', () => {
  const patch = (body) => request(app).patch(`/companies/${CID}/matcon/purchase-orders/${OID}`).set(AUTH).send(body);

  test('draft -> sent com as quantidades aprovadas (o que o front manda no "Enviar no WhatsApp")', async () => {
    const res = await patch({ items: [{ product_id: P_CIMENTO, quantity: 50 }, { product_id: P_PISO, quantity: 4.64 }], status: 'sent' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('sent');
    expect(res.body.order.sent_at).toBeTruthy();
    expect(res.body.order.items.map((i) => [i.product_id, i.quantity, i.unit_cost_est])).toEqual([
      [P_CIMENTO, 50, 32.9],
      [P_PISO, 4.64, 40],
    ]);
    const [sql, params] = callsMatching(/UPDATE matcon_purchase_orders\s+SET items\s+= \$3::jsonb,\s+total_est/)[0];
    expect(sql).toMatch(/sent_at\s+= CASE WHEN \$5::text IN \('sent', 'received'\) THEN COALESCE\(sent_at, NOW\(\)\)/);
    expect(params[3]).toBeCloseTo(1830.6, 2);
  });

  test('quantidade 0 tira o item; todos zerados -> 400', async () => {
    st.order = pedido({ items: [...pedido().items, { product_id: P_PISO, name: 'Piso', unit: 'm²', quantity: 10, unit_cost_est: 40, received_qty: 0 }] });
    const res = await patch({ items: [{ product_id: P_CIMENTO, quantity: 60 }, { product_id: P_PISO, quantity: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body.order.items.map((i) => i.product_id)).toEqual([P_CIMENTO]);

    const vazio = await patch({ items: [{ product_id: P_CIMENTO, quantity: 0 }] });
    expect(vazio.status).toBe(400);
  });

  test('sent -> received: o que nao tinha chegado conta como chegado', async () => {
    st.order = pedido({ status: 'sent', sent_at: '2026-09-22T10:00:00.000Z', items: [
      { product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 40 },
    ] });
    const res = await patch({ status: 'received' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('received');
    expect(res.body.order.received_at).toBeTruthy();
    expect(res.body.order.items[0].received_qty).toBe(60);
  });

  test('sent -> sent de novo (reenvio) mantem received_qty do que ja chegou', async () => {
    st.order = pedido({ status: 'sent', sent_at: '2026-09-22T10:00:00.000Z', items: [
      { product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 40 },
    ] });
    const res = await patch({ items: [{ product_id: P_CIMENTO, quantity: 70 }], status: 'sent' });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ status: 'sent', sent_at: '2026-09-22T10:00:00.000Z' });
    expect(res.body.order.items[0]).toMatchObject({ quantity: 70, received_qty: 40 });
  });

  test('draft -> received pula o envio -> 409; pedido recebido/cancelado nao muda -> 409', async () => {
    const pulou = await patch({ status: 'received' });
    expect(pulou.status).toBe(409);
    expect(pulou.body.code).toBe('TRANSICAO_INVALIDA');

    st.order = pedido({ status: 'received' });
    const fechado = await patch({ status: 'cancelled' });
    expect(fechado.status).toBe(409);
    expect(fechado.body.code).toBe('PEDIDO_FECHADO');

    st.order = pedido({ status: 'cancelled' });
    const itens = await patch({ items: [{ product_id: P_CIMENTO, quantity: 1 }] });
    expect(itens.status).toBe(409);
    expect(callsMatching(/UPDATE matcon_purchase_orders/)).toHaveLength(0);
  });

  test('draft -> cancelled', async () => {
    const res = await patch({ status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('cancelled');
  });

  test('pedido de outra empresa / inexistente -> 404', async () => {
    st.order = null;
    const res = await patch({ status: 'sent' });
    expect(res.status).toBe(404);
  });
});

// ── 6. Gate ──────────────────────────────────────────────────
describe('gate matcon_enabled (so na escrita)', () => {
  beforeEach(() => { st.matcon = 'false'; });

  test('POST, PATCH e entrada da nota -> 403 MATCON_DISABLED', async () => {
    const post = await request(app).post(`/companies/${CID}/matcon/purchase-orders`).set(AUTH)
      .send({ items: [{ product_id: P_CIMENTO, quantity: 1 }] });
    const pat = await request(app).patch(`/companies/${CID}/matcon/purchase-orders/${OID}`).set(AUTH).send({ status: 'sent' });
    const rec = await request(app).post(`/companies/${CID}/matcon/purchase-receipts`).set(AUTH)
      .send({ supplier_cnpj: CNPJ, items: [{ product_id: P_CIMENTO, quantity: 1, unit_cost: 1 }] });
    for (const r of [post, pat, rec]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('MATCON_DISABLED');
    }
    expect(callsMatching(/INSERT INTO|UPDATE /)).toHaveLength(0);
  });

  test('lista de pedidos continua aberta', async () => {
    const res = await request(app).get(`/companies/${CID}/matcon/purchase-orders`).set(AUTH);
    expect(res.status).toBe(200);
  });
});

// ── 7. Entrada da nota ───────────────────────────────────────
describe('POST /matcon/purchase-receipts — a nota do fornecedor casa com o pedido enviado', () => {
  const receber = (body) => request(app).post(`/companies/${CID}/matcon/purchase-receipts`).set(AUTH).send(body);

  function enviado(id, items, extra = {}) {
    return pedido({ id, status: 'sent', sent_at: '2026-09-20T10:00:00.000Z', items, ...extra });
  }

  test('parcial: grava received_qty e o numero da nota, pedido continua "sent"', async () => {
    st.sentOrders = [enviado(OID, [
      { product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 0 },
    ])];
    const res = await receber({
      supplier_name: 'Cimentos Ipê', supplier_cnpj: '11.222.333/0001-81', invoice_number: '123',
      items: [{ product_id: P_CIMENTO, quantity: 40, unit_cost: 33.5 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.products_updated).toBe(1);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0]).toMatchObject({ status: 'sent', received_invoice: '123', received_at: null });
    expect(res.body.orders[0].items[0].received_qty).toBe(40);

    // Ultima compra gravada no produto (CNPJ so digitos, custo da nota).
    const [, up] = callsMatching(/UPDATE products\s+SET last_supplier_name/)[0];
    expect(up).toEqual([P_CIMENTO, 'Cimentos Ipê', CNPJ, null, 33.5]);
    // So pedidos ENVIADOS do mesmo CNPJ, do mais antigo para o mais novo.
    const [sel, selParams] = callsMatching(/status = 'sent' AND supplier_cnpj = \$2/)[0];
    expect(selParams).toEqual([CID, CNPJ]);
    expect(sel).toMatch(/ORDER BY sent_at ASC/);
    expect(sel).toMatch(/FOR UPDATE/);
  });

  test('completo: converte caixa -> m² pelo purchase_factor e fecha o pedido (received)', async () => {
    st.sentOrders = [enviado(OID, [
      { product_id: P_PISO, name: 'Piso', unit: 'm²', quantity: 23.2, unit_cost_est: 40, received_qty: 0 },
      { product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 10, unit_cost_est: 32.9, received_qty: 4 },
    ], { received_invoice: '100' })];
    const res = await receber({
      supplier_name: 'Cimentos Ipê', supplier_cnpj: CNPJ, invoice_number: '124',
      // 10 caixas × 2,32 = 23,2 m²; 6 sacos completam o cimento
      items: [{ product_id: P_PISO, quantity: 10, unit_cost: 92.8 }, { product_id: P_CIMENTO, quantity: 6, unit_cost: 33 }],
    });
    expect(res.status).toBe(200);
    const o = res.body.orders[0];
    expect(o.status).toBe('received');
    expect(o.received_at).toBeTruthy();
    expect(o.received_invoice).toBe('100, 124');
    expect(o.items.map((i) => i.received_qty)).toEqual([23.2, 10]);
  });

  test('dois pedidos enviados do mesmo produto: fecha primeiro o mais antigo', async () => {
    st.sentOrders = [
      enviado(OID, [{ product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 30, unit_cost_est: 32.9, received_qty: 0 }]),
      enviado(OID2, [{ product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 30, unit_cost_est: 32.9, received_qty: 0 }], { seq: 43 }),
    ];
    const res = await receber({ supplier_cnpj: CNPJ, invoice_number: '9', items: [{ product_id: P_CIMENTO, quantity: 45, unit_cost: 33 }] });
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o) => [o.id, o.status, o.items[0].received_qty])).toEqual([
      [OID, 'received', 30],
      [OID2, 'sent', 15],
    ]);
  });

  test('mesma nota conferida duas vezes nao soma de novo', async () => {
    st.alreadyApplied = true;
    st.sentOrders = [enviado(OID, [{ product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 40 }])];
    const res = await receber({ supplier_cnpj: CNPJ, invoice_number: '123', items: [{ product_id: P_CIMENTO, quantity: 40, unit_cost: 33 }] });
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
    expect(callsMatching(/UPDATE matcon_purchase_orders/)).toHaveLength(0);
  });

  test('sem CNPJ na nota: so grava a ultima compra, nao casa pedido; produto desconhecido e ignorado', async () => {
    const res = await receber({
      supplier_name: 'Sem CNPJ', supplier_cnpj: null, invoice_number: '1',
      items: [{ product_id: P_CIMENTO, quantity: 5, unit_cost: 30 }, { product_id: '99999999-9999-4999-8999-999999999999', quantity: 1, unit_cost: 1 }, { quantity: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ products_updated: 1, ignored: 2, orders: [] });
    expect(callsMatching(/FROM matcon_purchase_orders/)).toHaveLength(0);
  });
});

// ── casarNotaComPedidos direto (excedente) ───────────────────
describe('casarNotaComPedidos', () => {
  test('chegou mais do que o pedido: received_qty para no pedido, excedente nao vai a lugar nenhum', async () => {
    st.sentOrders = [pedido({ status: 'sent', items: [{ product_id: P_CIMENTO, name: 'C', unit: 'sc', quantity: 10, unit_cost_est: 1, received_qty: 0 }] })];
    const client = { query: db.query };
    const out = await casarNotaComPedidos(client, CID, { supplierCnpj: CNPJ, invoiceNumber: '7', items: [{ product_id: P_CIMENTO, quantity: 25 }] });
    expect(out[0]).toMatchObject({ status: 'received' });
    expect(out[0].items[0].received_qty).toBe(10);
  });
});

// ── 8. import-nfe (importData.js) ────────────────────────────
describe('POST /products/import-nfe?save=true — ultima compra e pedido de compra', () => {
  const XML = `<NFe><infNFe>
    <ide><nNF>555</nNF><serie>1</serie><dhEmi>2026-09-23T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>${CNPJ}</CNPJ><xNome>Cimentos Ipê LTDA</xNome></emit>
    <det><prod><cProd>C1</cProd><xProd>Cimento CP-II 50 kg</xProd><cEAN>SEM GTIN</cEAN><uCom>SC</uCom><qCom>60.0000</qCom><vUnCom>33.00</vUnCom></prod></det>
    <total><ICMSTot><vNF>1980.00</vNF></ICMSTot></total>
  </infNFe></NFe>`;

  test('produto ja cadastrado: grava last_supplier_* e fecha o pedido enviado ao mesmo CNPJ', async () => {
    st.nfeExisting = P_CIMENTO;
    st.sentOrders = [pedido({ status: 'sent', items: [{ product_id: P_CIMENTO, name: 'Cimento', unit: 'sc', quantity: 60, unit_cost_est: 32.9, received_qty: 0 }] })];
    const res = await request(app).post(`/companies/${CID}/products/import-nfe?save=true`).set(AUTH).send({ xml_content: XML });
    expect(res.status).toBe(201);
    expect(res.body.stock_updated).toBe(1);

    const [, up] = callsMatching(/UPDATE products\s+SET last_supplier_name/)[0];
    expect(up).toEqual([P_CIMENTO, 'Cimentos Ipê LTDA', CNPJ, null, 33]);

    const [, recebido] = callsMatching(/UPDATE matcon_purchase_orders\s+SET items = \$3::jsonb,\s+status = \$4/)[0];
    expect(recebido[3]).toBe('received');
    expect(recebido[4]).toBe('555');
  });

  test('falha na ultima compra (base sem a 354) nao derruba o import', async () => {
    st.nfeExisting = P_CIMENTO;
    db.query.mockImplementation((sql, params) => {
      if (/SET last_supplier_name/.test(String(sql))) return Promise.reject(Object.assign(new Error('column does not exist'), { code: '42703' }));
      return Promise.resolve(handler(sql, params));
    });
    const res = await request(app).post(`/companies/${CID}/products/import-nfe?save=true`).set(AUTH).send({ xml_content: XML });
    expect(res.status).toBe(201);
    expect(callsMatching(/ROLLBACK TO SAVEPOINT sp_ultima_compra/)).toHaveLength(1);
    expect(callsMatching(/^\s*COMMIT/)).toHaveLength(1);
  });
});
