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
//   F7.2 — sync contínuo dojô → federação no PATCH e no import
//   F8 — upload de foto do aluno + responsável sincroniza para a federação
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
// AUDITORIA F7.2 (30/07/2026): updateStudent passou a poder rodar DENTRO
// de uma transação (db.connect) para sincronizar a ficha da federação.
// NENHUM caso deste arquivo mudou de comportamento, e isso é por desenho,
// não por sorte: a transação só abre quando as TRÊS condições valem —
// o PATCH tocou em IDENTIDADE, o aluno tem practitioner_id, e a 262 está
// aplicada. Os casos existentes ou mexem em faixa/status (não é
// identidade) ou usam studentRow() com practitioner_id null. Os dois
// casos que passariam perto estão marcados abaixo com a razão.
// DUAS mudanças estruturais foram necessárias:
//   1. afterEach agora reseta db.connect também (e restaura a
//      implementação base do jest.setup) — sem isso o client de uma
//      transação vazaria para o caso seguinte;
//   2. o caso do 42703 saiu para um describe PRÓPRIO, no fim do arquivo.
//      Ele desliga HAS_IDENTITY_COLS (flag module-level, é assim que o
//      fallback de deploy parcial funciona) e, a partir dali, needsSync é
//      sempre false — todo caso de sync declarado depois passaria "verde"
//      sem testar nada.
//
// AUDITORIA F8 (31/07/2026): dois pontos de entrada novos —
//   POST /dojo/students/:sid/photo reusa uploadToR2 (mockado neste
//     arquivo: o SDK do R2 é responsabilidade de r2Storage.js, aqui só o
//     CONTRATO da rota é testado) e o MESMO caminho transacional do PATCH
//     (updateStudentWithSync) quando o aluno tem ficha adotada.
//   PATCH /dojo/guardians/:gid ganhou sync em LOTE (syncStudentsBatch) para
//     todos os alunos ADOTADOS vinculados àquele responsável — mesmo
//     mecanismo do import, reaproveitado.
// Os describes F8 ficam ANTES do describe de deploy parcial (que desliga
// HAS_IDENTITY_COLS module-level e nunca liga de novo) — mesma regra do
// resto do arquivo.
//
// REGRA CRÍTICA (padrão karateDojoClaim.test.js): db.query.mockReset() em
// afterEach — jest.clearAllMocks NÃO drena filas mockResolvedValueOnce.
// Import usa transação via db.connect() → client mockado na ordem exata
// (mockImplementationOnce preserva a implementação base do jest.setup).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

// F8: uploadToR2 é o ÚNICO ponto de saída para o R2 na rota de foto do
// aluno (mesmo helper que a rota do praticante usa) — mockado por
// completo aqui. O SDK do R2 (src/utils/r2Storage.js) tem responsabilidade
// própria; este arquivo testa o CONTRATO da rota (validação, canal, sync).
jest.mock('../../src/utils/r2Storage', () => ({
  uploadToR2: jest.fn(),
}));
const { uploadToR2 } = require('../../src/utils/r2Storage');

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
  // F7.2: o PATCH pode abrir transação. Sem resetar (e restaurar) o
  // db.connect, o client de um caso vazaria para o próximo.
  db.connect.mockReset();
  db.connect.mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  }));
  // F8: uploadToR2 é mock de módulo — precisa da mesma disciplina de
  // reset que db.query/db.connect, senão uma fila Once vaza para o caso
  // seguinte.
  uploadToR2.mockReset();
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
    // F7.2: aluno novo não tem praticante — nenhum sync, nenhuma transação
    expect(db.query.mock.calls.length).toBe(1);
    expect(db.connect).not.toHaveBeenCalled();
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

  // ⚠️ F7.2: este é um dos dois casos que passam perto do sync. Ele
  // continua com 2 queries e sem transação porque belt_label NÃO é
  // identidade da pessoa — faixa é da federação, e o dojô não a sobrescreve.
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
    // F7.2: faixa não é identidade → nem transação, nem sync.
    expect(db.connect).not.toHaveBeenCalled();
    expect(res.body.identity_sync).toBeUndefined();
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
    // os dois vocabulários no CHECK). Quem converte para o canônico é o sync
    // da F7.2, na hora de escrever em customers — nunca aqui.
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

  // ⚠️ F7.2: o SEGUNDO caso que passa perto. Aqui o PATCH TOCA em
  // identidade (rg, city) — mas studentRow() tem practitioner_id null, ou
  // seja, não existe ficha na federação para receber nada. Continua sendo
  // o caminho de 2 queries, sem transação.
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
    expect(db.connect).not.toHaveBeenCalled();  // aluno sem praticante: nada a sincronizar

    const updSql = String(db.query.mock.calls[1][0]);
    expect(updSql).toMatch(/rg = \$1/);
    expect(updSql).toMatch(/city = \$2/);
    const updParams = db.query.mock.calls[1][1];
    expect(updParams[updParams.length - 1]).toBe(dojoId);
    expect(updParams[updParams.length - 2]).toBe(sid);
  });
});

// ════════════════════════════════════════════════════════════
// F7.2 — SINCRONIZAÇÃO CONTÍNUA (dojô → federação)
//
// "A federação não faz gestão de informação. O trabalho dela é apenas
//  receber a sincronização dos dados gerenciados pelos dojôs." (Caio)
//
// A F7.1 copiava a ficha UMA VEZ, ao federar. Aqui a cópia passa a
// acontecer TODA VEZ que o sensei edita a identidade de um aluno cuja
// ficha está adotada por ESTE dojô — na mesma transação e com trilha.
//
// ⚠️ MOCK POR SQL (mockImplementation despachando por regex), nunca fila
// posicional: o sync acrescenta queries DENTRO da transação e uma fila
// posicional quebraria a cada ajuste de ordem interna.
// ════════════════════════════════════════════════════════════
describe('F7.2 — PATCH sincroniza a identidade com a federação', () => {
  const isStudentSelect = (s) => /FROM karate_dojo_students s/.test(s) && /WHERE s\.id = \$1 AND s\.dojo_id = \$2/.test(s);
  const isStudentUpdate = (s) => /^UPDATE karate_dojo_students SET/.test(s.trim());
  const isCandidate = (s) => /FROM customers c/.test(s) && /karate_identity_managed_by = 'dojo'/.test(s);
  const isFedUpdate = (s) => /^UPDATE customers SET/.test(s.trim());
  const isAudit = (s) => /INSERT INTO karate_identity_audit/.test(s);

  // Aluno federado (tem praticante) — é o gatilho do sync.
  const federado = (over = {}) => ({
    ...studentRow({ practitioner_id: 'p1', ...over }),
    is_federated: true,
    has_pending_request: false,
    fpkt_number: 'FPKT-123',
    practitioner_name: 'Aluno Teste',
  });

  // Ficha do praticante como o SELECT de candidato do sync devolve.
  const fichaFederacao = (over = {}) => ({
    practitioner_id: 'p1',
    practitioner_label: 'Aluno Teste',
    fpkt_number: 'FPKT-123',
    full_name: 'Aluno Teste',
    birth_date: '1990-05-10',
    cpf: '52998224725',
    rg: null,
    sex: 'masculino',
    phone: '91999990000',
    email: 'aluno@exemplo.com',
    zip_code: null,
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    photo_url: null,
    ...over,
  });

  function mockPatch({ existing, tx }) {
    db.query.mockImplementation((sql) => {
      if (isStudentSelect(String(sql))) return Promise.resolve({ rows: [existing] });
      return Promise.resolve({ rows: [] });
    });
    const client = {
      query: jest.fn(async (sql) => {
        const r = tx(String(sql));
        if (r instanceof Error) throw r;
        return r || { rows: [] };
      }),
      release: jest.fn(),
    };
    client.sqls = () => client.query.mock.calls.map((c) => String(c[0]));
    client.find = (m) => client.query.mock.calls.find((c) => m(String(c[0])));
    client.hit = (m) => client.sqls().some((s) => m(s));
    db.connect.mockImplementation(() => client);
    return client;
  }

  test('ficha adotada por ESTE dojô: o telefone sobe na MESMA transação, com trilha', async () => {
    const client = mockPatch({
      existing: federado(),
      tx: (s) => {
        if (isStudentUpdate(s)) return { rows: [studentRow({ practitioner_id: 'p1', phone: '91888880000' })] };
        if (isCandidate(s)) return { rows: [fichaFederacao()] };
        if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
        return { rows: [] };
      },
    });

    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ phone: '91888880000' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('91888880000');
    expect(res.body.identity_sync).toMatchObject({ status: 'ok', synced: true, fields: ['phone'] });

    const all = client.sqls();
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');
    // o aluno é gravado ANTES do sync (se o sync cair, o salvamento fica)
    expect(all.findIndex(isStudentUpdate)).toBeLessThan(all.findIndex(isFedUpdate));
    expect(all).toContain('SAVEPOINT sp_identity_sync');

    // O guarda é parametrizado pelo praticante do aluno e pelo dojô do TOKEN
    expect(client.find(isCandidate)[1]).toEqual(['p1', dojoId]);
    // E o que subiu foi só telefone — nada de matrícula/faixa/papéis
    const setClause = String(client.find(isFedUpdate)[0]).split('WHERE')[0];
    expect(setClause).toContain('phone =');
    expect(setClause).not.toContain('karate_registration_number');
    expect(setClause).not.toContain('belt');
    expect(setClause).not.toContain('is_active');
    // trilha com action=sync
    expect(client.find(isAudit)[1][7]).toBe('sync');
  });

  test('praticante gerido pela FEDERAÇÃO: nada é escrito em customers (e o aluno salva)', async () => {
    const client = mockPatch({
      existing: federado(),
      tx: (s) => {
        if (isStudentUpdate(s)) return { rows: [studentRow({ practitioner_id: 'p1', phone: '91888880000' })] };
        if (isCandidate(s)) return { rows: [] }; // managed_by='federation' → não volta
        return { rows: [] };
      },
    });

    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ phone: '91888880000' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('91888880000');
    expect(res.body.identity_sync).toMatchObject({ status: 'skipped', reason: 'NOT_ADOPTED_BY_THIS_DOJO' });
    expect(client.hit(isFedUpdate)).toBe(false);
    expect(client.hit(isAudit)).toBe(false);
    expect(client.sqls()).toContain('COMMIT');
  });

  test('falha do sync NÃO derruba o salvamento — e não passa silenciosa', async () => {
    const client = mockPatch({
      existing: federado(),
      tx: (s) => {
        if (isStudentUpdate(s)) return { rows: [studentRow({ practitioner_id: 'p1', phone: '91888880000' })] };
        if (isCandidate(s)) return { rows: [fichaFederacao()] };
        if (isFedUpdate(s)) return Object.assign(new Error('deadlock detected'), { code: '40P01' });
        return { rows: [] };
      },
    });

    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ phone: '91888880000' });

    // O aluno FOI salvo: 200 com o telefone novo.
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('91888880000');
    // E o sensei fica sabendo que a federação não recebeu.
    expect(res.body.identity_sync).toMatchObject({ status: 'failed', synced: false, error_code: '40P01' });

    const all = client.sqls();
    expect(all).toContain('ROLLBACK TO SAVEPOINT sp_identity_sync'); // descarta SÓ o sync
    expect(all).toContain('COMMIT');                                  // o aluno persiste
    expect(all).not.toContain('ROLLBACK');                            // nunca o rollback da transação
  });

  test('o sync converge a ficha inteira, e o sexo sobe no vocabulário canônico', async () => {
    const client = mockPatch({
      existing: federado(),
      tx: (s) => {
        if (isStudentUpdate(s)) return { rows: [studentRow({ practitioner_id: 'p1', sex: 'F', city: 'Belém' })] };
        if (isCandidate(s)) return { rows: [fichaFederacao({ sex: 'masculino', city: null })] };
        if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
        return { rows: [] };
      },
    });

    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ sex: 'feminino' });

    expect(res.status).toBe(200);
    expect(res.body.sex).toBe('F'); // o dojô continua vendo M/F/other

    const [sql, vals] = client.find(isFedUpdate);
    const setClause = String(sql).split('WHERE')[0];
    const idx = (col) => Number(setClause.match(new RegExp(`${col} = \\$(\\d+)`))[1]) - 1;
    expect(vals[idx('sex')]).toBe('feminino'); // customers usa o canônico
    // city estava vazio na federação e preenchido no dojô → também sobe
    // (converge a ficha, não só o campo do PATCH)
    expect(vals[idx('city')]).toBe('Belém');
    expect(res.body.identity_sync.fields).toEqual(expect.arrayContaining(['sex', 'city']));
  });

  test('Canal B não sincroniza nada (403 antes de qualquer query)', async () => {
    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalB())
      .send({ phone: '91888880000' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('F7.2 — import em lote sincroniza sem explodir', () => {
  const isBatchCandidate = (s) => /JOIN customers c ON c\.id = s\.practitioner_id/.test(s);

  function mockImportTx(dispatch) {
    const client = {
      query: jest.fn(async (sql, params) => dispatch(String(sql), params) || { rows: [] }),
      release: jest.fn(),
    };
    client.sqls = () => client.query.mock.calls.map((c) => String(c[0]));
    client.count = (m) => client.sqls().filter((s) => m(s)).length;
    client.find = (m) => client.query.mock.calls.find((c) => m(String(c[0])));
    db.connect.mockImplementationOnce(() => client);
    return client;
  }

  test('import comum (ninguém federado) → ZERO query de sync', async () => {
    const client = mockImportTx((s) => {
      if (/INSERT INTO karate_dojo_students/.test(s)) return { rows: [{ id: 'i1', practitioner_id: null }] };
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${base}/students/import`)
      .set(canalA())
      .send({ rows: [{ full_name: 'Um' }, { full_name: 'Dois' }, { full_name: 'Três' }] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);
    // O INSERT devolve practitioner_id para que "ninguém nasce federado"
    // seja verificado, e não suposto.
    expect(String(client.find((s) => /INSERT INTO karate_dojo_students/.test(s))[0]))
      .toContain('RETURNING id, practitioner_id');
    expect(client.count(isBatchCandidate)).toBe(0);
    expect(client.sqls()).not.toContain('SAVEPOINT sp_identity_sync_batch');
    expect(res.body.identity_sync).toMatchObject({ status: 'ok', synced: 0, reason: 'NOTHING_TO_SYNC' });
    expect(client.sqls()).toContain('COMMIT');
  });

  test('linhas com praticante → UMA query de candidatos para o lote inteiro', async () => {
    let seq = 0;
    const client = mockImportTx((s) => {
      if (/INSERT INTO karate_dojo_students/.test(s)) {
        seq += 1;
        return { rows: [{ id: `i${seq}`, practitioner_id: `p${seq}` }] };
      }
      if (isBatchCandidate(s)) return { rows: [] }; // nenhuma ficha adotada por este dojô
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${base}/students/import`)
      .set(canalA())
      .send({ rows: [{ full_name: 'Um' }, { full_name: 'Dois' }, { full_name: 'Três' }] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);
    // A ASSERÇÃO DESTE CASO: 3 linhas vinculadas → 1 query, não 3.
    expect(client.count(isBatchCandidate)).toBe(1);
    expect(client.find(isBatchCandidate)[1]).toEqual([['i1', 'i2', 'i3'], dojoId]);
    expect(client.sqls()).toContain('SAVEPOINT sp_identity_sync_batch');
    expect(client.sqls()).toContain('COMMIT');
    expect(client.sqls()).not.toContain('ROLLBACK');
  });
});

// ════════════════════════════════════════════════════════════
// F8 — POST /dojo/students/:sid/photo
//
// Reusa uploadToR2 (mesmo helper da rota do praticante) — o teste de
// integração cobre o CONTRATO da rota (validação, canal, sync); o SDK do
// R2 é responsabilidade de src/utils/r2Storage.js (mockado no topo deste
// arquivo).
// ════════════════════════════════════════════════════════════
describe('F8 — POST /dojo/students/:sid/photo (upload de foto)', () => {
  test('upload aceito: grava karate_photo_url — aluno não federado, sem sync/transação', async () => {
    // 3 idas ao banco FORA de transação: a rota confere existência ANTES
    // de gastar o upload no R2 (mesma ordem da rota do praticante), e
    // svc.setStudentPhoto confere de novo por conta própria (é uma função
    // exportada com contrato próprio, não confia cegamente no chamador) —
    // depois vem o UPDATE. Nenhuma das duas é a transação do sync (essa só
    // abre quando o aluno tem practitioner_id).
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://cdn/aluno.jpg' });
    db.query
      .mockResolvedValueOnce({ rows: [studentRow()] })                                     // rota: svc.getStudent (existe?)
      .mockResolvedValueOnce({ rows: [studentRow()] })                                     // svc.setStudentPhoto: existência própria
      .mockResolvedValueOnce({ rows: [studentRow({ karate_photo_url: 'https://cdn/aluno.jpg' })] }); // UPDATE RETURNING

    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content: 'ZmFrZS1iYXNlNjQ=', content_type: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.karate_photo_url).toBe('https://cdn/aluno.jpg');
    expect(res.body.identity_sync).toBeUndefined();
    expect(uploadToR2).toHaveBeenCalledTimes(1);
    const [key, content, mime] = uploadToR2.mock.calls[0];
    expect(key).toBe(`karate/dojo-students/${dojoId}/${sid}.jpg`);
    expect(content).toBe('ZmFrZS1iYXNlNjQ=');
    expect(mime).toBe('image/jpeg');
    expect(db.query.mock.calls.length).toBe(3);
    expect(db.connect).not.toHaveBeenCalled(); // sem praticante, sem transação
  });

  test('content ausente → 400 VALIDATION_ERROR, sem chamar o R2 nem o banco', async () => {
    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content_type: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('content_type não suportado → 400 INVALID_CONTENT_TYPE, sem chamar o R2', async () => {
    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content: 'ZmFrZQ==', content_type: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTENT_TYPE');
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  test('extensão sai do content_type: image/png → chave .png, image/webp → chave .webp', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://cdn/a.png' });
    db.query
      .mockResolvedValueOnce({ rows: [studentRow()] })  // rota: svc.getStudent
      .mockResolvedValueOnce({ rows: [studentRow()] })  // svc.setStudentPhoto: existência própria
      .mockResolvedValueOnce({ rows: [studentRow({ karate_photo_url: 'https://cdn/a.png' })] });

    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content: 'ZmFrZQ==', content_type: 'image/png' });

    expect(res.status).toBe(200);
    expect(uploadToR2.mock.calls[0][0]).toBe(`karate/dojo-students/${dojoId}/${sid}.png`);
  });

  test('aluno inexistente neste dojô → 404, sem chamar o R2', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // getStudent não encontra

    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content: 'ZmFrZQ==', content_type: 'image/png' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  test('R2 falha → 500, sem gravar nada no banco', async () => {
    uploadToR2.mockResolvedValueOnce({ success: false, error: 'boom' });
    db.query.mockResolvedValueOnce({ rows: [studentRow()] }); // getStudent existe

    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content: 'ZmFrZQ==', content_type: 'image/jpeg' });

    expect(res.status).toBe(500);
    expect(db.query.mock.calls.length).toBe(1); // só o getStudent — nenhum UPDATE
  });

  test('Canal B → 403 PORTAL_READ_ONLY, sem chamar o R2 nem o banco', async () => {
    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalB())
      .send({ content: 'ZmFrZQ==', content_type: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('ficha adotada por ESTE dojô: a foto sobe na mesma transação (reusa updateStudentWithSync)', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://cdn/aluno.jpg' });

    const federado = {
      ...studentRow({ practitioner_id: 'p1' }),
      is_federated: true,
      has_pending_request: false,
      fpkt_number: 'FPKT-123',
      practitioner_name: 'Aluno Teste',
    };

    const isStudentUpdate = (s) => /^UPDATE karate_dojo_students SET/.test(s.trim());
    const isCandidate = (s) => /FROM customers c/.test(s) && /karate_identity_managed_by = 'dojo'/.test(s);
    const isFedUpdate = (s) => /^UPDATE customers SET/.test(s.trim());

    // Duas idas ao banco FORA da transação com a MESMA linha: a rota
    // (svc.getStudent) e a existência própria de svc.setStudentPhoto.
    db.query.mockResolvedValue({ rows: [federado] });

    const client = {
      query: jest.fn(async (sql) => {
        const s = String(sql);
        // A row do UPDATE só difere da federação em karate_photo_url — os
        // demais campos de identidade vêm NULOS dos dois lados de propósito,
        // para a asserção abaixo (`fields` = ['photo_url']) não pegar
        // convergências incidentais de outros campos junto.
        if (isStudentUpdate(s)) return { rows: [studentRow({
          practitioner_id: 'p1', karate_photo_url: 'https://cdn/aluno.jpg',
          full_name: null, birth_date: null, cpf: null, sex: null, phone: null, email: null,
        })] };
        if (isCandidate(s)) return {
          rows: [{
            practitioner_id: 'p1', practitioner_label: 'Aluno Teste', fpkt_number: 'FPKT-123',
            full_name: null, birth_date: null, cpf: null, rg: null, sex: null, phone: null, email: null,
            zip_code: null, street: null, number: null, complement: null, neighborhood: null,
            city: null, state: null, photo_url: null,
            guardian_full_name: null, guardian_cpf: null, guardian_phone: null, guardian_relationship: null,
          }],
        };
        if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    db.connect.mockImplementation(() => client);

    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content: 'ZmFrZQ==', content_type: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.karate_photo_url).toBe('https://cdn/aluno.jpg');
    expect(res.body.identity_sync).toMatchObject({ status: 'ok', synced: true });
    // f.key da foto é 'photo_url' (karate_photo_url é só o NOME da coluna
    // dos dois lados — ver IDENTITY_FIELDS em karateStudentIdentityLink.js)
    expect(res.body.identity_sync.fields).toEqual(['photo_url']);

    const all = client.query.mock.calls.map((c) => String(c[0]));
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all.some(isFedUpdate)).toBe(true);
    const setClause = String(client.query.mock.calls.find((c) => isFedUpdate(String(c[0])))[0]).split('WHERE')[0];
    expect(setClause).toContain('karate_photo_url =');
  });
});

// ════════════════════════════════════════════════════════════
// F8 — PATCH /dojo/guardians/:gid sincroniza os alunos ADOTADOS
// vinculados a este responsável (1 responsável : N alunos).
// Reusa syncStudentsBatch — o MESMO mecanismo do import (F7.2).
// ════════════════════════════════════════════════════════════
describe('F8 — PATCH /dojo/guardians/:gid sincroniza para a federação', () => {
  const guardianRow = (over = {}) => ({
    id: 'g1', full_name: 'Mãe Zelosa', cpf: null, phone: '91988880000', email: null,
    relationship: 'mãe', created_at: '2026-07-19T00:00:00Z', updated_at: '2026-07-19T00:00:00Z',
    ...over,
  });

  test('sem aluno adotado vinculado: UPDATE direto, sem transação nem identity_sync', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [guardianRow()] })                        // SELECT existing
      .mockResolvedValueOnce({ rows: [] })                                     // SELECT alunos adotados vinculados (nenhum)
      .mockResolvedValueOnce({ rows: [guardianRow({ phone: '91977776666' })] }); // UPDATE

    const res = await request(app)
      .patch(`${base}/guardians/g1`)
      .set(canalA())
      .send({ phone: '91977776666' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('91977776666');
    expect(res.body.identity_sync).toBeUndefined();
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query.mock.calls.length).toBe(3);
  });

  test('com aluno ADOTADO vinculado: nome e telefone do responsável sobem para a ficha da federação, em LOTE', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [guardianRow()] })      // SELECT existing
      .mockResolvedValueOnce({ rows: [{ id: sid }] });       // SELECT alunos adotados vinculados (1)

    const isGuardianUpdate = (s) => /^UPDATE karate_dojo_guardians SET/.test(s.trim());
    const isBatchCandidate = (s) => /JOIN customers c ON c\.id = s\.practitioner_id/.test(s);
    const isFedUpdate = (s) => /^UPDATE customers SET/.test(s.trim());
    const isAudit = (s) => /INSERT INTO karate_identity_audit/.test(s);

    const client = {
      query: jest.fn(async (sql) => {
        const s = String(sql);
        if (isGuardianUpdate(s)) return { rows: [guardianRow({ phone: '91977776666' })] };
        if (isBatchCandidate(s)) return {
          rows: [{
            student_id: sid, student_label: 'Aluno Teste',
            practitioner_id: 'p1', practitioner_label: 'Aluno Teste', fpkt_number: 'FPKT-123',
            // Todos os campos de IDENTIDADE do aluno neutros (null dos dois
            // lados) — este teste só cobre o RESPONSÁVEL, não a ficha
            // inteira (isso já é coberto no describe F7.2).
            d_full_name: null, f_full_name: null,
            d_birth_date: null, f_birth_date: null,
            d_cpf: null, f_cpf: null,
            d_rg: null, f_rg: null,
            d_sex: null, f_sex: null,
            d_phone: null, f_phone: null,
            d_email: null, f_email: null,
            d_zip_code: null, f_zip_code: null,
            d_street: null, f_street: null,
            d_number: null, f_number: null,
            d_complement: null, f_complement: null,
            d_neighborhood: null, f_neighborhood: null,
            d_city: null, f_city: null,
            d_state: null, f_state: null,
            d_photo_url: null, f_photo_url: null,
            // Responsável: nome e telefone DIVERGEM (dojô tem, federação
            // não/tem outro) → disparam write. CPF/parentesco iguais nos
            // dois lados (ou ambos vazios) → não disparam.
            d_guardian_full_name: 'Mãe Zelosa', f_guardian_full_name: null,
            d_guardian_cpf: null, f_guardian_cpf: null,
            d_guardian_phone: '91977776666', f_guardian_phone: '91988880000',
            d_guardian_relationship: null, f_guardian_relationship: null,
          }],
        };
        if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    db.connect.mockImplementation(() => client);

    const res = await request(app)
      .patch(`${base}/guardians/g1`)
      .set(canalA())
      .send({ phone: '91977776666' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('91977776666');
    expect(res.body.identity_sync).toMatchObject({ status: 'ok', synced: 1, checked: 1 });
    // Campo do sync usa a CHAVE (guardian_full_name), não a coluna de
    // customers (guardian_name) — ver GUARDIAN_SYNC_FIELDS.
    expect(res.body.identity_sync.fields).toEqual(
      expect.arrayContaining(['guardian_full_name', 'guardian_phone'])
    );

    const all = client.query.mock.calls.map((c) => String(c[0]));
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all.some(isFedUpdate)).toBe(true);
    expect(all).toContain('SAVEPOINT sp_identity_sync_batch');

    const candidateCall = client.query.mock.calls.find((c) => isBatchCandidate(String(c[0])));
    expect(candidateCall[1]).toEqual([[sid], dojoId]);

    // A coluna ESCRITA em customers é guardian_name (fedCol), não
    // guardian_full_name (que é só a chave/label do lado do dojô).
    const fedCall = client.query.mock.calls.find((c) => isFedUpdate(String(c[0])));
    const setClause = String(fedCall[0]).split('WHERE')[0];
    expect(setClause).toContain('guardian_name =');
    expect(setClause).toContain('guardian_phone =');
    expect(setClause).not.toContain('guardian_full_name =');

    // trilha gravada
    expect(client.query.mock.calls.some((c) => isAudit(String(c[0])))).toBe(true);
  });

  test('Canal B → 403 PORTAL_READ_ONLY, sem tocar o banco', async () => {
    const res = await request(app)
      .patch(`${base}/guardians/g1`)
      .set(canalB())
      .send({ phone: '91977776666' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════
// ⚠️ ESTE DESCRIBE FICA POR ÚLTIMO NO ARQUIVO DE PROPÓSITO.
// O flag HAS_IDENTITY_COLS do service é module-level (é assim que o
// fallback de deploy parcial funciona: degradou, ficou degradado). Depois
// que ele vira false, todo caso seguinte deste módulo rodaria degradado —
// e, na F7.2/F8, com o sync DESLIGADO (needsSync exige a 262).
// ════════════════════════════════════════════════════════════
describe('F7.0/F7.2 — deploy parcial: migration 262 ainda não aplicada', () => {
  test('42703 → aluno é criado mesmo assim, sem os campos novos', async () => {
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

  test('sem a 262, o PATCH de aluno federado NÃO abre transação (não há ficha adotada)', async () => {
    // HAS_IDENTITY_COLS já está false por causa do caso anterior — que é
    // exatamente o estado que este caso quer exercitar.
    db.query
      .mockResolvedValueOnce({ rows: [{ ...studentRow({ practitioner_id: 'p1' }), is_federated: true }] })
      .mockResolvedValueOnce({ rows: [studentRow({ practitioner_id: 'p1', phone: '91888880000' })] });

    const res = await request(app)
      .patch(`${base}/students/${sid}`)
      .set(canalA())
      .send({ phone: '91888880000' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('91888880000');
    // Sem a 262 não existe karate_identity_managed_by: não há o que
    // sincronizar, e o custo do sync tem que ser zero.
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query.mock.calls.length).toBe(2);
    expect(res.body.identity_sync).toBeUndefined();
  });

  test('sem a 262, o upload de foto responde 503 SCHEMA_PENDING (karate_photo_url não existe)', async () => {
    // Mesmo estado degradado herdado dos casos acima (HAS_IDENTITY_COLS
    // module-level já é false). A EXISTÊNCIA do aluno continua sendo
    // verificável (withStudentSchemaFallback já degrada as colunas de
    // identidade para NULL, mas a linha existe) — a rota confere isso
    // ANTES de subir para o R2, então o upload ACONTECE. Só depois, dentro
    // de svc.setStudentPhoto, é que a ausência da coluna de destino vira
    // 503 — não há onde GRAVAR a URL que o R2 acabou de devolver.
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://cdn/orfa.jpg' });
    db.query.mockResolvedValue({ rows: [studentRow()] }); // getStudent (rota) + existência própria do service

    const res = await request(app)
      .post(`${base}/students/${sid}/photo`)
      .set(canalA())
      .send({ content: 'ZmFrZQ==', content_type: 'image/jpeg' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING');
    expect(uploadToR2).toHaveBeenCalledTimes(1);
  });
});
