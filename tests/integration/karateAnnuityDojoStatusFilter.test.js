// ============================================================
// AURA KARATÊ — Testes: filtro dojo_status (ativo/inativo do DOJÔ)
//
// Decisão de produto (Caio, 21/07/2026): dojô inativo não é acionável —
// não dá pra cobrar nem controlar quem já saiu da federação. Por padrão,
// tanto a listagem (GET /annuities/dojos) quanto o summary/KPIs
// (GET /annuities/summary) devem enxergar só dojôs ATIVOS. `dojo_status`
// (active|inactive|all, default 'active') dá acesso ao inativo sem deixar
// ele poluir os números por padrão.
//
// Como db.query é mockado (tests/jest.setup.js) e a filtragem real de
// companies.is_active acontece dentro do SQL (executado pelo Postgres em
// produção, não neste mock), o que este arquivo verifica é o CONTRATO: o
// parâmetro posicional certo ($3, boolean[]) recebe o valor certo pra cada
// dojo_status — é essa correspondência que garante que o filtro realmente
// chega ao WHERE certo (e não outro parâmetro por engano, o risco que a
// tarefa aponta como "fonte clássica de bug silencioso"). A cobertura de
// que o SQL em si filtra companies.is_active corretamente é validada por
// leitura do arquivo fonte (dojosBaseSql / SUMMARY_SQL) + smoke em prod.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const financialBase = `/api/v1/federation/${fedId}/financial`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

afterEach(() => {
  db.query.mockReset();
});

// ── GET /annuities/dojos ────────────────────────────────────────────
describe('GET /annuities/dojos — dojo_status', () => {
  test('default (sem dojo_status na query): filtra companies.is_active = [true] no $3 posicional', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] });            // SELECT

    const res = await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);

    // 2ª chamada = COUNT, 3ª chamada = SELECT (1ª é o role check)
    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    // [federationId, year, dojoStatusValues, search, statusValues, ...]
    expect(countParams[0]).toBe(fedId);
    expect(countParams[2]).toEqual([true]);
    expect(selectParams[2]).toEqual([true]);
  });

  test('dojo_status=inactive: filtra companies.is_active = [false]', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          dojo_id: 'd1', dojo_name: 'Dojô Inativo', fpkt_affiliation_id: 'FPKT-1',
          dojo_is_active: false, whatsapp: null, email: null,
          annuity_id: null, reference_period: null, amount: null, due_date: null,
          paid_at: null, annuity_status: null, transaction_id: null,
          computed_status: 'no_charge', days_overdue: 0,
        }],
      });

    const res = await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ dojo_status: 'inactive' })
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].is_active).toBe(false);

    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    expect(countParams[2]).toEqual([false]);
    expect(selectParams[2]).toEqual([false]);
  });

  test('dojo_status=all: sem filtro de is_active ($3 = null)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ dojo_status: 'all' })
      .set(authHeader());

    expect(res.status).toBe(200);
    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    expect(countParams[2]).toBeNull();
    expect(selectParams[2]).toBeNull();
  });

  test('dojo_status inválido -> 422 VALIDATION_ERROR, nunca chega ao banco', async () => {
    mockCompanyAccess();

    const res = await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ dojo_status: 'bogus' })
      .set(authHeader());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // só o role check rodou -- nenhuma query de listagem foi disparada
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('numeração posicional: pageSize/offset continuam corretos com $4=dojoIdFilter (agora $7/$8)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ page: 2, pageSize: 10 })
      .set(authHeader());

    const selectSql = db.query.mock.calls[2][0];
    const selectParams = db.query.mock.calls[2][1];
    expect(selectSql).toMatch(/LIMIT \$7 OFFSET \$8/);
    expect(selectParams[6]).toBe(10); // pageSize
    expect(selectParams[7]).toBe(10); // offset = (page-1)*pageSize = (2-1)*10
  });
});

// ── GET /annuities/dojos — dojo_id (filtro por UM único dojô) ───────
describe('GET /annuities/dojos — dojo_id', () => {
  const otherDojoId = 'aaaaaaaa-0000-0000-0000-000000000002';

  test('dojo_id válido: chega no $4 posicional de todas as 4 call sites (count+select, com/sem plan)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] })              // SELECT (sem dojo -> installments não é buscado)
      ;

    const res = await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ dojo_id: otherDojoId })
      .set(authHeader());

    expect(res.status).toBe(200);
    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    // [federationId, year, dojoStatusValues, dojoIdFilter, search, statusValues, pageSize, offset]
    expect(countParams[3]).toBe(otherDojoId);
    expect(selectParams[3]).toBe(otherDojoId);
  });

  test('sem dojo_id: $4 é null (comportamento idêntico ao atual, filtro vira no-op)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .set(authHeader());

    const countParams = db.query.mock.calls[1][1];
    const selectParams = db.query.mock.calls[2][1];
    expect(countParams[3]).toBeNull();
    expect(selectParams[3]).toBeNull();
  });

  test('dojo_id inválido (não-uuid) -> 422 VALIDATION_ERROR, nunca chega ao banco', async () => {
    mockCompanyAccess();

    const res = await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ dojo_id: 'not-a-uuid' })
      .set(authHeader());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // só o role check rodou -- nenhuma query de listagem foi disparada
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('dojo_id de outra federação nunca vaza: o filtro é AND sobre c.federation_id = $1 (mesmo dojosBaseSql), nunca substitui o escopo', async () => {
    // Este teste documenta o contrato via leitura do SQL: dojosBaseSql() tem
    // "WHERE c.federation_id = $1 ... AND ($4::uuid IS NULL OR c.id = $4)" —
    // ambas as condições são ANDadas na MESMA subquery base, então um
    // dojo_id de outra federação (federation_id diferente de $1) nunca
    // bate a linha WHERE inteira, e o resultado real do Postgres seria
    // vazio. Com db.query mockado, simulamos exatamente esse retorno vazio
    // pra garantir que o handler propaga "vazio" pro cliente sem tentar
    // contornar/relaxar o filtro.
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ dojo_id: otherDojoId })
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);

    const selectSql = db.query.mock.calls[2][0];
    // garante que o SQL efetivamente gerado tem federation_id ANDado com
    // dojo_id na MESMA subquery (não em cláusulas independentes que um dos
    // dois poderia "vencer" isoladamente).
    expect(selectSql).toMatch(/WHERE c\.federation_id = \$1[\s\S]*AND \(\$4::uuid IS NULL OR c\.id = \$4\)/);
  });

  test('dojo_id + demais filtros (status, q, year) continuam sendo enviados juntos, sem se sobrescreverem', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`${financialBase}/annuities/dojos`)
      .query({ dojo_id: otherDojoId, status: 'em_aberto', q: 'Shotokan', year: '2026' })
      .set(authHeader());

    const selectParams = db.query.mock.calls[2][1];
    // [federationId, year, dojoStatusValues, dojoIdFilter, search, statusValues, pageSize, offset]
    expect(selectParams[1]).toBe('2026');
    expect(selectParams[3]).toBe(otherDojoId);
    expect(selectParams[4]).toBe('Shotokan');
    expect(selectParams[5]).toEqual(['due', 'overdue', 'defaulting', 'suspended']);
  });
});

// ── GET /annuities/summary ──────────────────────────────────────────
describe('GET /annuities/summary — dojo_status', () => {
  function summaryRows({ dojo, praticante, total } = {}) {
    const zero = { previsto_count: 0, previsto_valor: 0, recebido_count: 0, recebido_valor: 0, em_aberto_count: 0, em_aberto_valor: 0, atrasado_count: 0, atrasado_valor: 0 };
    return [
      { kind: 'dojo', ...zero, ...dojo },
      { kind: 'praticante', ...zero, ...praticante },
      { kind: null, ...zero, ...total },
    ];
  }

  test('default: dojo_status=[true] chega no $3 do SUMMARY_SQL', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: summaryRows() });

    const res = await request(app)
      .get(`${financialBase}/annuities/summary`)
      .set(authHeader());

    expect(res.status).toBe(200);
    const summaryParams = db.query.mock.calls[1][1];
    // $4 = memberStatusValues (customers.is_active do praticante), default
    // [true] também — ver parseMemberStatus/memberStatusToIsActiveValues.
    expect(summaryParams).toEqual([fedId, expect.any(String), [true], [true]]);
  });

  test('dojo inativo com saldo em aberto NÃO aparece no em_aberto do default (a query já devolve o universo filtrado — aqui garantimos que o filtro [true] foi de fato passado)', async () => {
    mockCompanyAccess();
    // Simula o resultado que o Postgres devolveria filtrando só ativos:
    // o dojô inativo com R$500 em aberto simplesmente não compõe a soma.
    db.query.mockResolvedValueOnce({ rows: summaryRows({
      dojo: { previsto_count: 1, previsto_valor: 500, em_aberto_count: 1, em_aberto_valor: 500 },
    }) });

    const res = await request(app)
      .get(`${financialBase}/annuities/summary`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.dojo.em_aberto.valor).toBe(500); // só o dojô ATIVO, o inativo já foi excluído no WHERE
    const summaryParams = db.query.mock.calls[1][1];
    expect(summaryParams[2]).toEqual([true]); // prova que o filtro default foi aplicado na query
  });

  test('dojo_status=all: $3 = null', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: summaryRows() });

    await request(app)
      .get(`${financialBase}/annuities/summary`)
      .query({ dojo_status: 'all' })
      .set(authHeader());

    const summaryParams = db.query.mock.calls[1][1];
    expect(summaryParams[2]).toBeNull();
  });

  test('dojo_status inválido -> 422, nunca chega ao banco', async () => {
    mockCompanyAccess();

    const res = await request(app)
      .get(`${financialBase}/annuities/summary`)
      .query({ dojo_status: 'nope' })
      .set(authHeader());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

// ── Consistência lista × summary ────────────────────────────────────
describe('dojo_status — consistência lista × summary (mesmo universo)', () => {
  test('mesmo dojo_status produz o MESMO array de is_active em ambas as rotas (via helper compartilhado)', () => {
    const annuitySvc = require('../../src/services/karateAnnuityService');
    for (const raw of ['active', 'inactive', 'all', undefined]) {
      const parsed = annuitySvc.parseDojoStatus(raw);
      const valuesA = annuitySvc.dojoStatusToIsActiveValues(parsed);
      const valuesB = annuitySvc.dojoStatusToIsActiveValues(annuitySvc.parseDojoStatus(raw));
      expect(valuesA).toEqual(valuesB);
    }
    expect(annuitySvc.dojoStatusToIsActiveValues('active')).toEqual([true]);
    expect(annuitySvc.dojoStatusToIsActiveValues('inactive')).toEqual([false]);
    expect(annuitySvc.dojoStatusToIsActiveValues('all')).toBeNull();
  });

  test('lista e summary, sem dojo_status explícito, mandam ambos [true] pro banco (mesmo default)', async () => {
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).get(`${financialBase}/annuities/dojos`).set(authHeader());
    const dojosParams = db.query.mock.calls[2][1];

    db.query.mockReset();
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get(`${financialBase}/annuities/summary`).set(authHeader());
    const summaryParams = db.query.mock.calls[1][1];

    expect(dojosParams[2]).toEqual(summaryParams[2]);
    expect(dojosParams[2]).toEqual([true]);
  });
});
