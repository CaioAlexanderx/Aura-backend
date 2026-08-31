// ============================================================
// A tira de categorias desenhada na loja comum.
//
// O QUE ENTRA já foi decidido no servidor (tiraDeCategorias.js, com teste
// próprio). Aqui o que se guarda é o DESENHO e o comportamento:
//
//  • a tira não decide nada — só desenha o que veio
//  • clicar numa categoria NÃO rola a página. Levantado por Caio em
//    30/08 olhando a loja: a pessoa está usando o menu, clica, a página
//    desce e o menu sai da tela, interrompendo a navegação. A paginação
//    continua rolando, que é o certo pra ela.
//  • a régua minimalista vale aqui: nada levanta no hover
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');

const parte = fs.readFileSync(
  path.join(__dirname, '..', 'src/templates/storefront/parts/tira_categorias.js'), 'utf8');
const estilos = fs.readFileSync(
  path.join(__dirname, '..', 'src/templates/storefrontStyles.js'), 'utf8');

function pagina(tira) {
  return buildPage({
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7C3AED' },
    settings: {}, contact: {}, products: [], categories: [],
    tira_de_categorias: tira,
  }, 'loja');
}

describe('a tira chega na página', () => {
  test('o container existe e nasce escondido', () => {
    // Escondido de saída: a tira só aparece se o JS achar o que desenhar.
    // Um <section> vazio com margem abriria um buraco na home.
    const html = pagina([]);
    expect(html).toContain('id="tiraCats"');
    expect(html).toMatch(/id="tiraCats"[^>]*hidden/);
  });

  test('vem antes da barra de categorias', () => {
    // A tira é a porta de entrada visual; a barra é a navegação completa.
    // Invertido, a barra empurraria a tira pra baixo da dobra.
    const html = pagina([]);
    expect(html.indexOf('id="tiraCats"')).toBeLessThan(html.indexOf('id="catsWrap"'));
  });

  test('a lista atravessa até o <script>', () => {
    const html = pagina([{ nome: 'Vestidos', caminho: '/vestidos', slug: 'v', total: 89, banner_url: null }]);
    expect(html).toContain('tira_de_categorias');
    expect(html).toContain('Vestidos');
  });
});

describe('clicar na categoria não rola a página', () => {
  test('irParaCategoria não tem scrollTo', () => {
    const fn = parte.slice(parte.indexOf('function irParaCategoria'));
    const corpo = fn.slice(0, fn.indexOf('\n}'));
    expect(corpo).not.toContain('scrollTo');
    expect(corpo).not.toContain('scrollIntoView');
  });

  test('reusa filterCat em vez de mexer no estado por conta própria', () => {
    // Duplicar a troca de categoria aqui era a forma garantida de a tira e
    // a barra discordarem sobre qual está ativa.
    expect(parte).toContain('filterCat(caminho, null)');
    expect(parte).not.toContain('currentCat=');
  });
});

describe('a tira não redecide o que o servidor já decidiu', () => {
  test('não conhece o limiar nem o nível da categoria', () => {
    // SEM os comentários: eles EXPLICAM a regra e citam "nível" e "três".
    // Casar com o próprio comentário já me enganou antes — o teste passava
    // descrevendo a explicação em vez do código.
    const codigo = parte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    for (const proibido of ['depth', 'nivel', '>= 3', 'length >= ']) {
      expect(codigo).not.toContain(proibido);
    }
  });

  test('lista vazia esconde e não desenha nada', () => {
    expect(parte).toContain('el.hidden=true');
  });
});

describe('desenho dentro da régua', () => {
  test('sem banner o cartão entra, com o degrau do gradiente', () => {
    // Decisão de Caio (30/08): entra com cor sólida em vez de sumir —
    // sumir faria a tira mudar de tamanho conforme ela sobe as imagens.
    expect(parte).toContain('FUNDO_CAPA(c.nome)');
  });

  test('nada levanta no hover — quem cresce é a foto DENTRO da moldura', () => {
    const bloco = estilos.slice(estilos.indexOf('.tira-cat{'), estilos.indexOf('Categories chip strip'));
    expect(bloco).toContain('.tira-cat-arte img');
    expect(bloco).toMatch(/\.tira-cat:hover[^}]*transform:scale/);
    // translateY seria a moldura se mexendo, e a fila inteira dançando.
    expect(bloco).not.toContain('translateY');
  });

  test('respeita prefers-reduced-motion', () => {
    const bloco = estilos.slice(estilos.indexOf('.tira-cat{'), estilos.indexOf('Categories chip strip'));
    expect(bloco).toContain('prefers-reduced-motion');
    expect(bloco).toMatch(/prefers-reduced-motion[\s\S]*transform:none/);
  });

  test('o cartão é acessível pelo teclado', () => {
    // <button>, não <div onclick>. E foco visível, senão quem navega por
    // teclado não sabe onde está.
    expect(parte).toContain("'<button type=\"button\" class=\"tira-cat\"");
    const bloco = estilos.slice(estilos.indexOf('.tira-cat{'), estilos.indexOf('Categories chip strip'));
    expect(bloco).toContain(':focus-visible');
  });
});
