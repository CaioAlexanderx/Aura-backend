// Bloco "Receita": MRR normalizado (services/receita.js) + o que a Asaas
// recebeu, atrasou e apagou (webhook_logs).
//
// O MRR vem da Asaas quando ela responde e da tabela de preços quando não; o
// bloco diz qual fonte usou e mostra as duas somas lado a lado. "Recebido" é
// dinheiro que entrou (RECEIVED/CONFIRMED), uma vez por cobrança, com os
// pagamentos sem loja marcados.
//
// A lista "Conferência com o extrato" é a dupla checagem contra o banco: o
// OFX anexado em /admin/painel/ofx (migration 373) casado com os repasses da
// Asaas, mês a mês. Mês sem extrato diz "sem extrato".
'use strict';

const b = require('./_base');
const { calcularMrr, ROTULO_FONTE } = require('../receita');
const { conferenciaPorMes } = require('../conciliacaoOfx');

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const rotuloMes = (ym) => MESES[parseInt(String(ym).slice(5, 7), 10) - 1] || ym;
const EVENTO = {
  PAYMENT_RECEIVED: 'Recebido', PAYMENT_CONFIRMED: 'Confirmado', PAYMENT_OVERDUE: 'Atrasado', PAYMENT_DELETED: 'Apagado',
};
const P = b.PAGAMENTO_ASAAS;
const COLUNAS_PAGAMENTO = [
  b.col('quando', 'Quando', 'data_hora'), b.colLoja(), b.col('valor', 'Valor', 'moeda'),
  b.col('vencimento', 'Vencimento', 'data'), b.col('situacao', 'Situação'), b.col('cliente_asaas', 'Cliente na Asaas'),
];

async function calcular({ hoje, periodo = 30, db = b.pool, empresas, mrr: mrrPronto } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const mrr = mrrPronto || await calcularMrr({ db });
  const mesAtual = hoje.slice(0, 7);

  const [snapshots, porMes, eventos, recebidos] = await Promise.all([
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
              COALESCE(SUM(NULLIF(${P}->>'value', '')::numeric), 0) AS total
         FROM webhook_logs
        WHERE provider = 'asaas'
          AND event = 'PAYMENT_OVERDUE'
          AND processed_at >= ((date_trunc('month', $1::date::timestamp) - INTERVAL '1 month') AT TIME ZONE '${b.TZ}')
        GROUP BY 1, 2`,
      [hoje]
    ),
    b.opcional(
      db,
      `SELECT id, company_id, event, processed_at,
              NULLIF(${P}->>'value', '')::numeric AS valor
         FROM webhook_logs
        WHERE provider = 'asaas'
          AND event IN ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED')
          AND processed_at >= ${b.desde(periodo)}
        ORDER BY processed_at DESC
        LIMIT 200`,
      [hoje]
    ),
    // Recebido no mês e no anterior, um por cobrança (o primeiro evento pago
    // de cada id): CONFIRMED seguido de RECEIVED não soma duas vezes.
    b.opcional(
      db,
      `SELECT DISTINCT ON (COALESCE(${P}->>'id', id::text))
              id, company_id, event, processed_at,
              to_char(date_trunc('month', processed_at AT TIME ZONE '${b.TZ}'), 'YYYY-MM') AS mes_recebido,
              NULLIF(${P}->>'value', '')::numeric AS valor,
              ${P}->>'id' AS pagamento_id,
              ${P}->>'customer' AS cliente_asaas,
              ${P}->>'dueDate' AS vencimento
         FROM webhook_logs
        WHERE provider = 'asaas'
          AND event IN ${b.EVENTOS_PAGOS}
          AND processed_at >= ((date_trunc('month', $1::date::timestamp) - INTERVAL '1 month') AT TIME ZONE '${b.TZ}')
        ORDER BY COALESCE(${P}->>'id', id::text), processed_at`,
      [hoje]
    ),
  ]);

  const serie = snapshots
    .map((s) => ({ rotulo: rotuloMes(s.mes), mes: s.mes, valor: b.round2(s.mrr_total) }))
    .reverse()
    .concat([{ rotulo: rotuloMes(mesAtual), mes: mesAtual, valor: mrr.mrr_total }]);

  const mesAnterior = b.somaDias(`${mesAtual}-01`, -1).slice(0, 7);
  const atrasadoMes = porMes.find((r) => r.mes === mesAtual && r.event === 'PAYMENT_OVERDUE') || { n: 0, total: 0 };

  const nomeDaLoja = (companyId) => {
    const loja = companyId ? emp.porId.get(companyId) : null;
    return {
      company_id: companyId || null,
      nome: loja ? loja.nome : (companyId ? 'Loja fora do painel' : 'Sem loja vinculada'),
      telefone: loja ? loja.telefone : null,
    };
  };
  const pagamentos = recebidos.map((r) => ({
    ...nomeDaLoja(r.company_id),
    log_id: r.id,
    mes: r.mes_recebido,
    quando: r.processed_at,
    valor: r.valor === null || r.valor === undefined ? null : b.round2(r.valor),
    vencimento: r.vencimento || null,
    pagamento_id: r.pagamento_id || null,
    cliente_asaas: r.cliente_asaas || null,
    sem_loja: !r.company_id,
    situacao: r.company_id ? 'Vinculado' : 'Sem loja',
  })).sort((x, y) => new Date(y.quando) - new Date(x.quando));
  const somaDoMes = (mes) => {
    const doMes = pagamentos.filter((p) => p.mes === mes);
    const orfaos = doMes.filter((p) => p.sem_loja);
    return {
      n: doMes.length,
      total: b.round2(doMes.reduce((t, p) => t + b.num(p.valor), 0)),
      sem_loja: orfaos.length,
      total_sem_loja: b.round2(orfaos.reduce((t, p) => t + b.num(p.valor), 0)),
      pagamentos: doMes,
    };
  };
  const recebidoMes = somaDoMes(mesAtual);
  const recebidoAnterior = somaDoMes(mesAnterior);

  // Asaas × banco, do mês mais novo para o mais antigo. Os dois meses que o
  // bloco já calculou entram como estão: o número da tabela é o do indicador.
  const chaveDoPagamento = (p) => ({ chave: p.pagamento_id || p.log_id, valor: p.valor });
  const conferencia = (await conferenciaPorMes({
    db,
    hoje,
    meses: 6,
    recebidos: {
      [mesAtual]: recebidoMes.pagamentos.map(chaveDoPagamento),
      [mesAnterior]: recebidoAnterior.pagamentos.map(chaveDoPagamento),
    },
  })).reverse();
  const linhasConferencia = conferencia.map((c) => ({
    mes: c.mes,
    mes_rotulo: `${c.rotulo}/${c.mes.slice(0, 4)}`,
    asaas: c.asaas,
    banco: c.banco,
    diferenca: c.diferenca,
    status: c.status,
    detalhe: c.detalhe,
    extrato_id: c.extratos.length ? c.extratos[c.extratos.length - 1].id : null,
  }));
  const notaRecebido = (r) => b.plural(r.n, 'pagamento', 'pagamentos')
    + (r.sem_loja ? ` · ${r.sem_loja} sem loja (${b.brl(r.total_sem_loja)})` : '');

  const linhasEventos = eventos.map((e) => ({
    ...nomeDaLoja(e.company_id),
    evento: EVENTO[e.event] || e.event,
    valor: e.valor === null || e.valor === undefined ? null : b.round2(e.valor),
    quando: e.processed_at,
    sem_loja: !e.company_id,
  }));
  const semLoja = recebidoMes.sem_loja + recebidoAnterior.sem_loja;

  // Dupla checagem: a mesma receita pelas duas fontes.
  const comp = mrr.comparativo || { asaas: null, tabela: mrr.mrr_total };
  const veioDaAsaas = mrr.fonte === 'asaas';
  const semEmpresa = (mrr.sem_empresa || []).map((a) => ({
    assinatura: a.asaas_subscription_id,
    cliente_asaas: a.asaas_customer_id,
    descricao: a.descricao,
    mrr: a.mrr,
    proximo_vencimento: a.proximo_vencimento,
  }));
  const foraDoMrr = (mrr.fora_do_mrr || []).map((a) => ({
    company_id: a.company_id,
    nome: a.nome,
    telefone: a.telefone,
    motivo: a.motivo,
    mrr: a.mrr,
    proximo_vencimento: a.proximo_vencimento,
  }));
  const somaMrr = (lista) => b.round2(lista.reduce((t, a) => t + b.num(a.mrr), 0));

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
  if (mrr.aviso) avisos.push(mrr.aviso.replace(/\.$/, ''));
  if (veioDaAsaas && comp.asaas !== comp.tabela) {
    avisos.push(`Asaas cobra ${b.brl(comp.asaas)} por mês; a tabela de preços diria ${b.brl(comp.tabela)}`);
  }
  if (semEmpresa.length) {
    avisos.push(`${b.plural(semEmpresa.length, 'assinatura ativa', 'assinaturas ativas')} na Asaas sem empresa (${b.brl(somaMrr(semEmpresa))} fora do MRR)`);
  }
  if ((mrr.duplicadas || []).length) {
    avisos.push(`${b.plural(new Set(mrr.duplicadas.map((d) => d.company_id)).size, 'loja', 'lojas')} com mais de uma assinatura ativa na Asaas`);
  }
  if (mrr.sem_cobranca.clientes) {
    avisos.push(`${b.plural(mrr.sem_cobranca.clientes, 'pagante', 'pagantes')} sem cobrança registrada (${b.brl(mrr.sem_cobranca.mrr_potencial)} fora do MRR)`);
  }
  for (const c of conferencia) {
    if (c.status === 'pendências') avisos.push(`Extrato de ${c.rotulo.toLowerCase()}: ${c.detalhe}`);
  }
  if (semLoja) avisos.push(`${b.plural(semLoja, 'pagamento', 'pagamentos')} sem loja vinculada desde ${rotuloMes(mesAnterior).toLowerCase()}`);

  return b.montarBloco({
    valor: mrr.mrr_total,
    unidade: 'R$ por mês',
    resumo: `Recebido em ${rotuloMes(mesAtual).toLowerCase()}: ${b.brl(recebidoMes.total)}`,
    serie,
    linhas,
    fonte: `${mrr.fonte_rotulo || ROTULO_FONTE.companies} · webhook_logs (Asaas)`,
    indicadores: [
      b.indicador('MRR pela Asaas', comp.asaas, comp.asaas === null ? (mrr.aviso ? 'Asaas não respondeu' : 'sem chave da Asaas') : 'fonte usada'),
      b.indicador('MRR pela tabela', comp.tabela, veioDaAsaas ? 'para conferir' : 'fonte usada'),
      b.indicador(`Recebido · ${rotuloMes(mesAnterior)}`, recebidoAnterior.total, notaRecebido(recebidoAnterior)),
      b.indicador(`Recebido · ${rotuloMes(mesAtual)}`, recebidoMes.total, notaRecebido(recebidoMes)),
      b.indicador('Atrasado', b.round2(atrasadoMes.total), 'no mês'),
      b.indicador('Ticket médio', ticket, 'por assinatura'),
      b.indicador('Sem cobrança registrada', mrr.sem_cobranca.mrr_potencial, b.plural(mrr.sem_cobranca.clientes, 'pagante', 'pagantes')),
    ],
    listas: [
      b.lista('Por plano e ciclo', [b.col('plano_ciclo', 'Plano e ciclo'), b.col('lojas', 'Lojas', 'numero'), b.col('mrr', 'MRR', 'moeda')], porPlanoCiclo),
      b.lista('Assinaturas', [b.colLoja(), b.col('plano', 'Plano'), b.col('ciclo', 'Ciclo'), b.col('mrr', 'MRR', 'moeda')], linhas.filter((l) => l.tem_cobranca)),
      b.lista('Sem cobrança registrada', [b.colLoja(), b.col('plano', 'Plano'), b.col('ciclo', 'Ciclo'), b.col('mrr', 'Valor de tabela', 'moeda')], linhas.filter((l) => !l.tem_cobranca)),
      b.lista(`Recebido em ${rotuloMes(mesAtual).toLowerCase()}`, COLUNAS_PAGAMENTO, recebidoMes.pagamentos),
      b.lista(`Recebido em ${rotuloMes(mesAnterior).toLowerCase()}`, COLUNAS_PAGAMENTO, recebidoAnterior.pagamentos),
      b.lista(
        'Conferência com o extrato',
        [b.col('mes_rotulo', 'Mês'), b.col('asaas', 'Asaas', 'moeda'), b.col('banco', 'Banco', 'moeda'), b.col('diferenca', 'Diferença', 'moeda'), b.col('status', 'Situação')],
        linhasConferencia
      ),
      b.lista('Assinaturas na Asaas sem empresa', [b.col('assinatura', 'Assinatura'), b.col('cliente_asaas', 'Cliente na Asaas'), b.col('descricao', 'Descrição'), b.col('mrr', 'MRR', 'moeda'), b.col('proximo_vencimento', 'Próximo vencimento', 'data')], semEmpresa),
      b.lista('Assinaturas ativas fora do MRR', [b.col('motivo', 'Motivo'), b.colLoja(), b.col('mrr', 'MRR', 'moeda'), b.col('proximo_vencimento', 'Próximo vencimento', 'data')], foraDoMrr),
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
