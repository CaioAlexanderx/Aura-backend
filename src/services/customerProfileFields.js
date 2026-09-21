// ============================================================
// AURA. — Campos do perfil do cliente (Fase 1 CRM, migration 341)
//
// Validação PURA de tags, preferences e important_dates, usada no PATCH de
// clientes e na mesclagem. Cada parse devolve { ok, value } ou
// { ok: false, error } — a rota transforma em 400 com o campo.
// ============================================================
'use strict';

const MAX_TAGS = 30;
const MAX_TAG_LEN = 40;
const MAX_PREFS_BYTES = 8000;
const MAX_DATES = 20;
const MAX_DATE_LABEL = 60;

/**
 * Tags: trim, espaços colapsados, sem vazias, sem repetição (comparação sem
 * diferenciar maiúsculas — a primeira grafia vence). Aceita array ou string
 * separada por vírgula.
 */
function parseTags(raw) {
  if (raw === null) return { ok: true, value: [] };
  let list = raw;
  if (typeof raw === 'string') list = raw.split(',');
  if (!Array.isArray(list)) return { ok: false, error: 'tags deve ser uma lista de textos' };
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      return { ok: false, error: 'tags deve ser uma lista de textos' };
    }
    const tag = String(item).replace(/\s+/g, ' ').trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LEN) {
      return { ok: false, error: `tag "${tag.slice(0, 20)}..." passa de ${MAX_TAG_LEN} caracteres` };
    }
    const key = tag.toLocaleLowerCase('pt-BR');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) return { ok: false, error: `maximo de ${MAX_TAGS} tags por cliente` };
  return { ok: true, value: out };
}

/** União de duas listas de tags com a mesma regra de parseTags. */
function unionTags(a, b) {
  const r = parseTags([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
  // A união nunca deve falhar a mesclagem por limite: corta no teto.
  if (r.ok) return r.value;
  const seen = new Set();
  const out = [];
  for (const t of [...(a || []), ...(b || [])]) {
    const tag = String(t).replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN);
    const key = tag.toLocaleLowerCase('pt-BR');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Preferências: objeto de chaves livres. Chaves conhecidas têm tipo:
 *   tamanho, estilo, observacoes -> texto
 *   numeracao                    -> texto ou número
 *   marcas                       -> lista de textos
 * Valores null removem a chave. Limite de 8 KB serializado.
 */
function parsePreferences(raw) {
  if (raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, error: 'preferences deve ser um objeto' };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    if (!key) continue;
    if (v === null || v === undefined) continue;
    if (key === 'marcas') {
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
        return { ok: false, error: 'preferences.marcas deve ser uma lista de textos' };
      }
      const marcas = [...new Set(v.map(x => x.trim()).filter(Boolean))];
      out.marcas = marcas;
      continue;
    }
    if (['tamanho', 'estilo', 'observacoes'].includes(key) && typeof v !== 'string') {
      return { ok: false, error: `preferences.${key} deve ser texto` };
    }
    if (key === 'numeracao' && typeof v !== 'string' && typeof v !== 'number') {
      return { ok: false, error: 'preferences.numeracao deve ser texto ou numero' };
    }
    out[key] = typeof v === 'string' ? v.trim() : v;
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_PREFS_BYTES) {
    return { ok: false, error: 'preferences muito grande (max 8 KB)' };
  }
  return { ok: true, value: out };
}

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Normaliza a data de uma data importante:
 *   AAAA-MM-DD ou DD/MM/AAAA -> 'AAAA-MM-DD'
 *   MM-DD ou DD/MM           -> 'MM-DD' (data que se repete todo ano, sem ano)
 */
function normalizeImportantDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return y >= 1900 && y <= 2100 && validYmd(y, mo, d) ? s : null;
  }
  if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) {
    const [d, mo, y] = [+m[1], +m[2], +m[3]];
    return y >= 1900 && y <= 2100 && validYmd(y, mo, d) ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
  if ((m = s.match(/^(\d{2})-(\d{2})$/))) {
    return validYmd(2000, +m[1], +m[2]) ? s : null; // 2000 é bissexto: aceita 02-29
  }
  if ((m = s.match(/^(\d{2})\/(\d{2})$/))) {
    return validYmd(2000, +m[2], +m[1]) ? `${m[2]}-${m[1]}` : null;
  }
  return null;
}

function parseImportantDates(raw) {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'important_dates deve ser uma lista' };
  if (raw.length > MAX_DATES) return { ok: false, error: `maximo de ${MAX_DATES} datas importantes` };
  const out = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return { ok: false, error: 'cada data importante deve ser {label, date}' };
    const label = String(item.label == null ? '' : item.label).replace(/\s+/g, ' ').trim();
    if (!label) return { ok: false, error: 'data importante sem label' };
    if (label.length > MAX_DATE_LABEL) {
      return { ok: false, error: `label de data importante passa de ${MAX_DATE_LABEL} caracteres` };
    }
    const date = normalizeImportantDate(item.date);
    if (!date) return { ok: false, error: `data invalida em "${label}" (use AAAA-MM-DD, DD/MM/AAAA ou DD/MM)` };
    out.push({ label, date });
  }
  return { ok: true, value: out };
}

/** União por (label sem caixa, date); a ordem do alvo vem primeiro. */
function unionImportantDates(a, b) {
  const seen = new Set();
  const out = [];
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || !item.label || !item.date) continue;
    const key = `${String(item.label).toLocaleLowerCase('pt-BR')}|${item.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: item.label, date: item.date });
  }
  return out.slice(0, MAX_DATES);
}

module.exports = {
  parseTags,
  unionTags,
  parsePreferences,
  parseImportantDates,
  unionImportantDates,
  normalizeImportantDate,
  MAX_TAGS,
};
