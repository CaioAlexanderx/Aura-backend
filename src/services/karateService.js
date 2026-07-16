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

// (14/07/2026 — H2) nextPractitionerRegistrationNumber FOI REMOVIDA daqui.
// Regra fechada com o Caio: o número de matrícula FPKT é emitido SOMENTE
// pela federação, fora do sistema — o backend NUNCA gera/inventa um
// (migration 231 / H1). Os 3 chamadores que ainda existiam foram todos
// fechados no mesmo PR (#381):
//   1) karateRosterPortalPublic.js (quick-add do portal do sensei) — agora
//      cria uma SOLICITAÇÃO pendente (karate_practitioner_requests), igual
//      ao fluxo novo do sensei — nunca mais insere direto em customers.
//   2) karateImport.js (import legado em massa) — o número agora é
//      OBRIGATÓRIO na própria planilha (PRACTITIONER_FIELDS.registration_number);
//      linha sem número vai para o relatório de erro, nunca ganha um
//      inventado.
//   3) karateApplyEvent.js (upsertPractitioner, sync dojô↔federação) — o
//      contrato do evento practitioner_added nunca carregou número FPKT;
//      criação nova (sem match por CPF) agora falha explicitamente
//      (recoverable=false) em vez de inventar.
// Se um dia surgir um caso legítimo de geração automática, ele PRECISA
// vir com essa mesma decisão de produto revisada — não reintroduza esta
// função "de leve" só porque um novo fluxo parece pedir um número.

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
  // Número de matrícula FPKT — SEMPRE emitido pela federação, fora do
  // sistema (regra H1, migration 231). O import legado (CSV) só aceita a
  // linha se ela já TRAZ esse número na planilha de origem; nunca inventa
  // um (ver karateImport.js handler / validateRow).
  registration_number: ['matricula', 'matrícula', 'registro', 'numero fpkt', 'número fpkt',
                         'num_fpkt', 'nº fpkt', 'fpkt', 'registration_number', 'karate_registration_number'],
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
  computeDojoStatus,
  parseCSVLine,
  suggestPractitionerMapping,
  applyMap,
  parseDate,
  PRACTITIONER_FIELDS,
};
