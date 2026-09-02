// ============================================================
// A loja de um GRUPO conta a árvore inteira (02/09/2026, Davi Calçados)
//
// A Davi Calçados são duas empresas: matriz e Villa Branca, que partilham
// o estoque (`is_group_shared`) e vendem numa vitrine só. O `visibilityWhere`
// já entrega as peças das duas. A ÁRVORE não entregava:
//
//   - `link_tenant_guard` (migration 259) exige que produto e categoria
//     sejam da MESMA empresa. Então a árvore nasce espelhada: cada empresa
//     tem o seu `/feminino/botas`.
//   - `arvoreDeCategorias` contava `JOIN product_categories d ON d.id =
//     v.category_id WHERE d.company_id = c.company_id` — o id do nó. O nó
//     da filial só via as peças da filial: 31 de 175.
//   - E, pior que o número errado, `rows.filter(r => r.total > 0)` APAGA
//     do menu o nó que ficou em zero. "Masculino > Cintos e Meias" sumia
//     porque os dois cintos são da matriz.
//
// A correção: contar por CAMINHO. É o mesmo critério que o filtro de
// categoria já usa (`paginaDoCatalogo` casa `c.path`), então o número do
// menu passa a ser exatamente o que a pessoa encontra ao clicar — que é a
// única garantia que interessa.
//
// Para loja de empresa única nada muda: o caminho é único por empresa
// (`product_categories_unique_path`).
// ============================================================
const fs = require('fs');
const path = require('path');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const paginado = fonte('src/services/catalogoPaginado.js');
const bloco = (() => {
  const i = paginado.indexOf('async function arvoreDeCategorias');
  return paginado.slice(i, paginado.indexOf('\nasync function contarPorCategoria', i));
})();

describe('a contagem do menu é por caminho, não por dono do nó', () => {
  test('o conjunto visível traz o caminho da categoria', () => {
    expect(bloco).toContain('SELECT (SELECT c2.path FROM product_categories c2 WHERE c2.id = l.category_id) AS caminho');
  });

  test('o caminho vem por SUBCONSULTA — um JOIN aqui torna company_id ambíguo', () => {
    // Custou uma ida a produção em 02/09: `visibilityWhere` fala em
    // `company_id` PELADO e product_categories também tem essa coluna.
    // Com o JOIN no FROM o Postgres devolve 42702 e o catch do builder
    // engolia — a loja da Davi caiu na barra plana sem uma linha de log.
    const visiveis = bloco.slice(bloco.indexOf('WITH visiveis'), bloco.indexOf('SELECT c.id'));
    expect(visiveis).not.toMatch(/JOIN\s+product_categories/);
  });

  test('quando a árvore falha, o builder GRITA antes de cair na barra plana', () => {
    const builder = fonte('src/services/storefrontBuilder.js');
    const i = builder.indexOf('arvoreBarra = await arvoreDeCategorias');
    expect(builder.slice(i, i + 700)).toContain("console.error('[storefront] arvore de categorias indisponivel");
  });

  test('o dono do nó saiu da contagem', () => {
    // Estas duas linhas eram a jaula: enquanto existirem, a filial conta
    // só o que é dela.
    expect(bloco).not.toContain('d.company_id = c.company_id');
    expect(bloco).not.toContain('JOIN product_categories d ON d.id = v.category_id');
  });

  test('o nó da vitrine continua sendo o da empresa da loja', () => {
    // Só a CONTAGEM cruza o grupo. Quem desenha o menu continua sendo a
    // árvore da empresa que publica a loja — senão a filial herdava
    // categoria que a matriz criou e não quis mostrar.
    expect(bloco).toContain('WHERE c.company_id = $1');
    expect(bloco).toContain('c.is_visible_storefront IS NOT FALSE');
  });

  test('o critério é o mesmo do filtro de categoria', () => {
    // Menu e grade têm que concordar: os dois casam o nó e a subárvore
    // pelo prefixo terminado em barra.
    const filtro = paginado.slice(paginado.indexOf('const cat = String(categoria'));
    expect(filtro).toContain("left(c.path, length($");
    expect(bloco).toContain("left(v.caminho, length(c.path) + 1) = c.path || '/'");
  });

  test('continua respeitando estoque, foto e visibilidade', () => {
    expect(bloco).toContain('EM_ESTOQUE');
    expect(bloco).toContain('filtroDeFoto(exigeFoto)');
    expect(bloco).toContain('products.is_active IS NOT FALSE');
    expect(bloco).toContain('rows.filter((r) => r.total > 0)');
  });
});

describe('numeração de calçado na régua de tamanho', () => {
  const { ordenarTamanhos, normalizarTamanho } = require('../src/services/tamanhosDaLoja');

  test('par (37/38) entra na escala junto com o número solto', () => {
    // A Davi grava os dois formatos: 17 ao 44 avulso (tênis, sapato) e
    // 17/18 ao 47/48 em par (chinelo). Antes o par caía no balde do
    // "não reconhecido" e a régua o jogava depois de 44 e de GG.
    expect(ordenarTamanhos(['39/40', '35', '44', '33/34', '17/18', '38']))
      .toEqual(['17/18', '33/34', '35', '38', '39/40', '44']);
  });

  test('o número solto vem antes do par que começa nele', () => {
    expect(ordenarTamanhos(['37/38', '37', '36'])).toEqual(['36', '37', '37/38']);
  });

  test('letra e Único continuam depois de toda numeração', () => {
    expect(ordenarTamanhos(['G', '43/44', 'Único', 'P', '34']))
      .toEqual(['34', '43/44', 'P', 'G', 'Único']);
  });

  test('normaliza espaço e zero à esquerda, e preserva o par', () => {
    expect(normalizarTamanho('37 / 38')).toBe('37/38');
    expect(normalizarTamanho('05/06')).toBe('5/6');
    expect(normalizarTamanho('37/38')).toBe('37/38');
    // O que não é par continua como era.
    expect(normalizarTamanho('34')).toBe('34');
    expect(normalizarTamanho('u')).toBe('Único');
  });
});
