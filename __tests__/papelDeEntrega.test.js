// ============================================================
// Papel de entrega (09/11/2026, parte 2) — src/routes/print.js +
// src/utils/buildDeliverySlipHtml.js
//
// O que estes testes travam:
//   1. SEM ?entrega o cupom é IDÊNTICO, byte a byte, ao que a main gerava
//      antes desta mudança — mesmo para uma venda que TEM endereço de
//      entrega e frete. Os arquivos fixtures/papelDeEntrega/cupom-*.html
//      são a saída da main (847379e4) para esta venda; nunca regenere
//      esses arquivos para "fazer o teste passar": se quebrar, o cupom de
//      quem não usa a novidade mudou, e isso é o bug.
//   2. COM ?entrega=1 o cupom inteiro continua lá, sem um byte mudado, e o
//      papel entra depois dele, com a linha de corte.
//   3. O papel: ENTREGA, número e data, nome e telefone, endereço com CEP e
//      referência, recado, itens SEM preço, "Pago · forma" e frete,
//      telefone da loja, "Recebido por". Nada de "cobrar na entrega".
//   4. /print/delivery/:saleId em 80, 58 e A4 (fixtures do papel).
//   5. O retrato da venda vale mais que o cadastro (que pode ter mudado);
//      sem retrato, o cadastro do cliente.
//
// Regenerar:
//   - cupom-*.html: SÓ a partir de uma main sem esta mudança, com
//     GERAR_FIXTURES_ENTREGA=cupom.
//   - papel-*.html (desenho do papel): GERAR_FIXTURES_ENTREGA=papel, e
//     revisar o diff à mão.
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
const VENDA = '5b1d3f0a-0000-4000-8000-000000000214';
const CLIENTE = 'c0000000-0000-4000-8000-000000000001';

const printRouter = require('../src/routes/print');
const app = express();
app.use(express.json());
app.use('/companies/:id/print', printRouter);

const FIXTURES = path.join(__dirname, 'fixtures', 'papelDeEntrega');

const EMPRESA = {
  legal_name: 'Loja Exemplo LTDA', trade_name: 'Loja Exemplo',
  cnpj: '00.000.000/0001-00', phone: '1133330000',
  address_street: 'R. do Comércio', address_number: '10',
  address_city: 'São Paulo', address_state: 'SP',
};

const RETRATO = {
  name: 'Pessoa Teste', phone: '11988881234',
  zip_code: '01310100', street: 'Av. Paulista', number: '1000',
  complement: 'Apto 52', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP',
  address_reference: 'portão azul', note: 'Entregar depois das 14h',
};

const VENDA_ROW = {
  id: VENDA, sale_number: 214, total_amount: '189.90', discount_amount: '0',
  payment_method: 'pix', created_at: '2026-11-09T17:32:00.000Z',
  seller_name: 'Ana', customer_name: 'Pessoa Teste', customer_id: CLIENTE,
  cash_tendered: null, pix_payload: null, notes: null,
  delivery_address: RETRATO,
};

const ITENS = [
  { product_id: 'p1', product_name: 'Vestido midi floral', quantity: 1, unit_price: 99.9, total_price: 99.9, discount: 0, variant_label: 'M' },
  { product_id: 'p2', product_name: 'Cinto couro caramelo', quantity: 1, unit_price: 45, total_price: 45, discount: 0, variant_label: null },
  { product_id: 'p3', product_name: 'Brinco argola dourada', quantity: 2, unit_price: 15, total_price: 30, discount: 0, variant_label: null },
  { product_id: null, product_name: 'Frete', product_name_snapshot: 'Frete', quantity: 1, unit_price: 15, total_price: 15, discount: 0, variant_label: null },
];

const CADASTRO = {
  name: 'Pessoa Teste', phone: '11988881234', zip_code: '04538132', street: 'Rua Nova',
  number: '7', complement: null, neighborhood: 'Itaim Bibi', city: 'São Paulo', state: 'SP',
  address_reference: null,
};

function despachar({ empresa = EMPRESA, venda = VENDA_ROW, payments = [{ method: 'pix', amount: '189.90' }], cliente = CADASTRO } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM companies WHERE id/i.test(s)) return Promise.resolve({ rows: [{ ...empresa }] });
    if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [{ ...venda }] });
    if (/FROM sale_items/i.test(s)) return Promise.resolve({ rows: ITENS.map(i => ({ ...i })) });
    if (/FROM sale_payments/i.test(s)) return Promise.resolve({ rows: payments });
    if (/FROM customers WHERE id/i.test(s)) return Promise.resolve({ rows: cliente ? [{ ...cliente }] : [] });
    return Promise.resolve({ rows: [] });
  });
}

const base = `/companies/${LOJA}/print`;
const get = async (url) => (await request(app).get(base + url)).text;

const CUPOM = { 'cupom-receipt': `/receipt/${VENDA}`, 'cupom-preview': `/receipt/${VENDA}/preview`, 'cupom-a4': `/receipt/${VENDA}/a4` };
const PAPEL = {
  'papel-80': `/delivery/${VENDA}?format=80`,
  'papel-58': `/delivery/${VENDA}?format=58`,
  'papel-a4': `/delivery/${VENDA}?format=a4`,
  'cupom-com-entrega-preview': `/receipt/${VENDA}/preview?entrega=1`,
};
const fixture = (nome) => fs.readFileSync(path.join(FIXTURES, `${nome}.html`), 'utf8');
const MARCA = '\n  <br><button onclick="window.print()"';

beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); despachar(); });

if (process.env.GERAR_FIXTURES_ENTREGA) {
  test(`gera fixtures (${process.env.GERAR_FIXTURES_ENTREGA})`, async () => {
    fs.mkdirSync(FIXTURES, { recursive: true });
    const lista = process.env.GERAR_FIXTURES_ENTREGA === 'cupom' ? CUPOM : PAPEL;
    for (const [nome, url] of Object.entries(lista)) {
      fs.writeFileSync(path.join(FIXTURES, `${nome}.html`), await get(url));
    }
  });
} else {
  describe('1. sem ?entrega: cupom idêntico ao da main', () => {
    for (const [nome, url] of Object.entries(CUPOM)) {
      test(`${nome}: byte a byte`, async () => {
        expect(await get(url)).toBe(fixture(nome));
      });
    }

    test('?entrega com outro valor (0, true, vazio) não muda nada', async () => {
      for (const v of ['0', 'true', '', 'sim']) {
        expect(await get(`/receipt/${VENDA}/preview?entrega=${v}`)).toBe(fixture('cupom-preview'));
      }
    });

    test('A4 do cupom ignora ?entrega (o A4 do papel é rota própria)', async () => {
      expect(await get(`/receipt/${VENDA}/a4?entrega=1`)).toBe(fixture('cupom-a4'));
    });

    test('sem ?entrega o cadastro do cliente nem é consultado', async () => {
      await get(`/receipt/${VENDA}/preview`);
      const sqls = db.query.mock.calls.map(([q]) => String(q));
      expect(sqls.some(q => /FROM customers WHERE id/i.test(q))).toBe(false);
    });
  });

  describe('2. com ?entrega=1 na bobina', () => {
    test('o cupom inteiro fica intacto e o papel entra depois, antes do botão', async () => {
      for (const [rota, nome] of [[`/receipt/${VENDA}/preview`, 'cupom-preview'], [`/receipt/${VENDA}`, 'cupom-receipt']]) {
        const com = await get(`${rota}?entrega=1`);
        const sem = fixture(nome);
        const i = sem.lastIndexOf(MARCA);
        expect(i).toBeGreaterThan(0);
        expect(com.startsWith(sem.slice(0, i))).toBe(true);
        expect(com.endsWith(sem.slice(i))).toBe(true);
        const papel = com.slice(i, com.length - (sem.length - i));
        expect(papel).toContain('data-papel-entrega');
        expect(papel).toContain('corte');
        expect(papel).toContain('ENTREGA');
      }
    });

    test('fixture do cupom com o papel', async () => {
      expect(await get(`/receipt/${VENDA}/preview?entrega=1`)).toBe(fixture('cupom-com-entrega-preview'));
    });

    test('venda sem endereço (sem retrato e cliente sem endereço): sai o cupom de sempre', async () => {
      despachar({ venda: { ...VENDA_ROW, delivery_address: null }, cliente: { ...CADASTRO, street: null, zip_code: null } });
      expect(await get(`/receipt/${VENDA}/preview?entrega=1`)).toBe(fixture('cupom-preview'));
    });

    test('venda sem cliente e sem retrato: sai o cupom de sempre', async () => {
      despachar({ venda: { ...VENDA_ROW, delivery_address: null, customer_id: null } });
      expect(await get(`/receipt/${VENDA}/preview?entrega=1`)).toBe(fixture('cupom-preview'));
    });

    test('erro ao ler o cadastro não derruba o cupom', async () => {
      despachar({ venda: { ...VENDA_ROW, delivery_address: null } });
      const original = db.query.getMockImplementation();
      db.query.mockImplementation((sql, p) => (/FROM customers/i.test(String(sql)) ? Promise.reject(new Error('boom')) : original(sql, p)));
      const res = await request(app).get(`${base}/receipt/${VENDA}/preview?entrega=1`);
      expect(res.status).toBe(200);
      expect(res.text).toBe(fixture('cupom-preview'));
    });
  });

  describe('3. o que o papel mostra', () => {
    let papel;
    beforeEach(async () => {
      const com = await get(`/receipt/${VENDA}/preview?entrega=1`);
      papel = com.slice(com.indexOf('data-papel-entrega'), com.lastIndexOf(MARCA));
    });

    test('cabeçalho, quem recebe e endereço completo', () => {
      expect(papel).toContain('<div class="ent-titulo">ENTREGA</div>');
      expect(papel).toContain('Venda Nº 214 · 09/11/2026 14:32');
      expect(papel).toContain('<div class="ent-nome">Pessoa Teste</div>');
      expect(papel).toMatch(/\.ent-nome\{[^}]*font-size:16px[^}]*text-transform:uppercase/);
      expect(papel).toContain('<div class="ent-tel">(11) 98888-1234</div>');
      expect(papel).toContain('Av. Paulista, 1000<br>Apto 52 - Bela Vista<br>São Paulo/SP<br>CEP 01310-100');
      expect(papel).toContain('Ref.: portão azul');
      expect(papel).toContain('RECADO');
      expect(papel).toContain('Entregar depois das 14h');
    });

    test('itens com quantidade e nome, sem preço; o frete não vira item', () => {
      expect(papel).toContain('ITENS (3)');
      expect(papel).toContain('<div>1x Vestido midi floral (M)</div>');
      expect(papel).toContain('<div>1x Cinto couro caramelo</div>');
      expect(papel).toContain('<div>2x Brinco argola dourada</div>');
      expect(papel).not.toContain('x Frete');
      // O único valor em reais é o do frete.
      expect(papel.match(/R\$/g)).toHaveLength(1);
      expect(papel).not.toContain('99,90');
    });

    test('pagamento, frete, telefone da loja e "Recebido por"; nada a cobrar', () => {
      expect(papel).toContain('<b>PAGO · PIX</b>');
      expect(papel).toContain('<span>Frete</span><span>R$ 15,00</span>');
      expect(papel).toContain('Loja Exemplo · (11) 3333-0000');
      expect(papel).toContain('Recebido por: ________________');
      expect(papel).not.toMatch(/cobrar/i);
    });

    test('nada de largura fixa por dentro: acompanha o corpo (80 ou 58 mm)', () => {
      const css = papel.slice(papel.indexOf('<style>'), papel.indexOf('</style>'));
      expect(css).not.toMatch(/width:\d+(mm|px)/);
      expect(css).toContain('.ent{');
      expect(css).toMatch(/overflow-wrap:anywhere/);
    });
  });

  describe('4. /print/delivery/:saleId', () => {
    for (const nome of ['papel-80', 'papel-58', 'papel-a4']) {
      test(`${nome}: fixture`, async () => {
        expect(await get(PAPEL[nome])).toBe(fixture(nome));
      });
    }

    test('80 mm: página de 80 mm, corpo de 72 mm', async () => {
      const html = await get(PAPEL['papel-80']);
      expect(html).toContain('size: 80mm auto');
      expect(html).toContain('body { width:72mm;');
    });

    test('58 mm: página de 58 mm, corpo de 48 mm, mesmo conteúdo', async () => {
      const h58 = await get(PAPEL['papel-58']);
      const h80 = await get(PAPEL['papel-80']);
      expect(h58).toContain('size: 58mm auto');
      expect(h58).toContain('body { width:48mm;');
      const corpo = (h) => h.slice(h.indexOf('<body>'));
      expect(corpo(h58)).toBe(corpo(h80));
    });

    test('formato desconhecido cai na bobina de 80 mm', async () => {
      expect(await get(`/delivery/${VENDA}?format=xx`)).toBe(fixture('papel-80'));
      expect(await get(`/delivery/${VENDA}`)).toBe(fixture('papel-80'));
    });

    test('A4: folha A4, blocos do mockup, itens em tabela sem preço', async () => {
      const html = await get(PAPEL['papel-a4']);
      expect(html).toContain('size: A4;');
      expect(html).toContain('<div class="tt">ENTREGA</div>');
      expect(html).toContain('Venda Nº 214 · 09/11/2026');
      expect(html).toContain('<div class="nm">Pessoa Teste</div>');
      expect(html).toContain('<div class="tel">(11) 98888-1234</div>');
      expect(html).toContain('Av. Paulista, 1000 · Apto 52<br>Bela Vista · São Paulo/SP · CEP 01310-100');
      expect(html).toContain('Ponto de referência: portão azul');
      expect(html).toContain('<tr><td>2</td><td>Brinco argola dourada</td></tr>');
      expect(html).toContain('<b class="v">Pago · Pix</b>');
      expect(html).toContain('<b class="v">R$ 15,00</b>');
      expect(html).toContain('<div>Recebido por</div><div>Data e hora</div>');
      expect(html).toContain('(11) 3333-0000');
      expect(html).not.toMatch(/cobrar/i);
      expect(html).not.toContain('99,90');
    });

    test('A4 com logo https: <img>; autoprint espera a imagem (2 s)', async () => {
      despachar({ empresa: { ...EMPRESA, logo_url: 'https://r2.exemplo.com.br/logo.png' } });
      const html = await get(`/delivery/${VENDA}?format=a4&autoprint=1`);
      expect(html).toContain('<img src="https://r2.exemplo.com.br/logo.png" alt="">');
      expect(html).toContain('setTimeout(go,2000)');
    });

    test('autoprint só com ?autoprint=1', async () => {
      expect(await get(PAPEL['papel-80'])).not.toContain('window.print();}catch');
      expect(await get(`/delivery/${VENDA}?format=80&autoprint=1`)).toContain('setTimeout(go,3000)');
    });

    test('venda sem endereço: 422 NO_DELIVERY_ADDRESS', async () => {
      despachar({ venda: { ...VENDA_ROW, delivery_address: null, customer_id: null } });
      const res = await request(app).get(`${base}/delivery/${VENDA}?format=a4`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NO_DELIVERY_ADDRESS');
    });

    test('venda de outra loja: 404', async () => {
      db.query.mockImplementation((sql) => Promise.resolve({ rows: /FROM companies/i.test(String(sql)) ? [EMPRESA] : [] }));
      const res = await request(app).get(`${base}/delivery/${VENDA}`);
      expect(res.status).toBe(404);
    });
  });

  describe('5. retrato x cadastro', () => {
    test('o retrato da venda vale mesmo com o cadastro diferente (reimpressão igual)', async () => {
      const html = await get(PAPEL['papel-80']);
      expect(html).toContain('Av. Paulista, 1000');
      expect(html).not.toContain('Rua Nova');
      const sqls = db.query.mock.calls.map(([q]) => String(q));
      expect(sqls.some(q => /FROM customers WHERE id/i.test(q))).toBe(false);
    });

    test('retrato em texto (jsonb como string) também vale', async () => {
      despachar({ venda: { ...VENDA_ROW, delivery_address: JSON.stringify(RETRATO) } });
      expect(await get(PAPEL['papel-80'])).toBe(fixture('papel-80'));
    });

    test('sem retrato (venda sem frete): usa o cadastro atual do cliente', async () => {
      despachar({ venda: { ...VENDA_ROW, delivery_address: null } });
      const html = await get(PAPEL['papel-80']);
      expect(html).toContain('Rua Nova, 7');
      expect(html).toContain('CEP 04538-132');
      expect(html).not.toContain('RECADO');
    });

    test('cadastro sem a coluna da 433: lê sem o ponto de referência', async () => {
      despachar({ venda: { ...VENDA_ROW, delivery_address: null } });
      const original = db.query.getMockImplementation();
      db.query.mockImplementation((sql, p) => {
        if (/address_reference FROM customers/i.test(String(sql))) {
          return Promise.reject(Object.assign(new Error('column "address_reference" does not exist'), { code: '42703' }));
        }
        return original(sql, p);
      });
      expect(await get(PAPEL['papel-80'])).toContain('Rua Nova, 7');
    });
  });

  describe('6. pagamento no papel', () => {
    const papelCom = async (venda, payments) => {
      despachar({ venda: { ...VENDA_ROW, ...venda }, payments });
      return get(PAPEL['papel-a4']);
    };

    test('crediário: "Crediário", sem "Pago"', async () => {
      const html = await papelCom({ payment_method: 'crediario' }, []);
      expect(html).toContain('<b class="v">Crediário</b>');
      expect(html).not.toContain('Pago ·');
    });

    test('dividida Pix + crediário', async () => {
      const html = await papelCom({ payment_method: 'pix' }, [{ method: 'pix', amount: '89.90' }]);
      expect(html).toContain('<b class="v">Pix + Crediário</b>');
    });

    test('dividida dinheiro + cartão', async () => {
      const html = await papelCom({ payment_method: 'dinheiro' }, [{ method: 'dinheiro', amount: '100' }, { method: 'cartao', amount: '89.90' }]);
      expect(html).toContain('<b class="v">Pago · Dinheiro + Cartão</b>');
    });

    test('venda antiga sem sale_payments: forma da venda', async () => {
      const html = await papelCom({ payment_method: 'debito' }, []);
      expect(html).toContain('<b class="v">Pago · Débito</b>');
    });
  });

  test('7. texto do cliente é escapado', async () => {
    despachar({ venda: { ...VENDA_ROW, delivery_address: { ...RETRATO, name: '<script>x</script>', note: 'a & "b"' } } });
    const html = await get(PAPEL['papel-80']);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a &amp; &quot;b&quot;');
  });
}
