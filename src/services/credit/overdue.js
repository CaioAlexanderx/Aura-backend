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
// Relato Valen (21/08/2026): o OPOSTO -- clientes que ENTRARAM em atraso nao
// acendiam. Duas causas, ambas nesta regra:
//   (i)  a carencia era aplicada mesmo com o motor de encargos DESLIGADO
//        (late_charges_enabled=false, hoje o caso de 100% das lojas). O
//        argumento original -- "nao acusar atraso em dia que nao gera multa"
//        -- so existe quando a loja de fato cobra multa. Sem encargos nao ha
//        dia de gratuidade nenhum: atraso e desde o dia 1.
//        Na Valen isso escondia 39 parcelas / 35 clientes / R$14.560.
//   (ii) a excecao "parcela retroativa" NUNCA expirava. Parcela lancada depois
//        do proprio vencimento ficava "A conferir" para sempre -- havia
//        parcela com 77 dias de atraso pintada de ambar. Agora a excecao vale
//        so na JANELA DE CONFERENCIA (REVIEW_WINDOW_DAYS) apos o cadastro;
//        passada a janela sem baixa, e inadimplencia como qualquer outra.
//        Na Valen isso escondia mais 8 parcelas / 6 clientes / R$1.057.
//
// A partir daqui existe UMA regra so, aqui. Uma parcela esta EM ATRASO
// quando as QUATRO condicoes valem ao mesmo tempo:
//
//   1. ABERTA      status IN ('pending','overdue')
//   2. COM RESIDUO amount_due - covered_amount > RESIDUE_TOLERANCE
//                  (evita "74 dias em atraso" por R$1,50 de arredondamento)
//   3. VENCIDA     due_date < hoje_SP - carencia_do_SINAL
//                  carencia_do_SINAL = late_grace_days SO quando a loja cobra
//                  encargos (late_charges_enabled=true); caso contrario 0.
//   4. CONFERIDA   due_date >= data de criacao da parcela
//                  OU ja passou a janela de conferencia desde o cadastro.
//                  Parcela cadastrada HOJE vencendo ONTEM e carne historico
//                  sendo digitalizado -- a loja ganha REVIEW_WINDOW_DAYS para
//                  conferir e dar baixa. Depois disso, conta como atraso.
//
// O status persistido continua existindo (indices, relatorios legados), mas
// NENHUMA leitura de atraso deve depender dele. Sempre use daqui.
// =============================================================

/** Carencia padrao em dias quando a loja nao configurou late_grace_days. */
const DEFAULT_GRACE_DAYS = 3;

/** Residuo (R$) que ainda conta como parcela quitada. */
const RESIDUE_TOLERANCE = 2.0;

/**
 * Dias que a loja tem para conferir um carne cadastrado ja vencido antes de
 * ele passar a contar como atraso. E uma janela de trabalho, nao um perdao.
 */
const REVIEW_WINDOW_DAYS = 7;

/** Hoje no dia-calendario de America/Sao_Paulo, como expressao SQL. */
const SP_TODAY = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

/** Carencia de ENCARGOS da loja -- a mesma que services/credit/lateCharges usa. */
function resolveGraceDays(config) {
  const g = Number(config?.late_grace_days);
  return Number.isFinite(g) && g >= 0 ? Math.floor(g) : DEFAULT_GRACE_DAYS;
}

/**
 * Carencia que vale para o SINAL de atraso. So existe quando a loja realmente
 * cobra mora/multa -- sem encargos ligados nao ha "dia sem multa" a respeitar,
 * e o cliente entra em atraso no dia seguinte ao vencimento.
 */
function signalGraceDays(config) {
  return config && config.late_charges_enabled === true ? resolveGraceDays(config) : 0;
}

/**
 * Expressao SQL booleana "esta parcela esta EM ATRASO?".
 * @param {object}  opts
 * @param {string}  opts.alias      prefixo da tabela (ex.: 'ci'). Default: sem prefixo.
 * @param {number}  opts.graceDays  carencia do sinal (use signalGraceDays(config)).
 *                                  Omitido = 0: sem config na mao, o padrao e
 *                                  sinalizar, nunca esconder.
 * @param {number}  opts.tolerance  residuo tolerado em R$.
 * @param {number}  opts.reviewDays janela de conferencia da parcela retroativa.
 */
function overdueSql(opts) {
  const o = opts || {};
  const p = o.alias ? o.alias + '.' : '';
  const grace = Number.isFinite(o.graceDays) ? Math.floor(o.graceDays) : 0;
  const tol = Number.isFinite(o.tolerance) ? o.tolerance : RESIDUE_TOLERANCE;
  const win = Number.isFinite(o.reviewDays) ? Math.floor(o.reviewDays) : REVIEW_WINDOW_DAYS;
  return `(
    ${p}status IN ('pending','overdue')
    AND (${p}amount_due - COALESCE(${p}covered_amount, 0)) > ${tol}
    AND ${p}due_date < (${SP_TODAY} - ${grace})
    AND (
      ${p}due_date >= (${p}created_at AT TIME ZONE 'America/Sao_Paulo')::date
      OR (${p}created_at AT TIME ZONE 'America/Sao_Paulo')::date < (${SP_TODAY} - ${win})
    )
  )`;
}

/**
 * Expressao SQL booleana "parcela retroativa vencida DENTRO da janela de
 * conferencia": o carne foi cadastrado DEPOIS do vencimento e a loja ainda tem
 * prazo para conferir. Nao e atraso (ainda): e historico a conferir. Passada a
 * janela, a parcela migra sozinha para overdueSql.
 */
function toReviewSql(opts) {
  const o = opts || {};
  const p = o.alias ? o.alias + '.' : '';
  const tol = Number.isFinite(o.tolerance) ? o.tolerance : RESIDUE_TOLERANCE;
  const win = Number.isFinite(o.reviewDays) ? Math.floor(o.reviewDays) : REVIEW_WINDOW_DAYS;
  return `(
    ${p}status IN ('pending','overdue')
    AND (${p}amount_due - COALESCE(${p}covered_amount, 0)) > ${tol}
    AND ${p}due_date < ${SP_TODAY}
    AND ${p}due_date < (${p}created_at AT TIME ZONE 'America/Sao_Paulo')::date
    AND (${p}created_at AT TIME ZONE 'America/Sao_Paulo')::date >= (${SP_TODAY} - ${win})
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

    // Retroativa: parcela cadastrada depois do proprio vencimento. Fica "a
    // conferir" so enquanto a loja esta dentro da janela de conferencia.
    const created = ymd(inst?.created_at);
    if (created && due < created && daysBetween(created, today) <= REVIEW_WINDOW_DAYS) {
      out.needs_review = true;
      return out;
    }

    out.is_overdue = late > signalGraceDays(config);
    return out;
  } catch (_) {
    return out;
  }
}

module.exports = {
  DEFAULT_GRACE_DAYS,
  RESIDUE_TOLERANCE,
  REVIEW_WINDOW_DAYS,
  SP_TODAY,
  resolveGraceDays,
  signalGraceDays,
  overdueSql,
  toReviewSql,
  classifyInstallment,
  todaySp,
};
