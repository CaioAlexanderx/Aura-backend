// ============================================================
// AURA. — Testes: 1.4 busca por telefone ignorando formatacao
// listPatients (src/services/dental.js) — GET /patients?search=
// ============================================================
const { listPatients } = require('../src/services/dental');
let db;

beforeAll(() => {
  db = require('../src/config/database');
});

beforeEach(() => jest.clearAllMocks());

describe('listPatients — normalizacao de busca por telefone', () => {
  test('termo com 4+ digitos ativa comparacao regexp_replace no WHERE', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await listPatients('company-1', { search: '99999-0002' });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/regexp_replace\(COALESCE\(c\.phone, ''\), '\[\^0-9\]', '', 'g'\)/);
    expect(sql).toMatch(/regexp_replace\(COALESCE\(c\.phone_secondary, ''\), '\[\^0-9\]', '', 'g'\)/);
    // digitsOnly de "99999-0002" = "999990002"
    expect(params).toContain('%999990002%');
  });

  test('"99999-0002" e "(99) 99999-0002" acham o mesmo telefone cadastrado', async () => {
    // Telefone salvo no banco: "(99) 99999-0002" -> digitos "99999990002".
    // O termo de busca "99999-0002" (digitos "999990002") tem que "caber"
    // dentro do telefone salvo via LIKE '%...%' — e o caso de uso real
    // (usuario digita so o numero, sem DDD).
    const storedPhoneDigits = '99999990002';

    db.query.mockResolvedValueOnce({ rows: [] });
    await listPatients('company-1', { search: '99999-0002' });
    const paramsShort = db.query.mock.calls[0][1];
    // params: [companyId, '%<search original>%', '%<digitos>%']
    const likeTermShort = paramsShort[2];
    expect(likeTermShort).toBe('%999990002%');
    expect(storedPhoneDigits.includes(likeTermShort.replace(/%/g, ''))).toBe(true);

    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({ rows: [] });
    await listPatients('company-1', { search: '(99) 99999-0002' });
    const paramsFull = db.query.mock.calls[0][1];
    const likeTermFull = paramsFull[2];
    expect(likeTermFull).toBe('%99999990002%');
    expect(storedPhoneDigits.includes(likeTermFull.replace(/%/g, ''))).toBe(true);
  });

  test('termo com menos de 4 digitos NAO ativa a clausula de telefone normalizado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await listPatients('company-1', { search: 'Ana' });

    const sql = db.query.mock.calls[0][0];
    expect(sql).not.toMatch(/regexp_replace/);
  });

  test('nome e CPF continuam com ILIKE normal (nao regride)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await listPatients('company-1', { search: 'Joao Silva' });

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/c\.name ILIKE/);
    expect(sql).toMatch(/c\.cpf_cnpj ILIKE/);
  });

  test('sem search, nao adiciona clausula extra', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await listPatients('company-1', {});
    const sql = db.query.mock.calls[0][0];
    expect(sql).not.toMatch(/regexp_replace/);
    expect(sql).not.toMatch(/ILIKE/);
  });
});
