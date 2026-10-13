// ============================================================
// Trial contado da primeira venda — pelas rotas (migration 379)
//
//   - POST /auth/register: self-service nasce 'primeira_venda' com o teto de
//     15 dias; código de acesso segue 'fixo'; sem a migration, os 7 dias de antes
//   - POST /auth/me: bloco trial { mode, ends_at, started_by_sale_at,
//     dias_restantes, teto_em }
//   - POST /pdv/sale: chama o gancho depois do COMMIT e nunca cai por causa dele
//   - PATCH /admin/clients/:cid/extend-trial: a data da Gestão Aura vira 'fixo'
//
// O gancho e o marcarTrialFixo são os jest.fn do tests/jest.setup.js (a regra
// em si está em tests/unit/trialRegra.test.js); ligarPrimeiraVendaNoCadastro
// e montarTrial rodam de verdade.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db, regra;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  regra = require('../../src/services/trialRegra');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const DIA    = 86400000;
const token  = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '1h' })}` });
const limpo  = (s) => String(s).replace(/\s+/g, ' ').trim();
const diasAte = (iso, de = Date.now()) => (new Date(iso).getTime() - de) / DIA;

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  regra.iniciarTrialPelaPrimeiraVenda.mockReset();
  regra.iniciarTrialPelaPrimeiraVenda.mockResolvedValue({ iniciou: false });
  regra.marcarTrialFixo.mockReset();
  regra.marcarTrialFixo.mockResolvedValue(true);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ── cadastro ─────────────────────────────────────────────────
// Banco de mentira do cadastro, por conteúdo do SQL. Guarda a empresa como o
// Postgres guardaria: o INSERT grava o trial_ends_at que recebeu e o UPDATE
// do modo aplica created_at + N dias.
function clienteDoCadastro({ codigo = null, semMigration = false } = {}) {
  const criadaEm = new Date();
  const estado = { empresa: null, sqls: [] };
  const client = { release: jest.fn() };
  client.query = jest.fn(async (sql, params) => {
    const s = limpo(sql);
    estado.sqls.push(s);
    if (s.startsWith('SELECT id FROM users WHERE email')) return { rows: [] };
    if (s.includes('FROM access_codes WHERE code')) return { rows: codigo ? [codigo] : [] };
    if (s.startsWith('INSERT INTO users')) {
      return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client', is_staff: false, email_verified: true, created_at: criadaEm }] };
    }
    if (s.startsWith('INSERT INTO companies')) {
      estado.empresa = {
        id: cid, legal_name: params[1], trade_name: params[1], plan: params[2], onboarding_step: 'cnpj',
        trial_ends_at: params[3], access_code_used: params[4], module_overrides: null,
      };
      return { rows: [{ ...estado.empresa }] };
    }
    if (s.startsWith('UPDATE companies SET trial_mode')) {
      if (semMigration) throw Object.assign(new Error('column "trial_mode" of relation "companies" does not exist'), { code: '42703' });
      estado.empresa.trial_mode = 'primeira_venda';
      estado.empresa.trial_ends_at = new Date(criadaEm.getTime() + params[1] * DIA).toISOString();
      return { rows: [{ trial_ends_at: estado.empresa.trial_ends_at, trial_mode: 'primeira_venda', trial_started_by_sale_at: null, created_at: criadaEm }] };
    }
    return { rows: [] };
  });
  db.connect.mockResolvedValueOnce(client);
  return estado;
}

const cadastrar = (extra = {}) => request(app).post('/api/v1/auth/register').send({
  name: 'Ana', email: 'ana@loja.com', password: 'senha1234', company_name: 'Loja da Ana', terms_accepted: true, ...extra,
});

describe('POST /auth/register', () => {
  test('self-service: nasce primeira_venda com trial_ends_at = cadastro + 15 dias (o teto)', async () => {
    const estado = clienteDoCadastro();

    const res = await cadastrar({ self_serve: true });

    expect(res.status).toBe(201);
    expect(estado.empresa.trial_mode).toBe('primeira_venda');
    expect(diasAte(estado.empresa.trial_ends_at)).toBeCloseTo(15, 2);
    // dentro da transação e atrás do SAVEPOINT, antes do COMMIT
    const ordem = (trecho) => estado.sqls.findIndex((s) => s.startsWith(trecho));
    expect(ordem('SAVEPOINT trial_primeira_venda')).toBeGreaterThan(ordem('INSERT INTO companies'));
    expect(ordem('RELEASE SAVEPOINT trial_primeira_venda')).toBeLessThan(ordem('COMMIT'));

    expect(res.body.company.plan).toBe('negocio');
    expect(diasAte(res.body.company.trial_ends_at)).toBeCloseTo(15, 2);
    expect(res.body.company.trial).toMatchObject({
      mode: 'primeira_venda', started_by_sale_at: null, dias_restantes: 15, aguardando_primeira_venda: true,
    });
    expect(res.body.company.trial.teto_em).toBe(res.body.company.trial.ends_at);
  });

  test('conta por código de acesso fica fixa: os dias do código, sem tocar no modo', async () => {
    const estado = clienteDoCadastro({
      codigo: { id: 'ac1', type: 'trial', plan: 'negocio', discount_pct: 0, trial_days: 30, max_uses: 10, uses: 0, expires_at: null, is_active: true, referrer_id: null },
    });

    const res = await cadastrar({ access_code: 'COMECAR', self_serve: true });

    expect(res.status).toBe(201);
    expect(estado.sqls.some((s) => s.includes('trial_mode'))).toBe(false);
    expect(estado.sqls.some((s) => s.startsWith('SAVEPOINT'))).toBe(false);
    expect(diasAte(estado.empresa.trial_ends_at)).toBeCloseTo(30, 2);
    expect(res.body.company.trial).toMatchObject({ mode: 'fixo', teto_em: null, aguardando_primeira_venda: false });
  });

  test('cadastro interno (sem self_serve, sem código): sem trial e sem modo', async () => {
    const estado = clienteDoCadastro();
    const res = await cadastrar();
    expect(res.status).toBe(201);
    expect(estado.empresa.trial_ends_at).toBeNull();
    expect(estado.sqls.some((s) => s.includes('trial_mode'))).toBe(false);
    expect(res.body.company.trial.mode).toBe('fixo');
  });

  test('migration 379 pendente: o cadastro não cai e fica com os 7 dias fixos de antes', async () => {
    const estado = clienteDoCadastro({ semMigration: true });

    const res = await cadastrar({ self_serve: true });

    expect(res.status).toBe(201);
    expect(estado.sqls).toContain('ROLLBACK TO SAVEPOINT trial_primeira_venda');
    expect(estado.sqls).toContain('COMMIT');
    expect(estado.sqls).not.toContain('ROLLBACK');
    expect(diasAte(res.body.company.trial_ends_at)).toBeCloseTo(7, 2);
    expect(res.body.company.trial.mode).toBe('fixo');
  });
});

// ── /auth/me ─────────────────────────────────────────────────
describe('POST /auth/me', () => {
  const auth = token({ id: 'u1', role: 'client', plan: 'negocio', company: cid });
  const criada = new Date(Date.now() - 3 * DIA);

  function bancoDoMe({ empresa = {}, trial } = {}) {
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client' }] };
      if (s.startsWith('SELECT trial_mode, trial_started_by_sale_at, created_at FROM companies')) {
        if (trial instanceof Error) throw trial;
        return { rows: trial ? [trial] : [] };
      }
      if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 1 }] };
      if (s.includes('AS member_role')) {
        return { rows: [{ id: cid, legal_name: 'Loja da Ana', plan: 'negocio', billing_status: 'trial', member_role: 'owner', ...empresa }] };
      }
      return { rows: [] };
    });
  }

  test('antes da primeira venda: mode primeira_venda, sem started_by_sale_at, teto em cadastro + 15', async () => {
    const teto = new Date(criada.getTime() + 15 * DIA);
    bancoDoMe({ empresa: { trial_ends_at: teto }, trial: { trial_mode: 'primeira_venda', trial_started_by_sale_at: null, created_at: criada } });

    const res = await request(app).post('/api/v1/auth/me').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.company.trial).toEqual({
      mode: 'primeira_venda',
      ends_at: teto.toISOString(),
      started_by_sale_at: null,
      dias_restantes: 12,
      teto_em: teto.toISOString(),
      aguardando_primeira_venda: true,
      dias_apos_primeira_venda: 7,
    });
    // o que o app já lia continua igual
    expect(res.body.company.trial_ends_at).toBe(teto.toISOString());
    expect(res.body.company.trial_active).toBe(true);
    expect(res.body.company.billing_status).toBe('trial');
  });

  test('depois da primeira venda: 7 dias a partir dela', async () => {
    const venda = new Date(Date.now() - 1 * DIA);
    const fim = new Date(venda.getTime() + 7 * DIA);
    bancoDoMe({ empresa: { trial_ends_at: fim }, trial: { trial_mode: 'primeira_venda', trial_started_by_sale_at: venda, created_at: criada } });

    const res = await request(app).post('/api/v1/auth/me').set(auth);

    expect(res.body.company.trial).toMatchObject({
      mode: 'primeira_venda', ends_at: fim.toISOString(), started_by_sale_at: venda.toISOString(),
      dias_restantes: 6, aguardando_primeira_venda: false,
    });
  });

  test('conta fixa: mode fixo e sem teto', async () => {
    const fim = new Date(Date.now() + 2 * DIA);
    bancoDoMe({ empresa: { trial_ends_at: fim }, trial: { trial_mode: 'fixo', trial_started_by_sale_at: null, created_at: criada } });
    const res = await request(app).post('/api/v1/auth/me').set(auth);
    expect(res.body.company.trial).toMatchObject({ mode: 'fixo', dias_restantes: 2, teto_em: null, started_by_sale_at: null });
  });

  test('migration 379 pendente: o /me responde igual, com trial fixo', async () => {
    const fim = new Date(Date.now() + 2 * DIA);
    bancoDoMe({ empresa: { trial_ends_at: fim }, trial: Object.assign(new Error('column "trial_mode" does not exist'), { code: '42703' }) });

    const res = await request(app).post('/api/v1/auth/me').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.company.trial_ends_at).toBe(fim.toISOString());
    expect(res.body.company.trial).toMatchObject({ mode: 'fixo', ends_at: fim.toISOString(), dias_restantes: 2, teto_em: null });
  });
});

// ── gancho da venda ──────────────────────────────────────────
describe('POST /companies/:id/pdv/sale', () => {
  const auth = token({ id: 'u1', role: 'client', plan: 'negocio' });

  function clienteDaVenda() {
    const client = { release: jest.fn() };
    client.query = jest.fn(async (sql) => {
      const s = limpo(typeof sql === 'string' ? sql : (sql && sql.text) || '');
      if (s.includes('pdv_settings')) return { rows: [{ pdv_settings: { caixa_enabled: false } }] };
      if (s.startsWith('INSERT INTO sales')) return { rows: [{ id: 'sale1', total_amount: 50 }] };
      return { rows: [] };
    });
    db.connect.mockResolvedValueOnce(client);
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
    return client;
  }
  const vender = () => request(app).post(`/api/v1/companies/${cid}/pdv/sale`).set(auth).send({
    payment_method: 'dinheiro',
    items: [{ product_name_snapshot: 'Item avulso', quantity: 1, unit_price: 50 }],
  });

  test('venda gravada chama o gancho da primeira venda, depois do COMMIT', async () => {
    const client = clienteDaVenda();
    let commitAntes = null;
    regra.iniciarTrialPelaPrimeiraVenda.mockImplementation(async () => {
      commitAntes = client.query.mock.calls.some(([q]) => /^\s*COMMIT/.test(String(q)));
      return { iniciou: true };
    });

    const res = await vender();

    expect(res.status).toBe(201);
    expect(regra.iniciarTrialPelaPrimeiraVenda).toHaveBeenCalledTimes(1);
    expect(regra.iniciarTrialPelaPrimeiraVenda).toHaveBeenCalledWith(cid);
    expect(commitAntes).toBe(true);
  });

  test('gancho rejeitando não derruba a venda', async () => {
    clienteDaVenda();
    regra.iniciarTrialPelaPrimeiraVenda.mockRejectedValue(new Error('banco fora'));
    const res = await vender();
    expect(res.status).toBe(201);
    expect(res.body.sale.id).toBe('sale1');
  });

  test('gancho estourando de forma síncrona também não derruba', async () => {
    clienteDaVenda();
    regra.iniciarTrialPelaPrimeiraVenda.mockImplementation(() => { throw new Error('estourou'); });
    const res = await vender();
    expect(res.status).toBe(201);
  });

  test('venda que não foi gravada (400) não chama o gancho', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/pdv/sale`).set(auth).send({ payment_method: 'dinheiro', items: [] });
    expect(res.status).toBe(400);
    expect(regra.iniciarTrialPelaPrimeiraVenda).not.toHaveBeenCalled();
  });
});

// ── estender trial ───────────────────────────────────────────
describe('PATCH /admin/clients/:cid/extend-trial', () => {
  const admin = token({ id: 'staff1', role: 'admin' });

  test('estende e a conta vira fixa (a primeira venda não encurta a extensão)', async () => {
    const fimAtual = new Date(Date.now() + 5 * DIA);
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (s.startsWith('SELECT trial_ends_at, billing_status FROM companies')) return { rows: [{ trial_ends_at: fimAtual, billing_status: 'trial' }] };
      return { rows: [] };
    });

    const res = await request(app).patch(`/api/v1/admin/clients/${cid}/extend-trial`).set(admin).send({ days: 10, reason: 'pediu mais tempo' });

    expect(res.status).toBe(200);
    expect(diasAte(res.body.trial_ends_at, fimAtual.getTime())).toBeCloseTo(10, 5);
    expect(res.body.trial_mode).toBe('fixo');
    expect(regra.marcarTrialFixo).toHaveBeenCalledWith(cid);
    // o UPDATE da data continua o de sempre (sem coluna nova: não quebra antes da 379)
    const upd = db.query.mock.calls.map(([q]) => limpo(q)).find((s) => s.startsWith('UPDATE companies SET trial_ends_at'));
    expect(upd).toBe('UPDATE companies SET trial_ends_at = $1, updated_at = NOW() WHERE id = $2');
  });

  test('empresa que não existe: 404 e nada é marcado', async () => {
    const res = await request(app).patch(`/api/v1/admin/clients/${cid}/extend-trial`).set(admin).send({ days: 10 });
    expect(res.status).toBe(404);
    expect(regra.marcarTrialFixo).not.toHaveBeenCalled();
  });
});
