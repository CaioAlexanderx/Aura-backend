// ============================================================
// AURA. — Mesclagem de cadastros de cliente (Fase 1 CRM, migration 341)
//
// POST /companies/:id/customers/:cid/merge/preview  { source_id }
// POST /companies/:id/customers/:cid/merge          { source_id, fields }
//
// :cid é o ALVO (sobrevive); source_id é o cadastro que some. Os dois têm
// que estar nas empresas do dono (src/utils/ownerScope.js).
//
// O QUE A EXECUÇÃO FAZ (uma transação):
//   1. trava os dois cadastros (FOR UPDATE)
//   2. move as referências: UPDATE <tabela> SET <coluna> = alvo WHERE
//      <coluna> = origem, uma tabela por SAVEPOINT:
//        42P01/42703 (tabela/coluna ausente)  -> pulada, segue
//        23505 (unicidade: ex. um aniversário por ano, um perfil de
//              crediário por empresa)            -> linhas ficam na origem e
//                                                   entram em `kept`
//        qualquer outro erro                    -> ROLLBACK de tudo
//   3. crediário (livro por par cliente-empresa): só move se as duas fichas
//      forem da MESMA empresa; senão fica na origem e é registrado
//   4. alvo recebe os campos escolhidos, a união das tags e das datas, a
//      soma de total_purchases/total_spent, a menor primeira compra e a
//      maior última compra; opt-out de marketing de qualquer um vence
//      (customers.marketing_opt_out = OR dos dois e, se existir
//      customer_consent_events — migration 340 —, um evento opt_out novo
//      para o alvo em cada empresa/finalidade onde um dos dois estava com
//      opt-out e o histórico unido terminaria em opt-in)
//   5. origem: merged_into_id = alvo, is_active = false
//   6. nota automática (kind = 'merge') na linha do tempo do alvo
//
// FORA DA MESCLAGEM (decisão): tabelas do karatê (student_id,
// practitioner_id...) — a identidade do praticante tem fluxo próprio com a
// federação, então cadastro de praticante não é mesclado por aqui (409);
// crediario_reconciliacao_309 (foto de auditoria, não referência viva).
// ============================================================
'use strict';

const db = require('../config/database');
const { unionTags, unionImportantDates } = require('./customerProfileFields');

// Referências "do dono": movem sempre.
// Lista levantada de `customer_id`/REFERENCES customers nas migrations.
const OWNER_REFS = [
  { table: 'sales', column: 'customer_id', label: 'vendas' },
  { table: 'coupons', column: 'customer_id', label: 'cupons' },
  { table: 'customer_notes', column: 'customer_id', label: 'notas' },
  { table: 'purchase_reviews', column: 'customer_id', label: 'avaliacoes' },
  { table: 'wa_marketing_log', column: 'customer_id', label: 'envios de marketing' },
  { table: 'birthday_messages_sent', column: 'customer_id', label: 'mensagens de aniversario' },
  // Migration 340 (consentimento por cliente, PR #713). Sem a tabela, é pulada.
  { table: 'customer_consent_events', column: 'customer_id', label: 'eventos de consentimento' },
  { table: 'hub_conversations', column: 'customer_id', label: 'conversas do hub' },
  { table: 'digital_orders', column: 'customer_id', label: 'pedidos online' },
  { table: 'troca_payouts', column: 'customer_id', label: 'devolucoes de troca' },
  { table: 'nfse', column: 'customer_id', label: 'notas de servico' },
  { table: 'service_orders', column: 'customer_id', label: 'ordens de servico' },
  { table: 'optical_prescriptions', column: 'customer_id', label: 'receitas de otica' },
  { table: 'studio_quotes', column: 'customer_id', label: 'orcamentos do studio' },
  { table: 'food_orders', column: 'customer_id', label: 'pedidos food' },
  { table: 'food_reservations', column: 'customer_id', label: 'reservas food' },
  { table: 'barbershop_appointments', column: 'customer_id', label: 'agendamentos barbearia' },
  { table: 'barbershop_cut_history', column: 'customer_id', label: 'historico de cortes' },
  { table: 'barber_loyalty_points', column: 'customer_id', label: 'pontos de fidelidade' },
  { table: 'barber_package_purchases', column: 'customer_id', label: 'pacotes barbearia' },
  { table: 'barber_recurring_appointments', column: 'customer_id', label: 'agendamentos recorrentes' },
  { table: 'barber_subscriber', column: 'customer_id', label: 'assinaturas barbearia' },
  { table: 'dental_patients', column: 'customer_id', label: 'ficha odonto' },
  { table: 'dental_appointments', column: 'customer_id', label: 'consultas odonto' },
  { table: 'dental_automation_log', column: 'customer_id', label: 'automacoes odonto' },
  { table: 'dental_billing_reminders', column: 'customer_id', label: 'lembretes odonto' },
  { table: 'dental_chart_entries', column: 'customer_id', label: 'odontograma' },
  { table: 'dental_checkins', column: 'customer_id', label: 'check-ins odonto' },
  { table: 'dental_consent_documents', column: 'customer_id', label: 'termos odonto' },
  { table: 'dental_documents', column: 'customer_id', label: 'documentos odonto' },
  { table: 'dental_images', column: 'customer_id', label: 'imagens odonto' },
  { table: 'dental_implant_treatments', column: 'customer_id', label: 'tratamentos de implante' },
  { table: 'dental_implants', column: 'customer_id', label: 'implantes' },
  { table: 'dental_lab_orders', column: 'customer_id', label: 'pedidos de laboratorio' },
  { table: 'dental_leads', column: 'customer_id', label: 'leads odonto' },
  { table: 'dental_ortho_sessions', column: 'customer_id', label: 'sessoes de orto' },
  { table: 'dental_ortho_treatments', column: 'customer_id', label: 'tratamentos de orto' },
  { table: 'dental_patient_insurance', column: 'customer_id', label: 'convenios' },
  { table: 'dental_perio_exams', column: 'customer_id', label: 'exames periodontais' },
  { table: 'dental_periodontal_chart', column: 'customer_id', label: 'periodontograma' },
  { table: 'dental_portal_tokens', column: 'customer_id', label: 'acessos ao portal' },
  { table: 'dental_prescriptions', column: 'customer_id', label: 'receitas odonto' },
  { table: 'dental_specialty_forms', column: 'customer_id', label: 'fichas de especialidade' },
  { table: 'dental_tiss_guides', column: 'customer_id', label: 'guias TISS' },
  { table: 'dental_treatment_plans', column: 'customer_id', label: 'planos de tratamento' },
  { table: 'dental_waitlist', column: 'customer_id', label: 'lista de espera odonto' },
  { table: 'dental_ai_conversations', column: 'patient_id', label: 'conversas de IA odonto' },
  { table: 'customers', column: 'parent_guardian_id', label: 'dependentes' },
];

// Livro do crediário: por par cliente-empresa.
const CREDIT_REFS = [
  { table: 'customer_credit_transactions', column: 'customer_id', label: 'lancamentos do crediario' },
  { table: 'credit_installments', column: 'customer_id', label: 'parcelas do crediario' },
  { table: 'credit_accounts', column: 'customer_id', label: 'carnes' },
  { table: 'customer_credit_profiles', column: 'customer_id', label: 'perfil de crediario' },
  { table: 'credit_reschedule_receipts', column: 'customer_id', label: 'recibos de renegociacao' },
  { table: 'credit_lead_contacts', column: 'customer_id', label: 'contatos de credito livre' },
];

// Campos escalares que o usuário escolhe (alvo x origem). Só entram os que
// existem na linha lida do banco.
const CHOOSABLE_FIELDS = [
  'name', 'email', 'phone', 'phone_secondary', 'cpf_cnpj', 'birth_date',
  'instagram_handle', 'notes', 'photo_url',
  'street', 'number', 'address_number', 'complement', 'neighborhood',
  'city', 'state', 'zip_code', 'postal_code',
  'preferences',
];

class MergeError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Date) return false;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function comparable(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return typeof v === 'string' ? v.trim() : v;
}

function plain(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v === undefined ? null : v;
}

function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}

function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

function validateFieldChoices(fields) {
  if (fields === undefined || fields === null) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new MergeError(400, 'fields deve ser um objeto { campo: "target" | "source" }');
  }
  for (const [k, v] of Object.entries(fields)) {
    if (!CHOOSABLE_FIELDS.includes(k)) throw new MergeError(400, `campo nao mesclavel: ${k}`);
    if (v !== 'target' && v !== 'source') throw new MergeError(400, `fields.${k} deve ser "target" ou "source"`);
  }
  return fields;
}

/**
 * Plano dos campos do alvo. PURO.
 * @returns {{ updates: object, conflicts: object[], autoFilled: object[] }}
 */
function planFields(target, source, choices) {
  const updates = {};
  const conflicts = [];
  const autoFilled = [];

  for (const field of CHOOSABLE_FIELDS) {
    if (!(field in target) || !(field in source)) continue;
    const t = target[field];
    const s = source[field];
    const choice = choices[field];

    if (field === 'preferences') {
      const tp = t && typeof t === 'object' ? t : {};
      const sp = s && typeof s === 'object' ? s : {};
      const overlap = Object.keys(tp).filter(k => k in sp && comparable(tp[k]) !== comparable(sp[k]));
      if (overlap.length) {
        conflicts.push({ field, target: tp, source: sp, choice: choice || 'target', keys: overlap });
      }
      const merged = choice === 'source' ? { ...tp, ...sp } : { ...sp, ...tp };
      if (comparable(merged) !== comparable(tp)) updates.preferences = merged;
      continue;
    }

    if (isEmpty(s)) {
      // Escolher explicitamente a origem vazia apaga o campo (nome nunca).
      if (choice === 'source' && !isEmpty(t) && field !== 'name') updates[field] = null;
      continue;
    }
    if (isEmpty(t)) {
      if (choice !== 'target') {
        updates[field] = plain(s);
        autoFilled.push({ field, value: plain(s) });
      }
      continue;
    }
    if (comparable(t) === comparable(s)) continue;
    conflicts.push({ field, target: plain(t), source: plain(s), choice: choice || 'target' });
    if (choice === 'source') updates[field] = plain(s);
  }

  if ('tags' in target && 'tags' in source) {
    const tags = unionTags(target.tags, source.tags);
    if (comparable(tags) !== comparable(target.tags || [])) updates.tags = tags;
  }
  if ('important_dates' in target && 'important_dates' in source) {
    const dates = unionImportantDates(target.important_dates, source.important_dates);
    if (comparable(dates) !== comparable(target.important_dates || [])) updates.important_dates = dates;
  }
  if ('marketing_opt_out' in target && 'marketing_opt_out' in source) {
    const optOut = target.marketing_opt_out === true || source.marketing_opt_out === true;
    if (optOut !== (target.marketing_opt_out === true)) updates.marketing_opt_out = optOut;
  }

  updates.total_purchases = (parseInt(target.total_purchases, 10) || 0) + (parseInt(source.total_purchases, 10) || 0);
  updates.total_spent = Math.round(((parseFloat(target.total_spent) || 0) + (parseFloat(source.total_spent) || 0)) * 100) / 100;
  updates.first_purchase_at = minDate(target.first_purchase_at, source.first_purchase_at);
  updates.last_purchase_at = maxDate(target.last_purchase_at, source.last_purchase_at);

  return { updates, conflicts, autoFilled };
}

function publicCustomer(c) {
  return {
    id: c.id,
    name: c.name,
    company_id: c.company_id,
    company_name: c.company_name || 'Empresa',
    phone: c.phone || null,
    cpf_cnpj: c.cpf_cnpj || null,
    email: c.email || null,
    total_purchases: parseInt(c.total_purchases, 10) || 0,
    total_spent: parseFloat(c.total_spent) || 0,
    is_active: c.is_active !== false,
  };
}

async function loadPair(conn, { ownerCompanyIds, targetId, sourceId, forUpdate }) {
  if (!sourceId) throw new MergeError(400, 'source_id e obrigatorio');
  if (sourceId === targetId) throw new MergeError(400, 'origem e alvo sao o mesmo cliente');
  const { rows } = await conn.query(
    `-- merge:carrega
     SELECT c.*, COALESCE(co.trade_name, co.legal_name) AS company_name
       FROM customers c
       JOIN companies co ON co.id = c.company_id
      WHERE c.id = ANY($1::uuid[]) AND c.company_id = ANY($2)
      ${forUpdate ? 'FOR UPDATE OF c' : ''}`,
    [[targetId, sourceId], ownerCompanyIds]
  );
  const target = rows.find(r => r.id === targetId);
  const source = rows.find(r => r.id === sourceId);
  if (!target) throw new MergeError(404, 'Cliente alvo nao encontrado');
  if (!source) throw new MergeError(404, 'Cliente de origem nao encontrado');
  if (!('merged_into_id' in target)) {
    throw new MergeError(409, 'Mesclagem indisponivel (migration 341 pendente)', 'PROFILE_COLUMNS_MISSING');
  }
  if (source.merged_into_id) throw new MergeError(409, 'Cliente de origem ja foi mesclado', 'ALREADY_MERGED');
  if (target.merged_into_id) throw new MergeError(409, 'Cliente alvo foi mesclado em outro cadastro', 'TARGET_MERGED');
  for (const c of [target, source]) {
    if (c.is_student === true || (c.karate_registration_number && String(c.karate_registration_number).trim())) {
      throw new MergeError(409, 'Cadastro de praticante de karate nao pode ser mesclado por aqui', 'KARATE_IDENTITY');
    }
  }
  return { target, source };
}

function isSkippable(e) {
  return e && (e.code === '42P01' || e.code === '42703');
}

async function countRefs(conn, ref, sourceId) {
  const { rows } = await conn.query(
    `-- merge:conta ${ref.table}
     SELECT COUNT(*)::int AS n FROM ${ref.table} WHERE ${ref.column} = $1`,
    [sourceId]
  );
  return parseInt(rows[0] && rows[0].n, 10) || 0;
}

/** Dry-run: nada é escrito. */
async function previewMerge({ ownerCompanyIds, targetId, sourceId, fields }) {
  const choices = validateFieldChoices(fields);
  const { target, source } = await loadPair(db, { ownerCompanyIds, targetId, sourceId, forUpdate: false });
  const sameCompany = target.company_id === source.company_id;

  const moves = [];
  const kept = [];
  const skippedTables = [];
  for (const ref of [...OWNER_REFS, ...CREDIT_REFS]) {
    let rows;
    try {
      rows = await countRefs(db, ref, source.id);
    } catch (e) {
      if (isSkippable(e)) { skippedTables.push(ref.table); continue; }
      throw e;
    }
    if (!rows) continue;
    const isCredit = CREDIT_REFS.includes(ref);
    if (isCredit && !sameCompany) {
      kept.push({ table: ref.table, label: ref.label, rows, reason: 'crediario_de_outra_empresa' });
    } else {
      moves.push({ table: ref.table, label: ref.label, rows });
    }
  }

  const { updates, conflicts, autoFilled } = planFields(target, source, choices);
  const warnings = [];
  if (kept.some(k => k.reason === 'crediario_de_outra_empresa')) {
    warnings.push('O crediario do cadastro de origem e de outra empresa e continua nele; confira o saldo antes de mesclar.');
  }

  return {
    target: publicCustomer(target),
    source: publicCustomer(source),
    same_company: sameCompany,
    moves,
    kept,
    skipped_tables: skippedTables,
    conflicts,
    auto_filled: autoFilled,
    warnings,
    result: {
      tags: updates.tags || target.tags || [],
      total_purchases: updates.total_purchases,
      total_spent: updates.total_spent,
      first_purchase_at: updates.first_purchase_at || null,
      last_purchase_at: updates.last_purchase_at || null,
      marketing_opt_out: 'marketing_opt_out' in updates ? updates.marketing_opt_out : (target.marketing_opt_out === true),
    },
  };
}

const JSONB_COLS = new Set(['preferences', 'important_dates']);

function buildTargetUpdate(targetId, updates) {
  const values = [];
  const sets = Object.entries(updates).map(([col, val]) => {
    if (JSONB_COLS.has(col)) {
      values.push(JSON.stringify(val));
      return `${col} = $${values.length}::jsonb`;
    }
    if (col === 'tags') {
      values.push(val);
      return `${col} = $${values.length}::text[]`;
    }
    values.push(val);
    return `${col} = $${values.length}`;
  });
  sets.push('updated_at = NOW()');
  values.push(targetId);
  return {
    sql: `-- merge:alvo
     UPDATE customers SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values,
  };
}

function describeNote(source, moved, kept, userName) {
  const parts = [`Cadastro "${source.name}" mesclado neste cliente${userName ? ` por ${userName}` : ''}.`];
  if (moved.length) parts.push(`Movido: ${moved.map(m => `${m.rows} ${m.label}`).join(', ')}.`);
  if (kept.length) parts.push(`Ficou no cadastro antigo: ${kept.map(k => `${k.rows} ${k.label}`).join(', ')}.`);
  const docs = [source.phone && `tel. ${source.phone}`, source.cpf_cnpj && `doc. ${source.cpf_cnpj}`, source.email]
    .filter(Boolean);
  if (docs.length) parts.push(`Dados do cadastro antigo: ${docs.join(', ')}.`);
  return parts.join(' ').slice(0, 5000);
}

/**
 * Tenta um UPDATE dentro de SAVEPOINT. Devolve { status, rows }.
 * status: 'moved' | 'skipped' | 'conflict'
 */
async function moveRef(client, ref, targetId, sourceId) {
  await client.query('SAVEPOINT merge_ref');
  try {
    const r = await client.query(
      `-- merge:move ${ref.table}
       UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = $2`,
      [targetId, sourceId]
    );
    await client.query('RELEASE SAVEPOINT merge_ref');
    return { status: 'moved', rows: r.rowCount || 0 };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT merge_ref');
    await client.query('RELEASE SAVEPOINT merge_ref');
    if (isSkippable(e)) return { status: 'skipped', rows: 0 };
    if (e.code === '23505') {
      let rows = 0;
      try { rows = await countRefs(client, ref, sourceId); } catch (_) { rows = 0; }
      return { status: 'conflict', rows };
    }
    throw e;
  }
}

async function countRefSafe(client, ref, sourceId) {
  await client.query('SAVEPOINT merge_ref');
  try {
    const n = await countRefs(client, ref, sourceId);
    await client.query('RELEASE SAVEPOINT merge_ref');
    return n;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT merge_ref');
    await client.query('RELEASE SAVEPOINT merge_ref');
    if (isSkippable(e)) return null;
    throw e;
  }
}

/** Query num SAVEPOINT; tabela/coluna ausente -> null. */
async function optionalQuery(client, sql, params) {
  await client.query('SAVEPOINT merge_opt');
  try {
    const r = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT merge_opt');
    return r;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT merge_opt');
    await client.query('RELEASE SAVEPOINT merge_opt');
    if (isSkippable(e)) return null;
    throw e;
  }
}

// Estado atual do consentimento = evento mais recente por empresa e
// finalidade (regra da migration 340).
const CONSENT_STATE_SQL = `
     SELECT DISTINCT ON (customer_id, company_id, purpose)
            customer_id, company_id, purpose, action
       FROM customer_consent_events
      WHERE customer_id = ANY($1::uuid[])
      ORDER BY customer_id, company_id, purpose, created_at DESC, id DESC`;

async function readConsentOptOuts(client, ids) {
  const r = await optionalQuery(client, `-- merge:consentimento-antes${CONSENT_STATE_SQL}`, [ids]);
  if (!r) return null;
  const keys = new Map();
  for (const row of r.rows) {
    if (row.action === 'opt_out') keys.set(`${row.company_id}|${row.purpose}`, row);
  }
  return keys;
}

async function enforceConsentOptOut(client, target, optOuts, user) {
  if (!optOuts || !optOuts.size) return 0;
  const r = await optionalQuery(client, `-- merge:consentimento-depois${CONSENT_STATE_SQL}`, [[target.id]]);
  if (!r) return 0;
  const current = new Map(r.rows.map(row => [`${row.company_id}|${row.purpose}`, row.action]));
  let inserted = 0;
  for (const [key, row] of optOuts) {
    if (current.get(key) === 'opt_out') continue;
    await client.query(
      `-- merge:consentimento-optout
       INSERT INTO customer_consent_events
         (company_id, customer_id, phone, action, channel, purpose, consent_text, collected_by)
       VALUES ($1, $2, $3, 'opt_out', 'manual', $4, $5, $6)`,
      [row.company_id, target.id, target.phone_e164 || null, row.purpose,
        'Mesclagem de cadastros: o opt-out de um dos cadastros prevalece.', (user && user.id) || null]
    );
    inserted++;
  }
  return inserted;
}

async function executeMerge({ ownerCompanyIds, targetId, sourceId, fields, user }) {
  const choices = validateFieldChoices(fields);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { target, source } = await loadPair(client, { ownerCompanyIds, targetId, sourceId, forUpdate: true });
    const sameCompany = target.company_id === source.company_id;
    const consentOptOuts = await readConsentOptOuts(client, [target.id, source.id]);

    const moved = [];
    const kept = [];
    const skippedTables = [];

    for (const ref of OWNER_REFS) {
      const r = await moveRef(client, ref, target.id, source.id);
      if (r.status === 'skipped') skippedTables.push(ref.table);
      else if (r.status === 'conflict') {
        if (r.rows) kept.push({ table: ref.table, label: ref.label, rows: r.rows, reason: 'conflito_de_unicidade' });
      } else if (r.rows) moved.push({ table: ref.table, label: ref.label, rows: r.rows });
    }

    for (const ref of CREDIT_REFS) {
      if (sameCompany) {
        const r = await moveRef(client, ref, target.id, source.id);
        if (r.status === 'skipped') skippedTables.push(ref.table);
        else if (r.status === 'conflict') {
          if (r.rows) kept.push({ table: ref.table, label: ref.label, rows: r.rows, reason: 'conflito_de_unicidade' });
        } else if (r.rows) moved.push({ table: ref.table, label: ref.label, rows: r.rows });
      } else {
        const n = await countRefSafe(client, ref, source.id);
        if (n === null) skippedTables.push(ref.table);
        else if (n) kept.push({ table: ref.table, label: ref.label, rows: n, reason: 'crediario_de_outra_empresa' });
      }
    }

    const consentOptOutsAdded = await enforceConsentOptOut(client, target, consentOptOuts, user);

    const { updates, conflicts } = planFields(target, source, choices);
    const upd = buildTargetUpdate(target.id, updates);
    const { rows: [updatedTarget] } = await client.query(upd.sql, upd.values);

    await client.query(
      `-- merge:origem
       UPDATE customers SET merged_into_id = $1, is_active = false, updated_at = NOW() WHERE id = $2`,
      [target.id, source.id]
    );

    const { rows: [note] } = await client.query(
      `-- merge:nota
       INSERT INTO customer_notes (company_id, customer_id, author_id, kind, body)
       VALUES ($1, $2, $3, 'merge', $4)
       RETURNING id`,
      [target.company_id, target.id, (user && user.id) || null,
        describeNote(source, moved, kept, user && (user.full_name || user.name))]
    );

    await client.query('COMMIT');
    return {
      merged: true,
      target: updatedTarget,
      source_id: source.id,
      moved,
      kept,
      skipped_tables: skippedTables,
      conflicts_resolved: conflicts,
      consent_opt_outs_added: consentOptOutsAdded,
      note_id: note ? note.id : null,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão já perdida */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  OWNER_REFS,
  CREDIT_REFS,
  CHOOSABLE_FIELDS,
  MergeError,
  planFields,
  validateFieldChoices,
  previewMerge,
  executeMerge,
  buildTargetUpdate,
};
