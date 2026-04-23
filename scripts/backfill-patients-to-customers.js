// ============================================================
// AURA. — D-UNIFY: Backfill dental_patients -> customers
//
// Executar APOS aplicar migration 050_unify_customers_patients.sql
//
// Uso:
//   node scripts/backfill-patients-to-customers.js --dry-run   # default, so simula
//   node scripts/backfill-patients-to-customers.js --apply     # aplica de fato
//   node scripts/backfill-patients-to-customers.js --apply --company=<uuid>  # so uma empresa
//
// Matching (por company_id):
//   1. CPF exato (so digitos)
//   2. Telefone exato (ultimos 10 digitos)
//   3. Email (lowercase, trim)
//
// Merge rules (quando acha match):
//   - Campos clinicos (allergies, medical_history, medications, insurance_*):
//     sobrescreve do dental_patient (fonte de verdade clinica)
//   - gender, birth_date: prioriza customers existente se nao-null; senao do dental
//   - name: mantem customers.name (nao sobrescreve)
//   - is_patient: sempre true
//   - lgpd_consent: OR dos dois (true se qualquer um tiver)
//   - cpf_cnpj: se customers.cpf_cnpj for null, popula do dental_patient.cpf
//
// Quando NAO acha match: cria novo customer com dados do dental_patient.
// Idempotencia: skip se ja tem mapping (dental_patients_migration_map).
// ============================================================

const db = require('../src/config/database');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const COMPANY_FILTER = (args.find(a => a.startsWith('--company=')) || '').split('=')[1] || null;

function log(...m)  { console.log('[backfill]', ...m); }
function warn(...m) { console.warn('[backfill][WARN]', ...m); }
function err(...m)  { console.error('[backfill][ERROR]', ...m); }

// ── Normalizadores ──────────────────────────────────────
function normCpf(v)   { return v ? String(v).replace(/\D/g, '') : ''; }
function normPhone(v) { const d = v ? String(v).replace(/\D/g, '') : ''; return d.slice(-10); }
function normEmail(v) { return v ? String(v).trim().toLowerCase() : ''; }

// ── Match logic ─────────────────────────────────────────
async function findMatch(client, companyId, patient) {
  // Prioridade: CPF > phone > email
  const cpf   = normCpf(patient.cpf);
  const phone = normPhone(patient.phone);
  const email = normEmail(patient.email);

  if (cpf) {
    const { rows } = await client.query(
      `SELECT * FROM customers
       WHERE company_id = $1 AND regexp_replace(COALESCE(cpf_cnpj,''), '\\D', '', 'g') = $2
       LIMIT 1`,
      [companyId, cpf]
    );
    if (rows.length) return { match: rows[0], by: 'cpf' };
  }

  if (phone) {
    const { rows } = await client.query(
      `SELECT * FROM customers
       WHERE company_id = $1
         AND right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = $2
       LIMIT 1`,
      [companyId, phone]
    );
    if (rows.length) return { match: rows[0], by: 'phone' };
  }

  if (email) {
    const { rows } = await client.query(
      `SELECT * FROM customers
       WHERE company_id = $1 AND lower(trim(COALESCE(email,''))) = $2
       LIMIT 1`,
      [companyId, email]
    );
    if (rows.length) return { match: rows[0], by: 'email' };
  }

  return null;
}

// ── Merge existing customer with dental_patient data ────
async function mergeIntoCustomer(client, customer, patient) {
  const sets = [];
  const vals = [];
  let idx = 1;

  // Campos clinicos — sempre do paciente (fonte de verdade)
  const clinical = ['allergies', 'medical_history', 'medications',
                    'insurance_name', 'insurance_card', 'insurance_plan', 'insurance_exp'];
  for (const f of clinical) {
    if (patient[f] != null && patient[f] !== '') {
      sets.push(`${f} = $${idx++}`);
      vals.push(patient[f]);
    }
  }

  // gender / birth_date: so se customers estava vazio
  if (!customer.gender     && patient.gender)     { sets.push(`gender = $${idx++}`);     vals.push(patient.gender); }
  if (!customer.birth_date && patient.birth_date) { sets.push(`birth_date = $${idx++}`); vals.push(patient.birth_date); }
  if (!customer.cpf_cnpj   && patient.cpf)        { sets.push(`cpf_cnpj = $${idx++}`);   vals.push(patient.cpf); }
  if (!customer.phone      && patient.phone)      { sets.push(`phone = $${idx++}`);      vals.push(patient.phone); }
  if (!customer.email      && patient.email)      { sets.push(`email = $${idx++}`);      vals.push(patient.email); }

  // Flags
  sets.push(`is_patient = true`);

  // LGPD: OR dos dois
  const consent = customer.lgpd_consent || patient.lgpd_consent;
  if (consent && !customer.lgpd_consent) {
    sets.push(`lgpd_consent = true`);
    sets.push(`lgpd_consent_at = $${idx++}`);
    vals.push(patient.lgpd_consent_at || new Date());
  }

  sets.push(`updated_at = NOW()`);
  vals.push(customer.id);

  if (sets.length === 1) return customer.id;  // nada a atualizar alem de is_patient

  if (!DRY_RUN) {
    await client.query(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = $${idx}`,
      vals
    );
  }
  return customer.id;
}

// ── Create new customer from dental_patient ─────────────
async function createCustomerFromPatient(client, companyId, patient) {
  if (!patient.lgpd_consent) {
    warn(`Paciente ${patient.id} (${patient.full_name}) sem lgpd_consent — criado mesmo assim mas marque consent no primeiro uso.`);
  }

  if (DRY_RUN) return '<DRY-RUN-NEW-UUID>';

  const { rows } = await client.query(
    `INSERT INTO customers (
       company_id, name, cpf_cnpj, email, phone, birth_date,
       gender, allergies, medical_history, medications,
       insurance_name, insurance_card, insurance_plan, insurance_exp,
       notes, is_patient, lgpd_consent, lgpd_consent_at, is_active
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13, $14,
       $15, true, $16, $17, $18
     ) RETURNING id`,
    [
      companyId,
      patient.full_name,
      patient.cpf || null,
      patient.email || null,
      patient.phone || null,
      patient.birth_date || null,
      patient.gender || null,
      patient.allergies || null,
      patient.medical_history || null,
      patient.medications || null,
      patient.insurance_name || null,
      patient.insurance_card || null,
      patient.insurance_plan || null,
      patient.insurance_exp || null,
      patient.notes || null,
      !!patient.lgpd_consent,
      patient.lgpd_consent_at || null,
      patient.is_active !== false,
    ]
  );
  return rows[0].id;
}

// ── Update FKs nas tabelas dental_* ─────────────────────
async function updateDentalFKs(client, patientId, customerId) {
  const tables = [
    'dental_appointments',
    'dental_chart_entries',
    'dental_prescriptions',
    'dental_treatment_plans',
  ];
  const counts = {};
  for (const t of tables) {
    if (DRY_RUN) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${t} WHERE patient_id = $1 AND customer_id IS NULL`,
        [patientId]
      );
      counts[t] = rows[0].n;
    } else {
      const r = await client.query(
        `UPDATE ${t} SET customer_id = $1 WHERE patient_id = $2 AND customer_id IS NULL`,
        [customerId, patientId]
      );
      counts[t] = r.rowCount;
    }
  }
  return counts;
}

// ── Processar uma empresa ───────────────────────────────
async function processCompany(companyId) {
  const client = await db.connect();
  const stats = { patients: 0, merged: 0, created: 0, skipped: 0, fks: {} };

  try {
    await client.query('BEGIN');

    const { rows: patients } = await client.query(
      'SELECT * FROM dental_patients WHERE company_id = $1 AND is_active = true ORDER BY created_at ASC',
      [companyId]
    );

    stats.patients = patients.length;
    if (!patients.length) {
      await client.query('COMMIT');
      return stats;
    }

    log(`Empresa ${companyId}: ${patients.length} paciente(s) a processar`);

    for (const p of patients) {
      // Idempotencia: se ja existe customer com mesma empresa, lgpd_consent e is_patient
      // e algum appointment ja tem customer_id, assume que foi migrado
      const { rows: existingFks } = await client.query(
        `SELECT DISTINCT customer_id FROM dental_appointments
         WHERE patient_id = $1 AND customer_id IS NOT NULL LIMIT 1`,
        [p.id]
      );
      if (existingFks.length) {
        stats.skipped++;
        log(`  [skip] paciente ${p.full_name} ja migrado (customer=${existingFks[0].customer_id})`);
        continue;
      }

      const matchRes = await findMatch(client, companyId, p);
      let customerId;

      if (matchRes) {
        customerId = await mergeIntoCustomer(client, matchRes.match, p);
        stats.merged++;
        log(`  [merge:${matchRes.by}] ${p.full_name} -> customer ${customerId}`);
      } else {
        customerId = await createCustomerFromPatient(client, companyId, p);
        stats.created++;
        log(`  [new] ${p.full_name} -> customer ${customerId}`);
      }

      const fkCounts = await updateDentalFKs(client, p.id, customerId);
      for (const [t, n] of Object.entries(fkCounts)) {
        stats.fks[t] = (stats.fks[t] || 0) + n;
      }
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      log(`Empresa ${companyId}: DRY-RUN — rollback aplicado`);
    } else {
      await client.query('COMMIT');
      log(`Empresa ${companyId}: COMMIT`);
    }
  } catch (e) {
    await client.query('ROLLBACK');
    err(`Empresa ${companyId} falhou: ${e.message}`);
    throw e;
  } finally {
    client.release();
  }

  return stats;
}

// ── Main ────────────────────────────────────────────────
async function main() {
  log(DRY_RUN ? '=== DRY-RUN (nada sera escrito) ===' : '=== APPLY (dados serao modificados) ===');
  if (COMPANY_FILTER) log(`Filtro: company_id = ${COMPANY_FILTER}`);

  const { rows: companies } = COMPANY_FILTER
    ? await db.query('SELECT id, legal_name FROM companies WHERE id = $1', [COMPANY_FILTER])
    : await db.query(`SELECT DISTINCT c.id, c.legal_name
                       FROM companies c
                       JOIN dental_patients dp ON dp.company_id = c.id
                       ORDER BY c.legal_name`);

  log(`${companies.length} empresa(s) com pacientes odonto`);

  const totals = { patients: 0, merged: 0, created: 0, skipped: 0, fks: {} };
  for (const c of companies) {
    try {
      log(`\n--- ${c.legal_name} (${c.id}) ---`);
      const s = await processCompany(c.id);
      totals.patients += s.patients;
      totals.merged   += s.merged;
      totals.created  += s.created;
      totals.skipped  += s.skipped;
      for (const [t, n] of Object.entries(s.fks)) totals.fks[t] = (totals.fks[t] || 0) + n;
    } catch (e) {
      err(`  ^ continuando com proxima empresa`);
    }
  }

  log('\n=== RESUMO ===');
  log(`Pacientes processados: ${totals.patients}`);
  log(`  merged (match encontrado): ${totals.merged}`);
  log(`  created (novo customer):   ${totals.created}`);
  log(`  skipped (ja migrado):      ${totals.skipped}`);
  log('FKs atualizadas:');
  for (const [t, n] of Object.entries(totals.fks)) log(`  ${t}: ${n}`);
  if (DRY_RUN) log('\nNenhuma alteracao aplicada (dry-run). Rode com --apply para persistir.');

  await db.end?.();
  process.exit(0);
}

main().catch(e => { err(e); process.exit(1); });
