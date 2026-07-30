// ============================================================
// AURA DOJÔ — Testes Integração: F2 alunos do dojô (registro PRÓPRIO)
// Cobre:
//   CRUD feliz (POST/GET/PATCH/DELETE /federation/:id/dojo/students[...])
//   menor de 18 sem responsável → 422 MENOR_SEM_RESPONSAVEL (form bloqueia)
//   Canal B (token de portal) → GET ok / POST 403 PORTAL_READ_ONLY
//   import em lote (1 ok, 1 cpf duplicado skipped, 1 menor com warning)
//   escopo — queries SEMPRE parametrizadas por req.dojoId (nunca do body)
//   guardians: POST cria + GET lista com contagem de alunos
//   F7.0 — identidade da pessoa (RG, endereço, foto) + sexo normalizado
//
// AUDITORIA F5a (26/07/2026): o shape do aluno ganhou federated,
// fpkt_number e federation_link_status, e o SELECT do PATCH ganhou JOIN.
// A fila posicional deste arquivo CONTINUA válida porque NENHUMA query
// nova entra na frente de nada — os campos federativos vieram por JOIN nas
// MESMAS queries que já existiam. Isso agora está ASSERTADO (o caso do
// PATCH federado conta as queries), e não só afirmado no PR.
//
// AUDITORIA F7.0 (30/07/2026): o INSERT do createStudent ganhou 9 colunas
// de identidade (migration 262) e o SELECT/RETURNING ganhou os mesmos 9
// campos. A fila posicional CONTINUA válida por construção:
//   - as colunas novas entram DEPOIS de $15 (a parte base do INSERT é
//     string literal), então `calls[0][1][0] === dojoId` e
//     `calls[0][1][3] === cpf` continuam apontando para o mesmo lugar —
//     asserção mantida abaixo, agora como GUARDA dessa promessa;
//   - nenhuma query NOVA foi criada: os campos vieram na MESMA query
//     (contagem de chamadas assertada nos casos de POST e PATCH).
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

// Row "crua" do banco. De propósito SEM is_federated/fpkt_number: prova o
// fallback do shape quando a migration 253 ainda não rodou (a coluna não
// vem na row) — nesse caso practitioner_id é a única verdade.
// Idem para os campos da F7.0 (migration 262): ausentes por padrão.
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
    // cpf armazenado normalizado (só dígitos) — o UNIQUE parcial depende disso.
    // F7.0: as colunas de identidade entram DEPOIS de $15, então o índice 3
    // continua sendo o cpf. Esta asserção é o guarda dessa promessa.
    expect(db.query.mock.calls[0][1][3]).toBe('52998224725');
    // F5a: aluno novo nasce cadastro PRIVADO do dojô (e sem query extra)
    expect(res.body.federated).toBe(false);
    expect(res.body.practitioner_id).toBeNull();
    expect(res.body.fpkt_number).toBeNull();
    expect(res.body.federation_link_status).toBe('none');
    expect(db.query.mock.calls.length).toBe(1);
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

  test('GET lista — F5a: os 3 estados do vínculo federativo, na MESMA query', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        // não federado: cadastro privado do dojô
        { ...studentRow(), is_federated: false, has_pending_request: false, fpkt_number: null },
        // solicitação H1 aberta: pendente NÃO é federado (o marcador só vira
        // true quando a federação confirma) — mas o front precisa do estado
        { ...studentRow({ id: 'a2' }), is_federated: false, has_pending_request: true, fpkt_number: null },
        // confirmado pela federação
        {
          ...studentRow({ id: 'a3', practitioner_id: 'p1' }),
          is_federated: true,
          has_pending_request: false,
          fpkt_number: 'FPKT-123',
          practitioner_name: 'João Praticante',
        },
      ],
    });
    const res = await request(app).get(`${base}/students`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.data[0].federated).toBe(false);
    expect(res.body.data[0].federation_link_status).toBe('none');

    expect(res.body.data[1].federated).toBe(false);
    expect(res.body.data[1].federation_link_status).toBe('pending');
    expect(res.body.data[1].practitioner_id).toBeNull();

    expect(res.body.data[2].federated).toBe(true);
    expect(res.body.data[2].federation_link_status).toBe('linked');
    expect(res.body.data[2].fpkt_number).toBe('FPKT-123');
    // uma query só: os campos federativos vêm por JOIN, não por N+1
    expect(db.query.mock.calls.length).toBe(1);
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

  test('PATCH — F5a: estado federativo vem do SELECT que JÁ existia (2 queries, nenhuma nova)', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          ...studentRow({ practitioner_id: 'p1' }),
          is_federated: true,
          has_pending_request: false,
          fpkt_number: 'FPKT-123',
          practitioner_name: 'João Praticante',
        }],
      })                                                                                   // SELECT existente (com JOIN)
      .mockResolvedValueOnce({ rows: [studentRow({ practitioner_id: 'p1', belt_label: 'Amarela' })] }); // UPDATE RETURNING

    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ belt_label: 'Amarela' });

    expect(res.status).toBe(200);
    expect(res.body.belt_label).toBe('Amarela');
    expect(res.body.federated).toBe(true);
    expect(res.body.fpkt_number).toBe('FPKT-123');
    expect(res.body.federation_link_status).toBe('linked');
    // A asserção que protege a fila posicional deste arquivo:
    expect(db.query.mock.calls.length).toBe(2);
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

// ════════════════════════════════════════════════════════════
// F7.0 — a identidade da PESSOA é do DOJÔ (migration 262)
// "O fluxo de informação SOBE: dojô → federação."
// ════════════════════════════════════════════════════════════
describe('F7.0 — identidade do aluno (RG, endereço, foto, sexo)', () => {
  // Posição dos params de identidade no INSERT: é a ordem de IDENTITY_COLS,
  // sempre DEPOIS dos 15 base (por isso dojo_id/$1 e cpf/$4 não se mexem).
  const IDX = {
    rg: 15, zip_code: 16, street: 17, number: 18, complement: 19,
    neighborhood: 20, city: 21, state: 22, karate_photo_url: 23,
  };

  test('POST grava RG + endereço + foto na MESMA query (nenhuma nova)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [studentRow({
        rg: '1234567', zip_code: '66000000', street: 'Av. Nazaré', number: '100',
        complement: 'Apto 2', neighborhood: 'Nazaré', city: 'Belém', state: 'PA',
        karate_photo_url: 'https://cdn/foto.jpg',
      })],
    });

    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({
        full_name: 'Aluno Completo', birth_date: '1990-05-10',
        rg: ' 1234567 ', zip_code: '66.000-000', street: 'Av. Nazaré', number: '100',
        complement: 'Apto 2', neighborhood: 'Nazaré', city: 'Belém', state: 'pa',
        karate_photo_url: 'https://cdn/foto.jpg',
      });

    expect(res.status).toBe(201);
    expect(res.body.rg).toBe('1234567');
    expect(res.body.city).toBe('Belém');
    expect(res.body.karate_photo_url).toBe('https://cdn/foto.jpg');
    expect(db.query.mock.calls.length).toBe(1); // sem N+1

    const params = db.query.mock.calls[0][1];
    expect(params[0]).toBe(dojoId);                 // escopo intacto
    expect(params[IDX.rg]).toBe('1234567');         // trim
    expect(params[IDX.zip_code]).toBe('66000000');  // máscara removida
    expect(params[IDX.state]).toBe('PA');           // UF normalizada (veio 'pa')
    expect(params[IDX.karate_photo_url]).toBe('https://cdn/foto.jpg');
  });

  test('POST aceita sexo no vocabulário LONGO e grava o do dojô (M) — zero mudança visível', async () => {
    db.query.mockResolvedValueOnce({ rows: [studentRow({ sex: 'M' })] });

    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'Aluno Sexo', birth_date: '1990-05-10', sex: 'masculino' });

    expect(res.status).toBe(201);
    // O que vai para o banco continua sendo M/F/other (a migration 262 mantém
    // os dois vocabulários no CHECK; a conversão do dado é F7.2).
    expect(db.query.mock.calls[0][1][4]).toBe('M');
    expect(res.body.sex).toBe('M');
  });

  test('POST sexo irreconhecível continua 422 (inválido é erro, ausente é neutro)', async () => {
    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'Aluno Sexo Ruim', sex: 'nao-sei' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.error).toMatch(/sex inválido/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST zip_code e state inválidos → 422, sem tocar o banco', async () => {
    const cep = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'CEP Ruim', zip_code: '123' });
    expect(cep.status).toBe(422);
    expect(cep.body.error).toMatch(/zip_code/i);

    const uf = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'UF Ruim', state: 'Pará' });
    expect(uf.status).toBe(422);
    expect(uf.body.error).toMatch(/state/i);

    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST ignora campo fora da whitelist (nada de spread do body)', async () => {
    db.query.mockResolvedValueOnce({ rows: [studentRow()] });

    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'Aluno Teste', practitioner_id: 'p-hackeado', is_federated: true, dojo_id: 'outro-dojo' });

    expect(res.status).toBe(201);
    // Só a LISTA DE COLUNAS do INSERT (o RETURNING legitimamente lê
    // practitioner_id — o que não pode é ser ESCRITO por aqui).
    const sql = String(db.query.mock.calls[0][0]);
    const insertCols = sql.slice(sql.indexOf('('), sql.indexOf('VALUES'));
    expect(insertCols).not.toMatch(/practitioner_id/); // federar tem rota própria
    expect(insertCols).not.toMatch(/is_federated/);
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId); // e o dojô é o do token
  });

  test('GET ficha: karate_photo_url cai para photo_url (coluna morta) quando vazia', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ ...studentRow({ photo_url: 'https://cdn/legado.jpg' }), karate_photo_url: null, rg: '99999' }],
    });

    const res = await request(app).get(`${base}/students/${sid}`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.rg).toBe('99999');
    expect(res.body.photo_url).toBe('https://cdn/legado.jpg');        // campo antigo intacto
    expect(res.body.karate_photo_url).toBe('https://cdn/legado.jpg'); // fallback
  });

  test('PATCH grava identidade e mantém o escopo (id + dojo_id no fim dos params)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [studentRow()] })                                      // SELECT existente
      .mockResolvedValueOnce({ rows: [studentRow({ rg: '7654321', city: 'Ananindeua' })] }); // UPDATE RETURNING

    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ rg: '7654321', city: 'Ananindeua' });

    expect(res.status).toBe(200);
    expect(res.body.rg).toBe('7654321');
    expect(res.body.city).toBe('Ananindeua');
    expect(db.query.mock.calls.length).toBe(2); // nenhuma query nova

    const updSql = String(db.query.mock.calls[1][0]);
    expect(updSql).toMatch(/rg = \$1/);
    expect(updSql).toMatch(/city = \$2/);
    const updParams = db.query.mock.calls[1][1];
    expect(updParams[updParams.length - 1]).toBe(dojoId);
    expect(updParams[updParams.length - 2]).toBe(sid);
  });

  // ⚠️ ESTE TESTE FICA POR ÚLTIMO NO ARQUIVO DE PROPÓSITO.
  // O flag HAS_IDENTITY_COLS do service é module-level (é assim que o
  // fallback de deploy parcial funciona: degradou, ficou degradado). Depois
  // que ele vira false, todo caso seguinte deste módulo rodaria degradado.
  test('42703 (migration 262 pendente) → aluno é criado mesmo assim, sem os campos novos', async () => {
    const err42703 = Object.assign(
      new Error('column "zip_code" of relation "karate_dojo_students" does not exist'),
      { code: '42703' }
    );
    db.query
      .mockRejectedValueOnce(err42703)                  // 1ª tentativa: com identidade
      .mockResolvedValueOnce({ rows: [studentRow()] }); // retentativa: sem identidade

    const res = await request(app)
      .post(`${base}/students`)
      .set(canalA())
      .send({ full_name: 'Aluno Deploy Parcial', birth_date: '1990-05-10', rg: '123' });

    expect(res.status).toBe(201);   // NUNCA 500 por causa de schema pendente
    expect(res.body.full_name).toBe('Aluno Teste');
    expect(res.body.rg).toBeNull(); // campo degrada para null, não some do shape
    expect('rg' in res.body).toBe(true);
    // Exatamente UMA retentativa (nunca cadeia de retry)
    expect(db.query.mock.calls.length).toBe(2);
    // 15 params base + 9 de identidade = $24 na primeira; só os base na segunda.
    expect(String(db.query.mock.calls[0][0])).toMatch(/\$24/);
    expect(String(db.query.mock.calls[1][0])).not.toMatch(/\$24/);
    // O shape não muda de formato: as colunas viram NULL::text com o alias.
    expect(String(db.query.mock.calls[1][0])).toMatch(/NULL::text AS zip_code/);
  });
});
