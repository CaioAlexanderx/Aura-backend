// ============================================================
// AURA Studio — baixa do saldo da encomenda (27/08/2026)
//
// O RELATO (Sheid Mania Personalizados): venda com sinal fechada, saldo em
// aberto, dinheiro recebido — e nenhum lugar na UI para registrar que entrou.
//
// A CAUSA: o saldo da venda com sinal vive em credit_installments, e a única
// porta de baixa era PATCH /credit/installments/:iid/pay, atrás do
// `router.use(assertCrediarioEnabled)` de creditInstallments.js. Loja de
// personalizados não liga crediário (não existe fiado nesse mercado), então a
// rota respondia 403 CREDIARIO_DISABLED. O saldo tinha cobrança
// (/orders/:oid/cobrar-saldo) e não tinha quitação.
//
// Este arquivo cobre as DUAS metades do conserto:
//   1. a rota POST /studio/orders/:oid/registrar-pagamento
//   2. o `saleId` do applyPayment — sem ele o FIFO é oldest-first por CLIENTE,
//      e dar baixa na encomenda de hoje quitaria a de março do mesmo cliente,
//      deixando o card clicado em aberto. Esse é o defeito que o escopo evita,
//      então ele é testado dos dois lados: com e sem o parâmetro.
// ============================================================
'use strict';

jest.mock('../../src/config/database');
const db = require('../../src/config/database');

jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

jest.mock('../../src/services/creditLedger', () => ({
  applyPayment: jest.fn().mockResolvedValue({ new_balance: 0, covered_installments: [] }),
}));

const express = require('express');
const request = require('supertest');
const creditLedger = require('../../src/services/creditLedger');
const studioRouter = require('../../src/routes/studioKdsApproval');

const app = express();
app.use(express.json());
app.use('/companies/:id/studio', studioRouter);

const CID = '11111111-1111-1111-1111-111111111111';
const OID = '22222222-2222-2222-2222-222222222222'; // = sales.id (view studio_orders)
const CUST = '33333333-3333-3333-3333-333333333333';

// Client fake da transação. `plan` mapeia trecho da query -> resposta.
function makeClient(plan) {
  const queries = [];
  return {
    queries,
    query: jest.fn(async (sql, params) => {
      queries.push({ sql, params });
      for (const [needle, rows] of plan) {
        if (sql.includes(needle)) return { rows };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

// Parcela em aberto de R$ 75,00 — o formato que a rota resolve a partir do pedido.
const PARCELA_ABERTA = [{
  id: 'inst-1',
  customer_id: CUST,
  amount_due: '200.00',
  covered_amount: '125.00',
  due_date: '2026-08-18',
  open_amount: '75.00',
}];

beforeEach(() => {
  jest.clearAllMocks();
  db.query = jest.fn().mockResolvedValue({ rows: [{ t: 'credit_installments' }] });
});

describe('POST /studio/orders/:oid/registrar-pagamento', () => {
  it('sem `amount`, dá baixa no saldo INTEIRO e escopa o pagamento na encomenda', async () => {
    const client = makeClient([
      ['FROM credit_installments ci', PARCELA_ABERTA],
      ['caixa_sessoes', [{ id: 'sessao-1' }]],
    ]);
    db.connect = jest.fn().mockResolvedValue(client);

    const res = await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({ method: 'pix' });

    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(75);
    expect(res.body.method).toBe('pix');
    expect(res.body.installment_id).toBe('inst-1');

    expect(creditLedger.applyPayment).toHaveBeenCalledTimes(1);
    const arg = creditLedger.applyPayment.mock.calls[0][1];
    expect(arg).toMatchObject({
      companyId:  CID,
      customerId: CUST,
      amount:     75,
      method:     'pix',
      sessaoId:   'sessao-1',
      // O ponto do conserto: a baixa é DESTA encomenda, não do cliente.
      saleId:     OID,
    });

    const sqls = client.queries.map((q) => q.sql).join(' | ');
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });

  it('aceita pagamento PARCIAL e a encomenda segue com o que falta', async () => {
    const client = makeClient([
      // A 1a query da parcela (antes da baixa) e a de saldo restante (depois)
      // batem no mesmo trecho, então o plano responde a mais específica primeiro.
      ['SUM(ci.amount_due', [{ remaining: '25.00' }]],
      ['FROM credit_installments ci', PARCELA_ABERTA],
    ]);
    db.connect = jest.fn().mockResolvedValue(client);

    const res = await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({ method: 'dinheiro', amount: 50 });

    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(50);
    expect(res.body.remaining).toBe(25);
    expect(res.body.settled).toBe(false);
    expect(creditLedger.applyPayment.mock.calls[0][1].amount).toBe(50);
  });

  it('quitação total devolve settled: true', async () => {
    const client = makeClient([['FROM credit_installments ci', PARCELA_ABERTA]]);
    db.connect = jest.fn().mockResolvedValue(client);

    const res = await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(0);
    expect(res.body.settled).toBe(true);
    // Default de método: dinheiro (o balcão).
    expect(res.body.method).toBe('dinheiro');
  });

  it('recusa valor MAIOR que o saldo — o excedente viraria crédito do cliente', async () => {
    const client = makeClient([['FROM credit_installments ci', PARCELA_ABERTA]]);
    db.connect = jest.fn().mockResolvedValue(client);

    const res = await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({ amount: 300 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_ACIMA_DO_SALDO');
    expect(res.body.open_amount).toBe(75);
    expect(creditLedger.applyPayment).not.toHaveBeenCalled();
    expect(client.queries.map((q) => q.sql).join(' | ')).toContain('ROLLBACK');
  });

  it('recusa valor zero ou negativo', async () => {
    const client = makeClient([['FROM credit_installments ci', PARCELA_ABERTA]]);
    db.connect = jest.fn().mockResolvedValue(client);

    const res = await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({ amount: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_INVALIDO');
    expect(creditLedger.applyPayment).not.toHaveBeenCalled();
  });

  it('404 quando a encomenda não tem saldo em aberto', async () => {
    const client = makeClient([]); // nenhuma parcela
    db.connect = jest.fn().mockResolvedValue(client);

    const res = await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_OPEN_BALANCE');
    expect(creditLedger.applyPayment).not.toHaveBeenCalled();
  });

  it('recusa forma de pagamento inválida — crediário inclusive', async () => {
    db.connect = jest.fn();
    const res = await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({ method: 'crediario' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('METHOD_INVALIDO');
    // Nem abre conexão: barra antes.
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('trava a parcela com FOR UPDATE — duas abas não dão baixa em dobro', async () => {
    const client = makeClient([['FROM credit_installments ci', PARCELA_ABERTA]]);
    db.connect = jest.fn().mockResolvedValue(client);

    await request(app)
      .post(`/companies/${CID}/studio/orders/${OID}/registrar-pagamento`)
      .send({});

    const lock = client.queries.find((q) => q.sql.includes('FROM credit_installments ci'));
    expect(lock.sql).toContain('FOR UPDATE');
    // Escopo por empresa E por pedido nas duas pontas.
    expect(lock.params).toEqual([CID, OID]);
  });
});

// ─────────────────────────────────────────────────────────────
// O escopo por encomenda no ledger
// ─────────────────────────────────────────────────────────────
describe('applyPayment — escopo por encomenda (saleId)', () => {
  // O ledger real, sem o mock do barrel acima.
  const ledger = jest.requireActual('../../src/services/credit/ledger');

  const SALE = 'sale-abc';

  function makeLedgerClient() {
    const queries = [];
    return {
      queries,
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        // O INSERT do pagamento precisa devolver a linha: o id dela vira a
        // chave de idempotência do lançamento de sobra.
        if (sql.includes('INSERT INTO customer_credit_transactions')) {
          return { rows: [{ id: 'tx-1' }] };
        }
        return { rows: [] };
      }),
    };
  }

  // Os três FIFOs que o pagamento percorre, e como cada um se prende à venda.
  const FIFOS = [
    ['A Receber',            'FROM transactions t',        'AND s.id = $3'],
    ['cobertura da parcela', 'FROM credit_installments',   'AND sale_id = $3'],
  ];

  it.each(FIFOS)('COM saleId, o FIFO de %s fica preso à venda', async (_nome, needle, scope) => {
    const client = makeLedgerClient();
    await ledger.applyPayment(client, {
      companyId: 'c1', customerId: 'cust1', amount: 75, method: 'pix', saleId: SALE,
    });

    const q = client.queries.find((x) => x.sql.includes(needle) && x.sql.includes('$1'));
    expect(q).toBeDefined();
    expect(q.sql).toContain(scope);
    expect(q.params).toContain(SALE);
  });

  it.each(FIFOS)('SEM saleId, o FIFO de %s continua global por cliente', async (_nome, needle) => {
    const client = makeLedgerClient();
    await ledger.applyPayment(client, {
      companyId: 'c1', customerId: 'cust1', amount: 75, method: 'pix',
    });

    const q = client.queries.find((x) => x.sql.includes(needle) && x.sql.includes('$1'));
    expect(q).toBeDefined();
    expect(q.sql).not.toContain('sale_id = $');
    expect(q.sql).not.toContain('s.id = $');
    expect(q.params).toEqual(['c1', 'cust1']);
  });

  it('saleId e accountId convivem: carnê E encomenda, sem colisão de $n', async () => {
    const client = makeLedgerClient();
    await ledger.applyPayment(client, {
      companyId: 'c1', customerId: 'cust1', amount: 75,
      accountId: 'acc-9', saleId: SALE,
    });

    const q = client.queries.find(
      (x) => x.sql.includes('FROM credit_installments') && x.sql.includes('FOR UPDATE')
    );
    expect(q.sql).toContain('AND account_id = $3');
    expect(q.sql).toContain('AND sale_id = $4');
    expect(q.params).toEqual(['c1', 'cust1', 'acc-9', SALE]);
  });
});
