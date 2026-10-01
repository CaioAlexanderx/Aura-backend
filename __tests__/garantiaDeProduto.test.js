// Garantia de produto: documento (buildWarrantyHtml) e normalizacao do codigo do QR.
// As rotas foram validadas contra Postgres real a mao (47 checks em 01/10/2026);
// aqui ficam as garantias que nao dependem de banco.
const {
  buildWarrantyHtml, prazoLabel, formatDateOnly, numeroLabel, termosHtml,
} = require('../src/utils/buildWarrantyHtml');
const { DEFAULT_WARRANTY_TERMS } = require('../src/utils/warrantyTerms');

const base = () => ({
  warranty: {
    warranty_number: 7, code: 'K7M4Q9XD', sale_number: 12, created_at: '2026-09-30T17:22:00Z',
    customer_name: 'Maria <b>Souza</b>', customer_cpf: '32397192829', customer_phone: '5512988327114',
    terms_text: null,
  },
  items: [{ product_name: 'Galaxy J5 <script>x</script>', serial: '3563', quantity: 1, unit_price: 290, days: 365, starts_on: '2026-09-30', expires_on: '2027-09-30' }],
  company: { trade_name: 'VALEN', legal_name: 'Valen LTDA', cnpj: '58090726000142' },
  brand: {},
});

describe('buildWarrantyHtml', () => {
  test('prazo em linguagem de balcao', () => {
    expect(prazoLabel(365)).toBe('1 ano');
    expect(prazoLabel(730)).toBe('2 anos');
    expect(prazoLabel(90)).toBe('3 meses');
    expect(prazoLabel(30)).toBe('1 mês');
    expect(prazoLabel(45)).toBe('45 dias');
    expect(prazoLabel(1)).toBe('1 dia');
  });

  test('data DATE nao desloca o dia (sem passar por fuso)', () => {
    expect(formatDateOnly('2026-09-30')).toBe('30/09/2026');
    expect(numeroLabel(7)).toBe('000007');
  });

  test('escapa HTML de cliente e produto', () => {
    const html = buildWarrantyHtml(base());
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<b>Souza</b>');
    expect(html).toContain('&lt;b&gt;Souza&lt;/b&gt;');
  });

  test('traz o QR inline, o codigo e nenhum recurso remoto', () => {
    const html = buildWarrantyHtml(base());
    expect(html).toContain('<svg');
    expect(html).toContain('K7M4Q9XD');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/<link /);
  });

  test('cor da marca so aceita hex; lixo cai no padrao', () => {
    const ok = buildWarrantyHtml({ ...base(), brand: { primary_color: '#0a7' } });
    expect(ok).toContain('--cor:#0a7');
    const ruim = buildWarrantyHtml({ ...base(), brand: { primary_color: 'red;}</style><script>' } });
    expect(ruim).not.toContain('</style><script>');
    expect(ruim).toContain('--cor:#5b21b6');
  });

  test('sem termos proprios usa o modelo padrao', () => {
    const html = buildWarrantyHtml(base());
    expect(html).toContain('Esta garantia não cobre');
    expect(termosHtml(DEFAULT_WARRANTY_TERMS)).toContain('<li>');
  });

  test('termos proprios substituem o padrao', () => {
    const b = base();
    b.warranty.terms_text = '## Meus termos\nTexto da loja.';
    const html = buildWarrantyHtml(b);
    expect(html).toContain('Meus termos');
    expect(html).not.toContain('Esta garantia não cobre');
  });

  test('garantia anulada vem carimbada', () => {
    const b = base();
    b.warranty.voided_at = '2026-10-01T10:00:00Z';
    expect(buildWarrantyHtml(b)).toContain('ANULADA');
    expect(buildWarrantyHtml(base())).not.toContain('class="anulada"');
  });

  test('varios produtos: um cartao por item e titulo no plural', () => {
    const b = base();
    b.items.push({ product_name: 'Carregador', quantity: 2, days: 90, starts_on: '2026-09-30', expires_on: '2026-12-29' });
    const html = buildWarrantyHtml(b);
    expect((html.match(/class="item"/g) || []).length).toBe(2);
    expect(html).toContain('Seus produtos estão protegidos');
    expect(html).toContain('× 2');
  });
});

describe('codigo do QR', () => {
  test('aceita codigo puro, minusculo ou URL inteira', () => {
    const { normalizeCode } = require('../src/routes/warranties')._test;
    expect(normalizeCode('K7M4Q9XD')).toBe('K7M4Q9XD');
    expect(normalizeCode(' k7m4q9xd ')).toBe('K7M4Q9XD');
    expect(normalizeCode('https://getaura.com.br/g/K7M4Q9XD?x=1')).toBe('K7M4Q9XD');
    expect(normalizeCode('')).toBe('');
  });
});
