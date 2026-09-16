// ============================================================
// AURA — FASE 8b: WhatsApp incluso no plano, cota mensal de MARKETING
// e pacote extra de 100 por R$49
//
// O que mudou no produto (14/09/2026): o WhatsApp oficial saiu do
// adicional de R$39 e entrou no preço do plano Negócio (R$169) e do
// Aura Dojô (R$140). Cobrança e lembrete (UTILITY, R$0,035 na Meta)
// viraram "ilimitados" com uso justo silencioso; marketing (R$0,3217 —
// quase 10x mais caro) ganhou cota visível: 100 por mês, e quem precisa
// de mais compra um pacote.
//
// Os dois números têm naturezas diferentes e este arquivo prova isso:
// a cota de marketing é um LIMITE DE PRODUTO (a tela mostra, o lojista
// resolve comprando) e o teto de utilidade é uma REDE DE SEGURANÇA (o
// cliente nunca deveria encostar nela; quem encosta vira aviso de
// suporte).
//
// Cobertura:
//  (1) cota = base do plano + pacotes ativos; pacote 'pending' não
//      conta, e pacote vencido também não.
//  (2) a conta do mês soma só marketing que não foi pulado nem falhou —
//      e é a consulta que garante isso, não o teste.
//  (3) cota zerada → LIMITE_MARKETING no enqueue; um pacote ativo
//      libera o MESMO envio.
//  (4) a cota não atrapalha a COBRANÇA: com marketing esgotado, o
//      lembrete de parcela continua saindo.
//  (5) uso justo mensal de utilidade → LIMITE_MENSAL (motivo novo,
//      diferente do de marketing) + aviso de suporte uma vez só.
//  (6) o dojô no essencial é liberado pelo vertical; o varejo no
//      essencial sem adicional continua barrado.
//  (7) /whatsapp/status.usage.marketing e .utility com o contrato
//      completo, sem perder os campos antigos.
//  (8) POST /whatsapp/marketing-packs: cobrança avulsa no Asaas quando
//      dá, needs_manual quando não dá — e nunca cota antes do dinheiro.
//  (9) webhook do Asaas ativa o pacote em PAYMENT_RECEIVED e ignora o
//      resto; rotas admin criam pacote e mudam a cota base.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
process.env.ASAAS_WEBHOOK_SECRET = 'segredo-do-webhook-teste';
process.env.ASAAS_API_KEY = 'chave-asaas-teste';
process.env.ASAAS_URL = 'https://sandbox.asaas.com/api/v3';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(), sendText: jest.fn(),
  createTemplate: jest.fn(), listTemplates: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const outbox = require('../src/services/waOutbox');
const addons = require('../src/services/addons');
const quota = require('../src/services/marketing/marketingQuota');

const COMPANY = 'company-uuid-cota';
const PACK_ID = '11111111-2222-3333-4444-555555555555';

const token = jwt.sign(
  { id: 'user-lojista', role: 'admin', plan: 'negocio' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);
const adminToken = jwt.sign(
  { id: 'user-staff', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

const HOJE = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const ONTEM = new Date(Date.now() - 27 * 3600000).toISOString().slice(0, 10);
const DAQUI_A_60 = new Date(Date.now() + 57 * 24 * 3600000).toISOString().slice(0, 10);

function pack(over = {}) {
  return {
    id: PACK_ID, company_id: COMPANY, qty: 100, price_cents: 4900,
    status: 'active', valid_from: HOJE, valid_until: DAQUI_A_60,
    asaas_payment_id: null, payment_url: null, source: 'app',
    activated_at: null, created_at: '2026-09-14T10:00:00Z',
    ...over,
  };
}

// "Banco" por âncora de SQL. A tabela de pacotes é uma LISTA aqui e o
// filtro de validade é aplicado em JS imitando o SQL — o teste (1c)
// confere que a consulta real tem os mesmos dois filtros, para o mock
// não acabar testando a si mesmo.
function mockBanco({
  plano = 'negocio', vertical = null, addonAtivo = false,
  conectado = true, templateAprovado = true,
  consentimento = true, qualidade = null, pausa = null,
  marketingNaJanela = 0, marketingHoje = 0,
  marketingNoMes = 0, utilidadeNoMes = 0,
  cotaDaEmpresa = null, packs = [],
  asaasCustomerId = 'cus_000123', contato = null,
  outboxHoje = 0,
} = {}) {
  const visto = {
    outboxInserts: [], packInserts: [], packPayments: [], packActivations: [],
    cotaSets: [], alertas: [], quotaSqls: [], webhookLogs: [],
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);

    // ── gate do produto
    if (s.includes('-- addon:has')) return Promise.resolve({ rows: addonAtivo ? [{ '?column?': 1 }] : [] });
    if (s.includes('-- addon:plan')) {
      return Promise.resolve({ rows: [{ plan: plano, vertical_active: vertical, vertical }] });
    }
    if (s.includes('-- wa:conn-state-flag')) return Promise.resolve({ rows: [{ wa_token_invalid_at: null }] });
    if (s.includes('-- wa:conn-state')) {
      return Promise.resolve({ rows: [conectado
        ? { wa_phone_number_id: 'PN1', has_token: true }
        : { wa_phone_number_id: null, has_token: false }] });
    }

    // ── guardas da fila
    if (s.includes('-- wa:guard-template')) {
      return Promise.resolve({ rows: templateAprovado ? [{ status: 'APPROVED' }] : [] });
    }
    if (s.includes('-- wa:guard-paused')) return Promise.resolve({ rows: [{ wa_paused_reason: pausa }] });
    if (s.includes('-- wa:guard-count-today')) return Promise.resolve({ rows: [{ n: outboxHoje }] });
    if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: contato ? [contato] : [] });
    if (s.includes('-- wa:guard-marketing-consent')) {
      return Promise.resolve({ rows: [{ wa_marketing_consent_at: consentimento ? '2026-09-01T00:00:00Z' : null }] });
    }
    if (s.includes('-- wa:guard-marketing-blocked')) return Promise.resolve({ rows: [] });
    if (s.includes('-- wa:guard-quality')) return Promise.resolve({ rows: [{ wa_quality_rating: qualidade }] });
    if (s.includes('-- wa:guard-marketing-count')) {
      if (params[4] === true) return Promise.resolve({ rows: [{ n: marketingHoje }] });
      return Promise.resolve({ rows: [{ n: marketingNaJanela }] });
    }

    // ── cota (332)
    if (s.includes('-- wa:quota-month-usage')) {
      visto.quotaSqls.push(s);
      const tipos = params[1] || [];
      const ehUtilidade = tipos.includes('crediario');
      return Promise.resolve({ rows: [{ n: ehUtilidade ? utilidadeNoMes : marketingNoMes }] });
    }
    if (s.includes('-- wa:quota-company')) {
      return Promise.resolve({ rows: [{ wa_marketing_quota: cotaDaEmpresa }] });
    }
    if (s.includes('-- wa:quota-packs-active')) {
      visto.quotaSqls.push(s);
      // Mesma regra da consulta: só 'active' e ainda dentro da validade.
      const qty = packs
        .filter((p) => p.status === 'active' && String(p.valid_until) >= HOJE)
        .reduce((acc, p) => acc + Number(p.qty || 0), 0);
      return Promise.resolve({ rows: [{ qty }] });
    }
    if (s.includes('-- wa:quota-set')) { visto.cotaSets.push(params); return Promise.resolve({ rows: [] }); }

    // ── pacotes
    if (s.includes('-- wa:pack-insert')) {
      visto.packInserts.push(params);
      return Promise.resolve({ rows: [pack({
        qty: params[1], price_cents: params[2], status: params[3], source: params[4],
      })] });
    }
    if (s.includes('-- wa:pack-payment')) {
      visto.packPayments.push(params);
      return Promise.resolve({ rows: [pack({ status: 'pending', asaas_payment_id: params[1], payment_url: params[2] })] });
    }
    if (s.includes('-- wa:pack-activate')) {
      visto.packActivations.push(params);
      return Promise.resolve({ rows: [pack({ status: 'active', asaas_payment_id: params[1], activated_at: '2026-09-14T12:00:00Z' })] });
    }
    if (s.includes('-- wa:pack-list')) return Promise.resolve({ rows: packs });
    if (s.includes('-- wa:pack-asaas-customer')) {
      return Promise.resolve({ rows: [{ asaas_customer_id: asaasCustomerId }] });
    }

    // ── avisos de suporte
    if (s.includes('-- wa:uso-justo-alerta') || s.includes('-- wa:pack-alerta-manual')) {
      visto.alertas.push({ sql: s, params });
      return Promise.resolve({ rows: [] });
    }

    // ── fila
    if (s.includes('-- wa:outbox-enqueue')) {
      visto.outboxInserts.push(params);
      return Promise.resolve({ rows: [{ id: 'ob-1', status: params[7] }] });
    }

    // ── /status
    if (s.includes('SELECT wa_waba_id')) {
      return Promise.resolve({ rows: [{
        wa_waba_id: 'WABA1', wa_phone_number_id: 'PN1', wa_phone_display: '+55 11 90000-0000',
        wa_connected_at: '2026-09-01T00:00:00Z', has_token: true, wa_token_invalid_at: null,
      }] });
    }
    if (s.includes('-- wa:conn-extras-get')) {
      return Promise.resolve({ rows: [{
        wa_subscribed_at: '2026-09-01T00:00:00Z', wa_registered_at: '2026-09-01T00:00:00Z',
        wa_quality_rating: qualidade, wa_paused_reason: pausa, wa_paused_at: null,
      }] });
    }
    if (s.includes('-- wa:status-usage')) {
      return Promise.resolve({ rows: [{ today_sent: 3, month_sent: 41 }] });
    }
    if (s.includes('-- wa:status-template')) return Promise.resolve({ rows: [{ status: 'APPROVED' }] });

    if (/INSERT INTO webhook_logs/i.test(s)) { visto.webhookLogs.push(params); return Promise.resolve({ rows: [] }); }

    return Promise.resolve({ rows: [] });
  });
  if (db.connect && db.connect.mockResolvedValue) {
    db.connect.mockResolvedValue({ query: db.query, release: () => {} });
  }
  return visto;
}

function buildCompanyApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  return app;
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', require('../src/routes/adminAddons'));
  return app;
}

function buildWebhookApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));
  return app;
}

const ENVIO_MARKETING = {
  companyId: COMPANY, toPhone: '11988887777',
  templateName: 'aniversario_cupom', sourceType: 'aniversario',
};
const ENVIO_COBRANCA = {
  companyId: COMPANY, toPhone: '11988887777',
  templateName: 'parcela_lembrete', sourceType: 'crediario',
};

beforeEach(() => {
  addons.clearCache();
  outbox._resetUsoJustoAvisos();
  delete process.env.WA_MARKETING_MONTHLY_QUOTA;
  delete process.env.WA_UTILITY_MONTHLY_CAP;
  delete process.env.WA_MARKETING_DAILY_CAP;
});

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  jest.restoreAllMocks();
});

// ── (1) a conta da cota ─────────────────────────────────────
describe('cota mensal de marketing', () => {
  it('(1a) cota = 100 do plano + 100 do pacote ativo = 200', async () => {
    mockBanco({ marketingNoMes: 150, packs: [pack()] });
    const s = await quota.marketingStatus(COMPANY);
    expect(s).toEqual({
      month_sent: 150, quota_base: 100, packs_qty: 100, quota: 200, remaining: 50,
      pack_price_cents: 4900, pack_qty: 100,
    });
  });

  it('(1b) pacote pendente e pacote vencido NÃO entram na cota', async () => {
    mockBanco({
      marketingNoMes: 100,
      packs: [
        pack({ id: 'p-pendente', status: 'pending' }),
        pack({ id: 'p-vencido', status: 'active', valid_until: ONTEM }),
        pack({ id: 'p-cancelado', status: 'cancelled' }),
      ],
    });
    const s = await quota.marketingStatus(COMPANY);
    expect(s.packs_qty).toBe(0);
    expect(s.quota).toBe(100);
    expect(s.remaining).toBe(0); // e por isso a cota está esgotada
  });

  it('(1c) a consulta dos pacotes filtra por status ativo E validade — não é o mock que decide', async () => {
    const visto = mockBanco({ packs: [pack()] });
    await quota.activePacksQty(COMPANY);
    const sql = visto.quotaSqls.find((q) => q.includes('wa_marketing_packs'));
    expect(sql).toBeTruthy();
    expect(sql).toMatch(/status\s*=\s*'active'/);
    expect(sql).toMatch(/valid_until\s*>=/);
  });

  it('(1d) a conta do mês ignora skipped/failed e vive no fuso de São Paulo', async () => {
    const visto = mockBanco({ marketingNoMes: 7 });
    await expect(quota.monthUsage(COMPANY, 'marketing')).resolves.toBe(7);
    const sql = visto.quotaSqls.find((q) => q.includes('wa_outbox'));
    expect(sql).toMatch(/status NOT IN \('skipped','failed'\)/);
    expect(sql).toMatch(/America\/Sao_Paulo/);
    expect(sql).toMatch(/date_trunc\('month'/);
  });

  it('(1e) exceção comercial da empresa manda no lugar do padrão do plano', async () => {
    mockBanco({ cotaDaEmpresa: 500, marketingNoMes: 120 });
    const s = await quota.marketingStatus(COMPANY);
    expect(s.quota_base).toBe(500);
    expect(s.remaining).toBe(380);
  });

  it('(1f) tabela 332 ausente (42P01) mantém a cota base — migration atrasada não tira o recurso do cliente', async () => {
    db.query.mockImplementation((sql) => {
      if (String(sql).includes('-- wa:quota-packs-active')) {
        const e = new Error('relation "wa_marketing_packs" does not exist'); e.code = '42P01';
        return Promise.reject(e);
      }
      if (String(sql).includes('-- wa:quota-company')) {
        const e = new Error('column "wa_marketing_quota" does not exist'); e.code = '42703';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [{ n: 0 }] });
    });
    const s = await quota.marketingStatus(COMPANY);
    expect(s).toMatchObject({ quota_base: 100, packs_qty: 0, quota: 100, remaining: 100 });
  });
});

// ── (3)(4) a guarda na fila ─────────────────────────────────
describe('guarda de cota no enfileiramento', () => {
  it('(3a) cota esgotada → LIMITE_MARKETING, e o item entra como skipped', async () => {
    const visto = mockBanco({ marketingNoMes: 100, packs: [] });
    const r = await outbox.enqueue(ENVIO_MARKETING);
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('LIMITE_MARKETING');
    expect(visto.outboxInserts[0][7]).toBe('skipped');
    expect(visto.outboxInserts[0][8]).toBe('LIMITE_MARKETING');
  });

  it('(3b) o MESMO envio passa quando há um pacote ativo — é o pacote que muda o veredito', async () => {
    const visto = mockBanco({ marketingNoMes: 100, packs: [pack()] });
    const r = await outbox.enqueue(ENVIO_MARKETING);
    expect(r.queued).toBe(true);
    expect(visto.outboxInserts[0][7]).toBe('pending');
    expect(visto.outboxInserts[0][8]).toBeNull();
  });

  it('(3c) a env WA_MARKETING_MONTHLY_QUOTA move a cota base', async () => {
    process.env.WA_MARKETING_MONTHLY_QUOTA = '300';
    mockBanco({ marketingNoMes: 100 });
    await expect(outbox.enqueue(ENVIO_MARKETING)).resolves.toMatchObject({ queued: true });

    process.env.WA_MARKETING_MONTHLY_QUOTA = '50';
    mockBanco({ marketingNoMes: 100 });
    await expect(outbox.enqueue(ENVIO_MARKETING)).resolves.toMatchObject({ reason: 'LIMITE_MARKETING' });
  });

  it('(4) marketing esgotado NÃO trava a cobrança do mesmo número', async () => {
    mockBanco({ marketingNoMes: 999, utilidadeNoMes: 10 });
    await expect(outbox.enqueue(ENVIO_MARKETING)).resolves.toMatchObject({ reason: 'LIMITE_MARKETING' });
    await expect(outbox.enqueue(ENVIO_COBRANCA)).resolves.toMatchObject({ queued: true });
  });
});

// ── (5) uso justo da cobrança ───────────────────────────────
describe('uso justo mensal da cobrança', () => {
  it('(5a) abaixo do teto a cobrança sai; no teto sai LIMITE_MENSAL', async () => {
    mockBanco({ utilidadeNoMes: 1499 });
    await expect(outbox.enqueue(ENVIO_COBRANCA)).resolves.toMatchObject({ queued: true });

    outbox._resetUsoJustoAvisos();
    mockBanco({ utilidadeNoMes: 1500 });
    const r = await outbox.enqueue(ENVIO_COBRANCA);
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('LIMITE_MENSAL');
  });

  it('(5b) o teto de utilidade não gasta nem bloqueia a cota de MARKETING', async () => {
    mockBanco({ utilidadeNoMes: 5000, marketingNoMes: 2 });
    const s = await quota.marketingStatus(COMPANY);
    expect(s.remaining).toBe(98);
    await expect(outbox.enqueue(ENVIO_MARKETING)).resolves.toMatchObject({ queued: true });
  });

  it('(5c) o suporte é avisado UMA vez por empresa por mês, não a cada mensagem barrada', async () => {
    const visto = mockBanco({ utilidadeNoMes: 2000 });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await outbox.enqueue(ENVIO_COBRANCA);
    await outbox.enqueue(ENVIO_COBRANCA);
    await outbox.enqueue(ENVIO_COBRANCA);
    expect(visto.alertas).toHaveLength(1);
    expect(visto.alertas[0].sql).toContain('wa_uso_justo_mensal');
    expect(visto.alertas[0].params[0]).toBe(COMPANY);
  });

  it('(5d) a env WA_UTILITY_MONTHLY_CAP move o teto', async () => {
    process.env.WA_UTILITY_MONTHLY_CAP = '10';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockBanco({ utilidadeNoMes: 10 });
    await expect(outbox.enqueue(ENVIO_COBRANCA)).resolves.toMatchObject({ reason: 'LIMITE_MENSAL' });
  });
});

// ── (6) gate do produto ─────────────────────────────────────
describe('gate do produto (Fase 8b)', () => {
  it('(6a) dojô no essencial é liberado pelo vertical; varejo no essencial não', async () => {
    mockBanco({ plano: 'essencial', vertical: 'karate_dojo', addonAtivo: false });
    await expect(addons.canAutoWhatsapp('dojo-1')).resolves.toBe(true);

    addons.clearCache();
    mockBanco({ plano: 'essencial', vertical: null, addonAtivo: false });
    await expect(addons.canAutoWhatsapp('varejo-1')).resolves.toBe(false);
  });
});

// ── (7) contrato do /status ─────────────────────────────────
describe('GET /whatsapp/status', () => {
  it('(7) usage ganha marketing e utility sem perder os campos antigos', async () => {
    mockBanco({ marketingNoMes: 80, utilidadeNoMes: 220, packs: [pack()] });
    const res = await request(buildCompanyApp())
      .get(`/companies/${COMPANY}/whatsapp/status`)
      .set('Authorization', 'Bearer ' + token);

    expect(res.status).toBe(200);
    expect(res.body.usage.today_sent).toBe(3);
    expect(res.body.usage.month_sent).toBe(41);
    expect(res.body.usage.daily_cap).toBe(300);
    expect(res.body.usage.marketing).toEqual({
      month_sent: 80, quota_base: 100, packs_qty: 100, quota: 200, remaining: 120,
      pack_price_cents: 4900, pack_qty: 100,
    });
    expect(res.body.usage.utility).toEqual({ month_sent: 220, cap: 1500 });
  });
});

// ── (8) compra do pacote ────────────────────────────────────
describe('POST /companies/:id/whatsapp/marketing-packs', () => {
  it('(8a) cria a cobrança avulsa no Asaas e devolve o link — o pacote fica PENDENTE', async () => {
    const visto = mockBanco({});
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'pay_987', invoiceUrl: 'https://asaas.com/i/pay_987', status: 'PENDING' }),
    });

    const res = await request(buildCompanyApp())
      .post(`/companies/${COMPANY}/whatsapp/marketing-packs`)
      .set('Authorization', 'Bearer ' + token)
      .send({ qty: 100 });

    expect(res.status).toBe(200);
    expect(res.body.needs_manual).toBe(false);
    expect(res.body.payment_url).toBe('https://asaas.com/i/pay_987');
    // O pacote nasce pendente: cota só depois do dinheiro.
    expect(visto.packInserts[0][3]).toBe('pending');
    expect(visto.packInserts[0][4]).toBe('app');
    // A cobrança leva o externalReference que o webhook usa para achar
    // o pacote de volta — sem isso o pagamento vira billing de plano.
    const corpo = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(corpo.externalReference).toBe(`wa-pack-${PACK_ID}`);
    expect(corpo.value).toBe(49);
    expect(corpo.customer).toBe('cus_000123');
    expect(visto.packPayments[0][1]).toBe('pay_987');
  });

  it('(8b) sem cliente no Asaas → needs_manual e alerta para o suporte, sem cota liberada', async () => {
    const visto = mockBanco({ asaasCustomerId: null });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn();

    const res = await request(buildCompanyApp())
      .post(`/companies/${COMPANY}/whatsapp/marketing-packs`)
      .set('Authorization', 'Bearer ' + token)
      .send({ qty: 100 });

    expect(res.status).toBe(200);
    expect(res.body.needs_manual).toBe(true);
    expect(res.body.payment_url).toBeNull();
    expect(res.body.pack.status).toBe('pending');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(visto.alertas[0].sql).toContain('wa_marketing_pack_manual');
  });

  it('(8c) Asaas recusando a cobrança também vira needs_manual — o pedido do lojista não se perde', async () => {
    const visto = mockBanco({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, json: async () => ({ errors: [{ description: 'customer inválido' }] }),
    });

    const res = await request(buildCompanyApp())
      .post(`/companies/${COMPANY}/whatsapp/marketing-packs`)
      .set('Authorization', 'Bearer ' + token)
      .send({});

    expect(res.body.needs_manual).toBe(true);
    expect(visto.alertas).toHaveLength(1);
  });

  it('(8d) quantidade fora do pacote da vitrine → 422 (o preço é nosso, não do corpo)', async () => {
    mockBanco({});
    const res = await request(buildCompanyApp())
      .post(`/companies/${COMPANY}/whatsapp/marketing-packs`)
      .set('Authorization', 'Bearer ' + token)
      .send({ qty: 5000 });
    expect(res.status).toBe(422);
  });

  it('(8e) migration 332 pendente → 503 SCHEMA_PENDING em vez de 200 mentiroso', async () => {
    db.query.mockImplementation((sql) => {
      if (String(sql).includes('-- wa:pack-insert')) {
        const e = new Error('relation "wa_marketing_packs" does not exist'); e.code = '42P01';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(buildCompanyApp())
      .post(`/companies/${COMPANY}/whatsapp/marketing-packs`)
      .set('Authorization', 'Bearer ' + token)
      .send({ qty: 100 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING');
  });

  it('(8f) GET lista o histórico de pacotes', async () => {
    mockBanco({ packs: [pack(), pack({ id: 'p-2', status: 'pending' })] });
    const res = await request(buildCompanyApp())
      .get(`/companies/${COMPANY}/whatsapp/marketing-packs`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });
});

// ── (9) webhook do Asaas e Gestão Aura ──────────────────────
describe('ativação do pacote', () => {
  it('(9a) PAYMENT_RECEIVED ativa o pacote; PAYMENT_OVERDUE não ativa nada', async () => {
    const visto = mockBanco({});
    const app = buildWebhookApp();

    const pago = await request(app)
      .post('/webhooks/asaas')
      .set('asaas-access-token', 'segredo-do-webhook-teste')
      .send({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_987', externalReference: `wa-pack-${PACK_ID}`, customer: 'cus_000123' } });
    expect(pago.status).toBe(200);
    expect(pago.body.handled).toBe(true);
    expect(pago.body.pack_id).toBe(PACK_ID);
    expect(visto.packActivations).toHaveLength(1);
    expect(visto.packActivations[0][1]).toBe('pay_987');

    const vencido = await request(app)
      .post('/webhooks/asaas')
      .set('asaas-access-token', 'segredo-do-webhook-teste')
      .send({ event: 'PAYMENT_OVERDUE', payment: { id: 'pay_987', externalReference: `wa-pack-${PACK_ID}`, customer: 'cus_000123' } });
    expect(vencido.status).toBe(200);
    expect(vencido.body.handled).toBe(false);
    expect(visto.packActivations).toHaveLength(1); // continua uma só
  });

  it('(9b) o pagamento do pacote NÃO mexe no billing_status da empresa', async () => {
    let mexeuEmCompanies = false;
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/UPDATE companies/i.test(s) && /billing_status/i.test(s)) mexeuEmCompanies = true;
      if (s.includes('-- wa:pack-activate')) return Promise.resolve({ rows: [pack({ status: 'active' })] });
      return Promise.resolve({ rows: [] });
    });
    await request(buildWebhookApp())
      .post('/webhooks/asaas')
      .set('asaas-access-token', 'segredo-do-webhook-teste')
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_987', externalReference: `wa-pack-${PACK_ID}`, customer: 'cus_000123' } });
    expect(mexeuEmCompanies).toBe(false);
  });

  it('(9c) a Gestão Aura cria pacote já ativo (pagamento por fora) com source admin', async () => {
    const visto = mockBanco({});
    const res = await request(buildAdminApp())
      .post(`/admin/clients/${COMPANY}/marketing-packs`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ qty: 100, activate: true });
    expect(res.status).toBe(200);
    expect(visto.packInserts[0][3]).toBe('active');
    expect(visto.packInserts[0][4]).toBe('admin');
  });

  it('(9d) a Gestão Aura muda a cota base e desfaz com null', async () => {
    const visto = mockBanco({ cotaDaEmpresa: 500 });
    const app = buildAdminApp();

    const põe = await request(app)
      .put(`/admin/clients/${COMPANY}/marketing-quota`)
      .set('Authorization', 'Bearer ' + adminToken).send({ quota: 500 });
    expect(põe.status).toBe(200);
    expect(põe.body.usage.quota_base).toBe(500);
    expect(visto.cotaSets[0][1]).toBe(500);

    const tira = await request(app)
      .put(`/admin/clients/${COMPANY}/marketing-quota`)
      .set('Authorization', 'Bearer ' + adminToken).send({ quota: null });
    expect(tira.status).toBe(200);
    expect(visto.cotaSets[1][1]).toBeNull();
  });

  it('(9e) sem papel de admin as duas rotas novas respondem 403', async () => {
    mockBanco({});
    const semPapel = jwt.sign({ id: 'u', role: 'owner' }, 'aura-test-secret-2026', { expiresIn: '1h' });
    const app = buildAdminApp();
    const a = await request(app)
      .post(`/admin/clients/${COMPANY}/marketing-packs`)
      .set('Authorization', 'Bearer ' + semPapel).send({ qty: 100 });
    const b = await request(app)
      .put(`/admin/clients/${COMPANY}/marketing-quota`)
      .set('Authorization', 'Bearer ' + semPapel).send({ quota: 200 });
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });
});
