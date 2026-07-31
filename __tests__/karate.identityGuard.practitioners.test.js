// ============================================================
// AURA DOJÔ — F7.3-A: a federação não reescreve ficha adotada por dojô
//
// A DECISÃO (Caio, 30/07/2026):
//   "A federação não faz gestão de informação. O trabalho dela é apenas
//    receber a sincronização dos dados gerenciados pelos dojôs."
//
// Aqui travamos a porta MAIS usada da federação — a ficha do praticante
// (PATCH /federation/:id/practitioners/:practitionerId) — e o contrato de
// leitura que a tela da F7.3-B usa para entrar em modo somente-leitura
// (GET do detalhe: identity_managed_by + identity_dojo).
//
// O que cada caso prova:
//   (a) campo de IDENTIDADE em ficha adotada → 409 IDENTITY_MANAGED_BY_DOJO,
//       com o NOME do dojô no corpo e identity_dojo preenchido. Nada gravado.
//   (b) só campos FEDERATIVOS em ficha adotada → segue normal (e a guarda
//       nem vai ao banco: papel/matrícula/situação não custam uma query).
//   (b2) body MISTO (federativo + identidade) → 409 na requisição INTEIRA.
//        Gravar metade seria pior: o staff acharia que salvou tudo.
//   (c) override com motivo → grava E escreve a trilha na MESMA transação,
//       com source='federation_admin', ANTES do COMMIT.
//   (d) override sem identity_override_reason → 422, nada gravado.
//   (e) ficha gerida pela FEDERAÇÃO → comportamento idêntico ao de hoje
//       (é o caminho dos 9.783 praticantes de produção).
//   (f) GET do detalhe devolve identity_managed_by / identity_dojo — e
//       degrada para 'federation'/null sem a migration 262.
//
// ── ESTILO DE MOCK: POR SQL, NUNCA POR FILA POSICIONAL ──────
// Este PR ACRESCENTA queries ao PATCH (leitura da guarda, "antes" travado
// e trilha). Qualquer mock que responda pela ORDEM das chamadas passa a
// devolver a linha errada para a query errada no dia em que mais uma
// query entra na frente — foi assim que dois CIs quebraram. Aqui todo
// despacho é por regex de SQL: query nova não desalinha nada.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// role:'admin' é a plataforma: requireCompanyAccess deixa passar sem ir ao
// banco (mesmo token dos outros testes de rota do karatê).
const adminToken = jwt.sign(
  { id: 'user-admin-001', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-001';
const PRAC_ID = 'prac-uuid-001';
const DOJO_ID = 'dojo-uuid-001';
const DOJO_NAME = 'Dojô Kondei Brasil';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/practitioners', require('../src/routes/karatePractitioners'));
  return app;
}

// ── A linha que a guarda lê (services/karateIdentityWriteGuard: OWNER_SQL) ──
const adoptedOwnerRow = {
  id: PRAC_ID,
  practitioner_label: 'Maria da Silva',
  fpkt_number: '12345-D',
  federation_id: FED_ID,
  karate_identity_managed_by: 'dojo',
  karate_identity_dojo_id: DOJO_ID,
  identity_dojo_name: DOJO_NAME,
};

const federationOwnerRow = {
  id: PRAC_ID,
  practitioner_label: 'Maria da Silva',
  fpkt_number: '12345-D',
  federation_id: FED_ID,
  karate_identity_managed_by: 'federation',
  karate_identity_dojo_id: null,
  identity_dojo_name: null,
};

// Linha devolvida pelo SELECT pós-update (e pelo GET de detalhe).
function practitionerRow(extra) {
  return Object.assign({
    id: PRAC_ID, name: 'Maria da Silva', cpf_cnpj: '11111111111', rg: '123456',
    birth_date: '2010-05-10', email: 'maria@example.com', phone: '11999998888',
    is_student: true, parent_guardian_id: null, dojo_id: DOJO_ID,
    is_arbiter: false, is_instructor: false, is_examiner: false, is_assistant: false,
    karate_photo_url: null, karate_registration_number: '12345-D', is_active: true,
    street: 'Rua Um', number: '10', complement: null, neighborhood: 'Centro',
    city: 'São Paulo', state: 'SP', zip_code: '01000000',
    guardian_name: null, guardian_cpf: null, guardian_phone: null, guardian_relationship: null,
    sex: 'feminino', affiliation_since: '2020-01-01',
    belt_level: 3, belt_name: 'Laranja', current_since: '2024-02-01',
  }, extra || {});
}

// ── Despacho por SQL do POOL (db.query) ─────────────────────
// A ordem das regras importa só porque SQLs diferentes compartilham
// tabelas (karate_belt_history aparece no histórico E no last_exam); a
// ordem das CHAMADAS do handler nunca importa.
function mockPool({ owner = null, ownership = null, detail = null, ownershipError = null } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    // Guarda de identidade (OWNER_SQL): única query com practitioner_label.
    if (/c\.name AS practitioner_label/.test(s)) {
      return Promise.resolve({ rows: owner ? [owner] : [] });
    }
    // GET detalhe — quem mantém a ficha (F7.3-A).
    if (/COALESCE\(idj\.trade_name/.test(s)) {
      if (ownershipError) return Promise.reject(ownershipError);
      return Promise.resolve({ rows: ownership ? [ownership] : [] });
    }
    if (/kbh\.graduated_at AS date/.test(s)) return Promise.resolve({ rows: [] });
    if (/karate_belt_exam_candidates/.test(s)) return Promise.resolve({ rows: [{ cnt: 0 }] });
    if (/FROM\s+karate_belt_history/.test(s)) return Promise.resolve({ rows: [] });
    // GET detalhe — a ficha (é o único SELECT com comp.name AS dojo_name).
    if (/comp\.name AS dojo_name/.test(s)) {
      return Promise.resolve({ rows: detail ? [detail] : [] });
    }
    // SELECT pós-update do PATCH.
    if (/karate_current_belt/.test(s)) return Promise.resolve({ rows: [practitionerRow()] });
    return Promise.resolve({ rows: [] });
  });
}

// ── Despacho por SQL do CLIENT da transação ─────────────────
function mockClientTx({ before = null, auditError = null } = {}) {
  const client = { query: jest.fn(), release: jest.fn() };
  client.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(s)) return Promise.resolve({});
    if (/SELECT id, dojo_id FROM customers/i.test(s)) {
      return Promise.resolve({ rows: [{ id: PRAC_ID, dojo_id: DOJO_ID }] });
    }
    if (/FROM customers WHERE id = \$1 FOR UPDATE/i.test(s)) {
      return Promise.resolve({ rows: before ? [before] : [] });
    }
    if (/INSERT INTO karate_identity_audit/i.test(s)) {
      if (auditError) return Promise.reject(auditError);
      return Promise.resolve({ rows: [{ id: 'audit-1' }] });
    }
    if (/INSERT INTO karate_dojo_roster_events/i.test(s)) {
      if (auditError) return Promise.reject(auditError);
      return Promise.resolve({ rows: [{ id: 'evt-1' }] });
    }
    if (/^\s*UPDATE customers SET/i.test(s)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
  db.connect.mockResolvedValue(client);
  return client;
}

const sqlOf = (mockFn) => mockFn.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '')).join('\n');

function patchFicha(app, body) {
  return request(app)
    .patch(`/federation/${FED_ID}/practitioners/${PRAC_ID}`)
    .set('Authorization', 'Bearer ' + adminToken)
    .send(body);
}

let app;
beforeAll(() => { app = buildApp(); });
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.connect.mockReset();
});

// ════════════════════════════════════════════════════════════
// (a) campo de identidade em ficha adotada → 409 com o NOME do dojô
// ════════════════════════════════════════════════════════════
describe('PATCH ficha adotada — campo de identidade é recusado (409)', () => {
  it('(a) 409 IDENTITY_MANAGED_BY_DOJO com o nome do dojô e identity_dojo — nada gravado', (done) => {
    const client = mockClientTx();
    mockPool({ owner: adoptedOwnerRow });

    patchFicha(app, { full_name: 'Nome Que A Federação Tentou Gravar' }).end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDENTITY_MANAGED_BY_DOJO');
      expect(res.body.identity_managed_by).toBe('dojo');
      expect(res.body.identity_dojo).toEqual({ id: DOJO_ID, name: DOJO_NAME });
      // A recusa DIZ qual dojô mantém a ficha — é o ponto inteiro da fase.
      expect(res.body.error).toContain(DOJO_NAME);
      expect(res.body.blocked_fields).toContain('name');

      // Nada gravado: nenhum UPDATE em customers na transação.
      expect(sqlOf(client.query)).not.toMatch(/UPDATE customers/i);
      expect(sqlOf(client.query)).toMatch(/ROLLBACK/);
      done();
    });
  });

  it('(a2) endereço, CPF, RG, sexo e foto também são identidade — recusados igual', (done) => {
    mockClientTx();
    mockPool({ owner: adoptedOwnerRow });

    patchFicha(app, { cpf: '22222222222', rg: '999', city: 'Belém', sex: 'feminino', photo_url: 'https://x/y.jpg' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IDENTITY_MANAGED_BY_DOJO');
        expect(res.body.blocked_fields).toEqual(
          expect.arrayContaining(['cpf_cnpj', 'rg', 'city', 'sex', 'karate_photo_url'])
        );
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (b) campos federativos em ficha adotada → segue normal
// ════════════════════════════════════════════════════════════
describe('PATCH ficha adotada — o que a federação EMITE continua editável', () => {
  it('(b) papéis e situação passam normalmente (e sem custar uma query à guarda)', (done) => {
    const client = mockClientTx();
    mockPool({ owner: adoptedOwnerRow });

    patchFicha(app, { is_active: false, is_arbiter: true }).end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);

      const upd = client.query.mock.calls
        .map((c) => String(c[0]))
        .find((s) => /^\s*UPDATE customers SET/i.test(s));
      expect(upd).toMatch(/is_arbiter = \$/);
      expect(upd).toMatch(/is_active = \$/);
      // Não escorregou para coluna de identidade nenhuma.
      expect(upd).not.toMatch(/\bname\s*=/);
      expect(upd).not.toMatch(/cpf_cnpj\s*=/);

      // A guarda nem foi ao banco: sem campo protegido, não há o que decidir.
      expect(sqlOf(db.query)).not.toMatch(/practitioner_label/);
      // Ficha adotada não vira trilha quando ninguém sobrescreveu identidade.
      expect(sqlOf(client.query)).not.toMatch(/karate_identity_audit/);
      expect(sqlOf(client.query)).toMatch(/COMMIT/);
      done();
    });
  });

  it('(b2) body MISTO (federativo + identidade) é recusado INTEIRO — nem o federativo grava', (done) => {
    const client = mockClientTx();
    mockPool({ owner: adoptedOwnerRow });

    patchFicha(app, { is_active: false, full_name: 'Outro Nome' }).end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDENTITY_MANAGED_BY_DOJO');
      // Gravar metade seria pior que recusar: o staff acharia que salvou tudo.
      expect(sqlOf(client.query)).not.toMatch(/UPDATE customers/i);
      done();
    });
  });
});

// ════════════════════════════════════════════════════════════
// (c) + (d) override — ato explícito, com motivo, e sempre com trilha
// ════════════════════════════════════════════════════════════
describe('PATCH ficha adotada — override da federação', () => {
  it('(c) com motivo: grava E escreve a trilha (source=federation_admin) ANTES do COMMIT', (done) => {
    const client = mockClientTx({ before: { name: 'Nome Antigo' } });
    mockPool({ owner: adoptedOwnerRow });

    patchFicha(app, {
      full_name: 'Nome Corrigido',
      federation_identity_override: true,
      identity_override_reason: 'Determinação judicial 123/2026 — grafia do nome',
    }).end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);

      const calls = client.query.mock.calls.map((c) => String(c[0]));

      // O "antes" foi lido TRAVADO, e só das colunas de identidade que mudam.
      const beforeSel = calls.find((s) => /FOR UPDATE/i.test(s));
      expect(beforeSel).toMatch(/SELECT name FROM customers WHERE id = \$1 FOR UPDATE/);

      // A trilha existe...
      const auditIdx = calls.findIndex((s) => /INSERT INTO karate_identity_audit/i.test(s));
      expect(auditIdx).toBeGreaterThan(-1);
      // ...e vem ANTES do COMMIT: override sem trilha não commita.
      const commitIdx = calls.findIndex((s) => /^\s*COMMIT/i.test(s));
      expect(commitIdx).toBeGreaterThan(auditIdx);

      const auditParams = client.query.mock.calls[auditIdx][1];
      expect(auditParams[1]).toBe(DOJO_ID);            // dojo_id
      expect(auditParams[2]).toBe(PRAC_ID);            // practitioner_id
      expect(auditParams[7]).toBe('sync');             // action (CHECK da 263)
      expect(auditParams[8]).toBe('federation_admin'); // source = o discriminador

      const changes = JSON.parse(auditParams[9]);
      const flag = changes.find((c) => c.field === 'federation_identity_override');
      expect(flag).toBeTruthy();
      expect(flag.reason).toMatch(/judicial/i);
      const nameChange = changes.find((c) => c.field === 'name');
      expect(nameChange).toMatchObject({
        winner: 'federation',
        federation_before: 'Nome Antigo',
        federation_after: 'Nome Corrigido',
      });

      // O UPDATE realmente aconteceu.
      expect(calls.find((s) => /^\s*UPDATE customers SET/i.test(s))).toMatch(/name = \$1/);
      done();
    });
  });

  it('(d) 422 IDENTITY_OVERRIDE_REASON_REQUIRED sem identity_override_reason — nada gravado', (done) => {
    const client = mockClientTx();
    mockPool({ owner: adoptedOwnerRow });

    patchFicha(app, { full_name: 'Nome Corrigido', federation_identity_override: true })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('IDENTITY_OVERRIDE_REASON_REQUIRED');
        expect(res.body.identity_dojo).toEqual({ id: DOJO_ID, name: DOJO_NAME });
        expect(sqlOf(client.query)).not.toMatch(/UPDATE customers/i);
        expect(sqlOf(client.query)).not.toMatch(/karate_identity_audit/i);
        done();
      });
  });

  it('override cuja trilha NÃO pôde ser gravada não commita (a sobrescrita é descartada)', (done) => {
    const boom = Object.assign(new Error('sem trilha'), { code: '42P01' });
    const client = mockClientTx({ before: { name: 'Nome Antigo' }, auditError: boom });
    mockPool({ owner: adoptedOwnerRow });

    patchFicha(app, {
      full_name: 'Nome Corrigido',
      federation_identity_override: true,
      identity_override_reason: 'Correção excepcional documentada',
    }).end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(500);
      const calls = client.query.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => /^\s*ROLLBACK\s*$/i.test(s.trim()))).toBe(true);
      expect(calls.some((s) => /^\s*COMMIT/i.test(s))).toBe(false);
      done();
    });
  });
});

// ════════════════════════════════════════════════════════════
// (e) ficha da federação — o caminho de 9.783 praticantes, intacto
// ════════════════════════════════════════════════════════════
describe('PATCH ficha da FEDERAÇÃO — comportamento idêntico ao de hoje', () => {
  it('(e) campo de identidade grava normalmente, sem trilha e sem leitura travada', (done) => {
    const client = mockClientTx();
    mockPool({ owner: federationOwnerRow });

    patchFicha(app, { full_name: 'Maria da Silva Souza', phone: '11888887777' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(PRAC_ID);

        const all = sqlOf(client.query);
        expect(all).toMatch(/UPDATE customers SET name = \$1, phone = \$2, updated_at = NOW\(\)/);
        expect(all).toMatch(/COMMIT/);
        // Nada de override: sem "antes" travado e sem trilha.
        expect(all).not.toMatch(/FOR UPDATE/i);
        expect(all).not.toMatch(/karate_identity_audit/i);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (f) GET do detalhe — o contrato de leitura da F7.3-B
// ════════════════════════════════════════════════════════════
describe('GET /federation/:id/practitioners/:practitionerId — identity_managed_by / identity_dojo', () => {
  function getFicha() {
    return request(app)
      .get(`/federation/${FED_ID}/practitioners/${PRAC_ID}`)
      .set('Authorization', 'Bearer ' + adminToken);
  }

  it('(f) ficha adotada devolve identity_managed_by:"dojo" e o dojô com id+nome', (done) => {
    mockPool({
      detail: practitionerRow({ dojo_name: DOJO_NAME }),
      ownership: {
        karate_identity_managed_by: 'dojo',
        karate_identity_dojo_id: DOJO_ID,
        identity_dojo_name: DOJO_NAME,
      },
    });

    getFicha().end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);
      expect(res.body.identity_managed_by).toBe('dojo');
      expect(res.body.identity_dojo).toEqual({ id: DOJO_ID, name: DOJO_NAME });
      // O nome do dojô sai de COALESCE(trade_name, legal_name) — companies
      // não é lida por `name` nesta junção (regra da casa).
      expect(sqlOf(db.query)).toMatch(/COALESCE\(idj\.trade_name, idj\.legal_name\) AS identity_dojo_name/);
      done();
    });
  });

  it('(f2) ficha da federação devolve identity_managed_by:"federation" e identity_dojo:null', (done) => {
    mockPool({
      detail: practitionerRow({ dojo_name: 'Dojô Qualquer' }),
      ownership: {
        karate_identity_managed_by: 'federation',
        karate_identity_dojo_id: null,
        identity_dojo_name: null,
      },
    });

    getFicha().end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);
      expect(res.body.identity_managed_by).toBe('federation');
      expect(res.body.identity_dojo).toBeNull();
      done();
    });
  });

  // ÚLTIMO de propósito: o 42703 desliga o cache module-level
  // HAS_IDENTITY_COLS para o resto do arquivo (é estado global do módulo).
  it('(f3) sem a migration 262 (42703) degrada para federation/null e não derruba o GET', (done) => {
    mockPool({
      detail: practitionerRow({ dojo_name: DOJO_NAME }),
      ownershipError: Object.assign(new Error('column does not exist'), { code: '42703' }),
    });

    getFicha().end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);
      expect(res.body.identity_managed_by).toBe('federation');
      expect(res.body.identity_dojo).toBeNull();
      // A ficha em si continua respondendo por inteiro.
      expect(res.body.full_name).toBe('Maria da Silva');
      done();
    });
  });
});
