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

// ─── SKU (20/10/2026, loja de roupas) ───────────────────────
// Planilha de loja de roupa vem com nome generico ("Blusa" x23, "Colar"
// x8) e o codigo do fornecedor no SKU: cada linha e uma PECA diferente,
// com preco proprio. So nome+unidade+marca jogava todas no mesmo grupo
// de "duplicatas" (14 grupos falsos numa loja medida em 20/10). O mesmo
// modelo em tamanhos diferentes repete o SKU (41402 P e M) -- esse sim
// e candidato a unificar em variante.
//
// SKU comparado com trim e sem caixa ("b8449 " == "B8449"). Vazio = ''.
function chaveSku(sku) {
  return String(sku === null || sku === undefined ? '' : sku).trim().toLowerCase();
}

// Chave do banner "N grupos de produtos duplicados" (GET
// /duplicate-groups): nome + unidade + marca + SKU.
//   - os dois com SKU: so agrupa se o SKU for o MESMO;
//   - os dois sem SKU: regra de antes (so nome+unidade+marca);
//   - um com SKU e outro sem: NAO agrupa. SKU preenchido e sinal de peca
//     cadastrada com o codigo do fornecedor; o sem SKU pode ser outra
//     peca de mesmo nome generico. O banner empurra a unificar em
//     VARIANTE, que apaga o produto secundario -- na duvida, nao sugerir.
function chaveDuplicataProduto(name, unit, brand, sku) {
  return chaveProdutoImport(name, unit, brand) + '|' + chaveSku(sku);
}

// Import por planilha: dentre os ja vistos com a mesma chave
// nome+unidade+marca (`lista` = [{ sku, ... }], sku ja passado por
// chaveSku), devolve o que conta como a MESMA peca, ou undefined.
// SKU diferente dos dois lados = pecas diferentes, entram as duas (como
// no banner). Se um dos lados nao tem SKU, continua duplicata como antes:
// aqui o erro caro e o contrario do banner -- deixar entrar dobra o
// catalogo numa reimportacao (ex.: 1a planilha sem a coluna SKU, 2a com
// ela), e a linha pulada volta listada em `duplicatas` no dry_run.
function mesmaPecaNoImport(lista, sku) {
  if (!lista) return undefined;
  return lista.find((e) => !sku || !e.sku || e.sku === sku);
}

module.exports = {
  chaveTexto,
  UNIDADES_IMPORT,
  resolverUnidadeImport,
  normalizarUnidadeImport,
  chaveProdutoImport,
  chaveSku,
  chaveDuplicataProduto,
  mesmaPecaNoImport,
};
