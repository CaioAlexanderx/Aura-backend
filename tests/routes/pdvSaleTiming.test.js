// ============================================================
// AURA. -- Testes: tempo da venda por etapa (p-140, 17/11/2026)
//
// services/vendaTiming.js escreve UMA linha por POST /pdv/sale, com o
// prefixo [pdv-sale-timing]. O que estes testes travam:
//   1. a linha sai, e JSON valido, com as etapas, o numero de itens, o
//      numero de consultas da transacao, a forma de pagamento e os sim/nao
//   2. nenhum dado de cliente final vai para a linha (nome, telefone, CPF,
//      nome de produto)
//   3. a linha tambem sai quando a venda e recusada (409)
//   4. erro ao escrever a linha NUNCA derruba a venda (201 igual)
//   5. as consultas que a venda faz sao as MESMAS, na mesma ordem, com a
//      medicao ligada (o client que conta so repassa)
//   6. PDV_SALE_TIMING=off desliga a linha
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');

const pdvRouter = require('../../src/routes/pdv');
const vendaTiming = require('../../src/services/vendaTiming');

let db;
beforeAll(() => { db = require('../../src/config/database'); });

const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const prod = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use('/pdv', vendaTiming.carimbarInicio);
  scoped.use((req, res, next) => { req.user = { id: 'u1' }; next(); });
  scoped.use('/pdv', pdvRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

function mockClient({ stock = '10' } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: {} }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Produto Secreto', cost_price: '3.00', stock_qty: stock, stock_company_id: cid }] });
    }
    if (/INSERT INTO customers/i.test(s)) return Promise.resolve({ rows: [{ id: 'cust-1' }] });
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '20.00' }] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

let logSpy;
let client;
beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.PDV_SALE_TIMING;
  client = mockClient();
  db.connect.mockResolvedValue(client);
  db.query.mockResolvedValue({ rows: [] });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); delete process.env.PDV_SALE_TIMING; });

const linhas = () => logSpy.mock.calls
  .map((c) => String(c[0] || ''))
  .filter((l) => l.startsWith(vendaTiming.PREFIXO + ' '));
const lerLinha = () => JSON.parse(linhas()[0].slice(vendaTiming.PREFIXO.length + 1));

const BODY = {
  items: [{ product_id: prod, quantity: 2, unit_price: 10, product_name_snapshot: 'Produto Secreto' }],
  payment_method: 'pix',
  customer_name: 'Fulana de Tal',
  customer_phone: '11999990000',
  customer_cpf_cnpj: '12345678909',
  notes: 'observacao digitada',
};
const sell = (body = BODY) => request(app).post(`/api/v1/companies/${cid}/pdv/sale`).send(body);

describe('POST /pdv/sale -- linha [pdv-sale-timing]', () => {
  test('a venda escreve uma linha JSON com etapas, itens, consultas, pagamento e sim/nao', async () => {
    const res = await sell();
    expect(res.status).toBe(201);

    expect(linhas()).toHaveLength(1);
    const l = lerLinha();
    expect(l.status).toBe(201);
    expect(typeof l.total_ms).toBe('number');
    expect(typeof l.pre_ms).toBe('number');
    expect(typeof l.db_ms).toBe('number');
    for (const etapa of [
      'conexao', 'abertura', 'itens_validacao', 'cupom_vendedora', 'insert_venda',
      'itens_estoque', 'crediario', 'pagamento_financeiro', 'ganchos', 'commit', 'resposta',
    ]) {
      expect(typeof l.etapas[etapa]).toBe('number');
    }
    expect(l.itens).toBe(1);
    expect(l.itens_com_variante).toBe(0);
    // Todas as consultas da transacao, do BEGIN ao COMMIT.
    expect(l.queries_tx).toBe(client.query.mock.calls.length);
    expect(l.queries_tx).toBeGreaterThanOrEqual(8);
    // Releitura dos itens para a resposta, fora da transacao.
    expect(l.queries_pos).toBe(1);
    expect(l.metodo).toBe('pix');
    expect(l).toMatchObject({
      company_id: cid, sale_id: 'sale-1',
      cliente: true, vendedora: false, cupom: false, crediario: false,
      sinal: false, retroativa: false, chave_idempotencia: false, caixa_sessao: false,
    });
  });

  test('nenhum dado de cliente final nem nome de produto na linha', async () => {
    await sell();
    const bruto = linhas()[0];
    for (const proibido of ['Fulana', '11999990000', '12345678909', 'Produto Secreto', 'observacao']) {
      expect(bruto).not.toContain(proibido);
    }
  });

  test('forma de pagamento estranha vira rotulo curto, sem texto livre', async () => {
    await sell({ ...BODY, payment_method: 'Pix da <Maria> 11 99999-0000 muito muito longo' });
    const l = lerLinha();
    expect(l.metodo).toMatch(/^[a-z0-9_-]{1,20}$/);
  });

  test('venda recusada por falta de estoque (409) tambem escreve a linha', async () => {
    client = mockClient({ stock: '0' });
    db.connect.mockResolvedValue(client);
    const res = await sell();
    expect(res.status).toBe(409);
    const l = lerLinha();
    expect(l.status).toBe(409);
    expect(l.sale_id).toBeUndefined();
    expect(l.etapas.commit).toBeUndefined();
  });

  test('erro ao escrever a linha nunca derruba a venda', async () => {
    logSpy.mockImplementation((msg) => {
      if (String(msg || '').startsWith(vendaTiming.PREFIXO)) throw new Error('log quebrado');
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await sell();
    warnSpy.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.sale.id).toBe('sale-1');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('relogio quebrado no meio da venda nunca derruba a venda', async () => {
    const { performance } = require('perf_hooks');
    const real = performance.now.bind(performance);
    let quebrar = false;
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => {
      if (quebrar) throw new Error('relogio quebrado');
      return real();
    });
    // Quebra a partir da primeira consulta da transacao (o BEGIN).
    const queryReal = client.query.getMockImplementation();
    client.query.mockImplementation((...args) => { quebrar = true; return queryReal(...args); });
    const res = await sell();
    quebrar = false;
    nowSpy.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.sale.id).toBe('sale-1');
  });

  test('PDV_SALE_TIMING=off desliga a linha', async () => {
    process.env.PDV_SALE_TIMING = 'off';
    const res = await sell();
    expect(res.status).toBe(201);
    expect(linhas()).toHaveLength(0);
  });

  test('a medicao nao muda as consultas da venda: mesmas, na mesma ordem', async () => {
    await sell();
    const comMedicao = client.query.mock.calls.map((c) => [String(c[0]), c[1]]);

    // Mesma venda com o client entregue sem contador.
    const semContar = jest.spyOn(vendaTiming, 'iniciar').mockImplementation(() => ({
      contar: (c) => c, foraDaTransacao: (p) => p, etapa: () => {}, dado: () => {}, emitir: () => {},
    }));
    const outro = mockClient();
    db.connect.mockResolvedValue(outro);
    const res = await sell();
    semContar.mockRestore();
    expect(res.status).toBe(201);
    const semMedicao = outro.query.mock.calls.map((c) => [String(c[0]), c[1]]);

    expect(comMedicao.length).toBeGreaterThan(0);
    expect(comMedicao).toEqual(semMedicao);
  });
});

describe('vendaTiming -- pecas', () => {
  test('contar() repassa argumentos, resultado e erro, e nao altera o client do pool', async () => {
    const t = vendaTiming.iniciar({});
    const erro = new Error('falhou');
    const real = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ a: 1 }] })
        .mockRejectedValueOnce(erro),
      release: jest.fn(),
    };
    const queryOriginal = real.query;
    const contado = t.contar(real);

    await expect(contado.query('SELECT 1', [1])).resolves.toEqual({ rows: [{ a: 1 }] });
    await expect(contado.query('SELECT 2')).rejects.toBe(erro);
    expect(real.query).toHaveBeenNthCalledWith(1, 'SELECT 1', [1]);
    expect(real.query).toHaveBeenNthCalledWith(2, 'SELECT 2');
    expect(real.query).toBe(queryOriginal);
    expect(contado.release).toBe(real.release);
  });

  test('emitir() escreve uma vez so', () => {
    const t = vendaTiming.iniciar({});
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    t.emitir({ statusCode: 201 });
    t.emitir({ statusCode: 201 });
    const n = spy.mock.calls.filter((c) => String(c[0]).startsWith(vendaTiming.PREFIXO)).length;
    spy.mockRestore();
    expect(n).toBe(1);
  });

  test('sem o carimbo de inicio, pre_ms e null', () => {
    const t = vendaTiming.iniciar({});
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    t.emitir({ statusCode: 201 });
    const linha = JSON.parse(String(spy.mock.calls[0][0]).slice(vendaTiming.PREFIXO.length + 1));
    spy.mockRestore();
    expect(linha.pre_ms).toBeNull();
  });
});
