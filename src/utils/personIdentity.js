// ============================================================
// AURA — Identidade da PESSOA: normalização de borda (F7.0)
//
// DECISÃO DE ARQUITETURA (Caio, 30/07/2026): o fluxo de informação SOBE —
// dojô → federação. O DOJÔ é dono do que descreve a pessoa (nome, nascimento,
// CPF, RG, sexo, contato, endereço, foto); a FEDERAÇÃO é dona só do que ela
// EMITE (matrícula FPKT, dan homologado, certificado, anuidade).
//
// Para o mesmo dado poder subir de um lado para o outro, ele precisa estar
// escrito do MESMO JEITO nos dois. Este módulo é o ponto único onde isso é
// decidido — usado nas BORDAS DE ESCRITA dos dois lados.
//
// ── Antes deste arquivo (auditado em 30/07/2026) ────────────
// Não existia helper de identidade em src/utils/ (conferido arquivo a
// arquivo). A normalização estava INLINE e divergente:
//   - karate_dojo_students.cpf: `String(x).replace(/\D/g,'')` dentro do
//     service, com 11 dígitos garantidos e UNIQUE parcial (dojo_id, cpf);
//   - customers.cpf_cnpj: NADA — nem normalização, nem UNIQUE. Comparar os
//     dois exige regexp_replace(...,'\D','','g') em toda query;
//   - karatePractitionerDedup.digitsOnly(): a única função "pronta", mas
//     escopada ao matcher e com semântica de '' (string vazia), não null.
// onlyDigits() abaixo é BYTE-A-BYTE equivalente a esse digitsOnly, de
// propósito. O matcher NÃO foi refatorado neste PR: ele é caminho de LEITURA
// (não é borda de escrita, que é o escopo deste helper) e teve um P0 recente
// de normalização de data — trocar a fonte de uma função dele sem necessidade
// seria risco sem retorno. A unificação entra quando o matcher for tocado.
//
// ── SEXO: três vocabulários, um canônico ────────────────────
//   karate_dojo_students.sex ..... 'M' | 'F' | 'other'                (dojô)
//   customers.sex ................ 'masculino'|'feminino'|'outro'  (CANÔNICO)
//   customers.gender ............. 'M' | 'F' | 'outro'  (DEPRECADO, odonto)
//
// CANÔNICO = 'masculino' | 'feminino' | 'outro' — é o que customers.sex já
// tem em CHECK e em 189 linhas reais. Ver migration 262 para o porquê.
//
// REGRA DAS BORDAS:
//   - entrada da API do dojô  → aceita OS DOIS vocabulários, grava M/F/other
//     (toDojoSex) — zero mudança visível no app;
//   - escrita em customers    → grava o CANÔNICO (normalizeSex);
//   - valor desconhecido      → null. "Dado faltante é neutro"; quem precisa
//     recusar (form) compara com null e devolve 422. Este módulo NUNCA chuta.
// ============================================================
'use strict';

const CPF_DIGITS = 11;
const CNPJ_DIGITS = 14;

// Semântica de string ('' quando não há dígito) — compatível byte-a-byte com
// o digitsOnly histórico de karatePractitionerDedup, que é comparado
// diretamente com o resultado de regexp_replace do Postgres em SQL.
// `v || ''` (e não `v == null ? '' : v`) é DE PROPÓSITO: é exatamente o que
// o digitsOnly faz, inclusive para falsy numérico. Há um teste que trava as
// duas implementações lado a lado.
function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

// Semântica de COLUNA (null quando vazio) — é o que vai para o banco, onde
// '' e NULL são coisas diferentes e '' furaria qualquer UNIQUE parcial
// `WHERE cpf IS NOT NULL`.
function normalizeCpf(v) {
  const d = onlyDigits(v);
  return d === '' ? null : d;
}

// customers.cpf_cnpj guarda CPF ou CNPJ na MESMA coluna — mesma regra.
function normalizeCpfCnpj(v) {
  return normalizeCpf(v);
}

function isCpfLength(v) {
  return onlyDigits(v).length === CPF_DIGITS;
}

function isCnpjLength(v) {
  return onlyDigits(v).length === CNPJ_DIGITS;
}

// Chave de comparação ASCII: NFD separa o acento em caractere próprio e o
// filtro [^a-zA-Z] o remove junto com espaços, pontos e hífens.
// 'Masculino' → 'masculino' | ' F ' → 'f' | 'S.P.' → 'sp' | 'Não' → 'nao'.
// Sem classe de caractere combinante literal no fonte (armadilha de escape).
function asciiKey(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase();
}

// ── Sexo ────────────────────────────────────────────────────
const SEX_CANONICAL = Object.freeze(['masculino', 'feminino', 'outro']);
const SEX_DOJO = Object.freeze(['M', 'F', 'other']);

// Só entram formas que EXISTEM nos três vocabulários do produto + as
// variações óbvias de digitação. Nada de adivinhação semântica: o que não
// está aqui vira null.
const SEX_ALIASES = Object.freeze({
  m: 'masculino',
  masc: 'masculino',
  masculino: 'masculino',
  male: 'masculino',
  f: 'feminino',
  fem: 'feminino',
  feminino: 'feminino',
  female: 'feminino',
  o: 'outro',
  outro: 'outro',
  outros: 'outro',
  other: 'outro',
});

// Qualquer vocabulário → CANÔNICO ('masculino'|'feminino'|'outro') ou null.
function normalizeSex(v) {
  if (v === null || v === undefined) return null;
  const key = asciiKey(v);
  if (!key) return null;
  return SEX_ALIASES[key] || null;
}

// Qualquer vocabulário → vocabulário do DOJÔ ('M'|'F'|'other') ou null.
// Usado na borda de escrita de karate_dojo_students para NÃO mudar o que o
// app já lê hoje enquanto a conversão do dado (F7.2) não acontece.
function toDojoSex(v) {
  switch (normalizeSex(v)) {
    case 'masculino': return 'M';
    case 'feminino': return 'F';
    case 'outro': return 'other';
    default: return null;
  }
}

// true só quando o valor é reconhecível. null/'' NÃO é "conhecido" — quem
// chama decide se ausência é erro (form) ou neutro (import).
function isKnownSex(v) {
  return normalizeSex(v) !== null;
}

// ── Endereço (vocabulário compartilhado dojô ↔ federação) ───
// UF em 2 letras maiúsculas — customers.state é `character` e não tolera
// lixo; padronizar aqui evita "sp", "S.P." e " SP " chegarem no banco.
function normalizeUf(v) {
  if (v === null || v === undefined) return null;
  const s = asciiKey(v).toUpperCase();
  return s.length === 2 ? s : null;
}

// CEP: 8 dígitos, sem máscara. Fora disso devolve null e quem chama decide
// se isso é erro (form) ou neutro (import).
function normalizeZipCode(v) {
  const d = onlyDigits(v);
  return d.length === 8 ? d : null;
}

module.exports = {
  CPF_DIGITS,
  CNPJ_DIGITS,
  SEX_CANONICAL,
  SEX_DOJO,
  asciiKey,
  onlyDigits,
  normalizeCpf,
  normalizeCpfCnpj,
  isCpfLength,
  isCnpjLength,
  normalizeSex,
  toDojoSex,
  isKnownSex,
  normalizeUf,
  normalizeZipCode,
};
