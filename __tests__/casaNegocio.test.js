// ============================================================
// AURA. — Casa no Negocio por empresa (p-189, 17/11/2026)
//
//   1. ligar: vertical_active sai, a casa liga, a data original e gravada,
//      studio_enabled NUNCA muda, audit log
//   2. desligar: volta vertical_active = 'studio' com a data de antes;
//      ida e volta repetidas sao reversiveis e nao trocam a data
//   3. quando nao da (motivos)
//   4. rota da equipe: portoes (role admin + is_staff do banco), corpo,
//      transacao
//   5. frente studio: caminho novo atras de FRENTE_STUDIO_NO_NEGOCIO e
//      empresa com a casa ligada nao volta ao Studio pela frente nem pela
//      vertical
//   6. /auth/me: casa_negocio so aparece quando ligada
//
// O SQL de verdade: __tests__/casaNegocio.banco.test.js (Postgres no CI).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const casa = require('../src/services/casaNegocio');
const { applySegment } = require('../src/services/segment');
const { fakeCasaDb } = require('../tests/helpers/fakeCasaDb');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

const CID = '133ec696-0000-4000-8000-000000000001';
const STAFF = '9f1b2c3d-0000-4000-8000-0000000000aa';
const STUDIO_DESDE = '2026-05-22T13:00:00.000Z';

function sheidLike(extra = {}) {
  return {
    [CID]: {
      plan: 'negocio',
      vertical_active: 'studio',
      vertical_enabled_at: new Date(STUDIO_DESDE),
      created_at: new Date('2026-05-22T10:00:00.000Z'),
      pdv_settings: { studio_enabled: true, caixa_enabled: true, label_size: '30x25' },
      studio_settings: { default_sla_days: 3 },
      ...extra,
    },
  };
}

const semData = (ps) => {
  const { personalizados_ativado_em, ...resto } = ps || {};
  return resto;
};

// Nenhuma escrita do servico menciona studio_enabled nem regrava pdv_settings
// inteiro. A unica escrita em pdv_settings e a da data (guardada).
function escritasEmPdvSettings(calls) {
  return calls.filter((c) => /^\s*UPDATE/.test(c.text) && /pdv_settings\s*=/.test(c.text));
}

describe('1. ligar a casa', () => {
  test('tira a vertical, liga a casa e grava a data original sem tocar studio_enabled', async () => {
    const fake = fakeCasaDb({ companies: sheidLike(), primeiroPedido: { [CID]: new Date('2026-06-15T12:00:00.000Z') } });
    const antes = JSON.parse(JSON.stringify(fake.state.companies[CID].pdv_settings));
    const agora = new Date('2026-12-01T12:00:00.000Z');

    const out = await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF, agora });

    const c = fake.state.companies[CID];
    expect(out.changed).toBe(true);
    expect(c.vertical_active).toBeNull();
    expect(c.vertical_enabled_at).toBeNull();
    expect(c.studio_settings).toEqual({
      default_sla_days: 3,
      casa_negocio: true,
      casa_negocio_em: agora.toISOString(),
      casa_negocio_studio_desde: STUDIO_DESDE,
    });
    // studio_enabled e o resto do pdv_settings: iguais.
    expect(c.pdv_settings.studio_enabled).toBe(true);
    expect(semData(c.pdv_settings)).toEqual(antes);
    // data original: a mais antiga entre a empresa e o primeiro pedido.
    expect(c.pdv_settings.personalizados_ativado_em).toBe('2026-05-22T10:00:00.000Z');
    expect(out.data_original).toEqual({ gravada: true, motivo: 'empresa', data: '2026-05-22T10:00:00.000Z' });
    expect(out.estado).toMatchObject({
      casa_negocio: true, vertical_active: null, studio_enabled: true,
      personalizados_ativado_em: '2026-05-22T10:00:00.000Z', pode_ligar: false, pode_desligar: true,
    });
    // so a data escreve em pdv_settings, e com guarda
    const escritas = escritasEmPdvSettings(fake.calls);
    expect(escritas).toHaveLength(1);
    expect(escritas[0].text.split('WHERE')[0]).not.toMatch(/studio_enabled/);
    expect(escritas[0].text).toMatch(/personalizados_ativado_em/);
    // audit
    expect(fake.state.audit).toEqual([{
      staff_user_id: STAFF,
      action: 'casa_negocio_on',
      company_id: CID,
      payload: {
        from: { vertical_active: 'studio', casa_negocio: false },
        to: { vertical_active: null, casa_negocio: true },
        studio_enabled: true,
        studio_desde: STUDIO_DESDE,
        data_original: { gravada: true, motivo: 'empresa', data: '2026-05-22T10:00:00.000Z' },
      },
    }]);
  });

  test('a data grava ANTES de tirar a vertical (a funcao so grava com a frente ligada)', async () => {
    const fake = fakeCasaDb({ companies: sheidLike({ pdv_settings: { studio_enabled: true } }) });
    await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF });
    const ordem = fake.calls.map((c) => c.text);
    const iData = ordem.findIndex((t) => /jsonb_build_object\('personalizados_ativado_em', \$2::text\)/.test(t));
    const iVertical = ordem.findIndex((t) => /SET vertical_active = NULL,/.test(t));
    expect(iData).toBeGreaterThan(-1);
    expect(iData).toBeLessThan(iVertical);
  });

  test('data ja gravada: fica a que estava', async () => {
    const fake = fakeCasaDb({ companies: sheidLike({ pdv_settings: { studio_enabled: true, personalizados_ativado_em: '2026-01-01T00:00:00.000Z' } }) });
    const out = await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF });
    expect(out.data_original).toMatchObject({ gravada: false, motivo: 'ja_tem_data' });
    expect(fake.state.companies[CID].pdv_settings.personalizados_ativado_em).toBe('2026-01-01T00:00:00.000Z');
  });

  test('ligar de novo: nada muda e nada vai ao audit', async () => {
    const fake = fakeCasaDb({ companies: sheidLike() });
    await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF });
    const antes = JSON.parse(JSON.stringify(fake.state.companies[CID]));
    const out = await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF });
    expect(out.changed).toBe(false);
    expect(JSON.parse(JSON.stringify(fake.state.companies[CID]))).toEqual(antes);
    expect(fake.state.audit).toHaveLength(1);
  });
});

describe('2. desligar a casa (a volta)', () => {
  test('volta vertical_active = studio com a data de antes; studio_enabled e a data ficam', async () => {
    const fake = fakeCasaDb({ companies: sheidLike() });
    await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF });
    const ps = JSON.parse(JSON.stringify(fake.state.companies[CID].pdv_settings));
    const agora = new Date('2026-12-02T12:00:00.000Z');

    const out = await casa.desligarCasa(fake.client, CID, { staffUserId: STAFF, agora });

    const c = fake.state.companies[CID];
    expect(out.changed).toBe(true);
    expect(c.vertical_active).toBe('studio');
    expect(new Date(c.vertical_enabled_at).toISOString()).toBe(STUDIO_DESDE);
    expect(c.studio_settings.casa_negocio).toBe(false);
    expect(c.studio_settings.default_sla_days).toBe(3);
    expect(c.pdv_settings).toEqual(ps);
    expect(out.estado).toMatchObject({ casa_negocio: false, vertical_active: 'studio', studio_enabled: true, pode_ligar: true });
    expect(fake.state.audit.map((a) => a.action)).toEqual(['casa_negocio_on', 'casa_negocio_off']);
    expect(fake.state.audit[1].payload).toEqual({
      from: { vertical_active: null, casa_negocio: true },
      to: { vertical_active: 'studio', casa_negocio: false },
      studio_enabled: true,
    });
    // desligar nunca escreve em pdv_settings
    expect(escritasEmPdvSettings(fake.calls)).toHaveLength(1);
  });

  test('ida e volta 3 vezes: mesmo estado; a data e a primeira; studio_enabled nunca muda', async () => {
    const fake = fakeCasaDb({ companies: sheidLike() });
    const original = JSON.parse(JSON.stringify(fake.state.companies[CID]));
    let primeiraData = null;
    for (let i = 0; i < 3; i += 1) {
      await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF });
      const c = fake.state.companies[CID];
      expect(c.vertical_active).toBeNull();
      expect(c.pdv_settings.studio_enabled).toBe(true);
      primeiraData = primeiraData || c.pdv_settings.personalizados_ativado_em;
      expect(c.pdv_settings.personalizados_ativado_em).toBe(primeiraData);

      await casa.desligarCasa(fake.client, CID, { staffUserId: STAFF });
      const d = fake.state.companies[CID];
      expect(d.vertical_active).toBe('studio');
      expect(d.pdv_settings.studio_enabled).toBe(true);
      expect(semData(d.pdv_settings)).toEqual(original.pdv_settings);
      expect(new Date(d.vertical_enabled_at).toISOString()).toBe(STUDIO_DESDE);
    }
    expect(fake.state.audit).toHaveLength(6);
  });

  test('desligar com a casa desligada: nada muda', async () => {
    const fake = fakeCasaDb({ companies: sheidLike() });
    const out = await casa.desligarCasa(fake.client, CID, { staffUserId: STAFF });
    expect(out.changed).toBe(false);
    expect(fake.state.companies[CID].vertical_active).toBe('studio');
    expect(fake.state.audit).toHaveLength(0);
  });
});

describe('3. quando nao da', () => {
  test.each([
    ['empresa sem vertical Studio', { vertical_active: null }, 409, 'CASA_NAO_ESTA_NO_STUDIO'],
    ['outra vertical', { vertical_active: 'food' }, 409, 'CASA_NAO_ESTA_NO_STUDIO'],
    ['studio_enabled desligado', { pdv_settings: { studio_enabled: false } }, 409, 'CASA_STUDIO_DESLIGADO'],
    ['plano essencial', { plan: 'essencial' }, 409, 'CASA_PLANO'],
  ])('ligar: %s', async (_n, extra, status, code) => {
    const fake = fakeCasaDb({ companies: sheidLike(extra) });
    const antes = JSON.parse(JSON.stringify(fake.state.companies[CID]));
    await expect(casa.ligarCasa(fake.client, CID, { staffUserId: STAFF })).rejects.toMatchObject({ statusCode: status, code });
    expect(JSON.parse(JSON.stringify(fake.state.companies[CID]))).toEqual(antes);
    expect(fake.state.audit).toHaveLength(0);
  });

  test('empresa que nao existe: 404', async () => {
    const fake = fakeCasaDb({ companies: {} });
    await expect(casa.ligarCasa(fake.client, CID)).rejects.toMatchObject({ statusCode: 404, code: 'CASA_EMPRESA_NAO_ENCONTRADA' });
    await expect(casa.desligarCasa(fake.client, CID)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('desligar com outra vertical gravada depois: 409 e nada muda', async () => {
    const fake = fakeCasaDb({ companies: sheidLike() });
    await casa.ligarCasa(fake.client, CID, { staffUserId: STAFF });
    fake.state.companies[CID].vertical_active = 'odonto';
    await expect(casa.desligarCasa(fake.client, CID)).rejects.toMatchObject({ statusCode: 409, code: 'CASA_OUTRA_VERTICAL' });
    expect(fake.state.companies[CID].vertical_active).toBe('odonto');
    expect(fake.state.companies[CID].studio_settings.casa_negocio).toBe(true);
  });

  test('estadoDaCasa diz o motivo para a tela da equipe', () => {
    expect(casa.estadoDaCasa({ id: CID, plan: 'negocio', vertical_active: null, pdv_settings: { studio_enabled: true }, studio_settings: {} }))
      .toMatchObject({ pode_ligar: false, motivo_ligar: 'nao_esta_no_studio', pode_desligar: false, motivo_desligar: 'ja_desligada' });
  });
});

// ── 4. rota ──────────────────────────────────────────────────────
describe('4. rota /admin/clients/:cid/casa-negocio', () => {
  const tokenDe = (payload) => 'Bearer ' + jwt.sign(payload, 'aura-test-secret-2026', { expiresIn: '1h' });
  const ADMIN = tokenDe({ id: STAFF, role: 'admin' });

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/admin', require('../src/routes/adminCasaNegocio'));
    // eslint-disable-next-line no-unused-vars
    a.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
    return a;
  }

  let fake;
  function montar({ isStaff = true, companies = sheidLike() } = {}) {
    fake = fakeCasaDb({ companies });
    db.query.mockImplementation(async (sql, params) => {
      if (/SELECT is_staff FROM users/.test(sql)) return { rows: [{ is_staff: isStaff }] };
      return fake.client.query(sql, params);
    });
    db.connect.mockImplementation(async () => fake.client);
  }
  afterEach(() => { db.query.mockReset(); db.connect.mockReset(); });

  test('sem login: 401; role de cliente: 403; admin sem is_staff no banco: 403', async () => {
    montar({ isStaff: false });
    expect((await request(app()).get(`/admin/clients/${CID}/casa-negocio`)).status).toBe(401);
    const cliente = tokenDe({ id: STAFF, role: 'client' });
    expect((await request(app()).patch(`/admin/clients/${CID}/casa-negocio`).set('Authorization', cliente).send({ ligada: true })).status).toBe(403);
    const r = await request(app()).patch(`/admin/clients/${CID}/casa-negocio`).set('Authorization', ADMIN).send({ ligada: true });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('STAFF_ONLY');
    expect(fake.state.companies[CID].vertical_active).toBe('studio');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('corpo e id invalidos: 400 sem abrir transacao', async () => {
    montar();
    for (const body of [{}, { ligada: 'true' }, { ligada: 1 }]) {
      const r = await request(app()).patch(`/admin/clients/${CID}/casa-negocio`).set('Authorization', ADMIN).send(body);
      expect(r.status).toBe(400);
    }
    expect((await request(app()).patch('/admin/clients/nao-e-uuid/casa-negocio').set('Authorization', ADMIN).send({ ligada: true })).status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('GET mostra o estado; PATCH liga e desliga numa transacao', async () => {
    montar();
    const g = await request(app()).get(`/admin/clients/${CID}/casa-negocio`).set('Authorization', ADMIN);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ company_id: CID, casa_negocio: false, vertical_active: 'studio', studio_enabled: true, pode_ligar: true });

    const desde = fake.calls.length;
    const on = await request(app()).patch(`/admin/clients/${CID}/casa-negocio`).set('Authorization', ADMIN).send({ ligada: true });
    expect(on.status).toBe(200);
    expect(on.body.changed).toBe(true);
    expect(on.body.estado).toMatchObject({ casa_negocio: true, vertical_active: null, studio_enabled: true });
    const textos = fake.calls.slice(desde).map((c) => c.text.trim());
    expect(textos[0]).toBe('BEGIN');
    expect(textos[textos.length - 1]).toBe('COMMIT');
    expect(fake.state.audit[0]).toMatchObject({ action: 'casa_negocio_on', staff_user_id: STAFF, company_id: CID });

    const off = await request(app()).patch(`/admin/clients/${CID}/casa-negocio`).set('Authorization', ADMIN).send({ ligada: false });
    expect(off.status).toBe(200);
    expect(off.body.estado).toMatchObject({ casa_negocio: false, vertical_active: 'studio', studio_enabled: true });
    expect(fake.client.release).toHaveBeenCalledTimes(2);
  });

  test('recusa vira 409 com o codigo e ROLLBACK', async () => {
    montar({ companies: sheidLike({ vertical_active: null }) });
    const r = await request(app()).patch(`/admin/clients/${CID}/casa-negocio`).set('Authorization', ADMIN).send({ ligada: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CASA_NAO_ESTA_NO_STUDIO');
    expect(fake.calls.map((c) => c.text.trim())).toContain('ROLLBACK');
    expect(fake.state.audit).toHaveLength(0);
  });
});

// ── 5. frente studio ─────────────────────────────────────────────
describe('5. frente studio: caminho novo e casa ligada', () => {
  const VARIAVEL = 'FRENTE_STUDIO_NO_NEGOCIO';
  const C = 'c1';
  let antes;
  beforeEach(() => { antes = process.env[VARIAVEL]; });
  afterEach(() => { if (antes === undefined) delete process.env[VARIAVEL]; else process.env[VARIAVEL] = antes; });

  test('variavel ligada: cadastro studio liga so o modulo (sem vertical), com a data', async () => {
    process.env[VARIAVEL] = 'true';
    const fake = fakeSegmentDb({ companies: { [C]: { plan: 'negocio' } } });
    const out = await applySegment(fake.client, C, { segment: 'studio', source: 'cnae' });
    const c = fake.state.companies[C];
    expect(c.vertical_active).toBeNull();
    expect(c.pdv_settings.studio_enabled).toBe(true);
    expect(typeof c.pdv_settings.personalizados_ativado_em).toBe('string');
    expect(c.segment).toBe('studio');
    expect(out).toMatchObject({ vertical_active: null, flags: { studio_enabled: true } });
    expect(fake.writesTo(/SET vertical_active/)).toHaveLength(0);
  });

  test('variavel ligada: Essencial continua recusado; quem ja esta no Studio fica la', async () => {
    process.env[VARIAVEL] = ' TRUE ';
    const ess = fakeSegmentDb({ companies: { [C]: { plan: 'essencial' } } });
    await expect(applySegment(ess.client, C, { segment: 'studio' })).rejects.toMatchObject({ statusCode: 409, code: 'STUDIO_PLAN_REQUIRED' });
    const leg = fakeSegmentDb({ companies: { [C]: { plan: 'negocio', vertical_active: 'studio', pdv_settings: { studio_enabled: true } } } });
    await applySegment(leg.client, C, { segment: 'studio', source: 'staff' });
    expect(leg.state.companies[C].vertical_active).toBe('studio');
    expect(leg.writesTo(/SET vertical_active/)).toHaveLength(0);
  });

  test('variavel ligada: outras frentes iguais ao caminho de hoje', async () => {
    process.env[VARIAVEL] = 'true';
    const fake = fakeSegmentDb({ companies: { [C]: {} } });
    await applySegment(fake.client, C, { segment: 'matcon' });
    expect(fake.state.companies[C].pdv_settings).toEqual({ matcon_enabled: true });
  });

  test('casa ligada (sem a variavel): a equipe ou o cliente escolhendo studio nao recria a vertical', async () => {
    delete process.env[VARIAVEL];
    for (const opts of [{ source: 'staff' }, { source: 'user', replacePrevious: true }]) {
      const fake = fakeSegmentDb({ companies: { [C]: { plan: 'negocio', vertical_active: null, pdv_settings: { studio_enabled: true } } } });
      const query = fake.client.query;
      fake.client.query = jest.fn(async (sql, params) => (/AS ligada/.test(sql) ? { rows: [{ ligada: true }] } : query(sql, params)));
      await applySegment(fake.client, C, { segment: 'studio', ...opts });
      expect(fake.state.companies[C].vertical_active).toBeNull();
      expect(fake.state.companies[C].pdv_settings.studio_enabled).toBe(true);
    }
  });

  test('casa desligada (sem a variavel): a equipe escolhendo studio segue o caminho de hoje', async () => {
    delete process.env[VARIAVEL];
    const fake = fakeSegmentDb({ companies: { [C]: { plan: 'negocio' } } });
    const query = fake.client.query;
    fake.client.query = jest.fn(async (sql, params) => (/AS ligada/.test(sql) ? { rows: [{ ligada: false }] } : query(sql, params)));
    await applySegment(fake.client, C, { segment: 'studio', source: 'staff' });
    expect(fake.state.companies[C].vertical_active).toBe('studio');
  });

  test('PATCH /admin/clients/:cid/vertical studio com a casa ligada: 409 CASA_LIGADA', async () => {
    const a = express();
    a.use(express.json());
    a.use('/admin', require('../src/routes/adminVertical'));
    db.query.mockImplementation(async (sql) => {
      if (/AS ligada/.test(sql)) return { rows: [{ ligada: true }] };
      if (/^\s*SELECT/.test(sql)) return { rows: [{ id: CID, plan: 'negocio', vertical_active: null, pdv_settings: { studio_enabled: true } }] };
      throw new Error('nao devia escrever: ' + sql);
    });
    const r = await request(a).patch(`/admin/clients/${CID}/vertical`)
      .set('Authorization', 'Bearer ' + jwt.sign({ id: STAFF, role: 'admin' }, 'aura-test-secret-2026'))
      .send({ vertical: 'studio' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CASA_LIGADA');
    db.query.mockReset();
  });
});
