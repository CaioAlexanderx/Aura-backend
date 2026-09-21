// ============================================================
// AURA. — Teste: D-QA #6 (2026-09-16)
// Dona que atende sozinha (exatamente 1 dentista ativo cadastrado)
// fica alocada automaticamente na primeira cadeira ativa quando
// nenhuma cadeira tem alocacao ainda — GET /dental/settings e no
// bootstrap do dentista RESPONSAVEL em GET /dental/practitioners.
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

describe('GET /dental/settings — auto-alocacao da dentista solo', () => {
  test('exatamente 1 dentista ativo e nenhuma cadeira alocada -> aloca na 1a cadeira ativa e persiste', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({
      // plan null -> max_chairs=1 (getMaxChairs default), arrays de 1 elemento nao sao paddados
      rows: [{ dental_settings: { chairs_active: [true], chair_practitioner_ids: [null] }, plan: null }],
    }); // SELECT dental_settings, plan
    db.query.mockResolvedValueOnce({ rows: [{ id: 'dent-1' }] }); // SELECT dentistas ativos -> so 1
    db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE companies SET dental_settings

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/settings`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.settings.chair_practitioner_ids).toEqual(['dent-1']);

    const updateCall = db.query.mock.calls[3];
    expect(updateCall[0]).toMatch(/UPDATE companies SET dental_settings/);
    const persisted = JSON.parse(updateCall[1][0]);
    expect(persisted.chair_practitioner_ids).toEqual(['dent-1']);
  });

  test('2+ dentistas ativos -> nao mexe na alocacao', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({
      rows: [{ dental_settings: { chairs_active: [true, true], chair_practitioner_ids: [null, null] }, plan: 'negocio' }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'dent-1' }, { id: 'dent-2' }] }); // 2 ativos

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/settings`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.settings.chair_practitioner_ids).toEqual([null, null]);
    // Sem UPDATE — so as 3 queries acima (companyAccess + settings + practitioners)
    expect(db.query.mock.calls.length).toBe(3);
  });

  test('ja existe alocacao configurada -> nao mexe, mesmo com 1 so dentista ativo', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({
      rows: [{ dental_settings: { chairs_active: [true, true], chair_practitioner_ids: ['dent-1', null] }, plan: 'negocio' }],
    });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/settings`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.settings.chair_practitioner_ids).toEqual(['dent-1', null]);
    // Nao chega a checar quantos dentistas ativos existem (ja tem alocacao)
    expect(db.query.mock.calls.length).toBe(2);
  });

  test('nenhum dentista ativo -> nao mexe', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({
      rows: [{ dental_settings: { chairs_active: [true], chair_practitioner_ids: [null] }, plan: null }],
    });
    db.query.mockResolvedValueOnce({ rows: [] }); // nenhum dentista ativo

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/settings`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.settings.chair_practitioner_ids).toEqual([null]);
  });
});

describe('GET /dental/practitioners — bootstrap do RESPONSAVEL aloca na 1a cadeira', () => {
  test('clinica sem nenhum dentista cadastrado: cria o RESPONSAVEL e ja aloca na cadeira 1', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT dental_practitioners -> vazio, dispara bootstrap
    db.query.mockResolvedValueOnce({ rows: [{ full_name: 'Dra. Ana' }] }); // SELECT owner (companies+users)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'dent-1', name: 'Dra. Ana', is_owner: true, is_active: true }] }); // INSERT dental_practitioners
    db.query.mockResolvedValueOnce({
      rows: [{ dental_settings: { chairs_active: [true], chair_practitioner_ids: [null] }, plan: null }],
    }); // SELECT dental_settings, plan (alocacao automatica)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'dent-1' }] }); // SELECT dentistas ativos -> so a recem-criada
    db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE companies SET dental_settings

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/practitioners`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.bootstrapped).toBe(true);

    const updateCall = db.query.mock.calls[6];
    expect(updateCall[0]).toMatch(/UPDATE companies SET dental_settings/);
    const persisted = JSON.parse(updateCall[1][0]);
    expect(persisted.chair_practitioner_ids).toEqual(['dent-1']);
  });
});
