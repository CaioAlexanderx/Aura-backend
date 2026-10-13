// ============================================================
// AURA. — Placar do dia no WhatsApp do dono (13/10/2026)
//
// Plano da temporada de fim de ano: no fim do dia o dono recebe, no WhatsApp,
// o placar da loja — vendas, ticket médio, item mais vendido, comparação com
// a média dos mesmos dias da semana do mês anterior e o que entrou do
// crediário. Sem abrir o app.
//
// Quando sai (uma vez por dia por loja):
//   1. ao FECHAR O CAIXA (services/caixaService.fechar → dispararNoFechamento);
//   2. às 21h BRT, pelo job (jobs/placarDoDiaJob.js), para a loja que não
//      fecha caixa. Com caixa aberto o job espera o fechamento e só cobre a
//      loja às 23h, para um caixa esquecido aberto não apagar o placar.
// A unicidade é do próprio enfileiramento: dedupe_key = placar_dia:<loja>:<dia>
// em wa_outbox (índice único) — vale entre fechamento, job e instâncias.
//
// Quando NÃO sai:
//   - companies.placar_do_dia_enabled desligado (default; migration 377);
//   - fora da temporada (services/temporada.TEMPORADA, 01/11/2026 a
//     31/01/2027), a menos que companies.placar_do_dia_sempre esteja ligado;
//   - sem WhatsApp conectado ou sem telefone do dono → audit_log
//     'placar.sem_canal' UMA vez por loja e segue (nada quebra).
//
// Envio: TEMPLATE UTILITY `placar_dia` pela fila (waOutbox.enqueue). O dono é
// quem recebe, quase nunca com a janela de 24h aberta; texto livre seria
// pulado. O template precisa estar APROVADO na loja (POST /whatsapp/templates
// com preset 'placar_dia'); sem aprovação a fila grava 'skipped' e o placar
// registra sem_canal com o motivo.
//
// Tudo que depende de migration pendente (42703/42P01) degrada em silêncio:
// o backend sobe antes da 377 ser aplicada.
// ============================================================
'use strict';

const db = require('../config/database');
const { TEMPORADA, dentroDaTemporada } = require('./temporada');

const TZ = 'America/Sao_Paulo';
const TEMPLATE_NAME = 'placar_dia';
const SOURCE_TYPE = 'placar_dia';
const ACAO_SEM_CANAL = 'placar.sem_canal';

// Fechamento de madrugada (até 03h59) pertence ao dia anterior: a loja que
// fecha o caixa 00h30 depois de um sábado quer o placar do sábado.
const HORA_VIRADA_BRT = 4;

// Corpo do template. {{1}}..{{7}} saem de montarPlacar().parametros. Nenhuma
// variável no começo nem no fim (a Meta recusa) e nenhuma quebra de linha
// dentro de variável — por isso o texto é uma frase só.
const TEMPLATE = Object.freeze({
  name: TEMPLATE_NAME,
  language: 'pt_BR',
  category: 'UTILITY',
  body: 'Placar do dia — {{1}}, {{2}}. Vendas: {{3}}. Ticket médio: {{4}}. Mais vendido: {{5}}. {{6}}. Crediário recebido: {{7}}. Bom descanso!',
  footer: 'Para parar de receber, desligue o Placar do dia no app da Aura.',
  example: [
    'Loja Exemplo', 'terça, 15/12', '12 vendas, R$ 3.450,00', 'R$ 287,50',
    'Camiseta Azul (8 un.)', '12% acima da média das terças de novembro', 'R$ 350,00 (3 pagamentos)',
  ],
});

// ── datas (sempre 'YYYY-MM-DD', sem fuso) ───────────────────────
function hojeBRT(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

function utc(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function somaDias(ymd, n) {
  return new Date(utc(ymd) + n * 86400000).toISOString().slice(0, 10);
}

function diaDaSemana(ymd) {
  return new Date(utc(ymd)).getUTCDay(); // 0 = domingo
}

// Dia do placar de um fechamento de caixa.
function diaDoFechamento(closedAt = new Date()) {
  const t = new Date(new Date(closedAt).getTime() - 3 * 3600000);
  const dia = t.toISOString().slice(0, 10);
  return t.getUTCHours() < HORA_VIRADA_BRT ? somaDias(dia, -1) : dia;
}

// Primeiro e último dia do mês anterior ao de `dia`.
function mesAnterior(dia) {
  const [y, m] = dia.split('-').map(Number);
  const inicio = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const fim = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return { inicio, fim };
}

const SEMANA_SING = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const SEMANA_PLURAL = ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
  'setembro', 'outubro', 'novembro', 'dezembro'];

// ── formatação ──────────────────────────────────────────────────
function reais(v) {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

function qtd(v) {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}

// Parâmetro de template que a Meta aceita: nunca vazio, sem quebra de linha
// nem tab, sem 4+ espaços seguidos (erro 132012 queima a tentativa paga).
function waParam(value, fallback = '—') {
  const txt = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
  return txt || fallback;
}

// ── regra de temporada ──────────────────────────────────────────
// Ligado + (temporada ou "sempre"). `sempre` é o segundo campo: a loja pode
// ficar com o placar o ano todo.
function ativoNoDia(loja, dia, temporada = TEMPORADA) {
  if (!loja || loja.placar_do_dia_enabled !== true) return { ativo: false, motivo: 'DESLIGADO' };
  if (loja.placar_do_dia_sempre === true) return { ativo: true, motivo: null };
  if (!dentroDaTemporada(dia, temporada)) return { ativo: false, motivo: 'FORA_DA_TEMPORADA' };
  return { ativo: true, motivo: null };
}

// ── consultas ───────────────────────────────────────────────────
// Faixa [início, fim) do dia em Brasília — comparação direta com created_at
// para usar o índice (company_id, created_at).
const FAIXA = (a, b) =>
  `created_at >= ${a}::date::timestamp AT TIME ZONE '${TZ}'
   AND created_at <  (${b}::date + 1)::timestamp AT TIME ZONE '${TZ}'`;

function schemaAusente(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

// Vendas do período por dia (BRT). `net_total` é o valor líquido (troca
// desconta o que voltou) e a view já tira as canceladas; a contagem não
// inclui troca: uma troca não é uma venda a mais.
async function vendasPorDia(companyId, de, ate, banco) {
  try {
    const { rows } = await banco.query(
      `-- placar:vendas-por-dia
       SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia,
              COUNT(*) FILTER (WHERE type <> 'troca')::int AS qtd,
              COALESCE(SUM(net_total), 0) AS total
         FROM sales_liquid
        WHERE company_id = $1 AND ${FAIXA('$2', '$3')}
        GROUP BY 1`,
      [companyId, de, ate]
    );
    return rows;
  } catch (e) {
    if (!schemaAusente(e)) throw e;
    // View ausente (CI/deploy parcial): mesma conta direto na tabela.
    const { rows } = await banco.query(
      `-- placar:vendas-por-dia-fallback
       SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia,
              COUNT(*) FILTER (WHERE COALESCE(type, 'sale') <> 'troca')::int AS qtd,
              COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(type, 'sale') <> 'troca'), 0) AS total
         FROM sales
        WHERE company_id = $1 AND COALESCE(status, 'completed') <> 'cancelled'
          AND ${FAIXA('$2', '$3')}
        GROUP BY 1`,
      [companyId, de, ate]
    );
    return rows;
  }
}

async function maisVendido(companyId, dia, banco) {
  const montar = (nome) => `-- placar:mais-vendido
       SELECT ${nome} AS nome, SUM(si.quantity) AS qtd
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
        WHERE s.company_id = $1
          AND COALESCE(s.status, 'completed') <> 'cancelled'
          AND COALESCE(s.type, 'sale') <> 'troca'
          AND s.created_at >= $2::date::timestamp AT TIME ZONE '${TZ}'
          AND s.created_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
        GROUP BY 1
        ORDER BY SUM(si.quantity) DESC, SUM(si.total_price) DESC, 1
        LIMIT 1`;
  let rows;
  try {
    ({ rows } = await banco.query(
      montar(`COALESCE(NULLIF(TRIM(si.product_name_snapshot), ''), p.name, 'Produto')`), [companyId, dia]
    ));
  } catch (e) {
    if (e.code !== '42703') throw e;
    ({ rows } = await banco.query(montar(`COALESCE(p.name, 'Produto')`), [companyId, dia]));
  }
  return rows[0] ? { nome: rows[0].nome, qtd: Number(rows[0].qtd) || 0 } : null;
}

// Recebimentos do crediário do dia: pagamentos lançados no ledger, menos o
// "pagamento" que é crédito de troca (payment_method crediario_credito —
// não entrou dinheiro).
async function recebidoDoCrediario(companyId, dia, banco) {
  try {
    const { rows } = await banco.query(
      `-- placar:crediario-recebido
       SELECT COUNT(*)::int AS qtd, COALESCE(SUM(amount), 0) AS total
         FROM customer_credit_transactions
        WHERE company_id = $1 AND type = 'payment'
          AND payment_method IS DISTINCT FROM 'crediario_credito'
          AND ${FAIXA('$2', '$2')}`,
      [companyId, dia]
    );
    return { qtd: Number(rows[0]?.qtd) || 0, total: Number(rows[0]?.total) || 0 };
  } catch (e) {
    if (schemaAusente(e)) return { qtd: 0, total: 0 };
    throw e;
  }
}

// Média do mesmo dia da semana no mês anterior. Conta todas as ocorrências
// do dia da semana no mês (dia sem venda entra como zero: "as terças de
// novembro" inclui a terça em que a loja não vendeu). Sem nenhuma venda
// nessas datas não há base — null.
function compararComMesAnterior(dia, totalHoje, qtdHoje, linhasMesAnterior) {
  const { inicio, fim } = mesAnterior(dia);
  const alvo = diaDaSemana(dia);
  const porDia = new Map(linhasMesAnterior.map((r) => [r.dia, r]));
  let ocorrencias = 0;
  let soma = 0;
  let somaQtd = 0;
  for (let d = inicio; d <= fim; d = somaDias(d, 1)) {
    if (diaDaSemana(d) !== alvo) continue;
    ocorrencias++;
    const r = porDia.get(d);
    if (r) { soma += Number(r.total) || 0; somaQtd += Number(r.qtd) || 0; }
  }
  if (!ocorrencias || soma <= 0) return null;
  const media = soma / ocorrencias;
  const mediaQtd = somaQtd / ocorrencias;
  const variacao = Math.round(((totalHoje - media) / media) * 100);
  return {
    dia_da_semana: SEMANA_PLURAL[alvo],
    mes: MESES[Number(inicio.slice(5, 7)) - 1],
    ocorrencias,
    media_total: Math.round(media * 100) / 100,
    media_qtd: Math.round(mediaQtd * 10) / 10,
    variacao_pct: variacao,
    qtd_hoje: qtdHoje,
  };
}

function frasesDaComparacao(c) {
  if (!c) return 'Sem base de comparação com o mês anterior';
  const media = `média das ${c.dia_da_semana} de ${c.mes} (${reais(c.media_total)})`;
  if (c.variacao_pct === 0) return `Em linha com a ${media}`;
  const n = Math.abs(c.variacao_pct);
  return `${n}% ${c.variacao_pct > 0 ? 'acima' : 'abaixo'} da ${media}`;
}

// Monta os dados e o texto do placar de uma loja num dia. Não envia nada.
async function montarPlacar(companyId, dia, { loja = null, db: banco = db } = {}) {
  const mes = mesAnterior(dia);
  const [doMes, destaque, crediario] = await Promise.all([
    vendasPorDia(companyId, mes.inicio, dia, banco),
    maisVendido(companyId, dia, banco),
    recebidoDoCrediario(companyId, dia, banco),
  ]);

  const hoje = doMes.find((r) => r.dia === dia);
  const vendasQtd = hoje ? Number(hoje.qtd) || 0 : 0;
  const vendasTotal = hoje ? Math.round((Number(hoje.total) || 0) * 100) / 100 : 0;
  const ticket = vendasQtd > 0 ? Math.round((vendasTotal / vendasQtd) * 100) / 100 : null;
  const anterior = doMes.filter((r) => r.dia >= mes.inicio && r.dia <= mes.fim);
  const comparacao = compararComMesAnterior(dia, vendasTotal, vendasQtd, anterior);

  const dow = diaDaSemana(dia);
  const rotuloDia = `${SEMANA_SING[dow]}, ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

  const parametros = [
    waParam(loja, 'sua loja'),
    rotuloDia,
    vendasQtd > 0
      ? `${vendasQtd} ${vendasQtd === 1 ? 'venda' : 'vendas'}, ${reais(vendasTotal)}`
      : 'nenhuma venda hoje',
    ticket === null ? '—' : reais(ticket),
    destaque ? waParam(`${destaque.nome} (${qtd(destaque.qtd)} un.)`) : '—',
    frasesDaComparacao(comparacao),
    crediario.qtd > 0
      ? `${reais(crediario.total)} (${crediario.qtd} ${crediario.qtd === 1 ? 'pagamento' : 'pagamentos'})`
      : 'nada hoje',
  ].map((p) => waParam(p));

  const texto = TEMPLATE.body.replace(/\{\{(\d)\}\}/g, (_, n) => parametros[Number(n) - 1]);

  return {
    dia,
    loja,
    vendas: { qtd: vendasQtd, total: vendasTotal },
    ticket_medio: ticket,
    mais_vendido: destaque,
    comparacao,
    crediario,
    parametros,
    texto,
  };
}

// ── destinatário e canal ────────────────────────────────────────
// Loja + preferência + dono. 42703 (377 pendente) → null: tratado como
// desligado, o backend nunca quebra por migration atrasada.
async function carregarLoja(companyId, banco = db) {
  try {
    const { rows } = await banco.query(
      `-- placar:loja
       SELECT c.id, COALESCE(c.trade_name, c.legal_name) AS loja,
              c.placar_do_dia_enabled, c.placar_do_dia_sempre,
              NULLIF(TRIM(u.phone), '') AS owner_phone
         FROM companies c
         LEFT JOIN users u ON u.id = c.owner_id
        WHERE c.id = $1
        LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (e) {
    if (schemaAusente(e)) return null;
    throw e;
  }
}

// "Sem canal" é registrado UMA vez por loja: o aviso existe para alguém ver
// que o placar ligado não chega, não para virar linha todo dia.
async function registrarSemCanal(companyId, motivo, banco = db) {
  try {
    const { rows } = await banco.query(
      `-- placar:sem-canal-ja-registrado
       SELECT 1 FROM audit_log WHERE company_id = $1 AND action = $2 LIMIT 1`,
      [companyId, ACAO_SEM_CANAL]
    );
    if (rows.length) return false;
    await banco.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES (NULL, $1, $2, $3, $4::jsonb)`,
      [companyId, ACAO_SEM_CANAL, motivo, JSON.stringify({ motivo })]
    );
    return true;
  } catch (e) {
    console.error('[placarDoDia] audit sem_canal falhou:', e.message);
    return false;
  }
}

// Já existe envio (ou tentativa) deste dia? Evita remontar o placar quando o
// job passa depois do fechamento do caixa.
async function jaEnfileirado(dedupeKey, banco = db) {
  try {
    const { rows } = await banco.query(
      `-- placar:ja-enfileirado
       SELECT 1 FROM wa_outbox WHERE dedupe_key = $1 LIMIT 1`,
      [dedupeKey]
    );
    return rows.length > 0;
  } catch (e) {
    if (schemaAusente(e)) return false;
    throw e;
  }
}

const dedupeKeyDoDia = (companyId, dia) => `${SOURCE_TYPE}:${companyId}:${dia}`;

// Envia (enfileira) o placar do dia. Nunca lança por regra de negócio.
// @returns { sent, reason, dia, ... }
async function enviarPlacar(companyId, { dia = hojeBRT(), origem = 'manual' } = {}, deps = {}) {
  const banco = deps.db || db;
  const wa = deps.waOutbox || require('./waOutbox');

  const loja = await carregarLoja(companyId, banco);
  if (!loja) return { sent: false, reason: 'DESLIGADO', dia };

  const estado = ativoNoDia(loja, dia, deps.temporada);
  if (!estado.ativo) return { sent: false, reason: estado.motivo, dia };

  const dedupeKey = dedupeKeyDoDia(companyId, dia);
  if (await jaEnfileirado(dedupeKey, banco)) return { sent: false, reason: 'JA_ENVIADO', dia };

  const phone = wa.normalizePhone(loja.owner_phone);
  const conn = await wa.connectionState(companyId);
  if (!conn.connected || !phone) {
    const motivo = !conn.connected
      ? (conn.token_expired ? 'whatsapp_token_expirado' : 'whatsapp_nao_conectado')
      : 'telefone_do_dono_ausente';
    await registrarSemCanal(companyId, motivo, banco);
    return { sent: false, reason: 'SEM_CANAL', detail: motivo, dia };
  }

  const placar = await montarPlacar(companyId, dia, { loja: loja.loja, db: banco });

  const r = await wa.enqueue({
    companyId,
    toPhone: phone,
    kind: 'template',
    templateName: TEMPLATE.name,
    templateLanguage: TEMPLATE.language,
    components: [{ type: 'body', parameters: placar.parametros.map((text) => ({ type: 'text', text })) }],
    sourceType: SOURCE_TYPE,
    sourceId: `${companyId}:${dia}`,
    dedupeKey,
  });

  if (r && r.reason === 'DUPLICADO') return { sent: false, reason: 'JA_ENVIADO', dia };
  if (!r || !r.queued) {
    // Fila recusou (template não aprovado, número pausado, opt-out...): o dono
    // não vai receber. É "sem canal" do mesmo jeito.
    const motivo = String((r && (r.reason || r.status)) || 'nao_enfileirado').toLowerCase();
    await registrarSemCanal(companyId, motivo, banco);
    return { sent: false, reason: 'SEM_CANAL', detail: motivo, dia, placar };
  }
  return { sent: true, reason: null, origem, dia, outbox_id: r.id, placar };
}

// Gancho do fechamento de caixa. Best-effort e SEM await no chamador: o
// fechamento já foi gravado e a resposta não espera o WhatsApp.
async function dispararNoFechamento(companyId, { closedAt = new Date() } = {}, deps = {}) {
  try {
    return await enviarPlacar(companyId, { dia: diaDoFechamento(closedAt), origem: 'fechamento' }, deps);
  } catch (e) {
    console.error('[placarDoDia] fechamento', companyId, e && e.message);
    return { sent: false, reason: 'ERRO' };
  }
}

module.exports = {
  TEMPLATE,
  TEMPLATE_NAME,
  SOURCE_TYPE,
  ACAO_SEM_CANAL,
  HORA_VIRADA_BRT,
  hojeBRT,
  diaDoFechamento,
  mesAnterior,
  reais,
  waParam,
  ativoNoDia,
  compararComMesAnterior,
  frasesDaComparacao,
  montarPlacar,
  carregarLoja,
  registrarSemCanal,
  dedupeKeyDoDia,
  enviarPlacar,
  dispararNoFechamento,
};
