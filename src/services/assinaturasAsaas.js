// ============================================================
// AURA. — Assinaturas da Asaas: eventos SUBSCRIPTION_* e o aviso de
// assinatura cancelada (24/10/2026; tq-73, tq-79; migration 410)
//
// Eventos (docs.asaas.com, "Eventos para assinaturas"):
//   SUBSCRIPTION_CREATED, SUBSCRIPTION_UPDATED, SUBSCRIPTION_INACTIVATED,
//   SUBSCRIPTION_DELETED (e os de split, que só são registrados).
//   O corpo traz { id: 'evt_...', event, dateCreated, subscription: {...} }.
//
// processarEventoDeAssinatura (chamado pelo webhook):
//   - grava o evento em webhook_logs (com a empresa) e espelha o estado em
//     assinaturas_asaas;
//   - reenvio do mesmo evento (a entrega é "pelo menos uma vez") é
//     reconhecido pela chave do evento (id do evt_, ou evento + assinatura +
//     data) e não grava de novo;
//   - NÃO muda companies.billing_status, não mexe em asaas_subscription_id e
//     não bloqueia nada. A própria Aura apaga e troca assinaturas: na troca
//     de plano (/billing/subscribe apaga a antiga e cria a nova) e na
//     migração para o Pix Automático (pixAutomaticoPiloto.trocarAssinatura).
//     Um SUBSCRIPTION_DELETED nunca derruba cliente que pagou;
//   - sem o segredo do webhook o corpo não é confiável: a assinatura é relida
//     na Asaas (GET /subscriptions/:id) e só o que ela devolve é gravado. Se
//     a leitura falhar, nada é gravado.
//   - evento sem empresa conhecida: só o espelho (com company_id NULL), sem
//     linha em webhook_logs — a lista de "pagamentos sem loja" da Gestão
//     Aura lê as linhas sem empresa e não pode ganhar assinatura.
//
// marcarEncerramentoPedido: os fluxos do backend que apagam assinatura
// gravam ANTES do DELETE quem pediu ('troca_de_plano', 'pix_automatico',
// 'cliente_no_app'). Assim o evento que chega depois sabe que foi a Aura.
//
// avisosDeCancelamento (job, tq-79): e-mail de assinatura cancelada, atrás
// de EMAIL_ASSINATURA_CANCELADA_ENABLED (padrão DESLIGADO: texto a aprovar
// pelo Caio). Só sai quando TODAS valem:
//   1. a assinatura encerrada (DELETED/INACTIVATED) é a
//      companies.asaas_subscription_id atual da empresa (ou o próprio cliente
//      cancelou pelo app, que zera a coluna logo depois do DELETE);
//   2. o encerramento não foi pedido por um fluxo da Aura (marca acima, ou
//      a assinatura antiga de uma troca para o Pix Automático);
//   3. relendo a Asaas, ela não voltou a ficar ativa e a empresa não tem
//      outra assinatura ativa (GET /subscriptions?customer=&status=ACTIVE);
//   4. a empresa está dentro das regras comuns (fora: interna, sandbox,
//      inativa, Karatê — cobrancaAssinatura.destinatarioDaEmpresa).
// Espera 2 horas depois do evento (dá tempo de uma troca terminar e de a
// equipe recriar uma assinatura apagada no painel) e não olha eventos com
// mais de 26 horas (nada retroativo). Idempotente pelo email_log
// (assinatura-cancelada:<sub>) e pela decisão gravada no espelho.
//
// Assinatura renovada NÃO tem e-mail próprio: cada renovação é uma cobrança
// paga, e o recibo (2.7, tq-76) já sai uma vez por cobrança.
// ============================================================
'use strict';

const conteudos = require('./emailsRelacionamento');
const { destinatarioDaEmpresa, enviarCobranca } = require('./cobrancaAssinatura');

const EVENTOS_DE_ENCERRAMENTO = ['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED'];

// Pedidos de encerramento que são da própria Aura (nunca geram e-mail).
const PEDIDOS_DA_AURA = ['troca_de_plano', 'pix_automatico'];
const PEDIDOS_VALIDOS = [...PEDIDOS_DA_AURA, 'cliente_no_app'];

const ESPERA_MS = 2 * 3600 * 1000;
const JANELA_MS = 26 * 3600 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function ligado(valor, padrao) {
  if (valor == null || String(valor).trim() === '') return padrao;
  return !/^(0|false|off|no|nao|não)$/i.test(String(valor).trim());
}

/** Aviso de assinatura cancelada: padrão DESLIGADO até o Caio aprovar o texto. */
function avisoDeCanceladaLigado(env = process.env) {
  return ligado(env.EMAILS_CICLO_ENABLED, true) && ligado(env.EMAIL_ASSINATURA_CANCELADA_ENABLED, false);
}

/** Chave do evento para o reenvio: o id do evt_ ou evento + assinatura + data. */
function chaveDoEvento(body, sub) {
  if (body && typeof body.id === 'string' && body.id.trim()) return 'evt:' + body.id.trim();
  return `${body && body.event}:${sub && sub.id}:${(body && body.dateCreated) || ''}`;
}

/**
 * Situação gravada no espelho: DELETED quando removida, senão o status da
 * Asaas. Relida na Asaas (sem segredo), vale só o que ela devolveu; com o
 * corpo validado, o nome do evento também conta.
 */
function statusDoEspelho(event, sub, fonte = 'body') {
  if (sub && sub.deleted === true) return 'DELETED';
  if (fonte !== 'asaas-api') {
    if (event === 'SUBSCRIPTION_DELETED') return 'DELETED';
    if (event === 'SUBSCRIPTION_INACTIVATED' && (!sub || !sub.status || sub.status === 'ACTIVE')) return 'INACTIVE';
  }
  return (sub && sub.status) ? String(sub.status).slice(0, 30) : null;
}

/**
 * O evento encerra a assinatura? Com o corpo validado, vale o evento. Relido
 * na Asaas (sem segredo), vale também o que ela devolve: removida ou fora de
 * ACTIVE.
 */
function encerra(event, sub, fonte) {
  if (!EVENTOS_DE_ENCERRAMENTO.includes(event)) return false;
  if (fonte !== 'asaas-api') return true;
  return !!(sub && (sub.deleted === true || (sub.status && sub.status !== 'ACTIVE')));
}

function dataDoEvento(body) {
  const t = body && body.dateCreated ? new Date(String(body.dateCreated).replace(' ', 'T')).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function jaRegistrado(db, event, chave) {
  try {
    const r = await db.query(
      `SELECT 1 FROM webhook_logs
        WHERE provider = 'asaas' AND event LIKE 'SUBSCRIPTION\\_%'
          AND payload->>'dedupe_key' = $1
        LIMIT 1`,
      [chave]
    );
    return !!(r && r.rows && r.rows.length);
  } catch (err) {
    console.error('[assinaturasAsaas] checagem de reenvio falhou (seguindo): ' + err.message);
    return false;
  }
}

async function acharEmpresa(db, sub) {
  const ref = sub && UUID_RE.test(sub.externalReference || '') ? sub.externalReference : null;
  const r = await db.query(
    `SELECT id, asaas_subscription_id
       FROM companies
      WHERE asaas_subscription_id = $1 OR asaas_customer_id = $2 OR id = $3
      ORDER BY (asaas_subscription_id = $1) DESC NULLS LAST, (id = $3) DESC NULLS LAST,
               is_primary DESC NULLS LAST, created_at ASC
      LIMIT 1`,
    [sub.id, sub.customer || null, ref]
  );
  return (r && r.rows && r.rows[0]) || null;
}

/**
 * Grava/atualiza o espelho. Evento mais antigo que o último gravado não
 * troca os campos descritivos (a entrega pode vir fora de ordem). O
 * encerramento só é marcado uma vez (o primeiro).
 */
async function registrarAssinatura(db, { sub, event, empresa, quando, encerrou, fonte }) {
  const status = statusDoEspelho(event, sub, fonte);
  const proximo = sub.nextDueDate ? String(sub.nextDueDate).slice(0, 10) : null;
  const valor = Number(sub.value);
  const r = await db.query(
    `INSERT INTO assinaturas_asaas
       (asaas_subscription_id, company_id, asaas_customer_id, status, removida, valor, ciclo, billing_type,
        proximo_vencimento, ultimo_evento, ultimo_evento_em,
        encerrada_em, evento_de_encerramento, era_atual_no_encerramento)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11::timestamptz,
             CASE WHEN $12::boolean THEN NOW() END, CASE WHEN $12::boolean THEN $10::text END,
             CASE WHEN $12::boolean THEN $13::boolean END)
     ON CONFLICT (asaas_subscription_id) DO UPDATE SET
       company_id = COALESCE(assinaturas_asaas.company_id, EXCLUDED.company_id),
       asaas_customer_id = COALESCE(EXCLUDED.asaas_customer_id, assinaturas_asaas.asaas_customer_id),
       status = CASE WHEN assinaturas_asaas.removida THEN 'DELETED'
                     WHEN assinaturas_asaas.ultimo_evento_em IS NULL OR EXCLUDED.ultimo_evento_em IS NULL
                          OR EXCLUDED.ultimo_evento_em >= assinaturas_asaas.ultimo_evento_em
                     THEN COALESCE(EXCLUDED.status, assinaturas_asaas.status)
                     ELSE assinaturas_asaas.status END,
       removida = assinaturas_asaas.removida OR EXCLUDED.removida,
       valor = COALESCE(EXCLUDED.valor, assinaturas_asaas.valor),
       ciclo = COALESCE(EXCLUDED.ciclo, assinaturas_asaas.ciclo),
       billing_type = COALESCE(EXCLUDED.billing_type, assinaturas_asaas.billing_type),
       proximo_vencimento = COALESCE(EXCLUDED.proximo_vencimento, assinaturas_asaas.proximo_vencimento),
       ultimo_evento = CASE WHEN assinaturas_asaas.ultimo_evento_em IS NULL OR EXCLUDED.ultimo_evento_em IS NULL
                                 OR EXCLUDED.ultimo_evento_em >= assinaturas_asaas.ultimo_evento_em
                            THEN EXCLUDED.ultimo_evento ELSE assinaturas_asaas.ultimo_evento END,
       ultimo_evento_em = GREATEST(assinaturas_asaas.ultimo_evento_em, EXCLUDED.ultimo_evento_em),
       encerrada_em = COALESCE(assinaturas_asaas.encerrada_em, EXCLUDED.encerrada_em),
       evento_de_encerramento = COALESCE(assinaturas_asaas.evento_de_encerramento, EXCLUDED.evento_de_encerramento),
       era_atual_no_encerramento = COALESCE(assinaturas_asaas.era_atual_no_encerramento, EXCLUDED.era_atual_no_encerramento),
       updated_at = NOW()
     RETURNING asaas_subscription_id, status, encerrada_em`,
    [
      sub.id, empresa ? empresa.id : null, sub.customer || null, status,
      status === 'DELETED', Number.isFinite(valor) ? valor : null,
      sub.cycle || null, sub.billingType || null, proximo && DATA_RE.test(proximo) ? proximo : null,
      event, quando, !!encerrou, !!(empresa && empresa.asaas_subscription_id === sub.id),
    ]
  );
  return (r && r.rows && r.rows[0]) || null;
}

/**
 * Trata um SUBSCRIPTION_* do webhook. Nunca muda companies. Devolve o corpo
 * da resposta (sempre 200 no webhook).
 */
async function processarEventoDeAssinatura({ body, hasSecret, db, asaas }) {
  const event = body && body.event;
  let sub = body && body.subscription;
  if (!sub || !sub.id) return { received: true, handled: false, reason: 'sem_assinatura' };

  let fonte = 'body';
  if (!hasSecret) {
    let real = null;
    try {
      real = await asaas('GET', '/subscriptions/' + encodeURIComponent(sub.id));
    } catch (err) {
      console.error('[assinaturasAsaas] releitura da assinatura ' + sub.id + ' falhou: ' + err.message);
    }
    if (!real || !real.id) {
      console.warn('[WEBHOOK] ' + event + ' sem segredo e sem releitura na Asaas — evento IGNORADO, ZERO mutacao.');
      return { received: true, handled: false, reason: 'no_secret_reverification_failed' };
    }
    sub = real;
    fonte = 'asaas-api';
  }

  const chave = chaveDoEvento(body, sub);
  if (await jaRegistrado(db, event, chave)) {
    console.log('[WEBHOOK] Reenvio ignorado: ' + event + ' de ' + sub.id + ' ja registrado em webhook_logs');
    return { received: true, handled: false, duplicate: true, event };
  }

  const empresa = await acharEmpresa(db, sub);
  const encerrou = encerra(event, sub, fonte);
  try {
    await registrarAssinatura(db, { sub, event, empresa, quando: dataDoEvento(body), encerrou, fonte });
  } catch (err) {
    // 42P01: migration 410 ainda não aplicada — o log abaixo ainda vale.
    if (err && err.code !== '42P01') console.error('[assinaturasAsaas] espelho falhou: ' + err.message);
  }

  if (empresa) {
    const payload = {
      id: body.id || null, event, dateCreated: body.dateCreated || null, dedupe_key: chave,
      fonte, subscription: sub,
    };
    await db.query(
      `INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at) VALUES ($1, 'asaas', $2, $3, NOW())`,
      [empresa.id, String(event).slice(0, 60), JSON.stringify(payload)]
    ).catch((err) => console.error('[assinaturasAsaas] webhook_logs falhou: ' + err.message));
  }

  console.log('[WEBHOOK] ' + event + ' | assinatura ' + sub.id + ' | company ' + (empresa ? empresa.id : '(nenhuma)') +
    ' | source=' + fonte + (encerrou ? ' | encerrada (billing_status preservado)' : ''));
  return {
    received: true,
    handled: true,
    subscription_event: event,
    company_found: !!empresa,
    status_changed: false,
    encerrada: encerrou,
  };
}

/**
 * Grava, ANTES do DELETE na Asaas, quem pediu o encerramento da assinatura.
 * Nunca lança (falhar aqui não pode impedir a troca de plano).
 */
async function marcarEncerramentoPedido(db, subscriptionId, { companyId = null, motivo } = {}) {
  if (!subscriptionId || !PEDIDOS_VALIDOS.includes(motivo)) return false;
  try {
    await db.query(
      `INSERT INTO assinaturas_asaas (asaas_subscription_id, company_id, encerramento_pedido_por, encerramento_pedido_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (asaas_subscription_id) DO UPDATE SET
         company_id = COALESCE(assinaturas_asaas.company_id, EXCLUDED.company_id),
         encerramento_pedido_por = EXCLUDED.encerramento_pedido_por,
         encerramento_pedido_em = EXCLUDED.encerramento_pedido_em,
         updated_at = NOW()`,
      [String(subscriptionId), companyId, motivo]
    );
    return true;
  } catch (err) {
    if (!err || err.code !== '42P01') console.error('[assinaturasAsaas] marca de encerramento falhou: ' + (err && err.message));
    return false;
  }
}

// ── tq-79: aviso de assinatura cancelada ────────────────────────

const SQL_PENDENTES = `
SELECT a.asaas_subscription_id, a.company_id, a.encerrada_em, a.era_atual_no_encerramento,
       a.encerramento_pedido_por, a.evento_de_encerramento,
       c.asaas_subscription_id AS assinatura_atual, c.asaas_customer_id, c.billing_status,
       c.vertical, c.vertical_active
  FROM assinaturas_asaas a
  JOIN companies c ON c.id = a.company_id
 WHERE a.encerrada_em IS NOT NULL
   AND a.aviso_decidido_em IS NULL
   AND a.encerrada_em <= $1::timestamptz
   AND a.encerrada_em >= $2::timestamptz
 ORDER BY a.encerrada_em
 LIMIT 50`;

async function decidir(db, subId, resultado) {
  await db.query(
    `UPDATE assinaturas_asaas SET aviso_decidido_em = NOW(), aviso_resultado = $2, updated_at = NOW()
      WHERE asaas_subscription_id = $1 AND aviso_decidido_em IS NULL`,
    [subId, resultado]
  );
}

async function foiTrocaParaPixAutomatico(db, subId) {
  try {
    const r = await db.query('SELECT 1 FROM pix_automatico_autorizacoes WHERE old_subscription_id = $1 LIMIT 1', [subId]);
    return !!(r && r.rows && r.rows.length);
  } catch (err) {
    if (err && err.code === '42P01') return false;
    throw err;
  }
}

/**
 * Relê a Asaas. 'ativa' (a encerrada voltou), 'outra_ativa' (a empresa tem
 * outra assinatura ativa), 'encerrada' (pode avisar) ou null (Asaas não
 * respondeu: decide na próxima volta).
 */
async function situacaoNaAsaas(asaas, { subId, customerId }) {
  try {
    const sub = await asaas('GET', '/subscriptions/' + encodeURIComponent(subId));
    if (sub && sub.id && sub.deleted !== true && sub.status === 'ACTIVE') return 'ativa';
  } catch (err) {
    // 404: a assinatura sumiu de vez — segue para a lista do cliente.
    if (!(err && err.asaasStatus === 404)) {
      console.warn('[assinaturasAsaas] releitura de ' + subId + ' falhou: ' + err.message);
      return null;
    }
  }
  if (!customerId) return null;
  try {
    const r = await asaas('GET', '/subscriptions?customer=' + encodeURIComponent(customerId) + '&status=ACTIVE&limit=20');
    const outras = ((r && r.data) || []).filter((s) => s && s.id !== subId && s.deleted !== true && (!s.status || s.status === 'ACTIVE'));
    return outras.length ? 'outra_ativa' : 'encerrada';
  } catch (err) {
    console.warn('[assinaturasAsaas] lista de assinaturas do cliente falhou: ' + err.message);
    return null;
  }
}

const VERTICAIS_SEM_CAIXA_VIVO = ['odonto', 'food', 'studio'];

/** O Caixa segue para essa loja? Shell Negócio e fora do atraso (pausa no dia 14). */
function caixaSegue(linha) {
  if (VERTICAIS_SEM_CAIXA_VIVO.includes(linha.vertical_active)) return false;
  return linha.billing_status !== 'overdue';
}

/**
 * Uma volta do aviso de cancelada (job, a cada 10 min das 8h às 20h BRT).
 * Devolve a contagem por resultado.
 */
async function avisosDeCancelamento({ db, asaas, enviar, env = process.env, now = Date.now() } = {}) {
  if (!avisoDeCanceladaLigado(env)) return { desligado: true };
  const resumo = {};
  const conta = (st) => { resumo[st] = (resumo[st] || 0) + 1; };
  let rows = [];
  try {
    ({ rows } = await db.query(SQL_PENDENTES, [
      new Date(now - ESPERA_MS).toISOString(), new Date(now - JANELA_MS).toISOString(),
    ]));
  } catch (err) {
    if (err && err.code !== '42P01') console.error('[assinaturasAsaas] fila do aviso falhou: ' + err.message);
    return { erro_consulta: 1 };
  }

  for (const l of rows || []) {
    const sub = l.asaas_subscription_id;
    try {
      if (PEDIDOS_DA_AURA.includes(l.encerramento_pedido_por) || await foiTrocaParaPixAutomatico(db, sub)) {
        await decidir(db, sub, 'pela_aura'); conta('pela_aura'); continue;
      }
      const atual = l.assinatura_atual === sub ||
        (!l.assinatura_atual && l.encerramento_pedido_por === 'cliente_no_app');
      if (!atual) { await decidir(db, sub, 'nao_era_a_atual'); conta('nao_era_a_atual'); continue; }

      const destino = await destinatarioDaEmpresa(db, l.company_id);
      if (!destino || !destino.email) { await decidir(db, sub, 'fora'); conta('fora'); continue; }

      const naAsaas = await situacaoNaAsaas(asaas, { subId: sub, customerId: l.asaas_customer_id });
      if (!naAsaas) { conta('asaas_indisponivel'); continue; }
      if (naAsaas !== 'encerrada') { await decidir(db, sub, naAsaas); conta(naAsaas); continue; }

      const conteudo = conteudos.assinaturaCancelada({ nome: destino.nome, loja: destino.loja, caixaSegue: caixaSegue(l) });
      const r = await enviarCobranca({
        db, enviar, tipo: 'cobranca_assinatura_cancelada', chave: `assinatura-cancelada:${sub}`, destino, conteudo,
        metadata: { asaas_subscription_id: sub, evento: l.evento_de_encerramento },
      });
      if (r.status === 'sent' || r.status === 'duplicate') await decidir(db, sub, 'enviado');
      conta(r.status);
    } catch (err) {
      console.error('[assinaturasAsaas] aviso de ' + sub + ' falhou: ' + err.message);
      conta('erro');
    }
  }
  return resumo;
}

module.exports = {
  EVENTOS_DE_ENCERRAMENTO,
  PEDIDOS_DA_AURA,
  ESPERA_MS,
  JANELA_MS,
  avisoDeCanceladaLigado,
  chaveDoEvento,
  statusDoEspelho,
  encerra,
  processarEventoDeAssinatura,
  marcarEncerramentoPedido,
  situacaoNaAsaas,
  caixaSegue,
  avisosDeCancelamento,
};
