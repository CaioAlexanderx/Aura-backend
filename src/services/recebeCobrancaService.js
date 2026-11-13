// ============================================================
// AURA. — Recebe na Aura: cobrança na SUBCONTA da loja, com split (RA-08)
// 13/11/2026.
//
// Modelo A: a Asaas presta o serviço financeiro, a Aura integra. A cobrança
// nasce na SUBCONTA da loja (chave da subconta, cifrada como o RA-05 guarda)
// e o dinheiro cai lá; a Aura recebe só a taxa da plataforma, pelo split, na
// própria Asaas. O dinheiro nunca passa pela Aura.
//
// Regras fixas:
//   - split em TODO pagamento, para a carteira da Aura (env
//     RECEBE_AURA_WALLET_ID). Sem a carteira configurada, nenhuma cobrança
//     é criada (503): cobrança sem split não existe no Recebe na Aura.
//   - o comprador não recebe e-mail/SMS da Asaas: todo cliente criado na
//     subconta sai de buildSubaccountCustomerPayload (notificationDisabled:
//     true). Cliente já existente só é reaproveitado se também estiver com
//     notificationDisabled = true; senão, cria outro (nunca altera cliente).
//   - externalReference aponta para a origem: "recebe:<tipo>:<id>" (pedido
//     da loja online ou venda do Caixa). O RA-09/RA-10 ligam o aviso de
//     pagamento (RA-07) à origem por ela.
//   - só subconta APROVADA cobra. Qualquer outro status: recusa gentil, sem
//     chamar a Asaas.
//
// Sem rota pública para lojista ainda: só este serviço e a rota interna de
// staff (routes/adminRecebe.js), atrás da flag RECEBE_NA_AURA_ENABLED e de
// users.is_staff.
//
// Contra cobrança em dobro (clique duplo, nova tentativa depois de resposta
// ambígua da Asaas): antes de criar, procura na subconta uma cobrança com a
// mesma externalReference. Pendente com o mesmo valor e forma → devolve a
// mesma; já paga → 409; qualquer outra coisa → cria. Se a busca falhar, não
// cria (502).
//
// Nunca loga a chave da subconta, o CPF/CNPJ do comprador nem o corpo da
// Asaas: só o status HTTP e a mensagem.
// ============================================================
'use strict';

const db = require('../config/database');
const asaasClient = require('./asaasClient');
const { decrypt } = require('./dojoBaasCrypto');
const { svcError, str } = require('./baasShared');
const companyBaas = require('./companyBaasService');

// O nome do produto mora em UM lugar só (companyBaasService).
const RECEBE_NA_AURA_NAME = companyBaas.RECEBE_NA_AURA_NAME;

const WALLET_ENV = 'RECEBE_AURA_WALLET_ID';

// ── Taxa da plataforma Aura, por forma de pagamento ──
// FONTE: levantamento "Plano do Recebe na Aura" (Produto/Design, 09/11/2026),
// seção "Quanto rende" → "Fórmula do split: no Pix a Aura recebe 2% do valor
// cobrado; no cartão, 1,01% do valor menos R$ 0,49 por cobrança."
// Base = valor BRUTO cobrado. Por isso o split vai como fixedValue calculado
// aqui, e não como percentualValue: na Asaas o percentual incide sobre o
// netValue, já sem as tarifas (docs.asaas.com, "Split de pagamentos").
// Mudou a regra? Muda SÓ aqui.
const AURA_SPLIT_RULES = Object.freeze({
  PIX: Object.freeze({ percent: 2, minusFixed: 0 }),
  CREDIT_CARD: Object.freeze({ percent: 1.01, minusFixed: 0.49 }),
});
const BILLING_TYPES = Object.keys(AURA_SPLIT_RULES);

// Origens da cobrança. 'teste' só pela rota de staff.
const ORIGIN_TYPES = ['pedido', 'venda'];
const TEST_ORIGIN_TYPE = 'teste';

const PAID_STATUSES = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
const ASAAS_TIMEOUT_MS = 15000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toCents(v) {
  return Math.round(Number(v) * 100);
}

// Taxa da Aura em reais (2 casas). 0 = a regra não dá taxa para esse valor.
function auraFeeFor(billingType, value) {
  const rule = AURA_SPLIT_RULES[billingType];
  if (!rule) return 0;
  const cents = Math.round((toCents(value) * rule.percent) / 100) - toCents(rule.minusFixed);
  return cents > 0 ? cents / 100 : 0;
}

// Menor valor em que a regra dá ao menos R$ 0,01 de taxa (o split não aceita 0).
function minValueFor(billingType) {
  const rule = AURA_SPLIT_RULES[billingType];
  if (!rule || !rule.minusFixed) return 0.01;
  let cents = Math.ceil(((toCents(rule.minusFixed) + 1) * 100) / rule.percent);
  while (auraFeeFor(billingType, (cents - 1) / 100) > 0) cents -= 1;
  while (auraFeeFor(billingType, cents / 100) <= 0) cents += 1;
  return cents / 100;
}

function brl(v) {
  return `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
}

function todayInBrazil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function buildExternalReference(origin) {
  return `recebe:${origin.type}:${origin.id}`;
}

// Valida e normaliza a entrada. 422 VALIDATION_ERROR no primeiro problema.
function validateInput(input, opts = {}) {
  const b = input || {};
  const bad = (msg) => svcError(422, 'VALIDATION_ERROR', msg);

  const billingType = str(b.billing_type).toUpperCase();
  if (!BILLING_TYPES.includes(billingType)) throw bad(`billing_type deve ser ${BILLING_TYPES.join(' ou ')}`);

  const value = Number(b.value);
  if (!Number.isFinite(value) || value <= 0) throw bad('value deve ser maior que zero');
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw bad('value deve ter no máximo 2 casas decimais');

  const dueDate = str(b.due_date) || todayInBrazil();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw bad('due_date deve ser YYYY-MM-DD');

  const o = b.origin || {};
  const allowed = opts.allowTestOrigin ? [...ORIGIN_TYPES, TEST_ORIGIN_TYPE] : ORIGIN_TYPES;
  const originType = str(o.type).toLowerCase();
  if (!allowed.includes(originType)) throw bad(`origin.type deve ser ${allowed.join(', ')}`);
  const originId = str(o.id);
  if (!UUID_RE.test(originId)) throw bad('origin.id deve ser um UUID');

  const c = b.customer || {};
  const name = str(c.name);
  if (!name) throw bad('customer.name é obrigatório');
  const cpfCnpj = str(c.cpf_cnpj).replace(/\D/g, '');
  if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) throw bad('customer.cpf_cnpj deve ter 11 (CPF) ou 14 (CNPJ) dígitos');
  const email = str(c.email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('customer.email inválido');
  const mobile = str(c.mobile_phone).replace(/\D/g, '');

  const description = (str(b.description) || RECEBE_NA_AURA_NAME).slice(0, 500);

  return {
    billingType,
    value: Math.round(value * 100) / 100,
    dueDate,
    origin: { type: originType, id: originId },
    customer: { name, cpfCnpj, email: email || null, mobilePhone: mobile || null },
    description,
  };
}

// Carrega a subconta e confere se pode cobrar.
async function loadApprovedAccount(companyId) {
  let row;
  try {
    const { rows } = await db.query(
      `SELECT status, api_key_enc FROM company_baas_accounts WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    row = rows[0] || null;
  } catch (e) {
    if (e && e.code === '42P01') {
      throw svcError(503, 'SCHEMA_PENDING', `O ${RECEBE_NA_AURA_NAME} ainda não está disponível (migration 436 pendente).`);
    }
    throw e;
  }
  if (!row) throw svcError(404, 'RECEBE_SEM_SUBCONTA', `Esta empresa ainda não ativou o ${RECEBE_NA_AURA_NAME}.`);
  if (row.status !== 'approved') {
    throw svcError(409, 'RECEBE_CONTA_NAO_APROVADA',
      `A conta do ${RECEBE_NA_AURA_NAME} desta loja ainda está em análise pela Asaas. ` +
      'Assim que ela for aprovada, as cobranças ficam liberadas. Enquanto isso, dá para seguir recebendo como antes.');
  }
  if (!row.api_key_enc) {
    throw svcError(409, 'RECEBE_EM_CONFERENCIA', `A conta do ${RECEBE_NA_AURA_NAME} está em conferência pela equipe da Aura.`);
  }
  try {
    return { apiKey: decrypt(row.api_key_enc) };
  } catch (e) {
    console.error('[recebeCobranca] não deu para decifrar a chave da subconta:', e && e.message);
    throw svcError(500, 'INTERNAL_ERROR', 'Erro interno');
  }
}

// Chamada à Asaas na subconta, com erro traduzido. Nunca loga chave/corpo.
async function asaas(method, path, body, apiKey, ctx) {
  try {
    return await asaasClient.asaasRequest(method, path, body, apiKey, { timeoutMs: ASAAS_TIMEOUT_MS });
  } catch (e) {
    const st = e && e.asaasStatus;
    console.error(`[recebeCobranca] ${ctx}: Asaas ${st || 'sem resposta'}:`, e && e.message);
    if (st >= 400 && st < 500) {
      throw svcError(422, 'RECEBE_COBRANCA_RECUSADA', `A Asaas recusou a cobrança: ${e.message}`);
    }
    throw svcError(502, 'RECEBE_ASAAS_INDISPONIVEL', 'Não deu para falar com a Asaas agora. Tente de novo em alguns minutos.');
  }
}

async function findExistingPayment(apiKey, externalReference) {
  const q = `/payments?externalReference=${encodeURIComponent(externalReference)}&limit=10`;
  const resp = await asaas('GET', q, null, apiKey, 'busca por externalReference');
  const list = (resp && Array.isArray(resp.data)) ? resp.data : [];
  return list.filter((p) => p && !p.deleted && p.externalReference === externalReference);
}

async function resolveCustomer(apiKey, customer) {
  const q = `/customers?cpfCnpj=${encodeURIComponent(customer.cpfCnpj)}&limit=10`;
  const resp = await asaas('GET', q, null, apiKey, 'busca de cliente');
  const list = (resp && Array.isArray(resp.data)) ? resp.data : [];
  const ok = list.find((c) => c && !c.deleted && c.notificationDisabled === true);
  if (ok && ok.id) return ok.id;

  const payload = companyBaas.buildSubaccountCustomerPayload({
    name: customer.name,
    cpfCnpj: customer.cpfCnpj,
    ...(customer.email ? { email: customer.email } : {}),
    ...(customer.mobilePhone ? { mobilePhone: customer.mobilePhone } : {}),
  });
  const created = await asaas('POST', '/customers', payload, apiKey, 'criação de cliente');
  if (!created || !created.id) {
    throw svcError(502, 'RECEBE_ASAAS_INDISPONIVEL', 'A Asaas não devolveu o cliente da cobrança.');
  }
  return created.id;
}

function buildPaymentPayload(x, customerId, walletId, auraFee, externalReference) {
  return {
    customer: customerId,
    billingType: x.billingType,
    value: x.value,
    dueDate: x.dueDate,
    description: x.description,
    externalReference,
    split: [{
      walletId,
      fixedValue: auraFee,
      description: `Taxa da plataforma ${RECEBE_NA_AURA_NAME}`,
      externalReference,
    }],
  };
}

function shapePayment(p, x, auraFee, externalReference, pix, reused) {
  return {
    reused: !!reused,
    product_name: RECEBE_NA_AURA_NAME,
    payment_id: p.id,
    status: p.status || null,
    billing_type: x.billingType,
    value: x.value,
    aura_fee: auraFee,
    due_date: p.dueDate || x.dueDate,
    external_reference: externalReference,
    invoice_url: p.invoiceUrl || null,
    pix,
  };
}

async function fetchPix(apiKey, paymentId) {
  try {
    const qr = await asaasClient.asaasRequest(
      'GET', `/payments/${encodeURIComponent(paymentId)}/pixQrCode`, null, apiKey, { timeoutMs: ASAAS_TIMEOUT_MS }
    );
    if (!qr || !qr.payload) return null;
    return { payload: qr.payload, encoded_image: qr.encodedImage || null, expiration_date: qr.expirationDate || null };
  } catch (e) {
    // A cobrança existe; o QR se busca de novo depois. Não falha a criação.
    console.warn(`[recebeCobranca] QR do Pix indisponível agora (Asaas ${e && e.asaasStatus ? e.asaasStatus : 'sem resposta'})`);
    return null;
  }
}

// ── Cria a cobrança na subconta da empresa, com split para a Aura ──
// opts.allowTestOrigin: só a rota de staff passa true.
async function createCharge(companyId, input, opts = {}) {
  if (!companyBaas.isEnabled()) {
    throw svcError(404, 'RECEBE_INDISPONIVEL', `O ${RECEBE_NA_AURA_NAME} ainda não está disponível.`);
  }
  if (!UUID_RE.test(str(companyId))) throw svcError(422, 'VALIDATION_ERROR', 'company_id deve ser um UUID');
  const x = validateInput(input, opts);

  const walletId = str(process.env[WALLET_ENV]);
  if (!walletId) {
    console.error(`[recebeCobranca] ${WALLET_ENV} ausente — nenhuma cobrança é criada sem o split da Aura`);
    throw svcError(503, 'RECEBE_SPLIT_NAO_CONFIGURADO', `O ${RECEBE_NA_AURA_NAME} ainda não está disponível.`);
  }

  const auraFee = auraFeeFor(x.billingType, x.value);
  if (auraFee <= 0) {
    const min = minValueFor(x.billingType);
    throw svcError(422, 'RECEBE_VALOR_ABAIXO_DO_MINIMO',
      `No cartão, o ${RECEBE_NA_AURA_NAME} aceita cobranças a partir de ${brl(min)}. Para valores menores, o Pix funciona.`);
  }

  const { apiKey } = await loadApprovedAccount(companyId);
  const externalReference = buildExternalReference(x.origin);

  // Contra cobrança em dobro para a mesma origem.
  const existing = await findExistingPayment(apiKey, externalReference);
  if (existing.some((p) => PAID_STATUSES.includes(p.status))) {
    throw svcError(409, 'RECEBE_ORIGEM_JA_PAGA', 'Esta cobrança já foi paga. Nada novo foi criado.');
  }
  const same = existing.find((p) => p.status === 'PENDING'
    && p.billingType === x.billingType && toCents(p.value) === toCents(x.value));
  if (same) {
    const pix = x.billingType === 'PIX' ? await fetchPix(apiKey, same.id) : null;
    return shapePayment(same, x, auraFee, externalReference, pix, true);
  }

  const customerId = await resolveCustomer(apiKey, x.customer);
  const payment = await asaas('POST', '/payments',
    buildPaymentPayload(x, customerId, walletId, auraFee, externalReference), apiKey, 'criação da cobrança');
  if (!payment || !payment.id) {
    throw svcError(502, 'RECEBE_ASAAS_INDISPONIVEL', 'A Asaas não devolveu a cobrança. Confira antes de tentar de novo.');
  }
  const pix = x.billingType === 'PIX' ? await fetchPix(apiKey, payment.id) : null;
  return shapePayment(payment, x, auraFee, externalReference, pix, false);
}

module.exports = {
  RECEBE_NA_AURA_NAME,
  WALLET_ENV,
  AURA_SPLIT_RULES,
  BILLING_TYPES,
  ORIGIN_TYPES,
  TEST_ORIGIN_TYPE,
  createCharge,
  auraFeeFor,
  minValueFor,
  buildExternalReference,
  // exportados p/ teste
  validateInput,
  buildPaymentPayload,
};
