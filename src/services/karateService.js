// ============================================================
// AURA KARATÊ — Serviço auxiliar (Track A)
// Funções de geração de IDs, status computado de dojô e helpers de import.
// ============================================================
'use strict';

const db = require('../config/database');

// ── Geração de FPKT-NNN (dojô) ─────────────────────────────
// Formato: FPKT-NNN  (3 dígitos com zero-padding, ex: FPKT-014)
// Estratégia: dentro de uma transação já aberta, faz SELECT FOR UPDATE no MAX
// existente para a federação, incrementa e retorna.
// Chame DENTRO de um client de transação para garantir atomicidade.
async function nextDojoAffiliationId(client, federationId) {
  // Trava em nível de linha usando advisory lock por federação
  // hashtext(federationId) garante um lock numérico único por UUID
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1::text))`,
    [federationId]
  );

  const { rows } = await client.query(
    `SELECT fpkt_affiliation_id
     FROM companies
     WHERE federation_id = $1 AND vertical = 'karate_dojo'
     ORDER BY fpkt_affiliation_id DESC
     LIMIT 1`,
    [federationId]
  );

  let nextNum = 1;
  if (rows.length > 0 && rows[0].fpkt_affiliation_id) {
    // Extrai o número do formato FPKT-NNN
    const match = rows[0].fpkt_affiliation_id.match(/(\d+)$/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }

  return `FPKT-${String(nextNum).padStart(3, '0')}`;
}

// ── Geração do Nº de registro do praticante (NNNNN-D) ──────
// Formato: <N>-D, continuando a maior numeração já existente na federação.
//
// Os dados reais da FPKT usam o padrão NNNNN-D (kyu) e variações por Dan nos
// faixas-pretas (NNN-Y-SHO, -Y-NI, -Y-SAN). Para gerar o próximo número de um
// praticante NOVO, pegamos o MAIOR PREFIXO NUMÉRICO entre TODOS os registros
// da federação (independente do sufixo) e incrementamos, formatando como
// "<N>-D" — o padrão dominante.
//
// (Decisão Caio 22/06.) O gerador antigo "FPKT-A-NNNNN" foi substituído porque
// o regex /(\d+)$/ não casava com os importados (terminam em letra) e cairia
// em colisão a partir de 00001.
//
// advisory lock por federação garante atomicidade sob concorrência.
async function nextPractitionerRegistrationNumber(client, federationId) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1::text || '-practitioner'))`,
    [federationId]
  );

  // Extrai os dígitos iniciais de cada karate_registration_number e pega o MAX.
  // regexp_replace(x, '\D.*$', '') → mantém só o prefixo numérico ("21758-D" → "21758").
  // Filtra para registros que começam com dígito (ignora formatos legados não-numéricos).
  const { rows } = await client.query(
    `SELECT COALESCE(
              MAX(NULLIF(regexp_replace(karate_registration_number, '\\D.*$', ''), '')::bigint),
              0
            ) AS maxnum
       FROM customers
      WHERE federation_id = $1
        AND karate_registration_number ~ '^[0-9]'`,
    [federationId]
  );

  // Defensivo: em testes o DB é mockado e pode devolver { rows: [] } (sem a
  // linha do agregado). Em Postgres real MAX retorna sempre 1 linha (maxnum=0
  // quando vazio, pelo COALESCE), então prod nunca cai no fallback.
  const next = (parseInt(rows?.[0]?.maxnum, 10) || 0) + 1;
  return `${next}-D`;
}

// ── Status computado do dojô ────────────────────────────────
// Decisão de produto (02/07/2026): status do dojô é derivado UNICAMENTE de
// is_active. Antes esta função misturava inadimplência (dias de atraso da
// afiliação) com o status de ativação, retornando 'suspended' tanto para
// is_active=false quanto para atraso > 180 dias — os dois conceitos são
// independentes. Inadimplência de anuidade é métrica separada, calculada a
// partir de karate_dojo_annuity_history (ver karateFinanceService.computeAnnuityStatus
// e a query de annuity_status em routes/karateFederation.js) — NÃO tocada aqui.
//
// Valores possíveis: 'active' | 'inactive'.
//   active   → is_active !== false
//   inactive → is_active === false
function computeDojoStatus(affiliation_model, affiliation_since, is_active) {
  if (is_active === false) return 'inactive';
  return 'active';
}

// ── Parser de linha CSV simples ─────────────────────────────
// Suporta campos entre aspas com vírgula interna.
// Uso: parseCSVLine(line) → string[]
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── Mapeamento fuzzy de cabeçalhos CSV para campos do praticante ─
const PRACTITIONER_FIELDS = {
  full_name:    ['nome', 'name', 'nome completo', 'full_name'],
  cpf:          ['cpf', 'documento', 'doc'],
  rg:           ['rg', 'identidade'],
  birth_date:   ['nascimento', 'data nascimento', 'data_nascimento', 'birthday', 'birth_date'],
  email:        ['email', 'e-mail'],
  phone:        ['telefone', 'phone', 'fone', 'celular'],
  dojo_id:      ['dojo_id', 'dojo id', 'dojo'],
  belt_level:   ['faixa', 'belt_level', 'belt level', 'faixa atual', 'grau'],
  belt_name:    ['nome faixa', 'belt_name', 'belt name', 'cor faixa'],
  graduated_at: ['data graduacao', 'data_graduacao', 'graduated_at', 'data graduação'],
  is_arbiter:   ['arbitro', 'árbitro', 'is_arbiter'],
  is_instructor:['instrutor', 'is_instructor'],
  is_examiner:  ['examinador', 'is_examiner'],
};

function suggestPractitionerMapping(headers) {
  const map = {};
  for (const header of headers) {
    const normalized = header.toLowerCase().trim()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const [field, aliases] of Object.entries(PRACTITIONER_FIELDS)) {
      if (aliases.some(a => {
        const aN = a.normalize('NFD').replace(/[̀-ͯ]/g, '');
        return normalized === aN || normalized.includes(aN);
      })) {
        if (!map[header]) map[header] = field;
      }
    }
  }
  return map;
}

function applyMap(row, columnMap) {
  const mapped = {};
  for (const [header, field] of Object.entries(columnMap)) {
    if (field && row[header] !== undefined) {
      mapped[field] = String(row[header] || '').trim();
    }
  }
  return mapped;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${m}-${d}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [d, m, y] = s.split('-');
    return `${y}-${m}-${d}`;
  }
  return null;
}

module.exports = {
  nextDojoAffiliationId,
  nextPractitionerRegistrationNumber,
  computeDojoStatus,
  parseCSVLine,
  suggestPractitionerMapping,
  applyMap,
  parseDate,
  PRACTITIONER_FIELDS,
};
