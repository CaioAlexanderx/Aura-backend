// ============================================================
// AURA. — Pix da loja online sem chave (RA-04, 10/11/2026)
//
// A loja online dava 500 quando a loja nao tinha chave Pix valida: o
// pixService caia num fallback legado que lia companies.asaas_subconta_*,
// colunas que nao existem no banco de producao. E, sem nada configurado,
// gerava um Pix FALSO (mock) — em producao a cliente pagaria um QR que nao
// existe. Aqui:
//   - com chave: BR Code manual, como sempre;
//   - sem chave (ou chave invalida) em producao: PIX_NOT_CONFIGURED (422),
//     sem consultar asaas_subconta_*;
//   - sem chave fora de producao: mock, para dev e testes;
//   - rota: o pedido recem-criado e cancelado (nao fica "aguardando Pix")
//     e a resposta e 422 com o codigo estavel; outras formas seguem.
//   - rotas da subconta legada respondem sem tocar no banco.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(async () => {}),
  notifyManualPixOrder: jest.fn(async () => {}),
  notifyPedidoAAceitar: jest.fn(async () => {}),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({
  onOrderConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/services/mpGateway', () => ({
  gatewayAtivo: jest.fn(async () => null),
  temGatewayAtivo: jest.fn(async () => false),
}));
jest.mock('../src/services/mpService', () => ({
  ...jest.requireActual('../src/services/mpService'),
  createMpPixPayment: jest.fn(async () => { throw new Error('MP fora do ar'); }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const mpGatewaySvc = require('../src/services/mpGateway');
const { generatePix, PIX_NOT_CONFIGURED } = require('../src/services/pixService');

const NODE_ENV_ORIGINAL = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = NODE_ENV_ORIGINAL; });

const PEDIDO = { id: 'aaaaaaaa-0000-0000-0000-000000000001', order_number: '00042' };

function consultas() {
  return db.query.mock.calls.map((c) => String(c[0]));
}

function bancoComConfig(cfg) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/asaas_subconta/.test(sql)) {
      const e = new Error('column "asaas_subconta_id" does not exist');
      e.code = '42703';
      throw e;
    }
    if (/FROM\s+digital_channel_config/.test(sql)) return { rows: cfg ? [cfg] : [] };
    return { rows: [] };
  });
}

describe('pixService.generatePix', () => {
  test('com chave Pix: BR Code manual, como hoje', async () => {
    process.env.NODE_ENV = 'production';
    bancoComConfig({ pix_key: 'loja@exemplo.com', pix_key_type: 'EMAIL', pix_holder_name: 'LOJA', pix_holder_city: 'BELEM' });
    const pix = await generatePix({ order: PEDIDO, company_id: 'c1', total: 59.9 });
    expect(pix.mode).toBe('manual');
    expect(pix.payload).toMatch(/^000201/);
    expect(pix.payload).toContain('loja@exemplo.com');
    expect(pix.payload).toContain('59.90');
    expect(pix.payload).not.toContain('MOCK');
    expect(consultas().some((s) => /asaas_subconta/.test(s))).toBe(false);
  });

  test('sem chave em producao: PIX_NOT_CONFIGURED (422), sem consultar asaas_subconta_*', async () => {
    process.env.NODE_ENV = 'production';
    bancoComConfig({ pix_key: null });
    await expect(generatePix({ order: PEDIDO, company_id: 'c1', total: 10 }))
      .rejects.toMatchObject({ code: PIX_NOT_CONFIGURED, status: 422 });
    expect(consultas().some((s) => /asaas_subconta/.test(s))).toBe(false);
  });

  test('sem linha de configuracao em producao: PIX_NOT_CONFIGURED', async () => {
    process.env.NODE_ENV = 'production';
    bancoComConfig(null);
    await expect(generatePix({ order: PEDIDO, company_id: 'c1', total: 10 }))
      .rejects.toMatchObject({ code: PIX_NOT_CONFIGURED });
  });

  test('chave invalida em producao: PIX_NOT_CONFIGURED, nunca mock', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    bancoComConfig({ pix_key: '123', pix_key_type: 'CPF' });
    const err = await generatePix({ order: PEDIDO, company_id: 'c1', total: 10 }).catch((e) => e);
    expect(err.code).toBe(PIX_NOT_CONFIGURED);
    expect(err.message).toMatch(/escolha outra forma de pagamento/);
    expect(consultas().some((s) => /asaas_subconta/.test(s))).toBe(false);
  });

  test('sem chave fora de producao: mock (dev e testes)', async () => {
    process.env.NODE_ENV = 'test';
    bancoComConfig({ pix_key: '' });
    const pix = await generatePix({ order: PEDIDO, company_id: 'c1', total: 10 });
    expect(pix.mode).toBe('mock');
    expect(consultas().some((s) => /asaas_subconta/.test(s))).toBe(false);
  });

  test('o codigo nao le mais companies.asaas_subconta_*', () => {
    const fs = require('fs');
    const path = require('path');
    const ler = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const semComentario = (src) => src.replace(/\/\/.*$/gm, '');
    for (const arq of ['src/services/pixService.js', 'src/routes/asaasSubconta.js', 'src/routes/digitalChannel.js']) {
      expect(semComentario(ler(arq))).not.toMatch(/asaas_subconta/);
    }
  });
});

// ── Rota da loja online ─────────────────────────────────────
const PRODUTO = { id: 'p1', name: 'BLUSA', price: '50.00', stock_qty: 10, image_url: null, is_active: true };

let updates;
function montarBanco(cfg) {
  updates = [];
  db.query.mockReset();
  db.connect.mockReset();
  const comum = async (sql, params) => {
    const s = String(sql);
    if (/asaas_subconta/.test(s)) {
      const e = new Error('column "asaas_subconta_id" does not exist');
      e.code = '42703';
      throw e;
    }
    if (/FROM digital_channel_config/.test(s)) {
      return { rows: [{ company_id: 'c1', pickup_enabled: true, company_display_name: 'Loja', pay_on_delivery_enabled: true, ...cfg }] };
    }
    if (/FROM products/.test(s)) return { rows: [PRODUTO] };
    if (/UPDATE digital_orders/.test(s)) updates.push({ sql: s, params });
    return { rows: [] };
  };
  db.query.mockImplementation(comum);
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO digital_orders/.test(s)) {
        return { rows: [{ id: 'o1', order_number: 1, company_id: 'c1', status: params[9], payment_method: params[11] }] };
      }
      return comum(s, params);
    }),
    release: jest.fn(),
  }));
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/storefront', require('../src/routes/storefront'));
  return app;
}

const CORPO = {
  customer_name: 'Cliente', customer_phone: '11999999999',
  delivery_type: 'pickup', payment_method: 'pix',
  items: [{ product_id: 'p1', quantity: 1 }],
};

describe('POST /storefront/:slug/order — Pix sem chave', () => {
  beforeEach(() => {
    mpGatewaySvc.gatewayAtivo.mockReset();
    mpGatewaySvc.gatewayAtivo.mockResolvedValue(null);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('producao, Mercado Pago falhou e sem chave: 422 PIX_NOT_CONFIGURED e o pedido e cancelado', async () => {
    const app = makeApp();
    montarBanco({ pix_key: null });
    mpGatewaySvc.gatewayAtivo.mockResolvedValue({ access_token: 'tok-teste' });
    process.env.NODE_ENV = 'production';
    const r = await request(app).post('/storefront/loja/order').send(CORPO);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PIX_NOT_CONFIGURED');
    expect(r.body.error).toMatch(/escolha outra forma de pagamento/);
    const cancelou = updates.find((u) => /status\s+= 'cancelled'/.test(u.sql));
    expect(cancelou).toBeTruthy();
    expect(cancelou.params[0]).toBe('o1');
    expect(cancelou.sql).toMatch(/WHERE id = \$1 AND status = 'pending_payment'/);
    // Nenhum Pix gravado no pedido.
    expect(updates.some((u) => /asaas_pix_payload/.test(u.sql))).toBe(false);
    expect(db.query.mock.calls.some((c) => /asaas_subconta/.test(String(c[0])))).toBe(false);
  });

  test('producao, chave invalida e sem gateway: 422, sem QR falso', async () => {
    const app = makeApp();
    montarBanco({ pix_key: '123', pix_key_type: 'CPF' });
    process.env.NODE_ENV = 'production';
    const r = await request(app).post('/storefront/loja/order').send(CORPO);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PIX_NOT_CONFIGURED');
    expect(r.body.pix).toBeUndefined();
  });

  test('producao, com chave: 201 com o BR Code manual', async () => {
    const app = makeApp();
    montarBanco({ pix_key: 'loja@exemplo.com', pix_key_type: 'EMAIL' });
    process.env.NODE_ENV = 'production';
    const r = await request(app).post('/storefront/loja/order').send(CORPO);
    expect(r.status).toBe(201);
    expect(r.body.pix.mode).toBe('manual');
    expect(updates.some((u) => /status\s+= 'cancelled'/.test(u.sql))).toBe(false);
  });

  test('producao, pagar na entrega na loja sem chave: o pedido segue (201)', async () => {
    const app = makeApp();
    montarBanco({ pix_key: null });
    process.env.NODE_ENV = 'production';
    const r = await request(app).post('/storefront/loja/order').send({ ...CORPO, payment_method: 'on_delivery' });
    expect(r.status).toBe(201);
    expect(r.body.pix).toBeNull();
  });

  test('fora de producao, chave invalida: mock, pedido 201', async () => {
    const app = makeApp();
    montarBanco({ pix_key: '123', pix_key_type: 'CPF' });
    process.env.NODE_ENV = 'test';
    const r = await request(app).post('/storefront/loja/order').send(CORPO);
    expect(r.status).toBe(201);
    expect(r.body.pix.mode).toBe('mock');
  });
});

describe('rotas da subconta legada', () => {
  function appLegado() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { role: 'client' }; next(); });
    app.use('/companies/:id/digital-channel/asaas', require('../src/routes/asaasSubconta'));
    return app;
  }

  beforeEach(() => {
    db.query.mockReset();
    global.fetch = jest.fn();
  });

  test('GET /status: "nao configurado", sem banco', async () => {
    const r = await request(appLegado()).get('/companies/c1/digital-channel/asaas/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ onboarded: false, subconta_status: 'none' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST /onboard e /bank-account: 410, sem banco e sem Asaas', async () => {
    const app = appLegado();
    const a = await request(app).post('/companies/c1/digital-channel/asaas/onboard').send({});
    const b = await request(app).post('/companies/c1/digital-channel/asaas/bank-account').send({ bank: '1', account: '2', agency: '3' });
    for (const r of [a, b]) {
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('SUBCONTA_LEGADA_DESATIVADA');
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('pedidoSemPix.desfazerPedidoSemPix', () => {
  const { desfazerPedidoSemPix } = require('../src/services/pedidoSemPix');

  test('com chave de idempotencia: solta a chave para o proximo toque criar pedido novo', async () => {
    const banco = { query: jest.fn(async () => ({ rows: [] })) };
    await desfazerPedidoSemPix(banco, { id: 'o9' }, { comChave: true });
    const [sql, params] = banco.query.mock.calls[0];
    expect(sql).toMatch(/idempotency_key = NULL/);
    expect(sql).toMatch(/status\s+= 'cancelled'/);
    expect(params[0]).toBe('o9');
  });

  test('sem chave: nao mexe na coluna (base sem a migration 416)', async () => {
    const banco = { query: jest.fn(async () => ({ rows: [] })) };
    await desfazerPedidoSemPix(banco, { id: 'o9' });
    expect(banco.query.mock.calls[0][0]).not.toMatch(/idempotency_key/);
  });

  test('falha ao cancelar nao derruba a resposta', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const banco = { query: jest.fn(async () => { throw new Error('caiu'); }) };
    await expect(desfazerPedidoSemPix(banco, { id: 'o9' })).resolves.toBeUndefined();
  });
});

describe('POST /digital-channel/setup-pix (subconta legada)', () => {
  test('410 SUBCONTA_LEGADA_DESATIVADA, sem banco e sem Asaas', async () => {
    db.query.mockReset();
    global.fetch = jest.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { role: 'client' }; next(); });
    app.use('/companies/:id/digital-channel', require('../src/routes/digitalChannel'));
    const r = await request(app).post('/companies/c1/digital-channel/setup-pix').send({
      name: 'Loja', email: 'loja@exemplo.com', cpf_cnpj: '00000000000', mobile_phone: '11999999999', birth_date: '1990-01-01',
    });
    expect(r.status).toBe(410);
    expect(r.body.code).toBe('SUBCONTA_LEGADA_DESATIVADA');
    expect(db.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
