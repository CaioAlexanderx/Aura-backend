// ============================================================
// AURA KARATÊ — F7.0: o approve-create PARA de perder sexo e filiação
//
// DECISÃO DE ARQUITETURA (Caio, 30/07/2026): o fluxo de informação SOBE —
// dojô → federação. O dojô é dono da identidade da pessoa; a federação
// RECEBE. O approve-create (POST /federation/:id/practitioner-requests/
// :requestId/approve-create) era o ponto exato onde isso falhava: o INSERT
// em customers NÃO incluía as colunas `sex` e `affiliation_since`. O sexo é
// OBRIGATÓRIO na ficha H1, viajava dentro do `payload` jsonb — e morria ali.
//
// Este arquivo é o teste de REGRESSÃO desse bug. Ele NÃO substitui
// __tests__/karate.practitionerRequests.test.js (que cobre o contrato de
// aprovação: 422 sem número, 409 duplicado/resolvido, "aprovar não gera
// cobrança"); é aditivo e focado só na identidade que sobe.
//
// ESTILO: mock por SQL (mockImplementation + regex), NUNCA fila posicional
// — convenção da casa desde o CI quebrado do PR #421/#422. Uma query nova
// entrando na frente do handler não pode desalinhar teste nenhum.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const FED_ID = 'fed-uuid-001';
const DOJO_ID = 'dojo-uuid-001';
const REQ_ID = 'req-f70-001';

const adminToken = jwt.sign(
  { id: 'user-admin-001', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karatePractitionerRequestsAdmin'));
  return app;
}

// Solicitação PENDENTE típica do fluxo H1: as colunas próprias trazem
// nome/cpf/rg/nascimento; o resto da ficha (inclusive o SEXO) vive no
// payload jsonb — que é exatamente de onde o dado precisa ser resgatado.
function requestRow(payload) {
  return {
    id: REQ_ID, federation_id: FED_ID, dojo_id: DOJO_ID, status: 'pendente',
    full_name: 'Aluna Aprovada', cpf: '52998224725', rg: '1234567',
    birth_date: '2011-04-18', email: 'aluna@exemplo.com', phone: '91999990000',
    claimed_belt: null, // sem faixa alegada: mantém a transação enxuta
    photo_url: null,
    payload: payload || {},
  };
}

// Despacha por SQL, nunca por posição.
function mockTx() {
  const client = { query: jest.fn(), release: jest.fn() };
  client.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/INSERT INTO customers/i.test(s)) {
      return Promise.resolve({
        rows: [{
          id: 'prac-f70-001',
          name: 'Aluna Aprovada',
          karate_registration_number: '98765-D',
          dojo_id: DOJO_ID,
          // O banco devolveria o que foi gravado; aqui espelhamos os params
          // para provar que a resposta expõe o dado (não volta a ser invisível).
          sex: 'feminino',
          affiliation_since: '2026-07-30',
        }],
      });
    }
    if (/FROM karate_practitioner_requests/i.test(s) && /FOR UPDATE/i.test(s)) {
      return Promise.resolve({ rows: [client.__requestRow] });
    }
    if (/SELECT id FROM customers/i.test(s)) {
      return Promise.resolve({ rows: [] }); // número FPKT livre
    }
    return Promise.resolve({ rows: [] });   // BEGIN/COMMIT/SAVEPOINT/UPDATE/eventos
  });
  return client;
}

function customersInsert(client) {
  return client.query.mock.calls.find((c) => /INSERT INTO customers/i.test(String(c[0])));
}

async function approve(payload) {
  const app = buildAdminApp();
  const client = mockTx();
  client.__requestRow = requestRow(payload);
  db.connect.mockResolvedValue(client);

  const res = await request(app)
    .post(`/federation/${FED_ID}/practitioner-requests/${REQ_ID}/approve-create`)
    .set('Authorization', 'Bearer ' + adminToken)
    .send({ fpkt_number: '98765-D' });

  return { res, client };
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

describe('F7.0 — approve-create grava sexo e filiação no praticante', () => {
  test('REGRESSÃO: o INSERT em customers inclui as colunas sex e affiliation_since', async () => {
    const { res, client } = await approve({ sex: 'F' });

    expect(res.status).toBe(201);
    const insert = customersInsert(client);
    expect(insert).toBeDefined();

    // A prova do bug consertado: antes destas duas colunas não existirem na
    // lista, o sexo obrigatório da ficha simplesmente não chegava ao
    // praticante e alguém teria que redigitar na federação.
    const sql = String(insert[0]);
    const cols = sql.slice(sql.indexOf('('), sql.indexOf('VALUES'));
    expect(cols).toMatch(/\bsex\b/);
    expect(cols).toMatch(/\baffiliation_since\b/);
  });

  test("sexo do dojô ('F') é traduzido para o CANÔNICO de customers ('feminino')", async () => {
    const { res, client } = await approve({ sex: 'F' });

    expect(res.status).toBe(201);
    const params = customersInsert(client)[1];
    // customers.sex tem CHECK em masculino|feminino|outro (migration 205);
    // gravar 'F' cru estouraria o CHECK.
    expect(params).toContain('feminino');
    expect(params).not.toContain('F');
    // E o que foi gravado volta na resposta (dado visível, não invisível).
    expect(res.body.practitioner.sex).toBe('feminino');
  });

  test("sexo já no vocabulário longo ('masculino') passa igual", async () => {
    const { res, client } = await approve({ sex: 'masculino' });

    expect(res.status).toBe(201);
    expect(customersInsert(client)[1]).toContain('masculino');
  });

  test('sexo irreconhecível vira NULL — a aprovação da federação NUNCA cai por causa disso', async () => {
    const { res, client } = await approve({ sex: 'sei-la' });

    expect(res.status).toBe(201); // nada de 500 no ato da federação
    const params = customersInsert(client)[1];
    // O CHECK aceita NULL; o penúltimo param é o sex (o último é a data).
    expect(params[params.length - 2]).toBeNull();
    expect(params).not.toContain('sei-la');
  });

  test('affiliation_since informada pelo dojô é respeitada', async () => {
    const { res, client } = await approve({ sex: 'M', affiliation_since: '2020-03-01' });

    expect(res.status).toBe(201);
    const params = customersInsert(client)[1];
    expect(params[params.length - 1]).toBe('2020-03-01');
  });

  test('sem affiliation_since, o SQL usa a data da APROVAÇÃO (COALESCE ... CURRENT_DATE)', async () => {
    const { res, client } = await approve({ sex: 'M' });

    expect(res.status).toBe(201);
    const insert = customersInsert(client);
    // A federação só afirma o que ELA emitiu — e ela emitiu a filiação
    // hoje. A data nunca é inventada em JS (fuso), quem resolve é o Postgres.
    expect(String(insert[0])).toMatch(/COALESCE\(\$\d+::date, CURRENT_DATE\)/);
    expect(insert[1][insert[1].length - 1]).toBeNull();
  });

  test('payload vazio não quebra nada (dado faltante é neutro)', async () => {
    const { res, client } = await approve({});

    expect(res.status).toBe(201);
    const params = customersInsert(client)[1];
    expect(params[params.length - 2]).toBeNull(); // sex
    expect(params[params.length - 1]).toBeNull(); // affiliation_since
  });
});
