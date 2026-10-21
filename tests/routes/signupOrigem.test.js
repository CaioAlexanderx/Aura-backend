// ============================================================
// AURA. -- Testes: origem do cadastro (card t2-09, 15/10/2026)
//
// O site manda `origem` (primeiro toque: UTM, pagina de entrada, referrer) em
// POST /auth/register. O que estes testes travam:
//   1. aceita e grava em companies.signup_origin (empresa NOVA, na transacao,
//      atras de SAVEPOINT, depois do INSERT da empresa e antes do COMMIT)
//   2. ignora chave estranha; corta tamanho; landing_page sem query/hash;
//      referrer so o host
//   3. sem `origem` (ou invalida) nada muda: nenhuma query a mais
//   4. migration 387 pendente (42703): o cadastro nao cai
//   5. entrar numa empresa existente pelo CNPJ nao grava origem
//   6. a cidade do CNPJ e gravada em segundo plano (sem sobrescrever)
//   7. o bloco Cadastros do painel mostra fonte/campanha so quando ha dado
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

const cid = '00000000-0000-0000-0000-000000000001';
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function clienteDoCadastro({ semMigration = false, empresaExistente = false } = {}) {
  const sqls = [];
  const chamadas = [];
  const client = { release: jest.fn() };
  client.query = jest.fn(async (sql, params) => {
    const s = limpo(sql);
    sqls.push(s);
    chamadas.push({ sql: s, params });
    if (s.startsWith('SELECT id FROM users WHERE email')) return { rows: [] };
    if (s.startsWith('INSERT INTO users')) {
      return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client', is_staff: false, email_verified: true, created_at: new Date() }] };
    }
    if (s.includes('FROM companies WHERE cnpj')) {
      return { rows: empresaExistente ? [{ id: 'c-existente', plan: 'negocio' }] : [] };
    }
    if (s.startsWith('INSERT INTO companies')) {
      return { rows: [{ id: cid, legal_name: params[1], trade_name: params[1], plan: params[2], onboarding_step: 'cnpj', trial_ends_at: params[3], access_code_used: params[4], module_overrides: null }] };
    }
    if (s.startsWith('UPDATE companies SET signup_origin')) {
      if (semMigration) throw Object.assign(new Error('column "signup_origin" of relation "companies" does not exist'), { code: '42703' });
      return { rows: [] };
    }
    return { rows: [] };
  });
  db.connect.mockResolvedValueOnce(client);
  return { sqls, chamadas };
}

const cadastrar = (extra = {}) => request(app).post('/api/v1/auth/register').send({
  name: 'Ana', email: 'ana@loja.com', password: 'senha1234', company_name: 'Loja da Ana', phone: '11987654321', terms_accepted: true, ...extra,
});
const gravouOrigem = (chamadas) => chamadas.find((c) => c.sql.startsWith('UPDATE companies SET signup_origin'));

describe('POST /auth/register -- origem do cadastro', () => {
  test('aceita a origem e grava na empresa nova, atras de SAVEPOINT, antes do COMMIT', async () => {
    const { sqls, chamadas } = clienteDoCadastro();
    const res = await cadastrar({
      self_serve: true,
      origem: {
        utm_source: 'Google', utm_medium: 'CPC', utm_campaign: 'otica-outubro', utm_content: 'anuncio-a', utm_term: 'sistema para otica',
        landing_page: '/planos', referrer: 'www.google.com', first_seen_at: '2026-10-12T14:30:00.000Z',
      },
    });

    expect(res.status).toBe(201);
    const upd = gravouOrigem(chamadas);
    expect(upd).toBeDefined();
    expect(upd.params[0]).toBe(cid);
    expect(JSON.parse(upd.params[1])).toEqual({
      utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'otica-outubro', utm_content: 'anuncio-a', utm_term: 'sistema para otica',
      landing_page: '/planos', referrer: 'www.google.com', first_seen_at: '2026-10-12T14:30:00.000Z',
    });
    const ordem = (trecho) => sqls.findIndex((s) => s.startsWith(trecho));
    expect(ordem('SAVEPOINT signup_origem')).toBeGreaterThan(ordem('INSERT INTO companies'));
    expect(ordem('UPDATE companies SET signup_origin')).toBeGreaterThan(ordem('SAVEPOINT signup_origem'));
    expect(ordem('RELEASE SAVEPOINT signup_origem')).toBeLessThan(ordem('COMMIT'));
    // a resposta do cadastro nao ganha campo novo
    expect(res.body.company).not.toHaveProperty('signup_origin');
  });

  test('ignora chave estranha, corta tamanho, tira query/hash da pagina e deixa so o host do referrer', async () => {
    const { chamadas } = clienteDoCadastro();
    const res = await cadastrar({
      origem: {
        utm_source: 'x'.repeat(300),
        utm_campaign: 'camp',
        email: 'ana@loja.com',          // dado pessoal: nunca entra
        ip: '1.2.3.4',
        __proto__x: 'y',
        landing_page: '/blog/artigo?email=ana@loja.com&utm_source=a#topo',
        referrer: 'https://www.google.com/search?q=sistema+de+gestao',
        first_seen_at: 'isto nao e data',
      },
    });

    expect(res.status).toBe(201);
    const origem = JSON.parse(gravouOrigem(chamadas).params[1]);
    expect(Object.keys(origem).sort()).toEqual(['landing_page', 'referrer', 'utm_campaign', 'utm_source']);
    expect(origem.utm_source).toHaveLength(100);
    expect(origem.landing_page).toBe('/blog/artigo');
    expect(origem.referrer).toBe('www.google.com');
  });

  test('sem origem: o cadastro roda como sempre, sem nenhuma query de origem', async () => {
    const { sqls } = clienteDoCadastro();
    const res = await cadastrar({ self_serve: true });
    expect(res.status).toBe(201);
    expect(sqls.some((s) => s.includes('signup_origin') || s.includes('signup_origem'))).toBe(false);
  });

  test.each([
    ['texto solto', 'google'],
    ['lista', ['utm_source']],
    ['numero', 42],
    ['objeto vazio', {}],
    ['so chaves desconhecidas', { foo: 'bar', ip: '1.2.3.4' }],
    ['valores que nao sao texto', { utm_source: { a: 1 }, utm_medium: 7, landing_page: ['/x'] }],
  ])('origem invalida (%s): nao quebra e nao grava', async (_nome, origem) => {
    const { sqls } = clienteDoCadastro();
    const res = await cadastrar({ origem });
    expect(res.status).toBe(201);
    expect(sqls.some((s) => s.includes('signup_origin'))).toBe(false);
  });

  test('migration 387 pendente: o cadastro nao cai (ROLLBACK TO SAVEPOINT, COMMIT)', async () => {
    const { sqls } = clienteDoCadastro({ semMigration: true });
    const res = await cadastrar({ self_serve: true, origem: { utm_source: 'google' } });
    expect(res.status).toBe(201);
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT signup_origem');
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });

  test('quem entra numa empresa que ja existe (CNPJ) nao regrava a origem dela', async () => {
    const { chamadas } = clienteDoCadastro({ empresaExistente: true });
    const res = await cadastrar({ cnpj: '11222333000181', origem: { utm_source: 'google' } });
    expect(res.status).toBe(201);
    expect(res.body.joined_existing).toBe(true);
    expect(gravouOrigem(chamadas)).toBeUndefined();
  });
});

describe('POST /auth/register -- cidade do CNPJ', () => {
  const esperar = async (fn) => {
    for (let i = 0; i < 20; i += 1) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const gravouCidade = () => db.query.mock.calls.find((c) => limpo(c[0]).startsWith('UPDATE companies SET address_city'));

  test('grava a cidade da Receita na empresa nova (sem sobrescrever quem ja tem)', async () => {
    clienteDoCadastro();
    cnpjService.lookupCNPJ.mockResolvedValueOnce({ address_city: 'Jacarei', address_state: 'SP' });

    const res = await cadastrar({ cnpj: '11.222.333/0001-81' });

    expect(res.status).toBe(201);
    await esperar(gravouCidade);
    const upd = gravouCidade();
    expect(upd).toBeDefined();
    expect(upd[1]).toEqual([cid, 'Jacarei', 'SP']);
    expect(limpo(upd[0])).toContain("COALESCE(NULLIF(address_city, ''), $2)");
    expect(cnpjService.lookupCNPJ.mock.calls[0][0]).toBe('11222333000181');
  });

  test('lookup falhou (Receita fora do ar): o cadastro fecha igual e nada e gravado', async () => {
    clienteDoCadastro();
    cnpjService.lookupCNPJ.mockRejectedValueOnce(new Error('CNPJ lookup timeout'));
    const res = await cadastrar({ cnpj: '11222333000181' });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect(gravouCidade()).toBeUndefined();
  });

  test('sem CNPJ: nao consulta a Receita', async () => {
    clienteDoCadastro();
    const res = await cadastrar();
    expect(res.status).toBe(201);
    expect(cnpjService.lookupCNPJ).not.toHaveBeenCalled();
  });
});
