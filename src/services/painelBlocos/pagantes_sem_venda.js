// Bloco "Pagantes sem venda": dias desde a última venda de cada pagante.
// O período é o limite de dias sem vender que põe a loja na lista (7, 30, 90).
'use strict';

const b = require('./_base');

async function calcular({ hoje, periodo = 7, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const ultima = await b.ultimaVendaPorLoja(db);

  const todos = emp.pagantes.map((e) => {
    const v = ultima.get(e.company_id);
    const dia = v ? b.diaDe(v.ultima) : null;
    return {
      ...b.ref(e),
      plano: b.PLANO_ROTULO[e.plan] || e.plan,
      ciclo: b.CICLO_ROTULO[e.ciclo] || e.ciclo,
      ultima_venda_em: dia,
      dias_sem_venda: dia ? b.diasEntre(dia, hoje) : null, // null = nunca vendeu
      vence_em: e.vence_em,
      eh_dojo: e.eh_dojo,
    };
  });

  const linhas = todos
    .filter((l) => l.dias_sem_venda === null || l.dias_sem_venda > periodo)
    .sort((x, y) => {
      // Quem já vendeu e parou vem antes de quem nunca usou o Caixa.
      if ((x.dias_sem_venda === null) !== (y.dias_sem_venda === null)) return x.dias_sem_venda === null ? 1 : -1;
      return (y.dias_sem_venda || 0) - (x.dias_sem_venda || 0);
    });

  const anuaisParados = linhas.filter((l) => l.ciclo === 'Anual' && l.dias_sem_venda !== null);
  const serie = linhas.map((l) => ({
    rotulo: l.nome,
    valor: l.dias_sem_venda,
    texto: l.dias_sem_venda === null ? 'nunca' : `${l.dias_sem_venda} d`,
  }));

  return b.montarBloco({
    valor: linhas.length,
    unidade: `de ${todos.length}, há mais de ${periodo} dias`,
    resumo: `${b.plural(linhas.filter((l) => l.dias_sem_venda === null).length, 'nunca vendeu', 'nunca venderam')} pelo Caixa`,
    serie,
    linhas,
    fonte: 'companies, sales',
    indicadores: [
      b.indicador(`Sem venda há mais de ${periodo} dias`, linhas.filter((l) => l.dias_sem_venda !== null).length),
      b.indicador('Nunca venderam', linhas.filter((l) => l.dias_sem_venda === null).length, 'dojôs e federação não usam o Caixa'),
      b.indicador('Anuais parados', anuaisParados.length),
    ],
    listas: [
      b.lista('Pagantes sem venda', [
        b.colLoja(), b.col('plano', 'Plano'), b.col('ciclo', 'Ciclo'),
        b.col('ultima_venda_em', 'Última venda', 'data'), b.col('dias_sem_venda', 'Dias sem venda', 'numero'),
        b.col('vence_em', 'Vence', 'data'),
      ], linhas),
    ],
    series: [b.serieDe('Dias desde a última venda', 'barras_h', serie)],
    insight: anuaisParados.length
      ? `${anuaisParados.map((l) => l.nome).join(' e ')}: anual sem uso. É o churn que dá para evitar antes da renovação.`
      : null,
  });
}

module.exports = { calcular };
