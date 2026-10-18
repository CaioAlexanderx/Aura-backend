// Bloco "Uso por funcionalidade": lojas distintas por módulo em 7 dias, no
// período e desde sempre — e quais lojas, por nome.
'use strict';

const b = require('./_base');
const { usoPorModulo, SEM_MEDIDA } = require('./_uso');

// "Uso amplo" = pelo menos um quarto das lojas que entraram no período.
const FATIA_AMPLO = 0.25;

async function calcular({ hoje, periodo = 30, db = b.pool, empresas, uso } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const [modulos, acesso] = await Promise.all([
    uso || usoPorModulo({ db, hoje, periodo }),
    b.acessoPorLoja(db, hoje, periodo),
  ]);
  const base = [...acesso.keys()].filter((id) => emp.porId.has(id)).length;

  const porLoja = [];
  const linhas = modulos.map((m) => {
    const lojas = [...m.lojas.entries()].filter(([id]) => emp.porId.has(id));
    const noPeriodo = lojas.filter(([, u]) => u.ep > 0);
    for (const [id, u] of noPeriodo) {
      porLoja.push({ modulo: m.rotulo, ...b.ref(emp.porId.get(id)), eventos: u.ep, ultimo_uso: b.diaDe(u.ultimo) });
    }
    return {
      modulo: m.id,
      rotulo: m.rotulo,
      lojas_7d: lojas.filter(([, u]) => u.e7 > 0).length,
      lojas_periodo: noPeriodo.length,
      eventos_periodo: noPeriodo.reduce((s, [, u]) => s + u.ep, 0),
      lojas_total: lojas.length,
      lojas: noPeriodo
        .sort((x, y) => y[1].ep - x[1].ep)
        .map(([id]) => ({ company_id: id, nome: emp.porId.get(id).nome })),
    };
  }).sort((x, y) => y.lojas_periodo - x.lojas_periodo || y.lojas_total - x.lojas_total);

  // Funcionalidades sem fonte no banco (Etiquetas): aparecem na lista, com o
  // motivo, mas ficam fora de série, uso amplo/nicho e "sem uso" — zero aqui
  // seria afirmar que ninguém usa, e a verdade é que ninguém consegue medir.
  const semMedida = SEM_MEDIDA.map((m) => ({
    modulo: m.id, rotulo: m.rotulo, sem_medida: true, motivo: m.motivo,
    lojas_7d: null, lojas_periodo: null, eventos_periodo: null, lojas_total: null, lojas: [],
  }));

  const corte = Math.max(1, Math.ceil(base * FATIA_AMPLO));
  const amplos = linhas.filter((l) => l.lojas_periodo >= corte && l.lojas_periodo > 0);
  const nicho = linhas.filter((l) => l.lojas_periodo > 0 && l.lojas_periodo < corte);
  const parados = linhas.filter((l) => l.lojas_periodo === 0);
  const serie = linhas.map((l) => ({ rotulo: l.rotulo, valor: l.lojas_periodo }));
  porLoja.sort((x, y) => x.modulo.localeCompare(y.modulo) || y.eventos - x.eventos);

  return b.montarBloco({
    valor: amplos.length,
    unidade: `módulos com uso amplo · ${nicho.length} de nicho`,
    resumo: `Base: ${base} lojas com login em ${periodo} dias`,
    serie,
    linhas,
    fonte: 'tabelas de cada módulo (uso inferido)',
    indicadores: [
      b.indicador('Uso amplo', amplos.length, `${corte}+ lojas em ${periodo} dias`),
      b.indicador('De nicho', nicho.length),
      b.indicador('Sem uso no período', parados.length, parados.map((l) => l.rotulo).join(', ') || null),
      b.indicador('Sem medida', semMedida.length, semMedida.map((l) => l.rotulo).join(', ') || null),
      b.indicador('Lojas com login', base, `${periodo} dias`),
    ],
    listas: [
      b.lista('Por módulo', [
        b.col('rotulo', 'Módulo'), b.col('lojas_7d', 'Lojas 7d', 'numero'),
        b.col('lojas_periodo', `Lojas ${periodo}d`, 'numero'), b.col('eventos_periodo', `Eventos ${periodo}d`, 'numero'),
        b.col('lojas_total', 'Já usaram', 'numero'),
      ], [...linhas, ...semMedida]),
      b.lista(`Lojas por módulo · ${periodo} dias`, [
        b.col('modulo', 'Módulo'), b.colLoja(), b.col('eventos', 'Eventos', 'numero'), b.col('ultimo_uso', 'Último uso', 'data'),
      ], porLoja),
    ],
    series: [
      b.serieDe(`Lojas por módulo · ${periodo} dias`, 'barras_h', serie),
      b.serieDe('Menos usados', 'barras_h', serie.filter((p) => p.valor < corte).slice().reverse()),
    ],
    insight: 'O uso é inferido pelas tabelas de cada módulo. Telas só de leitura (Relatórios, Painel) aparecem em "Telas visitadas". '
      + semMedida.map((m) => `${m.rotulo} está sem medida: ${m.motivo}.`).join(' '),
  });
}

module.exports = { calcular };
