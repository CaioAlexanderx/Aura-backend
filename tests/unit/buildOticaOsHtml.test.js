// p-206 (23/11/2026): regras puras da folha A4 da OS de otica.
const {
  buildOticaOsHtml, calcularValores, textoDasParcelas, dataBR, formatCpf,
} = require('../../src/utils/buildOticaOsHtml');

const OS = {
  id: 'os-1', os_number: 7, kind: 'otica', customer_name: 'Cliente', created_at: '2026-11-17T17:00:00Z',
  estimated_amount: '180.00', deposit_sale_id: null, deposit_sale_total: null, sale_id: null,
  optical: { use: 'longe', lens: {}, frame: {}, prescription: { od: {}, oe: {} } },
};

describe('calcularValores', () => {
  test('com sinal: sinal = total - parcelas; restante = o que falta', () => {
    const v = calcularValores({
      os: { ...OS, deposit_sale_id: 's', deposit_sale_total: '180.00' },
      parcelas: [
        { amount_due: '40', covered_amount: '40', status: 'paid' },
        { amount_due: '40', covered_amount: '10', status: 'pending' },
        { amount_due: '99', covered_amount: '0', status: 'cancelled' },
      ],
      formaDoSinal: 'pix',
    });
    expect(v).toMatchObject({ comSinal: true, total: 180, sinal: 100, restante: 30, saldoOriginal: 80 });
    expect(v.parcelas).toHaveLength(2);
  });

  test('sem sinal: tudo a pagar na retirada; com venda vinculada, pago na entrega', () => {
    expect(calcularValores({ os: OS })).toMatchObject({ comSinal: false, total: 180, restante: 180, pagoNaEntrega: false });
    expect(calcularValores({ os: { ...OS, sale_id: 'v' } })).toMatchObject({ restante: 0, pagoNaEntrega: true });
  });
});

test('textoDasParcelas', () => {
  expect(textoDasParcelas([{ valor: 40 }, { valor: 40 }])).toBe('2x R$ 40,00');
  expect(textoDasParcelas([{ valor: 26.66 }, { valor: 26.66 }, { valor: 26.68 }])).toBe('3x R$ 26,66 (última R$ 26,68)');
  expect(textoDasParcelas([])).toBe('');
});

test('dataBR: data sem hora nao cai no dia anterior', () => {
  expect(dataBR('2026-11-10')).toBe('10/11/2026');
  expect(dataBR(new Date(Date.UTC(2026, 10, 10)))).toBe('10/11/2026');
  expect(dataBR(null)).toBe('');
});

test('formatCpf', () => {
  expect(formatCpf('52998224725')).toBe('529.982.247-25');
});

test('folha: sem termos, sem quadro; vias invalidas caem nas duas', () => {
  const html = buildOticaOsHtml({ os: OS, company: { trade_name: 'Loja' }, vias: ['x'] });
  expect(html).not.toContain('TERMOS DA VENDA');
  expect(html).toContain('VIA DO LABORATÓRIO');
  expect(html).toContain('VIA DO CLIENTE');
  expect(html).toContain('sem sinal');
});

test('folha nunca leva texto juridico escrito pela Aura', () => {
  const html = buildOticaOsHtml({ os: OS, company: { trade_name: 'Loja' } });
  expect(html).not.toMatch(/C[óo]digo Civil|n[ãa]o admitem devolu/i);
});
