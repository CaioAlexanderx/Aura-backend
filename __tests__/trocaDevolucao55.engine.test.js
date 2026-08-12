/**
 * trocaDevolucao55 — roteamento engine própria (Aura Notas) × gateway.
 *
 * Regras cobertas (mesma semântica S4.2 do PDV):
 *  - empresa apta (A1 vigente + UF SP) → emite pela engine; gateway intocado
 *  - THROW da engine → breaker + fallback pro gateway na MESMA chamada
 *  - rejeição da SEFAZ via engine → SEM fallback (problema de dado)
 *  - sem A1 vigente → direto gateway
 *  - kill-switch provider='nuvemfiscal' → direto gateway
 *  - breaker aberto → direto gateway (fallback_reason='breaker_open')
 *  - 12/08/2026: numeração da 55 = série própria (serie_nfe55, default 2) +
 *    contador atômico next_number_nfe55 no nfce_config (fix Rejeição 539 —
 *    a série 1 do CNPJ pode ter números queimados por ERP anterior);
 *    fallback legado MAX+1 série 1 quando a migration 278 não existe.
 *
 * Mocks do db POR CONTEÚDO do SQL (nunca fila posicional).
 */

'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/nuvemfiscal', () => ({ emitNfeDevolucao: jest.fn() }));
jest.mock('../src/services/sefazSp/nfe55', () => ({ emitNfeDevolucao55: jest.fn() }));

const db = require('../src/config/database');
const nuvemfiscal = require('../src/services/nuvemfiscal');
const nfe55 = require('../src/services/sefazSp/nfe55');
const engineBreaker = require('../src/services/sefazSp/engineBreaker');
const trocaDevolucao55 = require('../src/services/trocaDevolucao55');

const COMPANY_ID = 'c-davi';
const CHAVE_ORIG = '35260747123119000204650300000000281951475443';

const COMPANY_ROW = {
  id: COMPANY_ID, cnpj: '47123119000204',
  legal_name: 'Davi Calcados LTDA', trade_name: 'Davi Calcados',
  inscricao_estadual: '123456789012', ibge_code: '3524402',
  address_street: 'Rua X', address_number: '10', address_city: 'Jacarei',
  address_state: 'SP', address_zip: '12300000', tax_regime: 'simples',
};

const CONFIG_ROW = { company_id: COMPANY_ID, uf: 'SP', ambiente: 'producao', provider: null };

const ENGINE_OK = {
  id: null, status: 'autorizado', chave_acesso: '3'.repeat(20) + '55' + '4'.repeat(22),
  protocolo: '135260000000001', codigo_status: '100',
  motivo_status: 'Autorizado o uso da NF-e', xml_signed: '<NFe>assinada</NFe>',
  tp_emis: 1, provider: 'sefaz_sp',
};

const GATEWAY_OK = {
  id: 'nfe_abc', status: 'autorizado', chave_acesso: '5'.repeat(44),
  codigo_status: '100', motivo_status: 'Autorizado o uso da NF-e',
};

/**
 * db.query roteado pelo CONTEÚDO do SQL. `overrides`:
 *   config:   null (sem linha) | objeto (linha do nfce_config)
 *   cert:     false → sem A1 vigente
 *   serieCfg: false → migration 278 ausente (UPDATE do contador → 42703,
 *             cai no legado MAX+1 série 1)
 */
function mockDbBySql(overrides = {}) {
  const inserts = [];
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (s.includes("tipo = 'nfce'") && s.includes('FROM nfce_emissions')) {
      return { rows: [{ id: 'orig-1', chave_acesso: CHAVE_ORIG, numero: 281, customer_cpf: '12345678901', customer_name: 'Maria', authorized_at: new Date() }] };
    }
    if (s.includes('next_number_nfe55')) {
      if (overrides.serieCfg === false) {
        const err = new Error('column "next_number_nfe55" does not exist');
        err.code = '42703';
        throw err;
      }
      return { rows: [{ serie_nfe55: 2, numero: 7 }] };
    }
    if (s.includes('next_numero')) return { rows: [{ next_numero: 7 }] };
    if (s.includes('FROM companies')) return { rows: [COMPANY_ROW] };
    if (s.includes('FROM products')) return { rows: [] };
    if (s.includes('FROM nfce_config')) {
      if (overrides.config === null) return { rows: [] };
      return { rows: [overrides.config || CONFIG_ROW] };
    }
    if (s.includes('FROM company_certificates')) {
      return overrides.cert === false ? { rows: [] } : { rows: [{ '?column?': 1 }] };
    }
    if (s.includes('INSERT INTO nfce_emissions')) {
      inserts.push({ sql: s, params });
      return { rows: [] };
    }
    if (s.includes('UPDATE sales')) return { rows: [] };
    throw new Error('SQL não mapeado no mock: ' + s.slice(0, 80));
  });
  return { inserts };
}

function callHandle() {
  return trocaDevolucao55.handle(null, {
    saleCompanyId: COMPANY_ID,
    originalSaleId: 'sale-1',
    trocaSaleId: 'troca-1',
    returnedItems: [{ product_id: 'p1', product_name_snapshot: 'Tenis', quantity: '1', unit_price: '249.99', ncm: '64041900' }],
    returnedValue: 249.99,
    notes: 'Troca',
    userId: 'u1',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  engineBreaker.reset();
});

describe('trocaDevolucao55 — roteamento engine × gateway', () => {
  it('empresa apta → engine própria; gateway NÃO é chamado; INSERT com provider sefaz_sp + xml_signed', async () => {
    const { inserts } = mockDbBySql();
    nfe55.emitNfeDevolucao55.mockResolvedValue(ENGINE_OK);

    const out = await callHandle();

    expect(nfe55.emitNfeDevolucao55).toHaveBeenCalledTimes(1);
    expect(nuvemfiscal.emitNfeDevolucao).not.toHaveBeenCalled();
    expect(out.status).toBe('autorizada');
    expect(out.provider_used).toBe('sefaz_sp');
    expect(out.fallback).toBe(false);
    expect(out.devolucao_chave).toBe(ENGINE_OK.chave_acesso);

    // payload da engine = MESMO payload do gateway (chave original, itens,
    // numero) — 12/08: serie/numero vem do contador atômico (serie 2, nº 7)
    const [companyArg, paramsArg, ctxArg] = nfe55.emitNfeDevolucao55.mock.calls[0];
    expect(companyArg.cnpj).toBe(COMPANY_ROW.cnpj);
    expect(paramsArg.originalChave).toBe(CHAVE_ORIG);
    expect(paramsArg.numero).toBe(7);
    expect(paramsArg.serie).toBe(2);
    expect(paramsArg.items[0].cfop).toBe('1202');
    expect(ctxArg.config).toEqual(CONFIG_ROW);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toEqual(expect.arrayContaining(['sefaz_sp', '<NFe>assinada</NFe>']));
    // serie persistida no INSERT (não mais literal 1)
    expect(inserts[0].params).toEqual(expect.arrayContaining([2]));
    // xml_signed NÃO duplicado no metadata
    const metaParam = inserts[0].params.find((p) => typeof p === 'string' && p.startsWith('{') && p.includes('chave_acesso'));
    expect(metaParam).not.toContain('assinada');
  });

  it('migration 278 ausente (42703 no contador) → fallback legado: MAX+1 na série 1', async () => {
    mockDbBySql({ serieCfg: false });
    nfe55.emitNfeDevolucao55.mockResolvedValue(ENGINE_OK);

    const out = await callHandle();

    expect(out.status).toBe('autorizada');
    expect(out.devolucao_serie).toBe(1);
    expect(out.devolucao_numero).toBe(7);
    const [, paramsArg] = nfe55.emitNfeDevolucao55.mock.calls[0];
    expect(paramsArg.serie).toBe(1);
    expect(paramsArg.numero).toBe(7);
  });

  it('THROW da engine → fallback pro gateway com fallback_reason=engine_error e breaker registrado', async () => {
    const { inserts } = mockDbBySql();
    nfe55.emitNfeDevolucao55.mockRejectedValue(new Error('CSC/cert: falha ao assinar'));
    nuvemfiscal.emitNfeDevolucao.mockResolvedValue(GATEWAY_OK);

    const out = await callHandle();

    expect(nfe55.emitNfeDevolucao55).toHaveBeenCalledTimes(1);
    expect(nuvemfiscal.emitNfeDevolucao).toHaveBeenCalledTimes(1);
    expect(out.provider_used).toBe('nuvemfiscal');
    expect(out.fallback).toBe(true);
    expect(out.fallback_reason).toMatch(/^engine_error: /);
    expect(engineBreaker.snapshot(COMPANY_ID).consecutiveFailures).toBe(1);
    expect(inserts[0].params).toEqual(expect.arrayContaining(['nuvemfiscal']));
  });

  it('rejeição da SEFAZ via engine → SEM fallback (problema de dado) e breaker fechado', async () => {
    mockDbBySql();
    nfe55.emitNfeDevolucao55.mockResolvedValue({
      ...ENGINE_OK, status: 'rejeitado', protocolo: null,
      codigo_status: '778', motivo_status: 'Informado NCM inexistente',
    });

    const out = await callHandle();

    expect(nuvemfiscal.emitNfeDevolucao).not.toHaveBeenCalled();
    expect(out.status).toBe('rejeitada');
    expect(out.motivo).toBe('778 - Informado NCM inexistente');
    expect(out.error_message).toContain('778');
    expect(engineBreaker.snapshot(COMPANY_ID).consecutiveFailures).toBe(0);
  });

  it('sem A1 vigente → direto gateway (engine nem é tentada)', async () => {
    mockDbBySql({ cert: false });
    nuvemfiscal.emitNfeDevolucao.mockResolvedValue(GATEWAY_OK);

    const out = await callHandle();

    expect(nfe55.emitNfeDevolucao55).not.toHaveBeenCalled();
    expect(out.provider_used).toBe('nuvemfiscal');
    expect(out.fallback).toBe(false);
  });

  it("kill-switch provider='nuvemfiscal' → direto gateway", async () => {
    mockDbBySql({ config: { ...CONFIG_ROW, provider: 'nuvemfiscal' } });
    nuvemfiscal.emitNfeDevolucao.mockResolvedValue(GATEWAY_OK);

    await callHandle();

    expect(nfe55.emitNfeDevolucao55).not.toHaveBeenCalled();
    expect(nuvemfiscal.emitNfeDevolucao).toHaveBeenCalledTimes(1);
  });

  it('breaker aberto → direto gateway com fallback_reason=breaker_open', async () => {
    mockDbBySql();
    engineBreaker.recordFailure(COMPANY_ID);
    engineBreaker.recordFailure(COMPANY_ID); // 2 falhas = janela aberta
    nuvemfiscal.emitNfeDevolucao.mockResolvedValue(GATEWAY_OK);

    const out = await callHandle();

    expect(nfe55.emitNfeDevolucao55).not.toHaveBeenCalled();
    expect(out.provider_used).toBe('nuvemfiscal');
    expect(out.fallback_reason).toBe('breaker_open');
  });

  it('engine E gateway falham → TrocaDevolucao55Error 502 com fallback_reason no body', async () => {
    mockDbBySql();
    nfe55.emitNfeDevolucao55.mockRejectedValue(new Error('engine down'));
    nuvemfiscal.emitNfeDevolucao.mockRejectedValue(new Error('Nuvem Fiscal fora do ar'));

    await expect(callHandle()).rejects.toMatchObject({
      isDevolucao55Error: true,
      status: 502,
      body: expect.objectContaining({
        fallback_reason: expect.stringMatching(/^engine_error: engine down/),
      }),
    });
  });

  it('migration 234/237 ausente (42703) → INSERT legado sem as colunas novas', async () => {
    const inserts = [];
    mockDbBySql();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (s.includes('INSERT INTO nfce_emissions')) {
        inserts.push({ sql: s, params });
        if (s.includes('provider_used')) {
          const err = new Error('column "provider_used" does not exist');
          err.code = '42703';
          throw err;
        }
        return { rows: [] };
      }
      return base(sql, params);
    });
    nfe55.emitNfeDevolucao55.mockResolvedValue(ENGINE_OK);

    const out = await callHandle();

    expect(out.status).toBe('autorizada');
    expect(inserts).toHaveLength(2);
    expect(inserts[1].sql).not.toContain('provider_used');
    // 12/08: base ganhou a coluna serie parametrizada → 16 valores
    expect(inserts[1].params).toHaveLength(16);
  });
});
