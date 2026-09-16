// ============================================================
// AURA — WhatsApp automático é ADICIONAL (company_addons, 328)
//
// Cada mensagem da Cloud API custa dinheiro. O portão do envio
// automático NÃO pode ser o plano: 104 dos 106 dojôs são 'essencial' e
// são justamente o público do adicional de R$39/mês. Quem paga liga o
// toggle; quem não paga segue com a pista manual (wa.me, grátis).
//
// Cobertura:
//  (1) hasAddon: ativo → true; cancelado → false; tabela ausente
//      (42P01, migration pendente no deploy) → false SEM lançar.
//  (2) o cache de 60s poupa a ida ao banco; setAddon invalida.
//  (3) setAddon desativando grava 'cancelled' com ended_at.
//  (4) rotas admin: listar e ligar/desligar o adicional.
//  (2b)(2c)(2d) Fase 8b: Negócio/Expansão (plano) e Aura Dojô/federação
//      (vertical) passaram a INCLUIR o WhatsApp; o Essencial de varejo
//      continua dependendo do adicional.
//  (5) régua do dojô com send_whatsapp_auto=true, sem adicional e sem
//      produto que inclua → 403 ADDON_REQUIRED, e o banco de
//      configuração nem é tocado.
//  (5b) o MESMO cenário com a vertical de dojô → 200: o Aura Dojô já
//      inclui o WhatsApp e não cobra os R$39 por cima.
//  (6) com adicional mas sem número conectado → 409 NAO_CONECTADO.
//  (7) com adicional e conectado → 200 (salva).
//  (8) DESLIGAR nunca é barrado (sem adicional, send_whatsapp_auto
//      false salva normalmente).
//  (9) o job noturno pula o dojô sem adicional — o toggle pode ter
//      ficado ligado de quando o adicional existia.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const addons = require('../src/services/addons');

const SECRET = 'aura-test-secret-2026';
const FED_ID = 'fed-uuid-addon';
const DOJO_ID = 'dojo-uuid-addon';

const dojoToken = jwt.sign(
  { type: 'access', id: 'user-sensei', role: 'owner', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET, { expiresIn: '1h' }
);
const adminToken = jwt.sign(
  { id: 'user-staff', role: 'admin', plan: 'expansao' },
  SECRET, { expiresIn: '1h' }
);

function buildDojoApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateDojoBilling'));
  return app;
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', require('../src/routes/adminAddons'));
  return app;
}

// Estado do "banco" por âncora de SQL. `addonAtivo` decide o adicional;
// `plano`/`vertical` decidem o que o PRODUTO já inclui (Fase 8b);
// `conectado` decide a credencial do WhatsApp (039/309).
//
// O default é a empresa mais restrita que existe hoje: varejo no
// 'essencial', sem vertical de karatê e sem adicional. Quem quiser o
// caso liberado diz isso no teste.
function mockBanco({
  addonAtivo = false, conectado = true, tokenExpirado = false,
  plano = 'essencial', vertical = null,
} = {}) {
  const visto = { configSalva: null, addonHas: 0, planLookups: 0 };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('-- addon:has')) {
      visto.addonHas++;
      return Promise.resolve({ rows: addonAtivo ? [{ '?column?': 1 }] : [] });
    }
    if (s.includes('-- addon:plan')) {
      visto.planLookups++;
      return Promise.resolve({ rows: [{ plan: plano, vertical_active: vertical, vertical }] });
    }
    if (s.includes('-- wa:conn-state-flag')) {
      return Promise.resolve({ rows: [{ wa_token_invalid_at: tokenExpirado ? '2026-09-10T00:00:00Z' : null }] });
    }
    if (s.includes('-- wa:conn-state')) {
      return Promise.resolve({ rows: [conectado
        ? { wa_phone_number_id: 'PN1', has_token: true }
        : { wa_phone_number_id: null, has_token: false }] });
    }
    if (/INSERT INTO karate_dojo_reminder_config/.test(s)) {
      visto.configSalva = params;
      return Promise.resolve({ rows: [{
        enabled: true, offsets: [-3, 0], send_email: true,
        send_whatsapp_auto: params[4], updated_at: '2026-09-13T12:00:00.000Z',
      }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return visto;
}

const BODY_LIGADO = { enabled: true, offsets: [-3, 0], send_email: true, send_whatsapp_auto: true };

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  addons.clearCache();
});

// ── (1)(2)(3) serviço ───────────────────────────────────────
describe('serviço de adicionais', () => {
  it('(1) ativo → true; tabela ausente (42P01) → false, sem lançar', async () => {
    mockBanco({ addonAtivo: true });
    await expect(addons.hasAddon('c-1', addons.ADDON_WHATSAPP_AUTO)).resolves.toBe(true);

    addons.clearCache();
    db.query.mockImplementation(() => {
      const e = new Error('relation "company_addons" does not exist'); e.code = '42P01';
      return Promise.reject(e);
    });
    await expect(addons.hasAddon('c-2', addons.ADDON_WHATSAPP_AUTO)).resolves.toBe(false);
    await expect(addons.listAddons('c-2')).resolves.toEqual([]);
  });

  it('(2) o cache poupa a segunda ida ao banco; setAddon invalida', async () => {
    const visto = mockBanco({ addonAtivo: true });
    await addons.hasAddon('c-3', addons.ADDON_WHATSAPP_AUTO);
    await addons.hasAddon('c-3', addons.ADDON_WHATSAPP_AUTO);
    expect(visto.addonHas).toBe(1);

    await addons.setAddon('c-3', addons.ADDON_WHATSAPP_AUTO, { active: false });
    await addons.hasAddon('c-3', addons.ADDON_WHATSAPP_AUTO);
    expect(visto.addonHas).toBe(2); // o cache foi invalidado pela mudança
  });

  // ── Fase 8b: o produto passou a incluir o WhatsApp ────────
  // O adicional de R$39 deixou de ser o único caminho. Negócio e
  // Expansão já valiam pelo plano; o Aura Dojô vale pela VERTICAL,
  // porque no banco o dojô continua marcado como 'essencial' e gatear
  // só por plano barraria justamente quem paga R$140 pelo produto que
  // promete o WhatsApp incluso.
  it('(2b) plano/vertical que INCLUEM o WhatsApp liberam sem adicional nenhum', async () => {
    const casos = [
      { plano: 'negocio', vertical: null },
      { plano: 'expansao', vertical: null },
      { plano: 'essencial', vertical: 'karate_dojo' },
      { plano: 'essencial', vertical: 'karate_federation' },
    ];
    let i = 0;
    for (const caso of casos) {
      addons.clearCache();
      mockBanco({ addonAtivo: false, ...caso });
      await expect(addons.canAutoWhatsapp(`c-inc-${i++}`)).resolves.toBe(true);
    }
  });

  it('(2c) Essencial de VAREJO sem adicional continua barrado — e o adicional continua liberando', async () => {
    addons.clearCache();
    mockBanco({ addonAtivo: false, plano: 'essencial', vertical: null });
    await expect(addons.canAutoWhatsapp('c-varejo')).resolves.toBe(false);

    addons.clearCache();
    mockBanco({ addonAtivo: true, plano: 'essencial', vertical: null });
    await expect(addons.canAutoWhatsapp('c-varejo-2')).resolves.toBe(true);
  });

  it('(2d) coluna de vertical ausente (42703) cai no gate só de plano, sem 500', async () => {
    addons.clearCache();
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('-- addon:has')) return Promise.resolve({ rows: [] });
      if (s.includes('-- addon:plan-legado')) return Promise.resolve({ rows: [{ plan: 'negocio' }] });
      if (s.includes('-- addon:plan')) {
        const e = new Error('column "vertical" does not exist'); e.code = '42703';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [] });
    });
    await expect(addons.canAutoWhatsapp('c-legado')).resolves.toBe(true);
  });

  it('(3) desativar grava cancelled + ended_at', async () => {
    let params = null;
    db.query.mockImplementation((sql, p) => {
      if (String(sql).includes('-- addon:set')) {
        params = p;
        return Promise.resolve({ rows: [{ addon_key: 'whatsapp_auto', status: 'cancelled', ended_at: 'agora' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const row = await addons.setAddon('c-4', addons.ADDON_WHATSAPP_AUTO, { active: false, source: 'admin' });
    expect(params[2]).toBe('cancelled');
    expect(row.status).toBe('cancelled');
  });
});

// ── (4) rotas admin ─────────────────────────────────────────
describe('rotas admin de adicionais', () => {
  it('(4) lista e liga o adicional da empresa', async () => {
    let setParams = null;
    db.query.mockImplementation((sql, p) => {
      const s = String(sql);
      if (s.includes('-- addon:list')) {
        return Promise.resolve({ rows: [{ addon_key: 'whatsapp_auto', status: 'active', price_cents: 3900 }] });
      }
      if (s.includes('-- addon:set')) {
        setParams = p;
        return Promise.resolve({ rows: [{ addon_key: 'whatsapp_auto', status: 'active', price_cents: 3900, source: 'admin' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const app = buildAdminApp();

    const lista = await request(app)
      .get(`/admin/clients/${DOJO_ID}/addons`).set('Authorization', 'Bearer ' + adminToken);
    expect(lista.status).toBe(200);
    expect(lista.body.data).toHaveLength(1);

    const put = await request(app)
      .put(`/admin/clients/${DOJO_ID}/addons/whatsapp_auto`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ active: true, notes: 'contratou no telefone' });
    expect(put.status).toBe(200);
    expect(put.body.status).toBe('active');
    expect(setParams[2]).toBe('active');
    expect(setParams[4]).toBe('admin'); // origem fica registrada
  });

  it('(4b) sem `active` no corpo → 422; sem papel de admin → 403', async () => {
    mockBanco();
    const app = buildAdminApp();
    const semCampo = await request(app)
      .put(`/admin/clients/${DOJO_ID}/addons/whatsapp_auto`)
      .set('Authorization', 'Bearer ' + adminToken).send({});
    expect(semCampo.status).toBe(422);

    const semPapel = jwt.sign({ id: 'u', role: 'owner' }, SECRET, { expiresIn: '1h' });
    const proibido = await request(app)
      .get(`/admin/clients/${DOJO_ID}/addons`).set('Authorization', 'Bearer ' + semPapel);
    expect(proibido.status).toBe(403);
  });
});

// ── (5)-(8) gate na régua do dojô ───────────────────────────
describe('PUT reminder-config — gate do adicional', () => {
  it('(5) empresa no essencial sem adicional e sem vertical de karatê → 403 ADDON_REQUIRED, sem tocar a configuração', async () => {
    // O portão continua existindo depois da Fase 8b: quem não está num
    // produto que inclui o WhatsApp e não contratou o adicional não liga
    // o envio automático. O que mudou foi QUEM cai aqui — ver (5b).
    const visto = mockBanco({ addonAtivo: false, plano: 'essencial', vertical: null });
    const res = await request(buildDojoApp())
      .put(`/federation/${FED_ID}/dojo/billing/reminder-config`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(BODY_LIGADO);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADDON_REQUIRED');
    expect(res.body.error).toMatch(/adicional do plano/i);
    expect(visto.configSalva).toBeNull();
  });

  it('(5b) dojô no essencial liga a régua SEM adicional — o Aura Dojô já inclui o WhatsApp', async () => {
    // A mudança comercial da Fase 8b em uma asserção: até 14/09/2026
    // este mesmo cenário devolvia 403 e cobrava R$39 por cima dos R$140
    // do Aura Dojô.
    const visto = mockBanco({ addonAtivo: false, plano: 'essencial', vertical: 'karate_dojo', conectado: true });
    const res = await request(buildDojoApp())
      .put(`/federation/${FED_ID}/dojo/billing/reminder-config`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(BODY_LIGADO);
    expect(res.status).toBe(200);
    expect(res.body.send_whatsapp_auto).toBe(true);
    expect(visto.configSalva[4]).toBe(true);
    expect(visto.addonHas).toBe(1);   // perguntou pelo adicional…
    expect(visto.planLookups).toBe(1); // …e liberou pelo produto
  });

  it('(6) com adicional mas sem número conectado → 409 NAO_CONECTADO', async () => {
    const visto = mockBanco({ addonAtivo: true, conectado: false });
    const res = await request(buildDojoApp())
      .put(`/federation/${FED_ID}/dojo/billing/reminder-config`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(BODY_LIGADO);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAO_CONECTADO');
    expect(visto.configSalva).toBeNull();
  });

  it('(6b) adicional ok, número conectado, mas token recusado → 409 pedindo reconectar', async () => {
    mockBanco({ addonAtivo: true, conectado: true, tokenExpirado: true });
    const res = await request(buildDojoApp())
      .put(`/federation/${FED_ID}/dojo/billing/reminder-config`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(BODY_LIGADO);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAO_CONECTADO');
    expect(res.body.error).toMatch(/Reconecte/i);
  });

  it('(7) com adicional e conectado → 200 e salva', async () => {
    const visto = mockBanco({ addonAtivo: true, conectado: true });
    const res = await request(buildDojoApp())
      .put(`/federation/${FED_ID}/dojo/billing/reminder-config`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(BODY_LIGADO);
    expect(res.status).toBe(200);
    expect(res.body.send_whatsapp_auto).toBe(true);
    expect(visto.configSalva[4]).toBe(true);
  });

  it('(8) DESLIGAR não exige adicional nenhum', async () => {
    const visto = mockBanco({ addonAtivo: false, conectado: false });
    const res = await request(buildDojoApp())
      .put(`/federation/${FED_ID}/dojo/billing/reminder-config`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send({ enabled: true, offsets: [-3, 0], send_email: true, send_whatsapp_auto: false });
    expect(res.status).toBe(200);
    expect(visto.configSalva[4]).toBe(false);
    expect(visto.addonHas).toBe(0); // nem perguntou pelo adicional
  });
});

// ── (9) job noturno ─────────────────────────────────────────
describe('runAll do motor da régua', () => {
  it('(9) dojô com o toggle ligado e sem adicional é pulado, sem enfileirar nada', async () => {
    let enfileirou = false;
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('-- addon:has')) return Promise.resolve({ rows: [] });
      if (/FROM karate_dojo_reminder_config/.test(s)) {
        return Promise.resolve({ rows: [{
          dojo_id: DOJO_ID, offsets: [-3], send_email: false, send_whatsapp_auto: true,
        }] });
      }
      if (s.includes('-- wa:outbox-enqueue')) { enfileirou = true; return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    const engine = require('../src/services/karateDojoReminderEngine');
    const agg = await engine.runAll('2026-09-13');
    expect(agg.wa_sem_addon).toBe(1);
    expect(agg.wa_enqueued).toBe(0);
    expect(enfileirou).toBe(false);
  });
});
