// ============================================================
// AURA. — Testes: PUT anamnese preserva os campos do PR20
// (QA odonto 16/09/2026: "Última visita ao dentista" sumia ao reabrir)
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
const pid    = '00000000-0000-0000-0000-0000000000aa';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

beforeEach(() => jest.clearAllMocks());

test('grava ultima_visita_dentista e demais campos do PR20, descarta chave desconhecida', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
  db.query.mockResolvedValueOnce({ rows: [{ id: pid, anamnesis_data: {}, anamnesis_updated_at: new Date() }] });

  const res = await request(app)
    .put(`/api/v1/companies/${cid}/dental/patients/${pid}/anamnesis`)
    .set(auth)
    .send({ data: {
      lgpd_consent: true,
      ultima_visita_dentista: '< 6 meses',
      bisfosfonatos: true,
      etilismo: false,
      ansiedade_dental: true,
      higiene_escovacao: '2x/dia',
      higiene_fio: true,
      queixa_principal: 'Dor no 36',
      historico_familiar: ['Diabetes', 42],
      campo_intruso: 'x',
    } });

  expect(res.status).toBe(200);
  const saved = JSON.parse(db.query.mock.calls[1][1][0]);
  expect(saved).toMatchObject({
    ultima_visita_dentista: '< 6 meses',
    bisfosfonatos: true,
    etilismo: false,
    ansiedade_dental: true,
    higiene_escovacao: '2x/dia',
    higiene_fio: true,
    queixa_principal: 'Dor no 36',
    historico_familiar: ['Diabetes'],
    lgpd_consent: true,
  });
  expect(saved).not.toHaveProperty('campo_intruso');
});
