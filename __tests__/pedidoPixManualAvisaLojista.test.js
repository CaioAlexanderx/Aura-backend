// ============================================================
// Pedido com Pix manual avisa a lojista quando NASCE (10/09/2026)
//
// No Pix manual (chave da lojista, sem gateway) ninguem confirma o pagamento
// sozinho: e a lojista quem confere o extrato. O e-mail ao dono so saia na
// confirmacao — que, no Pix manual, e ela mesma clicando. Ou seja, o aviso
// chegava depois de ela ja saber. Agora o pedido avisa ao nascer, com texto
// de "confira o Pix", e a cliente nao recebe nada ainda.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database');
jest.mock('../src/services/mailer', () => ({
  sendOrderStatusEmail: jest.fn().mockResolvedValue(undefined),
  sendOwnerNewOrderEmail: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/config/database');
const { sendOwnerNewOrderEmail, sendOrderStatusEmail } = require('../src/services/mailer');
const notify = require('../src/services/digitalOrderNotifications');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const PEDIDO = {
  id: 'bb2ffcea-0000-0000-0000-000000000077',
  company_id: 'c-manual',
  order_number: '00077',
  customer_name: 'Eryca',
  customer_email: 'cliente@exemplo.com',
  customer_phone: '(91) 98888-7777',
  total: '129.90',
  delivery_type: 'pickup',
  payment_method: 'pix',
};

function mockDb({ sandbox = false } = {}) {
  db.query.mockImplementation((sql) => {
    if (/is_sandbox/i.test(sql)) return Promise.resolve({ rows: [{ is_sandbox: sandbox }] });
    if (/FROM\s+digital_channel_config/i.test(sql)) return Promise.resolve({ rows: [{ site_name: 'Finesse' }] });
    if (/FROM\s+users/i.test(sql)) return Promise.resolve({ rows: [{ email: 'lojista@exemplo.com' }] });
    if (/FROM\s+digital_orders/i.test(sql)) return Promise.resolve({ rows: [PEDIDO] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

describe('notifyManualPixOrder', () => {
  test('manda o e-mail do dono com o texto de "confira o Pix"', async () => {
    mockDb();
    await notify.notifyManualPixOrder({ order: { ...PEDIDO } });
    expect(sendOwnerNewOrderEmail).toHaveBeenCalledTimes(1);
    const [para, dados] = sendOwnerNewOrderEmail.mock.calls[0];
    expect(para).toBe('lojista@exemplo.com');
    expect(dados).toMatchObject({ order_number: '00077', total: '129.90', store_name: 'Finesse', payment_method: 'pix', aguardando_pagamento: true });
  });

  test('a cliente nao recebe nada: o pedido ainda nao foi confirmado', async () => {
    mockDb();
    await notify.notifyManualPixOrder({ order: { ...PEDIDO } });
    expect(sendOrderStatusEmail).not.toHaveBeenCalled();
  });

  test('empresa de teste nao dispara e-mail real', async () => {
    mockDb({ sandbox: true });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await notify.notifyManualPixOrder({ order: { ...PEDIDO, company_id: 'c-sandbox' } });
    expect(sendOwnerNewOrderEmail).not.toHaveBeenCalled();
  });
});

// tq-88: o e-mail de pedido novo segue a preferência pedido_loja da empresa.
describe('preferência pedido_loja (tq-88)', () => {
  function mockPrefs(linha) {
    const base = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      if (/FROM company_email_prefs/i.test(sql)) return Promise.resolve({ rows: linha ? [{ company_id: 'c-manual', ...linha }] : [] });
      if (/FROM companies c\s+LEFT JOIN users u/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'c-manual', owner_id: 'u1', loja: 'Finesse', plan: 'negocio', owner_email: 'Dona@Finesse.test' }] });
      }
      if (/FROM company_email_addresses/i.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 'e1', email: 'financeiro@finesse.test', confirmado_em: new Date() },
          { id: 'e2', email: 'socio@finesse.test', confirmado_em: null },
        ] });
      }
      return base(sql, params);
    });
  }

  test('sem escolha: a equipe toda, como sempre (e o e-mail leva a empresa para o registro)', async () => {
    mockDb();
    mockPrefs(null);
    await notify.notifyManualPixOrder({ order: { ...PEDIDO } });
    expect(sendOwnerNewOrderEmail.mock.calls.map((c) => c[0])).toEqual(['lojista@exemplo.com']);
    expect(sendOwnerNewOrderEmail.mock.calls[0][1].company_id).toBe('c-manual');
  });

  test('"só os e-mails da tela": os confirmados (sem confirmar não recebe)', async () => {
    mockDb();
    mockPrefs({ tipo: 'pedido_loja', ligado: true, config: { pedido_destino: 'enderecos' } });
    await notify.notifyManualPixOrder({ order: { ...PEDIDO } });
    expect(sendOwnerNewOrderEmail.mock.calls.map((c) => c[0])).toEqual(['dona@finesse.test', 'financeiro@finesse.test']);
  });

  test('desligado: ninguém recebe', async () => {
    mockDb();
    mockPrefs({ tipo: 'pedido_loja', ligado: false, config: {} });
    await notify.notifyManualPixOrder({ order: { ...PEDIDO } });
    expect(sendOwnerNewOrderEmail).not.toHaveBeenCalled();
  });
});

describe('quem chama', () => {
  test('a loja comum avisa so no Pix manual', () => {
    const src = fonte('src/routes/storefront.js');
    expect(src).toContain("if (pixData && pixData.mode === 'manual') {");
    expect(src).toContain('notify.notifyManualPixOrder({ order })');
  });

  test('o Studio avisa no sino e no Pix manual', () => {
    const src = fonte('src/routes/studioStorefront.js');
    expect(src).toContain("lojaEvents.emit('loja_pedido_novo', order);");
    expect(src).toContain('notify.notifyManualPixOrder({ order })');
  });

  test('o e-mail tem assunto proprio para o pedido aguardando Pix', () => {
    const src = fonte('src/services/mailer.js');
    expect(src).toContain('recebido — confira o Pix');
    expect(src).toContain('confirmado — ${store_name}');
  });

  test('a rota de inscricao do navegador esta montada no painel', () => {
    expect(fonte('src/routes/private.js')).toContain("router.use('/web-push', require('./webPush'));");
  });
});
