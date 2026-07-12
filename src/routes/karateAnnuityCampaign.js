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
// Geração de parcelas: reusa karateAnnuityService.buildPlanSpecs (a MESMA
// lógica de data/valor do /charge individual — não duplicar; ver PR #356
// "continuação F3"). Se TODAS as parcelas do plano já venceram na temporada
// (ex.: campanha rodada em julho para um plano anual com vencimento em
// maio), NUNCA deixamos um elegível sem nenhuma cobrança silenciosamente —
// gera só a ÚLTIMA parcela do plano, mas com due_date = ÚLTIMO DIA DO MÊS
// CORRENTE (default seguro: a cobrança nasce "a vencer", não atrasada no
// mesmo instante em que é criada — decisão de produto que substitui o
// fallback anterior, que reusava a data original do plano). A federação
// também pode informar `due_date` explicitamente (POST .../campaign,
// .../batch e o /charge individual aceitam o campo) para sobrescrever a
// data da primeira parcela gerada — ver validateDueDateOverride/
// buildPlanSpecs em karateAnnuityService.js. Em ambos os casos
// (default seguro OU override), o item criado marca
// `due_date_ajustada=true` para o front avisar o operador (esse campo
// substitui o antigo `usedLastInstallmentFallback` desta fase).
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

// Migration 226 — companies.karate_annuity_plan (plano de anuidade REAL do
// dojô). Backend sobe antes da migration (armadilha_schema_pre_migration do
// CLAUDE.md): cache module-level otimista, vira false em 42703 e a query
// de elegibilidade cai para a forma sem a coluna (dojo aparece com
// karate_annuity_plan: null — que É o estado real "indefinido").
let HAS_ANNUITY_PLAN_COL = true;

// ── Elegibilidade — SQL é a fonte única (ver cabeçalho do arquivo). ────────
// Dojô: ativo (afiliado) E sem anuidade na temporada. Traz também
// karate_annuity_plan (F2 do bug de produto — ver cabeçalho do arquivo e
// karateAnnuityService.resolveDojoPlan): é o plano REAL que a campanha
// passa a usar em vez do default 'anual' fixo.
const DOJO_ELIGIBLE_SQL = `
  SELECT c.id AS dojo_id, c.name, c.karate_annuity_plan
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

// Fallback sem karate_annuity_plan (Migration 226 ainda não aplicada neste
// deploy) — mesmas condições, mesmo shape de linha exceto a coluna extra
// (o chamador trata como karate_annuity_plan: undefined → null).
const DOJO_ELIGIBLE_SQL_LEGACY = `
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
  if (HAS_ANNUITY_PLAN_COL) {
    try {
      const { rows } = await runner.query(DOJO_ELIGIBLE_SQL, [federationId, year, excludeIds]);
      return rows;
    } catch (e) {
      if (e.code === '42703') {
        HAS_ANNUITY_PLAN_COL = false;
        console.warn('[karateAnnuityCampaign] karate_annuity_plan ausente (Migration 226 pendente) — fallback sem coluna');
      } else throw e;
    }
  }
  const { rows } = await runner.query(DOJO_ELIGIBLE_SQL_LEGACY, [federationId, year, excludeIds]);
  return rows.map((r) => ({ ...r, karate_annuity_plan: null }));
}

async function fetchEligiblePractitioners(client, federationId, year, excludeIds) {
  const runner = client || db;
  const { rows } = await runner.query(PRACTITIONER_ELIGIBLE_SQL, [federationId, year, excludeIds]);
  return rows;
}

// ── Monta as parcelas de um alvo de campanha (ver nota no cabeçalho sobre
// o default seguro "todas as parcelas já venceram → gera a última, a
// vencer" e o override explícito de due_date). Wrapper fino sobre
// annuitySvc.buildPlanSpecs — MESMO motor usado pelo /charge individual;
// mantém o nome `buildCampaignSpecs` por compatibilidade com
// router.__testables / testes existentes.
function buildCampaignSpecs({ plan, amount, dueMonths, seasonYear, dueDateOverride }) {
  const { specs, dueDateAdjusted } = annuitySvc.buildPlanSpecs({
    plan, amount, dueMonths, seasonYear, fromDate: new Date(), dueDateOverride,
  });
  return { specs, due_date_ajustada: dueDateAdjusted };
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
async function createAnnuityForTarget(client, { type, id, name, federationId, year, plan, fee, dueDateOverride }) {
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
  const { specs, due_date_ajustada } = buildCampaignSpecs({
    plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear, dueDateOverride,
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
    due_date: specs[0].due_date,
    due_date_ajustada,
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
        due_date: r.due_date,
        due_date_ajustada: r.due_date_ajustada,
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
    let rows;
    if (HAS_ANNUITY_PLAN_COL) {
      try {
        ({ rows } = await client.query(
          `SELECT id, name, COALESCE(is_active, false) AS is_active, karate_annuity_plan
           FROM companies
           WHERE id = $1 AND federation_id = $2 AND vertical_active = 'karate_dojo'
           LIMIT 1`,
          [id, federationId]
        ));
      } catch (e) {
        if (e.code === '42703') {
          HAS_ANNUITY_PLAN_COL = false;
          console.warn('[karateAnnuityCampaign] karate_annuity_plan ausente em loadTargetInfo (Migration 226 pendente)');
        } else throw e;
      }
    }
    if (rows === undefined) {
      ({ rows } = await client.query(
        `SELECT id, name, COALESCE(is_active, false) AS is_active
         FROM companies
         WHERE id = $1 AND federation_id = $2 AND vertical_active = 'karate_dojo'
         LIMIT 1`,
        [id, federationId]
      ));
    }
    if (!rows.length) return { found: false };
    const isActive = rows[0].is_active;
    return {
      found: true, name: rows[0].name, eligible: isActive,
      ineligibleReason: isActive ? null : 'dojo_inativo',
      karate_annuity_plan: rows[0].karate_annuity_plan || null,
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
// { year, scope: 'dojos'|'practitioners'|'both', due_date? }
// Read-only — é o preview que protege o usuário: os números aqui são os que
// a UI mostra antes do commit, então usam a MESMA query de elegibilidade e
// o MESMO cálculo de parcelas (com o MESMO due_date, se informado) que
// /campaign vai usar de fato. Cada alvo devolve `due_date` (o vencimento
// que SERÁ usado, já com o default seguro aplicado quando todas as
// parcelas do plano já venceram) e `due_date_ajustada` (true quando esse
// due_date difere do vencimento natural do plano — default seguro ou
// override) para a UI avisar o operador antes de confirmar.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/campaign/preview', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { year: rawYear, scope: rawScope, due_date: rawDueDate, dojo_plans: rawDojoPlans } = req.body || {};
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
  const dueDateCheck = annuitySvc.validateDueDateOverride(rawDueDate, seasonYear);
  if (!dueDateCheck.valid) {
    return res.status(422).json({ error: dueDateCheck.error, code: 'VALIDATION_ERROR' });
  }
  const dueDateOverride = dueDateCheck.value;
  const wantDojos = scope === 'dojos' || scope === 'both';
  const wantPractitioners = scope === 'practitioners' || scope === 'both';
  // dojo_plans (opcional): { [dojo_id]: 'anual'|'semestral'|'trimestral' } —
  // permite a UI "definir o plano direto no preview" (requisito F2 do
  // wizard): o operador escolhe o plano de um dojô indefinido inline, o
  // wizard rechama o preview com esse mapa, e os números REAIS (valor,
  // parcelas, vencimento) voltam recalculados sem sair do passo. Nada aqui
  // é persistido — só POST /campaign com o mesmo mapa grava de verdade.
  const dojoPlansOverride = (rawDojoPlans && typeof rawDojoPlans === 'object' && !Array.isArray(rawDojoPlans))
    ? rawDojoPlans
    : {};

  try {
    let dojos = [];
    let practitioners = [];
    let planCatalog = [];

    if (wantDojos) {
      const rows = await fetchEligibleDojos(null, federationId, year, []);
      // Catálogo dos 3 planos (mesmo cálculo pra todo mundo no mesmo
      // ano/due_date) — evita recalcular o mesmo plano N vezes para N
      // dojôs, e dá pro front renderizar um seletor inline com números
      // reais (sem nova chamada) para os dojôs indefinidos.
      const catalog = {};
      for (const plan of annuitySvc.VALID_PLANS) {
        const fee = await annuitySvc.getVigentFee(null, federationId, 'dojo', plan);
        if (!fee) {
          catalog[plan] = {
            plan, fee_configurada: false, amount: 0,
            due_date: null, due_date_ajustada: false, installments_count: 0,
          };
          continue;
        }
        const built = buildCampaignSpecs({
          plan, amount: fee.amount, dueMonths: fee.due_months, seasonYear, dueDateOverride,
        });
        catalog[plan] = {
          plan, fee_configurada: true, amount: specsTotal(built.specs),
          due_date: built.specs[0] ? built.specs[0].due_date : null,
          due_date_ajustada: built.due_date_ajustada,
          installments_count: built.specs.length,
        };
      }
      planCatalog = annuitySvc.VALID_PLANS.map((p) => catalog[p]);

      // Precedência (ver karateAnnuityService.resolveDojoPlan): dojo_plans
      // deste request > karate_annuity_plan cadastrado no dojô > indefinido
      // (NUNCA 'anual' silencioso). Cada dojô sai com o SEU plano real —
      // um trimestral aparece com o total/parcelas do trimestral, não R$500.
      dojos = rows.map((r) => {
        const explicitPlan = dojoPlansOverride[r.dojo_id];
        const effectivePlan = annuitySvc.resolveDojoPlan(explicitPlan, r.karate_annuity_plan);
        if (!effectivePlan) {
          return {
            dojo_id: r.dojo_id, name: r.name, plan: null, plano_indefinido: true,
            amount: 0, due_date: null, due_date_ajustada: false, installments_count: 0,
          };
        }
        const c = catalog[effectivePlan];
        return {
          dojo_id: r.dojo_id, name: r.name, plan: effectivePlan, plano_indefinido: false,
          amount: c.amount, due_date: c.due_date, due_date_ajustada: c.due_date_ajustada,
          installments_count: c.installments_count, fee_configurada: c.fee_configurada,
        };
      });
    }

    if (wantPractitioners) {
      // Praticante SEMPRE plano 'anual' N=1 (regra inviolável — não confundir
      // com o plano do dojô; ver cabeçalho do arquivo e CLAUDE.md).
      const rows = await fetchEligiblePractitioners(null, federationId, year, []);
      const fee = await annuitySvc.getVigentFee(null, federationId, 'cpf', 'anual');
      let amount = 0;
      let dueDate = null;
      let dueDateAdjusted = false;
      if (fee) {
        const built = buildCampaignSpecs({
          plan: 'anual', amount: fee.amount, dueMonths: fee.due_months, seasonYear, dueDateOverride,
        });
        amount = specsTotal(built.specs);
        dueDate = built.specs[0] ? built.specs[0].due_date : null;
        dueDateAdjusted = built.due_date_ajustada;
      }
      practitioners = rows.map((r) => ({
        practitioner_id: r.practitioner_id,
        name: r.name,
        karate_registration_number: r.karate_registration_number || null,
        amount,
        due_date: dueDate,
        due_date_ajustada: dueDateAdjusted,
      }));
    }

    // valor_previsto só soma alvos com plano DEFINIDO — um dojô indefinido
    // não tem valor conhecido ainda (poderia ser R$500, R$560 ou R$600) até
    // a federação escolher; somar um chute quebraria a promessa do preview
    // ("os números aqui são os que /campaign vai usar de fato").
    const dojosPlanoIndefinidoCount = dojos.filter((d) => d.plano_indefinido).length;
    const valor_previsto = round2(
      dojos.filter((d) => !d.plano_indefinido).reduce((s, d) => s + Number(d.amount), 0) +
      practitioners.reduce((s, p) => s + Number(p.amount), 0)
    );

    res.json({
      dojos,
      practitioners,
      plan_catalog: planCatalog,
      totals: {
        dojos_count: dojos.length,
        dojos_plano_indefinido_count: dojosPlanoIndefinidoCount,
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
// { year, scope: 'dojos'|'practitioners'|'both', exclude: { dojo_ids[], practitioner_ids[] }, due_date? }
//
// `due_date` (opcional, ISO AAAA-MM-DD) sobrescreve o vencimento da
// PRIMEIRA parcela gerada de CADA alvo processado nesta chamada (dojôs E
// praticantes, se scope='both') — mesma semântica usada pelo /batch e pelo
// /charge individual (ver buildPlanSpecs em karateAnnuityService.js).
// Semântica adotada (documentada por ser potencialmente ambígua — ver PR):
// um único `due_date` por chamada, aplicado uniformemente a todos os alvos
// da rodada, e não um mapa de overrides por alvo — a campanha já processa
// N alvos elegíveis de uma vez sem que o operador escolha individualmente
// quem entra, então "a rodada vence em X" é a única leitura consistente com
// o restante do contrato do endpoint (scope + exclude, não uma lista
// endereçável de alvos). Precisa ser do mesmo ano da temporada (`year`).
// ────────────────────────────────────────────────────────────────
router.post('/annuities/campaign', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { year: rawYear, scope: rawScope, exclude, due_date: rawDueDate, dojo_plans: rawDojoPlans } = req.body || {};
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
  const dueDateCheck = annuitySvc.validateDueDateOverride(rawDueDate, parseInt(year, 10));
  if (!dueDateCheck.valid) {
    return res.status(422).json({ error: dueDateCheck.error, code: 'VALIDATION_ERROR' });
  }
  const dueDateOverride = dueDateCheck.value;
  // dojo_plans (opcional): { [dojo_id]: plan } — o mesmo mapa que o preview
  // aceita para "definir o plano direto no preview" (ver comentário lá).
  // Aqui ele vira DEFINIÇÃO DE VERDADE: se o dojô ainda não tinha
  // karate_annuity_plan salvo, gravamos o valor escolhido nesta rodada
  // (companies.karate_annuity_plan) — a próxima campanha já não vê esse
  // dojô como indefinido. Se o dojô JÁ tinha um plano salvo e dojo_plans
  // manda outro, o valor do request vale só PARA ESTA cobrança (override
  // pontual) e o cadastro do dojô não é tocado — mudar o plano permanente
  // é uma ação deliberada separada (PATCH do dojô).
  const dojoPlansOverride = (rawDojoPlans && typeof rawDojoPlans === 'object' && !Array.isArray(rawDojoPlans))
    ? rawDojoPlans
    : {};

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

    // Fee de dojô agora é buscada POR PLANO (não mais fixa 'anual') — cache
    // simples por plano dentro desta chamada, já que N dojôs podem
    // compartilhar o mesmo plano.
    const dojoFeeCache = {};
    async function getDojoFeeCached(plan) {
      if (!(plan in dojoFeeCache)) {
        dojoFeeCache[plan] = await annuitySvc.getVigentFee(client, federationId, 'dojo', plan);
      }
      return dojoFeeCache[plan];
    }
    const practFee = wantPractitioners ? await annuitySvc.getVigentFee(client, federationId, 'cpf', 'anual') : null;

    if (wantDojos) {
      const dojos = await fetchEligibleDojos(client, federationId, year, excludeDojoIds);
      for (const d of dojos) {
        const explicitPlan = dojoPlansOverride[d.dojo_id];
        const effectivePlan = annuitySvc.resolveDojoPlan(explicitPlan, d.karate_annuity_plan);
        if (!effectivePlan) {
          // NUNCA assume 'anual' — o wizard já deveria ter forçado a
          // definição/exclusão deste dojô (ver Step3Review no app), mas o
          // backend é o backstop final contra qualquer chamador que pule o
          // wizard (curl/Postman/corrida entre preview e confirmação).
          errors.push({ type: 'dojo', id: d.dojo_id, name: d.name, reason: annuitySvc.PLANO_INDEFINIDO_REASON });
          continue;
        }
        if (explicitPlan && !d.karate_annuity_plan && HAS_ANNUITY_PLAN_COL) {
          try {
            await client.query(`UPDATE companies SET karate_annuity_plan = $1 WHERE id = $2`, [effectivePlan, d.dojo_id]);
          } catch (e) {
            if (e.code === '42703') {
              HAS_ANNUITY_PLAN_COL = false;
              console.warn('[karateAnnuityCampaign] karate_annuity_plan ausente ao persistir definição inline (Migration 226 pendente)');
            } else throw e;
          }
        }
        const fee = await getDojoFeeCached(effectivePlan);
        await runTarget(client, {
          type: 'dojo', id: d.dojo_id, name: d.name, federationId, year, plan: effectivePlan, fee, dueDateOverride,
        }, { created, skipped, errors });
      }
    }

    if (wantPractitioners) {
      const practs = await fetchEligiblePractitioners(client, federationId, year, excludePractitionerIds);
      for (const p of practs) {
        await runTarget(client, {
          type: 'practitioner', id: p.practitioner_id, name: p.name, federationId, year, plan: 'anual', fee: practFee, dueDateOverride,
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
// { targets: [{ type: 'dojo'|'practitioner', id }], year, plan?, due_date? }
// Mesmo motor da campanha, para a multi-seleção manual da tabela. `plan`
// (opcional, default 'anual') só afeta alvos type='dojo' — CPF só tem o
// plano 'anual'. Cada alvo é REVALIDADO contra o banco (ver loadTargetInfo)
// — nunca confia que a UI só mandou elegíveis. `due_date` (opcional, ISO
// AAAA-MM-DD) segue a MESMA semântica de /campaign: um único valor por
// chamada, aplicado à primeira parcela gerada de CADA alvo do lote (dojô
// ou praticante) — não um override por linha da tabela. Precisa ser do
// mesmo ano de `year`.
// ────────────────────────────────────────────────────────────────
router.post('/annuities/batch', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { targets, year: rawYear, plan: rawPlan, due_date: rawDueDate } = req.body || {};
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
    if (t.plan && !annuitySvc.VALID_PLANS.includes(t.plan)) {
      return res.status(422).json({
        error: `plan inválido em um dos targets. Valores aceitos: ${annuitySvc.VALID_PLANS.join(', ')}`,
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
  const dueDateCheck = annuitySvc.validateDueDateOverride(rawDueDate, parseInt(year, 10));
  if (!dueDateCheck.valid) {
    return res.status(422).json({ error: dueDateCheck.error, code: 'VALIDATION_ERROR' });
  }
  const dueDateOverride = dueDateCheck.value;

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

    const dojoFeeCache = {};
    async function getDojoFeeCached(plan) {
      if (!(plan in dojoFeeCache)) {
        dojoFeeCache[plan] = await annuitySvc.getVigentFee(client, federationId, 'dojo', plan);
      }
      return dojoFeeCache[plan];
    }
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
        // Precedência (ver karateAnnuityService.resolveDojoPlan): plan DESTE
        // target > plan global do body (legado, aplicado a todo alvo dojô
        // do lote quando informado) > karate_annuity_plan cadastrado no
        // dojô > indefinido — NUNCA 'anual' silencioso.
        const explicitPlan = t.plan || rawPlan || null;
        plan = annuitySvc.resolveDojoPlan(explicitPlan, info.karate_annuity_plan);
        if (!plan) {
          errors.push({ type: 'dojo', id: t.id, name: info.name, reason: annuitySvc.PLANO_INDEFINIDO_REASON });
          continue;
        }
        if (explicitPlan && !info.karate_annuity_plan && HAS_ANNUITY_PLAN_COL) {
          try {
            await client.query(`UPDATE companies SET karate_annuity_plan = $1 WHERE id = $2`, [plan, t.id]);
          } catch (e) {
            if (e.code === '42703') {
              HAS_ANNUITY_PLAN_COL = false;
              console.warn('[karateAnnuityCampaign] karate_annuity_plan ausente ao persistir definição inline no /batch (Migration 226 pendente)');
            } else throw e;
          }
        }
        fee = await getDojoFeeCached(plan);
      } else {
        plan = 'anual';
        if (!practFeeLoaded) {
          practFee = await annuitySvc.getVigentFee(client, federationId, 'cpf', 'anual');
          practFeeLoaded = true;
        }
        fee = practFee;
      }

      await runTarget(client, {
        type: t.type, id: t.id, name: info.name, federationId, year, plan, fee, dueDateOverride,
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
