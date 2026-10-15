// ============================================================
// AURA. -- Testes: configuracao de impressao de etiqueta na CONTA
// (15/10/2026)
//
// Duas chaves novas em pdv_settings, para a loja nao perder a configuracao
// de etiqueta ao trocar de computador ou limpar o navegador:
//   - label_custom_specs: medidas proprias (ate 20), espelho de
//     aura-app customLabel.ts (MEDIDA_LIMITES)
//   - label_printer_prefs: calibracao por modelo fixo, espelho de
//     aura-app labelPrinterPrefs.ts / buildLabelHtml.ts
//
// O que estes testes travam:
//   1. GET: null para a loja que nunca salvou (o app migra o navegador uma vez)
//   2. PUT aceita, arredonda a decimos e completa os opcionais com o padrao
//   3. fora da faixa / forma errada => 400 com o campo na mensagem, nada gravado
//   4. limite de 20 medidas
//   5. chave desconhecida dentro da medida / modelo sem calibracao => descartada
//   6. GET devolve o que foi salvo; PUT de outra chave nao apaga
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };
const url = `/api/v1/companies/${cid}/pdv-settings`;

function mockSql(saved) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM company_members/i.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    if (/SELECT pdv_settings(, vertical_active)? FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: saved }] });
    return Promise.resolve({ rows: [] });
  });
}
const updates = () => db.query.mock.calls.filter((c) => /UPDATE companies SET pdv_settings/i.test(String(c[0] || '')));
const gravado = () => JSON.parse(updates()[0][1][0]);
const put = (settings) => request(app).put(url).set(auth).send({ settings });

const MEDIDA = {
  id: 'mabc123', larguraMm: 40, alturaMm: 25, colunas: 2,
  espacoLadoMm: 2, espacoLinhaMm: 2.5, ajusteXMm: -1.2, ajusteYMm: 0.5,
};

describe('pdv_settings -- label_custom_specs', () => {
  test('GET: null para a loja que nunca salvou na conta', async () => {
    mockSql({ caixa_enabled: true });
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.label_custom_specs).toBeNull();
    expect(res.body.settings.label_printer_prefs).toBeNull();
  });

  test('GET: devolve as medidas salvas', async () => {
    mockSql({ label_custom_specs: [MEDIDA] });
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.label_custom_specs).toEqual([MEDIDA]);
  });

  test('PUT: grava a medida como veio', async () => {
    mockSql({});
    const res = await put({ label_custom_specs: [{ ...MEDIDA, nome: '40x25 balcão' }] });
    expect(res.status).toBe(200);
    expect(res.body.settings.label_custom_specs).toEqual([{ ...MEDIDA, nome: '40x25 balcão' }]);
    expect(gravado().label_custom_specs).toEqual([{ ...MEDIDA, nome: '40x25 balcão' }]);
  });

  test('PUT: lista vazia e gravada (a loja apagou todas) e null volta a "nunca salvou"', async () => {
    mockSql({ label_custom_specs: [MEDIDA] });
    let res = await put({ label_custom_specs: [] });
    expect(res.status).toBe(200);
    expect(gravado().label_custom_specs).toEqual([]);
    jest.resetAllMocks();
    mockSql({ label_custom_specs: [MEDIDA] });
    res = await put({ label_custom_specs: null });
    expect(res.status).toBe(200);
    expect(gravado().label_custom_specs).toBeNull();
  });

  test('PUT: arredonda a decimos, aceita virgula e completa os opcionais com o padrao', async () => {
    mockSql({});
    const res = await put({ label_custom_specs: [{ id: ' m1 ', larguraMm: '50,04', alturaMm: 29.96 }] });
    expect(res.status).toBe(200);
    expect(gravado().label_custom_specs).toEqual([{
      id: 'm1', larguraMm: 50, alturaMm: 30, colunas: 1,
      espacoLadoMm: 3, espacoLinhaMm: 2, ajusteXMm: 0, ajusteYMm: 0,
    }]);
  });

  test('PUT: chave desconhecida dentro da medida e descartada', async () => {
    mockSql({});
    const res = await put({ label_custom_specs: [{ ...MEDIDA, cor: 'azul', __proto_hack: 1, html: '<b>' }] });
    expect(res.status).toBe(200);
    expect(gravado().label_custom_specs).toEqual([MEDIDA]);
  });

  test('PUT: id repetido fica so a primeira medida', async () => {
    mockSql({});
    const res = await put({ label_custom_specs: [MEDIDA, { ...MEDIDA, larguraMm: 60 }] });
    expect(res.status).toBe(200);
    expect(gravado().label_custom_specs).toEqual([MEDIDA]);
  });

  test.each([
    ['largura abaixo de 15', { larguraMm: 14.9 }, /larguraMm.*15 e 110/],
    ['largura acima de 110', { larguraMm: 110.1 }, /larguraMm.*15 e 110/],
    ['altura abaixo de 10', { alturaMm: 9 }, /alturaMm.*10 e 80/],
    ['altura acima de 80', { alturaMm: 81 }, /alturaMm.*10 e 80/],
    ['4 colunas', { colunas: 4 }, /colunas.*1 e 3/],
    ['coluna quebrada', { colunas: 1.5 }, /colunas/],
    ['espaco lado a lado acima de 10', { espacoLadoMm: 11 }, /espacoLadoMm.*0 e 10/],
    ['espaco entre linhas negativo', { espacoLinhaMm: -1 }, /espacoLinhaMm.*0 e 10/],
    ['ajuste X alem de 8', { ajusteXMm: 8.5 }, /ajusteXMm.*-8 e 8/],
    ['ajuste Y alem de -8', { ajusteYMm: -9 }, /ajusteYMm.*-8 e 8/],
    ['largura que nao e numero', { larguraMm: 'abc' }, /larguraMm/],
    ['largura boolean', { larguraMm: true }, /larguraMm/],
    ['sem altura', { alturaMm: undefined }, /alturaMm e obrigatorio/],
    ['sem id', { id: '' }, /id deve ser texto/],
    ['id longo demais', { id: 'x'.repeat(65) }, /id deve ser texto/],
    ['nome longo demais', { nome: 'n'.repeat(41) }, /nome deve ser texto de ate 40/],
    ['nome que nao e texto', { nome: 12 }, /nome/],
  ])('PUT: %s => 400 com mensagem e nada gravado', async (_rotulo, troca, msg) => {
    mockSql({ label_custom_specs: [MEDIDA] });
    const res = await put({ label_custom_specs: [{ ...MEDIDA, ...troca }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(msg);
    expect(updates()).toHaveLength(0);
  });

  test.each([
    ['objeto em vez de lista', { a: MEDIDA }],
    ['texto', 'medidas'],
    ['item que nao e objeto', [MEDIDA, 3]],
  ])('PUT: forma errada (%s) => 400', async (_rotulo, valor) => {
    mockSql({});
    const res = await put({ label_custom_specs: valor });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/label_custom_specs/);
    expect(updates()).toHaveLength(0);
  });

  test('PUT: ate 20 medidas passa; 21 => 400', async () => {
    const vinte = Array.from({ length: 20 }, (_, i) => ({ ...MEDIDA, id: 'm' + i }));
    mockSql({});
    let res = await put({ label_custom_specs: vinte });
    expect(res.status).toBe(200);
    expect(gravado().label_custom_specs).toHaveLength(20);

    jest.resetAllMocks();
    mockSql({});
    res = await put({ label_custom_specs: vinte.concat([{ ...MEDIDA, id: 'm20' }]) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/ate 20 medidas/);
    expect(updates()).toHaveLength(0);
  });
});

describe('pdv_settings -- label_printer_prefs', () => {
  const PREFS = {
    '105x21': { continuous: true, rowPitchMm: 23.3, offsetYMm: 0.1 },
    '40x25': { continuous: false, rowPitchMm: 28, offsetYMm: -1.5 },
  };

  test('PUT: grava a calibracao por modelo e o GET devolve', async () => {
    mockSql({});
    let res = await put({ label_printer_prefs: PREFS });
    expect(res.status).toBe(200);
    expect(gravado().label_printer_prefs).toEqual(PREFS);

    jest.resetAllMocks();
    mockSql({ label_printer_prefs: PREFS });
    res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.label_printer_prefs).toEqual(PREFS);
  });

  test('PUT: modelo sem calibracao (99x21, 58mm) ou desconhecido e chave desconhecida sao descartados', async () => {
    mockSql({});
    const res = await put({ label_printer_prefs: {
      '105x21': { continuous: true, rowPitchMm: 23, offsetYMm: 1, lixo: 'x' },
      '99x21': { continuous: true, rowPitchMm: 20, offsetYMm: 1 },
      '58mm': { continuous: true },
      'abc': { continuous: true },
    } });
    expect(res.status).toBe(200);
    expect(gravado().label_printer_prefs).toEqual({ '105x21': { continuous: true, rowPitchMm: 23, offsetYMm: 1 } });
  });

  test('PUT: objeto vazio e gravado (loja sem calibracao) e arredonda a decimos', async () => {
    mockSql({});
    let res = await put({ label_printer_prefs: {} });
    expect(res.status).toBe(200);
    expect(gravado().label_printer_prefs).toEqual({});

    jest.resetAllMocks();
    mockSql({});
    res = await put({ label_printer_prefs: { '30x25': { rowPitchMm: 27.04, offsetYMm: '-0,26' } } });
    expect(res.status).toBe(200);
    expect(gravado().label_printer_prefs).toEqual({ '30x25': { rowPitchMm: 27, offsetYMm: -0.3 } });
  });

  test.each([
    ['passo abaixo da etiqueta (105x21)', { '105x21': { rowPitchMm: 20.9 } }, /105x21\.rowPitchMm.*21 e 26.5/],
    ['passo acima do limite (105x21)', { '105x21': { rowPitchMm: 26.6 } }, /105x21\.rowPitchMm.*21 e 26.5/],
    ['passo abaixo da etiqueta (30x25)', { '30x25': { rowPitchMm: 24.9 } }, /30x25\.rowPitchMm.*25 e 30/],
    ['passo acima do limite (40x25)', { '40x25': { rowPitchMm: 31 } }, /40x25\.rowPitchMm.*25 e 30.5/],
    ['deslocamento alem de 10', { '40x25': { offsetYMm: 10.5 } }, /offsetYMm.*-10 e 10/],
    ['deslocamento alem de -10', { '30x25': { offsetYMm: -11 } }, /offsetYMm.*-10 e 10/],
    ['continuo que nao e boolean', { '105x21': { continuous: 'sim' } }, /continuous deve ser boolean/],
    ['modelo que nao e objeto', { '105x21': 5 }, /105x21 deve ser objeto/],
  ])('PUT: %s => 400 com mensagem e nada gravado', async (_rotulo, valor, msg) => {
    mockSql({ label_printer_prefs: PREFS });
    const res = await put({ label_printer_prefs: valor });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(msg);
    expect(updates()).toHaveLength(0);
  });

  test.each([[['105x21']], ['texto'], [true]])('PUT: forma errada (%p) => 400', async (valor) => {
    mockSql({});
    const res = await put({ label_printer_prefs: valor });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/label_printer_prefs/);
    expect(updates()).toHaveLength(0);
  });
});

describe('pdv_settings -- as chaves de etiqueta convivem com as demais', () => {
  test('PUT de outra chave mantem medidas e calibracao ja salvas', async () => {
    const PREFS = { '105x21': { continuous: true, rowPitchMm: 23.3, offsetYMm: 0.1 } };
    mockSql({ label_custom_specs: [MEDIDA], label_printer_prefs: PREFS, label_size: '40x25' });
    const res = await put({ require_customer: true });
    expect(res.status).toBe(200);
    expect(gravado()).toMatchObject({ require_customer: true, label_size: '40x25', label_custom_specs: [MEDIDA], label_printer_prefs: PREFS });
  });

  test('PUT das chaves de etiqueta nao apaga o restante', async () => {
    mockSql({ caixa_enabled: true, label_size: '58mm', label_offset_mm: -1.5 });
    const res = await put({ label_custom_specs: [MEDIDA] });
    expect(res.status).toBe(200);
    expect(gravado()).toMatchObject({ caixa_enabled: true, label_size: '58mm', label_offset_mm: -1.5, label_custom_specs: [MEDIDA], label_printer_prefs: null });
  });
});
