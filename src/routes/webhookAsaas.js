// ============================================================
// AURA. — Asaas Webhook Handler
// FIX: Asaas sends access token in header, NOT HMAC signature
// Asaas header: asaas-access-token (plain token comparison)
// Mounted at: /api/v1/webhooks/asaas (PUBLIC, no auth)
// FIX (03/05): logs de debug ricos pra rastrear webhooks rejeitados
//              (zero eventos chegavam ao DB desde 24/04 — investigando se
//              é mismatch de token, header com nome diferente, ou Asaas
//              pausou a integracao). Logs aparecem no Railway.
//
// FIX (11/07/2026) — PAYMENT_DELETED destruia billing de cliente adimplente:
//   Apagar uma cobranca avulsa/pendente/vencida no painel do Asaas dispara
//   PAYMENT_DELETED. O mapa mandava isso pra billing_status='cancelled' e o
//   UPDATE gravava last_payment_date = payment.paymentDate (NULL num pagamento
//   deletado). Cliente em dia virava 'cancelled' com last_payment_date NULL,
//   caia no checkout e perdia os gates de plano (Encanto Presentes: 15/06 e
//   11/07). Agora:
//     - PAYMENT_DELETED e NEUTRO: loga em webhook_logs, nao toca em companies.
//       Cancelamento real vem de SUBSCRIPTION_DELETED/INACTIVATED.
//     - last_payment_date so e escrito em pagamento efetivo (CONFIRMED/RECEIVED).
//     - next_billing_date nunca e sobrescrito por NULL (COALESCE).
//
// FIX SEGURANCA (11/07/2026) — fail-closed, nunca confiar cegamente no body:
//   Antes desta mudanca, sem ASAAS_WEBHOOK_SECRET configurado, validateToken()
//   retornava true pra QUALQUER requisicao — um POST forjado na internet, na
//   forma certa, mudava billing_status de empresa inteira e confirmava pedido
//   Canal Digital, sem nenhuma verificacao contra o Asaas de verdade.
//
//   Esta rota tem clientes reais em producao (billing/assinatura). Fail-closed
//   "burro" (401 sempre que faltar o segredo) tem risco real de derrubar a
//   reconciliacao de pagamento em silencio SE o segredo nao estiver configurado
//   no Railway — o que nao pudemos confirmar por acesso direto ao ambiente.
//   Evidencia no repo (git log, commit e063cd0, 03/05/2026): "User confirmou
//   que ASAAS_WEBHOOK_SECRET ja esta correto no Railway" + o proprio fluxo de
//   billing seguiu processando eventos reais depois disso (fix 11/07/2026
//   acima so faz sentido se eventos PAYMENT_DELETED estavam de fato chegando e
//   sendo aceitos). Ou seja: ha indicio forte de que o segredo esta
//   configurado hoje — mas o PR nao presume isso; ver "O que o Caio precisa
//   fazer" na descricao do PR.
//
//   Estrategia adotada (2 camadas, nao mutuamente exclusivas com o cenario
//   acima):
//     1) Segredo configurado -> continua sendo a UNICA fonte de verdade.
//        Token invalido = 401 IMEDIATO, zero leitura/escrita de negocio.
//     2) Segredo AUSENTE -> NUNCA mais aceita cego. Em vez disso, o body e
//        tratado como nao-confiavel: usamos so o payment.id pra buscar o
//        pagamento de verdade na API do Asaas (GET /payments/:id, via
//        ASAAS_API_KEY — credencial DIFERENTE do webhook secret, ja exigida
//        por todo o resto da integracao de billing/assinatura e portanto com
//        evidencia solida de estar configurada). O status_map, o customer e
//        o valor gravado vem TODOS da resposta do Asaas, nunca do body.
//        Um evento forjado (ID inventado, ou ID de pagamento que nao existe/
//        nao pertence a esta operacao) nao muta NADA. Se a reverificacao
//        falhar por qualquer motivo (rede, ASAAS_API_KEY tambem ausente,
//        pagamento nao encontrado), a requisicao e um no-op — nunca mutacao.
//   Isso preserva a reconciliacao de billing legitima mesmo se
//   ASAAS_WEBHOOK_SECRET cair/for removido por engano, sem reabrir o buraco
//   de forjar eventos direto no body.
//
// FIX (13/10/2026) — next_billing_date ficava um ciclo para tras:
//   O UPDATE gravava next_billing_date = payment.dueDate, ou seja, o
//   vencimento da cobranca que ACABOU DE SER PAGA, nao o proximo (Encanto
//   Presentes ficou em 15/09, Finesse em 08/08, Davi Villa Branca em 18/06).
//   Agora o proximo vencimento vem da propria Asaas (services/asaasAssinaturas
//   -> proximoVencimento: cobranca pendente mais proxima ou nextDueDate da
//   assinatura) e so e gravado em pagamento efetivo. Se a Asaas nao responder,
//   next_billing_date fica como estava — o dueDate do pagamento NUNCA mais
//   entra nessa coluna.
//
//   No mesmo dia: pagamento que nao acha empresa passou a ser gravado em
//   webhook_logs com company_id NULL (antes so saia no console). E o que
//   alimenta o alerta "pagamento sem loja" e GET /admin/painel/asaas/orfaos.
// FIX (14/10/2026) — reenvio seguro e cobranca criada (cartao t3-02, Celia):
//   - last_payment_date = GREATEST(paymentDate, last_payment_date): reenviar
//     (ou receber atrasado) o evento de um pagamento antigo nao regride mais a
//     data (caso Davi: o pagamento de 19/05 nao pode apagar o de 24/09).
//   - PAYMENT_RECEIVED / PAYMENT_CONFIRMED / PAYMENT_CREATED ja registrado
//     em webhook_logs para o mesmo pagamento (mesmo evento + mesmo pay_) e
//     reenvio: responde 200 sem tocar em companies e sem gravar outra linha.
//     O log e gravado DEPOIS do efeito, entao "ja tem log" = "ja teve efeito".
//   - PAYMENT_CREATED passa a ser registrado (neutro, como PAYMENT_DELETED):
//     e o "a receber" da Financeiro. Sem loja ele nao e gravado (nao e
//     dinheiro e poluiria a lista de pagamentos sem loja).
//   - Pagamento com paymentDate ANTERIOR ao last_payment_date da loja so e
//     registrado: nao muda billing_status nem propaga para filiais.
//   - A checagem de reenvio exige, para RECEIVED/CONFIRMED, que o log antigo
//     tenha status de pago, e, com loja encontrada, que ele ja esteja
//     vinculado a uma loja (orfao vinculado depois pode ser reprocessado).
//   PAYMENT_OVERDUE e PAYMENT_DELETED seguem exatamente como antes.
//
// ATENCAO: quando operando sem segredo, o log fica MUITO barulhento de
// proposito (WARN por requisicao) — ninguem deve poder dizer que "nao viu".
//
// Handles two flows:
//   1. externalReference = 'digital-order-<uuid>'  → pedido Canal Digital
//   2. tudo mais                                    → billing de empresa (plano)
//
// MULTI-CNPJ (M2): quando o billing da PRIMARY muda, propaga pras
// empresas filhas (billing_owner_company_id = primary.id). Sem isso,
// uma empresa secundária que nunca paga ficaria com status errado
// (ex: primary cancela, mas filha continua 'active'). A primary é a
// fonte da verdade de billing pra todo o "grupo" do owner.
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const crypto  = require('crypto');
const notify  = require('../services/digitalOrderNotifications');
const lojaEvents = require('../services/lojaEvents');
const { asaas } = require('../services/asaasClient');
const marketingQuota = require('../services/marketing/marketingQuota');
const { proximoVencimento } = require('../services/asaasAssinaturas');

const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_SECRET;

// Log inicial 1x no boot pra confirmar config
if (ASAAS_WEBHOOK_TOKEN) {
  console.log('[WEBHOOK] ASAAS_WEBHOOK_SECRET configurado (length=' + ASAAS_WEBHOOK_TOKEN.length + ', sha256-prefix=' +
    crypto.createHash('sha256').update(ASAAS_WEBHOOK_TOKEN).digest('hex').slice(0, 8) + ')');
} else {
  console.warn('[WEBHOOK] ASAAS_WEBHOOK_SECRET NAO configurado — operando em modo reverificacao ' +
    'server-to-server (nunca confia no body; ver comentario de topo do arquivo). ' +
    'Configure ASAAS_WEBHOOK_SECRET no Railway assim que possivel.');
}

function logIncomingRequest(req, decision, reason) {
  // Sanitiza headers pra log: nao loga valor de auth, so presence + length
  const headerNames = Object.keys(req.headers || {}).sort();
  const authLikeHeaders = headerNames.filter(h =>
    /token|secret|signature|auth|asaas/i.test(h)
  );
  const headerSummary = authLikeHeaders.map(h => {
    const v = req.headers[h];
    const len = typeof v === 'string' ? v.length : (Array.isArray(v) ? v.join(',').length : 0);
    return h + '(len=' + len + ')';
  });
  const event = req.body?.event || '(no event)';
  const paymentId = req.body?.payment?.id || '(no payment)';
  console.log('[WEBHOOK] ' + decision + ' — ' + reason + ' | event=' + event +
    ' | payment=' + paymentId + ' | auth-headers=[' + headerSummary.join(', ') +
    '] | all-header-count=' + headerNames.length + ' | from-ip=' + (req.ip || '(unknown)'));
}

// Valida o token contra ASAAS_WEBHOOK_SECRET. So deve ser chamada quando o
// segredo esta configurado — o caso "sem segredo" e tratado no router (nao
// aqui) porque o comportamento nesse caso NAO e "aceitar", e "reverificar".
function validateToken(req) {
  var token = req.headers['asaas-access-token'] || '';
  if (!token) {
    // Tenta variantes comuns de nome de header (caso Asaas tenha mudado)
    var alt = req.headers['asaas-token'] || req.headers['x-asaas-token'] ||
              req.headers['x-asaas-signature'] || req.headers['authorization'] || '';
    if (alt) {
      logIncomingRequest(req, 'REJECTED-401',
        'missing asaas-access-token header but found alternate auth-like header — Asaas pode ter mudado o nome do header');
    } else {
      logIncomingRequest(req, 'REJECTED-401', 'no asaas-access-token header at all');
    }
    return false;
  }
  try {
    var a = Buffer.from(String(token));
    var b = Buffer.from(String(ASAAS_WEBHOOK_TOKEN));
    if (a.length !== b.length) {
      logIncomingRequest(req, 'REJECTED-401',
        'token length mismatch: received=' + a.length + ', expected=' + b.length);
      return false;
    }
    const ok = crypto.timingSafeEqual(a, b);
    if (!ok) {
      logIncomingRequest(req, 'REJECTED-401', 'token value mismatch (same length)');
      return false;
    }
    logIncomingRequest(req, 'ACCEPTED', 'token valid');
    return true;
  } catch (err) {
    logIncomingRequest(req, 'REJECTED-401', 'comparison threw: ' + err.message);
    return false;
  }
}

// Busca o pagamento DIRETO na API do Asaas (nunca confia no body). So
// usada quando ASAAS_WEBHOOK_SECRET nao esta configurado. Usa ASAAS_API_KEY
// (credencial diferente, ja exigida pelo restante da integracao de billing —
// ver src/services/asaasClient.js). Retorna null em qualquer falha
// (pagamento inexistente, rede, ASAAS_API_KEY tambem ausente) — o chamador
// trata null como "nao mutar nada".
async function reverifyPaymentWithAsaas(paymentId) {
  if (!paymentId) return null;
  try {
    var verified = await asaas('GET', '/payments/' + encodeURIComponent(paymentId));
    return (verified && verified.id) ? verified : null;
  } catch (err) {
    console.error('[WEBHOOK] reverificacao server-to-server falhou pra payment ' +
      paymentId + ': ' + err.message);
    return null;
  }
}

// 11/07/2026: PAYMENT_DELETED foi REMOVIDO deste mapa de proposito.
// Apagar uma cobranca no painel NAO e um sinal de que o cliente cancelou a
// assinatura — e uma operacao administrativa rotineira (limpar duplicada,
// remover vencida antes de reemitir). Mapea-lo pra 'cancelled' derrubava
// cliente adimplente pro checkout. Ver STATUS_NEUTRAL_EVENTS abaixo.
var PAYMENT_STATUS_MAP = {
  PAYMENT_CONFIRMED: 'active',
  PAYMENT_RECEIVED:  'active',
  PAYMENT_OVERDUE:   'overdue',
  PAYMENT_REFUNDED:  'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

// Eventos registrados (auditoria) mas que NAO alteram o billing da empresa.
// 14/10/2026: PAYMENT_CREATED entra aqui — cobranca criada e o "a receber"
// da Financeiro, nao diz nada sobre o status da assinatura.
var STATUS_NEUTRAL_EVENTS = {
  PAYMENT_DELETED: true,
  PAYMENT_CREATED: true,
};

// Eventos neutros que so valem com loja: sem empresa, nao sao gravados
// (cobranca criada nao e dinheiro; a lista de "pagamento sem loja" e de
// dinheiro que entrou).
var NEUTRAL_ONLY_WITH_COMPANY = {
  PAYMENT_CREATED: true,
};

// Reenvio do mesmo evento para o mesmo pagamento nao repete o efeito. So
// estes: um pagamento recebe cada um deles uma unica vez. OVERDUE/DELETED
// ficam como estavam (t3-02 pediu para nao mexer).
var DEDUPE_EVENTS = {
  PAYMENT_RECEIVED:  true,
  PAYMENT_CONFIRMED: true,
  PAYMENT_CREATED:   true,
};

// So estes eventos representam dinheiro efetivamente recebido — apenas eles
// podem escrever last_payment_date.
var PAID_EVENTS = {
  PAYMENT_CONFIRMED: true,
  PAYMENT_RECEIVED:  true,
};

var ORDER_PAYMENT_MAP = {
  PAYMENT_CONFIRMED: 'confirmed',
  PAYMENT_RECEIVED:  'confirmed',
  PAYMENT_REFUNDED:  'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

// Equivalentes aos mapas acima, mas chaveados pelo status REAL devolvido
// pela API do Asaas (payment.status), nao pelo nome do evento do body.
// Usados SOMENTE no modo reverificacao (sem segredo configurado) — nesse
// modo o "evento" nunca decide nada, so o status que o Asaas confirma.
// Sem equivalente pra PAYMENT_DELETED: se o pagamento foi apagado, o GET
// devolve 404 e reverifyPaymentWithAsaas ja retorna null antes de chegar aqui.
var ASAAS_STATUS_TO_BILLING = {
  CONFIRMED: 'active',
  RECEIVED:  'active',
  OVERDUE:   'overdue',
  REFUNDED:  'refunded',
  CHARGEBACK_REQUESTED: 'chargeback',
};
var ASAAS_STATUS_IS_PAID = {
  CONFIRMED: true,
  RECEIVED:  true,
};
var ASAAS_STATUS_TO_ORDER_PAYMENT = {
  CONFIRMED: 'confirmed',
  RECEIVED:  'confirmed',
  REFUNDED:  'refunded',
  CHARGEBACK_REQUESTED: 'chargeback',
};

// externalReference so entra na busca por companies.id quando tem cara de
// UUID: qualquer outro texto faria o Postgres recusar a consulta inteira
// (22P02) e o pagamento sumiria no catch.
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Grava o evento cru em webhook_logs. Best-effort — nunca derruba o handler.
async function logWebhookEvent(companyId, event, payment) {
  await db.query(
    'INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at) VALUES ($1, \'asaas\', $2, $3, NOW())',
    [companyId, event, JSON.stringify(payment)]
  ).catch(function() {});
}

// O mesmo evento ja foi registrado para este pagamento? Em erro de leitura
// responde false: o handler segue como antes (melhor processar de novo —
// com GREATEST a data nao regride — do que perder um pagamento).
//   - Evento de dinheiro (RECEIVED/CONFIRMED) so conta como reenvio se o log
//     antigo tambem tinha status de pago: um log gravado com o evento errado
//     (body forjado ou status OVERDUE) nao "envenena" a chave e nao faz o
//     pagamento real ser descartado.
//   - comEmpresa: a empresa foi encontrada, entao so vale log JA vinculado a
//     uma loja. Um orfao gravado antes (company_id NULL) nao bloqueia o
//     reenvio depois que alguem cadastra o cliente da Asaas na loja.
var STATUS_PAGOS_NO_LOG = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
async function alreadyLogged(event, paymentId, comEmpresa) {
  if (!paymentId) return false;
  try {
    var r = await db.query(
      `SELECT 1 FROM webhook_logs
        WHERE provider = 'asaas' AND event = $1
          AND COALESCE(payload->'payment', payload)->>'id' = $2
          AND ($3::boolean IS NOT TRUE OR company_id IS NOT NULL)
          AND ($4::boolean IS NOT TRUE
               OR COALESCE(payload->'payment', payload)->>'status' = ANY($5::text[]))
        LIMIT 1`,
      [event, String(paymentId), !!comEmpresa, !!PAID_EVENTS[event], STATUS_PAGOS_NO_LOG]
    );
    return !!(r && r.rows && r.rows.length);
  } catch (err) {
    console.error('[WEBHOOK] checagem de reenvio falhou (seguindo): ' + err.message);
    return false;
  }
}

router.post('/', async function(req, res) {
  var hasSecret = !!ASAAS_WEBHOOK_TOKEN;

  if (hasSecret) {
    if (!validateToken(req)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else {
    // Barulhento de proposito — sem isso o buraco fica invisivel nos logs.
    console.warn('[WEBHOOK] ASAAS_WEBHOOK_SECRET ausente — NAO confiando no body. ' +
      'Reverificando o pagamento direto na API do Asaas antes de qualquer mutacao.');
  }

  var event       = req.body.event;
  var bodyPayment = req.body.payment;
  if (!event || !bodyPayment) return res.status(200).json({ received: true });

  var payment       = bodyPayment;
  var statusSource  = 'body'; // confiavel: token ja validado acima
  var newStatus, isNeutral, isPaid, newOrderPaymentStatus;

  if (!hasSecret) {
    var verified = await reverifyPaymentWithAsaas(bodyPayment.id);
    if (!verified) {
      console.warn('[WEBHOOK] Reverificacao sem sucesso (pagamento nao encontrado no Asaas, ' +
        'ASAAS_API_KEY ausente, ou erro de rede) — evento IGNORADO, ZERO mutacao. ' +
        'claimed_event=' + event + ' | claimed_payment_id=' + (bodyPayment.id || '(ausente)'));
      return res.status(200).json({ received: true, handled: false, reason: 'no_secret_reverification_failed' });
    }
    if (bodyPayment.status && verified.status !== bodyPayment.status) {
      console.warn('[WEBHOOK] body reivindicava status diferente do status real no Asaas — ' +
        'usando SOMENTE o status real. claimed=' + bodyPayment.status + ' real=' + verified.status +
        ' payment_id=' + verified.id);
    }
    payment      = verified;      // nunca mais usamos bodyPayment daqui pra baixo
    statusSource = 'asaas-api';
  }

  console.log('[WEBHOOK] Asaas event: ' + event + ' | Payment: ' + payment.id +
    ' | ref: ' + payment.externalReference + ' | source=' + statusSource);

  if (statusSource === 'asaas-api') {
    var realStatus = payment.status;
    newStatus             = ASAAS_STATUS_TO_BILLING[realStatus];
    // PAYMENT_DELETED equivalente ja foi filtrado (404 -> null acima). Cobranca
    // criada: so registra se a Asaas confirma que ela existe e esta pendente.
    isNeutral              = (event === 'PAYMENT_CREATED' && realStatus === 'PENDING');
    isPaid                 = !!ASAAS_STATUS_IS_PAID[realStatus];
    newOrderPaymentStatus  = ASAAS_STATUS_TO_ORDER_PAYMENT[realStatus];
  } else {
    newStatus             = PAYMENT_STATUS_MAP[event];
    isNeutral              = !!STATUS_NEUTRAL_EVENTS[event];
    isPaid                 = !!PAID_EVENTS[event];
    newOrderPaymentStatus  = ORDER_PAYMENT_MAP[event];
  }

  // ── 1. Digital order payment
  var extRef = payment.externalReference || '';
  if (extRef.startsWith('digital-order-')) {
    return handleDigitalOrderPayment(req, res, event, payment, extRef, newOrderPaymentStatus);
  }

  // ── 1b. Pacote extra de mensagens de marketing (Fase 8b)
  // Cobranca avulsa criada em POST /companies/:id/whatsapp/marketing-packs.
  // Nao e billing de plano: nao pode passar pelo bloco de companies
  // abaixo, senao um pacote pago viraria "assinatura em dia" e um pacote
  // vencido viraria "assinatura vencida" de uma empresa adimplente.
  if (extRef.startsWith('wa-pack-')) {
    return handleMarketingPackPayment(req, res, event, payment, extRef, isPaid);
  }

  // ── 2. Company billing (plano)
  try {
    if (!newStatus && !isNeutral) {
      console.log('[WEBHOOK] Event/status nao mapeado — ignorando (mas recebido). event=' + event +
        ' status_source=' + statusSource);
      return res.status(200).json({ received: true, handled: false, event_ignored: event });
    }

    var duplicado = function() {
      console.log('[WEBHOOK] Reenvio ignorado: ' + event + ' de ' + payment.id + ' ja registrado em webhook_logs');
      return res.status(200).json({ received: true, handled: false, duplicate: true, event: event });
    };

    var result = await db.query(
      'SELECT id, plan, billing_status, is_primary, asaas_subscription_id FROM companies WHERE asaas_customer_id=$1 OR id=$2 LIMIT 1',
      [payment.customer || null, UUID_RE.test(payment.externalReference || '') ? payment.externalReference : null]
    );
    if (!result.rows.length) {
      if (isNeutral && NEUTRAL_ONLY_WITH_COMPANY[event]) {
        console.log('[WEBHOOK] ' + event + ' sem loja (customer ' + payment.customer + ') — nao registrado');
        return res.status(200).json({ received: true, company_found: false, logged: false });
      }
      // Reenvio de um orfao ja gravado: nao grava outra linha sem loja.
      if (DEDUPE_EVENTS[event] && await alreadyLogged(event, payment.id, false)) return duplicado();
      // Sem loja: o evento fica registrado com company_id NULL em vez de
      // sumir. Vincular e decisao de gente (POST /admin/painel/asaas/orfaos/
      // :logId/vincular) — aqui ninguem adivinha de quem e o dinheiro.
      await logWebhookEvent(null, event, payment);
      console.warn('[WEBHOOK] Company not found for customer ' + payment.customer +
        ' — evento ' + event + ' gravado em webhook_logs sem empresa');
      return res.status(200).json({ received: true, company_found: false });
    }

    var company    = result.rows[0];
    var prevStatus = company.billing_status;

    // Reenvio: o mesmo evento deste pagamento ja foi processado e registrado
    // numa loja.
    if (DEDUPE_EVENTS[event] && await alreadyLogged(event, payment.id, true)) return duplicado();

    // ── Evento neutro: audita e sai SEM tocar em companies ────
    // PAYMENT_DELETED cai aqui. Apagar uma cobranca no Asaas nao diz nada
    // sobre a saude da assinatura do cliente.
    if (isNeutral) {
      await logWebhookEvent(company.id, event, payment);
      console.log('[WEBHOOK] Company ' + company.id + ' — evento neutro ' + event +
                  ' registrado; billing_status preservado em ' + prevStatus);
      return res.status(200).json({
        received: true,
        handled: true,
        status_changed: false,
        status: prevStatus,
        event_neutral: event,
      });
    }

    // Pagamento ANTIGO (anterior ao ultimo pagamento conhecido da loja), como
    // o de 19/05 da Davi chegando com last_payment_date em 24/09: e dinheiro
    // que entrou e fica registrado, mas nao diz nada sobre a situacao de HOJE.
    // Nao muda billing_status (uma loja 'overdue' continua 'overdue') nem
    // propaga para as filiais. Pagamento novo ou loja sem data: fluxo normal.
    var dataPagamento = payment.paymentDate ? String(payment.paymentDate).slice(0, 10) : null;
    var ultimoPagamento = null;
    if (isPaid && dataPagamento) {
      var ult = await db.query('SELECT last_payment_date::text AS last_payment_text FROM companies WHERE id = $1', [company.id]);
      ultimoPagamento = (ult && ult.rows && ult.rows[0] && ult.rows[0].last_payment_text) || null;
    }
    if (isPaid && dataPagamento && ultimoPagamento && dataPagamento < ultimoPagamento) {
      await logWebhookEvent(company.id, event, payment);
      console.log('[WEBHOOK] Company ' + company.id + ' — pagamento antigo ' + payment.id + ' (' + dataPagamento +
        ' < ' + ultimoPagamento + ') registrado; billing_status preservado em ' + prevStatus);
      return res.status(200).json({
        received: true,
        handled: true,
        status_changed: false,
        status: prevStatus,
        old_payment: true,
      });
    }

    // Proximo vencimento: so a Asaas sabe. Consultado apenas em pagamento
    // efetivo (e quando o dinheiro entra que o ciclo anda). Sem resposta,
    // fica NULL e o COALESCE abaixo preserva a data atual.
    var nextDue = null;
    if (isPaid) {
      var proximo = await proximoVencimento(asaas, company.asaas_subscription_id || payment.subscription);
      nextDue = proximo ? proximo.data : null;
    }

    // last_payment_date so avanca em pagamento efetivo; nos demais eventos
    // (OVERDUE, REFUNDED, CHARGEBACK) preserva o que ja estava la. E so
    // AVANCA: GREATEST ignora NULL e nunca devolve a data mais antiga, entao
    // um evento antigo reenviado nao regride a empresa (14/10/2026).
    // next_billing_date nunca e sobrescrito por NULL, e nunca recebe
    // payment.dueDate (e o vencimento da cobranca ja paga, nao o proximo).
    await db.query(
      `UPDATE companies
          SET billing_status    = $1,
              last_payment_date = CASE WHEN $2 THEN GREATEST($3::date, last_payment_date) ELSE last_payment_date END,
              next_billing_date = COALESCE($4, next_billing_date),
              updated_at        = NOW()
        WHERE id = $5`,
      [newStatus, isPaid, payment.paymentDate || null, nextDue, company.id]
    );

    // Segundo UPDATE, so com a data da Asaas e sem tocar em last_payment_date
    // (cartao ti-03, 18/10/2026). O trigger tr_billing_renewal_from_due_date
    // (migration 393) age quando last_payment_date muda: se a data informada
    // no UPDATE acima for IGUAL a que ja estava gravada, ele le "nao informou"
    // e soma 1 mes (ex.: pagamento atrasado depois da correcao de
    // vencimentos — gravaria 15/12 em vez de 15/11). Aqui last_payment_date
    // nao muda, o trigger nao age e vale a data da Asaas. COALESCE: nunca
    // sobrescreve com NULL. Sem transacao, como o resto do handler: se este
    // falhar, fica o resultado do UPDATE acima (o comportamento anterior).
    if (nextDue) {
      await db.query(
        `UPDATE companies
            SET next_billing_date = COALESCE($1::date, next_billing_date),
                updated_at        = NOW()
          WHERE id = $2`,
        [nextDue, company.id]
      );
    }

    // ── MULTI-CNPJ: propaga pra filhas se for primary ────
    // billing_owner_company_id aponta pra primary; quando ela muda
    // de status, todas as filhas devem refletir (atender requisições
    // de plano, gates, etc). Não propagamos last_payment/next_billing
    // pras filhas porque essas datas são da subscription real e podem
    // confundir UIs que mostram "próximo vencimento por empresa".
    var propagated = 0;
    if (company.is_primary) {
      var propagateRes = await db.query(
        `UPDATE companies
            SET billing_status = $1, updated_at = NOW()
          WHERE billing_owner_company_id = $2
            AND id <> $2
            AND is_active = true`,
        [newStatus, company.id]
      );
      propagated = propagateRes.rowCount || 0;
      if (propagated > 0) {
        console.log('[WEBHOOK] Propagated billing_status=' + newStatus +
                    ' to ' + propagated + ' child companies of primary ' + company.id);
      }
    }

    await logWebhookEvent(company.id, event, payment);

    console.log('[WEBHOOK] Company ' + company.id + ' billing: ' + prevStatus + ' -> ' + newStatus);
    res.status(200).json({
      received: true,
      handled: true,
      status: newStatus,
      next_billing_date: nextDue,
      propagated_to_children: propagated,
    });
  } catch (err) {
    console.error('[WEBHOOK] Error processing billing:', err.message);
    res.status(200).json({ received: true, error: true });
  }
});

// Pacote extra de mensagens de MARKETING (wa_marketing_packs, 332).
//
// So DINHEIRO RECEBIDO ativa: `isPaid` ja vem decidido la em cima pelo
// status real do Asaas (ou pelo evento, quando o segredo do webhook
// validou o body). Qualquer outro evento e registrado como ignorado — o
// pacote fica 'pending' e a cota nao muda, que e o comportamento seguro
// para quem so gerou o boleto.
//
// A ativacao e idempotente no servico (activated_at com COALESCE): o
// Asaas reenvia o mesmo evento e isso nao pode virar cota dobrada.
async function handleMarketingPackPayment(req, res, event, payment, extRef, isPaid) {
  const packId = extRef.replace('wa-pack-', '').trim();

  if (!isPaid) {
    console.log('[WEBHOOK] wa-pack ' + packId + ': evento sem dinheiro recebido (' + event + ') — ignorado');
    return res.status(200).json({ received: true, handled: false, reason: 'event_ignored' });
  }

  try {
    const pack = await marketingQuota.activatePack(packId, payment.id);
    if (!pack) {
      console.warn('[WEBHOOK] wa-pack nao encontrado (ou cancelado/migration 332 pendente):', packId);
      return res.status(200).json({ received: true, pack_found: false });
    }
    await logWebhookEvent(pack.company_id, event, payment);
    console.log('[WEBHOOK] wa-pack ' + pack.id + ' ativado para a company ' + pack.company_id +
      ' (+' + pack.qty + ' mensagens de marketing)');
    return res.status(200).json({
      received: true, handled: true,
      pack_id: pack.id, company_id: pack.company_id, qty: pack.qty, status: pack.status,
    });
  } catch (err) {
    console.error('[WEBHOOK] Error ativando pacote de marketing:', err.message);
    return res.status(200).json({ received: true, error: true });
  }
}

async function handleDigitalOrderPayment(req, res, event, payment, extRef, newPaymentStatus) {
  const orderId = extRef.replace('digital-order-', '').trim();

  if (!newPaymentStatus) {
    return res.status(200).json({ received: true, handled: false, reason: 'event_ignored' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, status, payment_status, company_id, customer_name, customer_email, order_number
       FROM digital_orders WHERE id = $1`, [orderId]
    );
    if (!rows.length) {
      console.warn('[WEBHOOK] digital order not found:', orderId);
      return res.status(200).json({ received: true, order_found: false });
    }

    const order = rows[0];
    if (order.payment_status === 'confirmed' && newPaymentStatus === 'confirmed') {
      return res.status(200).json({ received: true, handled: false, reason: 'already_confirmed' });
    }

    const shouldConfirmOrder = newPaymentStatus === 'confirmed' && order.status === 'pending_payment';

    await db.query(`
      UPDATE digital_orders SET
        payment_status   = $1,
        asaas_payment_id = COALESCE(asaas_payment_id, $2),
        status           = CASE WHEN $3 THEN 'confirmed' ELSE status END,
        confirmed_at     = CASE WHEN $3 AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END,
        updated_at       = NOW()
      WHERE id = $4
    `, [newPaymentStatus, payment.id, shouldConfirmOrder, orderId]);

    await logWebhookEvent(order.company_id, event, payment);

    console.log(`[WEBHOOK] digital_order ${orderId}: payment -> ${newPaymentStatus}` +
      (shouldConfirmOrder ? ', status -> confirmed' : ''));

    // Notificacões (fire-and-forget)
    if (shouldConfirmOrder) {
      notify.notifyPaymentConfirmed({ order: { ...order, status: 'confirmed' } })
        .catch(err => console.error('[notify] payment confirmed error:', err.message));
    }
    // Evento durável: "o dinheiro caiu" é o momento de separar a mercadoria,
    // e era invisível no sino. dedupe_key por pedido — webhook reprocessado
    // (o Asaas reenvia) não vira segundo aviso.
    if (newPaymentStatus === 'confirmed') {
      lojaEvents.emit('loja_pedido_pago', { id: orderId, company_id: order.company_id });
    }

    res.status(200).json({
      received:        true,
      handled:         true,
      order_id:        orderId,
      payment_status:  newPaymentStatus,
      order_confirmed: shouldConfirmOrder,
    });
  } catch (err) {
    console.error('[WEBHOOK] Error processing digital order payment:', err.message);
    res.status(200).json({ received: true, error: true });
  }
}

// ── Endpoint de diagnostico (GET, sem validacao de token) ─────
// Permite ao operador checar se o secret esta carregado e bate
// com o que ele espera (compara hash de prefixo, nao o secret cru).
// Uso: curl https://.../api/v1/webhooks/asaas/_diag
router.get('/_diag', function(req, res) {
  res.json({
    status: 'ok',
    secret_configured: !!ASAAS_WEBHOOK_TOKEN,
    secret_length: ASAAS_WEBHOOK_TOKEN ? ASAAS_WEBHOOK_TOKEN.length : 0,
    secret_sha256_prefix: ASAAS_WEBHOOK_TOKEN
      ? crypto.createHash('sha256').update(ASAAS_WEBHOOK_TOKEN).digest('hex').slice(0, 8)
      : null,
    expected_header: 'asaas-access-token',
    note: 'Compare secret_sha256_prefix com o hash do token configurado no painel Asaas pra confirmar que batem.',
  });
});

module.exports = router;
