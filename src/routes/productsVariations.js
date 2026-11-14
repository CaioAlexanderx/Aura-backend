// ============================================================
// AURA. -- Products Variations v2 (reformulado)
// Mount: /companies/:id/products/:pid/variations
//
// Nova UX: produto pai tem listas de cores e tamanhos; matriz
// cor x tamanho forma o estoque por combinacao. Preco unico do pai.
//
// Shape da API:
//   GET  -> { colors: [{hex, name, name_sugerido}] (name = SO o color_name da 414, ou null; name_sugerido = o pedaco do sku_suffix quando name e null — 14/11/2026), sizes: ["P","M"], matrix: {"#FF0000|P": 5, ...}, barcodes: {"#FF0000|P": "7891234567890", ...}, images: {"#FF0000|P": "https://..."}, mode: 'none'|'color'|'size'|'matrix' }
//   PUT  -> recebe mesmo shape; atualiza no lugar o que continua, cria o novo, desativa o que saiu (10/11/2026).
//           14/11/2026: name vazio ou ausente mantem o color_name gravado; em variante antiga
//           (color_name NULL) o eco do GET (pedaco do sufixo ou nome da paleta do app) nao e gravado.
//
// Schema preservado: usa product_variants + product_variant_values
// Cada combinacao = 1 row em product_variants + 1-2 rows em
// product_variant_values (attribute_name='Cor' ou 'Tamanho').
//
// Soft-delete (is_active=false) em vez de DELETE porque sale_items
// tem FK NO ACTION em variant_id (preserva historico de vendas).
//
// 08/05/2026: ao salvar variantes, se uma combinacao criada coincide
// com color/size proprios do pai, limpamos color=NULL e size=NULL do
// pai pra evitar dupla exibicao no VariantPickerModal e loop de
// banner-amarelo no editor (ver comentario no UPDATE final).
//
// 21/05/2026: GET expoe barcodes por combinacao (paralelo ao matrix).
// PUT aceita barcodes e persiste em product_variants.barcode no INSERT.
//
// 22/05/2026: GET e PUT usam visibilityWhere para casos multi-CNPJ
// (produto shared visto por subsidiaria). Bug Davi: editava produto
// shared logado na Villa Branca, GET caia em 404 com o filtro naive
// company_id=$cid -> frontend mostrava mode='none' falso -> user nao
// via variantes nem conseguia ajustar estoque. Mesma armadilha que
// o PR #77 corrigiu pra productImage.js (memoria
// armadilha_visibility_leaks_rotas_produto).
//
// 23/05/2026: GET expoe `images` map (matrixKey -> image_url) das
// variantes ativas. PUT preserva image_url no soft-delete + INSERT:
// antes do soft-delete, snapshota mapa (color,size) -> image_url;
// apos INSERT, reaplica image_url nas variantes recriadas com a
// mesma combinacao. Sem esse rewrite, qualquer auto-save (que dispara
// a cada blur) limpava as fotos. Migration 129 (image_url TEXT).
//
// 01/06/2026 (FIX corrida auto-save): o PUT agora adquire
// pg_advisory_xact_lock por produto logo apos o BEGIN. O auto-save do
// editor (debounce 400ms + onBlur flush) disparava PUTs concorrentes do
// MESMO produto; como cada PUT faz soft-delete-de-todas + insert-de-todas,
// dois saves simultaneos deixavam MULTIPLAS variantes ativas pro mesmo
// (cor,tamanho) e zeravam estoque. Foi a causa da corrupcao do catalogo
// Davi (206 grupos com variantes duplicadas + 636 produtos com stock_qty
// divergente das variantes, limpos via data fix em 01/06). O advisory lock
// serializa os saves por produto e fecha a corrida. O lock e liberado
// automaticamente no COMMIT/ROLLBACK da transacao.
//
// 10/11/2026 (fix estoque preso): o PUT NAO reescreve mais a grade. A
// combinacao que continua (mesmo hex, sem diferenca de caixa, e mesmo
// tamanho) e atualizada na mesma linha; so a nova e criada e so a que sai
// e desativada (deactivated_reason='removida_da_grade'). Sair com estoque
// > 0 exige confirmar_remocao_com_estoque=true (senao 409). O rewrite
// antigo deixou, so na Finesse, 8.146 variantes inativas — 2.862 com
// stock_qty > 0 — e perdia price_override, promocao e miniatura a cada
// Salvar. Regras em services/gradeDeVariantes.js.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
// 08/09/2026 (migration 323): a galeria por cor sai no mesmo GET.
const { agruparGaleria } = require('../services/productImageGallery');
// 10/11/2026: a grade e atualizada no lugar, nao reescrita (ver o servico).
const { planejarGrade } = require('../services/gradeDeVariantes');
// 14/11/2026: o pedaco cortado do sku_suffix nao vira nome da cor.
const {
  coresDoProduto, resolverNomeDaCor, nomeSugeridoDoSufixo, chaveDoHex,
} = require('../services/nomeDaCorNaGrade');

// ─── 30/06/2026: Normalizacao de cor (nome -> hex) ───────────
// Imports/legados gravavam NOME no atributo Cor (ex.: "DARK BROWN",
// "PRETO") em vez de hex; a validacao estrita travava o save inteiro
// com erro generico ("hex deve ser no formato #RRGGBB"), bloqueando
// edicao de cor E upload de foto da variante (caso Davi Calcados).
// Agora o PUT tolera nomes conhecidos (porta de utils/colorNames.ts) e,
// se nao reconhecer, retorna erro NOMEANDO a cor problematica.
const COLOR_NAME_TO_HEX = {
  'preto': '#000000', 'branco': '#FFFFFF', 'cinza': '#808080',
  'cinza claro': '#C8C8C8', 'cinza escuro': '#404040',
  'vermelho': '#EF4444', 'vinho': '#800020', 'rosa': '#EC4899',
  'rosa claro': '#FFB6C1', 'laranja': '#F97316', 'amarelo': '#EAB308',
  'marrom': '#8B4513', 'caramelo': '#BD7100', 'bege': '#F5DEB3',
  'nude': '#F0EBDF', 'verde': '#22C55E', 'verde escuro': '#006400',
  'verde agua': '#8BE8B3', 'azul': '#3B82F6', 'azul escuro': '#00008B',
  'azul claro': '#ADD8E6', 'azul marinho': '#000050', 'roxo': '#8B5CF6',
  'violeta': '#6D28D9', 'dourado': '#DAA520', 'prata': '#C0C0C0',
  // aliases EN + casos de import conhecidos
  'black': '#000000', 'white': '#FFFFFF', 'red': '#EF4444',
  'blue': '#3B82F6', 'green': '#22C55E', 'yellow': '#EAB308',
  'pink': '#EC4899', 'orange': '#F97316', 'purple': '#8B5CF6',
  'brown': '#8B4513', 'gray': '#808080', 'grey': '#808080',
  'gold': '#DAA520', 'silver': '#C0C0C0',
  'dark brown': '#654321', 'darkbrown': '#654321',
};
function colorNorm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}
// Retorna hex valido (preservando o caso quando ja e hex, pra nao
// quebrar as chaves de matrix/barcodes) ou null se irreconhecivel.
function coerceColorHex(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(t)) return t;          // ja e hex: passthrough
  if (/^[0-9A-Fa-f]{6}$/.test(t)) return '#' + t;     // hex sem '#'
  return COLOR_NAME_TO_HEX[colorNorm(t)] || null;     // nome conhecido
}

// ─── Visibilidade de grupo (BIDIRECIONAL) ────────────────
//
// Copia da funcao canonica em src/routes/products.js. Replicada
// aqui (em vez de importada) para evitar dependencia entre routers.
// Se a logica do canonico mudar (raro — produto-membership e padrao
// estavel desde 08/05/2026), atualizar ambos.
//
// Regra: produto P visivel para empresa X se
//   P.company_id = X
//   OU (P.is_group_shared E group_root(P.company_id) = group_root(X))
//
// SQL: COALESCE(NULLIF(billing_owner_company_id, id), id) = group_root.
function visibilityWhere(idParam, cidParam) {
  return `id = ${idParam} AND (company_id = ${cidParam} OR (
    is_group_shared = true
    AND company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

// Helpers
function buildMatrixKey(colorHex, sizeValue) {
  return (colorHex || '') + '|' + (sizeValue || '');
}

function skuSuffixFromAttrs(colorHex, colorName, sizeValue) {
  // Ex: "#FF0000" + "P" -> "VERMELHO-P"; "#FF0000" alone -> "VERMELHO"
  // Usa hex puro se nao tiver nome.
  const parts = [];
  if (colorHex) parts.push((colorName || colorHex.replace('#', '')).toUpperCase().slice(0, 10));
  if (sizeValue) parts.push(String(sizeValue).toUpperCase().slice(0, 10));
  return parts.join('-');
}

// 26/10/2026 (tq-55b, migration 414): o nome da cor como a lojista digitou
// vai para product_variants.color_name, sem caixa alta nem corte (o
// sku_suffix continua o de sempre). 14/11/2026: as regras (o que e nome,
// o que e eco do servidor, vazio mantem) moram em services/nomeDaCorNaGrade.js.

// 23/05/2026: Extrai a combinacao (color_hex, size_value) de um array
// de attributes vindo do GET. Usado tanto pelo GET (expor images map)
// quanto pelo PUT (snapshot pra preservar fotos no rewrite).
function extractAttrs(attributes) {
  let colorHex = null, sizeValue = null;
  for (const a of attributes || []) {
    const name = String(a.attribute || '').toLowerCase();
    if (name === 'cor' || name === 'color') colorHex = a.value;
    else if (name === 'tamanho' || name === 'size') sizeValue = a.value;
  }
  return { colorHex, sizeValue };
}

// GET /companies/:id/products/:pid/variations
router.get('/:pid/variations', async (req, res) => {
  const { id: cid, pid } = req.params;
  try {
    // 22/05/2026: visibilityWhere em vez de "id=$1 AND company_id=$2"
    // pra que subsidiarias do grupo enxerguem variantes de produtos
    // shared do billing_owner (bug Davi Villa Branca).
    const { rows: prodRows } = await db.query(
      `SELECT id, name, stock_qty FROM products WHERE ${visibilityWhere('$1', '$2')}`,
      [pid, cid]
    );
    if (!prodRows.length) return res.status(404).json({ error: 'Produto nao encontrado' });

    // Busca variantes ativas + atributos (23/05/2026: inclui image_url)
    const { rows: variantRows } = await db.query(
      `SELECT pv.id, pv.sku_suffix, pv.stock_qty, pv.barcode, pv.image_url, pv.color_name,
        COALESCE(json_agg(
          json_build_object('attribute', pvv.attribute_name, 'value', pvv.value)
          ORDER BY pvv.attribute_name
        ) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes
       FROM product_variants pv
       LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
       WHERE pv.product_id = $1 AND pv.is_active = true
       GROUP BY pv.id, pv.sku_suffix, pv.stock_qty, pv.barcode, pv.image_url, pv.color_name
       ORDER BY pv.created_at ASC`,
      [pid]
    );

    // Decompoe variantes em cores, tamanhos, matriz, barcodes e images (23/05/2026)
    const colorsMap = new Map();   // hex -> name
    const sizesSet = new Set();
    const matrix = {};
    const barcodes = {};   // matrixKey -> barcode (21/05/2026)
    const images = {};     // matrixKey -> image_url (23/05/2026)

    const sugeridos = new Map();   // hex -> parte da cor do sku_suffix (14/11/2026)
    for (const v of variantRows) {
      const { colorHex, sizeValue } = extractAttrs(v.attributes);
      // 14/11/2026: colors[].name e SO o color_name gravado (migration 414),
      // ou null. O pedaco do sku_suffix ("AZUL ESCUR", cortado em 10 letras)
      // vai a parte em name_sugerido: devolvido como nome, o editor o
      // mandava de volta no Salvar e o PUT o gravava como nome da cor.
      const colorName = colorHex && v.color_name ? v.color_name : null;
      if (colorHex && !sugeridos.get(colorHex)) {
        sugeridos.set(colorHex, nomeSugeridoDoSufixo(v.sku_suffix, sizeValue));
      }
      if (colorHex) colorsMap.set(colorHex, colorName || colorsMap.get(colorHex) || null);
      if (sizeValue) sizesSet.add(sizeValue);
      const key = buildMatrixKey(colorHex, sizeValue);
      matrix[key] = parseInt(v.stock_qty) || 0;
      if (v.barcode) barcodes[key] = v.barcode;
      if (v.image_url) images[key] = v.image_url;   // 23/05/2026
    }

    const colors = Array.from(colorsMap.entries()).map(([hex, name]) => ({
      hex,
      name,
      // So sugestao, nunca o nome gravado: null quando a cor tem nome.
      name_sugerido: name ? null : (sugeridos.get(hex) || null),
    }));
    const sizes = Array.from(sizesSet);

    let mode = 'none';
    if (colors.length > 0 && sizes.length > 0) mode = 'matrix';
    else if (colors.length > 0) mode = 'color';
    else if (sizes.length > 0) mode = 'size';

    // 08/09/2026 (migration 323): a galeria por cor vem junto. Este GET ja
    // e por UM produto — e a tela que edita as cores e a mesma que edita
    // as fotos delas, entao uma query a mais aqui poupa um round-trip por
    // cor no editor. `images` (o mapa antigo cor|tamanho -> foto unica)
    // continua igual: ADICIONA, NUNCA REMOVE.
    let galeria = { main: [], by_color: {} };
    try {
      const { rows: fotoRows } = await db.query(
        `SELECT id, color_hex, url, thumb_url, position
           FROM product_images
          WHERE product_id = $1
          ORDER BY color_hex NULLS FIRST, position ASC, created_at ASC`,
        [pid]
      );
      galeria = agruparGaleria(fotoRows);
    } catch (e) {
      // 42P01: base ainda sem a migration 323 — o editor abre sem galeria
      // em vez de nao abrir (CLAUDE.md, armadilha 1).
      if (e.code !== '42P01') throw e;
    }

    res.json({
      product_id: pid,
      product_name: prodRows[0].name,
      colors,
      sizes,
      matrix,
      barcodes,
      images,   // 23/05/2026: foto por combinacao
      gallery: galeria,   // 08/09/2026: { main: [...], by_color: { "#hex": [...] } }
      mode,
      total_variants: variantRows.length,
    });
  } catch (err) {
    console.error('[productsVariations GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar variacoes' });
  }
});

// PUT /companies/:id/products/:pid/variations
// Body: { colors: [{hex, name?}], sizes: ["P","M"], matrix: {"hex|size": stock, ...}, barcodes: {"hex|size": "ean", ...} }
//       + opcionais: confirmar_remocao_com_estoque (bool), matrix_lida ({"hex|size": n})
// Atualiza no lugar o que continua, cria o novo, desativa o que saiu.
router.put('/:pid/variations', async (req, res) => {
  const { id: cid, pid } = req.params;
  // 21/05/2026: barcodes adicionado ao body (opcional, padrao vazio)
  const { colors = [], sizes = [], matrix = {}, barcodes = {} } = req.body || {};
  // 10/11/2026 (fix estoque preso):
  //  - confirmar_remocao_com_estoque: true deixa sair da grade a cor/tamanho
  //    que ainda tem pecas (sem ele, 409 GRADE_REMOCAO_COM_ESTOQUE);
  //  - matrix_lida: a matriz que o editor leu ao abrir. Celula com o mesmo
  //    valor dela nao foi mexida, e o estoque do banco fica (venda feita
  //    com o editor aberto nao volta para a prateleira).
  const confirmarRemocao = !!(req.body && req.body.confirmar_remocao_com_estoque === true);
  const matrizLida = req.body && req.body.matrix_lida && typeof req.body.matrix_lida === 'object'
    ? req.body.matrix_lida : null;
  const veioBarcodes = !!(req.body && Object.prototype.hasOwnProperty.call(req.body, 'barcodes'));

  // Validacoes
  if (!Array.isArray(colors) || !Array.isArray(sizes)) {
    return res.status(400).json({ error: 'colors e sizes devem ser arrays' });
  }
  if (colors.length > 30 || sizes.length > 30) {
    return res.status(400).json({ error: 'Maximo de 30 cores ou 30 tamanhos' });
  }

  // 30/06/2026: valida E normaliza cada cor. Aceita hex (#RRGGBB) ou
  // nome de cor conhecido (ex.: "Preto", "DARK BROWN"); coage o nome
  // para hex. Se uma cor for irreconhecivel, retorna erro NOMEANDO ela
  // (em vez do erro generico que travava o save inteiro). Quando uma cor
  // e coagida, reescrevemos as chaves de matrix/barcodes (que vinham com
  // o token antigo) pra nao perder estoque/codigo de barras.
  const colorKeyRemap = [];   // { from, to }
  for (const c of colors) {
    const original = c && (c.hex != null ? c.hex : (c.name != null ? c.name : null));
    const hex = coerceColorHex(original);
    if (!hex) {
      const shown = (original === null || original === undefined || original === '')
        ? '(vazio)' : String(original);
      return res.status(400).json({
        error: 'Cor invalida: "' + shown + '". Use o seletor de cor (#RRGGBB) ou um nome reconhecido.',
      });
    }
    if (c.hex !== hex) {
      if (c.hex != null && c.hex !== hex) colorKeyRemap.push({ from: c.hex, to: hex });
      c.hex = hex;
    }
  }
  // Reescreve chaves de matrix/barcodes que usavam o token de cor antigo.
  if (colorKeyRemap.length > 0) {
    for (const map of [matrix, barcodes]) {
      for (const k of Object.keys(map)) {
        const sep = k.indexOf('|');
        const h = sep >= 0 ? k.slice(0, sep) : k;
        const sz = sep >= 0 ? k.slice(sep + 1) : '';
        const hit = colorKeyRemap.find(r => r.from === h);
        if (hit) {
          const nk = hit.to + '|' + sz;
          if (!(nk in map)) map[nk] = map[k];
          delete map[k];
        }
      }
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 01/06/2026: serializa PUTs concorrentes do MESMO produto. O auto-save
    // do editor (debounce 400ms + onBlur flush) disparava saves simultaneos;
    // como cada PUT faz soft-delete-de-todas + insert-de-todas, a corrida
    // deixava variantes ativas duplicadas pro mesmo (cor,tamanho) e zerava
    // estoque (corrupcao do catalogo Davi). hashtext($1) -> int4 estavel por
    // product_id; o lock e transaction-scoped (liberado no COMMIT/ROLLBACK).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pvariations:' + pid]);

    // Valida produto + captura color/size proprios atuais (necessario pra
    // detectar migracao do estoque do pai pra variante e limpar os campos
    // depois — evita dupla exibicao no VariantPickerModal e loop de banner
    // amarelo no editor).
    //
    // 22/05/2026: visibilityWhere em vez de "id=$1 AND company_id=$2"
    // (mesmo motivo do GET — subsidiarias precisam editar produtos shared).
    const { rows: prodRows } = await client.query(
      `SELECT id, color, size FROM products WHERE ${visibilityWhere('$1', '$2')}`,
      [pid, cid]
    );
    if (!prodRows.length) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Produto nao encontrado' });
    }
    const parentColor = prodRows[0].color || null;
    const parentSize  = prodRows[0].size  || null;

    // 10/11/2026 (fix estoque preso): le as variantes ATIVAS com estoque e
    // atributos. Antes daqui o PUT desativava todas e criava todas de novo
    // a cada Salvar; agora a combinacao que continua na grade e atualizada
    // na mesma linha (services/gradeDeVariantes.js explica as regras).
    const { rows: atuais } = await client.query(
      `SELECT pv.id, pv.stock_qty, pv.sku_suffix, pv.color_name,
         COALESCE(json_agg(
           json_build_object('attribute', pvv.attribute_name, 'value', pvv.value)
           ORDER BY pvv.attribute_name
         ) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes
       FROM product_variants pv
       LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
       WHERE pv.product_id = $1 AND pv.is_active = true
       GROUP BY pv.id, pv.stock_qty, pv.sku_suffix, pv.color_name, pv.created_at
       ORDER BY pv.created_at ASC, pv.id ASC`,
      [pid]
    );
    const existentes = atuais.map((row) => {
      const { colorHex, sizeValue } = extractAttrs(row.attributes);
      let colorName = row.color_name || null;
      if (!colorName && colorHex && row.sku_suffix) {
        const first = String(row.sku_suffix).split('-')[0];
        if (first && !/^[0-9A-F]{6}$/i.test(first)) colorName = first.charAt(0) + first.slice(1).toLowerCase();
      }
      return { id: row.id, colorHex, sizeValue, colorName, stock: parseInt(row.stock_qty) || 0 };
    });

    // 14/11/2026: o que fazer com o nome de cada cor (services/nomeDaCorNaGrade).
    // Variante antiga (color_name NULL) nao ganha como nome o eco do GET — o
    // pedaco cortado do sufixo ou o nome da paleta do app — e nome vazio nao
    // apaga o que esta gravado.
    const coresAtuais = coresDoProduto(atuais.map((row, i) => ({
      colorHex: existentes[i].colorHex,
      sizeValue: existentes[i].sizeValue,
      sku_suffix: row.sku_suffix,
      color_name: row.color_name,
    })));
    const skuAtualPorId = new Map(atuais.map((row) => [row.id, row.sku_suffix]));
    const nomePorCor = new Map();
    for (const c of colors) {
      const k = chaveDoHex(c.hex);
      if (!nomePorCor.has(k)) nomePorCor.set(k, resolverNomeDaCor(c.hex, c.name, coresAtuais.get(k)));
    }

    // Monta lista de combinacoes a criar baseado nos inputs
    // - Se tem cores E tamanhos: matriz completa (N*M combinacoes)
    // - Se so tem cores: 1 variante por cor
    // - Se so tem tamanhos: 1 variante por tamanho
    // - Se nao tem nenhum: produto simples (sem variantes)
    const combinations = [];
    if (colors.length > 0 && sizes.length > 0) {
      for (const c of colors) {
        for (const s of sizes) {
          const key = buildMatrixKey(c.hex, s);
          combinations.push({
            colorHex: c.hex, colorName: c.name || null, nomeDaCor: nomePorCor.get(chaveDoHex(c.hex)),
            sizeValue: s,
            stock: parseInt(matrix[key]) || 0,
          });
        }
      }
    } else if (colors.length > 0) {
      for (const c of colors) {
        const key = buildMatrixKey(c.hex, null);
        combinations.push({
          colorHex: c.hex, colorName: c.name || null, nomeDaCor: nomePorCor.get(chaveDoHex(c.hex)),
          sizeValue: null,
          stock: parseInt(matrix[key]) || 0,
        });
      }
    } else if (sizes.length > 0) {
      for (const s of sizes) {
        const key = buildMatrixKey(null, s);
        combinations.push({
          colorHex: null, colorName: null, nomeDaCor: null,
          sizeValue: s,
          stock: parseInt(matrix[key]) || 0,
        });
      }
    }

    const plano = planejarGrade({
      existentes,
      combinacoes: combinations,
      matrizLida,
      confirmarRemocao,
    });

    // Tirar da grade uma cor/tamanho que ainda tem pecas: so com
    // confirmacao explicita. Sem ela, nada e gravado.
    if (plano.bloqueio) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({
        error: plano.bloqueio.mensagem,
        code: 'GRADE_REMOCAO_COM_ESTOQUE',
        removidas: plano.bloqueio.removidas.map((r) => ({
          key: buildMatrixKey(r.colorHex, r.sizeValue),
          color_hex: r.colorHex, color_name: r.colorName, size: r.sizeValue, stock: r.stock,
        })),
      });
    }

    // Sai da grade (preserva sale_items FK: soft-delete, nunca DELETE).
    // O motivo fica gravado: inativa com estoque e motivo NULL passa a ser
    // so o legado do rewrite antigo, que a medicao separa.
    for (const v of plano.remover) {
      await client.query(
        `UPDATE product_variants SET is_active = false, deactivated_reason = 'removida_da_grade', updated_at = NOW()
          WHERE id = $1 AND is_active = true`,
        [v.id]
      );
    }
    for (const v of plano.duplicadas) {
      await client.query(
        `UPDATE product_variants SET is_active = false, deactivated_reason = 'duplicada_na_grade', updated_at = NOW()
          WHERE id = $1 AND is_active = true`,
        [v.id]
      );
    }

    const created = [];
    // Continua na grade: mesma linha, mesmo id. Foto, miniatura, preco
    // proprio e promocao ficam onde estao (o rewrite antigo perdia os tres
    // ultimos).
    for (const combo of plano.atualizar) {
      // 14/11/2026: nome que nao foi aceito (eco do servidor, vazio) deixa o
      // sku_suffix da variante como esta; nome aceito o refaz, como sempre.
      const nc = combo.nomeDaCor;
      const skuAtual = skuAtualPorId.get(combo.id);
      const skuSuffix = nc && nc.manterSku && skuAtual
        ? skuAtual
        : skuSuffixFromAttrs(combo.colorHex, nc ? nc.nomeDoSku : combo.colorName, combo.sizeValue);
      const k = buildMatrixKey(combo.colorHex, combo.sizeValue);
      const params = [combo.id, combo.stock, skuSuffix || null];
      let sets = 'stock_qty = $2, sku_suffix = $3';
      // Body sem `barcodes` (cliente antigo): o codigo gravado fica.
      if (veioBarcodes) { params.push(barcodes[k] || null); sets += ', barcode = $' + params.length; }
      // 14/11/2026: so grava nome aceito; sem ele o color_name fica como esta.
      if (combo.colorHex && nc && nc.gravar) { params.push(nc.gravar); sets += ', color_name = $' + params.length; }
      await client.query(
        `UPDATE product_variants SET ${sets}, updated_at = NOW() WHERE id = $1`,
        params
      );
      created.push({ id: combo.id, sku_suffix: skuSuffix, stock: combo.stock, color: combo.colorHex, size: combo.sizeValue });
    }

    for (const combo of plano.criar) {
      const nc = combo.nomeDaCor;
      const skuSuffix = skuSuffixFromAttrs(combo.colorHex, nc ? nc.nomeDoSku : combo.colorName, combo.sizeValue);
      // 21/05/2026: persiste barcode por combinacao (lookup na chave matrixKey)
      const barcodeVal = barcodes[buildMatrixKey(combo.colorHex, combo.sizeValue)] || null;

      const { rows: variantRow } = await client.query(
        `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, barcode, color_name, is_active)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [pid, skuSuffix || null, combo.stock, barcodeVal, (nc && nc.paraNova) || null]
      );
      const variantId = variantRow[0].id;

      // Cria atributos
      if (combo.colorHex) {
        await client.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value)
           VALUES ($1, 'Cor', $2)`,
          [variantId, combo.colorHex]
        );
      }
      if (combo.sizeValue) {
        await client.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value)
           VALUES ($1, 'Tamanho', $2)`,
          [variantId, combo.sizeValue]
        );
      }

      created.push({
        id: variantId,
        sku_suffix: skuSuffix,
        stock: combo.stock,
        color: combo.colorHex,
        size: combo.sizeValue,
      });
    }

    // O total do pai e o que ficou gravado: celula intocada pode ter
    // mantido o estoque do banco em vez do numero que veio no corpo.
    const estoqueFinal = new Map();
    for (const c of plano.atualizar) estoqueFinal.set(buildMatrixKey(c.colorHex, c.sizeValue), c.stock);
    for (const c of combinations) {
      const fk = buildMatrixKey(c.colorHex, c.sizeValue);
      if (estoqueFinal.has(fk)) c.stock = estoqueFinal.get(fk);
    }

    // Atualiza stock_qty do produto pai como SOMA das variantes
    // (se nao tem variantes, mantem o valor atual do produto)
    //
    // Detecta migracao: se alguma combinacao criada coincide com a
    // cor+tamanho proprios do pai, esse "estoque orfao" do pai foi agora
    // formalizado como variante. Limpa color/size do pai pra:
    //  - VariantPickerModal nao mostrar mais "Preto · M · estoque do pai"
    //  - useEffect do ProductVariationsSection nao re-disparar o merge
    //    no proximo open do editor (loop do banner amarelo)
    if (combinations.length > 0) {
      const totalStock = combinations.reduce((acc, c) => acc + c.stock, 0);

      // Logica de match adapta-se ao mode (matrix / color / size)
      const parentMigrated = combinations.some(c => {
        const matchColor = !!(parentColor && c.colorHex &&
          String(c.colorHex).toUpperCase() === String(parentColor).toUpperCase());
        const matchSize = !!(parentSize && c.sizeValue &&
          String(c.sizeValue) === String(parentSize));
        if (parentColor && parentSize) return matchColor && matchSize;     // matrix mode
        if (parentColor) return matchColor;                                 // color-only mode
        if (parentSize) return matchSize;                                   // size-only mode
        return false;                                                        // pai sem atributos
      });

      if (parentMigrated) {
        await client.query(
          `UPDATE products
           SET stock_qty = $1, color = NULL, size = NULL, updated_at = NOW()
           WHERE id = $2`,
          [totalStock, pid]
        );
      } else {
        await client.query(
          'UPDATE products SET stock_qty = $1, updated_at = NOW() WHERE id = $2',
          [totalStock, pid]
        );
      }
    }

    await client.query('COMMIT');
    client.release();

    let mode = 'none';
    if (colors.length > 0 && sizes.length > 0) mode = 'matrix';
    else if (colors.length > 0) mode = 'color';
    else if (sizes.length > 0) mode = 'size';

    res.json({
      product_id: pid,
      created_count: created.length,
      total_stock: combinations.reduce((acc, c) => acc + c.stock, 0),
      mode,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[productsVariations PUT]', err.message, err.code);
    res.status(500).json({ error: 'Erro ao salvar variacoes', detail: err.message });
  }
});

module.exports = router;
