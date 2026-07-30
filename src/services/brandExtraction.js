// ============================================================
// AURA. -- Extracao de marca (Bloco B2, Fase F0)
// Puro SQL: agrupa o primeiro token do nome dos produtos sem `brand`.
// Nenhuma normalizacao esperta, nenhum casamento aproximado, nenhuma
// lista de marcas conhecidas hardcoded -- o lojista corrige na tela
// (ex.: "Beira" -> "Beira Rio", truncamento de nome composto).
// ============================================================
const db = require('../config/database');
const { VENDABLE_SCOPE } = require('./categoryMigration');

const BRAND_APPLY_MAX = 100;

// ── brandCandidates ──────────────────────────────────────
// Mesmo recorte de vendavel do analyze. ?min_count= (default 1) pra UI
// filtrar a cauda de tokens raros.
async function brandCandidates(companyId, minCount) {
  const min = Number.isFinite(minCount) && minCount > 0 ? Math.floor(minCount) : 1;
  const { rows } = await db.query(
    `SELECT split_part(btrim(name), ' ', 1) AS token, COUNT(*) AS product_count
       FROM products
      WHERE company_id = $1 AND brand IS NULL AND ${VENDABLE_SCOPE}
        AND btrim(name) <> ''
      GROUP BY split_part(btrim(name), ' ', 1)
     HAVING COUNT(*) >= $2
      ORDER BY COUNT(*) DESC, token ASC`,
    [companyId, min]
  );
  return rows.map(r => ({ token: r.token, product_count: parseInt(r.product_count, 10) || 0 }));
}

// ── applyBrands ──────────────────────────────────────────
// Casamento pelo token bruto (primeiro token do nome); grava o brand
// corrigido pelo lojista. Sem filtro de brand IS NULL de proposito:
// permite corrigir marca ja gravada, e roda de novo com o mesmo payload
// sem mudar nada alem de updated_at (idempotente).
async function applyBrands(companyId, assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return { error: 400, message: 'assignments[] e obrigatorio e nao pode estar vazio' };
  }
  if (assignments.length > BRAND_APPLY_MAX) {
    return { error: 400, message: `Maximo de ${BRAND_APPLY_MAX} tokens por chamada` };
  }
  for (const a of assignments) {
    if (!a || typeof a.token !== 'string' || !a.token.trim() || typeof a.brand !== 'string' || !a.brand.trim()) {
      return { error: 400, message: 'Cada assignment precisa de { token, brand } nao vazios' };
    }
  }

  const results = [];
  for (const { token, brand } of assignments) {
    const { rows } = await db.query(
      `UPDATE products SET brand = $1, updated_at = now()
        WHERE company_id = $2 AND split_part(btrim(name), ' ', 1) = $3
        RETURNING id`,
      [brand.trim(), companyId, token]
    );
    results.push({ token, brand: brand.trim(), updated: rows.length });
  }
  return { results };
}

module.exports = { brandCandidates, applyBrands, BRAND_APPLY_MAX };
