// ============================================================
// Uma cor cheia por tela.
//
// A queixa foi que os controles "nao deixam clara a acao e parecem
// elementos flutuantes", e a direcao escolhida foi menos botoes, linha
// minimalista, referencia Oscar Calcados.
//
// A regra que saiu disso: PREENCHIMENTO SOLIDO DA MARCA E RESERVADO A
// ACAO PRINCIPAL. Categoria, pagina, busca, carrinho e o CTA do banner se
// distinguem por texto, regua e espaco.
//
// Este teste guarda a regra. Ele nao julga se ficou bonito — ele impede
// que a proxima feature adicione mais uma pilula preenchida sem que
// alguem tenha decidido isso.
// ============================================================
const buildStyles = require('../src/templates/storefrontStyles');

const css = buildStyles('#7C3AED', '#7C3AED', false, 'classic');

/** Todo seletor cuja declaracao preenche com a cor da marca. */
function seletoresPreenchidos() {
  const achados = [];
  const re = /(^|\n)([^\n{]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const seletor = m[2].trim();
    const corpo = m[3];
    if (/background:var\(--sf-brand\)[;}]/.test(corpo)) achados.push(seletor);
  }
  return achados;
}

// Cada um destes tem um motivo, e o motivo esta escrito aqui — nao no
// commit, que ninguem le depois.
const PODEM_SER_PREENCHIDOS = {
  '.topbar-logo': 'fundo do logo quando a loja nao subiu imagem — nao e controle',
  '.hero-card-logo': 'idem, no cabecalho grande',
  '.qty-btn': 'mais/menos dentro do carrinho, ja no fluxo de compra',
  '.checkout-btn': 'ACAO PRINCIPAL do carrinho',
  '.next-btn': 'ACAO PRINCIPAL de cada passo do checkout',
  '.step-dot.done': 'indicador de progresso, nao clicavel',
  '.delivery-opt.active .delivery-opt-radio': 'radio marcado — estado, nao acao',
  '.op-chip.sel': 'tamanho escolhido na pagina do produto — estado',
  '.pd-comprar': 'ACAO PRINCIPAL da loja inteira',
};

describe('preenchimento solido e reservado', () => {
  test('nenhum controle novo se preenche sem justificativa', () => {
    const inesperados = seletoresPreenchidos().filter(
      (s) => !Object.prototype.hasOwnProperty.call(PODEM_SER_PREENCHIDOS, s),
    );
    // Se este teste quebrou num PR novo: ou o controle nao devia ser
    // preenchido, ou ele devia — e nesse caso entra na lista ACIMA com o
    // motivo escrito.
    expect(inesperados).toEqual([]);
  });

  test('so UMA acao solida na jornada de navegacao', () => {
    // Categoria, pagina e CTA do banner sairam do preenchimento. Se algum
    // voltar, a hierarquia se perde: quando tudo grita, nada e principal.
    for (const morto of ['.cat-chip.active', '.pg-atual', '.banner-cta']) {
      const i = css.indexOf(morto + '{');
      expect(i).toBeGreaterThan(0);
      const decl = css.slice(i, css.indexOf('}', i));
      expect(decl).not.toContain('background:var(--sf-brand)');
    }
  });
});

describe('nada levanta no hover', () => {
  test('nenhum controle sobe ao passar o mouse', () => {
    // "Parecem elementos flutuantes" vinha literalmente disto: cartao,
    // banner-cta e os dois botoes do produto subiam 1-2px no hover. O que
    // se move agora e a foto DENTRO da moldura e a seta DENTRO do link —
    // o layout fica parado.
    const re = /([^\n{]+):hover[^{]*\{([^}]*)\}/g;
    const levantam = [];
    let m;
    while ((m = re.exec(css))) {
      if (/transform:translateY\(-/.test(m[2])) levantam.push(m[1].trim());
    }
    expect(levantam).toEqual([]);
  });

  test('a foto do produto responde no lugar do cartao', () => {
    expect(css).toContain('.product-card:hover .product-img img{transform:scale(');
    // E ela precisa de transicao, senao o crescimento e um salto.
    // O \n ancora a regra BASE: sem ele o indexOf casa primeiro com a
    // regra de hover, que contem a mesma substring.
    const i = css.indexOf('\n.product-img img{');
    expect(css.slice(i, css.indexOf('}', i))).toContain('transition:transform');
  });
});

describe('cabecalho e categorias sem caixa', () => {
  test('busca e carrinho perderam o anel', () => {
    for (const sel of ['.search-btn', '.cart-btn']) {
      const i = css.indexOf(sel + '{');
      const decl = css.slice(i, css.indexOf('}', i));
      expect(decl).toContain('border:0');
      expect(decl).not.toContain('border-radius:999px');
    }
  });

  test('a categoria selecionada se marca por regua', () => {
    const i = css.indexOf('.cat-chip.active{');
    expect(css.slice(i, css.indexOf('}', i))).toContain('border-bottom-color:var(--sf-brand)');
  });

  test('a pagina atual tambem', () => {
    const i = css.indexOf('.pg-atual{');
    expect(css.slice(i, css.indexOf('}', i))).toContain('border-bottom-color:var(--sf-brand)');
  });
});

describe('CSS orfao', () => {
  test('o botao "+" do cartao saiu do CSS junto com o markup', () => {
    // Ele foi removido do cartao quando a pagina de produto virou o
    // destino do clique. A regra ficou no arquivo por dois commits.
    expect(css).not.toContain('.add-btn');
  });
});

// ============================================================
// O contraste que a caixa escondia.
//
// Enquanto categoria e paginacao eram chips com borda, a borda carregava
// a leitura e o texto podia ser fraco. Tirando a caixa, o texto passou a
// ser TUDO que existe — e o tom que estava la (ink-3) da 2.91:1 sobre o
// fundo da loja, abaixo do minimo de 4.5:1 da WCAG AA.
//
// Peguei isso medindo no navegador depois da mudanca, nao antes. Este
// teste existe pra que a proxima simplificacao nao repita: sempre que um
// controle perde o fundo, o texto precisa subir de tom.
// ============================================================
function corDaVar(nome) {
  // Le a definicao do bloco CLARO (o primeiro :root do arquivo).
  const i = css.indexOf(nome + ':');
  const valor = css.slice(i + nome.length + 1, css.indexOf(';', i)).trim();
  const n = valor.match(/[\d.]+/g).map(Number);
  if (valor.startsWith('#')) {
    const h = valor.slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
}

function contraste(frente, fundo) {
  const lum = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const a = frente[3];
  const c = [0, 1, 2].map((k) => frente[k] * a + fundo[k] * (1 - a));
  const L1 = lum(c[0], c[1], c[2]);
  const L2 = lum(fundo[0], fundo[1], fundo[2]);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

describe('quem perdeu a caixa nao pode perder o contraste', () => {
  const fundo = corDaVar('--sf-bg');

  test('ink-3 NAO passa — e por isso que ninguem usa ele em controle', () => {
    // A medicao que motivou a correcao. Se um dia ink-3 passar a passar,
    // este teste avisa que a premissa mudou.
    expect(contraste(corDaVar('--sf-ink-3'), fundo)).toBeLessThan(4.5);
  });

  test('ink-2 passa em AA', () => {
    expect(contraste(corDaVar('--sf-ink-2'), fundo)).toBeGreaterThanOrEqual(4.5);
  });

  test('categoria, pagina e setas usam ink-2', () => {
    for (const sel of ['.cat-chip,.cat-todas', '.pg-num,.pg-seta']) {
      const i = css.indexOf(sel + '{');
      expect(i).toBeGreaterThan(0);
      const decl = css.slice(i, css.indexOf('}', i));
      expect(decl).toContain('color:var(--sf-ink-2)');
      expect(decl).not.toContain('color:var(--sf-ink-3)');
    }
  });

  test('a ativa continua bem separada da inativa', () => {
    // Passar em contraste nao pode custar a hierarquia: se as duas ficam
    // parecidas, a pessoa perde de vista em que categoria esta.
    const inativa = contraste(corDaVar('--sf-ink-2'), fundo);
    const ativa = contraste(corDaVar('--sf-ink'), fundo);
    expect(ativa / inativa).toBeGreaterThan(2);
  });
});

describe('a barra de categorias mede em vez de estimar', () => {
  const catsJs = require('fs').readFileSync(
    require('path').join(__dirname, '../src/templates/storefront/parts/categorias.js'), 'utf8',
  );

  test('re-mede quando a fonte da loja carrega', () => {
    // O primeiro desenho acontece na fonte de fallback. Quando a fonte
    // real entra, os nomes mudam de largura e a barra pode passar a
    // quebrar sem que ninguem tenha redimensionado nada — nenhum evento
    // de resize dispara nesse caso.
    expect(catsJs).toContain('document.fonts.ready');
  });

  test('o resize nao remede mais de uma vez por quadro', () => {
    // Cada render agora forca reflow por chip removido. Resize dispara
    // dezenas de vezes por segundo; sem agrupar, a barra engasgaria
    // enquanto a pessoa arrasta a janela.
    const i = catsJs.indexOf("addEventListener('resize'");
    const bloco = catsJs.slice(i, i + 320);
    expect(bloco).toContain('requestAnimationFrame');
  });
});
