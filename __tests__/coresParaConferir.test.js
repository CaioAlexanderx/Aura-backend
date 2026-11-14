// ============================================================
// AURA. — Nomes de cor para conferir (CP5 da revisão de cores, 14/11/2026)
// Regras puras + rotas com o banco simulado. O caminho com Postgres está em
// coresParaConferir.banco.test.js.
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');
const {
  pedacoDaVariante, sugerir, agrupar, lerConfirmacao,
} = require('../src/services/coresParaConferir');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const v = (o) => ({ product_id: P1, product_name: 'Vestido', company_id: 'c1', variant_id: 'v', color_name: null, sku_suffix: null, hex: '#1F2A44', tamanho: 'M', ...o });

describe('pedacoDaVariante', () => {
  test.each([
    [{ color_name: 'AZUL ESCUR' }, { pedaco: 'AZUL ESCUR', tipo: 'cortado', origem: 'color_name' }],
    [{ color_name: 'OFF WHITE' }, { pedaco: 'OFF WHITE', tipo: 'maiusculo', origem: 'color_name' }],
    [{ color_name: null, sku_suffix: 'AZUL ESCUR-M' }, { pedaco: 'AZUL ESCUR', tipo: 'cortado', origem: 'sufixo' }],
  ])('%p', (extra, esperado) => {
    expect(pedacoDaVariante(v(extra))).toEqual(esperado);
  });
  test.each([
    [{ color_name: 'Off White' }],          // nome de verdade
    [{ color_name: null, sku_suffix: 'CAQUI-M' }],   // sufixo curto: o Caixa já lê
    [{ color_name: null, sku_suffix: '1F2A44-M' }],  // hex
    [{ color_name: 'FFFFF' }],               // hex de 5 dígitos do lote antigo
    [{ color_name: 'AZUL ESCUR', hex: 'Azul' }],     // cor sem hex
  ])('fica de fora: %p', (extra) => {
    expect(pedacoDaVariante(v(extra))).toBeNull();
  });
});

describe('sugerir', () => {
  test('cortado: a loja primeiro (única), depois a paleta (única)', () => {
    expect(sugerir('CINZA MESC', 'cortado', ['Cinza Mescla', 'Off White'])).toEqual({ sugestao: { nome: 'Cinza Mescla', fonte: 'loja' }, opcoes: [] });
    expect(sugerir('AZUL ESCUR', 'cortado', [])).toEqual({ sugestao: { nome: 'Azul escuro', fonte: 'paleta' }, opcoes: [] });
    expect(sugerir('AZUL MARIN', 'cortado', [])).toEqual({ sugestao: { nome: 'Azul-marinho', fonte: 'paleta' }, opcoes: [] });
    expect(sugerir('VERDE AGUA', 'cortado', [])).toEqual({ sugestao: { nome: 'Verde-água', fonte: 'paleta' }, opcoes: [] });
  });
  test('mais de um candidato: opções; nenhum: nada', () => {
    expect(sugerir('MARROM CAF', 'cortado', ['Marrom Café', 'Marrom Cafeína'])).toEqual({ sugestao: null, opcoes: ['Marrom Café', 'Marrom Cafeína'] });
    expect(sugerir('ROSA CHICL', 'cortado', [])).toEqual({ sugestao: null, opcoes: [] });
  });
  test('inteiro em maiúsculas: a paleta se for um nome dela, senão caixa de frase', () => {
    expect(sugerir('BORDO', 'maiusculo', [])).toEqual({ sugestao: { nome: 'Bordô', fonte: 'paleta' }, opcoes: [] });
    expect(sugerir('PASSION', 'maiusculo', [])).toEqual({ sugestao: { nome: 'Passion', fonte: 'caixa_de_frase' }, opcoes: [] });
  });
});

describe('agrupar', () => {
  test('um grupo por pedaço, itens por produto e cor, o que sai hoje e "única da paleta"', () => {
    const g = agrupar([
      v({ variant_id: 'a', color_name: 'AZUL ESCUR', sku_suffix: 'AZUL ESCUR-M' }),
      v({ variant_id: 'b', color_name: 'AZUL ESCUR', sku_suffix: 'AZUL ESCUR-G', tamanho: 'G' }),
      v({ variant_id: 'c', product_id: P2, product_name: 'Saia', color_name: null, sku_suffix: 'AZUL ESCUR-P', tamanho: 'P' }),
      v({ variant_id: 'd', color_name: 'OFF WHITE', hex: '#FAF9F6' }),
      v({ variant_id: 'e', color_name: 'Caqui', hex: '#C3B091' }),
    ], []);
    expect(g.map((x) => [x.pedaco, x.tipo, x.variantes, x.produtos, x.unica_da_paleta])).toEqual([
      ['AZUL ESCUR', 'cortado', 3, 2, true],
      ['OFF WHITE', 'maiusculo', 1, 1, false],
    ]);
    expect(g[0].itens).toEqual([
      { product_id: P1, product_name: 'Vestido', company_id: 'c1', hex: '#1F2A44' },
      { product_id: P2, product_name: 'Saia', company_id: 'c1', hex: '#1F2A44' },
    ]);
    expect(g[0].hoje).toBe('Cinza escuro');
    expect(g[1].hoje).toBe('Off white');
  });
});

describe('lerConfirmacao', () => {
  test('valida produto, cor e nome', () => {
    expect(lerConfirmacao({ itens: [{ product_id: P1, hex: '#1f2a44', nome: '  Azul escuro ' }] }))
      .toEqual({ itens: [{ product_id: P1, hex: '#1F2A44', nome: 'Azul escuro' }] });
    expect(lerConfirmacao({}).erro).toBeTruthy();
    expect(lerConfirmacao({ itens: [{ product_id: 'x', hex: '#1F2A44', nome: 'A' }] }).erro).toBe('Produto inválido.');
    expect(lerConfirmacao({ itens: [{ product_id: P1, hex: 'azul', nome: 'A' }] }).erro).toBe('Cor inválida.');
    expect(lerConfirmacao({ itens: [{ product_id: P1, hex: '#1F2A44', nome: ' ' }] }).erro).toBe('Escreva o nome da cor.');
    expect(lerConfirmacao({ itens: [{ product_id: P1, hex: '#1F2A44', nome: '#1F2A44' }] }).erro).toBe('Escreva o nome da cor.');
  });
});

describe('rotas', () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1' }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productColorNames'));

  let updates;
  beforeEach(() => {
    updates = [];
    db.query.mockReset();
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/DISTINCT btrim\(pv\.color_name\)/.test(s)) return Promise.resolve({ rows: [{ nome: 'Cinza Mescla' }] });
      if (/FROM product_variants pv/.test(s)) return Promise.resolve({ rows: [v({ color_name: 'CINZA MESC', hex: '#8E9196' })] });
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockImplementation(async () => ({
      query: (sql, params) => {
        if (/^\s*UPDATE product_variants/.test(String(sql))) { updates.push(params); return Promise.resolve({ rowCount: params[1] === P1 ? 2 : 0 }); }
        return Promise.resolve({ rows: [] });
      },
      release: () => {},
    }));
  });

  test('GET só lê e devolve os grupos com a sugestão da loja', async () => {
    const r = await request(app).get('/companies/c1/products/cores-para-conferir');
    expect(r.status).toBe(200);
    expect(r.body.total_grupos).toBe(1);
    expect(r.body.grupos[0]).toMatchObject({ pedaco: 'CINZA MESC', sugestao: { nome: 'Cinza Mescla', fonte: 'loja' }, unica_da_paleta: false });
    for (const c of db.query.mock.calls) expect(String(c[0])).not.toMatch(/UPDATE|INSERT|DELETE/i);
  });

  test('POST grava só os itens que vieram, por produto e cor, sem mexer no sufixo', async () => {
    const r = await request(app).post('/companies/c1/products/cores-para-conferir/confirmar').send({
      itens: [{ product_id: P1, hex: '#8e9196', nome: 'Cinza Mescla' }, { product_id: P2, hex: '#8E9196', nome: 'Cinza Mescla' }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ variantes: 2, itens: 2, recusados: 1 });
    expect(updates).toEqual([
      ['Cinza Mescla', P1, '#8E9196', 'c1'],
      ['Cinza Mescla', P2, '#8E9196', 'c1'],
    ]);
  });

  test('POST inválido não grava nada', async () => {
    const r = await request(app).post('/companies/c1/products/cores-para-conferir/confirmar').send({ itens: [] });
    expect(r.status).toBe(400);
    expect(updates).toEqual([]);
  });
});
