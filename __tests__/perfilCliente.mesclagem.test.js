// ============================================================
// AURA CLIENTES — Fase 1: mesclagem, duplicados, notas, tags e PATCH
//
// Banco mockado. Trava:
//   - preview é dry-run (só SELECT), com o que move, o que fica e conflitos
//   - execução: ordem das queries, uma transação, SAVEPOINT por tabela,
//     42P01 pulado, 23505 mantido na origem, ROLLBACK em erro de verdade
//   - crediário só move entre fichas da mesma empresa
//   - opt-out de qualquer um vence; tags unidas; totais somados
//   - duplicados, notas (a automática não se apaga), tags e o PATCH novo
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const { companyRouter } = require('../src/routes/customerProfile');
const customersRouter = require('../src/routes/customers');
const merge = require('../src/services/customerMerge');
const dups = require('../src/services/customerDuplicates');

let db;
beforeAll(() => { db = require('../src/config/database'); });

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const SOURCE = '44444444-4444-4444-8444-444444444444';
const USER = '66666666-6666-4666-8666-666666666666';
const NOTE = '55555555-5555-4555-8555-555555555555';

const app = express();
app.use(express.json());
app.use('/companies/:id/customers', (req, res, next) => { req.user = { id: USER, plan: 'essencial' }; next(); });
app.use('/companies/:id/customers', customersRouter);
app.use('/companies/:id/customers', companyRouter);

function pgError(code, msg) {
  const e = new Error(msg || `pg ${code}`);
  e.code = code;
  return e;
}

function row(over) {
  return {
    id: TARGET, company_id: CO_A, company_name: 'Loja A', name: 'Ana Souza',
    email: null, phone: '(11) 98765-4321', phone_secondary: null, cpf_cnpj: null,
    birth_date: null, instagram_handle: null, notes: null, photo_url: null,
    street: null, city: null, state: null, zip_code: null,
    total_purchases: 3, total_spent: 300, first_purchase_at: new Date('2026-03-01T00:00:00Z'),
    last_purchase_at: new Date('2026-08-01T00:00:00Z'), is_active: true,
    marketing_opt_out: false, tags: ['VIP'], preferences: { tamanho: 'M' }, important_dates: [],
    merged_into_id: null, is_student: false, karate_registration_number: null,
    ...over,
  };
}

const target = () => row();
const source = (over) => row({
  id: SOURCE, name: 'Ana S.', email: 'ana@exemplo.com', phone: '11 8765-4321',
  cpf_cnpj: '52998224725', total_purchases: 2, total_spent: 150.55,
  first_purchase_at: new Date('2025-12-01T00:00:00Z'), last_purchase_at: new Date('2026-05-01T00:00:00Z'),
  marketing_opt_out: true, tags: ['vip', 'Noiva'], preferences: { tamanho: 'G', marcas: ['Farm'] },
  important_dates: [{ label: 'Casamento', date: '2026-11-20' }],
  ...over,
});

function ownerScope(sql) {
  return /owner_id = \(SELECT owner_id FROM companies WHERE id = \$1\)/.test(sql);
}

beforeEach(() => {
  jest.resetAllMocks();
  customersRouter._resetProfileColumnsCache();
  dups._resetCache();
});

// ── preview ─────────────────────────────────────────────────
describe('POST /:cid/merge/preview — dry-run', () => {
  it('conta o que move, o que fica e os conflitos, sem escrever nada', async () => {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push(sql);
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      if (/-- merge:carrega/.test(sql)) return { rows: [target(), source({ company_id: CO_B, company_name: 'Loja B' })] };
      const m = /-- merge:conta (\w+)/.exec(sql);
      if (m) {
        if (m[1] === 'customer_consent_events') throw pgError('42P01');
        const n = { sales: 4, coupons: 1, customer_credit_transactions: 3, customer_credit_profiles: 1 }[m[1]] || 0;
        return { rows: [{ n }] };
      }
      throw new Error('inesperada: ' + sql);
    });

    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge/preview`)
      .send({ source_id: SOURCE });

    expect(res.status).toBe(200);
    expect(res.body.same_company).toBe(false);
    expect(res.body.moves).toEqual([
      { table: 'sales', label: 'vendas', rows: 4 },
      { table: 'coupons', label: 'cupons', rows: 1 },
    ]);
    expect(res.body.kept).toEqual([
      { table: 'customer_credit_transactions', label: 'lancamentos do crediario', rows: 3, reason: 'crediario_de_outra_empresa' },
      { table: 'customer_credit_profiles', label: 'perfil de crediario', rows: 1, reason: 'crediario_de_outra_empresa' },
    ]);
    expect(res.body.skipped_tables).toEqual(['customer_consent_events']);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.conflicts).toEqual(expect.arrayContaining([
      { field: 'name', target: 'Ana Souza', source: 'Ana S.', choice: 'target' },
      { field: 'phone', target: '(11) 98765-4321', source: '11 8765-4321', choice: 'target' },
      expect.objectContaining({ field: 'preferences', keys: ['tamanho'], choice: 'target' }),
    ]));
    expect(res.body.auto_filled).toEqual(expect.arrayContaining([
      { field: 'email', value: 'ana@exemplo.com' },
      { field: 'cpf_cnpj', value: '52998224725' },
    ]));
    expect(res.body.result).toMatchObject({
      tags: ['VIP', 'Noiva'], total_purchases: 5, total_spent: 450.55, marketing_opt_out: true,
    });
    expect(calls.every(sql => !/\b(UPDATE|INSERT|DELETE)\b/.test(sql.replace(/--.*$/m, '')))).toBe(true);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('validações: mesma pessoa, source_id inválido, fields inválido, karatê, já mesclado', async () => {
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/-- merge:carrega/.test(sql)) return { rows: [target(), source({ is_student: true })] };
      return { rows: [{ n: 0 }] };
    });
    const url = `/companies/${CO_A}/customers/${TARGET}/merge/preview`;
    expect((await request(app).post(url).send({ source_id: TARGET })).status).toBe(400);
    expect((await request(app).post(url).send({ source_id: 'x' })).status).toBe(400);
    expect((await request(app).post(url).send({ source_id: SOURCE, fields: { total_spent: 'source' } })).status).toBe(400);
    expect((await request(app).post(url).send({ source_id: SOURCE, fields: { name: 'ambos' } })).status).toBe(400);

    const karate = await request(app).post(url).send({ source_id: SOURCE });
    expect(karate.status).toBe(409);
    expect(karate.body.code).toBe('KARATE_IDENTITY');

    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/-- merge:carrega/.test(sql)) return { rows: [target(), source({ merged_into_id: TARGET })] };
      return { rows: [] };
    });
    const ja = await request(app).post(url).send({ source_id: SOURCE });
    expect(ja.status).toBe(409);
    expect(ja.body.code).toBe('ALREADY_MERGED');

    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/-- merge:carrega/.test(sql)) return { rows: [target()] };
      return { rows: [] };
    });
    expect((await request(app).post(url).send({ source_id: SOURCE })).status).toBe(404);
  });

  it('antes da migration 341 a mesclagem responde 409 explicando', async () => {
    const semColuna = (r) => { const c = { ...r }; delete c.merged_into_id; return c; };
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/-- merge:carrega/.test(sql)) return { rows: [semColuna(target()), semColuna(source())] };
      return { rows: [] };
    });
    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge/preview`).send({ source_id: SOURCE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROFILE_COLUMNS_MISSING');
  });
});

// ── execução ────────────────────────────────────────────────
function fakeClient(handler) {
  const log = [];
  const client = {
    log,
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = String(sql).trim();
      log.push({ sql: s, params });
      const r = await handler(s, params);
      return r || { rows: [], rowCount: 0 };
    }),
  };
  return client;
}

function tagOf(sql) {
  const m = /-- (merge:[\w-]+(?: \w+)?)/.exec(sql);
  return m ? m[1] : sql.split(/\s+/).slice(0, 2).join(' ');
}

describe('POST /:cid/merge — execução transacional', () => {
  function setup({ sourceOver = {}, onMove = {}, failAt = null, consent = {} } = {}) {
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      throw new Error('fora da transacao: ' + sql);
    });
    const client = fakeClient(async (sql, params) => {
      const tag = tagOf(sql);
      if (failAt && tag === failAt) throw pgError('XX000', 'falha simulada');
      if (tag === 'merge:carrega') return { rows: [target(), source(sourceOver)] };
      if (consent[tag] instanceof Error) throw consent[tag];
      if (consent[tag]) return { rows: consent[tag] };
      const mv = /^merge:move (\w+)$/.exec(tag);
      if (mv) {
        const h = onMove[mv[1]];
        if (h instanceof Error) throw h;
        return { rows: [], rowCount: h || 0 };
      }
      const ct = /^merge:conta (\w+)$/.exec(tag);
      if (ct) return { rows: [{ n: { customer_credit_transactions: 2, birthday_messages_sent: 1 }[ct[1]] || 0 }] };
      if (tag === 'merge:alvo') return { rows: [{ id: TARGET, name: 'Ana Souza', tags: params[0] }] };
      if (tag === 'merge:nota') return { rows: [{ id: NOTE }] };
      return { rows: [], rowCount: 0 };
    });
    db.connect.mockResolvedValue(client);
    return client;
  }

  it('move as referências numa transação, na ordem certa', async () => {
    const client = setup({
      sourceOver: { company_id: CO_B, company_name: 'Loja B' },
      onMove: {
        sales: 4,
        coupons: 1,
        customer_consent_events: pgError('42P01'),
        birthday_messages_sent: pgError('23505'),
      },
    });

    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge`)
      .send({ source_id: SOURCE, fields: { name: 'source' } });

    expect(res.status).toBe(200);
    const tags = client.log.map(q => tagOf(q.sql));
    expect(tags[0]).toBe('BEGIN');
    expect(tags[1]).toBe('merge:carrega');
    expect(client.log[1].sql).toMatch(/FOR UPDATE OF c/);
    // estado do consentimento lido antes de mover, em savepoint próprio
    expect(tags.slice(2, 5)).toEqual(['SAVEPOINT merge_opt', 'merge:consentimento-antes', 'RELEASE SAVEPOINT']);
    // cada tabela do dono: SAVEPOINT -> UPDATE -> RELEASE
    expect(tags.slice(5, 8)).toEqual(['SAVEPOINT merge_ref', 'merge:move sales', 'RELEASE SAVEPOINT']);
    expect(client.log[6].params).toEqual([TARGET, SOURCE]);
    expect(client.log[6].sql).toMatch(/UPDATE sales SET customer_id = \$1 WHERE customer_id = \$2/);
    // o fim é sempre alvo -> origem -> nota -> COMMIT
    expect(tags.slice(-4)).toEqual(['merge:alvo', 'merge:origem', 'merge:nota', 'COMMIT']);
    expect(tags).not.toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);

    // tabela ausente e conflito de unicidade voltam ao savepoint e seguem
    const iConsent = tags.indexOf('merge:move customer_consent_events');
    expect(tags[iConsent + 1]).toBe('ROLLBACK TO');
    const iBday = tags.indexOf('merge:move birthday_messages_sent');
    expect(tags[iBday + 1]).toBe('ROLLBACK TO');

    // crediário de outra empresa: não é movido, só contado
    expect(tags).not.toContain('merge:move customer_credit_transactions');
    expect(tags).toContain('merge:conta customer_credit_transactions');

    expect(res.body).toMatchObject({
      merged: true,
      source_id: SOURCE,
      note_id: NOTE,
      moved: [
        { table: 'sales', label: 'vendas', rows: 4 },
        { table: 'coupons', label: 'cupons', rows: 1 },
      ],
      kept: [
        { table: 'birthday_messages_sent', label: 'mensagens de aniversario', rows: 1, reason: 'conflito_de_unicidade' },
        { table: 'customer_credit_transactions', label: 'lancamentos do crediario', rows: 2, reason: 'crediario_de_outra_empresa' },
      ],
    });
    expect(res.body.skipped_tables).toContain('customer_consent_events');

    // alvo: nome escolhido da origem, tags unidas, totais somados, opt-out vence
    const alvo = client.log.find(q => tagOf(q.sql) === 'merge:alvo');
    expect(alvo.sql).toMatch(/name = \$\d+/);
    expect(alvo.sql).toMatch(/tags = \$\d+::text\[\]/);
    expect(alvo.sql).toMatch(/preferences = \$\d+::jsonb/);
    expect(alvo.sql).toMatch(/updated_at = NOW\(\) WHERE id = \$\d+ RETURNING \*/);
    const cols = [...alvo.sql.matchAll(/(\w+) = \$(\d+)/g)].reduce((acc, m) => {
      acc[m[1]] = alvo.params[Number(m[2]) - 1];
      return acc;
    }, {});
    expect(cols).toMatchObject({
      name: 'Ana S.',
      email: 'ana@exemplo.com',
      cpf_cnpj: '52998224725',
      tags: ['VIP', 'Noiva'],
      marketing_opt_out: true,
      total_purchases: 5,
      total_spent: 450.55,
    });
    expect(cols).not.toHaveProperty('phone'); // conflito resolvido para o alvo
    expect(JSON.parse(cols.preferences)).toEqual({ tamanho: 'M', marcas: ['Farm'] });
    expect(JSON.parse(cols.important_dates)).toEqual([{ label: 'Casamento', date: '2026-11-20' }]);
    expect(cols.first_purchase_at.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(cols.last_purchase_at.toISOString()).toBe('2026-08-01T00:00:00.000Z');

    const origem = client.log.find(q => tagOf(q.sql) === 'merge:origem');
    expect(origem.sql).toMatch(/merged_into_id = \$1, is_active = false/);
    expect(origem.params).toEqual([TARGET, SOURCE]);

    const nota = client.log.find(q => tagOf(q.sql) === 'merge:nota');
    expect(nota.sql).toMatch(/'merge'/);
    expect(nota.params.slice(0, 3)).toEqual([CO_A, TARGET, USER]);
    expect(nota.params[3]).toMatch(/Cadastro "Ana S\." mesclado/);
    expect(nota.params[3]).toMatch(/Movido: 4 vendas, 1 cupons/);
    expect(nota.params[3]).toMatch(/Ficou no cadastro antigo: 1 mensagens de aniversario, 2 lancamentos do crediario/);
  });

  it('consentimento: opt-out de qualquer um vence mesmo com opt-in mais recente no alvo', async () => {
    const client = setup({
      consent: {
        'merge:consentimento-antes': [
          { customer_id: SOURCE, company_id: CO_A, purpose: 'marketing', action: 'opt_out' },
          { customer_id: SOURCE, company_id: CO_B, purpose: 'marketing', action: 'opt_out' },
          { customer_id: TARGET, company_id: CO_A, purpose: 'marketing', action: 'opt_in' },
        ],
        // histórico unido: na Loja A o opt-in do alvo é o mais recente; na
        // Loja B o opt-out da origem continua valendo
        'merge:consentimento-depois': [
          { customer_id: TARGET, company_id: CO_A, purpose: 'marketing', action: 'opt_in' },
          { customer_id: TARGET, company_id: CO_B, purpose: 'marketing', action: 'opt_out' },
        ],
      },
    });

    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge`).send({ source_id: SOURCE });
    expect(res.status).toBe(200);
    expect(res.body.consent_opt_outs_added).toBe(1);
    const ins = client.log.filter(q => tagOf(q.sql) === 'merge:consentimento-optout');
    expect(ins).toHaveLength(1);
    expect(ins[0].sql).toMatch(/'opt_out', 'manual'/);
    expect(ins[0].params).toEqual([
      CO_A, TARGET, null, 'marketing',
      'Mesclagem de cadastros: o opt-out de um dos cadastros prevalece.', USER,
    ]);
    const antes = client.log.find(q => tagOf(q.sql) === 'merge:consentimento-antes');
    expect(antes.params[0]).toEqual([TARGET, SOURCE]);
    expect(antes.sql).toMatch(/DISTINCT ON \(customer_id, company_id, purpose\)/);
    const tags = client.log.map(q => tagOf(q.sql));
    expect(tags.indexOf('merge:consentimento-depois')).toBeGreaterThan(tags.indexOf('merge:move customer_consent_events'));
    expect(tags.indexOf('merge:consentimento-optout')).toBeLessThan(tags.indexOf('merge:alvo'));
  });

  it('consentimento: sem a tabela (migration 340 pendente) a mesclagem segue', async () => {
    const client = setup({
      onMove: { customer_consent_events: pgError('42P01') },
      consent: { 'merge:consentimento-antes': pgError('42P01') },
    });
    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge`).send({ source_id: SOURCE });
    expect(res.status).toBe(200);
    expect(res.body.consent_opt_outs_added).toBe(0);
    const tags = client.log.map(q => tagOf(q.sql));
    expect(tags.slice(2, 6)).toEqual(['SAVEPOINT merge_opt', 'merge:consentimento-antes', 'ROLLBACK TO', 'RELEASE SAVEPOINT']);
    expect(tags).not.toContain('merge:consentimento-depois');
    expect(tags[tags.length - 1]).toBe('COMMIT');
  });

  it('mesma empresa: o crediário também é movido', async () => {
    const client = setup({ onMove: { customer_credit_transactions: 2, credit_installments: 3 } });
    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge`).send({ source_id: SOURCE });
    expect(res.status).toBe(200);
    const tags = client.log.map(q => tagOf(q.sql));
    expect(tags).toContain('merge:move customer_credit_transactions');
    expect(tags).not.toContain('merge:conta customer_credit_transactions');
    expect(res.body.moved).toEqual(expect.arrayContaining([
      { table: 'customer_credit_transactions', label: 'lancamentos do crediario', rows: 2 },
      { table: 'credit_installments', label: 'parcelas do crediario', rows: 3 },
    ]));
  });

  it('erro de verdade no meio: ROLLBACK, nada de COMMIT, conexão devolvida', async () => {
    const client = setup({ failAt: 'merge:origem' });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge`).send({ source_id: SOURCE });
    spy.mockRestore();
    expect(res.status).toBe(500);
    const tags = client.log.map(q => tagOf(q.sql));
    expect(tags[tags.length - 1]).toBe('ROLLBACK');
    expect(tags).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('erro não-schema ao mover uma tabela também aborta tudo', async () => {
    const client = setup({ onMove: { coupons: pgError('23503') } });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge`).send({ source_id: SOURCE });
    spy.mockRestore();
    expect(res.status).toBe(500);
    const tags = client.log.map(q => tagOf(q.sql));
    expect(tags).not.toContain('merge:alvo');
    expect(tags[tags.length - 1]).toBe('ROLLBACK');
  });

  it('origem inválida é 404 com ROLLBACK', async () => {
    db.query.mockImplementation(async () => ({ rows: [{ id: CO_A }] }));
    const client = fakeClient(async (sql) => (tagOf(sql) === 'merge:carrega' ? { rows: [target()] } : null));
    db.connect.mockResolvedValue(client);
    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/merge`).send({ source_id: SOURCE });
    expect(res.status).toBe(404);
    expect(client.log.map(q => tagOf(q.sql))).toEqual(['BEGIN', 'merge:carrega', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalled();
  });

  it('as listas de referências cobrem as tabelas de venda, cupom, nota, envio e avaliação', () => {
    const t = merge.OWNER_REFS.map(r => r.table);
    for (const x of ['sales', 'coupons', 'customer_notes', 'wa_marketing_log', 'birthday_messages_sent',
      'purchase_reviews', 'customer_consent_events']) {
      expect(t).toContain(x);
    }
    expect(t.some(x => x.startsWith('karate_'))).toBe(false);
    expect(merge.CREDIT_REFS.map(r => r.table)).toEqual(expect.arrayContaining([
      'customer_credit_transactions', 'credit_installments', 'credit_accounts', 'customer_credit_profiles',
    ]));
  });
});

// ── duplicados ──────────────────────────────────────────────
describe('GET /duplicates', () => {
  const cand = (over) => ({
    company_id: CO_A, company_name: 'Loja A', email: null, cpf_cnpj: null,
    total_purchases: 0, total_spent: 0, last_purchase_at: null, created_at: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('agrupa dentro das empresas do dono, ignorando mesclados', async () => {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      return {
        rows: [
          cand({ id: 'a', name: 'Ana Souza', phone: '11987654321', phone_e164: '5511987654321' }),
          cand({ id: 'b', name: 'Ana', phone: '1187654321', phone_e164: '5511987654321', company_id: CO_B }),
        ],
      };
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/duplicates`);
    expect(res.status).toBe(200);
    expect(res.body.total_groups).toBe(1);
    expect(res.body.groups[0]).toMatchObject({ strength: 'forte', reasons: ['phone'] });
    const q = calls.find(c => /-- dup:clientes/.test(c.sql));
    expect(q.params[0]).toEqual([CO_A, CO_B]);
    expect(q.sql).toMatch(/merged_into_id IS NULL/);
    expect(q.sql).toMatch(/COALESCE\(co\.trade_name, co\.legal_name\)/);
  });

  it('sem a migration 341 calcula o telefone no JS', async () => {
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/c\.phone_e164/.test(sql)) throw pgError('42703');
      return {
        rows: [
          cand({ id: 'a', name: 'Ana Souza', phone: '(11) 98765-4321', phone_e164: null }),
          cand({ id: 'b', name: 'Bia Lima', phone: '11 8765-4321', phone_e164: null }),
        ],
      };
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/duplicates`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].customers.map(c => c.phone_e164)).toEqual(['5511987654321', '5511987654321']);
  });
});

// ── notas e tags ────────────────────────────────────────────
describe('notas', () => {
  it('POST cria nota manual com o autor da sessão', async () => {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/-- perfil:cliente/.test(sql)) return { rows: [{ id: TARGET, company_id: CO_A }] };
      if (/-- perfil:nota-cria/.test(sql)) {
        return { rows: [{ id: NOTE, company_id: CO_A, customer_id: TARGET, author_id: USER, kind: 'manual', body: params[3] }] };
      }
      throw new Error('inesperada');
    });
    const res = await request(app).post(`/companies/${CO_A}/customers/${TARGET}/notes`).send({ body: '  Gosta de tons terrosos  ' });
    expect(res.status).toBe(201);
    expect(res.body.note).toMatchObject({ id: NOTE, kind: 'manual', body: 'Gosta de tons terrosos' });
    expect(calls.find(c => /nota-cria/.test(c.sql)).params).toEqual([CO_A, TARGET, USER, 'Gosta de tons terrosos']);
  });

  it('POST valida o corpo e responde 409 sem a tabela', async () => {
    const url = `/companies/${CO_A}/customers/${TARGET}/notes`;
    expect((await request(app).post(url).send({ body: '   ' })).status).toBe(400);
    expect((await request(app).post(url).send({ body: 'x'.repeat(5001) })).status).toBe(400);
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/-- perfil:cliente/.test(sql)) return { rows: [{ id: TARGET }] };
      throw pgError('42P01');
    });
    const res = await request(app).post(url).send({ body: 'oi' });
    expect(res.status).toBe(409);
  });

  it('DELETE apaga nota manual; a da mesclagem é travada', async () => {
    let kind = 'manual';
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/-- perfil:nota-busca/.test(sql)) return { rows: [{ id: NOTE, kind }] };
      if (/-- perfil:nota-apaga/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error('inesperada');
    });
    const url = `/companies/${CO_A}/customers/${TARGET}/notes/${NOTE}`;
    const ok = await request(app).delete(url);
    expect(ok.status).toBe(200);
    expect(calls.find(c => /nota-apaga/.test(c.sql)).sql).toMatch(/kind = 'manual'/);

    kind = 'merge';
    const travada = await request(app).delete(url);
    expect(travada.status).toBe(409);
    expect(travada.body.code).toBe('NOTE_LOCKED');
  });
});

describe('GET /tags', () => {
  it('lista as tags da base do dono com contagem', async () => {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      return { rows: [{ tag: 'VIP', count: 12 }, { tag: 'Noiva', count: '3' }] };
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/tags`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: [{ tag: 'VIP', count: 12 }, { tag: 'Noiva', count: 3 }] });
    expect(calls[1].params[0]).toEqual([CO_A, CO_B]);
  });

  it('antes da migration devolve lista vazia, não 500', async () => {
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      throw pgError('42703');
    });
    const res = await request(app).get(`/companies/${CO_A}/customers/tags`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: [] });
  });
});

// ── PATCH /customers/:cid ───────────────────────────────────
describe('PATCH /customers/:cid — campos do perfil', () => {
  function patchDb(onUpdate) {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/^\s*UPDATE customers/.test(sql)) return onUpdate(sql, params);
      throw new Error('inesperada: ' + sql);
    });
    return calls;
  }

  it('grava tags, preferências, datas, CPF só com dígitos e phone_e164', async () => {
    const calls = patchDb(async () => ({ rows: [{ id: TARGET }] }));
    const res = await request(app).patch(`/companies/${CO_A}/customers/${TARGET}`).send({
      phone: '(11) 8765-4321',
      cpf_cnpj: '529.982.247-25',
      tags: ['VIP', 'vip', 'Noiva'],
      preferences: { tamanho: 'M', marcas: ['Farm'] },
      important_dates: [{ label: 'Casamento', date: '20/11/2026' }],
    });
    expect(res.status).toBe(200);
    const upd = calls.find(c => /UPDATE customers/.test(c.sql));
    const cols = [...upd.sql.matchAll(/(\w+) = \$(\d+)/g)].reduce((acc, m) => {
      acc[m[1]] = upd.params[Number(m[2]) - 1];
      return acc;
    }, {});
    expect(cols).toMatchObject({
      phone: '(11) 8765-4321',
      phone_e164: '5511987654321',
      cpf_cnpj: '52998224725',
      tags: ['VIP', 'Noiva'],
    });
    expect(JSON.parse(cols.preferences)).toEqual({ tamanho: 'M', marcas: ['Farm'] });
    expect(JSON.parse(cols.important_dates)).toEqual([{ label: 'Casamento', date: '2026-11-20' }]);
    expect(upd.sql).toMatch(/tags = \$\d+::text\[\]/);
    expect(upd.sql).toMatch(/preferences = \$\d+::jsonb/);
  });

  it('CPF vazio apaga; CPF inválido é 400 com o campo', async () => {
    const calls = patchDb(async () => ({ rows: [{ id: TARGET }] }));
    const ok = await request(app).patch(`/companies/${CO_A}/customers/${TARGET}`).send({ cpf_cnpj: '' });
    expect(ok.status).toBe(200);
    expect(calls.find(c => /UPDATE/.test(c.sql)).params[0]).toBeNull();

    const bad = await request(app).patch(`/companies/${CO_A}/customers/${TARGET}`).send({ cpf_cnpj: '123.456.789-00' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'CPF invalido', field: 'cpf_cnpj' });
  });

  it('tags/preferências/datas inválidas são 400 antes do banco', async () => {
    const calls = patchDb(async () => ({ rows: [] }));
    const url = `/companies/${CO_A}/customers/${TARGET}`;
    expect((await request(app).patch(url).send({ tags: 'x'.repeat(41) })).body.field).toBe('tags');
    expect((await request(app).patch(url).send({ preferences: [] })).body.field).toBe('preferences');
    expect((await request(app).patch(url).send({ important_dates: [{ label: 'a', date: 'ontem' }] })).body.field).toBe('important_dates');
    expect(calls).toHaveLength(0);
  });

  it('sem a migration 341: grava o resto e avisa o que ignorou; cache evita a 2ª tentativa', async () => {
    const calls = patchDb(async (sql) => {
      if (/phone_e164|tags/.test(sql)) throw pgError('42703');
      return { rows: [{ id: TARGET, name: 'Ana' }] };
    });
    const url = `/companies/${CO_A}/customers/${TARGET}`;
    const res = await request(app).patch(url).send({ name: 'Ana', phone: '11987654321', tags: ['VIP'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: TARGET, name: 'Ana', ignored_fields: ['tags'] });
    expect(calls.filter(c => /UPDATE/.test(c.sql))).toHaveLength(2);

    const res2 = await request(app).patch(url).send({ phone: '11987654321' });
    expect(res2.status).toBe(200);
    expect(res2.body).not.toHaveProperty('ignored_fields');
    expect(calls.filter(c => /UPDATE/.test(c.sql))).toHaveLength(3);

    const res3 = await request(app).patch(url).send({ tags: ['VIP'] });
    expect(res3.status).toBe(409);
    expect(res3.body.code).toBe('PROFILE_COLUMNS_MISSING');
  });

  it('POST grava phone_e164 e cai para o INSERT antigo sem a coluna', async () => {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 0 }] };
      if (/INSERT INTO customers/.test(sql)) {
        if (/phone_e164/.test(sql)) throw pgError('42703');
        return { rows: [{ id: TARGET }] };
      }
      throw new Error('inesperada');
    });
    const res = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'Ana', phone: '11 8765-4321' });
    expect(res.status).toBe(201);
    const inserts = calls.filter(c => /INSERT INTO customers/.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params[8]).toBe('5511987654321');
    expect(inserts[1].params).toHaveLength(8);
  });
});
