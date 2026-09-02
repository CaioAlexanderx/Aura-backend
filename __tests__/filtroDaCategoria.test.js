// ============================================================
// O filtro lateral mostra as opções DA CATEGORIA (02/09/2026)
//
// As facetas nasceram lendo a loja inteira, e o comentário original
// explicava por quê: com paginação de 24, derivar das peças carregadas
// daria um filtro que muda de opções conforme a pessoa navega.
//
// Esse raciocínio vale contra derivar da PÁGINA — não contra recortar
// pela CATEGORIA. Recortar por categoria é estável: só muda quando a
// pessoa muda de categoria, que é exatamente quando ela espera.
//
// O preço disso apareceu na Davi Calçados: 40 chips de numeração na
// lateral — do 17 ao 44, mais 95, 100 e 110, que são tamanhos de CINTO —
// dentro de "Infantil > Botas", onde só existe do 17 ao 36.
//
// A regra que este teste guarda, e que é a parte fácil de errar: as
// opções são calculadas SEM o próprio tamanho/cor selecionado. Com o
// filtro aplicado sobre si mesmo, escolher "38" apagaria os outros
// números da régua e a pessoa não teria como trocar sem limpar tudo.
// ============================================================
const fs = require('fs');
const path = require('path');
const { condicaoDeCategoria } = require('../src/services/catalogoPaginado');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const parts = (f) => fonte('src/templates/storefront/parts/' + f);

describe('condicaoDeCategoria: uma fonte para as três consultas', () => {
  test('caminho casa o nó e a subárvore', () => {
    const params = ['cid'];
    const sql = condicaoDeCategoria('/feminino', params);
    expect(params).toEqual(['cid', '/feminino']);
    expect(sql).toContain('c.path = $2');
    expect(sql).toContain("left(c.path, length($2) + 1) = $2 || '/'");
    expect(sql).toContain('l.is_primary');
  });

  test('texto plano continua atendido — loja sem árvore', () => {
    const params = ['cid'];
    expect(condicaoDeCategoria('Vestidos', params)).toBe('category = $2');
    expect(params).toEqual(['cid', 'Vestidos']);
  });

  test('sem categoria não filtra nada e não consome parâmetro', () => {
    for (const v of [null, undefined, '', '   ', 'Todos']) {
      const params = ['cid'];
      expect(condicaoDeCategoria(v, params)).toBeNull();
      expect(params).toEqual(['cid']);
    }
  });

  test('as três consultas usam a MESMA função', () => {
    const src = fonte('src/services/catalogoPaginado.js');
    // paginaDoCatalogo, facetasDoCatalogo e faixaDePreco.
    expect((src.match(/condicaoDeCategoria\(/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(src).toContain('async function facetasDoCatalogo({ cid, visibilityWhere, exigeFoto, categoria })');
    expect(src).toContain('async function faixaDePreco({ cid, visibilityWhere, exigeFoto, categoria })');
  });

  test('as facetas NÃO recebem tamanho/cor', () => {
    // Se recebessem, escolher "38" apagaria os outros números da régua.
    // A asserção é sobre a ASSINATURA: 'tamanho'/'cores' aparecem no corpo
    // como nome de atributo do banco, o que é outra coisa.
    const src = fonte('src/services/catalogoPaginado.js');
    const assinatura = src.slice(
      src.indexOf('async function facetasDoCatalogo'),
      src.indexOf(')', src.indexOf('async function facetasDoCatalogo')),
    );
    expect(assinatura).toBe('async function facetasDoCatalogo({ cid, visibilityWhere, exigeFoto, categoria }');
  });
});

describe('a rota devolve as facetas da categoria pedida', () => {
  const rota = fonte('src/routes/storefront.js');

  test('facetas e faixa de preço usam a MESMA categoria da grade', () => {
    // req.query.cat — o mesmo parâmetro que paginaDoCatalogo recebe. Se
    // divergisse, a lateral falaria de uma categoria e a grade de outra.
    expect(rota).toContain('categoria: req.query.cat,');
    expect((rota.match(/categoria: req\.query\.cat,/g) || []).length).toBe(3);
  });

  test('vão na resposta do catálogo', () => {
    expect(rota).toContain('facetas,');
  });

  test('falha na consulta não esvazia a lateral', () => {
    // null = o cliente mantém as opções que já tinha. Esvaziar seria pior
    // que não atualizar: some o filtro inteiro sem a pessoa ter pedido.
    expect(rota).toContain("console.error('[storefront] facetas da categoria:'");
    expect(rota).toContain('return null;');
  });
});

describe('o cliente troca as opções e limpa o que não existe mais', () => {
  const filtros = parts('filtros.js');
  const produtos = parts('products.js');

  test('atualizarFacetas ignora resposta sem facetas', () => {
    expect(filtros).toContain('if(!novas) return false;');
  });

  test('seleção fora da categoria nova cai', () => {
    expect(filtros).toContain('tamSel = tamSel.filter(function(r){ return tams.indexOf(r) >= 0; });');
    expect(filtros).toContain('corSel = corSel.filter(function(f){ return fams.indexOf(f) >= 0; });');
    expect(filtros).toContain('if(precoSel!=null && !FAIXAS[precoSel]) precoSel = null;');
  });

  test('e a busca se refaz quando algo caiu', () => {
    // Senão a grade continuaria filtrada por um chip que sumiu da lateral.
    expect(filtros).toContain('return (tamSel.length + corSel.length + (precoSel!=null?1:0)) < antes;');
    expect(produtos).toContain("if(typeof atualizarFacetas==='function' && atualizarFacetas(j.facetas)){");
    expect(produtos).toContain('irParaPagina(1,{rolar:false});');
  });

  test('as faixas de preço são recalculadas junto', () => {
    // A faixa nasce do menor e do maior preço; recortada por categoria,
    // "até R$ 150" numa loja de tênis não é a mesma de uma de chinelo.
    const i = filtros.indexOf('function atualizarFacetas');
    expect(filtros.slice(i, i + 900)).toContain('faixasDePreco(FACETAS.preco.min, FACETAS.preco.max)');
  });
});
