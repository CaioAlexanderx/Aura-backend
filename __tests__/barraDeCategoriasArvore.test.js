// ============================================================
// A barra de categorias passa a ler a ÁRVORE.
//
// A árvore da Finesse foi montada no banco em 28/08 — Vestidos > Festa >
// Vestido Midi Festa, três níveis — e a loja continuou mostrando 12
// folhas soltas numa fila. A organização existia e não chegava na
// cliente, porque `contarPorCategoria` lê `products.category`, o texto
// plano.
//
// O QUE ESTE TESTE GUARDA, e é o que quebraria em silêncio:
//
// 1. Contar a subárvore, não o nó. "Vestidos 71" só existe somando Festa
//    e Casual — pendurado direto em Vestidos não há produto nenhum, e
//    contar só o próprio daria 0 em todo pai.
//
// 2. Filtrar por CAMINHO. Nenhum produto tem `category = 'Vestidos'`;
//    clicar no pai com o filtro de texto traria zero, que é a pior forma
//    de quebrar — silenciosa e parecida com "acabou o estoque".
//
// 3. Não quebrar as lojas sem árvore. Hoje 4 das lojas em produção têm
//    vínculo; as outras têm que continuar na barra plana.
// ============================================================
const fs = require('fs');
const path = require('path');
const { arvoreDeCategorias, filtroDeFoto } = require('../src/services/catalogoPaginado');

function fonte(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

// A função seguinte no arquivo — marca o fim do bloco de arvoreDeCategorias.
// Fatia até aqui em vez de uma janela de N caracteres: um comentário que
// cresce empurrava a asserção para fora da janela e o teste quebrava sem
// que o código tivesse mudado.
const BLOCO_FIM = 'async function contarPorCategoria';
const paginado = fonte('src/services/catalogoPaginado.js');
const builder = fonte('src/services/storefrontBuilder.js');
const cliente = require('../src/templates/storefront/parts/categorias');

describe('a contagem soma a subárvore', () => {
  test('o SQL casa o nó E os descendentes', () => {
    const i = paginado.indexOf('async function arvoreDeCategorias');
    const bloco = paginado.slice(i, paginado.indexOf('\nasync function contarPorCategoria', i));
    // 02/09/2026: a contagem passou a ser por CAMINHO, não por id do nó
    // (loja de grupo — ver __tests__/arvoreDeGrupo.test.js). O critério
    // continua o mesmo: o próprio nó E tudo abaixo dele.
    expect(bloco).toContain('v.caminho = c.path');
    expect(bloco).toContain("left(v.caminho, length(c.path) + 1) = c.path || '/'");
  });

  test('nó sem produto visível fica de fora', () => {
    // Categoria que abre numa grade vazia é pior que categoria que não
    // existe. Na Finesse isso tira Saias, Shorts, Cropped e mais 15.
    const i = paginado.indexOf('async function arvoreDeCategorias');
    expect(paginado.slice(i, paginado.indexOf(BLOCO_FIM, i))).toContain('rows.filter((r) => r.total > 0)');
  });

  test('respeita o filtro de foto e o de estoque', () => {
    // Se a barra contasse sem esses filtros, ela diria "Vestidos 611" e a
    // grade mostraria 71 — o mesmo bug de "Bolsa 29 / mostra 19".
    const i = paginado.indexOf('async function arvoreDeCategorias');
    const bloco = paginado.slice(i, paginado.indexOf(BLOCO_FIM, i));
    expect(bloco).toContain('EM_ESTOQUE');
    expect(bloco).toContain('filtroDeFoto(exigeFoto)');
  });

  test('devolve [] quando a base não tem a árvore', () => {
    // 42P01/42703: o backend não roda migration no boot. A loja abre com
    // a barra antiga em vez de não abrir.
    const i = paginado.indexOf('async function arvoreDeCategorias');
    const bloco = paginado.slice(i, paginado.indexOf(BLOCO_FIM, i));
    expect(bloco).toContain("e.code === '42P01' || e.code === '42703'");
  });

  test('a função existe e é chamável', () => {
    expect(typeof arvoreDeCategorias).toBe('function');
  });
});

describe('o filtro por caminho', () => {
  test('caminho e texto convivem', () => {
    const i = paginado.indexOf('const cat = String(categoria');
    const bloco = paginado.slice(i, i + 1400);
    // Começa com '/' → caminho; senão → o texto de sempre.
    expect(bloco).toContain("cat.charAt(0) === '/'");
    expect(bloco).toContain('category = $');
  });

  test('o prefixo termina em barra', () => {
    // Sem isso, `/vestidos` arrastaria um futuro `/vestidos-infantil`.
    const i = paginado.indexOf('const cat = String(categoria');
    expect(paginado.slice(i, i + 1400)).toContain("|| '/'");
  });

  test('casa o nó exato também, não só os filhos', () => {
    // Clicar numa FOLHA tem que trazer os produtos dela. Só o prefixo
    // com barra casaria apenas descendentes — e folha não tem.
    const i = paginado.indexOf('const cat = String(categoria');
    expect(paginado.slice(i, i + 1400)).toContain('c.path = $');
  });
});

describe('a loja sem árvore continua funcionando', () => {
  test('o builder só cai no texto plano quando a árvore vem vazia', () => {
    // Ancora no PRÓPRIO guarda, e não numa janela de N caracteres a
    // partir de outro ponto: comentário que cresce empurrava a asserção
    // para fora da janela e quebrava o teste sem o código ter mudado.
    expect(builder).toContain('let categoriasComTotal');
    const i = builder.indexOf('if (!arvoreBarra.length)');
    expect(i).toBeGreaterThan(0);
    // A contagem plana só existe DENTRO do guarda.
    expect(builder.slice(i, i + 500)).toContain('contarPorCategoria');
  });

  test('o payload leva os dois campos', () => {
    expect(builder).toContain('categorias_barra: categoriasComTotal');
    expect(builder).toContain('categorias_arvore: arvoreBarra');
  });

  test('o cliente escolhe qual usar', () => {
    expect(cliente).toContain('var TEM_ARVORE = ARVORE.length > 0');
    // Sem árvore, o caminho vira o próprio nome — que é o que o filtro
    // por texto já esperava.
    expect(cliente).toContain('caminho:c.nome');
  });
});

describe('o cliente desenha dois níveis', () => {
  test('a seleção compara CAMINHO, não nome', () => {
    // Haverá "Festa" sob Vestidos e poderá haver "Festa" sob Blusas.
    // Comparando por nome, as duas acenderiam juntas.
    expect(cliente).toContain("currentCat === c.caminho");
    expect(cliente).not.toContain("currentCat === c.nome");
  });

  test('a segunda linha aparece com a filha selecionada', () => {
    // Escolher "Festa" não pode fazer "Casual" sumir — trocar de
    // subcategoria exigiria voltar ao topo.
    const i = cliente.indexOf('function ramoAberto');
    const bloco = cliente.slice(i, cliente.indexOf('\nvar painelCatsAberto', i));
    expect(bloco).toContain('irmas');
  });

  test('a medição da barra ignora a segunda linha', () => {
    // O laço que tira chips até caber roda ANTES da segunda linha existir;
    // contá-la faria a barra encolher sem motivo.
    const i = cliente.indexOf('while(quantas > MINIMO_NA_BARRA');
    const j = cliente.indexOf("getElementById('catsSub')");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });

  test('o título da grade mostra nome, não caminho', () => {
    const cart = require('../src/templates/storefront/parts/cart');
    expect(cart).toContain('nomeDoCaminho');
    expect(cliente).toContain('function nomeDoCaminho');
  });

  test('o painel vira mapa quando há árvore', () => {
    expect(cliente).toContain('function ramosHtml');
    expect(cliente).toContain('cats-painel-ramos');
    // E o topo do ramo é clicável: quem quer "tudo em Vestidos" não
    // deveria ter que escolher uma subcategoria para chegar lá.
    expect(cliente).toContain('cats-ramo-topo');
    expect(cliente).toContain(".cats-item, .cats-ramo-topo");
  });
});

describe('o CSS das duas linhas', () => {
  const css = require('../src/templates/storefrontStyles')('#7a1f3a', '#7a1f3a', false, 'classic');

  test('a segunda linha é menor que a primeira', () => {
    // A hierarquia tem que se ler na forma, não só no recuo.
    const sub = css.slice(css.indexOf('.cat-sub{'), css.indexOf('.cat-sub:hover'));
    const topo = css.slice(css.indexOf('.cat-chip,.cat-todas{'), css.indexOf('.cats-wrap{gap'));
    const tam = (s) => Number((s.match(/font-size:([\d.]+)px/) || [])[1]);
    expect(tam(sub)).toBeLessThan(tam(topo));
  });

  test('as duas linhas grudam uma na outra ao rolar', () => {
    // A barra é sticky; se a segunda não fosse, ela sumiria ao rolar e a
    // pessoa perderia o contexto do ramo em que está.
    const i = css.indexOf('.cats-sub{');
    expect(css.slice(i, css.indexOf('}', i))).toContain('position:sticky');
  });

  test('a sub-linha selecionada usa régua, como a de cima', () => {
    const i = css.indexOf('.cat-sub.active{');
    expect(css.slice(i, css.indexOf('}', i))).toContain('border-bottom-color:var(--sf-brand)');
  });
});

describe('a pessoa nunca perde o lugar', () => {
  test('o chip do topo acende pelo RAMO, não pelo nó exato', () => {
    // Escolher "Festa" apagava o destaque de "Vestidos": a segunda linha
    // dizia "Festa" e a primeira não dizia nada. Peguei isto medindo os
    // quatro estados no navegador, não lendo o código.
    expect(cliente).toContain('function dentroDe');
    expect(cliente).toContain("currentCat.indexOf(caminho + '/') === 0");
    expect(cliente).toContain("(dentroDe(c.caminho) ? ' active' : '')");
  });

  test('mas a segunda linha acende só o nó clicado', () => {
    // Lá o prefixo marcaria pai e filha ao mesmo tempo, e a linha
    // inteira pareceria selecionada.
    const i = cliente.indexOf('function subChipHtml');
    expect(cliente.slice(i, i + 400)).toContain('currentCat === c.caminho');
  });
});
