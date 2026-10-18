// ============================================================
// AURA. — Testes: NCM validado no cadastro (t3-05, 18/10/2026)
//
// 3 de 3 rejeicoes de NFC-e em 30 dias foram a 778 (NCM inexistente). O NCM
// errado entrava no cadastro sem aviso. Agora:
//   1. a tabela oficial (Siscomex) esta no repositorio e reconhece NCMs reais;
//   2. POST/PATCH de produto devolvem `ncm_aviso` mas NUNCA bloqueiam;
//   3. GET /fiscal/ncm/:codigo diz se existe e a descricao;
//   4. importacoes (planilha, XML) devolvem `ncm_avisos` sem mudar o que salvam.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const productsRouter = require('../../src/routes/products');
const fiscalNcmRouter = require('../../src/routes/fiscalNcm');
const ncm = require('../../src/services/ncmTable');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const pid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

// Reais (tabela vigente em 18/10/2026): camiseta de algodao e calcado de couro.
const NCM_CAMISETA = '61091000';
const NCM_CALCADO = '64039990';
// 8 digitos, mas nao existe (o tipo de erro das rejeicoes 778).
const NCM_FALSO = '12345678';

describe('tabela NCM (Siscomex)', () => {
  test('o arquivo versionado traz a data e milhares de codigos', () => {
    const v = ncm.versaoDaTabela();
    expect(v.vigente_em).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.total).toBeGreaterThan(9000);
    expect(v.fonte).toMatch(/Siscomex/);
  });

  test.each([NCM_CAMISETA, NCM_CALCADO, '49019900', '21069090'])('NCM real %s existe, com descricao', (c) => {
    const r = ncm.consultarNcm(c);
    expect(r).toMatchObject({ ncm: c, formatoOk: true, existe: true });
    expect(r.descricao).toBeTruthy();
  });

  test('descricao junta a posicao de 4 digitos com o item, sem HTML', () => {
    const r = ncm.consultarNcm(NCM_CAMISETA);
    expect(r.descricao).toMatch(/^Camisetas/);
    expect(r.descricao).toMatch(/algod/i);
    expect(r.descricao).not.toMatch(/</);
  });

  test.each([NCM_FALSO, '00000000', '99999999'])('NCM %s nao existe', (c) => {
    expect(ncm.consultarNcm(c)).toMatchObject({ formatoOk: true, existe: false, descricao: null });
  });

  test('aceita pontuacao: 6109.10.00', () => {
    expect(ncm.consultarNcm('6109.10.00')).toMatchObject({ ncm: NCM_CAMISETA, existe: true });
  });

  test('vazio e formato errado nao dizem "existe"', () => {
    expect(ncm.consultarNcm('')).toMatchObject({ vazio: true, existe: null });
    expect(ncm.consultarNcm(null)).toMatchObject({ vazio: true });
    expect(ncm.consultarNcm('6109')).toMatchObject({ vazio: false, formatoOk: false, existe: null });
    expect(ncm.consultarNcm('610910001')).toMatchObject({ formatoOk: false, existe: null });
  });
});

describe('avisoDeNcm', () => {
  test('NCM bom e NCM vazio nao avisam', () => {
    expect(ncm.avisoDeNcm(NCM_CAMISETA)).toBeNull();
    expect(ncm.avisoDeNcm('')).toBeNull();
    expect(ncm.avisoDeNcm(undefined)).toBeNull();
  });

  test('inexistente usa o texto proposto', () => {
    expect(ncm.avisoDeNcm(NCM_FALSO)).toEqual({
      codigo: 'ncm_inexistente',
      ncm: NCM_FALSO,
      mensagem: 'Este NCM não existe na tabela da Receita. A nota fiscal com ele é recusada. Confira o código na nota do fornecedor.',
    });
  });

  test('formato errado: a mensagem diz se o valor foi descartado ou guardado', () => {
    expect(ncm.avisoDeNcm('6109', { salvo: false })).toMatchObject({ codigo: 'ncm_formato', mensagem: expect.stringMatching(/não foi salvo/) });
    expect(ncm.avisoDeNcm('6109', { salvo: true }).mensagem).not.toMatch(/não foi salvo/);
  });

  test('resumirAvisosNcm conta tudo e limita os exemplos', () => {
    const itens = [
      { name: 'A', ncm: NCM_CAMISETA },
      { name: 'B', ncm: NCM_FALSO },
      { name: 'C', ncm: null },
      { name: 'D', ncm: '1234' },
    ];
    expect(ncm.resumirAvisosNcm(itens)).toEqual({
      total: 2,
      exemplos: [
        { nome: 'B', ncm: NCM_FALSO, codigo: 'ncm_inexistente' },
        { nome: 'D', ncm: '1234', codigo: 'ncm_formato' },
      ],
    });
    expect(ncm.resumirAvisosNcm(itens, { max: 1 }).exemplos).toHaveLength(1);
    expect(ncm.resumirAvisosNcm([{ name: 'A', ncm: NCM_CAMISETA }])).toBeNull();
    expect(ncm.resumirAvisosNcm([])).toBeNull();
  });
});

describe('GET /fiscal/ncm/:codigo', () => {
  const app = express();
  app.use(express.json());
  app.use('/fiscal', fiscalNcmRouter);
  const get = (c, headers = auth) => request(app).get(`/fiscal/ncm/${encodeURIComponent(c)}`).set(headers);

  test('exige login', async () => {
    const r = await request(app).get(`/fiscal/ncm/${NCM_CAMISETA}`);
    expect(r.status).toBe(401);
  });

  test('NCM que existe: descricao e versao da tabela, sem mensagem', async () => {
    const r = await get(NCM_CAMISETA);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ncm: NCM_CAMISETA, formato_ok: true, existe: true, mensagem: null });
    expect(r.body.descricao).toMatch(/Camisetas/);
    expect(r.body.tabela.vigente_em).toMatch(/^\d{4}-/);
  });

  test('NCM que nao existe: existe=false e o texto proposto', async () => {
    const r = await get(NCM_FALSO);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ existe: false, descricao: null, mensagem: ncm.MSG_INEXISTENTE });
  });

  test('com pontos', async () => {
    const r = await get('6109.10.00');
    expect(r.body).toMatchObject({ ncm: NCM_CAMISETA, existe: true });
  });

  test('formato errado: existe=null e mensagem de formato', async () => {
    const r = await get('6109');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ formato_ok: false, existe: null, mensagem: ncm.MSG_FORMATO });
  });

  test('sem digito nenhum: 400', async () => {
    const r = await get('abc');
    expect(r.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/products', productsRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

function mockDb() {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/AS in_group/i.test(s)) return Promise.resolve({ rows: [{ total: '3', in_group: false }] });
    if (/INSERT INTO products/i.test(s) || /UPDATE products SET/i.test(s)) {
      return Promise.resolve({ rows: [{ id: pid, name: 'Camiseta' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}
const criar = (body) => request(app).post(`/api/v1/companies/${cid}/products`).set(auth).send({ name: 'Camiseta', ...body });
const editar = (body) => request(app).patch(`/api/v1/companies/${cid}/products/${pid}`).set(auth).send(body);
const insertCall = () => db.query.mock.calls.find((c) => /INSERT INTO products/i.test(String(c[0] || '')));
const updateCall = () => db.query.mock.calls.find((c) => /UPDATE products SET/i.test(String(c[0] || '')));

describe('POST /products — ncm_aviso', () => {
  test('NCM inexistente: cria (201), grava o NCM e avisa', async () => {
    mockDb();
    const r = await criar({ ncm: NCM_FALSO });
    expect(r.status).toBe(201);
    expect(insertCall()[1]).toContain(NCM_FALSO);
    expect(r.body.ncm_aviso).toMatchObject({ codigo: 'ncm_inexistente', ncm: NCM_FALSO, mensagem: ncm.MSG_INEXISTENTE });
  });

  test('NCM bom: sem ncm_aviso na resposta', async () => {
    mockDb();
    const r = await criar({ ncm: NCM_CAMISETA });
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('ncm_aviso');
  });

  test('sem NCM: sem ncm_aviso', async () => {
    mockDb();
    const r = await criar({});
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('ncm_aviso');
  });

  test('NCM com 7 digitos: cria sem o NCM (como antes) e avisa que nao foi salvo', async () => {
    mockDb();
    const r = await criar({ ncm: '6109100' });
    expect(r.status).toBe(201);
    expect(insertCall()[1]).not.toContain('6109100');
    expect(r.body.ncm_aviso).toMatchObject({ codigo: 'ncm_formato', mensagem: expect.stringMatching(/não foi salvo/) });
  });
});

describe('PATCH /products/:pid — ncm_aviso', () => {
  test('NCM inexistente: atualiza (200) e avisa', async () => {
    mockDb();
    const r = await editar({ ncm: NCM_FALSO });
    expect(r.status).toBe(200);
    expect(updateCall()[1]).toContain(NCM_FALSO);
    expect(r.body.ncm_aviso).toMatchObject({ codigo: 'ncm_inexistente' });
  });

  test('NCM bom: sem aviso', async () => {
    mockDb();
    const r = await editar({ ncm: NCM_CALCADO });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('ncm_aviso');
  });

  test('PATCH que nao mexe no NCM nunca traz aviso', async () => {
    mockDb();
    const r = await editar({ name: 'Outro nome' });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('ncm_aviso');
  });

  test('limpar o NCM (vazio) nao avisa', async () => {
    mockDb();
    const r = await editar({ ncm: '' });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('ncm_aviso');
  });
});

// ────────────────────────────────────────────────────────────
describe('importacao — ncm_avisos sem bloquear', () => {
  jest.setTimeout(60000); // a primeira carga do app inteiro e lenta
  const importApp = () => require('../../src/index').app;
  const urlPlanilha = `/api/v1/companies/${cid}/products/import`;
  const linhas = [
    { 'Nome do produto': 'Camiseta', 'Preço de venda': '49,90', NCM: NCM_CAMISETA },
    { 'Nome do produto': 'Tenis', 'Preço de venda': '199,90', NCM: NCM_FALSO },
    { 'Nome do produto': 'Meia', 'Preço de venda': '19,90', NCM: '' },
  ];

  function mockImport() {
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/FROM company_members/i.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/INSERT INTO products/i.test(s)) return Promise.resolve({ rows: [{ id: 'p1', category: null }, { id: 'p2', category: null }, { id: 'p3', category: null }] });
      return Promise.resolve({ rows: [] });
    });
  }

  test('planilha (dry_run): conta o NCM falso e mantem as 3 linhas validas', async () => {
    mockImport();
    const r = await request(importApp()).post(urlPlanilha).set(auth).send({ dry_run: true, rows: linhas });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(3);
    expect(r.body.ncm_avisos).toEqual({ total: 1, exemplos: [{ nome: 'Tenis', ncm: NCM_FALSO, codigo: 'ncm_inexistente' }] });
  });

  test('planilha (gravando): salva as 3 e traz o aviso', async () => {
    mockImport();
    const r = await request(importApp()).post(urlPlanilha).set(auth).send({ rows: linhas });
    expect(r.status).toBe(201);
    expect(r.body.saved).toBe(3);
    expect(r.body.ncm_avisos.total).toBe(1);
  });

  test('planilha sem NCM ruim: resposta sem ncm_avisos', async () => {
    mockImport();
    const r = await request(importApp()).post(urlPlanilha).set(auth).send({ dry_run: true, rows: [linhas[0], linhas[2]] });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('ncm_avisos');
  });

  const xml = (ncmItem) => `<?xml version="1.0"?><nfeProc><NFe><infNFe>
    <ide><nNF>10</nNF><serie>1</serie><dhEmi>2026-10-01T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>11222333000181</CNPJ><xNome>Fornecedor X</xNome></emit>
    <det nItem="1"><prod><cProd>A1</cProd><cEAN>SEM GTIN</cEAN><xProd>Camiseta</xProd><NCM>${ncmItem}</NCM>
      <uCom>UN</uCom><qCom>2</qCom><vUnCom>20.00</vUnCom></prod></det>
    <total><ICMSTot><vNF>40.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;

  test('XML da NF-e (previa): NCM falso vira aviso e o item continua na lista', async () => {
    mockImport();
    const r = await request(importApp()).post(`/api/v1/companies/${cid}/products/import-nfe`).set(auth)
      .send({ xml_content: xml(NCM_FALSO) });
    expect(r.status).toBe(200);
    expect(r.body.products).toHaveLength(1);
    expect(r.body.ncm_avisos).toMatchObject({ total: 1, exemplos: [{ nome: 'Camiseta', ncm: NCM_FALSO }] });
  });

  test('XML da NF-e (previa) com NCM real: sem ncm_avisos', async () => {
    mockImport();
    const r = await request(importApp()).post(`/api/v1/companies/${cid}/products/import-nfe`).set(auth)
      .send({ xml_content: xml(NCM_CAMISETA) });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('ncm_avisos');
  });
});
