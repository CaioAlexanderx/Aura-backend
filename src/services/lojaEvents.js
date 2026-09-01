// ============================================================
// AURA. — Eventos duráveis da loja online (Canal Digital)
//
// Criado: 01/09/2026
//
// O sino da loja só sabia dizer "chegou pedido", e olhando uma janela de 24h
// em digital_orders (routes/notifications.js, bloco 2). Isso tem dois furos:
// quem não abre o app em 24h PERDE o aviso — é polling de janela, não log —
// e tudo que acontece DEPOIS do pedido (pagou, PIX expirou, chegou
// comprovante, saiu pra entrega, entregou, cancelou) é invisível.
//
// Este módulo é a taxonomia + o disparo desses eventos. Ele NÃO tem tabela
// própria: escreve em app_notifications via services/appNotifications.js,
// com `type` = 'loja_<evento>' e `dedupe_key` = 'loja:<evento>:<order_id>'.
// Herdamos assim, sem escrever nada: o índice único parcial de dedupe
// (migration 285), notification_reads (lido/não lido), o filtro de alvo da
// rota e o card do app.
//
// REGRA HERDADA de appNotifications.js, e vale igual aqui: notificar NUNCA
// derruba o fluxo de origem. Toda falha vira `null` no retorno — quem chama
// não precisa de try/catch. Os disparos são fire-and-forget, DEPOIS do
// res.json(), como já era o padrão de digitalOrderNotifications.
//
// ── SEVERIDADE: derivada do type, sem coluna no banco ──────────────────
// Severidade aqui é atributo do TIPO, não da linha: um 'loja_pix_expirado'
// é sempre 'atencao', em qualquer empresa, em qualquer dia. Com coluna,
// mudar a régua (rebaixar 'loja_pedido_cancelado' para info, digamos) exigiria
// UPDATE em todo o histórico, e enquanto ele não rodasse o banco e o código
// diriam coisas diferentes sobre o mesmo evento. Derivando, a régua tem UMA
// fonte (a tabela EVENTS abaixo) e vale retroativamente. O custo é que o
// frontend não pode filtrar por severidade em SQL — e ele não precisa: o
// backend já entrega `severity` pronto em cada item do feed.
//
// ── PREFERÊNCIAS: gate na ESCRITA, não na leitura ──────────────────────
// isEnabled() é checado ANTES do INSERT. Evento desligado não vira linha em
// app_notifications. É mais barato (não polui a tabela nem o índice de
// dedupe) e mais honesto: se a lojista liga um evento hoje, ela quer os
// próximos, não o histórico que escolheu não receber.
// ============================================================
'use strict';

const db = require('../config/database');
// Chamado pelo módulo (appNotifications.notifyCompany), não desestruturado:
// desestruturar congela a referência no require e o teste perde o ponto de
// costura — é o mesmo motivo de sempre, e vale a linha a mais.
const appNotifications = require('./appNotifications');

const PREFIX = 'loja_';

// Pseudo-chave de preferência: NÃO é evento (não existe em
// app_notifications.type), é o interruptor com que a lojista desliga as
// "Novidades da Aura" — os banners de endomarketing da Gestão Aura. Vive na
// mesma tabela porque é a mesma tela e o mesmo escopo. Combinado com o
// frontend em 01/09/2026.
const APP_BANNER_KEY = 'app_banner';
const APP_BANNER_DEFAULT = true;

// ── Rota do CTA ────────────────────────────────────────────────────────
// Pedido do Studio tem tela própria por id: app/studio/(estudio)/pedidos/[id].
// O Canal Digital NÃO tem — a lista de pedidos é a aba 4 de app/(tabs)/canal.tsx,
// que hoje é estado local, sem parâmetro de rota. Mandamos '/canal' com os
// query params já no formato que a tela vai querer ler quando ganhar deep
// link; o Expo Router os ignora sem erro enquanto a tela não os lê, e a
// lojista cai na tela certa de qualquer forma.
function routeForOrder(order = {}) {
  if (order.vertical === 'studio') return `/studio/pedidos/${order.id}`;
  return `/canal?tab=pedidos&order_id=${order.id}`;
}

const fmt = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return 'R$ —';
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
};

const num = (order) => `#${order.order_number || String(order.id || '').slice(0, 8)}`;

// ── Entidade do evento (entity_ref / entity_label) ─────────────────────
// O app agrupa os cards por entity_ref ("3 avisos do Pedido #1042"). O
// PREFIXO é obrigatório e foi o ponto que o frontend levantou: sem ele, um
// evento de estoque e um de pedido — ids de TABELAS diferentes — podem
// coincidir e o app agrupa duas coisas sem relação.
// Hoje só existe entidade 'pedido'. 'loja_estoque_baixo' fala de VÁRIOS
// produtos de uma vez (um aviso por pedido, com a lista no corpo), então não
// há um produto único para apontar — fica sem entidade em vez de eleger um
// arbitrariamente. Se um dia virar um aviso por produto, o prefixo a usar é
// 'produto:<id>'.
function entityOf(spec, payload) {
  if (spec.orderless || !payload.id) return { ref: null, label: null };
  return { ref: `pedido:${payload.id}`, label: `Pedido ${num(payload)}` };
}
const quem = (order) => (order.customer_name ? ` — ${order.customer_name}` : '');

// ── A TAXONOMIA ────────────────────────────────────────────────────────
// severity: 'info' | 'atencao' | 'critico'
//   info    — fecha ciclo, é bom saber, não pede nada de ninguém.
//   atencao — EXIGE AÇÃO HUMANA (conferir, separar, recuperar cliente, repor).
//   critico — a loja está perdendo venda agora.
//
// defaultOn: o que a empresa recebe enquanto não configurar nada.
//   Ligado: tudo que é 'atencao'/'critico' + os dois eventos que a lojista já
//   recebia de alguma forma (pedido novo era o feed de 24h; pedido pago é o
//   momento de separar a mercadoria — sem ele o resto não faz sentido).
//   Desligado: 'loja_pedido_entregue', que é a lojista sendo avisada do que
//   ela mesma acabou de marcar como entregue.
//
// label: o que aparece na tela de preferências (GET .../notifications/preferences).
const EVENTS = Object.freeze({
  loja_pedido_novo: {
    severity: 'info',
    defaultOn: true,
    label: 'Pedido novo',
    hint: 'Um pedido entrou na loja online.',
    title: (o) => `Pedido novo ${num(o)}`,
    body:  (o) => `${fmt(o.total)}${quem(o)}. Toque para ver o pedido.`,
    ctaLabel: 'Ver pedido',
  },
  loja_pedido_pago: {
    severity: 'info',
    defaultOn: true,
    label: 'Pagamento confirmado',
    hint: 'O pagamento caiu — é a hora de separar a mercadoria.',
    title: (o) => `Pagamento confirmado ${num(o)}`,
    body:  (o) => `${fmt(o.total)}${quem(o)}. Pode separar a mercadoria.`,
    ctaLabel: 'Ver pedido',
  },
  loja_comprovante_enviado: {
    severity: 'atencao',
    defaultOn: true,
    label: 'Comprovante para conferir',
    hint: 'O cliente enviou comprovante de Pix. Alguém precisa conferir e aprovar.',
    title: (o) => `Comprovante para conferir ${num(o)}`,
    body:  (o) => `${quem(o).replace(' — ', '')} enviou o comprovante de ${fmt(o.total)}. Confira e aprove o pagamento.`.trim(),
    ctaLabel: 'Conferir',
  },
  loja_pix_expirado: {
    severity: 'atencao',
    defaultOn: true,
    label: 'Pix expirado',
    hint: 'O Pix venceu sem pagamento. Dá para chamar o cliente e recuperar a venda.',
    title: (o) => `Pix expirado ${num(o)}`,
    body:  (o) => `O Pix de ${fmt(o.total)}${quem(o)} venceu sem pagamento. Chame o cliente enquanto a venda é recuperável.`,
    ctaLabel: 'Ver pedido',
  },
  loja_pedido_cancelado: {
    severity: 'atencao',
    defaultOn: true,
    label: 'Pedido cancelado',
    hint: 'Um pedido foi cancelado.',
    title: (o) => `Pedido cancelado ${num(o)}`,
    body:  (o) => `${fmt(o.total)}${quem(o)}. Confira se há estoque ou valor a devolver.`,
    ctaLabel: 'Ver pedido',
  },
  loja_pedido_entregue: {
    severity: 'info',
    defaultOn: false,
    label: 'Pedido entregue',
    hint: 'Fecha o ciclo do pedido. Desligado por padrão — costuma ser a própria loja marcando.',
    title: (o) => `Pedido entregue ${num(o)}`,
    body:  (o) => `${fmt(o.total)}${quem(o)}. Ciclo fechado.`,
    ctaLabel: 'Ver pedido',
  },
  loja_sinal_pago: {
    severity: 'info',
    defaultOn: true,
    label: 'Sinal pago',
    hint: 'O sinal da encomenda foi pago — a produção está liberada.',
    title: (o) => `Sinal pago ${num(o)}`,
    body:  (o) => `O sinal da encomenda${quem(o)} foi confirmado. Produção liberada.`,
    ctaLabel: 'Ver pedido',
  },
  // Nome alinhado ao frontend em 01/09/2026 (o briefing dizia
  // 'loja_saiu_para_entrega'; o app já catalogou 'loja_pedido_saiu_entrega').
  // Um só nome nos dois lados vale mais que o nome mais bonito.
  //
  // 01/09/2026 — courier_name só é preenchido na CRIAÇÃO do pedido (o cliente
  // contrata Uber/99 no checkout e informa quem vai buscar; nenhum fluxo
  // preenche depois). Então este evento nasce junto com o pedido, e o que ele
  // avisa não é "o pacote saiu" e sim "este pedido tem portador designado —
  // confira nome e placa antes de entregar". É 'atencao' pelo mesmo motivo que
  // services/courierPickup.js existe: sem conferir, a lojista entrega a
  // personalização de um cliente ao primeiro motoboy que citar o número.
  loja_pedido_saiu_entrega: {
    severity: 'atencao',
    defaultOn: true,
    label: 'Retirada por portador',
    hint: 'O cliente contratou app de entrega e informou quem vai buscar. Confira nome e placa na retirada.',
    title: (o) => `Retirada por portador ${num(o)}`,
    body:  (o) => `${o.courier_name || 'Portador'}${o.courier_plate ? ` — placa ${o.courier_plate}` : ''}. Confira nome e placa antes de entregar.`,
    ctaLabel: 'Ver pedido',
  },
  // Não tem pedido no CTA: o que a lojista precisa é repor. A rota é o estoque.
  loja_estoque_baixo: {
    severity: 'atencao',
    defaultOn: true,
    orderless: true,
    label: 'Estoque no mínimo',
    hint: 'Uma venda online derrubou um produto até o estoque mínimo.',
    title: () => 'Estoque no mínimo',
    body:  (o) => o.body || 'Um produto chegou ao estoque mínimo depois de uma venda online.',
    ctaLabel: 'Ver estoque',
    ctaRoute: () => '/estoque',
  },
  // ── GRUPO B implementado (01/09/2026) ────────────────────────────────
  // Os dois abaixo entraram porque o gancho JÁ estava no caminho que este
  // trabalho tocou (services/digitalOrderConfirmation.js): o passo 3 é quem
  // cria o cliente quando não acha pelo telefone, e o passo 5 é quem
  // engole o erro de NFC-e num console.error. Custo: uma linha cada.
  loja_nfce_falhou: {
    severity: 'atencao',
    defaultOn: true,
    label: 'NFC-e não saiu',
    hint: 'O cliente pediu nota no checkout e a emissão falhou. Emita manualmente.',
    title: (o) => `NFC-e não saiu no pedido ${num(o)}`,
    body:  (o) => o.body || `O cliente pediu nota fiscal e a emissão falhou. Emita manualmente antes de entregar.`,
    ctaLabel: 'Ver pedido',
  },
  loja_novo_cliente: {
    severity: 'info',
    defaultOn: false,
    label: 'Cliente novo',
    hint: 'Primeiro pedido de um cliente que ainda não estava na sua base. Desligado por padrão.',
    title: () => 'Cliente novo na loja',
    body:  (o) => o.body || `${o.customer_name || 'Um cliente'} comprou pela primeira vez (${fmt(o.total)}). Já está na sua base de clientes.`,
    ctaLabel: 'Ver pedido',
  },

  // Não tem pedido: o pedido não chegou a existir — é exatamente esse o ponto.
  loja_sem_pagamento_configurado: {
    severity: 'critico',
    defaultOn: true,
    orderless: true,
    label: 'Loja sem forma de pagamento',
    hint: 'Um cliente tentou fechar o pedido e a loja não tem nenhuma forma de pagamento ativa.',
    title: () => 'Sua loja não aceita pagamento',
    body:  () => 'Um cliente tentou fechar o pedido e a loja não tem Pix, cartão nem pagamento na entrega ativos. Configure uma forma de pagamento no Canal Digital.',
    ctaLabel: 'Configurar pagamento',
    ctaRoute: () => '/canal',
  },
});

const TYPES = Object.freeze(Object.keys(EVENTS));

function isLojaType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(EVENTS, type);
}

/** Severidade do evento. Tipo desconhecido (ou banner) cai em 'info'. */
function severityOf(type) {
  return (EVENTS[type] && EVENTS[type].severity) || 'info';
}

/** Catálogo para a tela de preferências. */
function listEventTypes() {
  return TYPES.map((type) => ({
    type,
    label: EVENTS[type].label,
    hint: EVENTS[type].hint,
    severity: EVENTS[type].severity,
    default_enabled: EVENTS[type].defaultOn,
  }));
}

// ── Preferências ───────────────────────────────────────────────────────
// Cache em processo de 60s. Os disparos moram em caminho quente (webhook de
// pagamento, criação de pedido) e a alternativa era um SELECT por evento.
// 60s é curto o bastante para a lojista ver o efeito de mudar a preferência
// sem entender que "não pegou", e o PUT limpa o cache da própria instância.
const PREFS_TTL_MS = 60 * 1000;
const prefsCache = new Map(); // companyId -> { at, map }

// Defensivo (CLAUDE.md, armadilha 1): company_notification_prefs só existe
// depois da migration 315. Antes dela, 42P01 → todo mundo fica no default,
// em vez de o disparo inteiro morrer. Decidido uma vez por processo.
let hasPrefsTable = null;

async function loadPrefs(companyId) {
  const hit = prefsCache.get(companyId);
  if (hit && Date.now() - hit.at < PREFS_TTL_MS) return hit.map;

  let map = {};
  if (hasPrefsTable !== false) {
    try {
      const { rows } = await db.query(
        `SELECT event_type, enabled FROM company_notification_prefs WHERE company_id = $1`,
        [companyId]
      );
      map = Object.fromEntries(rows.map((r) => [r.event_type, r.enabled === true]));
      hasPrefsTable = true;
    } catch (err) {
      if (err.code === '42P01') {
        hasPrefsTable = false;
      } else {
        // Falha de leitura não pode calar a notificação — segue no default.
        console.error('[lojaEvents] falha ao ler preferências:', err.message);
        return defaultsMap();
      }
    }
  }

  prefsCache.set(companyId, { at: Date.now(), map });
  return map;
}

function defaultsMap() {
  return {};
}

/** true se a empresa quer receber este evento (tabela esparsa: ausente = default). */
async function isEnabled(companyId, type) {
  if (!isLojaType(type)) return false;
  const prefs = await loadPrefs(companyId);
  if (Object.prototype.hasOwnProperty.call(prefs, type)) return prefs[type] === true;
  return EVENTS[type].defaultOn === true;
}

/** Chave válida de preferência: um tipo de evento OU a pseudo-chave app_banner. */
function isPrefKey(k) {
  return isLojaType(k) || k === APP_BANNER_KEY;
}

function defaultOf(key) {
  if (key === APP_BANNER_KEY) return APP_BANNER_DEFAULT;
  return EVENTS[key] ? EVENTS[key].defaultOn === true : false;
}

/**
 * Preferências efetivas como Record<string, boolean> — o formato que o app
 * consome (combinado em 01/09/2026). A tabela é esparsa: o que não tem linha
 * cai no default da taxonomia.
 */
async function prefsRecord(companyId) {
  const prefs = await loadPrefs(companyId);
  const out = {};
  for (const key of [...TYPES, APP_BANNER_KEY]) {
    out[key] = Object.prototype.hasOwnProperty.call(prefs, key)
      ? prefs[key] === true
      : defaultOf(key);
  }
  return out;
}

/** true se a empresa ainda quer ver os banners de endomarketing. */
async function isBannerEnabled(companyId) {
  const prefs = await loadPrefs(companyId);
  return Object.prototype.hasOwnProperty.call(prefs, APP_BANNER_KEY)
    ? prefs[APP_BANNER_KEY] === true
    : APP_BANNER_DEFAULT;
}

/** Catálogo (label/hint/severidade/default) — acompanha o Record no GET. */
async function effectivePrefs(companyId) {
  const prefs = await loadPrefs(companyId);
  const linha = (type, extra) => ({
    ...extra,
    type,
    enabled: Object.prototype.hasOwnProperty.call(prefs, type)
      ? prefs[type] === true
      : defaultOf(type),
    customized: Object.prototype.hasOwnProperty.call(prefs, type),
  });
  return [
    ...listEventTypes().map((e) => linha(e.type, e)),
    linha(APP_BANNER_KEY, {
      label: 'Novidades da Aura',
      hint: 'Avisos e novidades publicados pela equipe da Aura.',
      severity: 'info',
      default_enabled: APP_BANNER_DEFAULT,
    }),
  ];
}

function invalidatePrefs(companyId) {
  if (companyId) prefsCache.delete(companyId);
  else prefsCache.clear();
}

// ── Recarga do pedido ──────────────────────────────────────────────────
// 17/08/2026 já custou um bug idêntico (ver __tests__/digitalOrderNotifications.test.js):
// cada caller montava o `order` com um SELECT próprio e três esqueciam
// `total`, então o lojista recebia "R$ NaN". Aqui o caller passa o que
// tiver — até só o id — e ESTE módulo garante as colunas que os textos
// consomem. Nenhum ponto de disparo precisa saber quais são.
const ORDER_FIELDS =
  'id, company_id, order_number, customer_name, total, vertical, ' +
  'courier_name, courier_plate';

const NEEDED = ['company_id', 'order_number', 'total'];

async function loadOrder(ref) {
  const given = ref && typeof ref === 'object' ? ref : {};
  const id = typeof ref === 'string' ? ref : given.id;
  if (id && NEEDED.some((f) => given[f] === undefined || given[f] === null)) {
    try {
      const { rows } = await db.query(
        `SELECT ${ORDER_FIELDS} FROM digital_orders WHERE id = $1`, [id]
      );
      if (rows.length) return { ...given, ...rows[0] };
    } catch (err) {
      console.error('[lojaEvents] falha ao recarregar pedido:', err.message);
    }
  }
  return id ? { ...given, id } : given;
}

// ── Disparo ────────────────────────────────────────────────────────────
/**
 * Dispara um evento da loja online.
 *
 * @param {string} type          chave de EVENTS (ex.: 'loja_pedido_pago')
 * @param {object|string} order  linha de digital_orders, um recorte dela, ou
 *                               só o id (as colunas faltantes são recarregadas).
 *                               Nos eventos `orderless`, passe { company_id }.
 * @param {object} [opts]
 * @param {string} [opts.dedupeSuffix] substitui o order_id na dedupe_key.
 * @param {string} [opts.body]         sobrescreve o corpo montado.
 * @returns {Promise<object|null>} a linha criada, ou null (desligado, dedup, falha)
 */
async function emitLojaEvent(type, order = {}, opts = {}) {
  try {
    if (!isLojaType(type)) {
      console.error('[lojaEvents] tipo desconhecido:', type);
      return null;
    }
    const spec = EVENTS[type];
    const given = order && typeof order === 'object' ? order : {};

    // Preferência ANTES da recarga: evento desligado não gasta um SELECT.
    // Só quando nem company_id veio é que recarregamos primeiro.
    let payload = given;
    if (!given.company_id) payload = await loadOrder(order);

    const companyId = payload.company_id;
    if (!companyId) {
      console.error('[lojaEvents] company_id ausente em', type);
      return null;
    }
    if (!(await isEnabled(companyId, type))) return null;

    if (!spec.orderless) payload = await loadOrder(payload);
    if (opts.body) payload = { ...payload, body: opts.body };

    const key = opts.dedupeSuffix || payload.id;
    if (!key) {
      console.error('[lojaEvents] sem chave de dedupe em', type);
      return null;
    }

    const row = await appNotifications.notifyCompany(companyId, {
      type,
      title: spec.title(payload),
      body: opts.body || spec.body(payload),
      ctaLabel: spec.ctaLabel,
      ctaRoute: spec.ctaRoute ? spec.ctaRoute(payload) : routeForOrder(payload),
      dedupeKey: `loja:${type.slice(PREFIX.length)}:${key}`,
    });

    // entity_ref/entity_label num UPDATE separado, e não como dois campos a
    // mais em createAppNotification, de propósito: aquele módulo serve TAMBÉM
    // os banners da Gestão Aura e já carrega um cache de capacidade de schema
    // (pré/pós-285). Enfiar uma terceira variação lá dentro faria uma coluna
    // faltando nesta migration derrubar banner de vertical, que não tem nada a
    // ver com isto. Aqui o pior caso é o card não agrupar. O UPDATE só roda
    // quando a linha foi REALMENTE criada (dedupe devolve null).
    if (row && row.id) await tagEntity(row, spec, payload);
    return row;
  } catch (err) {
    // Mesma regra de appNotifications: notificar não derruba o fluxo.
    console.error('[lojaEvents] erro ao disparar', type, '-', err.message);
    return null;
  }
}

// null = não sabemos; false = migration 315 ausente, para de tentar.
let hasEntityCols = null;

async function tagEntity(row, spec, payload) {
  if (hasEntityCols === false) return;
  const { ref, label } = entityOf(spec, payload);
  if (!ref) return;
  try {
    await db.query(
      `UPDATE app_notifications SET entity_ref = $1, entity_label = $2 WHERE id = $3`,
      [ref, label, row.id]
    );
    hasEntityCols = true;
    row.entity_ref = ref;
    row.entity_label = label;
  } catch (err) {
    if (err.code === '42703') hasEntityCols = false;
    else console.error('[lojaEvents] falha ao gravar entidade:', err.message);
  }
}

/** Versão fire-and-forget: para chamar depois do res.json() sem .catch(). */
function emit(type, order, opts) {
  emitLojaEvent(type, order, opts).catch((err) =>
    console.error('[lojaEvents] emit error:', err && err.message)
  );
}

/** Só para teste: limpa cache de prefs e a decisão sobre o schema. */
function _resetCaches() {
  prefsCache.clear();
  hasPrefsTable = null;
  hasEntityCols = null;
}

module.exports = {
  PREFIX,
  APP_BANNER_KEY,
  EVENTS,
  TYPES,
  isLojaType,
  isPrefKey,
  prefsRecord,
  isBannerEnabled,
  entityOf,
  severityOf,
  listEventTypes,
  effectivePrefs,
  isEnabled,
  invalidatePrefs,
  routeForOrder,
  emitLojaEvent,
  emit,
  _resetCaches,
};
