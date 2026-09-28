// ============================================================
// AURA Studio — numero do pedido no feed do Hub (27/09/2026)
//
// A busca do Hub de Pedidos (app#983, achado 3a do QA) filtra por nome,
// telefone ou numero do pedido, mas GET /studio/hub/orders selecionava
// direto de digital_orders sem `order_number` nem `customer_phone`: o
// unico "numero" possivel era o uuid interno, que a cliente nunca ve.
//
// Aqui trava:
//   (1) o SELECT dos pedidos pede order_number e customer_phone, e os dois
//       chegam na resposta ao lado dos campos que ja existiam;
//   (2) o SELECT dos eventos pede customer_phone e devolve order_number
//       nulo (evento nao tem numero de pedido), sem quebrar o feed unido.
//
// Mock por SQL, nunca por posicao.
// ============================================================
'use strict';

jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(() => Promise.resolve()),
  notifyStatusChange: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const pagamento = require('../src/services/pagamentoDoPedidoStudio');

const CID = 'c-studio';
const OID = '11111111-2222-3333-4444-555555555555';
const EID = '99999999-8888-7777-6666-555555555555';

function appDoStudio() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'u1', role: 'client', plan: 'negocio' }; next(); });
  app.use('/companies/:id/studio', require('../src/routes/studioBulkHub'));
  return app;
}

beforeEach(() => {
  db.query.mockReset();
  pagamento._resetParaTeste();
});

describe('GET /studio/hub/orders — numero do pedido e telefone', () => {
  test('(1) pedido digital: SELECT pede order_number e customer_phone, e a resposta traz os dois', async () => {
    const sqls = [];
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      sqls.push(s);
      if (/FROM digital_orders o/.test(s) && /'order'::text AS kind/.test(s)) {
        return Promise.resolve({ rows: [
          { id: OID, kind: 'order', created_at: '2026-09-20T12:00:00Z', amount: '89.82', status: 'pending_art',
            name: 'Helena', order_number: '00042', customer_phone: '11999990000', qty: 1 },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(appDoStudio()).get(`/companies/${CID}/studio/hub/orders?source=orders`);
    expect(res.status).toBe(200);

    const selectDosPedidos = sqls.find((s) => /FROM digital_orders o/.test(s) && /'order'::text AS kind/.test(s));
    expect(selectDosPedidos).toMatch(/o\.order_number/);
    expect(selectDosPedidos).toMatch(/o\.customer_phone/);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: OID, kind: 'order', status: 'pending_art', name: 'Helena', qty: 1,
      order_number: '00042', customer_phone: '11999990000',
    });
  });

  test('(2) evento: SELECT pede customer_phone e order_number vem nulo, no feed unido', async () => {
    const sqls = [];
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      sqls.push(s);
      if (/FROM digital_orders o/.test(s) && /'order'::text AS kind/.test(s)) {
        return Promise.resolve({ rows: [
          { id: OID, kind: 'order', created_at: '2026-09-20T12:00:00Z', amount: '89.82', status: 'pending_art',
            name: 'Helena', order_number: '00042', customer_phone: '11999990000', qty: 1 },
        ] });
      }
      if (/FROM studio_bulk_events/.test(s) && /'bulk'::text AS kind/.test(s)) {
        return Promise.resolve({ rows: [
          { id: EID, kind: 'bulk', created_at: '2026-09-21T12:00:00Z', amount: '1200.00', status: 'confirmed',
            name: 'Formatura Direito', qty: 40, order_number: null, customer_phone: '11988880000' },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(appDoStudio()).get(`/companies/${CID}/studio/hub/orders`);
    expect(res.status).toBe(200);

    const selectDosEventos = sqls.find((s) => /FROM studio_bulk_events/.test(s) && /'bulk'::text AS kind/.test(s));
    expect(selectDosEventos).toMatch(/NULL::text AS order_number/);
    expect(selectDosEventos).toMatch(/customer_phone/);

    // feed unido, mais recente primeiro: o evento (21/09) antes do pedido (20/09)
    expect(res.body.items.map((i) => i.kind)).toEqual(['bulk', 'order']);
    expect(res.body.items[0]).toMatchObject({ id: EID, order_number: null, customer_phone: '11988880000' });
    expect(res.body.items[1]).toMatchObject({ id: OID, order_number: '00042' });
  });
});
