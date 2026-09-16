// ============================================================
// AURA — CRM Fase 1: consentimento de marketing POR CLIENTE (340)
//
// Cobertura:
//  (1) canSendMarketing: sem corte (regra antiga, declaração da empresa),
//      corte futuro, corte passado com e sem opt-in, opt-out vence
//      (evento, wa_contacts e cadastro), migration pendente.
//  (2) recordConsent: opt-out propaga para todas as empresas do dono;
//      opt-in fica só na loja; validação.
//  (3) fila: marketing sem opt-in depois do corte → skipped
//      SEM_OPTIN_CLIENTE (enqueue e despacho); cobrança passa; a prévia
//      de reativação conta os pulados.
//  (4) webhook: SIM em resposta à loja grava opt-in; SAIR grava opt-out;
//      SIM solto (sem mensagem da loja) não grava.
//  (5) rotas: validação de body, 404, permissão, settings e resumo.
// ============================================================
'use strict';

const crypto = require('crypto');

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
process.env.WA_APP_SECRET = 'secret-test-consentimento';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
  createTemplate: jest.fn(),
  listTemplates: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const outbox = require('../src/services/waOutbox');
const consent = require('../src/services/customerConsent');
const addons = require('../src/services/addons');

const LOJA_A = '11111111-1111-4111-8111-111111111111';
const LOJA_B = '22222222-2222-4222-8222-222222222222';
const CLIENTE = '33333333-3333-4333-8333-333333333333';
const CLIENTE_B = '44444444-4444-4444-8444-444444444444';
const FONE = '5511988887777';

function ontem() { return consent.todayBRT(Date.now() - 86400000); }
function amanha() { return consent.todayBRT(Date.now() + 86400000); }

// "Banco" por âncora de SQL.
function mockBanco({
  declarado = true,
  corte = null,
  corteAusente = false,
  eventosAusente = false,
  ultimoEvento = null,           // { action, channel, created_at }
  contatoSaiu = false,
  clienteOptOut = false,
  cliente = { id: CLIENTE, company_id: LOJA_A, name: 'Ana', phone: '(11) 98888-7777', marketing_opt_out: false },
  grupo = [LOJA_A],
  clientesPorFone = [CLIENTE],
  lojaMandouRecente = false,
  resumo = { total: 10, opt_in: 3, opt_out: 2 },
  role = 'owner',
  marketingPendente = null,       // linha da wa_outbox para o processBatch
} = {}) {
  const visto = {
    eventos: [], contatos: [], flags: [], outbox: [], marcados: [], cortes: [],
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    const erro = (code) => Promise.reject(Object.assign(new Error('schema'), { code }));
    // acesso / empresas
    if (s.includes("SELECT 'owner' AS role")) return Promise.resolve({ rows: role ? [{ role }] : [] });
    if (s.includes('WHERE owner_id = (SELECT owner_id FROM companies')) {
      return Promise.resolve({ rows: grupo.map((id) => ({ id })) });
    }
    if (s.includes('-- consent:me-companies')) {
      return Promise.resolve({ rows: grupo.map((id, i) => ({
        id, trade_name: `Loja ${i + 1}`, legal_name: null, is_primary: i === 0, created_at: '2026-01-01',
      })) });
    }
    // consentimento
    if (s.includes('-- consent:store-name')) return Promise.resolve({ rows: [{ store_name: 'Finesse' }] });
    if (s.includes('-- consent:cutoff-get')) {
      if (corteAusente) return erro('42703');
      return Promise.resolve({ rows: [{ optin_required_from: corte }] });
    }
    if (s.includes('-- consent:cutoff-set')) {
      if (corteAusente) return erro('42703');
      visto.cortes.push(params);
      return Promise.resolve({ rows: [] });
    }
    if (s.includes('-- consent:status-customer')) {
      return Promise.resolve({ rows: cliente ? [{ ...cliente, marketing_opt_out: clienteOptOut }] : [] });
    }
    if (s.includes('-- consent:status-event')) {
      if (eventosAusente) return erro('42P01');
      return Promise.resolve({ rows: ultimoEvento ? [ultimoEvento] : [] });
    }
    if (s.includes('-- consent:status-contact')) {
      return Promise.resolve({ rows: contatoSaiu ? [{ opted_out_at: '2026-09-01T00:00:00Z', opt_source: 'inbound' }] : [] });
    }
    if (s.includes('-- consent:customer-get') || s.includes('-- consent:route-customer')) {
      const ok = cliente && params[0] === cliente.id && params[1].includes(cliente.company_id);
      return Promise.resolve({ rows: ok ? [cliente] : [] });
    }
    if (s.includes('-- consent:customer-by-phone')) {
      return Promise.resolve({ rows: clientesPorFone.map((id) => ({ id })) });
    }
    if (s.includes('-- consent:event-insert')) {
      if (eventosAusente) return erro('42P01');
      visto.eventos.push(params);
      return Promise.resolve({ rows: [{
        id: `ev-${visto.eventos.length}`, company_id: params[0], customer_id: params[1],
        phone: params[2], action: params[3], channel: params[4], purpose: 'marketing',
        consent_text: params[5], collected_by: params[6], created_at: '2026-09-16T12:00:00Z',
      }] });
    }
    if (s.includes('-- consent:events-list')) {
      if (eventosAusente) return erro('42P01');
      return Promise.resolve({ rows: ultimoEvento ? [{ id: 'ev-9', ...ultimoEvento }] : [] });
    }
    if (s.includes('-- consent:contact-sync')) { visto.contatos.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- consent:customer-flag')) { visto.flags.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- consent:recent-store-outbox')) {
      return Promise.resolve({ rows: lojaMandouRecente ? [{ '?column?': 1 }] : [] });
    }
    if (s.includes('-- consent:recent-store-message')) return Promise.resolve({ rows: [] });
    if (s.includes('-- consent:summary')) {
      if (eventosAusente && s.includes('customer_consent_events')) return erro('42P01');
      return Promise.resolve({ rows: [resumo] });
    }
    // fila
    if (s.includes('-- wa:guard-marketing-consent')) {
      return Promise.resolve({ rows: [{ wa_marketing_consent_at: declarado ? '2026-09-01T00:00:00Z' : null }] });
    }
    if (s.includes('-- wa:guard-template')) return Promise.resolve({ rows: [{ status: 'APPROVED' }] });
    if (s.includes('-- wa:guard-paused')) return Promise.resolve({ rows: [{ wa_paused_reason: null }] });
    if (s.includes('-- wa:guard-quality')) return Promise.resolve({ rows: [{ wa_quality_rating: 'GREEN' }] });
    if (s.includes('-- wa:guard-marketing-count')) return Promise.resolve({ rows: [{ n: 0 }] });
    if (s.includes('-- wa:guard-count-today')) return Promise.resolve({ rows: [{ n: 0 }] });
    if (s.includes('-- wa:quota')) return Promise.resolve({ rows: [{ n: 0 }] });
    if (s.includes('-- wa:contact-touch')) {
      return Promise.resolve({ rows: [{ id: 'contact-1', opted_out_at: null }] });
    }
    if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: [] });
    if (s.includes('-- wa:outbox-enqueue')) {
      visto.outbox.push(params);
      return Promise.resolve({ rows: [{ id: 'ob-1', status: params[7] }] });
    }
    if (s.includes('-- wa:outbox-pick')) return Promise.resolve({ rows: marketingPendente ? [marketingPendente] : [] });
    if (s.includes('-- wa:creds')) return Promise.resolve({ rows: [{ wa_phone_number_id: 'PN1', wa_access_token: 'tok' }] });
    if (/UPDATE wa_outbox SET/.test(s)) { visto.marcados.push(params); return Promise.resolve({ rows: [] }); }
    if (/wa_phone_number_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: LOJA_A }] });
    // reativação / gate
    if (s.includes('-- addon:has')) return Promise.resolve({ rows: [] });
    if (s.includes('-- addon:plan')) return Promise.resolve({ rows: [{ plan: 'expansao' }] });
    if (s.includes('-- wa:conn-state-flag')) return Promise.resolve({ rows: [{ wa_token_invalid_at: null }] });
    if (s.includes('-- wa:conn-state')) return Promise.resolve({ rows: [{ wa_phone_number_id: 'PN1', has_token: true }] });
    if (s.includes('-- mkt:react-candidatos')) {
      return Promise.resolve({ rows: [
        { id: CLIENTE, name: 'Ana', phone: '11988887777', total_spent: 900, days_since: 44 },
      ] });
    }
    return Promise.resolve({ rows: [] });
  });
  return visto;
}

afterEach(() => {
  db.query.mockReset();
  wa.sendTemplate.mockReset();
  wa.sendText.mockReset();
  consent._resetSchemaCache();
  if (addons.clearCache) addons.clearCache();
});

// ── (1) regra ───────────────────────────────────────────────
describe('canSendMarketing — regra de envio', () => {
  const alvo = { companyId: LOJA_A, customerId: CLIENTE, phone: '11988887777' };

  it('sem corte + consentimento declarado → envia (regra antiga)', async () => {
    mockBanco({ corte: null, declarado: true });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: true, reason: null });
  });

  it('sem corte e sem declaração → SEM_CONSENTIMENTO', async () => {
    mockBanco({ corte: null, declarado: false });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: false, reason: 'SEM_CONSENTIMENTO' });
  });

  it('corte no futuro → ainda vale a declaração, mesmo sem opt-in individual', async () => {
    mockBanco({ corte: amanha(), declarado: true });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: true, reason: null });
  });

  it('corte passado e sem opt-in → SEM_OPTIN_CLIENTE (a declaração não basta)', async () => {
    mockBanco({ corte: ontem(), declarado: true });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: false, reason: 'SEM_OPTIN_CLIENTE' });
  });

  it('corte HOJE já vale', async () => {
    mockBanco({ corte: consent.todayBRT(), declarado: true });
    const r = await consent.canSendMarketing(alvo);
    expect(r.reason).toBe('SEM_OPTIN_CLIENTE');
  });

  it('corte passado com opt-in individual → envia', async () => {
    mockBanco({
      corte: ontem(), declarado: false,
      ultimoEvento: { action: 'opt_in', channel: 'pdv', created_at: '2026-09-10T00:00:00Z' },
    });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: true, reason: null });
  });

  it('opt-out (evento) vence tudo, com ou sem corte', async () => {
    for (const corte of [null, amanha(), ontem()]) {
      mockBanco({ corte, ultimoEvento: { action: 'opt_out', channel: 'whatsapp', created_at: '2026-09-10T00:00:00Z' } });
      // eslint-disable-next-line no-await-in-loop
      await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: false, reason: 'OPT_OUT' });
    }
  });

  it('opt-out legado no wa_contacts vence um opt-in em evento', async () => {
    mockBanco({
      corte: ontem(), contatoSaiu: true,
      ultimoEvento: { action: 'opt_in', channel: 'pdv', created_at: '2026-08-01T00:00:00Z' },
    });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: false, reason: 'OPT_OUT' });
  });

  it('marketing_opt_out do cadastro bloqueia', async () => {
    mockBanco({ corte: null, clienteOptOut: true });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: false, reason: 'OPT_OUT' });
  });

  it('migration 340 pendente (42P01/42703) → regra antiga, sem exceção', async () => {
    mockBanco({ eventosAusente: true, corteAusente: true, declarado: true });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: true, reason: null });
    mockBanco({ eventosAusente: true, corteAusente: true, declarado: false });
    await expect(consent.canSendMarketing(alvo)).resolves.toEqual({ ok: false, reason: 'SEM_CONSENTIMENTO' });
  });

  it('getConsentStatus devolve status, data e canal', async () => {
    mockBanco({ ultimoEvento: { action: 'opt_in', channel: 'qr', created_at: '2026-09-10T00:00:00Z' } });
    await expect(consent.getConsentStatus(alvo)).resolves.toEqual({
      status: 'opt_in', since: '2026-09-10T00:00:00Z', channel: 'qr',
    });
    mockBanco({});
    await expect(consent.getConsentStatus(alvo)).resolves.toEqual({ status: 'sem_registro', since: null, channel: null });
  });
});

// ── (2) gravação ────────────────────────────────────────────
describe('recordConsent', () => {
  it('opt-out propaga para TODAS as empresas do dono e marca os cadastros do telefone', async () => {
    const visto = mockBanco({ grupo: [LOJA_A, LOJA_B], clientesPorFone: [CLIENTE, CLIENTE_B] });
    const r = await consent.recordConsent({
      companyId: LOJA_A, customerId: CLIENTE, action: 'opt_out', channel: 'pdv', userId: 'user-1',
    });
    expect(r.ok).toBe(true);
    expect(r.company_ids).toEqual([LOJA_A, LOJA_B]);
    expect(visto.eventos.map((p) => [p[0], p[1], p[2], p[3], p[4], p[6]])).toEqual([
      [LOJA_A, CLIENTE, FONE, 'opt_out', 'pdv', 'user-1'],
      [LOJA_B, CLIENTE, FONE, 'opt_out', 'pdv', 'user-1'],
    ]);
    expect(visto.contatos.map((p) => [p[0], p[1], p[2], p[3]])).toEqual([
      [LOJA_A, FONE, false, 'pdv'],
      [LOJA_B, FONE, false, 'pdv'],
    ]);
    expect(visto.flags).toEqual([[[CLIENTE, CLIENTE_B], true]]);
  });

  it('opt-in fica só na loja que coletou e desliga o marketing_opt_out do cadastro', async () => {
    const visto = mockBanco({ grupo: [LOJA_A, LOJA_B] });
    const r = await consent.recordConsent({
      companyId: LOJA_A, customerId: CLIENTE, action: 'opt_in', channel: 'cadastro', text: 'Aceito',
    });
    expect(r.company_ids).toEqual([LOJA_A]);
    expect(visto.eventos).toHaveLength(1);
    expect(visto.eventos[0].slice(0, 6)).toEqual([LOJA_A, CLIENTE, FONE, 'opt_in', 'cadastro', 'Aceito']);
    expect(visto.contatos).toEqual([[LOJA_A, FONE, true, 'cadastro']]);
    expect(visto.flags).toEqual([[[CLIENTE], false]]);
  });

  it('só telefone (webhook) acha o cliente pelo número', async () => {
    const visto = mockBanco({ clientesPorFone: [CLIENTE] });
    await consent.recordConsent({ companyId: LOJA_A, phone: '11988887777', action: 'opt_in', channel: 'whatsapp' });
    expect(visto.eventos[0][1]).toBe(CLIENTE);
    expect(visto.eventos[0][2]).toBe(FONE);
  });

  it('valida action, channel, telefone e cliente do grupo', async () => {
    mockBanco({});
    await expect(consent.recordConsent({ companyId: LOJA_A, phone: FONE, action: 'talvez', channel: 'pdv' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(consent.recordConsent({ companyId: LOJA_A, phone: FONE, action: 'opt_in', channel: 'sms' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(consent.recordConsent({ companyId: LOJA_A, phone: '123', action: 'opt_in', channel: 'pdv' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(consent.recordConsent({ companyId: LOJA_A, action: 'opt_in', channel: 'pdv' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(consent.recordConsent({ companyId: LOJA_A, customerId: CLIENTE_B, action: 'opt_in', channel: 'pdv' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('migration pendente → SCHEMA_PENDING, sem mexer nos espelhos', async () => {
    const visto = mockBanco({ eventosAusente: true });
    const r = await consent.recordConsent({ companyId: LOJA_A, customerId: CLIENTE, action: 'opt_out', channel: 'pdv' });
    expect(r).toEqual({ ok: false, code: 'SCHEMA_PENDING' });
    expect(visto.contatos).toHaveLength(0);
    expect(visto.flags).toHaveLength(0);
  });
});

// ── (3) fila ────────────────────────────────────────────────
describe('waOutbox — trava SEM_OPTIN_CLIENTE', () => {
  it('enqueue de reativação depois do corte, sem opt-in → skipped SEM_OPTIN_CLIENTE', async () => {
    const visto = mockBanco({ corte: ontem() });
    const r = await outbox.enqueue({
      companyId: LOJA_A, toPhone: '11988887777',
      templateName: 'reativacao_cupom', sourceType: 'reativacao', sourceId: CLIENTE,
    });
    expect(r).toMatchObject({ queued: false, status: 'skipped', reason: 'SEM_OPTIN_CLIENTE' });
    expect(visto.outbox[0][7]).toBe('skipped');
    expect(visto.outbox[0][8]).toBe('SEM_OPTIN_CLIENTE');
  });

  it('o id do cliente vem do source_id nas origens de cliente', async () => {
    mockBanco({ corte: ontem() });
    await outbox.enqueue({
      companyId: LOJA_A, toPhone: '11988887777',
      templateName: 'aniversario_cupom', sourceType: 'aniversario', sourceId: CLIENTE,
    });
    const chamadas = db.query.mock.calls.filter(([sql]) => String(sql).includes('-- consent:status-event'));
    expect(chamadas[0][1]).toEqual([LOJA_A, CLIENTE, FONE]);
    expect(outbox.customerIdFromSource('otica_revisao', CLIENTE)).toBeNull();
    expect(outbox.customerIdFromSource('reativacao', 'nao-uuid')).toBeNull();
  });

  it('com opt-in individual, a reativação passa', async () => {
    const visto = mockBanco({
      corte: ontem(),
      ultimoEvento: { action: 'opt_in', channel: 'whatsapp', created_at: '2026-09-10T00:00:00Z' },
    });
    const r = await outbox.enqueue({
      companyId: LOJA_A, toPhone: '11988887777',
      templateName: 'reativacao_cupom', sourceType: 'reativacao', sourceId: CLIENTE,
    });
    expect(r.reason).toBeNull();
    expect(visto.outbox[0][7]).toBe('pending');
  });

  it('cobrança do crediário NÃO passa pela trava', async () => {
    const visto = mockBanco({ corte: ontem(), declarado: false });
    const r = await outbox.enqueue({
      companyId: LOJA_A, toPhone: '11988887777',
      templateName: 'parcela_lembrete', sourceType: 'crediario', sourceId: CLIENTE,
    });
    expect(r.queued).toBe(true);
    expect(visto.outbox[0][7]).toBe('pending');
    const consultouConsent = db.query.mock.calls.some(([sql]) => String(sql).includes('-- consent:'));
    expect(consultouConsent).toBe(false);
  });

  it('despacho: item de marketing pendente depois do corte vira skipped SEM_OPTIN_CLIENTE', async () => {
    const visto = mockBanco({
      corte: ontem(),
      marketingPendente: {
        id: 'ob-9', company_id: LOJA_A, to_phone: FONE, kind: 'template',
        template_name: 'reativacao_cupom', template_language: 'pt_BR',
        source_type: 'reativacao', source_id: CLIENTE, attempts: 0,
      },
    });
    const out = await outbox.processBatch(5);
    expect(out.skipped).toBe(1);
    expect(wa.sendTemplate).not.toHaveBeenCalled();
    expect(visto.marcados[0]).toEqual(['skipped', 'SEM_OPTIN_CLIENTE', 'ob-9']);
  });

  it('prévia de reativação conta os pulados por SEM_OPTIN_CLIENTE', async () => {
    mockBanco({ corte: ontem() });
    addons.clearCache && addons.clearCache();
    const app = express();
    app.use(express.json());
    app.use('/companies/:id/reactivation', (req, _res, next) => { req.user = { id: 'u', plan: 'expansao' }; next(); },
      require('../src/routes/customerReactivation'));
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 'u', role: 'admin', plan: 'expansao' }, 'aura-test-secret-2026', { expiresIn: '1h' });
    const res = await request(app)
      .get(`/companies/${LOJA_A}/reactivation/preview`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body.would_send).toBe(0);
    expect(res.body.skipped).toEqual({ SEM_OPTIN_CLIENTE: 1 });
    expect(res.body.skipped_sem_optin_cliente).toBe(1);
  });
});

// ── (4) webhook ─────────────────────────────────────────────
describe('webhook — SIM / SAIR', () => {
  function app() {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    a.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
    return a;
  }
  function mensagem(msg) {
    return {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PN1' },
        messages: [{ id: 'wamid.IN1', from: FONE, timestamp: '1780000000', type: 'text', ...msg }],
      } }] }],
    };
  }
  async function post(body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', 'secret-test-consentimento')
      .update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
    const res = await request(app()).post('/webhooks/whatsapp').set('x-hub-signature-256', sig).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
  }

  it('"Sim!" em resposta a uma mensagem da loja grava opt-in pelo WhatsApp', async () => {
    const visto = mockBanco({ lojaMandouRecente: true });
    await post(mensagem({ text: { body: 'Sim!' } }));
    expect(visto.eventos).toHaveLength(1);
    expect(visto.eventos[0].slice(0, 6)).toEqual([LOJA_A, CLIENTE, FONE, 'opt_in', 'whatsapp', 'Sim!']);
  });

  it('"quero" citando uma mensagem (context.id) grava mesmo sem outbox recente', async () => {
    const visto = mockBanco({ lojaMandouRecente: false });
    await post(mensagem({ text: { body: 'QUERO' }, context: { id: 'wamid.LOJA' } }));
    expect(visto.eventos.map((p) => p[3])).toEqual(['opt_in']);
  });

  it('"sim" solto, sem mensagem da loja, não grava nada', async () => {
    const visto = mockBanco({ lojaMandouRecente: false });
    await post(mensagem({ text: { body: 'sim' } }));
    expect(visto.eventos).toHaveLength(0);
  });

  it('"sim, tem no M?" não é aceite', async () => {
    const visto = mockBanco({ lojaMandouRecente: true });
    await post(mensagem({ text: { body: 'sim, tem no M?' } }));
    expect(visto.eventos).toHaveLength(0);
  });

  it('"sim" de quem saiu NÃO desfaz o opt-out', async () => {
    const visto = mockBanco({
      lojaMandouRecente: true,
      ultimoEvento: { action: 'opt_out', channel: 'whatsapp', created_at: '2026-09-10T00:00:00Z' },
    });
    await post(mensagem({ text: { body: 'sim' } }));
    expect(visto.eventos).toHaveLength(0);
  });

  it('"SAIR" grava o EVENTO de opt-out (propagado ao grupo)', async () => {
    const visto = mockBanco({ grupo: [LOJA_A, LOJA_B] });
    await post(mensagem({ text: { body: 'SAIR' } }));
    expect(visto.eventos.map((p) => [p[0], p[3], p[4], p[5]])).toEqual([
      [LOJA_A, 'opt_out', 'whatsapp', 'SAIR'],
      [LOJA_B, 'opt_out', 'whatsapp', 'SAIR'],
    ]);
  });

  it('botão "Parar promoções" também é opt-out', async () => {
    const visto = mockBanco({});
    await post(mensagem({ type: 'button', button: { text: 'Parar promoções', payload: 'STOP' } }));
    expect(visto.eventos.map((p) => p[3])).toEqual(['opt_out']);
  });
});

// ── (5) rotas ───────────────────────────────────────────────
describe('rotas de consentimento', () => {
  function app(role = 'owner') {
    const a = express();
    a.use(express.json());
    a.use('/companies/:id', (req, _res, next) => {
      req.user = { id: 'user-1', plan: 'essencial' };
      req.companyRole = role;
      next();
    }, require('../src/routes/customerConsent').companyRouter);
    return a;
  }

  it('GET /customers/:cid/consent → status + eventos', async () => {
    mockBanco({ ultimoEvento: { action: 'opt_in', channel: 'pdv', created_at: '2026-09-10T00:00:00Z' } });
    const res = await request(app()).get(`/companies/${LOJA_A}/customers/${CLIENTE}/consent`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      customer_id: CLIENTE, company_id: LOJA_A, status: 'opt_in', channel: 'pdv',
    });
    expect(res.body.events).toHaveLength(1);
  });

  it('GET de cliente fora do grupo ou id inválido → 404', async () => {
    mockBanco({});
    expect((await request(app()).get(`/companies/${LOJA_A}/customers/${CLIENTE_B}/consent`)).status).toBe(404);
    expect((await request(app()).get(`/companies/${LOJA_A}/customers/abc/consent`)).status).toBe(404);
  });

  it('POST valida o body', async () => {
    mockBanco({});
    const url = `/companies/${LOJA_A}/customers/${CLIENTE}/consent`;
    for (const body of [
      {},
      { action: 'opt_in' },
      { action: 'sim', channel: 'pdv' },
      { action: 'opt_in', channel: 'email' },
      { action: 'opt_in', channel: 'pdv', text: 42 },
      { action: 'opt_in', channel: 'pdv', text: 'x'.repeat(2001) },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app()).post(url).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('POST opt_in sem texto grava o texto padrão com o nome da loja', async () => {
    const visto = mockBanco({});
    const res = await request(app())
      .post(`/companies/${LOJA_A}/customers/${CLIENTE}/consent`)
      .send({ action: 'opt_in', channel: 'pdv' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(visto.eventos[0][5]).toBe(
      'Aceito receber ofertas e novidades da Finesse pelo WhatsApp. Posso sair quando quiser respondendo SAIR.'
    );
    expect(visto.eventos[0][6]).toBe('user-1');
  });

  it('POST de cliente de outra loja do dono funciona; fora do grupo → 404', async () => {
    mockBanco({
      grupo: [LOJA_A, LOJA_B],
      cliente: { id: CLIENTE_B, company_id: LOJA_B, name: 'Bia', phone: '11977776666', marketing_opt_out: false },
    });
    const ok = await request(app()).post(`/companies/${LOJA_A}/customers/${CLIENTE_B}/consent`)
      .send({ action: 'opt_out', channel: 'manual' });
    expect(ok.status).toBe(201);
    expect(ok.body.propagated_company_ids).toEqual([LOJA_A, LOJA_B]);

    mockBanco({ grupo: [LOJA_A] });
    const nf = await request(app()).post(`/companies/${LOJA_A}/customers/${CLIENTE_B}/consent`)
      .send({ action: 'opt_out', channel: 'manual' });
    expect(nf.status).toBe(404);
  });

  it('POST com migration pendente → 503 SCHEMA_PENDING', async () => {
    mockBanco({ eventosAusente: true });
    const res = await request(app()).post(`/companies/${LOJA_A}/customers/${CLIENTE}/consent`)
      .send({ action: 'opt_out', channel: 'pdv' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING');
  });

  it('GET /whatsapp/consent/settings', async () => {
    mockBanco({ corte: '2026-12-01' });
    const res = await request(app()).get(`/companies/${LOJA_A}/whatsapp/consent/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      optin_required_from: '2026-12-01',
      wa_marketing_consent_at: '2026-09-01T00:00:00Z',
      schema_pending: false,
    });
    expect(res.body.texto_optin_padrao).toMatch(/Finesse/);
  });

  it('PUT settings: só dono/admin; data futura ou null', async () => {
    const url = `/companies/${LOJA_A}/whatsapp/consent/settings`;
    mockBanco({});
    expect((await request(app('vendedor')).put(url).send({ optin_required_from: amanha() })).status).toBe(403);
    expect((await request(app()).put(url).send({})).status).toBe(400);
    expect((await request(app()).put(url).send({ optin_required_from: ontem() })).status).toBe(400);
    expect((await request(app()).put(url).send({ optin_required_from: consent.todayBRT() })).status).toBe(400);
    expect((await request(app()).put(url).send({ optin_required_from: '2026-02-30' })).status).toBe(400);
    expect((await request(app()).put(url).send({ optin_required_from: 20261201 })).status).toBe(400);

    const visto = mockBanco({ corte: amanha() });
    const ok = await request(app('admin')).put(url).send({ optin_required_from: amanha() });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, optin_required_from: amanha(), optin_required_active: false });
    expect(visto.cortes).toEqual([[LOJA_A, amanha()]]);

    const visto2 = mockBanco({});
    const limpa = await request(app()).put(url).send({ optin_required_from: null });
    expect(limpa.status).toBe(200);
    expect(visto2.cortes).toEqual([[LOJA_A, null]]);
  });

  it('PUT settings com a coluna ausente → 503', async () => {
    mockBanco({ corteAusente: true });
    const res = await request(app()).put(`/companies/${LOJA_A}/whatsapp/consent/settings`)
      .send({ optin_required_from: amanha() });
    expect(res.status).toBe(503);
  });

  it('GET /whatsapp/consent/summary', async () => {
    mockBanco({ resumo: { total: 8, opt_in: 2, opt_out: 1 } });
    const res = await request(app()).get(`/companies/${LOJA_A}/whatsapp/consent/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      company_id: LOJA_A,
      total_clientes_com_telefone: 8, opt_in: 2, opt_out: 1, sem_registro: 5, pct_opt_in: 25,
      texto_optin_padrao: 'Aceito receber ofertas e novidades da Finesse pelo WhatsApp. Posso sair quando quiser respondendo SAIR.',
      schema_pending: false,
    });
  });

  it('summary sem a tabela de eventos cai para a contagem sem opt-in', async () => {
    mockBanco({ eventosAusente: true, resumo: { total: 4, opt_in: 0, opt_out: 1 } });
    const res = await request(app()).get(`/companies/${LOJA_A}/whatsapp/consent/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total_clientes_com_telefone: 4, opt_in: 0, opt_out: 1, schema_pending: true });
  });

  it('GET /me/whatsapp/consent/summary consolida as empresas', async () => {
    mockBanco({ grupo: [LOJA_A, LOJA_B], resumo: { total: 10, opt_in: 3, opt_out: 2 } });
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 'user-1', role: 'user', plan: 'negocio' }, 'aura-test-secret-2026', { expiresIn: '1h' });
    const a = express();
    a.use('/me', require('../src/routes/customerConsent').meRouter);
    const res = await request(a).get('/me/whatsapp/consent/summary').set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total_clientes_com_telefone: 20, opt_in: 6, opt_out: 4, sem_registro: 10, pct_opt_in: 30,
      company_count: 2,
    });
    expect(res.body.breakdown.map((b) => [b.company_id, b.company_name])).toEqual([
      [LOJA_A, 'Loja 1'], [LOJA_B, 'Loja 2'],
    ]);
  });
});
