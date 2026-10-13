// Bloco "Cadastros": contas novas por semana (sem os dojôs do Karatê).
'use strict';

const b = require('./_base');

const FRENTE = { varejo: 'Varejo', matcon: 'Matcon', otica: 'Ótica', assistencia: 'Assistência', studio: 'Studio', outro: 'Outro' };

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const contas = emp.lista.filter((e) => !e.eh_dojo && e.criado_em);

  const semanas = b.ultimasSemanas(hoje, 7);
  const serie = semanas.map((s) => ({
    rotulo: b.rotuloDia(s),
    valor: contas.filter((e) => b.inicioDaSemana(e.criado_em) === s).length,
  }));

  const em7 = contas.filter((e) => b.diasEntre(e.criado_em, hoje) < 7);
  const noPeriodo = contas
    .filter((e) => b.diasEntre(e.criado_em, hoje) < periodo)
    .sort((x, y) => (x.criado_em < y.criado_em ? 1 : -1));

  const linhas = noPeriodo.map((e) => ({
    ...b.ref(e),
    criado_em: e.criado_em,
    origem: e.por_codigo ? 'Código de convite' : 'Site (self-service)',
    frente: FRENTE[e.segment] || 'Sem frente',
    plano: b.PLANO_ROTULO[e.plan] || e.plan,
    status: e.status,
  }));

  const contar = (campo) => {
    const m = new Map();
    for (const l of linhas) m.set(l[campo], (m.get(l[campo]) || 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([rotulo, valor]) => ({ rotulo, valor }));
  };
  const porCodigo = em7.filter((e) => e.por_codigo).length;

  return b.montarBloco({
    valor: em7.length,
    unidade: 'em 7 dias',
    resumo: `${em7.length - porCodigo} self-service · ${porCodigo} por código`,
    serie,
    linhas,
    fonte: 'companies',
    indicadores: [
      b.indicador('Em 7 dias', em7.length),
      b.indicador(`Em ${periodo} dias`, linhas.length),
      b.indicador('Por código de convite', linhas.filter((l) => l.origem !== 'Site (self-service)').length, `${periodo} dias`),
    ],
    listas: [
      b.lista(`Cadastros · ${periodo} dias`, [
        b.colLoja(), b.col('criado_em', 'Cadastro', 'data'), b.col('origem', 'Origem'),
        b.col('frente', 'Frente'), b.col('plano', 'Plano'), b.col('status', 'Situação'),
      ], linhas),
    ],
    series: [
      b.serieDe('Cadastros por semana', 'barras', serie),
      b.serieDe(`Origem · ${periodo} dias`, 'barras_h', contar('origem')),
      b.serieDe('Frente escolhida', 'barras_h', contar('frente')),
    ],
    insight: linhas.length
      ? `${linhas.filter((l) => l.frente === 'Sem frente').length} de ${linhas.length} cadastros em ${periodo} dias estão sem frente atribuída.`
      : null,
  });
}

module.exports = { calcular };
