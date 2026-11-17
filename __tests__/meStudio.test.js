// ============================================================
// AURA. — /me/studio/orders e /me/studio/quotes (p-186), banco simulado
//
// Trava:
//   1. a regra de que lojas entram (plano por loja + permissão do membro);
//   2. ?company_id= de loja de outro dono: 403, sem consultar pedido nenhum;
//   3. loja do usuário fora da regra: lista vazia, sem erro;
//   4. a consulta só recebe as lojas que entram; limite e etapa validados;
//   5. nenhuma escrita: todo SQL das duas rotas é SELECT.
// O comportamento contra o Postgres real está em meStudio.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'u-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const db = require('../src/config/database');
const meStudio = require('../src/routes/meStudio');

const app = express();
app.use('/me', meStudio);

const loja = (id, extra = {}) => ({
  id, legal_name: `Razão ${id}`, trade_name: `Loja ${id}`, plan: 'negocio',
  is_primary: false, created_at: '2026-01-01T00:00:00Z',
  is_owner: true, role_label: null, permissions: null, ...extra,
});

function simularBanco(lojas) {
  const sqls = [];
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    sqls.push({ sql, params });
    if (/FROM companies c/.test(sql)) return { rows: lojas };
    if (/to_regclass/.test(sql)) return { rows: [{ t: 'credit_installments' }] };
    if (/information_schema\.columns/.test(sql)) return { rows: [{}] };
    if (/COUNT\(\*\)::int AS total FROM/.test(sql) && /GROUP BY/.test(sql)) {
      return { rows: params[0].map((cid) => ({ company_id: cid, total: 1 })) };
    }
    if (/COUNT\(\*\)::int AS total FROM/.test(sql)) return { rows: [{ total: 1 }] };
    if (/FROM studio_orders o/.test(sql)) {
      return { rows: [{ id: 'o-1', company_id: params[0][0], source: 'pdv', card_image_url: null }] };
    }
    if (/FROM studio_quotes q/.test(sql)) {
      return { rows: [{ id: 'q-1', company_id: params[0][0], status: 'sent' }] };
    }
    return { rows: [] };
  });
  return sqls;
}

describe('lojaEntra (regra pura)', () => {
  const entra = meStudio._lojaEntra;
  test('plano: Negócio, Expansão e Personalizado entram; Essencial e vazio não', () => {
    expect(entra({ plan: 'negocio', isOwner: true })).toBe(true);
    expect(entra({ plan: 'expansao', isOwner: true })).toBe(true);
    expect(entra({ plan: 'personalizado', isOwner: true })).toBe(true);
    expect(entra({ plan: 'essencial', isOwner: true })).toBe(false);
    expect(entra({ plan: null, isOwner: true })).toBe(false);
  });
  test('membro: sem restrição ou com personalizados.access; papel owner conta como dono', () => {
    expect(entra({ plan: 'negocio', isOwner: false, roleLabel: 'vendedor', permissions: null })).toBe(true);
    expect(entra({ plan: 'negocio', isOwner: false, roleLabel: 'owner', permissions: { pdv: true } })).toBe(true);
    expect(entra({ plan: 'negocio', isOwner: false, roleLabel: 'vendedor', permissions: { 'personalizados.access': true } })).toBe(true);
    expect(entra({ plan: 'negocio', isOwner: false, roleLabel: 'vendedor', permissions: { pdv: true } })).toBe(false);
    expect(entra({ plan: 'negocio', isOwner: false, roleLabel: 'admin', permissions: { estoque: true } })).toBe(false);
  });
});

describe.each([
  ['orders', 'orders'],
  ['quotes', 'quotes'],
])('GET /me/studio/%s', (rota, chave) => {
  test('só as lojas que entram vão para a consulta, com o nome da loja na linha', async () => {
    const sqls = simularBanco([
      loja('a', { is_primary: true }),
      loja('b', { plan: 'essencial' }),
      loja('c', { is_owner: false, role_label: 'vendedor', permissions: { pdv: true } }),
      loja('d', { is_owner: false, role_label: 'vendedor', permissions: { 'personalizados.access': true } }),
    ]);
    const res = await request(app).get(`/me/studio/${rota}`);
    expect(res.status).toBe(200);
    expect(res.body[chave][0].company_name).toBe('Loja a');
    expect(res.body.company_count).toBe(2);
    expect(res.body.breakdown.map((b) => b.company_id)).toEqual(['a', 'd']);
    const tabela = rota === 'orders' ? 'studio_orders' : 'studio_quotes';
    const daTabela = sqls.filter((s) => s.sql.includes(tabela));
    expect(daTabela.length).toBeGreaterThan(0);
    daTabela.forEach((s) => expect(s.params[0]).toEqual(['a', 'd']));
  });

  test('?company_id= de loja de outro dono: 403 e nenhuma consulta de pedido', async () => {
    const sqls = simularBanco([loja('a')]);
    const res = await request(app).get(`/me/studio/${rota}?company_id=de-fora`);
    expect(res.status).toBe(403);
    expect(sqls.filter((s) => /studio_orders|studio_quotes/.test(s.sql))).toHaveLength(0);
  });

  test('?company_id= de loja dele sem o plano: vazio, sem erro', async () => {
    const sqls = simularBanco([loja('a'), loja('b', { plan: 'essencial' })]);
    const res = await request(app).get(`/me/studio/${rota}?company_id=b`);
    expect(res.status).toBe(200);
    expect(res.body[chave]).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.filtered_company_id).toBe('b');
    expect(sqls.filter((s) => /studio_orders|studio_quotes/.test(s.sql))).toHaveLength(0);
  });

  test('?company_id= de loja que entra: a consulta vai só com ela', async () => {
    const sqls = simularBanco([loja('a'), loja('d')]);
    const res = await request(app).get(`/me/studio/${rota}?company_id=d`);
    expect(res.status).toBe(200);
    const lista = sqls.find((s) => /ORDER BY/.test(s.sql) && /studio_(orders|quotes)/.test(s.sql));
    expect(lista.params[0]).toEqual(['d']);
    // o breakdown segue com todas as lojas que entram
    expect(res.body.breakdown.map((b) => b.company_id)).toEqual(['a', 'd']);
  });

  test('nenhuma loja entra: lista vazia', async () => {
    simularBanco([loja('b', { plan: 'essencial' })]);
    const res = await request(app).get(`/me/studio/${rota}`);
    expect(res.status).toBe(200);
    expect(res.body[chave]).toEqual([]);
    expect(res.body.company_count).toBe(0);
  });

  test('limite: no máximo 200, padrão 50, offset repassado', async () => {
    const sqls = simularBanco([loja('a')]);
    let res = await request(app).get(`/me/studio/${rota}?limit=5000&offset=40`);
    expect(res.body.limit).toBe(200);
    expect(res.body.offset).toBe(40);
    const lista = sqls.find((s) => /LIMIT \$\d+ OFFSET/.test(s.sql));
    expect(lista.params.slice(-2)).toEqual([200, 40]);
    res = await request(app).get(`/me/studio/${rota}`);
    expect(res.body.limit).toBe(50);
  });

  test('situação inválida: 400', async () => {
    simularBanco([loja('a')]);
    const res = await request(app).get(`/me/studio/${rota}?status=qualquer`);
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.valid_status)).toBe(true);
  });

  test('só leitura: todo SQL é SELECT', async () => {
    const sqls = simularBanco([loja('a'), loja('d')]);
    await request(app).get(`/me/studio/${rota}?status=${rota === 'orders' ? 'pending_art' : 'sent'}`);
    expect(sqls.length).toBeGreaterThan(0);
    sqls.forEach((s) => {
      expect(s.sql.trim()).toMatch(/^SELECT/i);
      expect(s.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    });
  });
});

test('pedidos: card_customization sai null e a capa ganha a origem', async () => {
  simularBanco([loja('a')]);
  const res = await request(app).get('/me/studio/orders');
  const o = res.body.orders[0];
  expect(o.card_customization).toBeNull();
  expect(o).toHaveProperty('card_image_source');
  expect(o.company_id).toBe('a');
});
