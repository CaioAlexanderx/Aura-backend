// ============================================================
// Loja comum: tem_personalizavel e a excecao do estoque (p-179, loja
// unica 3.2a, 17/11/2026)
//
//   1. tem_personalizavel vem da MESMA consulta da contagem do catalogo
//      (nenhuma ida a mais ao banco) e so entra no payload quando e
//      verdadeiro: loja sem personalizavel recebe o payload de antes
//      (a prova byte a byte esta em lojaSemPersonalizavel.fixture.test.js);
//   2. o personalizavel nao passa pelo estoque (EM_ESTOQUE) e nao cai em
//      "Ultimas unidades"; para os outros produtos o fragmento e o de
//      antes, no mesmo CASE;
//   3. a home lembrada (60 s) e por loja: a variante com personalizavel
//      nunca e servida para outra loja, nem com outra CSP.
// O comportamento no Postgres de verdade: lojaTemPersonalizavel.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const { EM_ESTOQUE, PERSONALIZAVEL } = require('../src/services/catalogoPaginado');
const { buildStorefront } = require('../src/services/storefrontBuilder');
const { esquecerPagina } = require('../src/services/cacheDaPaginaDaLoja');
const storefront = require('../src/routes/storefront');

const CID_COM = '0b1a0000-0000-4000-8000-0000000000a1';
const CID_SEM = '0b1a0000-0000-4000-8000-0000000000a2';
const LOJAS = {
  'com-personalizavel': { company_id: CID_COM, slug: 'com-personalizavel', site_name: 'Com', is_published: true, company_pdv_settings: {} },
  'sem-personalizavel': { company_id: CID_SEM, slug: 'sem-personalizavel', site_name: 'Sem', is_published: true, company_pdv_settings: {} },
};

let consultas;
function banco({ temPersonalizavel } = {}) {
  consultas = [];
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    consultas.push(s);
    const cabeca = s.split(' WHERE ')[0];
    if (cabeca.includes('company_pdv_settings') || cabeca === 'SELECT * FROM digital_channel_config') {
      return { rows: LOJAS[params[0]] ? [LOJAS[params[0]]] : [] };
    }
    if (s.includes('COUNT(*)::int AS n') && s.includes('AS tem_personalizavel')) {
      const tem = typeof temPersonalizavel === 'function' ? temPersonalizavel(params[0]) : !!temPersonalizavel;
      return { rows: [{ n: 7, tem_personalizavel: tem }] };
    }
    return { rows: [] };
  });
}

const app = express();
app.use('/api/v1/storefront', storefront);

beforeEach(() => {
  esquecerPagina();
  db.query.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('tem_personalizavel no builder', () => {
  test('loja com personalizavel: a chave entra no payload', async () => {
    banco({ temPersonalizavel: true });
    const out = await buildStorefront(LOJAS['com-personalizavel']);
    expect(out.tem_personalizavel).toBe(true);
    expect(out.catalog_total).toBe(7);
  });

  test('loja sem personalizavel: a chave nao existe', async () => {
    banco({ temPersonalizavel: false });
    const out = await buildStorefront(LOJAS['sem-personalizavel']);
    expect(out).not.toHaveProperty('tem_personalizavel');
    expect(out.catalog_total).toBe(7);
  });

  test('vem da consulta da contagem, sem ida a mais ao banco', async () => {
    banco({ temPersonalizavel: false });
    await buildStorefront(LOJAS['sem-personalizavel']);
    const semFlag = consultas.length;
    banco({ temPersonalizavel: true });
    await buildStorefront(LOJAS['com-personalizavel']);
    expect(consultas.length).toBe(semFlag);
    const contagem = consultas.filter((s) => s.includes('AS tem_personalizavel'));
    expect(contagem).toHaveLength(1);
    expect(contagem[0]).toContain('COUNT(*)::int AS n');
  });

  test('so conta personalizavel com configurador, ativo e visivel na vitrine', async () => {
    banco({ temPersonalizavel: false });
    await buildStorefront(LOJAS['sem-personalizavel']);
    const s = consultas.find((q) => q.includes('AS tem_personalizavel'));
    expect(s).toContain('bool_or(');
    expect(s).toContain('products.is_personalizable IS TRUE AND products.customization_config IS NOT NULL');
    expect(s).toContain('is_active IS NOT FALSE');
    expect(s).toContain('dch.hidden_product_ids'); // NA_VITRINE
  });

  test('a contagem que falha nao liga o personalizavel', async () => {
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes('AS tem_personalizavel')) throw Object.assign(new Error('x'), { code: '57014' });
      return { rows: [] };
    });
    const out = await buildStorefront(LOJAS['com-personalizavel']);
    expect(out).not.toHaveProperty('tem_personalizavel');
    expect(out.catalog_total).toBe(0);
  });
});

describe('a excecao do estoque', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  test('o personalizavel e o primeiro ramo; o resto e o CASE de sempre', () => {
    const antes = `CASE WHEN EXISTS ( SELECT 1 FROM product_variants v WHERE v.product_id = products.id AND v.is_active = true ) THEN EXISTS ( SELECT 1 FROM product_variants v WHERE v.product_id = products.id AND v.is_active = true AND v.stock_qty > 0 ) ELSE products.stock_qty > 0 END`;
    expect(norm(EM_ESTOQUE)).toBe(`( ${norm(PERSONALIZAVEL)} OR ${antes} )`);
  });

  test('personalizavel e is_personalizable E customization_config, nada mais', () => {
    expect(norm(PERSONALIZAVEL)).toBe('( products.is_personalizable IS TRUE AND products.customization_config IS NOT NULL )');
  });

  test('"Ultimas unidades" deixa o personalizavel de fora', async () => {
    banco({ temPersonalizavel: true });
    await buildStorefront(LOJAS['com-personalizavel']);
    const ultimas = consultas.find((s) => s.includes(' AS restam'));
    expect(ultimas).toContain(`AND NOT ${norm(PERSONALIZAVEL)}`);
    // Os outros blocos da home nao ganham filtro: o personalizavel vendido
    // aparece em "Mais vendidos", o recem-cadastrado em "Novidades".
    const outros = consultas.filter((s) => s.includes('stock_min') && !s.includes(' AS restam'));
    expect(outros.length).toBeGreaterThan(0);
    outros.forEach((s) => expect(s).not.toContain('AND NOT ( products.is_personalizable'));
  });
});

describe('a home lembrada por 60 s', () => {
  const tem = (cid) => cid === CID_COM;

  test('cada loja recebe a propria pagina, com a mesma CSP na memoria e na hora', async () => {
    banco({ temPersonalizavel: tem });
    const com1 = await request(app).get('/api/v1/storefront/com-personalizavel/page');
    const sem1 = await request(app).get('/api/v1/storefront/sem-personalizavel/page');
    const com2 = await request(app).get('/api/v1/storefront/com-personalizavel/page');
    const sem2 = await request(app).get('/api/v1/storefront/sem-personalizavel/page');
    expect([com1, sem1].map((r) => r.headers['x-aura-cache'])).toEqual(['miss', 'miss']);
    expect([com2, sem2].map((r) => r.headers['x-aura-cache'])).toEqual(['hit', 'hit']);
    expect(com2.text).toBe(com1.text);
    expect(sem2.text).toBe(sem1.text);
    expect(com1.text).toContain('Com');
    expect(sem1.text).not.toBe(com1.text);
    expect(com2.headers['content-security-policy']).toBe(com1.headers['content-security-policy']);
    expect(sem2.headers['content-security-policy']).toBe(sem1.headers['content-security-policy']);
  });

  test('o payload JSON leva a chave so na loja com personalizavel', async () => {
    banco({ temPersonalizavel: tem });
    const com = await request(app).get('/api/v1/storefront/com-personalizavel');
    const sem = await request(app).get('/api/v1/storefront/sem-personalizavel');
    expect(com.body.tem_personalizavel).toBe(true);
    expect(sem.body).not.toHaveProperty('tem_personalizavel');
  });
});
