// ============================================================
// AURA — catálogo da loja comum, paginado
//
// A loja mandava 500 produtos de uma vez (419 KB na Finesse), desenhava
// os primeiros 60 e escrevia no rodapé "Mais 802 produtos no catálogo —
// use a busca". Para quem está comprando, essa frase diz "não vamos te
// atender, procure em outra loja".
//
// Agora a loja pagina: 24 por página, números embaixo da grade, catálogo
// inteiro alcançável. A página passa a nascer com UMA página de produtos
// em vez de 500 — a Finesse cai de 419 KB para ~30 KB.
//
// Filtro de categoria, busca e ordenação passam a ser do SERVIDOR: com
// paginação real, filtrar só o que está carregado esconderia resultado.
// ============================================================
'use strict';

// Import PREGUICOSO: config/database exige JWT_SECRET no carregamento, e
// as funcoes puras deste arquivo (janela de paginas, normalizacao, ordem)
// precisam ser testaveis sem banco e sem ambiente.
function bd() { return require('../config/database'); }

const { agruparPorFamilia } = require('./coresDaLoja');
const { agruparTamanhos } = require('./tamanhosDaLoja');

/** Quantos produtos por página. */
const POR_PAGINA = 24;

/** Teto de segurança: ninguém pede 10 mil de uma vez. */
const LIMITE_MAXIMO = 60;

/**
 * Produto disponivel, na MESMA regra que o cliente usa pra desenhar.
 *
 * O cliente escondia esgotado depois de receber a pagina, e a contagem
 * vinha do servidor sem esse filtro: em "Bolsa" a loja dizia "29
 * produtos" e mostrava 19. A conta de paginas saia errada pelo mesmo
 * motivo — paginas com buraco no fim.
 *
 * A regra e a de montarProdutoPublico: com variante ativa, basta uma com
 * saldo; sem variante, o saldo do proprio produto.
 */
const EM_ESTOQUE = `(
  CASE WHEN EXISTS (
    SELECT 1 FROM product_variants v
     WHERE v.product_id = products.id AND v.is_active = true
  )
  THEN EXISTS (
    SELECT 1 FROM product_variants v
     WHERE v.product_id = products.id AND v.is_active = true AND v.stock_qty > 0
  )
  ELSE products.stock_qty > 0
  END
)`;

/**
 * A peca tem foto? (migration 308)
 *
 * Capa OU galeria: a lojista pode ter subido foto pela galeria sem
 * definir capa, e esconder a peca nesse caso seria esconder trabalho que
 * ela ja fez.
 *
 * Isto e uma REGRA, nao uma lista. A diferenca importa: com lista, a peca
 * fotografada hoje so aparece quando alguem editar a lista; com regra,
 * ela acende sozinha. Ver migration 308.
 */
const COM_FOTO = `(
  btrim(COALESCE(products.image_url, '')) <> ''
  OR (
    jsonb_typeof(products.gallery_urls) = 'array'
    AND jsonb_array_length(products.gallery_urls) > 0
  )
)`;

/**
 * O filtro de foto, ou nada.
 *
 * Devolver a string 'TRUE' em vez de montar o WHERE condicionalmente
 * mantem UMA forma de query: quem le o SQL ve sempre a mesma lista de
 * filtros, e nao precisa segurar na cabeca dois formatos possiveis.
 */
function filtroDeFoto(exigeFoto) {
  return exigeFoto === true ? COM_FOTO : 'TRUE';
}

/** Janela do ranking de vendas. Decisao de Caio (02/09/2026): 90 dias. */
const JANELA_DE_VENDAS_DIAS = 90;

/**
 * Quantas unidades da peca sairam pelo Caixa na janela.
 *
 * UMA fonte pra ordenacao "Mais vendidos" da grade e pro bloco da home
 * (services/homeDaLoja.js). Troca fica de fora: `sales.type = 'troca'`
 * registra a peca nova que saiu no lugar de outra, nao uma venda —
 * armadilha 5 do CLAUDE.md, que ja inflou receita e inflaria ranking.
 */
const VENDIDOS_RECENTES = `(
    SELECT COALESCE(SUM(si.quantity), 0)
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
     WHERE si.product_id = products.id
       AND COALESCE(s.status, 'completed') <> 'cancelled'
       AND COALESCE(s.type, '') <> 'troca'
       AND s.created_at >= NOW() - INTERVAL '${JANELA_DE_VENDAS_DIAS} days'
  )`;

const ORDENS = {
  // A ordem que a lojista curou (featured primeiro) já vem do array de
  // destaques; sem ele, o mais recente na frente.
  destaque: 'created_at DESC',
  novidades: 'created_at DESC',
  // "Mais vendidos" nao e uma coluna: e uma subconsulta em sale_items.
  // A janela de 90 dias existe porque campeao de venda de dois anos atras
  // nao e o que a loja quer empurrar hoje — e porque sem recorte a ordem
  // congela e a vitrine nunca muda.
  //
  // NULLS LAST importa: produto nunca vendido tem SUM null, e sem isso o
  // Postgres o colocaria PRIMEIRO num ORDER BY DESC.
  mais_vendidos: `${VENDIDOS_RECENTES} DESC NULLS LAST, created_at DESC`,
  preco_asc: 'price ASC NULLS LAST',
  preco_desc: 'price DESC NULLS LAST',
  nome: 'name ASC',
};

function ordemSql(chave) {
  return ORDENS[String(chave || '').trim()] || ORDENS.destaque;
}

/** Normaliza para busca sem acento, igual ao cliente. */
function normalizar(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Uma página do catálogo.
 *
 * `visibilityWhere` chega de fora porque a regra de visibilidade mora no
 * builder e não pode ser reimplementada aqui — duas versões da mesma
 * regra é como produto de outra empresa vaza para a loja errada.
 */
async function paginaDoCatalogo({
  cid, visibilityWhere, offset, limit, categoria, busca, ordem, featuredIds,
  // migration 308 — a loja pode exigir foto. Chega de fora, como o
  // visibilityWhere, porque quem le a config e a rota.
  exigeFoto,
  // Filtros de atributo: arrays dos valores GRAVADOS (nao dos rotulos).
  // Quem traduz "M" para ['m','M'] e a rota, com agruparTamanhos.
  tamanhos, cores,
  // Faixa de preco (redesign 09/2026). Validada abaixo.
  precoMin, precoMax,
}) {
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const lim = Math.min(LIMITE_MAXIMO, Math.max(1, parseInt(limit, 10) || POR_PAGINA));

  const params = [cid];
  const filtros = [visibilityWhere, 'is_active IS NOT FALSE', EM_ESTOQUE, filtroDeFoto(exigeFoto)];

  // `featured_product_ids` nao e so ordenacao: quando a lojista cura a
  // lista, a loja mostra SO aqueles produtos. A pagina 1 vem embutida no
  // HTML com essa restricao, entao a rota tem que aplicar a mesma — senao
  // a pagina 2 traria produto que a pagina 1 nao mostra, e produto curado
  // apareceria duas vezes.
  const curados = Array.isArray(featuredIds) ? featuredIds.map(String).filter(Boolean) : [];
  let ordenacao = ordemSql(ordem);
  if (curados.length > 0) {
    params.push(curados);
    filtros.push(`id::text = ANY($${params.length})`);
    // Ordem curada primeiro; o criterio escolhido decide o desempate.
    ordenacao = `array_position($${params.length}, id::text), ${ordenacao}`;
  }

  // Categoria: por CAMINHO quando a loja tem arvore, por texto quando nao.
  //
  // O texto so consegue casar folha — nenhum produto tem
  // `category = 'Vestidos'`, porque Vestidos e um no de navegacao. Clicar
  // no pai traria zero, que e a pior forma de quebrar: silenciosa e
  // parecida com "acabou o estoque".
  //
  // O caminho resolve pai e folha com a mesma consulta: `/vestidos` casa
  // ele e tudo abaixo; `/vestidos/festa/vestido-midi-festa` casa so a
  // folha. O prefixo termina em '/' pra que `/vestidos` nao arraste um
  // futuro `/vestidos-infantil`.
  const cat = String(categoria == null ? '' : categoria).trim();
  if (cat && cat !== 'Todos') {
    if (cat.charAt(0) === '/') {
      params.push(cat);
      filtros.push(`EXISTS (
        SELECT 1 FROM product_category_links l
          JOIN product_categories c ON c.id = l.category_id
         WHERE l.product_id = products.id AND l.is_primary
           AND (c.path = $${params.length} OR left(c.path, length($${params.length}) + 1) = $${params.length} || '/')
      )`);
    } else {
      params.push(cat);
      filtros.push(`category = $${params.length}`);
    }
  }

  // ── Tamanho e cor ──────────────────────────────────────
  //
  // A regra que nao e obvia: os dois tem que casar na MESMA variante.
  // Duas condicoes separadas trariam o vestido que existe em "P azul" e
  // "G preto" quando a pessoa pede "P preto" — combinacao que a loja nao
  // tem. Por isso um unico EXISTS com as duas condicoes dentro.
  //
  // E so variante COM SALDO: o filtro promete uma peca comprável.
  const listaTam = Array.isArray(tamanhos) ? tamanhos.filter(Boolean) : [];
  const listaCor = Array.isArray(cores) ? cores.filter(Boolean) : [];
  if (listaTam.length || listaCor.length) {
    const dentro = [];
    if (listaTam.length) {
      params.push(listaTam);
      dentro.push(`EXISTS (SELECT 1 FROM product_variant_values t
                            WHERE t.variant_id = v.id
                              AND lower(t.attribute_name) IN ('tamanho','tamanhos')
                              AND t.value = ANY($${params.length}))`);
    }
    if (listaCor.length) {
      params.push(listaCor);
      dentro.push(`EXISTS (SELECT 1 FROM product_variant_values c
                            WHERE c.variant_id = v.id
                              AND lower(c.attribute_name) IN ('cor','cores')
                              AND c.value = ANY($${params.length}))`);
    }
    filtros.push(`EXISTS (
      SELECT 1 FROM product_variants v
       WHERE v.product_id = products.id AND v.is_active = true AND v.stock_qty > 0
         AND ${dentro.join(' AND ')}
    )`);
  }

  // Faixa de preco (redesign 09/2026): a pagina de categoria ganhou o
  // filtro. Valor ilegivel ou negativo e tratado como ausente — filtro que
  // esvazia a grade por causa de um "abc" na URL e pior que filtro nenhum.
  const pMin = Number(precoMin);
  const pMax = Number(precoMax);
  if (Number.isFinite(pMin) && pMin > 0) {
    params.push(pMin);
    filtros.push(`price >= $${params.length}`);
  }
  if (Number.isFinite(pMax) && pMax > 0) {
    params.push(pMax);
    filtros.push(`price <= $${params.length}`);
  }

  const termos = normalizar(busca).split(/\s+/).filter(Boolean);
  for (const termo of termos) {
    // unaccent não está garantido em toda base; lower + translate cobre
    // os acentos do português sem depender de extensão.
    params.push(`%${termo}%`);
    filtros.push(
      `translate(lower(coalesce(name,'') || ' ' || coalesce(description,'')),
                 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')
       LIKE $${params.length}`,
    );
  }

  const where = filtros.join(' AND ');

  const { rows: contagem } = await bd().query(
    `SELECT COUNT(*)::int AS n FROM products WHERE ${where}`,
    params,
  );
  const total = contagem[0] ? contagem[0].n : 0;

  params.push(lim, off);
  const { rows: produtos } = await bd().query(
    `SELECT id, name, description, price, image_url, gallery_urls, category, stock_qty, created_at,
            material, medidas, cuidados
     FROM products
     WHERE ${where}
     ORDER BY ${ordenacao}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { produtos, total, offset: off, limit: lim };
}

/**
 * Quantos produtos VISIVEIS cada categoria tem.
 *
 * A barra de categorias era montada a partir de PRODUCTS — ou seja, dos
 * produtos carregados. Com 500 embutidos isso quase funcionava; com
 * paginacao de 24, a Finesse (28 categorias) passou a mostrar so as
 * categorias que caiam na pagina 1. Regressao que a paginacao trouxe.
 *
 * A contagem vem junto porque "Vestidos 143" ajuda a escolher, e porque
 * categoria com zero produto visivel nao deve aparecer na barra.
 */
/**
 * A barra de categorias pela ARVORE, nao pelo texto.
 *
 * A barra sempre foi montada de `products.category` — o texto plano. Com
 * a Finesse a arvore virou real (Vestidos > Festa > Vestido Midi Festa) e
 * a barra continuava mostrando 12 folhas soltas: a organizacao existia no
 * banco e nao chegava na cliente.
 *
 * Cada no traz o total da PROPRIA SUBARVORE. "Vestidos 71" so significa
 * alguma coisa se somar Festa e Casual; contar so o que esta pendurado
 * direto no no daria 0 em todo pai, e a barra diria que a loja esta
 * vazia.
 *
 * Nos com zero produto visivel ficam de fora — categoria que abre numa
 * grade vazia e pior que categoria que nao existe.
 *
 * Devolve [] quando a loja nao tem arvore povoada. Quem chama cai no
 * comportamento antigo: hoje so 4 das lojas em producao tem vinculo, e
 * quebrar as outras para organizar uma nao e troca aceitavel.
 */
async function arvoreDeCategorias({ cid, visibilityWhere, exigeFoto }) {
  const sql = `
    WITH visiveis AS (
      SELECT l.category_id
        -- SEM ALIAS. visibilityWhere, EM_ESTOQUE e COM_FOTO sao fragmentos
        -- prontos que dizem products-ponto; um alias quebra os tres de uma
        -- vez com 42P01 — o mesmo codigo de "tabela nao existe", que o
        -- catch abaixo tolera. Foi assim que esta consulta ficou dias
        -- devolvendo vazio em producao.
        FROM products
        JOIN product_category_links l
          ON l.product_id = products.id AND l.is_primary
       WHERE ${visibilityWhere}
         -- Qualificado: nao ha conflito hoje, mas o proximo JOIN traz.
         AND products.is_active IS NOT FALSE
         AND ${EM_ESTOQUE}
         AND ${filtroDeFoto(exigeFoto)}
    )
    SELECT c.id, c.name AS nome, c.slug, c.path, c.depth,
           -- banner_url: a tira de categorias da home (so raizes). A
           -- coluna ja existia e ninguem lia; o catch de 42703 abaixo
           -- cobre base que ainda nao a tenha.
           c.banner_url,
           pai.slug AS pai_slug,
           (SELECT COUNT(*)::int FROM visiveis v
              JOIN product_categories d ON d.id = v.category_id
             WHERE d.company_id = c.company_id
               AND (d.id = c.id OR left(d.path, length(c.path) + 1) = c.path || '/')
           ) AS total
      FROM product_categories c
      LEFT JOIN product_categories pai ON pai.id = c.parent_id
     WHERE c.company_id = $1
       AND c.type = 'product'
       AND c.is_visible_storefront IS NOT FALSE
     ORDER BY c.depth, c.sort_order NULLS LAST, c.name`;
  try {
    const { rows } = await bd().query(sql, [cid]);
    return rows.filter((r) => r.total > 0);
  } catch (e) {
    // Base sem a arvore (42P01) ou sem alguma coluna dela (42703): a loja
    // abre com a barra antiga em vez de nao abrir.
    //
    // GRITA. Este catch ja escondeu um alias errado nesta mesma consulta,
    // que da 42P01 igualzinho. Ver o catch de facetasDoCatalogo.
    if (e.code === '42P01' || e.code === '42703') {
      console.error('[arvore-categorias] consulta falhou (' + e.code + '), barra cai na lista plana:', e.message);
      return [];
    }
    throw e;
  }
}

/**
 * As facetas de tamanho e cor, com a contagem de cada valor.
 *
 * A loja so filtrava por categoria. Quem entra procurando "vestido preto
 * tamanho M" precisava abrir peca por peca pra descobrir — e a Finesse ja
 * tem o dado: Cor em 81 das 112 pecas visiveis, Tamanho em 64.
 *
 * A CONTAGEM E DE PRODUTO, nao de variante. Um vestido com sete grades de
 * cor conta UMA vez em cada cor, nunca sete vezes em nenhuma — o numero
 * ao lado do filtro tem que casar com o que a grade mostra depois.
 *
 * So entra variante COM SALDO: filtro que leva a peca esgotada e pior que
 * filtro nenhum.
 */
async function facetasDoCatalogo({ cid, visibilityWhere, exigeFoto }) {
  const sql = `
    SELECT av.attribute_name AS atributo,
           av.value          AS valor,
           COUNT(DISTINCT products.id)::int AS total
      FROM products
      JOIN product_variants v        ON v.product_id = products.id AND v.is_active = true AND v.stock_qty > 0
      JOIN product_variant_values av ON av.variant_id = v.id
     WHERE ${visibilityWhere}
       -- QUALIFICADO: product_variants tambem tem is_active, e sem o
       -- prefixo o Postgres devolve 42702 (ambiguo). Nas outras consultas
       -- daqui nao ha JOIN, entao is_active cru bastava.
       AND products.is_active IS NOT FALSE
       AND ${filtroDeFoto(exigeFoto)}
       AND btrim(COALESCE(av.value, '')) <> ''
     GROUP BY av.attribute_name, av.value`;
  try {
    const { rows } = await bd().query(sql, [cid]);
    const porAtributo = {};
    for (const r of rows) {
      const a = String(r.atributo || '').trim();
      if (!porAtributo[a]) porAtributo[a] = [];
      porAtributo[a].push({ value: r.valor, total: r.total });
    }
    // Cor vira familia (151 hex viram ~20 nomes); tamanho vira regua.
    // Os outros atributos que a lojista tenha criado saem como estao.
    const saida = {};
    for (const a of Object.keys(porAtributo)) {
      const chave = a.toLowerCase();
      if (chave === 'cor' || chave === 'cores') {
        saida.cor = agruparPorFamilia(porAtributo[a]);
      } else if (chave === 'tamanho' || chave === 'tamanhos') {
        saida.tamanho = agruparTamanhos(porAtributo[a]);
      }
    }
    return saida;
  } catch (e) {
    // Base sem as tabelas de variante: a loja abre sem filtro em vez de
    // nao abrir.
    //
    // MAS GRITA NO LOG. Este catch ja engoliu um bug meu: a consulta
    // usava `FROM products p` enquanto visibilityWhere e o filtro de foto
    // referenciam `products.`, o que da 42P01 — o MESMO codigo de "tabela
    // nao existe". O filtro voltou vazio em producao sem nenhum sinal.
    // Um catch que tolera uma classe de erro acaba tolerando um bug dessa
    // classe; o log e o que separa os dois.
    if (e.code === '42P01' || e.code === '42703') {
      console.error('[facetas] consulta falhou (' + e.code + '), loja abre sem filtro:', e.message);
      return {};
    }
    throw e;
  }
}

/**
 * O menor e o maior preco entre as pecas visiveis.
 *
 * O filtro de preco da pagina de categoria desenha as faixas a partir
 * disto, em vez de "ate R$ 200 / 200 a 300 / acima de 300" fixos: numa
 * loja de bijuteria as tres faixas cairiam na primeira. Devolve null
 * quando nao ha peca com preco.
 */
async function faixaDePreco({ cid, visibilityWhere, exigeFoto }) {
  const sql = `
    SELECT MIN(price)::float AS min, MAX(price)::float AS max
      FROM products
     WHERE ${visibilityWhere}
       AND is_active IS NOT FALSE
       AND ${EM_ESTOQUE}
       AND ${filtroDeFoto(exigeFoto)}
       AND price IS NOT NULL AND price > 0`;
  try {
    const { rows } = await bd().query(sql, [cid]);
    const r = rows[0];
    if (!r || r.min == null || r.max == null) return null;
    return { min: r.min, max: r.max };
  } catch (e) {
    console.error('[faixa-de-preco] consulta falhou (' + e.code + '):', e.message);
    return null;
  }
}

async function contarPorCategoria({ cid, visibilityWhere, exigeFoto }) {
  const { rows } = await bd().query(
    `SELECT category AS nome, COUNT(*)::int AS total
       FROM products
      WHERE ${visibilityWhere}
        AND is_active IS NOT FALSE
        AND ${EM_ESTOQUE}
        AND ${filtroDeFoto(exigeFoto)}
        AND category IS NOT NULL
        AND btrim(category) <> ''
      GROUP BY category
      ORDER BY COUNT(*) DESC, category ASC`,
    [cid],
  );
  return rows;
}

/**
 * Números de página para a barra.
 *
 * Com 55 páginas não dá para desenhar 55 botões. Mostra as vizinhas, a
 * primeira, a última, e reticências no meio — o padrão que todo mundo já
 * sabe usar sem aprender.
 */
function janelaDePaginas(atual, totalPaginas, vizinhas = 1) {
  if (totalPaginas <= 1) return [1];
  const p = Math.min(Math.max(1, atual), totalPaginas);
  const set = new Set([1, totalPaginas]);
  for (let i = p - vizinhas; i <= p + vizinhas; i++) {
    if (i >= 1 && i <= totalPaginas) set.add(i);
  }
  const ordenadas = [...set].sort((a, b) => a - b);

  const saida = [];
  let anterior = 0;
  for (const n of ordenadas) {
    if (anterior && n - anterior > 1) saida.push('...');
    saida.push(n);
    anterior = n;
  }
  return saida;
}

module.exports = {
  POR_PAGINA, LIMITE_MAXIMO, EM_ESTOQUE, COM_FOTO, filtroDeFoto,
  JANELA_DE_VENDAS_DIAS, VENDIDOS_RECENTES,
  arvoreDeCategorias, facetasDoCatalogo, faixaDePreco,
  paginaDoCatalogo, contarPorCategoria, janelaDePaginas, normalizar, ordemSql,
};
