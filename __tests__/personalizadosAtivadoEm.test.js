// ============================================================
// AURA. — pdv_settings.personalizados_ativado_em (p-172, 17/11/2026)
//
// A Fila de producao do Negocio (aura-app#1271) corta a venda antiga do
// Caixa pela data em que a frente Personalizados foi ligada. Estes testes
// seguram:
//   1. regras puras (services/personalizadosAtivacao.js);
//   2. a vertical Studio ligada pela primeira vez grava a data; ja ligada,
//      nao grava; data existente nunca muda (setCompanyVertical e
//      applySegment, banco falso);
//   3. PUT /pdv-settings: a chave e somente leitura (corpo ignorado, banco
//      preservado) e o PUT que liga a frente grava a hora;
//   4. a funcao da migracao (data original do Studio), sem rodar em ninguem.
// O SQL de verdade (guardas no Postgres) esta em
// personalizadosAtivadoEm.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const router = require('../src/routes/pdvSettings');
const ativacao = require('../src/services/personalizadosAtivacao');
const { applySegment, setCompanyVertical } = require('../src/services/segment');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

const C = '18b5b708-0000-4000-8000-000000000172';
const CHAVE = 'personalizados_ativado_em';
const AGORA = new Date('2026-11-17T13:00:00.000Z');
const ANTIGA = '2026-05-22T12:00:00.000Z';

describe('regras puras', () => {
  test('dataValida aceita so texto que o Date entende', () => {
    expect(ativacao.dataValida(ANTIGA)).toBe(ANTIGA);
    expect(ativacao.dataValida('ontem')).toBeNull();
    expect(ativacao.dataValida('')).toBeNull();
    expect(ativacao.dataValida(null)).toBeNull();
    expect(ativacao.dataValida(true)).toBeNull();
    expect(ativacao.dataValida(1731848400000)).toBeNull();
  });

  test('temValorGravado: qualquer valor nao vazio conta (nunca trocar o que esta no banco)', () => {
    expect(ativacao.temValorGravado(ANTIGA)).toBe(true);
    expect(ativacao.temValorGravado('ontem')).toBe(true);
    expect(ativacao.temValorGravado(undefined)).toBe(false);
    expect(ativacao.temValorGravado(null)).toBe(false);
    expect(ativacao.temValorGravado('')).toBe(false);
  });

  test('frenteLigada: studio_enabled true ou vertical Studio', () => {
    expect(ativacao.frenteLigada({ studio_enabled: true }, null)).toBe(true);
    expect(ativacao.frenteLigada({ studio_enabled: false }, 'studio')).toBe(true);
    expect(ativacao.frenteLigada(null, 'studio')).toBe(true);
    expect(ativacao.frenteLigada({ studio_enabled: 'true' }, null)).toBe(false);
    expect(ativacao.frenteLigada({}, 'food')).toBe(false);
    expect(ativacao.frenteLigada(null, null)).toBe(false);
  });

  test('marcaDaAtivacao: so na transicao de desligada para ligada', () => {
    const m = (antes, verticalAntes, ligadaDepois) =>
      ativacao.marcaDaAtivacao({ antes, verticalAntes, ligadaDepois, agora: AGORA });
    expect(m({}, null, true)).toBe(AGORA.toISOString());
    expect(m(null, null, true)).toBe(AGORA.toISOString());
    expect(m({ studio_enabled: false }, null, true)).toBe(AGORA.toISOString());
    // ja ligada antes: sem data (vem pela migracao)
    expect(m({ studio_enabled: true }, null, true)).toBeNull();
    expect(m({ studio_enabled: false }, 'studio', true)).toBeNull();
    // continua desligada
    expect(m({}, null, false)).toBeNull();
    // desligou e ligou de novo: a primeira data fica
    expect(m({ studio_enabled: false, [CHAVE]: ANTIGA }, null, true)).toBeNull();
    // valor ruim gravado tambem nao e trocado
    expect(m({ studio_enabled: false, [CHAVE]: 'ontem' }, null, true)).toBeNull();
  });

  test('sqlMarcaSeAusente guarda pela chave vazia e usa o parametro dado', () => {
    const sql = ativacao.sqlMarcaSeAusente('$2');
    expect(sql).toMatch(/\$2::text IS NOT NULL/);
    expect(sql).toMatch(/NULLIF\(COALESCE\(pdv_settings, '\{\}'::jsonb\)->>'personalizados_ativado_em', ''\) IS NULL/);
    expect(sql).toMatch(/ELSE '\{\}'::jsonb END/);
  });

  test('escolherDataOriginal: a mais antiga entre empresa e primeiro pedido', () => {
    expect(ativacao.escolherDataOriginal({
      empresaCriadaEm: new Date('2026-05-22T10:00:00Z'), primeiroPedidoEm: new Date('2026-06-15T10:00:00Z'),
    })).toEqual({ data: '2026-05-22T10:00:00.000Z', origem: 'empresa' });
    // pedido importado com data anterior a empresa
    expect(ativacao.escolherDataOriginal({
      empresaCriadaEm: '2026-05-22T10:00:00Z', primeiroPedidoEm: '2026-01-02T10:00:00Z',
    })).toEqual({ data: '2026-01-02T10:00:00.000Z', origem: 'primeiro_pedido' });
    expect(ativacao.escolherDataOriginal({ empresaCriadaEm: '2026-05-22T10:00:00Z', primeiroPedidoEm: null }))
      .toEqual({ data: '2026-05-22T10:00:00.000Z', origem: 'empresa' });
    // empate fica com a empresa
    expect(ativacao.escolherDataOriginal({ empresaCriadaEm: ANTIGA, primeiroPedidoEm: ANTIGA }).origem).toBe('empresa');
    expect(ativacao.escolherDataOriginal({ empresaCriadaEm: 'lixo', primeiroPedidoEm: null })).toBeNull();
    expect(ativacao.escolherDataOriginal({})).toBeNull();
  });
});

describe('vertical Studio ligada (setCompanyVertical / applySegment)', () => {
  beforeEach(() => { jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate'] }); });
  afterEach(() => { jest.useRealTimers(); });

  test('primeira vez: grava a hora junto do studio_enabled', async () => {
    const fdb = fakeSegmentDb({ companies: { [C]: { plan: 'negocio' } } });
    await applySegment(fdb.client, C, { segment: 'studio' });
    expect(fdb.state.companies[C].pdv_settings).toMatchObject({ studio_enabled: true, [CHAVE]: AGORA.toISOString() });
    const sync = fdb.writesTo(/'studio_enabled', true/);
    expect(sync).toHaveLength(1);
    expect(sync[0].params).toEqual([C, AGORA.toISOString()]);
  });

  test('ja estava ligada (empresa Studio de antes): nao inventa data', async () => {
    const fdb = fakeSegmentDb({ companies: { [C]: { plan: 'negocio', pdv_settings: { studio_enabled: true } } } });
    await setCompanyVertical(fdb.client, C, 'studio', null);
    expect(fdb.state.companies[C].pdv_settings[CHAVE]).toBeUndefined();
    expect(fdb.writesTo(/'studio_enabled', true/)[0].params).toEqual([C, null]);
  });

  test('desligou e ligou de novo: a primeira data fica', async () => {
    const fdb = fakeSegmentDb({ companies: { [C]: { plan: 'negocio', vertical_active: 'studio', pdv_settings: { studio_enabled: true, [CHAVE]: ANTIGA } } } });
    await setCompanyVertical(fdb.client, C, null, 'studio');
    expect(fdb.state.companies[C].pdv_settings).toMatchObject({ studio_enabled: false, [CHAVE]: ANTIGA });
    await setCompanyVertical(fdb.client, C, 'studio', null);
    expect(fdb.state.companies[C].pdv_settings).toMatchObject({ studio_enabled: true, [CHAVE]: ANTIGA });
  });

  test('frente que nao e studio nao grava data', async () => {
    const fdb = fakeSegmentDb({ companies: { [C]: { plan: 'negocio' } } });
    await applySegment(fdb.client, C, { segment: 'matcon' });
    expect(fdb.state.companies[C].pdv_settings[CHAVE]).toBeUndefined();
  });
});

// ── PUT/GET /pdv-settings ─────────────────────────────────────────────────
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

// Uma linha de companies em memoria. O UPDATE aplica a guarda do
// SQL_PRESERVA_DATA: a data do banco vence o objeto enviado.
function mockCompany(row) {
  const state = { ...row, updates: [], sqls: [] };
  db.query.mockImplementation(async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) return { rows: [{ pdv_settings: state.pdv_settings, vertical_active: state.vertical_active }] };
    if (/^\s*UPDATE companies SET pdv_settings/i.test(sql)) {
      state.sqls.push(sql);
      const novo = JSON.parse(params[0]);
      const noBanco = (state.pdv_settings || {})[CHAVE];
      if (/personalizados_ativado_em/.test(sql) && ativacao.temValorGravado(noBanco)) novo[CHAVE] = noBanco;
      state.pdv_settings = novo;
      state.updates.push(novo);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('SQL inesperado no teste: ' + sql);
  });
  return state;
}

const put = (settings) => request(makeApp()).put('/companies/' + C + '/pdv-settings').send({ settings });

describe('PUT /pdv-settings — personalizados_ativado_em somente leitura', () => {
  beforeEach(() => { jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate'] }); });
  afterEach(() => { jest.useRealTimers(); db.query.mockReset(); });

  test('o corpo nao grava a chave (lojista nunca edita)', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: { caixa_enabled: true } });
    const res = await put({ [CHAVE]: '2020-01-01T00:00:00.000Z', require_customer: true });
    expect(res.status).toBe(200);
    expect(res.body.settings[CHAVE]).toBeUndefined();
    expect(state.updates[0][CHAVE]).toBeUndefined();
    expect(state.updates[0].require_customer).toBe(true);
  });

  test('valor no corpo de tipo errado nao vira 400 (o app manda o objeto inteiro que leu)', async () => {
    mockCompany({ vertical_active: null, pdv_settings: { [CHAVE]: ANTIGA } });
    const res = await put({ [CHAVE]: 123 });
    expect(res.status).toBe(200);
    expect(res.body.settings[CHAVE]).toBe(ANTIGA);
  });

  test('a data do banco fica, mesmo com outra no corpo ou sem ela', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: { studio_enabled: true, [CHAVE]: ANTIGA } });
    const a = await put({ [CHAVE]: '2026-11-17T00:00:00.000Z' });
    expect(a.body.settings[CHAVE]).toBe(ANTIGA);
    const b = await put({ studio_enabled: false });
    expect(b.body.settings[CHAVE]).toBe(ANTIGA);
    const c = await put({ studio_enabled: true });
    expect(c.body.settings[CHAVE]).toBe(ANTIGA);
    expect(state.updates.map((u) => u[CHAVE])).toEqual([ANTIGA, ANTIGA, ANTIGA]);
  });

  test('o PUT que liga a frente pela primeira vez grava a hora', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: { studio_enabled: false } });
    const res = await put({ studio_enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.settings[CHAVE]).toBe(AGORA.toISOString());
    expect(state.updates[0][CHAVE]).toBe(AGORA.toISOString());
  });

  test('PUT que nao liga a frente nao grava data', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: {} });
    await put({ require_seller: true });
    expect(state.updates[0][CHAVE]).toBeUndefined();
  });

  test('frente ja ligada antes (sem data): o PUT nao inventa data', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: { studio_enabled: true } });
    await put({ studio_enabled: true, caixa_enabled: true });
    expect(state.updates[0][CHAVE]).toBeUndefined();
  });

  test('vertical Studio com studio_enabled:false salvo nao conta como "ligou agora"', async () => {
    const state = mockCompany({ vertical_active: 'studio', pdv_settings: { studio_enabled: false } });
    await put({ caixa_enabled: true });
    expect(state.updates[0].studio_enabled).toBe(true);
    expect(state.updates[0][CHAVE]).toBeUndefined();
  });

  test('o UPDATE leva a guarda que preserva a data do banco', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: {} });
    await put({ caixa_enabled: true });
    expect(state.sqls[0]).toContain('$1::jsonb || ' + ativacao.SQL_PRESERVA_DATA);
  });

  test('GET devolve a data gravada e nao inventa a chave quando ela nao existe', async () => {
    mockCompany({ vertical_active: null, pdv_settings: { studio_enabled: true, [CHAVE]: ANTIGA } });
    const com = await request(makeApp()).get('/companies/' + C + '/pdv-settings');
    expect(com.body.settings[CHAVE]).toBe(ANTIGA);
    mockCompany({ vertical_active: null, pdv_settings: { studio_enabled: true } });
    const sem = await request(makeApp()).get('/companies/' + C + '/pdv-settings');
    expect(sem.body.settings).not.toHaveProperty(CHAVE);
  });
});

// ── Migracao: data original do Studio (banco falso) ───────────────────────
function fakeConn(row, { pedido = null, corrida = false } = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return { rows: row ? [{ ...row, primeiro_pedido_em: pedido }] : [] };
      if (/^\s*UPDATE companies/i.test(sql)) {
        if (corrida) return { rows: [] };
        return { rows: [{ data: params[1] }] };
      }
      throw new Error('SQL inesperado: ' + sql);
    }),
  };
}

describe('gravarDataOriginalDoStudio (migracao, sem rodar em ninguem)', () => {
  const empresa = { id: C, created_at: new Date('2026-05-22T10:00:00Z'), vertical_active: 'studio', pdv_settings: { studio_enabled: true } };

  test('inicioDoUsoDoStudio so le', async () => {
    const conn = fakeConn(empresa, { pedido: new Date('2026-06-15T10:00:00Z') });
    const r = await ativacao.inicioDoUsoDoStudio(conn, C);
    expect(r).toEqual({ company_id: C, ligada: true, data_gravada: null, data_original: '2026-05-22T10:00:00.000Z', origem: 'empresa' });
    expect(conn.calls).toHaveLength(1);
    expect(conn.calls[0].sql).toMatch(/FROM studio_orders/);
  });

  test('grava a data original com guarda no WHERE', async () => {
    const conn = fakeConn(empresa, { pedido: new Date('2026-06-15T10:00:00Z') });
    const r = await ativacao.gravarDataOriginalDoStudio(conn, C);
    expect(r).toEqual({ gravada: true, motivo: 'empresa', data: '2026-05-22T10:00:00.000Z' });
    const upd = conn.calls[1];
    expect(upd.params).toEqual([C, '2026-05-22T10:00:00.000Z']);
    expect(upd.sql).toMatch(/NULLIF\(COALESCE\(pdv_settings, '\{\}'::jsonb\)->>'personalizados_ativado_em', ''\) IS NULL/);
    expect(upd.sql).toMatch(/studio_enabled', ''\) = 'true' OR vertical_active = 'studio'/);
  });

  test('ja tem data: nao escreve', async () => {
    const conn = fakeConn({ ...empresa, pdv_settings: { studio_enabled: true, [CHAVE]: '2026-11-17T13:00:00.000Z' } });
    const r = await ativacao.gravarDataOriginalDoStudio(conn, C);
    expect(r).toEqual({ gravada: false, motivo: 'ja_tem_data', data: '2026-11-17T13:00:00.000Z' });
    expect(conn.calls).toHaveLength(1);
  });

  test('frente desligada: nao escreve', async () => {
    const conn = fakeConn({ ...empresa, vertical_active: null, pdv_settings: { studio_enabled: false } });
    const r = await ativacao.gravarDataOriginalDoStudio(conn, C);
    expect(r).toMatchObject({ gravada: false, motivo: 'frente_desligada' });
    expect(conn.calls).toHaveLength(1);
  });

  test('empresa inexistente', async () => {
    const r = await ativacao.gravarDataOriginalDoStudio(fakeConn(null), C);
    expect(r).toMatchObject({ gravada: false, motivo: 'empresa_nao_encontrada' });
  });

  test('outra gravacao entrou antes do UPDATE: a guarda segura e nada muda', async () => {
    const conn = fakeConn(empresa, { corrida: true });
    const r = await ativacao.gravarDataOriginalDoStudio(conn, C);
    expect(r).toMatchObject({ gravada: false, motivo: 'ja_tem_data' });
  });
});
