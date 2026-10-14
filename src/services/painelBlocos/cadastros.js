// Bloco "Cadastros": contas novas por semana (sem os dojôs do Karatê).
'use strict';

const b = require('./_base');

const FRENTE = { varejo: 'Varejo', matcon: 'Matcon', otica: 'Ótica', assistencia: 'Assistência', studio: 'Studio', outro: 'Outro' };

// O código COMECAR é o do cadastro pelo site: routes/auth.js o trata como
// cadastro self-service, e quem se cadastra assim fica com access_code_used =
// 'COMECAR'. É cadastro do SITE, não convite — só outro código é "Código de
// convite". Card t2-13 (antes tudo com código aparecia como convite).
const CODIGO_DO_SITE = 'COMECAR';
const ORIGEM_SITE = 'Site (self-service)';
const ORIGEM_SITE_COMECAR = `Site (${CODIGO_DO_SITE})`;
const ORIGEM_CONVITE = 'Código de convite';

function origemDe(e) {
  if (!e.por_codigo) return ORIGEM_SITE;
  const codigo = String(e.codigo_acesso || '').trim().toUpperCase();
  return codigo === CODIGO_DO_SITE ? ORIGEM_SITE_COMECAR : ORIGEM_CONVITE;
}

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
    origem: origemDe(e),
    frente: FRENTE[e.segment] || 'Sem frente',
    plano: b.PLANO_ROTULO[e.plan] || e.plan,
    status: e.status,
  }));

  const contar = (campo) => {
    const m = new Map();
    for (const l of linhas) m.set(l[campo], (m.get(l[campo]) || 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([rotulo, valor]) => ({ rotulo, valor }));
  };
  const porCodigo = em7.filter((e) => origemDe(e) === ORIGEM_CONVITE).length;

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
      b.indicador('Por código de convite', linhas.filter((l) => l.origem === ORIGEM_CONVITE).length, `${periodo} dias`),
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

module.exports = { calcular, origemDe };
