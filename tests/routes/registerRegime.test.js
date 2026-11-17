// ============================================================
// AURA. -- Testes: regime da Receita no cadastro (b-tq-regime-cadastro, 17/11/2026)
//
// Desde 19/10 o register usava so o `tax_regime` do corpo; o cadastro do
// site (/comecar) nunca mandou o campo e todo cadastro pelo site nascia
// simples_nacional, MEI inclusive. O que estes testes travam:
//   1. cadastro do site sem o campo: vale o regime da Receita
//   2. MEI na Receita vira `mei`, mesmo com o corpo dizendo outra coisa
//   3. Receita fora do ar: o comportamento de antes (corpo ou default), 201
//   4. Receita sem dado confiavel (estimado): o comportamento de antes
//   5. cadastro com CPF: nada muda, sem consulta
//   6. uma consulta so (a cidade reaproveita a resposta)
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const request = require('supertest');

let app, db, cnpjService;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  cnpjService = require('../../src/services/cnpj');
});

const cid = '00000000-0000-0000-0000-000000000002';
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();
let logs;

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function clienteDoCadastro() {
  const chamadas = [];
  const client = { release: jest.fn() };
  client.query = jest.fn(async (sql, params) => {
    const s = limpo(sql);
    chamadas.push({ sql: s, params });
    if (s.startsWith('SELECT id FROM users WHERE email')) return { rows: [] };
    if (s.startsWith('INSERT INTO users')) {
      return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client', is_staff: false, email_verified: true, created_at: new Date() }] };
    }
    if (s.includes('FROM access_codes WHERE code')) {
      return { rows: [{ id: 'ac1', type: 'trial', plan: 'negocio', discount_pct: 0, trial_days: 7, max_uses: 999999, uses: 1, expires_at: null, is_active: true, referrer_id: null }] };
    }
    if (s.includes('FROM companies WHERE cnpj')) return { rows: [] };
    if (s.startsWith('INSERT INTO companies')) {
      return { rows: [{ id: cid, legal_name: params[1], trade_name: params[1], plan: params[2], onboarding_step: 'cnpj', trial_ends_at: params[3], access_code_used: params[4], module_overrides: null, tax_regime: params[9] || 'simples_nacional' }] };
    }
    return { rows: [] };
  });
  db.connect.mockResolvedValueOnce(client);
  return { chamadas };
}

const regimeNoInsert = (chamadas) => {
  const ins = chamadas.find((c) => c.sql.startsWith('INSERT INTO companies'));
  return ins ? ins.params[9] : undefined;
};
const logDoCadastro = () => {
  const linha = logs.find((l) => l.startsWith('[REGIME]') && l.includes('"evento":"cadastro"'));
  return linha ? JSON.parse(linha.slice('[REGIME] '.length)) : null;
};

const CNPJ = '11222333000181';
// O que lookupCNPJ devolve (formato de services/cnpj._montar).
const receita = (regime, extra = {}) => ({
  cnpj_raw: CNPJ, suggested_regime: regime, regime_fonte: 'receita', regime_confirmar: false,
  mei_optante: regime === 'mei', simples_optante: regime !== 'lucro_presumido', rf_fonte: 'cnpj.ws',
  address_city: 'Jacarei', address_state: 'SP', ...extra,
});

// Corpo igual ao do aura-site js/comecar.js: sem tax_regime, com COMECAR.
const cadastroDoSite = (extra = {}) => request(app).post('/api/v1/auth/register').send({
  name: 'Ana', email: 'ana@loja.com', password: 'senha1234', phone: '11987654321',
  company_name: 'Loja da Ana', cnpj: '11.222.333/0001-81', access_code: 'COMECAR', terms_accepted: true, ...extra,
});

describe('POST /auth/register -- regime pela Receita', () => {
  test('cadastro do site sem tax_regime: grava o regime da Receita (simples_nacional)', async () => {
    const { chamadas } = clienteDoCadastro();
    cnpjService.lookupCNPJ.mockResolvedValueOnce(receita('simples_nacional'));
    const res = await cadastroDoSite();
    expect(res.status).toBe(201);
    expect(regimeNoInsert(chamadas)).toBe('simples_nacional');
    expect(logDoCadastro()).toMatchObject({ origem_regime: 'receita', via_coalesce: false, regime_do_app: '(ausente)' });
  });

  test('MEI na Receita, cadastro do site sem tax_regime: grava mei (antes caia no COALESCE)', async () => {
    const { chamadas } = clienteDoCadastro();
    cnpjService.lookupCNPJ.mockResolvedValueOnce(receita('mei'));
    const res = await cadastroDoSite();
    expect(res.status).toBe(201);
    expect(regimeNoInsert(chamadas)).toBe('mei');
    expect(res.body.company.tax_regime).toBe('mei');
  });

  test('MEI na Receita e o corpo diz simples_nacional: vale a Receita', async () => {
    const { chamadas } = clienteDoCadastro();
    cnpjService.lookupCNPJ.mockResolvedValueOnce(receita('mei'));
    const res = await cadastroDoSite({ tax_regime: 'simples_nacional' });
    expect(res.status).toBe(201);
    expect(regimeNoInsert(chamadas)).toBe('mei');
    expect(logDoCadastro().motivo_regime).toContain('divergia');
  });

  test('Receita fora do Simples e o corpo diz lucro_real: fica lucro_real (a Receita nao distingue)', async () => {
    const { chamadas } = clienteDoCadastro();
    cnpjService.lookupCNPJ.mockResolvedValueOnce(receita('lucro_presumido', { regime_confirmar: true }));
    const res = await cadastroDoSite({ tax_regime: 'lucro_real' });
    expect(res.status).toBe(201);
    expect(regimeNoInsert(chamadas)).toBe('lucro_real');
  });

  test('Receita fora do ar e corpo sem regime: o de hoje (default da coluna), cadastro fecha', async () => {
    const { chamadas } = clienteDoCadastro();
    cnpjService.lookupCNPJ.mockRejectedValueOnce(Object.assign(new Error('Nao conseguimos consultar a Receita agora.'), { status: 503 }));
    const res = await cadastroDoSite();
    expect(res.status).toBe(201);
    expect(regimeNoInsert(chamadas)).toBeNull();
    expect(chamadas.some((c) => c.sql === 'COMMIT')).toBe(true);
    const log = logDoCadastro();
    expect(log).toMatchObject({ origem_regime: 'padrao', via_coalesce: true });
    expect(log.motivo_regime).toContain('consulta falhou');
  });

  test('Receita fora do ar e o app mandou mei: grava mei, como hoje', async () => {
    const { chamadas } = clienteDoCadastro();
    cnpjService.lookupCNPJ.mockRejectedValueOnce(new Error('CNPJ lookup timeout'));
    const res = await cadastroDoSite({ tax_regime: 'mei', access_code: undefined, self_serve: true });
    expect(res.status).toBe(201);
    expect(regimeNoInsert(chamadas)).toBe('mei');
    expect(logDoCadastro().origem_regime).toBe('corpo');
  });

  test('Receita sem o dado do MEI (estimado): nao afirma regime, fica o de hoje', async () => {
    const { chamadas } = clienteDoCadastro();
    cnpjService.lookupCNPJ.mockResolvedValueOnce(receita('simples_nacional', { regime_fonte: 'estimado', regime_confirmar: true, rf_fonte: 'brasilapi' }));
    const res = await cadastroDoSite();
    expect(res.status).toBe(201);
    expect(regimeNoInsert(chamadas)).toBeNull();
    expect(logDoCadastro().motivo_regime).toContain('estimado');
  });

  test('consulta a Receita uma vez so: a cidade em segundo plano reaproveita a resposta', async () => {
    clienteDoCadastro();
    cnpjService.lookupCNPJ.mockResolvedValueOnce(receita('mei'));
    const res = await cadastroDoSite();
    expect(res.status).toBe(201);
    let upd;
    for (let i = 0; i < 20 && !upd; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      upd = db.query.mock.calls.find((c) => limpo(c[0]).startsWith('UPDATE companies SET address_city'));
    }
    expect(upd).toBeDefined();
    expect(upd[1]).toEqual([cid, 'Jacarei', 'SP']);
    expect(cnpjService.lookupCNPJ).toHaveBeenCalledTimes(1);
    expect(cnpjService.lookupCNPJ.mock.calls[0][0]).toBe(CNPJ);
  });

  test('cadastro com CPF ("Nao tenho CNPJ"): sem consulta e sem regime, como antes', async () => {
    const { chamadas } = clienteDoCadastro();
    const res = await cadastroDoSite({ cnpj: undefined, cpf: '529.982.247-25', tax_regime: 'mei' });
    expect(res.status).toBe(201);
    expect(cnpjService.lookupCNPJ).not.toHaveBeenCalled();
    expect(regimeNoInsert(chamadas)).toBeNull();
    expect(logDoCadastro().origem_regime).toBe('cpf');
  });
});
