// ============================================================
// Nome da loja nos papeis impressos — uma fonte so (21/11/2026)
//
// Regra (src/utils/nomeDaLoja.js): nome da loja = nome fantasia
// (trade_name) quando preenchido, senao a razao social (legal_name).
//
// O que este teste trava: para TODA loja cujo nome fantasia ja aparecia
// (igual a razao social, diferente dela, ou sem nome fantasia), o HTML do
// cupom (80 mm, preview e A4; venda comum e troca), do papel de entrega,
// do carne (termica e A4) e do recibo do crediario e IDENTICO, byte a byte,
// ao que a main (813825a9) gerava. As fixtures de
// __tests__/fixtures/nomeDaLoja/ sao a saida da main; nunca as regenere
// para "fazer o teste passar" — se quebrar, o papel de quem nao mudou
// nada mudou, e isso e o bug.
//
// Unicas lojas que mudam: nome fantasia gravado em branco ("" ou so
// espacos). Antes o cupom imprimia o branco (so espacos) e o carne/recibo
// imprimiam vazio (COALESCE do SQL nao pula ""); agora os dois imprimem a
// razao social. Esses casos tem teste proprio abaixo.
//
// Para regenerar as fixtures a partir de uma main SEM esta mudanca:
// GERAR_FIXTURES_NOME_DA_LOJA=1 npx jest nomeDaLoja.impressos
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const LOJA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const VENDA = '5b1d3f0a-0000-4000-8000-000000002101';
const TROCA = '5b1d3f0a-0000-4000-8000-000000002102';
const CLIENTE = '8fbde0b9-2ec0-4bc9-be58-f86c31465fa6';
const PAGAMENTO = 'e0000000-0000-4000-8000-000000002103';

const printRouter = require('../src/routes/print');
const app = express();
app.use(express.json());
app.use('/companies/:id/print', printRouter);

const FIXTURES = path.join(__dirname, 'fixtures', 'nomeDaLoja');

const BASE_EMPRESA = {
  cnpj: '12345678000190', phone: '(11) 90000-0000', logo_url: null, address: null,
  address_street: 'Rua das Flores', address_number: '10', address_district: 'Centro',
  address_city: 'São Paulo', address_state: 'SP',
};

// Lojas que NAO mudam (o nome que ja saia continua saindo).
const LOJAS_IGUAIS = {
  'fantasia-igual-razao': { trade_name: 'Doce Encanto', legal_name: 'Doce Encanto' },
  'fantasia-diferente': { trade_name: 'Layali Perfumaria Árabe', legal_name: 'MARIA DA SILVA 12345678900' },
  'sem-fantasia': { trade_name: null, legal_name: 'Ana Modas LTDA' },
};
// Lojas que mudam: nome fantasia gravado em branco.
const LOJAS_EM_BRANCO = {
  'fantasia-vazia': { trade_name: '', legal_name: 'Ana Modas LTDA' },
  'fantasia-so-espacos': { trade_name: '   ', legal_name: 'Ana Modas LTDA' },
};

// O que o banco devolve para a loja: as colunas + o display_name que o
// SQL `COALESCE(trade_name, legal_name)` calculava (carne e recibo).
const linhaDaEmpresa = (loja) => ({
  ...BASE_EMPRESA, ...loja,
  display_name: loja.trade_name !== null && loja.trade_name !== undefined ? loja.trade_name : loja.legal_name,
});

const VENDA_ROW = {
  id: VENDA, sale_number: 2101, type: 'sale', total_amount: '174.50', discount_amount: '10.00',
  payment_method: 'dinheiro', created_at: '2026-11-20T15:30:00.000Z', customer_id: CLIENTE,
  seller_name: 'Ana', customer_name: 'Carlos', cash_tendered: '200.00', pix_payload: null, notes: null,
  delivery_address: {
    name: 'Carlos', phone: '11988881234', zip_code: '01310100', street: 'Av. Paulista', number: '1000',
    complement: null, neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP', address_reference: null, note: null,
  },
};
const VENDA_ITENS = [
  { product_id: 'p1', product_name: 'Perfume 100ml', quantity: 1, unit_price: 169.5, total_price: 159.5, discount: 10, variant_label: null },
  { product_id: 'p2', product_name: 'Sacola', quantity: 1, unit_price: 15, total_price: 15, discount: 0, variant_label: null },
];
const TROCA_ROW = {
  ...VENDA_ROW, id: TROCA, sale_number: 2102, type: 'troca', total_amount: '99.90', discount_amount: '0.00',
  cash_tendered: null, notes: 'Troca v2 — 1 venda(s) original(is)', delivery_address: null,
};
const TROCA_ITENS = [
  { product_id: 'p3', product_name: 'Vestido midi', quantity: 1, unit_price: 99.9, total_price: 99.9, discount: 0, variant_label: 'M' },
];

const PARCELAS = [
  {
    id: 'a0000000-0000-4000-8000-000000000001', installment_number: 1, total_installments: 2,
    amount_due: '100.00', covered_amount: '100.00', due_date: new Date('2026-10-10T00:00:00Z'), due_date_br: '10/10/2026',
    status: 'paid', past_due: false, paid_at: '2026-10-08T14:00:00Z', account_id: null,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000002', installment_number: 2, total_installments: 2,
    amount_due: '100.00', covered_amount: '0.00', due_date: new Date('2026-12-10T00:00:00Z'), due_date_br: '10/12/2026',
    status: 'pending', past_due: false, paid_at: null, account_id: null,
  },
];

function despachar(loja, { venda = VENDA_ROW, itens = VENDA_ITENS, payments = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM companies WHERE id/i.test(s)) return Promise.resolve({ rows: [linhaDaEmpresa(loja)] });
    if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [{ ...venda }] });
    if (/FROM sale_items/i.test(s)) return Promise.resolve({ rows: itens.map(i => ({ ...i, sale_id: 'sale-a' })) });
    if (/FROM sale_payments/i.test(s)) return Promise.resolve({ rows: payments });
    if (/FROM customers WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ id: CLIENTE, name: 'Carlos', phone: '11988881234', cpf_cnpj: null }] });
    }
    if (/FROM customer_credit_balances/i.test(s)) return Promise.resolve({ rows: [{ balance: '100.00' }] });
    if (/FROM credit_installments/i.test(s) && !/credit_payment_allocations/i.test(s)) {
      return Promise.resolve({ rows: PARCELAS.map(p => ({ ...p })) });
    }
    if (/FROM credit_payment_allocations/i.test(s)) {
      return Promise.resolve({ rows: [{ installment_number: 1, total_installments: 2, due_date_br: '10/10/2026', principal_paid: '100.00', charges_paid: '0', status_after: 'paid' }] });
    }
    if (/FROM customer_credit_transactions/i.test(s) && /type = 'payment'/i.test(s) && /WHERE id = \$1/i.test(s)) {
      return Promise.resolve({ rows: [{ id: PAGAMENTO, customer_id: CLIENTE, amount: '100.00', payment_method: 'pix', created_at: '2026-10-08T14:00:00.000Z', account_id: null }] });
    }
    if (/FROM customer_credit_transactions/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'd-a', sale_id: 'sale-a', account_id: null, amount: '200.00', notes: null, created_at: '2026-09-13T15:00:00Z' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const base = `/companies/${LOJA}/print`;
const PAPEIS = {
  'venda.receipt-80mm': { url: `/receipt/${VENDA}` },
  'venda.preview-80mm': { url: `/receipt/${VENDA}/preview` },
  'venda.a4': { url: `/receipt/${VENDA}/a4` },
  'troca.receipt-80mm': { url: `/receipt/${TROCA}`, venda: TROCA_ROW, itens: TROCA_ITENS, payments: [{ method: 'dinheiro', amount: '-54.90' }, { method: 'dinheiro', amount: '45.00' }] },
  'troca.preview-80mm': { url: `/receipt/${TROCA}/preview`, venda: TROCA_ROW, itens: TROCA_ITENS, payments: [{ method: 'dinheiro', amount: '-54.90' }, { method: 'dinheiro', amount: '45.00' }] },
  'troca.a4': { url: `/receipt/${TROCA}/a4`, venda: TROCA_ROW, itens: TROCA_ITENS, payments: [{ method: 'dinheiro', amount: '-54.90' }, { method: 'dinheiro', amount: '45.00' }] },
  'entrega.80': { url: `/delivery/${VENDA}?format=80`, payments: [{ method: 'dinheiro', amount: '174.50' }] },
  'entrega.a4': { url: `/delivery/${VENDA}?format=a4`, payments: [{ method: 'dinheiro', amount: '174.50' }] },
  'carne.termica': { url: `/credit/${CLIENTE}/carne` },
  'carne.a4': { url: `/credit/${CLIENTE}/carne?format=a4` },
  'recibo-crediario': { url: `/credit/receipts/${PAGAMENTO}` },
};

async function gerar(loja, papel) {
  const p = PAPEIS[papel];
  despachar(loja, p);
  const res = await request(app).get(base + p.url);
  return res.text;
}

const arquivo = (nomeLoja, papel) => path.join(FIXTURES, `${nomeLoja}.${papel}.html`);

// "Emitido em" do carne usa a hora de agora: congela so o relogio.
beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-21T15:00:00.000Z'),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); });

if (process.env.GERAR_FIXTURES_NOME_DA_LOJA) {
  test('gera fixtures (modo GERAR_FIXTURES_NOME_DA_LOJA)', async () => {
    fs.mkdirSync(FIXTURES, { recursive: true });
    for (const [nomeLoja, loja] of Object.entries({ ...LOJAS_IGUAIS, ...LOJAS_EM_BRANCO })) {
      for (const papel of Object.keys(PAPEIS)) {
        fs.writeFileSync(arquivo(nomeLoja, papel), await gerar(loja, papel));
      }
    }
  });
} else {
  describe('loja que nao mudou nada: papel identico ao da main, byte a byte', () => {
    for (const [nomeLoja, loja] of Object.entries(LOJAS_IGUAIS)) {
      for (const papel of Object.keys(PAPEIS)) {
        test(`${nomeLoja} -> ${papel}`, async () => {
          const esperado = fs.readFileSync(arquivo(nomeLoja, papel), 'utf8');
          const html = await gerar(loja, papel);
          expect(html.startsWith('<')).toBe(true); // HTML de verdade, nao erro JSON
          expect(html).toBe(esperado);
        });
      }
    }
  });

  describe('nome fantasia em branco: sai a razao social (antes saia vazio ou espacos)', () => {
    for (const [nomeLoja, loja] of Object.entries(LOJAS_EM_BRANCO)) {
      for (const papel of Object.keys(PAPEIS)) {
        test(`${nomeLoja} -> ${papel}`, async () => {
          const html = await gerar(loja, papel);
          expect(html).toContain('Ana Modas LTDA');
        });
      }
    }

    test('fora o nome, o cupom e o mesmo: so a linha do nome muda', async () => {
      const antes = fs.readFileSync(arquivo('fantasia-so-espacos', 'venda.receipt-80mm'), 'utf8');
      const depois = await gerar(LOJAS_EM_BRANCO['fantasia-so-espacos'], 'venda.receipt-80mm');
      expect(depois.split('Ana Modas LTDA').join('   ')).toBe(antes);
    });
  });
}
