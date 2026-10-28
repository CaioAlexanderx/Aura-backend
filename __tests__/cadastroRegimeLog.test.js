// ============================================================
// [REGIME] — log do regime tributário no cadastro (28/10/2026)
//
// Desde 19/10 nenhum cadastro novo grava o regime vindo da Receita. O log
// mostra o que o cliente mandou em `tax_regime`, o que foi ao INSERT e o
// que a Receita respondeu (valor, provedor, erro). Só observa: o INSERT e
// as respostas seguem idênticos. Nunca loga e-mail, senha, telefone, nome
// de pessoa nem CPF.
// Banco falso por SQL (tests/helpers/fakeSegmentDb.js).
// ============================================================
jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});

const express = require('express');
const request = require('supertest');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');
const { lookupCNPJ } = require('../src/services/cnpj');
const regimeLog = require('../src/services/regimeLog');

const CNPJ_OK = '11222333000181';
const CPF_OK = '52998224725';

let app, db, logSpy;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  lookupCNPJ.mockReset();
  lookupCNPJ.mockResolvedValue({});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); });

function body(extra) {
  return {
    name: 'Ana Souza', email: 'ana@loja.com', password: 'senha1234',
    company_name: 'Loja da Ana', phone: '11999990000',
    terms_accepted: true, self_serve: true,
    ...(extra || {}),
  };
}

function fakeComCpf() {
  const fake = fakeSegmentDb();
  const base = fake.client.query;
  fake.client.query = jest.fn(async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : '';
    if (/FROM companies WHERE cpf = \$1/.test(text)) return { rows: [] };
    if (/UPDATE companies SET cpf = \$2 WHERE id = \$1/.test(text)) return { rows: [] };
    return base(sql, params);
  });
  return fake;
}

function linhasRegime() {
  return logSpy.mock.calls
    .map((c) => c[0])
    .filter((l) => typeof l === 'string' && l.startsWith('[REGIME] '));
}
function eventos(tipo) {
  return linhasRegime().map((l) => JSON.parse(l.slice('[REGIME] '.length))).filter((e) => e.evento === tipo);
}
function paramRegimeDoInsert(fake) {
  const ins = fake.calls.find((c) => /INSERT INTO companies/.test(c.text));
  return ins ? ins.params[9] : undefined;
}
const flush = () => new Promise((r) => setImmediate(r));

describe('POST /auth/register — [REGIME]', () => {
  test('CNPJ com regime do app: loga o regime recebido e o que foi ao INSERT (INSERT igual)', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cnpj: '11.222.333/0001-81', tax_regime: 'mei' }));
    expect(res.status).toBe(201);
    expect(paramRegimeDoInsert(fake)).toBe('mei');
    const [ev] = eventos('cadastro');
    expect(ev).toMatchObject({
      caminho: 'empresa_nova', cnpj: CNPJ_OK, regime_do_app: 'mei', regime_descartado: null,
      param_insert: 'mei', valor_no_insert: 'mei', via_coalesce: false, self_serve: true,
    });
  });

  test('CNPJ sem regime no corpo: loga "(ausente)" e o default do COALESCE', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK }));
    expect(res.status).toBe(201);
    expect(paramRegimeDoInsert(fake)).toBeNull();
    const [ev] = eventos('cadastro');
    expect(ev).toMatchObject({
      regime_do_app: '(ausente)', param_insert: null, valor_no_insert: 'simples_nacional', via_coalesce: true,
    });
  });

  test('regime fora da lista: loga o valor e o descarte', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK, tax_regime: 'simples' }));
    expect(paramRegimeDoInsert(fake)).toBeNull();
    const [ev] = eventos('cadastro');
    expect(ev.regime_do_app).toBe('simples');
    expect(ev.regime_descartado).toMatch(/^fora da lista/);
    expect(ev.via_coalesce).toBe(true);
  });

  test('conta com CPF: "sem CNPJ", regime descartado e o CPF fora do log', async () => {
    const fake = fakeComCpf();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cpf: CPF_OK, tax_regime: 'mei' }));
    expect(res.status).toBe(201);
    const [ev] = eventos('cadastro');
    expect(ev).toMatchObject({ cnpj: 'sem CNPJ', regime_descartado: 'conta com CPF', valor_no_insert: 'simples_nacional' });
    expect(lookupCNPJ).not.toHaveBeenCalled();
    expect(linhasRegime().join('\n')).not.toContain(CPF_OK);
  });

  test('consulta pós-cadastro (a que já existia) loga o regime da Receita e o provedor', async () => {
    lookupCNPJ.mockResolvedValueOnce({
      suggested_regime: 'mei', regime_fonte: 'receita', regime_confirmar: false,
      mei_optante: true, simples_optante: true, rf_fonte: 'cnpja', is_active: true, address_city: '',
    });
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK, tax_regime: 'mei' }));
    await flush(); await flush();
    expect(lookupCNPJ).toHaveBeenCalledTimes(1);
    const [ev] = eventos('receita');
    expect(ev).toMatchObject({ etapa: 'register', cnpj: CNPJ_OK, regime: 'mei', provedor: 'cnpja', do_cache: false, erro: null });
  });

  test('consulta pós-cadastro com erro: loga o erro e o cadastro segue 201', async () => {
    const err = new Error('Não conseguimos consultar a Receita agora.');
    err.status = 503; err.code = 'CNPJ_FONTES_INDISPONIVEIS';
    lookupCNPJ.mockRejectedValueOnce(err);
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK }));
    expect(res.status).toBe(201);
    await flush(); await flush();
    const [ev] = eventos('receita');
    expect(ev).toMatchObject({ etapa: 'register', regime: null, erro_codigo: 'CNPJ_FONTES_INDISPONIVEIS', erro_status: 503 });
  });

  test('nenhuma linha [REGIME] leva e-mail, senha, telefone ou nome', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK, tax_regime: 'mei' }));
    await flush(); await flush();
    const tudo = linhasRegime().join('\n');
    expect(tudo).not.toBe('');
    for (const proibido of ['ana@loja.com', 'senha1234', '11999990000', 'Ana Souza']) {
      expect(tudo).not.toContain(proibido);
    }
  });
});

describe('POST /onboarding/cnpj-lookup — [REGIME]', () => {
  const appOnb = express();
  appOnb.use(express.json());
  appOnb.use('/onboarding', require('../src/routes/onboarding'));

  test('loga regime, provedor e cache; resposta igual', async () => {
    lookupCNPJ.mockResolvedValueOnce({
      suggested_regime: 'simples_nacional', regime_fonte: 'estimado', regime_confirmar: true,
      rf_fonte: 'brasilapi', is_active: true, _from_cache: true, cnae_principal: null,
    });
    const res = await request(appOnb).post('/onboarding/cnpj-lookup').send({ cnpj: CNPJ_OK });
    expect(res.status).toBe(200);
    expect(res.body.suggested_regime).toBe('simples_nacional');
    const [ev] = eventos('receita');
    expect(ev).toMatchObject({
      etapa: 'cnpj-lookup', cnpj: CNPJ_OK, regime: 'simples_nacional', regime_fonte: 'estimado',
      provedor: 'brasilapi', do_cache: true, erro: null,
    });
  });

  test('erro da consulta: loga o erro e o status segue o de antes', async () => {
    lookupCNPJ.mockRejectedValueOnce(new Error('CNPJ não encontrado na Receita Federal'));
    const res = await request(appOnb).post('/onboarding/cnpj-lookup').send({ cnpj: CNPJ_OK });
    expect(res.status).toBe(404);
    const [ev] = eventos('receita');
    expect(ev).toMatchObject({ etapa: 'cnpj-lookup', regime: null, erro: 'CNPJ não encontrado na Receita Federal' });
  });
});

describe('services/regimeLog', () => {
  test('cnpjDoLog: 14 dígitos vão ao log; o resto não', () => {
    expect(regimeLog.cnpjDoLog('11.222.333/0001-81')).toBe(CNPJ_OK);
    expect(regimeLog.cnpjDoLog(null)).toBe('sem CNPJ');
    expect(regimeLog.cnpjDoLog(CPF_OK)).toBe('documento com 11 digitos');
  });

  test('valorDoCorpo não confia no tipo', () => {
    expect(regimeLog.valorDoCorpo(undefined)).toBe('(ausente)');
    expect(regimeLog.valorDoCorpo('')).toBe('(vazio)');
    expect(regimeLog.valorDoCorpo({ a: 1 })).toBe('(object)');
  });
});
