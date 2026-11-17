// ============================================================
// AURA. -- Paridade: planilha SEM grade grava como antes (b-import-grade, 17/11/2026)
//
// O POST /products/import passou a montar grade (um produto com variantes)
// quando linhas do mesmo SKU -- ou do mesmo nome + unidade + marca, sem
// SKU -- trazem cor/tamanho. Planilha em que cada linha e um produto
// diferente tem que gravar EXATAMENTE como antes.
//
// O registro `tests/fixtures/importProdutosSemGrade.json` foi gravado com o
// codigo de ANTES da mudanca (origin/main 34bc455d), rodando este arquivo
// com GRAVAR_PARIDADE=1. Ele guarda toda escrita no banco (INSERT/UPDATE/
// DELETE, SQL e parametros, na ordem) e as respostas do dry_run e da
// gravacao. O teste compara o codigo de hoje com esse registro.
//
// A planilha cobre o que o caminho simples ja fazia: produto com cor e
// tamanho proprios e SKU unico (o exemplo da planilha-modelo), mesmo nome
// com SKU diferente (entram os dois), linha repetida sem cor/tamanho
// (duplicata do lote), codigo de barras repetido, duplicata do banco,
// preco invalido, preco no cartao e categoria.
// ============================================================
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let mockContadorUuid = 0;
jest.mock('uuid', () => ({ v4: () => 'lote-' + String(++mockContadorUuid).padStart(4, '0') }));

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => { jest.resetAllMocks(); mockContadorUuid = 0; });

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };
const url = `/api/v1/companies/${cid}/products/import`;
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'importProdutosSemGrade.json');

const H = ['nome do produto', 'preco de venda (r$)', 'preco de custo (r$)', 'estoque atual', 'estoque minimo',
  'codigo de barras (ean)', 'sku / codigo interno', 'categoria', 'cor', 'tamanho', 'unidade', 'preco no cartao'];
function linha(...v) { return Object.fromEntries(H.map((h, i) => [h, v[i] === undefined ? '' : v[i]])); }

const ROWS = [
  linha('Camiseta Azul M', '79.90', '35.00', '50', '10', '7891234567890', 'CAM-AZM', 'Vestuário', '#0000FF', 'M', 'un', ''),
  linha('Vestido Temis', '185.00', '', '4', '', '3125580047102', '18345775', 'Vestido', '#000000', 'U', 'un', '199,90'),
  linha('Blusa', '59,90', '20', '3', '', '', 'B8449', 'Blusa', '', '', 'un', ''),
  linha('Blusa', '64,90', '22', '2', '', '', 'B8450', 'Blusa', '', '', 'un', ''),
  linha('Blusa', '59,90', '20', '3', '', '', 'B8449', 'Blusa', '', '', 'un', ''),       // repetida: duplicata do lote
  linha('Cinto Couro', '89,00', '30', '5', '', '7891234567890', 'CIN-1', 'Acessório', '', '', 'un', ''), // EAN repetido
  linha('Caneca', '25,00', '8', '10', '', '', '', 'Casa', '', '', 'un', ''),            // ja existe no banco
  linha('Sem Preco', '', '', '1', '', '', 'SP-1', '', '', '', 'un', ''),               // preco invalido
  linha('Bolsa Tiracolo', '149,90', '60', '1', '2', '', '', 'Bolsa', '', '', 'un', ''),
  linha('Saia Midi', '119,90', '45', '2', '', '', 'SAI-9', 'Saia', '#EF4444', '', 'un', ''), // so cor, SKU unico
];

function mockBanco() {
  let seq = 0;
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/FROM company_members/i.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    if (/SELECT id, name, unit, brand, sku FROM products WHERE company_id/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'p-antigo', name: 'Caneca', unit: 'un', brand: null, sku: null }] });
    }
    if (/INSERT INTO products/i.test(s)) {
      // um id por linha do VALUES; category e o 9o valor de cada linha
      const porLinha = /card_price/.test(s) ? 15 : 14;
      const n = (params.length - 2) / porLinha;
      const rows = [];
      for (let i = 0; i < n; i++) rows.push({ id: 'novo-' + (++seq), category: params[2 + i * porLinha + 7] });
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

const escritas = () => db.query.mock.calls
  .filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(String(c[0] || '')))
  .map((c) => ({ sql: String(c[0]).replace(/\s+/g, ' ').trim(), params: c[1] || [] }));

async function rodar() {
  mockBanco();
  const previa = await request(app).post(url).set(auth).send({ dry_run: true, rows: ROWS });
  const escritasDaPrevia = escritas();
  jest.resetAllMocks(); mockContadorUuid = 0;
  mockBanco();
  const gravacao = await request(app).post(url).set(auth).send({ rows: ROWS });
  return {
    previa: { status: previa.status, body: previa.body },
    escritas_da_previa: escritasDaPrevia,
    gravacao: { status: gravacao.status, body: gravacao.body },
    escritas: escritas(),
  };
}

test('planilha sem grade: escritas e respostas iguais ao registro de antes da mudanca', async () => {
  const agora = await rodar();
  if (process.env.GRAVAR_PARIDADE === '1') {
    fs.writeFileSync(FIXTURE, JSON.stringify(agora, null, 2) + '\n');
    return;
  }
  const antes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  expect(agora).toEqual(antes);
  // sanidade do proprio registro: houve gravacao de verdade
  expect(antes.escritas.some((e) => /INSERT INTO products/.test(e.sql))).toBe(true);
  expect(antes.escritas_da_previa).toEqual([]);
});
