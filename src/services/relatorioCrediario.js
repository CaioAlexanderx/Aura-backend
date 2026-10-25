// ============================================================
// AURA. — Relatório semanal: bloco do crediário (tq-85b, 24/10/2026)
//
// SOMENTE LEITURA. Diretriz do Caio (18/10): nada de reparo de parcela no
// crediário; só medir. Por isso este arquivo:
//   - NÃO chama GET /credit/dashboard nem GET /credit/installments (os dois
//     fazem UPDATE de credit_installments.status ao ler);
//   - não reaproveita função que grava: só usa as EXPRESSÕES da regra única
//     de atraso (services/credit/overdue.js: overdueSql, ledgerDebtSql, que
//     são texto SQL puro) e consultas SELECT escritas aqui;
//   - o teste espiona todas as consultas e falha com qualquer UPDATE,
//     INSERT ou DELETE.
//
// Métricas (consultas do card tq-85b, medidas pelo Teo em 21/10):
//   recebido        razão (customer_credit_transactions) type 'payment' na
//                   semana, SEM o crédito de troca (payment_method
//                   'crediario_credito', credit.js:1004)
//   novo fiado      razão type 'debit' na semana (por created_at)
//   saldo em aberto a mesma view da tela (customer_credit_balances, saldo > 0)
//   vencido         parcelas pela regra da tela (overdueSql, com a carência
//                   de credit_plan_configs e a condição 5 do razão); % sobre o
//                   saldo do razão. São fontes diferentes (parcelas x razão):
//                   o % é limitado a 100% e, quando passa, fica registrado no
//                   log (sem nome de cliente)
//   a vencer        parcelas abertas com vencimento de hoje a hoje + 7,
//                   valor amount_due - covered_amount e número de parcelas.
//                   Duas travas a mais que o card, para não mostrar dinheiro
//                   que ninguém deve: resíduo > R$ 0,01 e a condição 5 da
//                   regra única (cliente com dívida no razão; parcela órfã é
//                   "Conferir" na tela, não cobrança)
//   +30 dias        clientes cujo vencimento em atraso mais antigo (a mesma
//                   conta do oldest_overdue_date de GET /credit/balances) tem
//                   mais de 30 dias
//   fiado nas vendas débitos do razão com sale_id na semana (venda não
//                   cancelada). sales.payment_method subestima venda mista
//                   (pdv.js), por isso a fonte é o razão
//
// O bloco só existe com pdv_settings.crediario_enabled = true, lançamentos
// no razão e plano Negócio ou Expansão (o mesmo requirePlan das rotas
// /credit em routes/private.js). Sem nome de cliente final em lugar nenhum:
// só quantidades e valores.
//
// Nunca lança: qualquer erro (tabela ausente, coluna ausente, banco fora)
// desliga o bloco (null) e vai para o log.
// ============================================================
'use strict';

const overdueRule = require('./credit/overdue');

// O mesmo requirePlan('negocio', 'expansao') das rotas /credit (private.js).
const PLANOS_DO_CREDIARIO = Object.freeze(['negocio', 'expansao']);

const SP = "AT TIME ZONE 'America/Sao_Paulo'";
const HOJE = overdueRule.SP_TODAY;

// Dias à frente do "a vencer" (card: "due_date entre hoje e +7").
const DIAS_A_VENCER = 7;
// "Clientes com mais de 30 dias de atraso".
const DIAS_ATRASO_LONGO = 30;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function addDias(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Vencido sobre o saldo, em %, limitado a 100. As duas contas vêm de fontes
 * diferentes (parcelas x razão), então o vencido pode passar do saldo: nesse
 * caso o número mostrado é 100% e o caso vai para o log.
 * @returns {{ pct: number|null, passou: boolean }}
 */
function percentualVencido(vencido, saldo) {
  if (!(saldo > 0)) return { pct: null, passou: vencido > 0 };
  const bruto = (vencido / saldo) * 100;
  if (bruto > 100) return { pct: 100, passou: true };
  return { pct: Math.round(bruto), passou: false };
}

/** Fiado sobre o total de vendas da semana, em %, limitado a 100. */
function percentualDasVendas(vendasNoFiado, totalVendas) {
  if (!(totalVendas > 0)) return null;
  return Math.min(100, Math.round((vendasNoFiado / totalVendas) * 100));
}

async function carencia(db, companyId) {
  try {
    const { rows } = await db.query(
      'SELECT late_grace_days, late_charges_enabled FROM credit_plan_configs WHERE company_id = $1',
      [companyId]
    );
    return overdueRule.signalGraceDays(rows && rows[0]);
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return 0;
    throw e;
  }
}

/** A loja usa o crediário? Toggle ligado e algum lançamento no razão. */
async function usaCrediario(db, companyId) {
  const { rows } = await db.query(
    `SELECT (c.pdv_settings->>'crediario_enabled') = 'true' AS ligado,
            EXISTS (SELECT 1 FROM customer_credit_transactions t WHERE t.company_id = c.id) AS tem_lancamentos
       FROM companies c
      WHERE c.id = $1`,
    [companyId]
  );
  const r = rows && rows[0];
  return !!(r && r.ligado === true && r.tem_lancamentos === true);
}

/**
 * Crediário da semana de uma empresa. null = o bloco não aparece (plano sem
 * crediário, toggle desligado, nenhum lançamento, nada para mostrar na
 * semana, ou erro).
 *
 * @param db
 * @param {string} companyId
 * @param {{startDate: string, endDate: string}} period  endDate INCLUSIVO
 * @param {object} [o]
 * @param {string} [o.plano]        companies.plan
 * @param {number} [o.totalVendas]  vendas da semana (para o % no fiado)
 */
async function crediarioDaSemana(db, companyId, period, { plano = null, totalVendas = 0 } = {}) {
  if (!PLANOS_DO_CREDIARIO.includes(plano)) return null;
  try {
    if (!(await usaCrediario(db, companyId))) return null;

    const inicio = period.startDate;
    const fimExclusivo = addDias(period.endDate, 1);
    const naSemana = `(created_at ${SP}) >= $2::timestamp AND (created_at ${SP}) < $3::timestamp`;

    const { rows: [razao] } = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'payment' AND payment_method IS DISTINCT FROM 'crediario_credito'), 0) AS recebido,
         COUNT(*) FILTER (WHERE type = 'payment' AND payment_method IS DISTINCT FROM 'crediario_credito')::int          AS recebimentos,
         COALESCE(SUM(amount) FILTER (WHERE type = 'debit'), 0)                                                         AS novo_fiado
         FROM customer_credit_transactions
        WHERE company_id = $1 AND ${naSemana}`,
      [companyId, inicio, fimExclusivo]
    );

    const { rows: [saldoRow] } = await db.query(
      `SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS saldo,
              COUNT(*) FILTER (WHERE balance > 0)::int              AS clientes
         FROM customer_credit_balances
        WHERE company_id = $1`,
      [companyId]
    );

    const graceDays = await carencia(db, companyId);
    const emAtraso = overdueRule.overdueSql({ graceDays, companyParam: '$1' });
    const comDivida = overdueRule.ledgerDebtSql({ companyParam: '$1' });

    const { rows: [parcelas] } = await db.query(
      `SELECT
         COALESCE(SUM(amount_due - COALESCE(covered_amount, 0)) FILTER (WHERE ${emAtraso}), 0) AS vencido,
         COUNT(*) FILTER (WHERE ${emAtraso})::int                                               AS parcelas_vencidas,
         COALESCE(SUM(amount_due - COALESCE(covered_amount, 0)) FILTER (
           WHERE status IN ('pending','overdue')
             AND due_date >= ${HOJE} AND due_date <= ${HOJE} + ${DIAS_A_VENCER}
             AND (amount_due - COALESCE(covered_amount, 0)) > 0.009
             AND ${comDivida}), 0)                                                              AS a_vencer,
         COUNT(*) FILTER (
           WHERE status IN ('pending','overdue')
             AND due_date >= ${HOJE} AND due_date <= ${HOJE} + ${DIAS_A_VENCER}
             AND (amount_due - COALESCE(covered_amount, 0)) > 0.009
             AND ${comDivida})::int                                                             AS parcelas_a_vencer
         FROM credit_installments
        WHERE company_id = $1`,
      [companyId]
    );

    const { rows: [longos] } = await db.query(
      `SELECT COUNT(*)::int AS clientes
         FROM (
           SELECT customer_id, MIN(due_date) FILTER (WHERE ${emAtraso}) AS mais_antigo
             FROM credit_installments
            WHERE company_id = $1
            GROUP BY customer_id
         ) x
        WHERE x.mais_antigo < ${HOJE} - ${DIAS_ATRASO_LONGO}`,
      [companyId]
    );

    const { rows: [fiado] } = await db.query(
      `SELECT COUNT(DISTINCT t.sale_id)::int AS vendas,
              COALESCE(SUM(t.amount), 0)     AS valor
         FROM customer_credit_transactions t
         JOIN sales s ON s.id = t.sale_id AND COALESCE(s.status, 'completed') <> 'cancelled'
        WHERE t.company_id = $1
          AND t.type = 'debit'
          AND t.sale_id IS NOT NULL
          AND (t.created_at ${SP}) >= $2::timestamp AND (t.created_at ${SP}) < $3::timestamp`,
      [companyId, inicio, fimExclusivo]
    );

    const out = {
      recebido: num(razao && razao.recebido),
      recebimentos: int(razao && razao.recebimentos),
      novoFiado: num(razao && razao.novo_fiado),
      saldo: num(saldoRow && saldoRow.saldo),
      clientesComSaldo: int(saldoRow && saldoRow.clientes),
      vencido: num(parcelas && parcelas.vencido),
      parcelasVencidas: int(parcelas && parcelas.parcelas_vencidas),
      aVencer: { valor: num(parcelas && parcelas.a_vencer), parcelas: int(parcelas && parcelas.parcelas_a_vencer), dias: DIAS_A_VENCER },
      clientesAtrasoLongo: int(longos && longos.clientes),
      diasAtrasoLongo: DIAS_ATRASO_LONGO,
      fiadoNasVendas: { vendas: int(fiado && fiado.vendas), valor: num(fiado && fiado.valor), pct: null },
    };
    out.fiadoNasVendas.pct = percentualDasVendas(out.fiadoNasVendas.vendas, totalVendas);

    const p = percentualVencido(out.vencido, out.saldo);
    out.pctVencido = p.pct;
    if (p.passou) {
      // Parcelas e razão divergem para esta loja. Registra, sem nome de
      // cliente, e o e-mail mostra no máximo 100%.
      console.warn(`[relatorioCrediario] vencido acima do saldo: company=${companyId} vencido=${out.vencido} saldo=${out.saldo}`);
    }

    return temAlgoParaMostrar(out) ? out : null;
  } catch (err) {
    console.error(`[relatorioCrediario] bloco desligado: company=${companyId} code=${(err && err.code) || '-'}: ${err && err.message}`);
    return null;
  }
}

/** Semana sem movimento e sem nada em aberto: o bloco não aparece. */
function temAlgoParaMostrar(c) {
  return !!(c && (c.saldo > 0 || c.recebido > 0 || c.novoFiado > 0 || c.vencido > 0 || c.aVencer.valor > 0));
}

/**
 * Soma o crediário de várias empresas (relatório consolidado do dono).
 * Valores e contagens somam; os percentuais são refeitos sobre as somas,
 * com o mesmo limite de 100%. `porEmpresa` guarda a linha de cada uma para
 * a página completa (a tela do crediário é por CNPJ).
 */
function somarCrediarios(itens, totalVendas) {
  const validos = (itens || []).filter((x) => x && x.crediario);
  if (!validos.length) return null;
  const soma = {
    recebido: 0, recebimentos: 0, novoFiado: 0, saldo: 0, clientesComSaldo: 0,
    vencido: 0, parcelasVencidas: 0,
    aVencer: { valor: 0, parcelas: 0, dias: DIAS_A_VENCER },
    clientesAtrasoLongo: 0, diasAtrasoLongo: DIAS_ATRASO_LONGO,
    fiadoNasVendas: { vendas: 0, valor: 0, pct: null },
    porEmpresa: [],
  };
  for (const { companyId, nome, crediario: c } of validos) {
    soma.recebido += c.recebido;
    soma.recebimentos += c.recebimentos;
    soma.novoFiado += c.novoFiado;
    soma.saldo += c.saldo;
    soma.clientesComSaldo += c.clientesComSaldo;
    soma.vencido += c.vencido;
    soma.parcelasVencidas += c.parcelasVencidas;
    soma.aVencer.valor += c.aVencer.valor;
    soma.aVencer.parcelas += c.aVencer.parcelas;
    soma.clientesAtrasoLongo += c.clientesAtrasoLongo;
    soma.fiadoNasVendas.vendas += c.fiadoNasVendas.vendas;
    soma.fiadoNasVendas.valor += c.fiadoNasVendas.valor;
    soma.porEmpresa.push({ companyId, nome, saldo: c.saldo, vencido: c.vencido, recebido: c.recebido, novoFiado: c.novoFiado });
  }
  for (const k of ['recebido', 'novoFiado', 'saldo', 'vencido']) soma[k] = num(soma[k]);
  soma.aVencer.valor = num(soma.aVencer.valor);
  soma.fiadoNasVendas.valor = num(soma.fiadoNasVendas.valor);
  soma.fiadoNasVendas.pct = percentualDasVendas(soma.fiadoNasVendas.vendas, totalVendas);
  soma.pctVencido = percentualVencido(soma.vencido, soma.saldo).pct;
  return soma;
}

module.exports = {
  PLANOS_DO_CREDIARIO,
  DIAS_A_VENCER,
  DIAS_ATRASO_LONGO,
  crediarioDaSemana,
  somarCrediarios,
  percentualVencido,
  percentualDasVendas,
};
