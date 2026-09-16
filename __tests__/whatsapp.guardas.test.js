// ============================================================
// AURA — WhatsApp Fase 2: guardas de custo na fila
//
// Princípio nº 1 da spec: CADA MENSAGEM CUSTA DINHEIRO. Nenhuma mensagem
// sai da fila sem passar por todas as guardas — duplicadas no enfileirar
// E no despachar.
//
// Cobertura:
//  (1) enqueue: contato invalid_at → TELEFONE_INVALIDO_META.
//  (2) enqueue: template não aprovado (ou 42P01) → TEMPLATE_NAO_APROVADO.
//  (3) enqueue: company pausada → PAUSADO (e QUALIDADE_BAIXA quando o
//      motivo for esse).
//  (4) enqueue: teto diário da company (WA_DAILY_CAP) → LIMITE_DIARIO.
//  (5) enqueue: teto por contato (WA_PER_PHONE_DAILY_CAP) → LIMITE_POR_CONTATO.
//  (6) item de TESTE ignora template/tetos automáticos mas respeita
//      telefone inválido e pausa; teto PRÓPRIO de 5/dia (2f).
//  (7) processBatch: reforço 1/2/3 repete no despacho.
//  (8) processBatch: erro permanente da Meta (código) → failed na 1ª
//      tentativa; efeitos colaterais (invalid_at, wa_registered_at=NULL,
//      wa_paused_reason=CONTA_RESTRITA); erro de REDE (sem err.meta)
//      segue em retry/backoff — nunca é confundido com permanente.
//  (9) GET /whatsapp/preview: nunca insere na wa_outbox; conta seguindo
//      a MESMA ordem da fila; company sem addon → tudo ADDON_INATIVO.
//  (10) POST /whatsapp/test-send: 6º envio de teste no dia → skipped
//      LIMITE_DIARIO (cap fixo de 5).
//  (11) webhook: phone_number_quality_update (FLAGGED/UNFLAGGED) e
//      account_update (conta restrita) — 42703-safe.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
process.env.WA_APP_SECRET = 'secret-test-guardas';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const outbox = require('../src/services/waOutbox');
const addons = require('../src/services/addons');

const COMPANY = 'company-uuid-guardas';

const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'essencial' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  wa.sendTemplate.mockReset();
  wa.sendText.mockReset();
  addons.clearCache();
  delete process.env.WA_DAILY_CAP;
  delete process.env.WA_PER_PHONE_DAILY_CAP;
});

// ── (1)-(6) enqueue ──────────────────────────────────────────
describe('enqueue — guardas de custo (2a)', () => {
  function mockEnqueue({
    contact = null, templateApproved = true, pauseReason = null,
    dailyCount = 0, phoneCount = 0, testCount = 0,
  } = {}) {
    const inserted = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: contact ? [contact] : [] });
      if (s.includes('-- wa:guard-template')) {
        return Promise.resolve({ rows: templateApproved ? [{ status: 'APPROVED' }] : [] });
      }
      if (s.includes('-- wa:guard-paused')) {
        return Promise.resolve({ rows: [{ wa_paused_reason: pauseReason }] });
      }
      if (s.includes('-- wa:guard-count-today')) {
        // params: [companyId, phone, sourceType]
        if (params[2] === 'teste') return Promise.resolve({ rows: [{ n: testCount }] });
        if (params[1] != null) return Promise.resolve({ rows: [{ n: phoneCount }] });
        return Promise.resolve({ rows: [{ n: dailyCount }] });
      }
      if (s.includes('-- wa:outbox-enqueue')) {
        inserted.push(params);
        return Promise.resolve({ rows: [{ id: 'ob-x', status: params[7] }] });
      }
      return Promise.resolve({ rows: [] });
    });
    return inserted;
  }

  it('(1) contato com invalid_at → TELEFONE_INVALIDO_META, nunca chega no template/pausa', async () => {
    mockEnqueue({ contact: { invalid_at: '2026-09-01T00:00:00Z' } });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete' });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('TELEFONE_INVALIDO_META');
  });

  it('(2) template não aprovado (ou ausente/42P01) → TEMPLATE_NAO_APROVADO', async () => {
    mockEnqueue({ templateApproved: false });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete' });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('TEMPLATE_NAO_APROVADO');
  });

  it('(3) company pausada → PAUSADO; motivo QUALIDADE_BAIXA vira o próprio reason', async () => {
    const generico = mockEnqueue({ pauseReason: 'MANUAL' });
    const rGenerico = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete' });
    expect(rGenerico.reason).toBe('PAUSADO');
    void generico;

    mockEnqueue({ pauseReason: 'QUALIDADE_BAIXA' });
    const rQualidade = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete' });
    expect(rQualidade.reason).toBe('QUALIDADE_BAIXA');
  });

  it('(4) teto diário da company (WA_DAILY_CAP) → LIMITE_DIARIO', async () => {
    process.env.WA_DAILY_CAP = '3';
    mockEnqueue({ dailyCount: 3 });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete' });
    expect(r.reason).toBe('LIMITE_DIARIO');
  });

  it('(5) teto por contato (WA_PER_PHONE_DAILY_CAP) → LIMITE_POR_CONTATO', async () => {
    process.env.WA_PER_PHONE_DAILY_CAP = '1';
    mockEnqueue({ dailyCount: 0, phoneCount: 1 });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete' });
    expect(r.reason).toBe('LIMITE_POR_CONTATO');
  });

  it('(6) item de TESTE ignora template e os tetos automáticos, mas respeita telefone inválido e pausa', async () => {
    // Template "não aprovado" e tetos automáticos estourados — nada disso
    // deveria importar para sourceType 'teste'.
    mockEnqueue({ templateApproved: false, dailyCount: 999, phoneCount: 999 });
    const ok = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete', sourceType: 'teste',
    });
    expect(ok.queued).toBe(true);

    mockEnqueue({ contact: { invalid_at: '2026-09-01T00:00:00Z' } });
    const semTelefone = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete', sourceType: 'teste',
    });
    expect(semTelefone.reason).toBe('TELEFONE_INVALIDO_META');

    mockEnqueue({ pauseReason: 'CONTA_RESTRITA' });
    const pausado = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete', sourceType: 'teste',
    });
    expect(pausado.reason).toBe('PAUSADO');
  });

  it('(6b) teto FIXO de teste (5/dia) → LIMITE_DIARIO, contado só entre itens de teste', async () => {
    mockEnqueue({ testCount: 5 });
    const r = await outbox.enqueue({
      companyId: COMPANY, toPhone: '11988887777', templateName: 'mensalidade_lembrete', sourceType: 'teste',
    });
    expect(r.reason).toBe('LIMITE_DIARIO');
  });
});

// ── (7)(8) processBatch — reforço + erros permanentes ───────
describe('processBatch — reforço (2b) e erros permanentes da Meta (2c)', () => {
  function mockBatch(row, {
    creds = { wa_phone_number_id: 'PN1', wa_access_token: 'TK' },
    contact = null, templateApproved = true, pauseReason = null,
  } = {}) {
    const writes = { updates: [], contactInvalid: [], companyPause: [], clearRegistered: [] };
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- wa:outbox-pick')) return Promise.resolve({ rows: [row] });
      if (s.includes('-- wa:creds')) return Promise.resolve({ rows: creds ? [creds] : [] });
      if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: contact ? [contact] : [] });
      if (s.includes('-- wa:guard-template')) {
        return Promise.resolve({ rows: templateApproved ? [{ status: 'APPROVED' }] : [] });
      }
      if (s.includes('-- wa:guard-paused')) return Promise.resolve({ rows: [{ wa_paused_reason: pauseReason }] });
      if (s.includes('-- wa:contact-invalid')) { writes.contactInvalid.push(params); return Promise.resolve({ rows: [] }); }
      if (s.includes('-- wa:company-pause')) { writes.companyPause.push(params); return Promise.resolve({ rows: [] }); }
      if (s.includes('-- wa:clear-registered')) { writes.clearRegistered.push(params); return Promise.resolve({ rows: [] }); }
      if (/UPDATE wa_outbox/i.test(s)) { writes.updates.push({ s, params }); return Promise.resolve({ rows: [] }); }
      if (/INSERT INTO wa_messages/i.test(s)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    return writes;
  }
  const baseRow = {
    id: 'ob-1', company_id: COMPANY, to_phone: '5511988887777', kind: 'template',
    template_name: 'mensalidade_lembrete', template_language: 'pt_BR',
    components: null, text_body: null, attempts: 0,
  };

  it('(7) reforço: template deixou de estar aprovado entre o enqueue e o despacho → skipped TEMPLATE_NAO_APROVADO', async () => {
    const writes = mockBatch(baseRow, { templateApproved: false });
    const r = await outbox.processBatch(5);
    expect(r.skipped).toBe(1);
    expect(wa.sendTemplate).not.toHaveBeenCalled();
    expect(writes.updates.some((u) => u.params.includes('TEMPLATE_NAO_APROVADO'))).toBe(true);
  });

  it('(7b) reforço: fila pausada entre o enqueue e o despacho → skipped PAUSADO', async () => {
    const writes = mockBatch(baseRow, { pauseReason: 'MANUAL' });
    const r = await outbox.processBatch(5);
    expect(r.skipped).toBe(1);
    expect(writes.updates.some((u) => u.params.includes('PAUSADO'))).toBe(true);
  });

  it('(8) código permanente (132001, template inexistente) → failed na 1ª tentativa, sem retry', async () => {
    const writes = mockBatch(baseRow);
    const erro = new Error('Template name does not exist');
    erro.meta = { code: 132001 };
    wa.sendTemplate.mockRejectedValue(erro);
    const r = await outbox.processBatch(5);
    expect(r.failed).toBe(1);
    expect(r.retried).toBe(0);
    expect(writes.updates.some((u) => u.params.includes('failed'))).toBe(true);
  });

  it('(8b) 131026 (não é WhatsApp) → failed permanente E marca o contato invalid_at', async () => {
    const writes = mockBatch(baseRow);
    const erro = new Error('Not a WhatsApp user');
    erro.meta = { code: 131026 };
    wa.sendTemplate.mockRejectedValue(erro);
    const r = await outbox.processBatch(5);
    expect(r.failed).toBe(1);
    expect(writes.contactInvalid).toHaveLength(1);
    expect(writes.contactInvalid[0][0]).toBe(COMPANY);
  });

  it('(8c) 133010 (número não registrado) → failed permanente E zera wa_registered_at', async () => {
    const writes = mockBatch(baseRow);
    const erro = new Error('Phone number not registered');
    erro.meta = { code: 133010 };
    wa.sendTemplate.mockRejectedValue(erro);
    const r = await outbox.processBatch(5);
    expect(r.failed).toBe(1);
    expect(writes.clearRegistered).toHaveLength(1);
  });

  it('(8d) 131031 (conta restrita) → failed permanente E pausa a company com CONTA_RESTRITA', async () => {
    const writes = mockBatch(baseRow);
    const erro = new Error('Account restricted');
    erro.meta = { code: 131031 };
    wa.sendTemplate.mockRejectedValue(erro);
    const r = await outbox.processBatch(5);
    expect(r.failed).toBe(1);
    expect(writes.companyPause).toHaveLength(1);
    expect(writes.companyPause[0]).toEqual([COMPANY, 'CONTA_RESTRITA']);
  });

  it('(8e) 131042 (pagamento) pausa a company mas NÃO é permanente — segue em retry', async () => {
    const writes = mockBatch(baseRow);
    const erro = new Error('Payment issue');
    erro.meta = { code: 131042 };
    wa.sendTemplate.mockRejectedValue(erro);
    const r = await outbox.processBatch(5);
    expect(r.retried).toBe(1);
    expect(r.failed).toBe(0);
    expect(writes.companyPause).toHaveLength(1);
  });

  it('(8f) erro de REDE (sem err.meta) NUNCA é confundido com permanente — segue em retry/backoff', async () => {
    const writes = mockBatch(baseRow);
    wa.sendTemplate.mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    const r = await outbox.processBatch(5);
    expect(r.retried).toBe(1);
    expect(r.failed).toBe(0);
    expect(writes.contactInvalid).toHaveLength(0);
    expect(writes.companyPause).toHaveLength(0);
  });
});

// ── (9) GET /whatsapp/preview ────────────────────────────────
describe('GET /whatsapp/preview — prévia SEM enfileirar', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id', require('../src/routes/whatsappCloud'));
    return app;
  }

  function mockPreview({ queueRows = [], addonAtivo = true, dailyCount = 0, alreadySentPhones = [] } = {}) {
    const insertsIntoOutbox = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/JOIN karate_dojo_charges c/.test(s)) return Promise.resolve({ rows: queueRows });
      if (s.includes('-- addon:has')) return Promise.resolve({ rows: addonAtivo ? [{ '?column?': 1 }] : [] });
      if (s.includes('-- wa:guard-count-today')) {
        if (params[1] != null) return Promise.resolve({ rows: [{ n: alreadySentPhones.includes(params[1]) ? 1 : 0 }] });
        return Promise.resolve({ rows: [{ n: dailyCount }] });
      }
      if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: [] });
      if (s.includes('-- wa:guard-template')) return Promise.resolve({ rows: [{ status: 'APPROVED' }] });
      if (s.includes('-- wa:guard-paused')) return Promise.resolve({ rows: [{ wa_paused_reason: null }] });
      if (s.includes('-- wa:outbox-enqueue') || /INSERT INTO wa_outbox/i.test(s)) {
        insertsIntoOutbox.push(params);
        return Promise.resolve({ rows: [{ id: 'nao-deveria-existir' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    return insertsIntoOutbox;
  }

  const rowBase = {
    id: 'charge-1', amount: '150.00', competence: '2026-09', due_date: '2026-09-13',
    pix_payload: null, offset_val: 0, student_name: 'Aluno 1', student_phone: '11988887771',
    guardian_name: null, guardian_phone: null, already_sent: false,
  };

  it('(9a) nunca insere na wa_outbox, mesmo com candidatos válidos', async () => {
    const inserts = mockPreview({ queueRows: [rowBase] });
    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/whatsapp/preview`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(0);
    expect(res.body.would_send).toBe(1);
    // items é a lista de PULADOS com o motivo — quem seria enviado não
    // entra aqui (as contagens agregadas já dizem o total).
    expect(res.body.items).toHaveLength(0);
  });

  it('(9b) sem o adicional ativo → todo mundo cai em ADDON_INATIVO, would_send 0', async () => {
    mockPreview({ queueRows: [rowBase, { ...rowBase, id: 'charge-2', student_phone: '11988887772' }], addonAtivo: false });
    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/whatsapp/preview`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body.would_send).toBe(0);
    expect(res.body.skipped.ADDON_INATIVO).toBe(2);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ student_name: 'Aluno 1', reason: 'ADDON_INATIVO' });
    expect(res.body.items[0].phone_masked).toMatch(/^\*\*\*\d{4}$/);
  });

  it('(9c) teto diário já estourado → seguintes caem em LIMITE_DIARIO', async () => {
    process.env.WA_DAILY_CAP = '1';
    mockPreview({ queueRows: [rowBase], dailyCount: 1 }); // já bateu o teto de 1

    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/whatsapp/preview`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.body.would_send).toBe(0);
    expect(res.body.skipped.LIMITE_DIARIO).toBe(1);
  });

  it('(9d) já enviado hoje (already_sent do runner) → JA_ENVIADO, sem chamar as guardas', async () => {
    mockPreview({ queueRows: [{ ...rowBase, already_sent: true }] });
    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/whatsapp/preview`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.body.would_send).toBe(0);
    expect(res.body.skipped.JA_ENVIADO).toBe(1);
  });
});

// ── (10) POST /whatsapp/test-send — 5/dia ───────────────────
describe('POST /whatsapp/test-send — teto fixo de 5 envios de teste por dia', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id', require('../src/routes/whatsappCloud'));
    return app;
  }

  it('(10) 6º envio de teste no dia → 422 LIMITE_DIARIO, nada vai à Meta', async () => {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: [] });
      if (s.includes('-- wa:guard-count-today') && params[2] === 'teste') {
        return Promise.resolve({ rows: [{ n: 5 }] }); // já bateu o teto
      }
      if (s.includes('-- wa:outbox-enqueue')) return Promise.resolve({ rows: [{ id: 'ob-teste', status: 'skipped' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(buildApp())
      .post(`/companies/${COMPANY}/whatsapp/test-send`)
      .set('Authorization', 'Bearer ' + token)
      .send({ to: '11988887777', template_name: 'mensalidade_lembrete' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LIMITE_DIARIO');
    expect(wa.sendTemplate).not.toHaveBeenCalled();
  });
});

// ── (11) webhook: qualidade e conta restrita ────────────────
describe('webhook WhatsApp — qualidade (phone_number_quality_update) e conta (account_update)', () => {
  function buildApp() {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
    return app;
  }
  function sign(body) {
    return 'sha256=' + crypto.createHmac('sha256', 'secret-test-guardas')
      .update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
  }

  it('(11a) FLAGGED → RED + pausa QUALIDADE_BAIXA; UNFLAGGED → GREEN + despausa', async () => {
    const writes = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/wa_waba_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (/UPDATE companies SET wa_quality_rating/.test(s)) writes.push(['quality', params]);
      if (/UPDATE companies SET wa_paused_reason=\$2, wa_paused_at=NOW\(\)/.test(s)) writes.push(['pause', params]);
      if (/wa_paused_reason=NULL/.test(s)) writes.push(['unpause', params]);
      return Promise.resolve({ rows: [] });
    });
    const flagged = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'phone_number_quality_update', value: { event: 'FLAGGED' } }] }],
    };
    const res = await request(buildApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(flagged)).send(flagged);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(writes.some((w) => w[0] === 'quality' && w[1][1] === 'RED')).toBe(true);
    expect(writes.some((w) => w[0] === 'pause' && w[1][1] === 'QUALIDADE_BAIXA')).toBe(true);

    writes.length = 0;
    const unflagged = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'phone_number_quality_update', value: { event: 'UNFLAGGED' } }] }],
    };
    const res2 = await request(buildApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(unflagged)).send(unflagged);
    expect(res2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(writes.some((w) => w[0] === 'quality' && w[1][1] === 'GREEN')).toBe(true);
    expect(writes.some((w) => w[0] === 'unpause')).toBe(true);
  });

  it('(11b) account_update ACCOUNT_RESTRICTION → pausa CONTA_RESTRITA', async () => {
    const writes = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/wa_waba_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (/UPDATE companies SET wa_paused_reason=\$2, wa_paused_at=NOW\(\)/.test(s)) writes.push(params);
      return Promise.resolve({ rows: [] });
    });
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION' } }] }],
    };
    const res = await request(buildApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(writes).toEqual([[COMPANY, 'CONTA_RESTRITA']]);
  });

  it('(11c) 42703 (migração 328 pendente) no update de qualidade não derruba o processamento', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/wa_waba_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (/UPDATE companies SET wa_quality_rating/.test(s)) {
        const e = new Error('column does not exist'); e.code = '42703';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [] });
    });
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'phone_number_quality_update', value: { event: 'FLAGGED' } }] }],
    };
    const res = await request(buildApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30)); // não deve lançar/derrubar nada
  });
});
