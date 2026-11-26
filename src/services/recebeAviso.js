// ============================================================
// AURA. — Recebe na Aura: o AVISO (webhook) cadastrado em cada subconta
// 25/11/2026 (decisão do Caio).
//
// Subconta sem aviso não confirma pagamento: a Asaas só avisa a Aura de que
// o Pix caiu (ou de que a conta foi aprovada) se a subconta tiver um webhook
// apontando para POST /api/v1/webhooks/asaas-recebe, com o authToken que a
// rota confere (recebeWebhookService.checkToken). Por isso o aviso vai JUNTO
// na criação da subconta (POST /v3/accounts, campo `webhooks`) e, para
// subconta antiga, pela rota de staff (POST /v3/webhooks com a chave DA
// subconta).
//
// Tudo o que o aviso precisa mora AQUI (e não no recebeWebhookService) para
// o companyBaasService poder usar sem import circular:
//   - o segredo, por ambiente:
//       RECEBE_ASAAS_WEBHOOK_TOKEN          produção
//       RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN  quando ASAAS_ENV=sandbox
//     mínimo de 32 caracteres (regra da Asaas para o authToken);
//   - a URL: env RECEBE_ASAAS_WEBHOOK_URL; sem ela, o domínio próprio da API
//     (config/enderecoDaApi, PADRAO) + /api/v1/webhooks/asaas-recebe;
//   - o e-mail que a Asaas avisa se a fila do webhook parar: env
//     RECEBE_ASAAS_WEBHOOK_EMAIL; sem ela, contato@getaura.com.br. É da Aura
//     de propósito: fila parada é problema da Aura, não da lojista;
//   - os eventos: os de pagamento e os 18 de situação da conta (docs.asaas.com,
//     "Eventos para cobranças" e "Eventos para verificar situação da conta").
//
// sendType NON_SEQUENTIALLY: na fila sequencial, um evento que falha trava
// todos os seguintes (inclusive a confirmação de outros pagamentos) até a
// Asaas interromper a fila. O tratamento já é feito para chegar fora de ordem:
// situação da conta compara a data do evento (retrato mais velho não
// sobrescreve) e pagamento é idempotente pelo id do evento.
//
// TOKEN POR SUBCONTA (revisão de 25/11): cada subconta recebe o seu
// authToken, HMAC-SHA256(segredo mestre do ambiente, company_id) em hex
// (64 caracteres). A rota do aviso lê a conta do corpo (account.id), acha a
// empresa e recalcula: um token vazado de uma subconta não forja aviso de
// outra. Deriva do company_id (e não do id da conta na Asaas) porque o aviso
// vai DENTRO do POST /v3/accounts, antes de a Asaas devolver o id da conta;
// assim a subconta continua nascendo com o aviso, numa chamada só. O token
// mestre puro NÃO vale como aviso (hoje há 0 subcontas, nada a migrar).
//
// IMPRESSÃO DO TOKEN NO NOME: o nome do webhook leva os 12 primeiros hex do
// SHA-256 do token (`[a1b2c3d4e5f6]`). A Asaas não devolve o token na
// listagem; pela impressão a rota de staff sabe se o token cadastrado é o
// atual (rotação do segredo) sem guardar nada no banco. A impressão não
// permite recuperar o token.
//
// O token nunca é logado nem devolvido.
// ============================================================
'use strict';

const nodeCrypto = require('crypto');
const { str } = require('./baasShared');
const { PADRAO: API_PADRAO } = require('../config/enderecoDaApi');

const TOKEN_ENV = 'RECEBE_ASAAS_WEBHOOK_TOKEN';
const SANDBOX_TOKEN_ENV = 'RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN';
const URL_ENV = 'RECEBE_ASAAS_WEBHOOK_URL';
const EMAIL_ENV = 'RECEBE_ASAAS_WEBHOOK_EMAIL';
// Mínimo da Asaas para o authToken do webhook (32 a 255 caracteres).
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 255;

const WEBHOOK_PATH = '/api/v1/webhooks/asaas-recebe';
const DEFAULT_WEBHOOK_URL = `${API_PADRAO}${WEBHOOK_PATH}`;
const DEFAULT_WEBHOOK_EMAIL = 'contato@getaura.com.br';
const WEBHOOK_NAME = 'Aura - Recebe na Aura';
const WEBHOOK_API_VERSION = 3;
const WEBHOOK_SEND_TYPE = 'NON_SEQUENTIALLY';

// Os 18 eventos de situação da conta (docs.asaas.com, "Eventos para
// verificar situação da conta").
const ACCOUNT_STATUS_EVENTS = Object.freeze([
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_APPROVED',
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_PENDING',
  'ACCOUNT_STATUS_BANK_ACCOUNT_INFO_REJECTED',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_APPROVED',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_PENDING',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_REJECTED',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_EXPIRING_SOON',
  'ACCOUNT_STATUS_COMMERCIAL_INFO_EXPIRED',
  'ACCOUNT_STATUS_DOCUMENT_APPROVED',
  'ACCOUNT_STATUS_DOCUMENT_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_DOCUMENT_PENDING',
  'ACCOUNT_STATUS_DOCUMENT_REJECTED',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_PENDING',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED',
]);

// Pagamentos que o pedido (RA-09) e a venda do Caixa (RA-10) usam. Todos
// conferidos na lista "Eventos para cobranças" da Asaas.
const PAYMENT_EVENTS_OF_INTEREST = Object.freeze([
  'PAYMENT_CREATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE',
  'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'PAYMENT_SPLIT_DONE', 'PAYMENT_SPLIT_CANCELLED',
  'PAYMENT_SPLIT_DIVERGENCE_BLOCK', 'PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED',
]);

const WEBHOOK_EVENTS = Object.freeze([...PAYMENT_EVENTS_OF_INTEREST, ...ACCOUNT_STATUS_EVENTS]);

function isSandbox() {
  return str(process.env.ASAAS_ENV).toLowerCase() === 'sandbox';
}

// Nome da variável do segredo que vale no ambiente atual (lida a cada chamada).
function secretEnvName() {
  return isSandbox() ? SANDBOX_TOKEN_ENV : TOKEN_ENV;
}

// { ok, token?, reason? }. reason só vai para log/erro, nunca o token.
function resolveSecret() {
  const token = str(process.env[secretEnvName()]);
  if (!token) return { ok: false, reason: 'sem_segredo_configurado' };
  if (token.length < MIN_TOKEN_LENGTH) return { ok: false, reason: 'segredo_curto_demais' };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'segredo_longo_demais' };
  return { ok: true, token };
}

function webhookUrl() {
  const v = str(process.env[URL_ENV]);
  return v || DEFAULT_WEBHOOK_URL;
}

function webhookEmail() {
  const v = str(process.env[EMAIL_ENV]);
  return v || DEFAULT_WEBHOOK_EMAIL;
}

// authToken da subconta da empresa: HMAC-SHA256(mestre, company_id), hex.
function tokenDaSubconta(masterToken, companyId) {
  return nodeCrypto.createHmac('sha256', str(masterToken)).update(str(companyId).toLowerCase()).digest('hex');
}

// Impressão do token (vai no nome do webhook). Não revela o token.
function impressaoDoToken(token) {
  return nodeCrypto.createHash('sha256').update(str(token)).digest('hex').slice(0, 12);
}

// O nome do webhook cadastrado traz a impressão deste token?
function nomeTemImpressao(name, token) {
  return str(name).includes(`[${impressaoDoToken(token)}]`);
}

// O objeto do webhook, igual para POST /v3/accounts (dentro de `webhooks`),
// POST /v3/webhooks e PUT /v3/webhooks/:id. `token` = o da SUBCONTA.
function buildWebhookConfig(token) {
  return {
    name: `${WEBHOOK_NAME} [${impressaoDoToken(token)}]`,
    url: webhookUrl(),
    email: webhookEmail(),
    enabled: true,
    interrupted: false,
    apiVersion: WEBHOOK_API_VERSION,
    authToken: token,
    sendType: WEBHOOK_SEND_TYPE,
    events: [...WEBHOOK_EVENTS],
  };
}

module.exports = {
  TOKEN_ENV,
  SANDBOX_TOKEN_ENV,
  URL_ENV,
  EMAIL_ENV,
  MIN_TOKEN_LENGTH,
  WEBHOOK_PATH,
  DEFAULT_WEBHOOK_URL,
  DEFAULT_WEBHOOK_EMAIL,
  WEBHOOK_NAME,
  WEBHOOK_SEND_TYPE,
  ACCOUNT_STATUS_EVENTS,
  PAYMENT_EVENTS_OF_INTEREST,
  WEBHOOK_EVENTS,
  isSandbox,
  secretEnvName,
  resolveSecret,
  webhookUrl,
  webhookEmail,
  tokenDaSubconta,
  impressaoDoToken,
  nomeTemImpressao,
  buildWebhookConfig,
};
