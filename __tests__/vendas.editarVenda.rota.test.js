// ============================================================
// PATCH /companies/:id/sales/:sale_id — Editar venda (09/11/2026)
//
// Banco de mentira: cobre o contrato da rota e as travas. A conta de
// verdade (razão x parcelas, caixa, Financeiro, cliente, comissão) está em
// vendas.editarVenda.banco.test.js, com Postgres real.
//
//   1. campo desconhecido (o corpo do Studio: items/discount_amount) = 400
//      com a lista, sem gravar nada
//   2. corpo sem nada para mudar = 400
//   3. venda de outra empresa = 404
//   4. papel sem Financeiro: forma e cliente = 403; vendedor passa
//   5. seller_id ausente não zera o vendedor (ausente ≠ null)
//   6. dry_run: transação READ ONLY, nenhum INSERT/UPDATE/DELETE
//   7. cancelada / troca / devolução = 409; devolução ativa trava forma e
//      cliente e deixa o vendedor
//   8. crediário com pagamento trava forma e cliente
//   9. NFC-e autorizada: crediário recusado; outra forma passa com aviso
//  10. soma das formas diferente do total = 422
//  11. sem a tabela de registro (migration 431) = 503
//  12. entrar e sair do crediário usam createCreditSale / cancelCreditSale
// ============================================================
'use strict';

// 1ª parcela dentro da janela do crediário (validateFirstDueDate: de hoje
// até 90 dias), calculada no dia do teste para nunca vencer.
const PRIMEIRA = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const mockCreate = jest.fn();
const mockCancel = jest.fn();
jest.mock('../src/services/creditLedger', () => ({
  createCreditSale: (...a) => mockCreate(...a),
  cancelCreditSale: (...a) => mockCancel(...a),
}));

const CID = '11111111-1111-4111-8111-111111111111';
const SALE = '22222222-2222-4222-8222-222222222222';
const ANA = '33333333-3333-4333-8333-333333333333';
const BIA = '44444444-4444-4444-8444-444444444444';
const CLI = '55555555-5555-4555-8555-555555555555';
const USER = '66666666-6666-4666-8666-666666666666';

const client = { query: jest.fn(), release: jest.fn() };
db.connect = jest.fn().mockResolvedValue(client);

const editarVenda = require('../src/services/editarVenda');
const router = require('../src/routes/sales');

let papel = 'owner';
let permissoes = null;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: USER }; req.companyRole = papel; next(); });
app.use('/companies/:id/sales', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));

function venda(over = {}) {
  return Object.assign({
    id: SALE, company_id: CID, sale_number: 1042, customer_id: null, seller_id: USER, employee_id: ANA,
    seller_name: 'Ana', total_amount: '189.70', payment_method: 'dinheiro', status: 'completed', type: 'sale',
    created_at: new Date('2026-11-07T18:42:00Z'), dia: '2026-11-07', customer_name: null, employee_name: 'Ana',
    pagamentos: [{ id: 'sp1', method: 'dinheiro', amount: '189.70', sessao_id: null, created_at: '2026-11-07T18:42:00Z' }],
    debitos: [], recebiveis: [], parcelas: [],
    receita: { id: 'tx1', amount: '189.70', description: 'Venda PDV - Batom (dinheiro)' },
    taxa: null, devolucoes: [], nfce: null, produtos: ['Batom'], caixa: null, pdv_settings: {},
  }, over);
}

let linha;
function montar(over) {
  linha = venda(over);
  client.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/^SELECT 1 FROM sales WHERE id = \$1 AND company_id = \$2 FOR UPDATE$/.test(s)) {
      return Promise.resolve({ rows: linha ? [{ '?column?': 1 }] : [] });
    }
    if (/AS pagamentos,/.test(s) && /FROM sales s/.test(s)) {
      return Promise.resolve({ rows: linha ? [linha] : [] });
    }
    if (/FROM employees WHERE id = \$1 AND company_id = \$2/.test(s)) {
      return Promise.resolve({ rows: [{ id: BIA, name: 'Bia' }] });
    }
    if (/FROM customers WHERE id/.test(s)) {
      return Promise.resolve({ rows: [{ id: CLI, name: 'Cliente Exemplo' }] });
    }
    if (/^\s*SELECT id FROM transactions WHERE idempotency_key = \$1/.test(s)) {
      return Promise.resolve({ rows: [{ id: 'tx-' + String(params && params[0]) }] });
    }
    if (/INSERT INTO credit_accounts/.test(s)) {
      return Promise.resolve({ rows: [{ id: 'acc-novo', name: 'Compra de 07/11' }] });
    }
    if (/INSERT INTO sale_edits/.test(s)) {
      return Promise.resolve({ rows: [{ id: 'ed1', created_at: new Date() }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

let registroExiste = true;
beforeEach(() => {
  jest.clearAllMocks();
  editarVenda._resetCache();
  papel = 'owner';
  permissoes = null;
  registroExiste = true;
  mockCreate.mockResolvedValue({ debited: { id: 'd1' }, schedule: [], warnings: [] });
  mockCancel.mockResolvedValue({ ok: true });
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/to_regclass\('public.sale_edits'\)/.test(s)) return Promise.resolve({ rows: [{ ok: registroExiste }] });
    if (/information_schema.columns/.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM companies c\s+LEFT JOIN company_members/.test(s)) {
      return Promise.resolve({ rows: [{ is_owner: false, role_label: 'vendedor', permissions: permissoes, membro: true }] });
    }
    if (/SELECT full_name FROM users/.test(s)) return Promise.resolve({ rows: [{ full_name: 'Caio' }] });
    return Promise.resolve({ rows: [] });
  });
  montar();
});

const patch = (body) => request(app).patch(`/companies/${CID}/sales/${SALE}`).send(body);
const escritas = () => client.query.mock.calls
  .map(([s]) => String(s || ''))
  .filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s));
const houve = (re) => client.query.mock.calls.some(([s]) => re.test(String(s || '')));

test('1. corpo do Studio (items/discount_amount) dá 400 com a lista e não grava', async () => {
  const res = await patch({ items: [{ id: 'x', quantity: 1, unit_price: 10 }], discount_amount: 5 });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('UNKNOWN_FIELD');
  expect(res.body.fields).toEqual(['items', 'discount_amount']);
  expect(client.query).not.toHaveBeenCalled();
});

test('1b. campo desconhecido junto de um válido também é 400 (nunca sucesso calado)', async () => {
  const res = await patch({ seller_id: BIA, notes: 'x' });
  expect(res.status).toBe(400);
  expect(res.body.fields).toEqual(['notes']);
  expect(escritas()).toHaveLength(0);
});

test('2. sem nada para mudar = 400', async () => {
  const res = await patch({ reason: 'só motivo' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('NOTHING_TO_EDIT');
});

test('3. venda de outra empresa = 404', async () => {
  montar();
  linha = null;
  const res = await patch({ seller_id: BIA });
  expect(res.status).toBe(404);
  const travaCall = client.query.mock.calls.find(([s]) => /FOR UPDATE$/.test(String(s)));
  expect(travaCall[1]).toEqual([SALE, CID]);
  expect(escritas()).toHaveLength(0);
});

describe('4. permissões', () => {
  beforeEach(() => { papel = 'vendedor'; permissoes = { pdv: true, vendas: true }; });

  test('vendedor(a) sem Financeiro: forma = 403', async () => {
    const res = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_FIELD');
    expect(escritas()).toHaveLength(0);
  });

  test('vendedor(a) sem Financeiro: cliente = 403', async () => {
    const res = await patch({ customer_id: CLI });
    expect(res.status).toBe(403);
    expect(escritas()).toHaveLength(0);
  });

  test('vendedor(a) sem Financeiro: vendedor passa', async () => {
    const res = await patch({ seller_id: BIA });
    expect(res.status).toBe(200);
    expect(res.body.seller_id).toBe(BIA);
    expect(houve(/UPDATE sales SET[\s\S]*employee_id = \$3::uuid/)).toBe(true);
  });

  test('sem pdv, vendas nem Financeiro: vendedor = 403', async () => {
    permissoes = { estoque: true };
    const res = await patch({ seller_id: BIA });
    expect(res.status).toBe(403);
  });

  test('Financeiro muda a forma', async () => {
    permissoes = { financeiro: true };
    const res = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(res.status).toBe(200);
  });

  test('acesso total (permissions null) muda a forma', async () => {
    permissoes = null;
    const res = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(res.status).toBe(200);
  });
});

test('5. seller_id ausente não zera o vendedor', async () => {
  const res = await patch({ customer_id: CLI });
  expect(res.status).toBe(200);
  expect(houve(/employee_id = \$3::uuid/)).toBe(false);
  expect(houve(/UPDATE sales SET customer_id = \$3/)).toBe(true);
  expect(res.body.seller_id).toBe(ANA);
});

test('5b. seller_id: null tira o vendedor(a) de propósito', async () => {
  const res = await patch({ seller_id: null });
  expect(res.status).toBe(200);
  const call = client.query.mock.calls.find(([s]) => /employee_id = \$3::uuid/.test(String(s)));
  expect(call[1][2]).toBeNull();
});

test('6. dry_run devolve o plano numa transação READ ONLY e não grava nada', async () => {
  const res = await patch({ payments: [{ method: 'dinheiro', amount: 100 }, { method: 'pix', amount: 89.70 }], seller_id: BIA, dry_run: true });
  expect(res.status).toBe(200);
  expect(res.body.dry_run).toBe(true);
  expect(res.body.plan.changes).toEqual(['seller', 'payments']);
  expect(res.body.plan.effects.map((e) => e.text)).toEqual(expect.arrayContaining([
    'O Financeiro e o caixa de 07/11 passam a mostrar R$ 100,00 em dinheiro e R$ 89,70 no Pix.',
    'A comissão desta venda (novembro) sai de Ana e passa para Bia.',
    'Os produtos e o estoque não mudam.',
  ]));
  expect(client.query.mock.calls[0][0]).toBe('BEGIN TRANSACTION READ ONLY');
  expect(escritas()).toHaveLength(0);
  expect(houve(/^COMMIT/)).toBe(false);
});

describe('7. travas da venda', () => {
  test('cancelada = 409', async () => {
    montar({ status: 'cancelled' });
    const res = await patch({ seller_id: BIA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SALE_CANCELLED');
  });
  test('troca = 409', async () => {
    montar({ type: 'troca' });
    const res = await patch({ seller_id: BIA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SALE_TYPE_LOCKED');
  });
  test('devolução = 409', async () => {
    montar({ type: 'devolucao' });
    const res = await patch({ seller_id: BIA });
    expect(res.status).toBe(409);
  });
  test('devolução ativa: forma = 409, vendedor passa', async () => {
    montar({ devolucoes: [{ id: 'dev', sale_number: 1051, type: 'devolucao' }] });
    const r1 = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('SALE_HAS_ACTIVE_RETURN');
    expect(r1.body.error).toContain('#1051');
    const r2 = await patch({ customer_id: CLI });
    expect(r2.status).toBe(409);
    const r3 = await patch({ seller_id: BIA });
    expect(r3.status).toBe(200);
  });
});

const VENDA_FIADA = {
  customer_id: CLI, customer_name: 'Cliente Exemplo', payment_method: 'crediario',
  pagamentos: [], receita: null,
  debitos: [{ id: 'd1', customer_id: CLI, amount: '189.70', account_id: 'acc1', account_name: 'Compra de 07/11' }],
  recebiveis: [{ id: 'r1', amount: '189.70', status: 'pending', key: 'pdv-credit-receivable-' + SALE }],
  parcelas: [
    { id: 'i1', n: 1, total: 2, amount_due: '94.85', due_date: '2026-12-07', status: 'pending', covered: '0' },
    { id: 'i2', n: 2, total: 2, amount_due: '94.85', due_date: '2027-01-07', status: 'pending', covered: '0' },
  ],
};

test('8. crediário com parcela paga trava forma e cliente; vendedor passa', async () => {
  montar(Object.assign({}, VENDA_FIADA, {
    parcelas: [Object.assign({}, VENDA_FIADA.parcelas[0], { status: 'paid', covered: '94.85' }), VENDA_FIADA.parcelas[1]],
  }));
  const r1 = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
  expect(r1.status).toBe(409);
  expect(r1.body.code).toBe('CREDIT_HAS_PAYMENT');
  const r2 = await patch({ customer_id: null });
  expect(r2.status).toBe(409);
  expect(mockCancel).not.toHaveBeenCalled();
  const r3 = await patch({ seller_id: BIA });
  expect(r3.status).toBe(200);
});

describe('9. NFC-e autorizada', () => {
  const nfce = { id: 'n1', numero: 2318, authorized_at: new Date(Date.now() - 5 * 60000).toISOString() };
  test('crediário recusado', async () => {
    montar({ nfce, customer_id: CLI, customer_name: 'Cliente Exemplo' });
    const res = await patch({ payments: [{ method: 'crediario', amount: 189.70 }], installments: 3 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NFCE_AUTHORIZED_NO_CREDIARIO');
    expect(mockCreate).not.toHaveBeenCalled();
  });
  test('outra forma passa, com aviso e o atalho de cancelar a nota', async () => {
    montar({ nfce });
    const res = await patch({ payments: [{ method: 'cartao', amount: 189.70 }], dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.plan.warnings.map((w) => w.code)).toContain('NFCE_KEEPS_ORIGINAL');
    expect(res.body.plan.nfce.can_cancel).toBe(true);
  });
});

test('10. soma das formas diferente do total = 422', async () => {
  const res = await patch({ payments: [{ method: 'dinheiro', amount: 100 }, { method: 'pix', amount: 80 }] });
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('PAYMENTS_SUM_MISMATCH');
  expect(escritas()).toHaveLength(0);
});

test('10b. forma desconhecida = 400', async () => {
  const res = await patch({ payments: [{ method: 'cheque', amount: 189.70 }] });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('INVALID_METHOD');
});

test('11. sem a tabela de registro (migration 431) = 503, nada grava', async () => {
  registroExiste = false;
  const res = await patch({ seller_id: BIA });
  expect(res.status).toBe(503);
  expect(res.body.code).toBe('EDIT_LOG_UNAVAILABLE');
  expect(escritas()).toHaveLength(0);
});

test('11b. a edição grava o registro com antes, depois, quem e motivo', async () => {
  const res = await patch({ seller_id: BIA, reason: 'Vendeu a Bia' });
  expect(res.status).toBe(200);
  const call = client.query.mock.calls.find(([s]) => /INSERT INTO sale_edits/.test(String(s)));
  const [companyId, saleId, quem, nome, changes, antes, depois, , motivo] = call[1];
  expect([companyId, saleId, quem, nome]).toEqual([CID, SALE, USER, 'Caio']);
  expect(changes).toEqual(['seller']);
  expect(JSON.parse(antes).seller).toEqual({ id: ANA, name: 'Ana' });
  expect(JSON.parse(depois).seller).toEqual({ id: BIA, name: 'Bia' });
  expect(motivo).toBe('Vendeu a Bia');
  expect(res.body.result.edit.edited_by_name).toBe('Caio');
  expect(houve(/^COMMIT/)).toBe(true);
});

describe('12. crediário', () => {
  test('entrar exige cliente', async () => {
    const res = await patch({ payments: [{ method: 'crediario', amount: 189.70 }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CREDIARIO_REQUIRES_CUSTOMER');
  });

  test('entrar com cliente: carnê novo + createCreditSale com as parcelas', async () => {
    const res = await patch({
      customer_id: CLI,
      payments: [{ method: 'crediario', amount: 189.70 }], installments: 3, first_due_date: PRIMEIRA,
    });
    expect(res.status).toBe(200);
    expect(res.body.plan.credit.action).toBe('enter');
    expect(res.body.plan.requires_confirmation).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][1];
    expect(args).toMatchObject({ companyId: CID, customerId: CLI, saleId: SALE, amount: 189.7, installments: 3, firstDueDate: PRIMEIRA, enforceCreditBlock: true });
    expect(houve(/INSERT INTO credit_accounts/)).toBe(true);
    expect(houve(/DELETE FROM sale_payments/)).toBe(true);
    expect(houve(/DELETE FROM transactions WHERE id = \$1/)).toBe(true);
  });

  test('sair usa o cancelCreditSale antes de gravar a forma nova', async () => {
    montar(VENDA_FIADA);
    const res = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(res.status).toBe(200);
    expect(res.body.plan.credit.action).toBe('leave');
    expect(mockCancel).toHaveBeenCalledWith(client, { companyId: CID, saleId: SALE });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(houve(/INSERT INTO sale_payments/)).toBe(true);
  });

  test('trocar a cliente de uma venda fiada sem pagamento leva a dívida junto', async () => {
    montar(Object.assign({}, VENDA_FIADA, { customer_id: BIA, customer_name: 'Outra' }));
    const res = await patch({ customer_id: CLI });
    expect(res.status).toBe(200);
    expect(res.body.plan.credit.action).toBe('move');
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ customerId: CLI, amount: 189.7, installments: 2, firstDueDate: '2026-12-07' });
  });

  test('tirar a cliente de uma venda fiada sem sair do crediário = 422', async () => {
    montar(VENDA_FIADA);
    const res = await patch({ customer_id: null });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CREDIARIO_REQUIRES_CUSTOMER');
  });
});

describe('derivarPagamentos', () => {
  test('entrada + crediário: a entrada é lida até fechar total - principal', () => {
    const r = editarVenda.derivarPagamentos({
      total: 189.7,
      pagamentos: [
        { method: 'pix', amount: '50', created_at: '2026-11-07T18:00:00Z' },
        { method: 'dinheiro', amount: '70', created_at: '2026-12-07T18:00:00Z' }, // recebimento de parcela
      ],
      debitos: [{ id: 'd' }],
      recebiveis: [{ amount: '70', status: 'confirmed', key: 'pdv-credit-receivable-x' }, { amount: '69.70', status: 'pending', key: 'pdv-credit-receivable-x-rest-1' }],
      parcelas: [{ total: 2, due_date: '2026-12-07', status: 'paid', covered: '70' }],
    });
    expect(r.entrada).toEqual([{ method: 'pix', amount: 50 }]);
    expect(r.credito.amount).toBe(139.7);
    expect(r.credito.paid).toBe(true);
    expect(r.lista).toEqual([{ method: 'pix', amount: 50 }, { method: 'crediario', amount: 139.7, installments: 2 }]);
  });

  test('dividida sem crediário: todas as formas, agrupadas', () => {
    const r = editarVenda.derivarPagamentos({
      total: 100, pagamentos: [{ method: 'pix', amount: 40 }, { method: 'cartao', amount: 60 }], debitos: [], recebiveis: [], parcelas: [],
    });
    expect(r.lista).toEqual([{ method: 'pix', amount: 40 }, { method: 'cartao', amount: 60 }]);
    expect(r.credito).toBeNull();
  });

  test('brl', () => {
    expect(editarVenda.brl(1234.5)).toBe('R$ 1.234,50');
    expect(editarVenda.brl(0.1)).toBe('R$ 0,10');
  });

  test('prévia das parcelas: mesma conta do createCreditSale', () => {
    const p = editarVenda.previaDasParcelas({ amount: 189.7, installments: 3, firstDueDate: '2026-12-07', config: null });
    expect(p.map((x) => x.amount_due)).toEqual([63.23, 63.23, 63.24]);
    expect(p.map((x) => x.due_date)).toEqual(['2026-12-07', '2027-01-07', '2027-02-07']);
  });
});

// ── Revisão de 09/11/2026 (Aura-backend#972) ────────────────────────────────
describe('revisão: travas do crediário', () => {
  test('R1. renegociada (parcela cancelada da própria venda) trava forma e cliente', async () => {
    montar(Object.assign({}, VENDA_FIADA, { parcelas_canceladas: 2 }));
    const r1 = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('CREDIT_RENEGOTIATED');
    const r2 = await patch({ customer_id: null });
    expect(r2.body.code).toBe('CREDIT_RENEGOTIATED');
    expect(mockCancel).not.toHaveBeenCalled();
    const r3 = await patch({ seller_id: BIA });
    expect(r3.status).toBe(200);
  });

  test('R1b. unificada (parcela sem venda no carnê do débito) trava', async () => {
    montar(Object.assign({}, VENDA_FIADA, { parcelas_sem_venda: 3, customer_id: BIA }));
    const r = await patch({ customer_id: CLI });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CREDIT_RENEGOTIATED');
  });

  test('R3. recebimento só de encargos (sale_payment além da entrada) conta como pago', () => {
    const r = editarVenda.derivarPagamentos({
      total: 100,
      pagamentos: [{ id: 'a', method: 'pix', amount: 30 }, { id: 'b', method: 'dinheiro', amount: 5 }],
      debitos: [{ id: 'd' }],
      recebiveis: [{ amount: 70, status: 'pending', key: 'pdv-credit-receivable-x' }],
      parcelas: [{ total: 1, due_date: '2026-12-01', status: 'pending', covered: 0 }],
    });
    expect(r.credito.paid).toBe(true);
    expect(r.entrada_ids).toEqual(['a']);
  });

  test('R3b. pagamento que entra entre a leitura e a gravação: 409 e nada é cancelado', async () => {
    montar(VENDA_FIADA);
    const original = client.query.getMockImplementation();
    client.query.mockImplementation((sql, params) => {
      if (/FROM credit_installments[\s\S]*FOR UPDATE/.test(String(sql))) {
        return Promise.resolve({ rows: [{ id: 'i1', status: 'paid', covered_amount: '94.85' }] });
      }
      return original(sql, params);
    });
    const res = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDIT_HAS_PAYMENT');
    expect(mockCancel).not.toHaveBeenCalled();
    expect(houve(/^COMMIT/)).toBe(false);
  });

  test('R3c. regrava só as linhas da entrada (recebimento fica)', async () => {
    montar({
      pagamentos: [
        { id: 'sp1', method: 'dinheiro', amount: '100', sessao_id: null, created_at: '2026-11-07T18:42:00Z' },
        { id: 'sp2', method: 'pix', amount: '89.70', sessao_id: null, created_at: '2026-11-07T18:42:00Z' },
      ],
    });
    const res = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
    expect(res.status).toBe(200);
    const del = client.query.mock.calls.find(([s]) => /DELETE FROM sale_payments/.test(String(s)));
    expect(del[0]).toMatch(/id = ANY\(\$1::uuid\[\]\)/);
    expect(del[1][0]).toEqual(['sp1', 'sp2']);
  });
});

describe('revisão: datas, termos, nota, taxa e registro', () => {
  test('R5. 1ª parcela: data que não existe = 400; no passado = 422', async () => {
    montar({ customer_id: CLI, customer_name: 'Cliente Exemplo' });
    const r1 = await patch({ payments: [{ method: 'crediario', amount: 189.70 }], installments: 2, first_due_date: '2026-02-31' });
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('INVALID_FIRST_DUE_DATE');
    const r2 = await patch({ payments: [{ method: 'crediario', amount: 189.70 }], installments: 2, first_due_date: '2020-01-10' });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('FIRST_DUE_DATE_PAST');
  });

  test('R5b. venda antiga sem data escolhida: a 1ª parcela nasce daqui a um mês, nunca no passado', async () => {
    montar({ customer_id: CLI, customer_name: 'Cliente Exemplo', dia: '2026-01-10' });
    const res = await patch({ payments: [{ method: 'crediario', amount: 189.70 }], installments: 2, dry_run: true });
    expect(res.status).toBe(200);
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    expect(res.body.plan.credit.to.first_due_date > hoje).toBe(true);
  });

  test('R4. troca de cliente: termos da venda no carnê e no cronograma; pede confirmação', async () => {
    montar(Object.assign({}, VENDA_FIADA, {
      customer_id: BIA, customer_name: 'Outra',
      credit_plan_snapshot: { installments: 2, interest_rate: 0.05, period_unit: 'week', period_count: 2 },
    }));
    const res = await patch({ customer_id: CLI });
    expect(res.status).toBe(200);
    expect(res.body.plan.credit.action).toBe('move');
    expect(res.body.plan.requires_confirmation).toBe(true);
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ interestRate: 0.05, periodUnit: 'week', periodCount: 2 });
    const upd = client.query.mock.calls.find(([s]) => /UPDATE credit_accounts SET terms_snapshot/.test(String(s)));
    expect(JSON.parse(upd[1][2])).toEqual({ interest_rate: 0.05, period_unit: 'week', period_count: 2 });
  });

  test('R6. débito e A Receber criados na edição levam o instante da venda', async () => {
    const res = await patch({ customer_id: CLI, payments: [{ method: 'crediario', amount: 189.70 }] });
    expect(res.status).toBe(200);
    const deb = client.query.mock.calls.find(([s]) => /UPDATE customer_credit_transactions SET created_at/.test(String(s)));
    expect(new Date(deb[1][2]).toISOString()).toBe('2026-11-07T18:42:00.000Z');
    expect(houve(/UPDATE transactions SET created_at = \$3/)).toBe(true);
  });

  test('R7. NF-e 55 autorizada: mesma trava do crediário e mesmo aviso', async () => {
    const nfce = { id: 'n1', numero: 77, authorized_at: new Date().toISOString(), tipo: 'nfe' };
    montar({ nfce, customer_id: CLI, customer_name: 'Cliente Exemplo' });
    const r1 = await patch({ payments: [{ method: 'crediario', amount: 189.70 }] });
    expect(r1.status).toBe(422);
    expect(r1.body.error).toContain('NF-e 77');
    const r2 = await patch({ payments: [{ method: 'pix', amount: 189.70 }], dry_run: true });
    expect(r2.body.plan.warnings.find((w) => w.code === 'NFCE_KEEPS_ORIGINAL').text).toContain('NF-e 77');
  });

  test('R8. antes de apagar a taxa, solta a conciliação bancária', async () => {
    montar({ pagamentos: [{ id: 'sp1', method: 'cartao', amount: '189.70', sessao_id: null, created_at: '2026-11-07T18:42:00Z' }], taxa: '5.69' });
    const res = await patch({ payments: [{ method: 'dinheiro', amount: 189.70 }] });
    expect(res.status).toBe(200);
    const calls = client.query.mock.calls.map(([s]) => String(s));
    const solta = calls.findIndex((s) => /UPDATE bank_statement_entries\s+SET matched_transaction_id = NULL, match_status = 'pendente', matched_at = NULL/.test(s));
    const apaga = calls.findIndex((s) => /DELETE FROM transactions WHERE id = \$1/.test(s));
    expect(solta).toBeGreaterThan(-1);
    expect(apaga).toBeGreaterThan(solta);
  });

  test('R9. falha passageira na sondagem do registro não fica em cache', async () => {
    let falhou = false;
    const base = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      if (/to_regclass\('public.sale_edits'\)/.test(String(sql)) && !falhou) {
        falhou = true;
        return Promise.reject(Object.assign(new Error('conexão caiu'), { code: 'ECONNRESET' }));
      }
      return base(sql, params);
    });
    const r1 = await patch({ seller_id: BIA });
    expect(r1.status).toBe(503);
    const r2 = await patch({ seller_id: BIA });
    expect(r2.status).toBe(200);
  });
});

test('R11. Pix com taxa (card_fee_pix_pct): Pix -> dinheiro tira a taxa do Pix', async () => {
  montar({
    pagamentos: [{ id: 'sp1', method: 'pix', amount: '189.70', sessao_id: null, created_at: '2026-11-07T18:42:00Z' }],
    taxa: '1.88', pdv_settings: { card_fee_enabled: true, card_fee_pix_pct: 0.99 },
  });
  const prev = await patch({ payments: [{ method: 'dinheiro', amount: 189.70 }], dry_run: true });
  expect(prev.body.plan.effects.find((e) => e.code === 'CARD_FEE_CHANGES').text).toBe('A taxa da maquininha (R$ 1,88) sai do Financeiro.');
  const res = await patch({ payments: [{ method: 'dinheiro', amount: 189.70 }] });
  expect(res.status).toBe(200);
  expect(houve(/DELETE FROM transactions WHERE id = \$1/)).toBe(true);
  expect(houve(/'Taxas de cartão'/)).toBe(false);
});

test('R11b. dinheiro -> Pix com taxa no Pix: a prévia mostra a taxa nova', async () => {
  montar({ pdv_settings: { card_fee_enabled: true, card_fee_pix_pct: 1 } });
  const prev = await patch({ payments: [{ method: 'pix', amount: 189.70 }], dry_run: true });
  expect(prev.body.plan.effects.find((e) => e.code === 'CARD_FEE_CHANGES').text).toBe('A taxa da maquininha passa de R$ 0,00 para R$ 1,90.');
});

// ── Segunda revisão (09/11/2026) ─────────────────────────────────────────────
test('T1. venda 1x sem snapshot refeita em 3x: juros da loja (sem interestRate explícito), na prévia também', async () => {
  montar(Object.assign({}, VENDA_FIADA, { parcelas: [], credit_plan_snapshot: null }));
  const original = client.query.getMockImplementation();
  client.query.mockImplementation((sql, params) => {
    if (/SELECT \* FROM credit_plan_configs/.test(String(sql))) return Promise.resolve({ rows: [{ interest_rate: 0.1 }] });
    return original(sql, params);
  });
  const prev = await patch({ payments: [{ method: 'crediario', amount: 189.70 }], installments: 3, first_due_date: PRIMEIRA, dry_run: true });
  expect(prev.status).toBe(200);
  expect(prev.body.plan.credit.action).toBe('recreate');
  expect(prev.body.plan.credit.to.terms).toBeNull();
  const soma = prev.body.plan.credit.to.schedule.reduce((a, p) => a + p.amount_due, 0);
  expect(soma).toBeCloseTo(208.67, 2); // 189,70 + 10% da loja
  const res = await patch({ payments: [{ method: 'crediario', amount: 189.70 }], installments: 3, first_due_date: PRIMEIRA });
  expect(res.status).toBe(200);
  const args = mockCreate.mock.calls[0][1];
  expect('interestRate' in args).toBe(false);
  expect(houve(/UPDATE credit_accounts SET terms_snapshot/)).toBe(false);
});

test('T2. renegociação gravada entre a leitura e a trava: 409 e nada é cancelado', async () => {
  montar(VENDA_FIADA);
  const original = client.query.getMockImplementation();
  client.query.mockImplementation((sql, params) => {
    if (/WITH deb AS/.test(String(sql))) return Promise.resolve({ rows: [{ canceladas: 0, sem_venda: 2, tem_debito: true }] });
    return original(sql, params);
  });
  const res = await patch({ payments: [{ method: 'pix', amount: 189.70 }] });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('CREDIT_RENEGOTIATED');
  expect(mockCancel).not.toHaveBeenCalled();
  expect(houve(/^COMMIT/)).toBe(false);
});
