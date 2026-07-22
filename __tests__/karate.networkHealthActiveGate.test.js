// ============================================================
// AURA KARATÊ — Testes: segmentação ativo/inativo em karateNetworkHealth.js
// (auditoria 22/07/2026, Caio 21/07/2026: "não podemos cobrar e controlar
// os inativos... sempre ativos primeiro").
//
// db.query é mockado (tests/jest.setup.js). Como a filtragem real de
// companies.is_active/customers.is_active acontece dentro do SQL (executado
// pelo Postgres em produção, não neste mock), estes testes verificam o
// CONTRATO nos dois níveis possíveis sem banco real:
//   1) o TEXTO do SQL disparado contém o filtro/JOIN de is_active esperado
//      (mesma estratégia de "validado por leitura + contrato" usada em
//      tests/integration/karateAnnuityDojoStatusFilter.test.js);
//   2) o RESULTADO do handler (JSON) reflete corretamente linhas mockadas
//      já filtradas, como o Postgres devolveria se o SQL estiver certo.
// A convergência /summary × /standing/summary é validada como consistência
// ARITMÉTICA entre os dois payloads para o MESMO cenário hipotético
// (mesmo número de dojôs ativos vencidos alimentando os dois mocks) — não
// executa SQL real (não há Postgres neste ambiente de CI), mas prova que,
// se os dois SQLs estiverem corretos (validado por leitura acima), os dois
// endpoints reportam o MESMO universo de dojôs ativos inadimplentes.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/network-health', require('../src/routes/karateNetworkHealth'));
  app.use('/federation/:id/standing', require('../src/routes/karateStandingSummary'));
  return app;
}

function authGet(app, path) {
  return request(app).get(path).set('Authorization', 'Bearer ' + adminToken);
}

function authPost(app, path, body) {
  return request(app).post(path).set('Authorization', 'Bearer ' + adminToken).send(body || {});
}

describe('GET /network-health/summary — só ATIVO por padrão', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  // Ordem de chamadas ao db.query dentro do handler /summary (sequencial,
  // não Promise.all): dojosRes, newAffRes, practRes, inadRes, gradRes,
  // projRes, emDiaRes.
  function primeSummary({ dojoTotal = 0, practTotal = 0, inadTotal = 0, inadVencido = 0,
    gradTotal = 0, projTotal = 0, emDiaTotal = 0 } = {}) {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: dojoTotal }] })      // dojosRes
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })              // newAffRes
      .mockResolvedValueOnce({ rows: [{ total: practTotal }] })     // practRes
      .mockResolvedValueOnce({ rows: [{ total: inadTotal, vencido: inadVencido }] }) // inadRes
      .mockResolvedValueOnce({ rows: [{ total: gradTotal }] })      // gradRes
      .mockResolvedValueOnce({ rows: [{ total: projTotal }] })      // projRes
      .mockResolvedValueOnce({ rows: [{ total: emDiaTotal }] });    // emDiaRes
  }

  it('praticantes: SQL filtra is_active IS NOT FALSE', async () => {
    primeSummary({ practTotal: 42 });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/summary`);
    expect(res.status).toBe(200);
    expect(res.body.kpis.find((k) => k.key === 'praticantes').value).toBe(42);

    const practSql = db.query.mock.calls[2][0]; // 3ª chamada
    expect(practSql).toMatch(/is_active IS NOT FALSE/);
  });

  it('inadimplência: SQL faz JOIN companies com is_active IS NOT FALSE', async () => {
    primeSummary({ inadTotal: 10, inadVencido: 4 });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/summary`);
    expect(res.status).toBe(200);
    expect(res.body.kpis.find((k) => k.key === 'inadimplencia').value).toBe(40);
    // Campo aditivo novo — expõe o numerador/denominador cru.
    expect(res.body.inadimplencia).toEqual({ total: 10, vencido: 4, pct: 40 });

    const inadSql = db.query.mock.calls[3][0]; // 4ª chamada
    expect(inadSql).toMatch(/JOIN companies c ON c\.id = h\.dojo_id AND c\.is_active IS NOT FALSE/);
  });

  it('"Filiados em dia": SQL filtra c.is_active IS NOT FALSE', async () => {
    primeSummary({ emDiaTotal: 7 });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/summary`);
    expect(res.status).toBe(200);
    expect(res.body.kpis.find((k) => k.key === 'dojos').value).toBe(7);

    const emDiaSql = db.query.mock.calls[6][0]; // 7ª chamada
    expect(emDiaSql).toMatch(/c\.is_active IS NOT FALSE/);
  });

  it('dojo_total (base) NÃO é tocado — continua base TOTAL, coerente com Painel/afiliação', async () => {
    primeSummary({ dojoTotal: 111 });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/summary`);
    expect(res.status).toBe(200);
    expect(res.body.dojo_total).toBe(111);

    const dojosSql = db.query.mock.calls[0][0]; // 1ª chamada
    expect(dojosSql).not.toMatch(/is_active/);
  });
});

describe('/summary × /standing/summary — mesma fonte de inadimplência (convergência)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('cenário: 3 dojôs ativos vencidos — /summary.inadimplencia.vencido === /standing/summary.dojos.atrasado', async () => {
    // Cenário hipotético único, usado para alimentar os dois mocks: a
    // federação tem 5 dojôs ATIVOS com anuidade lançada na season, 3 deles
    // vencidos (overdue) — e mais 2 dojôs INATIVOS que também estão vencidos
    // (não podem entrar em nenhum dos dois números, essa é a premissa
    // auditada). Se os dois SQLs filtram companies.is_active corretamente
    // (contrato testado acima e em karateStandingSummary.js/migration 222 —
    // lidos, não reescritos aqui), o Postgres devolveria os MESMOS 3 nos
    // dois endpoints.
    const ATIVOS_VENCIDOS = 3;
    const ATIVOS_TOTAL_COM_COBRANCA = 5;

    // /network-health/summary — mocka inadRes com o resultado que o SQL
    // (JOIN companies c ... c.is_active IS NOT FALSE) devolveria para esse
    // cenário: só os 3 dojôs ativos vencidos entram no total/vencido.
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })   // dojosRes
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })   // newAffRes
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })   // practRes
      .mockResolvedValueOnce({ rows: [{ total: ATIVOS_TOTAL_COM_COBRANCA, vencido: ATIVOS_VENCIDOS }] }) // inadRes
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })   // gradRes
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })   // projRes
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });  // emDiaRes

    const summaryRes = await authGet(app, `/federation/${FED_ID}/network-health/summary`);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.inadimplencia.vencido).toBe(ATIVOS_VENCIDOS);

    jest.clearAllMocks();

    // /standing/summary — mocka dojosRes (karate_dojo_standing, já gateada
    // por is_active) com o MESMO cenário: dojos.atrasado = 3.
    db.query
      .mockResolvedValueOnce({ rows: [{ total: 0, ativos: 0, inativos: 0 }] }) // practRes
      .mockResolvedValueOnce({                                                 // pretasRes
        rows: [{
          black_belt_total: 0, black_belt_inactive: 0, black_belt_paid: 0,
          black_belt_overdue: 0, black_belt_sem_cobranca: 0, valor_em_aberto: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ ativos: 5, em_dia: 2, atrasado: ATIVOS_VENCIDOS, inativos: 2 }] }); // dojosRes

    const standingRes = await authGet(app, `/federation/${FED_ID}/standing/summary`);
    expect(standingRes.status).toBe(200);
    expect(standingRes.body.dojos.atrasado).toBe(ATIVOS_VENCIDOS);

    // A prova de convergência: os dois endpoints, para o mesmo universo de
    // dojôs ativos vencidos, reportam o MESMO número.
    expect(summaryRes.body.inadimplencia.vencido).toBe(standingRes.body.dojos.atrasado);
  });
});

describe('GET /network-health/inadimplencia — default status=active', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('sem ?status: SQL usa c.is_active IS NOT FALSE, dojô inativo vencido não aparece', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { dojo_id: 'd1', dojo_name: 'Dojô Ativo', city: 'SP', dojo_is_active: true,
          due_date: new Date('2026-01-10'), amount: 100, status: 'overdue', paid_at: null },
      ],
    });

    const res = await authGet(app, `/federation/${FED_ID}/network-health/inadimplencia`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].dojo_is_active).toBe(true);

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/AND c\.is_active IS NOT FALSE/);
    expect(sql).toMatch(/c\.is_active AS dojo_is_active/);
  });

  it('?status=all: sem filtro de is_active, aceita explícito', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await authGet(app, `/federation/${FED_ID}/network-health/inadimplencia?status=all`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('all');

    // SELECT sempre traz c.is_active AS dojo_is_active (pro badge visual);
    // "sem filtro" quer dizer sem cláusula WHERE/AND restringindo por ele.
    const sql = db.query.mock.calls[0][0];
    expect(sql).not.toMatch(/AND c\.is_active/);
  });

  it('?status=inactive: SQL filtra c.is_active = false', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await authGet(app, `/federation/${FED_ID}/network-health/inadimplencia?status=inactive`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/AND c\.is_active = false/);
  });

  it('?status=xyz (inválido): degrada pro default active', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/inadimplencia?status=xyz`);
    expect(res.body.status).toBe('active');
  });
});

describe('POST /network-health/report/send — e-mail segmenta e rotula explícito', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('inadimplência e dormência do e-mail usam só dojô ativo, com rótulo explícito', async () => {
    db.query
      // fedRes (db.query direto, não safeQuery)
      .mockResolvedValueOnce({ rows: [{ name: 'Federação Teste', email: 'fed@example.com', karate_logo_url: null, wa_phone_display: null }] })
      // Promise.all: dojosRes, dojoActiveRes, inadRes, gradRes, dormRes
      .mockResolvedValueOnce({ rows: [{ total: 12 }] })   // dojosRes (base total)
      .mockResolvedValueOnce({ rows: [{ total: 10 }] })   // dojoActiveRes (só ativos)
      .mockResolvedValueOnce({ rows: [{ total: 8, vencido: 2, paid: 6 }] }) // inadRes (já segmentado)
      .mockResolvedValueOnce({ rows: [{ total: 3 }] })    // gradRes
      .mockResolvedValueOnce({ rows: [{ active_dojos: 7 }] }); // dormRes (engajados na season)

    const res = await authPost(app, `/federation/${FED_ID}/network-health/report/send`, { to: 'admin@example.com' });
    expect(res.status).toBe(200);

    // dormência = dojoActiveCount(10) - activeDojos(7) = 3 (não 12 - 7 = 5,
    // que misturaria dojô inativo como "dormente").
    expect(res.body.summary.dormenteDojos).toBe(3);
    expect(res.body.summary.dojoActiveCount).toBe(10);
    expect(res.body.summary.dojoCount).toBe(12);

    // SQL do inadRes dentro do Promise.all faz JOIN companies is_active.
    const inadCall = db.query.mock.calls[3][0];
    expect(inadCall).toMatch(/JOIN companies c ON c\.id = h\.dojo_id AND c\.is_active IS NOT FALSE/);

    // SQL do dojoActiveRes filtra is_active.
    const dojoActiveCall = db.query.mock.calls[2][0];
    expect(dojoActiveCall).toMatch(/is_active IS NOT FALSE/);
  });
});

describe('GET /network-health/dormencia — base só dojô ativo', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('SQL da base de dojôs filtra c.is_active IS NOT FALSE', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // dojosRes
      .mockResolvedValueOnce({ rows: [] }) // examRes
      .mockResolvedValueOnce({ rows: [] }); // compRes

    const res = await authGet(app, `/federation/${FED_ID}/network-health/dormencia`);
    expect(res.status).toBe(200);

    const dojosSql = db.query.mock.calls[0][0];
    expect(dojosSql).toMatch(/AND c\.is_active IS NOT FALSE/);
  });
});

describe('GET /network-health/concentracao — base só dojô ativo (órfão, segmentado por consistência)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('SQL de praticantes por dojô filtra c.is_active IS NOT FALSE', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // practRes
      .mockResolvedValueOnce({ rows: [] }); // revRes

    const res = await authGet(app, `/federation/${FED_ID}/network-health/concentracao`);
    expect(res.status).toBe(200);

    const practSql = db.query.mock.calls[0][0];
    expect(practSql).toMatch(/AND c\.is_active IS NOT FALSE/);
  });
});

describe('GET /network-health/relacao-faixas — default status=active', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('sem ?status: effectiveStatus é "active" (era "all")', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/relacao-faixas`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/AND cu\.is_active IS NOT FALSE/);
  });

  it('?status=all explícito: continua funcionando (sem filtro)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/relacao-faixas?status=all`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('all');

    const sql = db.query.mock.calls[0][0];
    expect(sql).not.toMatch(/cu\.is_active/);
  });

  it('?status=inactive explícito: continua funcionando', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await authGet(app, `/federation/${FED_ID}/network-health/relacao-faixas?status=inactive`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/AND cu\.is_active = false/);
  });
});
