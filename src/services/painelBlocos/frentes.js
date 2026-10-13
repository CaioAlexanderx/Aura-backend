// Bloco "Frentes": pagantes e trials por frente do negócio.
'use strict';

const b = require('./_base');

const ROTULO = {
  varejo: 'Varejo', matcon: 'Matcon', otica: 'Ótica', assistencia: 'Assistência',
  studio: 'Studio', outro: 'Outro', karate: 'Karatê', sem_frente: 'Sem frente',
};

// A frente escolhida no cadastro (companies.segment) manda. As contas
// anteriores a ela só têm a vertical ligada — Karatê e Studio saem dali.
function frenteDe(e) {
  if (e.segment) return e.segment;
  if (e.vertical_active && String(e.vertical_active).startsWith('karate')) return 'karate';
  if (e.eh_dojo) return 'karate';
  if (e.vertical_active === 'studio') return 'studio';
  return 'sem_frente';
}

async function calcular({ db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const linhas = emp.lista.map((e) => ({
    ...b.ref(e),
    frente: ROTULO[frenteDe(e)] || frenteDe(e),
    situacao: e.pagante ? 'Pagante' : 'Trial',
    plano: b.PLANO_ROTULO[e.plan] || e.plan,
  }));

  const grupos = new Map();
  for (const l of linhas) {
    const g = grupos.get(l.frente) || { rotulo: l.frente, valor: 0, pagantes: 0, trials: 0 };
    g.valor += 1;
    g[l.situacao === 'Pagante' ? 'pagantes' : 'trials'] += 1;
    grupos.set(l.frente, g);
  }
  const serie = [...grupos.values()]
    .filter((g) => g.rotulo !== ROTULO.sem_frente)
    .sort((x, y) => y.valor - x.valor);
  const sem = grupos.get(ROTULO.sem_frente) || { valor: 0, pagantes: 0, trials: 0 };

  return b.montarBloco({
    valor: sem.valor,
    unidade: 'contas sem frente atribuída',
    resumo: serie.map((g) => `${g.rotulo} ${g.valor}`).join(' · ') || 'Nenhuma frente atribuída',
    serie,
    linhas,
    fonte: 'companies (segment, vertical)',
    indicadores: [
      b.indicador('Sem frente', sem.valor, `${sem.pagantes} pagantes · ${sem.trials} trials`),
      b.indicador('Frentes com conta', serie.length),
    ],
    listas: [
      b.lista('Contas por frente', [b.colLoja(), b.col('frente', 'Frente'), b.col('situacao', 'Situação'), b.col('plano', 'Plano')],
        linhas.slice().sort((x, y) => x.frente.localeCompare(y.frente) || String(x.nome).localeCompare(String(y.nome)))),
      b.lista('Sem frente atribuída', [b.colLoja(), b.col('situacao', 'Situação'), b.col('plano', 'Plano')],
        linhas.filter((l) => l.frente === ROTULO.sem_frente)),
    ],
    series: [b.serieDe('Contas por frente', 'barras_h', serie)],
    insight: sem.valor
      ? 'A frente só nasce no cadastro desde 06/10. As contas anteriores precisam de atribuição pela Gestão Aura.'
      : null,
  });
}

module.exports = { calcular, frenteDe };
