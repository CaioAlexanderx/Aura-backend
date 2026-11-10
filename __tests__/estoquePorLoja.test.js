// ============================================================
// AURA. — Estoque por loja (visão consolidada) — db mockado
//
// Trava as regras puras (acesso, entradas por loja, compartilhado,
// variantes, rótulo) e o desenho das rotas: só as lojas com acesso vão
// para o SQL, paginação e busca viram parâmetros, o degrau do vínculo de
// transferência (42P01/42703) não derruba a lista e quem só consulta sem
// pdv não recebe preço. O SQL de verdade é travado no .banco.
// ============================================================
'use strict';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
}));

const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');
const svc = require('../src/services/estoquePorLoja');

function buildApp() {
  const app = express();
  app.use('/me', require('../src/routes/meEstoquePorLoja'));
  return app;
}

const MATRIZ = '00000000-0000-0000-0000-00000000000a';
const FILIAL = '00000000-0000-0000-0000-00000000000b';
const SEM_ESTOQUE = '00000000-0000-0000-0000-00000000000c';
const CONSULTA = '00000000-0000-0000-0000-00000000000d';

const lojaRow = (id, extra = {}) => ({
  id, legal_name: `Loja ${id.slice(-1)}`, trade_name: null, is_primary: false,
  created_at: '2026-01-01T00:00:00Z', raiz: MATRIZ, is_owner: true, role_label: null, permissions: null,
  ...extra,
});

const ehLojas = (sql) => /FROM companies c/.test(sql) && /company_members/.test(sql);

afterEach(() => { db.query.mockReset(); svc._resetMemo(); });

describe('regras puras', () => {
  test('acesso: dono, admin e permissions null veem; membro precisa de estoque ou consulta', () => {
    expect(svc.acessoAoEstoque({ isOwner: true })).toEqual({ veEstoque: true, vePreco: true });
    expect(svc.acessoAoEstoque({ roleLabel: 'admin', permissions: {} }).veEstoque).toBe(true);
    expect(svc.acessoAoEstoque({ permissions: null }).veEstoque).toBe(true);
    expect(svc.acessoAoEstoque({ permissions: { pdv: true } }).veEstoque).toBe(false);
    expect(svc.acessoAoEstoque({ permissions: {} }).veEstoque).toBe(false);
    expect(svc.acessoAoEstoque({ permissions: { estoque: true } })).toEqual({ veEstoque: true, vePreco: true });
    expect(svc.acessoAoEstoque({ permissions: { estoque_consulta: true } })).toEqual({ veEstoque: true, vePreco: false });
    expect(svc.acessoAoEstoque({ permissions: { estoque_consulta: true, pdv: true } })).toEqual({ veEstoque: true, vePreco: true });
  });

  test('nome normalizado: minúsculas, sem acento, espaços colapsados', () => {
    expect(svc.normalizarNome('  Boné   ÁSPERO  ')).toBe('bone aspero');
    expect(svc.normalizarNome('Calça Jeans')).toBe(svc.normalizarNome('calca  jeans'));
  });

  test('entradas por loja: compartilhado aparece nas outras lojas do grupo, sem estoque inventado', () => {
    const lojas = [{ id: MATRIZ, raiz: MATRIZ }, { id: FILIAL, raiz: MATRIZ }, { id: 'x', raiz: 'x' }];
    const membros = [{ company_id: MATRIZ, product_id: 'p1', estoque: '7', compartilhado: true, raiz: MATRIZ }];
    const out = svc.entradasPorLoja(membros, lojas);
    expect(out).toEqual([
      { company_id: MATRIZ, product_id: 'p1', estoque: 7, compartilhado: false },
      { company_id: FILIAL, product_id: 'p1', estoque: null, compartilhado: true, dona_company_id: MATRIZ },
    ]);
    // loja de outro grupo não ganha a entrada
    expect(out.find((e) => e.company_id === 'x')).toBeUndefined();
  });

  test('entradas por loja: loja com cadastro próprio não ganha o compartilhado', () => {
    const lojas = [{ id: MATRIZ, raiz: MATRIZ }, { id: FILIAL, raiz: MATRIZ }];
    const out = svc.entradasPorLoja([
      { company_id: MATRIZ, product_id: 'p1', estoque: 7, compartilhado: true, raiz: MATRIZ },
      { company_id: FILIAL, product_id: 'p2', estoque: 2, compartilhado: false, raiz: MATRIZ },
    ], lojas);
    expect(out.map((e) => [e.company_id, e.estoque, e.compartilhado])).toEqual([[MATRIZ, 7, false], [FILIAL, 2, false]]);
  });

  test('rótulo: cor primeiro, nome da cor no lugar do hex; chave compara pelo hex', () => {
    const a = svc.rotuloDaVariante({ attributes: [{ attribute: 'Tamanho', value: 'M' }, { attribute: 'Cor', value: 'Azul (#0000FF)' }] });
    const b = svc.rotuloDaVariante({ color_name: 'Azul royal', attributes: [{ attribute: 'Cor', value: '#0000ff' }, { attribute: 'Tamanho', value: 'm' }] });
    expect(a.rotulo).toBe('Azul / M');
    expect(b.rotulo).toBe('Azul royal / m');
    expect(a.chave).toBe(b.chave);
    expect(svc.rotuloDaVariante({ sku_suffix: 'P', attributes: [] }).rotulo).toBe('P');
  });

  const v = (id, company_id, extra = {}) => ({ id, company_id, barcode: null, sku_suffix: null, attributes: [], estoque: 1, ...extra });

  test('variantes casam por barcode, sku e rótulo — uma por loja', () => {
    const grupos = svc.agruparVariantes([
      v('a1', 'A', { barcode: '111', attributes: [{ attribute: 'Tamanho', value: 'P' }] }),
      v('a2', 'A', { sku_suffix: 'AZ-M', attributes: [{ attribute: 'Tamanho', value: 'M' }] }),
      v('a3', 'A', { attributes: [{ attribute: 'Tamanho', value: 'G' }] }),
      v('b1', 'B', { barcode: '111', attributes: [{ attribute: 'Tamanho', value: 'PP' }] }),
      v('b2', 'B', { sku_suffix: 'az-m' }),
      v('b3', 'B', { attributes: [{ attribute: 'tamanho', value: 'g' }] }),
      v('b4', 'B', { attributes: [{ attribute: 'Tamanho', value: 'GG' }] }),
    ]);
    const ids = grupos.map((g) => g.membros.map((m) => m.id).sort());
    expect(ids).toEqual([['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3'], ['b4']]);
  });

  test('variante: barcode que contradiz não casa pelo rótulo nem pelo sku', () => {
    const grupos = svc.agruparVariantes([
      v('a1', 'A', { barcode: '111', sku_suffix: 'X', attributes: [{ attribute: 'Tamanho', value: 'P' }] }),
      v('b1', 'B', { barcode: '222', sku_suffix: 'X', attributes: [{ attribute: 'Tamanho', value: 'P' }] }),
    ]);
    expect(grupos).toHaveLength(2);
  });

  test('variante: vínculo de transferência vence o código e segue a cadeia', () => {
    const grupos = svc.agruparVariantes([
      v('a1', 'A', { barcode: '111', criadoVar: '2026-01-01' }),
      v('b1', 'B', { barcode: '999', origem_id: 'a1', criadoVar: '2026-02-01' }),
      v('c1', 'C', { barcode: '888', origem_id: 'b1', criadoVar: '2026-03-01' }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].membros.map((m) => m.id).sort()).toEqual(['a1', 'b1', 'c1']);
  });
});

describe('GET /me/estoque/por-loja', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  function mockDb({ lojas, itens = [], erroVinculo = null }) {
    db.query.mockImplementation(async (sql) => {
      if (ehLojas(sql)) return { rows: lojas };
      if (erroVinculo && sql.includes('stock_transfer_items')) {
        const e = new Error('relation "stock_transfer_items" does not exist');
        e.code = erroVinculo;
        throw e;
      }
      if (/WITH RECURSIVE lojas/.test(sql)) return { rows: itens };
      return { rows: [] };
    });
  }

  const itemRow = (extra = {}) => ({
    chave: 'barcode:789', nome: 'Camiseta', sku: 'CAM', barcode: '789', imagem_url: null,
    preco: '59.90', loja_ref: MATRIZ, total: '15', tem_variantes: false, total_itens: '1',
    membros: [
      { company_id: MATRIZ, product_id: 'p1', estoque: 12, compartilhado: false, raiz: MATRIZ },
      { company_id: FILIAL, product_id: 'p2', estoque: 3, compartilhado: false, raiz: MATRIZ },
    ],
    ...extra,
  });

  test('responde o contrato e só manda ao SQL as lojas com acesso ao Estoque', async () => {
    mockDb({
      lojas: [
        lojaRow(MATRIZ, { is_primary: true }),
        lojaRow(FILIAL),
        lojaRow(SEM_ESTOQUE, { is_owner: false, role_label: 'vendedor', permissions: { pdv: true } }),
      ],
      itens: [itemRow()],
    });
    const res = await request(app).get('/me/estoque/por-loja');
    expect(res.status).toBe(200);
    expect(res.body.lojas.map((l) => l.id)).toEqual([MATRIZ, FILIAL]);
    expect(res.body.total_itens).toBe(1);
    expect(res.body.itens[0]).toEqual({
      chave: 'barcode:789', nome: 'Camiseta', sku: 'CAM', barcode: '789', imagem_url: null, preco: 59.9,
      por_loja: [
        { company_id: MATRIZ, product_id: 'p1', estoque: 12, compartilhado: false },
        { company_id: FILIAL, product_id: 'p2', estoque: 3, compartilhado: false },
      ],
      total: 15,
      tem_variantes: false,
    });
    const lista = db.query.mock.calls.find(([sql]) => /WITH RECURSIVE lojas/.test(sql));
    expect(lista[1][0]).toEqual([MATRIZ, FILIAL]);
    expect(lista[1][0]).not.toContain(SEM_ESTOQUE);
  });

  test('paginação e busca viram parâmetros; limite tem teto', async () => {
    mockDb({ lojas: [lojaRow(MATRIZ)], itens: [itemRow()] });
    await request(app).get('/me/estoque/por-loja?q=camis&categoria=Roupas&limit=999&offset=50');
    const [sql, params] = db.query.mock.calls.find(([s]) => /WITH RECURSIVE lojas/.test(s));
    expect(params).toEqual([[MATRIZ], '%camis%', 'Roupas', 200, 50]);
    expect(sql).toMatch(/HAVING bool_or\(casa_busca\) AND bool_or\(casa_categoria\)/);
    expect(sql).toMatch(/LIMIT \$4 OFFSET \$5/);
  });

  test('sem loja com acesso: lista vazia sem consultar produtos', async () => {
    mockDb({ lojas: [] });
    const res = await request(app).get('/me/estoque/por-loja');
    expect(res.body).toEqual({ lojas: [], itens: [], total_itens: 0 });
    expect(db.query.mock.calls.some(([sql]) => /WITH RECURSIVE/.test(sql))).toBe(false);
  });

  test.each(['42P01', '42703'])('degrau %s: sem a tabela da transferência a lista sai do mesmo jeito', async (code) => {
    mockDb({ lojas: [lojaRow(MATRIZ)], itens: [itemRow()], erroVinculo: code });
    const res = await request(app).get('/me/estoque/por-loja');
    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(1);
    // memorizou: a segunda chamada já não tenta o vínculo
    db.query.mockClear();
    await request(app).get('/me/estoque/por-loja');
    expect(db.query.mock.calls.some(([sql]) => sql.includes('stock_transfer_items'))).toBe(false);
  });

  test('erro que não é de schema continua 500', async () => {
    db.query.mockImplementation(async (sql) => {
      if (ehLojas(sql)) return { rows: [lojaRow(MATRIZ)] };
      throw Object.assign(new Error('boom'), { code: '57014' });
    });
    const res = await request(app).get('/me/estoque/por-loja');
    expect(res.status).toBe(500);
  });

  test('quem só consulta o estoque sem pdv não recebe preço', async () => {
    mockDb({
      lojas: [lojaRow(CONSULTA, { is_owner: false, role_label: 'vendedor', permissions: { estoque_consulta: true } })],
      itens: [itemRow({ loja_ref: CONSULTA, membros: [{ company_id: CONSULTA, product_id: 'p9', estoque: 4, compartilhado: false, raiz: CONSULTA }] })],
    });
    const res = await request(app).get('/me/estoque/por-loja');
    expect(res.body.itens[0].preco).toBeNull();
    expect(res.body.itens[0].total).toBe(4);
  });

  test('compartilhado: total soma só o estoque da dona', async () => {
    mockDb({
      lojas: [lojaRow(MATRIZ, { is_primary: true }), lojaRow(FILIAL)],
      itens: [itemRow({ membros: [{ company_id: MATRIZ, product_id: 'p1', estoque: 7, compartilhado: true, raiz: MATRIZ }] })],
    });
    const res = await request(app).get('/me/estoque/por-loja');
    expect(res.body.itens[0].por_loja).toEqual([
      { company_id: MATRIZ, product_id: 'p1', estoque: 7, compartilhado: false },
      { company_id: FILIAL, product_id: 'p1', estoque: null, compartilhado: true, dona_company_id: MATRIZ },
    ]);
    expect(res.body.itens[0].total).toBe(7);
  });
});

describe('GET /me/estoque/por-loja/variantes', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('sem chave: 400', async () => {
    const res = await request(app).get('/me/estoque/por-loja/variantes');
    expect(res.status).toBe(400);
  });

  test('chave que não existe nas lojas do usuário: 404', async () => {
    db.query.mockImplementation(async (sql) => (ehLojas(sql) ? { rows: [lojaRow(MATRIZ)] } : { rows: [] }));
    const res = await request(app).get('/me/estoque/por-loja/variantes?chave=barcode:nada');
    expect(res.status).toBe(404);
  });

  test('variantes por loja', async () => {
    db.query.mockImplementation(async (sql) => {
      if (ehLojas(sql)) return { rows: [lojaRow(MATRIZ, { is_primary: true }), lojaRow(FILIAL)] };
      if (/WHERE chave = \$2/.test(sql)) {
        return { rows: [
          { id: 'p1', company_id: MATRIZ, raiz: MATRIZ, pos: 1, compartilhado: false, created_at: '2026-01-01' },
          { id: 'p2', company_id: FILIAL, raiz: MATRIZ, pos: 2, compartilhado: false, created_at: '2026-02-01' },
        ] };
      }
      if (/FROM product_variants pv/.test(sql)) {
        return { rows: [
          { id: 'v1', product_id: 'p1', sku_suffix: 'AZUL-M', barcode: '111', stock_qty: '5', color_name: null, created_at: '2026-01-01',
            attributes: [{ attribute: 'Cor', value: 'Azul (#0000FF)' }, { attribute: 'Tamanho', value: 'M' }], origem_id: null },
          { id: 'v2', product_id: 'p2', sku_suffix: 'AZUL-M', barcode: '111', stock_qty: '2', color_name: null, created_at: '2026-02-01',
            attributes: [{ attribute: 'Cor', value: 'Azul (#0000FF)' }, { attribute: 'Tamanho', value: 'M' }], origem_id: null },
        ] };
      }
      return { rows: [] };
    });
    const res = await request(app).get('/me/estoque/por-loja/variantes?chave=barcode:789');
    expect(res.status).toBe(200);
    expect(res.body.variantes).toEqual([{
      rotulo: 'Azul / M', sku: 'AZUL-M', barcode: '111',
      por_loja: [
        { company_id: MATRIZ, variant_id: 'v1', estoque: 5, compartilhado: false },
        { company_id: FILIAL, variant_id: 'v2', estoque: 2, compartilhado: false },
      ],
      total: 7,
    }]);
  });
});
