// ============================================================
// Cupom não fiscal do Caixa — logo da loja no canto superior esquerdo
// (GET /print/receipt/:saleId, /preview e /a4 — src/routes/print.js)
//
// O que estes testes travam:
//   1. SEM logo (logo_url ausente, null, vazio, http:, javascript:, data:...)
//      o HTML é IDÊNTICO, byte a byte, ao que a main gerava antes desta
//      mudança. Os arquivos de __tests__/fixtures/cupomSemLogo/ são a saída
//      da main (398c570d) para a mesma venda; nunca regenere esses arquivos
//      para "fazer o teste passar" — se o teste sem logo quebrar, o cupom de
//      quem não tem logo mudou, e isso é o bug.
//   2. COM logo https: cabeçalho em duas colunas, <img> com a URL escapada,
//      alt vazio, filtro de térmica, caixa de 18 mm (80 mm) / 30 mm (A4).
//   3. COM logo + autoprint: o script espera a imagem com teto de 2 s; sem
//      logo o script é o mesmo de sempre (teto de 3 s).
//
// Para regenerar as fixtures a partir de uma main SEM a feature (só se a
// venda de exemplo mudar): GERAR_FIXTURES_CUPOM=1 npx jest cupom.logoDaLoja
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

const printRouter = require('../src/routes/print');
const app = express();
app.use(express.json());
app.use('/companies/:id/print', printRouter);

const FIXTURES = path.join(__dirname, 'fixtures', 'cupomSemLogo');

const EMPRESA = {
  legal_name: 'MH Alimentos LTDA', trade_name: 'MH Alimentos',
  cnpj: '12.345.678/0001-90', phone: '(91) 90000-0000',
  address_street: 'Rua das Palmeiras', address_number: '120',
  address_city: 'Belém', address_state: 'PA',
};

const VENDA_ROW = {
  id: VENDA, sale_number: 1042, total_amount: '174.50', discount_amount: '10.00',
  payment_method: 'dinheiro', created_at: '2026-10-20T15:30:00.000Z',
  seller_name: 'Ana', customer_name: 'Carlos', cash_tendered: '200.00',
  pix_payload: null, notes: 'Entregar na portaria',
};

const ITENS = [
  { product_name: 'Feijão 1kg', quantity: 2, unit_price: 7.5, total_price: 15, discount: 0, variant_label: null },
  { product_name: 'Camiseta', quantity: 1, unit_price: 169.5, total_price: 159.5, discount: 10, variant_label: 'M-AZUL' },
];

function despachar({ empresa = EMPRESA, venda = VENDA_ROW, payments = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM companies WHERE id/i.test(s)) return Promise.resolve({ rows: [{ ...empresa }] });
    if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [{ ...venda }] });
    if (/FROM sale_items/i.test(s)) return Promise.resolve({ rows: ITENS.map(i => ({ ...i })) });
    if (/FROM sale_payments/i.test(s)) return Promise.resolve({ rows: payments });
    return Promise.resolve({ rows: [] });
  });
}

// nome da fixture -> sufixo da rota
const ROTAS = {
  'receipt-80mm': '',
  'preview-80mm-autoprint': '/preview',
  'a4': '/a4',
};
const get = async (sufixo) => (
  await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}${sufixo}`)
).text;

const LOGO = 'https://r2.exemplo.com.br/lojas/mh/logo.png';

beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); despachar(); });

if (process.env.GERAR_FIXTURES_CUPOM) {
  test('gera fixtures (modo GERAR_FIXTURES_CUPOM)', async () => {
    fs.mkdirSync(FIXTURES, { recursive: true });
    for (const [nome, sufixo] of Object.entries(ROTAS)) {
      fs.writeFileSync(path.join(FIXTURES, `${nome}.html`), await get(sufixo));
    }
  });
} else {
  describe('sem logo: HTML idêntico ao da main', () => {
    const semLogo = {
      'logo_url ausente (SELECT da main)': {},
      'logo_url null': { logo_url: null },
      'logo_url vazio': { logo_url: '' },
      'logo_url só espaços': { logo_url: '   ' },
      'logo_url http:': { logo_url: 'http://r2.exemplo.com.br/logo.png' },
      'logo_url javascript:': { logo_url: 'javascript:alert(1)' },
      'logo_url data:': { logo_url: 'data:image/png;base64,AAAA' },
      'logo_url relativa': { logo_url: '/uploads/logo.png' },
      'logo_url sem esquema': { logo_url: '//r2.exemplo.com.br/logo.png' },
      'logo_url https com quebra de linha': { logo_url: 'https://r2.exemplo.com.br/a.png\n<script>x</script>' },
      'logo_url https com espaço': { logo_url: 'https://r2.exemplo.com.br/a b.png' },
    };

    for (const [caso, extra] of Object.entries(semLogo)) {
      for (const [nome, sufixo] of Object.entries(ROTAS)) {
        test(`${caso} -> ${nome}`, async () => {
          despachar({ empresa: { ...EMPRESA, ...extra } });
          const esperado = fs.readFileSync(path.join(FIXTURES, `${nome}.html`), 'utf8');
          expect(await get(sufixo)).toBe(esperado);
        });
      }
    }

    test('venda no crediário com pagamento misto e logo http: não ganha <img> nem estilo novo', async () => {
      despachar({
        empresa: { ...EMPRESA, logo_url: 'http://r2.exemplo.com.br/logo.png' },
        venda: { ...VENDA_ROW, payment_method: 'crediario' },
        payments: [{ method: 'pix', amount: '74.50' }, { method: 'crediario', amount: '100.00' }],
      });
      const html = await get('/preview');
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/head-logo/);
    });

    test('a consulta da empresa pede logo_url', async () => {
      await get('');
      const sql = db.query.mock.calls.map(([q]) => String(q)).find(q => /FROM companies/i.test(q));
      expect(sql).toMatch(/\blogo_url\b/);
    });
  });

  describe('com logo https', () => {
    beforeEach(() => despachar({ empresa: { ...EMPRESA, logo_url: LOGO } }));

    test('80 mm: <img> com a URL, alt vazio, filtro de térmica e caixa de 18 mm', async () => {
      const html = await get('');
      expect(html).toContain(`<img src="${LOGO}" alt="">`);
      expect(html).toContain('filter:grayscale(1) contrast(1.2)');
      expect(html).toContain('object-fit:contain');
      expect(html).toMatch(/\.head-logo-img \{[^}]*width:18mm;[^}]*height:18mm/);
      expect((html.match(/<img/g) || []).length).toBe(1);
    });

    test('cabeçalho em duas colunas: logo antes do nome, nome em negrito, linhas à esquerda', async () => {
      const html = await get('');
      const cab = html.slice(html.indexOf('<div class="head-logo">'), html.indexOf('CUPOM NAO FISCAL'));
      expect(cab.indexOf('<img')).toBeGreaterThan(-1);
      expect(cab.indexOf('<img')).toBeLessThan(cab.indexOf('MH Alimentos'));
      expect(cab).toContain('class="company-name"');
      expect(cab).toContain('CNPJ: 12.345.678/0001-90');
      expect(cab).toContain('Tel: (91) 90000-0000');
      expect(cab).toContain('Rua das Palmeiras, 120');
      expect(cab).toContain('Belém - PA');
      expect(html).toMatch(/\.head-logo-txt \{[^}]*text-align:left/);
      expect(html).not.toMatch(/<div class="center">\s*<div class="company-name">/);
    });

    test('o resto do cupom não muda: só o cabeçalho e o CSS da logo diferem do sem logo', async () => {
      const com = await get('');
      const sem = fs.readFileSync(path.join(FIXTURES, 'receipt-80mm.html'), 'utf8');
      const marca = '<div class="divider"></div>\n  <div class="center bold">CUPOM NAO FISCAL';
      expect(com.indexOf(marca)).toBeGreaterThan(-1);
      expect(com.slice(com.indexOf(marca))).toBe(sem.slice(sem.indexOf(marca)));
    });

    test('URL com aspas, < e & é escapada no atributo', async () => {
      const feia = 'https://x.exemplo.com/l.png?a=1&b="2"><script>alert(1)</script>';
      despachar({ empresa: { ...EMPRESA, logo_url: feia } });
      const html = await get('');
      expect(html).toContain('src="https://x.exemplo.com/l.png?a=1&amp;b=&quot;2&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('b="2"');
    });

    test('esquema em maiúsculas (HTTPS://) vale', async () => {
      despachar({ empresa: { ...EMPRESA, logo_url: 'HTTPS://r2.exemplo.com.br/logo.png' } });
      expect(await get('')).toMatch(/<img src="HTTPS:\/\/r2\.exemplo\.com\.br\/logo\.png"/);
    });

    test('A4: mesma estrutura, caixa de até 30 mm', async () => {
      const html = await get('/a4');
      expect(html).toContain(`<img src="${LOGO}" alt="">`);
      expect(html).toContain('size: A4 auto');
      expect(html).toMatch(/\.head-logo-img \{[^}]*width:30mm;[^}]*height:30mm/);
      expect(html).not.toMatch(/width:18mm/);
    });

    test('autoprint com logo: espera a imagem com teto de 2 s (não 3 s)', async () => {
      const html = await get('/preview');
      expect(html).toContain('setTimeout(go,2000)');
      expect(html).not.toContain('setTimeout(go,3000)');
      expect(html).toContain('document.images');
    });

    test('sem autoprint (receipt) não há script', async () => {
      expect(await get('')).not.toContain('<script');
    });

    test('autoprint sem logo mantém o script de sempre (teto de 3 s)', async () => {
      despachar();
      const html = await get('/preview');
      expect(html).toContain('setTimeout(go,3000)');
      expect(html).not.toContain('setTimeout(go,2000)');
    });
  });
}
