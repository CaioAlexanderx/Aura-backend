const { parcelasDoPreco, textoDeParcelamento, PARCELA_MINIMA } = require('../src/services/parcelamento');

describe('parcelamento na loja', () => {
  test('divide ate o teto declarado pela lojista', () => {
    const r = parcelasDoPreco(159.9, 3);
    expect(r.vezes).toBe(3);
    // 159.9/3 da 53.300000000000004 em ponto flutuante — o que a loja
    // mostra e o texto formatado, e e ele que precisa estar certo.
    expect(r.valor).toBeCloseTo(53.3, 2);
    expect(textoDeParcelamento(159.9, 3)).toBe('ou 3x de R$ 53,30 sem juros');
  });

  test('o piso por parcela manda quando o preco e baixo', () => {
    // Uma caneca de R$ 30 anunciando "12x de R$ 2,50" nao passa em
    // operadora nenhuma e faz a loja parecer desonesta.
    const r = parcelasDoPreco(30, 12);
    expect(r.vezes).toBe(6);
    expect(r.valor).toBe(5);
    expect(r.valor).toBeGreaterThanOrEqual(PARCELA_MINIMA);
  });

  test('preco que nao chega a duas parcelas nao mostra nada', () => {
    // R$ 9 em 2x seria R$ 4,50 — abaixo do piso.
    expect(parcelasDoPreco(9, 12)).toBeNull();
    expect(textoDeParcelamento(9, 12)).toBeNull();
  });

  test('nunca passa de 12, mesmo com teto maior', () => {
    expect(parcelasDoPreco(5000, 24).vezes).toBe(12);
  });

  test('sem teto configurado, nao mostra parcelamento', () => {
    // Comportamento de hoje: a loja mostra so o preco.
    expect(parcelasDoPreco(200, null)).toBeNull();
    expect(parcelasDoPreco(200, undefined)).toBeNull();
    expect(parcelasDoPreco(200, 0)).toBeNull();
    expect(parcelasDoPreco(200, 1)).toBeNull();
  });

  test('preco invalido nao quebra a pagina', () => {
    expect(parcelasDoPreco(0, 6)).toBeNull();
    expect(parcelasDoPreco(-10, 6)).toBeNull();
    expect(parcelasDoPreco(null, 6)).toBeNull();
    expect(parcelasDoPreco('abc', 6)).toBeNull();
  });

  test('aceita preco em texto, como vem do banco', () => {
    expect(parcelasDoPreco('159.90', 3).vezes).toBe(3);
  });

  test('formata em pt-BR, com virgula', () => {
    expect(textoDeParcelamento(100, 4)).toBe('ou 4x de R$ 25,00 sem juros');
  });
});

describe('codigo serializado para a loja comum', () => {
  const { fonteClienteParcelamento } = require('../src/services/parcelamento');

  function noNavegador(teto) {
    return new Function(
      'var SETTINGS={card_max_installments:' + JSON.stringify(teto) + '};' +
        fonteClienteParcelamento() +
        'return PARCELAS_TXT;',
    )();
  }

  test('o codigo gerado devolve o mesmo que o modulo', () => {
    const f = noNavegador(3);
    expect(f(159.9)).toBe(textoDeParcelamento(159.9, 3));
    expect(f(30)).toBe(textoDeParcelamento(30, 3));
  });

  test('sem teto em SETTINGS, nao mostra nada', () => {
    expect(noNavegador(null)(200)).toBeNull();
  });

  test('le o teto de SETTINGS sem receber parametro', () => {
    // O markup do cartao chama PARCELAS_TXT(p.price) e mais nada; se a
    // leitura do SETTINGS quebrar, a loja para de mostrar parcela sem
    // erro nenhum.
    expect(noNavegador(6)(120)).toBe('ou 6x de R$ 20,00 sem juros');
  });
});
