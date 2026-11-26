// ============================================================
// Comprovante da condicional (C8, 25/11/2026) — GET /print/condicional/:cid
// (bobina 80 mm) e /a4, src/utils/buildCondicionalHtml.js.
// Textos do mockup aprovado em 25/11. Sem banco: db.query e simulado.
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

let mockUsuario = { id: 'user-1', is_staff: false, role: 'owner' };
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = mockUsuario; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const LOJA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const OUTRA = '99999999-9999-4999-8999-999999999999';
const CID = '5b1d3f0a-0000-4000-8000-000000000031';

const printRouter = require('../src/routes/print');
const app = express();
app.use('/companies/:id/print', printRouter);

const EMPRESA = {
  legal_name: 'Loja Centro LTDA', trade_name: 'Loja Centro',
  cnpj: '00000000000100', phone: '(11) 4002-0000',
  address_street: 'Rua das Acácias', address_number: '120',
  address_city: 'São Paulo', address_state: 'SP',
};

const itens = [
  { id: 'i1', product_id: 'p1', variant_id: 'v1', product_name: 'Vestido Midi Lívia', variant_label: null, color_name: 'Verde-oliva', size_label: 'M', unit_price: '189.90', situacao: 'com_cliente', added_at: '2026-11-25T13:42:00Z' },
  { id: 'i2', product_id: 'p2', variant_id: 'v2', product_name: 'Blusa Tricô Nina', variant_label: null, color_name: 'Off-white', size_label: 'P', unit_price: '129.90', situacao: 'com_cliente', added_at: '2026-11-25T13:42:00Z' },
  { id: 'i3', product_id: 'p3', variant_id: null, product_name: 'Brinco Argola Luz', variant_label: null, color_name: 'Dourado', size_label: null, unit_price: '69.90', situacao: 'com_cliente', added_at: '2026-11-25T13:42:00Z' },
];

function condicionalRow(extra = {}) {
  return {
    id: CID, company_id: LOJA, numero: 31, customer_id: 'c1',
    customer_name: 'Marina Duarte', customer_phone: '11988880142',
    seller_id: null, employee_id: null, seller_name: 'Jéssica',
    due_date: '2026-11-28', status: 'aberta', notes: null,
    terms_snapshot: 'As peças devem voltar no prazo, sem uso e com a etiqueta.',
    created_by: 'user-1', created_at: new Date('2026-11-25T13:42:00Z'), updated_at: new Date('2026-11-25T13:42:00Z'),
    closed_at: null, cancelled_at: null, cancel_reason: null,
    ...extra,
  };
}

function simular({ cond = condicionalRow(), eventos = [], lojaDaCond = LOJA, pecas = itens } = {}) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/FROM condicionais WHERE/.test(s)) {
      return Promise.resolve({ rows: params[1] === lojaDaCond ? [cond] : [] });
    }
    if (/FROM condicional_itens/.test(s)) return Promise.resolve({ rows: pecas });
    if (/FROM condicional_eventos/.test(s)) return Promise.resolve({ rows: eventos });
    if (/FROM companies/.test(s)) return Promise.resolve({ rows: [EMPRESA] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  db.query.mockReset();
  mockUsuario = { id: 'user-1', is_staff: true, role: 'owner' };
  delete process.env.CONDICIONAL_LIBERADA;
});

describe('comprovante da condicional — bobina 80 mm', () => {
  test('traz o essencial do mockup', async () => {
    simular();
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    const h = r.text;
    expect(h).toContain('size: 80mm auto');
    expect(h).not.toContain('size: A4');
    for (const t of [
      'LOJA CENTRO', 'COMPROVANTE DE CONDICIONAL', 'C-0031 · 25/11/2026 10:42',
      'Cliente: Marina Duarte', 'Tel.: (11) 98888-0142', 'Vendedora: Jéssica',
      'DEVOLVER ATÉ SÁB., 28/11/2026',
      'Vestido Midi Lívia', '189,90', 'Verde-oliva · M', 'Blusa Tricô Nina', 'Off-white · P',
      'Brinco Argola Luz', '69,90', 'Dourado',
      'TOTAL DAS PEÇAS (3)', '389,70', 'Nada foi pago na retirada.',
      'Assinatura da cliente', 'NÃO É DOCUMENTO FISCAL',
      'As peças devem voltar no prazo, sem uso e com a etiqueta.',
    ]) expect(h).toContain(t);
    expect(h).not.toContain('ATUALIZADO');
  });

  test('sem termos nao ha quadro de texto da loja', async () => {
    simular({ cond: condicionalRow({ terms_snapshot: null }) });
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('As peças devem voltar');
    expect(r.text).toContain('Assinatura da cliente');
    expect(r.text).toContain('NÃO É DOCUMENTO FISCAL');
  });

  test('peca acrescentada depois: comprovante atualizado', async () => {
    simular({ eventos: [{ id: 'e1', tipo: 'criada' }, { id: 'e2', tipo: 'peca_acrescentada', item_id: 'i3' }] });
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`);
    expect(r.text).toContain('COMPROVANTE DE CONDICIONAL (ATUALIZADO)');
  });

  test('autoprint so com ?autoprint=1', async () => {
    simular();
    const sem = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`);
    const com = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}?autoprint=1`);
    expect(sem.text).not.toContain('<script');
    expect(com.text).toContain('<script');
  });

  test('texto do cliente e escapado', async () => {
    simular({ cond: condicionalRow({ customer_name: '<b>Ana</b>' }) });
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`);
    expect(r.text).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    expect(r.text).not.toContain('<b>Ana</b>');
  });
});

describe('comprovante da condicional — A4', () => {
  test('traz o essencial do mockup, em A4', async () => {
    simular();
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}/a4`);
    expect(r.status).toBe(200);
    const h = r.text;
    expect(h).toContain('size: A4');
    expect(h).not.toContain('size: 80mm');
    for (const t of [
      'Loja Centro', 'CNPJ 00.000.000/0001-00', 'Rua das Acácias, 120 · São Paulo - SP · (11) 4002-0000',
      'C-0031', '25/11/2026, 10:42', 'Comprovante de condicional',
      'Marina Duarte', '(11) 98888-0142', 'quarta, 25/11/2026', 'Jéssica', 'Devolver até', 'sábado, 28/11/2026',
      'Vestido Midi Lívia', 'Verde-oliva', 'R$ 189,90', 'Total das peças (3)', 'R$ 389,70',
      'Nada foi pago na retirada. A cliente paga só as peças com que ficar.',
      'Combinado da loja', 'As peças devem voltar no prazo, sem uso e com a etiqueta.',
      'Assinatura da cliente', 'Não é documento fiscal · não é comprovante de venda',
    ]) expect(h).toContain(t);
  });

  test('sem termos o quadro "Combinado da loja" nao existe', async () => {
    simular({ cond: condicionalRow({ terms_snapshot: '   ' }) });
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}/a4`);
    expect(r.text).not.toContain('Combinado da loja');
    expect(r.text).toContain('Assinatura da cliente');
  });

  test('atualizado quando houve peca acrescentada', async () => {
    simular({ eventos: [{ id: 'e2', tipo: 'peca_acrescentada' }] });
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}/a4`);
    expect(r.text).toContain('Comprovante de condicional (atualizado)');
  });
});

describe('devolucao parcial', () => {
  // 3 pecas; a blusa voltou (decided_at 27/11 00:30 em SP = 03:30Z) e o brinco voltou com defeito.
  const parcial = [
    itens[0],
    { ...itens[1], situacao: 'voltou', decided_at: new Date('2026-11-27T03:30:00Z') },
    { ...itens[2], situacao: 'voltou_defeito', decided_at: new Date('2026-11-27T15:00:00Z') },
  ];

  test('A4: devolvida riscada com a data, fora da soma e da contagem', async () => {
    simular({ pecas: parcial });
    const h = (await request(app).get(`/companies/${LOJA}/print/condicional/${CID}/a4`)).text;
    expect(h).toContain('Total das peças (1)');
    expect(h).toContain('R$ 189,90</span></div>');
    expect(h).not.toContain('389,70');
    expect(h).not.toContain('R$ 319,80');
    expect(h).toContain('<tr class="vt"><td>Blusa Tricô Nina<small>Voltou em 27/11</small>');
    expect(h).toContain('<tr class="vt"><td>Brinco Argola Luz<small>Voltou em 27/11</small>');
    expect(h).toContain('<tr><td>Vestido Midi Lívia</td>');
  });

  test('bobina: mesma regra', async () => {
    simular({ pecas: parcial });
    const h = (await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`)).text;
    expect(h).toContain('TOTAL DAS PEÇAS (1)</span><span>189,90');
    expect(h).toContain('<div class="ln vt"><span>Blusa Tricô Nina</span>');
    expect(h).toContain('Voltou em 27/11');
    expect(h).not.toContain('389,70');
  });

  test('com cliente e ficou somam; sem devolucao nada fica riscado', async () => {
    simular({ pecas: [itens[0], { ...itens[1], situacao: 'ficou' }, itens[2]] });
    const h = (await request(app).get(`/companies/${LOJA}/print/condicional/${CID}/a4`)).text;
    expect(h).toContain('Total das peças (3)');
    expect(h).toContain('R$ 389,70');
    expect(h).not.toContain('<tr class="vt">');
    expect(h).not.toContain('Voltou em');
  });
});

describe('escopo e trava', () => {
  test('condicional de outra loja: 404', async () => {
    simular({ lojaDaCond: OUTRA });
    const b = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`);
    const a = await request(app).get(`/companies/${LOJA}/print/condicional/${CID}/a4`);
    expect(b.status).toBe(404);
    expect(a.status).toBe(404);
  });

  test('id que nao e uuid: 404 sem ir ao banco', async () => {
    const r = await request(app).get(`/companies/${LOJA}/print/condicional/abc`);
    expect(r.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('trava desligada: lojista 404, staff passa; ligada: lojista passa', async () => {
    simular();
    mockUsuario = { id: 'u2', is_staff: false, role: 'owner' };
    expect((await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`)).status).toBe(404);
    expect((await request(app).get(`/companies/${LOJA}/print/condicional/${CID}/a4`)).status).toBe(404);
    mockUsuario = { id: 'u3', is_staff: true, role: 'owner' };
    expect((await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`)).status).toBe(200);
    mockUsuario = { id: 'u2', is_staff: false, role: 'owner' };
    process.env.CONDICIONAL_LIBERADA = 'true';
    expect((await request(app).get(`/companies/${LOJA}/print/condicional/${CID}`)).status).toBe(200);
  });
});
