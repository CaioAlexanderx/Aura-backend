// ============================================================
// AURA. — Resultado do período (card p-81, 08/11/2026)
//
// Os quatro números da aba Receitas do Financeiro — Faturamento, Custos,
// Lucro bruto e Despesas — e a linha "Compras de mercadoria pagas". O card
// p-55 (Resumo do Relatórios) reaproveita esta função: a assinatura é
// genérica (empresas, de, até), para as duas telas dizerem o mesmo número.
//
// Regras (decisões do Caio, 07–08/11/2026):
//   Faturamento  vendas concluídas do período (sales type 'sale', não
//                canceladas; total_amount já tem o desconto) + 'Troca - Venda'
//                − 'Troca - Devolucao' e 'devolucao' (os lançamentos
//                confirmados que a trocaV2 e a devolução manual gravam). A troca não entra pela sales: total_amount
//                da troca é o valor do produto novo (CLAUDE.md, armadilha 5).
//   Custos       CMV: Σ sale_items.unit_cost × quantity dos itens COM custo
//                dessas vendas. Custo 0 e custo vazio contam como "sem custo"
//                (a venda grava 0 quando o produto não tem custo).
//   Lucro bruto  receita dos itens com custo − CMV desses itens. A receita do
//                item é o total da linha rateado pelo total da venda (o
//                desconto da venda inteira cai proporcionalmente em cada
//                item), então Σ receita dos itens = Σ vendas.
//   Cobertura    receita dos itens com custo ÷ vendas (por valor). A troca
//                fica fora do lucro bruto: não tem par de custo confiável.
//   Despesas     lançamentos expense confirmados, menos 'Fornecedores'
//                (compra de mercadoria vira estoque, não gasto do mês) e menos
//                'Troca - Devolucao' e 'devolucao' (venda desfeita, já sai do
//                faturamento).
//                'Taxas de cartão' e todo o resto entram.
//   Compras      expense confirmado em 'Fornecedores': só informativo.
//
// Dia: America/Sao_Paulo. Vendas pelo created_at (o PDV sincroniza o
// sale_date nele); lançamentos por COALESCE(due_date, created_at SP), o mesmo
// critério da lista e do summary de /transactions — a aba Receitas lê dali.
//
// Uma consulta por bloco (vendas, produtos sem custo, lançamentos), todas com
// company_id = ANY($1): o consolidado multi-CNPJ custa o mesmo que uma loja.
// ============================================================
'use strict';

const db = require('../config/database');

// Categorias comparadas em minúsculas e sem espaço nas pontas.
const CAT_FORNECEDORES = ['fornecedores'];
const CAT_TROCA_VENDA = ['troca - venda'];
// 08/11/2026: 'devolucao' (devolução manual, sem troca) conta como a
// 'Troca - Devolucao': abate o faturamento e sai de Despesas.
const CAT_TROCA_DEVOLUCAO = ['troca - devolucao', 'troca - devolução', 'devolucao', 'devolução'];

// Abaixo disso a loja aparece como "falta custo na maior parte" no consolidado.
const COBERTURA_BAIXA_PCT = 50;
const LIMITE_PRODUTOS_SEM_CUSTO = 20;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function centavos(n) {
  return Math.round(num(n) * 100) / 100;
}

function dataValida(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ── Consultas (uma por bloco) ───────────────────────────────────

// Venda do período, nos limites do dia de São Paulo. `timestamp AT TIME ZONE`
// devolve o instante: o filtro fica em created_at puro e usa o índice.
const VENDAS_DO_PERIODO = `
  SELECT s.id, s.company_id, s.total_amount::numeric AS total
    FROM sales s
   WHERE s.company_id = ANY($1::uuid[])
     AND COALESCE(s.type, 'sale') = 'sale'
     AND COALESCE(s.status, 'completed') <> 'cancelled'
     AND s.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
     AND s.created_at <  (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;

// Item com a receita rateada. Linha sem total_price (dado antigo) usa
// preço × quantidade − desconto do item.
const ITENS_DO_PERIODO = `
  v AS (${VENDAS_DO_PERIODO}),
  linha AS (
    SELECT v.id AS sale_id, v.company_id, v.total, si.product_id,
           si.product_name_snapshot, si.quantity::numeric AS qtd,
           si.unit_cost::numeric AS custo_unit,
           COALESCE(si.total_price::numeric,
                    si.unit_price::numeric * si.quantity::numeric - COALESCE(si.discount::numeric, 0)) AS bruto
      FROM v JOIN sale_items si ON si.sale_id = v.id
  ),
  soma AS (
    SELECT sale_id, SUM(bruto) AS bruto_venda FROM linha GROUP BY sale_id
  ),
  item AS (
    SELECT l.company_id, l.product_id, l.product_name_snapshot, l.qtd, l.custo_unit,
           (l.custo_unit IS NOT NULL AND l.custo_unit > 0) AS com_custo,
           CASE WHEN s.bruto_venda > 0 THEN l.bruto * l.total / s.bruto_venda ELSE 0 END AS receita
      FROM linha l JOIN soma s ON s.sale_id = l.sale_id
  )`;

const SQL_VENDAS = `
  WITH ${ITENS_DO_PERIODO},
  tv AS (
    SELECT company_id, COUNT(*)::int AS n_vendas, COALESCE(SUM(total), 0) AS vendas
      FROM v GROUP BY company_id
  ),
  ti AS (
    SELECT company_id,
           COALESCE(SUM(receita) FILTER (WHERE com_custo), 0)          AS receita_com_custo,
           COALESCE(SUM(custo_unit * qtd) FILTER (WHERE com_custo), 0) AS cmv,
           COUNT(*)::int                                               AS itens,
           COUNT(*) FILTER (WHERE com_custo)::int                      AS itens_com_custo,
           COUNT(DISTINCT COALESCE(product_id::text, product_name_snapshot))
             FILTER (WHERE NOT com_custo)::int                         AS produtos_sem_custo
      FROM item GROUP BY company_id
  )
  SELECT tv.company_id, tv.n_vendas, tv.vendas,
         COALESCE(ti.receita_com_custo, 0) AS receita_com_custo,
         COALESCE(ti.cmv, 0)               AS cmv,
         COALESCE(ti.itens, 0)             AS itens,
         COALESCE(ti.itens_com_custo, 0)   AS itens_com_custo,
         COALESCE(ti.produtos_sem_custo, 0) AS produtos_sem_custo
    FROM tv LEFT JOIN ti ON ti.company_id = tv.company_id`;

const SQL_PRODUTOS_SEM_CUSTO = `
  WITH ${ITENS_DO_PERIODO}
  SELECT item.product_id,
         COALESCE(MAX(p.name), MAX(item.product_name_snapshot), 'Produto') AS nome,
         COALESCE(SUM(item.receita), 0) AS receita,
         COALESCE(SUM(item.qtd), 0)     AS quantidade
    FROM item
    LEFT JOIN products p ON p.id = item.product_id
   WHERE NOT item.com_custo
   GROUP BY item.product_id, CASE WHEN item.product_id IS NULL THEN item.product_name_snapshot END
   ORDER BY 3 DESC, 2 ASC
   LIMIT $4`;

const SQL_LANCAMENTOS = `
  SELECT company_id,
         COALESCE(SUM(amount) FILTER (WHERE type = 'income'  AND cat = ANY($4::text[])), 0) AS troca_venda,
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND cat = ANY($5::text[])), 0) AS troca_devolucao,
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND cat = ANY($6::text[])), 0) AS compras,
         COUNT(*) FILTER (WHERE type = 'expense' AND cat = ANY($6::text[]))::int            AS n_compras,
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense'
                                        AND NOT (cat = ANY($5::text[]))
                                        AND NOT (cat = ANY($6::text[]))), 0)                AS despesas
    FROM (
      SELECT company_id, type, amount::numeric AS amount, lower(btrim(COALESCE(category, ''))) AS cat
        FROM transactions
       WHERE company_id = ANY($1::uuid[])
         AND status = 'confirmed'
         AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= $2::date
         AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= $3::date
    ) t
   GROUP BY company_id`;

// ── Montagem (pura) ─────────────────────────────────────────────

function zerada() {
  return {
    n_vendas: 0, vendas: 0, receita_com_custo: 0, cmv: 0, itens: 0, itens_com_custo: 0,
    produtos_sem_custo: 0, troca_venda: 0, troca_devolucao: 0, compras: 0, n_compras: 0, despesas: 0,
  };
}

function somar(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = num(a[k]) + num(b[k]);
  return out;
}

/**
 * Transforma as somas brutas de UMA empresa (ou do grupo) nos números da tela.
 * Pura: os testes de unidade chamam direto.
 */
function numerosDasSomas(s) {
  const vendas = centavos(s.vendas);
  const trocaVenda = centavos(s.troca_venda);
  const trocaDevolucao = centavos(s.troca_devolucao);
  const receitaComCusto = centavos(s.receita_com_custo);
  const cmv = centavos(s.cmv);
  const temCusto = receitaComCusto > 0;
  const lucro = temCusto ? centavos(receitaComCusto - cmv) : null;
  return {
    faturamento: centavos(vendas + trocaVenda - trocaDevolucao),
    vendas,
    vendas_qtd: int(s.n_vendas),
    trocas: { entrou: trocaVenda, devolvido: trocaDevolucao },
    custos: cmv,
    lucro_bruto: lucro,
    margem_pct: temCusto ? Math.round((lucro / receitaComCusto) * 1000) / 10 : null,
    receita_com_custo: receitaComCusto,
    cobertura: {
      pct: vendas > 0 ? Math.min(100, Math.round((receitaComCusto / vendas) * 100)) : null,
      receita_sem_custo: centavos(Math.max(0, vendas - receitaComCusto)),
      itens: int(s.itens),
      itens_com_custo: int(s.itens_com_custo),
      produtos_sem_custo: int(s.produtos_sem_custo),
    },
    despesas: centavos(s.despesas),
    compras_pagas: { total: centavos(s.compras), lancamentos: int(s.n_compras) },
  };
}

/**
 * Junta as linhas das consultas (por company_id) no resultado da tela.
 * `empresas`: [{ id, nome }] na ordem que a tela mostra; com mais de uma, o
 * resultado traz `por_empresa`.
 */
function montarResultado({ empresas, de, ate, vendas = [], lancamentos = [], produtosSemCusto = [] }) {
  const porId = new Map(empresas.map((e) => [e.id, zerada()]));
  for (const r of vendas) {
    const alvo = porId.get(r.company_id);
    if (!alvo) continue;
    Object.assign(alvo, {
      n_vendas: r.n_vendas, vendas: r.vendas, receita_com_custo: r.receita_com_custo, cmv: r.cmv,
      itens: r.itens, itens_com_custo: r.itens_com_custo, produtos_sem_custo: r.produtos_sem_custo,
    });
  }
  for (const r of lancamentos) {
    const alvo = porId.get(r.company_id);
    if (!alvo) continue;
    Object.assign(alvo, {
      troca_venda: r.troca_venda, troca_devolucao: r.troca_devolucao,
      compras: r.compras, n_compras: r.n_compras, despesas: r.despesas,
    });
  }

  let total = zerada();
  for (const s of porId.values()) total = somar(total, s);
  // Produto sem custo vendido em duas lojas conta duas vezes no grupo (é um
  // cadastro em cada uma). No consolidado o número é a soma das lojas.
  const out = {
    periodo: { de, ate },
    consolidado: empresas.length > 1,
    empresas: empresas.length,
    ...numerosDasSomas(total),
    produtos_sem_custo: produtosSemCusto.map((p) => ({
      product_id: p.product_id || null,
      nome: p.nome || 'Produto',
      receita: centavos(p.receita),
      quantidade: num(p.quantidade),
    })),
  };

  if (empresas.length > 1) {
    out.por_empresa = empresas.map((e) => ({ company_id: e.id, nome: e.nome || 'Empresa', ...numerosDasSomas(porId.get(e.id)) }));
    out.cobertura.lojas_com_pouco_custo = out.por_empresa.filter(
      (e) => e.vendas > 0 && e.cobertura.pct !== null && e.cobertura.pct < COBERTURA_BAIXA_PCT
    ).length;
    out.cobertura.lojas_com_venda = out.por_empresa.filter((e) => e.vendas > 0).length;
  }
  return out;
}

// ── Função compartilhada ────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {Array<string|{id:string,nome?:string}>} opts.empresas  uma ou mais (consolidado)
 * @param {string}   opts.de   'AAAA-MM-DD' (inclusive, dia de São Paulo)
 * @param {string}   opts.ate  'AAAA-MM-DD' (inclusive)
 * @param {boolean} [opts.comProdutos=true] lista dos produtos vendidos sem custo
 * @param {object}  [opts.client] pg client/pool (padrão: config/database)
 */
async function resultadoDoPeriodo({ empresas, de, ate, comProdutos = true, client = db } = {}) {
  if (!dataValida(de) || !dataValida(ate)) {
    const e = new Error('Período inválido: use de e ate no formato AAAA-MM-DD');
    e.statusCode = 400;
    throw e;
  }
  if (de > ate) {
    const e = new Error('Período inválido: a data inicial é depois da final');
    e.statusCode = 400;
    throw e;
  }
  const lista = (empresas || []).map((x) => (typeof x === 'string' ? { id: x } : x)).filter((x) => x && x.id);
  if (!lista.length) return montarResultado({ empresas: [], de, ate });

  const ids = lista.map((x) => x.id);
  const base = [ids, de, ate];
  const [vendas, lancamentos, produtos] = await Promise.all([
    client.query(SQL_VENDAS, base),
    client.query(SQL_LANCAMENTOS, base.concat([CAT_TROCA_VENDA, CAT_TROCA_DEVOLUCAO, CAT_FORNECEDORES])),
    comProdutos ? client.query(SQL_PRODUTOS_SEM_CUSTO, base.concat([LIMITE_PRODUTOS_SEM_CUSTO])) : Promise.resolve({ rows: [] }),
  ]);
  return montarResultado({
    empresas: lista, de, ate,
    vendas: vendas.rows, lancamentos: lancamentos.rows, produtosSemCusto: produtos.rows,
  });
}

/** O período anterior de mesmo tamanho, colado antes de `de` (fallback). */
function periodoAnterior(de, ate) {
  const d0 = new Date(de + 'T12:00:00Z');
  const d1 = new Date(ate + 'T12:00:00Z');
  const dias = Math.round((d1 - d0) / 86400000) + 1;
  const fim = new Date(d0.getTime() - 86400000);
  const ini = new Date(fim.getTime() - (dias - 1) * 86400000);
  return { de: ini.toISOString().slice(0, 10), ate: fim.toISOString().slice(0, 10) };
}

/** Só os números do período anterior (a tela compara; a lista não serve). */
function resumoParaComparar(r) {
  if (!r) return null;
  return {
    periodo: r.periodo,
    faturamento: r.faturamento,
    custos: r.custos,
    lucro_bruto: r.lucro_bruto,
    margem_pct: r.margem_pct,
    receita_com_custo: r.receita_com_custo,
    despesas: r.despesas,
    compras_pagas: r.compras_pagas,
  };
}

module.exports = {
  resultadoDoPeriodo,
  montarResultado,
  numerosDasSomas,
  periodoAnterior,
  resumoParaComparar,
  dataValida,
  CAT_FORNECEDORES,
  CAT_TROCA_VENDA,
  CAT_TROCA_DEVOLUCAO,
  _sql: { SQL_VENDAS, SQL_LANCAMENTOS, SQL_PRODUTOS_SEM_CUSTO },
};
