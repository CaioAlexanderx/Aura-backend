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

describe('elevacao no hover: so o clicavel, e sempre com a sombra da marca', () => {
  // REVISTO em 02/09/2026. A regra de 24/08 era "nada levanta"; Caio
  // considerou a decisao errada — o aplicativo inteiro usa elevacao e
  // sombra — e o redesign (Claude Design) traz o cartao subindo 3px e o
  // botao 2px. O que fica de guardrail e a DISCIPLINA: quem sobe e
  // clicavel, sobe pelos tokens (--sf-lift / --sf-lift-2) e sobe com
  // --sf-shadow-hover. Um pixel solto ou uma sombra inventada por regra e
  // como a loja volta a parecer "solta".
  const re = /([^\n{]+):hover[^{]*\{([^}]*)\}/g;
  const levantam = [];
  let m;
  while ((m = re.exec(css))) {
    if (/transform:translateY\(/.test(m[2])) levantam.push({ sel: m[1].trim(), decl: m[2] });
  }

  test('quem sobe, sobe pelo token — nunca por pixel solto', () => {
    for (const { sel, decl } of levantam) {
      expect({ sel, ok: /translateY\(var\(--sf-lift(-2)?\)\)/.test(decl) }).toEqual({ sel, ok: true });
    }
  });

  test('quem sobe leva a sombra da marca junto', () => {
    for (const { sel, decl } of levantam) {
      // O cartao poe a sombra na moldura da foto, numa regra irma.
      const comSombra = decl.includes('var(--sf-shadow-hover)')
        || css.includes(sel + ':hover .product-img{box-shadow:var(--sf-shadow-hover)');
      expect({ sel, comSombra }).toEqual({ sel, comSombra: true });
    }
  });

  test('so o que e clicavel sobe', () => {
    const clicaveis = ['.product-card', '.checkout-btn', '.next-btn', '.pd-comprar', '.pd-add', '.banner-cta', '.tira-cat', '.whatsapp-cta', '.home-cat', '.home-linha', '.pg-num', '.pg-seta'];
    for (const { sel } of levantam) {
      const base = sel.replace(/:hover.*$/, '').replace(/:not\([^)]*\)/g, '').trim();
      expect({ sel, clicavel: clicaveis.includes(base) }).toEqual({ sel, clicavel: true });
    }
  });

  test('o cartao de produto e o primeiro a subir', () => {
    expect(levantam.map((l) => l.sel)).toContain('.product-card');
    // E precisa de transicao, senao a subida e um salto.
    const i = css.indexOf('\n.product-card{');
    expect(css.slice(i, css.indexOf('}', i))).toContain('transition:transform');
  });

  test('com movimento reduzido, nada sobe', () => {
    const i = css.indexOf('prefers-reduced-motion: reduce');
    const bloco = css.slice(i);
    for (const { sel } of levantam) {
      expect(bloco).toContain(sel.split(' ')[0]);
    }
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

// ============================================================
// Micro-interacoes: um sinal por acao, e nenhum movimento pra quem pediu
// pra parar de mexer.
// ============================================================
describe('quem pediu pra parar de mexer', () => {
  test('a loja respeita prefers-reduced-motion', () => {
    // "Reduzir movimento" e opcao do sistema, e quem liga costuma ter um
    // motivo fisico. A loja nao tinha esse bloco: foto que cresce, badge
    // que pulsa e toast que sobe rodavam igual pra todo mundo.
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('para o movimento sem apagar o feedback', () => {
    const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
    // O bloco vai ate o fim da folha; pego o suficiente pra cobrir ele.
    const bloco = css.slice(i);
    // Movimento morre...
    expect(bloco).toContain('transform:none !important');
    expect(bloco).toContain('.pulse{animation:none !important;}');
    // ...mas a opacidade continua, senao a grade deixa de avisar que
    // esta carregando e o botao deixa de confirmar o clique.
    expect(bloco).toContain('transition-property:opacity !important');
  });

  test('a transicao curta nao vira zero na grade', () => {
    // Uma regra generica de 0.01ms apagaria o fade da grade junto. A
    // excecao devolve uma duracao curta, mas perceptivel.
    const bloco = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    const m = bloco.match(/\.products-grid\{[^}]*transition-duration:(\d+)ms/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(0);
  });
});

describe('um sinal por acao', () => {
  const pd = require('fs').readFileSync(
    require('path').join(__dirname, '../src/templates/storefront/parts/product_detail.js'), 'utf8',
  );
  const cart = require('fs').readFileSync(
    require('path').join(__dirname, '../src/templates/storefront/parts/cart.js'), 'utf8',
  );

  test('a pagina do produto nao mostra toast — o botao ja confirma', () => {
    // Rotulo + toast + badge sao tres avisos da mesma coisa, e os olhos
    // da pessoa estao no botao que ela acabou de clicar.
    expect(pd).toContain('semToast:true');
    expect(cart).toContain('if(!opcoes.semToast) showToast');
  });

  test('o badge pulsa MESMO sem toast', () => {
    // Ele e o unico sinal de que o carrinho cresceu, e fica no cabecalho,
    // longe de onde a pessoa clicou.
    const i = cart.indexOf("getElementById('cartBadge')");
    const j = cart.indexOf('if(!opcoes.semToast)');
    expect(i).toBeGreaterThan(0);
    // O pulso vem ANTES da checagem do toast, logo nao depende dela.
    expect(i).toBeLessThan(j);
  });

  test('clicar duas vezes nao prende o rotulo do botao', () => {
    // O bug: o rotulo original era lido de textContent no clique. O
    // segundo clique dentro da janela lia "Adicionado" como original e o
    // botao ficava preso nesse texto pra sempre.
    expect(pd).toContain('b.dataset.rotulo');
    expect(pd).toContain('clearTimeout(voltarRotulo)');
    expect(pd).not.toMatch(/var antes\s*=\s*b\.textContent/);
  });
});

describe('trocar de pagina nao pisca', () => {
  const prods = require('fs').readFileSync(
    require('path').join(__dirname, '../src/templates/storefront/parts/products.js'), 'utf8',
  );

  test('o estado de carregando tem duracao minima', () => {
    // Resposta em 40ms apagava e reacendia a grade rapido demais pra ler
    // como "carregou" — lia como a tela piscando.
    expect(prods).toContain('MINIMO_CARREGANDO');
    const m = prods.match(/MINIMO_CARREGANDO\s*=\s*(\d+)/);
    expect(Number(m[1])).toBeGreaterThanOrEqual(150);
  });

  test('a grade tem transicao de opacidade', () => {
    const i = css.indexOf('.products-grid{');
    expect(css.slice(i, css.indexOf('}', i))).toContain('transition:opacity');
  });
});
