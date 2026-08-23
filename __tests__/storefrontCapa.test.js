// Nomes reais de catalogo de lojista — e por isso que a regra existe.
const { iniciais, fonteClienteIniciais } = require('../src/templates/storefrontCapa');

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

describe('gradiente da capa', () => {
  const { gradienteDaCapa, fundoDaCapa } = require('../src/templates/storefrontCapa');

  test('deterministico — a loja nao pode piscar entre renders', () => {
    expect(gradienteDaCapa('Vestido longo')).toEqual(gradienteDaCapa('Vestido longo'));
  });

  test('nomes diferentes caem em degraus diferentes', () => {
    const a = gradienteDaCapa('Vestido longo drapeado Dayanna');
    const b = gradienteDaCapa('Vestido longo com detalhe no peito');
    expect(a).not.toEqual(b);
  });

  test('angulo NAO fica colado na intensidade', () => {
    // O multiplicador e impar, entao os bits BAIXOS do giro repetem os do
    // hash: lendo dali, o angulo seria funcao da intensidade e so 8 das 32
    // combinacoes existiriam. Este teste trava a leitura dos bits altos.
    const combos = new Set();
    for (let i = 0; i < 400; i++) {
      const g = gradienteDaCapa('Vestido longo modelo ' + i);
      combos.add(g.forca + '/' + g.angulo);
    }
    expect(combos.size).toBe(32);
  });

  test('distribui sem concentrar num degrau', () => {
    const conta = {};
    for (let i = 0; i < 400; i++) {
      const g = gradienteDaCapa('Produto ' + i);
      conta[g.forca] = (conta[g.forca] || 0) + 1;
    }
    // 400/8 = 50 por degrau; nenhum pode passar do dobro.
    for (const n of Object.values(conta)) expect(n).toBeLessThan(100);
  });

  test('sai CSS valido, sempre com a cor da loja', () => {
    const css = fundoDaCapa('Camiseta');
    expect(css).toMatch(/^linear-gradient\(\d+deg,/);
    expect(css).toContain('--sf-ph-from');
    expect(css).toContain('--sf-bg-card');
  });

  test('nome vazio nao quebra', () => {
    expect(fundoDaCapa('')).toMatch(/^linear-gradient/);
    expect(fundoDaCapa(null)).toMatch(/^linear-gradient/);
  });
});

describe('a serializacao sobrevive a instrumentacao', () => {
  const { fonteClienteIniciais } = require('../src/templates/storefrontCapa');

  test('o codigo enviado ao navegador nao cita contador de cobertura', () => {
    // Ver o cabecalho de storefrontCapa.js. Aqui o bug era LATENTE:
    // src/templates/** esta fora do collectCoverageFrom, entao passava
    // por sorte. Bastaria ampliar a cobertura pra loja quebrar em
    // producao sem ninguem entender por que.
    expect(fonteClienteIniciais()).not.toMatch(/\bcov_[a-z0-9]+\b/);
  });
});
