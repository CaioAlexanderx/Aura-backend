// ============================================================
// AURA. — GET /companies/:id/notifications com os eventos da loja (315)
//
// O QUE ESTE ARQUIVO PROTEGE: o CONTRATO da rota. O app já consome
// `banners`, `orders` e `unread_count`; o que entrou foi `events`. Se um
// evento 'loja_*' vazar para dentro de `banners`, o app tenta renderizá-lo
// como card de endomarketing (html_content, CTA externo) — falha silenciosa,
// do tipo que ninguém vê em teste unitário de serviço.
//
// Router isolado (private.js é de outro bloco). O app abaixo replica
// requireAuth + requireCompanyAccess + mount, igual aos outros testes de
// rota. Mock do db despacha por CONTEÚDO DO SQL, nunca por fila posicional.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const notificationsRouter = require('../../src/routes/notifications');
const lojaEvents = require('../../src/services/lojaEvents');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => { jest.resetAllMocks(); lojaEvents._resetCaches(); });

const SECRET = 'aura-test-secret-2026';
const CID = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const OID = 'bb2ffcea-0000-0000-0000-000000000009';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess()); // admin bypassa o SELECT no banco
  scoped.use('/notifications', notificationsRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

const BANNER = {
  id: 'n-banner', type: 'banner', title: 'Novidade', body: 'Chegou o Aura Notas',
  html_content: '<b>oi</b>', cta_label: 'Ver', cta_url: null, cta_route: '/planos',
  created_at: '2026-09-01T10:00:00.000Z',
};
const EVENTO = {
  id: 'n-evento', type: 'loja_comprovante_enviado',
  title: 'Comprovante para conferir #00042',
  body: 'Davi Calçados enviou o comprovante de R$ 129,90. Confira e aprove o pagamento.',
  cta_label: 'Conferir', cta_url: null,
  cta_route: `/canal?tab=pedidos&order_id=${OID}`,
  dedupe_key: `loja:comprovante_enviado:${OID}`,
  entity_ref: `pedido:${OID}`, entity_label: 'Pedido #00042',
  created_at: '2026-09-01T11:00:00.000Z',
};

// Roteia por SQL. As duas leituras de app_notifications se separam pelo
// NOT LIKE — que é exatamente o corte que este teste existe para travar.
function mockFeed({ banners = [], events = [], orders = [], prefs = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/company_notification_prefs/i.test(s)) return Promise.resolve({ rows: prefs });
    if (/FROM app_notifications/i.test(s)) {
      return Promise.resolve({ rows: /NOT LIKE/.test(s) ? banners : events });
    }
    if (/FROM digital_orders/i.test(s)) return Promise.resolve({ rows: orders });
    if (/FROM studio_orders/i.test(s)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

describe('GET /notifications — shape', () => {
  test('401 sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`);
    expect(res.status).toBe(401);
  });

  test('devolve banners, events, orders e unread_count', async () => {
    mockFeed({ banners: [BANNER], events: [EVENTO] });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['banners', 'events', 'orders', 'unread_count']);
  });

  // O corte. Sem ele o evento cai em `banners` e o app o pinta como
  // endomarketing.
  test('evento loja_* NAO aparece dentro de banners', async () => {
    mockFeed({ banners: [BANNER], events: [EVENTO] });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.body.banners.map((b) => b.id)).toEqual(['n-banner']);
    expect(res.body.events.map((e) => e.id)).toEqual(['n-evento']);
  });

  test('cada evento vem com severity derivada e order_id extraido da dedupe_key', async () => {
    mockFeed({ events: [EVENTO] });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.body.events[0]).toEqual({
      id: 'n-evento',
      type: 'loja_comprovante_enviado',
      severity: 'atencao',
      title: EVENTO.title,
      body: EVENTO.body,
      cta_label: 'Conferir',
      cta_url: null,
      cta_route: `/canal?tab=pedidos&order_id=${OID}`,
      entity_id: `pedido:${OID}`,
      entity_label: 'Pedido #00042',
      read_at: null,
      order_id: OID,
      created_at: EVENTO.created_at,
    });
  });

  test('evento sem pedido devolve order_id null (nao inventa uuid)', async () => {
    mockFeed({ events: [{
      ...EVENTO, id: 'n-sem-pedido', type: 'loja_sem_pagamento_configurado',
      dedupe_key: `loja:sem_pagamento_configurado:${CID}:2026-09-01`,
      entity_ref: null, entity_label: null,
    }] });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.body.events[0].order_id).toBeNull();
    expect(res.body.events[0].entity_id).toBeNull();
    expect(res.body.events[0].severity).toBe('critico');
  });

  test('unread_count soma banners + eventos + pedidos recentes', async () => {
    mockFeed({
      banners: [BANNER],
      events: [EVENTO, { ...EVENTO, id: 'n2' }],
      orders: [{ id: OID, order_number: '00042', customer_name: 'Davi', total: 10,
                 status: 'pending_payment', created_at: new Date().toISOString(), source: 'canal_digital' }],
    });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.body.unread_count).toBe(4);
  });

  // Ambiente sem migration 285/315: o feed antigo continua inteiro em vez de
  // a rota virar 500 e o app ficar sem sino nenhum.
  test('falha na leitura dos eventos nao derruba o resto do feed', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM app_notifications/i.test(s)) {
        if (/NOT LIKE/.test(s)) return Promise.resolve({ rows: [BANNER] });
        return Promise.reject(Object.assign(new Error('column dedupe_key does not exist'), { code: '42703' }));
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.banners).toHaveLength(1);
  });
});

describe('severidade', () => {
  // Combinado com o frontend: valores EM PORTUGUES, sem acento. Se isto
  // virar 'warning'/'critical' o app pinta tudo de cinza sem dar erro.
  test('so info | atencao | critico atravessam a rota', async () => {
    mockFeed({ events: [
      EVENTO,
      { ...EVENTO, id: 'n2', type: 'loja_pedido_entregue' },
      { ...EVENTO, id: 'n3', type: 'loja_sem_pagamento_configurado' },
    ] });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.body.events.map((e) => e.severity)).toEqual(['atencao', 'info', 'critico']);
  });
});

describe('preferencias', () => {
  // Record<type, boolean> — o formato que o app consome. O catalogo (labels,
  // severidade, default) vem ao lado, aditivo.
  test('GET devolve Record<type, boolean> + catalogo', async () => {
    mockFeed({ prefs: [{ event_type: 'loja_pedido_entregue', enabled: true }] });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications/preferences`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.preferences.loja_pedido_entregue).toBe(true);
    expect(res.body.preferences.loja_pedido_novo).toBe(true);
    expect(res.body.preferences.app_banner).toBe(true);
    expect(Object.values(res.body.preferences).every((v) => typeof v === 'boolean')).toBe(true);
    const entregue = res.body.catalog.find((p) => p.type === 'loja_pedido_entregue');
    expect(entregue).toMatchObject({
      severity: 'info', default_enabled: false, enabled: true, customized: true,
    });
    expect(res.body.catalog.every((p) => p.label && p.hint)).toBe(true);
  });

  test('PUT aceita a pseudo-chave app_banner', async () => {
    mockFeed();
    const res = await request(app)
      .put(`/api/v1/companies/${CID}/notifications/preferences`).set(auth)
      .send({ preferences: { app_banner: false } });
    expect(res.status).toBe(200);
    const up = db.query.mock.calls.find((c) => /INSERT INTO company_notification_prefs/.test(c[0]));
    expect(up[1]).toEqual([CID, 'app_banner', false]);
  });

  // Gate na LEITURA: o banner nao e criado por empresa, entao nao ha INSERT
  // nosso para nao fazer.
  test('app_banner desligado esvazia banners sem tocar em events', async () => {
    mockFeed({ banners: [BANNER], events: [EVENTO],
               prefs: [{ event_type: 'app_banner', enabled: false }] });
    const res = await request(app).get(`/api/v1/companies/${CID}/notifications`).set(auth);
    expect(res.body.banners).toEqual([]);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.unread_count).toBe(1);
  });

  test('PUT grava so o que veio e devolve o estado novo', async () => {
    mockFeed();
    const res = await request(app)
      .put(`/api/v1/companies/${CID}/notifications/preferences`).set(auth)
      .send({ preferences: { loja_pedido_entregue: true } });
    expect(res.status).toBe(200);
    const upserts = db.query.mock.calls.filter((c) => /INSERT INTO company_notification_prefs/.test(c[0]));
    expect(upserts).toHaveLength(1);
    expect(upserts[0][1]).toEqual([CID, 'loja_pedido_entregue', true]);
  });

  // Sem FK para um catálogo de tipos: quem valida é a rota. Sem isto, um
  // typo do frontend vira linha morta na tabela e a preferência "não pega".
  test('PUT recusa tipo fora da taxonomia', async () => {
    mockFeed();
    const res = await request(app)
      .put(`/api/v1/companies/${CID}/notifications/preferences`).set(auth)
      .send({ preferences: { loja_inventado: true } });
    expect(res.status).toBe(400);
    expect(res.body.valid_types).toContain('loja_pedido_pago');
    expect(db.query.mock.calls.some((c) => /INSERT INTO company_notification_prefs/.test(c[0]))).toBe(false);
  });

  test('PUT recusa valor que nao e booleano', async () => {
    mockFeed();
    const res = await request(app)
      .put(`/api/v1/companies/${CID}/notifications/preferences`).set(auth)
      .send({ preferences: { loja_pedido_pago: 'sim' } });
    expect(res.status).toBe(400);
  });
});

describe('marcar como lido', () => {
  // Forma curta: e a que o app chama.
  test('/:nid/read grava em notification_reads (idempotente)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${CID}/notifications/n-evento/read`).set(auth);
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls.find((c) => /INSERT INTO notification_reads/.test(c[0]));
    expect(sql).toMatch(/ON CONFLICT .* DO NOTHING/);
    expect(params).toEqual(['n-evento', CID]);
  });

  test('/read-all responde 200 (o app so cai no legado se der 4xx)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${CID}/notifications/read-all`).set(auth);
    expect(res.status).toBe(200);
    expect(db.query.mock.calls.some((c) => /INSERT INTO notification_reads/.test(c[0]))).toBe(true);
  });

  test('/events/:nid/read grava em notification_reads (idempotente)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${CID}/notifications/events/n-evento/read`).set(auth);
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls.find((c) => /INSERT INTO notification_reads/.test(c[0]));
    expect(sql).toMatch(/ON CONFLICT .* DO NOTHING/);
    expect(params).toEqual(['n-evento', CID]);
  });

  // "Marcar todas como lidas" que deixasse metade da gaveta acesa seria pior
  // que o problema que resolve: o read-all cobre banners E eventos.
  test('read-all-banners nao filtra por type', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${CID}/notifications/read-all-banners`).set(auth);
    expect(res.status).toBe(200);
    const [sql] = db.query.mock.calls.find((c) => /INSERT INTO notification_reads/.test(c[0]));
    expect(sql).not.toMatch(/LIKE 'loja/);
  });
});
