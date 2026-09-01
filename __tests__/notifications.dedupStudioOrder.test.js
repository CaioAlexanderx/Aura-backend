// ============================================================
// AURA. — Feed de notificações: pedido do Studio não duplica
//
// Bug de 31/08/2026: um pedido de digital_orders com vertical 'studio'
// entrava no feed DUAS vezes — o bloco do Canal Digital seleciona de
// digital_orders sem filtrar vertical (source 'canal_digital') e o bloco
// do Studio seleciona da view studio_orders, cujo primeiro ramo é
// exatamente digital_orders WHERE vertical = 'studio' (source 'studio',
// MESMO id). O card do app usa key id+source, então não havia colisão de
// key — o pedido só aparecia duplicado na gaveta e contava dobrado no
// unread_count.
//
// O fix deduplica por id na mescla (não com WHERE vertical <> 'studio'
// no SQL: a criação da view studio_orders é condicional — migration 208,
// "deferida" sem marketplace_orders — e num ambiente sem a view o filtro
// SQL faria o pedido sumir do feed). O card 'studio' vence o dedup.
//
// MOCK POR SQL, NUNCA POR POSIÇÃO (CLAUDE.md). db.query vem do mock
// GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const CID = 'company-studio-1';

// Pedido do Studio vendido pelo Canal Digital: mesmo id nas duas queries.
const STUDIO_VIA_DIGITAL_ID = 'do-studio-0001';

function isBannerSelect(sql) {
  return /FROM app_notifications/.test(sql) && /^\s*SELECT/.test(sql);
}
function isDigitalOrders(sql) {
  return /FROM digital_orders/.test(sql);
}
function isStudioOrders(sql) {
  return /FROM studio_orders/.test(sql);
}

describe('feed de notificações — dedup de pedido Studio', () => {
  let app, db;

  beforeEach(() => {
    // resetModules zera o cache module-level hasTargetVertical e obriga o
    // re-require do mock de db DEPOIS (mesmo padrão de notifications.vertical).
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    app = express();
    app.use(express.json());
    app.use('/companies/:id/notifications', require('../src/routes/notifications'));
  });

  test('pedido digital com vertical studio aparece UMA vez, com o card studio', async () => {
    const now = new Date().toISOString();
    db.query.mockImplementation((sql) => {
      if (isBannerSelect(sql)) return Promise.resolve({ rows: [] });
      if (isDigitalOrders(sql)) {
        return Promise.resolve({ rows: [
          // O bloco do Canal Digital NÃO filtra vertical — devolve o pedido
          // studio junto com um pedido de varejo comum.
          { id: STUDIO_VIA_DIGITAL_ID, order_number: '00042', customer_name: 'Sheid Mania',
            total: '89.90', status: 'confirmed', created_at: now, source: 'canal_digital' },
          { id: 'do-retail-0002', order_number: '00043', customer_name: 'Davi Calçados',
            total: '45.90', status: 'confirmed', created_at: now, source: 'canal_digital' },
        ] });
      }
      if (isStudioOrders(sql)) {
        return Promise.resolve({ rows: [
          // Primeiro ramo da view: o MESMO pedido digital, relabelado.
          { id: STUDIO_VIA_DIGITAL_ID, order_number: '00042', customer_name: 'Sheid Mania',
            total: '89.90', status: 'confirmed', created_at: now, source: 'studio' },
          // Pedido de marketplace só existe na view — não pode ser dedupado.
          { id: 'mkt-0003', order_number: 'ML-abc123', customer_name: 'Cliente ML',
            total: '120.00', status: 'novo', created_at: now, source: 'studio' },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get(`/companies/${CID}/notifications`);

    expect(res.status).toBe(200);

    const ids = res.body.orders.map(o => o.id);
    // O pedido duplicado entra uma vez só…
    expect(ids.filter(id => id === STUDIO_VIA_DIGITAL_ID)).toHaveLength(1);
    // …e os demais continuam todos lá.
    expect(ids.sort()).toEqual(['do-retail-0002', 'do-studio-0001', 'mkt-0003']);

    // O card que sobrevive é o do Studio (roteia pro fluxo de produção).
    const survivor = res.body.orders.find(o => o.id === STUDIO_VIA_DIGITAL_ID);
    expect(survivor.source).toBe('studio');

    // unread_count não conta o pedido dobrado: 0 banners + 3 pedidos < 2h.
    expect(res.body.unread_count).toBe(3);
  });

  test('pedidos com ids distintos não são tocados pelo dedup', async () => {
    const now = new Date().toISOString();
    db.query.mockImplementation((sql) => {
      if (isBannerSelect(sql)) return Promise.resolve({ rows: [] });
      if (isDigitalOrders(sql)) {
        return Promise.resolve({ rows: [
          { id: 'do-1', order_number: '1', customer_name: 'A', total: '10.00',
            status: 'confirmed', created_at: now, source: 'canal_digital' },
        ] });
      }
      if (isStudioOrders(sql)) {
        return Promise.resolve({ rows: [
          { id: 'st-2', order_number: 'PDV-2', customer_name: 'B', total: '20.00',
            status: 'pending_art', created_at: now, source: 'studio' },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get(`/companies/${CID}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.orders.map(o => o.id).sort()).toEqual(['do-1', 'st-2']);
  });
});
