// Bloco "Contatos": quem chamou a Aura — WhatsApp do número da Aura (conversas
// do hub, services/contatosWhatsapp.js) e formulário do site (sales_leads com
// source 'site' ou 'site_partial').
//
// Sem AURA_COMPANY_ID (número ainda não ligado) a parte do WhatsApp é zero e a
// lista só tem o site — o bloco nunca quebra por falta de dado.
'use strict';

const b = require('./_base');
const plantao = require('../plantao');
const cw = require('../contatosWhatsapp');

const CANAL_SITE = { site: 'site', site_partial: 'site (incompleto)' };
const DIAS_DA_SERIE = 14;
const MAX_LINHAS = 300;

const horaBRT = (ts) => Math.floor(plantao.minutosDoDiaBRT(new Date(ts)) / 60);

async function calcular({ hoje, periodo = 30, db = b.pool, empresas } = {}) {
  const janela = Math.max(periodo, DIAS_DA_SERIE);
  const { desde, ate } = cw.janelaDeDias(hoje, janela);

  const [leads, whats] = await Promise.all([
    b.opcional(
      db,
      `SELECT id, name, phone, city, source, status, created_at, converted_company_id
         FROM sales_leads
        WHERE source IN ('site', 'site_partial')
          AND created_at >= ${b.desde(janela)}
        ORDER BY created_at DESC
        LIMIT 500`,
      [hoje]
    ),
    cw.carregarContatos({ db, desde, ate }),
  ]);

  // ── site ──
  const site = leads.map((r) => ({
    conversa_id: null,
    company_id: r.converted_company_id || null,
    nome: r.name,
    telefone: r.phone || null,
    cidade: r.city || null,
    canal: CANAL_SITE[r.source] || r.source,
    situacao: r.status,
    quando: r.created_at,
    dia: b.diaDe(r.created_at),
    primeira_resposta: null,
    tempo_ate_resposta: null,
    empresa: r.converted_company_id && empresas && empresas.porId.get(r.converted_company_id)
      ? empresas.porId.get(r.converted_company_id).nome
      : null,
    _hora: r.created_at ? horaBRT(r.created_at) : null,
    origem: 'site',
  }));

  // ── WhatsApp ──
  const whatsapp = whats.contatos.map((c) => ({
    conversa_id: c.conversa_id,
    company_id: c.empresa ? c.empresa.company_id : null,
    nome: c.nome,
    telefone: cw.mascararTelefone(c.telefone),
    cidade: null,
    canal: 'whatsapp',
    situacao: cw.SITUACAO_ROTULO[c.situacao],
    quando: c.chegou_em.toISOString(),
    dia: b.diaDe(c.chegou_em),
    primeira_resposta: c.resposta_humana_em ? c.resposta_humana_em.toISOString() : null,
    tempo_ate_resposta: c.espera_min === null ? null : cw.duracao(c.espera_min),
    empresa: c.empresa ? c.empresa.nome : null,
    _hora: horaBRT(c.chegou_em),
    origem: 'whatsapp',
    _c: c,
  }));

  const todos = [...whatsapp, ...site]
    .filter((l) => l.dia)
    .sort((x, y) => new Date(y.quando) - new Date(x.quando));
  const noPeriodo = todos.filter((l) => b.diasEntre(l.dia, hoje) < periodo);
  const naSemana = todos.filter((l) => b.diasEntre(l.dia, hoje) < 7);
  const waPeriodo = noPeriodo.filter((l) => l.origem === 'whatsapp');
  const waSemana = naSemana.filter((l) => l.origem === 'whatsapp');
  const sitePeriodo = noPeriodo.filter((l) => l.origem === 'site');
  const siteSemana = naSemana.filter((l) => l.origem === 'site');

  // ── séries ──
  const serie = Array.from({ length: DIAS_DA_SERIE }, (_, i) => {
    const dia = b.somaDias(hoje, i - (DIAS_DA_SERIE - 1));
    return { rotulo: b.rotuloDia(dia), dia, valor: todos.filter((l) => l.dia === dia).length };
  });
  const porHora = Array.from({ length: 24 }, (_, h) => noPeriodo.filter((l) => l._hora === h).length);
  const serieHora = porHora.map((v, h) => ({ rotulo: String(h), hora: h, valor: v }));

  // ── indicadores do WhatsApp (janela do período) ──
  const contatosWa = waPeriodo.map((l) => l._c);
  const aguardando = contatosWa.filter((c) => c.pendente_desde);
  const soAurinha = aguardando.filter((c) => c.resposta_aurinha_em).length;
  const respondidosAurinha = contatosWa.filter((c) => c.resposta_aurinha_em).length;
  const madrugada = contatosWa.filter((c) => plantao.emHorarioNoturno(c.chegou_em, null)).length;
  const esperas = contatosWa.filter((c) => c.espera_min !== null).map((c) => c.espera_min);
  const mediana = esperas.length ? b.mediana(esperas) : null;
  const novosDoSite = sitePeriodo.filter((l) => l.situacao === 'new' || l.situacao === 'novo').length;

  const linhas = noPeriodo.slice(0, MAX_LINHAS).map(({ _c, _hora, origem, ...linha }) => linha);

  const ultimo = todos[0];
  let resumo;
  if (ultimo) {
    resumo = `Último: ${b.rotuloDia(ultimo.dia)}, ${ultimo.origem === 'whatsapp' ? 'WhatsApp' : 'formulário do site'}`;
  } else {
    resumo = whats.ativo ? 'Nenhum contato no período' : 'Nenhum contato pelo site (WhatsApp da Aura ainda não ligado)';
  }

  return b.montarBloco({
    valor: naSemana.length,
    unidade: 'na semana',
    resumo,
    serie,
    linhas,
    fonte: "hub_messages/hub_conversations (WhatsApp da Aura) + sales_leads (source 'site', 'site_partial')",
    indicadores: [
      b.indicador('Na semana', naSemana.length, `${waSemana.length} WhatsApp · ${siteSemana.length} site`),
      b.indicador(`Em ${periodo} dias`, noPeriodo.length, `${waPeriodo.length} WhatsApp · ${sitePeriodo.length} site`),
      b.indicador('Sem resposta agora', aguardando.length, aguardando.length ? `${soAurinha} só com a Aurinha` : null),
      b.indicador('Primeira resposta (mediana)', mediana === null ? null : cw.duracao(mediana), mediana === null ? null : `${esperas.length} respondidos`),
      b.indicador('Respondidos pela Aurinha', respondidosAurinha),
      b.indicador('De madrugada (21h às 8h)', madrugada, 'WhatsApp'),
      b.indicador('Site ainda sem atendimento', novosDoSite),
      b.indicador('Viraram conta', noPeriodo.filter((l) => l.company_id).length),
    ],
    listas: [
      b.lista(`Contatos · ${periodo} dias`, [
        b.col('quando', 'Quando', 'data_hora'), b.col('nome', 'Quem'), b.col('telefone', 'Telefone'),
        b.col('cidade', 'Cidade'), b.col('canal', 'Canal'),
        b.col('primeira_resposta', 'Primeira resposta', 'data_hora'), b.col('tempo_ate_resposta', 'Demorou'),
        b.col('situacao', 'Situação'), b.col('empresa', 'Empresa'),
      ], linhas),
    ],
    series: [
      b.serieDe(`Contatos por dia · ${DIAS_DA_SERIE} dias`, 'barras', serie),
      b.serieDe(`Contatos por hora do dia · ${periodo} dias`, 'barras', serieHora),
    ],
    insight: aguardando.length
      ? `${b.plural(aguardando.length, 'contato aguarda', 'contatos aguardam')} resposta${soAurinha ? ` (${soAurinha} ${soAurinha === 1 ? 'já falou' : 'já falaram'} com a Aurinha)` : ''}.`
      : null,
  });
}

module.exports = { calcular };
