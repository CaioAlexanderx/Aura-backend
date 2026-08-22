// O `storeData` da pagina copia campo a campo, nao espalha o objeto do
// builder. Quem adiciona chave no builder e esquece daqui ve o dado sumir
// em silencio — foi o que aconteceu com `catalog_total`: o builder
// calculava, a grade sabia usar, e o aviso "500 de 1302" nunca aparecia
// porque a chave parava no meio do caminho.
const buildPage = require('../src/templates/storefrontPage');

function paginaDe(extra) {
  const data = {
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7C3AED' },
    contact: {},
    settings: {},
    products: [],
    categories: [],
    ...extra,
  };
  return buildPage(data, 'loja');
}

describe('payload injetado na pagina', () => {
  test('catalog_total atravessa ate o <script>', () => {
    expect(paginaDe({ catalog_total: 1302 })).toContain('"catalog_total":1302');
  });

  test('loja pequena tambem manda o numero — o cliente da grade decide', () => {
    expect(paginaDe({ catalog_total: 9 })).toContain('"catalog_total":9');
  });

  test('base sem a contagem nao quebra a pagina', () => {
    // contarProdutosDaLoja devolve 0 quando a query falha; a grade
    // interpreta 0 como "nao sei" e simplesmente nao mostra o aviso.
    const html = paginaDe({ catalog_total: 0 });
    expect(html).toContain('CATALOGO_TOTAL');
    expect(typeof html).toBe('string');
  });
});
