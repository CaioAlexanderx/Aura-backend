// ============================================================
// AURA. — Aviso no sino: pedido de Personalizados no Negócio (p-177)
//
// routeForOrder apontava todo pedido do Studio para /studio/pedidos/<id>.
// A empresa com a frente Personalizados no Negócio (studio_enabled true e
// SEM vertical_active 'studio') não abre o /studio: o aviso dela vai para
// /personalizados/pedido/<id>. Para quem está no /studio, nada muda.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const appNotifications = require('../src/services/appNotifications');
const webPush = require('../src/services/webPush');
const lojaEvents = require('../src/services/lojaEvents');

const CID = 'c0000000-0000-0000-0000-000000000001';
const OID = 'bb2ffcea-0000-0000-0000-000000000009';
const ORDER = {
  id: OID, company_id: CID, order_number: '00042', customer_name: 'Marina',
  total: '49.90', vertical: 'studio', courier_name: null, courier_plate: null,
};

let empresa;
let criados;
function mockDb(order = ORDER) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/company_notification_prefs/i.test(s)) return { rows: [] };
    if (/FROM digital_orders/i.test(s)) return { rows: [order] };
    if (/FROM companies WHERE id = \$1/i.test(s) && /studio_enabled/.test(s)) {
      if (empresa instanceof Error) throw empresa;
      return { rows: empresa ? [empresa] : [] };
    }
    return { rows: [] };
  });
}

const consultasDaCasa = () => db.query.mock.calls.filter(([s]) => /pdv_settings->'studio_enabled'/.test(String(s)));

beforeEach(() => {
  jest.resetAllMocks();
  lojaEvents._resetCaches();
  criados = [];
  empresa = null;
  mockDb();
  jest.spyOn(appNotifications, 'notifyCompany').mockImplementation(async (cid, p) => {
    criados.push(p);
    return { id: 'n' + criados.length };
  });
  jest.spyOn(webPush, 'notifyCompany').mockResolvedValue({ enviados: 1 });
});
afterEach(() => jest.restoreAllMocks());

describe('routeForOrder', () => {
  test('sem a marca, igual a antes', () => {
    expect(lojaEvents.routeForOrder({ id: OID, vertical: 'studio' })).toBe(`/studio/pedidos/${OID}`);
    expect(lojaEvents.routeForOrder({ id: OID, vertical: null })).toBe(`/canal?tab=pedidos&order_id=${OID}`);
  });
  test('com a frente no Negócio, abre o pedido em Personalizados', () => {
    expect(lojaEvents.routeForOrder({ id: OID, vertical: 'studio', personalizados_no_negocio: true }))
      .toBe(`/personalizados/pedido/${OID}`);
  });
  test('a marca não mexe em pedido da loja comum', () => {
    expect(lojaEvents.routeForOrder({ id: OID, vertical: null, personalizados_no_negocio: true }))
      .toBe(`/canal?tab=pedidos&order_id=${OID}`);
  });
});

describe('emitLojaEvent', () => {
  test('frente Personalizados no Negócio: sino e navegador abrem /personalizados/pedido', async () => {
    empresa = { vertical_active: null, studio_enabled: true };
    await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
    expect(criados[0].ctaRoute).toBe(`/personalizados/pedido/${OID}`);
    expect(webPush.notifyCompany.mock.calls[0][1].url).toBe(`/personalizados/pedido/${OID}`);
    expect(consultasDaCasa()[0][1]).toEqual([CID]);
  });

  test('vertical Studio: continua no /studio', async () => {
    empresa = { vertical_active: 'studio', studio_enabled: true };
    await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
    expect(criados[0].ctaRoute).toBe(`/studio/pedidos/${OID}`);
    expect(webPush.notifyCompany.mock.calls[0][1].url).toBe(`/studio/pedidos/${OID}`);
  });

  test('sem a frente ligada: continua no /studio', async () => {
    empresa = { vertical_active: null, studio_enabled: false };
    await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
    expect(criados[0].ctaRoute).toBe(`/studio/pedidos/${OID}`);
  });

  test('studio_enabled em texto não conta (a regra é o booleano, como no backend)', async () => {
    empresa = { vertical_active: null, studio_enabled: 'true' };
    await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
    expect(criados[0].ctaRoute).toBe(`/studio/pedidos/${OID}`);
  });

  test('falha ao ler a empresa: o link de sempre, e o aviso sai', async () => {
    empresa = new Error('db fora');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
    expect(criados[0].ctaRoute).toBe(`/studio/pedidos/${OID}`);
  });

  test('pedido da loja comum não consulta a empresa', async () => {
    mockDb({ ...ORDER, vertical: null });
    await lojaEvents.emitLojaEvent('loja_pedido_novo', { ...ORDER, vertical: null });
    expect(criados[0].ctaRoute).toBe(`/canal?tab=pedidos&order_id=${OID}`);
    expect(consultasDaCasa()).toHaveLength(0);
  });

  test('tipo com rota própria não consulta a empresa', async () => {
    await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: 's1', company_id: CID, total: 10, vertical: 'studio' }, { dedupeSuffix: 's1' });
    expect(consultasDaCasa()).toHaveLength(0);
  });
});
