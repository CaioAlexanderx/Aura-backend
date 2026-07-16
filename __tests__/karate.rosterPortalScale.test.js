// ============================================================
// AURA KARATÊ — G1: portal do sensei em escala (400 praticantes)
//
// Cobertura pedida na entrega:
//   (a) link de auto-atendimento NÃO aceita campo fora de contato
//   (b) import casa por identificador estável (matrícula), nunca por nome
//   (c) inativar pelo portal não gera cobrança nem mexe em mais ninguém
//   (d) a ordenação põe preta-ativa-em-aberto no topo
//   (e) GET /:token devolve self_service_url pronto — gera sob demanda
//       quando ausente/expirado, preserva quando já existe válido, degrada
//       para null quando a migration 225 ainda não foi aplicada (13/07/2026)
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
// (a) self-service — ficha inteira, whitelist estrita de campos,
//     identidade (prova) separada de fields (o que muda)
// ════════════════════════════════════════════════════════════
describe('POST /public/roster-self/:token/update — whitelist de campos', () => {
  it('422 FIELD_NOT_ALLOWED quando o body traz chave de topo fora de {student_id, identity, fields}', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', is_active: false, identity: { karate_registration_number: 'FPKT-001' }, fields: { phone: '11999990000' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        // Nunca chega a consultar o banco — a rejeição é antes do resolve do token.
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 FIELD_NOT_ALLOWED quando identity traz chave fora de {birth_date, karate_registration_number}', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-001', belt_level: 'preta' }, fields: { phone: '11999990000' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 FIELD_NOT_ALLOWED quando fields traz is_active (faixa/status intocáveis mesmo mandados no body)', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-001' }, fields: { is_active: false } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 FIELD_NOT_ALLOWED quando fields traz karate_registration_number (FPKT só existe como identity, nunca gravável)', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', identity: { birth_date: '2000-01-01' }, fields: { karate_registration_number: 'FPKT-999' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 FIELD_NOT_ALLOWED quando fields traz dojo_id', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', identity: { birth_date: '2000-01-01' }, fields: { dojo_id: 'dojo-other' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        done();
      });
  });

  it('200 quando fields (ficha inteira) + identity (matrícula) são enviados — SET nunca inclui is_active/faixa/dojo_id/matrícula', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] }) // resolveSelfServiceToken
      .mockResolvedValueOnce({ rows: [{ id: 'pract-1', name: 'Aluno Teste', phone: '11999990000', email: 'aluno@teste.com' }] }) // UPDATE customers
      .mockResolvedValueOnce({ rows: [] }) // evento
      .mockResolvedValueOnce({ rows: [] }); // touch last_accessed_at

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({
        student_id: 'pract-1',
        identity: { karate_registration_number: 'FPKT-001' },
        fields: {
          phone: '(11) 99999-0000',
          email: 'ALUNO@Teste.com',
          cpf: '123.456.789-09',
          rg: '12.345.678-9',
          street: 'Rua Um', number: '100', neighborhood: 'Centro', city: 'São Paulo', state: 'sp', zip_code: '01310-100',
        },
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const updateCall = db.query.mock.calls[1];
        const [setClause, whereClause] = updateCall[0].split(/\bWHERE\b/);
        expect(updateCall[0]).toMatch(/UPDATE customers SET/);
        expect(setClause).not.toMatch(/is_active/);
        expect(setClause).not.toMatch(/\bdojo_id\s*=/); // dojo_id só no WHERE, nunca no SET
        expect(setClause).not.toMatch(/karate_registration_number\s*=/); // nunca gravado (só pode aparecer no WHERE de identidade)
        expect(whereClause).toMatch(/dojo_id\s*=\s*\$2/);
        expect(whereClause).toMatch(/karate_registration_number\s*=\s*\$13/);

        // Normalização: telefone/CPF/CEP viram dígitos, e-mail vira minúsculo, UF vira maiúscula.
        expect(updateCall[1]).toEqual(expect.arrayContaining(['11999990000', 'aluno@teste.com', '12345678909', 'SP', '01310100']));
        done();
      });
  });

  it('422 VALIDATION_ERROR quando um campo normalizável vem inválido (CPF com menos de 11 dígitos)', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-001' }, fields: { cpf: '123.456' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('403 IDENTITY_MISMATCH quando matrícula/nascimento não batem (0 linhas afetadas) — zero mutação', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE não encontrou match de identidade

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-ERRADA' }, fields: { phone: '11999990000' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_MISMATCH');
        // Só 2 chamadas: resolve token + UPDATE que não achou linha. Nenhum
        // evento de auditoria é gravado (nada mudou de fato).
        expect(db.query).toHaveBeenCalledTimes(2);
        done();
      });
  });

  it('praticante de OUTRO dojô (mesmo com identidade certa) não atualiza — escopo do token', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      // WHERE id=$1 AND dojo_id=$2 AND (...) — praticante existe mas é de
      // outro dojô, o WHERE nunca bate, UPDATE devolve 0 linhas.
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({ student_id: 'pract-outro-dojo', identity: { birth_date: '2000-01-01' }, fields: { phone: '11999990000' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_MISMATCH');
        const updateCall = db.query.mock.calls[1];
        expect(updateCall[0]).toMatch(/WHERE id = \$1 AND dojo_id = \$2/);
        expect(updateCall[1][0]).toBe('pract-outro-dojo');
        expect(updateCall[1][1]).toBe(DOJO_ID); // dojo_id vem do TOKEN, nunca do body
        done();
      });
  });

  it('corrige birth_date confirmando identidade por nº FPKT (não pelo próprio nascimento, que está errado)', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pract-1', name: 'Aluno Teste', phone: null, email: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({
        student_id: 'pract-1',
        identity: { karate_registration_number: 'FPKT-001' },
        fields: { birth_date: '2011-04-18' },
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const updateCall = db.query.mock.calls[1];
        expect(updateCall[0]).toMatch(/birth_date = \$3/); // SET com o valor NOVO
        expect(updateCall[0]).toMatch(/karate_registration_number = \$4/); // WHERE usa a matrícula, não o nascimento
        expect(updateCall[1]).toEqual(['pract-1', DOJO_ID, '2011-04-18', 'FPKT-001']);
        done();
      });
  });

  it('a mesma query funciona quando o campo CONFIRMADO (identity.birth_date) é o mesmo sendo ALTERADO (fields.birth_date) — WHERE usa o valor ANTIGO', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pract-1', name: 'Aluno Teste', phone: null, email: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/update`)
      .send({
        student_id: 'pract-1',
        identity: { birth_date: '2000-01-01' }, // valor ANTIGO/correto, prova de identidade
        fields: { birth_date: '2000-01-02' },    // valor NOVO, correção
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const updateCall = db.query.mock.calls[1];
        // SET birth_date = $3 (novo) ... WHERE ... birth_date = $4::date (antigo)
        expect(updateCall[0]).toMatch(/SET birth_date = \$3/);
        expect(updateCall[0]).toMatch(/birth_date = \$4::date/);
        expect(updateCall[1]).toEqual(['pract-1', DOJO_ID, '2000-01-02', '2000-01-01']);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (a2) self-service — leitura da própria ficha (POST /record), ANTES do
//     /update, atrás do MESMO gate de identidade — a feature existe pra
//     REVISAR o cadastro, não digitar no escuro.
// ════════════════════════════════════════════════════════════
describe('POST /public/roster-self/:token/record — leitura da própria ficha', () => {
  it('422 FIELD_NOT_ALLOWED quando o body traz chave de topo fora de {student_id, identity}', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-001' }, fields: { phone: '11999990000' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 FIELD_NOT_ALLOWED quando identity traz chave fora de {birth_date, karate_registration_number}', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-001', belt_level: 'preta' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 VALIDATION_ERROR quando nenhuma identidade é informada', (done) => {
    const app = buildSelfServiceApp();
    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-1', identity: {} })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  // (a) identidade errada → 403 e NÃO devolve a ficha
  it('403 IDENTITY_MISMATCH quando a identidade não bate — resposta não contém a ficha', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] }) // resolveSelfServiceToken
      .mockResolvedValueOnce({ rows: [] }); // SELECT não achou match de identidade

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-ERRADA' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_MISMATCH');
        expect(res.body.fields).toBeUndefined();
        expect(res.body.locked).toBeUndefined();
        expect(res.body.phone).toBeUndefined();
        expect(res.body.name).toBeUndefined();
        done();
      });
  });

  // (b) praticante de OUTRO dojô (mesmo com identidade certa) → escopo do token
  it('praticante de OUTRO dojô não retorna a ficha, mesmo com identidade certa — escopo do token', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      // WHERE id=$1 AND dojo_id=$2 AND (...) — praticante existe mas é de
      // outro dojô, o WHERE nunca bate, SELECT devolve 0 linhas.
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-outro-dojo', identity: { birth_date: '2000-01-01' } })
      .end((err, res) => {
        if (err) return done(err);
        expect([403, 404]).toContain(res.status);
        const selectCall = db.query.mock.calls[1];
        expect(selectCall[0]).toMatch(/WHERE c\.id = \$1 AND c\.dojo_id = \$2/);
        expect(selectCall[1][0]).toBe('pract-outro-dojo');
        expect(selectCall[1][1]).toBe(DOJO_ID); // dojo_id vem do TOKEN, nunca do body
        done();
      });
  });

  // (c) resposta não traz campo fora da lista (nada de is_active/financeiro/terceiro)
  // (d) birth_date sai como YYYY-MM-DD, não "Sun Apr 17" (driver `pg` devolve
  //     Date object pra coluna `date` — toIsoDate cobre isso).
  it('200 devolve só os campos editáveis + travados-leitura; birth_date normalizado YYYY-MM-DD (não "Sun Apr 17")', (done) => {
    const app = buildSelfServiceApp();
    const birthDateObj = new Date('2011-04-18T00:00:00.000Z'); // simula o driver pg devolvendo Date, não string
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'pract-1',
          name: 'Aluno Teste',
          karate_registration_number: 'FPKT-001',
          belt_name: 'Faixa Roxa',
          phone: '11999990000',
          email: 'aluno@teste.com',
          cpf_cnpj: '12345678909',
          rg: '123456789',
          birth_date: birthDateObj,
          street: 'Rua Um', number: '100', complement: null, neighborhood: 'Centro',
          city: 'São Paulo', state: 'SP', zip_code: '01310100',
          // colunas que NUNCA devem vazar mesmo se viessem no row (defesa
          // em profundidade — o SELECT do backend não pede essas colunas,
          // mas o teste garante que o serializador da resposta também não
          // as inclui caso apareçam por engano):
          is_active: false,
          financeiro: 'atrasado',
          guardian_name: 'Dado de Terceiro',
        }],
      });

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-1', identity: { karate_registration_number: 'FPKT-001' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);

        // (d) data normalizada, nunca o toString() de Date ("Sun Apr 17...")
        expect(res.body.fields.birth_date).toBe('2011-04-18');
        expect(res.body.fields.birth_date).not.toMatch(/[A-Za-z]{3} [A-Za-z]{3} \d{2}/);

        // travados-leitura
        expect(res.body.locked).toEqual({
          name: 'Aluno Teste',
          karate_registration_number: 'FPKT-001',
          belt_name: 'Faixa Roxa',
        });

        // editáveis — mesma whitelist de SELF_SERVICE_EDITABLE_FIELDS
        expect(res.body.fields).toEqual({
          phone: '11999990000',
          email: 'aluno@teste.com',
          cpf: '12345678909',
          rg: '123456789',
          birth_date: '2011-04-18',
          street: 'Rua Um',
          number: '100',
          complement: null,
          neighborhood: 'Centro',
          city: 'São Paulo',
          state: 'SP',
          zip_code: '01310100',
        });

        // (c) nada fora da whitelist: sem is_active, financeiro, guardian_*,
        // sem chave solta no nível raiz além de id/locked/fields.
        expect(Object.keys(res.body).sort()).toEqual(['fields', 'id', 'locked']);
        expect(res.body.is_active).toBeUndefined();
        expect(res.body.financeiro).toBeUndefined();
        expect(res.body.guardian_name).toBeUndefined();
        expect(res.body.fields.is_active).toBeUndefined();
        expect(res.body.fields.financeiro).toBeUndefined();
        expect(res.body.fields.guardian_name).toBeUndefined();

        // GET/leitura não muda nada — nenhuma query de UPDATE/INSERT.
        expect(db.query).toHaveBeenCalledTimes(2);
        const selectCall = db.query.mock.calls[1];
        expect(selectCall[0]).toMatch(/^\s*SELECT/);
        expect(selectCall[0]).not.toMatch(/UPDATE|INSERT|DELETE/);
        done();
      });
  });

  it('escopa o SELECT ao dojô do TOKEN, nunca de um dojo_id no body (não existe esse campo no body, mas confirma que o WHERE usa resolved.dojo_id)', (done) => {
    const app = buildSelfServiceApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: FUTURE }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pract-1', name: 'Aluno', karate_registration_number: null, belt_name: null, phone: null, email: null, cpf_cnpj: null, rg: null, birth_date: null, street: null, number: null, complement: null, neighborhood: null, city: null, state: null, zip_code: null }] });

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-1', identity: { birth_date: '2000-01-01' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.fields.birth_date).toBeNull();
        const selectCall = db.query.mock.calls[1];
        expect(selectCall[1]).toEqual(['pract-1', DOJO_ID, '2000-01-01', FED_ID]);
        done();
      });
  });

  it('410 quando o link expirou (mesmo comportamento do /update)', (done) => {
    const app = buildSelfServiceApp();
    const PAST = new Date(Date.now() - 1000).toISOString();
    db.query.mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, self_service_token_expires_at: PAST }] });

    request(app)
      .post(`/public/roster-self/${SELF_TOKEN}/record`)
      .send({ student_id: 'pract-1', identity: { birth_date: '2000-01-01' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(410);
        done();
      });
  });

  it('404 quando o token não resolve (link inválido)', (done) => {
    const app = buildSelfServiceApp();
    db.query.mockResolvedValueOnce({ rows: [] }); // resolveSelfServiceToken não achou nada

    request(app)
      .post(`/public/roster-self/token-invalido/record`)
      .send({ student_id: 'pract-1', identity: { birth_date: '2000-01-01' } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(404);
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
      .mockResolvedValueOnce({ rows: [{ name: 'João', is_active: true }] }) // valor ANTIGO (item 8 — diff antes/depois)
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

        const updateCall = mockClient.query.mock.calls[3];
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
          { id: 'p-c', name: 'Zeca Comum', karate_registration_number: 'R3', is_active: true, phone: '119999', email: 'zeca@x.com',
            birth_date: '2000-01-01', cpf_cnpj: '11111111111', rg: '123456', street: 'Rua A', city: 'São Paulo', state: 'SP',
            belt_name: 'Amarela', financeiro: 'nao_aplicavel', is_black_belt: false },
          { id: 'p-a', name: 'Ana Preta', karate_registration_number: 'R1', is_active: true, phone: '119999', email: 'ana@x.com',
            birth_date: '1990-01-01', cpf_cnpj: '22222222222', rg: '654321', street: 'Rua B', city: 'São Paulo', state: 'SP',
            belt_name: 'Preta', financeiro: 'atrasado', is_black_belt: true },
          // grupo b — item 4: SÓ contato falta aqui de propósito (nascimento/cpf/rg/
          // endereço presentes) pra provar que a régua de completude nova (item 4)
          // não infla `missing` além do que o teste espera.
          { id: 'p-b', name: 'Bruno SemContato', karate_registration_number: 'R2', is_active: true, phone: null, email: null,
            birth_date: '1995-01-01', cpf_cnpj: '33333333333', rg: '789012', street: 'Rua C', city: 'São Paulo', state: 'SP',
            belt_name: 'Verde', financeiro: 'nao_aplicavel', is_black_belt: false },
        ],
      })
      // ensureSelfServiceUrl: UPDATE idempotente (já existia um token válido)
      .mockResolvedValueOnce({ rows: [{ self_service_token: SELF_TOKEN }] });

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

        // self_service_url pronto — não é preciso pedir à federação
        expect(res.body.self_service_url).toContain(`/karate/roster-self/${SELF_TOKEN}`);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (e) GET /:token — self_service_url pronto (sensei não depende da
//     federação pra compartilhar o link com os alunos)
// ════════════════════════════════════════════════════════════
describe('GET /public/roster-update/:token — self_service_url', () => {
  function mockResolveAndQuadro() {
    db.query
      .mockResolvedValueOnce({
        rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, status: 'pending', token_expires_at: FUTURE, dojo_nome: 'Dojô Teste' }],
      })
      .mockResolvedValueOnce({ rows: [] }) // touch last_accessed_at
      .mockResolvedValueOnce({ rows: [] }); // fetchQuadro (sem praticantes, não é o foco deste teste)
  }

  it('devolve a URL pronta quando o dojô já tem self_service_token válido', (done) => {
    const app = buildPortalApp();
    mockResolveAndQuadro();
    db.query.mockResolvedValueOnce({ rows: [{ self_service_token: SELF_TOKEN }] }); // ensureSelfServiceUrl

    request(app)
      .get(`/public/roster-update/${TOKEN}`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.self_service_url).toBe(`https://app.getaura.com.br/karate/roster-self/${SELF_TOKEN}`);
        done();
      });
  });

  it('gera um self_service_token novo sob demanda quando o dojô ainda não tinha (idempotente)', (done) => {
    const app = buildPortalApp();
    mockResolveAndQuadro();
    // A query idempotente devolve o token recém-gerado pelo próprio UPDATE
    // (CASE WHEN NULL/expirado THEN novo) — o teste não precisa saber o
    // valor exato do random, só que veio preenchido.
    db.query.mockResolvedValueOnce({ rows: [{ self_service_token: 'recem-gerado-000' }] });

    request(app)
      .get(`/public/roster-update/${TOKEN}`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.self_service_url).toBe('https://app.getaura.com.br/karate/roster-self/recem-gerado-000');
        done();
      });
  });

  it('degrada para self_service_url: null quando a migration 225 ainda não foi aplicada (42703), sem derrubar o GET', (done) => {
    const app = buildPortalApp();
    mockResolveAndQuadro();
    db.query.mockImplementationOnce(() => {
      const e = new Error('column "self_service_token" does not exist');
      e.code = '42703';
      return Promise.reject(e);
    });

    request(app)
      .get(`/public/roster-update/${TOKEN}`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.self_service_url).toBeNull();
        expect(res.body.dojo_nome).toBe('Dojô Teste');
        done();
      });
  });
});
