// ============================================================
// AURA KARATÊ — F7.3-A: o portal do sensei (link público, sem login) não
// sobrescreve ficha mantida por dojô
//
// A DECISÃO (Caio, 30/07/2026):
//   "A federação não faz gestão de informação. O trabalho dela é apenas
//    receber a sincronização dos dados gerenciados pelos dojôs."
//
// Desde a F7.1/F7.2 uma ficha pode estar ADOTADA por um dojô
// (customers.karate_identity_managed_by = 'dojo'): quem digita aquela
// pessoa é o sistema do próprio dojô, e o dado SOBE de lá. Este arquivo
// trava as DUAS portas que karateRosterPortalPublic.js ainda tinha
// abertas:
//
//   PATCH /public/roster-update/:token/practitioners/:studentId
//         — reescrevia telefone, e-mail, CPF, RG, nascimento e endereço;
//   POST  /public/roster-update/:token/import
//         — reescrevia telefone/e-mail em LOTE, por matrícula, a partir de
//           uma planilha que pode estar meses atrasada.
//
// E prova o que NÃO mudou, que é tão importante quanto: is_active segue
// editável (situação é da federação, não é identidade) e, sem a migration
// 262, tudo funciona como antes (sem a coluna não existe ficha adotada).
//
// Estilo: supertest + mock por TEXTO do SQL (sqlRouter). Fila posicional
// está proibida aqui de propósito — foi exatamente o que quebrou os
// outros dois arquivos quando a guarda acrescentou queries.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const TOKEN = 'sensei-token-abc123';
const DOJO_ID = 'dojo-uuid-001';
const FED_ID = 'fed-uuid-001';
const ADOPTING_DOJO_ID = 'dojo-uuid-adotante';
const ADOPTING_DOJO_NAME = 'Dojô Kondei Brasil';
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/roster-update', require('../src/routes/karateRosterPortalPublic'));
  return app;
}

// ── Despacho de mock por SQL (nunca por posição) ────────────
function sqlRouter(routes, fallback = { rows: [] }) {
  return (sql, params) => {
    const text = typeof sql === 'string' ? sql : '';
    for (const [pattern, reply] of routes) {
      if (pattern.test(text)) {
        try {
          return Promise.resolve(typeof reply === 'function' ? reply(text, params) : reply);
        } catch (e) {
          return Promise.reject(e);
        }
      }
    }
    return Promise.resolve(fallback);
  };
}

function findCall(mockFn, pattern) {
  return mockFn.mock.calls.find((c) => typeof c[0] === 'string' && pattern.test(c[0]));
}

function callsMatching(mockFn, pattern) {
  return mockFn.mock.calls.filter((c) => typeof c[0] === 'string' && pattern.test(c[0]));
}

const TOKEN_ROW = { rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] };

// Linha do OWNER_SQL — ficha ADOTADA por um dojô.
function adoptedOwnerRow(id = 'pract-1', name = 'Aluna Teste') {
  return {
    id,
    practitioner_label: name,
    fpkt_number: 'FPKT-001',
    federation_id: FED_ID,
    karate_identity_managed_by: 'dojo',
    karate_identity_dojo_id: ADOPTING_DOJO_ID,
    identity_dojo_name: ADOPTING_DOJO_NAME,
  };
}

// Linha do OWNER_SQL — identidade na FEDERAÇÃO (9.783 de 9.783 hoje).
function federationOwnerRow(id = 'pract-1', name = 'Aluna Teste') {
  return {
    id,
    practitioner_label: name,
    fpkt_number: 'FPKT-001',
    federation_id: FED_ID,
    karate_identity_managed_by: 'federation',
    karate_identity_dojo_id: null,
    identity_dojo_name: null,
  };
}

function mockClientWith(routes) {
  const mockClient = { query: jest.fn(), release: jest.fn() };
  mockClient.query.mockImplementation(sqlRouter(routes));
  db.connect.mockResolvedValue(mockClient);
  return mockClient;
}

// ════════════════════════════════════════════════════════════
// (a) PATCH de campo de identidade em ficha ADOTADA → 409
// ════════════════════════════════════════════════════════════
describe('PATCH /public/roster-update/:token/practitioners/:studentId — ficha mantida por dojô', () => {
  it('409 IDENTITY_MANAGED_BY_DOJO com o NOME do dojô, e NENHUM UPDATE em customers', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, { rows: [adoptedOwnerRow()] }],
    ]);

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ phone: '11999998888', email: 'novo@example.com' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IDENTITY_MANAGED_BY_DOJO');

        // A recusa DIZ qual dojô mantém a ficha — é o que transforma o erro
        // em instrução ("fale com o dojô X") em vez de parede.
        expect(res.body.identity_managed_by).toBe('dojo');
        expect(res.body.identity_dojo).toEqual({ id: ADOPTING_DOJO_ID, name: ADOPTING_DOJO_NAME });
        expect(res.body.error).toContain(ADOPTING_DOJO_NAME);
        expect(res.body.error).toContain('Aluna Teste');
        // Canal público: nada de "peça override" (este link não tem override).
        expect(res.body.error).not.toMatch(/override/i);
        expect(res.body.blocked_fields).toEqual(expect.arrayContaining(['phone', 'email']));

        // O que importa de verdade: a escrita NÃO aconteceu, e a transação
        // foi desfeita.
        expect(callsMatching(mockClient.query, /UPDATE customers/)).toHaveLength(0);
        expect(callsMatching(mockClient.query, /^ROLLBACK$/)).toHaveLength(1);
        expect(mockClient.release).toHaveBeenCalled();
        done();
      });
  });

  it('a leitura do dono é escopada ao dojô do TOKEN (nunca vira sonda de praticante de outro dojô)', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, { rows: [adoptedOwnerRow()] }],
    ]);

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ cpf: '11111111111' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        const ownerCall = findCall(mockClient.query, /practitioner_label/);
        expect(ownerCall[0]).toMatch(/WHERE c\.id = \$1 AND c\.dojo_id = \$2/);
        expect(ownerCall[1]).toEqual(['pract-1', DOJO_ID]); // dojo_id do TOKEN, nunca do body
        // Roda em SAVEPOINT: 42703 aqui não pode envenenar a transação.
        expect(callsMatching(mockClient.query, /^SAVEPOINT sp_identity_owner$/)).toHaveLength(1);
        done();
      });
  });

  it('praticante que não é do dojô do token (zero linha) segue para o UPDATE de sempre — 404 NOT_FOUND, não 409', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, { rows: [] }], // fora do escopo do token
      [/^\s*SELECT name,/, { rows: [] }],
      [/^\s*UPDATE customers SET/, { rows: [] }], // WHERE id + dojo_id não bate
    ]);

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-de-outro-dojo`)
      .send({ phone: '11999998888' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
        expect(mockClient).toBeDefined();
        done();
      });
  });

  it('is_active continua editável em ficha ADOTADA — situação é da federação, não é identidade', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, { rows: [adoptedOwnerRow()] }],
      [/^\s*SELECT name,/, { rows: [{ name: 'Aluna Teste', is_active: true }] }],
      [/^\s*UPDATE customers SET/, { rows: [{ id: 'pract-1', name: 'Aluna Teste', phone: null, email: null, is_active: false }] }],
    ]);
    db.query.mockResolvedValue({ rows: [{ total: 3, resolved: 1 }] });

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ is_active: false })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.is_active).toBe(false);
        const updateCall = findCall(mockClient.query, /^\s*UPDATE customers SET/);
        expect(updateCall[0]).toMatch(/SET is_active = \$2/);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (b) ficha gerida pela FEDERAÇÃO → comportamento idêntico ao de hoje
// ════════════════════════════════════════════════════════════
describe('PATCH /public/roster-update/:token/practitioners/:studentId — ficha da federação', () => {
  it('200 e o UPDATE roda exatamente como antes da F7.3-A', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, { rows: [federationOwnerRow()] }],
      [/^\s*SELECT name,/, { rows: [{ name: 'Aluna Teste', phone: null }] }],
      [/^\s*UPDATE customers SET/, {
        rows: [{
          id: 'pract-1', name: 'Aluna Teste', phone: '11999998888', email: null, is_active: true,
          birth_date: null, cpf_cnpj: null, rg: null, street: null, city: null, state: null,
        }],
      }],
    ]);
    db.query.mockResolvedValue({ rows: [{ total: 3, resolved: 1 }] });

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ phone: '11999998888' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.phone).toBe('11999998888');
        expect(callsMatching(mockClient.query, /UPDATE customers/)).toHaveLength(1);
        expect(callsMatching(mockClient.query, /^COMMIT$/)).toHaveLength(1);
        done();
      });
  });

  it('sem a migration 262 (42703 na leitura do dono) a guarda degrada LIBERANDO — sem a coluna não existe ficha adotada', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, () => {
        const e = new Error('column "karate_identity_managed_by" does not exist');
        e.code = '42703';
        return Promise.reject(e);
      }],
      [/^\s*SELECT name,/, { rows: [{ name: 'Aluna Teste', phone: null }] }],
      [/^\s*UPDATE customers SET/, {
        rows: [{
          id: 'pract-1', name: 'Aluna Teste', phone: '11999998888', email: null, is_active: true,
          birth_date: null, cpf_cnpj: null, rg: null, street: null, city: null, state: null,
        }],
      }],
    ]);
    db.query.mockResolvedValue({ rows: [{ total: 3, resolved: 1 }] });

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ phone: '11999998888' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        // O 42703 foi contido pelo SAVEPOINT — a transação seguiu e commitou.
        expect(callsMatching(mockClient.query, /^ROLLBACK TO SAVEPOINT sp_identity_owner$/)).toHaveLength(1);
        expect(callsMatching(mockClient.query, /^COMMIT$/)).toHaveLength(1);
        expect(callsMatching(mockClient.query, /UPDATE customers/)).toHaveLength(1);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (c) import — pula as linhas de ficha adotada e DECLARA quais
// ════════════════════════════════════════════════════════════
describe('POST /public/roster-update/:token/import — ficha mantida por dojô', () => {
  it('não sobrescreve telefone/e-mail de ficha adotada, atualiza o resto e reporta o que pulou', (done) => {
    const app = buildApp();
    const csv = [
      'Matrícula FPKT;Nome;Telefone;E-mail',
      'FPKT-001;Aluna Adotada;11999990000;adotada@example.com',   // ficha do dojô — não pode ser tocada
      'FPKT-002;Aluno da Federação;11988887777;fed@example.com',  // ficha da federação — segue normal
    ].join('\r\n');

    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      // lote da F7.3-A: só a FPKT-001 está adotada
      [/AS fpkt_number/, {
        rows: [{
          fpkt_number: 'FPKT-001',
          practitioner_label: 'Aluna Adotada',
          karate_identity_dojo_id: ADOPTING_DOJO_ID,
          identity_dojo_name: ADOPTING_DOJO_NAME,
        }],
      }],
      [/^\s*UPDATE customers SET/, { rows: [{ id: 'pract-2', name: 'Aluno da Federação' }] }],
    ]);

    request(app)
      .post(`/public/roster-update/${TOKEN}/import`)
      .send({ csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.atualizados).toBe(1);
        expect(res.body.erros).toEqual([]);

        // Pular em silêncio não vale: a linha volta declarada, com o nome do
        // dojô que mantém a ficha e o que fazer.
        expect(res.body.skipped_identity_managed_by_dojo).toHaveLength(1);
        const pulada = res.body.skipped_identity_managed_by_dojo[0];
        expect(pulada.matricula).toBe('FPKT-001');
        expect(pulada.nome).toBe('Aluna Adotada');
        expect(pulada.identity_dojo).toEqual({ id: ADOPTING_DOJO_ID, name: ADOPTING_DOJO_NAME });
        expect(pulada.motivo).toContain(ADOPTING_DOJO_NAME);
        expect(pulada.row).toBe(2); // linha 2 do CSV (1 é o cabeçalho)

        // Só a linha da federação virou UPDATE.
        const updates = callsMatching(mockClient.query, /UPDATE customers/);
        expect(updates).toHaveLength(1);
        expect(updates[0][1][0]).toBe('FPKT-002');
        done();
      });
  });

  it('UMA query de lote resolve o quadro inteiro (nunca N consultas dentro do loop)', (done) => {
    const app = buildApp();
    const linhas = ['Matrícula FPKT;Nome;Telefone;E-mail'];
    for (let i = 1; i <= 25; i++) {
      linhas.push(`FPKT-${String(i).padStart(3, '0')};Praticante ${i};1199999${String(i).padStart(4, '0')};`);
    }
    const csv = linhas.join('\r\n');

    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/AS fpkt_number/, { rows: [] }],
      [/^\s*UPDATE customers SET/, { rows: [{ id: 'pract-x', name: 'Praticante' }] }],
    ]);

    request(app)
      .post(`/public/roster-update/${TOKEN}/import`)
      .send({ csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.atualizados).toBe(25);

        const loteCalls = callsMatching(mockClient.query, /AS fpkt_number/);
        expect(loteCalls).toHaveLength(1);
        expect(loteCalls[0][0]).toMatch(/= ANY\(\$2::text\[\]\)/);
        expect(loteCalls[0][0]).toMatch(/karate_identity_managed_by = 'dojo'/);
        expect(loteCalls[0][1][0]).toBe(DOJO_ID); // escopado ao dojô do TOKEN
        expect(loteCalls[0][1][1]).toHaveLength(25); // as 25 matrículas, sem repetição
        done();
      });
  });

  it('sem a migration 262 (42703 no lote) o import segue exatamente como antes', (done) => {
    const app = buildApp();
    const csv = ['Matrícula FPKT;Nome;Telefone;E-mail', 'FPKT-001;Alguém;11977776666;'].join('\r\n');

    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/AS fpkt_number/, () => {
        const e = new Error('column "karate_identity_managed_by" does not exist');
        e.code = '42703';
        return Promise.reject(e);
      }],
      [/^\s*UPDATE customers SET/, { rows: [{ id: 'pract-1', name: 'Alguém' }] }],
    ]);

    request(app)
      .post(`/public/roster-update/${TOKEN}/import`)
      .send({ csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.atualizados).toBe(1);
        expect(res.body.skipped_identity_managed_by_dojo).toEqual([]);
        expect(callsMatching(mockClient.query, /^ROLLBACK TO SAVEPOINT sp_identity_batch$/)).toHaveLength(1);
        expect(callsMatching(mockClient.query, /^COMMIT$/)).toHaveLength(1);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (d) override — este canal NÃO tem. Token não é credencial de staff.
// ════════════════════════════════════════════════════════════
describe('override da federação no link público do sensei — a porta não existe', () => {
  it('PATCH com federation_identity_override → 403 IDENTITY_OVERRIDE_NOT_ALLOWED, nunca aceito', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, { rows: [adoptedOwnerRow()] }],
    ]);

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({
        phone: '11999998888',
        federation_identity_override: true,
        identity_override_reason: 'preciso corrigir isto agora',
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_OVERRIDE_NOT_ALLOWED');
        // O pedido é RECUSADO, não ignorado em silêncio — e nada foi escrito.
        expect(callsMatching(mockClient.query, /UPDATE customers/)).toHaveLength(0);
        expect(callsMatching(mockClient.query, /^ROLLBACK$/)).toHaveLength(1);
        done();
      });
  });

  it('PATCH com override numa ficha da FEDERAÇÃO também é 403 — a porta não existe, independe da ficha', (done) => {
    const app = buildApp();
    const mockClient = mockClientWith([
      [/FROM karate_dojo_roster_validation/, TOKEN_ROW],
      [/practitioner_label/, { rows: [federationOwnerRow()] }],
    ]);

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ phone: '11999998888', federation_identity_override: true, identity_override_reason: 'motivo qualquer' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_OVERRIDE_NOT_ALLOWED');
        expect(callsMatching(mockClient.query, /UPDATE customers/)).toHaveLength(0);
        done();
      });
  });

  it('import com federation_identity_override → 403 antes de abrir transação', (done) => {
    const app = buildApp();
    const csv = ['Matrícula FPKT;Nome;Telefone;E-mail', 'FPKT-001;Alguém;11977776666;'].join('\r\n');

    request(app)
      .post(`/public/roster-update/${TOKEN}/import`)
      .send({ csv_content: csv, federation_identity_override: true, identity_override_reason: 'planilha oficial' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_OVERRIDE_NOT_ALLOWED');
        expect(db.connect).not.toHaveBeenCalled(); // nem chega a abrir transação
        done();
      });
  });

  it('override em string ("true") também é recusado — nada de contorno por tipo', (done) => {
    const app = buildApp();
    const csv = ['Matrícula FPKT;Nome;Telefone;E-mail', 'FPKT-001;Alguém;11977776666;'].join('\r\n');

    request(app)
      .post(`/public/roster-update/${TOKEN}/import`)
      .send({ csv_content: csv, federation_identity_override: 'true' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IDENTITY_OVERRIDE_NOT_ALLOWED');
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });
});
