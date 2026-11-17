// ============================================================
// AURA. — Folha "Recolher a arte e o texto" (p-177): rota do backend
//
// GET/POST /companies/:id/studio/orders/:oid/personalizacao
//
// O que trava:
//   1. o corpo: itens com id e customization (objeto), sem repetição;
//   2. o pedido é da empresa (view studio_orders) e não é de marketplace
//      nem cancelado;
//   3. grava a customization de cada item, com a mesma limpeza das chaves
//      de ajuste do PATCH do Studio, e move "Aguardando personalização"
//      para "Aguardando arte" na MESMA transação;
//   4. com peça personalizável sem arte nem texto, não grava nada (422);
//   5. pedido que já andou de etapa só tem a arte corrigida, não volta nem
//      avança; `avancar: false` só guarda.
// Mock por conteúdo do SQL, nunca por fila.
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

const express = require('express');
const request = require('supertest');
const router = require('../src/routes/studioPersonalizacaoDoPedido');
const { temPersonalizacao, lerCorpo } = router._internals;

const app = express();
app.use(express.json());
app.use('/companies/:id/studio', router);

const CID = '11111111-1111-1111-1111-111111111111';
const OID = '22222222-2222-2222-2222-222222222222';
const IT1 = '33333333-3333-3333-3333-333333333331';
const IT2 = '33333333-3333-3333-3333-333333333332';
const url = `/companies/${CID}/studio/orders/${OID}/personalizacao`;

const CONFIG = {
  fields: [
    { id: 'nome', type: 'text', label: 'Nome' },
    { id: 'arte', type: 'image', label: 'Sua arte' },
  ],
};

function headPdv(extra = {}) {
  return {
    id: OID, source: 'pdv', status: 'completed', studio_production_status: 'awaiting_customization',
    customer_name: 'Rafael', display_name: 'PDV-22222222', digital_order_id: null, pdv_sale_id: OID, ...extra,
  };
}

function itensPdv() {
  return [
    { id: IT1, product_id: 'p1', product_name: 'Caneca com nome', quantity: '1', customization: null, is_personalizable: true, customization_config: CONFIG },
    { id: IT2, product_id: 'p2', product_name: 'Sacola', quantity: '2', customization: null, is_personalizable: false, customization_config: null },
  ];
}

let client;
function montar({ head = headPdv(), itens = itensPdv(), etapa = 'awaiting_customization', travar = true } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM studio_orders/.test(sql)) return { rows: head ? [head] : [] };
    if (/FROM sale_items si/.test(sql) || /FROM digital_order_items doi/.test(sql)) return { rows: itens };
    return { rows: [] };
  });
  const queries = [];
  client = {
    queries,
    query: jest.fn(async (sql, params) => {
      queries.push({ sql: String(sql), params });
      const s = String(sql);
      if (/FOR UPDATE/.test(s)) return { rows: travar ? [{ id: OID, studio_production_status: etapa, status: head && head.status }] : [] };
      if (/FROM sale_items si/.test(s) || /FROM digital_order_items doi/.test(s)) return { rows: itens.map((r) => ({ ...r })) };
      if (/SET studio_production_status = 'pending_art'/.test(s)) {
        return { rows: etapa === 'awaiting_customization' ? [{ studio_production_status: 'pending_art' }] : [] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  db.connect.mockResolvedValue(client);
}

const sqls = () => client.queries.map((q) => q.sql);
const gravacoes = () => client.queries.filter((q) => /customization = \$1::jsonb/.test(q.sql));

beforeEach(() => {
  jest.resetAllMocks();
});

describe('regras puras', () => {
  test('arte ou texto de um campo do produto conta como personalização', () => {
    expect(temPersonalizacao({ nome: 'Ana' }, CONFIG)).toBe(true);
    expect(temPersonalizacao({ arte: 'https://cdn/arte.png' }, CONFIG)).toBe(true);
    expect(temPersonalizacao({ nome: '   ' }, CONFIG)).toBe(false);
    expect(temPersonalizacao({ has_back_selected: true }, CONFIG)).toBe(false);
    expect(temPersonalizacao({ outro: 'x' }, CONFIG)).toBe(false);
    expect(temPersonalizacao(null, CONFIG)).toBe(false);
  });

  test('sem os campos do produto, qualquer texto não vazio conta', () => {
    expect(temPersonalizacao({ texto: 'Feliz aniversário' }, null)).toBe(true);
    expect(temPersonalizacao({ flag: true }, null)).toBe(false);
  });

  test('avancar vale true quando não vem', () => {
    expect(lerCorpo({ itens: [{ id: IT1, customization: {} }] }).avancar).toBe(true);
    expect(lerCorpo({ itens: [{ id: IT1, customization: {} }], avancar: false }).avancar).toBe(false);
  });
});

describe('POST: corpo inválido', () => {
  test.each([
    [{}, 'ITENS_OBRIGATORIOS'],
    [{ itens: [] }, 'ITENS_OBRIGATORIOS'],
    [{ itens: [{ customization: {} }] }, 'ITEM_SEM_ID'],
    [{ itens: [{ id: IT1, customization: 'Ana' }] }, 'CUSTOMIZATION_INVALIDA'],
    [{ itens: [{ id: IT1, customization: ['Ana'] }] }, 'CUSTOMIZATION_INVALIDA'],
    [{ itens: [{ id: IT1, customization: {} }, { id: IT1, customization: {} }] }, 'ITEM_REPETIDO'],
  ])('%j -> 400 %s', async (body, code) => {
    montar();
    const r = await request(app).post(url).send(body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(code);
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('POST: pedido', () => {
  test('pedido de outra empresa ou inexistente: 404, sem transação', async () => {
    montar({ head: null });
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(404);
    expect(db.connect).not.toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND company_id = \$2/);
    expect(params).toEqual([OID, CID]);
  });

  test('marketplace usa a rota dele', async () => {
    montar({ head: headPdv({ source: 'marketplace', pdv_sale_id: null }) });
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('MARKETPLACE_USA_OUTRA_ROTA');
  });

  test('pedido da loja online cancelado não recebe arte', async () => {
    montar({ head: headPdv({ source: 'digital', status: 'cancelled', digital_order_id: OID, pdv_sale_id: null }) });
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('order_cancelled');
  });

  test('item de outro pedido: 404 e nada gravado', async () => {
    montar();
    const r = await request(app).post(url).send({ itens: [{ id: 'nao-e-daqui', customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('ITEM_FORA_DO_PEDIDO');
    expect(r.body.itens).toEqual(['nao-e-daqui']);
    expect(gravacoes()).toHaveLength(0);
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('POST: grava e move a etapa', () => {
  test('venda do Caixa: grava a arte e o texto e vai para Aguardando arte, numa transação', async () => {
    montar();
    const r = await request(app).post(url).send({
      itens: [{ id: IT1, customization: { nome: 'Ana', arte: 'https://cdn/arte.png' } }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true, order_id: OID, source: 'pdv', studio_production_status: 'pending_art', avancou: true, faltam: [],
    });
    const s = sqls();
    expect(s[0]).toBe('BEGIN');
    // trava a venda da empresa antes de ler os itens
    expect(s[1]).toMatch(/FROM sales[\s\S]*company_id = \$2[\s\S]*FOR UPDATE/);
    expect(client.queries[1].params).toEqual([OID, CID]);
    // grava só o item enviado, no pedido certo
    expect(gravacoes()).toHaveLength(1);
    expect(gravacoes()[0].sql).toMatch(/UPDATE sale_items .* WHERE id = \$2 AND sale_id = \$3/);
    expect(JSON.parse(gravacoes()[0].params[0])).toEqual({ nome: 'Ana', arte: 'https://cdn/arte.png' });
    expect(gravacoes()[0].params.slice(1)).toEqual([IT1, OID]);
    // a etapa só sai de awaiting_customization
    const mov = client.queries.find((q) => /SET studio_production_status = 'pending_art'/.test(q.sql));
    expect(mov.sql).toMatch(/UPDATE sales/);
    expect(mov.sql).toMatch(/studio_production_status = 'awaiting_customization'/);
    expect(mov.params).toEqual([OID, CID]);
    expect(s[s.length - 1]).toBe('COMMIT');
    // a resposta devolve os itens com a arte e o que falta
    const item = r.body.itens.find((i) => i.id === IT1);
    expect(item).toMatchObject({ product_name: 'Caneca com nome', quantity: 1, is_personalizable: true, tem_personalizacao: true });
  });

  test('a limpeza das chaves de ajuste é a mesma do PATCH do Studio', async () => {
    montar();
    await request(app).post(url).send({
      itens: [{ id: IT1, customization: { nome: 'Ana', nome_tam: 'GIGANTE', arte_ajuste: { v: 1, cx: 0.5, cy: 0.5, rot: 45 } } }],
    });
    const gravado = JSON.parse(gravacoes()[0].params[0]);
    expect(gravado.nome).toBe('Ana');
    expect(gravado).not.toHaveProperty('nome_tam');
    expect(gravado.arte_ajuste.rot).toBe(0);
  });

  test('peça personalizável sem arte nem texto: 422 e nada gravado', async () => {
    montar();
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: '' } }] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('FALTA_PERSONALIZACAO');
    expect(r.body.faltam).toEqual([IT1]);
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(sqls().some((x) => /SET studio_production_status/.test(x))).toBe(false);
  });

  test('item que não é personalizável não é cobrado', async () => {
    montar();
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(200);
    expect(r.body.faltam).toEqual([]);
  });

  test('avancar false só guarda, mesmo faltando peça', async () => {
    montar();
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: '' } }], avancar: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ avancou: false, studio_production_status: 'awaiting_customization', faltam: [IT1] });
    expect(gravacoes()).toHaveLength(1);
    expect(sqls().some((x) => /SET studio_production_status/.test(x))).toBe(false);
    expect(sqls()).toContain('COMMIT');
  });

  test('pedido que já andou: corrige a arte e fica na etapa', async () => {
    montar({ etapa: 'in_production' });
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ avancou: false, studio_production_status: 'in_production' });
    expect(sqls().some((x) => /SET studio_production_status/.test(x))).toBe(false);
  });

  test('loja online: grava em digital_order_items e move digital_orders', async () => {
    montar({ head: headPdv({ source: 'digital', status: 'confirmed', digital_order_id: OID, pdv_sale_id: null }) });
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { arte: 'https://cdn/a.png' } }] });
    expect(r.status).toBe(200);
    expect(r.body.studio_production_status).toBe('pending_art');
    expect(sqls()[1]).toMatch(/FROM digital_orders[\s\S]*vertical = 'studio'[\s\S]*FOR UPDATE/);
    expect(gravacoes()[0].sql).toMatch(/UPDATE digital_order_items .* AND order_id = \$3/);
    const mov = client.queries.find((q) => /SET studio_production_status = 'pending_art'/.test(q.sql));
    expect(mov.sql).toMatch(/UPDATE digital_orders/);
  });

  test('id numérico (digital_order_items é bigint) casa com o texto', async () => {
    const itens = [{ ...itensPdv()[0], id: '42' }];
    montar({ head: headPdv({ source: 'digital', status: 'confirmed', digital_order_id: OID, pdv_sale_id: null }), itens });
    const r = await request(app).post(url).send({ itens: [{ id: 42, customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(200);
    expect(gravacoes()[0].params[1]).toBe('42');
  });

  test('erro no meio: ROLLBACK, 500 e conexão devolvida', async () => {
    montar();
    client.query.mockImplementation(async (sql) => {
      if (/FOR UPDATE/.test(sql)) throw new Error('boom');
      return { rows: [] };
    });
    const r = await request(app).post(url).send({ itens: [{ id: IT1, customization: { nome: 'Ana' } }] });
    expect(r.status).toBe(500);
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('GET: o que a folha mostra', () => {
  test('itens com campos do produto, a arte já gravada e o que falta', async () => {
    montar();
    const r = await request(app).get(url);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ id: OID, source: 'pdv', studio_production_status: 'awaiting_customization' });
    expect(r.body.itens).toHaveLength(2);
    expect(r.body.itens[0]).toMatchObject({
      id: IT1, product_name: 'Caneca com nome', quantity: 1, is_personalizable: true,
      customization_config: CONFIG, customization: null, tem_personalizacao: false,
    });
    expect(r.body.itens[1]).toMatchObject({ id: IT2, is_personalizable: false, customization_config: null });
    expect(r.body.faltam).toEqual([IT1]);
    // só leitura: nenhuma transação
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('pedido de outra empresa: 404', async () => {
    montar({ head: null });
    const r = await request(app).get(url);
    expect(r.status).toBe(404);
  });
});
