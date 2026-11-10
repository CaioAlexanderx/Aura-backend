// ============================================================
// AURA. — Estoque por loja na visão consolidada (multi-CNPJ)
//
// 10/11/2026 (decisão do dono): em "Todas as lojas" o mesmo produto aparece
// numa linha só, com o estoque de cada loja: "Matriz: 12 | Filial: 3 |
// Total: 15". Cada loja continua com o próprio cadastro e o próprio estoque;
// esta camada só RECONHECE que dois cadastros são a mesma peça.
//
// ─── Regra do agrupamento (produto) ──────────────────────────
// Dois produtos de lojas diferentes são o mesmo item, nesta ordem:
//   1. vínculo de transferência (stock_transfer_items, da PR da
//      transferência entre lojas): o produto criado no destino herda a
//      chave do produto de origem. Cadeia (A → B → C) e ida e volta
//      (A → B → A) caem no produto mais antigo do caminho. Sem a tabela
//      (42P01) ou sem as colunas (42703), o degrau pula este passo;
//   2. barcode igual (sem espaços nas pontas);
//   3. sku igual (sem diferença de maiúscula). Produto sem barcode cujo sku
//      aponta, no conjunto, para UM barcode só, entra no item desse barcode.
//      Sku com dois barcodes diferentes não decide nada: fica "sku:";
//   4. nome normalizado igual (minúsculas, sem acento, espaços colapsados),
//      SÓ quando o produto não tem barcode nem sku.
//
// Um item tem no máximo UM produto de cada loja: se a mesma loja tem dois
// cadastros com o mesmo sku ou o mesmo nome, o segundo vira outro item
// (chave com sufixo "#2"), pareado com o segundo da outra loja na ordem de
// criação. Limites conhecidos (documentados no PR):
//   - nome igual de produtos diferentes ("Camiseta" e "Camiseta") vira um
//     item só entre lojas — por isso o nome é o último degrau e só vale sem
//     código nenhum;
//   - o mesmo produto cadastrado com códigos diferentes em cada loja (barcode
//     interno gerado por loja) aparece em duas linhas, até ser transferido;
//   - produto sem código numa loja e com código na outra não casa pelo nome.
//
// ─── Variantes ───────────────────────────────────────────────
// Dentro de um item, variantes casam por vínculo de transferência, barcode,
// sku (sku_suffix) ou rótulo de atributos (Cor + Tamanho), nesta ordem, uma
// variante por loja. Código que contradiz (dois barcodes diferentes) não
// casa pelo sku nem pelo rótulo.
//
// ─── Produto compartilhado do grupo (is_group_shared, migration 100) ──
// O estoque é um só, o da loja dona. A dona aparece com o número; as outras
// lojas do MESMO grupo de faturamento aparecem com estoque null e
// compartilhado: true. O total soma só estoque real (nada é contado duas
// vezes, nada é inventado).
//
// ─── Acesso ──────────────────────────────────────────────────
// Só lojas que o usuário acessa (dono ou membro ativo, como os outros
// /me/*) E onde ele vê o Estoque: dono, papel admin, permissions null,
// permissions.estoque ou permissions.estoque_consulta. Quem só consulta e
// não tem pdv não recebe preço (mesma regra de middleware/estoqueSoConsulta).
// Custo não sai nesta rota.
// ============================================================
'use strict';

const db = require('../config/database');

// ─── Vínculo de transferência (tabela da outra PR) ─────────────
// Colunas de stock_transfer_items na migration 444 (transferência entre
// lojas): product_id/variant_id são a origem, destino_* o cadastro do
// destino. Se a tabela ou as colunas não existirem (42P01/42703), o degrau
// segue sem o vínculo.
const VINCULO = {
  tabela: 'stock_transfer_items',
  produtoOrigem: 'product_id',
  produtoDestino: 'destino_product_id',
  varianteOrigem: 'variant_id',
  varianteDestino: 'destino_variant_id',
};

const MEMO_MS = 5 * 60 * 1000;
const vinculoDisponivel = { produto: { ok: null, ate: 0 }, variante: { ok: null, ate: 0 } };

function lerMemo(tipo) {
  const m = vinculoDisponivel[tipo];
  if (m.ok === false && Date.now() > m.ate) m.ok = null;
  return m.ok;
}
function gravarMemo(tipo, ok) {
  vinculoDisponivel[tipo] = { ok, ate: ok ? Infinity : Date.now() + MEMO_MS };
}
function _resetMemo() {
  gravarMemo('produto', null);
  gravarMemo('variante', null);
  vinculoDisponivel.produto.ate = 0;
  vinculoDisponivel.variante.ate = 0;
}

const ehSchemaAusente = (e) => !!e && (e.code === '42P01' || e.code === '42703');

/** Tenta com o vínculo; sem a tabela/colunas, memoriza e roda sem. */
async function comDegrauDoVinculo(tipo, rodar) {
  if (lerMemo(tipo) !== false) {
    try {
      const r = await rodar(true);
      gravarMemo(tipo, true);
      return r;
    } catch (e) {
      if (!ehSchemaAusente(e)) throw e;
      gravarMemo(tipo, false);
    }
  }
  return rodar(false);
}

// ─── Acesso por loja ─────────────────────────────────────────

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/** Regra pura: a loja entra na visão? E o preço sai? */
function acessoAoEstoque({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner' || roleLabel === 'admin' || !permissions) {
    return { veEstoque: true, vePreco: true };
  }
  const consulta = permissions.estoque_consulta === true;
  const veEstoque = consulta || permissions.estoque === true;
  return { veEstoque, vePreco: consulta ? permissions.pdv === true : true };
}

/**
 * Lojas do usuário onde ele vê o Estoque, na ordem dos outros /me/*
 * (principal primeiro, depois a mais antiga).
 */
async function lojasDoUsuario(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id, c.legal_name, c.trade_name, c.is_primary, c.created_at,
            COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id) AS raiz,
            (c.owner_id = $1) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, (c.owner_id = $1) DESC, cm.role_label NULLS LAST`,
    [userId]
  );
  const lojas = [];
  for (const r of rows) {
    const acesso = acessoAoEstoque({
      isOwner: r.is_owner, roleLabel: r.role_label, permissions: lerPermissoes(r.permissions),
    });
    if (!acesso.veEstoque) continue;
    lojas.push({
      id: r.id,
      nome: r.trade_name || r.legal_name || 'Empresa',
      raiz: r.raiz || r.id,
      vePreco: acesso.vePreco,
      is_primary: !!r.is_primary,
      created_at: r.created_at,
    });
  }
  lojas.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return lojas;
}

// ─── SQL do agrupamento ──────────────────────────────────────

// Mesma normalização no SQL e no JS (os testes travam as duas).
const ACENTOS = 'áàâãäåéèêëíìîïóòôõöúùûüçñý';
const SEM_ACENTO = 'aaaaaaeeeeiiiiooooouuuucny';

function nomeNormalizadoSql(col) {
  return `btrim(regexp_replace(translate(lower(COALESCE(${col}, '')), '${ACENTOS}', '${SEM_ACENTO}'), '\\s+', ' ', 'g'))`;
}

function normalizarNome(s) {
  let t = String(s || '').toLowerCase();
  let out = '';
  for (const ch of t) {
    const i = ACENTOS.indexOf(ch);
    out += i >= 0 ? SEM_ACENTO[i] : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * CTEs que dão a cada produto ativo das lojas $1 a sua `chave` de item.
 * Termina na CTE `chaves` (uma linha por produto).
 * @param {{comVinculo: boolean, busca: string|null, categoria: string|null}} o
 *   busca/categoria: placeholders ($n) já com o valor nos params.
 */
function ctesDasChaves({ comVinculo, busca, categoria }) {
  const casaBusca = busca
    ? `(p.name ILIKE ${busca} OR p.sku ILIKE ${busca} OR p.barcode ILIKE ${busca}
        OR EXISTS (SELECT 1 FROM product_variants pvb
                    WHERE pvb.product_id = p.id AND pvb.is_active = true
                      AND (pvb.barcode ILIKE ${busca} OR pvb.sku_suffix ILIKE ${busca})))`
    : 'true';
  const casaCategoria = categoria ? `(p.category = ${categoria})` : 'true';

  const vinculo = comVinculo
    ? `vinculo AS (
         SELECT DISTINCT ON (t.${VINCULO.produtoDestino})
                t.${VINCULO.produtoDestino} AS destino, t.${VINCULO.produtoOrigem} AS origem
           FROM ${VINCULO.tabela} t
          WHERE t.${VINCULO.produtoDestino} IN (SELECT id FROM base)
            AND t.${VINCULO.produtoOrigem} IN (SELECT id FROM base)
            AND t.${VINCULO.produtoDestino} <> t.${VINCULO.produtoOrigem}
          ORDER BY t.${VINCULO.produtoDestino}, t.${VINCULO.produtoOrigem}
       ),
       caminho AS (
         SELECT v.destino AS id, v.origem AS no, 1 AS nivel, ARRAY[v.destino, v.origem] AS visto
           FROM vinculo v
         UNION ALL
         SELECT c.id, v.origem, c.nivel + 1, c.visto || v.origem
           FROM caminho c
           JOIN vinculo v ON v.destino = c.no
          WHERE c.nivel < 10 AND NOT (v.origem = ANY(c.visto))
       ),
       -- O produto mais antigo do caminho (ele mesmo incluído) é a origem:
       -- cadeia e ida-e-volta caem no mesmo item.
       canonico AS (
         SELECT DISTINCT ON (x.id) x.id, x.no AS canonico
           FROM (SELECT id, no FROM caminho UNION SELECT id, id FROM caminho) x
           JOIN base b ON b.id = x.no
          ORDER BY x.id, b.created_at, b.id
       ),`
    : `canonico AS (SELECT NULL::uuid AS id, NULL::uuid AS canonico WHERE false),`;

  return `
    WITH RECURSIVE lojas AS (
      SELECT c.id, COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id) AS raiz,
             array_position($1::uuid[], c.id) AS pos
        FROM companies c
       WHERE c.id = ANY($1::uuid[])
    ),
    var_agg AS (
      SELECT pv.product_id, COUNT(*) AS n_var, SUM(pv.stock_qty) AS estoque_var
        FROM product_variants pv
        JOIN products pp ON pp.id = pv.product_id
       WHERE pv.is_active = true
         AND pp.is_active = true
         AND pp.company_id = ANY($1::uuid[])
       GROUP BY pv.product_id
    ),
    base AS (
      SELECT p.id, p.company_id, l.raiz, l.pos, p.name, p.category, p.image_url,
             p.price, p.created_at, COALESCE(p.is_group_shared, false) AS compartilhado,
             NULLIF(btrim(p.sku), '') AS sku,
             upper(NULLIF(btrim(p.sku), '')) AS sku_norm,
             NULLIF(btrim(p.barcode), '') AS barcode,
             ${nomeNormalizadoSql('p.name')} AS nome_norm,
             COALESCE(va.n_var, 0) AS n_var,
             CASE WHEN COALESCE(va.n_var, 0) > 0 THEN COALESCE(va.estoque_var, 0)
                  ELSE COALESCE(p.stock_qty, 0) END AS estoque,
             ${casaBusca} AS casa_busca,
             ${casaCategoria} AS casa_categoria
        FROM products p
        JOIN lojas l ON l.id = p.company_id
        LEFT JOIN var_agg va ON va.product_id = p.id
       WHERE p.is_active = true
    ),
    sku_unico AS (
      SELECT sku_norm, MIN(barcode) AS barcode
        FROM base
       WHERE sku_norm IS NOT NULL AND barcode IS NOT NULL
       GROUP BY sku_norm
      HAVING COUNT(DISTINCT barcode) = 1
    ),
    ${vinculo}
    chave0 AS (
      SELECT b.*,
             CASE WHEN b.barcode IS NOT NULL THEN 'barcode:' || b.barcode
                  WHEN b.sku_norm IS NOT NULL THEN COALESCE('barcode:' || su.barcode, 'sku:' || b.sku_norm)
                  ELSE 'nome:' || b.nome_norm END AS chave0,
             NULLIF(cn.canonico, b.id) AS canonico
        FROM base b
        LEFT JOIN sku_unico su ON su.sku_norm = b.sku_norm
        LEFT JOIN canonico cn ON cn.id = b.id
    ),
    proprias AS (
      SELECT id, chave0 || CASE WHEN rn > 1 THEN '#' || rn ELSE '' END AS chave
        FROM (SELECT id, chave0,
                     ROW_NUMBER() OVER (PARTITION BY company_id, chave0 ORDER BY created_at, id) AS rn
                FROM chave0 WHERE canonico IS NULL) x
    ),
    chaves AS (
      SELECT c.*, COALESCE(pc.chave, pp.chave, c.chave0) AS chave
        FROM chave0 c
        LEFT JOIN proprias pp ON pp.id = c.id
        LEFT JOIN proprias pc ON pc.id = c.canonico
    )`;
}

const AGREGADO_DO_ITEM = `
      chave,
      (array_agg(name ORDER BY pos, created_at, id))[1] AS nome,
      (array_agg(sku ORDER BY pos, created_at, id) FILTER (WHERE sku IS NOT NULL))[1] AS sku,
      (array_agg(barcode ORDER BY pos, created_at, id) FILTER (WHERE barcode IS NOT NULL))[1] AS barcode,
      (array_agg(image_url ORDER BY pos, created_at, id) FILTER (WHERE NULLIF(image_url, '') IS NOT NULL))[1] AS imagem_url,
      (array_agg(price ORDER BY pos, created_at, id))[1] AS preco,
      (array_agg(company_id ORDER BY pos, created_at, id))[1] AS loja_ref,
      json_agg(json_build_object(
        'company_id', company_id, 'product_id', id, 'estoque', estoque,
        'compartilhado', compartilhado, 'raiz', raiz
      ) ORDER BY pos, created_at, id) AS membros,
      SUM(estoque) AS total,
      bool_or(n_var > 0) AS tem_variantes`;

const num = (v) => {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Entradas por loja de um item: as reais (na ordem das lojas) e, para cada
 * loja do mesmo grupo sem cadastro próprio, o compartilhado da dona.
 * @param {Array} membros [{company_id, product_id, estoque, compartilhado, raiz}]
 * @param {Array} lojas   [{id, raiz}] na ordem da resposta
 * @param {string} campoId 'product_id' | 'variant_id'
 */
function entradasPorLoja(membros, lojas, campoId = 'product_id') {
  const pos = new Map(lojas.map((l, i) => [l.id, i]));
  const out = membros.map((m) => ({
    company_id: m.company_id,
    [campoId]: m[campoId],
    estoque: num(m.estoque),
    compartilhado: false,
  }));
  const temProprio = new Set(membros.map((m) => m.company_id));
  for (const loja of lojas) {
    if (temProprio.has(loja.id)) continue;
    const dona = membros.find((m) => m.compartilhado === true && m.raiz === loja.raiz && m.company_id !== loja.id);
    if (!dona) continue;
    out.push({
      company_id: loja.id,
      [campoId]: dona[campoId],
      estoque: null,
      compartilhado: true,
      dona_company_id: dona.company_id,
    });
  }
  out.sort((a, b) => (pos.get(a.company_id) ?? 999) - (pos.get(b.company_id) ?? 999));
  return out;
}

const totalReal = (entradas) => entradas.reduce((s, e) => s + (e.estoque === null ? 0 : e.estoque), 0);

/**
 * Lista paginada de itens.
 * @returns {{lojas, itens, total_itens}}
 */
async function listarPorLoja(lojas, { q = null, categoria = null, limit = 50, offset = 0 } = {}) {
  const lojasOut = lojas.map((l) => ({ id: l.id, nome: l.nome }));
  if (!lojas.length) return { lojas: lojasOut, itens: [], total_itens: 0 };

  const params = [lojas.map((l) => l.id)];
  let busca = null;
  let cat = null;
  if (q) { params.push(`%${q}%`); busca = `$${params.length}`; }
  if (categoria) { params.push(categoria); cat = `$${params.length}`; }
  params.push(limit, offset);
  const pLimit = `$${params.length - 1}`;
  const pOffset = `$${params.length}`;

  const filtros = [];
  if (busca) filtros.push('bool_or(casa_busca)');
  if (cat) filtros.push('bool_or(casa_categoria)');
  const having = filtros.length ? `HAVING ${filtros.join(' AND ')}` : '';

  const { rows } = await comDegrauDoVinculo('produto', (comVinculo) => db.query(
    `${ctesDasChaves({ comVinculo, busca, categoria: cat })},
    itens AS (
      SELECT ${AGREGADO_DO_ITEM}
        FROM chaves
       GROUP BY chave
       ${having}
    )
    SELECT itens.*, COUNT(*) OVER () AS total_itens
      FROM itens
     ORDER BY lower(nome), chave
     LIMIT ${pLimit} OFFSET ${pOffset}`,
    params
  ));

  const vePreco = new Map(lojas.map((l) => [l.id, l.vePreco !== false]));
  const itens = rows.map((r) => {
    const membros = Array.isArray(r.membros) ? r.membros : JSON.parse(r.membros || '[]');
    const por_loja = entradasPorLoja(membros, lojas, 'product_id');
    return {
      chave: r.chave,
      nome: r.nome || '',
      sku: r.sku || null,
      barcode: r.barcode || null,
      imagem_url: r.imagem_url || null,
      preco: vePreco.get(r.loja_ref) === false ? null : num(r.preco),
      por_loja,
      total: totalReal(por_loja),
      tem_variantes: r.tem_variantes === true,
    };
  });

  let total_itens = rows.length ? parseInt(rows[0].total_itens, 10) || 0 : 0;
  // Página além do fim: o COUNT(*) OVER não volta. Uma contagem barata.
  if (!rows.length && offset > 0) {
    const c = await comDegrauDoVinculo('produto', (comVinculo) => db.query(
      `${ctesDasChaves({ comVinculo, busca, categoria: cat })}
      SELECT COUNT(*) AS total_itens FROM (SELECT chave FROM chaves GROUP BY chave ${having}) x`,
      params.slice(0, params.length - 2)
    ));
    total_itens = parseInt(c.rows[0]?.total_itens, 10) || 0;
  }

  return { lojas: lojasOut, itens, total_itens };
}

// ─── Variantes de um item ────────────────────────────────────

const COR = new Set(['cor', 'color', 'colour']);
const TAMANHO = new Set(['tamanho', 'size', 'tam', 'tam.', 'variacao', 'variação', 'medida', 'numero', 'número', 'num', 'numeracao', 'numeração']);
const HEX = /#?([0-9a-fA-F]{6})\b/;

function ordemDoAtributo(nome) {
  const n = normalizarNome(nome);
  if (COR.has(n)) return 0;
  if (TAMANHO.has(n)) return 1;
  return 2;
}

/** "Preto (#000000)" → "Preto"; "#000000" → nome gravado ou o do sku_suffix. */
function valorDeCor(valor, colorName, skuSuffix) {
  const v = String(valor || '').trim();
  const semHex = v.replace(/\(?\s*#[0-9a-fA-F]{6}\s*\)?/g, '').trim();
  if (semHex) return semHex;
  if (colorName && String(colorName).trim()) return String(colorName).trim();
  const primeiro = String(skuSuffix || '').split('-')[0];
  if (primeiro && !/^[0-9A-F]{6}$/i.test(primeiro)) return primeiro;
  return v;
}

/**
 * Rótulo para a tela ("Azul / M") e chave de comparação (atributo=valor
 * normalizados; a cor compara pelo hex quando existe).
 */
function rotuloDaVariante(v) {
  const attrs = (Array.isArray(v.attributes) ? v.attributes : [])
    .filter((a) => a && String(a.value || '').trim())
    .slice()
    .sort((a, b) => ordemDoAtributo(a.attribute) - ordemDoAtributo(b.attribute)
      || normalizarNome(a.attribute).localeCompare(normalizarNome(b.attribute)));
  if (!attrs.length) {
    const r = (v.color_name && String(v.color_name).trim()) || (v.sku_suffix && String(v.sku_suffix).trim()) || 'Variante';
    return { rotulo: r, chave: `rotulo:${normalizarNome(r)}` };
  }
  const partes = [];
  const chave = [];
  for (const a of attrs) {
    const ehCor = ordemDoAtributo(a.attribute) === 0;
    const bruto = String(a.value).trim();
    partes.push(ehCor ? valorDeCor(bruto, v.color_name, v.sku_suffix) : bruto);
    const hex = ehCor ? bruto.match(HEX) : null;
    const tipo = ehCor ? 'cor' : (ordemDoAtributo(a.attribute) === 1 ? 'tamanho' : normalizarNome(a.attribute));
    chave.push(`${tipo}=${hex ? `#${hex[1].toLowerCase()}` : normalizarNome(bruto)}`);
  }
  return { rotulo: partes.join(' / '), chave: `rotulo:${chave.sort().join('|')}` };
}

/**
 * Agrupa variantes de produtos já reconhecidos como o mesmo item.
 * @param {Array} variantes [{id, company_id, barcode, sku_suffix, attributes,
 *   color_name, estoque, compartilhado, raiz, origem_id}] na ordem das lojas
 * @returns {Array} grupos [{membros: [...]}]
 */
function agruparVariantes(variantes) {
  const grupos = [];
  const doId = new Map();
  const temLoja = (g, cid) => g.membros.some((m) => m.company_id === cid);
  const contradiz = (g, v) => !!v.barcode && g.barcodes.size > 0 && !g.barcodes.has(v.barcode);
  const entrar = (g, v) => {
    g.membros.push(v);
    if (v.barcode) g.barcodes.add(v.barcode);
    if (v.sku) g.skus.add(v.sku);
    g.rotulos.add(v.chaveRotulo);
    doId.set(v.id, g);
  };
  const novo = (v) => {
    const g = { membros: [], barcodes: new Set(), skus: new Set(), rotulos: new Set() };
    grupos.push(g);
    entrar(g, v);
    return g;
  };

  const prontas = variantes.map((v) => {
    const { rotulo, chave } = rotuloDaVariante(v);
    return {
      ...v,
      barcode: v.barcode && String(v.barcode).trim() ? String(v.barcode).trim() : null,
      sku: v.sku_suffix && String(v.sku_suffix).trim() ? String(v.sku_suffix).trim().toUpperCase() : null,
      rotulo,
      chaveRotulo: chave,
    };
  });
  const porId = new Map(prontas.map((v) => [v.id, v]));

  // 1. Vínculo de transferência: origem e destino juntos, antes de tudo.
  // Cadeia (A → B → C) e ida e volta (A → B → A) caem na variante mais
  // antiga do caminho, como no produto.
  const maisAntiga = (a, b) => {
    const d = new Date(a.criadoVar || 0) - new Date(b.criadoVar || 0);
    if (d !== 0) return d < 0 ? a : b;
    return String(a.id) < String(b.id) ? a : b;
  };
  const origemFinal = (v) => {
    let atual = v;
    let escolhida = v;
    const visto = new Set([v.id]);
    while (atual.origem_id && porId.has(atual.origem_id) && !visto.has(atual.origem_id)) {
      atual = porId.get(atual.origem_id);
      visto.add(atual.id);
      escolhida = maisAntiga(escolhida, atual);
    }
    return escolhida;
  };
  for (const v of prontas) {
    if (!v.origem_id || !porId.has(v.origem_id)) continue;
    const raiz = origemFinal(v);
    if (raiz.id === v.id) continue;
    const g = doId.get(raiz.id) || novo(raiz);
    if (!doId.has(v.id) && !temLoja(g, v.company_id)) entrar(g, v);
  }

  // 2–4. Barcode, sku, rótulo — uma variante por loja.
  for (const v of prontas) {
    if (doId.has(v.id)) continue;
    const livre = grupos.filter((g) => !temLoja(g, v.company_id));
    const alvo = (v.barcode && livre.find((g) => g.barcodes.has(v.barcode)))
      || (v.sku && livre.find((g) => g.skus.has(v.sku) && !contradiz(g, v)))
      || livre.find((g) => g.rotulos.has(v.chaveRotulo) && !contradiz(g, v));
    if (alvo) entrar(alvo, v);
    else novo(v);
  }
  return grupos;
}

/**
 * Variantes de um item da lista (pela `chave`).
 * @returns {null | {lojas, variantes}} null = item não existe nas lojas.
 */
async function variantesDoItem(lojas, chave) {
  const lojasOut = lojas.map((l) => ({ id: l.id, nome: l.nome }));
  if (!lojas.length) return null;
  const params = [lojas.map((l) => l.id), chave];

  const { rows: produtos } = await comDegrauDoVinculo('produto', (comVinculo) => db.query(
    `${ctesDasChaves({ comVinculo, busca: null, categoria: null })}
    SELECT id, company_id, raiz, pos, compartilhado, created_at
      FROM chaves
     WHERE chave = $2
     ORDER BY pos, created_at, id`,
    params
  ));
  if (!produtos.length) return null;

  const ids = produtos.map((p) => p.id);
  const doProduto = new Map(produtos.map((p) => [p.id, p]));
  const sqlVariantes = (comVinculo) => `
    SELECT pv.id, pv.product_id, pv.sku_suffix, pv.barcode, pv.stock_qty, pv.color_name, pv.created_at,
           COALESCE(json_agg(json_build_object('attribute', pvv.attribute_name, 'value', pvv.value)
                    ORDER BY pvv.attribute_name) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes,
           ${comVinculo
    ? `(SELECT t.${VINCULO.varianteOrigem} FROM ${VINCULO.tabela} t
                WHERE t.${VINCULO.varianteDestino} = pv.id
                  AND t.${VINCULO.varianteOrigem} IS NOT NULL
                ORDER BY t.${VINCULO.varianteOrigem} LIMIT 1)`
    : 'NULL::uuid'} AS origem_id
      FROM product_variants pv
      LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
     WHERE pv.product_id = ANY($1::uuid[]) AND pv.is_active = true
     GROUP BY pv.id
     ORDER BY pv.created_at, pv.id`;
  const { rows: varRows } = await comDegrauDoVinculo('variante', (comVinculo) => db.query(sqlVariantes(comVinculo), [ids]));

  const variantes = varRows
    .map((v) => {
      const p = doProduto.get(v.product_id) || {};
      return {
        id: v.id,
        company_id: p.company_id,
        pos: p.pos,
        criado: p.created_at,
        criadoVar: v.created_at,
        raiz: p.raiz,
        compartilhado: p.compartilhado === true,
        barcode: v.barcode,
        sku_suffix: v.sku_suffix,
        color_name: v.color_name,
        attributes: Array.isArray(v.attributes) ? v.attributes : JSON.parse(v.attributes || '[]'),
        estoque: num(v.stock_qty),
        origem_id: v.origem_id || null,
      };
    })
    // Ordem das lojas (a principal primeiro), depois a grade como foi cadastrada.
    .sort((a, b) => (a.pos ?? 999) - (b.pos ?? 999)
      || new Date(a.criado) - new Date(b.criado));

  const grupos = agruparVariantes(variantes);
  const out = grupos.map((g) => {
    const membros = g.membros.map((m) => ({
      company_id: m.company_id, variant_id: m.id, estoque: m.estoque,
      compartilhado: m.compartilhado, raiz: m.raiz,
    }));
    const por_loja = entradasPorLoja(membros, lojas, 'variant_id');
    // Representante: a variante da primeira loja (a principal primeiro).
    const rep = g.membros.slice().sort((a, b) => (a.pos ?? 999) - (b.pos ?? 999))[0];
    return {
      rotulo: rep.rotulo,
      sku: rep.sku_suffix || null,
      barcode: rep.barcode || ((g.membros.find((m) => m.barcode) || {}).barcode) || null,
      por_loja,
      total: totalReal(por_loja),
    };
  });
  return { lojas: lojasOut, variantes: out };
}

module.exports = {
  lojasDoUsuario,
  listarPorLoja,
  variantesDoItem,
  // puros, para os testes
  acessoAoEstoque,
  entradasPorLoja,
  agruparVariantes,
  rotuloDaVariante,
  normalizarNome,
  nomeNormalizadoSql,
  ctesDasChaves,
  VINCULO,
  _resetMemo,
};
