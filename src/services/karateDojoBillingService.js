// ============================================================
// AURA DOJÔ — F3a: Service do motor de mensalidades (CHARGE-BASED)
//
// DECISÃO CENTRAL (19/07/2026): a mensalidade do dojô é CHARGE-BASED —
// gera-se a cobrança do mês (competência) e o aluno paga UM PIX por
// cobrança. Pix Automático (débito recorrente) só entra em outubro; até
// lá NÃO há assinatura de cartão nem cobrança recorrente no provider.
// O RECEBEDOR do PIX é a chave do PRÓPRIO dojô (digital_channel_config do
// company do dojô, mesmos campos da migration 088) — BaaS Asaas (subconta
// + split) fica OPCIONAL/FUTURO atrás do karatePaymentProvider (seam já
// existente). Nada aqui fala com Asaas hoje.
//
// F3b (19/07/2026): a Conta Aura do dojô (BaaS via subconta Asaas) é OPT-IN
// e atrás da flag DOJO_BAAS_ENABLED. createChargePix resolve o provider
// EFETIVO: com a flag ligada E o dojô tendo escolhido 'baas' E a subconta
// aprovada, a cobrança PIX é criada NA SUBCONTA do dojô (com split de 0,5%
// pra conta-mãe) via karateDojoBaasService; senão, segue o caminho pix_manual
// (chave própria). resolveActiveBaas NÃO toca o banco com a flag desligada.
//
// Escopo SEMPRE por req.dojoId (o company do dojô) — nunca do body/query.
// Migration 243 (karate_dojo_billing_plans/_subscriptions/_charges). As
// rotas tratam 42P01 (schema pendente) — aqui só propagamos o erro.
//
// overdue é DERIVADO na leitura: o banco só guarda pending/paid/cancelled;
// uma cobrança pending com due_date < hoje é devolvida como 'overdue' sem
// nunca escrever 'overdue' no banco. Datas são date-puras (to_char /
// make_date / comparação de string YYYY-MM-DD) — tz-safe, nunca
// new Date('YYYY-MM-DD').
// ============================================================
'use strict';

const db = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');
const { createPixChargeForCompany } = require('./karatePaymentProvider');
const { signPixToken } = require('./karatePixPublicToken');
const baasSvc = require('./karateDojoBaasService');

const env = validateRuntimeEnv();

const VALID_METHODS = ['pix', 'dinheiro', 'cartao', 'outro'];

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// ── Datas (tz-safe: componentes locais, string YYYY-MM-DD) ──
function todayStr() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidCompetence(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function makeTxid() {
  return ('DJ' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 20);
}

function maskPixKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  if (k.length <= 4) return '••••';
  return `${k.slice(0, 2)}••••${k.slice(-2)}`;
}

// ── Planos ──
function shapePlan(r) {
  return {
    id: r.id,
    name: r.name,
    amount: r.amount != null ? Number(r.amount) : 0,
    due_day: r.due_day != null ? Number(r.due_day) : null,
    active: r.active !== false,
    students_count: r.students_count != null ? Number(r.students_count) : 0,
  };
}

function validatePlanPayload(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (!partial || b.name !== undefined) {
    const name = b.name != null ? String(b.name).trim() : '';
    if (!name) errors.push('Campo name é obrigatório');
    else data.name = name;
  }
  if (!partial || b.amount !== undefined) {
    const a = Number(b.amount);
    if (!Number.isFinite(a) || a <= 0) errors.push('amount deve ser maior que zero');
    else data.amount = a;
  }
  if (!partial || b.due_day !== undefined) {
    const d = Number(b.due_day);
    if (!Number.isInteger(d) || d < 1 || d > 28) errors.push('due_day deve estar entre 1 e 28');
    else data.due_day = d;
  }
  if (partial && b.active !== undefined) {
    data.active = b.active === true || b.active === 'true';
  }
  return { errors, data };
}

async function listPlans(dojoId) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.amount, p.due_day, p.active,
            count(sub.id)::int AS students_count
       FROM karate_dojo_billing_plans p
       LEFT JOIN karate_dojo_subscriptions sub
              ON sub.plan_id = p.id AND sub.canceled_at IS NULL
      WHERE p.dojo_id = $1
      GROUP BY p.id
      ORDER BY p.name ASC
      LIMIT 500`,
    [dojoId]
  );
  return rows.map(shapePlan);
}

async function getPlan(dojoId, planId) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.amount, p.due_day, p.active,
            count(sub.id)::int AS students_count
       FROM karate_dojo_billing_plans p
       LEFT JOIN karate_dojo_subscriptions sub
              ON sub.plan_id = p.id AND sub.canceled_at IS NULL
      WHERE p.id = $1 AND p.dojo_id = $2
      GROUP BY p.id
      LIMIT 1`,
    [planId, dojoId]
  );
  return rows.length ? shapePlan(rows[0]) : null;
}

async function createPlan(dojoId, data) {
  const { rows } = await db.query(
    `INSERT INTO karate_dojo_billing_plans (dojo_id, name, amount, due_day)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, amount, due_day, active`,
    [dojoId, data.name, data.amount, data.due_day]
  );
  const p = shapePlan(rows[0]);
  p.students_count = 0;
  return p;
}

async function updatePlan(dojoId, planId, data) {
  const cols = ['name', 'amount', 'due_day', 'active'];
  const sets = [];
  const vals = [];
  for (const c of cols) {
    if (data[c] !== undefined) {
      vals.push(data[c]);
      sets.push(`${c} = $${vals.length}`);
    }
  }
  if (!sets.length) {
    const p = await getPlan(dojoId, planId);
    if (!p) throw svcError(404, 'NOT_FOUND', 'Plano não encontrado neste dojô');
    return p;
  }
  sets.push('updated_at = now()');
  vals.push(planId, dojoId);
  const upd = await db.query(
    `UPDATE karate_dojo_billing_plans SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
      RETURNING id`,
    vals
  );
  if (!upd.rows.length) throw svcError(404, 'NOT_FOUND', 'Plano não encontrado neste dojô');
  return getPlan(dojoId, planId);
}

// ── Assinaturas ──
const SUB_FIELDS =
  `id, student_id, plan_id, amount, due_day, payer_guardian_id, ` +
  `to_char(active_from, 'YYYY-MM-DD') AS active_from, canceled_at`;

function shapeSubscriptionFlat(r) {
  return {
    id: r.id,
    student_id: r.student_id,
    plan_id: r.plan_id || null,
    amount: r.amount != null ? Number(r.amount) : 0,
    due_day: r.due_day != null ? Number(r.due_day) : null,
    payer_guardian_id: r.payer_guardian_id || null,
    active_from: r.active_from || null,
    canceled_at: r.canceled_at || null,
  };
}

async function subscribeStudent(dojoId, studentId, body) {
  const b = body || {};
  // aluno tem que ser do dojô
  const st = await db.query(
    `SELECT id FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [studentId, dojoId]
  );
  if (!st.rows.length) throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');

  let amount = b.amount;
  let dueDay = b.due_day;
  const planId = b.plan_id != null && String(b.plan_id).trim() !== '' ? String(b.plan_id).trim() : null;
  const payer = b.payer_guardian_id != null && String(b.payer_guardian_id).trim() !== ''
    ? String(b.payer_guardian_id).trim() : null;

  // herança do plano (amount/due_day herdam quando omitidos)
  if (planId) {
    const p = await db.query(
      `SELECT id, amount, due_day FROM karate_dojo_billing_plans WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [planId, dojoId]
    );
    if (!p.rows.length) throw svcError(404, 'PLAN_NOT_FOUND', 'Plano não encontrado neste dojô');
    if (amount === undefined || amount === null || amount === '') amount = Number(p.rows[0].amount);
    if (dueDay === undefined || dueDay === null || dueDay === '') dueDay = Number(p.rows[0].due_day);
  }

  amount = Number(amount);
  dueDay = Number(dueDay);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw svcError(422, 'VALIDATION_ERROR', 'amount deve ser maior que zero (informe amount ou um plan_id com valor)');
  }
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
    throw svcError(422, 'VALIDATION_ERROR', 'due_day deve estar entre 1 e 28');
  }

  if (payer) {
    const g = await db.query(
      `SELECT id FROM karate_dojo_guardians WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [payer, dojoId]
    );
    if (!g.rows.length) throw svcError(422, 'GUARDIAN_NOT_FOUND', 'Responsável pagador não encontrado neste dojô');
  }

  // 1 assinatura ATIVA por aluno (UNIQUE parcial): existe → atualiza, senão cria
  const existing = await db.query(
    `SELECT id FROM karate_dojo_subscriptions
      WHERE student_id = $1 AND dojo_id = $2 AND canceled_at IS NULL LIMIT 1`,
    [studentId, dojoId]
  );
  let row;
  if (existing.rows.length) {
    const upd = await db.query(
      `UPDATE karate_dojo_subscriptions
          SET plan_id = $3, amount = $4, due_day = $5, payer_guardian_id = $6, updated_at = now()
        WHERE id = $1 AND dojo_id = $2
        RETURNING ${SUB_FIELDS}`,
      [existing.rows[0].id, dojoId, planId, amount, dueDay, payer]
    );
    row = upd.rows[0];
  } else {
    const ins = await db.query(
      `INSERT INTO karate_dojo_subscriptions
         (dojo_id, student_id, plan_id, amount, due_day, payer_guardian_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SUB_FIELDS}`,
      [dojoId, studentId, planId, amount, dueDay, payer]
    );
    row = ins.rows[0];
  }
  return shapeSubscriptionFlat(row);
}

async function unsubscribeStudent(dojoId, studentId) {
  const upd = await db.query(
    `UPDATE karate_dojo_subscriptions
        SET canceled_at = now(), updated_at = now()
      WHERE student_id = $1 AND dojo_id = $2 AND canceled_at IS NULL
      RETURNING id`,
    [studentId, dojoId]
  );
  if (!upd.rows.length) throw svcError(404, 'NOT_FOUND', 'Assinatura ativa não encontrada para este aluno');
  return { canceled: true, student_id: studentId };
}

async function listSubscriptions(dojoId) {
  const { rows } = await db.query(
    `SELECT sub.id, sub.student_id, sub.plan_id, sub.amount, sub.due_day,
            sub.payer_guardian_id,
            to_char(sub.active_from, 'YYYY-MM-DD') AS active_from,
            sub.canceled_at,
            s.full_name AS student_name,
            g.full_name AS guardian_name
       FROM karate_dojo_subscriptions sub
       JOIN karate_dojo_students s ON s.id = sub.student_id
       LEFT JOIN karate_dojo_guardians g ON g.id = sub.payer_guardian_id
      WHERE sub.dojo_id = $1 AND sub.canceled_at IS NULL
      ORDER BY s.full_name ASC
      LIMIT 2000`,
    [dojoId]
  );
  return rows.map((r) => {
    const sub = shapeSubscriptionFlat(r);
    sub.student = { id: r.student_id, full_name: r.student_name };
    sub.guardian = r.payer_guardian_id ? { id: r.payer_guardian_id, full_name: r.guardian_name || null } : null;
    return sub;
  });
}

// ── Geração de cobranças (idempotente: UNIQUE subscription_id+competence) ──
async function generateCharges(dojoId, competence) {
  if (!isValidCompetence(competence)) {
    throw svcError(422, 'VALIDATION_ERROR', "competence deve estar no formato 'YYYY-MM'");
  }
  const totalRes = await db.query(
    `SELECT count(*)::int AS n FROM karate_dojo_subscriptions
      WHERE dojo_id = $1 AND canceled_at IS NULL`,
    [dojoId]
  );
  const total = Number(totalRes.rows[0] && totalRes.rows[0].n) || 0;

  // Statement ÚNICO (atômico, sem BEGIN → sem tx-poison). due_date =
  // competência + due_day via make_date (date puro, tz-safe). Snapshot de
  // amount + payer_guardian_id na cobrança. ON CONFLICT DO NOTHING = regerar
  // não duplica; RETURNING conta só as CRIADAS de fato.
  const ins = await db.query(
    `INSERT INTO karate_dojo_charges
       (dojo_id, subscription_id, student_id, guardian_id, competence, amount, due_date, status)
     SELECT sub.dojo_id, sub.id, sub.student_id, sub.payer_guardian_id, $2,
            sub.amount,
            make_date(split_part($2, '-', 1)::int, split_part($2, '-', 2)::int, sub.due_day),
            'pending'
       FROM karate_dojo_subscriptions sub
      WHERE sub.dojo_id = $1 AND sub.canceled_at IS NULL
     ON CONFLICT (subscription_id, competence) DO NOTHING
     RETURNING id`,
    [dojoId, competence]
  );
  const created = ins.rows.length;
  return { created, skipped: Math.max(0, total - created) };
}

// ── Cobranças (list + summary; overdue derivado) ──
const CHARGE_SELECT =
  `SELECT c.id, c.competence, c.amount,
          to_char(c.due_date, 'YYYY-MM-DD') AS due_date,
          c.status, c.paid_at, c.payment_method, c.pix_txid,
          s.id AS student_id, s.full_name AS student_name,
          g.id AS guardian_id, g.full_name AS guardian_name
     FROM karate_dojo_charges c
     JOIN karate_dojo_students s ON s.id = c.student_id
     LEFT JOIN karate_dojo_guardians g ON g.id = c.guardian_id`;

function deriveStatus(rawStatus, dueDateStr, today) {
  if (rawStatus === 'pending' && dueDateStr && dueDateStr < today) return 'overdue';
  return rawStatus;
}

function shapeCharge(r, today) {
  return {
    id: r.id,
    student: { id: r.student_id, full_name: r.student_name },
    guardian: r.guardian_id ? { id: r.guardian_id, full_name: r.guardian_name || null } : null,
    competence: r.competence,
    amount: r.amount != null ? Number(r.amount) : 0,
    due_date: r.due_date || null,
    status: deriveStatus(r.status, r.due_date, today),
    paid_at: r.paid_at || null,
    payment_method: r.payment_method || null,
    has_pix: !!r.pix_txid,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function summarize(list) {
  let total_amount = 0, paid_amount = 0, pending_count = 0, overdue_count = 0, paid_count = 0;
  for (const c of list) {
    if (c.status === 'cancelled') continue; // cancelada não é devida
    total_amount += c.amount;
    if (c.status === 'paid') { paid_amount += c.amount; paid_count++; }
    else if (c.status === 'overdue') overdue_count++;
    else if (c.status === 'pending') pending_count++;
  }
  return {
    total_amount: round2(total_amount),
    paid_amount: round2(paid_amount),
    pending_count,
    overdue_count,
    paid_count,
  };
}

async function listCharges(dojoId, { competence = null, status = null, q = null } = {}) {
  const { rows } = await db.query(
    `${CHARGE_SELECT}
      WHERE c.dojo_id = $1
        AND ($2::text IS NULL OR c.competence = $2)
        AND ($3::text IS NULL OR s.full_name ILIKE '%' || $3 || '%')
      ORDER BY c.competence DESC, s.full_name ASC
      LIMIT 5000`,
    [dojoId, competence, q]
  );
  const today = todayStr();
  const all = rows.map((r) => shapeCharge(r, today));
  const summary = summarize(all);
  const data = status ? all.filter((c) => c.status === status) : all;
  return { data, summary };
}

async function getChargeShaped(dojoId, chargeId) {
  const { rows } = await db.query(
    `${CHARGE_SELECT}
      WHERE c.id = $1 AND c.dojo_id = $2
      LIMIT 1`,
    [chargeId, dojoId]
  );
  return rows.length ? shapeCharge(rows[0], todayStr()) : null;
}

// ── PIX da cobrança (recebedor = chave do DOJÔ; token público reusado) ──
async function getPixConfigRow(dojoId) {
  try {
    const { rows } = await db.query(
      `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city
         FROM digital_channel_config WHERE company_id = $1 LIMIT 1`,
      [dojoId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e && e.code === '42P01') return null; // config ausente → trata como não configurado
    throw e;
  }
}

// F3c: leitura defensiva da cobrança pro PIX. pix_payload (migration 245)
// pode não existir ainda — 42703 cai pro SELECT sem a coluna (sem reuso).
// pix_txid (243) sempre existe.
async function fetchChargeForPix(dojoId, chargeId) {
  const base =
    `SELECT id, amount, competence, status,
            to_char(due_date, 'YYYY-MM-DD') AS due_date, pix_txid`;
  try {
    const { rows } = await db.query(
      `${base}, pix_payload FROM karate_dojo_charges WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [chargeId, dojoId]
    );
    return rows[0] || null;
  } catch (e) {
    if (!(e && e.code === '42703')) throw e;
    const { rows } = await db.query(
      `${base} FROM karate_dojo_charges WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [chargeId, dojoId]
    );
    return rows[0] || null;
  }
}

// F3c: persiste txid + BR Code (pix_payload) BEST-EFFORT. Se pix_payload
// (migration 245) ainda não existe, 42703 cai pro UPDATE só do txid (o
// comportamento pré-F3c), preservando a conciliação.
async function persistPixArtifacts(dojoId, chargeId, txid, payload) {
  try {
    await db.query(
      `UPDATE karate_dojo_charges SET pix_txid = $3, pix_payload = $4, updated_at = now()
        WHERE id = $1 AND dojo_id = $2`,
      [chargeId, dojoId, txid, payload]
    );
  } catch (e) {
    if (e && e.code === '42703') {
      try {
        await db.query(
          `UPDATE karate_dojo_charges SET pix_txid = $3, updated_at = now()
            WHERE id = $1 AND dojo_id = $2`,
          [chargeId, dojoId, txid]
        );
      } catch (_) { /* best-effort */ }
    }
    /* outros erros: best-effort, ignora */
  }
}

async function createChargePix(dojoId, chargeId) {
  const c = await fetchChargeForPix(dojoId, chargeId);
  if (!c) throw svcError(404, 'NOT_FOUND', 'Cobrança não encontrada neste dojô');
  if (c.status === 'cancelled') throw svcError(409, 'CHARGE_CANCELLED', 'Cobrança cancelada não gera PIX');

  const amount = Number(c.amount);
  const existingPayload = c.pix_payload && String(c.pix_payload).trim() ? String(c.pix_payload) : null;

  // Monta a página pública a partir de um BR Code (token stateless — só
  // valor/competência/BR Code, sem dado pessoal).
  const buildPublicUrl = (pixCode) => {
    try {
      const token = signPixToken({ amount, referencePeriod: c.competence, pixCode });
      return `${env.APP_URL}/karate/pix/${token}`;
    } catch (_) { return null; }
  };

  // ── Provider EFETIVO (F3b) ──
  // BaaS (subconta Asaas do dojô) só quando o dojô optou por 'baas', a
  // subconta está aprovada E a flag DOJO_BAAS_ENABLED está ligada.
  // resolveActiveBaas NÃO toca o banco quando a flag está desligada — o
  // caminho pix_manual (F3a) fica idêntico ao de antes.
  const baas = await baasSvc.resolveActiveBaas(dojoId);
  if (baas) {
    // REUSO (F3c): já há BR Code salvo E o pagamento na subconta já foi
    // criado (pix_txid). NUNCA cria um novo payment Asaas a cada clique/
    // lembrete — evita cobranças duplicadas na subconta do dojô.
    if (existingPayload && c.pix_txid) {
      return { payload: existingPayload, public_url: buildPublicUrl(existingPayload), provider: 'baas' };
    }
    let res;
    try {
      res = await baasSvc.createChargePixViaBaas({
        account: baas,
        amount,
        chargeId,
        competence: c.competence,
        dueDate: c.due_date,
      });
    } catch (e) {
      if (e && e.status) throw e;
      // Sem fallback SILENCIOSO pra chave manual: o valor iria pra outro
      // recebedor. O dojô decide trocar o provider nas configurações.
      throw svcError(502, 'BAAS_INDISPONIVEL',
        'Não foi possível gerar o PIX na Conta Aura do dojô agora. Tente novamente ou, ' +
        'nas configurações, troque o recebimento para a chave PIX própria do dojô.');
    }

    // pix_txid = id do pagamento NA SUBCONTA (conciliação via webhook).
    // Salva também o BR Code (pix_payload) pra reuso. Best-effort.
    await persistPixArtifacts(dojoId, chargeId, res.payment_id, res.payload);

    return { payload: res.payload, public_url: buildPublicUrl(res.payload), provider: 'baas' };
  }

  // ── Caminho pix_manual (chave PIX do PRÓPRIO dojô — F3a) ──
  // REUSO (F3c): BR Code salvo → devolve o mesmo (a chave própria não muda
  // o recebedor a cada clique).
  if (existingPayload) {
    return { payload: existingPayload, public_url: buildPublicUrl(existingPayload), provider: 'pix_manual' };
  }

  const cfg = await getPixConfigRow(dojoId);
  if (!cfg || !cfg.pix_key || !String(cfg.pix_key).trim()) {
    throw svcError(409, 'PIX_NAO_CONFIGURADO', 'O dojô ainda não configurou uma chave PIX de recebimento');
  }

  const txid = makeTxid();
  const charge = await createPixChargeForCompany({
    companyId: dojoId,
    amount,
    txid,
    description: `Mensalidade ${c.competence}`,
  });
  const pixCode = charge && charge.payload;
  if (!pixCode) throw svcError(502, 'PIX_PROVIDER_ERROR', 'Falha ao gerar o código PIX');

  // Guarda txid + BR Code pra conciliação/reuso — BEST-EFFORT (fora de
  // qualquer transação; nunca deixa a falha aqui derrubar a geração do PIX).
  await persistPixArtifacts(dojoId, chargeId, txid, pixCode);

  return { payload: pixCode, public_url: buildPublicUrl(pixCode), provider: 'pix_manual' };
}

// ── Baixa manual / cancelamento (idempotentes) ──
function normalizeMethod(method) {
  if (method === undefined || method === null || method === '') return 'dinheiro';
  if (!VALID_METHODS.includes(method)) {
    throw svcError(422, 'VALIDATION_ERROR', `method inválido. Use: ${VALID_METHODS.join(', ')}`);
  }
  return method;
}

async function confirmCharge(dojoId, chargeId, method) {
  const m = normalizeMethod(method);
  const cur = await db.query(
    `SELECT id, status FROM karate_dojo_charges WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [chargeId, dojoId]
  );
  if (!cur.rows.length) throw svcError(404, 'NOT_FOUND', 'Cobrança não encontrada neste dojô');
  if (cur.rows[0].status === 'paid') {
    const full = await getChargeShaped(dojoId, chargeId);
    return Object.assign({ already_paid: true }, full);
  }
  if (cur.rows[0].status === 'cancelled') {
    throw svcError(409, 'CHARGE_CANCELLED', 'Cobrança cancelada não pode ser confirmada');
  }
  await db.query(
    `UPDATE karate_dojo_charges
        SET status = 'paid', paid_at = now(), payment_method = $3, updated_at = now()
      WHERE id = $1 AND dojo_id = $2 AND status = 'pending'`,
    [chargeId, dojoId, m]
  );
  const full = await getChargeShaped(dojoId, chargeId);
  return Object.assign({ already_paid: false }, full);
}

async function cancelCharge(dojoId, chargeId) {
  const cur = await db.query(
    `SELECT id, status FROM karate_dojo_charges WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [chargeId, dojoId]
  );
  if (!cur.rows.length) throw svcError(404, 'NOT_FOUND', 'Cobrança não encontrada neste dojô');
  if (cur.rows[0].status === 'paid') {
    throw svcError(409, 'CHARGE_ALREADY_PAID', 'Cobrança já paga não pode ser cancelada');
  }
  if (cur.rows[0].status === 'cancelled') {
    const full = await getChargeShaped(dojoId, chargeId);
    return Object.assign({ already_cancelled: true }, full);
  }
  await db.query(
    `UPDATE karate_dojo_charges
        SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND dojo_id = $2 AND status = 'pending'`,
    [chargeId, dojoId]
  );
  const full = await getChargeShaped(dojoId, chargeId);
  return Object.assign({ already_cancelled: false }, full);
}

// ── Config PIX do dojô (digital_channel_config por company_id do dojô) ──
async function getConfig(dojoId) {
  const row = await getPixConfigRow(dojoId);
  const key = row && row.pix_key ? String(row.pix_key).trim() : '';
  return {
    pix_configured: !!key,
    pix_key_masked: key ? maskPixKey(key) : null,
    pix_key_type: (row && row.pix_key_type) || null,
  };
}

const VALID_PIX_KEY_TYPES = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM', 'EVP'];

async function putConfig(dojoId, body) {
  const b = body || {};
  const pixKey = b.pix_key != null ? String(b.pix_key).trim() : '';
  if (!pixKey) throw svcError(422, 'VALIDATION_ERROR', 'pix_key é obrigatório');
  let pixKeyType = b.pix_key_type != null && String(b.pix_key_type).trim() !== ''
    ? String(b.pix_key_type).trim().toUpperCase() : null;
  if (pixKeyType && !VALID_PIX_KEY_TYPES.includes(pixKeyType)) {
    throw svcError(422, 'VALIDATION_ERROR', `pix_key_type inválido. Use: ${VALID_PIX_KEY_TYPES.join(', ')}`);
  }

  // upsert sem depender de UNIQUE em company_id: UPDATE e, se nada mudou,
  // INSERT só das colunas de PIX (migration 088). digital_channel_config já
  // existe há muito (Canal Digital) — não referenciamos colunas fora da 088.
  const upd = await db.query(
    `UPDATE digital_channel_config SET pix_key = $2, pix_key_type = $3
      WHERE company_id = $1
      RETURNING company_id`,
    [dojoId, pixKey, pixKeyType]
  );
  if (!upd.rows.length) {
    await db.query(
      `INSERT INTO digital_channel_config (company_id, pix_key, pix_key_type)
       VALUES ($1, $2, $3)`,
      [dojoId, pixKey, pixKeyType]
    );
  }
  return getConfig(dojoId);
}

module.exports = {
  VALID_METHODS,
  validatePlanPayload,
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  subscribeStudent,
  unsubscribeStudent,
  listSubscriptions,
  generateCharges,
  listCharges,
  getChargeShaped,
  createChargePix,
  confirmCharge,
  cancelCharge,
  getConfig,
  putConfig,
};
