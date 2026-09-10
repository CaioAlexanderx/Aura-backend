// ============================================================
// Sino + Web Push (10/09/2026)
//
// O aviso que pede acao da lojista vai tambem para o navegador, com a aba
// fechada. O ponto de costura e o emitLojaEvent, e o que trava:
//   - so os tipos marcados com push (pedido novo, pagamento, comprovante);
//   - so quando a linha do sino foi REALMENTE criada — a dedupe_key e a
//     unica idempotencia, e webhook reenviado nao toca o computador duas
//     vezes;
//   - o link abre a tela certa (Canal Digital ou pedido do Studio).
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
  id: OID, company_id: CID, order_number: '00042', customer_name: 'Davi Calçados',
  total: '129.90', vertical: null, courier_name: null, courier_plate: null,
};

function mockDb(order = ORDER) {
  db.query.mockImplementation((sql) => {
    if (/company_notification_prefs/i.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM digital_orders/i.test(sql)) return Promise.resolve({ rows: [order] });
    return Promise.resolve({ rows: [] });
  });
}

let linhaCriada;
beforeEach(() => {
  jest.resetAllMocks();
  lojaEvents._resetCaches();
  linhaCriada = { id: 'n1' };
  mockDb();
  jest.spyOn(appNotifications, 'notifyCompany').mockImplementation(() => Promise.resolve(linhaCriada));
  jest.spyOn(webPush, 'notifyCompany').mockResolvedValue({ enviados: 1, removidos: 0, falhas: 0 });
});
afterEach(() => jest.restoreAllMocks());

test('os tipos com push sao exatamente os que pedem acao imediata', () => {
  const comPush = lojaEvents.TYPES.filter((t) => lojaEvents.EVENTS[t].push === true).sort();
  expect(comPush).toEqual(['loja_comprovante_enviado', 'loja_pedido_novo', 'loja_pedido_pago']);
});

test('pedido novo vai para o navegador com titulo, link e agrupamento do pedido', async () => {
  await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
  expect(webPush.notifyCompany).toHaveBeenCalledTimes(1);
  const [cid, aviso] = webPush.notifyCompany.mock.calls[0];
  expect(cid).toBe(CID);
  expect(aviso.title).toBe('Pedido novo #00042');
  expect(aviso.body).toContain('R$ 129,90');
  expect(aviso.url).toBe(`/canal?tab=pedidos&order_id=${OID}`);
  // Mesma tag para novo e pago: o "pagamento confirmado" SUBSTITUI o
  // "pedido novo" na central do sistema em vez de empilhar dois.
  expect(aviso.tag).toBe(`pedido:${OID}`);
  expect(aviso.type).toBe('loja_pedido_novo');
});

test('pedido do Studio abre a tela do pedido', async () => {
  mockDb({ ...ORDER, vertical: 'studio' });
  await lojaEvents.emitLojaEvent('loja_pedido_novo', { ...ORDER, vertical: 'studio' });
  expect(webPush.notifyCompany.mock.calls[0][1].url).toBe(`/studio/pedidos/${OID}`);
});

test('pagamento confirmado e comprovante tambem avisam o navegador', async () => {
  await lojaEvents.emitLojaEvent('loja_pedido_pago', ORDER);
  await lojaEvents.emitLojaEvent('loja_comprovante_enviado', ORDER);
  expect(webPush.notifyCompany.mock.calls.map(([, a]) => a.type)).toEqual(['loja_pedido_pago', 'loja_comprovante_enviado']);
});

test('dedupe: linha que ja existia (notifyCompany devolve null) nao toca o navegador', async () => {
  linhaCriada = null;
  await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
  expect(webPush.notifyCompany).not.toHaveBeenCalled();
});

test('tipo sem push fica so no sino', async () => {
  await lojaEvents.emitLojaEvent('loja_pix_expirado', ORDER);
  expect(appNotifications.notifyCompany).toHaveBeenCalledTimes(1);
  expect(webPush.notifyCompany).not.toHaveBeenCalled();
});

test('falha do Web Push nao derruba o evento do sino', async () => {
  webPush.notifyCompany.mockRejectedValue(new Error('rede'));
  const row = await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
  // tagEntity acrescenta entity_ref/entity_label a linha; o que importa e
  // que a linha do sino volta inteira mesmo com o navegador falhando.
  expect(row).toMatchObject({ id: 'n1' });
});
