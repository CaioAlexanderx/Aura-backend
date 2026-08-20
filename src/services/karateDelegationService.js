// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: DELEGAÇÃO (o clube inscreve)
//
// O ato que os regulamentos descrevem e o sistema não tinha: o DOJÔ
// consolida sua delegação (atletas em categorias individuais + equipes
// com roster), vê a cotação composta (taxa única por atleta, equipes por
// prova, isenções por contrapartida) e submete UM pedido — que vira UMA
// cobrança (PIX direto) ou UMA conferência de comprovante (manual).
// Substitui a planilha + depósito + e-mail do fluxo real.
//
// ── PADRÕES DA CASA APLICADOS ───────────────────────────────
//  • Âncora do aluno: karate_dojo_students escopado pelo dojo_id do TOKEN
//    (mesmo padrão de karateDojoFederativeService) — aluno de outro dojô
//    não resolve e vira skip ALUNO_NAO_ENCONTRADO; sem practitioner_id é
//    skip ALUNO_NAO_FEDERADO (competição é ato federativo).
//  • Validação PURA antes do BEGIN (padrão F8.1/planResults): dentro da
//    transação só entram escritas que não falham por regra de negócio.
//  • Skips circunstanciais POR ITEM (padrão F5b): JA_INSCRITO /
//    ALUNO_NAO_FEDERADO / ALUNO_NAO_ENCONTRADO não derrubam o carrinho.
//  • COTA por clube (rules da divisão) BLOQUEIA (422 QUOTA_EXCEEDED, com
//    detalhe por categoria): é limite regulamentar, o dojô decide quem
//    fica — submeter além da cota inscreveria alguém que a federação
//    terá de cortar na mão.
//  • Compatibilidade de categoria: SEMPRE só aviso (FPKT #1) — reusa
//    checkCategoryFit.
//  • Âncoras de SQL `-- p0d:` para os testes despacharem por regex.
//
// ── STATUS DO PEDIDO ────────────────────────────────────────
//  total = 0            → 'paid' (nada a pagar; confirmado na criação)
//  pix_direct           → 'awaiting_payment' (webhook confirma → PR da
//                          fila de conferência liga a cascata)
//  manual               → 'awaiting_payment' até o upload do comprovante
//                          (rota da fila de conferência, PR seguinte)
// ============================================================
'use strict';

const db = require('../config/database');
const { checkCategoryFit } = require('./karateCompetitionService');
const { quoteDelegation, checkClubQuotas } = require('./karateCompetitionPricingService');

const MAX_ATHLETES = 200;
const MAX_TEAMS = 40;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

function serviceError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.isServiceError = true;
  if (extra) Object.assign(e, extra);
  return e;
}

// ── Leituras ────────────────────────────────────────────────

// Competições abertas da federação — a vitrine do dojô. Divisões vêm
// juntas (42P01-safe: migration 294 pendente → sem divisões, lista segue).
async function listOpenCompetitions(federationId) {
  const { rows } = await db.query(
    `-- p0d:list-open-competitions
     SELECT c.id, c.name, c.season, c.event_date, c.location, c.status,
            c.fee_amount, c.pricing_config, c.rectification_deadline
       FROM karate_competitions c
      WHERE c.federation_id = $1 AND c.status = 'open'
      ORDER BY c.event_date ASC NULLS LAST`,
    [federationId]
  ).catch((e) => {
    if (e.code === '42703') {
      // pricing_config/rectification_deadline ausentes (294 pendente)
      return db.query(
        `SELECT c.id, c.name, c.season, c.event_date, c.location, c.status, c.fee_amount
           FROM karate_competitions c
          WHERE c.federation_id = $1 AND c.status = 'open'
          ORDER BY c.event_date ASC NULLS LAST`,
        [federationId]
      );
    }
    throw e;
  });

  let divisions = [];
  try {
    const d = await db.query(
      `-- p0d:list-divisions
       SELECT id, competition_id, name, sort_order, rules
         FROM karate_competition_divisions
        WHERE competition_id = ANY($1::uuid[])
        ORDER BY sort_order ASC, name ASC`,
      [rows.map((r) => r.id)]
    );
    divisions = d.rows;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    season: c.season,
    event_date: c.event_date,
    location: c.location || null,
    fee_amount: c.fee_amount != null ? Number(c.fee_amount) : null,
    has_pricing: !!(c.pricing_config && Object.keys(c.pricing_config).length),
    rectification_deadline: c.rectification_deadline || null,
    divisions: divisions.filter((d) => d.competition_id === c.id)
      .map((d) => ({ id: d.id, name: d.name, rules: d.rules || {} })),
  }));
}

async function loadCompetition(federationId, competitionId) {
  if (!isUuid(competitionId)) return null;
  const { rows } = await db.query(
    `-- p0d:load-competition
     SELECT id, federation_id, name, status, event_date, fee_amount, pricing_config
       FROM karate_competitions
      WHERE id = $1 AND federation_id = $2
      LIMIT 1`,
    [competitionId, federationId]
  ).catch((e) => {
    if (e.code === '42703') {
      return db.query(
        `SELECT id, federation_id, name, status, event_date, fee_amount
           FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
        [competitionId, federationId]
      );
    }
    throw e;
  });
  return rows[0] || null;
}

// Categorias da competição para o seletor do dojô (com divisão/grupo).
async function listCategoriesForEnrollment(competitionId) {
  const sql = (withDivision) => `
     SELECT cat.id, cat.name, cat.modality, cat.min_age, cat.max_age,
            cat.belt_min, cat.belt_max, cat.sex, cat.weight_class,
            cat.max_entries, cat.fee_amount${withDivision ? ', cat.division_id, cat.group_label' : ''},
            COUNT(e.id)::int AS entry_count
       FROM karate_competition_categories cat
       LEFT JOIN karate_competition_entries e ON e.category_id = cat.id
      WHERE cat.competition_id = $1
      GROUP BY cat.id
      ORDER BY cat.created_at ASC`;
  try {
    const { rows } = await db.query(`-- p0d:list-categories\n${sql(true)}`, [competitionId]);
    return rows;
  } catch (e) {
    if (e.code !== '42703') throw e;
    const { rows } = await db.query(sql(false), [competitionId]);
    return rows.map((r) => ({ ...r, division_id: null, group_label: null }));
  }
}

// Alunos do dojô, uma query (nunca N+1), escopo pelo token.
async function loadDojoStudents(dojoId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `-- p0d:load-students
     SELECT s.id, s.full_name, s.practitioner_id,
            cu.birth_date, cu.gender, cu.dojo_id AS customer_dojo_id
       FROM karate_dojo_students s
       LEFT JOIN customers cu ON cu.id = s.practitioner_id
      WHERE s.dojo_id = $1 AND s.id = ANY($2::uuid[])`,
    [dojoId, ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Faixa atual dos praticantes (para o category_fit) — uma query.
async function loadCurrentBelts(federationId, practitionerIds) {
  if (!practitionerIds.length) return new Map();
  try {
    const { rows } = await db.query(
      `-- p0d:current-belts
       SELECT student_id, belt_level FROM karate_current_belt
        WHERE federation_id = $1 AND student_id = ANY($2::uuid[])`,
      [federationId, practitionerIds]
    );
    return new Map(rows.map((r) => [r.student_id, r.belt_level]));
  } catch (e) {
    if (e.code === '42P01') return new Map();
    throw e;
  }
}

// Inscrições individuais já existentes destes praticantes nestas categorias
// (dupla inscrição vira skip, não erro).
async function loadExistingEntries(categoryIds, practitionerIds) {
  if (!categoryIds.length || !practitionerIds.length) return new Set();
  const { rows } = await db.query(
    `-- p0d:existing-entries
     SELECT category_id, student_id FROM karate_competition_entries
      WHERE category_id = ANY($1::uuid[]) AND student_id = ANY($2::uuid[])`,
    [categoryIds, practitionerIds]
  );
  return new Set(rows.map((r) => `${r.category_id}:${r.student_id}`));
}

// Contagens do DOJÔ por categoria (cota por clube): individuais + equipes.
async function loadDojoCategoryCounts(dojoId, categoryIds) {
  const counts = {};
  if (!categoryIds.length) return counts;
  const ind = await db.query(
    `-- p0d:dojo-individual-counts
     SELECT category_id, COUNT(*)::int AS n
       FROM karate_competition_entries
      WHERE category_id = ANY($1::uuid[]) AND dojo_id = $2
        AND status NOT IN ('withdrawn') AND student_id IS NOT NULL
      GROUP BY category_id`,
    [categoryIds, dojoId]
  );
  for (const r of ind.rows) counts[r.category_id] = { existing: r.n, adding: 0, is_team: false };
  try {
    const tm = await db.query(
      `-- p0d:dojo-team-counts
       SELECT category_id, COUNT(*)::int AS n
         FROM karate_competition_teams
        WHERE category_id = ANY($1::uuid[]) AND dojo_id = $2 AND status = 'registered'
        GROUP BY category_id`,
      [categoryIds, dojoId]
    );
    for (const r of tm.rows) {
      counts[`team:${r.category_id}`] = { existing: r.n, adding: 0, is_team: true, category_id: r.category_id };
    }
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  return counts;
}

// ── Plano (validação pura sobre leituras) ───────────────────
async function planDelegation({ federationId, dojoId, competitionId, body }) {
  const b = body || {};
  const athletesIn = Array.isArray(b.athletes) ? b.athletes : [];
  const teamsIn = Array.isArray(b.teams) ? b.teams : [];
  const officialsCount = Math.max(0, parseInt(b.officials_count, 10) || 0);

  if (!athletesIn.length && !teamsIn.length) {
    throw serviceError(422, 'VALIDATION_ERROR', 'Informe athletes e/ou teams');
  }
  if (athletesIn.length > MAX_ATHLETES) {
    throw serviceError(422, 'VALIDATION_ERROR', `Máximo de ${MAX_ATHLETES} atletas por delegação`);
  }
  if (teamsIn.length > MAX_TEAMS) {
    throw serviceError(422, 'VALIDATION_ERROR', `Máximo de ${MAX_TEAMS} equipes por delegação`);
  }

  const competition = await loadCompetition(federationId, competitionId);
  if (!competition) throw serviceError(404, 'NOT_FOUND', 'Competição não encontrada nesta federação');
  if (competition.status !== 'open') {
    throw serviceError(409, 'INSCRICOES_ENCERRADAS', `Competição ${competition.status} não aceita inscrições`);
  }

  // Categorias referenciadas precisam existir NESTA competição.
  const catIds = new Set();
  for (const a of athletesIn) for (const cid of (a.category_ids || [])) if (isUuid(String(cid))) catIds.add(String(cid));
  for (const t of teamsIn) for (const cid of (t.category_ids || [])) if (isUuid(String(cid))) catIds.add(String(cid));
  const allCats = await listCategoriesForEnrollment(competitionId);
  const catById = new Map(allCats.map((c) => [c.id, c]));
  for (const cid of catIds) {
    if (!catById.has(cid)) {
      throw serviceError(422, 'CATEGORIA_INVALIDA', `Categoria ${cid} não pertence a esta competição`);
    }
  }

  // Alunos (atletas individuais + membros de equipe), uma query.
  const studentIds = [];
  for (const a of athletesIn) if (isUuid(String(a.student_id || ''))) studentIds.push(String(a.student_id));
  for (const t of teamsIn) {
    for (const sid of [...(t.titular_ids || []), ...(t.reserve_ids || [])]) {
      if (isUuid(String(sid))) studentIds.push(String(sid));
    }
  }
  const students = await loadDojoStudents(dojoId, [...new Set(studentIds)]);

  const skipped = [];
  const warnings = [];

  // ── Atletas individuais ──
  const plannedAthletes = [];
  const seenAthlete = new Set();
  for (const raw of athletesIn) {
    const sid = String(raw.student_id || '').trim();
    if (!isUuid(sid)) {
      skipped.push({ student_id: raw.student_id || null, reason: 'ID_INVALIDO', message: 'student_id inválido' });
      continue;
    }
    if (seenAthlete.has(sid)) {
      skipped.push({ student_id: sid, reason: 'ALUNO_DUPLICADO', message: 'O mesmo aluno aparece duas vezes' });
      continue;
    }
    seenAthlete.add(sid);
    const student = students.get(sid);
    if (!student) {
      skipped.push({ student_id: sid, reason: 'ALUNO_NAO_ENCONTRADO', message: 'Aluno não encontrado neste dojô' });
      continue;
    }
    if (!student.practitioner_id) {
      skipped.push({
        student_id: sid, name: student.full_name,
        reason: 'ALUNO_NAO_FEDERADO',
        message: 'Competição é ato federativo — federe o aluno (número FPKT) antes de inscrevê-lo',
      });
      continue;
    }
    const wanted = [...new Set((raw.category_ids || []).map(String).filter((c) => catById.has(c)))];
    if (!wanted.length) {
      skipped.push({ student_id: sid, name: student.full_name, reason: 'SEM_CATEGORIA', message: 'Nenhuma categoria válida informada' });
      continue;
    }
    plannedAthletes.push({ student, category_ids: wanted });
  }

  // ── Equipes ──
  const plannedTeams = [];
  for (let i = 0; i < teamsIn.length; i++) {
    const raw = teamsIn[i] || {};
    const key = `team-${i}`;
    const name = raw.name != null ? String(raw.name).trim() : '';
    const sex = ['M', 'F', 'mixed'].includes(raw.sex) ? raw.sex : 'mixed';
    const cats = [...new Set((raw.category_ids || []).map(String).filter((c) => catById.has(c)))];
    if (!name) {
      skipped.push({ team: key, reason: 'EQUIPE_SEM_NOME', message: 'Informe o nome da equipe' });
      continue;
    }
    if (!cats.length) {
      skipped.push({ team: key, name, reason: 'SEM_CATEGORIA', message: 'Nenhuma categoria válida informada para a equipe' });
      continue;
    }
    const titulares = [...new Set((raw.titular_ids || []).map(String).filter(isUuid))];
    const reservas = [...new Set((raw.reserve_ids || []).map(String).filter(isUuid))]
      .filter((sid) => !titulares.includes(sid));
    if (titulares.length < 2) {
      skipped.push({ team: key, name, reason: 'ROSTER_INSUFICIENTE', message: 'Equipe precisa de pelo menos 2 titulares' });
      continue;
    }
    const members = [];
    let memberProblem = null;
    for (const sid of [...titulares, ...reservas]) {
      const student = students.get(sid);
      if (!student) { memberProblem = { sid, reason: 'ALUNO_NAO_ENCONTRADO' }; break; }
      if (!student.practitioner_id) { memberProblem = { sid, name: student.full_name, reason: 'ALUNO_NAO_FEDERADO' }; break; }
      members.push({
        student,
        role: titulares.includes(sid) ? 'titular' : 'reserva',
      });
    }
    if (memberProblem) {
      skipped.push({
        team: key, name, reason: memberProblem.reason,
        student_id: memberProblem.sid,
        message: memberProblem.reason === 'ALUNO_NAO_FEDERADO'
          ? `Integrante ${memberProblem.name || ''} não é federado — federe antes de inscrever a equipe`.trim()
          : 'Integrante não encontrado neste dojô',
      });
      continue;
    }
    plannedTeams.push({ team_key: key, name, sex, category_ids: cats, members });
  }

  // ── Dupla inscrição individual (skip por categoria) ──
  const practitionerIds = plannedAthletes.map((p) => p.student.practitioner_id);
  const existing = await loadExistingEntries([...catIds], practitionerIds);
  for (const p of plannedAthletes) {
    p.category_ids = p.category_ids.filter((cid) => {
      if (existing.has(`${cid}:${p.student.practitioner_id}`)) {
        skipped.push({
          student_id: p.student.id, name: p.student.full_name, category_id: cid,
          reason: 'JA_INSCRITO', message: 'Aluno já inscrito nesta categoria',
        });
        return false;
      }
      return true;
    });
  }
  const finalAthletes = plannedAthletes.filter((p) => p.category_ids.length > 0);

  // ── Cotas por clube (bloqueia — limite regulamentar) ──
  const counts = await loadDojoCategoryCounts(dojoId, [...catIds]);
  for (const p of finalAthletes) {
    for (const cid of p.category_ids) {
      if (!counts[cid]) counts[cid] = { existing: 0, adding: 0, is_team: false };
      counts[cid].adding++;
    }
  }
  for (const t of plannedTeams) {
    for (const cid of t.category_ids) {
      const key = `team:${cid}`;
      if (!counts[key]) counts[key] = { existing: 0, adding: 0, is_team: true, category_id: cid };
      counts[key].adding++;
    }
  }
  // rules vêm da divisão da categoria; sem divisão/rules → sem cota.
  let divisionRules = {};
  try {
    const divIds = [...new Set(allCats.map((c) => c.division_id).filter(Boolean))];
    if (divIds.length) {
      const d = await db.query(
        `-- p0d:division-rules
         SELECT id, rules FROM karate_competition_divisions WHERE id = ANY($1::uuid[])`,
        [divIds]
      );
      divisionRules = Object.fromEntries(d.rows.map((r) => [r.id, r.rules || {}]));
    }
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  const quotaViolations = [];
  for (const [key, c] of Object.entries(counts)) {
    const categoryId = c.is_team ? c.category_id : key;
    const cat = catById.get(categoryId);
    const rules = cat && cat.division_id ? (divisionRules[cat.division_id] || {}) : {};
    const violations = checkClubQuotas({ [categoryId]: c }, rules);
    for (const v of violations) {
      quotaViolations.push({
        ...v,
        category_name: cat ? cat.name : null,
        is_team: !!c.is_team,
      });
    }
  }

  // ── Compatibilidade de categoria (SÓ AVISO — FPKT #1) ──
  const belts = await loadCurrentBelts(federationId, practitionerIds);
  for (const p of finalAthletes) {
    for (const cid of p.category_ids) {
      const cat = catById.get(cid);
      const fit = checkCategoryFit({
        student: {
          birth_date: p.student.birth_date,
          gender: p.student.gender,
          belt_level: belts.get(p.student.practitioner_id) || null,
        },
        category: cat,
        refDate: competition.event_date,
      });
      if (!fit.fits) {
        warnings.push({
          student_id: p.student.id,
          name: p.student.full_name,
          category_id: cid,
          category_name: cat.name,
          warnings: fit.warnings,
        });
      }
    }
  }

  // ── Cotação ──
  const pricing = competition.pricing_config || {};
  const quote = quoteDelegation({
    pricing,
    eventDate: competition.event_date ? String(competition.event_date).slice(0, 10) : null,
    legacy: { competition_fee: competition.fee_amount },
    athletes: finalAthletes.map((p) => ({
      student_id: p.student.id,
      name: p.student.full_name,
      birth_date: p.student.birth_date ? String(p.student.birth_date).slice(0, 10) : null,
      entries: p.category_ids.map((cid) => ({
        category_id: cid,
        category_name: catById.get(cid).name,
        category_fee: catById.get(cid).fee_amount,
      })),
    })),
    teams: plannedTeams.map((t) => ({
      team_key: t.team_key,
      name: t.name,
      provas_count: t.category_ids.length,
    })),
    officialsCount,
  });

  return {
    competition,
    athletes: finalAthletes,
    teams: plannedTeams,
    officialsCount,
    skipped,
    warnings,
    quotaViolations,
    quote,
  };
}

// ── Submit (uma transação; PIX depois do COMMIT é da rota) ──
async function submitDelegation({ federationId, dojoId, competitionId, body, createdBy, createdByName }) {
  const plan = await planDelegation({ federationId, dojoId, competitionId, body });

  if (plan.quotaViolations.length) {
    throw serviceError(422, 'QUOTA_EXCEEDED',
      'Cota por clube excedida em uma ou mais categorias — ajuste a delegação',
      { quota_violations: plan.quotaViolations });
  }
  if (!plan.athletes.length && !plan.teams.length) {
    throw serviceError(422, 'NADA_A_INSCREVER',
      'Nenhuma inscrição válida restou após as validações',
      { skipped: plan.skipped });
  }

  const paymentMode = ['aura_pay', 'pix_direct', 'manual'].includes((body || {}).payment_mode)
    ? body.payment_mode : 'manual';
  const initialStatus = plan.quote.total <= 0 ? 'paid' : 'awaiting_payment';

  const client = await db.connect();
  const enrolled = { athletes: [], teams: [] };
  let order;
  try {
    await client.query('BEGIN');

    const ins = await client.query(
      `-- p0d:insert-order
       INSERT INTO karate_delegation_orders
         (federation_id, competition_id, dojo_id, status, payment_mode,
          quote, total_amount, officials_count, created_by, created_by_name,
          confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,
               CASE WHEN $4 = 'paid' THEN NOW() ELSE NULL END)
       RETURNING id, status, payment_mode, total_amount, created_at`,
      [
        federationId, competitionId, dojoId, initialStatus, paymentMode,
        JSON.stringify(plan.quote), plan.quote.total, plan.officialsCount,
        createdBy || null, createdByName || null,
      ]
    );
    order = ins.rows[0];

    // Atletas individuais — advisory lock + UNIQUE como rede (23505 → skip).
    for (const p of plan.athletes) {
      for (const cid of p.category_ids) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1::text || '-deleg-' || $2::text))`,
          [cid, p.student.practitioner_id]
        );
        try {
          const e = await client.query(
            `-- p0d:insert-entry
             INSERT INTO karate_competition_entries
               (competition_id, category_id, student_id, dojo_id, status, fee_paid,
                delegation_order_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'registered', $5, $6, NOW(), NOW())
             RETURNING id`,
            [competitionId, cid, p.student.practitioner_id, dojoId,
             plan.quote.total <= 0, order.id]
          );
          enrolled.athletes.push({
            student_id: p.student.id,
            name: p.student.full_name,
            category_id: cid,
            entry_id: e.rows[0].id,
          });
        } catch (err) {
          if (err.code === '23505') continue; // corrida: já inscrito — segue
          throw err;
        }
      }
    }

    // Equipes: uma linha de equipe + membros + UMA entry por categoria.
    for (const t of plan.teams) {
      const tm = await client.query(
        `-- p0d:insert-team
         INSERT INTO karate_competition_teams
           (competition_id, category_id, dojo_id, name, sex, status, delegation_order_id)
         VALUES ($1,$2,$3,$4,$5,'registered',$6)
         RETURNING id`,
        [competitionId, t.category_ids[0], dojoId, t.name, t.sex, order.id]
      );
      const teamId = tm.rows[0].id;
      let sort = 0;
      for (const m of t.members) {
        await client.query(
          `-- p0d:insert-team-member
           INSERT INTO karate_competition_team_members (team_id, student_id, role, sort_order)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (team_id, student_id) DO NOTHING`,
          [teamId, m.student.practitioner_id, m.role, sort++]
        );
      }
      const teamEntryIds = [];
      for (const cid of t.category_ids) {
        const e = await client.query(
          `-- p0d:insert-team-entry
           INSERT INTO karate_competition_entries
             (competition_id, category_id, team_id, dojo_id, status, fee_paid,
              delegation_order_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'registered', $5, $6, NOW(), NOW())
           RETURNING id`,
          [competitionId, cid, teamId, dojoId, plan.quote.total <= 0, order.id]
        );
        teamEntryIds.push(e.rows[0].id);
      }
      enrolled.teams.push({
        team_key: t.team_key, team_id: teamId, name: t.name,
        category_ids: t.category_ids, entry_ids: teamEntryIds,
        members: t.members.length,
      });
    }

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e.code === '42P01') {
      throw serviceError(503, 'SCHEMA_PENDING', 'Delegações indisponíveis (migração 294 pendente)');
    }
    throw e;
  } finally {
    client.release();
  }

  return {
    order: {
      id: order.id,
      status: order.status,
      payment_mode: order.payment_mode,
      total_amount: Number(order.total_amount),
      created_at: order.created_at,
    },
    quote: plan.quote,
    enrolled,
    skipped: plan.skipped,
    warnings: plan.warnings,
  };
}

// ── Pedidos do dojô ─────────────────────────────────────────
async function listOrders(federationId, dojoId) {
  try {
    const { rows } = await db.query(
      `-- p0d:list-orders
       SELECT o.id, o.competition_id, c.name AS competition_name, c.event_date,
              o.status, o.payment_mode, o.total_amount, o.officials_count,
              o.receipt_url, o.created_at, o.confirmed_at
         FROM karate_delegation_orders o
         JOIN karate_competitions c ON c.id = o.competition_id
        WHERE o.federation_id = $1 AND o.dojo_id = $2
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [federationId, dojoId]
    );
    return rows.map((r) => ({ ...r, total_amount: Number(r.total_amount) }));
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

async function getOrder(federationId, dojoId, orderId) {
  if (!isUuid(orderId)) return null;
  try {
    const { rows } = await db.query(
      `-- p0d:get-order
       SELECT o.*, c.name AS competition_name, c.event_date
         FROM karate_delegation_orders o
         JOIN karate_competitions c ON c.id = o.competition_id
        WHERE o.id = $1 AND o.federation_id = $2 AND o.dojo_id = $3
        LIMIT 1`,
      [orderId, federationId, dojoId]
    );
    if (!rows.length) return null;
    const o = rows[0];
    const entries = await db.query(
      `-- p0d:order-entries
       SELECT e.id, e.category_id, cat.name AS category_name, e.status, e.fee_paid,
              e.student_id, cu.name AS student_name,
              e.team_id, t.name AS team_name
         FROM karate_competition_entries e
         JOIN karate_competition_categories cat ON cat.id = e.category_id
         LEFT JOIN customers cu ON cu.id = e.student_id
         LEFT JOIN karate_competition_teams t ON t.id = e.team_id
        WHERE e.delegation_order_id = $1
        ORDER BY cat.name ASC, cu.name ASC NULLS LAST`,
      [orderId]
    );
    return {
      id: o.id,
      competition: { id: o.competition_id, name: o.competition_name, event_date: o.event_date },
      status: o.status,
      payment_mode: o.payment_mode,
      total_amount: Number(o.total_amount),
      officials_count: o.officials_count,
      quote: o.quote || {},
      receipt_url: o.receipt_url || null,
      created_at: o.created_at,
      confirmed_at: o.confirmed_at || null,
      entries: entries.rows,
    };
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

// ============================================================
// FILA DE CONFERÊNCIA — comprovante (dojô) + confirmar/recusar (federação)
// Digitaliza o fluxo real: "planilhas de inscrição sem comprovante de
// depósito, e vice-versa, serão desconsideradas" (Regulamento JKA). Para a
// federação SEM Aura Pay, esta fila É o produto; para a que aderir, é o
// que o Aura Pay elimina.
// ============================================================

const RECEIPT_TYPES = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});
// ~5MB reais (base64 infla ~33%) — mesma régua dos anexos de exame do dojô.
const RECEIPT_MAX_BASE64 = 7 * 1024 * 1024;

// Dojô anexa o comprovante do pedido → status 'awaiting_confirmation'.
// Aceito em awaiting_payment (primeiro envio) e awaiting_confirmation
// (reenvio/correção do arquivo). pix_direct também aceita: se o PIX falhou
// na geração, o clube pode pagar por fora e comprovar.
async function uploadReceipt({ federationId, dojoId, orderId, fileBase64, contentType, uploadToR2 }) {
  if (!isUuid(orderId)) throw serviceError(404, 'NOT_FOUND', 'Pedido não encontrado');
  const ext = RECEIPT_TYPES[String(contentType || '').toLowerCase()];
  if (!ext) {
    throw serviceError(422, 'TIPO_INVALIDO', 'Comprovante deve ser PDF, JPEG, PNG ou WebP');
  }
  const b64 = String(fileBase64 || '');
  if (!b64) throw serviceError(422, 'VALIDATION_ERROR', 'Arquivo vazio');
  if (b64.length > RECEIPT_MAX_BASE64) {
    throw serviceError(422, 'ARQUIVO_GRANDE', 'Comprovante acima de 5MB');
  }

  const { rows } = await db.query(
    `-- p0d:receipt-load-order
     SELECT id, status FROM karate_delegation_orders
      WHERE id = $1 AND federation_id = $2 AND dojo_id = $3
      LIMIT 1`,
    [orderId, federationId, dojoId]
  );
  if (!rows.length) throw serviceError(404, 'NOT_FOUND', 'Pedido não encontrado');
  const order = rows[0];
  if (!['awaiting_payment', 'awaiting_confirmation'].includes(order.status)) {
    throw serviceError(409, 'STATUS_INVALIDO',
      `Pedido ${order.status === 'paid' ? 'já confirmado' : order.status} não aceita comprovante`);
  }

  const key = `karate/${federationId}/delegation-receipts/${orderId}/${Date.now()}.${ext}`;
  const up = await uploadToR2(key, b64, contentType);
  if (!up || !up.url) {
    throw serviceError(502, 'UPLOAD_FALHOU', 'Não foi possível salvar o comprovante — tente novamente');
  }

  const upd = await db.query(
    `-- p0d:receipt-update-order
     UPDATE karate_delegation_orders
        SET receipt_url = $1, receipt_uploaded_at = NOW(),
            status = 'awaiting_confirmation', updated_at = NOW()
      WHERE id = $2
    RETURNING id, status, receipt_url, receipt_uploaded_at`,
    [up.url, orderId]
  );
  return upd.rows[0];
}

// Federação confirma o pedido: 'paid' + cascata fee_paid nas entries.
// Idempotente: já pago → 409 ALREADY_PAID (a UI mostra quem confirmou).
async function confirmOrder({ federationId, competitionId, orderId, actorId, actorName }) {
  if (!isUuid(orderId)) throw serviceError(404, 'NOT_FOUND', 'Pedido não encontrado');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `-- p0d:confirm-load-order
       SELECT id, status, dojo_id, total_amount FROM karate_delegation_orders
        WHERE id = $1 AND federation_id = $2 AND competition_id = $3
        FOR UPDATE`,
      [orderId, federationId, competitionId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      throw serviceError(404, 'NOT_FOUND', 'Pedido não encontrado nesta competição');
    }
    const order = cur.rows[0];
    if (order.status === 'paid') {
      await client.query('ROLLBACK');
      throw serviceError(409, 'ALREADY_PAID', 'Pedido já confirmado');
    }
    if (order.status === 'cancelled') {
      await client.query('ROLLBACK');
      throw serviceError(409, 'PEDIDO_CANCELADO', 'Pedido cancelado não pode ser confirmado');
    }

    await client.query(
      `-- p0d:confirm-order
       UPDATE karate_delegation_orders
          SET status = 'paid', confirmed_by = $1, confirmed_by_name = $2,
              confirmed_at = NOW(), updated_at = NOW()
        WHERE id = $3`,
      [actorId || null, actorName || null, orderId]
    );
    const cascade = await client.query(
      `-- p0d:confirm-cascade
       UPDATE karate_competition_entries
          SET fee_paid = true, updated_at = NOW()
        WHERE delegation_order_id = $1 AND fee_paid = false`,
      [orderId]
    );

    await client.query('COMMIT');
    return { id: orderId, status: 'paid', entries_marked_paid: cascade.rowCount || 0 };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e.isServiceError) throw e;
    if (e.code === '42P01') throw serviceError(503, 'SCHEMA_PENDING', 'Delegações indisponíveis (migração 294 pendente)');
    throw e;
  } finally {
    client.release();
  }
}

// Federação recusa: pedido 'cancelled' + inscrições/equipes 'withdrawn'.
// As entries NÃO são apagadas (rastro do que foi pedido e recusado) — só
// saem das listagens/chaves, que já filtram withdrawn.
async function rejectOrder({ federationId, competitionId, orderId, reason }) {
  if (!isUuid(orderId)) throw serviceError(404, 'NOT_FOUND', 'Pedido não encontrado');
  const cleanReason = reason != null && String(reason).trim() !== ''
    ? String(reason).trim().slice(0, 1000) : null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `-- p0d:reject-load-order
       SELECT id, status FROM karate_delegation_orders
        WHERE id = $1 AND federation_id = $2 AND competition_id = $3
        FOR UPDATE`,
      [orderId, federationId, competitionId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      throw serviceError(404, 'NOT_FOUND', 'Pedido não encontrado nesta competição');
    }
    const order = cur.rows[0];
    if (order.status === 'paid') {
      await client.query('ROLLBACK');
      throw serviceError(409, 'PEDIDO_PAGO', 'Pedido já confirmado — não pode ser recusado. Trate o estorno fora do sistema.');
    }
    if (order.status === 'cancelled') {
      await client.query('ROLLBACK');
      throw serviceError(409, 'JA_CANCELADO', 'Pedido já cancelado');
    }

    await client.query(
      `-- p0d:reject-order
       UPDATE karate_delegation_orders
          SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1, updated_at = NOW()
        WHERE id = $2`,
      [cleanReason, orderId]
    );
    const entries = await client.query(
      `-- p0d:reject-withdraw-entries
       UPDATE karate_competition_entries
          SET status = 'withdrawn', updated_at = NOW()
        WHERE delegation_order_id = $1 AND status <> 'withdrawn'`,
      [orderId]
    );
    await client.query(
      `-- p0d:reject-withdraw-teams
       UPDATE karate_competition_teams
          SET status = 'withdrawn', updated_at = NOW()
        WHERE delegation_order_id = $1 AND status <> 'withdrawn'`,
      [orderId]
    );

    await client.query('COMMIT');
    return { id: orderId, status: 'cancelled', entries_withdrawn: entries.rowCount || 0 };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e.isServiceError) throw e;
    if (e.code === '42P01') throw serviceError(503, 'SCHEMA_PENDING', 'Delegações indisponíveis (migração 294 pendente)');
    throw e;
  } finally {
    client.release();
  }
}

// Detalhe do pedido para a FEDERAÇÃO (fila de conferência).
async function getOrderForFederation(federationId, competitionId, orderId) {
  if (!isUuid(orderId)) return null;
  try {
    const { rows } = await db.query(
      `-- p0d:fed-get-order
       SELECT o.*, COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
         FROM karate_delegation_orders o
         LEFT JOIN companies dj ON dj.id = o.dojo_id
        WHERE o.id = $1 AND o.federation_id = $2 AND o.competition_id = $3
        LIMIT 1`,
      [orderId, federationId, competitionId]
    );
    if (!rows.length) return null;
    const o = rows[0];
    const entries = await db.query(
      `-- p0d:fed-order-entries
       SELECT e.id, e.category_id, cat.name AS category_name, e.status, e.fee_paid,
              e.student_id, cu.name AS student_name,
              e.team_id, t.name AS team_name
         FROM karate_competition_entries e
         JOIN karate_competition_categories cat ON cat.id = e.category_id
         LEFT JOIN customers cu ON cu.id = e.student_id
         LEFT JOIN karate_competition_teams t ON t.id = e.team_id
        WHERE e.delegation_order_id = $1
        ORDER BY cat.name ASC, cu.name ASC NULLS LAST`,
      [orderId]
    );
    return {
      id: o.id,
      dojo: { id: o.dojo_id, name: o.dojo_name || null },
      status: o.status,
      payment_mode: o.payment_mode,
      total_amount: Number(o.total_amount),
      officials_count: o.officials_count,
      quote: o.quote || {},
      receipt_url: o.receipt_url || null,
      receipt_uploaded_at: o.receipt_uploaded_at || null,
      created_at: o.created_at,
      confirmed_at: o.confirmed_at || null,
      confirmed_by_name: o.confirmed_by_name || null,
      cancelled_at: o.cancelled_at || null,
      cancel_reason: o.cancel_reason || null,
      entries: entries.rows,
    };
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

module.exports = {
  MAX_ATHLETES,
  MAX_TEAMS,
  listOpenCompetitions,
  listCategoriesForEnrollment,
  planDelegation,
  submitDelegation,
  listOrders,
  getOrder,
  uploadReceipt,
  confirmOrder,
  rejectOrder,
  getOrderForFederation,
};
