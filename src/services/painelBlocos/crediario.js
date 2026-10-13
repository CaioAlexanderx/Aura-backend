// Bloco "Crediário": parcelas vencidas por loja (em aberto com vencimento
// antes de hoje). É a contagem crua das parcelas — a conferência contra o
// razão do cliente é da tela do crediário, não daqui.
'use strict';

const b = require('./_base');

async function calcular({ hoje, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const rows = await b.opcional(
    db,
    `SELECT company_id,
            COUNT(*) AS parcelas,
            COUNT(DISTINCT customer_id) AS clientes,
            COALESCE(SUM(amount_due - COALESCE(amount_paid, 0)), 0) AS valor,
            to_char(MIN(due_date), 'YYYY-MM-DD') AS mais_antiga
       FROM credit_installments
      WHERE status IN ('pending', 'open', 'overdue') AND due_date < $1::date
      GROUP BY company_id`,
    [hoje]
  );

  const linhas = rows.filter((r) => emp.porId.has(r.company_id)).map((r) => ({
    ...b.ref(emp.porId.get(r.company_id)),
    parcelas: b.num(r.parcelas),
    clientes: b.num(r.clientes),
    valor: b.round2(r.valor),
    mais_antiga: r.mais_antiga,
  })).sort((x, y) => y.parcelas - x.parcelas);

  const total = linhas.reduce((s, l) => s + l.parcelas, 0);
  const valor = b.round2(linhas.reduce((s, l) => s + l.valor, 0));
  const top2 = linhas.slice(0, 2);
  const fatia = total ? Math.round((top2.reduce((s, l) => s + l.parcelas, 0) / total) * 100) : 0;
  const serie = linhas.slice(0, 8).map((l) => ({ rotulo: l.nome, valor: l.parcelas }));

  return b.montarBloco({
    valor: total,
    unidade: `parcelas em ${b.plural(linhas.length, 'loja', 'lojas')}`,
    resumo: `${b.brl(valor)} vencidos`,
    serie,
    linhas,
    fonte: 'credit_installments',
    indicadores: [
      b.indicador('Parcelas vencidas', total),
      b.indicador('Valor vencido', valor),
      b.indicador('Lojas com atraso', linhas.length),
      b.indicador('Clientes em atraso', linhas.reduce((s, l) => s + l.clientes, 0)),
    ],
    listas: [
      b.lista('Parcelas vencidas por loja', [
        b.colLoja(), b.col('parcelas', 'Parcelas', 'numero'), b.col('clientes', 'Clientes', 'numero'),
        b.col('valor', 'Valor', 'moeda'), b.col('mais_antiga', 'Mais antiga', 'data'),
      ], linhas),
    ],
    series: [b.serieDe('Parcelas vencidas por loja', 'barras_h', serie)],
    insight: top2.length === 2
      ? `${top2[0].nome} e ${top2[1].nome} somam ${fatia}% do atraso da plataforma: o piloto da régua de cobrança começa por elas.`
      : null,
  });
}

module.exports = { calcular };
