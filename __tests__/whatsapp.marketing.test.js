// ============================================================
// AURA — FASES 7/8: reativação e aniversário pelo WhatsApp (MARKETING)
//
// Princípio nº 1 da spec do WhatsApp: CADA MENSAGEM CUSTA DINHEIRO. Aqui
// custa MAIS — marketing é a categoria cara da Meta, tem limite por
// usuário (131049) e derruba a qualidade do número quando incomoda. Por
// isso as guardas são mais duras que as da cobrança, e o que este
// arquivo prova é justamente que elas NÃO valem para cobrança.
//
// Cobertura:
//  (1) sem consentimento declarado pela empresa, nada de marketing sai —
//      e a COBRANÇA do mesmo número continua saindo.
//  (2) contato com opt-out e cliente com marketing_opt_out ficam de fora.
//  (3) frequência: 1 marketing por contato a cada 7 dias.
//  (4) qualidade YELLOW bloqueia marketing e NÃO bloqueia cobrança.
//  (5) teto diário de marketing (WA_MARKETING_DAILY_CAP).
//  (6) 131049 grava marketing_blocked_until e NÃO invalid_at (a cobrança
//      do mesmo cliente continua).
//  (7) reativação: dedupe por mês, cupom com source 'reactivation',
//      prévia não grava nada.
//  (8) aniversário: um por cliente por ano; send-whatsapp cria o cupom
//      quando ele não veio; o job é idempotente.
//  (9) gates 403/409 nas duas rotas de settings.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
  createTemplate: jest.fn(),
  listTemplates: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const outbox = require('../src/services/waOutbox');
const addons = require('../src/services/addons');
const mkt = require('../src/services/marketing/marketingCommon');
const reactivationAuto = require('../src/services/marketing/reactivationAuto');
const birthdayAuto = require('../src/services/marketing/birthdayAuto');

const COMPANY = 'company-uuid-marketing';
const HOJE = '2026-09-14';

const token = jwt.sign(
  { id: 'user-lojista', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

// Um cliente como as consultas de candidatos devolvem.
function cliente(over = {}) {
  return {
    id: 'cust-1', name: 'Ana Souza', phone: '11988887777', email: null,
    total_spent: '900.00', total_purchases: 6,
    last_purchase_at: '2026-08-01T12:00:00Z', days_since: 44,
    reactivation_status: null, reactivation_contacted_at: null,
    birth_date: '1990-09-14', marketing_opt_out: false, is_active: true,
    ...over,
  };
}

// "Banco" por âncora de SQL — cada flag liga/desliga um degrau.
function mockBanco({
  plano = 'expansao', addonAtivo = false,
  conectado = true, tokenExpirado = false,
  templateAprovado = true,
  consentimento = true, qualidade = null, bloqueadoMarketing = false,
  marketingNaJanela = 0, marketingHoje = 0,
  contato = null, pausa = null,
  candidatos = [], aniversariantes = [],
  clienteUnico = null, jaNoLog = false, jaNoHistorico = false,
  cupom = null,
} = {}) {
  const visto = {
    outboxInserts: [], cupons: [], logs: [], contatados: [],
    consentSet: [], autoFlags: [], marketingBlocks: [], invalidos: [],
    historicoBday: [], candidatosParams: [],
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    // ── gate/plano
    if (s.includes('-- addon:has')) return Promise.resolve({ rows: addonAtivo ? [{ '?column?': 1 }] : [] });
    if (s.includes('-- addon:plan')) return Promise.resolve({ rows: [{ plan: plano }] });
    if (s.includes('-- wa:conn-state-flag')) {
      return Promise.resolve({ rows: [{ wa_token_invalid_at: tokenExpirado ? '2026-09-10T00:00:00Z' : null }] });
    }
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
    if (s.includes('-- wa:guard-count-today')) return Promise.resolve({ rows: [{ n: 0 }] });
    if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: contato ? [contato] : [] });
    // ── guardas de marketing
    if (s.includes('-- wa:guard-marketing-consent')) {
      return Promise.resolve({ rows: [{ wa_marketing_consent_at: consentimento ? '2026-09-01T00:00:00Z' : null }] });
    }
    if (s.includes('-- wa:guard-marketing-blocked')) {
      return Promise.resolve({ rows: bloqueadoMarketing ? [{ '?column?': 1 }] : [] });
    }
    if (s.includes('-- wa:guard-quality')) return Promise.resolve({ rows: [{ wa_quality_rating: qualidade }] });
    if (s.includes('-- wa:guard-marketing-count')) {
      // params: [companyId, tipos[], phone, days, todayOnly]
      if (params[4] === true) return Promise.resolve({ rows: [{ n: marketingHoje }] });
      return Promise.resolve({ rows: [{ n: marketingNaJanela }] });
    }
    if (s.includes('-- wa:contact-marketing-block')) {
      visto.marketingBlocks.push(params);
      return Promise.resolve({ rows: [] });
    }
    if (s.includes('-- wa:contact-invalid')) { visto.invalidos.push(params); return Promise.resolve({ rows: [] }); }
    // ── fila
    if (s.includes('-- wa:outbox-enqueue')) {
      visto.outboxInserts.push(params);
      return Promise.resolve({ rows: [{ id: 'ob-1', status: params[7] }] });
    }
    if (s.includes('-- wa:outbox-pick')) return Promise.resolve({ rows: [] });
    if (s.includes('-- wa:creds')) {
      return Promise.resolve({ rows: [{ wa_phone_number_id: 'PN1', wa_access_token: 'tok' }] });
    }
    // ── marketing comum
    if (s.includes('-- mkt:store-name')) return Promise.resolve({ rows: [{ store_name: 'Loja Exemplo' }] });
    if (s.includes('-- mkt:coupon-defaults')) {
      return Promise.resolve({ rows: [{ reactivation_coupon_defaults: {}, birthday_coupon_defaults: {} }] });
    }
    if (s.includes('-- mkt:cupom-insert')) {
      visto.cupons.push(params);
      return Promise.resolve({ rows: [{
        id: 'coupon-1', code: params[1], description: params[2],
        discount_type: params[3], discount_value: params[4],
        expires_at: '2026-09-29T23:59:59Z', source: params[9],
      }] });
    }
    if (s.includes('-- mkt:cupom-get')) return Promise.resolve({ rows: cupom ? [cupom] : [] });
    if (s.includes('-- mkt:log-insert')) { visto.logs.push(params); return Promise.resolve({ rows: [{ id: 'log-1' }] }); }
    if (s.includes('-- mkt:log-recente')) return Promise.resolve({ rows: jaNoLog ? [{ '?column?': 1 }] : [] });
    if (s.includes('-- mkt:consent-set')) { visto.consentSet.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- mkt:auto-flag-set')) { visto.autoFlags.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- mkt:settings-get')) {
      return Promise.resolve({ rows: [{
        wa_marketing_consent_at: consentimento ? '2026-09-01T00:00:00Z' : null,
        wa_reactivation_auto: true, wa_birthday_auto: true,
        reactivation_coupon_defaults: {},
      }] });
    }
    if (s.includes('-- mkt:auto-companies')) return Promise.resolve({ rows: [{ id: COMPANY }] });
    // ── reativação
    if (s.includes('-- mkt:react-candidatos')) {
      visto.candidatosParams.push(params);
      return Promise.resolve({ rows: candidatos });
    }
    if (s.includes('-- mkt:react-contatado')) { visto.contatados.push(params); return Promise.resolve({ rows: [] }); }
    // ── aniversário
    if (s.includes('-- mkt:bday-do-dia')) return Promise.resolve({ rows: aniversariantes });
    if (s.includes('-- mkt:bday-cliente')) return Promise.resolve({ rows: clienteUnico ? [clienteUnico] : [] });
    if (s.includes('-- mkt:bday-ja-enviado')) return Promise.resolve({ rows: jaNoHistorico ? [{ '?column?': 1 }] : [] });
    if (s.includes('-- mkt:bday-historico')) { visto.historicoBday.push(params); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
  db.connect.mockResolvedValue({ query: db.query, release: () => {} });
  return visto;
}

function buildReactivationApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/reactivation', require('../src/routes/customerReactivation'));
  return app;
}

function buildBirthdayApp() {
  const app = express();
  app.use(express.json());
  // requireCompanyAccess (private.js) é quem carimba companyRole em
  // produção; aqui basta o papel, porque o alvo do teste é o gate de
  // marketing e não o de permissão.
  app.use('/companies/:id/birthday', (req, _res, next) => {
    req.companyRole = 'owner';
    req.user = { id: 'user-lojista' };
    next();
  }, require('../src/routes/birthday'));
  return app;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
  wa.sendTemplate.mockReset();
  wa.sendText.mockReset();
  wa.createTemplate.mockReset();
  wa.listTemplates.mockReset();
  addons.clearCache();
  delete process.env.WA_MARKETING_DAILY_CAP;
});

// ── (1)-(5) guardas de marketing na fila ────────────────────
describe('waOutbox.enqueue — guardas de MARKETING', () => {
  it('(1) sem consentimento declarado da empresa, marketing não sai', async () => {
    mockBanco({ consentimento: false });
    const r = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'reativacao_cupom', sourceType: 'reativacao',
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('SEM_CONSENTIMENTO');
  });

  it('(1b) a COBRANÇA do mesmo número sai sem consentimento nenhum', async () => {
    mockBanco({ consentimento: false });
    const r = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'parcela_lembrete', sourceType: 'crediario',
    });
    expect(r.queued).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('(2) contato com opt-out continua vencendo tudo', async () => {
    mockBanco({ contato: { opted_out_at: '2026-09-01T00:00:00Z' } });
    const r = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'aniversario_cupom', sourceType: 'aniversario',
    });
    expect(r.reason).toBe('OPT_OUT');
  });

  it('(3) 1 marketing por contato a cada 7 dias → FREQUENCIA_MARKETING', async () => {
    mockBanco({ marketingNaJanela: 1 });
    const r = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'reativacao_cupom', sourceType: 'reativacao',
    });
    expect(r.reason).toBe('FREQUENCIA_MARKETING');
  });

  it('(4) qualidade YELLOW bloqueia MARKETING e não bloqueia COBRANÇA', async () => {
    mockBanco({ qualidade: 'YELLOW' });
    const promo = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'aniversario_cupom', sourceType: 'aniversario',
    });
    expect(promo.reason).toBe('QUALIDADE_MARKETING');

    mockBanco({ qualidade: 'YELLOW' });
    const cobranca = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'parcela_lembrete', sourceType: 'crediario',
    });
    expect(cobranca.queued).toBe(true);
  });

  it('(5) teto diário de marketing é separado do geral → LIMITE_MARKETING', async () => {
    process.env.WA_MARKETING_DAILY_CAP = '1';
    mockBanco({ marketingHoje: 1 });
    const r = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'reativacao_cupom', sourceType: 'reativacao',
    });
    expect(r.reason).toBe('LIMITE_MARKETING');
  });

  it('(5b) contato bloqueado pelo 131049 → MARKETING_BLOQUEADO', async () => {
    mockBanco({ bloqueadoMarketing: true });
    const r = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777',
      templateName: 'reativacao_cupom', sourceType: 'reativacao',
    });
    expect(r.reason).toBe('MARKETING_BLOQUEADO');
  });
});

// ── (6) o 131049 no despacho ────────────────────────────────
describe('processBatch — erro 131049 da Meta', () => {
  it('(6) bloqueia só MARKETING (30 dias) e nunca marca o contato como inválido', async () => {
    const visto = mockBanco({});
    db.query.mockImplementation(((anterior) => (sql, params) => {
      const s = String(sql);
      if (s.includes('-- wa:outbox-pick')) {
        return Promise.resolve({ rows: [{
          id: 'ob-9', company_id: COMPANY, to_phone: '5511988887777',
          kind: 'template', template_name: 'reativacao_cupom', template_language: 'pt_BR',
          components: null, status: 'pending', attempts: 0, source_type: 'reativacao',
        }] });
      }
      return anterior(sql, params);
    })(db.query.getMockImplementation()));

    const err = new Error('Marketing message limit reached');
    err.meta = { code: 131049 };
    wa.sendTemplate.mockRejectedValue(err);

    const out = await outbox.processBatch(5);
    expect(out.picked).toBe(1);
    expect(visto.marketingBlocks).toHaveLength(1);
    expect(String(visto.marketingBlocks[0][2])).toBe('30');
    expect(visto.invalidos).toHaveLength(0);
  });
});

// ── (7) reativação ──────────────────────────────────────────
describe('reactivationAuto.runForCompany', () => {
  it('(7) enfileira com dedupe mensal e cria o cupom de source reactivation', async () => {
    const visto = mockBanco({ candidatos: [cliente()] });
    const r = await reactivationAuto.runForCompany(COMPANY, { today: HOJE, segment: 'at_risk' });
    expect(r.enqueued).toBe(1);

    // O cupom nasce antes da mensagem porque o código dele é parâmetro
    // do template — e nasce com a origem certa.
    expect(visto.cupons).toHaveLength(1);
    expect(visto.cupons[0][9]).toBe('reactivation');

    const params = visto.outboxInserts[0];
    expect(params[3]).toBe('reativacao_cupom');
    expect(params[9]).toBe('reativacao');
    expect(String(params[11])).toBe('react-cust-1-2026-09');

    const texts = JSON.parse(params[5])[0].parameters.map((p) => p.text);
    expect(texts).toHaveLength(5);
    expect(texts[0]).toBe('Ana');
    expect(texts[1]).toBe('Loja Exemplo');
    expect(texts[2]).toBe('10% de desconto');
    for (const t of texts) {
      expect(String(t).trim()).not.toBe('');
      expect(/[\n\t]|\s{4,}/.test(String(t))).toBe(false);
    }

    // Histórico e "contatado" só existem porque a fila ACEITOU.
    expect(visto.logs).toHaveLength(1);
    expect(visto.contatados).toHaveLength(1);
  });

  it('(7b) cliente que já recebeu reativação na janela não volta, e não gera cupom', async () => {
    const visto = mockBanco({ candidatos: [cliente()], jaNoLog: true });
    const r = await reactivationAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(0);
    expect(r.skipped.JA_ENVIADO).toBe(1);
    expect(visto.cupons).toHaveLength(0);
    expect(visto.outboxInserts).toHaveLength(0);
  });

  it('(7c) guarda que pula NÃO cria cupom nem marca o cliente como contatado', async () => {
    const visto = mockBanco({ candidatos: [cliente()], qualidade: 'YELLOW' });
    const r = await reactivationAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(0);
    expect(r.skipped.QUALIDADE_MARKETING).toBe(1);
    expect(visto.cupons).toHaveLength(0);
    expect(visto.contatados).toHaveLength(0);
  });

  it('(7d) sem consentimento a company inteira é barrada antes de olhar cliente nenhum', async () => {
    const visto = mockBanco({ candidatos: [cliente()], consentimento: false });
    const r = await reactivationAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.skipped_reason).toBe('SEM_CONSENTIMENTO');
    expect(visto.candidatosParams).toHaveLength(0);
  });

  it('(7e) GET /reactivation/preview não escreve nada — nem cupom, nem fila', async () => {
    const visto = mockBanco({ candidatos: [cliente()] });
    const res = await request(buildReactivationApp())
      .get(`/companies/${COMPANY}/reactivation/preview?segment=at_risk&date=${HOJE}`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body.would_send).toBe(1);
    expect(res.body.items).toEqual([]);
    expect(visto.outboxInserts).toHaveLength(0);
    expect(visto.cupons).toHaveLength(0);
    expect(visto.logs).toHaveLength(0);
  });
});

// ── (8) aniversário ─────────────────────────────────────────
describe('birthdayAuto', () => {
  it('(8) POST /birthday/send-whatsapp cria o cupom quando ele não veio e enfileira', async () => {
    const visto = mockBanco({ clienteUnico: cliente() });
    const res = await request(buildBirthdayApp())
      .post(`/companies/${COMPANY}/birthday/send-whatsapp`)
      .send({ customer_id: 'cust-1' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(res.body.coupon.source).toBe('birthday');
    expect(visto.cupons).toHaveLength(1);
    const params = visto.outboxInserts[0];
    expect(params[3]).toBe('aniversario_cupom');
    expect(params[9]).toBe('aniversario');
    expect(String(params[11])).toMatch(/^bday-cust-1-\d{4}$/);
    // Espelha no histórico que o card já lê (method aceito pelo CHECK da 065).
    expect(visto.historicoBday).toHaveLength(1);
    expect(visto.logs).toHaveLength(1);
  });

  it('(8b) quem já recebeu o parabéns este ano não recebe de novo (nem pelo wa.me manual)', async () => {
    const visto = mockBanco({ clienteUnico: cliente(), jaNoHistorico: true });
    const res = await request(buildBirthdayApp())
      .post(`/companies/${COMPANY}/birthday/send-whatsapp`)
      .send({ customer_id: 'cust-1' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(res.body.reason).toBe('JA_ENVIADO');
    expect(visto.outboxInserts).toHaveLength(0);
    expect(visto.cupons).toHaveLength(0);
  });

  it('(8c) cliente com marketing_opt_out não recebe — e nada é gravado', async () => {
    const visto = mockBanco({ clienteUnico: cliente({ marketing_opt_out: true }) });
    const res = await request(buildBirthdayApp())
      .post(`/companies/${COMPANY}/birthday/send-whatsapp`)
      .send({ customer_id: 'cust-1' });
    expect(res.body.queued).toBe(false);
    expect(res.body.reason).toBe('OPT_OUT_MARKETING');
    expect(visto.outboxInserts).toHaveLength(0);
  });

  it('(8d) o job roda a loja inteira e é idempotente no mesmo ano', async () => {
    const visto = mockBanco({ aniversariantes: [cliente()], clienteUnico: cliente() });
    const r1 = await birthdayAuto.runAll(HOJE);
    expect(r1.companies).toBe(1);
    expect(r1.enqueued).toBe(1);

    addons.clearCache();
    const jaFoi = mockBanco({ aniversariantes: [cliente()], clienteUnico: cliente(), jaNoLog: true });
    const r2 = await birthdayAuto.runAll(HOJE);
    expect(r2.enqueued).toBe(0);
    expect(r2.skipped.JA_ENVIADO).toBe(1);
    expect(jaFoi.outboxInserts).toHaveLength(0);
    void visto;
  });
});

// ── (9) gates das telas de configuração ─────────────────────
describe('gates das rotas de settings', () => {
  const casos = [
    ['sem plano e sem adicional → 403 ADDON_REQUIRED', { plano: 'essencial', addonAtivo: false }, 403, 'ADDON_REQUIRED'],
    ['sem número conectado → 409 NAO_CONECTADO', { conectado: false }, 409, 'NAO_CONECTADO'],
    ['template não aprovado → 409 TEMPLATE_NAO_APROVADO', { templateAprovado: false }, 409, 'TEMPLATE_NAO_APROVADO'],
    ['sem consentimento declarado → 409 SEM_CONSENTIMENTO', { consentimento: false }, 409, 'SEM_CONSENTIMENTO'],
  ];

  for (const [nome, cfg, status, code] of casos) {
    it(`(9) reativação: ${nome}`, async () => {
      const visto = mockBanco(cfg);
      const res = await request(buildReactivationApp())
        .put(`/companies/${COMPANY}/reactivation/settings`)
        .set('Authorization', 'Bearer ' + token)
        .send({ wa_reactivation_auto: true });
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(visto.autoFlags).toHaveLength(0);
      addons.clearCache();
    });

    it(`(9) aniversário: ${nome}`, async () => {
      const visto = mockBanco(cfg);
      const res = await request(buildBirthdayApp())
        .put(`/companies/${COMPANY}/birthday/settings`)
        .send({ wa_birthday_auto: true });
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(visto.autoFlags).toHaveLength(0);
      addons.clearCache();
    });
  }

  it('(9b) com tudo pronto, ligar grava o interruptor', async () => {
    const visto = mockBanco({});
    const res = await request(buildReactivationApp())
      .put(`/companies/${COMPANY}/reactivation/settings`)
      .set('Authorization', 'Bearer ' + token)
      .send({ wa_reactivation_auto: true });
    expect(res.status).toBe(200);
    expect(visto.autoFlags).toHaveLength(1);
    expect(visto.autoFlags[0][1]).toBe(true);
  });

  it('(9c) DESLIGAR nunca passa por gate — nem sem plano, nem sem conexão', async () => {
    const visto = mockBanco({ plano: 'essencial', addonAtivo: false, conectado: false, consentimento: false });
    const res = await request(buildReactivationApp())
      .put(`/companies/${COMPANY}/reactivation/settings`)
      .set('Authorization', 'Bearer ' + token)
      .send({ wa_reactivation_auto: false });
    expect(res.status).toBe(200);
    expect(visto.autoFlags[0][1]).toBe(false);
  });

  it('(9d) o fluxo manual do aniversário não mudou: PUT só com defaults segue salvando', async () => {
    const visto = mockBanco({ plano: 'essencial', addonAtivo: false, conectado: false });
    const res = await request(buildBirthdayApp())
      .put(`/companies/${COMPANY}/birthday/settings`)
      .send({ defaults: { discount_value: 15 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(visto.autoFlags).toHaveLength(0);
  });
});

// ── presets de template (categoria MARKETING) ───────────────
describe('POST /whatsapp/templates — presets de marketing', () => {
  function buildWaApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id', require('../src/routes/whatsappCloud'));
    return app;
  }

  function mockConectado() {
    const anterior = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('SELECT wa_waba_id')) {
        return Promise.resolve({ rows: [{ wa_waba_id: 'WABA1', wa_phone_number_id: 'PN1', has_token: true }] });
      }
      if (s.includes('SELECT wa_access_token')) return Promise.resolve({ rows: [{ wa_access_token: 'tok' }] });
      return anterior(sql, params);
    });
  }

  for (const [preset, esperado] of [
    ['reativacao_cupom', 'Sentimos sua falta'],
    ['aniversario_cupom', 'Feliz aniversário'],
  ]) {
    it(`${preset} vai para a Meta como MARKETING, pt_BR, com 5 exemplos`, async () => {
      mockBanco({});
      mockConectado();
      wa.createTemplate.mockResolvedValue({ id: '1', status: 'PENDING' });

      const res = await request(buildWaApp())
        .post(`/companies/${COMPANY}/whatsapp/templates`)
        .set('Authorization', 'Bearer ' + token)
        .send({ preset });

      expect(res.status).toBe(201);
      const [, , enviado] = wa.createTemplate.mock.calls[0];
      expect(enviado.name).toBe(preset);
      expect(enviado.language).toBe('pt_BR');
      // Categoria errada é o caminho curto para a Meta recategorizar
      // sozinha (cobrando como marketing) ou punir o número.
      expect(enviado.category).toBe('MARKETING');
      const body = enviado.components.find((c) => c.type === 'BODY');
      expect(body.text).toContain(esperado);
      expect((body.text.match(/\{\{\d+\}\}/g) || [])).toHaveLength(5);
      expect(body.example.body_text[0]).toHaveLength(5);
      // Saída visível: marketing sem "responda SAIR" vira denúncia de spam.
      expect(enviado.components.find((c) => c.type === 'FOOTER').text).toMatch(/SAIR/);
    });
  }
});
