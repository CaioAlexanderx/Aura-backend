// ============================================================
// Cupom da troca com o crédito lançado na ficha (INC-2026-11-19-01)
// (GET /print/receipt/:saleId, /preview e /a4 — src/routes/print.js)
//
// Defeito: a troca só de crédito (sem item novo) imprimia o cupom comum da
// venda de troca, com total R$ 0,00 e nada do crédito gerado.
//
// O que estes testes travam:
//   1. Venda de troca com crédito na ficha: depois dos totais, as linhas
//      aprovadas pelo Caio, exatas:
//        Crédito da troca: R$ 54,90
//        Saldo para usar: R$ 54,90
//   2. Venda comum e troca SEM crédito: HTML IDÊNTICO, byte a byte, ao que a
//      main gerava antes desta mudança (fixtures em
//      __tests__/fixtures/cupomTrocaValorPago/, geradas a partir da main
//      3f9ef283 com GERAR_FIXTURES_CUPOM_TROCA=1). Nunca regenere para
//      "fazer passar": se quebrar, o cupom impresso pelos clientes mudou.
//   3. Venda comum não consulta o razão de crédito (nenhuma ida a mais).
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
const VENDA = '5b1d3f0a-0000-4000-8000-000000000042';
const TROCA = '6b340b17-0000-4000-8000-000000000077';
const CLIENTE = 'cc000000-0000-4000-8000-000000000001';

const printRouter = require('../src/routes/print');
const app = express();
app.use(express.json());
app.use('/companies/:id/print', printRouter);

const FIXTURES = path.join(__dirname, 'fixtures', 'cupomTrocaValorPago');

const EMPRESA = {
  legal_name: 'Loja Exemplo LTDA', trade_name: 'Loja Exemplo',
  cnpj: '12.345.678/0001-90', phone: '(11) 90000-0000',
  address_street: 'Rua das Flores', address_number: '10',
  address_city: 'São Paulo', address_state: 'SP',
};

// Venda comum com desconto na venda (o caso real: 79,90 - 25,00 = 54,90).
const VENDA_ROW = {
  id: VENDA, sale_number: 2001, type: 'sale', total_amount: '54.90', discount_amount: '25.00',
  payment_method: 'pix', created_at: '2026-11-10T15:30:00.000Z', customer_id: CLIENTE,
  seller_name: 'Ana', customer_name: 'Maria', cash_tendered: null, pix_payload: null, notes: null,
};
const VENDA_ITENS = [
  { product_name: 'BLUSA POLO FEMININA', quantity: 1, unit_price: 79.9, total_price: 79.9, discount: 0, variant_label: null },
];

// Troca só de crédito: devolveu a blusa, nenhum item novo, total 0.
const TROCA_SO_CREDITO = {
  id: TROCA, sale_number: 2002, type: 'troca', total_amount: '0.00', discount_amount: '0.00',
  payment_method: 'crediario_credito', created_at: '2026-11-19T15:30:00.000Z', customer_id: CLIENTE,
  seller_name: 'Ana', customer_name: 'Maria', cash_tendered: null, pix_payload: null,
  notes: 'Troca v2 — 1 venda(s) original(is)',
};

// Troca com item novo, diferença paga em dinheiro (sem crédito na ficha).
const TROCA_COM_ITEM = {
  ...TROCA_SO_CREDITO, sale_number: 2003, total_amount: '99.90', payment_method: 'dinheiro', cash_tendered: null,
};
const TROCA_ITENS = [
  { product_name: 'VESTIDO MIDI', quantity: 1, unit_price: 99.9, total_price: 99.9, discount: 0, variant_label: 'M' },
];

function despachar({ venda, itens = [], payments = [], creditoDaTroca = [], saldo = null }) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM companies WHERE id/i.test(s)) return Promise.resolve({ rows: [{ ...EMPRESA }] });
    if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [{ ...venda }] });
    if (/FROM sale_items/i.test(s)) return Promise.resolve({ rows: itens.map(i => ({ ...i })) });
    if (/FROM sale_payments/i.test(s)) return Promise.resolve({ rows: payments });
    // Crédito usado na venda (creditoDaCliente.usadoNaVenda): nada usado.
    if (/FROM customer_credit_transactions/i.test(s) && /type = 'debit'/i.test(s) && /sale_id = \$1/i.test(s)) {
      return Promise.resolve({ rows: [{ total: '0' }] });
    }
    // Crédito lançado na ficha por esta troca.
    if (/FROM customer_credit_transactions/i.test(s) && /type = 'payment'/i.test(s) && /sale_id = \$1/i.test(s)) {
      return Promise.resolve({ rows: creditoDaTroca });
    }
    if (/FROM customer_credit_transactions/i.test(s) && /customer_id\s*=\s*\$2/i.test(s)) {
      return Promise.resolve({ rows: saldo ? [saldo] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const ROTAS = { 'receipt-80mm': '', 'preview-80mm-autoprint': '/preview', a4: '/a4' };
const CASOS = {
  'venda-comum': { venda: VENDA_ROW, itens: VENDA_ITENS, sale: VENDA },
  'troca-sem-credito': {
    venda: TROCA_COM_ITEM, itens: TROCA_ITENS, sale: TROCA,
    payments: [{ method: 'dinheiro', amount: '-54.90' }, { method: 'dinheiro', amount: '45.00' }],
  },
};

const get = async (saleId, sufixo = '') => (
  await request(app).get(`/companies/${LOJA}/print/receipt/${saleId}${sufixo}`)
).text;

beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); });

if (process.env.GERAR_FIXTURES_CUPOM_TROCA) {
  test('gera fixtures (modo GERAR_FIXTURES_CUPOM_TROCA)', async () => {
    fs.mkdirSync(FIXTURES, { recursive: true });
    for (const [caso, c] of Object.entries(CASOS)) {
      for (const [nome, sufixo] of Object.entries(ROTAS)) {
        despachar(c);
        fs.writeFileSync(path.join(FIXTURES, `${caso}.${nome}.html`), await get(c.sale, sufixo));
      }
    }
  });
} else {
  describe('cupom sem crédito da troca: HTML idêntico ao da main', () => {
    for (const [caso, c] of Object.entries(CASOS)) {
      for (const [nome, sufixo] of Object.entries(ROTAS)) {
        test(`${caso} -> ${nome}`, async () => {
          despachar(c);
          const esperado = fs.readFileSync(path.join(FIXTURES, `${caso}.${nome}.html`), 'utf8');
          expect(await get(c.sale, sufixo)).toBe(esperado);
        });
      }
    }

    test('venda comum não consulta o razão de crédito', async () => {
      despachar(CASOS['venda-comum']);
      await get(VENDA);
      const sqls = db.query.mock.calls.map(([q]) => String(q));
      expect(sqls.some((q) => /customer_credit_transactions/i.test(q))).toBe(false);
    });

    test('troca cuja consulta do crédito falha: sai o cupom de sempre', async () => {
      const c = CASOS['troca-sem-credito'];
      despachar(c);
      const base = db.query.getMockImplementation();
      db.query.mockImplementation((sql, params) => (
        /customer_credit_transactions/i.test(String(sql)) && /type = 'payment'/i.test(String(sql))
          ? Promise.reject(new Error('boom')) : base(sql, params)
      ));
      const esperado = fs.readFileSync(path.join(FIXTURES, 'troca-sem-credito.receipt-80mm.html'), 'utf8');
      expect(await get(TROCA)).toBe(esperado);
    });
  });

  describe('troca com crédito na ficha', () => {
    const credito = {
      venda: TROCA_SO_CREDITO, itens: [], sale: TROCA,
      payments: [{ method: 'crediario', amount: '-54.90' }],
      creditoDaTroca: [{ company_id: LOJA, customer_id: CLIENTE, amount: '54.90' }],
      // saldoPorOrigem: ficha com -54,90 (a favor), 54,90 de troca, nada usado.
      saldo: { balance: '-54.90', troca: '54.90', devolucao: '0', usado_devolucao: '0', usado_troca: '0' },
    };

    test('80 mm: as duas linhas aprovadas, exatas, depois dos totais', async () => {
      despachar(credito);
      const html = await get(TROCA);
      expect(html).toContain('Crédito da troca: R$ 54,90');
      expect(html).toContain('Saldo para usar: R$ 54,90');
      const total = html.indexOf('>TOTAL<');
      expect(total).toBeGreaterThan(-1);
      expect(html.indexOf('Crédito da troca:')).toBeGreaterThan(total);
      expect(html.indexOf('Saldo para usar:')).toBeGreaterThan(html.indexOf('Crédito da troca:'));
      expect(html.indexOf('Crédito da troca:')).toBeLessThan(html.indexOf('Obrigado pela preferencia'));
    });

    test('saldo é o da loja onde o crédito ficou (company_id do lançamento) e da cliente', async () => {
      despachar(credito);
      await get(TROCA);
      const call = db.query.mock.calls.find(([q]) => /customer_credit_transactions/i.test(String(q)) && /customer_id\s*=\s*\$2/i.test(String(q)));
      expect(call[1].slice(0, 2)).toEqual([LOJA, CLIENTE]);
    });

    test('saldo maior que o crédito (crédito antigo na ficha): mostra o saldo inteiro', async () => {
      despachar({
        ...credito,
        saldo: { balance: '-80.00', troca: '80.00', devolucao: '0', usado_devolucao: '0', usado_troca: '0' },
      });
      const html = await get(TROCA);
      expect(html).toContain('Crédito da troca: R$ 54,90');
      expect(html).toContain('Saldo para usar: R$ 80,00');
    });

    test('A4 e preview também levam as linhas', async () => {
      despachar(credito);
      expect(await get(TROCA, '/a4')).toContain('Crédito da troca: R$ 54,90');
      despachar(credito);
      expect(await get(TROCA, '/preview')).toContain('Saldo para usar: R$ 54,90');
    });

    test('fora as duas linhas, o cupom é o mesmo da troca sem crédito', async () => {
      despachar(credito);
      const com = await get(TROCA);
      despachar({ ...credito, creditoDaTroca: [] });
      const sem = await get(TROCA);
      expect(com).not.toBe(sem);
      const semBloco = com.replace(/\n {2}<div class="divider"><\/div>\n {2}<div class="bold">Crédito da troca:[^\n]*<\/div>\n {2}<div>Saldo para usar:[^\n]*<\/div>/, '');
      expect(semBloco).toBe(sem);
    });
  });
}
