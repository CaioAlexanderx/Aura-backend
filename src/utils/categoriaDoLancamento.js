// ============================================================
// AURA. — Categoria do lancamento (migration 434), em SQL
//
// /transactions grava category_id junto do texto sem uma ida a mais ao banco
// (o app roda longe do banco; cada ida custa ~190 ms): o id e o texto saem de
// subconsultas dentro do proprio INSERT/UPDATE.
//
// Regras:
//   - category_id da loja e do mesmo tipo -> vale; o texto vira o nome da
//     categoria-MAE (subcategoria nunca vai para transactions.category).
//   - category_id de outra loja, de outro tipo ou inexistente -> ignorado;
//     cai no texto.
//   - so texto (app antigo, lote, outros clientes) -> liga a categoria de
//     primeiro nivel de mesmo nome (sem acento/caixa), se houver.
//
// Antes da 434 (42P01/42703/42883) as rotas voltam ao SQL antigo e guardam
// isso aqui (cache do modulo), sem repetir o erro a cada request.
// ============================================================
'use strict';

var disponivel = null;

// So o que falta da 434 desliga as categorias. Outra coluna ausente e erro de
// verdade e tem que aparecer, nao virar "sem categorias" calado.
function faltaSchema(err) {
  if (!err || (err.code !== '42P01' && err.code !== '42703' && err.code !== '42883')) return false;
  return /category_id|finance_categor/i.test(String(err.message || ''));
}
function usarCategorias() { return disponivel !== false; }
function marcarIndisponivel() { disponivel = false; }
function _reset() { disponivel = null; }

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idValido(v) { return v === undefined || v === null || v === '' || UUID_RE.test(String(v)); }
function idOuNull(v) { return v ? String(v) : null; }

// $cid: a empresa; $id: category_id (uuid ou NULL); $kind: 'income'|'expense'
// como TEXTO (parametro proprio: reaproveitar o do enum quebra a inferencia
// de tipo do Postgres, ver o hotfix 42804 em transactions.js).
function sqlDoId(cid, id, txt, kind) {
  return 'COALESCE(' +
    '(SELECT fc.id FROM finance_categories fc WHERE fc.id = ' + id + '::uuid AND fc.company_id = ' + cid + ' AND fc.kind = ' + kind + '::text),' +
    ' (SELECT fc.id FROM finance_categories fc WHERE fc.company_id = ' + cid +
    ' AND fc.kind = ' + kind + '::text AND fc.parent_id IS NULL AND fc.archived_at IS NULL' +
    ' AND fc.name_norm = finance_category_norm(' + txt + ') LIMIT 1))';
}

function sqlDoTexto(cid, id, kind, fallback) {
  return 'COALESCE((SELECT COALESCE(p.name, fc.name) FROM finance_categories fc' +
    ' LEFT JOIN finance_categories p ON p.id = fc.parent_id' +
    ' WHERE fc.id = ' + id + '::uuid AND fc.company_id = ' + cid + ' AND fc.kind = ' + kind + '::text), ' + fallback + ')';
}

// Colunas extras da listagem: o id, o nome da subcategoria (quando o id
// aponta para uma) e o nome atual da categoria-mae (o texto antigo pode estar
// sem acento, ex. "Servicos").
function colunasDaLista(tabela) {
  var t = tabela || 'transactions';
  return ', ' + t + '.category_id,' +
    ' (SELECT CASE WHEN fc.parent_id IS NULL THEN NULL ELSE fc.name END FROM finance_categories fc WHERE fc.id = ' + t + '.category_id) AS subcategory,' +
    ' (SELECT COALESCE(p.name, fc.name) FROM finance_categories fc LEFT JOIN finance_categories p ON p.id = fc.parent_id WHERE fc.id = ' + t + '.category_id) AS category_name';
}

module.exports = {
  faltaSchema, usarCategorias, marcarIndisponivel, _reset,
  idValido, idOuNull, sqlDoId, sqlDoTexto, colunasDaLista,
};
