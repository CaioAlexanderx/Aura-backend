// ============================================================
// AURA. — O que falta pra loja ficar pronta
//
// A Finesse tem 143 peças publicadas. Todas com foto, nenhuma com marca,
// 37 sem tamanho, e ate 30/08 nenhuma com descricao. Nada disso aparece
// como erro em lugar nenhum: a loja simplesmente fica mais pobre, e a
// lojista nao tem como saber o que falta sem abrir peca por peca.
//
// Este modulo responde duas perguntas:
//   1. o que falta, e em quantas pecas          -> condicaoDeFalta / CAMPOS
//   2. como gravar varias de uma vez, com seguranca -> sanitizarItens
//
// POR QUE SERVICO E NAO ROTA: a regra de "o que conta como faltando" e a
// mesma na contagem, na listagem e no teste. Duplicar em SQL solto dentro
// da rota e como a contagem da barra de categorias divergiu do que a
// grade renderizava — o numero dizia 29 e apareciam 19.
// ============================================================

/**
 * Um campo so entra aqui se a AUSENCIA dele piora a loja de um jeito que
 * a lojista consegue consertar sozinha. "Sem NCM" nao entra: e fiscal,
 * nao vitrine. "Sem preco" nao entra: produto sem preco nem e vendido.
 *
 * A ordem e de IMPACTO, e e ela que a tela usa:
 *   foto      — sem foto a peca nem aparece (require_product_image)
 *   descricao — e o que responde "serve pra mim?" na pagina do produto
 *   tamanho   — sem tamanho a peca some do filtro de tamanho
 *   foto2     — segunda foto e a diferenca entre olhar e decidir
 *   marca     — cosmetico; ultima de proposito
 */
const CAMPOS = [
  {
    chave: 'foto',
    titulo: 'Foto do produto',
    // COM_FOTO em catalogoPaginado.js e a fonte da verdade do que conta
    // como "tem foto" na loja. Aqui e a negacao dela, e as duas tem que
    // continuar espelhadas — ver o teste.
    onde: `(
      btrim(COALESCE(products.image_url, '')) = ''
      AND (
        jsonb_typeof(products.gallery_urls) <> 'array'
        OR jsonb_array_length(products.gallery_urls) = 0
      )
    )`,
    editavel: false, // upload de imagem tem rota propria
  },
  {
    chave: 'descricao',
    titulo: 'Descrição',
    onde: `btrim(COALESCE(products.description, '')) = ''`,
    editavel: true,
    coluna: 'description',
  },
  {
    chave: 'tamanho',
    titulo: 'Tamanho',
    onde: `btrim(COALESCE(products.size, '')) = ''`,
    editavel: true,
    coluna: 'size',
  },
  {
    chave: 'foto2',
    titulo: 'Segunda foto',
    onde: `(
      jsonb_typeof(products.gallery_urls) <> 'array'
      OR jsonb_array_length(products.gallery_urls) < 2
    )`,
    editavel: false,
  },
  {
    chave: 'marca',
    titulo: 'Marca',
    onde: `btrim(COALESCE(products.brand, '')) = ''`,
    editavel: true,
    coluna: 'brand',
  },
];

// Map, e nao objeto: `chave` vem da query string, e num objeto comum
// POR_CHAVE['toString'] acha a funcao herdada do prototype e passa pelo
// `if (campo)`. Devolvia undefined em vez de null — a rota barrava do
// mesmo jeito, mas o guarda passava a depender de `.onde` ser undefined
// num objeto que nao e um campo. Map nao tem prototype pra herdar.
const POR_CHAVE = new Map(CAMPOS.map((c) => [c.chave, c]));

/** Fragmento SQL que isola as pecas em que o campo esta faltando. */
function condicaoDeFalta(chave) {
  const campo = POR_CHAVE.get(chave);
  return campo ? campo.onde : null;
}

/**
 * O universo de cada pendencia NAO e o mesmo.
 *
 * "Falta foto" pergunta sobre o catalogo inteiro — sao justamente as
 * pecas que a loja esta escondendo. Os outros campos perguntam sobre o
 * que JA esta na vitrine: mandar a lojista escrever descricao pra 1.159
 * pecas que ninguem ve seria trabalho jogado fora.
 */
function exigeFotoNoUniverso(chave) {
  return chave !== 'foto';
}

/** Quantas pecas o batch aceita de uma vez. */
const LIMITE_DO_LOTE = 200;

const COLUNAS_EDITAVEIS = Object.fromEntries(
  CAMPOS.filter((c) => c.editavel).map((c) => [c.coluna, c])
);

/** Tamanho maximo de cada campo, pra um paste acidental nao virar um TOAST. */
const LIMITE_DE_TEXTO = { description: 1200, size: 24, brand: 80 };

/**
 * Valida e normaliza o corpo do PATCH em lote.
 *
 * Regras, e cada uma existe por um motivo:
 *  • id ausente ou repetido -> item descartado. Repetido nao e erro do
 *    usuario, e a tela mandando duas vezes o mesmo cartao; vale o ULTIMO.
 *  • campo ausente (undefined) -> NAO mexe naquela coluna.
 *  • campo vazio ('') -> LIMPA a coluna. E deliberado: sem isso a lojista
 *    nao consegue apagar uma descricao que ficou errada.
 *  • nada conhecido no item -> descartado, senao um UPDATE no-op passaria
 *    por "salvo" na tela.
 */
function sanitizarItens(bruto) {
  if (!Array.isArray(bruto)) return { itens: [], descartados: 0 };

  const porId = new Map();
  let descartados = 0;

  for (const cru of bruto) {
    if (!cru || typeof cru !== 'object') { descartados++; continue; }
    const id = typeof cru.id === 'string' ? cru.id.trim() : '';
    if (!id) { descartados++; continue; }

    const item = { id };
    let temAlgo = false;
    for (const coluna of Object.keys(COLUNAS_EDITAVEIS)) {
      const v = cru[coluna];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') { continue; }
      item[coluna] = v.trim().slice(0, LIMITE_DE_TEXTO[coluna]);
      temAlgo = true;
    }
    if (!temAlgo) { descartados++; continue; }
    porId.set(id, item);
  }

  const itens = [...porId.values()].slice(0, LIMITE_DO_LOTE);
  return { itens, descartados: descartados + Math.max(0, porId.size - itens.length) };
}

module.exports = {
  CAMPOS,
  LIMITE_DO_LOTE,
  LIMITE_DE_TEXTO,
  condicaoDeFalta,
  exigeFotoNoUniverso,
  sanitizarItens,
};
