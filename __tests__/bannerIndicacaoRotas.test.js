// ============================================================
// AURA. Banner de indicação nas rotas (08/11/2026, card b-mk-30)
//
//   1. GET /companies/:id/notifications reescreve o texto do banner de
//      indicação pela fase (BLACK50 só com cupom) e marca a campanha.
//   2. POST /companies/:id/notifications/:nid/indicacao grava vista/clique;
//      staff em modo admin não conta; evento inválido é 400.
//   3. GET /admin/notifications/indicacao/contadores é só staff.
//   4. GET /referrals/mine devolve a fase do texto.
// Mock por SQL, nunca por posição. db.query vem do mock global.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = 'aura-test-secret-2026';
const CID = '11111111-2222-3333-4444-555555555555';
const NID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UID = '66666666-7777-8888-9999-000000000000';

const NA_BF = new Date('2026-11-13T12:00:00Z');

let db;
function despacho({ black50 = { uses: 0, max_uses: 10, is_active: true }, banners = [] } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM access_codes WHERE code = \$1/.test(sql)) return { rows: black50 ? [black50] : [] };
    if (/FROM app_notifications n/.test(sql) && /NOT LIKE/.test(sql)) return { rows: banners };
    if (/INSERT INTO audit_log/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
}

function appEmpresa(user = { id: UID, role: 'user' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/companies/:id/notifications', require('../src/routes/notifications'));
  return app;
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers({ now: NA_BF, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'] });
  db = require('../src/config/database');
  db.query.mockReset();
});
afterEach(() => { jest.useRealTimers(); });

describe('GET /notifications com banner de indicação', () => {
  const linha = {
    id: NID, type: 'banner', title: 'velho', body: 'velho', cta_label: 'Gerar meu código',
    cta_route: '/configuracoes?foco=indicacao', created_at: '2026-10-30T09:00:00Z',
    target_vertical: null, dedupe_key: 'indicacao-bf-2026:' + CID,
  };
  const comum = { ...linha, id: 'outro', title: 'Novidade', body: 'b', dedupe_key: null };

  test('com BLACK50 disponível: texto da Black e campanha marcada; sem dedupe_key', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    despacho({ banners: [linha, comum] });
    const res = await request(appEmpresa()).get(`/companies/${CID}/notifications`);
    expect(res.status).toBe(200);
    const [b, c] = res.body.banners;
    expect(b).toMatchObject({ title: svc.BANNER_BLACK_FRIDAY.title, campanha: 'indicacao', fase: 'black' });
    expect(b).not.toHaveProperty('dedupe_key');
    expect(c).toMatchObject({ title: 'Novidade' });
    expect(c).not.toHaveProperty('campanha');
  });

  test('BLACK50 com 10 de 10 usos: banner no ar cai para o texto sem BLACK50', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    despacho({ banners: [linha], black50: { uses: 10, max_uses: 10, is_active: true } });
    const res = await request(appEmpresa()).get(`/companies/${CID}/notifications`);
    expect(res.body.banners[0]).toMatchObject({ title: svc.BANNER.title, body: svc.BANNER.body, fase: 'sem_black50' });
    expect(res.body.banners[0].body).not.toMatch(/BLACK50/);
  });

  test('a consulta de banners traz dedupe_key (para reconhecer o banner)', async () => {
    despacho({ banners: [] });
    await request(appEmpresa()).get(`/companies/${CID}/notifications`);
    const sel = db.query.mock.calls.find(([s]) => /FROM app_notifications n/.test(s) && /NOT LIKE/.test(s));
    expect(sel[0]).toContain('n.dedupe_key');
    // Sem banner de indicação, nada de ler o cupom.
    expect(db.query.mock.calls.some(([s]) => /FROM access_codes/.test(s))).toBe(false);
  });
});

describe('POST /notifications/:nid/indicacao', () => {
  test('vista grava audit_log indicacao.banner_visto', async () => {
    despacho();
    const res = await request(appEmpresa()).post(`/companies/${CID}/notifications/${NID}/indicacao`).send({ evento: 'vista' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrado: true });
    const ins = db.query.mock.calls.find(([s]) => /INSERT INTO audit_log/.test(s));
    expect(ins[1].slice(0, 3)).toEqual([UID, CID, 'indicacao.banner_visto']);
  });

  test('clique grava indicacao.banner_clique', async () => {
    despacho();
    await request(appEmpresa()).post(`/companies/${CID}/notifications/${NID}/indicacao`).send({ evento: 'clique' });
    const ins = db.query.mock.calls.find(([s]) => /INSERT INTO audit_log/.test(s));
    expect(ins[1][2]).toBe('indicacao.banner_clique');
  });

  test('evento inválido ou id inválido: 400 sem tocar o banco', async () => {
    despacho();
    const a = await request(appEmpresa()).post(`/companies/${CID}/notifications/${NID}/indicacao`).send({ evento: 'x' });
    const b = await request(appEmpresa()).post(`/companies/${CID}/notifications/nao-e-uuid/indicacao`).send({ evento: 'vista' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('staff em modo admin não conta', async () => {
    despacho();
    const res = await request(appEmpresa({ id: UID, role: 'admin' }))
      .post(`/companies/${CID}/notifications/${NID}/indicacao`).send({ evento: 'vista' });
    expect(res.body).toEqual({ registrado: false });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('banco fora: responde registrado false, nunca 500', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValue(new Error('fora'));
    const res = await request(appEmpresa()).post(`/companies/${CID}/notifications/${NID}/indicacao`).send({ evento: 'vista' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrado: false });
    err.mockRestore();
  });
});

describe('GET /admin/notifications/indicacao/contadores', () => {
  const adminToken = () => jwt.sign({ type: 'access', id: 'staff-1', role: 'admin' }, SECRET, { expiresIn: '1h' });
  const userToken = () => jwt.sign({ type: 'access', id: UID, role: 'user' }, SECRET, { expiresIn: '1h' });
  const adminApp = () => {
    const app = express();
    app.use('/admin', require('../src/routes/adminNotifications'));
    return app;
  };

  test('só staff', async () => {
    despacho();
    const res = await request(adminApp()).get('/admin/notifications/indicacao/contadores')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(403);
  });

  test('staff lê os contadores; desde em data vira meia-noite de Brasília', async () => {
    despacho();
    const res = await request(adminApp()).get('/admin/notifications/indicacao/contadores?desde=2026-11-01')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.periodo.desde).toBe('2026-11-01T03:00:00.000Z');
    expect(res.body).toHaveProperty('vistas');
    expect(res.body).toHaveProperty('cliques_gerar_codigo');
    expect(res.body).toHaveProperty('indicacoes.depois_do_clique_no_banner');
    expect(res.body.black50).toMatchObject({ usos: 0, limite: 10, esgotado: false });
  });

  test('data inválida é 400', async () => {
    despacho();
    const res = await request(adminApp()).get('/admin/notifications/indicacao/contadores?desde=ontem')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /referrals/mine devolve a fase do texto', () => {
  const app = () => {
    const a = express();
    a.use('/referrals', require('../src/routes/accessCodes'));
    return a;
  };
  const token = () => jwt.sign({ type: 'access', id: UID, role: 'user' }, SECRET, { expiresIn: '1h' });

  test.each([
    [{ uses: 0, max_uses: 10, is_active: true }, 'black'],
    [{ uses: 10, max_uses: 10, is_active: true }, 'sem_black50'],
  ])('BLACK50 %j → %s', async (black50, fase) => {
    despacho({ black50 });
    const res = await request(app()).get('/referrals/mine').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.campanha).toEqual({ fase });
  });
});
