// ============================================================
// AURA. — Excluir produto / variante nunca e negado (24/10/2026)
//
// Regra do Caio: se a confirmacao apareceu e a lojista aceitou, o item sai.
//
// Antes: DELETE FROM products cascateava product_variants, mas
// sale_items.variant_id (FK sem acao) segurava a variante ja vendida. O
// retry so anulava sale_items.product_id / stock_movements /
// barber_stock_movements e devolvia 409 "Tente desativa-lo". A exclusao de
// variante nem tinha retry: 500.
//
// Agora, quando o DELETE simples esbarra numa FK (23503):
//   1. numa transacao, anula as referencias de HISTORICO ao produto e as
//      variantes dele (so colunas que aceitam NULL; tabela ou coluna que
//      nao existe nesse banco e pulada) e limpa a vitrine
//      (digital_channel_config.hero_product_id);
//   2. apaga o produto (ou a variante);
//   3. se ainda assim alguma FK impedir, desfaz o passo 1 (o historico
//      fica ligado ao item) e ARQUIVA: is_active = false (+ deleted_at se a
//      coluna existir). O item some das listas do Estoque, do Caixa, do
//      bipe e da vitrine, que ja filtram is_active.
//
// O historico continua legivel: sale_items guarda product_name_snapshot
// (migration 018; o Caixa grava "Produto (variante)"), unit_price,
// unit_cost e total_price. troca_returned_items, studio_bulk_events e
// warranty_items tambem guardam o nome; digital_order_items guarda nome e
// preco. As telas de venda leem COALESCE(p.name, si.product_name_snapshot).
//
// Os nomes de tabela e coluna abaixo sao FIXOS (lista interna), nunca vem
// de entrada do usuario.
// ============================================================

// Referencias ao produto que sao historico/documento. Na producao varias
// delas estao como NO ACTION (o banco nao seguiu sempre as migrations);
// anular explicitamente vale para os dois casos.
const REFS_DO_PRODUTO = [
  ['sale_items', 'product_id'],
  ['stock_movements', 'product_id'],
  ['barber_stock_movements', 'product_id'],
  ['barber_stock_usage', 'product_id'],
  ['food_recipes', 'product_id'],
  ['troca_returned_items', 'product_id'],
  ['digital_order_items', 'product_id'],
  ['studio_bulk_events', 'product_id'],
  ['studio_quote_items', 'product_id'],
  ['service_order_items', 'product_id'],
  ['warranty_items', 'product_id'],
  ['pdv_comanda_items', 'product_id'],
  ['digital_channel_config', 'hero_product_id'],
];

const REFS_DA_VARIANTE = [
  ['sale_items', 'variant_id'],
  ['digital_order_items', 'variant_id'],
  ['troca_returned_items', 'variant_id'],
  ['pdv_comanda_items', 'variant_id'],
];

// 42P01 tabela nao existe, 42703 coluna nao existe, 23502 coluna NOT NULL,
// 23514 CHECK que exige o valor. Em todos: essa referencia fica como esta.
const PULAVEIS = new Set(['42P01', '42703', '23502', '23514']);

async function anularReferencia(client, tabela, coluna, condicao, params) {
  await client.query('SAVEPOINT anular_ref');
  try {
    const r = await client.query(
      `UPDATE ${tabela} SET ${coluna} = NULL WHERE ${coluna} ${condicao}`,
      params
    );
    await client.query('RELEASE SAVEPOINT anular_ref');
    return (r && r.rowCount) || 0;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT anular_ref');
    await client.query('RELEASE SAVEPOINT anular_ref');
    if (PULAVEIS.has(err.code)) return 0;
    throw err;
  }
}

async function anularRefsDasVariantes(client, variantIds) {
  if (!variantIds.length) return;
  for (const [tabela, coluna] of REFS_DA_VARIANTE) {
    await anularReferencia(client, tabela, coluna, '= ANY($1::uuid[])', [variantIds]);
  }
}

// Arquiva com deleted_at quando a coluna existe; sem ela, so is_active.
async function arquivar(conn, tabela, id) {
  try {
    await conn.query('SAVEPOINT arquivar');
    await conn.query(`UPDATE ${tabela} SET is_active = false, deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
    await conn.query('RELEASE SAVEPOINT arquivar');
  } catch (err) {
    await conn.query('ROLLBACK TO SAVEPOINT arquivar');
    await conn.query('RELEASE SAVEPOINT arquivar');
    if (err.code !== '42703') throw err;
    await conn.query(`UPDATE ${tabela} SET is_active = false WHERE id = $1`, [id]);
  }
}

// Fora de transacao (ultimo recurso, quando a transacao inteira falhou).
async function arquivarSolto(db, tabela, id) {
  try {
    const r = await db.query(`UPDATE ${tabela} SET is_active = false, deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
    return (r && r.rowCount) || 0;
  } catch (err) {
    if (err.code !== '42703') throw err;
    const r = await db.query(`UPDATE ${tabela} SET is_active = false WHERE id = $1`, [id]);
    return (r && r.rowCount) || 0;
  }
}

async function rollbackQuieto(client) {
  try { await client.query('ROLLBACK'); } catch (_) { /* conexao ja caiu */ }
}

/**
 * Exclui o produto ja confirmado pela lojista, depois que o DELETE simples
 * esbarrou numa FK. `whereVisivel` e o WHERE de visibilidade de grupo de
 * products.js (com $1 = pid, $2 = cid).
 *
 * @returns {Promise<{found: false} | {found: true, deleted: true, archived: boolean, id: string, name: string}>}
 */
async function excluirProdutoComHistorico(db, { pid, cid, whereVisivel }) {
  const client = await db.connect();
  let produto = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, name FROM products WHERE ${whereVisivel} FOR UPDATE`,
      [pid, cid]
    );
    if (!rows.length) {
      await rollbackQuieto(client);
      return { found: false };
    }
    produto = rows[0];

    const { rows: vrows } = await client.query(
      'SELECT id FROM product_variants WHERE product_id = $1',
      [pid]
    );
    const variantIds = vrows.map((r) => r.id);

    await client.query('SAVEPOINT antes_de_anular');
    for (const [tabela, coluna] of REFS_DO_PRODUTO) {
      await anularReferencia(client, tabela, coluna, '= $1', [pid]);
    }
    await anularRefsDasVariantes(client, variantIds);

    try {
      await client.query('SAVEPOINT apagar');
      await client.query('DELETE FROM products WHERE id = $1', [pid]);
      await client.query('RELEASE SAVEPOINT apagar');
      await client.query('COMMIT');
      return { found: true, deleted: true, archived: false, id: pid, name: produto.name };
    } catch (err) {
      if (err.code !== '23503') throw err;
      console.warn('[products] delete: FK ainda segura o produto, arquivando:', err.constraint || err.message);
      // Desfaz as anulacoes: o produto continua existindo, o historico
      // continua apontando para ele.
      await client.query('ROLLBACK TO SAVEPOINT antes_de_anular');
      await arquivar(client, 'products', pid);
      await client.query('COMMIT');
      return { found: true, deleted: true, archived: true, id: pid, name: produto.name };
    }
  } catch (err) {
    await rollbackQuieto(client);
    if (!produto) throw err;
    // Qualquer outra falha no caminho transacional: arquiva fora dela.
    console.error('[products] delete: caminho transacional falhou, arquivando:', err.message, err.code);
    await arquivarSolto(db, 'products', pid);
    return { found: true, deleted: true, archived: true, id: pid, name: produto.name };
  } finally {
    client.release();
  }
}

/**
 * Mesma regra para a variante (cor/tamanho) dentro do produto.
 * @returns {Promise<{found: false} | {found: true, deleted: true, archived: boolean, id: string}>}
 */
async function excluirVarianteComHistorico(db, { vid, pid }) {
  const client = await db.connect();
  let achou = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE',
      [vid, pid]
    );
    if (!rows.length) {
      await rollbackQuieto(client);
      return { found: false };
    }
    achou = true;

    await client.query('SAVEPOINT antes_de_anular');
    await anularRefsDasVariantes(client, [vid]);
    try {
      await client.query('SAVEPOINT apagar');
      await client.query('DELETE FROM product_variants WHERE id = $1', [vid]);
      await client.query('RELEASE SAVEPOINT apagar');
      await client.query('COMMIT');
      return { found: true, deleted: true, archived: false, id: vid };
    } catch (err) {
      if (err.code !== '23503') throw err;
      console.warn('[variants] delete: FK ainda segura a variante, arquivando:', err.constraint || err.message);
      await client.query('ROLLBACK TO SAVEPOINT antes_de_anular');
      await arquivar(client, 'product_variants', vid);
      await client.query('COMMIT');
      return { found: true, deleted: true, archived: true, id: vid };
    }
  } catch (err) {
    await rollbackQuieto(client);
    if (!achou) throw err;
    console.error('[variants] delete: caminho transacional falhou, arquivando:', err.message, err.code);
    await arquivarSolto(db, 'product_variants', vid);
    return { found: true, deleted: true, archived: true, id: vid };
  } finally {
    client.release();
  }
}

module.exports = {
  excluirProdutoComHistorico,
  excluirVarianteComHistorico,
  REFS_DO_PRODUTO,
  REFS_DA_VARIANTE,
};
