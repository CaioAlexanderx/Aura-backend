// ============================================================
// AURA KARATÊ — G1: portal do sensei em escala (400 praticantes)
//
// Cobertura pedida na entrega:
//   (a) link de auto-atendimento NÃO aceita campo fora de contato
//   (b) import casa por identificador estável (matrícula), nunca por nome
//   (c) inativar pelo portal não gera cobrança nem mexe em mais ninguém
//   (d) a ordenação põe preta-ativa-em-aberto no topo
//
// Estilo: supertest + mock sequencial de db.query/db.connect (mesmo padrão
// de __tests__/karate.trackM.routes.test.js) — sem Postgres real.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const express = require('express');
const request = require('supertest');

const TOKEN = 'sensei-token-abc123';
const SELF_TOKEN = 'self-service-token-xyz789';
const DOJO_ID = 'dojo-uuid-001';
const FED_ID = 'fed-uuid-001';

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function buildPortalApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/roster-update', require('../src/routes/karateRosterPortalPublic'));
  return app;
}

function buildSelfServiceApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/roster-self', require('../src/routes/karateRosterSelfServicePublic'));
  return app;
}

// ════════════════════════════════════════════════════════════
// (a) self-service — whitelist estrita de campos
// ════════════════════════════════════════════════════════════
describe('POST /public/roster-self/:token/update — whitelist de campos', () => {
  it('422 quando o body traz campo fora de contato (ex.: is_active)', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', karate_registration_number: 'FPKT-001', is_active: false })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        // Nunca chega a consultar o banco — a rejeição é antes do resolve do token.
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 quando o body traz belt_level (faixa não é contato)', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', birth_date: '2000-01-01', belt_level: 'preta' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        done();
      });
  });

  it('200 quando só telefone/e-mail + identidade (matrícula) são enviados', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] }) // resolveSelfServiceToken
      .mockResolvedValueOnce({ rows: [{ id: 'pract-1', name: 'Aluno Teste', phone: '11999990000', email: null }] }) // UPDATE customers
      .mockResolvedValueOnce({ rows: [] }) // evento
      .mockResolvedValueOnce({ rows: [] }); // touch last_accessed_at

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', karate_registration_number: 'FPKT-001', phone: '11999990000' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        // Confirma que o UPDATE não tocou is_active/faixa — só phone/email no SET.
        const updateCall = db.query.mock.calls[1];
        expect(updateCall[0]).toMatch(/UPDATE customers SET/);
        expect(updateCall[0]).not.toMatch(/is_active/);
        done();
      });
  });

  it('403 IDENTITY_MISMATCH quando matrícula/nascimento não batem (0 linhas afetadas)', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE não encontrou match de identidade

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', karate_registration_number: 'FPKT-ERRADA', phone: '11999990000' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_MISMATCH');
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (b) import — casamento por identificador estável, nunca por nome
// ════════════════════════════════════════════════════════════
describe('POST /public/roster-update/:token/import — casamento por matrícula', () => {
  it('atualiza linha com matrícula válida; linha SEM matrícula vai para erros (não casa por nome)', (done) => {
    const app = buildPortalApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    const csv = [
      'Matrícula FPKT;Nome;Telefone;E-mail',
      'FPKT-001;João da Silva;11999990000;',
      ';Maria Souza;11988887777;', // sem matrícula — mesmo tendo nome, NUNCA deve casar por nome
    ].join('\r\n');

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }) // token FOR UPDATE
      .mockResolvedValueOnce({}) // SAVEPOINT sp_import_row (linha 1)
      .mockResolvedValueOnce({ rows: [{ id: 'pract-1', name: 'João da Silva' }] }) // UPDATE linha 1 (matrícula bate)
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT (linha 1)
      .mockResolvedValueOnce({}) // SAVEPOINT sp_import_row (linha 2 — sem matrícula, curto-circuita antes do UPDATE)
      .mockResolvedValueOnce({}) // ROLLBACK TO SAVEPOINT (linha 2)
      .mockResolvedValueOnce({}) // SAVEPOINT sp_import_event
      .mockResolvedValueOnce({}) // INSERT karate_dojo_roster_events
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}) // SAVEPOINT sp_import_touch
      .mockResolvedValueOnce({}) // UPDATE last_accessed_at
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/public/roster-update/${TOKEN}/import`)
      .send({ csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.atualizados).toBe(1);
        expect(res.body.erros).toHaveLength(1);
        expect(res.body.erros[0].motivo).toMatch(/matr[íi]cula/i);

        // A query de UPDATE só rodou 1x (linha com matrícula) — nunca com
        // WHERE por nome.
        const updateCalls = mockClient.query.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('UPDATE customers')
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0][0]).toMatch(/karate_registration_number = \$1 AND dojo_id = \$2/);
        expect(updateCalls[0][0]).not.toMatch(/name\s*=/i);
        done();
      });
  });

  it('linha com matrícula que não existe neste dojô vira erro (nunca atualiza outro dojô)', (done) => {
    const app = buildPortalApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    const csv = ['Matrícula FPKT;Nome;Telefone;E-mail', 'FPKT-999;Alguém;11977776666;'].join('\r\n');

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] })
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE não encontrou (matrícula de outro dojô ou inexistente)
      .mockResolvedValueOnce({}) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce({}) // SAVEPOINT sp_import_event
      .mockResolvedValueOnce({}) // INSERT evento
      .mockResolvedValueOnce({}) // RELEASE
      .mockResolvedValueOnce({}) // SAVEPOINT sp_import_touch
      .mockResolvedValueOnce({}) // UPDATE last_accessed_at
      .mockResolvedValueOnce({}) // RELEASE
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/public/roster-update/${TOKEN}/import`)
      .send({ csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.atualizados).toBe(0);
        expect(res.body.erros).toHaveLength(1);
        expect(res.body.erros[0].motivo).toMatch(/não encontrada neste dojô/);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (c) inativar pelo portal — não gera cobrança, não mexe em mais ninguém
// ════════════════════════════════════════════════════════════
describe('PATCH /public/roster-update/:token/practitioners/:studentId — inativação', () => {
  it('is_active=false só afeta o praticante alvo; nenhuma query toca transactions/cobrança', (done) => {
    const app = buildPortalApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }) // token FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'pract-1', name: 'João', phone: '119999', email: null, is_active: false }] }) // UPDATE customers
      .mockResolvedValueOnce({}) // SAVEPOINT sp_granular_event
      .mockResolvedValueOnce({}) // INSERT karate_dojo_roster_events
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}) // SAVEPOINT sp_touch_access
      .mockResolvedValueOnce({}) // UPDATE last_accessed_at
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    db.query.mockResolvedValueOnce({ rows: [{ total: 10, resolved: 4 }] }); // progresso pós-PATCH

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ is_active: false })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.is_active).toBe(false);

        const updateCall = mockClient.query.mock.calls[2];
        expect(updateCall[0]).toMatch(/UPDATE customers SET is_active = \$2, updated_at = NOW\(\)/);
        expect(updateCall[0]).toMatch(/WHERE id = \$1 AND dojo_id = \$3/);
        // Params: [studentId, is_active, dojoId] — só ESTE id, escopado ao dojô do token.
        expect(updateCall[1]).toEqual(['pract-1', false, DOJO_ID]);

        // Nenhuma query em toda a transação toca a tabela de transações
        // (inativar não gera cobrança nem mexe em financeiro).
        const allSql = mockClient.query.mock.calls
          .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
          .join('\n');
        expect(allSql).not.toMatch(/\btransactions\b/i);
        expect(allSql).not.toMatch(/UPDATE\s+customers[\s\S]*WHERE\s+dojo_id\s*=\s*\$\d+\s*(;|$)/i); // nunca um UPDATE em lote sem filtro de id

        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (d) ordenação por consequência — preta-ativa-em-aberto no topo
// ════════════════════════════════════════════════════════════
describe('GET /public/roster-update/:token — ordenação por consequência', () => {
  it('grupo a (preta ATIVA em aberto) > grupo b (ativo sem nenhum contato) > grupo c (resto)', (done) => {
    const app = buildPortalApp();

    db.query
      // resolveToken: SELECT join
      .mockResolvedValueOnce({
        rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, status: 'pending', token_expires_at: FUTURE, dojo_nome: 'Dojô Teste' }],
      })
      // resolveToken: touch last_accessed_at
      .mockResolvedValueOnce({ rows: [] })
      // fetchQuadro: SELECT do quadro — de propósito fora de ordem alfabética
      // e fora da ordem de prioridade, para provar que o handler reordena.
      .mockResolvedValueOnce({
        rows: [
          { id: 'p-c', name: 'Zeca Comum', karate_registration_number: 'R3', is_active: true, phone: '119999', email: 'zeca@x.com', belt_name: 'Amarela', financeiro: 'nao_aplicavel', is_black_belt: false },
          { id: 'p-a', name: 'Ana Preta', karate_registration_number: 'R1', is_active: true, phone: '119999', email: 'ana@x.com', belt_name: 'Preta', financeiro: 'atrasado', is_black_belt: true },
          { id: 'p-b', name: 'Bruno SemContato', karate_registration_number: 'R2', is_active: true, phone: null, email: null, belt_name: 'Verde', financeiro: 'nao_aplicavel', is_black_belt: false },
        ],
      });

    request(app)
      .get(`/public/roster-update/${TOKEN}`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const ids = res.body.praticantes.map((p) => p.id);
        expect(ids).toEqual(['p-a', 'p-b', 'p-c']);

        expect(res.body.praticantes[0].priority_group).toBe('a');
        expect(res.body.praticantes[1].priority_group).toBe('b');
        expect(res.body.praticantes[2].priority_group).toBe('c');

        // grupo b tem os dois contatos faltando
        expect(res.body.praticantes[1].missing).toEqual(['telefone', 'email']);
        // grupo c (já tem contato) não deveria ter nada faltando
        expect(res.body.praticantes[2].missing).toEqual([]);

        // contagens: a+b = essenciais, resto = demais
        expect(res.body.counts).toEqual({ essenciais: 2, demais: 1 });
        done();
      });
  });
});
