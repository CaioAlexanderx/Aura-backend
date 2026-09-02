// ============================================================
// Filtrar por tamanho e cor.
//
// Comparação com a Oscar (29/08): eles filtram por dez facetas, a loja da
// Aura por nenhuma. Quem entra procurando "vestido preto tamanho M"
// precisava abrir peça por peça — e o dado já estava lá: na Finesse, Cor
// em 81 das 112 peças visíveis (151 valores, todos hex) e Tamanho em 64.
// ============================================================
const fs = require('fs');
const path = require('path');
const { normalizarTamanho, ordenarTamanhos, agruparTamanhos } = require('../src/services/tamanhosDaLoja');
const { rotuloDaCor, agruparPorFamilia, FONTE } = require('../src/services/coresDaLoja');

const paginado = fs.readFileSync(path.join(__dirname, '../src/services/catalogoPaginado.js'), 'utf8');
const rota = fs.readFileSync(path.join(__dirname, '../src/routes/storefront.js'), 'utf8');
const builderSrc = fs.readFileSync(path.join(__dirname, '../src/services/storefrontBuilder.js'), 'utf8');
const clienteFiltros = require('../src/templates/storefront/parts/filtros');

// Os 17 valores REAIS de tamanho da Finesse, lidos do banco em 29/08.
const TAMANHOS_DA_FINESSE = ['34','36','38','40','42','g','G','gg','GG','m','M','p','P','PP','u','U','Único'];

describe('tamanho: 17 valores gravados são 11 tamanhos', () => {
  test('a caixa não cria tamanhos novos', () => {
    // "G" e "g" são o mesmo tamanho. Sem normalizar, o filtro mostraria
    // dois botões e clicar num traria metade das peças.
    expect(normalizarTamanho('g')).toBe('G');
    expect(normalizarTamanho('G')).toBe('G');
    expect(normalizarTamanho('gg')).toBe('GG');
  });

  test('"u", "U" e "Único" são a mesma coisa', () => {
    for (const v of ['u', 'U', 'Único', 'unico', 'UN', 'tamanho único']) {
      expect(normalizarTamanho(v)).toBe('Único');
    }
  });

  test('número perde o zero à esquerda mas continua número', () => {
    expect(normalizarTamanho('38')).toBe('38');
    expect(normalizarTamanho('038')).toBe('38');
  });

  test('tamanho que não reconheço não some — volta como veio', () => {
    // Sumir com o tamanho da lojista é pior que mostrar um rótulo
    // estranho que ela reconhece.
    expect(normalizarTamanho('44/46')).toBe('44/46');
    expect(normalizarTamanho('   ')).toBeNull();
  });

  test('os 17 da Finesse agrupam em 11', () => {
    const g = agruparTamanhos(TAMANHOS_DA_FINESSE.map((v) => ({ value: v, total: 1 })));
    expect(g.map((x) => x.rotulo)).toEqual(
      ['34', '36', '38', '40', '42', 'PP', 'P', 'M', 'G', 'GG', 'Único'],
    );
    // E o grupo guarda os valores GRAVADOS, porque é por eles que o
    // filtro busca no banco.
    const gg = g.find((x) => x.rotulo === 'GG');
    expect(gg.valores.sort()).toEqual(['GG', 'gg']);
    expect(gg.total).toBe(2);
  });
});

describe('tamanho: a régua se lê na ordem de tamanho', () => {
  test('alfabético seria G, GG, M, P, PP — e isso não é uma escala', () => {
    const alfabetico = ['G', 'GG', 'M', 'P', 'PP'].sort();
    expect(ordenarTamanhos(['G', 'GG', 'M', 'P', 'PP'])).not.toEqual(alfabetico);
    expect(ordenarTamanhos(['G', 'GG', 'M', 'P', 'PP'])).toEqual(['PP', 'P', 'M', 'G', 'GG']);
  });

  test('número vem antes de letra, e "Único" por último', () => {
    // "Único" não é um ponto da escala, é a ausência dela; no meio da
    // régua confundiria.
    expect(ordenarTamanhos(['Único', 'M', '38', 'P', '34'])).toEqual(['34', '38', 'P', 'M', 'Único']);
  });
});

describe('cor: 151 hex viram famílias com nome', () => {
  test('o hex ganha o nome do tom mais próximo', () => {
    expect(rotuloDaCor('#000000')).toBe('Preto');
    expect(rotuloDaCor('#6E1F2B')).toBe('Vinho');
    expect(rotuloDaCor('#EC4899')).toBe('Pink');
  });

  test('hex curto e caixa não importam', () => {
    expect(rotuloDaCor('#abc')).toBe(rotuloDaCor('#AABBCC'));
  });

  test('tons vizinhos caem na MESMA família', () => {
    // É o ponto todo: 151 amostras não é filtro, é outra grade.
    const g = agruparPorFamilia([
      { value: '#000000', total: 3 },
      { value: '#111111', total: 2 },
      { value: '#0A0A0A', total: 1 },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].rotulo).toBe('Preto');
    expect(g[0].total).toBe(6);
  });

  test('a amostra usa o tom mais COMUM da família, não o da tabela', () => {
    // Desenhar o tom teórico mostraria uma cor que a loja não tem.
    const g = agruparPorFamilia([
      { value: '#0A0A0A', total: 1 },
      { value: '#151515', total: 9 },
    ]);
    expect(g[0].hex).toBe('#151515');
  });

  test('cor sem nome vira família dela mesma, e não some', () => {
    // Esconder produto por causa de um tom exótico seria pior que uma
    // entrada a mais no filtro.
    const g = agruparPorFamilia([{ value: '#7FFF00', total: 2 }]);
    expect(g).toHaveLength(1);
    expect(g[0].total).toBe(2);
  });

  test('valor que não é cor é ignorado', () => {
    expect(agruparPorFamilia([{ value: 'listrado', total: 5 }])).toEqual([]);
  });

  test('a fonte do cliente não carrega instrumentação de cobertura', () => {
    // Já derrubou um PR: sob cobertura, o istanbul instrumenta a função e
    // o código serializado quebra no navegador com ReferenceError.
    expect(FONTE).not.toContain('cov_');
    expect(FONTE).toContain('function nomeDaCor');
  });
});

describe('a consulta: tamanho e cor na MESMA variante', () => {
  test('é um EXISTS só, com as duas condições dentro', () => {
    // Duas condições separadas trariam o vestido que existe em "P azul" e
    // "G preto" quando a pessoa pede "P preto" — combinação que a loja
    // não tem. Este é o defeito que o teste guarda.
    const i = paginado.indexOf('const listaTam');
    const bloco = paginado.slice(i, i + 1800);
    expect(bloco).toContain('FROM product_variants v');
    expect(bloco).toContain("dentro.join(' AND ')");
    // As duas subconsultas amarram na MESMA variante v.
    expect(bloco).toContain('t.variant_id = v.id');
    expect(bloco).toContain('c.variant_id = v.id');
  });

  test('só variante com saldo entra', () => {
    // Filtro que leva à peça esgotada é pior que filtro nenhum.
    const i = paginado.indexOf('const listaTam');
    expect(paginado.slice(i, i + 1800)).toContain('v.stock_qty > 0');
  });

  test('a faceta conta PRODUTO, não variante', () => {
    // Um vestido com sete grades de cor conta uma vez em cada cor, nunca
    // sete vezes — o número ao lado do filtro tem que casar com o que a
    // grade mostra depois.
    // Conta `products.id`, não `p.id`: o alias era justamente o bug que
    // fez a consulta inteira falhar em produção.
    const i = paginado.indexOf('async function facetasDoCatalogo');
    expect(paginado.slice(i, i + 1600)).toContain('COUNT(DISTINCT products.id)');
  });
});

describe('a rota traduz rótulo em valor gravado', () => {
  test('o rótulo "M" cobre "m" e "M"', () => {
    const fn = new Function(
      'normalizarTamanho',
      rota.slice(rota.indexOf('function valoresDeTamanho'), rota.indexOf('/**', rota.indexOf('function valoresDeTamanho')))
        + '\nreturn valoresDeTamanho;',
    )(normalizarTamanho);
    const saida = fn('M');
    expect(saida).toEqual(expect.arrayContaining(['m', 'M']));
  });

  test('"Único" cobre todas as formas que a lojista escreve', () => {
    const fn = new Function(
      'normalizarTamanho',
      rota.slice(rota.indexOf('function valoresDeTamanho'), rota.indexOf('/**', rota.indexOf('function valoresDeTamanho')))
        + '\nreturn valoresDeTamanho;',
    )(normalizarTamanho);
    expect(fn('Único')).toEqual(expect.arrayContaining(['u', 'U', 'Único', 'UNICO']));
  });

  test('a cor consulta o banco em vez de gerar', () => {
    // Os hex são os que a lojista cadastrou; só o banco sabe quais
    // existem. Gerar produziria um conjunto incoerente com o filtro
    // que foi oferecido.
    const i = rota.indexOf('async function valoresDeCor');
    expect(rota.slice(i, i + 900)).toContain('facetasDoCatalogo');
  });
});

describe('o cliente', () => {
  test('manda os filtros na MESMA requisição da página', () => {
    const prods = require('../src/templates/storefront/parts/products');
    expect(prods).toContain('paramsDeFiltro');
  });

  test('a faceta com um valor só não vira filtro', () => {
    // Filtrar por "M" numa loja onde tudo é M não filtra nada, e ocupa
    // uma barra inteira.
    expect(clienteFiltros).toContain('FACETAS.tamanho.length > 1');
    expect(clienteFiltros).toContain('FACETAS.cor.length > 1');
  });

  test('o que está filtrando aparece mesmo com o painel fechado', () => {
    // Fechar o painel não pode esconder o filtro ativo: a pessoa acharia
    // que a loja tem menos peça do que tem.
    expect(clienteFiltros).toContain('filtro-ficha');
    expect(clienteFiltros).toContain('function contarFiltros');
  });

  test('a bolinha de cor vem COM o nome', () => {
    // A bolinha sozinha exclui quem não distingue tons próximos, e
    // "Vinho" e "Bordô" viram a mesma mancha escura numa fila.
    const i = clienteFiltros.indexOf('filtro-op-cor');
    expect(clienteFiltros.slice(i, i + 400)).toContain('c.rotulo');
  });
});

describe('preço no Pix', () => {
  // Fase 3 (02/09/2026): o cartao mudou pra parts/card.js — grade e home
  // desenham com a mesma funcao.
  const prods = require('../src/templates/storefront/parts/card');
  const css = require('../src/templates/storefrontStyles')('#7a1f3a', '#7a1f3a', false, 'classic');

  test('só aparece quando a lojista declarou o desconto', () => {
    // Migration 309, default 0. Nenhuma loja passa a anunciar desconto
    // que ninguém decidiu dar.
    expect(prods).toContain('pixPct>0');
  });

  test('é percentual sobre o preço, não valor fixo', () => {
    expect(prods).toContain('p.price*(1-pixPct/100)');
  });

  test('o teto de 30% está na migration', () => {
    // Guarda-corpo contra dedo errado: quem digita 50 achando que são
    // "50 reais" anunciaria metade do preço.
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/309_desconto_no_pix.sql'), 'utf8');
    expect(sql).toContain('pix_discount_pct <= 30');
    expect(sql).toMatch(/DEFAULT\s+0/);
  });

  test('não usa verde — a loja tem uma cor só', () => {
    const i = css.indexOf('.product-pix{');
    const decl = css.slice(i, css.indexOf('}', i));
    expect(decl).not.toMatch(/#25D366|green/i);
    expect(decl).toContain('var(--sf-ink-2)');
  });
});

describe('ordenar por mais vendidos', () => {
  // Redesign 09/2026: a conta saiu do ORDENS e virou VENDIDOS_RECENTES, a
  // MESMA fonte que o bloco "Mais vendidos" da home usa. O teste olha a
  // fonte do fragmento e exige que a ordenacao o use.
  const i = paginado.indexOf('const VENDIDOS_RECENTES = `');
  const bloco = paginado.slice(i, i + 700);

  test('a ordem existe e sai de sale_items', () => {
    expect(i).toBeGreaterThan(0);
    expect(bloco).toContain('sale_items');
    expect(paginado).toContain('mais_vendidos: `${VENDIDOS_RECENTES}');
  });

  test('venda cancelada não conta', () => {
    expect(bloco).toContain("<> 'cancelled'");
  });

  test('troca não conta (armadilha 5)', () => {
    expect(bloco).toContain("<> 'troca'");
  });

  test('tem janela de tempo', () => {
    // Campeão de venda de dois anos atrás não é o que a loja quer
    // empurrar hoje. 90 dias — decisão de 02/09/2026.
    expect(bloco).toContain("INTERVAL '${JANELA_DE_VENDAS_DIAS} days'");
    expect(paginado).toContain('const JANELA_DE_VENDAS_DIAS = 90;');
  });
});

describe('a consulta das facetas não pode repetir os dois bugs', () => {
  // Só o SQL, sem os comentários em volta. O comentário que EXPLICA o bug
  // contém a string "FROM products p" e reprovava o próprio teste — o
  // mesmo tropeço do teste do `!important`.
  const bloco = paginado.slice(
    paginado.indexOf('async function facetasDoCatalogo'),
    paginado.indexOf('async function contarPorCategoria'),
  );
  const sql = bloco.slice(bloco.indexOf('const sql = `'), bloco.indexOf('`;', bloco.indexOf('const sql = `')));

  test('products NÃO leva alias', () => {
    // visibilityWhere e COM_FOTO são fragmentos prontos que dizem
    // `products.` — dar um alias quebra os dois de uma vez.
    expect(sql).toMatch(/FROM products\s*[\r\n]/);
    // Um alias seria "FROM products p" — palavra logo depois, na MESMA
    // linha. Casar `\s` genérico pegaria a quebra de linha e reprovaria
    // o código correto.
    expect(sql).not.toMatch(/FROM products[ \t]+\w/);
  });

  test('is_active vem qualificado', () => {
    // product_variants também tem is_active. Sem prefixo: 42702.
    expect(sql).toContain('products.is_active IS NOT FALSE');
    expect(sql).not.toMatch(/\n\s+AND is_active/);
  });

  test('o COUNT usa a mesma referência', () => {
    expect(sql).toContain('COUNT(DISTINCT products.id)');
  });

  test('o catch grita antes de devolver vazio', () => {
    // É a diferença entre "esta base não tem variantes" e "eu escrevi o
    // SQL errado". Sem o log, os dois parecem iguais em produção.
    expect(bloco).toContain('console.error');
    expect(bloco).toContain("'[facetas] consulta falhou");
  });

  test('o catch do builder também', () => {
    expect(builderSrc).toContain("'[storefront] facetas indisponiveis:'");
  });
});

// ============================================================
// O agrupamento de cor, refeito depois de ver o resultado em produção.
//
// A primeira versão usava a MESMA distância que nomeia o swatch da página
// do produto. Funcionou como código e falhou como filtro: 30 famílias,
// seis mostrando hex cru porque nada chegou perto — inclusive vermelho
// puro (#FF0000) — e catorze famílias com uma peça só.
//
// São duas necessidades diferentes do mesmo dado:
//   nomear um swatch pede PRECISÃO — "Marsala" diz mais que "Vermelho";
//   agrupar um filtro pede o CONTRÁRIO — quem procura vestido filtra por
//   vermelho e espera achar o marsala dentro.
//
// E a distância no RGB é a ferramenta errada para a segunda: `#6B7280`,
// um cinza-azulado, caía em "verde" porque o peso perceptual no canal
// verde o aproximava mais dele que do cinza. Matiz e saturação resolvem
// na ordem que o olho usa — primeiro "isso tem cor?", depois "qual?".
// ============================================================
describe('as famílias de cor, contra as cores REAIS da Finesse', () => {
  const { familiaDaCor, FAMILIAS } = require('../src/services/coresDaLoja');

  // Amostra dos 121 hex com estoque e foto, lidos do banco em 29/08.
  const REAIS = {
    '#000000': 'preto', '#0D0D0D': 'preto', '#1F2937': 'preto',
    '#6B7280': 'cinza', '#C0C0C0': 'cinza', '#E2E3E4': 'cinza',
    '#FFFFFF': 'branco', '#F0EBDF': 'branco',
    '#F5DEB3': 'bege', '#E0E094': 'bege',
    '#92400E': 'marrom', '#8B4513': 'marrom', '#A06513': 'marrom', '#683708': 'marrom',
    '#FF0000': 'vermelho', '#D20F0F': 'vermelho', '#EF4444': 'vermelho',
    '#800000': 'vinho', '#800020': 'vinho', '#6B0000': 'vinho',
    '#EC4899': 'rosa', '#FF6EC7': 'rosa', '#CE1270': 'rosa',
    '#FFA500': 'laranja', '#F97316': 'laranja',
    '#FFFF00': 'amarelo', '#EAB308': 'amarelo', '#DAA520': 'amarelo',
    '#22C55E': 'verde', '#137149': 'verde', '#196110': 'verde',
    '#0000FF': 'azul', '#0161FD': 'azul', '#06B6D4': 'azul', '#ADD8E6': 'azul',
    '#A020F0': 'roxo', '#8B5CF6': 'roxo', '#32047C': 'roxo',
  };

  test.each(Object.entries(REAIS))('%s é %s', (hex, esperado) => {
    expect(familiaDaCor(hex)).toBe(esperado);
  });

  test('cinza-azulado é CINZA, não verde', () => {
    // O caso concreto que derrubou a distância no RGB.
    expect(familiaDaCor('#6B7280')).toBe('cinza');
  });

  test('nenhuma cor fica sem balde', () => {
    // No filtro, um balde aproximado é sempre melhor que hex cru na tela.
    // Antes, seis das trinta famílias eram um código hexadecimal.
    for (const hex of Object.keys(REAIS)) {
      expect(familiaDaCor(hex)).not.toBeNull();
      expect(familiaDaCor(hex).startsWith('#')).toBe(false);
    }
  });

  test('são treze baldes, não quarenta e sete tons', () => {
    // O mapa fino continua existindo — ele nomeia o swatch da página do
    // produto. Este é outro, e curto de propósito.
    expect(Object.keys(FAMILIAS).length).toBeLessThanOrEqual(14);
  });

  test('a precisão do swatch NÃO foi perdida', () => {
    // Os dois mapas convivem: o filtro agrupa, a página do produto nomeia.
    const { rotuloDaCor } = require('../src/services/coresDaLoja');
    expect(rotuloDaCor('#6E1F2B')).toBe('Vinho');
    expect(rotuloDaCor('#8A3A44')).toBe('Marsala');
    expect(familiaDaCor('#8A3A44')).toBe('vinho');
  });
});

// ============================================================
// O QA em produção pegou duas coisas que nenhum teste pegou.
// ============================================================
describe('o alias que quebrou a árvore também', () => {
  const arv = paginado.slice(
    paginado.indexOf('async function arvoreDeCategorias'),
    paginado.indexOf('async function facetasDoCatalogo'),
  );
  const sql = arv.slice(arv.indexOf('const sql = `'), arv.indexOf('`;', arv.indexOf('const sql = `')));

  test('products sem alias, aqui também', () => {
    // O MESMO bug das facetas, na consulta que eu tinha escrito antes.
    // Consertei um e não olhei o outro; a barra ficou dias caindo na
    // lista plana em produção, e o catch de 42P01 escondeu.
    expect(sql).toMatch(/FROM products\s*[\r\n]/);
    expect(sql).not.toMatch(/FROM products[ \t]+\w/);
  });

  test('is_active qualificado', () => {
    expect(sql).toContain('products.is_active IS NOT FALSE');
  });

  test('e o catch grita', () => {
    expect(arv).toContain("'[arvore-categorias] consulta falhou");
  });
});

describe('clique durante o carregamento não some', () => {
  const prods = require('../src/templates/storefront/parts/products');

  test('a intenção fica pendente em vez de ser descartada', () => {
    // Peguei no QA: clicar num filtro enquanto a página 1 ainda carregava
    // não fazia nada. A ficha "Preto" aparecia na barra e a grade
    // continuava inteira — sem erro, sem sinal, só a impressão de que o
    // filtro não funciona.
    // O pendente virou registro ({n, rolar}) quando a rolagem passou a
    // depender de quem pediu — a intencao de rolar precisa sobreviver
    // junto com o numero da pagina.
    expect(prods).toContain('pedidoPendente={n:n');
    expect(prods).not.toContain('if(carregandoPagina) return;');
  });

  test('roda o pendente quando a carga atual termina', () => {
    // Ancora no `.then` final, não na declaração da variável lá em cima —
    // que é onde o `indexOf` cru cai.
    const i = prods.indexOf('marcarCarregando(false);');
    expect(i).toBeGreaterThan(0);
    expect(prods.slice(i, i + 300)).toContain('irParaPagina(p.n,{rolar:p.rolar})');
  });

  test('guarda a ÚLTIMA intenção, não uma fila', () => {
    // Quem clicou em três filtros seguidos quer o resultado dos três
    // juntos, não três recargas em sequência.
    expect(prods).toContain('var pedidoPendente=null');
  });
});
