// Bloco "Plataforma": vendas por dia em todas as lojas (o pulso do produto).
'use strict';

const b = require('./_base');

async function calcular({ hoje, periodo = 14, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const janela = Math.max(periodo, 14);
  const rows = await b.consultar(
    db,
    `SELECT company_id, ${b.diaBRT('created_at')} AS dia, COUNT(*) AS vendas
       FROM sales
      WHERE created_at >= ${b.desde(janela)} AND ${b.VENDA_VALIDA}
      GROUP BY 1, 2`,
    [hoje]
  );
  // Só lojas do painel: a venda sintética das contas internas fica de fora.
  const vendas = rows
    .filter((r) => emp.porId.has(r.company_id))
    .map((r) => ({ company_id: r.company_id, dia: r.dia, vendas: b.num(r.vendas) }));

  const noDia = (dia) => vendas.filter((v) => v.dia === dia).reduce((s, v) => s + v.vendas, 0);
  const somaJanela = (de, ate) => vendas.filter((v) => v.dia >= de && v.dia <= ate).reduce((s, v) => s + v.vendas, 0);

  // A série fecha em ontem: às 06h o dia de hoje ainda não tem venda.
  const ontem = b.somaDias(hoje, -1);
  const dias = Array.from({ length: janela }, (_, i) => b.somaDias(ontem, -(janela - 1 - i)));
  const serie = dias.map((d) => ({ rotulo: b.rotuloDia(d), dia: d, valor: noDia(d) }));

  const vendas7 = somaJanela(b.somaDias(ontem, -6), ontem);
  const vendas7Antes = somaJanela(b.somaDias(ontem, -13), b.somaDias(ontem, -7));
  const recorde = serie.reduce((m, p) => (p.valor > m.valor ? p : m), { valor: 0, rotulo: '—' });

  const porLoja = new Map();
  for (const v of vendas) {
    if (v.dia < b.somaDias(ontem, -6) || v.dia > ontem) continue;
    const g = porLoja.get(v.company_id) || { vendas_7d: 0, vendas_ontem: 0 };
    g.vendas_7d += v.vendas;
    if (v.dia === ontem) g.vendas_ontem += v.vendas;
    porLoja.set(v.company_id, g);
  }
  const linhas = [...porLoja.entries()]
    .map(([id, g]) => ({ ...b.ref(emp.porId.get(id)), ...g }))
    .sort((x, y) => y.vendas_7d - x.vendas_7d);
  const lojasOntem = linhas.filter((l) => l.vendas_ontem > 0).length;

  return b.montarBloco({
    valor: noDia(ontem),
    unidade: 'vendas ontem',
    resumo: `${vendas7} vendas em 7 dias · ${b.plural(lojasOntem, 'loja vendeu', 'lojas venderam')} ontem`,
    serie,
    linhas,
    fonte: 'sales',
    indicadores: [
      b.indicador('Vendas · 7 dias', vendas7, vendas7Antes ? `${vendas7 >= vendas7Antes ? '+' : ''}${Math.round(((vendas7 - vendas7Antes) / vendas7Antes) * 100)}% vs semana anterior` : null),
      b.indicador('Lojas vendendo · ontem', lojasOntem),
      b.indicador('Lojas vendendo · 7 dias', linhas.length),
      b.indicador('Recorde', recorde.valor, `em ${recorde.rotulo}, nos últimos ${janela} dias`),
    ],
    listas: [
      b.lista('Lojas vendendo · 7 dias', [b.colLoja(), b.col('vendas_7d', 'Vendas 7d', 'numero'), b.col('vendas_ontem', 'Ontem', 'numero')], linhas),
    ],
    series: [b.serieDe(`Vendas por dia · ${janela} dias`, 'barras', serie)],
    insight: null,
  });
}

module.exports = { calcular };
