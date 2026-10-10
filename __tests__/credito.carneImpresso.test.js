// ============================================================
// Crediário — carnê impresso: GET /print/credit/:cid/carne (10/10/2026)
//
// O que estes testes travam na ROTA (o desenho do A4 e a seleção de compras
// têm testes próprios em tests/unit/):
//   1. sem parâmetro sai a térmica de sempre, agora com "O que foi comprado",
//      "Parcelas pagas" e "Parcelas a pagar"; parcela cancelada fora;
//   2. ?format=a4 despacha para o builder A4 com a marca da loja;
//   3. ?account=<uuid> imprime UM carnê: só as parcelas e compras dele, e o
//      saldo / Pix "de uma vez" passam a ser do carnê, não do cliente;
//   4. ?account=none imprime só o grupo "Sem carnê";
//   5. UUID inválido ou carnê que não é deste cliente/empresa -> 404;
//   6. toda consulta de dívida filtra pela empresa da URL;
//   7. sem a tabela do razão (42P01) o carnê sai, só sem a lista de compras.
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
const CARNE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CARNE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ALHEIO  = 'cccccccc-3333-4333-8333-cccccccccccc'; // carnê de outro cliente

const printRouter = require('../src/routes/print');
const app = express();
app.use(express.json());
app.use('/companies/:id/print', printRouter);

const inst = (id, n, total, extra = {}) => ({
  id, installment_number: n, total_installments: total,
  amount_due: '100.00', covered_amount: '0.00',
  due_date: new Date('2026-12-10T00:00:00Z'), due_date_br: '10/12/2026',
  status: 'pending', past_due: false, paid_at: null, account_id: null, ...extra,
});

// Carnê A: 1 paga + 1 a pagar (100) + 1 cancelada. Carnê B: 1 a pagar (250).
// Sem carnê: 1 a pagar com abatimento (resta 40).
const PARCELAS = [
  inst('a0000000-0000-4000-8000-000000000001', 1, 2, { account_id: CARNE_A, status: 'paid', covered_amount: '100.00', paid_at: '2026-10-08T14:00:00Z', due_date_br: '10/10/2026' }),
  inst('a0000000-0000-4000-8000-000000000002', 2, 2, { account_id: CARNE_A, due_date_br: '10/11/2026' }),
  inst('a0000000-0000-4000-8000-000000000009', 3, 3, { account_id: CARNE_A, status: 'cancelled', amount_due: '7777.00' }),
  inst('b0000000-0000-4000-8000-000000000001', 1, 1, { account_id: CARNE_B, amount_due: '250.00', past_due: true }),
  inst('c0000000-0000-4000-8000-000000000001', 1, 1, { amount_due: '90.00', covered_amount: '50.00' }),
];

const DEBITOS = [
  { id: 'd-none', sale_id: null, account_id: null, amount: '90.00', notes: 'Saldo do caderno', created_at: '2026-09-01T15:00:00Z' },
  { id: 'd-b', sale_id: 'sale-b', account_id: CARNE_B, amount: '250.00', notes: null, created_at: '2026-09-14T15:00:00Z' },
  { id: 'd-a', sale_id: 'sale-a', account_id: CARNE_A, amount: '200.00', notes: null, created_at: '2026-09-13T15:00:00Z' },
];

const ITENS = [
  { sale_id: 'sale-a', product_name: 'Vans Hylane 40/41', quantity: '1', unit_price: '120.00', total_price: '120.00' },
  { sale_id: 'sale-a', product_name: 'Slide <b>Alta</b>', quantity: '2', unit_price: '40.00', total_price: '80.00' },
  { sale_id: 'sale-b', product_name: 'Bota Carne B', quantity: '1', unit_price: '250.00', total_price: '250.00' },
];

function despachar({ pix = true, semRazao = false, achaCliente = true } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM companies WHERE id = \$1/i.test(s)) {
      return Promise.resolve({ rows: [{
        display_name: 'MH Alimentos', trade_name: 'MH Alimentos', legal_name: 'MH LTDA',
        cnpj: '12345678000190', phone: '(91) 90000-0000', logo_url: null, address: null,
        address_street: 'Rua das Palmeiras', address_number: '120', address_district: 'Centro',
        address_city: 'Belém', address_state: 'PA',
      }] });
    }
    if (/FROM customers WHERE id/i.test(s)) {
      return Promise.resolve({ rows: achaCliente ? [{ id: CLIENTE, name: 'Alexander Olivier', phone: null, cpf_cnpj: null }] : [] });
    }
    if (/FROM customer_credit_balances/i.test(s)) return Promise.resolve({ rows: [{ balance: '390.00' }] });
    if (/FROM credit_installments/i.test(s)) return Promise.resolve({ rows: PARCELAS.map(p => ({ ...p })) });
    if (/FROM credit_accounts/i.test(s)) {
      return Promise.resolve({ rows: [
        { id: CARNE_A, name: 'Carnê de setembro', status: 'active' },
        { id: CARNE_B, name: 'Carnê da bota', status: 'active' },
      ] });
    }
    if (/FROM customer_credit_transactions/i.test(s)) {
      if (semRazao) return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
      return Promise.resolve({ rows: DEBITOS.map(d => ({ ...d })) });
    }
    if (/FROM sale_items/i.test(s)) return Promise.resolve({ rows: ITENS.map(i => ({ ...i })) });
    if (/pix_key/i.test(s)) {
      return Promise.resolve({ rows: pix ? [{
        pix_key: 'loja@exemplo.com.br', pix_key_type: 'EMAIL',
        pix_holder_name: 'MH ALIMENTOS', pix_holder_city: 'BELEM', site_name: null, address: null,
      }] : [] });
    }
    if (/FROM digital_channel_config/i.test(s)) {
      return Promise.resolve({ rows: [{ logo_url: 'https://r2.exemplo/logo-vitrine.png', primary_color: '#EF4444' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const carne = (qs = '') => request(app).get(`/companies/${LOJA}/print/credit/${CLIENTE}/carne${qs}`);
const corpo = (html) => html.slice(html.indexOf('<body>'));
const contar = (txt, re) => (txt.match(re) || []).length;
const sqls = () => db.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  despachar();
});

describe('carnê térmico (padrão)', () => {
  test('sem parâmetro: cupom de sempre, com compras e pagas separadas das a pagar', async () => {
    const res = await carne();
    expect(res.status).toBe(200);
    const html = res.text;
    // Continua o cupom: Consolas, size:auto, regra da bobina.
    expect(html).toContain('@page { margin: 10mm 12mm; size: auto; }');
    expect(html).toContain('@media print and (max-width: 120mm)');
    expect(html).toContain('CARNE / EXTRATO DE CREDIARIO');
    expect(html).not.toContain('class="slip');

    // Três grupos, cada um com os três blocos.
    expect(contar(html, /O que foi comprado/g)).toBe(3);
    expect(contar(html, />Parcelas pagas</g)).toBe(3);
    expect(contar(html, />Parcelas a pagar</g)).toBe(3);
    expect(html).toContain('Vans Hylane 40/41');
    expect(html).toContain('Saldo do caderno');
    expect(html).toContain('Nenhuma parcela paga.');

    // Pix por parcela A PAGAR (3) + o bloco "pagar tudo" (1).
    expect(contar(corpo(html), /<svg\b/g)).toBe(4);
    expect(html).toContain('Pagar tudo de uma vez via Pix — R$ 390.00');
    expect(html).toContain('SALDO TOTAL EM ABERTO: R$390.00');
  });

  test('?format=thermal é o mesmo documento', async () => {
    const [a, b] = await Promise.all([carne(), carne('?format=thermal')]);
    const semData = (t) => t.replace(/Emitido em: [^<]+/, '');
    expect(semData(b.text)).toBe(semData(a.text));
  });

  test('parcela cancelada não entra no cronograma, no saldo nem ganha Pix', async () => {
    const html = (await carne()).text;
    expect(html).not.toContain('7777.00');
    expect(html).not.toContain('3/3');
    // Carnê A: só a parcela 2/2 em aberto.
    expect(html).toContain('Saldo em aberto: <strong>R$100.00</strong>');
  });

  test('Pix da parcela com abatimento vale o principal restante', async () => {
    const html = (await carne()).text;
    expect(html).toContain('Pix da parcela 1/1 — R$40.00');
  });

  test('atraso vem da data (past_due), não do status persistido', async () => {
    const html = (await carne()).text;
    expect(contar(html, /<strong>Atrasada<\/strong>/g)).toBe(1);
  });

  test('nome de produto vindo do banco é escapado', async () => {
    const html = (await carne()).text;
    expect(html).not.toContain('<b>Alta</b>');
    expect(html).toContain('2x Slide &lt;b&gt;Alta&lt;/b&gt;');
  });

  test('sem chave Pix: nenhum QR, aviso de sempre', async () => {
    despachar({ pix: false });
    const html = (await carne()).text;
    expect(contar(corpo(html), /<svg\b/g)).toBe(0);
    expect(html).toContain('Nenhuma chave Pix configurada.');
    expect(html).toContain('Vans Hylane 40/41');
  });

  test('sem a tabela do razão (42P01): sai sem a lista de compras, sem warn', async () => {
    despachar({ semRazao: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await carne();
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('O que foi comprado');
    expect(contar(res.text, />Parcelas a pagar</g)).toBe(3);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('carnê A4 (?format=a4)', () => {
  test('folha A4 com a marca da loja e um cupom por parcela a pagar', async () => {
    const res = await carne('?format=a4');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const html = res.text;
    expect(html).toContain('@page{size:A4;margin:14mm}');
    expect(html).toContain('logo-vitrine.png');
    expect(html).toContain('#EF4444');
    expect(html).toContain('Rua das Palmeiras, 120 — Centro — Belém/PA');
    expect(contar(corpo(html), /<div class="slip/g)).toBe(3);
    expect(contar(corpo(html), /<svg\b/g)).toBe(3);
    // Vários carnês: título por grupo.
    expect(contar(corpo(html), /class="grp"/g)).toBe(3);
    // 100 + 100 + 250 + 90 = 540; falta 100 + 250 + 40 = 390.
    expect(html).toMatch(/Comprou<\/div><div class="n">R\$ 540,00</);
    expect(html).toMatch(/Já pagou<\/div><div class="n">R\$ 150,00</);
    expect(html).toMatch(/Falta pagar<\/div><div class="n">R\$ 390,00</);
    expect(html).not.toContain('7.777,00');
  });

  test('sem chave Pix: cupons sem QR e sem copia-e-cola', async () => {
    despachar({ pix: false });
    const html = (await carne('?format=A4')).text;
    expect(contar(corpo(html), /<div class="slip sem-pix/g)).toBe(3);
    expect(contar(corpo(html), /<svg\b/g)).toBe(0);
    expect(corpo(html)).not.toContain('Pix copia e cola');
  });

  test('?autoprint=0 abre sem disparar a impressão', async () => {
    expect((await carne('?format=a4')).text).toContain('<script>');
    expect((await carne('?format=a4&autoprint=0')).text).not.toContain('<script>');
  });
});

describe('um carnê só (?account=)', () => {
  test('térmica: só o carnê pedido, e saldo/Pix "de uma vez" são DELE', async () => {
    const res = await carne(`?account=${CARNE_A}`);
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html).toContain('Carnê de setembro');
    expect(html).not.toContain('Carnê da bota');
    expect(html).not.toContain('Sem carne');
    expect(html).toContain('Vans Hylane 40/41');
    expect(html).not.toContain('Bota Carne B');
    expect(html).not.toContain('Saldo do caderno');
    // Saldo do carnê (100), não o do cliente no razão (390).
    expect(html).toContain('SALDO DESTE CARNE: R$100.00');
    expect(html).toContain('Pagar este carne de uma vez via Pix — R$ 100.00');
    expect(html).not.toContain('390.00');
    // 1 parcela a pagar + 1 bloco do carnê.
    expect(contar(corpo(html), /<svg\b/g)).toBe(2);
  });

  test('A4: resumo do carnê e nome dele no cabeçalho', async () => {
    const html = (await carne(`?format=a4&account=${CARNE_A}`)).text;
    expect(html).toContain('<div class="cn">Carnê de setembro</div>');
    expect(html).not.toContain('class="grp"');
    expect(html).toMatch(/Comprou<\/div><div class="n">R\$ 200,00</);
    expect(html).toMatch(/Já pagou<\/div><div class="n">R\$ 100,00</);
    expect(html).toMatch(/Falta pagar<\/div><div class="n">R\$ 100,00</);
    expect(contar(corpo(html), /<div class="slip/g)).toBe(1);
    expect(html).not.toContain('Bota Carne B');
  });

  test('?account=none: só o grupo "Sem carnê"', async () => {
    const html = (await carne('?account=none')).text;
    expect(html).toContain('Sem carne');
    expect(html).not.toContain('Carnê de setembro');
    expect(html).toContain('Saldo do caderno');
    expect(html).not.toContain('Vans Hylane');
    expect(html).toContain('SALDO DESTE CARNE: R$40.00');

    const a4 = (await carne('?format=a4&account=NONE')).text;
    expect(a4).toMatch(/Falta pagar<\/div><div class="n">R\$ 40,00</);
    expect(a4).not.toContain('class="cn"');
  });

  test('UUID com caixa diferente ainda acha o carnê', async () => {
    const res = await carne(`?account=${CARNE_A.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Carnê de setembro');
  });

  test('UUID inválido -> 404', async () => {
    for (const ruim of ['abc', '123', `${CARNE_A}x`, "' OR 1=1 --"]) {
      const res = await carne(`?account=${encodeURIComponent(ruim)}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CREDIT_ACCOUNT_NOT_FOUND');
    }
  });

  test('carnê de outro cliente/empresa -> 404 (nos dois formatos)', async () => {
    expect((await carne(`?account=${ALHEIO}`)).status).toBe(404);
    const a4 = await carne(`?format=a4&account=${ALHEIO}`);
    expect(a4.status).toBe(404);
    expect(a4.body).toEqual({ error: 'Carne nao encontrado', code: 'CREDIT_ACCOUNT_NOT_FOUND' });
  });

  test('sem ?account o comportamento é o de sempre (todos os grupos)', async () => {
    const html = (await carne('?account=')).text;
    expect(html).toContain('Carnê de setembro');
    expect(html).toContain('Carnê da bota');
    expect(html).toContain('SALDO TOTAL EM ABERTO: R$390.00');
  });
});

describe('escopo', () => {
  test('cliente que a conferência do dono não acha -> 404 com code', async () => {
    despachar({ achaCliente: false });
    const res = await carne('?format=a4');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  test('parcelas, carnês, débitos e itens filtram pela empresa da URL', async () => {
    await carne('?format=a4');
    const chamadas = db.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params: params || [] }));
    const alvo = chamadas.filter(c =>
      /FROM (credit_installments|credit_accounts|customer_credit_transactions|sale_items)/i.test(c.sql));
    expect(alvo.length).toBeGreaterThanOrEqual(4);
    for (const c of alvo) {
      expect(c.sql).toMatch(/company_id = \$\d/);
      expect(c.params).toContain(LOJA);
    }
    // O carnê pedido nunca vai para o SQL: é conferido na lista já filtrada.
    expect(sqls().some(s => /account_id = \$/i.test(s))).toBe(false);
  });

  test('débito de venda cancelada fica fora (filtro no SQL)', async () => {
    await carne();
    const debitos = sqls().find(s => /FROM customer_credit_transactions/i.test(s));
    expect(debitos).toMatch(/type = 'debit'/);
    expect(debitos).toMatch(/<> 'cancelled'/);
  });
});
