// ============================================================
// AURA. -- Testes: cadastro do cliente por link (p-209, 23/11/2026)
//
// Lado do cliente (/public/cadastro/:token, sem auth):
//   1. GET devolve SÓ nome e logo da loja; nenhum dado do cliente.
//   2. Link usado, vencido, trocado ou desconhecido -> 410 LINK_INDISPONIVEL.
//   3. POST grava, marca o link como usado e devolve só {ok, store.name}.
//   4. POST inválido (CPF, aceite, campo fora da lista) não gasta o link.
//   5. Valor diferente do cadastro vira pendência, sem UPDATE no campo.
// Lado do lojista (/companies/:id/customer-signup-links):
//   6. Gera o link (token só na resposta, hash no banco) e revoga o anterior.
//   7. Ótica desligada -> 403 OTICA_DISABLED.
//   8. Sem customer_id: acha pelo telefone ou cria só com o telefone.
//   9. GET mostra estado e pendências com o valor atual ao lado.
//  10. resolve: aceitar grava no cliente; manter só descarta.
//
// Mock por CONTEÚDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const publicRouter = require('../../src/routes/cadastroLinkPublic');
const lojistaRouter = require('../../src/routes/customerSignupLinks');
const { hashToken, gerarToken } = require('../../src/services/cadastroPorLink');

let db;
beforeAll(() => { db = require('../../src/config/database'); });

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cust = '11111111-2222-3333-4444-555555555555';
const linkId = '22222222-3333-4444-5555-666666666666';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
app.use('/api/v1/public/cadastro', publicRouter);
const scoped = express.Router({ mergeParams: true });
scoped.use(requireAuth);
scoped.use(requireCompanyAccess());
scoped.use('/customer-signup-links', lojistaRouter);
app.use('/api/v1/companies/:id', scoped);

const TOKEN = gerarToken();
const futuro = () => new Date(Date.now() + 3 * 86400000).toISOString();

const CLIENTE_SO_TELEFONE = {
  id: cust, name: 'Maria Souza', birth_date: null, cpf_cnpj: null, phone: '11999990000', email: null,
  zip_code: null, street: null, number: null, complement: null, neighborhood: null, city: null, state: null,
};

let estado;
function mockDb({ link, cliente = CLIENTE_SO_TELEFONE, otica = 'true', porTelefone = [], links = [] } = {}) {
  estado = { link, cliente, otica, porTelefone, links };
  const handler = (sql, params) => {
    const s = String(sql || '');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
    if (/pdv_settings->>'otica_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: estado.otica }] });
    if (/FROM customer_signup_links l\s+JOIN companies/i.test(s)) {
      const l = estado.link && params[0] === estado.link.token_hash ? estado.link : null;
      return Promise.resolve({ rows: l ? [l] : [] });
    }
    if (/FROM customer_signup_links l\s+JOIN customers/i.test(s)) {
      return Promise.resolve({ rows: estado.links.filter((l) => l.id === params[0]) });
    }
    if (/FROM customer_signup_links\s+WHERE customer_id/i.test(s)) return Promise.resolve({ rows: estado.links });
    if (/INSERT INTO customer_signup_links/i.test(s)) {
      return Promise.resolve({ rows: [{ id: linkId, created_at: new Date().toISOString(), expires_at: futuro(), used_at: null, revoked_at: null, filled_fields: null }] });
    }
    if (/regexp_replace\(COALESCE\(phone/i.test(s)) return Promise.resolve({ rows: estado.porTelefone });
    if (/SELECT COUNT\(\*\) AS total FROM customers/i.test(s)) return Promise.resolve({ rows: [{ total: '10' }] });
    if (/INSERT INTO customers/i.test(s)) return Promise.resolve({ rows: [{ id: 'novo-cliente', name: params[1], phone: params[2] }] });
    if (/FROM customers WHERE id = \$1/i.test(s)) return Promise.resolve({ rows: estado.cliente ? [estado.cliente] : [] });
    if (/getOwnerScoped|FROM companies/i.test(s)) return Promise.resolve({ rows: [{ id: cid }] });
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  db.query.mockImplementation(handler);
  db.connect.mockImplementation(() => Promise.resolve({ query: jest.fn(handler), release: jest.fn() }));
}

jest.mock('../../src/utils/ownerScope', () => ({
  getOwnerScopedCompanyIds: jest.fn(() => Promise.resolve(['08c05f0e-b75b-4c12-870e-d7fb65f1dca0', 'outra-loja-do-dono'])),
}));

async function chamadasSql() {
  const clients = await Promise.all(db.connect.mock.results.map((r) => r.value));
  return [...db.query.mock.calls, ...clients.flatMap((c) => c.query.mock.calls)];
}
async function sqlQueBate(re) {
  return (await chamadasSql()).filter((c) => re.test(String(c[0] || '')));
}

const linkAberto = (extra) => ({
  id: linkId, customer_id: cust, company_id: cid, token_hash: hashToken(TOKEN), expires_at: futuro(),
  used_at: null, revoked_at: null, placeholder_name: null, store_name: 'Ótica Exemplo', logo_url: 'https://cdn/logo.png', ...extra,
});
const ENVIO = { name: 'Maria Souza', birth_date: '15/06/1990', cpf: '529.982.247-25', zip_code: '01310100', street: 'Av. Paulista', number: '1000', city: 'São Paulo', state: 'SP', consent: { accepted: true, version: 'v1' } };

beforeEach(() => { jest.clearAllMocks(); });

describe('GET /public/cadastro/:token', () => {
  it('link aberto: só a loja, nenhum dado do cliente', async () => {
    mockDb({ link: linkAberto() });
    const r = await request(app).get(`/api/v1/public/cadastro/${TOKEN}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['expires_at', 'store']);
    expect(r.body.store).toEqual({ name: 'Ótica Exemplo', logo_url: 'https://cdn/logo.png' });
    expect(JSON.stringify(r.body)).not.toMatch(/Maria|11999990000|customer/);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('usado, vencido, trocado -> 410 com a loja; desconhecido e token torto -> 410 sem loja', async () => {
    for (const extra of [{ used_at: new Date().toISOString() }, { expires_at: new Date(Date.now() - 1000).toISOString() }, { revoked_at: new Date().toISOString() }]) {
      mockDb({ link: linkAberto(extra) });
      const r = await request(app).get(`/api/v1/public/cadastro/${TOKEN}`);
      expect(r.status).toBe(410);
      expect(r.body.code).toBe('LINK_INDISPONIVEL');
      expect(r.body.store.name).toBe('Ótica Exemplo');
    }
    mockDb({ link: linkAberto() });
    const outro = await request(app).get(`/api/v1/public/cadastro/${gerarToken()}`);
    expect(outro.status).toBe(410); expect(outro.body.store).toBeUndefined();
    const torto = await request(app).get('/api/v1/public/cadastro/abc');
    expect(torto.status).toBe(410);
  });
});

describe('POST /public/cadastro/:token', () => {
  it('grava no cliente, gasta o link e devolve só {ok, store.name}', async () => {
    mockDb({ link: linkAberto() });
    const r = await request(app).post(`/api/v1/public/cadastro/${TOKEN}`).send(ENVIO);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, store: { name: 'Ótica Exemplo' } });
    const upd = (await sqlQueBate(/UPDATE customers SET/i))[0];
    expect(upd[0]).toMatch(/cpf_cnpj = \$\d/);
    expect(upd[1]).toContain('52998224725');
    expect(upd[1]).toContain('1990-06-15');
    const usado = (await sqlQueBate(/SET used_at = NOW\(\)/i))[0];
    expect(usado[1][0]).toBe('v1');
    expect(usado[1][1].sort()).toEqual(['address', 'birth_date', 'cpf_cnpj']);
    expect(usado[1][2]).toBeNull();
    expect((await sqlQueBate(/COMMIT/))).toHaveLength(1);
  });

  it('CPF inválido, sem aceite ou campo de receita: não abre transação nem gasta o link', async () => {
    mockDb({ link: linkAberto() });
    const a = await request(app).post(`/api/v1/public/cadastro/${TOKEN}`).send({ ...ENVIO, cpf: '123.456.789-00' });
    expect(a.status).toBe(400); expect(a.body.field).toBe('cpf');
    const b = await request(app).post(`/api/v1/public/cadastro/${TOKEN}`).send({ ...ENVIO, consent: { accepted: false, version: 'v1' } });
    expect(b.status).toBe(400); expect(b.body.code).toBe('ACEITE_OBRIGATORIO');
    const c = await request(app).post(`/api/v1/public/cadastro/${TOKEN}`).send({ ...ENVIO, od_sph: '-1.00' });
    expect(c.status).toBe(422);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('link já usado -> 410, nada gravado', async () => {
    mockDb({ link: linkAberto({ used_at: new Date().toISOString() }) });
    const r = await request(app).post(`/api/v1/public/cadastro/${TOKEN}`).send(ENVIO);
    expect(r.status).toBe(410);
    expect(await sqlQueBate(/UPDATE customers/i)).toHaveLength(0);
    expect(await sqlQueBate(/ROLLBACK/i)).toHaveLength(1);
  });

  it('cliente com CPF diferente: pendência, sem UPDATE do CPF, resposta sem o dado', async () => {
    mockDb({ link: linkAberto(), cliente: { ...CLIENTE_SO_TELEFONE, cpf_cnpj: '11144477735' } });
    const r = await request(app).post(`/api/v1/public/cadastro/${TOKEN}`).send(ENVIO);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/111444|529982/);
    const upd = (await sqlQueBate(/UPDATE customers SET/i))[0];
    expect(upd[0]).not.toMatch(/cpf_cnpj/);
    const usado = (await sqlQueBate(/SET used_at = NOW\(\)/i))[0];
    expect(JSON.parse(usado[1][2])).toEqual({ cpf_cnpj: '52998224725' });
    expect(await sqlQueBate(/SET pending_changes = NULL, pending_resolved_at = NOW\(\)/i)).toHaveLength(1);
  });

  it('erro no banco não loga o body nem a mensagem do Postgres', async () => {
    mockDb({ link: linkAberto() });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.connect.mockImplementation(() => Promise.resolve({
      query: jest.fn((sql) => {
        if (/FOR UPDATE OF l/.test(String(sql))) return Promise.resolve({ rows: [linkAberto()] });
        if (/FROM customers WHERE id/.test(String(sql))) return Promise.resolve({ rows: [CLIENTE_SO_TELEFONE] });
        if (/UPDATE customers/.test(String(sql))) { const e = new Error('invalid input syntax: "52998224725"'); e.code = '22P02'; return Promise.reject(e); }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    }));
    const r = await request(app).post(`/api/v1/public/cadastro/${TOKEN}`).send(ENVIO);
    expect(r.status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/52998224725|Maria/);
    spy.mockRestore();
  });
});

describe('POST /companies/:id/customer-signup-links', () => {
  it('gera o link: token na resposta, só o hash no banco, revoga o anterior', async () => {
    mockDb();
    const r = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links`).set(adminAuth).send({ customer_id: cust });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.path).toBe(`/cadastro/${r.body.token}`);
    expect(r.body.link.status).toBe('enviado');
    const ins = (await sqlQueBate(/INSERT INTO customer_signup_links/i))[0];
    expect(ins[1][2]).toBe(hashToken(r.body.token));
    expect(ins[1]).not.toContain(r.body.token);
    expect(ins[1][4]).toBe(7);
    expect(await sqlQueBate(/SET revoked_at = NOW\(\)/i)).toHaveLength(1);
  });

  it('ótica desligada -> 403 OTICA_DISABLED', async () => {
    mockDb({ otica: 'false' });
    const r = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links`).set(adminAuth).send({ customer_id: cust });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('OTICA_DISABLED');
    expect(await sqlQueBate(/INSERT INTO customer_signup_links/i)).toHaveLength(0);
  });

  it('cliente de outra loja do mesmo dono vale (owner-scope)', async () => {
    mockDb();
    await request(app).post(`/api/v1/companies/${cid}/customer-signup-links`).set(adminAuth).send({ customer_id: cust });
    const sel = (await sqlQueBate(/SELECT id, name, phone FROM customers WHERE id = \$1 AND company_id = ANY/i))[0];
    expect(sel[1][1]).toEqual([cid, 'outra-loja-do-dono']);
  });

  it('só telefone, sem cliente: cria com nome provisório', async () => {
    mockDb();
    const r = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links`).set(adminAuth).send({ phone: '(11) 98888-7777' });
    expect(r.status).toBe(201);
    expect(r.body.customer_created).toBe(true);
    expect(r.body.customer.name).toBe('Cadastro por link pendente');
    const ins = (await sqlQueBate(/INSERT INTO customer_signup_links/i))[0];
    expect(ins[1][5]).toBe('Cadastro por link pendente');
  });

  it('só telefone de cliente que já existe: usa o cliente, não cria', async () => {
    mockDb({ porTelefone: [{ id: cust, name: 'Maria Souza', phone: '11999990000' }] });
    const r = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links`).set(adminAuth).send({ phone: '11999990000' });
    expect(r.status).toBe(201);
    expect(r.body.customer_created).toBe(false);
    expect(await sqlQueBate(/INSERT INTO customers/i)).toHaveLength(0);
  });

  it('telefone de dois clientes -> 409 TELEFONE_AMBIGUO', async () => {
    mockDb({ porTelefone: [{ id: 'a' }, { id: 'b' }] });
    const r = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links`).set(adminAuth).send({ phone: '11999990000' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TELEFONE_AMBIGUO');
  });
});

describe('GET e resolve', () => {
  const comPendencia = {
    id: linkId, customer_id: cust, created_at: new Date().toISOString(), expires_at: futuro(),
    used_at: new Date().toISOString(), revoked_at: null, filled_fields: ['address'],
    pending_changes: { cpf_cnpj: '52998224725', name: 'Maria S. Souza' },
  };

  it('GET mostra recebido e as diferenças com o valor atual', async () => {
    mockDb({ cliente: { ...CLIENTE_SO_TELEFONE, cpf_cnpj: '11144477735' }, links: [comPendencia] });
    const r = await request(app).get(`/api/v1/companies/${cid}/customer-signup-links?customer_id=${cust}`).set(adminAuth);
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(r.body.link.status).toBe('recebido');
    expect(r.body.pending_link_id).toBe(linkId);
    expect(r.body.pending).toEqual([
      { field: 'name', label: 'Nome', current: 'Maria Souza', received: 'Maria S. Souza' },
      { field: 'cpf_cnpj', label: 'CPF', current: '11144477735', received: '52998224725' },
    ]);
  });

  it('GET sem a migration -> available:false (o app esconde o botão)', async () => {
    mockDb();
    const handler = db.query.getMockImplementation();
    db.query.mockImplementation((sql, p) => {
      if (/FROM customer_signup_links/i.test(String(sql))) { const e = new Error('x'); e.code = '42P01'; return Promise.reject(e); }
      return handler(sql, p);
    });
    const r = await request(app).get(`/api/v1/companies/${cid}/customer-signup-links?customer_id=${cust}`).set(adminAuth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: false, link: null, pending: [], pending_link_id: null });
  });

  it('resolve: aceitar CPF grava; manter nome descarta; pendência zera', async () => {
    mockDb({ links: [comPendencia] });
    const r = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links/${linkId}/resolve`).set(adminAuth)
      .send({ accept: ['cpf_cnpj'], keep: ['name'] });
    expect(r.status).toBe(200);
    expect(r.body.pending).toEqual([]);
    const upd = (await sqlQueBate(/UPDATE customers SET/i))[0];
    expect(upd[0]).toMatch(/^\s*UPDATE customers SET cpf_cnpj = \$1, updated_at/);
    expect(upd[1]).toEqual(['52998224725', cust]);
    const fim = (await sqlQueBate(/UPDATE customer_signup_links\s+SET pending_changes = \$1/i))[0];
    expect(fim[1][0]).toBeNull();
  });

  it('resolve de campo já resolvido -> 409; campo desconhecido -> 400', async () => {
    mockDb({ links: [comPendencia] });
    const a = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links/${linkId}/resolve`).set(adminAuth).send({ accept: ['email'] });
    expect(a.status).toBe(409);
    const b = await request(app).post(`/api/v1/companies/${cid}/customer-signup-links/${linkId}/resolve`).set(adminAuth).send({ accept: ['notes'] });
    expect(b.status).toBe(400);
  });
});
