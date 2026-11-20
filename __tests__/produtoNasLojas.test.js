// ============================================================
// AURA. — Em qual loja o produto entra (B1), banco mockado
//
// O caminho completo (copia, grade, fotos, categoria, movimentos, par,
// repeticao) roda contra Postgres real em produtoNasLojas.banco.test.js.
// Aqui:
//   1. leitura do corpo (lojas, quantidade, variantes, repetida, limite)
//   2. limite do plano por loja (mesmos numeros do POST /products)
//   3. rota montada em private.js antes de ./products; "so consulta" 403
//   4. GET: so as lojas em que a pessoa mexe; estoque unico (D12)
//   5. POST: produto compartilhado recusado sem gravar; loja sem acesso,
//      limite e codigo em uso viram erro SO daquela loja (D6, D10, D11);
//      copia nunca liga is_group_shared; movimento de entrada
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const svc = require('../src/services/produtoNasLojas');
const copia = require('../src/services/copiaDeCadastro');

const MATRIZ = '11111111-1111-4111-8111-111111111111';
const FILIAL = '22222222-2222-4222-8222-222222222222';
const OUTRA = '33333333-3333-4333-8333-333333333333';
const TERCEIRA = '44444444-4444-4444-8444-444444444444';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const V1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const PAR = 'cccccccc-0000-4000-8000-000000000001';
const token = () => jwt.sign({ id: 'dono', role: 'client', plan: 'expansao', company: MATRIZ }, 'aura-test-secret-2026', { expiresIn: '1h' });
const LOJAS = `/companies/${MATRIZ}/products/lojas-para-cadastro`;
const POST = `/companies/${MATRIZ}/products/${P1}/lojas`;

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/private'));
}, 60000);

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  copia._limparCacheDeColunas();
});

const loja = (id, extra = {}) => ({
  id, grupo: MATRIZ, nome: `Loja ${id.slice(0, 4)}`, plan: 'negocio', regime: 'simples_nacional',
  municipio: '3550308', compartilha: 'false', ativa: true, is_owner: true, role_label: null, permissions: null, ...extra,
});

// requireCompanyAccess (dono) + estoqueSoConsulta liberado + respostas pela SQL
function bancoFalso(responder) {
  const chamadas = [];
  const run = async (sql, params) => {
    sql = String(sql);
    chamadas.push({ sql, params });
    if (/SELECT 'owner' AS role/.test(sql)) return { rows: [{ role: 'owner' }] };
    const r = responder(sql, params || []);
    if (r instanceof Error) throw r;
    return r || { rows: [] };
  };
  db.query.mockImplementation(run);
  db.connect.mockResolvedValue({ query: jest.fn(run), release: jest.fn() });
  return chamadas;
}

describe('lerPedidoDeLojas', () => {
  test('normaliza lojas, soma variante repetida, quantidade vazia vira 0', () => {
    const out = svc.lerPedidoDeLojas({
      lojas: [{ company_id: FILIAL.toUpperCase(), stock_qty: '2.5', variantes: [{ variant_id: V1, stock_qty: 1 }, { variant_id: V1, stock_qty: 2 }] },
        { company_id: OUTRA }],
    });
    expect(out[0].company_id).toBe(FILIAL);
    expect(out[0].stock_qty).toBe(2.5);
    expect([...out[0].variantes.entries()]).toEqual([[V1, 3]]);
    expect(out[1]).toMatchObject({ company_id: OUTRA, stock_qty: 0 });
  });

  test('sem lojas, loja repetida, uuid invalido, quantidade negativa, mais de 20: 400', () => {
    const casos = [
      [{}, 'LOJAS_INVALIDAS'],
      [{ lojas: [] }, 'LOJAS_INVALIDAS'],
      [{ lojas: [{ company_id: FILIAL }, { company_id: FILIAL }] }, 'LOJAS_INVALIDAS'],
      [{ lojas: [{ company_id: 'x' }] }, 'LOJAS_INVALIDAS'],
      [{ lojas: [{ company_id: FILIAL, stock_qty: -1 }] }, 'QUANTIDADE_INVALIDA'],
      [{ lojas: [{ company_id: FILIAL, stock_qty: 'abc' }] }, 'QUANTIDADE_INVALIDA'],
      [{ lojas: [{ company_id: FILIAL, variantes: [{ variant_id: 'x', stock_qty: 1 }] }] }, 'VARIANTE_INVALIDA'],
      [{ lojas: Array.from({ length: 21 }, (_, i) => ({ company_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` })) }, 'LOJAS_INVALIDAS'],
    ];
    for (const [body, code] of casos) {
      expect(() => svc.lerPedidoDeLojas(body)).toThrow(expect.objectContaining({ code, status: 400 }));
    }
  });
});

test('limite do plano: mesmos numeros do POST /products; sem limite = null', () => {
  expect(svc.limiteDoPlano('essencial')).toBe(2000);
  expect(svc.limiteDoPlano(null)).toBe(2000);
  expect(svc.limiteDoPlano('negocio')).toBe(7000);
  expect(svc.limiteDoPlano('expansao')).toBeNull();
  expect(svc.limiteDoPlano('personalizado')).toBeNull();
});

describe('GET /products/lojas-para-cadastro', () => {
  test('so as lojas em que a pessoa mexe no estoque, a ativa marcada, limite por loja', async () => {
    bancoFalso((sql) => {
      if (/FROM companies c\s+LEFT JOIN company_members/.test(sql)) {
        return { rows: [
          loja(MATRIZ),
          loja(FILIAL, { plan: 'expansao', regime: 'mei' }),
          loja(OUTRA, { is_owner: false, role_label: 'vendedor', permissions: JSON.stringify({ estoque_consulta: true }) }),
          loja(TERCEIRA, { ativa: false }),
        ] };
      }
      if (/COUNT\(\*\)::int AS total FROM products/.test(sql)) return { rows: [{ company_id: MATRIZ, total: 120 }] };
      return null;
    });
    const res = await request(app).get(LOJAS).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      estoque_unico: false,
      lojas: [
        { company_id: MATRIZ, nome: expect.any(String), ativa: true, regime: 'simples_nacional', limite: { usados: 120, maximo: 7000 } },
        { company_id: FILIAL, nome: expect.any(String), ativa: false, regime: 'mei', limite: { usados: 0, maximo: null } },
      ],
    });
  });

  test('D12: grupo sem nenhuma loja com o estoque separado = estoque_unico', async () => {
    bancoFalso((sql) => {
      if (/FROM companies c\s+LEFT JOIN company_members/.test(sql)) {
        return { rows: [loja(MATRIZ, { compartilha: 'true' }), loja(FILIAL, { compartilha: null })] };
      }
      return null;
    });
    const res = await request(app).get(LOJAS).set('Authorization', `Bearer ${token()}`);
    expect(res.body.estoque_unico).toBe(true);
  });

  test('loja sozinha: uma loja e estoque_unico false (o app esconde o campo)', async () => {
    bancoFalso((sql) => (/FROM companies c\s+LEFT JOIN company_members/.test(sql) ? { rows: [loja(MATRIZ, { compartilha: 'true' })] } : null));
    const res = await request(app).get(LOJAS).set('Authorization', `Bearer ${token()}`);
    expect(res.body.estoque_unico).toBe(false);
    expect(res.body.lojas).toHaveLength(1);
  });

  test('"estoque so consulta" na loja do caminho: 403 (rota nova sob /products nasce fechada)', async () => {
    const run = async (sql) => {
      if (/SELECT 'owner' AS role/.test(sql)) return { rows: [{ role: 'vendedor' }] };
      if (/permissions/.test(sql)) return { rows: [{ permissions: { estoque_consulta: true }, role_label: 'vendedor', is_owner: false }] };
      return { rows: [] };
    };
    db.query.mockImplementation(run);
    const res = await request(app).get(LOJAS).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /products/:pid/lojas', () => {
  const produto = (extra = {}) => ({
    id: P1, company_id: MATRIZ, name: 'Vestido midi', is_active: true, is_group_shared: false,
    barcode: '7891234567895', sku: 'VM-1', master_sku: null, unit: 'un', tax_profile: 'simples_st', ...extra,
  });
  function cenario({ grupo, prod = produto(), par = [], conflito = null, sku = null, usados = [] } = {}) {
    return bancoFalso((sql) => {
      if (/FROM companies c\s+LEFT JOIN company_members/.test(sql)) return { rows: grupo || [loja(MATRIZ), loja(FILIAL)] };
      if (/SELECT \* FROM products WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2 ORDER BY id FOR UPDATE/.test(sql)) return { rows: prod ? [prod] : [] };
      if (/FROM product_variants\s+WHERE product_id = ANY/.test(sql)) return { rows: [] };
      if (/SELECT id, company_id, btrim\(master_sku\) AS master_sku FROM products/.test(sql)) return { rows: par };
      if (/COUNT\(\*\)::int AS total FROM products/.test(sql)) return { rows: usados };
      if (/SELECT id, name, is_active, codigo FROM/.test(sql)) return { rows: conflito ? [conflito] : [] };
      if (/btrim\(sku\) = ANY\(\$2::text\[\]\)/.test(sql)) return { rows: sku ? [sku] : [] };
      if (/information_schema\.columns/.test(sql)) {
        return { rows: ['name', 'sku', 'master_sku', 'price', 'unit', 'tax_profile'].map((c) => ({ table_name: 'products', column_name: c }))
          .concat([{ table_name: 'product_variants', column_name: 'sku_suffix' }]) };
      }
      return null;
    });
  }
  const enviar = (body) => request(app).post(POST).set('Authorization', `Bearer ${token()}`).send(body);
  const escritas = (chamadas) => chamadas.filter((c) => /^\s*(UPDATE|INSERT)/.test(c.sql));

  test('caminho feliz: gera o master_sku, copia privada, estoque e movimento de entrada, COMMIT', async () => {
    const chamadas = cenario();
    const res = await enviar({ lojas: [{ company_id: FILIAL, stock_qty: 4 }] });
    expect(res.status).toBe(200);
    expect(res.body.master_sku).toMatch(/^AURA-[0-9A-F]{12}$/);
    expect(res.body.resultados).toEqual([{
      company_id: FILIAL, nome: expect.any(String), status: 'criado', product_id: expect.any(String), stock_qty: 4, avisos: [],
    }]);
    const sqls = chamadas.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls.some((s) => /pg_advisory_xact_lock/.test(s))).toBe(true);
    const ms = chamadas.find((c) => /UPDATE products SET master_sku = \$2, updated_at = NOW\(\) WHERE id = \$1$/.test(c.sql));
    expect(ms.params).toEqual([P1, res.body.master_sku]);
    const ins = chamadas.find((c) => /INSERT INTO products \(id, company_id, stock_qty, is_group_shared, barcode/.test(c.sql));
    expect(ins.sql).toMatch(/SELECT m\.novo, \$1, 0, false, m\.barcode/);
    expect(ins.params[0]).toBe(FILIAL);
    expect(ins.params[3]).toEqual(['7891234567895']);
    const mov = chamadas.find((c) => /INSERT INTO stock_movements/.test(c.sql));
    expect(mov.sql).toMatch(/'in'/);
    expect(mov.sql).toMatch(/'cadastro_em_outra_loja'/);
    expect(mov.params[0]).toBe(FILIAL);
    expect(mov.params[3]).toEqual([4]);
    expect(mov.params[5]).toEqual([P1]);
    // nenhuma escrita liga o compartilhamento do grupo
    expect(escritas(chamadas).some((c) => /is_group_shared\s*=\s*true/.test(c.sql))).toBe(false);
  });

  test('estoque 0: cria sem movimento; master_sku existente nao muda', async () => {
    const chamadas = cenario({ prod: produto({ master_sku: 'VEST-01' }) });
    const res = await enviar({ lojas: [{ company_id: FILIAL, stock_qty: 0 }] });
    expect(res.body.master_sku).toBe('VEST-01');
    expect(res.body.resultados[0]).toMatchObject({ status: 'criado', stock_qty: 0 });
    expect(chamadas.some((c) => /INSERT INTO stock_movements/.test(c.sql))).toBe(false);
    expect(chamadas.some((c) => /SET master_sku/.test(c.sql))).toBe(false);
  });

  test('par com o mesmo master_sku: ja_existia, sem copia nem estoque', async () => {
    const chamadas = cenario({ prod: produto({ master_sku: 'VEST-01' }), par: [{ id: PAR, company_id: FILIAL, master_sku: 'VEST-01' }] });
    const res = await enviar({ lojas: [{ company_id: FILIAL, stock_qty: 9 }] });
    expect(res.body.resultados[0]).toMatchObject({ status: 'ja_existia', product_id: PAR });
    expect(res.body.resultados[0].erro).toBeUndefined();
    expect(escritas(chamadas)).toHaveLength(0);
  });

  test('produto compartilhado do grupo: 409 sem gravar nada', async () => {
    const chamadas = cenario({ prod: produto({ is_group_shared: true }) });
    const res = await enviar({ lojas: [{ company_id: FILIAL }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRODUTO_COMPARTILHADO');
    expect(escritas(chamadas)).toHaveLength(0);
    expect(chamadas.map((c) => c.sql)).toContain('ROLLBACK');
  });

  test('produto de outra loja ou inexistente: 404', async () => {
    cenario({ prod: null });
    const res = await enviar({ lojas: [{ company_id: FILIAL }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PRODUTO_NAO_ENCONTRADO');
  });

  test('variante que nao e do produto: 400 VARIANTE_INVALIDA', async () => {
    cenario();
    const res = await enviar({ lojas: [{ company_id: FILIAL, variantes: [{ variant_id: V1, stock_qty: 1 }] }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VARIANTE_INVALIDA');
  });

  test('D11/D10/D6: sem acesso, fora do grupo, limite e codigo em uso falham so naquela loja', async () => {
    const grupo = [
      loja(MATRIZ),
      loja(FILIAL, { is_owner: false, role_label: 'vendedor', permissions: { estoque: false } }),
      loja(OUTRA, { plan: 'essencial' }),
      loja(TERCEIRA),
    ];
    const chamadas = bancoFalso((sql, params) => {
      if (/FROM companies c\s+LEFT JOIN company_members/.test(sql)) return { rows: grupo };
      if (/SELECT \* FROM products WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2 ORDER BY id FOR UPDATE/.test(sql)) return { rows: [produto()] };
      if (/COUNT\(\*\)::int AS total FROM products/.test(sql)) return { rows: [{ company_id: OUTRA, total: 2000 }] };
      if (/SELECT id, name, is_active, codigo FROM/.test(sql) && params[0] === TERCEIRA) {
        return { rows: [{ id: PAR, name: 'Vestido linho bege', is_active: true, codigo: '7891234567895' }] };
      }
      return null;
    });
    const fora = '55555555-5555-4555-8555-555555555555';
    const res = await enviar({ lojas: [{ company_id: FILIAL }, { company_id: OUTRA }, { company_id: TERCEIRA }, { company_id: fora }, { company_id: MATRIZ }] });
    expect(res.status).toBe(200);
    const [semAcesso, limite, codigo, deFora, mesma] = res.body.resultados;
    expect(semAcesso).toMatchObject({ company_id: FILIAL, status: 'erro', product_id: null, erro: { code: 'SEM_ACESSO' } });
    expect(limite).toMatchObject({ status: 'erro', erro: { code: 'LIMITE_PLANO', limite: 2000, usados: 2000 } });
    expect(codigo).toMatchObject({
      status: 'erro',
      erro: { code: 'BARCODE_EM_USO', message: 'O código 7891234567895 já está no produto "Vestido linho bege" desta loja.', produto_conflito: { id: PAR, name: 'Vestido linho bege' } },
    });
    expect(deFora).toMatchObject({ status: 'erro', erro: { code: 'SEM_ACESSO' } });
    expect(mesma).toMatchObject({ status: 'erro', erro: { code: 'MESMA_LOJA' } });
    expect(chamadas.some((c) => /INSERT INTO products/.test(c.sql))).toBe(false);
    expect(chamadas.map((c) => c.sql)).toContain('COMMIT');
  });

  test('D6: codigo interno (sku) em outro produto da loja', async () => {
    cenario({ sku: { id: PAR, name: 'Outro vestido', chave: 'VM-1' } });
    const res = await enviar({ lojas: [{ company_id: FILIAL }] });
    expect(res.body.resultados[0].erro).toMatchObject({ code: 'CODIGO_EM_USO', produto_conflito: { id: PAR, name: 'Outro vestido' } });
  });

  test('D7: regime diferente nao leva o perfil tributario e avisa fiscal_conferir', async () => {
    const chamadas = cenario({ grupo: [loja(MATRIZ), loja(FILIAL, { regime: 'mei' })] });
    const res = await enviar({ lojas: [{ company_id: FILIAL }] });
    expect(res.body.resultados[0]).toMatchObject({ status: 'criado', avisos: ['fiscal_conferir'] });
    expect(chamadas.some((c) => /UPDATE products SET "tax_profile" = NULL WHERE id = ANY\(\$1::uuid\[\]\)/.test(c.sql))).toBe(true);
  });

  test('D7: outro municipio nao leva o codigo municipal nem a aliquota do ISS; mesmo municipio leva', async () => {
    const servico = produto({ tax_profile: null, nfse_ctribmun: '101', nfse_aliquota_iss: '2.50' });
    const limpou = (chamadas, c) => chamadas.some((x) => new RegExp(`UPDATE products SET "${c}" = NULL WHERE id = ANY`).test(x.sql));

    const outro = cenario({ prod: servico, grupo: [loja(MATRIZ), loja(FILIAL, { municipio: '3304557' })] });
    const r1 = await enviar({ lojas: [{ company_id: FILIAL }] });
    expect(r1.body.resultados[0]).toMatchObject({ status: 'criado', avisos: ['fiscal_conferir'] });
    expect(limpou(outro, 'nfse_ctribmun')).toBe(true);
    expect(limpou(outro, 'nfse_aliquota_iss')).toBe(true);

    const mesmo = cenario({ prod: servico, grupo: [loja(MATRIZ), loja(FILIAL)] });
    const r2 = await enviar({ lojas: [{ company_id: FILIAL }] });
    expect(r2.body.resultados[0]).toMatchObject({ status: 'criado', avisos: [] });
    expect(limpou(mesmo, 'nfse_ctribmun')).toBe(false);
    expect(limpou(mesmo, 'nfse_aliquota_iss')).toBe(false);
  });

  test('falha inesperada numa loja: ROLLBACK TO SAVEPOINT, erro so dela, as outras seguem', async () => {
    let primeira = true;
    const chamadas = bancoFalso((sql) => {
      if (/FROM companies c\s+LEFT JOIN company_members/.test(sql)) return { rows: [loja(MATRIZ), loja(FILIAL), loja(OUTRA)] };
      if (/SELECT \* FROM products WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2 ORDER BY id FOR UPDATE/.test(sql)) return { rows: [produto()] };
      if (/INSERT INTO products \(id, company_id/.test(sql) && primeira) { primeira = false; return Object.assign(new Error('boom'), { code: 'XX000' }); }
      return null;
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await enviar({ lojas: [{ company_id: FILIAL }, { company_id: OUTRA }] });
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.resultados[0]).toMatchObject({ status: 'erro', erro: { code: 'ERRO_AO_CRIAR' } });
    expect(res.body.resultados[1]).toMatchObject({ status: 'criado' });
    expect(chamadas.map((c) => c.sql)).toContain('ROLLBACK TO SAVEPOINT sp_loja');
  });
});

describe('levarLote (o lote da planilha e da lista)', () => {
  test('300 produtos em 2 lojas: numero fixo de queries, nao uma por produto', async () => {
    const pids = Array.from({ length: 300 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const chamadas = [];
    const conn = {
      query: jest.fn(async (sql, params) => {
        sql = String(sql);
        chamadas.push(sql);
        if (/FROM companies c\s+LEFT JOIN company_members/.test(sql)) return { rows: [loja(MATRIZ), loja(FILIAL, { plan: 'expansao' }), loja(OUTRA, { plan: 'expansao' })] };
        if (/SELECT \* FROM products WHERE id = ANY/.test(sql)) {
          return { rows: params[0].map((id, i) => ({ id, company_id: MATRIZ, name: `P${i}`, is_active: true, is_group_shared: false, barcode: `789${i}`, sku: null, master_sku: null, unit: 'un' })) };
        }
        return { rows: [] };
      }),
    };
    const itens = pids.map((product_id) => ({
      product_id,
      lojas: [{ company_id: FILIAL, stock_qty: 1, variantes: new Map() }, { company_id: OUTRA, stock_qty: 0, variantes: new Map() }],
    }));
    const out = await svc.levarLote(conn, { origemId: MATRIZ, userId: 'dono', itens });
    expect(out.size).toBe(300);
    expect([...out.values()].every((o) => o.resultados.every((r) => r.status === 'criado'))).toBe(true);
    expect(out.get(pids[0]).resultados.map((r) => r.stock_qty)).toEqual([1, 0]);
    expect(chamadas.length).toBeLessThan(45);
    const mov = chamadas.filter((s) => /INSERT INTO stock_movements/.test(s));
    expect(mov).toHaveLength(1); // so a FILIAL recebeu estoque
  });
});
