// Bloco "Trials por degrau": em que degrau cada cadastro recente parou.
// Só cadastro → com produtos → vendeu → viu o checkout → assinou. Sem os
// dojôs do Karatê (não passam pelo funil do varejo).
'use strict';

const b = require('./_base');

const DEGRAUS = [
  { id: 'so_cadastro', rotulo: 'Só cadastro' },
  { id: 'com_produtos', rotulo: 'Com produtos' },
  { id: 'vendeu', rotulo: 'Venderam' },
  { id: 'viu_checkout', rotulo: 'Viram checkout' },
  { id: 'assinou', rotulo: 'Assinaram' },
];

function degrauDe(e, f) {
  if (e.pagante) return 'assinou';
  if (f.checkout_em) return 'viu_checkout';
  if (f.vendas > 0) return 'vendeu';
  if (f.produtos > 0) return 'com_produtos';
  return 'so_cadastro';
}

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  // Filial paga pela matriz não é cadastro que assinou: fica fora do funil
  // (senão aparece como "Assinaram" ou, sem trial_ate, como trial vencido).
  const contas = emp.lista.filter((e) => !e.eh_dojo && !(e.pagante && e.fora_da_contagem)
    && e.criado_em && b.diasEntre(e.criado_em, hoje) < periodo);

  const rows = contas.length ? await b.consultar(
    db,
    `SELECT c.id AS company_id,
            (SELECT COUNT(*) FROM products p WHERE p.company_id = c.id) AS produtos,
            (SELECT COUNT(*) FROM sales s WHERE s.company_id = c.id AND COALESCE(s.status, 'completed') <> 'cancelled') AS vendas,
            (SELECT MAX(a.created_at) FROM audit_log a WHERE a.company_id = c.id AND a.action = 'checkout.viewed') AS checkout_em
       FROM companies c
      WHERE c.id = ANY($1::uuid[])`,
    [contas.map((e) => e.company_id)]
  ) : [];
  const funil = new Map(rows.map((r) => [r.company_id, {
    produtos: b.num(r.produtos), vendas: b.num(r.vendas), checkout_em: r.checkout_em || null,
  }]));

  // 13/10/2026: modo do trial (migration 379). Consulta a parte: sem as
  // colunas, b.opcional devolve [] e todo mundo aparece como 'fixo' — dentro
  // da consulta do funil, a coluna ausente derrubaria o bloco.
  const modoRows = contas.length ? await b.opcional(
    db,
    `SELECT c.id AS company_id, c.trial_mode, c.trial_started_by_sale_at
       FROM companies c
      WHERE c.id = ANY($1::uuid[])`,
    [contas.map((e) => e.company_id)]
  ) : [];
  const modo = new Map(modoRows.map((r) => [r.company_id, r]));

  const linhas = contas.map((e) => {
    const f = funil.get(e.company_id) || { produtos: 0, vendas: 0, checkout_em: null };
    const m = modo.get(e.company_id) || {};
    return {
      ...b.ref(e),
      degrau: degrauDe(e, f),
      produtos: f.produtos,
      vendas: f.vendas,
      viu_checkout_em: f.checkout_em,
      criado_em: e.criado_em,
      vence_em: e.pagante ? null : e.trial_ate,
      // 'primeira_venda' sem started_by_sale_at = o relógio ainda não começou
      // (vence_em é o teto de 15 dias do cadastro).
      trial_mode: m.trial_mode || 'fixo',
      started_by_sale_at: m.trial_started_by_sale_at || null,
      vencido: !e.pagante && !!e.trial_ate && e.trial_ate < hoje,
      plano: b.PLANO_ROTULO[e.plan] || e.plan,
      ciclo: e.pagante ? b.CICLO_ROTULO[e.ciclo] : null,
    };
  }).sort((x, y) => (x.vence_em || '9') < (y.vence_em || '9') ? -1 : 1);

  const total = linhas.length;
  const em = (id) => linhas.filter((l) => l.degrau === id);
  // Funil acumulado: quem assinou também vendeu, quem vendeu tem produto.
  const comProdutos = linhas.filter((l) => l.produtos > 0 || l.vendas > 0 || l.degrau === 'assinou').length;
  const venderam = linhas.filter((l) => l.vendas > 0).length;
  const viram = linhas.filter((l) => l.viu_checkout_em).length;
  const assinaram = em('assinou').length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const serie = [
    { rotulo: 'Cadastraram', valor: total, pct: 100 },
    { rotulo: 'Com produtos', valor: comProdutos, pct: pct(comProdutos) },
    { rotulo: 'Venderam', valor: venderam, pct: pct(venderam) },
    { rotulo: 'Viram checkout', valor: viram, pct: pct(viram) },
    { rotulo: 'Assinaram', valor: assinaram, pct: pct(assinaram) },
  ];
  const vencidos = linhas.filter((l) => l.vencido).length;
  const soCadastro = em('so_cadastro').length;
  const vendeuSemAssinar = em('vendeu').length + em('viu_checkout').filter((l) => l.vendas > 0).length;

  const colunas = [
    b.colLoja(), b.col('produtos', 'Produtos', 'numero'), b.col('vendas', 'Vendas', 'numero'),
    b.col('vence_em', 'Vence', 'data'), b.col('vencido', 'Vencido', 'booleano'), b.col('plano', 'Plano'),
  ];

  return b.montarBloco({
    valor: total,
    unidade: 'cadastros',
    resumo: `${b.plural(vencidos, 'vencido', 'vencidos')} · ${b.plural(assinaram, 'assinou', 'assinaram')}`,
    serie,
    linhas,
    fonte: 'companies (trial_mode), products, sales, audit_log (checkout.viewed)',
    indicadores: [
      b.indicador('Cadastros', total, `${periodo} dias, sem dojôs`),
      b.indicador('Trials vencidos', vencidos),
      b.indicador('Venderam sem assinar', vendeuSemAssinar, 'as ligações de hoje'),
      b.indicador('Assinaram', assinaram, `${pct(assinaram)}%`),
    ],
    listas: DEGRAUS.map((d) => b.lista(d.rotulo, colunas, em(d.id))),
    series: [b.serieDe('Funil', 'funil', serie)],
    insight: total
      ? `${soCadastro} de ${total} nunca cadastraram um produto. ${b.plural(vendeuSemAssinar, 'conta vendeu', 'contas venderam')} e ainda não assinou: são as ligações de hoje.`
      : null,
  });
}

module.exports = { calcular, DEGRAUS, degrauDe };
