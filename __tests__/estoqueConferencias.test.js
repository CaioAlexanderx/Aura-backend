// ============================================================
// AURA. — Conferencia de estoque (card p-108, migration 446), banco mockado
//
// O caminho completo (snapshot, aplicar, desfazer, grupo, transferencia)
// roda contra Postgres real em estoqueConferencias.banco.test.js. Aqui:
//   1. a regra do ajuste, pura: venda depois do bipe mantida, piso 0,
//      zerar nao contados, desfazer com o mesmo piso
//   2. leitura do corpo: escopo, quantidade, modo
//   3. rota montada em private.js: 503 MIGRATION_PENDING antes da migration
//      (sem abrir transacao), 403 sem acesso ao estoque, 403 sem permissao
//      de editar no aplicar/desfazer, 409 fora de rascunho, snapshot so no
//      INSERT, as cegas sem estoque no GET
//   4. transferencia: sem stock_count_id o SQL e o de sempre; com o campo
//      antes da migration, ignorado; depois, gravado
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const svc = require('../src/services/conferenciaDeEstoque');
const transf = require('../src/services/transferenciaDeEstoque');
const schema = require('../src/utils/conferenciaSchema');

const LOJA = '11111111-1111-4111-8111-111111111111';
const DESTINO = '22222222-2222-4222-8222-222222222222';
const CONT = '44444444-4444-4444-8444-444444444444';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const D1 = 'cccccccc-0000-4000-8000-000000000001';
const BASE = `/companies/${LOJA}/estoque/conferencias`;
const token = (id = 'dono') => jwt.sign({ id, role: 'client', plan: 'essencial', company: LOJA }, 'aura-test-secret-2026', { expiresIn: '1h' });

let app;
let migrationRodou;
let papel;        // o que requireCompanyAccess acha
let permissoes;   // company_members.permissions do membro

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/private'));
}, 60000);

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  schema._resetCache();
  transf._limparCacheDeColunas();
  migrationRodou = true;
  papel = 'owner';
  permissoes = null;
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/SELECT 'owner' AS role/.test(s)) return { rows: [{ role: papel }] };
    if (/table_name = 'stock_count_items'/.test(s)) return { rows: [{ n: migrationRodou ? '2' : '0' }] };
    if (/AS is_owner, cm.role_label, cm.permissions/.test(s)) {
      return { rows: [{ is_owner: papel === 'owner', role_label: papel === 'owner' ? null : papel, permissions: permissoes }] };
    }
    return { rows: [] };
  });
});

function clienteFalso(responder) {
  const chamadas = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      chamadas.push({ sql: String(sql), params });
      const r = responder(String(sql), params || []);
      if (r instanceof Error) throw r;
      return r || { rows: [] };
    }),
    release: jest.fn(),
  };
  db.connect.mockResolvedValue(client);
  return { client, chamadas };
}

const conferencia = (extra = {}) => ({
  id: CONT, company_id: LOJA, numero: 3, status: 'rascunho', escopo: { tipo: 'loja_toda' }, as_cegas: true,
  motivo: null, criada_em: '2026-11-11T10:00:00Z', criada_por: 'dono', criada_por_nome: 'Dono',
  aplicada_em: null, aplicada_por: null, desfeita_em: null, desfeita_por: null, zerou_nao_contados: false,
  pode_desfazer_ate: null, dentro_do_prazo: false, ...extra,
});

describe('regra do ajuste', () => {
  test('diferenca sobre o estoque ATUAL: venda depois do bipe fica mantida', () => {
    // sistema tinha 10 no bipe, contou 7, vendeu 2 depois -> 8 + (7 - 10) = 5
    expect(svc.calcularAjuste({ contado: 7, estoqueNoBipe: 10, estoqueAtual: 8 })).toEqual({ diferenca: -3, novo: 5, aplicada: -3 });
    // sobra: contou 12 de 10, entrou 1 depois -> 11 + 2 = 13
    expect(svc.calcularAjuste({ contado: 12, estoqueNoBipe: 10, estoqueAtual: 11 })).toEqual({ diferenca: 2, novo: 13, aplicada: 2 });
    expect(svc.calcularAjuste({ contado: 4, estoqueNoBipe: 4, estoqueAtual: 1 })).toEqual({ diferenca: 0, novo: 1, aplicada: 0 });
  });

  test('piso 0: a diferenca aplicada e a efetiva', () => {
    expect(svc.calcularAjuste({ contado: 0, estoqueNoBipe: 5, estoqueAtual: 2 })).toEqual({ diferenca: -5, novo: 0, aplicada: -2 });
    expect(svc.calcularAjuste({ contado: 1.5, estoqueNoBipe: 2.25, estoqueAtual: 0.5 })).toEqual({ diferenca: -0.75, novo: 0, aplicada: -0.5 });
  });

  test('zerar nao contado: vai a 0, inclusive o negativo', () => {
    expect(svc.calcularZerar(4)).toMatchObject({ novo: 0, aplicada: -4 });
    expect(svc.calcularZerar(-2)).toMatchObject({ novo: 0, aplicada: 2 });
    expect(svc.calcularZerar(0)).toMatchObject({ novo: 0, aplicada: 0 });
  });

  test('desfazer: inverso do aplicado sobre o atual, mesmo piso', () => {
    expect(svc.calcularDesfazer({ estoqueAtual: 1, diferencaAplicada: -7 })).toEqual({ novo: 8, efetiva: 7 });
    expect(svc.calcularDesfazer({ estoqueAtual: 1, diferencaAplicada: 3 })).toEqual({ novo: 0, efetiva: -1 });
  });

  test('grupo da diferenca', () => {
    expect([-1, 0, 2].map(svc.grupoDaDiferenca)).toEqual(['faltam', 'batem', 'sobram']);
  });
});

describe('leitura do corpo', () => {
  test('escopo valido e invalido', () => {
    expect(svc.lerEscopo({ tipo: 'loja_toda', category_ids: [P1] })).toEqual({ tipo: 'loja_toda' });
    expect(svc.lerEscopo({ tipo: 'categoria', category_ids: [P1, P1.toUpperCase()] })).toEqual({ tipo: 'categoria', category_ids: [P1] });
    for (const e of [undefined, null, [], { tipo: 'tudo' }, { tipo: 'categoria' }, { tipo: 'categoria', category_ids: ['x'] }]) {
      expect(() => svc.lerEscopo(e)).toThrow(expect.objectContaining({ status: 400, code: 'ESCOPO_INVALIDO' }));
    }
  });

  test('as cegas por padrao; motivo curto e opcional', () => {
    expect(svc.lerCriacao({ escopo: { tipo: 'com_estoque' } })).toEqual({ escopo: { tipo: 'com_estoque' }, asCegas: true, motivo: null });
    expect(svc.lerCriacao({ escopo: { tipo: 'loja_toda' }, as_cegas: false, motivo: '  Inventário  ' }))
      .toEqual({ escopo: { tipo: 'loja_toda' }, asCegas: false, motivo: 'Inventário' });
    expect(svc.lerCriacao({ escopo: { tipo: 'loja_toda' }, motivo: 'x'.repeat(500) }).motivo).toHaveLength(200);
  });

  test('registro: somar por padrao com 1; definir nao aceita negativo', () => {
    expect(svc.lerRegistro({ product_id: P1 })).toEqual({ productId: P1, variantId: null, quantidade: 1, modo: 'somar' });
    expect(svc.lerRegistro({ product_id: P1, quantidade: -1, modo: 'somar' }).quantidade).toBe(-1);
    expect(() => svc.lerRegistro({ product_id: P1, quantidade: -1, modo: 'definir' })).toThrow(expect.objectContaining({ code: 'QUANTIDADE_INVALIDA' }));
    expect(() => svc.lerRegistro({ product_id: P1, quantidade: 1, modo: 'trocar' })).toThrow(expect.objectContaining({ code: 'QUANTIDADE_INVALIDA' }));
    expect(() => svc.lerRegistro({ product_id: 'x', quantidade: 1 })).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('rotas /estoque/conferencias', () => {
  test('antes da migration: 503 MIGRATION_PENDING em todas, sem abrir transacao', async () => {
    migrationRodou = false;
    const chamadas = [
      request(app).post(BASE).send({ escopo: { tipo: 'loja_toda' } }),
      request(app).get(BASE),
      request(app).get(`${BASE}/${CONT}`),
      request(app).put(`${BASE}/${CONT}/itens`).send({ product_id: P1, quantidade: 1 }),
      request(app).get(`${BASE}/${CONT}/diferencas`),
      request(app).post(`${BASE}/${CONT}/aplicar`).send({}),
      request(app).post(`${BASE}/${CONT}/desfazer`),
      request(app).delete(`${BASE}/${CONT}`),
    ];
    for (const r of await Promise.all(chamadas.map((c) => c.set('Authorization', `Bearer ${token()}`)))) {
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('MIGRATION_PENDING');
    }
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('membro com estoque desligado: 403 SEM_ACESSO_AO_ESTOQUE', async () => {
    papel = 'caixa';
    permissoes = JSON.stringify({ estoque: false, pdv: true });
    const r = await request(app).get(BASE).set('Authorization', `Bearer ${token('membro')}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SEM_ACESSO_AO_ESTOQUE');
  });

  test('estoque so consulta passa pela conferencia (o /estoque nega) mas nao aplica nem desfaz', async () => {
    papel = 'vendedor';
    permissoes = { estoque_consulta: true };
    const lista = await request(app).get(BASE).set('Authorization', `Bearer ${token('membro')}`);
    expect(lista.status).toBe(200);
    expect(lista.body).toEqual([]);
    for (const acao of ['aplicar', 'desfazer']) {
      const r = await request(app).post(`${BASE}/${CONT}/${acao}`).set('Authorization', `Bearer ${token('membro')}`).send({});
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('SEM_PERMISSAO_DE_EDITAR');
    }
    expect(db.connect).not.toHaveBeenCalled();
    // e a ruptura, no mesmo /estoque, continua negada para esse perfil
    const ruptura = await request(app).get(`/companies/${LOJA}/estoque/ruptura`).set('Authorization', `Bearer ${token('membro')}`);
    expect(ruptura.status).toBe(403);
  });

  test('fora de rascunho: PUT itens 409 CONFERENCIA_FECHADA sem gravar', async () => {
    const { chamadas } = clienteFalso((sql) => (/FROM stock_counts c/.test(sql) ? { rows: [conferencia({ status: 'aplicada' })] } : null));
    const r = await request(app).put(`${BASE}/${CONT}/itens`).set('Authorization', `Bearer ${token()}`).send({ product_id: P1, quantidade: 1 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'CONFERENCIA_FECHADA', status: 'aplicada' });
    expect(chamadas.some((c) => /^\s*(UPDATE|INSERT)/.test(c.sql))).toBe(false);
    expect(chamadas.map((c) => c.sql)).toContain('ROLLBACK');
    expect(chamadas.find((c) => /FROM stock_counts c/.test(c.sql)).sql).toMatch(/FOR SHARE OF c/);
  });

  test('aplicar de novo: 409 JA_APLICADA sem mexer no estoque', async () => {
    const { chamadas } = clienteFalso((sql) => (/FROM stock_counts c/.test(sql) ? { rows: [conferencia({ status: 'aplicada', dentro_do_prazo: true })] } : null));
    const r = await request(app).post(`${BASE}/${CONT}/aplicar`).set('Authorization', `Bearer ${token()}`).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('JA_APLICADA');
    expect(r.body.conferencia.status).toBe('aplicada');
    expect(chamadas.find((c) => /FROM stock_counts c/.test(c.sql)).sql).toMatch(/FOR UPDATE OF c/);
    expect(chamadas.some((c) => /stock_movements|UPDATE products|UPDATE product_variants/.test(c.sql))).toBe(false);
  });

  test('primeiro bipe grava o snapshot; no conflito so o contado muda', async () => {
    const { chamadas } = clienteFalso((sql) => {
      if (/FROM stock_counts c/.test(sql)) return { rows: [conferencia()] };
      if (/FROM products p\s+JOIN companies c/.test(sql)) {
        return { rows: [{ id: P1, company_id: LOJA, name: 'Blusa', is_active: true, is_group_shared: false, unit: 'un', stock_qty: '9', custo: '12.5', tem_grade: false, mesmo_grupo: true }] };
      }
      if (/INSERT INTO stock_count_items/.test(sql)) return { rows: [{ id: 'item-1', criado: true }] };
      if (/FROM stock_count_items i/.test(sql)) {
        return { rows: [{ id: 'item-1', product_id: P1, variant_id: null, contado: '1', estoque_no_bipe: '9', estoque_atual: '9', nome: 'Blusa', barcode: '789', contado_em: 'x', atualizado_em: 'x' }] };
      }
      return null;
    });
    const r = await request(app).put(`${BASE}/${CONT}/itens`).set('Authorization', `Bearer ${token()}`).send({ product_id: P1, quantidade: 1, modo: 'somar' });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ id: 'item-1', nome: 'Blusa', codigo: '789', contado: 1 });
    expect(r.body.item).not.toHaveProperty('estoque_no_bipe'); // as cegas
    const ins = chamadas.find((c) => /INSERT INTO stock_count_items/.test(c.sql));
    expect(ins.params.slice(0, 7)).toEqual([CONT, LOJA, P1, null, 1, 9, 12.5]);
    const conflito = ins.sql.split('DO UPDATE SET')[1];
    expect(conflito).not.toMatch(/estoque_no_bipe|custo_no_bipe/);
    expect(chamadas[chamadas.length - 1].sql).toBe('COMMIT');
  });

  test('GET em rascunho as cegas: nenhum estoque do sistema na resposta', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/SELECT 'owner' AS role/.test(s)) return { rows: [{ role: 'owner' }] };
      if (/table_name = 'stock_count_items'/.test(s)) return { rows: [{ n: '2' }] };
      if (/FROM stock_counts c/.test(s)) return { rows: [conferencia()] };
      if (/FROM stock_count_items i/.test(s)) {
        return { rows: [{ id: 'item-1', product_id: P1, variant_id: null, contado: '3', estoque_no_bipe: '9', estoque_atual: '8', custo_no_bipe: '5', nome: 'Blusa' }] };
      }
      if (/COUNT\(\*\) AS n FROM \(/.test(s)) return { rows: [{ n: '40' }] };
      return { rows: [] };
    });
    const r = await request(app).get(`${BASE}/${CONT}`).set('Authorization', `Bearer ${token()}`);
    expect(r.status).toBe(200);
    expect(r.body.escopo_total).toBe(40);
    expect(r.body.itens).toEqual([expect.objectContaining({ id: 'item-1', contado: 3 })]);
    expect(JSON.stringify(r.body.itens)).not.toMatch(/estoque|custo/);
    expect(r.body.transferencias).toEqual([]);
  });
});

describe('transferencia com stock_count_id', () => {
  const T_BASE = `/companies/${LOJA}/estoque/transferencias`;
  const lojas = {
    rows: [
      { id: LOJA, grupo: LOJA, nome: 'Loja Centro', ativa: true, is_owner: true, role_label: null, permissions: null },
      { id: DESTINO, grupo: LOJA, nome: 'Loja Shopping', ativa: true, is_owner: true, role_label: null, permissions: null },
    ],
  };
  const feliz = (extra = () => null) => clienteFalso((sql, params) => {
    const e = extra(sql, params);
    if (e) return e;
    if (/FROM companies c/.test(sql)) return lojas;
    if (/FROM products\s+WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2\s+ORDER BY id\s+FOR UPDATE/.test(sql)) {
      return { rows: [{ id: P1, name: 'Blusa', is_active: true, stock_qty: '10', barcode: '789', sku: null, master_sku: null }] };
    }
    if (/SELECT id, barcode, is_active FROM products/.test(sql)) return { rows: [{ id: D1, barcode: '789', is_active: true }] };
    if (/SELECT id, stock_qty FROM products WHERE id = ANY/.test(sql)) return { rows: [{ id: D1, stock_qty: '1' }] };
    if (/COALESCE\(MAX\(numero\)/.test(sql)) return { rows: [{ numero: 7 }] };
    if (/INSERT INTO stock_transfers/.test(sql)) {
      return { rows: [{ id: 'tttttttt-0000-4000-8000-000000000001', numero: 7, origem_company_id: LOJA, destino_company_id: DESTINO, criada_em: 'x', criada_por: 'dono', observacao: null, stock_count_id: params[8] || undefined }] };
    }
    return null;
  });
  const ORIGINAL = `INSERT INTO stock_transfers
       (grupo_company_id, numero, origem_company_id, destino_company_id, criada_por, observacao, itens_count, quantidade_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, numero, origem_company_id, destino_company_id, criada_em, criada_por, observacao`;

  test('sem o campo: o INSERT de sempre, sem sondar a migration, resposta sem stock_count_id', async () => {
    const { chamadas } = feliz();
    const r = await request(app).post(T_BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 3 }] });
    expect(r.status).toBe(201);
    expect(r.body.transferencia).not.toHaveProperty('stock_count_id');
    const ins = chamadas.find((c) => /INSERT INTO stock_transfers/.test(c.sql));
    expect(ins.sql).toBe(ORIGINAL);
    expect(ins.params).toHaveLength(8);
    expect(chamadas.some((c) => /stock_counts/.test(c.sql))).toBe(false);
    expect(db.query.mock.calls.some(([s]) => /stock_count_items/.test(String(s)))).toBe(false);
  });

  test('antes da migration: o campo e ignorado', async () => {
    migrationRodou = false;
    const { chamadas } = feliz();
    const r = await request(app).post(T_BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 3 }], stock_count_id: CONT });
    expect(r.status).toBe(201);
    expect(chamadas.find((c) => /INSERT INTO stock_transfers/.test(c.sql)).sql).toBe(ORIGINAL);
    expect(chamadas.some((c) => /FROM stock_counts/.test(c.sql))).toBe(false);
  });

  test('depois da migration: confere que e da origem e grava', async () => {
    const { chamadas } = feliz((sql) => (/FROM stock_counts WHERE id = \$1 AND company_id = \$2/.test(sql) ? { rows: [{ id: CONT, status: 'aplicada' }] } : null));
    const r = await request(app).post(T_BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 3 }], stock_count_id: CONT });
    expect(r.status).toBe(201);
    expect(r.body.transferencia.stock_count_id).toBe(CONT);
    const conf = chamadas.find((c) => /FROM stock_counts WHERE id/.test(c.sql));
    expect(conf.params).toEqual([CONT, LOJA]);
    const ins = chamadas.find((c) => /INSERT INTO stock_transfers/.test(c.sql));
    expect(ins.sql).toMatch(/stock_count_id\)/);
    expect(ins.params[8]).toBe(CONT);
  });

  test('conferencia de outra loja ou descartada: 400 CONFERENCIA_INVALIDA sem transferir', async () => {
    for (const rows of [[], [{ id: CONT, status: 'descartada' }]]) {
      const { chamadas } = feliz((sql) => (/FROM stock_counts WHERE id/.test(sql) ? { rows } : null));
      const r = await request(app).post(T_BASE).set('Authorization', `Bearer ${token()}`)
        .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 3 }], stock_count_id: CONT });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('CONFERENCIA_INVALIDA');
      expect(chamadas.some((c) => /^\s*(UPDATE|INSERT)/.test(c.sql))).toBe(false);
    }
  });
});
