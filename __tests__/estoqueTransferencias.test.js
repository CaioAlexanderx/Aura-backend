// ============================================================
// AURA. — Transferencia de estoque entre lojas (migration 444), banco mockado
//
// O caminho completo (copia, match, lock, movimentos) roda contra Postgres
// real em estoqueTransferencias.banco.test.js. Aqui:
//   1. leitura do corpo: soma item repetido, limite de 1.000, quantidade,
//      uuid, observacao
//   2. quem pode mexer no estoque (dono, admin, membro; consulta e
//      estoque desligado nao)
//   3. rota montada em private.js: MESMA_LOJA e lote acima do limite sem
//      tocar no banco; destino de outro grupo e destino "so consulta"
//      recusados; caminho feliz com baixa/entrada por unnest, movimentos
//      out/in com reference_type stock_transfer e numero fixo de queries
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const svc = require('../src/services/transferenciaDeEstoque');

const ORIGEM = '11111111-1111-4111-8111-111111111111';
const DESTINO = '22222222-2222-4222-8222-222222222222';
const OUTRA = '33333333-3333-4333-8333-333333333333';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const V2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const D1 = 'cccccccc-0000-4000-8000-000000000001';
const BASE = `/companies/${ORIGEM}/estoque/transferencias`;
const token = () => jwt.sign({ id: 'dono', role: 'client', plan: 'essencial', company: ORIGEM }, 'aura-test-secret-2026', { expiresIn: '1h' });

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/private'));
}, 60000);

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  svc._limparCacheDeColunas();
  // requireCompanyAccess: dono da origem
  db.query.mockImplementation(async (sql) => {
    if (/SELECT 'owner' AS role/.test(sql)) return { rows: [{ role: 'owner' }] };
    return { rows: [] };
  });
});

// Cliente falso que responde pelo texto da SQL.
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

const lojas = ({ destinoGrupo = ORIGEM, permissoesDestino = null, membroDestino = false } = {}) => ({
  rows: [
    { id: ORIGEM, grupo: ORIGEM, nome: 'Loja Centro', ativa: true, is_owner: true, role_label: null, permissions: null },
    {
      id: DESTINO, grupo: destinoGrupo, nome: 'Loja Shopping', ativa: true,
      is_owner: !membroDestino, role_label: membroDestino ? 'vendedor' : null, permissions: permissoesDestino,
    },
  ],
});

describe('lerPedido', () => {
  test('soma o mesmo item repetido e normaliza', () => {
    const p = svc.lerPedido({
      destino_company_id: DESTINO,
      itens: [{ product_id: P1, quantidade: 2 }, { product_id: P1.toUpperCase(), variant_id: null, quantidade: '1.5' }, { product_id: P2, variant_id: V2, quantidade: 1 }],
      observacao: '  ',
    });
    expect(p.destino).toBe(DESTINO);
    expect(p.itens).toEqual([
      { product_id: P1, variant_id: null, quantidade: 3.5 },
      { product_id: P2, variant_id: V2, quantidade: 1 },
    ]);
    expect(p.observacao).toBeNull();
  });

  test('quantidade zero, negativa ou texto: QUANTIDADE_INVALIDA', () => {
    for (const quantidade of [0, -1, 'abc', null, Infinity]) {
      try {
        svc.lerPedido({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade }] });
        throw new Error('nao lancou');
      } catch (e) {
        expect(e.code).toBe('QUANTIDADE_INVALIDA');
        expect(e.status).toBe(400);
      }
    }
  });

  test('sem itens ou acima de 1.000: QUANTIDADE_INVALIDA; 1.000 passa', () => {
    expect(() => svc.lerPedido({ destino_company_id: DESTINO, itens: [] })).toThrow(svc.ErroDeTransferencia);
    const mil = Array.from({ length: 1000 }, (_, i) => ({ product_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, quantidade: 1 }));
    expect(svc.lerPedido({ destino_company_id: DESTINO, itens: mil }).itens).toHaveLength(1000);
    try { svc.lerPedido({ destino_company_id: DESTINO, itens: [...mil, mil[0]] }); } catch (e) { expect(e.code).toBe('QUANTIDADE_INVALIDA'); }
  });

  test('id que nao e uuid: ITEM_NAO_ENCONTRADO; destino invalido: NAO_E_DO_GRUPO', () => {
    expect(() => svc.lerPedido({ destino_company_id: DESTINO, itens: [{ product_id: 'x', quantidade: 1 }] }))
      .toThrow(expect.objectContaining({ code: 'ITEM_NAO_ENCONTRADO' }));
    expect(() => svc.lerPedido({ itens: [{ product_id: P1, quantidade: 1 }] }))
      .toThrow(expect.objectContaining({ code: 'NAO_E_DO_GRUPO' }));
  });
});

describe('podeMexer', () => {
  test('dono e admin sempre; membro sem permissoes sim; consulta e estoque desligado nao', () => {
    expect(svc.podeMexer({ isOwner: true })).toBe(true);
    expect(svc.podeMexer({ roleLabel: 'admin', permissions: { estoque: false } })).toBe(true);
    expect(svc.podeMexer({ roleLabel: 'vendedor', permissions: null })).toBe(true);
    expect(svc.podeMexer({ roleLabel: 'vendedor', permissions: { estoque: true } })).toBe(true);
    expect(svc.podeMexer({ roleLabel: 'vendedor', permissions: { estoque: true, estoque_consulta: true } })).toBe(false);
    expect(svc.podeMexer({ roleLabel: 'vendedor', permissions: { estoque: false } })).toBe(false);
    expect(svc.podeMexer({ isOwner: false, roleLabel: null })).toBe(false);
  });

  test('assinatura dos atributos ignora caixa, espaco e ordem', () => {
    expect(svc.assinaturaDosAtributos([{ attribute_name: 'Tamanho', value: ' P ' }, { attribute_name: 'Cor', value: '#3B82F6' }]))
      .toBe(svc.assinaturaDosAtributos([{ attribute_name: 'cor', value: '#3b82f6' }, { attribute_name: 'TAMANHO', value: 'p' }]));
    expect(svc.assinaturaDosAtributos([])).toBeNull();
  });
});

describe('POST /estoque/transferencias', () => {
  test('mesma loja: 400 MESMA_LOJA sem abrir transacao', async () => {
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: ORIGEM, itens: [{ product_id: P1, quantidade: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MESMA_LOJA');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('1.001 itens: 400 sem abrir transacao', async () => {
    const itens = Array.from({ length: 1001 }, (_, i) => ({ product_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, quantidade: 1 }));
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token()}`).send({ destino_company_id: DESTINO, itens });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'QUANTIDADE_INVALIDA', limite: 1000 });
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('destino de outro grupo: 403 NAO_E_DO_GRUPO e ROLLBACK', async () => {
    const { chamadas } = clienteFalso((sql) => (/FROM companies c/.test(sql) ? lojas({ destinoGrupo: OUTRA }) : null));
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NAO_E_DO_GRUPO');
    expect(chamadas.map((c) => c.sql)).toContain('ROLLBACK');
    expect(chamadas.some((c) => /UPDATE|INSERT/.test(c.sql))).toBe(false);
  });

  test('membro "so consulta" no destino: 403 NAO_E_DO_GRUPO', async () => {
    clienteFalso((sql) => (/FROM companies c/.test(sql)
      ? lojas({ membroDestino: true, permissoesDestino: JSON.stringify({ estoque_consulta: true }) })
      : null));
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NAO_E_DO_GRUPO');
  });

  test('caminho feliz: baixa e entrada em lote, movimentos out/in, COMMIT', async () => {
    const { chamadas } = clienteFalso((sql) => {
      if (/FROM companies c/.test(sql)) return lojas();
      if (/FROM products\s+WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2\s+ORDER BY id\s+FOR UPDATE/.test(sql)) {
        return { rows: [{ id: P1, name: 'Blusa', is_active: true, stock_qty: '10', barcode: '789', sku: null, master_sku: null }] };
      }
      if (/SELECT id, barcode, is_active FROM products/.test(sql)) return { rows: [{ id: D1, barcode: '789', is_active: true }] };
      if (/SELECT id, stock_qty FROM products WHERE id = ANY/.test(sql)) return { rows: [{ id: D1, stock_qty: '1' }] };
      if (/COALESCE\(MAX\(numero\)/.test(sql)) return { rows: [{ numero: 7 }] };
      if (/INSERT INTO stock_transfers/.test(sql)) {
        return { rows: [{ id: 'tttttttt-0000-4000-8000-000000000001', numero: 7, origem_company_id: ORIGEM, destino_company_id: DESTINO, criada_em: '2026-11-10T12:00:00Z', criada_por: 'dono', observacao: null }] };
      }
      return null;
    });
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 3 }] });
    expect(res.status).toBe(201);
    expect(res.body.transferencia).toMatchObject({
      numero: 7, origem_company_id: ORIGEM, destino_company_id: DESTINO,
      itens: [{ product_id: P1, variant_id: null, destino_product_id: D1, destino_variant_id: null, quantidade: 3, criado_no_destino: false }],
    });
    const sqls = chamadas.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls.some((s) => /pg_advisory_xact_lock/.test(s))).toBe(true);
    const baixa = chamadas.find((c) => /UPDATE products t SET stock_qty = t.stock_qty - u.q/.test(c.sql));
    expect(baixa.params).toEqual([[P1], [3], ORIGEM]);
    const entrada = chamadas.find((c) => /UPDATE products t SET stock_qty = t.stock_qty \+ u.q/.test(c.sql));
    expect(entrada.params).toEqual([[D1], [3], DESTINO]);
    const mov = chamadas.find((c) => /INSERT INTO stock_movements/.test(c.sql));
    expect(mov.sql).toMatch(/'stock_transfer'/);
    expect(mov.params[0]).toEqual([P1, D1]);
    expect(mov.params[1]).toEqual([ORIGEM, DESTINO]);
    expect(mov.params[2]).toEqual(['out', 'in']);
    expect(mov.params[3]).toEqual([3, 3]);
    expect(chamadas.length).toBeLessThan(25);
  });

  test('tabela ainda nao criada: 503 SCHEMA_PENDENTE', async () => {
    clienteFalso((sql) => {
      if (/FROM companies c/.test(sql)) return lojas();
      if (/FROM products\s+WHERE id = ANY/.test(sql)) return { rows: [{ id: P1, name: 'Blusa', is_active: true, stock_qty: 10 }] };
      if (/stock_transfer_items/.test(sql)) return Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return null;
    });
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token()}`)
      .send({ destino_company_id: DESTINO, itens: [{ product_id: P1, quantidade: 1 }] });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDENTE');
  });
});
