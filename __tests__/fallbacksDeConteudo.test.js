// ============================================================
// Fallbacks de conteudo (QA das lojas, 08/09/2026)
//
// Tres coisas que a loja desenhava a partir do que a lojista NAO
// preencheu, e desenhava mal:
//  - "sempre aberta" virava "Aberta 24 horas" embaixo do endereco de uma
//    boutique;
//  - categoria com UMA peca ganhava cartao grande na tira ("Blusas 1");
//  - tres categorias numa grade de quatro deixavam a quarta vaga vazia.
// ============================================================
const { montarTira, MINIMO_PARA_APARECER, MINIMO_DE_PECAS_NO_CARTAO } = require('../src/services/tiraDeCategorias');
const buildPage = require('../src/templates/storefrontPage');

const raiz = (nome, extra) => ({ id: nome, nome, slug: nome.toLowerCase(), path: '/' + nome.toLowerCase(), depth: 0, total: 10, banner_url: null, ...extra });

describe('categoria com uma peca nao ganha cartao', () => {
  test('o minimo e duas pecas', () => {
    expect(MINIMO_DE_PECAS_NO_CARTAO).toBe(2);
  });

  test('"Blusas 1" sai da tira; as outras ficam', () => {
    const tira = montarTira([raiz('Vestidos', { total: 70 }), raiz('Conjuntos', { total: 37 }), raiz('Blusas', { total: 1 }), raiz('Macacões', { total: 3 })]);
    expect(tira.map((t) => t.nome)).toEqual(['Vestidos', 'Conjuntos', 'Macacões']);
  });

  test('o minimo de cartoes continua valendo depois do corte', () => {
    expect(MINIMO_PARA_APARECER).toBe(3);
    expect(montarTira([raiz('A'), raiz('B'), raiz('C', { total: 1 })])).toEqual([]);
  });
});

describe('tres categorias, tres colunas', () => {
  const html = buildPage({
    slug: 'loja', site: { name: 'Loja', primary_color: '#0bbdea' }, contact: {}, settings: {}, products: [], categories: [],
    categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, 'loja');

  test('o script marca a tira com a contagem', () => {
    expect(html).toContain(`'<div class="tira-cats-inner tira-n'+lista.length+'">'`);
  });

  test('o CSS trata o caso de tres no desktop e no celular', () => {
    expect(html).toContain('.tira-cats-inner.tira-n3{grid-template-columns:repeat(3,1fr);}');
    expect(html).toContain('.tira-cats-inner.tira-n3 .tira-cat:last-child{grid-column:1/-1;aspect-ratio:2/1;}');
  });
});
