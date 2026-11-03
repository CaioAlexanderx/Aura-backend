// ============================================================
// AURA. — estoque_consulta fora de /products (02/11/2026)
//
// O #942 tirou custo e valores de /products para quem tem a permissão
// estoque_consulta. Estas rotas ainda devolviam custo a qualquer membro:
//   - GET /pdv/scan/:code e POST /pdv/scan/batch (cost_price)
//   - GET /pdv/sale/:saleId e POST /pdv/troca (sale_items.unit_cost)
//   - GET /suppliers/:sid (cost_price dos produtos, unit_cost das entradas)
//   - GET /margin (Expansão: a tela inteira é margem)
//   - Matcon compras (est_cost, unit_cost_est, total_est, total)
//   - food (cost_price do cardápio, ficha técnica, margem, desperdício)
//   - GET /dental/supplies (cost_price)
//   - chat da Aura (valor do estoque no contexto)
//
// Monta o private.js inteiro, na ordem real. Para cada rota:
//   - dono, admin, permissions null e membro comum recebem a MESMA resposta
//     de antes (o corpo que a rota monta, com custo);
//   - consulta não recebe custo; com pdv mantém o preço, sem pdv perde.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
// O aiChat lê a chave ao carregar: com ela, o prompt vai para o fetch
// (mockado abaixo) e o teste lê o que a IA receberia.
process.env.CLAUDE_API_KEY = 'chave-de-teste';

jest.mock('../src/config/database');

// A troca real abre transação, mexe em estoque e NFC-e. Aqui interessa só
// que a resposta dela passa pelo filtro do mount /pdv.
const TROCA = {
  version: 'v2',
  sale: { id: 's2', total_amount: 120, items: [{ id: 'i9', unit_price: 120, unit_cost: 50, total_price: 120 }] },
  new_items: [{ id: 'i9', unit_price: 120, unit_cost: 50, total_price: 120 }],
  returned_items: [{ id: 'r1', quantity: 1, unit_price: 100 }],
  net_amount: 20,
};
jest.mock('../src/services/trocaV2', () => ({
  handle: (req, res) => res.status(201).json(JSON.parse(JSON.stringify(TROCA))),
  reemitirEmissao: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const { semValores } = require('../src/middleware/estoqueSoConsulta');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const BASE = `/companies/${COMPANY}`;

const token = (plan = 'negocio') => jwt.sign(
  { id: 'funcionario', role: 'client', plan, company: COMPANY },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

let montado;
const app = () => montado;
beforeAll(() => {
  montado = express();
  montado.use(express.json());
  montado.use('/companies/:id', require('../src/routes/private'));
}, 60000);

// ── Linhas que o banco devolve ─────────────────────────────
const PRODUTO_BIPE = {
  id: PID, name: 'Vestido', description: '', price: '120.00', cost_price: '50.00',
  card_price: '130.00', stock_qty: '7', barcode: '789', barcode_format: 'ean13',
  category: 'Roupas', sku: 'V1', is_active: true, unit: 'un', stock_company_id: COMPANY,
  variants: [{ id: 'v1', sku_suffix: 'P', price_override: '125.00', stock_qty: 3, barcode: '790', attributes: null }],
};
const VENDA = { id: 's1', company_id: COMPANY, total_amount: '120.00', status: 'completed', has_pending_delivery: false };
const ITEM_VENDA = {
  id: 'i1', sale_id: 's1', product_id: PID, quantity: '1', unit_price: '120.00',
  unit_cost: '50.00', discount: '0', total_price: '120.00', product_name: 'Vestido',
};
const FORNECEDOR = { id: SID, company_id: COMPANY, name: 'Malharia', cnpj: null, is_active: true };
const PRODUTO_FORNECEDOR = { id: PID, name: 'Vestido', sku: 'V1', barcode: '789', stock_qty: 7, price: '120.00', cost_price: '50.00', is_active: true };
const ENTRADA = { id: 'm1', product_id: PID, product_name: 'Vestido', type: 'in', quantity: 10, unit_cost: '50.00', notes: null };
const SUGESTAO = {
  id: PID, name: 'Cimento', unit: 'sc', stock_qty: '2', stock_min: '10', cost_price: '30.00',
  purchase_factor: null, last_supplier_name: 'Votoran', last_supplier_cnpj: null,
  last_supplier_phone: null, last_purchase_unit_cost: '32.00', supplier_id: null,
  supplier_name: null, supplier_cnpj: null, has_variants: false, variants_stock_total: '0',
  sold_30d: '20',
};
const PEDIDO_COMPRA = {
  id: 'po1', seq: 1, status: 'draft', supplier_name: 'Votoran', supplier_cnpj: null, supplier_phone: null,
  items: [{ product_id: PID, name: 'Cimento', unit: 'sc', quantity: 10, unit_cost_est: 32, received_qty: 0 }],
  total_est: '320.00', sent_at: null, received_at: null, received_invoice: null,
  created_at: '2026-11-01T10:00:00.000Z',
};
const RESUMO_COMPRA = { draft_count: 1, draft_total: '320.00', sent_count: 0, sent_total: '0', rec_count: 0, rec_total: '0' };
const ITEM_FOOD = { id: 'f1', name: 'X-Burger', price: '30.00', cost_price: '12.00', category_id: 'c1', is_active: true };
const INGREDIENTE = { id: 'r1', item_id: 'f1', ingredient_name: 'Pão', quantity: '1', unit_cost: '2.00', product_name: 'Pão', stock_unit_cost: '2.00' };
const MATERIAL = { id: PID, name: 'Resina', dental_category: 'resina', unit: 'un', cost_price: '80.00', stock_qty: 4, stock_min: 2, low_stock: false };

// papel: o que requireCompanyAccess lê. permissions: a linha do membro.
function banco({ papel, permissions }) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    const r = (rows) => Promise.resolve({ rows, rowCount: rows.length });
    if (/'owner' AS role/.test(s)) return r([{ role: papel }]);
    if (/cm\.role_label, cm\.permissions/.test(s)) {
      return r([{ is_owner: papel === 'owner', role_label: papel, permissions }]);
    }
    // bipe
    if (/p\.barcode=ANY\(\$2::text\[\]\) AND p\.is_active/.test(s)) return r([PRODUTO_BIPE]);
    if (/p\.barcode=ANY\(\$2\) OR p\.sku=ANY\(\$2\)/.test(s)) {
      const { variants, description, barcode_format, is_active, ...linha } = PRODUTO_BIPE;
      return r([linha]);
    }
    // venda
    if (/to_regclass\('public\.matcon_deliveries'\)/.test(s)) return r([{ ok: false }]);
    if (/SELECT s\.\*, u\.full_name AS user_seller_name/.test(s)) return r([VENDA]);
    if (/SELECT si\.\*, COALESCE\(p\.name, si\.product_name_snapshot\)/.test(s)) return r([ITEM_VENDA]);
    // fornecedor
    if (/FROM suppliers s WHERE id = \$1/.test(s)) return r([FORNECEDOR]);
    if (/FROM products WHERE supplier_id = \$1/.test(s)) return r([PRODUTO_FORNECEDOR]);
    if (/FROM stock_movements sm\s+LEFT JOIN products p/.test(s)) return r([ENTRADA]);
    // margem
    if (/AS custo_total/.test(s)) {
      return r([{ id: PID, name: 'Vestido', price: '120', cost_price: '50', category: 'Roupas', stock_qty: '7',
        vendas: 6, unidades: 6, faturamento: '720', custo_total: '300', lucro: '420', margem_pct: '58.3',
        preco_medio: '120', custo_medio: '50' }]);
    }
    // Matcon compras
    if (/WITH visiveis AS/.test(s)) return r([SUGESTAO]);
    if (/FROM matcon_purchase_orders/.test(s) && /draft_count/.test(s)) return r([RESUMO_COMPRA]);
    if (/FROM matcon_purchase_orders/.test(s)) return r([PEDIDO_COMPRA]);
    // food
    if (/SELECT id FROM food_items WHERE id=\$1 AND company_id=\$2/.test(s)) return r([{ id: 'f1' }]);
    if (/FROM food_recipes fr/.test(s)) return r([INGREDIENTE]);
    if (/SELECT price, name FROM food_items/.test(s)) return r([{ price: '30.00', name: 'X-Burger' }]);
    if (/AS ingredient_count/.test(s)) return r([{ ...ITEM_FOOD, margin_pct: '60.0', ingredient_count: '3' }]);
    // Odonto
    if (/p\.is_dental_supply = true/.test(s) && /AS last_movement_at/.test(s)) return r([MATERIAL]);
    if (/SELECT COUNT\(\*\) AS total FROM products p WHERE/.test(s)) return r([{ total: '1' }]);
    if (/COUNT\(\*\) FILTER \(WHERE stock_min > 0/.test(s)) return r([{ low_stock: '0', expired: '0', expiring_soon: '0' }]);
    // chat da Aura
    if (/SELECT plan FROM companies/.test(s)) return r([{ plan: 'negocio' }]);
    if (/SELECT name, stock_qty, stock_min, price FROM products/.test(s)) {
      return r([{ name: 'Vestido', stock_qty: 1, stock_min: 2, price: '120.00' }]);
    }
    if (/SUM\(stock_qty \* cost_price\)/.test(s)) return r([{ total: '10', valor_total: '3500.00' }]);
    if (/SELECT COUNT\(\*\) AS total FROM products WHERE company_id=\$1/.test(s)) return r([{ total: '10' }]);
    return r([]);
  });
}

const PERFIS_LIVRES = [
  ['dono', { papel: 'owner', permissions: null }],
  ['admin da empresa', { papel: 'admin', permissions: { estoque_consulta: true } }],
  ['membro com permissions null', { papel: 'colaborador', permissions: null }],
  ['membro comum com estoque e pdv', { papel: 'Gerente', permissions: { estoque: true, pdv: true } }],
];
const CONSULTA = { papel: 'Estoque', permissions: { estoque_consulta: true } };
const CONSULTA_COM_CAIXA = { papel: 'Caixa', permissions: { estoque_consulta: true, pdv: true } };

// Uma chamada de cada rota, com o plano que ela pede.
const ROTAS = {
  'GET /pdv/scan/:code': { plan: 'essencial', chamar: (a) => a.get(`${BASE}/pdv/scan/789`) },
  'POST /pdv/scan/batch': { plan: 'essencial', chamar: (a) => a.post(`${BASE}/pdv/scan/batch`).send({ codes: ['789'] }) },
  'GET /pdv/sale/:saleId': { plan: 'essencial', chamar: (a) => a.get(`${BASE}/pdv/sale/s1`) },
  'POST /pdv/troca': { plan: 'essencial', chamar: (a) => a.post(`${BASE}/pdv/troca`).send({ original_sale_ids: ['s1'] }) },
  'GET /suppliers/:sid': { plan: 'essencial', chamar: (a) => a.get(`${BASE}/suppliers/${SID}`) },
  'GET /matcon/purchase-suggestions': { plan: 'essencial', chamar: (a) => a.get(`${BASE}/matcon/purchase-suggestions`) },
  'GET /matcon/purchase-orders': { plan: 'essencial', chamar: (a) => a.get(`${BASE}/matcon/purchase-orders`) },
  'GET /food/items/:iid/recipe': { plan: 'negocio', chamar: (a) => a.get(`${BASE}/food/items/f1/recipe`) },
  'GET /food/recipes/summary': { plan: 'negocio', chamar: (a) => a.get(`${BASE}/food/recipes/summary`) },
  'GET /dental/supplies': { plan: 'negocio', chamar: (a) => a.get(`${BASE}/dental/supplies`) },
};

async function chamar(nome, perfil) {
  banco(perfil);
  const { plan, chamar: fn } = ROTAS[nome];
  return fn(request(app())).set('Authorization', `Bearer ${token(plan)}`);
}

// Resposta "de antes": a do dono. Os outros perfis livres têm que bater com
// ela; e ela tem que trazer o custo (prova de que a rota expunha).
const respostaDoDono = (nome) => chamar(nome, { papel: 'owner', permissions: null });

const CUSTO = /"(cost_price|unit_cost|unit_cost_est|est_cost|total_est|total_est_cost|last_purchase_unit_cost|stock_unit_cost|total_cost|margin_pct|margin_alert)"/;
const PRECO = /"(price|card_price|price_override|sale_price|effective_price)"/;

beforeEach(() => { db.query.mockReset(); });

describe.each(Object.keys(ROTAS))('%s', (nome) => {
  test('a rota devolve custo para o dono (era o vazamento)', async () => {
    const res = await respostaDoDono(nome);
    expect(res.status).toBeLessThan(300);
    expect(JSON.stringify(res.body)).toMatch(CUSTO);
  });

  test.each(PERFIS_LIVRES)('%s recebe a resposta idêntica à de antes', async (_rotulo, perfil) => {
    const antes = await respostaDoDono(nome);
    const res = await chamar(nome, perfil);
    expect(res.status).toBe(antes.status);
    expect(res.body).toEqual(antes.body);
  });

  test('consulta sem pdv: sem custo e sem preço, o resto igual', async () => {
    const antes = await respostaDoDono(nome);
    const res = await chamar(nome, CONSULTA);
    expect(res.status).toBe(antes.status);
    const txt = JSON.stringify(res.body);
    expect(txt).not.toMatch(CUSTO);
    expect(txt).not.toMatch(PRECO);
  });

  test('consulta com pdv: perde só o custo', async () => {
    const antes = await respostaDoDono(nome);
    const res = await chamar(nome, CONSULTA_COM_CAIXA);
    expect(res.status).toBe(antes.status);
    expect(JSON.stringify(res.body)).not.toMatch(CUSTO);
  });
});

describe('o que a tela usa continua lá', () => {
  test('bipe com pdv: preço, preço no cartão e price_override da variante', async () => {
    const res = await chamar('GET /pdv/scan/:code', CONSULTA_COM_CAIXA);
    expect(res.body.product).toMatchObject({ name: 'Vestido', price: '120.00', card_price: '130.00', stock_qty: '7' });
    expect(res.body.product.variants[0]).toMatchObject({ price_override: '125.00', stock_qty: 3 });
    expect(res.body.product).not.toHaveProperty('cost_price');
  });

  test('venda com pdv: total e preço do item ficam, unit_cost sai', async () => {
    const res = await chamar('GET /pdv/sale/:saleId', CONSULTA_COM_CAIXA);
    expect(res.body).toMatchObject({ total_amount: '120.00' });
    expect(res.body.items[0]).toMatchObject({ unit_price: '120.00', total_price: '120.00', quantity: '1' });
    expect(res.body.items[0]).not.toHaveProperty('unit_cost');
  });

  test('troca com pdv: valores da troca ficam, unit_cost sai', async () => {
    const res = await chamar('POST /pdv/troca', CONSULTA_COM_CAIXA);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ net_amount: 20, sale: { total_amount: 120 } });
    expect(res.body.new_items[0]).toEqual({ id: 'i9', unit_price: 120, total_price: 120 });
  });

  test('Matcon compras: quantidades ficam, total do pedido sai', async () => {
    const sug = await chamar('GET /matcon/purchase-suggestions', CONSULTA);
    expect(sug.body.suggestions[0]).toMatchObject({ name: 'Cimento', stock: 2, min_stock: 10, suggested_qty: expect.any(Number) });
    expect(sug.body.summary).toEqual({ items_below_min: 1, suppliers: 1 });

    const ped = await chamar('GET /matcon/purchase-orders', CONSULTA);
    expect(ped.body.orders[0].items[0]).toEqual({ product_id: PID, name: 'Cimento', unit: 'sc', quantity: 10, received_qty: 0 });
    expect(ped.body.summary.draft).toEqual({ count: 1 });
  });

  test('o "total" dos pedidos de compra continua para o dono', async () => {
    const ped = await respostaDoDono('GET /matcon/purchase-orders');
    expect(ped.body.summary.draft).toEqual({ count: 1, total: 320 });
  });

  test('fornecedor: produtos e quantidades das entradas ficam', async () => {
    const res = await chamar('GET /suppliers/:sid', CONSULTA);
    expect(res.body).toMatchObject({ name: 'Malharia', product_count: 1 });
    expect(res.body.products[0]).toEqual({ id: PID, name: 'Vestido', sku: 'V1', barcode: '789', stock_qty: 7, is_active: true });
    expect(res.body.recent_stock_movements[0]).toMatchObject({ quantity: 10, type: 'in' });
  });
});

describe('GET /margin (Expansão)', () => {
  const margem = () => request(app()).get(`${BASE}/margin`).set('Authorization', `Bearer ${token('expansao')}`);

  test.each(PERFIS_LIVRES)('%s continua recebendo a margem', async (_rotulo, perfil) => {
    banco(perfil);
    const res = await margem();
    expect(res.status).toBe(200);
    expect(res.body.products[0]).toMatchObject({ cost_price: 50, lucro: 420, margem_pct: 58.3 });
  });

  test.each([['sem pdv', CONSULTA], ['com pdv', CONSULTA_COM_CAIXA]])('consulta %s: 403', async (_r, perfil) => {
    banco(perfil);
    const res = await margem();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ESTOQUE_SO_CONSULTA');
    expect(JSON.stringify(res.body)).not.toMatch(/cost_price|lucro|margem/);
  });
});

describe('chat da Aura (aiContext)', () => {
  let prompts;
  beforeEach(() => {
    prompts = [];
    global.fetch = jest.fn(async (_url, init) => {
      prompts.push(JSON.parse(init.body).system);
      return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
    });
  });
  afterAll(() => { delete global.fetch; });

  const perguntar = (perfil) => {
    banco(perfil);
    return request(app()).post(`${BASE}/ai/chat`)
      .set('Authorization', `Bearer ${token('negocio')}`)
      .send({ message: 'Quanto vale meu estoque?', context: 'estoque' });
  };

  test.each(PERFIS_LIVRES)('%s: prompt idêntico ao de antes, com valor do estoque', async (_rotulo, perfil) => {
    await perguntar({ papel: 'owner', permissions: null });
    await perguntar(perfil);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[0]).toMatch(/"valor_estoque": 3500/);
    expect(prompts[0]).toMatch(/"preco": 120/);
    expect(prompts[0]).not.toMatch(/ACESSO DESTE USUARIO/);
  });

  test('consulta sem pdv: sem valor do estoque, sem preço e com a instrução', async () => {
    const res = await perguntar(CONSULTA);
    expect(res.status).toBe(200);
    const p = prompts[0];
    expect(p).not.toMatch(/valor_estoque|3500/);
    expect(p).not.toMatch(/"preco"/);
    expect(p).toMatch(/"total_produtos": 10/);
    expect(p).toMatch(/ACESSO DESTE USUARIO: so consulta de estoque/);
    expect(p).toMatch(/preco de venda/);
    // nem a conta do valor chega a ser feita
    expect(db.query.mock.calls.some(([s]) => /cost_price/.test(String(s)))).toBe(false);
  });

  test('consulta com pdv: mantém o preço, perde o valor do estoque', async () => {
    await perguntar(CONSULTA_COM_CAIXA);
    const p = prompts[0];
    expect(p).not.toMatch(/valor_estoque|3500/);
    expect(p).toMatch(/"preco": 120/);
    expect(p).toMatch(/ACESSO DESTE USUARIO/);
    expect(p).not.toMatch(/preco de venda/);
  });
});

test('falha ao ler a permissão no Caixa não derruba o bipe e não solta custo', async () => {
  banco(CONSULTA);
  const base = db.query.getMockImplementation();
  db.query.mockImplementation((sql) => (
    /cm\.role_label, cm\.permissions/.test(String(sql)) ? Promise.reject(new Error('conexao caiu')) : base(sql)
  ));
  const res = await request(app()).get(`${BASE}/pdv/scan/789`).set('Authorization', `Bearer ${token('essencial')}`);
  expect(res.status).toBe(200);
  expect(res.body.product).toMatchObject({ price: '120.00', card_price: '130.00' });
  expect(res.body.product).not.toHaveProperty('cost_price');
});

test('semValores: extras só valem quando pedidos', () => {
  const corpo = { summary: { total: 10, count: 1 } };
  expect(semValores(corpo, false)).toEqual(corpo);
  expect(semValores(corpo, false, new Set(['total']))).toEqual({ summary: { count: 1 } });
});
