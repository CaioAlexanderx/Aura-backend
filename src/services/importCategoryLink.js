// ============================================================
// AURA. — D4: importação e criação em lote passam a vincular categoria
//
// Fecha os dois pontos de escrita em products.category que o Bloco 0 só
// mapeou em 18/08 (DEC-06): importData.js e productsBatch.js. Importação
// que grava texto livre recria exatamente o problema que a F0 resolve.
//
// ── O QUE ESTA FUNÇÃO FAZ, POR CATEGORIA RECEBIDA ───────────
//
//   1 categoria correspondente na árvore  → cria VÍNCULO (link primário).
//                                            products.category passa a ser
//                                            escrito pelo TRIGGER, não pela rota.
//   0 correspondentes                      → deixa PENDENTE no wizard.
//   2+ correspondentes (nome ambíguo)      → deixa PENDENTE no wizard.
//
// ── POR QUE O TEXTO CONTINUA NO PRODUTO QUANDO FICA PENDENTE ─
// Este é o ponto que quase passou batido. O wizard da migração casa
// produto com valor POR `products.category = raw_value`
// (categoryMigration.applyCategoryRow). Se a importação zerasse o texto
// do que não resolveu, o wizard perderia esses produtos de vista para
// sempre — a planilha diria "Sandalia Feminina" e nada mais registraria
// a qual produto aquilo pertencia.
//
// Então "deixar pendente" (decisão do Caio, 18/08) significa PENDENTE NA
// FILA DO WIZARD, não texto apagado: o valor entra em
// category_migration_staging com status 'pending' e o produto mantém o
// texto como chave de junção até o lojista decidir o destino.
//
// ── AMBÍGUO É PENDENTE, DE PROPÓSITO ────────────────────────
// "Calçados" pode existir sob Feminino E sob Masculino — a limitação de
// irmãos homônimos é reconhecida na DEC-01 como transitória. Adivinhar o
// ramo colocaria produto na categoria errada silenciosamente, que é pior
// que deixar o lojista escolher no wizard.
//
// ── NUNCA ESCREVE products.category ─────────────────────────
// Resolvido: quem escreve é trg_sync_legacy_category (migration 259).
// Pendente: o texto já veio no INSERT da própria rota.
// Nenhum caminho daqui faz UPDATE products SET category.
// ============================================================
'use strict';

// Mesmo escopo de "produto vendável" do analyze do wizard
// (src/services/categoryMigration.js) — a contagem do staging tem que
// bater com a que o lojista vê lá, senão o wizard mostra dois números.
const VENDABLE_SCOPE = `is_active AND stock_qty > 0 AND (unit IS NULL OR unit <> 'srv')`;

function norm(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Vincula (ou deixa pendente) a categoria dos produtos recém-criados.
 *
 * Nunca lança: importação de planilha não pode falhar inteira porque a
 * taxonomia não resolveu. O relatório volta no retorno e a rota decide o
 * que mostrar. Também é tolerante a base sem a árvore (42P01/42703),
 * para não quebrar ambiente onde as migrations 257-260 não rodaram
 * (CLAUDE.md, armadilhas 1 e 10).
 *
 * @param {object} client        pg client OU o módulo db (ambos têm .query)
 * @param {string} companyId
 * @param {Array}  products      [{ id, category }] recém-inseridos
 * @returns {Promise<{linked:number, pending:string[], ambiguous:string[], skipped:boolean}>}
 */
async function linkImportedCategories(client, companyId, products) {
  const out = { linked: 0, pending: [], ambiguous: [], skipped: false };

  const porValor = new Map();   // texto -> [productId]
  for (const p of products || []) {
    const valor = norm(p && p.category);
    if (!p || !p.id || !valor) continue;
    if (!porValor.has(valor)) porValor.set(valor, []);
    porValor.get(valor).push(p.id);
  }
  if (!porValor.size) return out;

  const valores = [...porValor.keys()];

  // Resolve TODOS os valores numa query só, e deixa o SQL devolver o
  // mapeamento pronto: uma linha por valor de entrada com os ids que
  // casaram. Normalizar acento no JS erraria em "Calçados" — unaccent()
  // vive no banco, então a comparação inteira fica lá.
  let mapa;
  try {
    const { rows } = await client.query(
      `SELECT v.valor,
              COALESCE(array_agg(c.id) FILTER (WHERE c.id IS NOT NULL), '{}') AS ids
         FROM unnest($2::text[]) AS v(valor)
         LEFT JOIN product_categories c
                ON c.company_id = $1
               AND c.type = 'product'
               AND lower(unaccent(c.name)) = lower(unaccent(v.valor))
        GROUP BY v.valor`,
      [companyId, valores]
    );
    mapa = new Map(rows.map(r => [r.valor, r.ids || []]));
  } catch (e) {
    // Sem árvore nesta base ainda (ou sem unaccent): comportamento
    // legado, o texto já foi gravado pelo INSERT da rota.
    if (e.code === '42P01' || e.code === '42703' || e.code === '42883') {
      out.skipped = true;
      return out;
    }
    throw e;
  }

  const pendentes = [];

  for (const [valor, productIds] of porValor) {
    const achados = mapa.get(valor) || [];

    if (achados.length === 0) { pendentes.push(valor); out.pending.push(valor);   continue; }
    if (achados.length > 1)   { pendentes.push(valor); out.ambiguous.push(valor); continue; }

    const categoryId = achados[0];
    try {
      // Armadilha do índice parcial one_primary (mesma paga em
      // categoryMigration.applyCategoryRow): desmarcar a primária ANTES
      // do insert, senão o ON CONFLICT "sucede" sem trocar nada num
      // produto que já tem primária.
      await client.query(
        `UPDATE product_category_links SET is_primary = false
          WHERE product_id = ANY($1::uuid[]) AND is_primary`,
        [productIds]
      );
      await client.query(
        `INSERT INTO product_category_links (product_id, category_id, is_primary)
         SELECT unnest($1::uuid[]), $2, true
         ON CONFLICT (product_id, category_id) DO UPDATE SET is_primary = true`,
        [productIds, categoryId]
      );
      out.linked += productIds.length;
    } catch (e) {
      if (e.code === '42P01') { out.skipped = true; return out; }
      // Um valor que falhou não derruba os outros — vira pendente.
      pendentes.push(valor);
      out.pending.push(valor);
    }
  }

  if (pendentes.length) await registrarPendentes(client, companyId, pendentes, out);
  return out;
}

// Registra os valores não resolvidos na fila do wizard. A contagem é
// RECONTADA a partir de products, com o mesmo escopo do analyze — assim
// o staging tem uma fonte de verdade só (a tabela de produtos) e não
// diverge da contagem que o wizard recalcula depois.
async function registrarPendentes(client, companyId, valores, out) {
  try {
    await client.query(
      `WITH scoped AS (
         SELECT category, name FROM products
          WHERE company_id = $1 AND ${VENDABLE_SCOPE}
            AND category = ANY($2::text[])
       ),
       grouped AS (
         SELECT category, COUNT(*) AS product_count FROM scoped GROUP BY category
       )
       INSERT INTO category_migration_staging
         (company_id, raw_value, product_count, sample_product_names)
       SELECT $1, g.category, g.product_count,
         (SELECT array_agg(s.name ORDER BY s.name) FROM (
            SELECT name FROM scoped WHERE category = g.category ORDER BY name LIMIT 5
          ) s)
         FROM grouped g
       ON CONFLICT (company_id, COALESCE(raw_value, '__NULL__')) DO UPDATE
         SET product_count        = EXCLUDED.product_count,
             sample_product_names = EXCLUDED.sample_product_names,
             updated_at           = now()`,
      [companyId, valores]
    );
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') { out.skipped = true; return; }
    // Falhar aqui não pode perder a importação: o analyze do wizard
    // recalcula o staging a partir de products de qualquer forma.
    console.error('[importCategoryLink] staging error:', e.message);
  }
}

module.exports = { linkImportedCategories, VENDABLE_SCOPE };
