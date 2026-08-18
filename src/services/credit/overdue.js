// =============================================================
// AURA. -- Crediario: REGRA UNICA DE ATRASO
//
// Relato Valen (18/08/2026, cliente "livia aline"): a ficha mostrava
// "Em atraso" no topo enquanto os DOIS carnes mostravam "Em dia".
// Causa: existiam TRES regras diferentes de atraso convivendo --
//   (a) GET /credit/balances        -> por DATA (correta)
//   (b) accounts[].overdue          -> por DATA (correta)
//   (c) ficha + KPIs + top_defaulters -> credit_installments.status CRU
// O status cru so e sincronizado quando alguem abre GET /credit/installments,
// GET /credit/dashboard ou edita um vencimento. Entre um evento e outro ele
// fica CONGELADO: parcela com vencimento em 2027 continuava com status
// 'overdue' e a ficha gritava "Em atraso" (23 parcelas da livia estavam
// exatamente nesse estado).
//
// A partir daqui existe UMA regra so, aqui. Uma parcela esta EM ATRASO
// quando as QUATRO condicoes valem ao mesmo tempo:
//
//   1. ABERTA      status IN ('pending','overdue')
//   2. COM RESIDUO amount_due - covered_amount > RESIDUE_TOLERANCE
//                  (evita "74 dias em atraso" por R$1,50 de arredondamento)
//   3. VENCIDA     due_date < hoje_SP - carencia (late_grace_days, default 3)
//                  mesma carencia que o motor de encargos ja usa -- antes a
//                  tag acusava atraso em dia que nao gerava nem multa
//   4. NAO RETROATIVA  due_date >= data de criacao da parcela
//                  parcela cadastrada HOJE vencendo ONTEM e carne historico
//                  sendo digitalizado, nao inadimplencia. Na Valen isso era
//                  11 das 24 parcelas vencidas. Essas viram "A conferir".
//
// O status persistido continua existindo (indices, relatorios legados), mas
// NENHUMA leitura de atraso deve depender dele. Sempre use daqui.
// =============================================================

/** Carencia padrao em dias quando a loja nao configurou late_grace_days. */
const DEFAULT_GRACE_DAYS = 3;

/** Residuo (R$) que ainda conta como parcela quitada. */
const RESIDUE_TOLERANCE = 2.0;

/** Hoje no dia-calendario de America/Sao_Paulo, como expressao SQL. */
const SP_TODAY = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

function resolveGraceDays(config) {
  const g = Number(config?.late_grace_days);
  return Number.isFinite(g) && g >= 0 ? Math.floor(g) : DEFAULT_GRACE_DAYS;
}

/**
 * Expressao SQL booleana "esta parcela esta EM ATRASO?".
 * @param {object}  opts
 * @param {string}  opts.alias      prefixo da tabela (ex.: 'ci'). Default: sem prefixo.
 * @param {number}  opts.graceDays  carencia em dias (use resolveGraceDays(config)).
 * @param {number}  opts.tolerance  residuo tolerado em R$.
 */
function overdueSql(opts) {
  const o = opts || {};
  const p = o.alias ? o.alias + '.' : '';
  const grace = Number.isFinite(o.graceDays) ? Math.floor(o.graceDays) : DEFAULT_GRACE_DAYS;
  const tol = Number.isFinite(o.tolerance) ? o.tolerance : RESIDUE_TOLERANCE;
  return `(
    ${p}status IN ('pending','overdue')
    AND (${p}amount_due - COALESCE(${p}covered_amount, 0)) > ${tol}
    AND ${p}due_date < (${SP_TODAY} - ${grace})
    AND ${p}due_date >= (${p}created_at AT TIME ZONE 'America/Sao_Paulo')::date
  )`;
}

/**
 * Expressao SQL booleana "parcela retroativa vencida" -- o carne foi cadastrado
 * DEPOIS do vencimento. Nao e atraso: e historico que a loja precisa conferir.
 */
function toReviewSql(opts) {
  const o = opts || {};
  const p = o.alias ? o.alias + '.' : '';
  const tol = Number.isFinite(o.tolerance) ? o.tolerance : RESIDUE_TOLERANCE;
  return `(
    ${p}status IN ('pending','overdue')
    AND (${p}amount_due - COALESCE(${p}covered_amount, 0)) > ${tol}
    AND ${p}due_date < ${SP_TODAY}
    AND ${p}due_date < (${p}created_at AT TIME ZONE 'America/Sao_Paulo')::date
  )`;
}

/** Hoje (ou asOf) no dia-calendario de America/Sao_Paulo, 'YYYY-MM-DD'. */
function todaySp(asOf) {
  const ref = asOf instanceof Date ? asOf : (asOf ? new Date(asOf) : new Date());
  if (isNaN(ref.getTime())) return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return ref.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
}

/**
 * Versao JS da mesma regra -- para enriquecer payloads ja carregados.
 * Espelha overdueSql/toReviewSql bit a bit. Nunca lanca.
 *
 * @returns {{ is_overdue: boolean, needs_review: boolean, days_late: number, remaining: number }}
 *   days_late e o atraso REAL em dias (sem carencia), so para exibicao.
 */
function classifyInstallment(inst, config, asOf) {
  const out = { is_overdue: false, needs_review: false, days_late: 0, remaining: 0 };
  try {
    const status = inst && inst.status;
    const remaining = Math.round(
      ((Number(inst?.amount_due) || 0) - (Number(inst?.covered_amount) || 0)) * 100
    ) / 100;
    out.remaining = remaining;
    if (status !== 'pending' && status !== 'overdue') return out;

    const due = ymd(inst?.due_date);
    if (!due) return out;

    const today = todaySp(asOf);
    const late = daysBetween(due, today);
    out.days_late = Math.max(0, late);

    if (remaining <= RESIDUE_TOLERANCE) return out;
    if (late <= 0) return out;

    // Retroativa: parcela cadastrada depois do proprio vencimento.
    const created = ymd(inst?.created_at);
    if (created && due < created) {
      out.needs_review = true;
      return out;
    }

    out.is_overdue = late > resolveGraceDays(config);
    return out;
  } catch (_) {
    return out;
  }
}

module.exports = {
  DEFAULT_GRACE_DAYS,
  RESIDUE_TOLERANCE,
  SP_TODAY,
  resolveGraceDays,
  overdueSql,
  toReviewSql,
  classifyInstallment,
  todaySp,
};
