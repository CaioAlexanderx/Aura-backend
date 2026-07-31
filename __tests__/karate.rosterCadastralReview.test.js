// ============================================================
// AURA KARATÊ — Revisão "Atualização Cadastral" (15/07/2026)
//
// Cobertura pedida pelo Caio pros itens 4, 5 e 6 do punch list:
//
//   (4) BUG de completude: apagar nascimento e preencher só e-mail/celular
//       não pode marcar o praticante como "OK". classifyPraticante precisa
//       olhar TODOS os campos que o portal edita (menos `complement`,
//       modificador opcional do endereço).
//   (5) BUG de leitura do RG: o dado nunca foi perdido no banco (é bug de
//       front). Aqui, no backend, o que garantimos é o contrato que
//       sustenta essa garantia — PATCH granular só ALTERA as colunas
//       presentes no body; nunca sobrescreve rg (ou qualquer outro campo)
//       como efeito colateral de salvar OUTRO campo.
//   (6) "Solicitar novo praticante" exige TODOS os campos da ficha,
//       validado no BACKEND (validatePractitionerRequestPayload) — não só
//       no front.
//
// Estilo: mistura unit test direto (sem mock de banco, mais rápido e mais
// fácil de auditar) com um teste de contrato via supertest+mock de
// db.connect para o item 5 (mesmo padrão de karate.rosterPortalScale.test.js).
//
// (30/07/2026 — F7.3-A) O mock do item 5 deixou de ser FILA POSICIONAL e
// passou a despachar por TEXTO do SQL. A guarda de identidade acrescentou
// três queries no PATCH (SAVEPOINT + SELECT do dono da ficha + RELEASE)
// entre o FOR UPDATE do token e a leitura do valor antigo; com fila
// posicional, cada query nova empurra todas as respostas seguintes um
// degrau e o CI quebra por motivo errado. Despacho por SQL é imune a isso.
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

const { classifyPraticante } = require('../src/routes/karateRosterPortalPublic');
const { validatePractitionerRequestPayload } = require('../src/services/karatePractitionerRequestValidation');

// ── Despacho de mock por SQL (nunca por posição) ────────────
// `routes` é uma lista [regex, resposta]; a primeira que casar com o texto
// do SQL responde. BEGIN/COMMIT/SAVEPOINT e qualquer query nova caem no
// fallback sem quebrar nada.
function sqlRouter(routes, fallback = { rows: [] }) {
  return (sql) => {
    const text = typeof sql === 'string' ? sql : '';
    for (const [pattern, reply] of routes) {
      if (pattern.test(text)) return Promise.resolve(typeof reply === 'function' ? reply(text) : reply);
    }
    return Promise.resolve(fallback);
  };
}

function findCall(mockFn, pattern) {
  return mockFn.mock.calls.find((c) => typeof c[0] === 'string' && pattern.test(c[0]));
}

// ════════════════════════════════════════════════════════════
// (4) classifyPraticante — completude olha TODOS os campos, não só contato
// ════════════════════════════════════════════════════════════
describe('classifyPraticante — item 4: completude não pode olhar só telefone/email', () => {
  it('BUG real do Caio: nascimento apagado + só telefone/e-mail preenchidos NÃO pode dar missing:[]', () => {
    const row = {
      is_active: true,
      phone: '11999998888',
      email: 'caio@example.com',
      birth_date: null, // apagado
      cpf_cnpj: '38858871800',
      rg: '388588718',
      street: 'Rua Exemplo', city: 'São Paulo', state: 'SP',
    };
    const { missing } = classifyPraticante(row);
    expect(missing).toContain('nascimento');
    expect(missing.length).toBeGreaterThan(0); // ANTES da correção, isto vinha [] — o bug relatado
  });

  it('registro totalmente preenchido (todos os campos do portal) → missing: []', () => {
    const row = {
      is_active: true,
      phone: '11999998888',
      email: 'aluno@example.com',
      birth_date: '2010-05-10',
      cpf_cnpj: '11111111111',
      rg: '123456',
      street: 'Rua Exemplo', city: 'São Paulo', state: 'SP',
    };
    const { missing } = classifyPraticante(row);
    expect(missing).toEqual([]);
  });

  it('cada campo ausente aparece em missing individualmente (cpf, rg, endereço)', () => {
    const base = {
      is_active: true, phone: '11999998888', email: 'aluno@example.com',
      birth_date: '2010-05-10', cpf_cnpj: '11111111111', rg: '123456',
      street: 'Rua Exemplo', city: 'São Paulo', state: 'SP',
    };
    expect(classifyPraticante({ ...base, cpf_cnpj: null }).missing).toEqual(['cpf']);
    expect(classifyPraticante({ ...base, rg: '' }).missing).toEqual(['rg']);
    expect(classifyPraticante({ ...base, street: null }).missing).toEqual(['endereco']);
    expect(classifyPraticante({ ...base, city: null }).missing).toEqual(['endereco']);
    expect(classifyPraticante({ ...base, state: null }).missing).toEqual(['endereco']);
  });

  it('endereço não exige number/complement/neighborhood/zip_code (só rua+cidade+UF) — mesmo corte da grade de completude do front', () => {
    const row = {
      is_active: true, phone: '11999998888', email: 'aluno@example.com',
      birth_date: '2010-05-10', cpf_cnpj: '11111111111', rg: '123456',
      street: 'Rua Exemplo', city: 'São Paulo', state: 'SP',
      // number/complement/neighborhood/zip_code deliberadamente ausentes
    };
    const { missing } = classifyPraticante(row);
    expect(missing).not.toContain('endereco');
  });
});

// ════════════════════════════════════════════════════════════
// (6) validatePractitionerRequestPayload — TODOS os campos obrigatórios
// ════════════════════════════════════════════════════════════
describe('validatePractitionerRequestPayload — item 6: ficha de solicitação exige tudo', () => {
  const adultPayload = () => ({
    full_name: 'Praticante Teste', birth_date: '1990-01-01', sex: 'M',
    cpf: '11111111111', rg: '123456', phone: '11999998888', email: 'x@example.com',
    claimed_belt: 'Branca',
    street: 'Rua A', number: '10', complement: null, neighborhood: 'Centro', city: 'São Paulo', state: 'SP', zip_code: '01000-000',
    guardian_name: null, guardian_cpf: null, guardian_phone: null, guardian_relationship: null,
  });

  it('ficha de adulto completa → sem erros', () => {
    expect(validatePractitionerRequestPayload(adultPayload())).toEqual([]);
  });

  it('complement ausente NÃO é erro (modificador opcional do endereço)', () => {
    const p = adultPayload();
    delete p.complement;
    expect(validatePractitionerRequestPayload(p)).toEqual([]);
  });

  it.each([
    'full_name', 'birth_date', 'sex', 'cpf', 'rg', 'phone', 'email', 'claimed_belt',
    'zip_code', 'street', 'number', 'neighborhood', 'city', 'state',
  ])('campo "%s" ausente → erro de validação', (field) => {
    const p = adultPayload();
    p[field] = null;
    const errors = validatePractitionerRequestPayload(p);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('menor de 18 sem responsável → 3 erros (nome/telefone/parentesco do responsável)', () => {
    const p = adultPayload();
    p.birth_date = '2015-01-01'; // menor
    const errors = validatePractitionerRequestPayload(p);
    expect(errors.some((e) => /responsável/i.test(e))).toBe(true);
    expect(errors.filter((e) => /responsável/i.test(e)).length).toBe(3);
  });

  it('menor de 18 COM responsável completo → sem erros', () => {
    const p = adultPayload();
    p.birth_date = '2015-01-01';
    p.guardian_name = 'Responsável Teste';
    p.guardian_phone = '11988887777';
    p.guardian_relationship = 'mãe';
    expect(validatePractitionerRequestPayload(p)).toEqual([]);
  });

  it('maior de 18 sem responsável → não exige responsável (não é erro)', () => {
    const p = adultPayload(); // birth_date 1990 — adulto
    const errors = validatePractitionerRequestPayload(p);
    expect(errors.some((e) => /responsável/i.test(e))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// (5) PATCH granular — salvar UM campo nunca apaga outro (garantia que
//     sustenta "o autosave não apaga o RG", a preocupação mais grave do
//     item 5). O bug relatado pelo Caio era de LEITURA no front (RG nunca
//     foi perdido no banco) — aqui travamos o contrato do backend que
//     torna isso estruturalmente impossível: o SET do UPDATE só contém as
//     colunas presentes no body.
// ════════════════════════════════════════════════════════════
describe('PATCH /public/roster-update/:token/practitioners/:studentId — item 5: nunca apaga campo não enviado', () => {
  const TOKEN = 'sensei-token-abc123';
  const DOJO_ID = 'dojo-uuid-001';
  const FED_ID = 'fed-uuid-001';
  const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/public/roster-update', require('../src/routes/karateRosterPortalPublic'));
    return app;
  }

  it('PATCH só de phone gera um UPDATE cujo SET só toca phone (nunca rg/cpf/etc.)', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query.mockImplementation(sqlRouter([
      // token sob FOR UPDATE
      [/FROM karate_dojo_roster_validation/, { rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }],
      // F7.3-A: dono da ficha — federação gerencia, comportamento idêntico ao de sempre
      [/practitioner_label/, {
        rows: [{
          id: 'pract-1',
          practitioner_label: 'Caio',
          fpkt_number: 'FPKT-001',
          federation_id: FED_ID,
          karate_identity_managed_by: 'federation',
          karate_identity_dojo_id: null,
          identity_dojo_name: null,
        }],
      }],
      // valor ANTIGO (item 8 — diff antes/depois)
      [/^\s*SELECT name,/, { rows: [{ name: 'Caio', phone: null }] }],
      // UPDATE customers
      [/^\s*UPDATE customers SET/, {
        rows: [{
          id: 'pract-1', name: 'Caio', phone: '11999998888', email: null, is_active: true,
          birth_date: null, cpf_cnpj: null, rg: '388588718', street: null, city: null, state: null,
        }],
      }],
    ]));

    db.query.mockResolvedValue({ rows: [{ total: 1, resolved: 0 }] }); // progresso

    request(app)
      .patch(`/public/roster-update/${TOKEN}/practitioners/pract-1`)
      .send({ phone: '11999998888' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);

        const updateCall = findCall(mockClient.query, /^\s*UPDATE customers SET/);
        expect(updateCall[0]).toMatch(/SET phone = \$2, updated_at = NOW\(\)/);
        expect(updateCall[0]).not.toMatch(/rg\s*=/);
        expect(updateCall[0]).not.toMatch(/cpf_cnpj\s*=/);
        expect(updateCall[0]).not.toMatch(/birth_date\s*=/);
        // RG devolvido pelo GET/PATCH nunca é reescrito — segue intacto no banco
        // (a UPDATE acima nem toca a coluna).
        done();
      });
  });
});
