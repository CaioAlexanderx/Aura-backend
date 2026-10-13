// Bloco "Horário de uso": vendas por hora do dia (Brasília).
'use strict';

const b = require('./_base');

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const rows = await b.consultar(
    db,
    `SELECT company_id,
            EXTRACT(HOUR FROM created_at AT TIME ZONE '${b.TZ}')::int AS hora,
            COUNT(*) AS vendas
       FROM sales
      WHERE created_at >= ${b.desde(periodo)} AND ${b.VENDA_VALIDA}
      GROUP BY 1, 2`,
    [hoje]
  );
  const dados = rows
    .filter((r) => emp.porId.has(r.company_id))
    .map((r) => ({ company_id: r.company_id, hora: b.num(r.hora), vendas: b.num(r.vendas) }));

  const porHora = Array.from({ length: 24 }, (_, h) => dados.filter((d) => d.hora === h).reduce((s, d) => s + d.vendas, 0));
  const total = porHora.reduce((s, v) => s + v, 0);
  const pico = porHora.reduce((m, v, h) => (v > porHora[m] ? h : m), 0);
  const serie = porHora.map((v, h) => ({ rotulo: String(h), hora: h, valor: v }));
  const comercial = porHora.slice(10, 18).reduce((s, v) => s + v, 0);
  const pctComercial = total ? Math.round((comercial / total) * 100) : 0;
  // Primeira hora do dia que já concentra 2% das vendas: antes dela é seguro.
  const primeira = porHora.findIndex((v) => total > 0 && v / total >= 0.02);

  const porLoja = new Map();
  for (const d of dados) {
    const g = porLoja.get(d.company_id) || { vendas: 0, horas: {} };
    g.vendas += d.vendas;
    g.horas[d.hora] = (g.horas[d.hora] || 0) + d.vendas;
    porLoja.set(d.company_id, g);
  }
  const linhas = [...porLoja.entries()].map(([id, g]) => {
    const horaPico = Object.keys(g.horas).map(Number).reduce((m, h) => (g.horas[h] > (g.horas[m] || 0) ? h : m));
    return { ...b.ref(emp.porId.get(id)), vendas: g.vendas, hora_pico: `${horaPico}h` };
  }).sort((x, y) => y.vendas - x.vendas);

  return b.montarBloco({
    valor: total ? pico : null,
    unidade: 'h',
    resumo: total ? `pico · ${porHora[pico]} vendas` : `Nenhuma venda em ${periodo} dias`,
    serie,
    linhas,
    fonte: 'sales (America/Sao_Paulo)',
    indicadores: [
      b.indicador('Hora de pico', total ? `${pico}h` : null, total ? `${porHora[pico]} vendas` : null),
      b.indicador('Entre 10h e 18h', `${pctComercial}%`, 'das vendas'),
      b.indicador('Vendas no período', total, `${periodo} dias`),
      b.indicador('Janela segura para deploy', primeira > 0 ? `antes das ${primeira}h` : null),
    ],
    listas: [
      b.lista('Hora de pico por loja', [b.colLoja(), b.col('vendas', `Vendas ${periodo}d`, 'numero'), b.col('hora_pico', 'Pico')], linhas),
    ],
    series: [b.serieDe(`Vendas por hora · ${periodo} dias`, 'barras', serie)],
    insight: total
      ? `${pctComercial}% das vendas entre 10h e 18h. Deploy, migração e manutenção fora dessa janela.`
      : null,
  });
}

module.exports = { calcular };
