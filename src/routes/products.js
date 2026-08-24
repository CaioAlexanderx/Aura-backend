// ============================================================
// AURA. -- S4: Products CRUD
// Plan limits: essencial=2000, negocio=7000, expansao=unlimited
// FIX: DELETE tries first, handles FK with retry
// FEAT: image_url included in GET and PATCH
// FEAT (mai/2026): ncm exposto no CRUD — pré-requisito do form de NCM
//   no aura-app. sanitizeNcm strip não-dígitos e exige 8 chars.
// FEAT (mai/2026): is_group_shared — produtos do billing_owner_company_id
//   ficam visíveis para CNPJs subsidiários do mesmo grupo (migration 100).
// FIX (07/05/2026): GET listagem desacoplada do plan limit. Plan limit
//   ainda gating do CADASTRO (POST), mas o GET agora só aplica HARD_CAP
//   (20k) — clientes com produtos cadastrados acima do plano (import CSV
//   legacy ou downgrade) continuam enxergando todo o catálogo.
//   Bug Davi (07/05): plano negocio (7000) com 10.157 produtos →
//   3.157 produtos invisíveis no Estoque.
// FIX (08/05/2026): visibilidade BIDIRECIONAL no grupo. Antes a migration
//   100 só fazia subsidiária ver produtos shared do billing_owner; matriz
//   NÃO via produtos shared das subsidiárias.
//   Bug Davi: produto criado em Villa Branca (cnpj2) ficava invisível na
//   Matriz. Sintoma "alterar preço dá 404" era a inconsistência GET-vs-
//   PATCH (PATCH não casava produto shared visto pela subsidiária).
//   Solução:
//     - GET/PATCH/DELETE usam visibilityWhere() — bidirecional via group_root.
//     - POST defaulta is_group_shared=true para empresa em billing group.
//     - Migration 102 backfill em produtos existentes.
//     - group_root(empresa) = billing_owner se subsidiária, senão a própria
//       empresa. Empresas com mesmo group_root estão no mesmo grupo.
// FIX (12/05/2026): DELETE retry chain nullifica FKs antes de re-deletar
//   mas explodia em 42P01 quando o deployment nao tinha a migration de
//   barbershop (caso Eryca/Finesse — varejo puro). safeNullProductRef
//   ignora 42P01 e segue o resto da cadeia.
// FEAT (19/05/2026): suporte a variantes no GET. variants_stock_total
//   agrega SUM(product_variants.stock_qty) e variant_barcodes lista
//   ARRAY_AGG dos barcodes das variants ativas. Search WHERE estendido
//   pra match em pv.barcode (bipando variant encontra o pai).
//   Necessario depois da migration que move estoque do pai pras variants
//   (zera products.stock_qty do pai). Sem isso o KPI "Unidades totais"
//   subnotifica e o lowStock infla.
// FEAT (21/05/2026): merge_suggestion no POST — detecta produtos sem
//   variantes com mesmo nome base (strip de sufixo de tamanho) e retorna
//   { nome_base, count } junto com o produto criado. Não bloqueia a criação.
// FIX (21/05/2026): GET filtra is_active = true — produtos filhos de
//   variante (desativados no merge) não aparecem mais no Estoque/PDV.
//   Sem esse filtro, "Beira Rio Mule Napa Camel - 37" (is_active=false)
//   aparecia na lista com stock=0, causando "estoque baixo" no PDV quando
//   Davi clicava nele ao invés do pai com variantes.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const { normalizeGallery } = require('../services/productGallery');
const db = require('../config/database');

const HARD_CAP = 20000;

function getPlanLimit(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 7000;
    default:              return 2000;
  }
}

function sanitizeNcm(raw) {
  if (raw === undefined || raw === null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length !== 8) return null;
  return digits;
}

// ─── Visibilidade de grupo (BIDIRECIONAL) ────────────────
//
// Regra: produto P visível para empresa X se
//   P.company_id = X
//   OU (P.is_group_shared E group_root(P.company_id) = group_root(X))
//
// SQL: COALESCE(NULLIF(billing_owner_company_id, id), id) = group_root.
//
// Pra empresa standalone (sem grupo), a lista de empresas-do-grupo
// contém só ela mesma → visibilidade idêntica ao caso single-company.
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

// Versão sem o `id =` para uso em listagens.
function listVisibilityWhere(cidParam) {
  return `(company_id = ${cidParam} OR (
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

// ─── safeNullProductRef ──────────────────────────────────
//
// 12/05/2026: helper pro retry de DELETE quando ha FK violation
// (23503). Cada deployment so tem as tabelas das migrations que
// rodaram nele — barber_stock_movements so existe se a vertical
// barbershop foi aplicada. Tentar UPDATE em tabela inexistente
// explode 42P01 e quebra a cadeia inteira do retry.
//
// `tableName` E HARDCODED neste arquivo (whitelist de tabelas
// internas conhecidas), nunca vem de user input — SEM risco
// de SQL injection.
async function safeNullProductRef(tableName, productId) {
  try {
    await db.query(
      `UPDATE ${tableName} SET product_id = NULL WHERE product_id = $1`,
      [productId]
    );
  } catch (err) {
    // 42P01 = undefined_table. Acontece quando a migration que cria
    // essa tabela nao rodou nesse deployment (ex: barbershop em
    // cliente de varejo puro). Ignora e segue a cadeia.
    if (err.code === '42P01') {
      console.log('[products] safeNull: tabela', tableName, 'nao existe nesse deployment, pulando');
      return;
    }
    // Outras falhas (permissao, sintaxe, deadlock) sobem.
    throw err;
  }
}

// ─── GET / ──────────────────────────────────
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const planLimit = getPlanLimit(req.user?.plan);
  const requested = parseInt(req.query.limit);
  const limit = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : HARD_CAP,
    HARD_CAP
  );
  const offset = parseInt(req.query.offset) || 0;
  const category = req.query.category;
  const search = req.query.search;

  try {
    // FIX (21/05/2026): is_active = true filtra produtos desativados (filhos
    // de variante) — sem isso aparecem na lista com stock=0 causando
    // "estoque baixo" no PDV quando o usuário clica no filho ao invés do pai.
    let where = `WHERE is_active = true AND ${listVisibilityWhere('$1')}`;
    const params = [cid];

    if (category) { where += ` AND category = $${params.length + 1}`; params.push(category); }
    if (search) {
      // 19/05/2026: busca tambem em variant.barcode — usuario bipa o
      // barcode da variante e queremos encontrar o pai. Sem isso, depois
      // da migration que move barcode pras variants, o pai com barcode=NULL
      // some da busca por codigo de barras.
      where += ` AND (
        name ILIKE $${params.length + 1}
        OR sku ILIKE $${params.length + 1}
        OR barcode ILIKE $${params.length + 1}
        OR EXISTS (
          SELECT 1 FROM product_variants pv
          WHERE pv.product_id = products.id
            AND pv.is_active = true
            AND pv.barcode ILIKE $${params.length + 1}
        )
      )`;
      params.push(`%${search}%`);
    }

    const countRes = await db.query(`SELECT COUNT(*) AS total FROM products ${where}`, params);
    // Migration 305 — ficha tecnica. Tentar-e-cair em vez de consultar o
    // information_schema: uma query a mais desloca a sequencia de mocks
    // dos testes de integracao, e no caminho feliz ela e pura perda.
    const dataRes = await comFallbackDeFicha((colsFicha) => db.query(
      `SELECT id, name, sku, barcode, category, description, price, cost_price,
              stock_qty, stock_min, stock_max, unit, color, size, image_url, ncm,
              ${colsFicha}
              is_active, is_group_shared, company_id, created_at,
              (SELECT EXISTS(SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id AND pv.is_active = true)) AS has_variants,
              -- 19/05/2026: SUM do estoque das variants ativas pra alimentar UI/KPIs
              -- depois que a migration zera products.stock_qty do pai.
              COALESCE(
                (SELECT SUM(pv.stock_qty) FROM product_variants pv
                 WHERE pv.product_id = products.id AND pv.is_active = true),
                0
              ) AS variants_stock_total,
              -- ARRAY dos barcodes das variants ativas — frontend usa pra
              -- scanner local achar o pai bipando barcode de variant.
              COALESCE(
                (SELECT array_agg(pv.barcode) FROM product_variants pv
                 WHERE pv.product_id = products.id
                   AND pv.is_active = true
                   AND pv.barcode IS NOT NULL),
                ARRAY[]::TEXT[]
              ) AS variant_barcodes
       FROM products ${where} ORDER BY name ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ));

    const products = dataRes.rows.map(r => ({
      id: r.id, name: r.name || '', sku: r.sku || '', barcode: r.barcode || '',
      category: r.category || 'Produtos', description: r.description || '',
      price: parseFloat(r.price) || 0, cost_price: parseFloat(r.cost_price) || 0,
      stock_qty: parseInt(r.stock_qty) || 0, min_stock: parseInt(r.stock_min) || 0,
      stock_max: parseInt(r.stock_max) || 0, unit: r.unit || 'un',
      color: r.color || '', size: r.size || '',
      image_url: r.image_url || '',
      ncm: r.ncm || '',
      // Migration 305 — ficha tecnica. '' quando a coluna nao existe na
      // base ainda, entao o formulario abre vazio em vez de quebrar.
      material: r.material || '', medidas: r.medidas || '', cuidados: r.cuidados || '',
      is_active: r.is_active !== false,
      is_group_shared: r.is_group_shared || false,
      stock_company_id: r.company_id,
      created_at: r.created_at,
      has_variants: r.has_variants || false,
      // 19/05/2026: novos campos pra UI lidar com variants
      variants_stock_total: parseInt(r.variants_stock_total) || 0,
      variant_barcodes: Array.isArray(r.variant_barcodes) ? r.variant_barcodes : [],
    }));

    res.json({ products, total: parseInt(countRes.rows[0]?.total) || 0, limit, offset, plan_limit: planLimit });
  } catch (err) { console.error('[products] list error:', err.message); res.status(500).json({ error: 'Erro ao listar produtos' }); }
});

// ─── GET /:pid/variants ────────────────────────────
router.get('/:pid/variants', async (req, res) => {
  const { id: companyId, pid: productId } = req.params;
  try {
    const { rows: check } = await db.query(
      `SELECT id FROM products WHERE ${visibilityWhere('$1', '$2')}`,
      [productId, companyId]
    );
    if (!check.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    const { rows } = await db.query(`
      SELECT pv.id, pv.sku_suffix, pv.price_override, pv.stock_qty, pv.barcode,
        COALESCE(json_agg(json_build_object('attribute', pvv.attribute_name, 'value', pvv.value) ORDER BY pvv.attribute_name) FILTER (WHERE pvv.id IS NOT NULL), '[]'::json) AS attributes
      FROM product_variants pv LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
      WHERE pv.product_id = $1 AND pv.is_active = true
      GROUP BY pv.id, pv.sku_suffix, pv.price_override, pv.stock_qty, pv.barcode ORDER BY pv.created_at ASC`, [productId]);
    res.json({ variants: rows });
  } catch (err) { console.error('[products] variants error:', err.message); res.status(500).json({ error: 'Erro ao buscar variantes' }); }
});

// ─── POST / ──────────────────────────────────
//
// Default de is_group_shared: true se a empresa está em billing group
// (tem billing_owner != self OU tem subsidiárias). Senão false.
//
// Override via body.is_group_shared se cliente quiser explícito (ex:
// produto privado mesmo em grupo, ou shared mesmo standalone).
//
// in_group é pego no MESMO query do count (mantém número de db.query
// calls — compat com testes existentes).
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, sku, barcode, category, description, price, cost_price, stock_qty, min_stock, stock_max, unit, color, size, ncm, image_url, material, medidas, cuidados } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name e obrigatorio' });

  let defaultShared = false;
  try {
    const planLimit = getPlanLimit(req.user?.plan);
    const stats = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE company_id = $1) AS total,
         EXISTS(
           SELECT 1 FROM companies c
           WHERE c.id = $1
             AND (
               (c.billing_owner_company_id IS NOT NULL AND c.billing_owner_company_id != c.id)
               OR EXISTS (SELECT 1 FROM companies sub WHERE sub.billing_owner_company_id = c.id AND sub.id != c.id)
             )
         ) AS in_group`,
      [cid]
    );
    const current = parseInt(stats.rows[0]?.total) || 0;
    defaultShared = stats.rows[0]?.in_group === true;
    if (current >= planLimit) return res.status(403).json({ error: `Limite de produtos atingido (${planLimit}).`, limit: planLimit, current });
  } catch (err) { console.error('[products] count/group check error:', err.message); }

  // A foto escolhida na CRIACAO era descartada em silencio: o app mandava
  // image_url no body e o INSERT nao listava a coluna. A lojista subia a foto,
  // via a previa, salvava — e o produto nascia sem foto nenhuma.
  // gallery_urls nasce junto com a capa no indice 0, igual ao backfill da 290.
  let capaNova = null;
  if (image_url !== undefined && image_url !== null && String(image_url).trim() !== '') {
    const g = normalizeGallery([image_url]);
    if (g.error) return res.status(400).json({ error: g.error });
    capaNova = g.cover;
  }

  const isGroupShared = req.body.is_group_shared !== undefined
    ? !!req.body.is_group_shared
    : defaultShared;

  try {
    // Migration 305: ficha tecnica. Texto curto e opcional; o corte de
    // tamanho evita que um paste de 40 KB vire coluna.
    const ficha = (v) => (v && String(v).trim() ? String(v).trim().slice(0, 600) : null);

    const COLS_ANTIGAS = 'company_id, name, sku, barcode, category, description, price, cost_price, stock_qty, stock_min, stock_max, unit, color, size, ncm, is_group_shared';
    const paramsAntigos = [cid, String(name).trim(), sku||null, barcode||null, category||'Produtos', description||null,
       parseFloat(price)||0, parseFloat(cost_price)||0, parseInt(stock_qty)||0, parseInt(min_stock)||0,
       parseInt(stock_max)||0, unit||'un', color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : null,
       size ? String(size).slice(0,100) : null, sanitizeNcm(ncm), isGroupShared];

    const paramsFicha = [ficha(material), ficha(medidas), ficha(cuidados)];

    /** $1..$n pra n parametros — a contagem era escrita a mao e ficou errada. */
    function marcadores(n, jsonbNoFim) {
      var l = [];
      for (var k = 1; k <= n; k++) l.push('$' + k + (jsonbNoFim && k === n ? '::jsonb' : ''));
      return l.join(',');
    }

    // Duas migrations podem faltar numa base atrasada: a 290
    // (gallery_urls) e a 305 (ficha). O backend nao roda migration no
    // boot, entao cada uma tem seu degrau — cadastrar produto nao pode
    // quebrar pro varejo inteiro por causa de campo novo.
    const tentativas = [
      { cols: COLS_ANTIGAS + ', material, medidas, cuidados, image_url, gallery_urls',
        params: [...paramsAntigos, ...paramsFicha, capaNova, JSON.stringify(capaNova ? [capaNova] : [])],
        jsonb: true },
      { cols: COLS_ANTIGAS + ', image_url, gallery_urls',
        params: [...paramsAntigos, capaNova, JSON.stringify(capaNova ? [capaNova] : [])],
        jsonb: true },
      { cols: COLS_ANTIGAS, params: paramsAntigos, jsonb: false },
    ];

    let result = null;
    let ultimoErro = null;
    for (const t of tentativas) {
      try {
        result = await db.query(
          `INSERT INTO products (${t.cols}) VALUES (${marcadores(t.params.length, t.jsonb)}) RETURNING *`,
          t.params
        );
        break;
      } catch (e) {
        if (e.code !== '42703') throw e;
        ultimoErro = e;
      }
    }
    if (!result) throw ultimoErro;

    // Detectar sugestão de merge: verifica se existem outros produtos sem variantes
    // com o mesmo nome base (após strip do sufixo de tamanho) na mesma empresa.
    // Não bloqueia a criação — erro silencioso.
    let merge_suggestion = null;
    try {
      const nomeTrimmed = String(name).trim();
      const nomeBase = nomeTrimmed
        .replace(/\s*-\s*\d{2,3}(\/\d{2,3})?$/, '')
        .replace(/\s\d{2,3}(\/\d{2,3})?$/, '')
        .trim();
      // Só sugere se o nome foi modificado (tinha sufixo de tamanho)
      if (nomeBase.toLowerCase() !== nomeTrimmed.toLowerCase()) {
        const nomeNorm = nomeBase.toLowerCase().replace(/\s+/g, ' ');
        const { rows: similar } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products
           WHERE company_id = $1
             AND is_active = true
             AND id != $2
             AND NOT EXISTS (SELECT 1 FROM product_variants WHERE product_id = products.id)
             AND lower(trim(regexp_replace(
                   regexp_replace(
                     regexp_replace(name, '\\s*-\\s*\\d{2,3}(/\\d{2,3})?$', ''),
                     '\\s\\d{2,3}(/\\d{2,3})?$', ''
                   ), '\\s+', ' ', 'g'
                 ))) = $3`,
          [cid, result.rows[0].id, nomeNorm]
        );
        const cnt = parseInt(similar[0]?.cnt) || 0;
        if (cnt >= 1) {
          merge_suggestion = { nome_base: nomeBase, count: cnt + 1 };
        }
      }
    } catch (_) { /* não bloqueia a criação */ }

    res.status(201).json({ ...result.rows[0], merge_suggestion });
  } catch (err) { console.error('[products] create error:', err.message); res.status(500).json({ error: 'Erro ao criar produto' }); }
});

// ─── PATCH /:pid ────────────────────────────────
/**
 * Roda a query com as colunas da ficha; se a base estiver atras da
 * migration 305, roda de novo sem elas.
 *
 * O backend nao aplica migration no boot, entao coluna nova sempre tem um
 * intervalo em que o codigo ja subiu e o banco nao (CLAUDE.md, armadilha
 * 1). Aqui o custo do degrau e uma query extra SO nesse intervalo.
 */
async function comFallbackDeFicha(rodar) {
  try {
    return await rodar('material, medidas, cuidados,');
  } catch (e) {
    if (e.code !== '42703') throw e;
    return await rodar('');
  }
}

router.patch('/:pid', async (req, res) => {
  const { id: cid, pid } = req.params;

  if (req.body.stock_qty_decrement !== undefined) {
    const decrement = parseInt(req.body.stock_qty_decrement);
    if (!decrement || decrement <= 0) return res.status(400).json({ error: 'stock_qty_decrement deve ser positivo' });
    try {
      const result = await db.query(
        `UPDATE products SET stock_qty = GREATEST(0, stock_qty - $1), updated_at = NOW()
         WHERE ${visibilityWhere('$2', '$3')} RETURNING *`,
        [decrement, pid, cid]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
      return res.json(result.rows[0]);
    } catch (err) { console.error('[products] decrement error:', err.message); return res.status(500).json({ error: 'Erro ao decrementar estoque' }); }
  }

  // S9 (migration 290) — galeria de ate 6 fotos. Fica FORA do fieldMap
  // porque nao e um valor escalar: precisa ser validada e, sobretudo,
  // precisa manter `image_url` espelhando a capa. Todo o resto do sistema
  // (listagem, carrinho, marketplace, notificacao, PDV) le image_url, e
  // nenhum desses lugares foi tocado — mesmo racional do dual-write de
  // products.category na F0.
  let galeria = null;
  if (req.body.gallery_urls !== undefined) {
    const g = normalizeGallery(req.body.gallery_urls);
    if (g.error) return res.status(400).json({ error: g.error });
    galeria = g;
  }

  const fieldMap = { name:'name', sku:'sku', barcode:'barcode', category:'category', description:'description', price:'price', cost_price:'cost_price', stock_qty:'stock_qty', min_stock:'stock_min', stock_max:'stock_max', unit:'unit', is_active:'is_active', color:'color', size:'size', image_url:'image_url', ncm:'ncm', is_group_shared:'is_group_shared', studio_storefront_visible:'studio_storefront_visible',
    // Migration 305 — ficha tecnica na pagina do produto.
    material:'material', medidas:'medidas', cuidados:'cuidados' };
  const numFields = ['price','cost_price','stock_qty','stock_min','stock_max'];
  const updates = [], values = []; let idx = 1;
  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined) {
      updates.push(`${dbCol} = $${idx}`); let val = req.body[bodyKey];
      if (numFields.includes(dbCol)) val = parseFloat(val);
      if (dbCol === 'color' && val && !/^#[0-9A-Fa-f]{6}$/.test(val)) val = null;
      if (dbCol === 'ncm') val = sanitizeNcm(val);
      values.push(val); idx++;
    }
  }
  if (galeria) {
    updates.push(`gallery_urls = $${idx}::jsonb`);
    values.push(JSON.stringify(galeria.gallery)); idx++;
    // A capa segue a galeria, a menos que o proprio request tenha mandado
    // image_url junto — nesse caso a escolha explicita vence.
    if (req.body.image_url === undefined) {
      updates.push(`image_url = $${idx}`);
      values.push(galeria.cover); idx++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()'); values.push(pid, cid);
  try {
    const result = await db.query(
      `UPDATE products SET ${updates.join(', ')} WHERE ${visibilityWhere(`$${idx}`, `$${idx+1}`)} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) { console.error('[products] update error:', err.message); res.status(500).json({ error: 'Erro ao atualizar produto' }); }
});

// ─── DELETE /:pid ───────────────────────────────
router.delete('/:pid', async (req, res) => {
  const { id: cid, pid } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM products WHERE ${visibilityWhere('$1', '$2')} RETURNING id, name`,
      [pid, cid]
    );
    if (!result || !result.rows.length) return res.status(404).json({ error: 'Produto nao encontrado' });
    res.json({ deleted: true, id: pid, name: result.rows[0].name });
  } catch (err) {
    if (err.code === '23503') {
      try {
        // 12/05/2026: safeNullProductRef ignora 42P01 pra deployments que
        // nao tem todas as tabelas (ex: Finesse sem barbershop). Sem isso,
        // a primeira tabela ausente quebrava a cadeia inteira e o produto
        // nao deletava mesmo com sale_items/stock_movements ja nulificados.
        await safeNullProductRef('sale_items', pid);
        await safeNullProductRef('barber_stock_movements', pid);
        await safeNullProductRef('stock_movements', pid);
        const retry = await db.query(
          `DELETE FROM products WHERE ${visibilityWhere('$1', '$2')} RETURNING id, name`,
          [pid, cid]
        );
        if (retry && retry.rows.length) return res.json({ deleted: true, id: pid, name: retry.rows[0].name });
        return res.status(404).json({ error: 'Produto nao encontrado' });
      } catch (retryErr) {
        console.error('[products] delete retry error:', retryErr.message, retryErr.code);
        return res.status(409).json({ error: 'Este produto esta vinculado a outros registros e nao pode ser excluido. Tente desativa-lo.', code: 'FK_VIOLATION' });
      }
    }
    console.error('[products] delete error:', err.message, err.code);
    res.status(500).json({ error: 'Erro ao deletar produto' });
  }
});

module.exports = router;
