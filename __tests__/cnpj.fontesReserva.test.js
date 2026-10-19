// 19/10/2026 — INC-2026-10-19-03: o cnpj.ws parou de responder e o cadastro
// travava em 500 "CNPJ lookup timeout". A consulta agora cai no CNPJá aberto
// e, por último, na BrasilAPI, devolvendo o mesmo formato de antes.
// https.get é simulado: cada host responde o que o teste mandar.
const { EventEmitter } = require('events');

jest.mock('https', () => ({ get: jest.fn() }));
// tests/jest.setup.js desliga lookupCNPJ em todas as suítes; aqui queremos o real.
jest.unmock('../src/services/cnpj');
const https = require('https');
const cnpj = require('../src/services/cnpj');

const CNPJ = '33000167000101';

// Respostas por host: { status, body } | 'timeout' | 'erro-rede'
let roteiro = {};
const chamados = () => https.get.mock.calls.map(([url]) => new URL(url).host);

beforeEach(() => {
  roteiro = {};
  https.get.mockReset();
  https.get.mockImplementation((url, _opts, cb) => {
    const req = new EventEmitter();
    req.destroy = jest.fn();
    const r = roteiro[new URL(url).host];
    setImmediate(() => {
      if (r === 'timeout' || r === undefined) return; // nunca responde: o prazo corta
      if (r === 'erro-rede') return req.emit('error', new Error('getaddrinfo ENOTFOUND'));
      const res = new EventEmitter();
      res.statusCode = r.status;
      cb(res);
      res.emit('data', typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      res.emit('end');
    });
    return req;
  });
  // Prazos curtos no teste; a ordem e a regra são as de produção.
  Object.assign(cnpj.FONTE_TIMEOUT_MS, { 'cnpj.ws': 30, cnpja: 30, brasilapi: 30 });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const WS = 'publica.cnpj.ws';
const JA = 'open.cnpja.com';
const BR = 'brasilapi.com.br';

// Petrobras nas três fontes (formato real conferido em 19/10/2026; sem sócios).
const wsBody = (simples = null) => ({
  razao_social: 'PETROLEO BRASILEIRO S A PETROBRAS',
  natureza_juridica: { id: '2038', descricao: 'Sociedade de Economia Mista' },
  porte: { id: '05', descricao: 'Demais' },
  simples,
  estabelecimento: {
    nome_fantasia: 'Petrobras - Edise', situacao_cadastral: 'Ativa', data_inicio_atividade: '1966-09-28',
    email: 'CC-RFISC@PETROBRAS.COM.BR', ddd1: '21', telefone1: '21660000',
    logradouro: 'REPUBLICA DO CHILE', numero: '65', complemento: null, bairro: 'Centro',
    cidade: { nome: 'Rio de Janeiro' }, estado: { sigla: 'RJ' }, cep: '20031170',
    atividade_principal: { subclasse: '0600-0/01', descricao: 'Extração de petróleo e gás natural' },
    atividades_secundarias: [{ subclasse: '1921-7/00', descricao: 'Fabricação de produtos do refino de petróleo' }],
  },
});
const jaBody = ({ simples = false, simei = false, size = { id: 5, acronym: 'DEMAIS', text: 'Demais' }, nature = { id: 2038, text: 'Sociedade de Economia Mista' } } = {}) => ({
  taxId: CNPJ, alias: 'Petrobras - Edise', founded: '1966-09-28', status: { id: 2, text: 'Ativa' },
  company: {
    name: 'PETROLEO BRASILEIRO S A PETROBRAS', nature, size,
    simples: { optant: simples, since: null, history: [] }, simei: { optant: simei, since: null, history: [] },
    members: [{ person: { name: 'NAO DEVE APARECER' } }],
  },
  address: { street: 'Avenida Republica do Chile', number: '65', district: 'Centro', city: 'Rio de Janeiro', state: 'RJ', details: null, zip: '20031170' },
  phones: [{ type: 'LANDLINE', area: '21', number: '21660000' }],
  emails: [{ address: 'cc-rfisc@petrobras.com.br' }],
  mainActivity: { id: 600001, text: 'Extração de petróleo e gás natural' },
  sideActivities: [{ id: 1921700, text: 'Fabricação de produtos do refino de petróleo' }],
});
const brBody = ({ simples = null, mei = null, porte = 'DEMAIS' } = {}) => ({
  cnpj: CNPJ, razao_social: 'PETROLEO BRASILEIRO S A PETROBRAS', nome_fantasia: 'PETROBRAS - EDISE',
  natureza_juridica: 'Sociedade de Economia Mista', codigo_natureza_juridica: 2038, porte,
  descricao_situacao_cadastral: 'ATIVA', data_inicio_atividade: '1966-09-28', email: null,
  ddd_telefone_1: '2121660000', logradouro: 'REPUBLICA DO CHILE', numero: '65', complemento: '',
  bairro: 'CENTRO', municipio: 'RIO DE JANEIRO', uf: 'RJ', cep: '20031170',
  cnae_fiscal: 600001, cnae_fiscal_descricao: 'Extração de petróleo e gás natural',
  cnaes_secundarios: [{ codigo: 1921700, descricao: 'Fabricação de produtos do refino de petróleo' }],
  opcao_pelo_simples: simples, opcao_pelo_mei: mei, data_exclusao_do_simples: null, data_exclusao_do_mei: null,
  qsa: [{ nome_socio: 'NAO DEVE APARECER' }],
});

const CHAVES = [
  'cnpj', 'cnpj_raw', 'legal_name', 'trade_name', 'legal_nature', 'legal_nature_code', 'company_size',
  'rf_situation', 'opening_date', 'email', 'phone', 'address_street', 'address_number', 'address_complement',
  'address_district', 'address_city', 'address_state', 'address_zip', 'cnae_principal', 'cnaes_secundarios',
  'suggested_regime', 'regime_fonte', 'regime_confirmar', 'simples_optante', 'mei_optante',
  'suggested_vertical', 'is_mei', 'is_active', 'rf_fonte',
].sort();

describe('lookupCNPJ — fontes de reserva', () => {
  test('cnpj.ws ok: usa o cnpj.ws e não chama as reservas', async () => {
    roteiro[WS] = { status: 200, body: wsBody({ simples: 'Não', mei: 'Não' }) };
    const r = await cnpj.lookupCNPJ(CNPJ, null);
    expect(chamados()).toEqual([WS]);
    expect(r.rf_fonte).toBe('cnpj.ws');
    expect(r).toMatchObject({
      cnpj: '33.000.167/0001-01', legal_name: 'PETROLEO BRASILEIRO S A PETROBRAS', trade_name: 'Petrobras - Edise',
      legal_nature_code: '2038', company_size: 'Demais', rf_situation: 'Ativa', is_active: true,
      email: 'cc-rfisc@petrobras.com.br', phone: '(21) 21660000', address_city: 'Rio de Janeiro', address_zip: '20031170',
      cnae_principal: { code: '0600001', description: 'Extração de petróleo e gás natural' },
      cnaes_secundarios: [{ code: '1921700', description: 'Fabricação de produtos do refino de petróleo' }],
      suggested_regime: 'lucro_presumido', regime_fonte: 'receita', regime_confirmar: true,
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('cnpj.ws em timeout: CNPJá responde no mesmo formato, com aviso no log', async () => {
    // Referência: o que o cnpj.ws devolveria para a mesma empresa.
    roteiro[WS] = { status: 200, body: wsBody({ simples: 'Não', mei: 'Não' }) };
    const ws = await cnpj.lookupCNPJ(CNPJ, null);
    https.get.mockClear();
    roteiro[WS] = 'timeout';
    roteiro[JA] = { status: 200, body: jaBody() };
    const r = await cnpj.lookupCNPJ(CNPJ, null);
    expect(chamados()).toEqual([WS, JA]);
    expect(Object.keys(r).sort()).toEqual(CHAVES);
    expect(r.rf_fonte).toBe('cnpja');
    // Mesmos valores que o cnpj.ws daria (o endereço do CNPJá já traz o tipo do logradouro).
    const { rf_fonte: _a, address_street: _b, ...resto } = r;
    const { rf_fonte: _c, address_street: _d, ...restoWs } = ws;
    expect(resto).toEqual(restoWs);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('respondida por cnpja'));
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain('NAO DEVE APARECER');
    expect(JSON.stringify(r)).not.toContain('NAO DEVE APARECER');
  });

  test('cnpj.ws erro de rede e CNPJá 429: BrasilAPI responde no mesmo formato', async () => {
    roteiro[WS] = 'erro-rede';
    roteiro[JA] = { status: 429, body: { code: 429, message: 'rate limit exceeded' } };
    roteiro[BR] = { status: 200, body: brBody() };
    const r = await cnpj.lookupCNPJ(CNPJ, null);
    expect(chamados()).toEqual([WS, JA, BR]);
    expect(Object.keys(r).sort()).toEqual(CHAVES);
    expect(r).toMatchObject({
      rf_fonte: 'brasilapi', legal_name: 'PETROLEO BRASILEIRO S A PETROBRAS', trade_name: 'PETROBRAS - EDISE',
      legal_nature: 'Sociedade de Economia Mista', legal_nature_code: '2038', company_size: 'DEMAIS',
      rf_situation: 'ATIVA', is_active: true, opening_date: '1966-09-28', email: '', phone: '(21) 21660000',
      address_street: 'REPUBLICA DO CHILE', address_number: '65', address_city: 'RIO DE JANEIRO', address_state: 'RJ',
      address_zip: '20031170',
      cnae_principal: { code: '0600001', description: 'Extração de petróleo e gás natural' },
      cnaes_secundarios: [{ code: '1921700', description: 'Fabricação de produtos do refino de petróleo' }],
      // opcao_pelo_simples null: sem registro → heurística de porte, marcada como estimada
      suggested_regime: 'lucro_presumido', regime_fonte: 'estimado', regime_confirmar: true,
      is_mei: false, simples_optante: false, mei_optante: false,
    });
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain('NAO DEVE APARECER');
    expect(JSON.stringify(r)).not.toContain('NAO DEVE APARECER');
  });

  test('cnpj.ws 5xx também cai na reserva', async () => {
    roteiro[WS] = { status: 502, body: '<html>Bad Gateway</html>' };
    roteiro[JA] = { status: 200, body: jaBody() };
    const r = await cnpj.lookupCNPJ(CNPJ, null);
    expect(chamados()).toEqual([WS, JA]);
    expect(r.rf_fonte).toBe('cnpja');
  });

  test('cnpj.ws 404: "não encontrado" sem chamar as reservas', async () => {
    roteiro[WS] = { status: 404, body: { status: 404, titulo: 'Não Encontrado' } };
    await expect(cnpj.lookupCNPJ(CNPJ, null)).rejects.toThrow('CNPJ não encontrado na Receita Federal');
    expect(chamados()).toEqual([WS]);
  });

  test('404 numa reserva também é "não encontrado" e para ali', async () => {
    roteiro[WS] = 'timeout';
    roteiro[JA] = { status: 404, body: { message: 'not found' } };
    await expect(cnpj.lookupCNPJ(CNPJ, null)).rejects.toThrow('não encontrado');
    expect(chamados()).toEqual([WS, JA]);
  });

  test('as três falham: erro 503 com mensagem para a pessoa', async () => {
    roteiro[WS] = 'timeout';
    roteiro[JA] = { status: 429, body: {} };
    roteiro[BR] = 'timeout';
    const err = await cnpj.lookupCNPJ(CNPJ, null).catch(e => e);
    expect(err.status).toBe(503);
    expect(err.message).toBe('Não conseguimos consultar a Receita agora. Tente de novo em alguns minutos.');
    expect(chamados()).toEqual([WS, JA, BR]);
  });

  test('resposta da reserva vai ao cache do mesmo jeito', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
    roteiro[WS] = 'timeout';
    roteiro[JA] = { status: 200, body: jaBody() };
    await cnpj.lookupCNPJ(CNPJ, redis);
    expect(redis.setex).toHaveBeenCalledWith(`cnpj:ws:v2:${CNPJ}`, 86400, expect.any(String));
    expect(JSON.parse(redis.setex.mock.calls[0][2]).rf_fonte).toBe('cnpja');
  });

  test('prazos de produção somam menos que o abort de 10 s do app', () => {
    jest.isolateModules(() => {
      const fresco = require('../src/services/cnpj');
      const total = Object.values(fresco.FONTE_TIMEOUT_MS).reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(9000);
    });
  });
});

describe('regime pelas reservas — mesma regra do bloco simples do cnpj.ws (#805)', () => {
  const ME = { id: 1, acronym: 'ME', text: 'Microempresa' };
  const EI = { id: 2135, text: 'Empresário (Individual)' };

  async function viaCnpja(opts) {
    roteiro[WS] = 'timeout';
    roteiro[JA] = { status: 200, body: jaBody(opts) };
    return cnpj.lookupCNPJ(CNPJ, null);
  }
  async function viaBrasilApi(opts) {
    roteiro[WS] = 'timeout';
    roteiro[JA] = { status: 429, body: {} };
    roteiro[BR] = { status: 200, body: brBody(opts) };
    return cnpj.lookupCNPJ(CNPJ, null);
  }

  test('CNPJá: MEI optante é mei', async () => {
    const r = await viaCnpja({ simples: true, simei: true, size: ME, nature: EI });
    expect(r).toMatchObject({ suggested_regime: 'mei', regime_fonte: 'receita', regime_confirmar: false, is_mei: true, mei_optante: true, simples_optante: true });
  });
  test('CNPJá: Simples sem MEI é simples_nacional', async () => {
    const r = await viaCnpja({ simples: true, simei: false, size: ME });
    expect(r).toMatchObject({ suggested_regime: 'simples_nacional', regime_fonte: 'receita', regime_confirmar: false, is_mei: false });
  });
  test('CNPJá: fora do Simples sugere Presumido e pede confirmação', async () => {
    const r = await viaCnpja({ simples: false, simei: false, size: ME });
    expect(r).toMatchObject({ suggested_regime: 'lucro_presumido', regime_fonte: 'receita', regime_confirmar: true });
  });
  test('CNPJá sem o dado de opção: heurística de porte, estimada', async () => {
    const r = await viaCnpja({ simples: null, simei: null, size: ME });
    expect(r).toMatchObject({ suggested_regime: 'simples_nacional', regime_fonte: 'estimado', regime_confirmar: true, is_mei: false });
  });

  test('BrasilAPI: MEI optante é mei', async () => {
    const r = await viaBrasilApi({ simples: true, mei: true, porte: 'MICRO EMPRESA' });
    expect(r).toMatchObject({ suggested_regime: 'mei', regime_fonte: 'receita', regime_confirmar: false, is_mei: true });
  });
  test('BrasilAPI: saiu do MEI e segue no Simples é simples_nacional', async () => {
    const r = await viaBrasilApi({ simples: true, mei: false, porte: 'MICRO EMPRESA' });
    expect(r).toMatchObject({ suggested_regime: 'simples_nacional', regime_fonte: 'receita', regime_confirmar: false, is_mei: false });
  });
  test('BrasilAPI: excluída do Simples (false) sugere Presumido e pede confirmação', async () => {
    const r = await viaBrasilApi({ simples: false, mei: false, porte: 'MICRO EMPRESA' });
    expect(r).toMatchObject({ suggested_regime: 'lucro_presumido', regime_fonte: 'receita', regime_confirmar: true });
  });
  test('BrasilAPI sem registro (null): heurística de porte, estimada — nunca afirma o regime', async () => {
    const r = await viaBrasilApi({ simples: null, mei: null, porte: 'MICRO EMPRESA' });
    expect(r).toMatchObject({ suggested_regime: 'simples_nacional', regime_fonte: 'estimado', regime_confirmar: true, is_mei: false });
  });
});
