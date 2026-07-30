// ============================================================
// AURA. -- Migracao de categorias (staging) -- Bloco B2, Fase F0
// Sem inferencia: o lojista decide kind/target_path via PATCH. Este
// arquivo so filtra, agrupa e grava o que o lojista mandou.
//
// Escopo "vendavel" (analyze e brand-candidates): ativos, estoque > 0,
// sem servico (unit IS NULL OR unit <> 'srv'). Historico morto e
// desperdicio classificar -- o resto cai em "A organizar" (rotas B1).
//
// `state` em getStatus (declarada no PR):
//   total === 0                 -> not_started (analyze nunca rodou)
//   applied >= total (total>0)  -> done
//   applied > 0 || approved > 0 -> in_progress
//   resto (pending/rejected, nada aplicado/aprovado) -> not_started
// ============================================================
const db = require('../config/database');

const VENDABLE_SCOPE = `is_active AND stock_qty > 0 AND (unit IS NULL OR unit <> 'srv')`;
const VALID_KINDS = ['category', 'brand', 'attribute', 'collection', 'discard'];
const VALID_STATUSES = ['pending', 'approved', 'rejected'];
const APPLY_BATCH_SIZE = 100;

// timestamptz -> America/Sao_Paulo. Nunca CURRENT_DATE/::date cru.
function formatSaoPaulo(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
}

function mapStagingRow(r) {
  return {
    id: r.id,
    raw_value: r.raw_value,
    product_count: parseInt(r.product_count, 10) || 0,
    sample_product_names: Array.isArray(r.sample_product_names) ? r.sample_product_names : [],
    kind: r.kind,
    target_path: r.target_path,
    status: r.status,
    resolved_category_id: r.resolved_category_id,
    resolved_at: formatSaoPaulo(r.resolved_at),
    created_at: formatSaoPaulo(r.created_at),
    updated_at: formatSaoPaulo(r.updated_at),
  };
}

// ── analyze ── idempotente por (company_id, COALESCE(raw_value,'__NULL__')).
// O DO UPDATE so toca product_count/sample_product_names/updated_at --
// kind/target_path/status/resolved_category_id NUNCA entram no SET, senao
// rodar de novo apagaria a classificacao que o lojista ja fez.
async function analyze(companyId) {
  await db.query(
    `WITH scoped AS (
       SELECT category, name FROM products
       WHERE company_id = $1 AND ${VENDABLE_SCOPE} AND category IS NOT NULL
     ),
     grouped AS (
       SELECT category, COUNT(*) AS product_count FROM scoped GROUP BY category
     )
     INSERT INTO category_migration_staging (company_id, raw_value, product_count, sample_product_names)
     SELECT $1, g.category, g.product_count,
       (SELECT array_agg(s.name ORDER BY s.name) FROM (
          SELECT name FROM scoped WHERE category = g.category ORDER BY name LIMIT 5
        ) s)
     FROM grouped g
     ON CONFLICT (company_id, COALESCE(raw_value, '__NULL__')) DO UPDATE
       SET product_count = EXCLUDED.product_count,
           sample_product_names = EXCLUDED.sample_product_names,
           updated_at = now()`,
    [companyId]
  );

  // Linha orfa: SEMPRE criada, mesmo com contagem 0 (caso Villa Branca).
  await db.query(
    `WITH scoped AS (
       SELECT name FROM products
       WHERE company_id = $1 AND ${VENDABLE_SCOPE} AND category IS NULL
     )
     INSERT INTO category_migration_staging (company_id, raw_value, product_count, sample_product_names)
     SELECT $1, NULL, (SELECT COUNT(*) FROM scoped),
       (SELECT array_agg(name ORDER BY name) FROM (SELECT name FROM scoped ORDER BY name LIMIT 5) s)
     ON CONFLICT (company_id, COALESCE(raw_value, '__NULL__')) DO UPDATE
       SET product_count = EXCLUDED.product_count,
           sample_product_names = EXCLUDED.sample_product_names,
           updated_at = now()`,
    [companyId]
  );
}

// ── proposal ── nome herdado da v1 (motor que sugeria). So devolve o
// que ja esta gravado -- so chega la pelo PATCH. Orfa vem separada,
// nao misturada na lista (nao e classificavel).
async function getProposal(companyId) {
  const { rows } = await db.query(
    `SELECT id, raw_value, product_count, sample_product_names, kind, target_path,
            status, resolved_category_id, resolved_at, created_at, updated_at
       FROM category_migration_staging
      WHERE company_id = $1
      ORDER BY product_count DESC`,
    [companyId]
  );
  const mapped = rows.map(mapStagingRow);
  const orphan = mapped.find(r => r.raw_value === null) || null;
  const items = mapped.filter(r => r.raw_value !== null);
  return { items, orphan };
}

// ── patchItem ── decisao (declarada no PR): target_path so e gravado se
// kind==='category'. Com outro kind (ou sem), target_path e IGNORADO
// (NULL) em vez de 422 -- a UI pode reenviar o campo desabilitado.
async function patchItem(companyId, itemId, body) {
  const { kind, target_path, status } = body || {};

  if (kind !== undefined && kind !== null && !VALID_KINDS.includes(kind)) {
    return { error: 422, message: `kind invalido. Use um de: ${VALID_KINDS.join(', ')}` };
  }
  if (!VALID_STATUSES.includes(status)) {
    return { error: 422, message: `status invalido. Use: ${VALID_STATUSES.join(', ')} ("applied" so via apply).` };
  }

  const effectiveTargetPath = (kind === 'category') ? (target_path || null) : null;

  const { rows } = await db.query(
    `UPDATE category_migration_staging
        SET kind = $1, target_path = $2, status = $3, updated_at = now()
      WHERE id = $4 AND company_id = $5
      RETURNING id, raw_value, product_count, sample_product_names, kind, target_path,
                status, resolved_category_id, resolved_at, created_at, updated_at`,
    [kind || null, effectiveTargetPath, status, itemId, companyId]
  );
  if (!rows.length) return { error: 404, message: 'Item de migracao nao encontrado' };
  return { item: mapStagingRow(rows[0]) };
}

// ── apply ── transacional por lote de APPLY_BATCH_SIZE, retomavel: so
// processa status='approved' com raw_value NOT NULL (orfa sempre pulada).
// Erro inesperado no meio de um lote da ROLLBACK so daquele lote --
// lotes ja commitados ficam. Nova chamada retoma do que resta 'approved'.
async function apply(companyId) {
  const { rows: pending } = await db.query(
    `SELECT id, raw_value, kind, target_path
       FROM category_migration_staging
      WHERE company_id = $1 AND status = 'approved' AND raw_value IS NOT NULL
      ORDER BY created_at ASC`,
    [companyId]
  );

  const results = { applied: 0, errors: [], batches: 0 };

  for (let offset = 0; offset < pending.length; offset += APPLY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + APPLY_BATCH_SIZE);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const row of batch) {
        const outcome = await applyRow(client, companyId, row);
        if (outcome.ok) {
          results.applied++;
        } else {
          // Erro de NEGOCIO (ex.: target_path nao resolve) -- nao derruba
          // a transacao do lote. Linha fica 'approved' pra retry depois
          // que o lojista corrigir a arvore (rotas do B1).
          results.errors.push({ id: row.id, raw_value: row.raw_value, error: outcome.error });
        }
      }
      await client.query('COMMIT');
      results.batches++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      results.errors.push({ batch_offset: offset, error: 'Erro inesperado no lote: ' + err.message });
      client.release();
      break; // nao continua pros lotes seguintes; anteriores ja commitados ficam.
    }
    client.release();
  }

  return results;
}

// Processa uma linha staging na transacao do lote. Nunca lanca --
// devolve { ok:true } ou { ok:false, error } pra nao derrubar o lote.
async function applyRow(client, companyId, row) {
  if (row.kind === 'category') return applyCategoryRow(client, companyId, row);
  if (['brand', 'attribute', 'collection', 'discard'].includes(row.kind)) {
    return applyNonCategoryRow(client, companyId, row);
  }
  return { ok: false, error: `kind ausente ou invalido ("${row.kind}") -- classifique via PATCH antes de aplicar` };
}

async function applyCategoryRow(client, companyId, row) {
  if (!row.target_path) return { ok: false, error: 'target_path ausente para kind=category' };

  // (a) target_path RESOLVE, nunca cria. Se nao existir, erro acionavel --
  // criar o no e sempre acao deliberada do lojista (wizard passo 2, B1).
  const { rows: cat } = await client.query(
    `SELECT id FROM product_categories WHERE company_id = $1 AND type = 'product' AND path = $2`,
    [companyId, row.target_path]
  );
  if (!cat.length) {
    return { ok: false, error: `target_path "${row.target_path}" nao existe na arvore -- crie a categoria antes de aplicar` };
  }
  const categoryId = cat[0].id;

  const { rows: prods } = await client.query(
    `SELECT id FROM products WHERE company_id = $1 AND category = $2`,
    [companyId, row.raw_value]
  );
  const productIds = prods.map(p => p.id);

  if (productIds.length > 0) {
    // Armadilha ON CONFLICT DO NOTHING: desmarca a primaria ANTES do
    // insert -- senao o indice parcial one_primary "sucede" sem trocar
    // nada num produto que ja tem primaria.
    await client.query(
      `UPDATE product_category_links SET is_primary = false WHERE product_id = ANY($1) AND is_primary`,
      [productIds]
    );
    await client.query(
      `INSERT INTO product_category_links (product_id, category_id, is_primary)
       SELECT unnest($1::uuid[]), $2, true
       ON CONFLICT (product_id, category_id) DO UPDATE SET is_primary = true`,
      [productIds, categoryId]
    );
    // products.category final e escrito pelo trigger trg_sync_legacy_category
    // -- esta funcao NUNCA escreve products.category.
  }

  await client.query(
    `UPDATE category_migration_staging
        SET status = 'applied', resolved_category_id = $1, resolved_at = now(), updated_at = now()
      WHERE id = $2`,
    [categoryId, row.id]
  );
  return { ok: true };
}

async function applyNonCategoryRow(client, companyId, row) {
  // (c) Limpa products.category so em produtos SEM link. O trigger
  // trg_sync_legacy_category so reage a evento de link -- produto sem
  // link nunca e tocado por ele, logo esta escrita e segura.
  await client.query(
    `UPDATE products p SET category = NULL, updated_at = now()
      WHERE p.company_id = $1 AND p.category = $2
        AND NOT EXISTS (SELECT 1 FROM product_category_links l WHERE l.product_id = p.id)`,
    [companyId, row.raw_value]
  );
  await client.query(
    `UPDATE category_migration_staging SET status = 'applied', resolved_at = now(), updated_at = now() WHERE id = $1`,
    [row.id]
  );
  return { ok: true };
}

// ── status ───────────────────────────────────────────────
async function getStatus(companyId) {
  const { rows } = await db.query(
    `SELECT raw_value, status, product_count FROM category_migration_staging WHERE company_id = $1`,
    [companyId]
  );
  const orphanRow = rows.find(r => r.raw_value === null);
  const classifiable = rows.filter(r => r.raw_value !== null);

  const total = classifiable.length;
  const approved = classifiable.filter(r => r.status === 'approved').length;
  const applied = classifiable.filter(r => r.status === 'applied').length;
  const orphans = orphanRow ? (parseInt(orphanRow.product_count, 10) || 0) : 0;

  let state;
  if (total === 0) state = 'not_started';
  else if (applied >= total) state = 'done';
  else if (applied > 0 || approved > 0) state = 'in_progress';
  else state = 'not_started';

  return { state, total, approved, applied, orphans };
}

module.exports = {
  VENDABLE_SCOPE, VALID_KINDS, VALID_STATUSES, APPLY_BATCH_SIZE,
  formatSaoPaulo, mapStagingRow,
  analyze, getProposal, patchItem, apply, getStatus,
};
