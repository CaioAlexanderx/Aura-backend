// ============================================================
// AURA. — Relatório semanal longo: dados dos blocos (tq-85, 24/10/2026)
//
// Versão "completa" (padrão do Caio, 21/10). Os blocos são os de
// services/emailPreferencias.BLOCOS; cada um só existe quando:
//   1. está ligado nas preferências da empresa (config.blocos) E o plano tem
//      o módulo (blocosDoRelatorio). O que o plano não tem some: nada de
//      cadeado nem "faça upgrade" (premissa do Caio);
//   2. há dado verdadeiro na semana. Bloco sem dado não aparece, ou aparece
//      com uma frase curta e verdadeira. Nenhum número é inventado.
//
// Cada bloco é calculado isolado (seguro): se a consulta de um bloco falha,
// só aquele bloco some e o erro vai para o log; o relatório segue.
//
// Fontes (medidas no card tq-85):
//   vendas             salesAnalytics (o mesmo do relatório de sempre) e mais
//                      duas semanas para as "4 últimas semanas"
//   mais_vendidos      services/productsRanking (curva ABC da tela
//                      /financeiro/produtos: sem troca e sem cancelada)
//   pagamentos_estoque formas de pagamento (salesAnalytics), contas a pagar e
//                      a receber dos próximos 7 dias (transactions pending;
//                      o "a receber" do crediário fica fora: tem bloco
//                      próprio), estoque baixo (stock_qty <= stock_min AND
//                      stock_min > 0, como aiInsights.js:39)
//   equipe_margem      ranking por vendedor com a MESMA regra da tela
//                      /vendas?tab=ranking (employeesRanking: por
//                      employee_id, troca pelo líquido). Margem bruta da loja
//                      inteira, com a semana anterior ao lado. NÃO existe
//                      margem por produto (decisão da Nina, 21/10): não há.
//   clientes           atendidos, novos e que voltaram (das vendas),
//                      aniversariantes dos próximos 7 dias e clientes parados
//                      há mais de 30 dias (reportDataQueries)
//   loja_online        só com vitrine publicada: pedidos confirmados da semana.
//                      A META DO MÊS ficou de fora: não existe meta de
//                      faturamento da loja gravada em lugar nenhum (sales_goals
//                      não tem rota nem tela), então não há número verdadeiro
//   crediario          services/relatorioCrediario (tq-85b, só leitura)
//
// Desligar sem deploy: RELATORIO_BLOCOS_DESLIGADOS=crediario,equipe_margem
// tira esses blocos de todos os relatórios.
// ============================================================
'use strict';

const db = require('../config/database');
const P = require('./emailPreferencias');
const { getSummary } = require('./salesAnalytics');
const { getProductsRanking, classifyABC } = require('./productsRanking');
const { crediarioDaSemana, somarCrediarios } = require('./relatorioCrediario');

const SP = "AT TIME ZONE 'America/Sao_Paulo'";

// ── Helpers ─────────────────────────────────────────────────────

function addDias(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function hojeSP(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function pct(a, b) {
  if (!(b > 0)) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

/** Blocos desligados por env (vírgula), para todos os relatórios. */
function blocosDesligadosPorEnv(env = process.env) {
  return String(env.RELATORIO_BLOCOS_DESLIGADOS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Blocos que o relatório desta empresa mostra: os ligados nas preferências
 * que o plano tem (blocosDoRelatorio), menos os desligados por env.
 */
function blocosEfetivos(config, plano, env = process.env) {
  const fora = new Set(blocosDesligadosPorEnv(env));
  return P.blocosDoRelatorio(config, plano).filter((b) => !fora.has(b));
}

/** Versão longa ligada? RELATORIO_LONGO_ENABLED=false manda todos no resumo. */
function relatorioLongoLigado(env = process.env) {
  const v = env.RELATORIO_LONGO_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|off|no|nao|não)$/i.test(String(v).trim());
}

/** Versão do e-mail: 'completa' (padrão) ou 'resumo'. */
function versaoDoRelatorio(config, env = process.env) {
  if (!relatorioLongoLigado(env)) return 'resumo';
  return config && config.versao === 'resumo' ? 'resumo' : 'completa';
}

async function seguro(nome, companyId, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[relatorioBlocos] bloco ${nome} desligado: company=${companyId} code=${(err && err.code) || '-'}: ${err && err.message}`);
    return null;
  }
}

// ── Rótulos ─────────────────────────────────────────────────────

const ROTULOS_PAGAMENTO = {
  pix: 'Pix',
  dinheiro: 'Dinheiro', cash: 'Dinheiro',
  credito: 'Cartão de crédito', credit: 'Cartão de crédito', cartao_credito: 'Cartão de crédito',
  debito: 'Cartão de débito', debit: 'Cartão de débito', cartao_debito: 'Cartão de débito',
  cartao: 'Cartão',
  crediario: 'Crediário', fiado: 'Crediário',
  boleto: 'Boleto',
  cheque: 'Cheque',
  misto: 'Misto', multiplo: 'Misto',
  'nao informado': 'Não informado',
  outros: 'Outros',
};

function rotuloPagamento(m) {
  const k = String(m || 'nao informado').toLowerCase();
  if (ROTULOS_PAGAMENTO[k]) return ROTULOS_PAGAMENTO[k];
  const s = String(m || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Não informado';
}

// ── Vendas ──────────────────────────────────────────────────────

/**
 * Vendas da semana com a anterior ao lado e as 4 últimas semanas.
 * kpis/dailyRevenue já vêm do relatório de sempre (buildReportData).
 */
async function blocoVendas(companyId, { period, kpis, dailyRevenue, prevRevenue }) {
  const semanas = [];
  // Semanas -3 e -2 (as -1 e atual já estão calculadas).
  for (const k of [3, 2]) {
    const ini = addDias(period.startDate, -7 * k);
    const fim = addDias(period.endDate, -7 * k);
    const s = await getSummary(companyId, ini, addDias(fim, 1));
    semanas.push({ inicio: ini, fim, receita: num(s.total_revenue) });
  }
  semanas.push({ inicio: addDias(period.startDate, -7), fim: addDias(period.endDate, -7), receita: num(prevRevenue) });
  semanas.push({ inicio: period.startDate, fim: period.endDate, receita: num(kpis.revenue) });
  return montarVendas({ kpis, dailyRevenue, prevRevenue, semanas });
}

function montarVendas({ kpis, dailyRevenue, prevRevenue, semanas }) {
  const diario = (dailyRevenue || []).map((d) => ({ dia: d.day, data: d.date, valor: num(d.value) }));
  const total = diario.reduce((s, d) => s + d.valor, 0);
  let melhor = null;
  for (const d of diario) if (d.valor > 0 && (!melhor || d.valor > melhor.valor)) melhor = d;
  return {
    receita: num(kpis.revenue),
    vendas: int(kpis.sales),
    ticket: num(kpis.avg_ticket),
    receitaAnterior: num(prevRevenue),
    variacaoPct: pct(num(kpis.revenue), num(prevRevenue)),
    diario,
    melhorDia: melhor ? { ...melhor, pctDaSemana: total > 0 ? Math.round((melhor.valor / total) * 100) : null } : null,
    semanas: semanas || [],
  };
}

// ── Mais vendidos e curva ABC ───────────────────────────────────

async function blocoMaisVendidos(companyId, { period }) {
  const r = await getProductsRanking(companyId, {
    period: 'custom', start_date: period.startDate, end_date: period.endDate, limit: 1000,
  });
  const todos = (r.products || []).map((p) => ({ id: p.id, nome: p.name, qtd: p.qty_sold, receita: num(p.total_revenue) }));
  return montarMaisVendidos(todos);
}

function montarMaisVendidos(todos) {
  const ordenados = [...(todos || [])].filter((p) => p.receita > 0 || p.qtd > 0).sort((a, b) => b.receita - a.receita);
  if (!ordenados.length) return null;
  const total = ordenados.reduce((s, p) => s + p.receita, 0);
  const classificados = classifyABC(ordenados.map((p) => ({ ...p, total_revenue: p.receita })), total);
  const curva = {};
  for (const g of ['A', 'B', 'C']) {
    const itens = classificados.filter((p) => p.abc === g);
    const rec = itens.reduce((s, p) => s + p.receita, 0);
    curva[g] = { produtos: itens.length, receitaPct: total > 0 ? Math.round((rec / total) * 100) : 0 };
  }
  return {
    top: ordenados.slice(0, 5).map((p) => ({ nome: p.nome, qtd: Math.round(p.qtd * 100) / 100, receita: num(p.receita) })),
    curva,
    produtosVendidos: ordenados.length,
    _todos: ordenados,
  };
}

// ── Pagamentos, contas e estoque ────────────────────────────────

async function blocoPagamentosEstoque(companyId, { byPayment, now }) {
  const hoje = hojeSP(now);
  const ate = addDias(hoje, 6);
  const { rows: [contas] } = await db.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)                                              AS pagar,
       COUNT(*) FILTER (WHERE type = 'expense')::int                                                          AS pagar_qtd,
       COALESCE(SUM(amount) FILTER (WHERE type = 'income' AND COALESCE(category, '') NOT ILIKE 'credi%'), 0)  AS receber,
       COUNT(*) FILTER (WHERE type = 'income' AND COALESCE(category, '') NOT ILIKE 'credi%')::int              AS receber_qtd
       FROM transactions
      WHERE company_id = $1 AND status = 'pending' AND due_date >= $2::date AND due_date <= $3::date`,
    [companyId, hoje, ate]
  );
  const { rows: baixo } = await db.query(
    `SELECT name, stock_qty, stock_min, COUNT(*) OVER ()::int AS total
       FROM products
      WHERE company_id = $1 AND COALESCE(is_active, true) = true
        AND stock_min > 0 AND stock_qty <= stock_min
      ORDER BY (stock_qty - stock_min) ASC, name ASC
      LIMIT 8`,
    [companyId]
  );
  return montarPagamentosEstoque({
    byPayment,
    contas: {
      pagar: { valor: num(contas && contas.pagar), qtd: int(contas && contas.pagar_qtd) },
      receber: { valor: num(contas && contas.receber), qtd: int(contas && contas.receber_qtd) },
      ate,
    },
    estoqueBaixo: {
      qtd: baixo.length ? int(baixo[0].total) : 0,
      itens: baixo.map((r) => ({ nome: r.name, estoque: num(r.stock_qty), minimo: num(r.stock_min) })),
    },
  });
}

function montarPagamentosEstoque({ byPayment, contas, estoqueBaixo }) {
  const brutos = new Map();
  for (const p of byPayment || []) {
    const rot = rotuloPagamento(p.method);
    brutos.set(rot, (brutos.get(rot) || 0) + num(p.total_revenue));
  }
  const total = [...brutos.values()].reduce((s, v) => s + v, 0);
  const pagamentos = [...brutos.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([rotulo, valor]) => ({ rotulo, valor: num(valor), pct: total > 0 ? Math.round((valor / total) * 100) : 0 }));
  const temContas = contas && (contas.pagar.qtd > 0 || contas.receber.qtd > 0);
  const temEstoque = estoqueBaixo && estoqueBaixo.qtd > 0;
  if (!pagamentos.length && !temContas && !temEstoque) return null;
  return { pagamentos, contas: temContas ? contas : null, estoqueBaixo: temEstoque ? estoqueBaixo : null };
}

// ── Equipe e margem ─────────────────────────────────────────────

let _colunasDeTroca = null; // migration 111 (exchange_employee_id) aplicada?

async function temColunasDeTroca() {
  if (_colunasDeTroca !== null) return _colunasDeTroca;
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name = 'exchange_employee_id'`
    );
    _colunasDeTroca = int(r.rows && r.rows[0] && r.rows[0].n) === 1;
  } catch (_) {
    _colunasDeTroca = false;
  }
  return _colunasDeTroca;
}

/**
 * Ranking da semana com a regra da tela /vendas?tab=ranking
 * (routes/employeesRanking.js): vendas type 'sale' por employee_id, mais as
 * trocas atendidas pelo líquido. Limites em instantes UTC do dia de São Paulo.
 */
async function rankingDaEquipe(companyId, { period }) {
  const ini = `${period.startDate}T03:00:00Z`;
  const fim = `${addDias(period.endDate, 1)}T03:00:00Z`;
  const quemAtendeu = (await temColunasDeTroca()) ? 'COALESCE(s.exchange_employee_id, s.employee_id)' : 's.employee_id';
  const { rows } = await db.query(
    `SELECT e.name AS nome,
            COALESCE(pura.vendas, 0) + COALESCE(troca.vendas, 0)   AS vendas,
            COALESCE(pura.receita, 0) + COALESCE(troca.receita, 0) AS receita
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT COUNT(s.id) AS vendas, COALESCE(SUM(s.total_amount), 0) AS receita
           FROM sales s
          WHERE s.company_id = $1 AND s.employee_id = e.id
            AND COALESCE(s.type, 'sale') = 'sale'
            AND COALESCE(s.status, 'completed') <> 'cancelled'
            AND s.created_at >= $2::timestamptz AND s.created_at < $3::timestamptz
       ) pura ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(s.id) AS vendas,
                COALESCE(SUM(s.total_amount - COALESCE((
                  SELECT SUM(tri.quantity * tri.unit_price) FROM troca_returned_items tri WHERE tri.troca_sale_id = s.id
                ), 0)), 0) AS receita
           FROM sales s
          WHERE s.type = 'troca' AND ${quemAtendeu} = e.id
            AND COALESCE(s.status, 'completed') <> 'cancelled'
            AND s.created_at >= $2::timestamptz AND s.created_at < $3::timestamptz
       ) troca ON true
      WHERE e.company_id = $1 AND e.is_active = true
      ORDER BY 3 DESC NULLS LAST, e.name ASC`,
    [companyId, ini, fim]
  );
  return rows
    .map((r) => ({ nome: r.nome, vendas: int(r.vendas), receita: num(r.receita) }))
    .filter((r) => r.vendas > 0)
    .slice(0, 10);
}

/**
 * Somas da margem bruta de uma semana: receita das vendas (total_amount, que
 * já tem o desconto da venda), receita e custo só das vendas em que TODO
 * item tem custo cadastrado. Margem = (receita com custo - custo) / receita
 * com custo; cobertura = receita com custo / receita.
 *
 * Por que não o /dre-simples: ele soma a receita do PDV duas vezes (a venda
 * grava transactions 'income' "Vendas" e o DRE soma isso com sale_items),
 * não tira venda cancelada e desconta imposto estimado. A margem daqui é a
 * bruta de verdade, com o CMV do sale_items.unit_cost (a mesma fonte do DRE).
 */
async function somasDaMargem(companyId, inicio, fimInclusivo) {
  const { rows: [r] } = await db.query(
    `WITH v AS (
       SELECT s.id, s.total_amount,
              COUNT(si.id) FILTER (WHERE si.unit_cost IS NULL OR si.unit_cost <= 0) AS sem_custo,
              COALESCE(SUM(si.unit_cost * si.quantity), 0)                         AS custo
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
        WHERE s.company_id = $1
          AND COALESCE(s.status, 'completed') <> 'cancelled'
          AND COALESCE(s.type, 'sale') = 'sale'
          AND (s.created_at ${SP}) >= $2::timestamp
          AND (s.created_at ${SP}) <  $3::timestamp
        GROUP BY s.id, s.total_amount
     )
     SELECT COALESCE(SUM(total_amount), 0)                        AS receita,
            COALESCE(SUM(total_amount) FILTER (WHERE sem_custo = 0), 0) AS receita_com_custo,
            COALESCE(SUM(custo) FILTER (WHERE sem_custo = 0), 0)        AS custo
       FROM v`,
    [companyId, inicio, addDias(fimInclusivo, 1)]
  );
  return { receita: num(r && r.receita), receitaComCusto: num(r && r.receita_com_custo), custo: num(r && r.custo) };
}

// Abaixo disso a margem não sai: com pouca venda com custo, o número não
// representaria a loja.
const COBERTURA_MINIMA = 0.8;

function margemDasSomas(s) {
  if (!s || !(s.receita > 0)) return null;
  const cobertura = s.receitaComCusto / s.receita;
  if (!(s.receitaComCusto > 0) || cobertura < COBERTURA_MINIMA) return { pct: null, cobertura: Math.round(cobertura * 100) };
  return {
    pct: Math.round(((s.receitaComCusto - s.custo) / s.receitaComCusto) * 1000) / 10,
    cobertura: Math.round(cobertura * 100),
  };
}

async function blocoEquipeMargem(companyId, { period }) {
  const equipe = await rankingDaEquipe(companyId, { period });
  const atual = await somasDaMargem(companyId, period.startDate, period.endDate);
  const anterior = await somasDaMargem(companyId, addDias(period.startDate, -7), addDias(period.endDate, -7));
  return montarEquipeMargem({ equipe, somas: { atual, anterior } });
}

function montarEquipeMargem({ equipe, somas, porEmpresa = null }) {
  const atual = margemDasSomas(somas && somas.atual);
  const anterior = margemDasSomas(somas && somas.anterior);
  const temEquipe = (equipe && equipe.length) || (porEmpresa && porEmpresa.some((e) => e.equipe.length));
  if (!temEquipe && !atual) return null;
  return {
    equipe: equipe || [],
    porEmpresa,
    margem: atual ? { atual, anterior } : null,
    _somas: somas,
  };
}

// ── Clientes ────────────────────────────────────────────────────

/** Os próximos 7 dias (hoje incluído) em MM-DD, para os aniversariantes. */
function proximosDiasMMDD(now = Date.now(), dias = 7) {
  const hoje = hojeSP(now);
  const out = [];
  for (let i = 0; i < dias; i++) out.push(addDias(hoje, i).slice(5));
  return out;
}

async function blocoClientes(companyId, { period, dormant, now }) {
  const ini = period.startDate;
  const fim = addDias(period.endDate, 1);
  const { rows: [c] } = await db.query(
    `WITH semana AS (
       SELECT DISTINCT s.customer_id
         FROM sales s
        WHERE s.company_id = $1 AND s.customer_id IS NOT NULL
          AND COALESCE(s.status, 'completed') <> 'cancelled'
          AND (s.created_at ${SP}) >= $2::timestamp AND (s.created_at ${SP}) < $3::timestamp
     )
     SELECT COUNT(*)::int AS atendidos,
            COUNT(*) FILTER (WHERE
              EXISTS (SELECT 1 FROM sales s2
                       WHERE s2.company_id = $1 AND s2.customer_id = semana.customer_id
                         AND COALESCE(s2.status, 'completed') <> 'cancelled'
                         AND (s2.created_at ${SP}) < $2::timestamp)
              OR EXISTS (SELECT 1 FROM customers cu
                          WHERE cu.id = semana.customer_id
                            AND cu.first_purchase_at IS NOT NULL
                            AND (cu.first_purchase_at ${SP}) < $2::timestamp)
            )::int AS voltaram
       FROM semana`,
    [companyId, ini, fim]
  );
  const { rows: [a] } = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM customers
      WHERE company_id = $1 AND COALESCE(is_active, true) = true
        AND birth_date IS NOT NULL
        AND to_char(birth_date, 'MM-DD') = ANY($2::text[])`,
    [companyId, proximosDiasMMDD(now)]
  );
  return montarClientes({
    atendidos: int(c && c.atendidos),
    voltaram: int(c && c.voltaram),
    aniversariantes: int(a && a.n),
    parados: dormant && Number.isFinite(dormant.count) ? dormant.count : 0,
  });
}

function montarClientes({ atendidos, voltaram, aniversariantes, parados }) {
  if (!atendidos && !aniversariantes && !parados) return null;
  const v = Math.min(voltaram, atendidos);
  return { atendidos, novos: atendidos - v, voltaram: v, aniversariantes, parados, diasParado: 30 };
}

// ── Loja online ─────────────────────────────────────────────────

const STATUS_CONFIRMADO = ['confirmed', 'preparing', 'ready', 'delivered'];

async function blocoLojaOnline(companyId, { period }) {
  const { rows: cfg } = await db.query(
    'SELECT is_published FROM digital_channel_config WHERE company_id = $1',
    [companyId]
  );
  if (!cfg.length || cfg[0].is_published !== true) return null; // sem loja online: some
  const { rows: [o] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status::text = ANY($4::text[]))::int              AS pedidos,
            COALESCE(SUM(total) FILTER (WHERE status::text = ANY($4::text[])), 0)    AS valor
       FROM digital_orders
      WHERE company_id = $1
        AND (created_at ${SP}) >= $2::timestamp AND (created_at ${SP}) < $3::timestamp`,
    [companyId, period.startDate, addDias(period.endDate, 1), STATUS_CONFIRMADO]
  );
  return { pedidos: int(o && o.pedidos), valor: num(o && o.valor) };
}

// ── Empresa ─────────────────────────────────────────────────────

/**
 * Dados de todos os blocos de UMA empresa.
 *
 * @param {string} companyId
 * @param {object} ctx
 * @param {string[]} ctx.blocos     blocos efetivos (blocosEfetivos)
 * @param {string}   ctx.plano      companies.plan (gate do crediário)
 * @param {object}   ctx.period     { startDate, endDate } endDate inclusivo
 * @param {object}   ctx.kpis       kpis do relatório (buildReportData)
 * @param {Array}    ctx.dailyRevenue
 * @param {number}   ctx.prevRevenue receita da semana anterior
 * @param {Array}    ctx.byPayment  salesCurrent.by_payment
 * @param {object}   [ctx.dormant]  fetchDormantCustomers
 * @returns {Promise<object>} { blocos: [...], vendas?, mais_vendidos?, ... }
 */
async function dadosDosBlocos(companyId, ctx) {
  const blocos = ctx.blocos || [];
  const tem = (b) => blocos.includes(b);
  const out = { blocos };
  const now = ctx.now || Date.now();

  if (tem('vendas')) out.vendas = await seguro('vendas', companyId, () => blocoVendas(companyId, ctx));
  if (tem('mais_vendidos')) out.mais_vendidos = await seguro('mais_vendidos', companyId, () => blocoMaisVendidos(companyId, ctx));
  if (tem('pagamentos_estoque')) out.pagamentos_estoque = await seguro('pagamentos_estoque', companyId, () => blocoPagamentosEstoque(companyId, { byPayment: ctx.byPayment, now }));
  if (tem('equipe_margem')) out.equipe_margem = await seguro('equipe_margem', companyId, () => blocoEquipeMargem(companyId, ctx));
  if (tem('clientes')) out.clientes = await seguro('clientes', companyId, () => blocoClientes(companyId, { period: ctx.period, dormant: ctx.dormant, now }));
  if (tem('loja_online')) out.loja_online = await seguro('loja_online', companyId, () => blocoLojaOnline(companyId, ctx));
  if (tem('crediario')) {
    out.crediario = await crediarioDaSemana(db, companyId, ctx.period, { plano: ctx.plano, totalVendas: (ctx.kpis && ctx.kpis.sales) || 0 });
  }
  return out;
}

// ── Consolidado (multi-CNPJ, grupo do mesmo dono) ───────────────

/**
 * Junta os blocos das empresas do grupo. Decisão por bloco:
 *   vendas, pagamentos, contas, estoque, clientes, loja online: SOMAM
 *     (cada venda, conta, produto e cliente pertence a uma empresa só);
 *   mais vendidos: o mesmo produto (mesmo id, caso do compartilhado no
 *     grupo) soma; a curva ABC é refeita sobre o grupo;
 *   margem: refeita sobre as somas de receita e custo do grupo;
 *   equipe: POR EMPRESA (a tela /vendas?tab=ranking é por CNPJ e pede para
 *     escolher a empresa no consolidado);
 *   crediário: soma, com a linha de cada empresa na página completa (a
 *     tela do crediário também é por CNPJ).
 *
 * @param {Array<{companyId, nome, dados}>} porEmpresa
 * @param {object} agregado  { kpis, dailyRevenue, prevRevenue, payments }
 */
function consolidarBlocos(porEmpresa, agregado) {
  const lista = (porEmpresa || []).filter((x) => x && x.dados);
  const blocos = [...new Set(lista.flatMap((x) => x.dados.blocos || []))];
  const out = { blocos };
  const de = (b) => lista.filter((x) => x.dados[b]).map((x) => ({ ...x, d: x.dados[b] }));

  if (blocos.includes('vendas') && de('vendas').length) {
    const semanas = [];
    const ref = de('vendas')[0].d.semanas || [];
    ref.forEach((s, i) => {
      semanas.push({ ...s, receita: num(de('vendas').reduce((acc, x) => acc + ((x.d.semanas[i] && x.d.semanas[i].receita) || 0), 0)) });
    });
    out.vendas = montarVendas({ kpis: agregado.kpis, dailyRevenue: agregado.dailyRevenue, prevRevenue: agregado.prevRevenue, semanas });
  }

  if (de('mais_vendidos').length) {
    const porId = new Map();
    for (const x of de('mais_vendidos')) {
      for (const p of x.d._todos || []) {
        const k = String(p.id);
        const atual = porId.get(k) || { id: p.id, nome: p.nome, qtd: 0, receita: 0 };
        atual.qtd += p.qtd;
        atual.receita += p.receita;
        porId.set(k, atual);
      }
    }
    out.mais_vendidos = montarMaisVendidos([...porId.values()]);
  }

  if (de('pagamentos_estoque').length) {
    const xs = de('pagamentos_estoque');
    const byPayment = [];
    for (const x of xs) for (const p of x.d.pagamentos || []) byPayment.push({ method: p.rotulo, total_revenue: p.valor });
    const somaContas = (k) => ({
      valor: num(xs.reduce((s, x) => s + ((x.d.contas && x.d.contas[k].valor) || 0), 0)),
      qtd: xs.reduce((s, x) => s + ((x.d.contas && x.d.contas[k].qtd) || 0), 0),
    });
    const ate = (xs.find((x) => x.d.contas) || { d: { contas: {} } }).d.contas.ate || null;
    const itens = [];
    for (const x of xs) for (const it of (x.d.estoqueBaixo && x.d.estoqueBaixo.itens) || []) itens.push({ ...it, empresa: x.nome });
    out.pagamentos_estoque = montarPagamentosEstoque({
      byPayment,
      contas: { pagar: somaContas('pagar'), receber: somaContas('receber'), ate },
      estoqueBaixo: {
        qtd: xs.reduce((s, x) => s + ((x.d.estoqueBaixo && x.d.estoqueBaixo.qtd) || 0), 0),
        itens: itens.sort((a, b) => (a.estoque - a.minimo) - (b.estoque - b.minimo)).slice(0, 8),
        porEmpresa: xs.filter((x) => x.d.estoqueBaixo).map((x) => ({ companyId: x.companyId, nome: x.nome, qtd: x.d.estoqueBaixo.qtd })),
      },
    });
  }

  if (de('equipe_margem').length) {
    const xs = de('equipe_margem');
    const somar = (k) => {
      const s = { receita: 0, receitaComCusto: 0, custo: 0 };
      for (const x of xs) {
        const v = x.d._somas && x.d._somas[k];
        if (!v) continue;
        s.receita += v.receita; s.receitaComCusto += v.receitaComCusto; s.custo += v.custo;
      }
      return s;
    };
    out.equipe_margem = montarEquipeMargem({
      equipe: [],
      somas: { atual: somar('atual'), anterior: somar('anterior') },
      porEmpresa: xs.map((x) => ({ companyId: x.companyId, nome: x.nome, equipe: x.d.equipe || [] })),
    });
  }

  if (de('clientes').length) {
    const xs = de('clientes');
    const soma = (k) => xs.reduce((s, x) => s + (x.d[k] || 0), 0);
    out.clientes = montarClientes({
      atendidos: soma('atendidos'), voltaram: soma('voltaram'),
      aniversariantes: soma('aniversariantes'), parados: soma('parados'),
    });
  }

  if (de('loja_online').length) {
    const xs = de('loja_online');
    out.loja_online = {
      pedidos: xs.reduce((s, x) => s + x.d.pedidos, 0),
      valor: num(xs.reduce((s, x) => s + x.d.valor, 0)),
    };
  }

  if (de('crediario').length) {
    out.crediario = somarCrediarios(de('crediario').map((x) => ({ companyId: x.companyId, nome: x.nome, crediario: x.d })), (agregado.kpis && agregado.kpis.sales) || 0);
  }
  return out;
}

/** Tira os campos internos (_todos, _somas) antes de sair na API/HTML. */
function semInternos(dados) {
  if (!dados || typeof dados !== 'object') return dados;
  const out = { ...dados };
  for (const k of Object.keys(out)) {
    if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      const b = { ...out[k] };
      delete b._todos;
      delete b._somas;
      out[k] = b;
    }
  }
  return out;
}

module.exports = {
  COBERTURA_MINIMA,
  blocosEfetivos,
  blocosDesligadosPorEnv,
  relatorioLongoLigado,
  versaoDoRelatorio,
  dadosDosBlocos,
  consolidarBlocos,
  semInternos,
  rotuloPagamento,
  margemDasSomas,
  proximosDiasMMDD,
  // para teste
  _montar: { montarVendas, montarMaisVendidos, montarPagamentosEstoque, montarEquipeMargem, montarClientes },
};
