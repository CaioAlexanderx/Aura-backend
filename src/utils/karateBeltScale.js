// ============================================================
// AURA KARATÊ — F8.0: DICIONÁRIO CANÔNICO DE FAIXAS (fonte única)
//
// Escala oficial da FPKT, confirmada pelo dono do produto em 31/07/2026:
//
//   10º kyu Branca   ·  9º kyu Amarela  ·  8º kyu Laranja
//    7º kyu Verde    ·  6º kyu Azul Claro ·  5º kyu Roxa
//    4º kyu Azul Escuro · 3º/2º/1º kyu Marrom · Preta 1º ao 10º dan
//
//   "Branca, Amarela, Laranja, Verde, Azul Claro, Roxa, Azul Escuro,
//    Marrom (3 Kyus) e Preta."  — Caio, 31/07/2026
//
// ── POR QUE ESTE ARQUIVO EXISTE ────────────────────────────
// Até hoje o backend tinha QUATRO representações divergentes da mesma
// escala, e três delas discordavam entre si:
//
//   1. migrations/229 — CASE da view karate_current_belt.
//      roxo=5, azul_claro=6  → Roxa ANTES de Azul Claro. ERRADO.
//   2. src/services/karateDojoFederativeService.js — const BELT_ORDER.
//      Cópia literal da 229 (o próprio comentário dizia "MESMOS pesos do
//      CASE da migration 229"). Herdava o mesmo erro.
//   3. src/routes/karateFederation.js — const BELT_ORDER + beltRank().
//      Escala própria (10..900) com azul_claro=45, azul=50,
//      azul_escuro=55, roxa=60 → Azul Escuro ANTES de Roxa. ERRADO, e de
//      um jeito DIFERENTE do erro da 229.
//   4. migrations/150 — seed karate_belt_requirements.
//      6kyu→5kyu "Azul Claro → Roxo" e 5kyu→4kyu "Roxo → Azul Escuro".
//      CORRETO — a tabela de requisitos da FPKT sempre esteve certa; quem
//      divergiu foi a view e os dois mapas de JS.
//
// A partir daqui existe UMA escala. Quem precisar ordenar, rotular ou
// deduzir grau de faixa importa daqui. Novo mapa de faixa em qualquer
// arquivo = regressão (ver __tests__/karate.beltScale.test.js, que
// também confere o CASE da migration 264 contra LEVEL_RANK).
//
// ── ONDE O SENSEI PARA ────────────────────────────────────
// O teto da graduação feita pelo DOJÔ é o 1º kyu (Marrom 1º kyu).
// Faixa preta é EXCLUSIVAMENTE banca da federação — e isso não é regra
// nova nossa: a própria tabela de requisitos da FPKT (seed da migration
// 150) carrega, no degrau 1kyu → 1dan, a nota "Exame estadual
// obrigatório com banca designada pela FPKT".
//
// ── DUAS ESCALAS, NÃO UMA ─────────────────────────────────
// karate_belt_history.belt_schema separa 'fpkt_shotokan' (a atual, 10
// kyus, sem vermelha) de 'legacy' (sistema antigo de 7 kyus, com
// vermelha — 953 linhas, a última de 2016). Este módulo descreve a
// escala fpkt_shotokan. A legacy é reconhecida (para não sumir do
// histórico e não quebrar ordenação) mas NÃO tem mapa kyu→cor: a ordem
// interna dos 7 kyus antigos não está documentada em lugar nenhum do
// repo, e inventá-la carimbaria um fato falso em 4.446 graduações.
// Vermelha fica FORA da progressão (rank 0), como já estava na 229.
//
// ── GRAU: COR ≠ GRAU ──────────────────────────────────────
// belt_level guarda a COR ('marrom', 'preta'). O grau vive dentro do
// texto de belt_name ("Preta 1°", "Marrom 3°kyu") — foi assim que a
// 229 teve de extrair dan por regex. A migration 264 cria belt_kyu /
// belt_dan em karate_belt_history; as funções daqui implementam as
// MESMAS regras de dedução das funções SQL karate_belt_dan_from_name /
// karate_belt_kyu_from_name criadas pela 264, para que JS e banco nunca
// respondam coisas diferentes sobre a mesma linha.
// ============================================================
'use strict';

const BELT_SCHEMA_FPKT = 'fpkt_shotokan';
const BELT_SCHEMA_LEGACY = 'legacy';
const BELT_SCHEMAS = Object.freeze([BELT_SCHEMA_FPKT, BELT_SCHEMA_LEGACY]);

// Grau máximo de faixa preta reconhecido pela escala (1º ao 10º dan).
const MAX_DAN = 10;

// ── A escala, em ordem CRESCENTE de graduação ──────────────
// `kyus` lista os kyus daquela cor, do mais baixo para o mais alto
// (marrom tem três). Cor com um kyu só é DEDUTÍVEL: saber a cor é saber
// o kyu. Marrom não é: 3º, 2º e 1º kyu dividem a mesma cor.
const COLOR_SCALE = Object.freeze([
  Object.freeze({ level: 'branca', label: 'Branca', kyus: Object.freeze([10]) }),
  Object.freeze({ level: 'amarela', label: 'Amarela', kyus: Object.freeze([9]) }),
  Object.freeze({ level: 'laranja', label: 'Laranja', kyus: Object.freeze([8]) }),
  Object.freeze({ level: 'verde', label: 'Verde', kyus: Object.freeze([7]) }),
  Object.freeze({ level: 'azul_claro', label: 'Azul Claro', kyus: Object.freeze([6]) }),
  Object.freeze({ level: 'roxo', label: 'Roxa', kyus: Object.freeze([5]) }),
  Object.freeze({ level: 'azul_escuro', label: 'Azul Escuro', kyus: Object.freeze([4]) }),
  Object.freeze({ level: 'marrom', label: 'Marrom', kyus: Object.freeze([3, 2, 1]) }),
  Object.freeze({ level: 'preta', label: 'Preta', kyus: Object.freeze([]) }),
]);

// Cor que existe SÓ na escala legada. Fora da progressão de propósito.
const LEGACY_ONLY_LEVELS = Object.freeze(['vermelha']);

// Sinônimos vindos de importação/planilha/UI antiga. Normalizar aqui é o
// que evita que 'Azul Claro', 'azulclaro' e 'azul_claro' virem três
// faixas diferentes num GROUP BY.
//
// 'azul' (sem qualificação) NÃO existe em nenhuma das 13.781 linhas de
// karate_belt_history (medido em 31/07/2026) — só aparecia como chave
// órfã no mapa de karateFederation.js, onde valia 50 e se enfiava entre
// azul_claro e azul_escuro. Mapeado para azul_claro por ser o primeiro
// azul da progressão; se algum dia entrar dado com 'azul' cru, ele cai
// na faixa mais baixa das duas em vez de virar uma faixa fantasma.
const LEVEL_ALIASES = Object.freeze({
  roxa: 'roxo',
  azul: 'azul_claro',
  azulclaro: 'azul_claro',
  'azul claro': 'azul_claro',
  azulescuro: 'azul_escuro',
  'azul escuro': 'azul_escuro',
  vermelho: 'vermelha',
});

// ── Rank por COR (0..9) ────────────────────────────────────
// É o espelho EXATO do CASE de karate_current_belt (migration 264).
// Derivado da ordem de COLOR_SCALE — não é uma segunda lista escrita à
// mão, é a mesma lista contada. vermelha=0 fica fora da progressão.
const LEVEL_RANK = Object.freeze(
  COLOR_SCALE.reduce(
    (acc, c, i) => {
      acc[c.level] = i + 1;
      return acc;
    },
    { vermelha: 0 }
  )
);

// ── Escada completa: 10 kyus + 10 dans, em ordem crescente ──
// Cada degrau é um par (cor, grau) com rótulo de exibição e um rank
// linear 1..20. É o objeto que a UI de graduação consome.
const FPKT_LADDER = Object.freeze(
  [].concat(
    ...COLOR_SCALE.filter((c) => c.kyus.length).map((c) =>
      c.kyus.map((kyu) => ({
        level: c.level,
        color_label: c.label,
        kyu,
        dan: null,
        label: c.kyus.length > 1 ? `${c.label} ${kyu}º kyu` : c.label,
        grantable_by_dojo: true,
      }))
    ),
    Array.from({ length: MAX_DAN }, (_, i) => ({
      level: 'preta',
      color_label: 'Preta',
      kyu: null,
      dan: i + 1,
      label: `Preta ${i + 1}º dan`,
      grantable_by_dojo: false,
    }))
  ).map((step, i) => Object.freeze(Object.assign({}, step, { rank: i + 1 })))
);

// ── Fronteira do sensei ────────────────────────────────────
// Último degrau que o dojô pode conceder. Tudo acima é banca federativa.
const DOJO_CEILING = Object.freeze({ level: 'marrom', kyu: 1, label: 'Marrom 1º kyu' });
const DOJO_CEILING_REASON =
  'Faixa preta é exame de banca da federação (FPKT). A própria tabela de ' +
  'requisitos da federação registra isso no degrau 1kyu → 1dan: "Exame ' +
  'estadual obrigatório com banca designada pela FPKT".';

// ============================================================
// Normalização
// ============================================================

function normalizeBeltLevel(value) {
  if (value == null) return null;
  const raw = String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (!raw) return null;
  const compact = raw.replace(/[\s-]+/g, ' ');
  if (Object.prototype.hasOwnProperty.call(LEVEL_ALIASES, compact)) {
    return LEVEL_ALIASES[compact];
  }
  const underscored = compact.replace(/\s+/g, '_');
  if (Object.prototype.hasOwnProperty.call(LEVEL_ALIASES, underscored)) {
    return LEVEL_ALIASES[underscored];
  }
  return underscored;
}

function normalizeBeltSchema(value) {
  const raw = value == null ? '' : String(value).trim().toLowerCase();
  return raw === BELT_SCHEMA_LEGACY ? BELT_SCHEMA_LEGACY : BELT_SCHEMA_FPKT;
}

function colorOf(level) {
  const key = normalizeBeltLevel(level);
  if (!key) return null;
  return COLOR_SCALE.find((c) => c.level === key) || null;
}

function isBlackBelt(level) {
  return normalizeBeltLevel(level) === 'preta';
}

function isLegacyOnlyLevel(level) {
  const key = normalizeBeltLevel(level);
  return key != null && LEGACY_ONLY_LEVELS.indexOf(key) !== -1;
}

// ============================================================
// Ordenação
// ============================================================

// Rank por cor (0..9). null = cor desconhecida — o caller decide.
// Espelha o CASE de karate_current_belt.
function levelRankOf(level) {
  const key = normalizeBeltLevel(level);
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, key) ? LEVEL_RANK[key] : null;
}

// Rank de EXIBIÇÃO — o número que sai no payload da API para o front
// ordenar a lista "Praticantes por graduação". Múltiplos de 10 por cor
// (branca 10 … preta 90) para preservar a ordem de grandeza que o front
// já recebia de karateFederation.js; o grau soma dentro da própria cor.
// É opaco: só a ORDEM importa, nunca o valor absoluto.
const UNKNOWN_DISPLAY_RANK = 500; // desconhecida vem depois das conhecidas…
const LEGACY_RED_DISPLAY_RANK = 900; // …e a vermelha (legada) fecha a lista.

function beltDisplayRank(level, beltNameOrDegree) {
  const key = normalizeBeltLevel(level);
  if (key === 'vermelha') return LEGACY_RED_DISPLAY_RANK;

  const degree = resolveDegreeArg(key, beltNameOrDegree);
  const base = levelRankOf(key);
  if (base == null) return UNKNOWN_DISPLAY_RANK;

  if (key === 'preta') {
    // Preta 1º dan = 91, 2º = 92 … 10º = 100. Sem grau conhecido → 91
    // (mesma degradação da implementação anterior: assume Shodan).
    return base * 10 + (degree.dan || 1);
  }
  if (key === 'marrom') {
    // 3º kyu = 80, 2º = 81, 1º = 82. Sem grau → 80 (o degrau mais baixo
    // da cor): grau desconhecido NUNCA promove ninguém por engano.
    const kyu = degree.kyu;
    return base * 10 + (kyu != null ? 3 - kyu : 0);
  }
  return base * 10;
}

function resolveDegreeArg(level, arg) {
  if (arg == null) return { kyu: null, dan: null };
  if (typeof arg === 'object') {
    return {
      kyu: Number.isInteger(arg.kyu) ? arg.kyu : null,
      dan: Number.isInteger(arg.dan) ? arg.dan : null,
    };
  }
  return parseDegreeFromName(level, arg);
}

// ============================================================
// Grau: dedução a partir do que existe hoje no dado
// ============================================================

// Primeiro número do texto, 1..10, ou null.
// Mais estrito que o regexp_replace da 229 (que concatenava TODOS os
// dígitos): "Preta 1° 2020" viraria 12020 lá e 1 aqui. Nas 912 linhas
// com dígito em belt_name as duas leituras dão o MESMO resultado
// (conferido em 31/07/2026), então a troca não move nenhum dado real.
function firstNumberInRange(text) {
  if (text == null) return null;
  const m = String(text).match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAN ? n : null;
}

// Grau escrito DENTRO de belt_name. Espelha karate_belt_dan_from_name /
// a primeira regra de karate_belt_kyu_from_name (migration 264).
//   'preta'  + número           → dan   ("Preta 1°"     → dan 1)
//   qualquer + número + "kyu"   → kyu   ("Marrom 3°kyu" → kyu 3)
//   "Marrom" sem número         → { kyu: null, dan: null }
function parseDegreeFromName(level, beltName) {
  const key = normalizeBeltLevel(level);
  const name = beltName == null ? '' : String(beltName);
  const n = firstNumberInRange(name);
  if (key === 'preta') return { kyu: null, dan: n };
  if (n != null && /kyu/i.test(name)) return { kyu: n, dan: null };
  return { kyu: null, dan: null };
}

// Grau DEDUTÍVEL da cor — só para cores de kyu único e só na escala
// fpkt_shotokan. Marrom retorna null de propósito (3 kyus na mesma cor);
// legacy retorna null de propósito (mapa kyu→cor desconhecido).
function kyuFromColor(level, beltSchema) {
  if (normalizeBeltSchema(beltSchema) !== BELT_SCHEMA_FPKT) return null;
  const color = colorOf(level);
  if (!color || color.kyus.length !== 1) return null;
  return color.kyus[0];
}

// Resolução completa, na MESMA ordem de precedência do backfill da 264:
//   1. dan escrito no nome (preta)
//   2. kyu escrito no nome ("… Xº kyu")
//   3. kyu deduzido da cor (fpkt_shotokan, cor de kyu único)
//   4. desconhecido → { kyu: null, dan: null, source: null }
// `source` deixa explícito de onde veio — quem consome pode distinguir
// "1º kyu porque está escrito" de "6º kyu porque a cor só tem um kyu".
function resolveDegree(level, beltName, beltSchema) {
  const fromName = parseDegreeFromName(level, beltName);
  if (fromName.dan != null) return { kyu: null, dan: fromName.dan, source: 'name' };
  if (fromName.kyu != null) return { kyu: fromName.kyu, dan: null, source: 'name' };
  const kyu = kyuFromColor(level, beltSchema);
  if (kyu != null) return { kyu, dan: null, source: 'color' };
  return { kyu: null, dan: null, source: null };
}

// ============================================================
// Rótulos
// ============================================================

function beltLabel(level, degree) {
  const key = normalizeBeltLevel(level);
  const d = resolveDegreeArg(key, degree);
  if (key === 'preta') return d.dan != null ? `Preta ${d.dan}º dan` : 'Preta';
  const color = colorOf(key);
  if (!color) return isLegacyOnlyLevel(key) ? 'Vermelha' : null;
  if (color.kyus.length > 1 && d.kyu != null) return `${color.label} ${d.kyu}º kyu`;
  return color.label;
}

// ============================================================
// Fronteira do sensei
// ============================================================

// O dojô gradua até 1º kyu. Preta (qualquer dan) é banca da federação.
// Recebe { level, kyu, dan } ou (level, beltName).
function canDojoGrant(target, beltName) {
  const level = normalizeBeltLevel(target && target.level != null ? target.level : target);
  if (!level) return false;
  if (level === 'preta') return false;
  if (isLegacyOnlyLevel(level)) return false; // escala legada não é graduável
  const color = colorOf(level);
  if (!color || !color.kyus.length) return false;
  const degree =
    target && typeof target === 'object' ? resolveDegreeArg(level, target) : parseDegreeFromName(level, beltName);
  if (degree.dan != null) return false;
  if (degree.kyu != null && color.kyus.indexOf(degree.kyu) === -1) return false;
  return true;
}

// ============================================================
// Compatibilidade — mapa antigo, valores corrigidos
// ============================================================
// BELT_ORDER era exportado por karateDojoFederativeService.js com a
// ordem invertida herdada da 229. Continua exportado (mesmo formato,
// mesmas chaves, incluindo o alias 'roxa' e vermelha=0) para não quebrar
// nenhum consumidor — mas agora é DERIVADO de LEVEL_RANK.
const BELT_ORDER = Object.freeze(
  Object.keys(LEVEL_RANK).reduce(
    (acc, k) => {
      acc[k] = LEVEL_RANK[k];
      return acc;
    },
    { roxa: LEVEL_RANK.roxo }
  )
);

function beltOrderOf(beltLevel) {
  return levelRankOf(beltLevel);
}

module.exports = {
  BELT_SCHEMA_FPKT,
  BELT_SCHEMA_LEGACY,
  BELT_SCHEMAS,
  MAX_DAN,
  COLOR_SCALE,
  LEGACY_ONLY_LEVELS,
  LEVEL_ALIASES,
  LEVEL_RANK,
  FPKT_LADDER,
  DOJO_CEILING,
  DOJO_CEILING_REASON,
  UNKNOWN_DISPLAY_RANK,
  LEGACY_RED_DISPLAY_RANK,
  BELT_ORDER,
  normalizeBeltLevel,
  normalizeBeltSchema,
  colorOf,
  isBlackBelt,
  isLegacyOnlyLevel,
  levelRankOf,
  beltOrderOf,
  beltDisplayRank,
  parseDegreeFromName,
  kyuFromColor,
  resolveDegree,
  beltLabel,
  canDojoGrant,
};
