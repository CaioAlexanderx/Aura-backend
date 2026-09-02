// ============================================================
// O <script> que a loja gera precisa ser JS valido.
//
// Os parts/ sao template literals que viram codigo no navegador, e um
// escape errado (\' onde precisava \\') so aparece quando a pagina abre
// em branco. Peguei duas vezes na fase 4 rodando `node --check` no script
// da pagina renderizada; este teste faz isso em todo PR.
// ============================================================
const buildPage = require('../src/templates/storefrontPage');

function scripts(html) {
  return (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map((s) => s.replace(/^<script>/, '').replace(/<\/script>$/, ''));
}

describe('o script gerado da loja e JS valido', () => {
  const html = buildPage({
    site: { name: "Loja d'Água", primary_color: '#7a1f3a', banners: [{ headline: 'a', cta: 'Ver', cta_url: '#cat=/vestidos' }] },
    contact: { whatsapp: '5534999999999' }, settings: {}, products: [], categories: [],
    categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, 'loja-d-agua');
  const js = scripts(html);

  test('ha dois scripts (o da loja e o da rotacao do banner)', () => {
    expect(js.length).toBe(2);
  });

  test.each(js.map((s, i) => [i, s]))('script %i compila', (_i, src) => {
    // new Function so PARSEIA — nao executa. Erro de sintaxe estoura aqui.
    // O bootstrap fecha com "<\/script>" escapado; desfaz antes de parsear.
    expect(() => new Function(src.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
  });
});
