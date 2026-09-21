// ============================================================
// AURA — FASE 1 do CRM: "quanto a mensagem vendeu"
//
// Reativação e aniversário mandam mensagem de MARKETING (custam caro na
// Meta — ver marketing/marketingQuota.js). O lojista sempre perguntou a
// mesma coisa depois: "isso vendeu alguma coisa?". Este serviço responde
// com uma regra de atribuição EXPLÍCITA — porque toda regra implícita de
// "isso vendeu" vira discussão de suporte no fim do mês.
//
// Duas atribuições, nunca a mesma venda nas duas:
//   DIRETA   — a venda usou o cupom que a mensagem levou.
//   ESTIMADA (last-touch) — o cliente comprou de novo em até 5 dias
//     depois de LER a mensagem (ou depois de ENVIAR, se a leitura nunca
//     chegou pelo webhook) sem usar o cupom. Se o mesmo cliente recebeu
//     mais de uma mensagem na janela, a venda vai para a mais recente
//     ANTES dela — é a definição de "last touch".
//
// Armadilha 5 do CLAUDE.md (troca infla receita): toda venda que entra
// nesta conta passa pelos dois filtros — type != 'troca' e status !=
// 'cancelled' — ANTES de qualquer tentativa de atribuição. Aplicado tanto
// no SQL (fetchAttributionData) quanto na função pura (attributeSales),
// de propósito: a função pura tem que ser segura mesmo se algum dia
// alguém chamar com uma lista que não passou pelo filtro do SQL.
//
// Armadilhas 1/10 (schema ausente): toda consulta aqui é 42703/42P01-safe
// — wa_marketing_log é da migration 331, que pode não estar aplicada.
// Sem a tabela, a resposta é "zero envios", nunca uma exceção.
// ============================================================
'use strict';

const db = require('../config/database');

// Janela do last-touch: 5 dias corridos a partir da LEITURA (ou do envio,
// se a leitura nunca chegou pelo webhook — número real, não zero, porque
// "não leu" não é "não vendeu": muita gente compra sem abrir a notificação).
const WINDOW_DAYS = 5;

// kind externo da API (?kind=reactivation|birthday|all) → kind interno
// (wa_marketing_log.kind / wa_outbox.source_type, ambos em português desde
// a 331/marketingCommon.js — reaproveitados aqui, não reinventados).
const KIND_MAP = {
  reactivation: ['reativacao'],
  birthday: ['aniversario'],
  all: ['reativacao', 'aniversario'],
};

function schemaMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

function normalizeKind(kind) {
  const k = String(kind || 'all').trim().toLowerCase();
  return KIND_MAP[k] ? k : 'all';
}

function kindsFor(kind) {
  return KIND_MAP[normalizeKind(kind)];
}

// ── Datas do período (America/Sao_Paulo) ────────────────────
// Aproximação de calendário (não recalcula DST — o Brasil não usa
// horário de verão desde 2019): trata a data como literal e ancora
// início/fim do dia em -03:00. Suficiente para um filtro de período de
// tela; não é usado para nenhuma soma financeira sensível a fuso.
function todaySP() {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function startOfDaySP(dateStr) { return `${String(dateStr).slice(0, 10)}T00:00:00-03:00`; }
function endOfDaySP(dateStr) { return `${String(dateStr).slice(0, 10)}T23:59:59.999-03:00`; }

// Período padrão: últimos 30 dias (hoje incluso). `from`/`to` inválidos
// caem no padrão — filtro de tela nunca deveria virar 500.
function resolvePeriod(from, to) {
  const hoje = todaySP();
  const toStr = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to).slice(0, 10) : hoje;
  const fromStr = /^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))
    ? String(from).slice(0, 10)
    : addDaysStr(toStr, -29);
  return { from: fromStr, to: toStr };
}

// ── Regra pura de atribuição ─────────────────────────────────
// Sem banco, testável em isolado.
//
// envios: [{ id, customer_id, coupon_id, coupon_code, coupon_expires_at,
//            sent_at, read_at, status }]
// vendas: [{ id, customer_id, coupon_id, coupon_code, total_amount,
//            status, cancelled_at, type, created_at }]
//
// devolve { diretas: [...], estimadas: [...] }, cada item:
//   { sale_id, customer_id, envio_id, valor, tipo, enviada_em, lida_em, voltou_em }
function isVendaElegivel(v) {
  if (!v) return false;
  if (v.cancelled_at) return false;
  const status = v.status == null ? 'completed' : String(v.status);
  if (status === 'cancelled') return false;
  const tipo = v.type == null ? 'sale' : String(v.type);
  if (tipo === 'troca') return false;
  return true;
}

function touchTime(envio) {
  const base = envio.read_at || envio.sent_at;
  if (!base) return null;
  const t = new Date(base).getTime();
  return Number.isFinite(t) ? t : null;
}

function toAttribution(venda, envio, tipo) {
  return {
    sale_id: venda.id,
    customer_id: venda.customer_id,
    envio_id: envio.id,
    valor: Number(venda.total_amount) || 0,
    tipo,
    enviada_em: envio.sent_at || null,
    lida_em: envio.read_at || null,
    voltou_em: venda.created_at || null,
  };
}

function attributeSales({ envios = [], vendas = [] } = {}) {
  const vendasElegiveis = (vendas || []).filter(isVendaElegivel);
  const usedSaleIds = new Set();
  const diretas = [];
  const estimadas = [];

  // ── 1) Diretas: a venda usou o cupom da mensagem ────────────
  const envioPorCupom = new Map();
  for (const e of envios || []) {
    if (e.coupon_id != null) envioPorCupom.set(String(e.coupon_id), e);
  }
  for (const v of vendasElegiveis) {
    const couponKey = v.coupon_id != null ? String(v.coupon_id) : null;
    if (!couponKey) continue;
    const envio = envioPorCupom.get(couponKey);
    if (!envio) continue;
    const vendaEm = new Date(v.created_at).getTime();
    if (!Number.isFinite(vendaEm)) continue;
    // Cupom só vale até a expiração dele.
    if (envio.coupon_expires_at) {
      const expira = new Date(envio.coupon_expires_at).getTime();
      if (Number.isFinite(expira) && vendaEm > expira) continue;
    }
    // Venda não pode ser anterior ao envio (o cupom não existia ainda).
    if (envio.sent_at) {
      const enviadaEm = new Date(envio.sent_at).getTime();
      if (Number.isFinite(enviadaEm) && vendaEm < enviadaEm) continue;
    }
    usedSaleIds.add(v.id);
    diretas.push(toAttribution(v, envio, 'direta'));
  }

  // ── 2) Estimadas (last-touch): mesmo cliente, até 5 dias da leitura
  // (ou do envio, sem leitura), sem cupom da mensagem ─────────
  const enviosPorCliente = new Map();
  for (const e of envios || []) {
    if (touchTime(e) == null) continue;
    const key = String(e.customer_id);
    if (!enviosPorCliente.has(key)) enviosPorCliente.set(key, []);
    enviosPorCliente.get(key).push(e);
  }

  const restantes = vendasElegiveis
    .filter((v) => !usedSaleIds.has(v.id) && enviosPorCliente.has(String(v.customer_id)))
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  for (const v of restantes) {
    if (usedSaleIds.has(v.id)) continue;
    const vendaEm = new Date(v.created_at).getTime();
    if (!Number.isFinite(vendaEm)) continue;
    const candidatos = enviosPorCliente.get(String(v.customer_id)) || [];
    let melhor = null;
    let melhorTempo = -Infinity;
    for (const e of candidatos) {
      const t = touchTime(e);
      if (t == null || t > vendaEm) continue; // mensagem tem que ser antes da venda
      const fimJanela = t + WINDOW_DAYS * 24 * 3600 * 1000;
      if (vendaEm > fimJanela) continue; // venda fora da janela desta mensagem
      // Mais de uma mensagem serve: vai para a mais recente (last-touch).
      if (t > melhorTempo) { melhor = e; melhorTempo = t; }
    }
    if (melhor) {
      usedSaleIds.add(v.id);
      estimadas.push(toAttribution(v, melhor, 'estimada'));
    }
  }

  return { diretas, estimadas };
}

// ── Busca no banco ────────────────────────────────────────────
// Envios: wa_marketing_log (histórico do que foi enfileirado) + status
// real da entrega/leitura via wa_outbox (wa_outbox.status vira 'read' e
// updated_at é carimbado NA HORA da transição — ver waOutbox.applyStatusUpdate
// e o webhook em routes/webhookWhatsapp.js) + validade do cupom via coupons.
async function fetchEnvios(companyId, { kinds, fromTs, toTs }) {
  try {
    const { rows } = await db.query(
      `-- mkt-attr:envios
       SELECT l.id, l.customer_id, l.kind, l.coupon_id, l.created_at AS sent_at,
              o.status AS outbox_status, o.updated_at AS outbox_updated_at,
              c.code AS coupon_code, c.expires_at AS coupon_expires_at
         FROM wa_marketing_log l
         LEFT JOIN wa_outbox o ON o.id = l.wa_outbox_id
         LEFT JOIN coupons c ON c.id = l.coupon_id
        WHERE l.company_id = $1
          AND l.kind = ANY($2::text[])
          AND l.created_at >= $3 AND l.created_at <= $4
        ORDER BY l.created_at ASC`,
      [companyId, kinds, fromTs, toTs]
    );
    return rows.map((r) => ({
      id: r.id,
      customer_id: r.customer_id,
      kind: r.kind,
      coupon_id: r.coupon_id,
      coupon_code: r.coupon_code,
      coupon_expires_at: r.coupon_expires_at,
      sent_at: r.sent_at,
      // 'read' só é carimbado por transição (sent/delivered → read) — no
      // momento em que o status ATUAL é 'read', updated_at É a leitura.
      read_at: r.outbox_status === 'read' ? r.outbox_updated_at : null,
      status: r.outbox_status || null,
    }));
  } catch (e) {
    if (schemaMissing(e)) return [];
    throw e;
  }
}

// Vendas dos clientes que receberam mensagem no período, com folga de 60
// dias além do `to` — cobre a janela de 5 dias do last-touch e a validade
// usual do cupom (15/7 dias por padrão, negociável mas raramente > 60).
async function fetchVendas(companyId, { customerIds, fromTs, toDatePlus }) {
  if (!customerIds.length) return [];
  try {
    const { rows } = await db.query(
      `-- mkt-attr:vendas
       SELECT id, customer_id, coupon_id, coupon_code, total_amount, status,
              cancelled_at, type, created_at
         FROM sales
        WHERE company_id = $1
          AND customer_id = ANY($2::uuid[])
          AND created_at >= $3
          AND created_at <= $4
          AND COALESCE(type, 'sale') != 'troca'
          AND COALESCE(status, 'completed') != 'cancelled'`,
      [companyId, customerIds, fromTs, toDatePlus]
    );
    return rows;
  } catch (e) {
    if (schemaMissing(e)) return [];
    throw e;
  }
}

// Puladas por motivo: só o que de fato ficou registrado como 'skipped' na
// wa_outbox (skip_reason) para estes source_types no período. Skips que
// nunca chegam a enqueue() (barrados por waOutbox.simulate() nas prévias
// de reativação/aniversário, ver reactivationAuto.js/birthdayAuto.js) não
// têm rastro no banco — o card mostra o que É persistido, não finge saber
// o resto.
async function fetchPuladasPorMotivo(companyId, { kinds, fromTs, toTs }) {
  try {
    const { rows } = await db.query(
      `-- mkt-attr:puladas
       SELECT COALESCE(skip_reason, 'DESCONHECIDO') AS motivo, COUNT(*)::int AS n
         FROM wa_outbox
        WHERE company_id = $1
          AND source_type = ANY($2::text[])
          AND status = 'skipped'
          AND created_at >= $3 AND created_at <= $4
        GROUP BY motivo`,
      [companyId, kinds, fromTs, toTs]
    );
    const out = {};
    for (const r of rows) out[r.motivo] = r.n;
    return out;
  } catch (e) {
    if (schemaMissing(e)) return {};
    throw e;
  }
}

async function fetchCustomerNames(companyId, customerIds) {
  if (!customerIds.length) return new Map();
  try {
    const { rows } = await db.query(
      `SELECT id, name FROM customers WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, customerIds]
    );
    return new Map(rows.map((r) => [String(r.id), r.name]));
  } catch (e) {
    if (schemaMissing(e)) return new Map();
    throw e;
  }
}

// Preço por mensagem de MARKETING: mesmo da vitrine do pacote (R$49 / 100
// = R$0,49 — marketing/marketingQuota.js, PACK_PRICE_CENTS/PACK_QTY). Não
// inventa constante nova: é o preço que a Aura já cobra pelo excedente.
function custoPorMensagemCents() {
  const quota = require('./marketing/marketingQuota');
  return quota.packPriceCents() / quota.packQty();
}

// ── Orquestração: um resultado completo para UMA empresa ────
async function buildResults(companyId, { kind = 'all', from, to } = {}) {
  const kinds = kindsFor(kind);
  const periodo = resolvePeriod(from, to);
  const fromTs = startOfDaySP(periodo.from);
  const toTs = endOfDaySP(periodo.to);
  // Vendas podem chegar até 60 dias depois do fim do período (janela de
  // 5 dias do last-touch + folga de validade de cupom).
  const toDatePlus = endOfDaySP(addDaysStr(periodo.to, 60));

  const envios = await fetchEnvios(companyId, { kinds, fromTs, toTs });
  const customerIds = Array.from(new Set(envios.map((e) => e.customer_id).filter(Boolean)));
  const [vendas, puladasPorMotivo] = await Promise.all([
    fetchVendas(companyId, { customerIds, fromTs, toDatePlus }),
    fetchPuladasPorMotivo(companyId, { kinds, fromTs, toTs }),
  ]);

  const { diretas, estimadas } = attributeSales({ envios, vendas });

  const enviadas = envios.length;
  const entregues = envios.filter((e) => e.status === 'delivered' || e.status === 'read').length;
  const lidas = envios.filter((e) => e.status === 'read').length;

  const clientesQueVoltaram = new Set(
    [...diretas, ...estimadas].map((a) => String(a.customer_id))
  ).size;

  const diretasQtd = diretas.length;
  const diretasValor = diretas.reduce((s, a) => s + a.valor, 0);
  const estimadasQtd = estimadas.length;
  const estimadasValor = estimadas.reduce((s, a) => s + a.valor, 0);
  const receitaTotal = diretasValor + estimadasValor;

  const custoCents = Math.round(enviadas * custoPorMensagemCents());

  return {
    kind: normalizeKind(kind),
    periodo,
    enviadas,
    entregues,
    lidas,
    puladas_por_motivo: puladasPorMotivo,
    clientes_que_voltaram: clientesQueVoltaram,
    vendas: {
      diretas: { qtd: diretasQtd, valor: round2(diretasValor) },
      estimadas: { qtd: estimadasQtd, valor: round2(estimadasValor) },
    },
    receita_total: round2(receitaTotal),
    custo_estimado: {
      mensagens: enviadas,
      valor_brl: round2(custoCents / 100),
    },
    janela_dias: WINDOW_DAYS,
    rotulo: 'estimativa',
    // Interno: usado por buildByCustomer para não recalcular a atribuição.
    _diretas: diretas,
    _estimadas: estimadas,
  };
}

// Top 20 por receita, para o detalhe da tela.
async function buildByCustomer(companyId, { kind = 'all', from, to } = {}) {
  const resultado = await buildResults(companyId, { kind, from, to });
  const todas = [...resultado._diretas, ...resultado._estimadas]
    .slice()
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 20);

  const nomes = await fetchCustomerNames(
    companyId,
    Array.from(new Set(todas.map((a) => a.customer_id)))
  );

  return todas.map((a) => ({
    customer_id: a.customer_id,
    name: nomes.get(String(a.customer_id)) || null,
    enviada_em: a.enviada_em,
    lida_em: a.lida_em,
    voltou_em: a.voltou_em,
    valor: round2(a.valor),
    tipo: a.tipo,
  }));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Remove os campos internos (_diretas/_estimadas) antes de responder na
// rota — ficam só para buildByCustomer reaproveitar o cálculo.
function publicShape(resultado) {
  const { _diretas, _estimadas, ...pub } = resultado;
  return pub;
}

module.exports = {
  WINDOW_DAYS, KIND_MAP,
  normalizeKind, kindsFor, resolvePeriod,
  isVendaElegivel, attributeSales,
  fetchEnvios, fetchVendas, fetchPuladasPorMotivo, fetchCustomerNames,
  custoPorMensagemCents,
  buildResults, buildByCustomer, publicShape,
};
