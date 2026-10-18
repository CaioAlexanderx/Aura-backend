// Bloco "Adoção por recurso": de N pagantes, quantos usam cada recurso — e
// quem usa e quem não usa, por nome.
'use strict';

const b = require('./_base');
const { usoPorModulo } = require('./_uso');

async function calcular({ hoje, periodo = 30, db = b.pool, empresas, uso } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  // Recurso recém-medido e sem nenhum registro (Etiquetas, tq-23) fica fora:
  // 0/N seria afirmar que ninguém usa.
  const modulos = (uso || await usoPorModulo({ db, hoje, periodo })).filter((m) => !m.sem_dado);
  const pagantes = emp.pagantes;
  const de = pagantes.length;

  const linhas = modulos.map((m) => {
    const usam = pagantes.filter((e) => (m.lojas.get(e.company_id) || {}).ep > 0);
    const naoUsam = pagantes.filter((e) => !((m.lojas.get(e.company_id) || {}).ep > 0));
    return {
      recurso: m.id,
      rotulo: m.rotulo,
      usam: usam.length,
      de,
      texto: `${usam.length}/${de}`,
      lojas_usam: usam.map(b.ref),
      lojas_nao_usam: naoUsam.map(b.ref),
    };
  }).sort((x, y) => y.usam - x.usam);

  const metade = linhas.filter((l) => de > 0 && l.usam * 2 >= de);
  const poucos = linhas.filter((l) => l.usam > 0 && l.usam * 4 <= de);
  const serie = linhas.map((l) => ({ rotulo: l.rotulo, valor: l.usam, texto: l.texto }));

  const porLoja = [];
  for (const l of linhas) {
    for (const e of l.lojas_usam) porLoja.push({ recurso: l.rotulo, ...e, usa: true });
    for (const e of l.lojas_nao_usam) porLoja.push({ recurso: l.rotulo, ...e, usa: false });
  }

  return b.montarBloco({
    valor: metade.length,
    unidade: `recursos usados por metade dos ${de} pagantes`,
    resumo: linhas.slice(0, 3).map((l) => `${l.rotulo} ${l.texto}`).join(' · '),
    serie,
    linhas,
    fonte: 'tabelas de cada módulo, só pagantes',
    indicadores: [
      b.indicador('Pagantes', de),
      b.indicador('Usados por metade ou mais', metade.length),
      b.indicador('Usados por até um quarto', poucos.length, poucos.map((l) => l.rotulo).join(', ') || null),
    ],
    listas: [
      b.lista(`Adoção por recurso · ${periodo} dias`, [b.col('rotulo', 'Recurso'), b.col('usam', 'Usam', 'numero'), b.col('de', 'De', 'numero')], linhas),
      b.lista('Quem usa e quem não usa', [b.col('recurso', 'Recurso'), b.colLoja(), b.col('usa', 'Usa', 'booleano')], porLoja),
    ],
    series: [b.serieDe('Pagantes que usam', 'barras_h', serie)],
    insight: poucos.length
      ? `${poucos.map((l) => `${l.rotulo} (${l.texto})`).join(', ')}: ou o recurso não é encontrado, ou não é necessário. A resposta vem da próxima ligação de ativação.`
      : null,
  });
}

module.exports = { calcular };
