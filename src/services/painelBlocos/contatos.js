// Bloco "Contatos": quem chamou pelo formulário do site (sales_leads com
// source 'site' ou 'site_partial'). WhatsApp entra quando a API estiver no ar.
'use strict';

const b = require('./_base');

const CANAL = { site: 'site', site_partial: 'site (incompleto)' };

async function calcular({ hoje, periodo = 30, db = b.pool } = {}) {
  const semanas = b.ultimasSemanas(hoje, 7);
  const janela = Math.max(periodo, b.diasEntre(semanas[0], hoje) + 1);
  const rows = await b.opcional(
    db,
    `SELECT id, name, phone, city, source, status, created_at, converted_company_id
       FROM sales_leads
      WHERE source IN ('site', 'site_partial')
        AND created_at >= ${b.desde(janela)}
      ORDER BY created_at DESC
      LIMIT 500`,
    [hoje]
  );

  const todos = rows.map((r) => ({
    company_id: r.converted_company_id || null,
    nome: r.name,
    telefone: r.phone || null,
    cidade: r.city || null,
    canal: CANAL[r.source] || r.source,
    situacao: r.status,
    quando: r.created_at,
    dia: b.diaDe(r.created_at),
  }));
  const serie = semanas.map((s) => ({
    rotulo: b.rotuloDia(s),
    valor: todos.filter((l) => l.dia && b.inicioDaSemana(l.dia) === s).length,
  }));
  const linhas = todos.filter((l) => l.dia && b.diasEntre(l.dia, hoje) < periodo);
  const naSemana = todos.filter((l) => l.dia && b.diasEntre(l.dia, hoje) < 7);
  const novos = linhas.filter((l) => l.situacao === 'new' || l.situacao === 'novo');

  return b.montarBloco({
    valor: naSemana.length,
    unidade: 'na semana',
    resumo: todos.length ? `Último: ${b.rotuloDia(todos[0].dia)}, formulário do site` : 'Nenhum contato pelo site',
    serie,
    linhas,
    fonte: "sales_leads (source 'site', 'site_partial')",
    indicadores: [
      b.indicador('Na semana', naSemana.length),
      b.indicador(`Em ${periodo} dias`, linhas.length),
      b.indicador('Ainda sem atendimento', novos.length),
      b.indicador('Viraram conta', linhas.filter((l) => l.company_id).length),
    ],
    listas: [
      b.lista(`Contatos · ${periodo} dias`, [
        b.col('quando', 'Quando', 'data_hora'), b.col('nome', 'Quem'), b.col('telefone', 'Telefone'),
        b.col('cidade', 'Cidade'), b.col('canal', 'Canal'), b.col('situacao', 'Situação'),
      ], linhas),
    ],
    series: [b.serieDe('Contatos por semana', 'barras', serie)],
    insight: null,
  });
}

module.exports = { calcular };
