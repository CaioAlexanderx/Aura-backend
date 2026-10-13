// Bloco "Receita": MRR normalizado (services/receita.js) + o que a Asaas
// recebeu, atrasou e apagou (webhook_logs).
'use strict';

const b = require('./_base');
const { calcularMrr } = require('../receita');

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const rotuloMes = (ym) => MESES[parseInt(String(ym).slice(5, 7), 10) - 1] || ym;
const EVENTO = { PAYMENT_RECEIVED: 'Recebido', PAYMENT_OVERDUE: 'Atrasado', PAYMENT_DELETED: 'Apagado' };

async function calcular({ hoje, periodo = 30, db = b.pool, empresas, mrr: mrrPronto } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const mrr = mrrPronto || await calcularMrr({ db });
  const mesAtual = hoje.slice(0, 7);

  const [snapshots, porMes, eventos] = await Promise.all([
    b.opcional(
      db,
      `SELECT to_char(reference_month, 'YYYY-MM') AS mes, mrr_total
         FROM aura_revenue_snapshot
        WHERE reference_month < date_trunc('month', $1::date)::date
        ORDER BY reference_month DESC
        LIMIT 5`,
      [hoje]
    ),
    b.opcional(
      db,
      `SELECT to_char(date_trunc('month', processed_at AT TIME ZONE '${b.TZ}'), 'YYYY-MM') AS mes,
              event,
              COUNT(*) AS n,
              COALESCE(SUM(NULLIF(payload->'payment'->>'value', '')::numeric), 0) AS total
         FROM webhook_logs
        WHERE provider = 'asaas'
          AND event IN ('PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED')
          AND processed_at >= ((date_trunc('month', $1::date::timestamp) - INTERVAL '1 month') AT TIME ZONE '${b.TZ}')
        GROUP BY 1, 2`,
      [hoje]
    ),
    b.opcional(
      db,
      `SELECT id, company_id, event, processed_at,
              NULLIF(payload->'payment'->>'value', '')::numeric AS valor
         FROM webhook_logs
        WHERE provider = 'asaas'
          AND event IN ('PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED')
          AND processed_at >= ${b.desde(periodo)}
        ORDER BY processed_at DESC
        LIMIT 200`,
      [hoje]
    ),
  ]);

  const serie = snapshots
    .map((s) => ({ rotulo: rotuloMes(s.mes), mes: s.mes, valor: b.round2(s.mrr_total) }))
    .reverse()
    .concat([{ rotulo: rotuloMes(mesAtual), mes: mesAtual, valor: mrr.mrr_total }]);

  const mesAnterior = b.somaDias(`${mesAtual}-01`, -1).slice(0, 7);
  const doMes = (mes, evento) => porMes.find((r) => r.mes === mes && r.event === evento) || { n: 0, total: 0 };
  const recebidoMes = doMes(mesAtual, 'PAYMENT_RECEIVED');
  const recebidoAnterior = doMes(mesAnterior, 'PAYMENT_RECEIVED');
  const atrasadoMes = doMes(mesAtual, 'PAYMENT_OVERDUE');

  const linhasEventos = eventos.map((e) => {
    const loja = e.company_id ? emp.porId.get(e.company_id) : null;
    return {
      company_id: e.company_id || null,
      nome: loja ? loja.nome : (e.company_id ? 'Loja fora do painel' : 'Sem loja vinculada'),
      telefone: loja ? loja.telefone : null,
      evento: EVENTO[e.event] || e.event,
      valor: e.valor === null || e.valor === undefined ? null : b.round2(e.valor),
      quando: e.processed_at,
      sem_loja: !e.company_id,
    };
  });
  const semLoja = linhasEventos.filter((l) => l.sem_loja && l.evento === 'Recebido');

  const linhas = mrr.assinaturas.map((a) => ({
    company_id: a.company_id,
    nome: a.nome,
    telefone: a.telefone,
    plano: b.PLANO_ROTULO[a.plan] || a.plan,
    ciclo: b.CICLO_ROTULO[a.ciclo] || a.ciclo,
    mrr: a.mrr,
    tem_cobranca: a.tem_cobranca,
  })).sort((x, y) => y.mrr - x.mrr);

  const porPlanoCiclo = mrr.por_plano_ciclo.map((g) => ({
    plano_ciclo: `${b.PLANO_ROTULO[g.plan] || g.plan} ${(b.CICLO_ROTULO[g.ciclo] || g.ciclo).toLowerCase()}`,
    lojas: g.clientes,
    mrr: g.mrr,
  }));
  const ticket = mrr.com_cobranca ? b.round2(mrr.mrr_total / mrr.com_cobranca) : 0;

  const avisos = [];
  if (mrr.sem_cobranca.clientes) {
    avisos.push(`${b.plural(mrr.sem_cobranca.clientes, 'pagante', 'pagantes')} sem cobrança registrada (${b.brl(mrr.sem_cobranca.mrr_potencial)} fora do MRR)`);
  }
  if (semLoja.length) avisos.push(`${b.plural(semLoja.length, 'pagamento', 'pagamentos')} sem loja vinculada em ${periodo} dias`);

  return b.montarBloco({
    valor: mrr.mrr_total,
    unidade: 'R$ por mês',
    resumo: `Recebido em ${rotuloMes(mesAtual).toLowerCase()}: ${b.brl(recebidoMes.total)}`,
    serie,
    linhas,
    fonte: 'companies + tabela de preços (anual ÷ 12) · webhook_logs (Asaas)',
    indicadores: [
      b.indicador(`Recebido · ${rotuloMes(mesAnterior)}`, b.round2(recebidoAnterior.total), b.plural(b.num(recebidoAnterior.n), 'pagamento', 'pagamentos')),
      b.indicador(`Recebido · ${rotuloMes(mesAtual)}`, b.round2(recebidoMes.total), b.plural(b.num(recebidoMes.n), 'pagamento', 'pagamentos')),
      b.indicador('Atrasado', b.round2(atrasadoMes.total), 'no mês'),
      b.indicador('Ticket médio', ticket, 'por assinatura'),
      b.indicador('Sem cobrança registrada', mrr.sem_cobranca.mrr_potencial, b.plural(mrr.sem_cobranca.clientes, 'pagante', 'pagantes')),
    ],
    listas: [
      b.lista('Por plano e ciclo', [b.col('plano_ciclo', 'Plano e ciclo'), b.col('lojas', 'Lojas', 'numero'), b.col('mrr', 'MRR', 'moeda')], porPlanoCiclo),
      b.lista('Assinaturas', [b.colLoja(), b.col('plano', 'Plano'), b.col('ciclo', 'Ciclo'), b.col('mrr', 'MRR', 'moeda')], linhas.filter((l) => l.tem_cobranca)),
      b.lista('Sem cobrança registrada', [b.colLoja(), b.col('plano', 'Plano'), b.col('ciclo', 'Ciclo'), b.col('mrr', 'Valor de tabela', 'moeda')], linhas.filter((l) => !l.tem_cobranca)),
      b.lista(`Eventos da Asaas · ${periodo} dias`, [b.col('quando', 'Quando', 'data_hora'), b.colLoja(), b.col('evento', 'Evento'), b.col('valor', 'Valor', 'moeda')], linhasEventos),
    ],
    series: [
      b.serieDe('MRR por mês', 'linha', serie),
      b.serieDe('Por plano e ciclo', 'rosca', porPlanoCiclo.map((g) => ({ rotulo: g.plano_ciclo, valor: g.lojas, mrr: g.mrr }))),
    ],
    insight: avisos.length ? `${avisos.join(' · ')}. O cálculo mostra, não esconde.` : null,
  });
}

module.exports = { calcular };
