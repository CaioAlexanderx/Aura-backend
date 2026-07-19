// ============================================================
// AURA DOJÔ — Testes Integração: F2 alunos do dojô (registro PRÓPRIO)
// Cobre:
//   CRUD feliz (POST/GET/PATCH/DELETE /federation/:id/dojo/students[...])
//   menor de 18 sem responsável → 422 MENOR_SEM_RESPONSAVEL (form bloqueia)
//   Canal B (token de portal) → GET ok / POST 403 PORTAL_READ_ONLY
//   import em lote (1 ok, 1 cpf duplicado skipped, 1 menor com warning)
//   escopo — queries SEMPRE parametrizadas por req.dojoId (nunca do body)
//   guardians: POST cria + GET lista com contagem de alunos
//
// REGRA CRÍTICA (padrão karateDojoClaim.test.js): db.query.mockReset() em
// afterEach — jest.clearAllMocks NÃO drena filas mockResolvedValueOnce.
// Import usa transação via db.connect() → client mockado na ordem exata
// (mockImplementationOnce preserva a implementação base do jest.setup).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const sid = 'a1000000-0000-0000-0000-00000000000a';
const base = `/api/v1/federation/${fedId}/dojo`;

// Canal A: JWT de acesso padrão com dojo_id (requireDojoAccess → channel 'A')
const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

// Canal B: token de portal do dojô (somente leitura nas rotas F2)
const canalB = () => ({
  Authorization: `Bearer ${jwt.sign(
    { type: 'portal', scope: 'dojo_portal', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

afterEach(() => {
  db.query.mockReset();
});

const studentRow = (over = {}) => ({
  id: sid,
  full_name: 'Aluno Teste',
  birth_date: '1990-05-10',
  cpf: '52998224725',
  sex: 'M',
  phone: '91999990000',
  email: 'aluno@exemplo.com',
  photo_url: null,
  belt_label: 'Branca',
  belt_order: 1,
  status: 'active',
  guardian_id: null,
  consent_lgpd: false,
  notes: null,
  practitioner_id: null,
  enrolled_at: '2026-07-01',
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
  ...over,
});

// Client de transação: fila Once na ordem exata + default vazio p/ excedentes
function makeTxClient(queue) {
  const client = { query: jest.fn(), release: jest.fn() };
  client.query.mockResolvedValue({ rows: [], rowCount: 0 });
  for (const item of queue) client.query.mockResolvedValueOnce(item);
  return client;
}

describe('F2 — alunos do dojô (registro próprio)', () => {
  test('GET sem token → 401', async () => {
    const res = await request(app).get(`${base}/students`);
    expect(res.status).toBe(401);
  });

  test('POST cria aluno adulto — dojo_id vem do TOKEN, cpf normalizado', async () => {
    db.query.mockResolvedValueOnce({ rows: [studentRow()] }); // INSERT RETURNING
    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'Aluno Teste', birth_date: '1990-05-10', cpf: '529.982.247-25', belt_label: 'Branca', belt_order: 1 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(sid);
    expect(res.body.age).toBeGreaterThanOrEqual(18);
    expect(res.body.guardian).toBeNull();
    // escopo: dojo_id do INSERT é o do token (req.dojoId), nunca do body
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);
    // cpf armazenado normalizado (só dígitos) — o UNIQUE parcial depende disso
    expect(db.query.mock.calls[0][1][3]).toBe('52998224725');
  });

  test('POST menor de 18 sem responsável → 422 MENOR_SEM_RESPONSAVEL (sem tocar o banco)', async () => {
    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'Criança Sem Responsável', birth_date: '2015-01-01' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MENOR_SEM_RESPONSAVEL');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST menor COM guardian_id passa (guardian validado no escopo do dojô)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'g1', full_name: 'Mãe Zelosa', phone: null, relationship: 'mãe' }] }) // guardian check
      .mockResolvedValueOnce({ rows: [studentRow({ birth_date: '2015-01-01', guardian_id: 'g1' })] });            // INSERT
    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'Criança Com Responsável', birth_date: '2015-01-01', guardian_id: 'g1' });

    expect(res.status).toBe(201);
    expect(res.body.guardian).toEqual({ id: 'g1', full_name: 'Mãe Zelosa', phone: null, relationship: 'mãe' });
    expect(db.query.mock.calls[0][1]).toEqual(['g1', dojoId]);
  });

  test('GET lista — filtro status + escopo por req.dojoId', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ ...studentRow(), guardian_full_name: null, guardian_phone: null, guardian_relationship: null }],
    });
    const res = await request(app).get(`${base}/students?status=active`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].full_name).toBe('Aluno Teste');
    const params = db.query.mock.calls[0][1];
    expect(params[0]).toBe(dojoId);
    expect(params[1]).toBe('active');
  });

  test('GET lista com summary=1 devolve totais + pirâmide por faixa', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })                                              // lista
      .mockResolvedValueOnce({ rows: [{ total: 3, active: 2, inactive: 1 }] })          // totais
      .mockResolvedValueOnce({ rows: [{ belt_label: 'Branca', belt_order: 1, count: 2 }] }); // pirâmide
    const res = await request(app).get(`${base}/students?summary=1`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(3);
    expect(res.body.summary.active).toBe(2);
    expect(res.body.summary.by_belt).toEqual([{ belt_label: 'Branca', belt_order: 1, count: 2 }]);
  });

  test('GET ficha de aluno de OUTRO dojô → 404 (query parametrizada por req.dojoId)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`${base}/students/${sid}`).set(canalA());

    expect(res.status).toBe(404);
    expect(db.query.mock.calls[0][1]).toEqual([sid, dojoId]);
  });

  test('PATCH parcial — UPDATE escopado por id + dojo_id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [studentRow()] })                                        // SELECT existente
      .mockResolvedValueOnce({ rows: [studentRow({ belt_label: 'Amarela', belt_order: 2 })] }); // UPDATE RETURNING
    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ belt_label: 'Amarela', belt_order: 2 });

    expect(res.status).toBe(200);
    expect(res.body.belt_label).toBe('Amarela');
    const updParams = db.query.mock.calls[1][1];
    expect(updParams[updParams.length - 1]).toBe(dojoId);
    expect(updParams[updParams.length - 2]).toBe(sid);
  });

  test('PATCH que TORNA menor sem responsável → 422 (estado resultante, não só o patch)', async () => {
    db.query.mockResolvedValueOnce({ rows: [studentRow()] }); // existente: adulto, sem guardian
    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ birth_date: '2015-01-01' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MENOR_SEM_RESPONSAVEL');
    expect(db.query.mock.calls.length).toBe(1); // não chegou no UPDATE
  });

  test('DELETE remove (por ora delete real — F3 vira 409 HAS_HISTORY)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: sid }] });
    const res = await request(app).delete(`${base}/students/${sid}`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(db.query.mock.calls[0][1]).toEqual([sid, dojoId]);
  });

  test('Canal B (portal): GET lista OK / POST 403 PORTAL_READ_ONLY', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const g = await request(app).get(`${base}/students`).set(canalB());
    expect(g.status).toBe(200);

    db.query.mockReset();
    const p = await request(app).post(`${base}/students`).set(canalB()).send({ full_name: 'X' });
    expect(p.status).toBe(403);
    expect(p.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('import: 1 ok, 1 cpf duplicado skipped, 1 menor com warning — transação única', async () => {
    const client = makeTxClient([
      {},                        // BEGIN
      { rows: [] },              // dup check linha 1 (cpf inédito)
      { rows: [{ id: 'i1' }] },  // INSERT linha 1
      { rows: [{ id: 'i3' }] },  // INSERT linha 3 (menor, sem cpf)
      {},                        // COMMIT
    ]);
    db.connect.mockImplementationOnce(() => client);

    const res = await request(app)
      .post(`${base}/students/import`)
      .set(canalA())
      .send({
        rows: [
          { full_name: 'Adulto Um', birth_date: '1990-01-01', cpf: '529.982.247-25' },
          { full_name: 'Adulto Dois', birth_date: '1991-02-02', cpf: '52998224725' }, // mesmo cpf normalizado
          { full_name: 'Criança Três', birth_date: '2015-03-03' },                     // menor sem responsável
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped).toBe(1);
    expect(res.body.warnings.some((w) => w.row === 2 && w.code === 'DUP_CPF')).toBe(true);
    expect(res.body.warnings.some((w) => w.row === 3 && w.code === 'MENOR_SEM_RESPONSAVEL')).toBe(true);

    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    // INSERTs escopados pelo dojô do token
    const inserts = client.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO karate_dojo_students'));
    expect(inserts.length).toBe(2);
    for (const c of inserts) expect(c[1][0]).toBe(dojoId);
    expect(client.release).toHaveBeenCalled();
  });

  test('import Canal B → 403 (portal não importa)', async () => {
    const res = await request(app)
      .post(`${base}/students/import`)
      .set(canalB())
      .send({ rows: [{ full_name: 'X' }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
  });

  test('guardians: POST cria + GET lista com contagem de alunos vinculados', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'g1', full_name: 'Mãe Zelosa', cpf: null, phone: '91988880000', email: null, relationship: 'mãe', created_at: '2026-07-19T00:00:00Z', updated_at: '2026-07-19T00:00:00Z' }],
    });
    const p = await request(app)
      .post(`${base}/guardians`)
      .set(canalA())
      .send({ full_name: 'Mãe Zelosa', phone: '91988880000', relationship: 'mãe' });
    expect(p.status).toBe(201);
    expect(p.body.id).toBe('g1');
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);

    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'g1', full_name: 'Mãe Zelosa', cpf: null, phone: '91988880000', email: null, relationship: 'mãe', students_count: 2, created_at: '2026-07-19T00:00:00Z', updated_at: '2026-07-19T00:00:00Z' }],
    });
    const g = await request(app).get(`${base}/guardians`).set(canalB()); // GET aceita Canal B
    expect(g.status).toBe(200);
    expect(g.body.data[0].students_count).toBe(2);
  });
});
