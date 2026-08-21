// Nomes reais de catalogo de lojista — e por isso que a regra existe.
const { iniciais, fonteClienteIniciais } = require('../src/templates/storefrontIniciais');

describe('iniciais da capa sem foto', () => {
  test('duas iniciais das palavras que informam', () => {
    expect(iniciais('Camiseta Basica Branca')).toBe('CB');
    expect(iniciais('Caneca Personalizada')).toBe('CP');
  });

  test('pula numero e medida — o problema que motivou a regra', () => {
    // Antes a loja mostrava "K" e "5": o primeiro caractere cru.
    expect(iniciais('KIT 3 PARES MEIA CANO LONGO')).toBe('KP');
    expect(iniciais('50 Sacolas Plastica com Alca')).toBe('SP');
    expect(iniciais('CALCA JEANS SKINNY 38x32')).toBe('CJ');
  });

  test('pula preposicao', () => {
    expect(iniciais('Xicara com pires')).toBe('XP');
    expect(iniciais('Kit de Canecas')).toBe('KC');
  });

  test('uma palavra so devolve uma letra', () => {
    expect(iniciais('Canecas')).toBe('C');
  });

  test('sem letra nenhuma nao quebra a grade', () => {
    expect(iniciais('123')).toBe('?');
    expect(iniciais('')).toBe('?');
    expect(iniciais(null)).toBe('?');
    expect(iniciais(undefined)).toBe('?');
  });

  test('acento e caixa preservam a inicial certa', () => {
    expect(iniciais('Ágata do Norte')).toBe('ÁN');
    expect(iniciais('  ecobag  dupla  ')).toBe('ED');
  });
});

describe('fonteClienteIniciais', () => {
  // A loja comum roda no navegador: a funcao vai serializada pro <script>.
  // Se a serializacao perder a lista de palavras vazias, o resultado muda em
  // silencio — o teste executa o codigo gerado, nao so inspeciona o texto.
  const INICIAIS = new Function(fonteClienteIniciais() + 'return INICIAIS;')();

  test('o codigo gerado devolve o mesmo que o modulo', () => {
    for (const nome of ['KIT 3 PARES MEIA CANO LONGO', 'Xicara com pires', 'Canecas', '123', 'Ágata do Norte']) {
      expect(INICIAIS(nome)).toBe(iniciais(nome));
    }
  });
});
