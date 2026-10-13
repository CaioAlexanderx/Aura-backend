// Bloco "Acesso": quantas lojas entram por semana (pagantes em destaque),
// dias ativos por pagante e quem nunca entrou.
'use strict';

const b = require('./_base');

const SEMANAS = 8;

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const semanas = b.ultimasSemanas(hoje, SEMANAS);

  const [porSemana, acesso, ultimos, acoes] = await Promise.all([
    b.consultar(
      db,
      `SELECT to_char(date_trunc('week', created_at AT TIME ZONE '${b.TZ}')::date, 'YYYY-MM-DD') AS semana,
              company_id
         FROM audit_log
        WHERE action IN ${b.ACOES_ACESSO} AND company_id IS NOT NULL
          AND created_at >= ($2::date::timestamp AT TIME ZONE '${b.TZ}')
          AND created_at < (($1::date + 1)::timestamp AT TIME ZONE '${b.TZ}')
        GROUP BY 1, 2`,
      [hoje, semanas[0]]
    ),
    b.acessoPorLoja(db, hoje, periodo),
    b.consultar(
      db,
      `SELECT company_id, MAX(created_at) AS ultimo
         FROM audit_log
        WHERE action IN ${b.ACOES_ACESSO} AND company_id IS NOT NULL
        GROUP BY company_id`
    ),
    b.consultar(
      db,
      `SELECT action, COUNT(*) AS n, COUNT(DISTINCT company_id) AS lojas
         FROM audit_log
        WHERE action IN ('login', 'login_failed', 'switch_company')
          AND created_at >= ${b.desde(periodo)}
        GROUP BY action`,
      [hoje]
    ),
  ]);

  const serie = semanas.map((s) => {
    const lojas = porSemana.filter((r) => r.semana === s && emp.porId.has(r.company_id));
    return {
      rotulo: b.rotuloDia(s),
      valor: lojas.length,
      pagantes: lojas.filter((r) => emp.porId.get(r.company_id).pagante).length,
    };
  });

  const ultimoDe = new Map(ultimos.map((r) => [r.company_id, r.ultimo]));
  const linhaDe = (e) => ({
    ...b.ref(e),
    plano: b.PLANO_ROTULO[e.plan] || e.plan,
    situacao: e.pagante ? 'Pagante' : 'Trial',
    dias_ativos: (acesso.get(e.company_id) || {}).dias_ativos || 0,
    ultimo_login: b.diaDe(ultimoDe.get(e.company_id)),
    eh_dojo: e.eh_dojo,
  });

  const linhas = emp.pagantes.map(linhaDe).sort((x, y) => y.dias_ativos - x.dias_ativos);
  const entraram = linhas.filter((l) => l.dias_ativos > 0).length;
  // Quem nunca entrou: pagantes e trials (os dojôs em trial ficam de fora —
  // são cadastro da federação, não conta que alguém abriu).
  const nunca = emp.lista
    .filter((e) => !ultimoDe.has(e.company_id) && (e.pagante || !e.eh_dojo))
    .map(linhaDe)
    .sort((x, y) => (x.situacao === y.situacao ? 0 : x.situacao === 'Pagante' ? -1 : 1));
  const pagantesNunca = nunca.filter((l) => l.situacao === 'Pagante').length;

  const acao = (a) => acoes.find((r) => r.action === a) || { n: 0, lojas: 0 };
  const lojasNoPeriodo = [...acesso.keys()].filter((id) => emp.porId.has(id)).length;

  return b.montarBloco({
    valor: entraram,
    unidade: `de ${linhas.length} pagantes entraram em ${periodo} dias`,
    resumo: `${b.plural(pagantesNunca, 'pagante nunca entrou', 'pagantes nunca entraram')} · ${serie[serie.length - 1].valor} lojas ativas na semana`,
    serie,
    linhas,
    fonte: "audit_log (action 'login' e 'switch_company')",
    indicadores: [
      b.indicador(`Logins · ${periodo}d`, b.num(acao('login').n), `${lojasNoPeriodo} lojas`),
      b.indicador('Dias ativos · mediana', b.mediana(linhas.map((l) => l.dias_ativos)), `pagantes, de ${periodo}`),
      b.indicador('Login falhou', b.num(acao('login_failed').n), `${periodo} dias`),
      b.indicador('Trocas de loja', b.num(acao('switch_company').n), 'grupos multi-CNPJ'),
    ],
    listas: [
      b.lista(`Dias ativos por pagante · ${periodo} dias`, [
        b.colLoja(), b.col('plano', 'Plano'), b.col('dias_ativos', 'Dias ativos', 'numero'),
        b.col('ultimo_login', 'Último login', 'data'),
      ], linhas),
      b.lista('Quem nunca entrou', [b.colLoja(), b.col('situacao', 'Situação'), b.col('plano', 'Plano')], nunca),
    ],
    series: [
      b.serieDe('Lojas com login por semana', 'linha', serie),
      b.serieDe(`Dias ativos por pagante · ${periodo} dias`, 'barras_h', linhas.map((l) => ({ rotulo: l.nome, valor: l.dias_ativos }))),
    ],
    insight: pagantesNunca
      ? `${nunca.filter((l) => l.situacao === 'Pagante').map((l) => l.nome).join(', ')}: pagando sem nunca ter entrado.`
      : null,
  });
}

module.exports = { calcular };
