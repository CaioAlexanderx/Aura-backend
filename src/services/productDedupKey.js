// ============================================================
// AURA. -- Chave de deduplicacao de produto (nome + unidade + marca)
//
// Extraido de src/routes/importData.js (22/09/2026, import por planilha,
// PR #739 -- "chaveProdutoImport") para reuso em
// src/routes/productsDuplicates.js (23/09/2026, QA producao 23/09/2026):
// o banner "N grupos de produtos duplicados" do Estoque (GET
// /duplicate-groups) agrupava so por NOME (LOWER(TRIM(...)), sem remover
// acento, sem olhar unidade/marca) -- "MANTA ALUMINIZADA 10CM" cadastrada
// em METRO e em ROLO, ou "CIMENTO" das marcas Nassau e Mizu, viravam
// "duplicata" e empurravam a loja a unificar como VARIANTE (cor/tamanho)
// produtos que na verdade sao DIFERENTES.
//
// Agora as duas rotas (import e listagem de duplicatas) usam a MESMA
// chave: nome + unidade + marca, todos normalizados (minusculas, sem
// acento, espacos colapsados; marca vazia == vazia; unidade passa pela
// tabela de grafias do deposito -- "MT"/"metro"/"metros" == "m").
//
// Mesma filosofia de normalizeName() em karatePractitionerDedup.js: a
// normalizacao roda em JS (nao em SQL/unaccent -- unaccent() do Postgres
// e STABLE, nao IMMUTABLE, e aqui nem precisa de indice).
// ============================================================
'use strict';

// Minusculas, sem acento, espacos colapsados — so para COMPARAR.
function chaveTexto(v) {
  return String(v === null || v === undefined ? '' : v)
    .normalize('NFD').replace(/\p{Mn}/gu, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── Unidade (22/09/2026, Matcon) ───────────────────────────
// Planilha de deposito escreve a unidade do jeito dela ("MT", "RL", "PÇ",
// "UM"). Chave = sem acento, minuscula, sem ponto final; valor = grafia
// canonica do app (utils/matconUnits.ts e UNITS do estoque no front).
const UNIDADES_IMPORT = {};
for (const [canonica, grafias] of Object.entries({
  'un':      ['un', 'und', 'unid', 'unidade', 'unidades', 'um', 'u', 'uni'],
  'm':       ['m', 'mt', 'mts', 'metro', 'metros'],
  'm²':      ['m2', 'm²', 'mt2', 'mts2', 'metro quadrado', 'metros quadrados'],
  'm³':      ['m3', 'm³', 'mt3', 'mts3', 'metro cubico', 'metros cubicos'],
  'rolo':    ['rl', 'rolo', 'rolos'],
  'pç':      ['pc', 'pca', 'peca', 'pecas', 'pcs'],
  'kg':      ['kg', 'kgs', 'quilo', 'quilos', 'kilo', 'quilograma'],
  'g':       ['g', 'gr', 'grs', 'grama', 'gramas'],
  'L':       ['l', 'lt', 'lts', 'litro', 'litros'],
  'ml':      ['ml'],
  'pct':     ['pct', 'pcte', 'pacote', 'pacotes'],
  'cx':      ['cx', 'caixa', 'caixas'],
  'sc':      ['sc', 'saco', 'sacos'],
  'br':      ['br', 'barra', 'barras'],
  'dz':      ['dz', 'duzia', 'duzias'],
  'cartela': ['cart', 'cartela', 'cartelas'],
  'mlh':     ['mlh', 'milheiro', 'milheiros', 'mil'],
  'ton':     ['ton', 't', 'tonelada', 'toneladas'],
  'par':     ['par', 'pr', 'pares'],
  'kit':     ['kit', 'kits', 'jg', 'jogo', 'jogos'],
  'lata':    ['lata', 'latas'],
  'balde':   ['balde', 'baldes', 'bd'],
  'gl':      ['gl', 'galao', 'galoes'],
})) {
  for (const g of grafias) UNIDADES_IMPORT[chaveTexto(g)] = canonica;
}

// { unit, conhecida }: vazia vira 'un' (como antes); desconhecida e
// gravada em minusculas como veio — nunca recusa a linha.
function resolverUnidadeImport(raw) {
  const bruto = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!bruto) return { unit: 'un', conhecida: true };
  const chave = chaveTexto(bruto).replace(/\.+$/, '').trim();
  if (UNIDADES_IMPORT[chave]) return { unit: UNIDADES_IMPORT[chave], conhecida: true };
  return { unit: bruto.toLowerCase(), conhecida: false };
}

function normalizarUnidadeImport(raw) {
  return resolverUnidadeImport(raw).unit;
}

// Duplicata = mesmo nome + unidade + marca. Deposito tem o mesmo nome em
// marcas diferentes e em "pacote x unidade" / "metro x rolo".
function chaveProdutoImport(name, unit, brand) {
  return [chaveTexto(name), chaveTexto(normalizarUnidadeImport(unit)), chaveTexto(brand)].join('|');
}

module.exports = {
  chaveTexto,
  UNIDADES_IMPORT,
  resolverUnidadeImport,
  normalizarUnidadeImport,
  chaveProdutoImport,
};
