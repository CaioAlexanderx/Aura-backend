// ============================================================
// 11/11/2026 — POST /nfce/emit com UF ainda sem emissão própria.
// Caso real: loja do RJ recebeu "Erro ao transmitir nota para SEFAZ-SP:
// sefazSp: UF RJ não suportada na emissão própria. UFs disponíveis: ...".
// Agora:
//   - UF sem endpoints (ex.: BA), sem gateway → 422 com texto gentil, ANTES
//     de reservar número; nada de "SEFAZ-SP"; detalhe técnico só no log;
//   - RJ entra no caminho normal da engine;
//   - rede de segurança: se a engine lançar UF_NAO_SUPORTADA, mesma mensagem
//     gentil e o breaker não conta como falha;
//   - erro genérico de loja fora de SP não cita "SEFAZ-SP".
// Mesmo harness de sefazSpFallback.test.js (router nfce num app minimal,
// db.query por inspeção de SQL). Empresa fictícia.
// ============================================================
const supertest = require('supertest');
const app0 = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/sefazSp', () => ({ emitNfce: jest.fn() }));
jest.mock('../../src/services/nuvemfiscal', () => ({
  emitNfce: jest.fn(), emitNfe: jest.fn(), queryNfce: jest.fn(), queryNfe: jest.fn(),
  ufToCodigo: () => 35, isoBR: () => '2026-11-11T10:00:00-03:00',
}));
jest.mock('../../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));

const sefazSp = require('../../src/services/sefazSp');
const nuvemfiscal = require('../../src/services/nuvemfiscal');
const engineBreaker = require('../../src/services/sefazSp/engineBreaker');
const { UfNaoSuportadaError } = require('../../src/services/sefazSp/endpoints');

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-000000000033';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };

const COMPANY_ROW = {
  id: CID, cnpj: '11222333000181', legal_name: 'Loja Teste', trade_name: 'Loja Teste',
  address_street: 'R', address_number: '1', address_neighborhood: 'C',
  address_city: 'Cidade Teste', address_state: 'RJ', address_zip: '20010000',
  inscricao_estadual: '12345678', inscricao_municipal: null, ibge_code: '3304557',
  email: 'x@y.com', phone: '1', tax_regime: 'simples_nacional',
};

const CONFIG_ROW = {
  id: 'cfg-1', company_id: CID, provider: 'sefaz_sp', is_active: true,
  ambiente: 'producao', uf: 'RJ', serie_nfce: 1, next_number: 500,
  serie_sefaz_sp: 2, next_number_sefaz_sp: 900, csc_id: '1', csc_token_enc: 'x',
  inscricao_estadual: '12345678',
};

const EMIT_BODY = {
  items: [{ product_name: 'Item', quantity: 1, unit_price: 10 }],
  payments: [{ method: 'dinheiro', value: 10 }],
  tipo: 'nfce',
};

function makeDb(opts = {}) {
  const state = {
    emission: { id: 'em-1', company_id: CID, status: 'processando', numero: null, serie: null,
      chave_acesso: null, provider_used: null, fallback_reason: null, error_message: null },
    ownSeriesReserved: false,
    gatewaySeriesReserved: false,
  };
  const company = { ...COMPANY_ROW, ...(opts.company || {}) };
  const query = jest.fn(async (sql, params = []) => {
    if (/SELECT serie_sefaz_sp, next_number_sefaz_sp FROM nfce_config/.test(sql)) return { rows: [] };
    if (/SELECT provider_used, fallback_reason FROM nfce_emissions/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM nfce_config/.test(sql)) return { rows: [{ ...CONFIG_ROW, ...(opts.config || {}) }] };
    if (/FROM companies WHERE id=/.test(sql)) return { rows: [company] };
    if (/UPDATE nfce_config SET next_number_sefaz_sp/.test(sql)) { state.ownSeriesReserved = true; return { rows: [{ numero: 900 }] }; }
    if (/UPDATE nfce_config SET next_number =/.test(sql)) { state.gatewaySeriesReserved = true; return { rows: [{ numero: 500 }] }; }
    if (/INSERT INTO nfce_emissions/.test(sql)) {
      state.emission.numero = params[3]; state.emission.serie = params[4]; state.emission.chave_acesso = params[5];
      return { rows: [{ ...state.emission }] };
    }
    if (/SELECT id, ncm, tax_profile FROM products/.test(sql)) return { rows: [] };
    if (/UPDATE nfce_emissions SET provider_used=/.test(sql)) {
      state.emission.provider_used = params[0]; state.emission.fallback_reason = params[1];
      return { rows: [] };
    }
    if (/UPDATE nfce_emissions SET status='erro', error_message=\$1/.test(sql)) {
      state.emission.status = 'erro'; state.emission.error_message = params[0];
      return { rows: [] };
    }
    if (/UPDATE nfce_emissions SET status=/.test(sql)) {
      if (params[0] === 'rejeitada' || params[0] === 'autorizada') state.emission.status = params[0];
      return { rows: [] };
    }
    if (/UPDATE nfce_emissions SET/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM nfce_emissions WHERE id=/.test(sql)) return { rows: [{ ...state.emission }] };
    return { rows: [] };
  });
  return { query, connect: jest.fn(), state };
}

function buildApp(dbMock) {
  jest.resetModules();
  jest.doMock('../../src/config/database', () => dbMock);
  jest.doMock('../../src/services/sefazSp', () => sefazSp);
  jest.doMock('../../src/services/nuvemfiscal', () => nuvemfiscal);
  jest.doMock('../../src/services/sefazSp/engineBreaker', () => engineBreaker);
  jest.doMock('../../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  const router = require('../../src/routes/nfce');
  const a = app0();
  a.use(app0.json());
  a.use('/c/:id/nfce', router);
  return a;
}

const OK_RESULT = {
  status: 'autorizado', chave_acesso: '33' + '1'.repeat(42), protocolo: 'P1',
  codigo_status: '100', motivo_status: 'Autorizado', qr_code: 'qr',
  url_consulta: 'https://www.fazenda.rj.gov.br/nfce/consulta',
  xml_signed: '<xml/>', tp_emis: 1, provider: 'sefaz_sp',
};

const GENTIL_BA = 'A emissão de NFC-e para lojas de BA está sendo ligada pela equipe Aura. A venda foi registrada normalmente.';

let warnSpy;
let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  engineBreaker.reset();
  // produção: sem gateway
  delete process.env.NUVEM_FISCAL_CLIENT_ID;
  delete process.env.NUVEM_FISCAL_CLIENT_SECRET;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); errorSpy.mockRestore(); });

describe('UF sem emissão própria (BA) → texto gentil antes de reservar número', () => {
  test('422 gentil, sem SEFAZ-SP, sem reservar número, sem criar emissão; detalhe no log', async () => {
    const db = makeDb({ config: { uf: 'BA' }, company: { address_state: 'BA' } });
    const res = await supertest(buildApp(db)).post(`/c/${CID}/nfce/emit`).set(auth)
      .send({ ...EMIT_BODY, sale_id: 'sale-1' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NFCE_UF_NAO_SUPORTADA');
    expect(res.body.error).toBe(GENTIL_BA);
    expect(JSON.stringify(res.body)).not.toMatch(/SEFAZ-SP|sefazSp|não suportada|UFs disponíveis/);
    expect(sefazSp.emitNfce).not.toHaveBeenCalled();
    expect(db.state.ownSeriesReserved).toBe(false);
    expect(db.state.gatewaySeriesReserved).toBe(false);
    expect(db.query.mock.calls.some((c) => /INSERT INTO nfce_emissions/.test(c[0]))).toBe(false);
    // tentativas antigas em erro dessa venda passam a mostrar o texto gentil
    const fix = db.query.mock.calls.find((c) => /UPDATE nfce_emissions SET error_message=\$1/.test(c[0]));
    expect(fix[1]).toEqual([GENTIL_BA, CID, 'sale-1', 'nfce']);
    // detalhe técnico no log
    expect(warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/UF BA.*UFs disponíveis: .*RJ/);
  });
});

describe('RJ → caminho normal da engine', () => {
  test('emite pela engine (201), reserva número da série própria', async () => {
    sefazSp.emitNfce.mockResolvedValueOnce(OK_RESULT);
    const db = makeDb();
    const res = await supertest(buildApp(db)).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(201);
    expect(res.body.provider_used).toBe('sefaz_sp');
    expect(sefazSp.emitNfce).toHaveBeenCalledTimes(1);
    expect(sefazSp.emitNfce.mock.calls[0][2].config.uf).toBe('RJ');
    expect(db.state.ownSeriesReserved).toBe(true);
  });
});

describe('rede de segurança no catch da emissão', () => {
  test('engine lança UF_NAO_SUPORTADA → 422 gentil, error_message gentil, breaker intocado', async () => {
    sefazSp.emitNfce.mockRejectedValueOnce(new UfNaoSuportadaError('BA'));
    const db = makeDb();
    const res = await supertest(buildApp(db)).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NFCE_UF_NAO_SUPORTADA');
    expect(res.body.error).toBe(GENTIL_BA);
    expect(res.body.nfce_id).toBe('em-1');
    expect(db.state.emission.error_message).toBe(GENTIL_BA);
    expect(engineBreaker.snapshot(CID).consecutiveFailures).toBe(0);
    // detalhe técnico continua no log
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/UF BA não suportada na emissão própria/);
  });

  test('erro genérico em loja do RJ cita SEFAZ-RJ, nunca SEFAZ-SP', async () => {
    sefazSp.emitNfce.mockRejectedValueOnce(new Error('certificado nao decripta'));
    const db = makeDb();
    const res = await supertest(buildApp(db)).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Erro ao transmitir nota para SEFAZ-RJ: certificado nao decripta');
    expect(res.body.error).not.toMatch(/SEFAZ-SP/);
  });

  test('loja de SP: texto de sempre (SEFAZ-SP)', async () => {
    sefazSp.emitNfce.mockRejectedValueOnce(new Error('certificado nao decripta'));
    const db = makeDb({ config: { uf: 'SP' }, company: { address_state: 'SP' } });
    const res = await supertest(buildApp(db)).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Erro ao transmitir nota para SEFAZ-SP: certificado nao decripta');
  });
});
