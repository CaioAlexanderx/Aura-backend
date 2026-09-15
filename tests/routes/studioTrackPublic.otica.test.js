// ============================================================
// AURA. -- Testes: GET /acompanhar/:token com token de ORDEM DE SERVICO
//
// Terceiro caminho do tracker (migration 334): venda -> vitrine -> OS.
// Mesmo shape de resposta; etapas proprias da otica; `tipo: 'oculos'`.
//
// O teste que mais importa continua sendo o do que NAO sai: alem de
// CPF/telefone/sobrenome, aqui a receita e dado de SAUDE e o laboratorio
// e informacao comercial — nenhum dos dois pode aparecer nem na resposta
// nem na consulta.
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');

let db;
let app;

const TOKEN = 'b'.repeat(32);

const OS = {
  id: '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
  os_number: 12,
  company_id: 'comp-1',
  created_at: '2026-09-10T12:00:00Z',
  status: 'em_execucao',
  kind: 'otica',
  lab_status: 'no_laboratorio',
  promised_at: '2026-09-17T15:00:00Z',
  estimated_amount: '890.00',
  deposit_sale_id: 'sale-sinal-1',
  customer_name: 'Maria Fernanda Souza',
  loja: 'Ótica Bairro',
  itens: [{ nome: 'Armação RB5154', qtd: 1 }, { nome: 'Lente Varilux', qtd: 1 }],
};

function buildApp() {
  jest.resetModules();
  process.env.JWT_SECRET = 'aura-test-secret-2026';
  db = require('../../src/config/database');
  const router = require('../../src/routes/studioTrackPublic');
  const a = express();
  a.use(express.json());
  a.use('/acompanhar', router);
  return a;
}

function mockDb({ os = OS, saldo = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM credit_installments/i.test(s)) return Promise.resolve({ rows: saldo });
    if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM digital_orders/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM service_orders so/i.test(s)) return Promise.resolve({ rows: os ? [os] : [] });
    return Promise.resolve({ rows: [] });
  });
}

const track = (tk = TOKEN) => request(app).get(`/acompanhar/${tk}`);
const osSql = () => db.query.mock.calls.map((c) => String(c[0] || '')).find((s) => /FROM service_orders so/i.test(s)) || '';

beforeEach(() => { jest.resetAllMocks(); app = buildApp(); });

describe('o que o cliente vê', () => {
  test('etapas de otica, etapa atual pelo lab_status e tipo oculos', async () => {
    mockDb();
    const res = await track();

    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('oculos');
    expect(res.body.loja).toBe('Ótica Bairro');
    expect(res.body.pedido).toBe('OS 12');
    expect(res.body.etapas.map((e) => e.key)).toEqual(['recebido', 'laboratorio', 'montagem', 'pronto']);
    expect(res.body.etapa_atual).toBe(1);            // no_laboratorio
    expect(res.body.entrega_combinada).toBe('2026-09-17');
    expect(res.body.imagem).toBeNull();
    expect(res.body.total).toBe(890);
    expect(res.body.itens).toHaveLength(2);
  });

  test.each([
    ['aberta',      'aguardando_envio', 0],
    ['em_execucao', 'refacao',          1],
    ['em_execucao', 'recebida',         2],
    ['em_execucao', 'em_montagem',      2],
    ['pronta',      'em_montagem',      3],
    ['entregue',    'em_montagem',      3],
  ])('status %s + lab %s -> etapa %i', async (status, lab_status, etapa) => {
    mockDb({ os: { ...OS, status, lab_status } });
    const res = await track();
    expect(res.body.etapa_atual).toBe(etapa);
  });

  test('OS cancelada avisa, com tipo oculos', async () => {
    mockDb({ os: { ...OS, status: 'cancelada' } });
    const res = await track();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cancelado: true, tipo: 'oculos', pedido: 'OS 12' });
    expect(res.body.etapa_atual).toBeUndefined();
  });

  test('saldo do sinal vem da venda em deposit_sale_id', async () => {
    mockDb({ saldo: [{ id: 'ci-1', valor: '490.00', due_date: '2026-09-17' }] });
    const res = await track();
    expect(res.body.saldo).toMatchObject({ valor: 490, vencimento: '2026-09-17' });
    const call = db.query.mock.calls.find((c) => /FROM credit_installments/i.test(String(c[0])));
    expect(call[1]).toEqual(['comp-1', 'sale-sinal-1']);
  });

  test('OS de reparo ganha etapas proprias e NAO leva tipo oculos', async () => {
    mockDb({ os: { ...OS, kind: 'reparo', lab_status: null } });
    const res = await track();
    expect(res.body.tipo).toBeUndefined();
    expect(res.body.etapas.map((e) => e.key)).toEqual(['recebido', 'execucao', 'pronto']);
    expect(res.body.etapa_atual).toBe(1);
  });

  test('token que nao existe em lugar nenhum -> 404', async () => {
    mockDb({ os: null });
    const res = await track();
    expect(res.status).toBe(404);
  });
});

describe('o que NÃO pode vazar', () => {
  test('só o primeiro nome do cliente', async () => {
    mockDb();
    const res = await track();
    expect(res.body.cliente).toBe('Maria');
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain('Fernanda');
    expect(corpo).not.toContain('Souza');
  });

  test('a resposta não leva receita, prescritor, telefone nem laboratório', async () => {
    mockDb();
    const res = await track();
    const chaves = JSON.stringify(Object.keys(res.body)).toLowerCase();
    expect(chaves).not.toMatch(/optical|prescri|receita|lab|phone|telefone|cpf|customer_id|deposit_sale_id/);
  });

  test('a consulta não busca receita, prescritor, laboratório nem dado sensível do cliente', async () => {
    mockDb();
    await track();
    const sql = osSql();
    expect(sql).not.toMatch(/optical|optical_labs|lab_id|lab_name|prescri/i);
    expect(sql).not.toMatch(/cpf|cnpj|cu\.phone|cu\.email|address/i);
  });

  test('schema sem a 334 (42703) nao derruba o tracker: 404 limpo', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/FROM service_orders so/i.test(s)) return Promise.reject(Object.assign(new Error('x'), { code: '42703' }));
      return Promise.resolve({ rows: [] });
    });
    const res = await track();
    expect(res.status).toBe(404);
  });
});
