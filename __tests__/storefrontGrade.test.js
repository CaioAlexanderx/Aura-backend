// A grade da loja comum roda no NAVEGADOR, dentro de um template literal.
// Testar o texto do template nao pega nada: o bug classico daqui e a barra
// invertida que some (CLAUDE.md, armadilha 8) e transforma /\s+/ em /s+/.
// Entao estes testes EXECUTAM o codigo que a pagina vai receber.
const buildScript = require('../src/templates/storefront/index');

function carregarDaPagina(nomes) {
  const s = buildScript({ products: [], categories: [] }, 'loja', '');
  const corpo = nomes
    .map((n) => {
      const m = s.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
      if (!m) throw new Error('funcao ausente no <script>: ' + n);
      return m[0];
    })
    .join('\n');
  return corpo;
}

describe('busca da grade', () => {
  const f = new Function(
    carregarDaPagina(['normalizarBusca', 'casaBusca']) +
      '\nreturn { normalizarBusca, casaBusca };',
  )();

  test('ignora acento nos dois lados', () => {
    expect(f.casaBusca('vestido', 'Vestído longo')).toBe(true);
    expect(f.casaBusca('acucar', 'Açúcar mascavo')).toBe(true);
  });

  test('termos em qualquer ordem', () => {
    // Esta e a asserção que pega o \\s comido: com split(/s+/) os termos
    // quebram em cada letra "s" e a busca passa a nao achar nada.
    expect(f.casaBusca('longo vestido', 'Vestido longo drapeado')).toBe(true);
    expect(f.casaBusca('  vestido   longo  ', 'Vestido longo')).toBe(true);
  });

  test('termo ausente reprova', () => {
    expect(f.casaBusca('saia', 'Vestido longo')).toBe(false);
    expect(f.casaBusca('vestido curto', 'Vestido longo')).toBe(false);
  });

  test('busca vazia passa tudo', () => {
    expect(f.casaBusca('', 'qualquer')).toBe(true);
    expect(f.casaBusca('   ', 'qualquer')).toBe(true);
  });
});

describe('ordenacao da grade', () => {
  const monta = (ordem) =>
    new Function(
      'var ordem=' + JSON.stringify(ordem) + ';\n' +
        carregarDaPagina(['ordenarProdutos']) +
        '\nreturn ordenarProdutos;',
    )();

  const lista = [
    { name: 'Camiseta', price: 50, created_at: '2026-01-02' },
    { name: 'Almofada', price: 30, created_at: '2026-03-01' },
    { name: 'Boné', price: 90, created_at: '2026-02-01' },
  ];

  test('destaque preserva a ordem do servidor', () => {
    expect(monta('destaque')(lista).map((p) => p.name)).toEqual(['Camiseta', 'Almofada', 'Boné']);
  });

  test('preco sobe e desce', () => {
    expect(monta('preco_asc')(lista).map((p) => p.price)).toEqual([30, 50, 90]);
    expect(monta('preco_desc')(lista).map((p) => p.price)).toEqual([90, 50, 30]);
  });

  test('nome respeita acento do portugues', () => {
    expect(monta('nome')(lista).map((p) => p.name)).toEqual(['Almofada', 'Boné', 'Camiseta']);
  });

  test('novidades poe a mais recente primeiro', () => {
    expect(monta('novidades')(lista).map((p) => p.name)).toEqual(['Almofada', 'Boné', 'Camiseta']);
  });

  test('nao muta a lista recebida', () => {
    const orig = lista.map((p) => p.name);
    monta('preco_asc')(lista);
    expect(lista.map((p) => p.name)).toEqual(orig);
  });
});

describe('rodape da grade — sem teto silencioso', () => {
  function rodape(visiveis, filtrados, faltam) {
    let texto = null;
    let escondido = null;
    const el = {
      set hidden(v) { escondido = v; },
      get hidden() { return escondido; },
      set innerHTML(v) { texto = v; },
    };
    const fn = new Function(
      'document',
      carregarDaPagina(['atualizarRodapeDaGrade']) + '\nreturn atualizarRodapeDaGrade;',
    )({ getElementById: () => el });
    fn(visiveis, filtrados, faltam);
    return { texto, escondido };
  }

  test('avisa que ha mais para rolar', () => {
    expect(rodape(60, 410, 0).texto).toContain('Mostrando 60 de 410');
  });

  test('oferece BOTAO enquanto ha mais para ver', () => {
    // Rolagem infinita sozinha deixa quem navega por teclado sem acesso ao
    // resto do catalogo: o foco nunca chega ao fim pra disparar a sentinela,
    // e o rodape fica inalcancavel.
    const html = rodape(60, 410, 0).texto;
    expect(html).toContain('<button');
    expect(html).toContain('verMais()');
  });

  test('sem botao quando a grade ja mostrou tudo', () => {
    expect(rodape(410, 410, 802).texto).not.toContain('<button');
  });

  test('avisa o catalogo que nao coube — o caso Finesse', () => {
    // 1302 no catalogo, 500 no payload: 802 sumiam sem uma palavra.
    expect(rodape(500, 500, 802).texto).toContain('Mais 802 produtos');
  });

  test('some quando nao ha nada a dizer', () => {
    expect(rodape(12, 12, 0).escondido).toBe(true);
  });
});
