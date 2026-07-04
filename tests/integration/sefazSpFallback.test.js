// ============================================================
// S4.2/S4.3 — fallback automático engine→gateway + circuit breaker.
// Mocka sefazSp + nuvemfiscal; monta SÓ o router nfce num app minimal
// (requireRole lê req.user.role do JWT, sem db). Driva db.query por
// inspeção de SQL (padrão dos testes stateful da S3).
//
// Cenários:
//   (a) THROW da engine  → nota sai pelo GATEWAY (serie_nfce) + provider_used
//       'nuvemfiscal' + fallback_reason 'engine_error: ...' gravados.
//   (b) contingência     → SEM fallback (provider_used sefaz_sp).
//   (c) rejeição         → SEM fallback + breaker NÃO abre (engine funcionou).
//   (d) breaker aberto   → vai DIRETO ao gateway (fallback_reason breaker_open).
//   (e) colunas ausentes (42703) → comportamento LEGADO (série única, sem fallback).
// ============================================================
const supertest = require('supertest');
const app0 = require('express');
const jwt = require('jsonwebtoken');

// service mocks
jest.mock('../../src/services/sefazSp', () => ({
  emitNfce: jest.fn(),
}));
jest.mock('../../src/services/nuvemfiscal', () => ({
  emitNfce: jest.fn(),
  emitNfe: jest.fn(),
  queryNfce: jest.fn(),
  queryNfe: jest.fn(),
  ufToCodigo: () => 35,   // SP
  isoBR: () => '2026-07-04T10:00:00-03:00',
}));
// middleware de auditoria não deve tocar db de verdade
jest.mock('../../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));

const sefazSp = require('../../src/services/sefazSp');
const nuvemfiscal = require('../../src/services/nuvemfiscal');
const engineBreaker = require('../../src/services/sefazSp/engineBreaker');

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };

const COMPANY_ROW = {
  id: CID, cnpj: '11222333000181', legal_name: 'Davi', trade_name: 'Davi',
  address_street: 'R', address_number: '1', address_neighborhood: 'C',
  address_city: 'Jacareí', address_state: 'SP', address_zip: '12327000',
  inscricao_estadual: '111222333444', inscricao_municipal: null, ibge_code: '3524402',
  email: 'x@y.com', phone: '1', tax_regime: 'simples_nacional',
};

const CONFIG_ROW = {
  id: 'cfg-1', company_id: CID, provider: 'sefaz_sp', is_active: true,
  ambiente: 'producao', uf: 'SP', serie_nfce: 1, next_number: 500,
  serie_sefaz_sp: 2, next_number_sefaz_sp: 900, csc_id: '1', csc_token_enc: 'x',
  inscricao_estadual: '111222333444',
};

const EMIT_BODY = {
  items: [{ product_name: 'Item', quantity: 1, unit_price: 10 }],
  payments: [{ method: 'dinheiro', value: 10 }],
  tipo: 'nfce',
};

/**
 * Mock de db.query por inspeção de SQL. `opts.hasCols` controla se as colunas
 * da migration 176 existem. Guarda a última row de emissão em `state.emission`.
 */
function makeDb(opts = {}) {
  const hasCols = opts.hasCols !== false;
  const state = {
    emission: {
      id: 'em-1', company_id: CID, status: 'processando',
      numero: null, serie: null, chave_acesso: null,
      provider_used: null, fallback_reason: null,
    },
    ownSeriesReserved: false,
    gatewaySeriesReserved: false,
  };
  const query = jest.fn(async (sql, params = []) => {
    // probe de colunas (fallbackColsAvailable)
    if (/SELECT serie_sefaz_sp, next_number_sefaz_sp FROM nfce_config/.test(sql)) {
      if (!hasCols) { const e = new Error('column does not exist'); e.code = '42703'; throw e; }
      return { rows: [] };
    }
    if (/SELECT provider_used, fallback_reason FROM nfce_emissions/.test(sql)) {
      if (!hasCols) { const e = new Error('column does not exist'); e.code = '42703'; throw e; }
      return { rows: [] };
    }
    if (/SELECT \* FROM nfce_config/.test(sql)) return { rows: [CONFIG_ROW] };
    if (/FROM companies WHERE id=/.test(sql)) return { rows: [COMPANY_ROW] };
    // reserva própria
    if (/UPDATE nfce_config SET next_number_sefaz_sp/.test(sql)) {
      state.ownSeriesReserved = true;
      return { rows: [{ numero: 900 }] };
    }
    // reserva gateway
    if (/UPDATE nfce_config SET next_number =/.test(sql)) {
      state.gatewaySeriesReserved = true;
      return { rows: [{ numero: 500 }] };
    }
    if (/INSERT INTO nfce_emissions/.test(sql)) {
      // params: [company, sale, tx, numero, serie, chave, ...]
      state.emission.numero = params[3];
      state.emission.serie = params[4];
      state.emission.chave_acesso = params[5];
      return { rows: [{ ...state.emission }] };
    }
    if (/SELECT id, ncm, tax_profile FROM products/.test(sql)) return { rows: [] };
    if (/UPDATE nfce_emissions SET numero=\$1, serie=\$2, chave_acesso=\$3/.test(sql)) {
      state.emission.numero = params[0];
      state.emission.serie = params[1];
      state.emission.chave_acesso = params[2];
      return { rows: [] };
    }
    if (/UPDATE nfce_emissions SET provider_used=/.test(sql)) {
      state.emission.provider_used = params[0];
      state.emission.fallback_reason = params[1];
      return { rows: [] };
    }
    if (/UPDATE nfce_emissions SET status=/.test(sql)) {
      // main persist: status é params[0]
      if (params[0] === 'rejeitada' || params[0] === 'autorizada') state.emission.status = params[0];
      return { rows: [] };
    }
    if (/UPDATE nfce_emissions SET/.test(sql)) return { rows: [] }; // rejection_code, xml_signed, etc
    if (/INSERT INTO nfce_pending_transmission/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM nfce_emissions WHERE id=/.test(sql)) return { rows: [{ ...state.emission }] };
    return { rows: [] };
  });
  return { query, connect: jest.fn(), state };
}

function buildApp(dbMock) {
  jest.resetModules();
  // re-registra os MESMOS objetos de mock no novo registro de módulos, pra
  // que o nfce.js re-required compartilhe as instâncias que este teste segura
  // (senão .mockResolvedValueOnce e o estado do breaker não seriam vistos).
  jest.doMock('../../src/config/database', () => dbMock);
  jest.doMock('../../src/services/sefazSp', () => sefazSp);
  jest.doMock('../../src/services/nuvemfiscal', () => nuvemfiscal);
  jest.doMock('../../src/services/sefazSp/engineBreaker', () => engineBreaker);
  jest.doMock('../../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  const router = require('../../src/routes/nfce');
  const a = app0();
  a.use(app0.json());
  a.use(`/c/:id/nfce`, router);
  return a;
}

const OK_RESULT = {
  status: 'autorizado', chave_acesso: '3'.repeat(44), protocolo: 'P1',
  codigo_status: '100', motivo_status: 'Autorizado', qr_code: 'qr', url_consulta: 'u',
  xml_signed: '<xml/>', tp_emis: 1, provider: 'sefaz_sp',
};

beforeEach(() => {
  jest.clearAllMocks();
  engineBreaker.reset();
});

describe('(a) THROW da engine → fallback pro gateway', () => {
  test('nota sai pelo gateway com serie do gateway + provider_used/fallback_reason', async () => {
    sefazSp.emitNfce.mockRejectedValueOnce(new Error('certificado nao decripta'));
    nuvemfiscal.emitNfce.mockResolvedValueOnce({
      status: 'autorizada', chave_acesso: '5'.repeat(44), protocolo: 'G1', qr_code: 'q', url_consulta: 'u',
    });
    const db = makeDb();
    const a = buildApp(db);
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);

    expect(res.status).toBe(201);
    expect(res.body.provider_used).toBe('nuvemfiscal');
    expect(res.body.fallback).toBe(true);
    // engine tentada, gateway chamado
    expect(sefazSp.emitNfce).toHaveBeenCalledTimes(1);
    expect(nuvemfiscal.emitNfce).toHaveBeenCalledTimes(1);
    // reservou AMBAS as séries (própria queimada + gateway)
    expect(db.state.ownSeriesReserved).toBe(true);
    expect(db.state.gatewaySeriesReserved).toBe(true);
    // gateway emitiu com serie do gateway (1) e numero 500
    const gwPayload = nuvemfiscal.emitNfce.mock.calls[0][1];
    expect(gwPayload.serie).toBe(1);
    expect(gwPayload.numero).toBe(500);
    // gravou provider_used + fallback_reason
    expect(db.state.emission.provider_used).toBe('nuvemfiscal');
    expect(db.state.emission.fallback_reason).toMatch(/^engine_error: /);
    // breaker registrou 1 falha (não abre ainda)
    expect(engineBreaker.isOpen(CID)).toBe(false);
    expect(engineBreaker.snapshot(CID).consecutiveFailures).toBe(1);
  });

  test('2 throws consecutivos abrem o breaker', async () => {
    sefazSp.emitNfce.mockRejectedValue(new Error('cert quebrado'));
    nuvemfiscal.emitNfce.mockResolvedValue({ status: 'autorizada', chave_acesso: '5'.repeat(44), protocolo: 'G' });
    const a = buildApp(makeDb());
    await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(engineBreaker.isOpen(CID)).toBe(true);
  });
});

describe('(b) contingência → SEM fallback', () => {
  test('resultado contingencia não chama o gateway', async () => {
    sefazSp.emitNfce.mockResolvedValueOnce({
      status: 'contingencia', chave_acesso: '9'.repeat(44), qr_code: 'qc', url_consulta: 'u',
      xml_signed: '<x/>', tp_emis: 9, contingency_at: '2026-07-04T10:00:00-03:00', provider: 'sefaz_sp',
    });
    const db = makeDb();
    const a = buildApp(db);
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(201);
    expect(nuvemfiscal.emitNfce).not.toHaveBeenCalled();
    expect(res.body.provider_used).toBe('sefaz_sp');
    expect(res.body.fallback).toBe(false);
    expect(res.body.contingencia).toBe(true);
    expect(db.state.emission.provider_used).toBe('sefaz_sp');
    // contingência não conta como sucesso NEM falha do breaker
    expect(engineBreaker.snapshot(CID).consecutiveFailures).toBe(0);
    expect(engineBreaker.isOpen(CID)).toBe(false);
  });
});

describe('(c) rejeição → SEM fallback + breaker não abre', () => {
  test('rejeitado conta como sucesso pro breaker; gateway não é chamado', async () => {
    sefazSp.emitNfce.mockResolvedValue({
      status: 'rejeitado', chave_acesso: '3'.repeat(44), codigo_status: '778',
      motivo_status: 'NCM inexistente', xml_signed: '<x/>', tp_emis: 1, provider: 'sefaz_sp',
    });
    const db = makeDb();
    const a = buildApp(db);
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(201);
    expect(nuvemfiscal.emitNfce).not.toHaveBeenCalled();
    expect(res.body.provider_used).toBe('sefaz_sp');
    expect(res.body.fallback).toBe(false);
    expect(db.state.emission.provider_used).toBe('sefaz_sp');
    // engine funcionou (SEFAZ respondeu) → sucesso pro breaker
    expect(engineBreaker.snapshot(CID).consecutiveFailures).toBe(0);
    // mesmo 2 rejeições NÃO abrem o breaker
    await supertest(buildApp(makeDb())).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(engineBreaker.isOpen(CID)).toBe(false);
  });
});

describe('(d) breaker aberto → direto ao gateway', () => {
  test('não tenta a engine; fallback_reason breaker_open', async () => {
    engineBreaker.recordFailure(CID);
    engineBreaker.recordFailure(CID); // abre
    expect(engineBreaker.isOpen(CID)).toBe(true);

    nuvemfiscal.emitNfce.mockResolvedValueOnce({ status: 'autorizada', chave_acesso: '5'.repeat(44), protocolo: 'G' });
    const db = makeDb();
    const a = buildApp(db);
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(201);
    expect(sefazSp.emitNfce).not.toHaveBeenCalled(); // engine NÃO tentada
    expect(nuvemfiscal.emitNfce).toHaveBeenCalledTimes(1);
    expect(res.body.provider_used).toBe('nuvemfiscal');
    expect(res.body.fallback).toBe(true);
    expect(db.state.emission.fallback_reason).toBe('breaker_open');
    // reservou só a série do gateway (não a própria)
    expect(db.state.gatewaySeriesReserved).toBe(true);
    expect(db.state.ownSeriesReserved).toBe(false);
  });
});

describe('(e) colunas ausentes (42703) → comportamento legado', () => {
  test('sem fallback, série única do gateway, provider_used não gravado', async () => {
    // provider sefaz_sp mas SEM as colunas da 176 → useSefazSp fica false
    nuvemfiscal.emitNfce.mockResolvedValueOnce({ status: 'autorizada', chave_acesso: '5'.repeat(44), protocolo: 'G' });
    const db = makeDb({ hasCols: false });
    const a = buildApp(db);
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send(EMIT_BODY);
    expect(res.status).toBe(201);
    // engine nunca tentada (sem colunas não há fallback seguro); gateway direto
    expect(sefazSp.emitNfce).not.toHaveBeenCalled();
    expect(nuvemfiscal.emitNfce).toHaveBeenCalledTimes(1);
    // série única do gateway
    expect(db.state.gatewaySeriesReserved).toBe(true);
    expect(db.state.ownSeriesReserved).toBe(false);
    // provider_used NÃO gravado (persistProviderUsed é no-op sem colunas)
    expect(db.state.emission.provider_used).toBeNull();
  });
});
