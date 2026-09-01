// ============================================================
// AURA. — Notificações do app segmentadas por SHELL (migration 285)
//
// O que estes testes provam:
//   1. GET /companies/:id/notifications filtra banner por target_vertical
//      casando com COALESCE(vertical_active, vertical, 'negocio').
//   2. Em 42703 (migration 285 não aplicada) a rota NÃO quebra: repete a
//      query sem a coluna e responde 200 — e memoriza a decisão, para não
//      pagar o erro a cada poll de 30s.
//   3. read-all-banners usa o MESMO filtro do GET (write path espelha read
//      path — CLAUDE.md, armadilha 7).
//   4. A Gestão Aura recusa vertical inválida (400) antes de tocar o banco.
//
// MOCK POR SQL, NUNCA POR POSIÇÃO — o despacho lê a própria SQL. Fila
// posicional já derrubou o CI deste repo (CLAUDE.md).
// db.query vem do mock GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const SECRET = 'aura-test-secret-2026'; // igual ao forçado em tests/jest.setup.js
const CID    = 'company-dojo-1';

function err(code) {
  const e = new Error('column "target_vertical" does not exist');
  e.code = code;
  return e;
}

// 01/09/2026: app_notifications passou a ter DUAS leituras por poll —
// banners (type NOT LIKE 'loja_%') e eventos da loja (type LIKE 'loja_%').
// Este predicado casava com as duas, então o mock devolvia o mesmo banner
// nas duas e o unread_count vinha dobrado. O corte por type é o mesmo que a
// rota usa; ele é o que garante que evento de pedido não seja renderizado
// como card de endomarketing.
function isBannerSelect(sql) {
  return /FROM app_notifications/.test(sql) && /^\s*SELECT/.test(sql)
      && /NOT LIKE/.test(sql);
}
function isReadAll(sql) {
  return /INSERT INTO notification_reads/.test(sql) && /FROM app_notifications/.test(sql);
}
function hasVerticalClause(sql) {
  return /n\.target_vertical IS NULL/.test(sql);
}

describe('notificações do app — segmentação por shell', () => {
  let app, db;

  beforeEach(() => {
    // resetModules zera o cache module-level `hasTargetVertical` entre os
    // testes — e obriga a re-require do mock de db DEPOIS dele: o registry
    // novo cria um novo jest.fn, e mockar o antigo não teria efeito nenhum.
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    app = express();
    app.use(express.json());
    // O router real é montado em private.js sob /companies/:id/notifications,
    // já depois de requireAuth/requireCompanyAccess — aqui só o router.
    app.use('/companies/:id/notifications', require('../src/routes/notifications'));
  });

  test('GET filtra banner pelo shell da empresa e devolve os banners', async () => {
    const seen = [];
    db.query.mockImplementation((sql) => {
      seen.push(sql);
      if (isBannerSelect(sql)) {
        return Promise.resolve({ rows: [{ id: 'b1', title: 'Novidade do Dojô', target_vertical: 'karate_dojo' }] });
      }
      // digital_orders / studio_orders: sem pedido nas últimas 24h
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get(`/companies/${CID}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body.banners).toHaveLength(1);
    expect(res.body.unread_count).toBe(1);

    const bannerSql = seen.find(isBannerSelect);
    expect(hasVerticalClause(bannerSql)).toBe(true);
    // O shell tem que sair da PRÓPRIA empresa, nunca de constante do teste.
    expect(bannerSql).toMatch(/COALESCE\(vertical_active, vertical, 'negocio'\)/);
    expect(bannerSql).toMatch(/FROM companies WHERE id = \$1/);
  });

  test('42703: cai na query sem target_vertical, responde 200 e não repete o erro', async () => {
    const seen = [];
    db.query.mockImplementation((sql) => {
      seen.push(sql);
      if (isBannerSelect(sql)) {
        if (hasVerticalClause(sql)) return Promise.reject(err('42703'));
        return Promise.resolve({ rows: [{ id: 'b1', title: 'Aviso geral' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const first = await request(app).get(`/companies/${CID}/notifications`);
    expect(first.status).toBe(200);
    expect(first.body.banners).toHaveLength(1);
    expect(seen.filter(isBannerSelect).filter(hasVerticalClause)).toHaveLength(1);

    // Segundo poll: o cache module-level já sabe que a coluna não existe,
    // então a forma nova NÃO é tentada de novo.
    const second = await request(app).get(`/companies/${CID}/notifications`);
    expect(second.status).toBe(200);
    expect(seen.filter(isBannerSelect).filter(hasVerticalClause)).toHaveLength(1);
  });

  test('erro que não é 42703 continua virando 500 (não é engolido pelo fallback)', async () => {
    db.query.mockImplementation((sql) => {
      if (isBannerSelect(sql)) return Promise.reject(err('42P01'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get(`/companies/${CID}/notifications`);
    expect(res.status).toBe(500);
  });

  test('read-all-banners aplica o mesmo filtro de shell do GET', async () => {
    const seen = [];
    db.query.mockImplementation((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).post(`/companies/${CID}/notifications/read-all-banners`);

    expect(res.status).toBe(200);
    const sql = seen.find(isReadAll);
    expect(sql).toBeDefined();
    expect(hasVerticalClause(sql)).toBe(true);
    expect(sql).toMatch(/target_plan IS NULL/);
    expect(sql).toMatch(/expires_at IS NULL OR n\.expires_at > NOW\(\)/);
  });
});

describe('Gestão Aura — validação de target_vertical', () => {
  let adminApp, db;
  const adminToken = jwt.sign({ type: 'access', id: 'staff-1', role: 'admin' }, SECRET, { expiresIn: '1h' });

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    adminApp = express();
    adminApp.use(express.json());
    adminApp.use('/admin', require('../src/routes/adminNotifications'));
  });

  test('POST com vertical inexistente é 400 e não escreve nada', async () => {
    const res = await request(adminApp)
      .post('/admin/notifications/banners')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Aviso', target_vertical: 'jiu_jitsu' });

    expect(res.status).toBe(400);
    expect(res.body.valid_verticals).toContain('karate_dojo');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST com vertical válida cria o banner com target_vertical', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'b1', title: 'Aviso', target_vertical: 'karate_federation' }] });

    const res = await request(adminApp)
      .post('/admin/notifications/banners')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Aviso', target_vertical: 'karate_federation' });

    expect(res.status).toBe(201);
    expect(res.body.banner.target_vertical).toBe('karate_federation');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO app_notifications/);
    expect(sql).toMatch(/target_vertical/);
    expect(params).toContain('karate_federation');
  });

  test('POST sem target_vertical segue criando banner de todos os shells', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'b2', title: 'Global', target_vertical: null }] });

    const res = await request(adminApp)
      .post('/admin/notifications/banners')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Global' });

    expect(res.status).toBe(201);
    const [, params] = db.query.mock.calls[0];
    expect(params).toContain(null);
    expect(res.body.banner.target_vertical).toBeNull();
  });

  test('GET /notifications/verticals lista os shells aceitos', async () => {
    const res = await request(adminApp)
      .get('/admin/notifications/verticals')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.verticals).toEqual(
      expect.arrayContaining(['negocio', 'karate_dojo', 'karate_federation', 'studio'])
    );
  });
});
