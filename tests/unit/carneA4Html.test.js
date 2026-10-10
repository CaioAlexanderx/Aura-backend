// ============================================================
// Carnê de crediário em A4 — utils/buildCarneA4Html.js (10/10/2026)
//
// O que estes testes travam:
//   1. marca da LOJA no topo (logo da vitrine > logo da empresa > iniciais),
//      cor da marca validada, Aura só no rodapé;
//   2. com Pix: um QR por parcela A PAGAR e nenhum para parcela paga;
//      sem Pix: nenhum QR, nenhum copia-e-cola, cupom de duas colunas;
//   3. parcela cancelada fora do papel e fora do resumo;
//   4. Comprou = Já pagou + Falta pagar, e Falta pagar = soma dos cupons;
//   5. todo texto do banco escapado;
//   6. geometria A4 (182mm + 2 x 14mm), cupom que não parte entre páginas.
// ============================================================
const { buildStaticBrCode } = require('../../src/services/staticPixService');
const {
  buildCarneA4Html,
  classifyInstallments,
  summarize,
  formatDocumento,
  formatVencimento,
} = require('../../src/utils/buildCarneA4Html');

const company = {
  trade_name: 'MH Alimentos',
  legal_name: 'MH Comercio de Alimentos LTDA',
  cnpj: '12345678000190',
  phone: '(91) 90000-0000',
  logo_url: 'https://r2.exemplo/logo-empresa.png',
  address_street: 'Rua das Palmeiras',
  address_number: '120',
  address_district: 'Centro',
  address_city: 'Belém',
  address_state: 'PA',
};
const customer = { name: 'Alexander Olivier', phone: '(91) 98888-0000', cpf_cnpj: '12345678901' };

const pix = (valor, id) => buildStaticBrCode({
  pixKey: 'loja@exemplo.com.br',
  amount: valor,
  beneficiaryName: 'MH ALIMENTOS',
  beneficiaryCity: 'BELEM',
  txid: `CRED${id}`,
});

function parcela(n, extra = {}) {
  return {
    id: `0000000${n}`,
    installment_number: n,
    total_installments: 5,
    amount_due: '185.00',
    covered_amount: '0',
    due_date_br: `10/${String(n + 9).padStart(2, '0')}/2026`,
    status: 'pending',
    past_due: false,
    paid_at: null,
    pix_payload: null,
    ...extra,
  };
}

// 2 pagas, 3 a pagar (a 3ª com abatimento parcial), 1 cancelada.
function grupo({ comPix = true, extra = {} } = {}) {
  const abertas = [
    parcela(3, { covered_amount: '85.00', past_due: true }), // resta 100
    parcela(4),
    parcela(5),
  ].map(p => ({
    ...p,
    pix_payload: comPix ? pix(parseFloat(p.amount_due) - parseFloat(p.covered_amount), p.id) : null,
  }));
  return {
    key: '__none__',
    name: 'Sem carnê',
    closed: false,
    installments: [
      parcela(1, { status: 'paid', covered_amount: '185.00', paid_at: '2026-10-08T14:00:00Z' }),
      parcela(2, { status: 'paid', covered_amount: '185.00', paid_at: '2026-10-09T02:30:00Z' }),
      ...abertas,
      parcela(9, { status: 'cancelled', amount_due: '7777.00', due_date_br: '31/12/2030' }),
    ],
    purchases: {
      total: 280,
      lines: [
        { date: '2026-09-13T15:00:00Z', description: 'Vans Hylane 40/41', quantity: 1, amount: 120 },
        { date: '2026-09-13T15:00:00Z', description: 'Slide Alta 40/41', quantity: 2, amount: 160 },
      ],
    },
    ...extra,
  };
}

const build = (args = {}) => buildCarneA4Html({
  company, customer, groups: [grupo()], now: new Date('2026-10-10T17:32:00Z'), ...args,
});

const css = (html) => (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const corpo = (html) => html.slice(html.indexOf('<body>'));
const contar = (html, re) => (html.match(re) || []).length;
const qrs = (html) => contar(corpo(html), /<svg\b/g);

describe('Carnê A4 — marca da loja', () => {
  test('nome fantasia, endereço, telefone e CNPJ formatado no cabeçalho', () => {
    const html = build();
    expect(html).toContain('<div class="name">MH Alimentos</div>');
    expect(html).toContain('Rua das Palmeiras, 120 — Centro — Belém/PA');
    expect(html).toContain('(91) 90000-0000');
    expect(html).toContain('CNPJ 12.345.678/0001-90');
    expect(html).toContain('Emitido em 10/10/2026');
  });

  test('logo da vitrine tem precedência sobre o da empresa', () => {
    const html = build({ brand: { logo_url: 'https://r2.exemplo/logo-vitrine.png', primary_color: '#EF4444' } });
    expect(html).toContain('logo-vitrine.png');
    expect(html).not.toContain('logo-empresa.png');
    expect(css(html)).toContain('#EF4444');
  });

  test('sem logo nenhum, cai nas iniciais', () => {
    const html = build({ company: { ...company, logo_url: null } });
    expect(html).toContain('logo-fb');
    expect(html).toContain('>MA<');
    expect(html).not.toContain('<img');
  });

  test('sem nome fantasia, usa a razão social', () => {
    const html = build({ company: { ...company, trade_name: null } });
    expect(html).toContain('<div class="name">MH Comercio de Alimentos LTDA</div>');
  });

  test('sem rua cadastrada, usa o endereço em texto livre', () => {
    const html = build({
      company: { ...company, address_street: null, address_number: null, address_district: null, address: 'Tv. Um, 10 - Marco, Belém - PA' },
    });
    expect(html).toContain('Tv. Um, 10 - Marco, Belém - PA');
  });

  test('cor inválida não vaza para o CSS e cai no neutro', () => {
    const html = build({ brand: { primary_color: 'red;}body{display:none' } });
    expect(html).not.toContain('body{display:none');
    expect(css(html)).toContain('#1f2937');
  });

  test('Aura aparece só no rodapé', () => {
    const html = build();
    const c = corpo(html);
    expect(c.indexOf('Aura')).toBeGreaterThan(c.indexOf('class="foot"'));
    expect(c).toContain('Powered by Aura');
  });
});

describe('Carnê A4 — cliente e resumo', () => {
  test('nome, telefone e CPF formatado', () => {
    const html = build();
    expect(html).toContain('<div class="v">Alexander Olivier</div>');
    expect(html).toContain('(91) 98888-0000');
    expect(html).toContain('CPF 123.456.789-01');
  });

  test('Comprou = Já pagou + Falta pagar, e Falta pagar = soma dos cupons', () => {
    const html = build();
    // 5 parcelas vivas de 185 = 925; falta 100 + 185 + 185 = 470; pagou 455.
    expect(html).toMatch(/Comprou<\/div><div class="n">R\$ 925,00</);
    expect(html).toMatch(/Já pagou<\/div><div class="n">R\$ 455,00</);
    expect(html).toMatch(/Falta pagar<\/div><div class="n">R\$ 470,00</);

    const cupons = [...html.matchAll(/<span class="val">R\$ ([\d.,]+)<\/span>/g)]
      .map(m => parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
    expect(cupons).toEqual([100, 185, 185]);
    expect(cupons.reduce((a, b) => a + b, 0)).toBe(470);
  });

  test('summarize fecha mesmo com centavos quebrados', () => {
    const r = summarize([{
      installments: [
        { amount_due: '33.34', covered_amount: '33.34', status: 'paid' },
        { amount_due: '33.33', covered_amount: '10.01', status: 'pending' },
        { amount_due: '33.33', covered_amount: '0', status: 'pending' },
        { amount_due: '500.00', covered_amount: '0', status: 'cancelled' },
      ],
    }]);
    expect(r).toEqual({ comprou: 100, pagou: 43.35, falta: 56.65 });
    expect(Math.round((r.pagou + r.falta) * 100) / 100).toBe(r.comprou);
  });
});

describe('Carnê A4 — compras e parcelas', () => {
  test('lista "O que foi comprado" com data em São Paulo, quantidade e valor', () => {
    const html = build();
    expect(html).toContain('<h2>O que foi comprado</h2>');
    expect(html).toContain('<td class="nw">13/09/2026</td><td>Slide Alta 40/41</td><td class="r">2</td><td class="r">R$ 160,00</td>');
  });

  test('sem compras para o grupo, o bloco não aparece', () => {
    const html = build({ groups: [grupo({ extra: { purchases: null } })] });
    expect(html).not.toContain('O que foi comprado');
  });

  test('parcelas pagas trazem vencimento e "pago em" no fuso de São Paulo', () => {
    const html = build();
    expect(html).toContain('<td>1/5</td><td>10/10/2026</td><td>08/10/2026</td><td class="r">R$ 185,00</td>');
    // 09/10 02:30 UTC ainda é dia 08 em São Paulo.
    expect(html).toContain('<td>2/5</td><td>10/11/2026</td><td>08/10/2026</td>');
  });

  test('grupo sem parcela paga diz "Nenhuma parcela paga"', () => {
    const g = grupo();
    g.installments = g.installments.filter(i => i.status !== 'paid');
    expect(build({ groups: [g] })).toContain('Nenhuma parcela paga.');
  });

  test('parcela cancelada não aparece em lugar nenhum', () => {
    const html = build();
    expect(html).not.toContain('7.777,00');
    expect(html).not.toContain('31/12/2030');
    expect(html).not.toContain('9/5');
  });

  test('cada parcela a pagar é um cupom com canhoto "Via da loja"', () => {
    const html = build();
    expect(contar(corpo(html), /<div class="slip/g)).toBe(3);
    expect(contar(corpo(html), /Via da loja/g)).toBe(3);
    expect(html).toContain('Recebido em ___/___/___');
  });

  test('selo "Em atraso" só na parcela vencida', () => {
    const html = build();
    expect(contar(corpo(html), /class="late"/g)).toBe(1);
    expect(html).toMatch(/Parcela 3\/5<span class="late">Em atraso<\/span>/);
  });

  test('parcela com abatimento mostra o valor cheio e o já pago', () => {
    expect(build()).toContain('Parcela de R$ 185,00 &middot; já pago R$ 85,00');
  });

  test('título do carnê só aparece quando há mais de um', () => {
    expect(build()).not.toContain('class="grp"');
    const dois = build({
      groups: [
        grupo({ extra: { key: 'a', name: 'Carnê de setembro' } }),
        grupo({ extra: { key: 'b', name: 'Carnê antigo', closed: true } }),
      ],
    });
    expect(contar(corpo(dois), /class="grp"/g)).toBe(2);
    expect(dois).toContain('Carnê de setembro');
    expect(dois).toContain('Carnê antigo (encerrado)');
    expect(dois).toMatch(/Comprou<\/div><div class="n">R\$ 1\.850,00</);
  });

  test('carnê avulso: nome no cabeçalho e resumo só dele', () => {
    const html = build({ carneName: 'Compra de 13/09' });
    expect(html).toContain('<div class="cn">Compra de 13/09</div>');
    expect(html).toMatch(/Falta pagar<\/div><div class="n">R\$ 470,00</);
  });

  test('sem parcela nenhuma: documento sai, com aviso e resumo zerado', () => {
    const html = build({ groups: [] });
    expect(html).toContain('Nenhuma parcela registrada.');
    expect(html).toMatch(/Falta pagar<\/div><div class="n">R\$ 0,00</);
  });
});

describe('Carnê A4 — Pix', () => {
  test('com Pix: um QR por parcela a pagar, nenhum para parcela paga', () => {
    const g = grupo();
    // Mesmo que um payload chegue por engano numa parcela paga, ela não ganha QR.
    g.installments[0].pix_payload = pix(185, 'paga');
    const html = build({ groups: [g] });
    expect(qrs(html)).toBe(3);
    expect(contar(corpo(html), /Pix copia e cola/g)).toBe(3);
    expect(contar(corpo(html), /class="qr"/g)).toBe(3);
    // O QR vive dentro do cupom, nunca na tabela de pagas.
    const pagas = html.slice(html.indexOf('<h2>Parcelas pagas</h2>'), html.indexOf('<h2>Parcelas a pagar</h2>'));
    expect(pagas).not.toContain('<svg');
  });

  test('o copia-e-cola impresso é exatamente o payload recebido', () => {
    const g = grupo();
    const html = build({ groups: [g] });
    for (const i of g.installments.filter(x => x.pix_payload && x.status !== 'paid')) {
      expect(html).toContain(`<div class="emv">${i.pix_payload}</div>`);
    }
    // Valor do Pix da parcela com abatimento = principal restante (100,00).
    expect(g.installments[2].pix_payload).toContain('5406100.00');
  });

  test('sem Pix: nenhum QR, nenhum copia-e-cola, cupom de duas colunas', () => {
    const html = build({ groups: [grupo({ comPix: false })] });
    expect(qrs(html)).toBe(0);
    expect(corpo(html)).not.toContain('Pix copia e cola');
    expect(corpo(html)).not.toContain('class="qr"');
    expect(corpo(html)).not.toContain('class="emv"');
    expect(contar(corpo(html), /class="slip sem-pix"/g)).toBe(3);
    expect(html).not.toContain('O pagamento por Pix é confirmado pela loja');
    // Os cupons continuam lá, com valor e vencimento.
    expect(contar(corpo(html), /Via da loja/g)).toBe(3);
  });

  test('com Pix, o rodapé avisa que a loja confirma o pagamento', () => {
    expect(build()).toContain('O pagamento por Pix é confirmado pela loja.');
    expect(build()).toContain('multa e juros calculados no dia do pagamento');
  });
});

describe('Carnê A4 — escape de HTML', () => {
  const XSS = '<script>alert(1)</script>';

  test('nome do cliente', () => {
    const html = build({ customer: { ...customer, name: `Ana ${XSS} "Silva"` } });
    expect(html).not.toContain(XSS);
    expect(html).toContain('Ana &lt;script&gt;alert(1)&lt;/script&gt; &quot;Silva&quot;');
  });

  test('nome do produto e descrição de lançamento manual', () => {
    const g = grupo();
    g.purchases.lines = [
      { date: '2026-09-13T15:00:00Z', description: `Tenis ${XSS}`, quantity: 1, amount: 10 },
      { date: '2026-09-14T15:00:00Z', description: '<img src=x onerror=alert(1)>', quantity: null, amount: 5 },
    ];
    const html = build({ groups: [g] });
    expect(html).not.toContain(XSS);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Tenis &lt;script&gt;');
  });

  test('loja, endereço, nome do carnê, logo e payload do Pix', () => {
    const g = grupo({ extra: { name: `Carne ${XSS}` } });
    g.installments[3].pix_payload = `000201"><b>x</b>`;
    const html = build({
      company: { ...company, trade_name: `Loja ${XSS}`, address_street: '<b>Rua</b>', logo_url: 'x" onerror="alert(1)' },
      groups: [g, grupo({ extra: { key: 'b', name: 'Outro' } })],
      carneName: XSS,
    });
    expect(html).not.toContain(XSS);
    expect(html).not.toContain('<b>Rua</b>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('src="x" onerror="alert(1)"');
  });

  test('o único <script> do documento é o da impressão automática', () => {
    const html = build({ customer: { ...customer, name: XSS } });
    expect(contar(html, /<script/g)).toBe(1);
    expect(contar(build({ customer: { ...customer, name: XSS }, autoprint: false }), /<script/g)).toBe(0);
  });
});

describe('Carnê A4 — geometria e impressão', () => {
  const html = build();

  test('página A4 com margem declarada e coluna de 182mm', () => {
    expect(css(html)).toContain('@page{size:A4;margin:14mm}');
    expect(css(html)).toContain('.page{width:182mm;');
    expect(182 + 14 * 2).toBe(210);
  });

  test('o print não redefine a largura da página', () => {
    const c = css(html);
    const print = c.slice(c.indexOf('@media print'));
    expect(print.slice(0, print.indexOf('}}'))).not.toMatch(/width\s*:/);
  });

  test('cupom não parte entre páginas e a cor da marca imprime', () => {
    expect(css(html)).toMatch(/\.slip\{[^}]*break-inside:avoid/);
    expect(css(html)).toContain('print-color-adjust:exact');
  });

  test('botão Imprimir na barra, que some no papel', () => {
    expect(html).toContain('<button onclick="window.print()">Imprimir</button>');
    expect(css(html)).toContain('.toolbar{display:none!important}');
  });

  test('exige company e customer', () => {
    expect(() => buildCarneA4Html({ customer })).toThrow('company');
    expect(() => buildCarneA4Html({ company })).toThrow('customer');
  });
});

describe('Carnê A4 — helpers', () => {
  test('classifyInstallments: paga, a pagar e cancelada', () => {
    const { paid, open } = classifyInstallments([
      { status: 'paid', amount_due: '10', covered_amount: '10' },
      { status: 'pending', amount_due: '10', covered_amount: '10' },      // quitada sem status
      { status: 'pending', amount_due: '10', covered_amount: '4', past_due: true },
      { status: 'overdue', amount_due: '10', covered_amount: '0' },       // sem past_due: usa o status
      { status: 'overdue', amount_due: '10', covered_amount: '0', past_due: false }, // status congelado
      { status: 'cancelled', amount_due: '10', covered_amount: '0' },
    ]);
    expect(paid).toHaveLength(2);
    expect(open.map(i => [i.remaining, i.late])).toEqual([[6, true], [10, true], [10, false]]);
  });

  test('formatDocumento', () => {
    expect(formatDocumento('12345678901')).toEqual({ rotulo: 'CPF', valor: '123.456.789-01' });
    expect(formatDocumento('12.345.678/0001-90')).toEqual({ rotulo: 'CNPJ', valor: '12.345.678/0001-90' });
    expect(formatDocumento('RG 123')).toEqual({ rotulo: 'CPF/CNPJ', valor: 'RG 123' });
  });

  test('formatVencimento não volta um dia (DATE não tem fuso)', () => {
    expect(formatVencimento({ due_date_br: '10/12/2026' })).toBe('10/12/2026');
    expect(formatVencimento({ due_date: '2026-12-10' })).toBe('10/12/2026');
    expect(formatVencimento({ due_date: new Date('2026-12-10T00:00:00Z') })).toBe('10/12/2026');
    expect(formatVencimento({})).toBe('—');
  });
});

describe('telefone com máscara', () => {
  test('cadastro só com dígitos sai formatado no cabeçalho e no cliente', () => {
    const html = buildCarneA4Html({
      company: { trade_name: 'Loja', phone: '6681573761' },
      customer: { name: 'Cliente', phone: '5566996456351' },
      groups: [],
    });
    expect(html).toContain('(66) 8157-3761');
    expect(html).toContain('(66) 99645-6351');
    expect(html).not.toContain('6681573761');
  });

  // 10/10/2026: a regex saiu como /D/g (sem a barra) — só tirava a letra "D".
  // Passava com cadastro só de dígitos e deixava cru o telefone já pontuado.
  test('cadastro já pontuado ou com +55 também sai na máscara', () => {
    const html = buildCarneA4Html({
      company: { trade_name: 'Loja', phone: '66 8157-3761' },
      customer: { name: 'Cliente', phone: '+55 (66) 9 9645-6351' },
      groups: [],
    });
    expect(html).toContain('(66) 8157-3761');
    expect(html).toContain('(66) 99645-6351');
  });
});
