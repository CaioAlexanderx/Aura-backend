// ============================================================
// Studio · catálogo do modal do orçamento (29/09/2026, migration 364)
//
// O que os testes seguram:
//   - "Mais usados" e "Recentes" saem de orçamentos e pedidos Studio DA
//     EMPRESA da rota (multi-CNPJ), sem contar duas vezes o pedido que
//     nasceu de orçamento;
//   - a rota não é engolida por /quotes/:qid;
//   - visual_template_key do item: aceito no POST e no PATCH, null quando
//     vazio ou em item avulso (null = herda do produto), e volta no GET.
//
// Mock do db por CONTEÚDO DO SQL, nunca por ordem de chamada.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const regras = require('../src/services/produtosFrequentesDoOrcamento');
const rotaQuotes = require('../src/routes/studioQuotes');

const CID = 'c0000000-0000-0000-0000-000000000001';
const QID = 'q0000000-0000-0000-0000-000000000001';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
  a.use('/companies/:id/studio', rotaQuotes);
  return a;
}

function clienteQueGrava() {
  const chamadas = [];
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      chamadas.push({ s, params });
      if (/INSERT INTO studio_quotes/.test(s)) return { rows: [{ id: QID, company_id: CID, status: 'draft' }] };
      if (/UPDATE studio_quotes/.test(s)) return { rows: [{ id: QID, company_id: CID, status: 'draft' }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  }));
  return chamadas;
}

describe('regras puras', () => {
  test('dias e limite ficam dentro da faixa', () => {
    expect(regras.lerDias(undefined)).toBe(90);
    expect(regras.lerDias('1')).toBe(7);
    expect(regras.lerDias('9999')).toBe(365);
    expect(regras.lerLimite(undefined)).toBe(8);
    expect(regras.lerLimite('0')).toBe(1);
    expect(regras.lerLimite('50')).toBe(20);
  });

  test('mais usados por contagem (desempate pelo mais recente) e recentes pelo último uso', () => {
    const linhas = [
      { product_id: 'p1', usos: 3, ultima_vez: '2026-09-01T10:00:00Z' },
      { product_id: 'p2', usos: 5, ultima_vez: '2026-08-01T10:00:00Z' },
      { product_id: 'p3', usos: 3, ultima_vez: '2026-09-20T10:00:00Z' },
      { product_id: 'p4', usos: 1, ultima_vez: '2026-09-28T10:00:00Z' },
      { product_id: null, usos: 9, ultima_vez: '2026-09-28T10:00:00Z' },
    ];
    const r = regras.listasDeProdutosFrequentes(linhas, 3);
    expect(r.mais_usados.map((x) => x.product_id)).toEqual(['p2', 'p3', 'p1']);
    expect(r.recentes.map((x) => x.product_id)).toEqual(['p4', 'p3', 'p1']);
    expect(r.mais_usados[0]).toEqual({ product_id: 'p2', usos: 5, ultima_vez: '2026-08-01T10:00:00.000Z' });
  });

  test('modelo do item: texto aparado, vazio ou estranho vira null (herda do produto)', () => {
    expect(regras.lerModeloDoItem(' caneca-3d ')).toBe('caneca-3d');
    expect(regras.lerModeloDoItem('')).toBeNull();
    expect(regras.lerModeloDoItem('   ')).toBeNull();
    expect(regras.lerModeloDoItem(null)).toBeNull();
    expect(regras.lerModeloDoItem(42)).toBeNull();
    expect(regras.lerModeloDoItem('x'.repeat(121))).toBeNull();
  });
});

describe('GET /quotes/produtos-frequentes', () => {
  test('filtra pela empresa da rota e devolve as duas listas', async () => {
    const sqls = [];
    db.query.mockReset();
    db.query.mockImplementation(async (sql, params) => {
      sqls.push({ s: String(sql), params });
      if (/WITH usos AS/.test(String(sql))) {
        return { rows: [
          { product_id: 'p1', usos: 4, ultima_vez: '2026-09-10T10:00:00Z' },
          { product_id: 'p2', usos: 1, ultima_vez: '2026-09-28T10:00:00Z' },
        ] };
      }
      return { rows: [] };
    });
    const r = await request(app()).get(`/companies/${CID}/studio/quotes/produtos-frequentes?days=30&limit=5`);
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(30);
    expect(r.body.mais_usados.map((x) => x.product_id)).toEqual(['p1', 'p2']);
    expect(r.body.recentes.map((x) => x.product_id)).toEqual(['p2', 'p1']);

    expect(sqls).toHaveLength(1);
    const { s, params } = sqls[0];
    expect(params).toEqual([CID, '30']);
    // Multi-CNPJ nas duas fontes e no filtro do pedido que veio de orçamento.
    expect(s).toMatch(/WHERE q\.company_id = \$1/);
    expect(s).toMatch(/WHERE o\.company_id = \$1/);
    expect(s).toMatch(/o\.vertical = 'studio'/);
    expect(s).toMatch(/q2\.order_id = o\.id AND q2\.company_id = \$1/);
    // Não caiu no GET /quotes/:qid.
    expect(s).not.toMatch(/SELECT \* FROM studio_quotes/);
  });

  test('erro do banco vira 500 com mensagem em português', async () => {
    db.query.mockReset();
    db.query.mockRejectedValue(new Error('boom'));
    const r = await request(app()).get(`/companies/${CID}/studio/quotes/produtos-frequentes`);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/mais usados/);
  });
});

describe('visual_template_key do item', () => {
  test('POST grava o modelo do item; vazio e item avulso ficam null', async () => {
    const chamadas = clienteQueGrava();
    const r = await request(app()).post(`/companies/${CID}/studio/quotes`).send({
      items: [
        { product_id: 'p1', description: 'Caneca', quantity: 2, unit_price: 39.9, visual_template_key: 'caneca-magica' },
        { product_id: 'p2', description: 'Camiseta', quantity: 1, unit_price: 59.9, visual_template_key: '' },
        { product_id: null, description: 'Arte extra', quantity: 1, unit_price: 20, visual_template_key: 'caneca-magica' },
      ],
    });
    expect(r.status).toBe(201);
    const itens = chamadas.filter((c) => /INSERT INTO studio_quote_items/.test(c.s));
    expect(itens).toHaveLength(3);
    expect(itens[0].s).toMatch(/visual_template_key/);
    expect(itens.map((c) => c.params[9])).toEqual(['caneca-magica', null, null]);
    expect(itens[0].params[0]).toBe(QID);
  });

  test('PATCH regrava os itens com o modelo de cada um', async () => {
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM studio_quotes WHERE id = \$1 AND company_id = \$2/.test(String(sql))) {
        return { rows: [{ id: QID, company_id: CID, status: 'draft', subtotal: '0', discount: '0', total: '0', validity_days: 7 }] };
      }
      return { rows: [] };
    });
    const chamadas = clienteQueGrava();
    const r = await request(app()).patch(`/companies/${CID}/studio/quotes/${QID}`).send({
      items: [
        { product_id: 'p1', description: 'Caneca', quantity: 12, unit_price: 39.9, visual_template_key: 'caneca-classica' },
        { product_id: 'p2', description: 'Camiseta', quantity: 1, unit_price: 59.9 },
      ],
    });
    expect(r.status).toBe(200);
    const itens = chamadas.filter((c) => /INSERT INTO studio_quote_items/.test(c.s));
    expect(itens.map((c) => c.params[9])).toEqual(['caneca-classica', null]);
    expect(chamadas.find((c) => /DELETE FROM studio_quote_items/.test(c.s)).params).toEqual([QID]);
  });

  test('GET /quotes/:qid devolve o modelo de cada item', async () => {
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM studio_quotes\s+WHERE id = \$1 AND company_id = \$2/.test(s)) return { rows: [{ id: QID, company_id: CID, status: 'draft' }] };
      if (/FROM studio_quote_items/.test(s)) {
        return { rows: [
          { id: 'i1', product_id: 'p1', description: 'Caneca', quantity: '12', unit_price: '39.90', visual_template_key: 'caneca-magica' },
          { id: 'i2', product_id: 'p2', description: 'Camiseta', quantity: '1', unit_price: '59.90', visual_template_key: null },
        ] };
      }
      return { rows: [] };
    });
    const r = await request(app()).get(`/companies/${CID}/studio/quotes/${QID}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.visual_template_key)).toEqual(['caneca-magica', null]);
  });
});
