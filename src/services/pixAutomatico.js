// ============================================================
// AURA. — Cliente do Pix Automático da Asaas (tq-104, 24/10/2026)
//
// Só fala com a Asaas; não lê nem grava no banco. Quem decide o que fazer
// com as respostas é services/pixAutomaticoPiloto.js (rota de staff) e
// services/pixAutomaticoWebhook.js (eventos).
//
// Decisões do piloto (Caio, 24/10):
//   - paymentCreationMode = SUBSCRIPTION: o valor da Aura é fixo e a própria
//     Asaas gera as cobranças (uma assinatura nasce da autorização —
//     authorization.subscriptionId).
//   - Jornada 3: a cliente paga o QR do primeiro pagamento (immediateQrCode)
//     e isso autoriza os próximos. A autorização só fica ACTIVE quando o banco
//     da pagadora confirma (evento PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED).
//   - retryPolicy = ALLOW_THREE_IN_SEVEN_DAYS (só pode ser definida na criação).
//   - Notificação da Asaas desligada: o corpo da autorização NÃO tem campo de
//     notificação (referência "Criar uma autorização", conferida em 24/10), então
//     o desligamento é no cliente da Asaas: PUT /customers/:id
//     { notificationDisabled: true }, antes de criar a autorização.
//
// Endpoints (base resolvida por asaasClient: ASAAS_ENV=sandbox → sandbox):
//   POST   /pix/automatic/authorizations            criar
//   GET    /pix/automatic/authorizations/:id        consultar
//   DELETE /pix/automatic/authorizations/:id        cancelar (desfazer)
//   GET    /pix/automatic/paymentInstructions       instruções (por cobrança)
//   PUT    /customers/:id                           notificationDisabled
//   GET    /subscriptions/:id, GET /subscriptions/:id/payments (PENDING e OVERDUE),
//   DELETE /subscriptions/:id, DELETE /payments/:id,
//   POST   /payments/:id/receiveInCash              (troca e concessão)
//
// Toda chamada tem prazo (TIMEOUT_MS) e log de uma linha: método, caminho
// sem query, status e tempo. Nunca o corpo: ele leva nome, CPF/CNPJ e o
// copia e cola de quem paga.
// ============================================================
'use strict';

const asaasClient = require('./asaasClient');

const TIMEOUT_MS = 15000;

const FREQUENCIA = 'MONTHLY';
const MODO_DE_CRIACAO = 'SUBSCRIPTION';
const POLITICA_DE_RETENTATIVA = 'ALLOW_THREE_IN_SEVEN_DAYS';
// Prazo do QR do primeiro pagamento. A Cassie manda o QR pelo WhatsApp e a
// cliente pode pagar no dia seguinte; 48 h dá folga sem deixar QR velho no ar.
const EXPIRACAO_QR_PADRAO_S = 48 * 3600;

// contractId e description: no máximo 35 caracteres (referência da Asaas).
const MAX_35 = 35;

function caminhoSemQuery(p) {
  return String(p).split('?')[0];
}

async function chamar(method, path, body) {
  const t0 = Date.now();
  try {
    const r = await asaasClient.asaasRequest(method, path, body || null, undefined, { timeoutMs: TIMEOUT_MS });
    console.log(`[pixAutomatico] ${method} ${caminhoSemQuery(path)} -> ok (${Date.now() - t0}ms)`);
    return r;
  } catch (err) {
    const codigo = err && err.asaasBody && Array.isArray(err.asaasBody.errors) && err.asaasBody.errors[0]
      ? err.asaasBody.errors[0].code : null;
    console.error(`[pixAutomatico] ${method} ${caminhoSemQuery(path)} -> falhou` +
      ` status=${err && err.asaasStatus ? err.asaasStatus : (err && err.asaasTimeout ? 'timeout' : 'rede')}` +
      (codigo ? ` code=${codigo}` : '') + ` (${Date.now() - t0}ms)`);
    throw err;
  }
}

function enc(id) {
  return encodeURIComponent(String(id));
}

function corta35(s) {
  return String(s || '').slice(0, MAX_35);
}

function dataIso(v, campo) {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const e = new Error(`${campo} inválida (use AAAA-MM-DD)`);
    e.status = 400;
    throw e;
  }
  return s;
}

function valorPositivo(v, campo) {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error(`${campo} precisa ser maior que zero`);
    e.status = 400;
    throw e;
  }
  return n;
}

/**
 * Monta o corpo do POST /pix/automatic/authorizations. Separado para o teste
 * conferir exatamente o que vai para a Asaas.
 */
function montarCorpoDaAutorizacao({
  customerId, valor, primeiroDebito, dataFim, contractId, descricao,
  valorPrimeiroPagamento, descricaoPrimeiroPagamento, expiracaoSegundos,
}) {
  if (!customerId) {
    const e = new Error('empresa sem cliente na Asaas (asaas_customer_id)');
    e.status = 409;
    throw e;
  }
  if (!contractId) throw new Error('contractId obrigatório');
  const value = valorPositivo(valor, 'valor');
  const corpo = {
    customerId: String(customerId),
    frequency: FREQUENCIA,
    contractId: corta35(contractId),
    startDate: dataIso(primeiroDebito, 'primeiro_debito'),
    value,
    description: corta35(descricao || 'Assinatura Aura'),
    paymentCreationMode: MODO_DE_CRIACAO,
    retryPolicy: POLITICA_DE_RETENTATIVA,
    immediateQrCode: {
      expirationSeconds: Number(expiracaoSegundos) > 0 ? Math.floor(Number(expiracaoSegundos)) : EXPIRACAO_QR_PADRAO_S,
      originalValue: valorPositivo(valorPrimeiroPagamento == null ? value : valorPrimeiroPagamento, 'valor_primeiro_pagamento'),
      description: corta35(descricaoPrimeiroPagamento || descricao || 'Assinatura Aura'),
    },
  };
  if (dataFim) {
    corpo.finishDate = dataIso(dataFim, 'data_fim');
    if (corpo.finishDate < corpo.startDate) {
      const e = new Error('data_fim antes do primeiro débito');
      e.status = 400;
      throw e;
    }
  }
  return corpo;
}

/** O que a rota devolve para a Cassie: QR, copia e cola e prazo. */
function resumoDaAutorizacao(a) {
  if (!a) return null;
  return {
    id: a.id || null,
    status: a.status || null,
    subscription_id: a.subscriptionId || null,
    start_date: a.startDate || null,
    finish_date: a.finishDate || null,
    value: a.value != null ? Number(a.value) : null,
    // Na resposta da Asaas o QR fica na raiz (payload/encodedImage), não
    // dentro de immediateQrCode. Lido dos dois lugares por segurança.
    qr_code_base64: a.encodedImage || (a.immediateQrCode && a.immediateQrCode.encodedImage) || null,
    copia_e_cola: a.payload || (a.immediateQrCode && a.immediateQrCode.payload) || null,
    expira_em: (a.immediateQrCode && a.immediateQrCode.expirationDate) || null,
  };
}

/** Desliga as notificações da Asaas (e-mail/SMS/WhatsApp) para o cliente. */
async function desligarNotificacoesDoCliente(customerId) {
  return chamar('PUT', `/customers/${enc(customerId)}`, { notificationDisabled: true });
}

async function criarAutorizacao(params) {
  const corpo = montarCorpoDaAutorizacao(params);
  const r = await chamar('POST', '/pix/automatic/authorizations', corpo);
  return { autorizacao: r, corpo };
}

async function consultarAutorizacao(authorizationId) {
  return chamar('GET', `/pix/automatic/authorizations/${enc(authorizationId)}`);
}

async function cancelarAutorizacao(authorizationId) {
  return chamar('DELETE', `/pix/automatic/authorizations/${enc(authorizationId)}`);
}

async function listarInstrucoes({ paymentId, authorizationId, status } = {}) {
  const q = new URLSearchParams();
  if (paymentId) q.set('paymentId', paymentId);
  if (authorizationId) q.set('authorizationId', authorizationId);
  if (status) q.set('status', status);
  const r = await chamar('GET', '/pix/automatic/paymentInstructions' + (q.toString() ? '?' + q : ''));
  return (r && Array.isArray(r.data)) ? r.data : [];
}

const INSTRUCAO_VIVA = new Set(['AWAITING_REQUEST', 'SCHEDULED']);

/**
 * Cancela o débito automático de UM ciclo (concessão: mês de cortesia,
 * desconto combinado). A Asaas não tem endpoint para cancelar uma instrução;
 * a documentação diz que, quando a cobrança do ciclo é quitada por outro meio
 * até a véspera do vencimento, a instrução daquele ciclo é cancelada e a
 * autorização segue ativa para os próximos. Por isso:
 *
 *   modo 'receber_em_dinheiro' (padrão): POST /payments/:id/receiveInCash com
 *     o valor da cobrança — o ciclo fica quitado sem dinheiro entrar
 *     (é o registro da concessão);
 *   modo 'excluir_cobranca': DELETE /payments/:id — some a cobrança do ciclo.
 *     A documentação NÃO diz que isso cancela a instrução; confirmar no sandbox.
 *
 * Depois relê as instruções da cobrança e devolve o estado (o chamador
 * confere se ficou CANCELLED). Quem registra a concessão é o tq-106.
 */
async function cancelarInstrucaoDoCiclo({ paymentId, modo = 'receber_em_dinheiro', dataPagamento } = {}) {
  if (!paymentId) {
    const e = new Error('paymentId obrigatório');
    e.status = 400;
    throw e;
  }
  const antes = await listarInstrucoes({ paymentId });
  if (modo === 'excluir_cobranca') {
    await chamar('DELETE', `/payments/${enc(paymentId)}`);
  } else if (modo === 'receber_em_dinheiro') {
    const cobranca = await chamar('GET', `/payments/${enc(paymentId)}`);
    await chamar('POST', `/payments/${enc(paymentId)}/receiveInCash`, {
      paymentDate: dataPagamento || new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10),
      value: Number(cobranca && cobranca.value),
      notifyCustomer: false,
    });
  } else {
    const e = new Error('modo inválido: ' + modo);
    e.status = 400;
    throw e;
  }
  let depois = [];
  try { depois = await listarInstrucoes({ paymentId }); } catch (_) { depois = []; }
  return {
    payment_id: paymentId,
    modo,
    instrucoes_antes: antes.map((i) => ({ id: i.id, status: i.status })),
    instrucoes_depois: depois.map((i) => ({ id: i.id, status: i.status })),
    alguma_viva: depois.some((i) => INSTRUCAO_VIVA.has(i.status)),
  };
}

// ── Assinatura antiga (Pix comum) — usada só na troca ──────────
async function consultarAssinatura(subscriptionId) {
  return chamar('GET', `/subscriptions/${enc(subscriptionId)}`);
}

async function listarCobrancasPendentesDaAssinatura(subscriptionId) {
  const r = await chamar('GET', `/subscriptions/${enc(subscriptionId)}/payments?status=PENDING&limit=100`);
  return (r && Array.isArray(r.data)) ? r.data : [];
}

// Vencidas (OVERDUE) da assinatura antiga: a troca espera elas serem pagas.
// Filtra pelo status de cada cobrança também, por segurança.
async function listarCobrancasVencidasDaAssinatura(subscriptionId) {
  const r = await chamar('GET', `/subscriptions/${enc(subscriptionId)}/payments?status=OVERDUE&limit=100`);
  return ((r && Array.isArray(r.data)) ? r.data : []).filter((p) => p && p.status === 'OVERDUE');
}

async function cancelarAssinatura(subscriptionId) {
  return chamar('DELETE', `/subscriptions/${enc(subscriptionId)}`);
}

async function excluirCobranca(paymentId) {
  return chamar('DELETE', `/payments/${enc(paymentId)}`);
}

module.exports = {
  TIMEOUT_MS,
  FREQUENCIA,
  MODO_DE_CRIACAO,
  POLITICA_DE_RETENTATIVA,
  EXPIRACAO_QR_PADRAO_S,
  montarCorpoDaAutorizacao,
  resumoDaAutorizacao,
  desligarNotificacoesDoCliente,
  criarAutorizacao,
  consultarAutorizacao,
  cancelarAutorizacao,
  listarInstrucoes,
  cancelarInstrucaoDoCiclo,
  consultarAssinatura,
  listarCobrancasPendentesDaAssinatura,
  listarCobrancasVencidasDaAssinatura,
  cancelarAssinatura,
  excluirCobranca,
};
