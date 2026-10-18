// Bloco "Custos" (18/10/2026, card f5-06): o custo de cada mês, lido do
// snapshot mensal (aura_revenue_snapshot.custos_detalhe e total_costs,
// migration 382), com a margem e o resultado depois de taxas e DAS.
//
// O número do card é o custo do mês corrente. Mês sem lançamento fica SEM
// número (null) e o resumo diz qual foi o último mês lançado: R$ 0 seria
// mentira — era o que a tela antiga mostrava lendo aura_operational_costs.
//
// Margem = mrr_total (que o job grava todo dia) − total_costs, calculada aqui
// na leitura. Resultado = margem − taxas da Asaas − DAS (fora de total_costs).
// O lançamento é POST /admin/painel/custos (routes/adminPainelCustos.js).
'use strict';

const b = require('./_base');
const custos = require('../custosMensais');

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MESES_EXTENSO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const rotuloMes = (ym) => MESES[parseInt(String(ym).slice(5, 7), 10) - 1] || ym;
const extenso = (ym) => MESES_EXTENSO[parseInt(String(ym).slice(5, 7), 10) - 1] || ym;
const mesAno = (ym) => `${rotuloMes(ym)}/${String(ym).slice(0, 4)}`;
const ouNull = (v) => (v === null || v === undefined ? null : b.round2(v));

// Meses mostrados: o corrente e os 5 anteriores.
const MESES_NO_BLOCO = 6;

async function lerSemQuebrar(db, hoje) {
  try {
    return await custos.lerMeses({ db, hoje, meses: MESES_NO_BLOCO });
  } catch (err) {
    // Coluna da 382 ausente (deploy antes da migration): o bloco fica vazio.
    if (err && (err.code === '42P01' || err.code === '42703')) {
      console.warn('[painel] custos sem a migration 382:', err.message);
      return [];
    }
    throw err;
  }
}

function resumoDoMes(linha) {
  const lancado = custos.temCusto(linha);
  const mrr = b.round2(linha.mrr_total);
  const valor = lancado ? b.round2(linha.total_costs) : null;
  const taxas = ouNull(linha.taxas_asaas);
  const das = ouNull(linha.das);
  const margem = lancado ? b.round2(mrr - valor) : null;
  const itens = custos.itensDoMes(linha);
  const somaItens = b.round2(itens.reduce((t, i) => t + i.valor, 0));
  return {
    mes: linha.mes,
    lancado,
    mrr,
    custos: valor,
    margem,
    taxas_asaas: taxas,
    das,
    resultado: lancado ? b.round2(margem - b.num(taxas) - b.num(das)) : null,
    itens,
    // soma das categorias diferente do total gravado (correção à mão no banco)
    divergente: lancado && itens.length > 0 && somaItens !== valor,
    sem_abertura: b.round2(itens.filter((i) => i.categoria === 'demais' || i.categoria === 'sem_abertura').reduce((t, i) => t + i.valor, 0)),
  };
}

async function calcular({ hoje, db = b.pool } = {}) {
  const mesAtual = custos.mesDe(hoje);
  const linhas = await lerSemQuebrar(db, hoje);
  const porMes = new Map(linhas.map((l) => [l.mes, resumoDoMes(l)]));

  // Os 6 meses em ordem, com buraco quando não há linha.
  const meses = [];
  for (let i = MESES_NO_BLOCO - 1; i >= 0; i -= 1) {
    const [y, m] = mesAtual.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const ym = d.toISOString().slice(0, 7);
    meses.push(porMes.get(ym) || {
      mes: ym, lancado: false, mrr: null, custos: null, margem: null, taxas_asaas: null, das: null,
      resultado: null, itens: [], divergente: false, sem_abertura: 0,
    });
  }
  const atual = meses[meses.length - 1];
  const fechados = meses.slice(0, -1).filter((m) => m.lancado);
  const ultimoFechado = fechados.length ? fechados[fechados.length - 1] : null;
  // Mês que a lista por categoria detalha: o corrente, ou o último lançado.
  const referencia = atual.lancado ? atual : ultimoFechado;

  const serie = meses.map((m) => ({
    rotulo: rotuloMes(m.mes),
    mes: m.mes,
    valor: m.custos,
    ...(m.lancado ? {} : { texto: 'sem lançamento' }),
  }));

  const origem = (i) => custos.rotuloOrigem(i.origem) || 'não informada';
  const porCategoria = referencia
    ? referencia.itens.map((i) => ({
      categoria: i.rotulo,
      valor: i.valor,
      origem: origem(i),
      observacao: i.observacao,
      lancado_em: i.lancado_em,
    }))
    : [];
  const porMesLista = meses.slice().reverse().map((m) => ({
    mes_rotulo: mesAno(m.mes),
    mrr: m.mrr,
    custos: m.custos,
    margem: m.margem,
    taxas_asaas: m.taxas_asaas,
    das: m.das,
    resultado: m.resultado,
    situacao: !m.lancado ? 'Sem lançamento' : (m.sem_abertura > 0 ? 'Parte sem abertura' : 'Lançado'),
  }));
  const lancamentos = [];
  for (const m of meses.slice().reverse()) {
    for (const i of m.itens) {
      lancamentos.push({
        mes_rotulo: mesAno(m.mes),
        categoria: i.rotulo,
        valor: i.valor,
        origem: origem(i),
        observacao: i.observacao,
        lancado_em: i.lancado_em,
      });
    }
  }

  const Mes = (ym) => extenso(ym).replace(/^./, (c) => c.toUpperCase());
  let resumo;
  if (atual.lancado) {
    resumo = `Margem de ${extenso(atual.mes)}: ${b.brl(atual.margem)} · MRR ${b.brl(atual.mrr)}`;
  } else if (ultimoFechado) {
    resumo = `${Mes(atual.mes)} sem custo lançado · ${extenso(ultimoFechado.mes)}: ${b.brl(ultimoFechado.custos)}`;
  } else {
    resumo = 'Nenhum mês com custo lançado';
  }

  const avisos = [];
  if (!atual.lancado) {
    avisos.push(`${Mes(atual.mes)} ainda sem custo lançado: sem ele não há margem nem caixa projetado do mês. Lance em "Lançar custo do mês"`);
  }
  const comSobra = meses.filter((m) => m.sem_abertura > 0);
  if (comSobra.length) {
    const total = b.round2(comSobra.reduce((t, m) => t + m.sem_abertura, 0));
    avisos.push(`${b.plural(comSobra.length, 'mês tem', 'meses têm')} ${b.brl(total)} sem abertura por categoria (${comSobra.map((m) => rotuloMes(m.mes)).join(', ')})`);
  }
  const divergentes = meses.filter((m) => m.divergente);
  if (divergentes.length) {
    avisos.push(`Soma das categorias diferente do total gravado em ${divergentes.map((m) => rotuloMes(m.mes)).join(', ')}`);
  }

  return b.montarBloco({
    valor: atual.lancado ? atual.custos : null,
    unidade: 'R$ no mês',
    resumo,
    serie,
    linhas: porMesLista,
    fonte: 'aura_revenue_snapshot (custos_detalhe, lançamento mensal)',
    indicadores: [
      b.indicador(`Custos · ${rotuloMes(atual.mes)}`, atual.custos, atual.lancado ? b.plural(atual.itens.length, 'categoria', 'categorias') : 'sem lançamento'),
      b.indicador(`Margem bruta · ${rotuloMes(atual.mes)}`, atual.margem, atual.lancado ? 'MRR − custos' : 'sem custo lançado'),
      b.indicador(
        ultimoFechado ? `Custos · ${rotuloMes(ultimoFechado.mes)}` : 'Último mês lançado',
        ultimoFechado ? ultimoFechado.custos : null,
        ultimoFechado ? `margem ${b.brl(ultimoFechado.margem)}` : 'nenhum'
      ),
      b.indicador(
        ultimoFechado ? `Resultado · ${rotuloMes(ultimoFechado.mes)}` : 'Resultado',
        ultimoFechado ? ultimoFechado.resultado : null,
        'depois de taxas da Asaas e DAS'
      ),
    ],
    listas: [
      b.lista(
        referencia ? `Por categoria · ${mesAno(referencia.mes)}` : 'Por categoria',
        [b.col('categoria', 'Categoria'), b.col('valor', 'Valor', 'moeda'), b.col('origem', 'Origem'), b.col('observacao', 'Observação'), b.col('lancado_em', 'Lançado em', 'data_hora')],
        porCategoria
      ),
      b.lista(
        'Por mês',
        [b.col('mes_rotulo', 'Mês'), b.col('mrr', 'MRR', 'moeda'), b.col('custos', 'Custos', 'moeda'), b.col('margem', 'Margem', 'moeda'),
          b.col('taxas_asaas', 'Taxas Asaas', 'moeda'), b.col('das', 'DAS', 'moeda'), b.col('resultado', 'Resultado', 'moeda'), b.col('situacao', 'Situação')],
        porMesLista
      ),
      b.lista(
        'Lançamentos por mês e categoria',
        [b.col('mes_rotulo', 'Mês'), b.col('categoria', 'Categoria'), b.col('valor', 'Valor', 'moeda'), b.col('origem', 'Origem'), b.col('observacao', 'Observação')],
        lancamentos
      ),
    ],
    series: [
      b.serieDe('Custos por mês', 'barras', serie),
      b.serieDe(
        referencia ? `Por categoria · ${mesAno(referencia.mes)}` : 'Por categoria',
        'rosca',
        porCategoria.map((c) => ({ rotulo: c.categoria, valor: c.valor, texto: b.brl(c.valor) }))
      ),
    ],
    insight: avisos.length ? `${avisos.join(' · ')}.` : null,
  });
}

module.exports = { calcular };
