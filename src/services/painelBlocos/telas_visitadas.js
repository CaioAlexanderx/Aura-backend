// Bloco "Telas visitadas": lojas e visitas por tela do app, a partir do que
// o app envia em POST /usage/screens (tabela screen_views). Cobre o que o
// "Uso por funcionalidade" não enxerga: telas só de leitura.
//
// 18/10/2026 (card t2-20): cada tela mostra também quantas visitas foram
// ENTRADA (a primeira tela depois do login/cadastro, quase sempre o Painel) e
// quantas foram RETORNO (o usuário abriu a tela de novo). A marca é
// screen_views.views_login (migration 391, backend #852): retorno =
// views - views_login. O total (`views`) continua sendo entrada + retorno, e
// é o que o bloco já mostrava: nada que lia o total muda.
//
// A marca só existe a partir de 17/10/2026 (o app começou a mandar às 20h10
// em Brasília). Antes disso a linha tem views_login = 0, que NÃO quer dizer
// "tudo retorno": quer dizer "sem origem". Por isso entrada e retorno somam
// só os dias >= ENTRADA_RETORNO_DESDE, e o bloco diz isso na tela.
'use strict';

const b = require('./_base');

const ENTRADA_RETORNO_DESDE = '2026-10-17';
const DESDE_ROTULO = b.rotuloDia(ENTRADA_RETORNO_DESDE);

const SQL_COM_ORIGEM = `SELECT screen, company_id,
            COALESCE(SUM(views) FILTER (WHERE dia > $1::date - 7), 0) AS v7,
            COALESCE(SUM(views), 0) AS vp,
            COALESCE(SUM(LEAST(views_login, views)) FILTER (WHERE dia >= $3::date), 0) AS ent,
            COALESCE(SUM(GREATEST(views - views_login, 0)) FILTER (WHERE dia >= $3::date), 0) AS ret,
            MAX(last_at) AS ultimo
       FROM screen_views
      WHERE dia > $1::date - $2::int AND dia <= $1::date
      GROUP BY 1, 2`;

// Sem a coluna (backend subiu antes da migration 391): só o total, como antes.
const SQL_SO_TOTAL = `SELECT screen, company_id,
            COALESCE(SUM(views) FILTER (WHERE dia > $1::date - 7), 0) AS v7,
            COALESCE(SUM(views), 0) AS vp,
            MAX(last_at) AS ultimo
       FROM screen_views
      WHERE dia > $1::date - $2::int AND dia <= $1::date
      GROUP BY 1, 2`;

async function lerVisitas(db, hoje, periodo) {
  try {
    return { rows: await b.consultar(db, SQL_COM_ORIGEM, [hoje, periodo, ENTRADA_RETORNO_DESDE]), separado: true };
  } catch (err) {
    if (!err || (err.code !== '42703' && err.code !== '42P01')) throw err;
    return { rows: await b.opcional(db, SQL_SO_TOTAL, [hoje, periodo]), separado: false };
  }
}

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const { rows, separado } = await lerVisitas(db, hoje, periodo);
  const dados = rows.filter((r) => emp.porId.has(r.company_id));
  // null = sem separação (coluna ausente): a lista mostra "—", não zero.
  const parte = (v) => (separado ? b.num(v) : null);

  const telas = new Map();
  const porLoja = [];
  for (const r of dados) {
    const g = telas.get(r.screen) || {
      tela: r.screen, lojas_7d: 0, lojas_periodo: 0, visitas_7d: 0, visitas_periodo: 0,
      entrada_periodo: parte(0), retorno_periodo: parte(0), lojas: [],
    };
    const e = emp.porId.get(r.company_id);
    g.lojas_periodo += 1;
    g.visitas_periodo += b.num(r.vp);
    if (separado) { g.entrada_periodo += b.num(r.ent); g.retorno_periodo += b.num(r.ret); }
    if (b.num(r.v7) > 0) { g.lojas_7d += 1; g.visitas_7d += b.num(r.v7); }
    g.lojas.push({ company_id: e.company_id, nome: e.nome });
    telas.set(r.screen, g);
    porLoja.push({
      tela: r.screen, ...b.ref(e), visitas: b.num(r.vp),
      entrada: parte(r.ent), retorno: parte(r.ret), ultima_visita: b.diaDe(r.ultimo),
    });
  }
  const linhas = [...telas.values()].sort((x, y) => y.lojas_periodo - x.lojas_periodo || y.visitas_periodo - x.visitas_periodo);
  porLoja.sort((x, y) => x.tela.localeCompare(y.tela) || y.visitas - x.visitas);
  const serie = linhas.slice(0, 12).map((l) => ({
    rotulo: l.tela, valor: l.lojas_periodo, visitas: l.visitas_periodo,
    entrada: l.entrada_periodo, retorno: l.retorno_periodo,
  }));
  const lojas = new Set(dados.map((r) => r.company_id)).size;

  const totalEntrada = separado ? linhas.reduce((s, l) => s + l.entrada_periodo, 0) : null;
  const totalRetorno = separado ? linhas.reduce((s, l) => s + l.retorno_periodo, 0) : null;
  const colEntrada = b.col('entrada_periodo', 'Entrada', 'numero');
  const colRetorno = b.col('retorno_periodo', 'Retorno', 'numero');

  // Entrada x retorno por tela, só as telas que tiveram visita com marca.
  const serieEntradaRetorno = separado
    ? linhas
      .filter((l) => l.entrada_periodo + l.retorno_periodo > 0)
      .slice(0, 12)
      .map((l) => ({
        rotulo: l.tela,
        valor: l.entrada_periodo + l.retorno_periodo,
        texto: `${l.entrada_periodo} entrada · ${l.retorno_periodo} retorno`,
      }))
    : [];

  const explicacao = `Entrada é a primeira tela aberta logo depois de entrar (quase sempre o Painel); retorno é o usuário abrir a tela de novo. Entrada e retorno contam desde ${DESDE_ROTULO} (a marca passou a ser gravada às 20h10 desse dia); antes disso só existe o total de visitas.`;

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
      b.indicador('Entradas (após login)', totalEntrada, separado ? `desde ${DESDE_ROTULO}` : 'sem a marca ainda'),
      b.indicador('Retornos', totalRetorno, separado ? `desde ${DESDE_ROTULO}` : 'sem a marca ainda'),
    ],
    listas: [
      b.lista(`Por tela · entrada e retorno desde ${DESDE_ROTULO}`, [
        b.col('tela', 'Tela'), b.col('lojas_7d', 'Lojas 7d', 'numero'), b.col('lojas_periodo', `Lojas ${periodo}d`, 'numero'),
        b.col('visitas_periodo', `Visitas ${periodo}d`, 'numero'), colEntrada, colRetorno,
      ], linhas),
      b.lista(`Lojas por tela · entrada e retorno desde ${DESDE_ROTULO}`, [
        b.col('tela', 'Tela'), b.colLoja(), b.col('visitas', 'Visitas', 'numero'),
        b.col('entrada', 'Entrada', 'numero'), b.col('retorno', 'Retorno', 'numero'),
        b.col('ultima_visita', 'Última visita', 'data'),
      ], porLoja),
    ],
    series: [
      b.serieDe(`Lojas por tela · ${periodo} dias`, 'barras_h', serie),
      ...(serieEntradaRetorno.length ? [b.serieDe(`Entrada e retorno por tela · desde ${DESDE_ROTULO}`, 'barras_h', serieEntradaRetorno)] : []),
    ],
    insight: linhas.length ? explicacao : 'O app começa a enviar as telas visitadas na próxima versão; até lá o bloco fica vazio.',
  });
}

module.exports = { calcular, ENTRADA_RETORNO_DESDE };
