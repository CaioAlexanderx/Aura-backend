// ============================================================
// AURA KARATÊ — apuração de KATA por 5 notas (regra real FPKT/JKA)
//
// Cada árbitro dá uma nota (tipicamente 5 árbitros). Regra ditada pelo
// dono do produto (mesário no Paulista 2026):
//   1. TOTAL: soma cortando a nota mais ALTA e a mais BAIXA (uma
//      ocorrência de cada — com 5 notas, somam-se as 3 do meio).
//   2. Desempate 1: soma-se DE VOLTA a nota mais baixa (= soma − maior).
//   3. Desempate 2: soma-se também a mais alta (= soma das 5).
//   4. Persistindo o empate: NOVO KATA — decisão humana; o sistema só
//      sinaliza (tie_break_needed), nunca desempata sozinho.
//
// Funções PURAS (sem DB) — usadas pelo PUT/advance/finalize de
// karateBrackets.js e testáveis isoladamente. Dinheiro não: notas têm
// 1 casa decimal na prática; trabalhamos em CENTÉSIMOS inteiros para
// não cair em ruído de float na comparação de empate.
// ============================================================
'use strict';

// Aceita 3 a 7 notas (o padrão real é 5). Devolve null se inválido.
function normalizeNotas(raw) {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 7) return null;
  const out = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n) || n < 0 || n > 10) return null;
    out.push(Math.round(n * 100) / 100);
  }
  return out;
}

// { total, tb1, tb2 } — todos em PONTOS (2 casas), calculados em centésimos.
function computeKataTotals(notas) {
  const cents = notas.map((n) => Math.round(n * 100));
  const sum = cents.reduce((a, b) => a + b, 0);
  const hi = Math.max(...cents);
  const lo = Math.min(...cents);
  const totalC = sum - hi - lo;   // corta UMA ocorrência de cada extremo
  const tb1C = totalC + lo;       // soma de volta a mais baixa
  const tb2C = sum;               // soma também a mais alta (todas)
  return { total: totalC / 100, tb1: tb1C / 100, tb2: tb2C / 100 };
}

// Comparador DESC para ranking. Entradas: { nota, notas } — quando `notas`
// existe, a cascata usa os desempates reais; sem `notas` (legado, nota
// única), só a nota decide. Retorno 0 = EMPATE PERSISTENTE (novo kata).
function compareKata(a, b) {
  const at = a.notas ? computeKataTotals(a.notas) : { total: a.nota, tb1: null, tb2: null };
  const bt = b.notas ? computeKataTotals(b.notas) : { total: b.nota, tb1: null, tb2: null };
  const c = (x, y) => (x === null || y === null ? 0 : Math.round(y * 100) - Math.round(x * 100));
  return c(at.total, bt.total) || c(at.tb1, bt.tb1) || c(at.tb2, bt.tb2);
}

module.exports = { normalizeNotas, computeKataTotals, compareKata };
