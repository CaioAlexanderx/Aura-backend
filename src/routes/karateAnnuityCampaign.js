// ============================================================
// AURA KARATÊ — Fase F3: campanha anual de anuidades + cobrança em lote
//
//   POST /financial/annuities/campaign/preview — pré-visualização (read-only)
//   POST /financial/annuities/campaign         — dispara a campanha (idempotente)
//   POST /financial/annuities/batch             — mesmo motor, multi-seleção manual
//
// 🔴 REGRA CRÍTICA (ver CLAUDE.md + PR): elegibilidade de PRATICANTE não é
// "ativo" — é ATIVO **E** FAIXA-PRETA **E** sem anuidade lançada na
// temporada. Confundir isso manda uma cobrança de R$60 para TODO praticante
// ativo (na federação de referência, 6.950 em vez de 549 faixas-pretas
// ativas) — ~R$417 mil de receita fantasma, e os índices únicos parciais de
// karate_dojo_annuity_history (dojo_id/practitioner_id, reference_period —
// migration 222) impedem desfazer por reexecução. A checagem de
// is_black_belt SEMPRE vem de karate_current_belt (mesma fonte usada por
// karate_member_standing e karateAnnuitySummary.js) — nunca reimplementar o
// cálculo de faixa aqui.
//
// Por que este arquivo NÃO faz `SELECT * FROM karate_member_standing`
// direto: as views karate_dojo_standing/karate_member_standing (migration
// 222) são fixas no ANO CORRENTE (EXTRACT(year FROM now())), e campanha/
// lote aceitam `year` arbitrário (ex.: preparar a campanha do ano que vem
// com antecedência). A regra é replicada em SQL sobre
// companies/customers/karate_current_belt/karate_dojo_annuity_history — os
// PREDICADOS (is_active, belt_level='preta') são idênticos aos das views;
// só o filtro de período é parametrizado. Mesmo padrão já usado em
// karateAnnuitySummary.js (ver comentário lá).
//
// Elegibilidade EXATA (não mexer sem atualizar os testes em
// __tests__/karate.annuityCampaign.test.js):
//   Dojô:       companies.is_active = true E vertical_active='karate_dojo'
//               E SEM header em karate_dojo_annuity_history para (dojo_id, year)
//   Praticante: customers.is_active = true E karate_current_belt.belt_level='preta'
//               E SEM header em karate_dojo_annuity_history para (practitioner_id, year)
//
// Geração de parcelas: reusa karateAnnuityService.buildInstallmentPlan (a
// MESMA lógica de data/valor do /charge individual — não duplicar). A única
// diferença de comportamento em relação ao /charge manual (Fase F1) é
// PROPOSITAL desta fase (ver PR): se TODAS as parcelas do plano já venceram
// na temporada (ex.: campanha rodada em julho para um plano anual com
// vencimento em maio), o /charge individual falha alto (422, decisão de
// quem clicou 1 vez). Já a campanha/lote NUNCA deixa um elegível sem
// nenhuma cobrança silenciosamente — gera só a ÚLTIMA parcela do plano
// nesse caso (buildCampaignSpecs → usedLastInstallmentFallback=true no item
// criado, para o front sinalizar isso ao operador).
//
// Idempotência: pg_advisory_xact_lock(hashtext(federationId||'-campaign-'||year))
// — MESMO namespace de lock para /campaign e /batch (mesmo motor, mesma
// temporada = mesma seção crítica). Reexecutar não duplica: a query de
// elegibilidade já exclui quem tem header no período, e o INSERT do header
// ainda está protegido pelos índices únicos parciais da migration 222
// (uq_kdah_dojo_period / uq_kdah_practitioner_period) — 23505 vira
// "skipped", não erro 500.
//
// Nunca all-or-nothing: cada alvo roda sob SAVEPOINT (armadilha do repo —
// nunca best-effort dentro de BEGIN SEM savepoint, envenena a transação
// inteira). Um alvo que falha vai para `errors[]`; o loop continua para os
// demais. Resposta sempre `{ created[], skipped[], errors[] }`.
//
// Nada aqui altera is_active de ninguém, e nada envia e-mail (F4).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const annuitySvc = require('../services/karateAnnuityService');

const VALID_SCOPES = ['dojos', 'practitioners', 'both'];

function normalizeYear(input) {
  const y = String(input == null ? '' : input).trim();
  return /^\d{4}$/.test(y) ? y : null;
}

function toUuidArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => typeof v === 'string' && v.trim().length > 0);
}

function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

// ── Elegibilidade — SQL é a fonte única (ver cabeçalho do arquivo). ────────
// Dojô: ativo (afiliado) E sem anuidade na temporada.
const DOJO_ELIGIBLE_SQL = `
  SELECT c.id AS dojo_id, c.name
  FROM companies c
  WHERE c.federation_id = $1
    AND c.vertical_active = 'karate_dojo'
    AND COALESCE(c.is_active, false)
    AND NOT EXISTS (
      SELECT 1 FROM karate_dojo_annuity_history h
      WHERE h.dojo_id = c.id AND h.reference_period = $2
    )
    AND NOT (c.id = ANY($3::uuid[]))
  ORDER BY c.name ASC
`;

// Praticante: ATIVO **E** FAIXA-PRETA **E** sem anuidade na temporada — as
// TRÊS condições, sempre juntas. Ver 🔴 no cabeçalho do arquivo.
const PRACTITIONER_ELIGIBLE_SQL = `
  SELECT c.id AS practitioner_id, c.name, c.karate_registration_number
  FROM customers c
  JOIN karate_current_belt cb ON cb.student_id = c.id
  WHERE c.federation_id = $1
    AND COALESCE(c.is_active, true)
    AND cb.belt_level = 'preta'
    AND NOT EXISTS (
      SELECT 1 FROM karate_dojo_annuity_history h
      WHERE h.practitioner_id = c.id AND h.reference_period = $2
    )
    AND NOT (c.id = ANY($3::uuid[]))
  ORDER BY c.karate_registration_number ASC NULLS LAST, c.name ASC
`;

async function fetchEligibleDojos(client, federationId, year, excludeIds) {
  const runner = client || db;
  const { rows } = await runner.query(DOJO_ELIGIBLE_SQL, [federationId, year, excludeIds]);
  return rows;
}

async function fetchEligiblePractitioners(client, federationId, year, excludeIds) {
  const runner = client || db;
  const { rows } = await runner.query(PRACTITIONER_ELIGIBLE_SQL, [federationId, year, excludeIds]);
  return rows;
}

// ── Monta as parcelas de um alvo de campanha (ver nota no cabeçalho sobre
// o fallback "todas as parcelas já venceram → gera a última").
function buildCampaignSpecs({ plan, amount, dueMonths, seasonYear }) {
  const restantes = annuitySvc.buildInstallmentPlan({
    plan, amount, dueMonths, seasonYear, fromDate: new Date(),
  });
  if (restantes.length) return { specs: restantes, usedLastInstallmentFallback: false };
  const completo = annuitySvc.buildInstallmentPlan({ plan, amount, dueMonths, seasonYear });
  if (!completo.length) return { specs: [], usedLastInstallmentFallback: false };
  return { specs: [completo[completo.length - 1]], usedLastInstallmentFallback: true };
}

function specsTotal(specs) {
  return round2(specs.reduce((s, x) => s + Number(x.amount), 0));
}

// ── Executa uma etapa "por alvo" sob SAVEPOINT — erro de UM alvo não
// derruba o lote (armadilha do repo: nunca best-effort sem savepoint).
async function withSavepoint(client, label, fn) {
  const sp = 'sp_campaign_' + label;
  await client.query('SAVEPOINT ' + sp);
  try {
    const result = await fn();
    await client.query('RELEASE SAVEPOINT ' + sp);
    return { ok: true, result };
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT ' + sp); } catch (_) { /* noop */ }
    return { ok: false, error: err };
  }
}

// Cria o header + parcelas + transactions para UM alvo já validado como
// elegível. Reaproveita createInstallmentsForAnnuity / createTransactions-
// ForInstallments / syncAnnuityHeaderRollup — MESMO motor do /charge
// individual (karateAnnuities.js), sem duplicar a lógica de geração.
async function createAnnuityForTarget(client, { type, id, name, federationId, year, plan, fee }) {
  const dojoId = type === 'dojo' ? id : null;
  const practitionerId = type === 'practitioner' ? id : null;

  // Checagem de duplicidade dentro da MESMA transação/lock — a elegibilidade
  // já foi calculada antes do advisory lock (ou vem de um target explícito
  // no /batch), então revalidamos aqui. Índice único parcial é o backstop
  // final (23505 → tratado como skip pelo chamador).
  const existing = await client.query(
    `SELECT id FROM karate_dojo_annuity_history
     WHERE reference_period = $1 AND ${type === 'dojo' ? 'dojo_id = $2' : 'practitioner_id = $2'}
     LIMIT 1`,
    [year, id]
  );
  if (existing.rows.length) {
    return { status: 'skipped', reason: 'already_has_annuity_this_season' };
  }

  if (!fee) {
    return {
      status: 'error',
      reason: `Nenhuma fee configurada para o plano '${plan}' (karate_annual_fees, fee_type='${type === 'dojo' ? 'dojo' : 'cpf'}')`,
    };
  }

  const seasonYear = parseInt(year, 10) || new Date().getFullYear();
  const { specs, usedLastInstallmentFallback } = buildCampaignSpecs({
    plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear,
  });
  if (!specs.length) {
    return { status: 'error', reason: 'Não foi possível montar o plano de parcelas (fee sem due_months válido)' };
  }

  const histRes = await client.query(
    `INSERT INTO karate_dojo_annuity_history
       (dojo_id, federation_id, practitioner_id, reference_period, plan, amount, due_date, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 'pending', NOW())
     RETURNING id`,
    [dojoId, federationId, practitionerId, year, plan, specs[0].due_date]
  );
  const annuityId = histRes.rows[0].id;
  let installments = await annuitySvc.createInstallmentsForAnnuity(client, { annuityId, federationId, specs });
  installments = await annuitySvc.createTransactionsForInstallments(client, {
    federationId, kind: type === 'dojo' ? 'dojo' : 'cpf', refId: id, refName: name,
    referencePeriod: year, installments,
  });
  await annuitySvc.syncAnnuityHeaderRollup(client, annuityId);

  return {
    status: 'created',
    annuity_id: annuityId,
    installments_count: installments.length,
    used_last_installment_fallback: usedLastInstallmentFallback,
    total: specsTotal(specs),
  };
}

let savepointCounter = 0;

async function runTarget(client, target, buckets) {
  const { created, skipped, errors } = buckets;
  const label = `${target.type}_${savepointCounter++}`;
  const outcome = await withSavepoint(client, label, () => createAnnuityForTarget(client, target));

  if (outcome.ok) {
    const r = outcome.result;
    if (r.status === 'created') {
      created.push({
        type: target.type, id: target.id, name: target.name,
        annuity_id: r.annuity_id, plan: target.plan,
        installments_count: r.installments_count,
        used_last_installment_fallback: r.used_last_installment_fallback,
        total: r.total,
      });
    } else if (r.status === 'skipped') {
      skipped.push({ type: target.type, id: target.id, name: target.name, reason: r.reason });
    } else {
      errors.push({ type: target.type, id: target.id, name: target.name, reason: r.reason });
    }
    return;
  }

  const err = outcome.error;
  if (err.code === '23505') {
    skipped.push({ type: target.type, id: target.id, name: target.name, reason: 'already_has_annuity_this_season' });
  } else {
    console.error('[karateAnnuityCampaign] target failed:', target.type, target.id, err.message);
    errors.push({ type: target.type, id: target.id, name: target.name, reason: err.message });
  }
}

// Resolve um alvo explícito do /batch (id vindo da UI) contra o estado ATUAL
// do banco — nunca confia que o front só mandou linhas elegíveis. É aqui
// que a regra "só faixa-preta ativa" é reforçada de novo para o /batch.
async function loadTargetInfo(client, type, id, federationId) {
  if (type === 'dojo') {
    const { rows } = await client.query(
      `SELECT id, name, COALESCE(is_active, false) AS is_active
       FROM companies
       WHERE id = $1 AND federation_id = $2 AND vertical_active = 'karate_dojo'
       LIMIT 1`,
      [id, federationId]
    );
    if (!rows.length) return { found: false };
    const isActive = rows[0].is_active;
    return {
      found: true, name: rows[0].name, eligible: isActive,
      ineligibleReason: isActive ? null : 'dojo_inativo',
    };
  }
  if (type === 'practitioner') {
    const { rows } = await client.query(
      `SELECT c.id, c.name, COALESCE(c.is_active, true) AS is_active, cb.belt_level
       FROM customers c
       LEFT JOIN karate_current_belt cb ON cb.student_id = c.id
       WHERE c.id = $1 AND c.federation_id = $2
       LIMIT 1`,
      [id, federationId]
    );
    if (!rows.length) return { found: false };
    const isActive = rows[0].is_active;
    const isBlack = rows[0].belt_level === 'preta';
    let reason = null;
    if (!isActive && !isBlack) reason = 'praticante_inativo_e_nao_e_faixa_preta';
    else if (!isActive) reason = 'praticante_inativo';
    else if (!isBlack) reason = 'praticante_nao_e_faixa_preta';
    return { found: true, name: rows[0].name, eligible: isActive && isBlack, ineligibleReason: reason };
  }
  return { found: false };
}

// ────────────────────────────────────────────────────────────────
// POST /annuities/campaign/preview
// { year, scope: 'dojos'|'practitioners'|'both' }
// Read-only — é o preview que protege o usuário: os números aqui são os que
// a UI mostra antes do commit, então usam a MESMA query de elegibilidade e
// o MESMO cálculo de parcelas que /campaign vai usar de fato.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/campaign/preview', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { year: rawYear, scope: rawScope } = req.body || {};
  const year = normalizeYear(rawYear);
  const scope = VALID_SCOPES.includes(rawScope) ? rawScope : null;

  if (!year) {
    return res.status(422).json({ error: 'year obrigatório (formato AAAA)', code: 'VALIDATION_ERROR' });
  }
  if (!scope) {
    return res.status(422).json({
      error: `scope inválido. Valores aceitos: ${VALID_SCOPES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const seasonYear = parseInt(year, 10);
  const wantDojos = scope === 'dojos' || scope === 'both';
  const wantPractitioners = scope === 'practitioners' || scope === 'both';

  try {
    let dojos = [];
    let practitioners = [];

    if (wantDojos) {
      const rows = await fetchEligibleDojos(null, federationId, year, []);
      const fee = await annuitySvc.getVigentFee(null, federationId, 'dojo', 'anual');
      const amount = fee
        ? specsTotal(buildCampaignSpecs({ plan: 'anual', amount: fee.amount, dueMonths: fee.due_months, seasonYear }).specs)
        : 0;
      dojos = rows.map((r) => ({ dojo_id: r.dojo_id, name: r.name, plan_default: 'anual', amount }));
    }

    if (wantPractitioners) {
      const rows = await fetchEligiblePractitioners(null, federationId, year, []);
      const fee = await annuitySvc.getVigentFee(null, federationId, 'cpf', 'anual');
      const amount = fee
        ? specsTotal(buildCampaignSpecs({ plan: 'anual', amount: fee.amount, dueMonths: fee.due_months, seasonYear }).specs)
        : 0;
      practitioners = rows.map((r) => ({
        practitioner_id: r.practitioner_id,
        name: r.name,
        karate_registration_number: r.karate_registration_number || null,
        amount,
      }));
    }

    const valor_previsto = round2(
      dojos.reduce((s, d) => s + Number(d.amount), 0) +
      practitioners.reduce((s, p) => s + Number(p.amount), 0)
    );

    res.json({
      dojos,
      practitioners,
      totals: {
        dojos_count: dojos.length,
        practitioners_count: practitioners.length,
        valor_previsto,
      },
    });
  } catch (err) {
    console.error('[karateAnnuityCampaign] preview error:', err.message);
    res.status(500).json({ error: 'Erro ao pré-visualizar campanha', detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// POST /annuities/campaign
// { year, scope: 'dojos'|'practitioners'|'both', exclude: { dojo_ids[], practitioner_ids[] } }
// ────────────────────────────────────────────────────────────────
router.post('/annuities/campaign', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { year: rawYear, scope: rawScope, exclude } = req.body || {};
  const year = normalizeYear(rawYear);
  const scope = VALID_SCOPES.includes(rawScope) ? rawScope : null;

  if (!year) {
    return res.status(422).json({ error: 'year obrigatório (formato AAAA)', code: 'VALIDATION_ERROR' });
  }
  if (!scope) {
    return res.status(422).json({
      error: `scope inválido. Valores aceitos: ${VALID_SCOPES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const excludeDojoIds = toUuidArray(exclude && exclude.dojo_ids);
  const excludePractitionerIds = toUuidArray(exclude && exclude.practitioner_ids);
  const wantDojos = scope === 'dojos' || scope === 'both';
  const wantPractitioners = scope === 'practitioners' || scope === 'both';

  const client = await db.connect();
  const created = [];
  const skipped = [];
  const errors = [];
  try {
    await client.query('BEGIN');
    // Idempotência: mesma federação + mesmo ano = mesma seção crítica.
    // Segunda execução concorrente/sequencial espera aqui até a primeira
    // terminar; como a elegibilidade já exclui quem tem header no período,
    // a segunda leva tudo pra `skipped`.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-campaign-' || $2::text))`,
      [federationId, year]
    );

    const dojoFee = wantDojos ? await annuitySvc.getVigentFee(client, federationId, 'dojo', 'anual') : null;
    const practFee = wantPractitioners ? await annuitySvc.getVigentFee(client, federationId, 'cpf', 'anual') : null;

    if (wantDojos) {
      const dojos = await fetchEligibleDojos(client, federationId, year, excludeDojoIds);
      for (const d of dojos) {
        await runTarget(client, {
          type: 'dojo', id: d.dojo_id, name: d.name, federationId, year, plan: 'anual', fee: dojoFee,
        }, { created, skipped, errors });
      }
    }

    if (wantPractitioners) {
      const practs = await fetchEligiblePractitioners(client, federationId, year, excludePractitionerIds);
      for (const p of practs) {
        await runTarget(client, {
          type: 'practitioner', id: p.practitioner_id, name: p.name, federationId, year, plan: 'anual', fee: practFee,
        }, { created, skipped, errors });
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ created, skipped, errors });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuityCampaign] campaign error:', err.message);
    res.status(500).json({ error: 'Erro ao rodar campanha', detail: err.message });
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────────────────────
// POST /annuities/batch
// { targets: [{ type: 'dojo'|'practitioner', id }], year, plan? }
// Mesmo motor da campanha, para a multi-seleção manual da tabela. `plan`
// (opcional, default 'anual') só afeta alvos type='dojo' — CPF só tem o
// plano 'anual'. Cada alvo é REVALIDADO contra o banco (ver loadTargetInfo)
// — nunca confia que a UI só mandou elegíveis.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/batch', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { targets, year: rawYear, plan: rawPlan } = req.body || {};
  const year = normalizeYear(rawYear);

  if (!year) {
    return res.status(422).json({ error: 'year obrigatório (formato AAAA)', code: 'VALIDATION_ERROR' });
  }
  if (!Array.isArray(targets) || !targets.length) {
    return res.status(422).json({ error: 'targets obrigatório (array não vazio)', code: 'VALIDATION_ERROR' });
  }
  for (const t of targets) {
    if (!t || !['dojo', 'practitioner'].includes(t.type) || !t.id) {
      return res.status(422).json({
        error: 'cada target precisa de { type: "dojo"|"practitioner", id }',
        code: 'VALIDATION_ERROR',
      });
    }
  }
  if (rawPlan && !annuitySvc.VALID_PLANS.includes(rawPlan)) {
    return res.status(422).json({
      error: `plan inválido. Valores aceitos: ${annuitySvc.VALID_PLANS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const dojoPlan = rawPlan || 'anual';

  const client = await db.connect();
  const created = [];
  const skipped = [];
  const errors = [];
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-campaign-' || $2::text))`,
      [federationId, year]
    );

    let dojoFee;
    let dojoFeeLoaded = false;
    let practFee;
    let practFeeLoaded = false;

    for (const t of targets) {
      const info = await loadTargetInfo(client, t.type, t.id, federationId);
      if (!info.found) {
        errors.push({ type: t.type, id: t.id, name: null, reason: 'not_found' });
        continue;
      }
      if (!info.eligible) {
        errors.push({ type: t.type, id: t.id, name: info.name, reason: info.ineligibleReason });
        continue;
      }

      let plan;
      let fee;
      if (t.type === 'dojo') {
        plan = dojoPlan;
        if (!dojoFeeLoaded) {
          dojoFee = await annuitySvc.getVigentFee(client, federationId, 'dojo', dojoPlan);
          dojoFeeLoaded = true;
        }
        fee = dojoFee;
      } else {
        plan = 'anual';
        if (!practFeeLoaded) {
          practFee = await annuitySvc.getVigentFee(client, federationId, 'cpf', 'anual');
          practFeeLoaded = true;
        }
        fee = practFee;
      }

      await runTarget(client, {
        type: t.type, id: t.id, name: info.name, federationId, year, plan, fee,
      }, { created, skipped, errors });
    }

    await client.query('COMMIT');
    res.status(201).json({ created, skipped, errors });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[karateAnnuityCampaign] batch error:', err.message);
    res.status(500).json({ error: 'Erro ao processar lote', detail: err.message });
  } finally {
    client.release();
  }
});

// Helpers expostos SOMENTE para teste unitário direto (Router é uma
// função — anexar propriedades nela não interfere na montagem via
// `router.use(path, require('./karateAnnuityCampaign'))` em routes/index.js).
router.__testables = { buildCampaignSpecs, specsTotal, normalizeYear, toUuidArray };

module.exports = router;
