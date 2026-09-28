// ============================================================
// QA final da vitrine Studio (28/09/2026) — rodada 3: ciclo de vida do pedido
//
//  1. LJ-33 (P1) · pedido cancelado sai da produção: migration 359 (trigger
//     e CHECK), leitura do quadro, KPIs e feed do hub
//  2. LJ-33/CL-46 (P1) · a cliente vê o motivo certo: tipo e motivo do
//     cancelamento na confirmação e no acompanhamento
//  3. LJ-34 (P1) · Pix vencido que não cancelou diz por quê no hub e na fila
//  4. P2 · "Recusar pagamento" e "Cancelar pedido" gravam tipo e motivo
//  5. P2 · o quadro não cancela nem ressuscita pedido da loja online
//  6. P2 · o sino resolve o aviso que o pedido já resolveu
//  7. LJ-36 (P1) · o upload do mockup aceita os 15 MB que promete
//
// Mock do banco por SQL, nunca por posição.
// ============================================================
'use strict';

jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(() => Promise.resolve()),
  notifyStatusChange: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({
  onOrderConfirmed: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/lojaEvents', () => ({
  emit: jest.fn(),
  emitLojaEvent: jest.fn(() => Promise.resolve({ id: 'n1' })),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';
const OID = '11111111-2222-3333-4444-555555555555';

function comUsuario(app) {
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'u1', role: 'client', plan: 'negocio' }; next(); });
  return app;
}

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
const chamada = (re) => db.query.mock.calls.find(([s]) => re.test(String(s)));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const {
  cancelamentoDoPedido, etapaDaProducao, sqlDaEtapa, motivoDaRecusaNasNotas,
} = require('../src/services/cancelamentoDoPedido');

// ─────────────────────────────────────────────────────────────
describe('1 · LJ-33: cancelado é cancelado também na produção', () => {
  const sql = fonte('migrations/359_pedido_studio_cancelado.sql');

  test('a migration 359 existe e o número não repete', () => {
    const nums = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
      .map((f) => parseInt(f, 10)).filter(Number.isFinite);
    expect(nums.filter((n) => n === 359)).toHaveLength(1);
  });

  test('o CHECK da etapa aceita cancelled e awaiting_customization, sem varrer linhas antigas', () => {
    expect(sql).toMatch(/ADD CONSTRAINT digital_orders_studio_production_status_check/);
    for (const etapa of ['awaiting_customization', 'pending_art', 'approved', 'in_production', 'ready', 'delivered', 'cancelled']) {
      expect(sql).toContain(`'${etapa}'`);
    }
    expect(sql).toMatch(/NOT VALID/);
    // Derruba o CHECK antigo seja qual for o nome dele em prod.
    expect(sql).toMatch(/pg_get_constraintdef\(oid\) ILIKE '%studio_production_status%'/);
  });

  test('o trigger roda antes do UPDATE de status OU da etapa e força a produção cancelada', () => {
    expect(sql).toMatch(/BEFORE UPDATE OF status, studio_production_status ON public\.digital_orders/);
    expect(sql).toMatch(/IF NEW\.vertical = 'studio' THEN\s+NEW\.studio_production_status := 'cancelled'/);
    // Sem cancel_kind do chamador: expired = job do Pix; senão, a loja.
    expect(sql).toMatch(/WHEN NEW\.payment_status = 'expired' THEN 'pix_expirado'/);
    expect(sql).toMatch(/ELSE 'cancelado_pela_loja'/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS cancel_kind/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS cancel_reason/);
  });

  test('a leitura trata status cancelled como etapa cancelled (pedido anterior à 359)', () => {
    expect(etapaDaProducao({ status: 'cancelled', studio_production_status: 'pending_art' })).toBe('cancelled');
    expect(etapaDaProducao({ status: 'confirmed', studio_production_status: 'approved' })).toBe('approved');
    expect(etapaDaProducao({ status: 'pending_payment', studio_production_status: null })).toBeNull();
    expect(sqlDaEtapa('o')).toBe("(CASE WHEN o.status::text = 'cancelled' THEN 'cancelled' ELSE o.studio_production_status::text END)");
  });

  test('o quadro (GET /studio/orders) lê e filtra pela etapa de verdade', async () => {
    const rota = require('../src/routes/studioKdsApproval');
    const app = comUsuario(express());
    app.use('/companies/:id/studio', rota);
    banco([
      [/FROM studio_orders o/, [{ id: OID, source: 'digital', digital_order_id: OID, status: 'cancelled', studio_production_status: 'cancelled' }]],
    ]);
    const r = await request(app).get(`/companies/${CID}/studio/orders?status=cancelled`);
    expect(r.status).toBe(200);
    const [s, params] = chamada(/FROM studio_orders o/);
    expect(s).toContain(`${sqlDaEtapa('o')} AS studio_production_status`);
    expect(s).toContain(`${sqlDaEtapa('o')} = $2`);
    expect(params[1]).toBe('cancelled');
  });

  test('o detalhe (GET /studio/orders/:oid) mostra "Cancelado" mesmo com a etapa parada', async () => {
    const rota = require('../src/routes/studioKdsApproval');
    const app = comUsuario(express());
    app.use('/companies/:id/studio', rota);
    banco([
      [/SELECT \* FROM studio_orders/, [{ id: OID, source: 'digital', digital_order_id: OID, status: 'cancelled', studio_production_status: 'pending_art' }]],
      [/SELECT \* FROM digital_orders WHERE id = \$1 AND company_id = \$2/, [{
        id: OID, status: 'cancelled', payment_status: 'cancelled', payment_method: 'pix', created_at: new Date().toISOString(),
        cancel_kind: 'pagamento_recusado', cancel_reason: 'O Pix não caiu no extrato',
      }]],
    ]);
    const r = await request(app).get(`/companies/${CID}/studio/orders/${OID}`);
    expect(r.status).toBe(200);
    expect(r.body.order.studio_production_status).toBe('cancelled');
    expect(r.body.order.cancelamento).toEqual({ tipo: 'pagamento_recusado', motivo: 'O Pix não caiu no extrato' });
  });

  test('KPIs do hub: cancelado fora dos contadores e da receita; feed com a etapa de verdade', () => {
    const hub = require('../src/routes/studioBulkHub');
    const k = hub._SQL_KPIS_DO_HUB;
    expect(k).not.toMatch(/studio_hub_kpis/);
    expect(k).toContain(sqlDaEtapa('d'));
    expect(k).toMatch(/SUM\(total\) FILTER \(WHERE NOT cancelado AND created_at >= NOW\(\) - INTERVAL '7 days'\)/);
    expect(k).toMatch(/etapa NOT IN \('delivered', 'ready', 'cancelled'\)/);
    expect(fonte('src/routes/studioBulkHub.js')).toMatch(/\$\{sqlDaEtapa\('o'\)\} AS status/);
  });

  test('GET /studio/hub/stats usa a consulta nova (não a view)', async () => {
    const hub = require('../src/routes/studioBulkHub');
    const app = comUsuario(express());
    app.use('/companies/:id/studio', hub);
    banco([
      [/pending_art_count/, [{ pending_art_count: '2', revenue_7d: '170.64', total_orders: '4' }]],
      [/FROM studio_bulk_events/, [{ active_count: '0', deadline_7d: '0' }]],
      [/FROM studio_inputs/, [{ low_stock_count: '0' }]],
    ]);
    const r = await request(app).get(`/companies/${CID}/studio/hub/stats`);
    expect(r.status).toBe(200);
    expect(r.body.orders.pending_art).toBe(2);
    expect(r.body.revenue.last_7d).toBeCloseTo(170.64);
    expect(chamada(/studio_hub_kpis/)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
describe('2 · LJ-33/CL-46: o motivo do cancelamento para a cliente', () => {
  test('colunas novas: tipo e motivo da loja', () => {
    expect(cancelamentoDoPedido({ status: 'cancelled', cancel_kind: 'pagamento_recusado', cancel_reason: '  Pix não caiu  ' }))
      .toEqual({ tipo: 'pagamento_recusado', motivo: 'Pix não caiu' });
    expect(cancelamentoDoPedido({ status: 'cancelled', cancel_kind: 'cancelado_pela_loja', cancel_reason: null }))
      .toEqual({ tipo: 'cancelado_pela_loja', motivo: null });
    // Pix vencido nunca leva motivo (é o job, não a loja).
    expect(cancelamentoDoPedido({ status: 'cancelled', cancel_kind: 'pix_expirado', cancel_reason: 'x' }))
      .toEqual({ tipo: 'pix_expirado', motivo: null });
  });

  test('pedido anterior à 359: expired = Pix vencido; marca REJEITADO = recusado, com o motivo', () => {
    expect(cancelamentoDoPedido({ status: 'cancelled', payment_status: 'expired', notes: 'x' }))
      .toEqual({ tipo: 'pix_expirado', motivo: null });
    const notas = 'Recado da cliente: capricha!\n[REJEITADO em 2026-09-28T13:00:00.000Z]: Teste QA: o Pix nao caiu no extrato';
    expect(cancelamentoDoPedido({ status: 'cancelled', payment_status: 'cancelled', notes: notas }))
      .toEqual({ tipo: 'pagamento_recusado', motivo: 'Teste QA: o Pix nao caiu no extrato' });
    // Recusa sem motivo.
    expect(cancelamentoDoPedido({ status: 'cancelled', payment_status: 'cancelled', notes: '\n[REJEITADO em 2026-09-28T13:00:00.000Z]' }))
      .toEqual({ tipo: 'pagamento_recusado', motivo: null });
    // Cancelado de outro jeito: a loja, sem motivo, e o recado da cliente NÃO vaza.
    expect(cancelamentoDoPedido({ status: 'cancelled', payment_status: 'pending', notes: 'Recado da cliente' }))
      .toEqual({ tipo: 'cancelado_pela_loja', motivo: null });
  });

  test('a última recusa vale; não cancelado devolve null', () => {
    expect(motivoDaRecusaNasNotas('[REJEITADO em a]: primeiro\n[REJEITADO em b]: segundo')).toEqual({ motivo: 'segundo' });
    expect(motivoDaRecusaNasNotas('nada')).toBeNull();
    expect(cancelamentoDoPedido({ status: 'pending_payment' })).toBeNull();
    expect(cancelamentoDoPedido(null)).toBeNull();
  });

  test('confirmação pelo token leva `cancelamento` e não leva as notas', () => {
    const { montarConfirmacao } = require('../src/services/confirmacaoDoPedido');
    const r = montarConfirmacao({
      pedido: {
        order_number: '00005', status: 'cancelled', payment_status: 'cancelled', payment_method: 'pix',
        notes: 'Recado da cliente\n[REJEITADO em 2026-09-28T13:00:00.000Z]: O Pix não caiu',
        created_at: '2026-09-28T12:55:00.000Z',
      },
      itens: [], loja: {}, studioSettings: {}, faixas: null,
    });
    expect(r.cancelamento).toEqual({ tipo: 'pagamento_recusado', motivo: 'O Pix não caiu' });
    expect(JSON.stringify(r)).not.toContain('Recado da cliente');
    const ativo = montarConfirmacao({ pedido: { status: 'pending_payment' }, itens: [], loja: {}, studioSettings: {} });
    expect(ativo.cancelamento).toBeNull();
  });

  test('a consulta do pedido pelo token lê as colunas novas sem quebrar antes da 359', () => {
    const src = fonte('src/routes/studioStorefront.js');
    expect(src).toMatch(/to_jsonb\(o\)->>'cancel_kind'\s+AS cancel_kind/);
    expect(src).toMatch(/to_jsonb\(o\)->>'cancel_reason' AS cancel_reason/);
  });

  test('acompanhamento cancelado leva o tipo e o motivo', () => {
    const track = require('../src/routes/studioTrackPublic');
    const r = track._respostaDoPedidoDaVitrine({
      order_number: '00005', status: 'cancelled', customer_name: 'Teste QA Aura', loja: 'Aura QA',
      cancel_kind: 'pagamento_recusado', cancel_reason: 'O Pix não caiu', notes: 'Recado',
    });
    expect(r.cancelado).toBe(true);
    expect(r.cancelamento).toEqual({ tipo: 'pagamento_recusado', motivo: 'O Pix não caiu' });
    expect(JSON.stringify(r)).not.toContain('Recado');
  });
});

// ─────────────────────────────────────────────────────────────
describe('3 · LJ-34: o Pix vencido que não cancelou diz por quê', () => {
  const { _alertaDoAtraso } = require('../src/routes/studioBulkHub');
  const agora = new Date('2026-09-28T12:00:00Z').getTime();
  const base = {
    id: OID, order_number: '00001', customer_name: 'Marina QA (teste)',
    created_at: '2026-09-04T17:58:14Z', vertical: 'studio', payment_method: 'pix',
    payment_status: 'pending', status: 'pending_payment',
  };

  test('00001: arte aprovada sem o Pix — o job cancela (decisão de 28/09), o alerta diz isso', () => {
    const a = _alertaDoAtraso({ ...base, studio_production_status: 'approved' }, agora);
    expect(a.kind).toBe('pix_sem_pagamento');
    expect(a.title).toBe('Pedido 00001: Pix sem pagamento há 24 dias');
    expect(a.sub).toBe('Marina QA (teste) · o cancelamento automático cancela na próxima volta.');
    expect(a.sub).not.toMatch(/produção já andou/);
    expect(a.href).toBe(`/studio/pedidos/${OID}`);
  });

  test('sinal registrado continua segurando, com o porquê', () => {
    const a = _alertaDoAtraso({ ...base, studio_production_status: 'approved', deposit_paid: true }, agora);
    expect(a.sub).toMatch(/você registrou o sinal/);
  });

  test('a cliente disse que pagou: pede para conferir', () => {
    const a = _alertaDoAtraso({ ...base, status: 'awaiting_approval', studio_production_status: 'pending_art' }, agora);
    expect(a.sub).toMatch(/a cliente disse que pagou/);
  });

  test('pedido pago e atrasado continua "atrasado" (produção)', () => {
    const a = _alertaDoAtraso({ ...base, status: 'confirmed', payment_status: 'confirmed', studio_production_status: 'approved' }, agora);
    expect(a.kind).toBe('overdue');
    expect(a.title).toBe('Pedido 00001 atrasado');
    expect(a.href).toBe('/studio/producao');
  });

  test('a fila recebe o mesmo motivo do job (pix_cancelamento)', () => {
    const { camposDaLista } = require('../src/services/pagamentoDoPedidoStudio');
    const c = camposDaLista({ ...base, studio_production_status: 'approved', deposit_paid: false });
    expect(c.pix_cancelamento).toEqual({ vencido: true, motivo: null });
  });
});

// ─────────────────────────────────────────────────────────────
describe('3b · decisão do Caio (28/09): sem pagamento na janela, cancela — produção andando ou não', () => {
  const job = require('../src/jobs/lojaPixExpiradoJob');
  const agora = new Date('2026-09-28T12:00:00Z').getTime();
  const horasAtras = (h) => new Date(agora - h * 3600 * 1000).toISOString();
  const studio = (extra) => ({
    vertical: 'studio', payment_method: 'pix', status: 'pending_payment', payment_status: 'pending',
    created_at: horasAtras(73), ...extra,
  });

  test.each(['approved', 'in_production', 'ready', 'pending_art', 'awaiting_customization', null])(
    'etapa %s sem Pix há mais de 72 h: vencido e sem nada que segure', (etapa) => {
      expect(job.situacaoDoPixVencido(studio({ studio_production_status: etapa }), agora)).toEqual({ vencido: true, motivo: null });
    });

  test('continuam fora só pagamento registrado ou a conferir', () => {
    expect(job.situacaoDoPixVencido(studio({ studio_production_status: 'approved', status: 'awaiting_approval' }), agora).motivo).toBe('ja_paguei');
    expect(job.situacaoDoPixVencido(studio({ studio_production_status: 'approved', payment_proof_url: 'https://r2/x.png' }), agora).motivo).toBe('comprovante');
    expect(job.situacaoDoPixVencido(studio({ studio_production_status: 'approved', deposit_paid: true }), agora).motivo).toBe('sinal');
  });

  test('o tick cancela o pedido com arte aprovada e sem Pix, gravando pix_expirado', async () => {
    const fakeDb = { query: jest.fn(async (sql) => {
      if (/UPDATE digital_orders SET/.test(sql)) {
        return { rows: [{ id: OID, company_id: CID, order_number: '00001', customer_name: 'Marina', total: 35.91, vertical: 'studio', created_at: horasAtras(24 * 24) }] };
      }
      return { rows: [] };
    }) };
    const fakeEventos = { emitLojaEvent: jest.fn(async () => ({ id: 'n' })) };
    const r = await job.tickCancelarPixVencido({ db: fakeDb, lojaEvents: fakeEventos });
    expect(r.cancelados).toBe(1);
    const [sql] = fakeDb.query.mock.calls[0];
    expect(sql).toMatch(/cancel_kind\s+= 'pix_expirado'/);
    expect(sql).not.toMatch(/studio_production_status/);
    expect(sql).toMatch(/COALESCE\(deposit_paid, false\) = false/);
    expect(sql).toMatch(/payment_proof_url IS NULL/);
    expect(sql).toMatch(/WHERE status = 'pending_payment'/);
    // Pedido de 24 dias: cancela calado (fora da janela do aviso).
    expect(fakeEventos.emitLojaEvent).not.toHaveBeenCalled();
  });

  test('a cliente vê o texto das 72 h (tipo pix_expirado)', () => {
    expect(cancelamentoDoPedido({ status: 'cancelled', payment_status: 'expired', cancel_kind: 'pix_expirado' }))
      .toEqual({ tipo: 'pix_expirado', motivo: null });
  });
});

// ─────────────────────────────────────────────────────────────
describe('4 · Recusar e cancelar gravam tipo e motivo', () => {
  const rota = require('../src/routes/digitalOrders');
  const app = comUsuario(express());
  app.use('/companies/:id/digital-channel/orders', rota);

  test('recusar: cancel_kind pagamento_recusado + motivo (e a nota de sempre)', async () => {
    banco([
      [/^\s*SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'awaiting_approval', payment_status: 'pending' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled' }]],
    ]);
    const r = await request(app).post(`/companies/${CID}/digital-channel/orders/${OID}/reject-payment`).send({ reason: ' O Pix não caiu ' });
    expect(r.status).toBe(200);
    const [s, p] = chamada(/UPDATE digital_orders SET/);
    expect(s).toMatch(/cancel_kind = 'pagamento_recusado'/);
    expect(s).toMatch(/cancel_reason = \$4/);
    expect(p[3]).toBe('O Pix não caiu');
    expect(p[0]).toMatch(/\[REJEITADO em .*\]: O Pix não caiu$/);
  });

  test('recusar sem motivo grava motivo nulo', async () => {
    banco([
      [/^\s*SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'pending_payment', payment_status: 'pending' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled' }]],
    ]);
    await request(app).post(`/companies/${CID}/digital-channel/orders/${OID}/reject-payment`).send({});
    expect(chamada(/UPDATE digital_orders SET/)[1][3]).toBeNull();
  });

  test('"Cancelar pedido" (PATCH /status) grava cancelado_pela_loja e o motivo', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'confirmed' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled' }]],
    ]);
    const r = await request(app).patch(`/companies/${CID}/digital-channel/orders/${OID}/status`).send({ status: 'cancelled', reason: 'Cliente desistiu' });
    expect(r.status).toBe(200);
    const [s, p] = chamada(/UPDATE digital_orders SET/);
    expect(s).toMatch(/cancel_kind\s+= CASE WHEN \$1 = 'cancelled' THEN 'cancelado_pela_loja'/);
    expect(p[3]).toBe('Cliente desistiu');
  });

  test('avançar etapa não mexe no motivo', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'confirmed' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'preparing' }]],
    ]);
    await request(app).patch(`/companies/${CID}/digital-channel/orders/${OID}/status`).send({ status: 'preparing', reason: 'x' });
    expect(chamada(/UPDATE digital_orders SET/)[1][3]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
describe('5 · o quadro não cancela nem ressuscita pedido da loja online', () => {
  const rota = require('../src/routes/studioKdsApproval');
  const { _motivoParaNaoMudarEtapa } = rota;

  test('regra', () => {
    expect(_motivoParaNaoMudarEtapa({ source: 'digital', status: 'cancelled' }, 'pending_art').codigo).toBe('order_cancelled');
    expect(_motivoParaNaoMudarEtapa({ source: 'digital', status: 'confirmed' }, 'cancelled').codigo).toBe('use_cancel_order');
    expect(_motivoParaNaoMudarEtapa({ source: 'digital', status: 'confirmed' }, 'approved')).toBeNull();
    expect(_motivoParaNaoMudarEtapa({ source: 'pdv', status: 'completed' }, 'cancelled')).toBeNull();
  });

  test('PATCH production-status de pedido cancelado: 409 e nada gravado', async () => {
    const app = comUsuario(express());
    app.use('/companies/:id/studio', rota);
    banco([
      [/FROM studio_orders/, [{ source: 'digital', status: 'cancelled', digital_order_id: OID }]],
    ]);
    const r = await request(app).patch(`/companies/${CID}/studio/orders/${OID}/production-status`).send({ status: 'approved' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/foi cancelado e não volta para a produção/);
    expect(r.body.code).toBe('order_cancelled');
    expect(chamada(/UPDATE digital_orders/)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
describe('6 · o sino resolve o aviso que o pedido já resolveu', () => {
  const { estadoDoEvento, comEstadoDoPedido } = require('../src/services/eventoResolvido');
  const ev = (type, severity = 'atencao') => ({ type, severity });
  const recusado = { status: 'cancelled', payment_status: 'cancelled', cancel_kind: 'pagamento_recusado' };
  const expirado = { status: 'cancelled', payment_status: 'expired', cancel_kind: 'pix_expirado' };
  const pago = { status: 'confirmed', payment_status: 'confirmed' };
  const esperando = { status: 'awaiting_approval', payment_status: 'pending' };

  test('pagamento a conferir / comprovante: resolvido quando saiu da espera', () => {
    for (const t of ['loja_pagamento_a_conferir', 'loja_comprovante_enviado']) {
      expect(estadoDoEvento(ev(t), recusado)).toEqual({ resolved: true, severity: 'info' });
      expect(estadoDoEvento(ev(t), pago)).toEqual({ resolved: true, severity: 'info' });
      expect(estadoDoEvento(ev(t), esperando)).toEqual({ resolved: false, severity: 'atencao' });
    }
  });

  test('pedido cancelado pela própria loja é informativo; o automático não', () => {
    expect(estadoDoEvento(ev('loja_pedido_cancelado'), recusado).resolved).toBe(true);
    expect(estadoDoEvento(ev('loja_pedido_cancelado'), { status: 'cancelled', cancel_kind: 'cancelado_pela_loja' }).resolved).toBe(true);
    expect(estadoDoEvento(ev('loja_pedido_cancelado'), expirado).resolved).toBe(false);
  });

  test('Pix expirado continua pedindo ação até pagar ou a loja cancelar', () => {
    expect(estadoDoEvento(ev('loja_pix_expirado'), expirado).resolved).toBe(false);
    expect(estadoDoEvento(ev('loja_pix_expirado'), pago).resolved).toBe(true);
    expect(estadoDoEvento(ev('loja_pix_expirado'), recusado).resolved).toBe(true);
  });

  test('comEstadoDoPedido marca os itens e nunca derruba o sino', async () => {
    banco([[/FROM digital_orders d/, [{ id: OID, ...recusado }]]]);
    const itens = [
      { id: 'a', type: 'loja_pagamento_a_conferir', severity: 'atencao', order_id: OID },
      { id: 'b', type: 'loja_pedido_novo', severity: 'info', order_id: OID },
    ];
    const r = await comEstadoDoPedido(db, CID, itens);
    expect(r[0]).toMatchObject({ resolved: true, severity: 'info' });
    expect(r[1].resolved).toBeUndefined();

    banco([[/FROM digital_orders d/, new Error('boom')]]);
    expect(await comEstadoDoPedido(db, CID, itens)).toBe(itens);
  });
});

// ─────────────────────────────────────────────────────────────
describe('7 · LJ-36: upload do mockup aceita os 15 MB que promete', () => {
  // O parser de 25 MB veio no #765 (middleware/jsonDeUpload.js); aqui só se
  // confere que a rota do motor está coberta, antes do global de 5 MB.
  test('upload-mockup tem parser próprio, antes do global de 5 MB', () => {
    const { ROTAS_DE_UPLOAD } = require('../src/middleware/jsonDeUpload');
    expect(ROTAS_DE_UPLOAD).toContain('/api/v1/companies/:id/studio/upload-mockup');
    const app = fonte('src/app.js');
    const proprio = app.indexOf('montarJsonDeUpload(app');
    const global = app.indexOf("limit: '5mb'");
    expect(proprio).toBeGreaterThan(-1);
    expect(proprio).toBeLessThan(global);
  });
});

// ─────────────────────────────────────────────────────────────
describe('8 · CL-50/LJ-40: o texto da cliente não é cortado no resumo', () => {
  const { resumoDaPersonalizacao } = require('../src/services/confirmacaoDoPedido');

  test('briefing longo sai inteiro (a página quebra a linha)', () => {
    const cfg = { fields: [{ id: 'brief', type: 'text', label: 'Briefing da arte' }] };
    const texto = 'Nome Helena em dourado, com um coração pequeno do lado direito';
    expect(resumoDaPersonalizacao(cfg, { brief: texto })).toEqual([`Briefing da arte: ${texto}`]);
  });

  test('opção continua curta', () => {
    const cfg = { fields: [{ id: 'cor', type: 'option', label: 'Cor', config: { choices: [{ value: 'x', label: 'A'.repeat(60) }] } }] };
    expect(resumoDaPersonalizacao(cfg, { cor: 'x' })[0].length).toBe(40);
  });
});

// ─────────────────────────────────────────────────────────────
describe('9 · migration 360: nomes com acento (id E nome antigo)', () => {
  const sql = fonte('migrations/360_correcao_de_nomes_com_acento.sql');

  test.each([
    ['25f526eb-57da-4caa-bf9a-9629638eed49', 'Caneca alca coracao 355ml', 'Caneca alça coração 355ml'],
    ['b1582583-6f16-41c5-9661-fc6a01fd7301', 'Caneca alca coracao preta 355ml', 'Caneca alça coração preta 355ml'],
    ['48cb4b2a-5bbc-4703-af4c-32269653edc7', 'Caneca alca colorida 355ml', 'Caneca alça colorida 355ml'],
    ['3dff306c-b2c0-4a7e-bfbb-cf1304333b96', 'Caneca ceramica vintage fosca', 'Caneca cerâmica vintage fosca'],
    ['59e86de3-98de-4cc1-b73d-34c98caadebf', 'Xicara com pires e colher', 'Xícara com pires e colher'],
  ])('%s', (id, antigo, novo) => {
    expect(sql).toContain(`SET name = '${novo}', updated_at = NOW()\n WHERE id = '${id}' AND name = '${antigo}';`);
  });

  test('Folha de sublimação: só os dois produtos, e não reescreve o certo', () => {
    expect(sql).toMatch(/WHERE id IN \('20afafae-898d-41b0-b9b5-1b567be00e02', '8c7f1280-dee8-47a1-9cfe-81b1d9e1dfe4'\)\s+AND name LIKE 'Folha de sublima%'\s+AND name <> 'Folha de sublimação';/);
    expect(sql).not.toContain('�');
  });

  test('359: higiene dos cancelados antigos depois do trigger', () => {
    const m359 = fonte('migrations/359_pedido_studio_cancelado.sql');
    expect(m359.indexOf('CREATE TRIGGER trg_digital_orders_cancelamento'))
      .toBeLessThan(m359.indexOf("SET studio_production_status = 'cancelled'"));
  });
});
