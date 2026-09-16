// ============================================================
// AURA — FASE 6: a régua do CREDIÁRIO envia pelo WhatsApp oficial
//
// Princípio nº 1 da spec do WhatsApp continua valendo aqui: CADA
// MENSAGEM CUSTA DINHEIRO. A régua do crediário nunca disparou sozinha
// até agora; ligar o automático em cima de uma base como a da Valen
// (1938 parcelas abertas) só é seguro porque toda saída passa pelas
// mesmas guardas da fila (waOutbox) e pelo teto diário.
//
// Cobertura:
//  (1) PUT /credit/collection/rules com whatsapp_auto=true sem plano
//      nem adicional → 403 ADDON_REQUIRED, sem gravar.
//  (2) com plano Negócio mas sem número conectado → 409 NAO_CONECTADO.
//  (3) conectado, mas templates da Meta ainda PENDING → 409
//      TEMPLATE_NAO_APROVADO.
//  (4) tudo pronto → 200, grava whatsapp_auto + whatsapp_auto_since.
//  (5) DESLIGAR é sempre livre — nem pergunta pelo plano.
//  (6) runForCompany casa só due_date = hoje - days (negativo = antes);
//      parcela sem saldo fica fora pela própria consulta.
//  (7) dedupe: parcela que já recebeu a mesma regra não volta.
//  (8) evento de cobrança só é gravado quando a fila ACEITOU o item —
//      skip por guarda não grava (a régua tenta de novo amanhã).
//  (9) dryRun não escreve nada (é o que o preview usa).
//  (10) company com a régua ligada mas whatsapp_auto desligado não
//      enfileira nada.
//  (11) mapeamento regra→template e os 6 parâmetros do template, com
//      o Pix caindo no texto de fallback (parâmetro nunca vazio).
//  (12) GET /whatsapp/preview?source=crediario não insere na wa_outbox.
//  (13) POST /collection/trigger/:iid com channel 'whatsapp_auto'
//      enfileira e não repete no mesmo dia.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const addons = require('../src/services/addons');
const collectionAuto = require('../src/services/credit/collectionAuto');

const COMPANY = 'company-uuid-crediario';
const HOJE = '2026-09-14';

const token = jwt.sign(
  { id: 'user-lojista', role: 'admin', plan: 'negocio' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildCreditApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/credit', require('../src/routes/creditInstallments'));
  return app;
}

function buildWaApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  return app;
}

// Uma parcela de crediário como a consulta da régua devolve.
function parcela(over = {}) {
  return {
    id: 'inst-1', company_id: COMPANY, customer_id: 'cust-1',
    installment_number: 2, total_installments: 6,
    amount_due: '150.00', covered_amount: '0.00',
    due_date: '2026-09-17', status: 'pending', pix_link: null,
    late_fee: '0', late_interest: '0', collection_stage: 0,
    customer_name: 'Ana Souza', phone: '11988887777',
    store_name: 'Loja Exemplo',
    ...over,
  };
}

// "Banco" por âncora de SQL. Cada flag liga/desliga um degrau do gate.
function mockBanco({
  regua = { enabled: true, whatsapp_auto: true, rules: [{ days: -3, active: true, channel: 'whatsapp', template: 'lembrete' }] },
  plano = 'negocio', addonAtivo = false,
  conectado = true, tokenExpirado = false,
  templatesAprovados = true,
  parcelas = [], jaEnviado = false,
  filaAceita = true, filaMotivo = 'LIMITE_DIARIO',
} = {}) {
  const visto = {
    enqueues: [], eventos: [], stages: [], regraSalva: null, regraSalvaLegado: null,
    parcelasParams: [], outboxInserts: [],
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('crediario_enabled')) return Promise.resolve({ rows: [{ enabled: 'true' }] });
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
    if (s.includes('-- wa:guard-template')) {
      return Promise.resolve({ rows: templatesAprovados ? [{ status: 'APPROVED' }] : [{ status: 'PENDING' }] });
    }
    if (s.includes('-- wa:guard-paused')) return Promise.resolve({ rows: [{ wa_paused_reason: null }] });
    if (s.includes('-- wa:guard-count-today')) return Promise.resolve({ rows: [{ n: 0 }] });
    if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: [] });
    if (s.includes('-- wa:outbox-enqueue')) {
      visto.outboxInserts.push(params);
      return Promise.resolve({ rows: [{ id: 'ob-1', status: params[7] }] });
    }
    if (s.includes('-- cred:auto-rules')) {
      return Promise.resolve({ rows: regua ? [{ company_id: COMPANY, ...regua }] : [] });
    }
    if (s.includes('-- cred:auto-parcelas')) {
      visto.parcelasParams.push(params);
      return Promise.resolve({ rows: parcelas });
    }
    if (s.includes('-- cred:auto-ja-enviado')) {
      return Promise.resolve({ rows: jaEnviado ? [{ '?column?': 1 }] : [] });
    }
    if (s.includes('-- cred:auto-evento')) { visto.eventos.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- cred:auto-stage')) { visto.stages.push(params); return Promise.resolve({ rows: [] }); }
    if (s.includes('-- cred:rules-save-legado')) {
      visto.regraSalvaLegado = params;
      return Promise.resolve({ rows: [{ company_id: COMPANY, enabled: true }] });
    }
    if (s.includes('-- cred:rules-save')) {
      visto.regraSalva = params;
      return Promise.resolve({ rows: [{ company_id: COMPANY, enabled: true, whatsapp_auto: params[5] }] });
    }
    if (s.includes('-- cred:trigger-parcela')) {
      return Promise.resolve({ rows: parcelas.length ? [parcelas[0]] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  // As rotas de crédito pegam um client do pool.
  db.connect.mockResolvedValue({ query: db.query, release: () => {} });
  void filaAceita; void filaMotivo;
  return visto;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
  addons.clearCache();
});

// ── (1)-(5) gate do interruptor ─────────────────────────────
describe('PUT /credit/collection/rules — gate do envio automático', () => {
  const CORPO = {
    enabled: true, whatsapp_auto: true,
    rules: [{ days: -3, active: true, channel: 'whatsapp', template: 'lembrete' }],
  };

  it('(1) sem plano Negócio e sem adicional → 403 ADDON_REQUIRED, sem gravar', async () => {
    const visto = mockBanco({ plano: 'essencial', addonAtivo: false });
    const res = await request(buildCreditApp())
      .put(`/companies/${COMPANY}/credit/collection/rules`)
      .set('Authorization', 'Bearer ' + token).send(CORPO);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADDON_REQUIRED');
    expect(visto.regraSalva).toBeNull();
  });

  it('(2) plano Negócio mas número não conectado → 409 NAO_CONECTADO', async () => {
    const visto = mockBanco({ plano: 'negocio', conectado: false });
    const res = await request(buildCreditApp())
      .put(`/companies/${COMPANY}/credit/collection/rules`)
      .set('Authorization', 'Bearer ' + token).send(CORPO);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAO_CONECTADO');
    expect(visto.regraSalva).toBeNull();
  });

  it('(3) conectado mas templates ainda não aprovados → 409 TEMPLATE_NAO_APROVADO', async () => {
    const visto = mockBanco({ plano: 'negocio', conectado: true, templatesAprovados: false });
    const res = await request(buildCreditApp())
      .put(`/companies/${COMPANY}/credit/collection/rules`)
      .set('Authorization', 'Bearer ' + token).send(CORPO);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEMPLATE_NAO_APROVADO');
    expect(visto.regraSalva).toBeNull();
  });

  it('(4) tudo pronto → 200 e grava o interruptor com a data de ligação', async () => {
    const visto = mockBanco({ plano: 'expansao', conectado: true, templatesAprovados: true });
    const res = await request(buildCreditApp())
      .put(`/companies/${COMPANY}/credit/collection/rules`)
      .set('Authorization', 'Bearer ' + token).send(CORPO);
    expect(res.status).toBe(200);
    expect(visto.regraSalva).not.toBeNull();
    expect(visto.regraSalva[5]).toBe(true);
  });

  it('(5) desligar não passa por gate nenhum', async () => {
    const visto = mockBanco({ plano: 'essencial', addonAtivo: false, conectado: false });
    const res = await request(buildCreditApp())
      .put(`/companies/${COMPANY}/credit/collection/rules`)
      .set('Authorization', 'Bearer ' + token)
      .send({ ...CORPO, whatsapp_auto: false });
    expect(res.status).toBe(200);
    expect(visto.regraSalva[5]).toBe(false);
  });
});

// ── (6)-(11) o runner ───────────────────────────────────────
describe('collectionAuto.runForCompany', () => {
  it('(6) consulta as parcelas com due_date = hoje - days (negativo = antes do vencimento)', async () => {
    const visto = mockBanco({ parcelas: [] });
    await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(visto.parcelasParams).toHaveLength(1);
    expect(visto.parcelasParams[0]).toEqual([COMPANY, HOJE, -3]);
  });

  it('(7) parcela que já recebeu esta regra não volta (dedupe pelo evento)', async () => {
    const visto = mockBanco({ parcelas: [parcela()], jaEnviado: true });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(0);
    expect(r.skipped.JA_ENVIADO).toBe(1);
    expect(visto.outboxInserts).toHaveLength(0);
  });

  it('(8) evento e stage só quando a fila aceita; guarda que pula NÃO grava evento', async () => {
    const ok = mockBanco({ parcelas: [parcela()] });
    const r1 = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r1.enqueued).toBe(1);
    expect(ok.eventos).toHaveLength(1);
    expect(ok.stages).toHaveLength(1);
    expect(ok.eventos[0][1]).toBe('parcela_lembrete'); // template do preset
    addons.clearCache();

    // Agora a fila pula por template não aprovado: nada de evento.
    const pulado = mockBanco({ parcelas: [parcela()], templatesAprovados: false });
    const r2 = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r2.enqueued).toBe(0);
    expect(r2.skipped.TEMPLATE_NAO_APROVADO).toBe(1);
    expect(pulado.eventos).toHaveLength(0);
    expect(pulado.stages).toHaveLength(0);
  });

  it('(9) dryRun não escreve nada — nem fila, nem evento', async () => {
    const visto = mockBanco({ parcelas: [parcela()] });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE, dryRun: true });
    expect(r.enqueued).toBe(1);
    expect(visto.outboxInserts).toHaveLength(0);
    expect(visto.eventos).toHaveLength(0);
  });

  it('(10) régua ligada mas whatsapp_auto desligado → não enfileira nada', async () => {
    const visto = mockBanco({
      regua: { enabled: true, whatsapp_auto: false, rules: [{ days: 0, active: true, channel: 'whatsapp', template: 'vencimento' }] },
      parcelas: [parcela()],
    });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(0);
    expect(r.skipped_reason).toBe('AUTO_DESLIGADO');
    expect(visto.outboxInserts).toHaveLength(0);
  });

  it('(10b) sem plano e sem adicional o runner nem olha as parcelas', async () => {
    const visto = mockBanco({ plano: 'essencial', addonAtivo: false, parcelas: [parcela()] });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.skipped_reason).toBe('ADDON_INATIVO');
    expect(visto.parcelasParams).toHaveLength(0);
  });

  it('(11) atraso vira parcela_atraso com os 6 parâmetros; Pix ausente vira texto, nunca vazio', async () => {
    const visto = mockBanco({
      regua: { enabled: true, whatsapp_auto: true, rules: [{ days: 3, active: true, channel: 'whatsapp', template: 'atraso_1' }] },
      parcelas: [parcela({ due_date: '2026-09-11' })],
    });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.enqueued).toBe(1);
    const params = visto.outboxInserts[0];
    expect(params[3]).toBe('parcela_atraso'); // template_name
    const componentes = JSON.parse(params[5]);
    const texts = componentes[0].parameters.map((p) => p.text);
    expect(texts).toHaveLength(6);
    expect(texts[0]).toBe('Ana Souza');
    expect(texts[1]).toBe('Loja Exemplo');
    expect(texts[2]).toBe('2/6');
    expect(texts[3]).toBe('R$ 150,00');
    expect(texts[4]).toBe('3'); // dias em atraso
    expect(texts[5]).toBe('Pague na loja ou fale conosco');
    for (const t of texts) {
      expect(String(t).trim()).not.toBe('');
      expect(/[\n\t]|\s{4,}/.test(String(t))).toBe(false);
    }
  });

  it('(11b) regra de bloqueio não é WhatsApp — a régua pula sem consultar parcela', async () => {
    const visto = mockBanco({
      regua: { enabled: true, whatsapp_auto: true, rules: [{ days: 30, active: true, channel: 'whatsapp', template: 'bloqueio' }] },
      parcelas: [parcela()],
    });
    const r = await collectionAuto.runForCompany(COMPANY, { today: HOJE });
    expect(r.rules).toBe(0);
    expect(visto.parcelasParams).toHaveLength(0);
  });
});

// ── (12) prévia do crediário ────────────────────────────────
describe('GET /whatsapp/preview?source=crediario', () => {
  it('(12) devolve a contagem sem inserir uma linha sequer na wa_outbox', async () => {
    const visto = mockBanco({ parcelas: [parcela()] });
    const res = await request(buildWaApp())
      .get(`/companies/${COMPANY}/whatsapp/preview?source=crediario&date=${HOJE}`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('crediario');
    expect(res.body.would_send).toBe(1);
    expect(visto.outboxInserts).toHaveLength(0);
    expect(visto.eventos).toHaveLength(0);
  });
});

// ── (13) cobrança manual pela via oficial ───────────────────
describe('POST /credit/collection/trigger/:iid com channel whatsapp_auto', () => {
  it('(13) enfileira o template e devolve queued; o mesmo dia não repete', async () => {
    const visto = mockBanco({ parcelas: [parcela({ due_date: '2026-09-11' })] });
    const res = await request(buildCreditApp())
      .post(`/companies/${COMPANY}/credit/collection/trigger/inst-1`)
      .set('Authorization', 'Bearer ' + token)
      .send({ channel: 'whatsapp_auto' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(visto.outboxInserts).toHaveLength(1);
    // dedupeKey de 1 por dia por parcela
    expect(String(visto.outboxInserts[0][11])).toMatch(/^cred-manual-inst-1-\d{4}-\d{2}-\d{2}$/);
    expect(visto.outboxInserts[0][9]).toBe('crediario_manual');

    // Segundo clique no mesmo dia: a chave já existe e o INSERT não
    // devolve linha (ON CONFLICT DO NOTHING) — nada vai à Meta de novo.
    const antes = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      if (String(sql).includes('-- wa:outbox-enqueue')) return Promise.resolve({ rows: [] });
      return antes(sql, params);
    });
    const repetido = await request(buildCreditApp())
      .post(`/companies/${COMPANY}/credit/collection/trigger/inst-1`)
      .set('Authorization', 'Bearer ' + token)
      .send({ channel: 'whatsapp_auto' });
    expect(repetido.status).toBe(200);
    expect(repetido.body.queued).toBe(false);
    expect(repetido.body.reason).toBe('DUPLICADO');
  });
});
