// Bloco "Pagantes": quem paga, em que plano e ciclo, quando vence e quanto usa.
'use strict';

const b = require('./_base');

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const [vendas, acesso] = await Promise.all([
    b.vendasPorLoja(db, hoje, periodo),
    b.acessoPorLoja(db, hoje, periodo),
  ]);

  const linhas = emp.pagantes.map((e) => ({
    ...b.ref(e),
    plano: b.PLANO_ROTULO[e.plan] || e.plan,
    ciclo: b.CICLO_ROTULO[e.ciclo] || e.ciclo,
    vence_em: e.vence_em,
    // Vencimento no passado numa conta ativa é dado errado (o webhook da
    // Asaas grava a data errada) — mostra, com o aviso, em vez de esconder.
    vencimento_suspeito: !!e.vence_em && e.vence_em < hoje,
    vendas: (vendas.get(e.company_id) || {}).vendas || 0,
    dias_ativos: (acesso.get(e.company_id) || {}).dias_ativos || 0,
    tem_cobranca: e.tem_cobranca,
    eh_dojo: e.eh_dojo,
  })).sort((x, y) => (x.vence_em || '9') < (y.vence_em || '9') ? -1 : 1);

  const porPlano = new Map();
  for (const l of linhas) {
    const g = porPlano.get(l.plano) || { rotulo: l.plano, valor: 0, anuais: 0 };
    g.valor += 1;
    if (l.ciclo === 'Anual') g.anuais += 1;
    porPlano.set(l.plano, g);
  }
  const serie = [...porPlano.values()].sort((x, y) => y.valor - x.valor);

  const naSemana = linhas.filter((l) => l.vence_em && l.vence_em >= hoje && b.diasEntre(hoje, l.vence_em) <= 7);
  const suspeitos = linhas.filter((l) => l.vencimento_suspeito);
  const semCobranca = linhas.filter((l) => !l.tem_cobranca);
  // Ativas que existem mas não contam como pagante (card t1-11): a Nina vê
  // quais são e por quê, em vez de filtrar à mão.
  const foraDaContagem = (emp.foraDaContagem || []).map((e) => ({
    ...b.ref(e),
    plano: b.PLANO_ROTULO[e.plan] || e.plan,
    motivo: b.motivoForaDaContagem(e),
  }));

  return b.montarBloco({
    valor: linhas.length,
    unidade: 'ativos',
    resumo: naSemana.length
      ? `Vencem esta semana: ${naSemana.map((l) => l.nome).join(', ')}`
      : 'Nenhum vencimento nesta semana',
    serie,
    linhas,
    fonte: 'companies, sales, audit_log',
    indicadores: [
      b.indicador('Pagantes', linhas.length),
      b.indicador('Anuais', linhas.filter((l) => l.ciclo === 'Anual').length),
      b.indicador('Vencem em 7 dias', naSemana.length),
      b.indicador('Sem cobrança registrada', semCobranca.length, 'sem assinatura na Asaas'),
      // Só aparece quando há alguém fora (o formato sem filial/dojô não muda).
      ...(foraDaContagem.length
        ? [b.indicador('Fora da contagem', foraDaContagem.length, 'filial paga pela matriz ou dojô sem assinatura')]
        : []),
    ],
    listas: [
      b.lista('Pagantes', [
        b.colLoja(), b.col('plano', 'Plano'), b.col('ciclo', 'Ciclo'), b.col('vence_em', 'Vence', 'data'),
        b.col('vendas', `Vendas ${periodo}d`, 'numero'), b.col('dias_ativos', 'Dias ativos', 'numero'),
      ], linhas),
      b.lista('Sem cobrança registrada', [b.colLoja(), b.col('plano', 'Plano'), b.col('ciclo', 'Ciclo')], semCobranca),
      ...(foraDaContagem.length
        ? [b.lista('Ativas fora da contagem', [b.colLoja(), b.col('plano', 'Plano'), b.col('motivo', 'Motivo')], foraDaContagem)]
        : []),
    ],
    series: [b.serieDe('Por plano', 'rosca', serie)],
    insight: suspeitos.length
      ? `${b.plural(suspeitos.length, 'pagante está', 'pagantes estão')} com o próximo vencimento no passado (${suspeitos.map((l) => l.nome).join(', ')}): a data gravada não confere com a Asaas.`
      : null,
  });
}

module.exports = { calcular };
