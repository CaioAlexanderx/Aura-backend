// ============================================================
// AURA. — Testes: 1.3 CPF duplicado no cadastro/edicao de paciente odonto
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

beforeEach(() => jest.clearAllMocks());

describe('POST /dental/patients — CPF duplicado', () => {
  test('409 quando ja existe paciente com o mesmo CPF (compara so digitos)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pat-existente', name: 'Joao Ja Cadastrado' }] }); // dup check

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/patients`)
      .set(auth)
      .send({ full_name: 'Joao Novo', cpf: '123.456.789-00', lgpd_consent: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CPF_DUPLICADO');
    expect(res.body.patient_id).toBe('pat-existente');
    expect(res.body.patient_name).toBe('Joao Ja Cadastrado');

    const dupSql = db.query.mock.calls[1][0];
    expect(dupSql).toMatch(/regexp_replace\(COALESCE\(cpf_cnpj, ''\), '\[\^0-9\]', '', 'g'\)/);
    expect(db.query.mock.calls[1][1]).toEqual([cid, '12345678900']);
  });

  test('allow_duplicate_cpf=true ignora a checagem e cadastra normalmente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: 'novo-id', name: 'Joao Novo' }] }); // INSERT

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/patients`)
      .set(auth)
      .send({ full_name: 'Joao Novo', cpf: '123.456.789-00', lgpd_consent: true, allow_duplicate_cpf: true });

    expect(res.status).toBe(201);
    // so 2 chamadas (companyAccess + INSERT) — nenhuma checagem de duplicata
    expect(db.query.mock.calls.length).toBe(2);
  });

  test('sem CPF no body, nao faz checagem de duplicata', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'novo-id', name: 'Sem CPF' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/patients`)
      .set(auth)
      .send({ full_name: 'Sem CPF', lgpd_consent: true });

    expect(res.status).toBe(201);
    expect(db.query.mock.calls.length).toBe(2);
  });
});

describe('PATCH /dental/patients/:pid — CPF duplicado na edicao', () => {
  test('409 quando o CPF novo pertence a OUTRO paciente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: 'outro-paciente', name: 'Fulano' }] }); // dup check

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/dental/patients/pat-1`)
      .set(auth)
      .send({ cpf: '111.222.333-44' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CPF_DUPLICADO');
    expect(res.body.patient_id).toBe('outro-paciente');

    const dupSql = db.query.mock.calls[1][0];
    expect(dupSql).toMatch(/id != \$2/);
    expect(db.query.mock.calls[1][1]).toEqual([cid, 'pat-1', '11122233344']);
  });

  test('edicao passa quando o CPF pertence ao PROPRIO paciente (nenhuma linha != id encontrada)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] }); // dup check -- nao achou outro paciente
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pat-1', name: 'Fulano', cpf_cnpj: '11122233344' }] }); // UPDATE

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/dental/patients/pat-1`)
      .set(auth)
      .send({ cpf: '111.222.333-44' });

    expect(res.status).toBe(200);
  });
});
