// ============================================================
// QA pos-deploy da vitrine Studio (28/09/2026) — segunda rodada do backend
//
//  1. P0 · a CSP da vitrine libera os loaders do three no jsdelivr
//  2. P0 · "Recusar pagamento" nao da mais 500 (trigger 42702, migration 357)
//  3. P1 · "Gerar do pedido (motor visual)" nao da mais 500 (22P02, migration 358)
//  4. P1 · "Ja paguei" sem comprovante avisa a lojista no sino
//  5. P1 · o detalhe do pedido traz CPF/CNPJ da nota e a entrega
//  6. P1 · o Configurador diz por que a peca nao aparece na loja
//  7. P1 · o job de Pix vencido sobe, e o detalhe diz por que nao cancelou
//  8. P2 · alerta do hub com o numero do pedido
//  9. P2 · a mensagem de aprovacao assina com o nome da loja
//
// Mock do banco por SQL, nunca por posicao.
// ============================================================
'use strict';

jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(() => Promise.resolve()),
  notifyStatusChange: jest.fn(() => Promise.resolve()),
  notifyPaymentMarkedByCustomer: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({
  onOrderConfirmed: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/lojaEvents', () => ({
  emit: jest.fn(),
  emitLojaEvent: jest.fn(() => Promise.resolve({ id: 'n1' })),
}));
jest.mock('../src/services/pixService', () => ({ generatePix: jest.fn() }));
jest.mock('../src/services/mpService', () => ({
  createMpPixPayment: jest.fn(), createMpPreference: jest.fn(),
}));
jest.mock('../src/services/cacheDaPaginaDaLoja', () => ({
  esquecerPagina: jest.fn(), paginaLembrada: jest.fn(() => null), lembrarPagina: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const lojaEvents = require('../src/services/lojaEvents');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';
const OID = '11111111-2222-3333-4444-555555555555';

function comUsuario(app) {
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'u1', role: 'client', plan: 'negocio' }; next(); });
  return app;
}

/** Banco falso: lista de [regex, linhas | (sql, params) => linhas | Error]. */
function banco(regras) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    for (const [re, resp] of regras) {
      if (re.test(s)) {
        const r = typeof resp === 'function' ? resp(s, params) : resp;
        if (r instanceof Error) throw r;
        return { rows: r, rowCount: r.length };
      }
    }
    return { rows: [], rowCount: 0 };
  });
}
const erroPg = (code, message) => Object.assign(new Error(message), { code });
const chamada = (re) => db.query.mock.calls.find(([s]) => re.test(String(s)));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('1 · CSP da vitrine: a camiseta 3D carrega', () => {
  const { cspDaVitrineStudio, HOST_DO_APP, THREE_DO_JSDELIVR } = require('../src/services/vitrineStudioShell');
  const csp = cspDaVitrineStudio('https://api.getaura.com.br');
  const diretiva = (nome) => csp.split('; ').find((d) => d.startsWith(nome + ' ')) || '';

  // As URLs que o viewer usa (aura-app components/studio/visualEngine/threeLoader.ts).
  const DO_APP = [
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/',
  ];

  test('script-src libera o three do jsdelivr (GLTFLoader e DRACOLoader)', () => {
    expect(diretiva('script-src')).toContain(THREE_DO_JSDELIVR);
    expect(THREE_DO_JSDELIVR.startsWith('https://cdn.jsdelivr.net/')).toBe(true);
    for (const url of DO_APP) expect(url.startsWith(THREE_DO_JSDELIVR)).toBe(true);
  });

  test('connect-src libera o GLB do app e o decoder Draco do jsdelivr', () => {
    expect(diretiva('connect-src')).toContain(HOST_DO_APP);
    expect(HOST_DO_APP).toBe('https://app.getaura.com.br');
    expect(diretiva('connect-src')).toContain(THREE_DO_JSDELIVR);
  });

  test('o decoder Draco roda: worker de blob e wasm', () => {
    expect(diretiva('worker-src')).toBe("worker-src 'self' blob:");
    expect(diretiva('script-src')).toContain("'wasm-unsafe-eval'");
  });

  test('nao abre o jsdelivr inteiro nem eval de JavaScript', () => {
    const script = diretiva('script-src');
    expect(script.split(' ')).not.toContain('https://cdn.jsdelivr.net');
    expect(script).not.toMatch(/(^|\s)'unsafe-eval'/);
    expect(script).not.toMatch(/\s\*(\s|$)/);
    // O resto continua como era.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('https://cdnjs.cloudflare.com');
  });
});

// ─────────────────────────────────────────────────────────────
describe('2 · Recusar pagamento', () => {
  const rota = require('../src/routes/digitalOrders');
  const app = comUsuario(express());
  app.use('/companies/:id/digital-channel/orders', rota);
  const url = `/companies/${CID}/digital-channel/orders/${OID}/reject-payment`;

  const pedido = (extra = {}) => ({ id: OID, status: 'awaiting_approval', payment_status: 'pending', ...extra });

  test('caminho feliz: cancela, grava o motivo, avisa a cliente e o sino', async () => {
    banco([
      [/^\s*SELECT id, status, payment_status FROM digital_orders/, [pedido()]],
      [/UPDATE digital_orders SET/, (_s, p) => [{ ...pedido(), status: 'cancelled', payment_status: 'cancelled', notes: p[0] }]],
    ]);
    const r = await request(app).post(url).send({ reason: 'Pix nao caiu' });
    expect(r.status).toBe(200);
    expect(r.body.rejected).toBe(true);
    const [sql, params] = chamada(/UPDATE digital_orders SET/);
    expect(sql).toMatch(/status IN \('pending_payment', 'awaiting_approval'\)/);
    expect(params[0]).toMatch(/\[REJEITADO em .*\]: Pix nao caiu$/);
    expect(params[0].startsWith('\n')).toBe(true);
    expect(lojaEvents.emit).toHaveBeenCalledWith('loja_pedido_cancelado', expect.objectContaining({ id: OID }));
  });

  test('sem motivo tambem cancela (a nota fica so com a data)', async () => {
    banco([
      [/^\s*SELECT id, status, payment_status FROM digital_orders/, [pedido({ status: 'pending_payment' })]],
      [/UPDATE digital_orders SET/, [{ ...pedido(), status: 'cancelled' }]],
    ]);
    const r = await request(app).post(url).send({});
    expect(r.status).toBe(200);
    expect(chamada(/UPDATE digital_orders SET/)[1][0]).toMatch(/\[REJEITADO em [^\]]+\]$/);
  });

  test.each([
    [{ status: 'confirmed', payment_status: 'confirmed' }, /já foi confirmado.*Cancelar pedido/],
    [{ status: 'awaiting_approval', payment_status: 'paid' }, /já foi confirmado/],
    [{ status: 'preparing' }, /não está esperando pagamento.*Cancelar pedido/],
    [{ status: 'cancelled' }, /já está cancelado/],
    [{ status: 'delivered' }, /já foi entregue/],
  ])('fora da espera do pagamento (%o): 409 em portugues e nada gravado', async (extra, msg) => {
    banco([[/^\s*SELECT id, status, payment_status FROM digital_orders/, [pedido(extra)]]]);
    const r = await request(app).post(url).send({ reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(msg);
    expect(chamada(/UPDATE digital_orders/)).toBeUndefined();
  });

  test('pedido que mudou no meio (UPDATE sem linha): 409, nao 200', async () => {
    banco([
      [/^\s*SELECT id, status, payment_status FROM digital_orders/, [pedido()]],
      [/UPDATE digital_orders SET/, []],
    ]);
    const r = await request(app).post(url).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/mudou/);
    expect(lojaEvents.emit).not.toHaveBeenCalled();
  });

  test('erro do banco: 500 com o que fazer, em portugues', async () => {
    banco([
      [/^\s*SELECT id, status, payment_status FROM digital_orders/, [pedido()]],
      [/UPDATE digital_orders SET/, erroPg('42702', 'column reference "stock_qty" is ambiguous')],
    ]);
    const r = await request(app).post(url).send({});
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/não foi alterado.*Tente de novo/);
  });

  test('pedido de outra empresa: 404', async () => {
    banco([]);
    const r = await request(app).post(url).send({});
    expect(r.status).toBe(404);
  });

  describe('a causa do 500: o trigger de estorno de insumos', () => {
    // A ultima definicao de cada funcao (pela ordem do runner) e a que
    // vale no banco. A 208 tinha desfeito o fix da 135 — isto impede a
    // terceira vez.
    const arquivos = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
    const ultimaDefinicao = (fn) => {
      let corpo = null;
      for (const f of arquivos) {
        const sql = fonte('migrations/' + f);
        // Do cabecalho da funcao ate o "RETURN NEW" que fecha o corpo.
        const re = new RegExp(`CREATE OR REPLACE FUNCTION (public\\.)?${fn}\\(\\)[\\s\\S]*?RETURN NEW;\\s*END;`, 'g');
        let m;
        while ((m = re.exec(sql))) corpo = { f, sql: m[0] };
      }
      return corpo;
    };

    test.each([
      ['fn_studio_restore_inputs_digital_cancel', 'i'],
      ['fn_studio_restore_inputs_sale_cancel', 'i'],
      ['fn_studio_consume_inputs_digital', 'si'],
    ])('%s: o RHS do stock_qty e qualificado na versao que vale', (fn, alias) => {
      const def = ultimaDefinicao(fn);
      expect(def).not.toBeNull();
      expect(def.sql).toMatch(new RegExp(`stock_qty\\s*=\\s*${alias}\\.stock_qty`));
      expect(def.sql).not.toMatch(/stock_qty\s*=\s*stock_qty/);
    });

    test('a 357 e a que corrige o cancelamento digital', () => {
      expect(ultimaDefinicao('fn_studio_restore_inputs_digital_cancel').f)
        .toBe('357_fix_estorno_de_insumos_no_cancelamento_digital.sql');
    });
  });
});

// ─────────────────────────────────────────────────────────────
describe('3 · Gerar do pedido (motor visual)', () => {
  const rota = require('../src/routes/studioVisualTemplates');
  const app = comUsuario(express());
  app.use('/companies/:id/studio', rota);
  const url = `/companies/${CID}/studio/visual-renders`;
  const corpo = (extra = {}) => ({
    template_key: 'mockup-foto:abc', template_version: 3, kind: 'hd_2d',
    customization: { f1: 'Helena' }, file_url: 'https://r2.getaura.com.br/x.png', content_type: 'image/png',
    ...extra,
  });
  const inserido = [{ id: 'r1', template_key: 'mockup-foto:abc', template_version: 3, kind: 'hd_2d', content_hash: 'h' }];

  test('item do pedido da loja (id numerico 43): confere a empresa e grava', async () => {
    banco([
      [/FROM digital_order_items i\s+JOIN digital_orders o/, [{ '?column?': 1 }]],
      [/INSERT INTO studio_visual_renders/, inserido],
    ]);
    const r = await request(app).post(url).send(corpo({ digital_order_item_id: 43 }));
    expect(r.status).toBe(201);
    const [, dono] = chamada(/FROM digital_order_items i/);
    expect(dono).toEqual(['43', CID]);
    const [, params] = chamada(/INSERT INTO studio_visual_renders/);
    expect(params[3]).toBeNull();
    expect(params[4]).toBe('43');
    expect(params[7]).toMatch(/^[0-9a-f]{64}$/);
  });

  test('UUID em digital_order_item_id (item de venda do Caixa) vai para sale_item_id', async () => {
    const SI = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    banco([
      [/FROM sale_items si\s+JOIN sales s/, [{ '?column?': 1 }]],
      [/INSERT INTO studio_visual_renders/, inserido],
    ]);
    const r = await request(app).post(url).send(corpo({ digital_order_item_id: SI }));
    expect(r.status).toBe(201);
    const [, params] = chamada(/INSERT INTO studio_visual_renders/);
    expect(params[3]).toBe(SI);
    expect(params[4]).toBeNull();
  });

  test.each([
    [{ digital_order_item_id: 'abc' }, /digital_order_item_id inválido/],
    [{ digital_order_item_id: '-4' }, /digital_order_item_id inválido/],
    [{ sale_item_id: '43' }, /sale_item_id inválido/],
  ])('id em formato errado (%o): 400 claro, sem tocar no banco', async (extra, msg) => {
    banco([]);
    const r = await request(app).post(url).send(corpo(extra));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(msg);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('item de outra empresa: 404, nada gravado', async () => {
    banco([[/FROM digital_order_items i/, []]]);
    const r = await request(app).post(url).send(corpo({ digital_order_item_id: '43' }));
    expect(r.status).toBe(404);
    expect(chamada(/INSERT INTO studio_visual_renders/)).toBeUndefined();
  });

  test('banco ainda sem a 358 (22P02): 400 com saida, nao 500', async () => {
    banco([
      [/FROM digital_order_items i/, [{ '?column?': 1 }]],
      [/INSERT INTO studio_visual_renders/, erroPg('22P02', 'invalid input syntax for type uuid: "43"')],
    ]);
    const r = await request(app).post(url).send(corpo({ digital_order_item_id: 43 }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Envie o mockup manualmente/);
  });

  test('sem item: grava o render solto, como antes', async () => {
    banco([[/INSERT INTO studio_visual_renders/, inserido]]);
    const r = await request(app).post(url).send(corpo());
    expect(r.status).toBe(201);
    const [, params] = chamada(/INSERT INTO studio_visual_renders/);
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  test('GET por digital_order_item_id invalido: 400', async () => {
    banco([]);
    const r = await request(app).get(url + '?digital_order_item_id=abc');
    expect(r.status).toBe(400);
  });

  test('a 358 alinha a coluna ao tipo de digital_order_items.id, sem apagar item de venda', () => {
    const sql = fonte('migrations/358_render_visual_item_digital_bigint.sql');
    expect(sql).toMatch(/attrelid = 'public\.digital_order_items'::regclass AND attname = 'id'/);
    expect(sql).toMatch(/ALTER COLUMN digital_order_item_id TYPE %s/);
    expect(sql).toMatch(/SET sale_item_id\s+= COALESCE\(sale_item_id, digital_order_item_id\)/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('4 · "Ja paguei" sem comprovante avisa a lojista', () => {
  const app = express();
  app.use(express.json());
  app.use('/storefront', require('../src/routes/storefront'));
  const url = `/storefront/aura-qa/order/${OID}/mark-as-paid`;
  const pedido = (extra = {}) => ({
    id: OID, status: 'pending_payment', company_id: CID, customer_name: 'Teste QA Aura',
    order_number: '00004', payment_method: 'pix', ...extra,
  });
  const esperar = () => new Promise((r) => setImmediate(r));

  test('sem comprovante: evento "Pagamento a conferir" do pedido', async () => {
    banco([
      [/JOIN digital_channel_config dcc ON dcc.company_id = o.company_id/, [pedido()]],
      [/SELECT payment_proof_url FROM digital_orders/, [{ payment_proof_url: null }]],
    ]);
    const r = await request(app).post(url).send({});
    expect(r.status).toBe(200);
    await esperar();
    expect(lojaEvents.emitLojaEvent).toHaveBeenCalledTimes(1);
    expect(lojaEvents.emitLojaEvent).toHaveBeenCalledWith('loja_pagamento_a_conferir', expect.objectContaining({ id: OID, company_id: CID }));
  });

  test('com comprovante: o aviso ja saiu no upload, nao repete', async () => {
    banco([
      [/JOIN digital_channel_config dcc ON dcc.company_id = o.company_id/, [pedido()]],
      [/SELECT payment_proof_url FROM digital_orders/, [{ payment_proof_url: 'https://r2/x.png' }]],
    ]);
    await request(app).post(url).send({});
    await esperar();
    expect(lojaEvents.emitLojaEvent).not.toHaveBeenCalled();
  });

  test('segundo toque (ja em awaiting_approval): nao avisa de novo', async () => {
    banco([[/JOIN digital_channel_config dcc ON dcc.company_id = o.company_id/, [pedido({ status: 'awaiting_approval' })]]]);
    const r = await request(app).post(url).send({});
    expect(r.body.message).toBe('Ja registrado.');
    await esperar();
    expect(lojaEvents.emitLojaEvent).not.toHaveBeenCalled();
  });

  describe('o evento na taxonomia', () => {
    const real = jest.requireActual('../src/services/lojaEvents');
    const ev = real.EVENTS.loja_pagamento_a_conferir;

    test('mesmo grupo do comprovante ("Precisa de voce"), ligado, com push', () => {
      expect(ev.severity).toBe(real.EVENTS.loja_comprovante_enviado.severity);
      expect(ev.severity).toBe('atencao');
      expect(ev.defaultOn).toBe(true);
      expect(ev.push).toBe(true);
      expect(ev.label).toBe('Pagamento a conferir');
    });

    test('texto na voz do Studio', () => {
      const o = { id: OID, order_number: '00004', customer_name: 'Teste QA Aura', total: '85.32', vertical: 'studio' };
      expect(ev.title(o)).toBe('Pagamento a conferir #00004');
      expect(ev.body(o)).toBe('A cliente Teste QA Aura disse que pagou o Pix de R$ 85,32 do pedido 00004. Confira na sua conta e confirme no pedido.');
    });

    test('loja comum e sem nome', () => {
      expect(ev.body({ order_number: '00012', total: 10, vertical: 'retail' }))
        .toBe('O cliente disse que pagou o Pix de R$ 10,00 do pedido 00012. Confira na sua conta e confirme no pedido.');
    });
  });
});

// ─────────────────────────────────────────────────────────────
describe('5 e 7 · detalhe do pedido Studio: nota, entrega e Pix vencido', () => {
  const { camposDeEntregaENota } = require('../src/services/pagamentoDoPedidoStudio');
  const AGORA = new Date('2026-09-28T12:00:00Z').getTime();
  const horasAtras = (h) => new Date(AGORA - h * 3600 * 1000).toISOString();
  const LOJA = { pickup_address: 'Av Napoleão Bonaparte, Colonial - São José dos Campos', address: 'Av Dom Pedro I, 553' };
  const base = (extra = {}) => ({
    id: OID, vertical: 'studio', status: 'awaiting_approval', payment_method: 'pix', payment_status: 'pending',
    customer_cpf_cnpj: '529.982.247-25', nfce_requested: true, delivery_type: 'pickup',
    delivery_fee: '0.00', discount_amount: '9.48', created_at: horasAtras(2), ...extra,
  });

  test('retirada com CPF na nota (o #00003 do QA)', () => {
    const c = camposDeEntregaENota(base(), LOJA, AGORA);
    expect(c).toMatchObject({
      customer_cpf_cnpj: '529.982.247-25',
      request_nfce: true,
      delivery_type: 'pickup',
      retirada_endereco: 'Av Napoleão Bonaparte, Colonial - São José dos Campos',
      delivery_address: null,
      courier_name: null, courier_plate: null, courier_a_informar: false,
      shipping_fee: 0, pix_discount: 9.48,
      payment_method: 'pix', payment_status: 'pending',
      pix_cancelamento: { vencido: false, motivo: null },
    });
  });

  test('retirada sem endereco proprio usa o do negocio', () => {
    expect(camposDeEntregaENota(base(), { address: 'Av Dom Pedro I, 553' }, AGORA).retirada_endereco)
      .toBe('Av Dom Pedro I, 553');
  });

  test('entrega: endereco da cliente, frete e sem retirada', () => {
    const c = camposDeEntregaENota(base({
      delivery_type: 'delivery', delivery_address: 'Rua A, 10 - Centro, SJC/SP', delivery_fee: '15.00',
      address_neighborhood: 'Centro', address_city: 'SJC', nfce_requested: false, customer_cpf_cnpj: null,
    }), LOJA, AGORA);
    expect(c).toMatchObject({
      delivery_type: 'delivery', delivery_address: 'Rua A, 10 - Centro, SJC/SP', retirada_endereco: null,
      shipping_fee: 15, request_nfce: false, customer_cpf_cnpj: null, address_city: 'SJC',
    });
  });

  test('portador: nome e placa, ou "a informar"', () => {
    expect(camposDeEntregaENota(base({ delivery_type: 'courier', courier_name: 'Joao', courier_plate: 'ABC1D23' }), LOJA, AGORA))
      .toMatchObject({ delivery_type: 'courier', courier_name: 'Joao', courier_plate: 'ABC1D23', courier_a_informar: false, retirada_endereco: LOJA.pickup_address });
    expect(camposDeEntregaENota(base({ delivery_type: 'courier' }), LOJA, AGORA).courier_a_informar).toBe(true);
  });

  test('pedido sem tipo de entrega gravado e retirada (como na confirmacao)', () => {
    expect(camposDeEntregaENota(base({ delivery_type: null }), LOJA, AGORA).delivery_type).toBe('pickup');
  });

  describe('pix_cancelamento: a mesma regra do job', () => {
    const { situacaoDoPixVencido, PRAZO_HORAS_STUDIO, PRAZO_HORAS, sqlDoCancelamento } =
      require('../src/jobs/lojaPixExpiradoJob');
    const pix = (extra) => ({ ...base({ status: 'pending_payment', created_at: horasAtras(24 * 24) }), ...extra });

    test.each([
      ['Pix Studio de 24 dias sem nada: vencido, o job cancela', {}, { vencido: true, motivo: null }],
      ['"Ja paguei"', { status: 'awaiting_approval' }, { vencido: true, motivo: 'ja_paguei' }],
      ['comprovante anexado', { payment_proof_url: 'https://r2/x.png' }, { vencido: true, motivo: 'comprovante' }],
      ['sinal registrado', { deposit_paid: true }, { vencido: true, motivo: 'sinal' }],
      // 28/09/2026 (decisao do Caio): a producao andando nao segura mais.
      ['arte aprovada (o 00001 do QA): o job cancela', { studio_production_status: 'approved' }, { vencido: true, motivo: null }],
      ['em producao sem Pix: o job cancela', { studio_production_status: 'in_production' }, { vencido: true, motivo: null }],
      ['producao parada', { studio_production_status: 'pending_art' }, { vencido: true, motivo: null }],
      ['dentro do prazo', { created_at: horasAtras(PRAZO_HORAS_STUDIO - 1) }, { vencido: false, motivo: null }],
      ['ja pago', { payment_status: 'confirmed' }, { vencido: false, motivo: null }],
      ['cancelado', { status: 'cancelled' }, { vencido: false, motivo: null }],
      ['nao e Pix', { payment_method: 'card' }, { vencido: false, motivo: null }],
      ['loja comum com producao "andando" nao conta producao', { vertical: 'retail', studio_production_status: 'approved' }, { vencido: true, motivo: null }],
    ])('%s', (_n, extra, esperado) => {
      expect(situacaoDoPixVencido(pix(extra), AGORA)).toEqual(esperado);
      expect(camposDeEntregaENota(pix(extra), LOJA, AGORA).pix_cancelamento).toEqual(esperado);
    });

    test('loja comum vence em 48 h, Studio em 72 h', () => {
      const em = (h, vertical) => situacaoDoPixVencido(pix({ vertical, created_at: horasAtras(h) }), AGORA).vencido;
      expect(em(PRAZO_HORAS + 1, 'retail')).toBe(true);
      expect(em(PRAZO_HORAS + 1, 'studio')).toBe(false);
      expect(em(PRAZO_HORAS_STUDIO + 1, 'studio')).toBe(true);
    });

    test('o SQL do job usa as mesmas condicoes', () => {
      const sql = sqlDoCancelamento({ comComprovante: true });
      expect(sql).toMatch(/status = 'pending_payment'/);
      expect(sql).toMatch(/payment_method = 'pix'/);
      expect(sql).toMatch(/payment_proof_url IS NULL/);
      expect(sql).toMatch(/COALESCE\(deposit_paid, false\) = false/);
      expect(sql).toContain(`INTERVAL '${PRAZO_HORAS} hours'`);
      expect(sql).toContain(`INTERVAL '${PRAZO_HORAS_STUDIO} hours'`);
      expect(sql).not.toMatch(/studio_production_status/);
    });
  });

  describe('GET /studio/orders/:oid devolve os campos', () => {
    const app = comUsuario(express());
    app.use('/companies/:id/studio', require('../src/routes/studioKdsApproval'));
    require('../src/services/pagamentoDoPedidoStudio')._resetParaTeste();

    test('pedido da vitrine: nota, entrega e pix_cancelamento no order', async () => {
      banco([
        [/FROM studio_orders\s+WHERE id = \$1 AND company_id = \$2/, [{ id: OID, company_id: CID, source: 'digital', digital_order_id: OID, status: 'x' }]],
        [/SELECT \* FROM digital_orders WHERE id = \$1 AND company_id = \$2/, [base({ status: 'pending_payment', created_at: horasAtras(24 * 24), studio_production_status: 'approved' })]],
        [/SELECT \* FROM digital_channel_config WHERE company_id = \$1/, [LOJA]],
        [/FROM digital_orders\s+WHERE company_id = \$1\s+AND id::text = ANY/, [{ id: OID, status: 'pending_payment', payment_method: 'pix', payment_status: 'pending', total: '85.32', order_number: '00001' }]],
      ]);
      const r = await request(app).get(`/companies/${CID}/studio/orders/${OID}`);
      expect(r.status).toBe(200);
      expect(r.body.order).toMatchObject({
        order_number: '00001',
        customer_cpf_cnpj: '529.982.247-25', request_nfce: true, delivery_type: 'pickup',
        retirada_endereco: LOJA.pickup_address, courier_a_informar: false,
        shipping_fee: 0, pix_discount: 9.48, payment_method: 'pix', payment_status: 'pending',
        pix_cancelamento: { vencido: true, motivo: null }, // 28/09: a produção andando não segura mais,
      });
    });

    test('falha ao ler a entrega nao derruba o detalhe', async () => {
      banco([
        [/FROM studio_orders\s+WHERE id = \$1 AND company_id = \$2/, [{ id: OID, company_id: CID, source: 'digital', digital_order_id: OID }]],
        [/SELECT \* FROM digital_orders/, erroPg('57014', 'timeout')],
      ]);
      const r = await request(app).get(`/companies/${CID}/studio/orders/${OID}`);
      expect(r.status).toBe(200);
      expect(r.body.order.id).toBe(OID);
    });
  });
});

// ─────────────────────────────────────────────────────────────
describe('6 · por que a peca nao aparece na loja', () => {
  const { motivoOcultoNaLoja } = require('../src/services/storefrontBuilder');
  const peca = (extra = {}) => ({
    is_active: true, is_personalizable: true, customization_config: { fields: [] },
    studio_storefront_visible: true, image_url: 'https://r2/x.png', gallery_urls: [], ...extra,
  });

  test.each([
    ['aparece', {}, {}, null],
    ['Copo Stanley - Marcelle RJ (sem configurador)', { customization_config: null }, {}, 'Sem campos de personalização'],
    ['inativa', { is_active: false }, {}, 'Produto inativo'],
    ['nao personalizavel', { is_personalizable: false }, {}, 'Não é personalizável'],
    ['oculta no Estoque Studio', { studio_storefront_visible: false }, {}, 'Oculto da loja por você'],
    ['sem foto numa loja que exige foto', { image_url: '' }, { exigeFoto: true }, 'Sem foto (a loja exige foto)'],
    ['sem foto numa loja que nao exige', { image_url: '' }, { exigeFoto: false }, null],
    ['so com galeria numa loja que exige', { image_url: null, gallery_urls: ['https://r2/g.png'] }, { exigeFoto: true }, null],
  ])('%s', (_n, extra, loja, esperado) => {
    expect(motivoOcultoNaLoja(peca(extra), loja)).toBe(esperado);
  });

  test('a regra conversa com a da vitrine (NA_VITRINE_STUDIO)', () => {
    const { NA_VITRINE_STUDIO } = require('../src/services/storefrontBuilder');
    expect(NA_VITRINE_STUDIO).toMatch(/is_personalizable = true/);
    expect(NA_VITRINE_STUDIO).toMatch(/customization_config IS NOT NULL/);
    expect(NA_VITRINE_STUDIO).toMatch(/studio_storefront_visible IS NOT FALSE/);
    expect(fonte('src/routes/studioStorefront.js')).toMatch(/is_active IS NOT FALSE\s+AND \$\{NA_VITRINE_STUDIO\}\s+AND \$\{comFoto\}/);
  });

  test('GET /studio/products (o do Configurador) traz motivo_oculto_na_loja', async () => {
    const app = comUsuario(express());
    app.use('/companies/:id/studio', require('../src/routes/studioSaleItemPatch'));
    banco([
      [/SELECT require_product_image FROM digital_channel_config/, [{ require_product_image: false }]],
      [/FROM products/, [
        { id: 'p1', name: 'Copo Stanley - Marcelle RJ', price: '37', is_personalizable: true, customization_config: null, studio_storefront_visible: true, company_id: CID },
        { id: 'p2', name: 'CANECA BRANCA', price: '39.9', is_personalizable: true, customization_config: { fields: [] }, studio_storefront_visible: true, company_id: CID },
      ]],
    ]);
    const r = await request(app).get(`/companies/${CID}/studio/products?include_non_personalizable=true&limit=500`);
    expect(r.status).toBe(200);
    expect(r.body.products.map((p) => [p.name, p.motivo_oculto_na_loja])).toEqual([
      ['Copo Stanley - Marcelle RJ', 'Sem campos de personalização'],
      ['CANECA BRANCA', null],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
describe('7 · o job de Pix vencido sobe em producao', () => {
  test('startServer inicia o job (src/index.js -> server.js)', () => {
    expect(fonte('src/index.js')).toMatch(/startServer\(\)/);
    const server = fonte('src/server.js');
    const inicio = server.indexOf('function startServer');
    expect(inicio).toBeGreaterThan(-1);
    expect(server.slice(inicio)).toMatch(/initPixExpiradoJob\(\);/);
    expect(fonte('railway.toml')).toMatch(/startCommand = "node src\/index.js"/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('8 · alerta do hub com o numero do pedido', () => {
  const app = comUsuario(express());
  app.use('/companies/:id/studio', require('../src/routes/studioBulkHub'));

  test('"Pedido 00001 atrasado", com order_number e order_id', async () => {
    banco([
      // Rodada 3 (28/09): a consulta ganhou o alias `d` e as colunas do Pix (LJ-34).
      [/FROM digital_orders d\s+WHERE d\.company_id = \$1 AND d\.vertical = 'studio'/, [
        { id: 'baa22b9d-0000-4000-8000-000000000001', order_number: '00001', customer_name: 'Marina', created_at: new Date(Date.now() - 23 * 86400000).toISOString() },
        { id: 'cdf9501f-0000-4000-8000-000000000002', order_number: null, customer_name: null, created_at: new Date(Date.now() - 5 * 86400000).toISOString() },
      ]],
    ]);
    const r = await request(app).get(`/companies/${CID}/studio/hub/alerts`);
    expect(r.status).toBe(200);
    const atrasados = r.body.alerts.filter((a) => a.kind === 'overdue');
    expect(atrasados[0]).toMatchObject({ title: 'Pedido 00001 atrasado', order_number: '00001', order_id: 'baa22b9d-0000-4000-8000-000000000001' });
    expect(atrasados[1]).toMatchObject({ title: 'Pedido #CDF9501F atrasado', order_number: null });
    const [sql] = chamada(/FROM digital_orders d\s+WHERE d\.company_id = \$1 AND d\.vertical = 'studio'/);
    expect(sql).toMatch(/order_number/);
    expect(sql).toMatch(/COALESCE\(d\.status, ''\) <> 'cancelled'/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('9 · a mensagem de aprovacao assina com o nome da loja', () => {
  const app = comUsuario(express());
  app.use('/companies/:id/studio', require('../src/routes/studioKdsApproval'));

  function bancoDaAprovacao(siteName) {
    banco([
      [/SELECT source, digital_order_id FROM studio_orders/, [{ source: 'digital', digital_order_id: OID }]],
      [/FROM digital_orders o\s+LEFT JOIN companies c/, [{
        id: OID, customer_name: 'Teste QA Aura', customer_phone: '12996145447', display_name: 'Teste QA Aura',
        trade_name: 'Aura QA', legal_name: 'Aura QA Ltda', site_name: siteName,
      }]],
      [/INSERT INTO studio_approval_links/, [{ id: 'a1', token: 't', status: 'pending' }]],
    ]);
  }

  test('com loja: "_Aura QA — espelho da Sheid_", nao o nome da empresa', async () => {
    bancoDaAprovacao('Aura QA — espelho da Sheid');
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/approval`)
      .send({ mockup_url: 'https://r2.getaura.com.br/m.png' });
    expect(r.status).toBe(201);
    expect(r.body.message_text.endsWith('\n\n_Aura QA — espelho da Sheid_')).toBe(true);
    expect(chamada(/FROM digital_orders o\s+LEFT JOIN companies c/)[0]).toMatch(/digital_channel_config dcc/);
  });

  test('sem nome de loja: o da empresa, como antes', async () => {
    bancoDaAprovacao(null);
    const r = await request(app).post(`/companies/${CID}/studio/orders/${OID}/approval`)
      .send({ mockup_url: 'https://r2.getaura.com.br/m.png' });
    expect(r.body.message_text.endsWith('_Aura QA_')).toBe(true);
  });
});
