// ============================================================
// Crediário — um carnê por compra (10/10/2026)
//
// Cada venda no crediário feita no Caixa nasce como um carnê novo
// ("Compra de DD/MM"), com o débito e as parcelas dela. O que estes testes
// travam na ROTA:
//   1. venda parcelada cria o carnê e liga débito + parcelas a ele;
//   2. segunda compra do dia ganha "(2)"; venda retroativa usa o dia dela;
//   3. venda 1x/fiado (sem parcela) também nasce com carnê e débito ligado;
//   4. credit_account_id (juntar a um carnê existente) NÃO cria carnê novo;
//      carnê de outro cliente ou fechado é 422, com a venda desfeita;
//   5. falha de schema ao criar o carnê não derruba a venda;
//   6. venda à vista e venda com sinal não criam carnê;
//   7. cancelar a venda tira da ficha o carnê que ficou vazio;
//   8. unificar (app antigo, sem credit_account_id na venda) adota a venda:
//      o débito vai para o carnê alvo e o carnê automático sai da ficha;
//   9. lançamento manual com new_account=true e sem nome: o backend nomeia
//      ("Lançamento de DD/MM"); sem a flag continua na Conta geral.
//
// Mock por CONTEÚDO DO SQL.
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const LOJA    = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const CLIENTE = '8fbde0b9-2ec0-4bc9-be58-f86c31465fa6';
const PROD    = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SALE    = '5a1e0000-0000-4000-8000-000000000001';
const CARNE_NOVO   = 'c0000000-0000-4000-8000-00000000000a';
const CARNE_ANTIGO = 'c0000000-0000-4000-8000-00000000000b';

const pdvRouter   = require('../src/routes/pdv');
const unifyRouter = require('../src/routes/creditUnify');
const creditRouter = require('../src/routes/credit');
const { carneDayLabel } = require('../src/services/credit/carneAuto');

const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', pdvRouter);
app.use('/companies/:id/credit', unifyRouter);
app.use('/companies/:id/credit', creditRouter);

let client;

// opts:
//   nomesAbertos      nomes de carnês abertos do cliente (colisão)
//   carneFalha        código de erro do INSERT em credit_accounts
//   carneEscolhido    linha devolvida na conferência do carnê escolhido (null = não existe)
//   debitoDaVenda     linhas do débito da venda (cancelamento / unificação)
//   carnesVazios      ids que o UPDATE "carnê vazio" marca
function despachar(opts = {}) {
  const {
    nomesAbertos = [], carneFalha = null, carneEscolhido = null,
    debitoDaVenda = [], carnesVazios = [],
  } = opts;
  const responder = (sql, params) => {
    const s = String(sql || '');

    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: {} }] });
    if (/crediario_enabled/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    if (/FROM customers WHERE id/i.test(s)) return Promise.resolve({ rows: [{ id: CLIENTE }] });
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Vans Hylane', cost_price: '60.00', stock_qty: '50', stock_company_id: LOJA }] });
    }
    if (/INSERT INTO sales/i.test(s)) {
      return Promise.resolve({ rows: [{ id: SALE, total_amount: '300.00', status: 'completed' }] });
    }
    if (/FROM sales WHERE id=\$1 AND company_id=\$2/i.test(s)) {
      return Promise.resolve({ rows: [{ id: SALE, customer_id: CLIENTE, employee_id: null, total_amount: '300.00', coupon_id: null, status: 'completed' }] });
    }
    if (/SELECT customer_id FROM sales/i.test(s)) return Promise.resolve({ rows: [{ customer_id: CLIENTE }] });

    // --- carnê ---
    if (/SELECT name FROM credit_accounts/i.test(s)) return Promise.resolve({ rows: nomesAbertos.map(name => ({ name })) });
    if (/SELECT id, name, status FROM credit_accounts/i.test(s)) {
      return Promise.resolve({ rows: carneEscolhido ? [carneEscolhido] : [] });
    }
    if (/INSERT INTO credit_accounts/i.test(s)) {
      if (carneFalha) return Promise.reject(Object.assign(new Error('falha no carne'), { code: carneFalha }));
      return Promise.resolve({ rows: [{ id: CARNE_NOVO, name: params[2] }] });
    }
    if (/UPDATE credit_accounts/i.test(s)) return Promise.resolve({ rows: carnesVazios.map(id => ({ id })) });

    // --- crediário ---
    if (/INSERT INTO customer_credit_profiles/i.test(s)) return Promise.resolve({ rows: [{ id: 'prof-1', status: 'active', credit_score: 700 }] });
    if (/INSERT INTO credit_plan_configs/i.test(s)) return Promise.resolve({ rows: [{ id: 'conf-1', max_installments: 500, interest_rate: '0' }] });
    if (/INSERT INTO customer_credit_transactions/i.test(s)) return Promise.resolve({ rows: [{ id: 'tx-1', type: 'debit', amount: '300.00' }] });
    if (/INSERT INTO credit_installments/i.test(s)) return Promise.resolve({ rows: [{ id: 'inst-' + params[3] }] });
    if (/DELETE FROM customer_credit_transactions/i.test(s)) return Promise.resolve({ rows: debitoDaVenda });
    if (/SELECT DISTINCT account_id FROM customer_credit_transactions/i.test(s)) {
      return Promise.resolve({ rows: debitoDaVenda.map(d => ({ account_id: d.account_id })) });
    }
    if (/FROM customer_credit_balances/i.test(s)) return Promise.resolve({ rows: [{ balance: '300.00' }] });

    return Promise.resolve({ rows: [] });
  };
  client = { query: jest.fn().mockImplementation(responder), release: jest.fn() };
  db.query.mockImplementation(responder);
  db.connect = jest.fn().mockResolvedValue(client);
}

const chamadas = (re) => client.query.mock.calls.filter(c => re.test(String(c[0] || '')));
const params = (re) => (chamadas(re)[0] || [])[1];
const houve = (re) => chamadas(re).length > 0;

const VENDA = {
  items: [{ product_id: PROD, quantity: 1, unit_price: 300 }],
  payment_method: 'crediario',
  customer_id: CLIENTE,
};
const vender = (body) => request(app).post(`/companies/${LOJA}/pdv/sale`).send({ ...VENDA, ...body });

beforeEach(() => jest.resetAllMocks());

describe('POST /pdv/sale — a venda no crediário nasce num carnê', () => {
  test('parcelada em 3x: cria "Compra de DD/MM" e liga débito + parcelas ao carnê', async () => {
    despachar();
    const res = await vender({ installments: 3, first_due_date: '2026-11-10' });
    expect(res.status).toBe(201);

    const nome = `Compra de ${carneDayLabel(new Date())}`;
    const criacao = params(/INSERT INTO credit_accounts/i);
    expect(criacao).toEqual([LOJA, CLIENTE, nome]);

    // Débito: account_id é o 7º parâmetro do INSERT do razão.
    const debito = params(/INSERT INTO customer_credit_transactions/i);
    expect(debito[2]).toBe(SALE);
    expect(debito[3]).toBe(300);
    expect(debito[6]).toBe(CARNE_NOVO);

    // As 3 parcelas, todas no carnê.
    const parcelas = chamadas(/INSERT INTO credit_installments/i);
    expect(parcelas).toHaveLength(3);
    for (const p of parcelas) {
      expect(p[1][1]).toBe(SALE);
      expect(p[1][7]).toBe(CARNE_NOVO);
    }

    // O carnê nasce antes do débito, dentro da mesma transação e de um savepoint.
    const ordem = client.query.mock.calls.map(c => String(c[0]));
    const iCarne = ordem.findIndex(s => /INSERT INTO credit_accounts/i.test(s));
    const iDebito = ordem.findIndex(s => /INSERT INTO customer_credit_transactions/i.test(s));
    expect(ordem.indexOf('BEGIN')).toBeLessThan(iCarne);
    expect(ordem.indexOf('SAVEPOINT carne_auto')).toBeLessThan(iCarne);
    expect(iCarne).toBeLessThan(iDebito);
    expect(iDebito).toBeLessThan(ordem.indexOf('COMMIT'));

    expect(res.body.credit).toMatchObject({
      debited: 300, account_id: CARNE_NOVO, account_name: nome, account_created: true,
    });
    expect(res.body.credit.installments).toHaveLength(3);
  });

  test('segunda compra do dia: "(2)"', async () => {
    const base = `Compra de ${carneDayLabel(new Date())}`;
    despachar({ nomesAbertos: [base] });
    const res = await vender({ installments: 2, first_due_date: '2026-11-10' });
    expect(res.status).toBe(201);
    expect(params(/INSERT INTO credit_accounts/i)[2]).toBe(`${base} (2)`);
  });

  test('venda retroativa: o nome leva o dia da venda, não o de hoje', async () => {
    despachar();
    const res = await vender({ sale_date: '2026-09-13', installments: 2, first_due_date: '2026-10-13' });
    expect(res.status).toBe(201);
    expect(params(/INSERT INTO credit_accounts/i)[2]).toBe('Compra de 13/09');
  });

  test('1x/fiado: sem parcela (como sempre), mas o carnê nasce com o débito ligado', async () => {
    despachar();
    const res = await vender({});
    expect(res.status).toBe(201);
    expect(houve(/INSERT INTO credit_accounts/i)).toBe(true);
    expect(params(/INSERT INTO customer_credit_transactions/i)[6]).toBe(CARNE_NOVO);
    expect(houve(/INSERT INTO credit_installments/i)).toBe(false);
    expect(res.body.credit).toMatchObject({ account_id: CARNE_NOVO, installments: [] });
  });

  test('parte no crediário (pagamento dividido): o carnê cobre só a parte a prazo', async () => {
    despachar();
    const res = await vender({
      payment_method: undefined,
      payments: [{ method: 'pix', value: 100 }, { method: 'crediario', value: 200 }],
      installments: 2, first_due_date: '2026-11-10',
    });
    expect(res.status).toBe(201);
    const debito = params(/INSERT INTO customer_credit_transactions/i);
    expect(debito[3]).toBe(200);
    expect(debito[6]).toBe(CARNE_NOVO);
  });
});

describe('POST /pdv/sale — juntar a um carnê existente (credit_account_id)', () => {
  test('não cria carnê novo; débito e parcelas entram no carnê escolhido', async () => {
    despachar({ carneEscolhido: { id: CARNE_ANTIGO, name: 'Compra de 13/09', status: 'open' } });
    const res = await vender({ credit_account_id: CARNE_ANTIGO, installments: 2, first_due_date: '2026-11-10' });
    expect(res.status).toBe(201);

    expect(houve(/INSERT INTO credit_accounts/i)).toBe(false);
    // Conferido com a empresa e o cliente da venda.
    expect(params(/SELECT id, name, status FROM credit_accounts/i)).toEqual([CARNE_ANTIGO, LOJA, CLIENTE]);
    expect(params(/INSERT INTO customer_credit_transactions/i)[6]).toBe(CARNE_ANTIGO);
    for (const p of chamadas(/INSERT INTO credit_installments/i)) expect(p[1][7]).toBe(CARNE_ANTIGO);
    expect(res.body.credit).toMatchObject({ account_id: CARNE_ANTIGO, account_name: 'Compra de 13/09', account_created: false });
  });

  test('carnê de outro cliente/loja: 422, venda desfeita, nada no razão', async () => {
    despachar({ carneEscolhido: null });
    const res = await vender({ credit_account_id: CARNE_ANTIGO });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CREDIT_ACCOUNT_NOT_FOUND');
    expect(houve(/^ROLLBACK$/)).toBe(true);
    expect(houve(/^COMMIT$/)).toBe(false);
    expect(houve(/INSERT INTO customer_credit_transactions/i)).toBe(false);
    expect(houve(/INSERT INTO credit_accounts/i)).toBe(false);
  });

  test('carnê fechado: 422 CREDIT_ACCOUNT_CLOSED', async () => {
    despachar({ carneEscolhido: { id: CARNE_ANTIGO, name: 'Antigo', status: 'closed' } });
    const res = await vender({ credit_account_id: CARNE_ANTIGO });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CREDIT_ACCOUNT_CLOSED');
    expect(houve(/INSERT INTO customer_credit_transactions/i)).toBe(false);
  });
});

describe('POST /pdv/sale — o carnê nunca derruba a venda', () => {
  test.each(['42P01', '42703', '23505'])('erro %s ao criar o carnê: venda 201, débito sem carnê', async (code) => {
    despachar({ carneFalha: code });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await vender({ installments: 2, first_due_date: '2026-11-10' });
    warn.mockRestore();

    expect(res.status).toBe(201);
    expect(houve(/^ROLLBACK TO SAVEPOINT carne_auto$/)).toBe(true);
    expect(houve(/^COMMIT$/)).toBe(true);
    expect(params(/INSERT INTO customer_credit_transactions/i)[6]).toBeNull();
    expect(chamadas(/INSERT INTO credit_installments/i)).toHaveLength(2);
    expect(res.body.credit).toMatchObject({ debited: 300, account_id: null, account_created: false });
  });
});

describe('POST /pdv/sale — quem não ganha carnê', () => {
  test('venda à vista não toca em credit_accounts', async () => {
    despachar();
    const res = await vender({ payment_method: 'pix' });
    expect(res.status).toBe(201);
    expect(houve(/credit_accounts/i)).toBe(false);
    expect(res.body.credit).toBeNull();
  });

  test('venda com sinal (Studio): saldo no crediário, sem carnê', async () => {
    despachar();
    const res = await request(app).post(`/companies/${LOJA}/pdv/sale-com-sinal`).send({
      items: [{ product_id: PROD, quantity: 1, unit_price: 300 }],
      sinal: { method: 'pix', amount: 100 },
      saldo_due_date: '2026-11-10',
      customer_id: CLIENTE,
    });
    expect(res.status).toBe(201);
    expect(houve(/INSERT INTO credit_accounts/i)).toBe(false);
    expect(params(/INSERT INTO customer_credit_transactions/i)[6]).toBeNull();
  });
});

describe('DELETE /pdv/sale/:saleId — cancelamento não deixa carnê fantasma', () => {
  test('o carnê da venda cancelada, se ficou vazio, sai da ficha', async () => {
    despachar({
      debitoDaVenda: [{ id: 'tx-1', account_id: CARNE_NOVO }],
      carnesVazios: [CARNE_NOVO],
    });
    const res = await request(app).delete(`/companies/${LOJA}/pdv/sale/${SALE}`);
    expect(res.status).toBe(200);

    const upd = chamadas(/UPDATE credit_accounts/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/status = 'cancelled'/);
    // Só marca carnê SEM lançamento e SEM parcela viva.
    expect(upd[0][0]).toMatch(/NOT EXISTS[\s\S]*customer_credit_transactions/);
    expect(upd[0][0]).toMatch(/NOT EXISTS[\s\S]*credit_installments/);
    expect(upd[0][1]).toEqual([[CARNE_NOVO], LOJA]);

    // Depois de apagar o débito e cancelar as parcelas — senão nunca estaria vazio.
    const ordem = client.query.mock.calls.map(c => String(c[0]));
    const iUpd = ordem.findIndex(s => /UPDATE credit_accounts/i.test(s));
    expect(ordem.findIndex(s => /DELETE FROM customer_credit_transactions/i.test(s))).toBeLessThan(iUpd);
    expect(ordem.findIndex(s => /UPDATE credit_installments/i.test(s))).toBeLessThan(iUpd);
    expect(houve(/^COMMIT$/)).toBe(true);
  });

  test('venda antiga, sem carnê: nenhuma consulta nova', async () => {
    despachar({ debitoDaVenda: [{ id: 'tx-1', account_id: null }] });
    const res = await request(app).delete(`/companies/${LOJA}/pdv/sale/${SALE}`);
    expect(res.status).toBe(200);
    expect(houve(/credit_accounts/i)).toBe(false);
    expect(houve(/SAVEPOINT carne/i)).toBe(false);
  });
});

describe('POST /credit/.../unify com sale_id — a unificação adota a venda', () => {
  const unificar = (aid) => request(app)
    .post(`/companies/${LOJA}/credit/customers/${CLIENTE}/accounts/${aid}/unify`)
    .send({ amount: 300, installments: 3, first_due_date: '2026-11-10', sale_id: SALE });

  test('app antigo: o débito sai do carnê automático e vai para o carnê alvo', async () => {
    despachar({ debitoDaVenda: [{ account_id: CARNE_NOVO }], carnesVazios: [CARNE_NOVO] });
    const res = await unificar(CARNE_ANTIGO);
    expect(res.status).toBe(200);

    const move = chamadas(/UPDATE customer_credit_transactions/i);
    expect(move).toHaveLength(1);
    expect(move[0][1]).toEqual([SALE, LOJA, CLIENTE, CARNE_ANTIGO, [CARNE_NOVO]]);
    // O carnê automático, vazio, sai da ficha.
    expect(params(/UPDATE credit_accounts/i)).toEqual([[CARNE_NOVO], LOJA]);
    expect(res.body.adopted_sale).toEqual({ from_account_ids: [CARNE_NOVO], cancelled_account_ids: [CARNE_NOVO] });
    // As parcelas novas do carnê unificado continuam lá (3 inserts no alvo).
    for (const p of chamadas(/INSERT INTO credit_installments/i)) expect(p[1][7]).toBe(CARNE_ANTIGO);
  });

  test('app novo: a venda já nasceu no carnê alvo — nada a adotar', async () => {
    despachar({ debitoDaVenda: [{ account_id: CARNE_ANTIGO }] });
    const res = await unificar(CARNE_ANTIGO);
    expect(res.status).toBe(200);
    expect(houve(/UPDATE customer_credit_transactions/i)).toBe(false);
    expect(houve(/UPDATE credit_accounts/i)).toBe(false);
    expect(res.body.adopted_sale).toBeUndefined();
  });

  test('unificar na Conta geral: o débito volta a ficar sem carnê', async () => {
    despachar({ debitoDaVenda: [{ account_id: CARNE_NOVO }], carnesVazios: [CARNE_NOVO] });
    const res = await unificar('general');
    expect(res.status).toBe(200);
    expect(params(/UPDATE customer_credit_transactions/i)[3]).toBeNull();
  });

  test('falha ao adotar não desfaz a unificação', async () => {
    despachar({ debitoDaVenda: [{ account_id: CARNE_NOVO }] });
    const original = client.query.getMockImplementation();
    client.query.mockImplementation((sql, p) => (/UPDATE customer_credit_transactions/i.test(String(sql))
      ? Promise.reject(Object.assign(new Error('coluna'), { code: '42703' }))
      : original(sql, p)));
    const res = await unificar(CARNE_ANTIGO);
    expect(res.status).toBe(200);
    expect(houve(/^ROLLBACK TO SAVEPOINT unify_adota_venda$/)).toBe(true);
    expect(houve(/^COMMIT$/)).toBe(true);
  });
});

describe('POST /credit/manual-entry — carnê novo sem nome', () => {
  const lancar = (body) => request(app).post(`/companies/${LOJA}/credit/manual-entry`)
    .send({ customer_id: CLIENTE, amount: 120, installments: 2, first_due_date: '2026-11-10', ...body });

  test('new_account=true sem nome: "Lançamento de DD/MM", débito e parcelas no carnê', async () => {
    despachar();
    const res = await lancar({ new_account: true });
    expect(res.status).toBe(201);
    expect(params(/INSERT INTO credit_accounts/i)).toEqual([LOJA, CLIENTE, `Lançamento de ${carneDayLabel(new Date())}`]);
    expect(params(/INSERT INTO customer_credit_transactions/i)[6]).toBe(CARNE_NOVO);
    expect(res.body.account_id).toBe(CARNE_NOVO);
  });

  test('lançamento retroativo: o nome leva o dia do lançamento', async () => {
    despachar();
    const res = await lancar({ new_account: true, entry_date: '2026-09-13' });
    expect(res.status).toBe(201);
    expect(params(/INSERT INTO credit_accounts/i)[2]).toBe('Lançamento de 13/09');
  });

  test('new_account=true COM nome: vale o nome informado', async () => {
    despachar();
    const res = await lancar({ new_account: true, new_account_name: 'Reforma da cozinha' });
    expect(res.status).toBe(201);
    expect(params(/INSERT INTO credit_accounts/i)[2]).toBe('Reforma da cozinha');
  });

  test('sem a flag, sem nome e sem account_id: Conta geral, como o app de hoje espera', async () => {
    despachar();
    const res = await lancar({});
    expect(res.status).toBe(201);
    expect(houve(/INSERT INTO credit_accounts/i)).toBe(false);
    expect(res.body.account_id).toBeNull();
  });

  test('tabela de carnês ausente: o lançamento entra na Conta geral em vez de falhar', async () => {
    despachar({ carneFalha: '42P01' });
    const res = await lancar({ new_account: true });
    expect(res.status).toBe(201);
    expect(res.body.account_id).toBeNull();
  });
});
