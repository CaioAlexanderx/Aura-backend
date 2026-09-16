// ============================================================
// AURA KARATÊ — Serviço auxiliar (Track A)
// Funções de geração de IDs, status computado de dojô e helpers de import.
// ============================================================
'use strict';

const db = require('../config/database');

// ── Geração do código de filiação do dojô (PREFIXO-NNN) ────────────
// Formato: PREFIXO-NNN  (3 dígitos com zero-padding, ex.: FPKT-014).
//
// ⚠️ 16/09/2026 — O PREFIXO NÃO É MAIS HARDCODED. Até aqui esta função
// devolvia `FPKT-NNN` para QUALQUER federação: ao criar a segunda federação
// (JKA Teste) os 10 dojôs dela nasceram FPKT-001..FPKT-010, com o código de
// uma federação carimbado na outra. Diretriz do Caio: nenhuma identidade de
// federação escrita no código — tudo deriva do registro em `companies`.
//
// Ordem de resolução (a primeira que responder ganha):
//   1. companies.karate_affiliation_prefix (migration 337) — o dado
//      declarado, editável em PUT /federation/:id/settings/identity.
//   2. O prefixo que os PRÓPRIOS dojôs da federação já usam. É o que
//      garante que NADA muda para quem já está numerado: mesmo com a coluna
//      ausente (42703, deploy parcial) ou vazia, a federação incumbente
//      continua FPKT-NNN porque os dojôs dela dizem FPKT.
//   3. Federação nova, sem dojô e sem prefixo: deriva do slug (primeiro
//      segmento) ou das iniciais do nome. Último recurso: 'FED' — genérico
//      de propósito, nunca o nome de uma federação existente.
//
// Estratégia de concorrência: dentro de uma transação já aberta, advisory
// lock por federação + MAX existente, incrementa e retorna.
// Chame DENTRO de um client de transação para garantir atomicidade.

// 'FPKT-014' -> 'FPKT'. Sem o `-NNN` final não há prefixo a extrair.
function affiliationPrefixOf(affiliationId) {
  const m = String(affiliationId || '').match(/^(.+)-\d+$/);
  return m ? m[1] : null;
}

// Normaliza o que veio do banco (ou do slug/nome) num prefixo utilizável:
// maiúsculas, só A-Z/0-9, no máximo 12 caracteres. Devolve null se sobrar
// nada — o caller decide o próximo passo da cadeia.
function normalizeAffiliationPrefix(raw) {
  const clean = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  return clean || null;
}

// Fallback para federação NOVA (sem prefixo declarado e sem nenhum dojô
// numerado). Slug 'jka-teste' -> 'JKA' (primeiro segmento, que é como
// federação se identifica); sem slug, as iniciais do nome
// ('Federação Paulista de Karatê Tradicional' -> 'FPKT').
function derivePrefixFromIdentity({ slug, name }) {
  const fromSlug = normalizeAffiliationPrefix(String(slug || '').split(/[-_]/)[0]);
  if (fromSlug) return fromSlug;

  const initials = String(name || '')
    .split(/\s+/)
    .filter((w) => w.length > 2) // ignora "de", "do", "da", "e"
    .map((w) => w[0])
    .join('');
  return normalizeAffiliationPrefix(initials);
}

// Lê o prefixo declarado da federação. Defensivo a 42703: a coluna nasce na
// migration 337 e o backend sobe antes dela ser aplicada.
async function readDeclaredPrefix(client, federationId) {
  try {
    const { rows } = await client.query(
      `SELECT karate_affiliation_prefix AS prefix, slug, name
         FROM companies WHERE id = $1 LIMIT 1`,
      [federationId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code !== '42703') throw e;
    const { rows } = await client.query(
      `SELECT NULL::text AS prefix, slug, name
         FROM companies WHERE id = $1 LIMIT 1`,
      [federationId]
    );
    return rows[0] || null;
  }
}

// Último código de filiação emitido pela federação (o maior). Serve para
// DUAS coisas: o próximo número e o prefixo já em uso.
async function lastAffiliationId(client, federationId) {
  const { rows } = await client.query(
    `SELECT fpkt_affiliation_id
     FROM companies
     WHERE federation_id = $1 AND vertical = 'karate_dojo'
     ORDER BY fpkt_affiliation_id DESC
     LIMIT 1`,
    [federationId]
  );
  return (rows[0] && rows[0].fpkt_affiliation_id) || null;
}

// O PREFIXO da federação, resolvido pela cadeia descrita acima. Exportada
// porque o gerador (nextDojoAffiliationId) não é o único a montar um código
// de filiação: o import legado em massa (src/routes/karateImport.js) monta o
// dele a partir da coluna "cod" da planilha e tinha o MESMO 'FPKT-' cravado.
// Dois lugares montando o código, um só lugar decidindo o prefixo.
//
// [lastId] é opcional e existe só para não repetir a consulta quando quem
// chama já a fez (cada ida ao banco custa ~190 ms cross-region).
async function resolveAffiliationPrefix(client, federationId, lastId) {
  const ultimo = lastId !== undefined ? lastId : await lastAffiliationId(client, federationId);
  const prefixEmUso = normalizeAffiliationPrefix(affiliationPrefixOf(ultimo));
  const fed = await readDeclaredPrefix(client, federationId);
  return (
    normalizeAffiliationPrefix(fed && fed.prefix) ||
    prefixEmUso ||
    derivePrefixFromIdentity(fed || {}) ||
    'FED'
  );
}

async function nextDojoAffiliationId(client, federationId) {
  // Trava em nível de linha usando advisory lock por federação
  // hashtext(federationId) garante um lock numérico único por UUID
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1::text))`,
    [federationId]
  );

  const ultimo = await lastAffiliationId(client, federationId);

  let nextNum = 1;
  if (ultimo) {
    // Extrai o número do formato PREFIXO-NNN
    const match = ultimo.match(/(\d+)$/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }

  const prefix = await resolveAffiliationPrefix(client, federationId, ultimo);
  return `${prefix}-${String(nextNum).padStart(3, '0')}`;
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
  resolveAffiliationPrefix,
  // Exportados para teste e para quem precise mostrar/validar o prefixo
  // sem duplicar a cadeia de resolução (ver nextDojoAffiliationId).
  affiliationPrefixOf,
  normalizeAffiliationPrefix,
  derivePrefixFromIdentity,
  computeDojoStatus,
  parseCSVLine,
  suggestPractitionerMapping,
  applyMap,
  parseDate,
  PRACTITIONER_FIELDS,
};
