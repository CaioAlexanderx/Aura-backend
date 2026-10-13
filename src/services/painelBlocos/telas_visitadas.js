// Bloco "Telas visitadas": lojas e visitas por tela do app, a partir do que
// o app envia em POST /usage/screens (tabela screen_views). Cobre o que o
// "Uso por funcionalidade" não enxerga: telas só de leitura.
'use strict';

const b = require('./_base');

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const rows = await b.opcional(
    db,
    `SELECT screen, company_id,
            COALESCE(SUM(views) FILTER (WHERE dia > $1::date - 7), 0) AS v7,
            COALESCE(SUM(views), 0) AS vp,
            MAX(last_at) AS ultimo
       FROM screen_views
      WHERE dia > $1::date - $2::int AND dia <= $1::date
      GROUP BY 1, 2`,
    [hoje, periodo]
  );
  const dados = rows.filter((r) => emp.porId.has(r.company_id));

  const telas = new Map();
  const porLoja = [];
  for (const r of dados) {
    const g = telas.get(r.screen) || { tela: r.screen, lojas_7d: 0, lojas_periodo: 0, visitas_7d: 0, visitas_periodo: 0, lojas: [] };
    const e = emp.porId.get(r.company_id);
    g.lojas_periodo += 1;
    g.visitas_periodo += b.num(r.vp);
    if (b.num(r.v7) > 0) { g.lojas_7d += 1; g.visitas_7d += b.num(r.v7); }
    g.lojas.push({ company_id: e.company_id, nome: e.nome });
    telas.set(r.screen, g);
    porLoja.push({ tela: r.screen, ...b.ref(e), visitas: b.num(r.vp), ultima_visita: b.diaDe(r.ultimo) });
  }
  const linhas = [...telas.values()].sort((x, y) => y.lojas_periodo - x.lojas_periodo || y.visitas_periodo - x.visitas_periodo);
  porLoja.sort((x, y) => x.tela.localeCompare(y.tela) || y.visitas - x.visitas);
  const serie = linhas.slice(0, 12).map((l) => ({ rotulo: l.tela, valor: l.lojas_periodo, visitas: l.visitas_periodo }));
  const lojas = new Set(dados.map((r) => r.company_id)).size;

  return b.montarBloco({
    valor: linhas.length,
    unidade: `telas visitadas em ${periodo} dias`,
    resumo: linhas.length
      ? `${b.plural(lojas, 'loja enviou', 'lojas enviaram')} navegação · mais vista: ${linhas[0].tela}`
      : 'Nenhuma navegação recebida ainda',
    serie,
    linhas,
    fonte: 'screen_views (enviado pelo app)',
    indicadores: [
      b.indicador('Telas', linhas.length),
      b.indicador('Lojas com navegação', lojas, `${periodo} dias`),
      b.indicador('Visitas', linhas.reduce((s, l) => s + l.visitas_periodo, 0), `${periodo} dias`),
    ],
    listas: [
      b.lista('Por tela', [
        b.col('tela', 'Tela'), b.col('lojas_7d', 'Lojas 7d', 'numero'), b.col('lojas_periodo', `Lojas ${periodo}d`, 'numero'),
        b.col('visitas_periodo', `Visitas ${periodo}d`, 'numero'),
      ], linhas),
      b.lista('Lojas por tela', [b.col('tela', 'Tela'), b.colLoja(), b.col('visitas', 'Visitas', 'numero'), b.col('ultima_visita', 'Última visita', 'data')], porLoja),
    ],
    series: [b.serieDe(`Lojas por tela · ${periodo} dias`, 'barras_h', serie)],
    insight: linhas.length ? null : 'O app começa a enviar as telas visitadas na próxima versão; até lá o bloco fica vazio.',
  });
}

module.exports = { calcular };
