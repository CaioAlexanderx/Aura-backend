// ============================================================
// 08/11/2026 — POST /companies/:id/nfce/config é update PARCIAL.
//
// Bug: o ON CONFLICT reescrevia serie/ambiente/uf/IE/CSC com os defaults
// (homologacao, SP, null) quando o campo não vinha no corpo. O RegimeFiscal
// do app (Matcon) manda só { regime } — trocar o regime de uma loja em
// produção a voltava para homologação e apagava IE e CSC. Linha nova nascia
// com provider 'nuvemfiscal' (gateway que não existe mais).
//
// O mock de db.query aqui é um nfce_config/companies em memória que
// interpreta o SQL que a rota emite (INSERT ... ON CONFLICT DO UPDATE SET
// col=EXCLUDED.col), então os testes conferem o ESTADO final da linha, não
// só o texto do SQL.
// ============================================================
const supertest = require('supertest');
const app0 = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/sefazSp', () => ({ emitNfce: jest.fn() }));
jest.mock('../../src/services/nuvemfiscal', () => ({
  emitNfce: jest.fn(), emitNfe: jest.fn(), queryNfce: jest.fn(), queryNfe: jest.fn(),
  ufToCodigo: () => 35, isoBR: () => '2026-11-08T10:00:00-03:00',
}));

const sefazSp = require('../../src/services/sefazSp');
const nuvemfiscal = require('../../src/services/nuvemfiscal');

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

// Loja configurada pela equipe: produção, IE, CSC, engine própria.
const CONFIG_PRODUCAO = {
  id: 'cfg-1', company_id: CID, serie_nfce: 3, next_number: 120, ambiente: 'producao',
  uf: 'SP', inscricao_estadual: '111222333444', is_active: true, csc_id: '000001',
  csc_token: 'TOKEN-CSC', csc_token_enc: 'ENC', auto_emit_nfce: false,
  provider: 'sefaz_sp', serie_sefaz_sp: 5, next_number_sefaz_sp: 900,
};

const COLS_237 = ['provider', 'serie_sefaz_sp', 'next_number_sefaz_sp'];

function makeDb({ config = null, taxRegime = 'simples_nacional', hasCols = true } = {}) {
  const state = {
    config: config ? { ...config } : null,
    company: { id: CID, tax_regime: taxRegime },
    audit: [],
  };
  const query = jest.fn(async (sql, params = []) => {
    if (/SELECT tax_regime FROM companies WHERE id=\$1/.test(sql)) return { rows: [{ tax_regime: state.company.tax_regime }] };
    if (/UPDATE companies SET tax_regime=\$1/.test(sql)) { state.company.tax_regime = params[0]; return { rows: [] }; }
    if (/INSERT INTO audit_log/.test(sql)) { state.audit.push({ action: params[2], metadata: JSON.parse(params[4]) }); return { rows: [] }; }

    if (/INSERT INTO nfce_config/.test(sql)) {
      const cols = sql.match(/INSERT INTO nfce_config \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
      if (!hasCols && cols.some((c) => COLS_237.includes(c))) {
        const e = new Error('column "provider" does not exist'); e.code = '42703'; throw e;
      }
      const excluded = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
      if (state.config) {
        const upd = sql.split('DO UPDATE SET')[1];
        for (const [, col] of upd.matchAll(/(\w+)=EXCLUDED\.(\w+)/g)) state.config[col] = excluded[col];
        state.config.updated_at = 'now';
      } else {
        state.config = { id: 'cfg-novo', next_number: 1, is_active: false, ...excluded };
      }
      return { rows: [{ ...state.config }] };
    }
    if (/FROM nfce_config WHERE company_id/.test(sql)) {
      if (!hasCols && /serie_sefaz_sp/.test(sql)) { const e = new Error('no col'); e.code = '42703'; throw e; }
      return { rows: state.config ? [{ ...state.config }] : [] };
    }
    throw new Error('SQL inesperado no teste: ' + sql);
  });
  return { query, queryRetry: query, connect: jest.fn(), state };
}

function buildApp(dbMock) {
  jest.resetModules();
  jest.doMock('../../src/config/database', () => dbMock);
  jest.doMock('../../src/services/sefazSp', () => sefazSp);
  jest.doMock('../../src/services/nuvemfiscal', () => nuvemfiscal);
  const router = require('../../src/routes/nfce');
  const a = app0();
  a.use(app0.json());
  a.use('/c/:id/nfce', router);
  return a;
}

const post = (a, body) => supertest(a).post(`/c/${CID}/nfce/config`).set(auth).send(body);
const nfceSqls = (db) => db.query.mock.calls.map((c) => c[0]).filter((s) => /nfce_config/.test(s));

describe('POST /nfce/config — só o regime', () => {
  test('loja em produção: regime grava em companies.tax_regime e a config fiscal fica intacta', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO });
    const res = await post(buildApp(db), { regime: 'presumido' });

    expect(res.status).toBe(200);
    expect(db.state.config).toEqual(CONFIG_PRODUCAO); // ambiente, uf, IE, CSC, provider, série: nada mudou
    expect(nfceSqls(db).some((s) => /INSERT INTO nfce_config|UPDATE nfce_config/.test(s))).toBe(false);
    expect(db.state.company.tax_regime).toBe('lucro_presumido');
    expect(res.body.regime).toBe('presumido');
    expect(res.body.config.regime).toBe('presumido');
    expect(res.body.config.ambiente).toBe('producao');
    expect(db.state.audit).toEqual([{ action: 'tax_regime.changed',
      metadata: { de: 'simples_nacional', para: 'lucro_presumido', origem: 'nfe_regime_fiscal' } }]);
  });

  test('empresa sem config: só o regime não cria linha em nfce_config', async () => {
    const db = makeDb({ config: null });
    const res = await post(buildApp(db), { regime: 'real' });
    expect(res.status).toBe(200);
    expect(db.state.config).toBeNull();
    expect(res.body.config).toBeNull();
    expect(res.body.regime).toBe('real');
    expect(db.state.company.tax_regime).toBe('lucro_real');
  });

  test('MEI que escolhe "Simples Nacional" continua MEI (CRT não muda)', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO, taxRegime: 'mei' });
    const res = await post(buildApp(db), { regime: 'simples' });
    expect(res.status).toBe(200);
    expect(db.state.company.tax_regime).toBe('mei');
    expect(db.query.mock.calls.some((c) => /UPDATE companies/.test(c[0]))).toBe(false);
    expect(db.state.audit).toEqual([]);
    expect(res.body.regime).toBe('simples');
  });

  test('regime inválido → 400 sem gravar nada', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO });
    const res = await post(buildApp(db), { regime: 'mei' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /nfce/config — update parcial dos campos fiscais', () => {
  test('só auto_emit_nfce: o resto da config fica como estava', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO });
    const res = await post(buildApp(db), { auto_emit_nfce: true });
    expect(res.status).toBe(200);
    expect(db.state.config).toEqual({ ...CONFIG_PRODUCAO, auto_emit_nfce: true, updated_at: 'now' });
  });

  test('regime + IE: grava a IE e o regime, sem tocar ambiente/uf/CSC/provider/série', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO });
    const res = await post(buildApp(db), { regime: 'simples', inscricao_estadual: '999888777666' });
    expect(res.status).toBe(200);
    expect(db.state.config).toEqual({ ...CONFIG_PRODUCAO, inscricao_estadual: '999888777666', updated_at: 'now' });
    expect(db.state.company.tax_regime).toBe('simples_nacional');
  });

  test('null em IE/CSC limpa de propósito; null em ambiente/uf não apaga', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO });
    await post(buildApp(db), { csc_id: null, ambiente: null, uf: '' });
    expect(db.state.config.csc_id).toBeNull();
    expect(db.state.config.ambiente).toBe('producao');
    expect(db.state.config.uf).toBe('SP');
    expect(db.state.config.csc_token).toBe('TOKEN-CSC');
  });

  test('linha nova nasce com provider NULL (modo AUTO), nunca nuvemfiscal', async () => {
    const db = makeDb({ config: null });
    const res = await post(buildApp(db), { inscricao_estadual: '123456789012' });
    expect(res.status).toBe(200);
    expect(db.state.config.provider).toBeNull();
    expect(db.state.config).toMatchObject({
      serie_nfce: 1, ambiente: 'homologacao', uf: 'SP', inscricao_estadual: '123456789012',
      csc_id: null, csc_token: null, auto_emit_nfce: false, serie_sefaz_sp: 2,
    });
    const insert = db.query.mock.calls.find((c) => /INSERT INTO nfce_config/.test(c[0]));
    expect(JSON.stringify(insert)).not.toMatch(/nuvemfiscal/);
  });

  test('nunca escreve is_active, csc_token_enc nem contadores', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO });
    await post(buildApp(db), { serie_nfce: 4, ambiente: 'producao', uf: 'SP', inscricao_estadual: '1',
      csc_id: '2', csc_token: '3', auto_emit_nfce: true, provider: 'sefaz_sp', serie_sefaz_sp: 6,
      is_active: false, csc_token_enc: 'X', next_number: 1 });
    const insert = db.query.mock.calls.find((c) => /INSERT INTO nfce_config/.test(c[0]))[0];
    expect(insert).not.toMatch(/is_active|csc_token_enc|next_number/);
    expect(db.state.config).toMatchObject({ is_active: true, csc_token_enc: 'ENC', next_number: 120, serie_sefaz_sp: 6 });
  });

  test('caminho legado (migration 237 ausente): também parcial', async () => {
    const legacy = { ...CONFIG_PRODUCAO };
    for (const c of COLS_237) delete legacy[c];
    const db = makeDb({ config: legacy, hasCols: false });
    const res = await post(buildApp(db), { regime: 'presumido', csc_id: '000009' });
    expect(res.status).toBe(200);
    expect(db.state.config).toEqual({ ...legacy, csc_id: '000009', updated_at: 'now' });
    expect(db.state.company.tax_regime).toBe('lucro_presumido');
  });

  test('provider sefaz_sp sem uf no corpo valida a UF gravada', async () => {
    const db = makeDb({ config: { ...CONFIG_PRODUCAO, uf: 'RJ', provider: null } });
    const res = await post(buildApp(db), { provider: 'sefaz_sp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UF RJ/);
    expect(res.body.error).toMatch(/MG/); // a lista de UFs vem do mapa de endpoints
    expect(db.state.config.provider).toBeNull();
  });

  test('08/11/2026: provider sefaz_sp em MG é aceito (MG entrou no mapa de endpoints)', async () => {
    const db = makeDb({ config: { ...CONFIG_PRODUCAO, uf: 'MG', provider: null } });
    const res = await post(buildApp(db), { provider: 'sefaz_sp' });
    expect(res.status).toBe(200);
    expect(db.state.config.provider).toBe('sefaz_sp');
    expect(db.state.config.uf).toBe('MG');
  });
});

describe('GET /nfce/config — regime vem de companies.tax_regime', () => {
  test('com config: regime dentro da config e no topo', async () => {
    const db = makeDb({ config: CONFIG_PRODUCAO, taxRegime: 'lucro_real' });
    const res = await supertest(buildApp(db)).get(`/c/${CID}/nfce/config`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.config.regime).toBe('real');
    expect(res.body.regime).toBe('real');
  });

  test('sem config: regime no topo (MEI lê como simples)', async () => {
    const db = makeDb({ config: null, taxRegime: 'mei' });
    const res = await supertest(buildApp(db)).get(`/c/${CID}/nfce/config`).set(auth);
    expect(res.body.config).toBeNull();
    expect(res.body.regime).toBe('simples');
  });
});
