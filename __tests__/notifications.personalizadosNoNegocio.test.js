// ============================================================
// AURA. — Feed de notificações: card do Studio na frente Personalizados (p-194)
//
// Empresa com a frente no Negócio (studio_enabled true, sem vertical_active
// 'studio'): o card source 'studio' ganha cta_route /personalizados/pedido/<id>.
// No /studio, e quando a leitura da empresa falha, o card sai como antes.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const CID = 'company-studio-1';
const ID = 'do-studio-0001';

describe('feed de notificações — card do Studio (p-194)', () => {
  let app, db, empresa;

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    empresa = null;
    const now = new Date().toISOString();
    db.query.mockImplementation((sql) => {
      if (/FROM companies WHERE id = \$1/.test(sql) && /studio_enabled/.test(sql)) {
        if (empresa instanceof Error) return Promise.reject(empresa);
        return Promise.resolve({ rows: empresa ? [empresa] : [] });
      }
      if (/FROM studio_orders/.test(sql)) {
        return Promise.resolve({ rows: [{ id: ID, order_number: '00042', customer_name: 'M', total: '9.90', status: 'x', created_at: now, source: 'studio' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    app = express();
    app.use(express.json());
    app.use('/companies/:id/notifications', require('../src/routes/notifications'));
  });

  const card = async () => (await request(app).get(`/companies/${CID}/notifications`)).body.orders[0];

  test('frente no Negócio: o card leva a /personalizados/pedido', async () => {
    empresa = { vertical_active: null, studio_enabled: true };
    const c = await card();
    expect(c.cta_route).toBe(`/personalizados/pedido/${ID}`);
    expect(c.source).toBe('studio');
  });

  test('vertical Studio: o card sai como antes, sem cta_route', async () => {
    empresa = { vertical_active: 'studio', studio_enabled: true };
    const c = await card();
    expect(c).not.toHaveProperty('cta_route');
    expect(c).not.toHaveProperty('personalizados_no_negocio');
  });

  test('falha ao ler a empresa: o card sai como antes', async () => {
    empresa = new Error('db fora');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const c = await card();
    expect(c).not.toHaveProperty('cta_route');
  });
});
