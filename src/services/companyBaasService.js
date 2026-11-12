// ============================================================
// AURA. — Recebe na Aura: subconta Asaas POR EMPRESA (RA-05, 10/11/2026)
//
// Primeiro passo da refatoração do BaaS do dojô (karateDojoBaasService) para
// o varejo. Modelo A: a Asaas presta o serviço, a Aura integra. Cada empresa
// (cada CNPJ do grupo, nunca uma por grupo) tem a sua subconta, criada pela
// conta-mãe da Aura. O dinheiro vai da Asaas direto para a subconta da
// lojista e nunca passa pela conta da Aura; o split para a carteira da Aura
// entra nas cobranças (RA-07, fora deste PR).
//
// FLAG RECEBE_NA_AURA_ENABLED (env, desligada por padrão). Desligada:
// nenhuma função daqui chama a Asaas nem grava nada (as rotas respondem 404
// antes de chegar aqui; o serviço confere de novo, por garantia).
//
// Reaproveita do dojô: validação de KYC, payload de POST /accounts e máscara
// da wallet (baasShared.js), cifra da apiKey (dojoBaasCrypto, AES-256-GCM,
// env DOJO_BAAS_ENC_KEY — o mesmo cofre que o WhatsApp já usa) e o cliente
// asaasRequest. A apiKey da subconta nunca é logada nem devolvida.
//
// Idempotência: a linha da empresa é RESERVADA (status 'creating', INSERT ...
// ON CONFLICT DO NOTHING) antes de chamar a Asaas. Duas chamadas, mesmo ao
// mesmo tempo, não criam duas subcontas: só quem reservou chama a Asaas.
// Se a Asaas recusar (4xx), a reserva é desfeita e dá para tentar de novo.
// Se a resposta for ambígua (5xx, rede), a reserva fica em 'creating': a
// subconta pode ter sido criada do lado da Asaas e uma nova tentativa
// gastaria mais uma das subcontas do período de avaliação. Conferência
// manual nesse caso (fora deste PR).
//
// Notificações da Asaas para o cliente final: DESLIGADAS. Quem avisa é a
// Aura. POST /accounts não tem chave de notificação; na Asaas o desligamento
// é por cliente (notificationDisabled, o mesmo que o pixAutomatico usa). A
// subconta nasce com customer_notifications_disabled = true e todo cliente
// criado nela deve sair de buildSubaccountCustomerPayload (RA-07).
//
// SITUAÇÃO EM 4 BLOCOS (RA-06, 12/11/2026, migration 447): a Asaas devolve a
// situação cadastral da subconta em quatro blocos (GET /v3/myAccount/status/
// com a chave DA SUBCONTA, e o mesmo objeto `accountStatus` nos eventos
// ACCOUNT_STATUS_*): commercialInfo, documentation, bankAccountInfo e
// general, cada um PENDING | AWAITING_APPROVAL | APPROVED | REJECTED. O
// retrato fica em account_status (+ account_status_at). Retrato mais velho
// nunca sobrescreve um mais novo, e o status resumido só avança
// (shouldApplyStatus, o mesmo do dojô). Sem a coluna (447 pendente) a leitura
// volta sem os blocos e a gravação responde 503 SCHEMA_PENDING.
// ============================================================
'use strict';

const db = require('../config/database');
const asaasClient = require('./asaasClient');
const { encrypt, decrypt } = require('./dojoBaasCrypto');
const {
  svcError, flagOn, str, maskWallet, validateKyc, buildAccountPayload, shouldApplyStatus,
} = require('./baasShared');

// Nome comercial em UM lugar só: a Asaas pode não aceitar este nome e ele
// teria de mudar sem caçar texto pelo código.
const RECEBE_NA_AURA_NAME = 'Recebe na Aura';

const FLAG_ENV = 'RECEBE_NA_AURA_ENABLED';

// Tipo de titular da subconta. PJ por padrão; PF e MEI pelo parâmetro.
const HOLDER_TYPES = ['PJ', 'PF', 'MEI'];
const DEFAULT_HOLDER_TYPE = 'PJ';
// companyType aceito pela Asaas para PJ que não é MEI.
const PJ_COMPANY_TYPES = ['LIMITED', 'INDIVIDUAL', 'ASSOCIATION'];

// A Aura avisa o cliente final; a Asaas não.
const CUSTOMER_NOTIFICATIONS_DISABLED = true;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RA-06: os quatro blocos, na ordem da tela. `field` é o nome da Asaas.
const STATUS_BLOCKS = [
  { key: 'dados_comerciais', field: 'commercialInfo' },
  { key: 'documentos', field: 'documentation' },
  { key: 'dados_bancarios', field: 'bankAccountInfo' },
  { key: 'geral', field: 'general' },
];
const BLOCK_STATUSES = ['PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED'];

function isEnabled() {
  return flagOn(FLAG_ENV);
}

function indisponivel() {
  return svcError(404, 'RECEBE_INDISPONIVEL', `O ${RECEBE_NA_AURA_NAME} ainda não está disponível.`);
}

function schemaPendente() {
  return svcError(503, 'SCHEMA_PENDING', `O ${RECEBE_NA_AURA_NAME} ainda não está disponível (migration 436 pendente).`);
}

function normalizeHolderType(v) {
  const t = str(v).toUpperCase();
  if (!t) return DEFAULT_HOLDER_TYPE;
  if (!HOLDER_TYPES.includes(t)) {
    throw svcError(422, 'VALIDATION_ERROR', `holder_type deve ser ${HOLDER_TYPES.join(', ')}`);
  }
  return t;
}

// Dados do titular, conforme o tipo. Reusa a validação do dojô
// (FISICA/JURIDICA) e acrescenta a regra do MEI.
function validateHolder(body, holderType) {
  const b = { ...(body || {}) };
  if (holderType === 'PF') {
    b.person_type = 'FISICA';
    delete b.company_type;
  } else if (holderType === 'MEI') {
    b.person_type = 'JURIDICA';
    b.company_type = 'MEI';
  } else {
    b.person_type = 'JURIDICA';
    const ct = str(b.company_type).toUpperCase();
    if (ct === 'MEI') {
      throw svcError(422, 'VALIDATION_ERROR', "company_type MEI: use holder_type 'MEI'");
    }
    if (ct && !PJ_COMPANY_TYPES.includes(ct)) {
      throw svcError(422, 'VALIDATION_ERROR', `company_type deve ser ${PJ_COMPANY_TYPES.join(', ')}`);
    }
    b.company_type = ct;
  }
  const kyc = validateKyc(b); // 422 VALIDATION_ERROR
  if (holderType !== 'PF') kyc.birth_date = null; // a Asaas só pede data de nascimento de PF
  return kyc;
}

// Corpo de POST /customers NA SUBCONTA (usado pelo RA-07). Sempre com as
// notificações da Asaas desligadas.
function buildSubaccountCustomerPayload(customer) {
  return { ...(customer || {}), notificationDisabled: CUSTOMER_NOTIFICATIONS_DISABLED };
}

// O que a API devolve. Nunca a apiKey; a wallet sai mascarada.
// Só os quatro campos conhecidos, só com valor do enum da Asaas. Nada
// além disso entra no banco nem sai na resposta. null = nada aproveitável.
function normalizeAccountStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let algum = false;
  for (const b of STATUS_BLOCKS) {
    const v = str(raw[b.field]).toUpperCase();
    out[b.field] = BLOCK_STATUSES.includes(v) ? v : null;
    if (out[b.field]) algum = true;
  }
  return algum ? out : null;
}

// Status resumido (coluna status) a partir dos blocos.
function summaryFromBlocks(st) {
  if (!st) return null;
  if (st.general === 'APPROVED') return 'approved';
  if (st.general === 'REJECTED') return 'rejected';
  if (st.documentation === 'PENDING' || st.documentation === 'REJECTED') return 'docs_pending';
  return 'under_review';
}

function shapeBlocks(row) {
  const st = row ? normalizeAccountStatus(row.account_status) : null;
  return STATUS_BLOCKS.map((b) => ({ key: b.key, status: st ? st[b.field] : null }));
}

function shape(row) {
  if (!row) {
    return {
      enabled: true,
      product_name: RECEBE_NA_AURA_NAME,
      status: 'none',
      holder_type: null,
      onboarding_url: null,
      account: null,
      blocks: null,
      blocks_updated_at: null,
      created_at: null,
    };
  }
  const temConta = !!(row.agency || row.account || row.wallet_id);
  return {
    enabled: true,
    product_name: RECEBE_NA_AURA_NAME,
    status: row.status,
    holder_type: row.holder_type || null,
    onboarding_url: row.onboarding_url || null,
    account: temConta ? {
      agency: row.agency || null,
      account: row.account || null,
      account_digit: row.account_digit || null,
      wallet_id_masked: maskWallet(row.wallet_id),
    } : null,
    blocks: shapeBlocks(row),
    blocks_updated_at: row.account_status_at || null,
    created_at: row.created_at || null,
  };
}

const SELECT_COLS = `status, holder_type, onboarding_url, agency, account, account_digit, wallet_id, created_at`;

// RA-06 (migration 447). Fora do RETURNING da criação de propósito: se a
// coluna faltar, a criação da subconta não pode falhar depois de a Asaas já
// ter criado a conta.
const STATUS_COLS = `account_status, account_status_at`;
let _temColunasDeStatus = null; // null = não sabe; false = 447 pendente

async function loadRow(companyId) {
  if (_temColunasDeStatus !== false) {
    try {
      const { rows } = await db.query(
        `SELECT ${SELECT_COLS}, ${STATUS_COLS} FROM company_baas_accounts WHERE company_id = $1 LIMIT 1`,
        [companyId]
      );
      _temColunasDeStatus = true;
      return rows[0] || null;
    } catch (e) {
      if (!(e && e.code === '42703')) throw e;
      _temColunasDeStatus = false;
    }
  }
  const { rows } = await db.query(
    `SELECT ${SELECT_COLS} FROM company_baas_accounts WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

// ── GET status ──
async function getStatus(companyId) {
  if (!isEnabled()) throw indisponivel();
  try {
    return shape(await loadRow(companyId));
  } catch (e) {
    if (e && e.code === '42P01') return shape(null); // migration 436 pendente → sem conta
    throw e;
  }
}

// ── POST criar subconta / onboarding ──
// opts.holderType vence body.holder_type; sem nenhum dos dois, PJ.
async function createAccount(companyId, body, opts = {}) {
  if (!isEnabled()) throw indisponivel();
  const b = body || {};
  const holderType = normalizeHolderType(opts.holderType != null ? opts.holderType : b.holder_type);
  const kyc = validateHolder(b, holderType);

  // 1. Reserva a linha da empresa. Quem não reservou não chama a Asaas.
  let reserved;
  try {
    const { rows } = await db.query(
      `INSERT INTO company_baas_accounts
         (company_id, status, holder_type, customer_notifications_disabled, created_by)
       VALUES ($1, 'creating', $2, $3, $4)
       ON CONFLICT (company_id) DO NOTHING
       RETURNING id`,
      [companyId, holderType, CUSTOMER_NOTIFICATIONS_DISABLED, UUID_RE.test(str(opts.userId)) ? str(opts.userId) : null]
    );
    reserved = rows[0] || null;
  } catch (e) {
    if (e && e.code === '42P01') throw schemaPendente();
    if (e && e.code === '23503') throw svcError(404, 'EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada.');
    throw e;
  }
  if (!reserved) {
    // Já existe (ou outra chamada acabou de reservar): devolve o que há.
    return { created: false, ...shape(await loadRow(companyId)) };
  }

  // 2. Cria a subconta com a credencial da conta-mãe (sem webhook: o
  // endpoint do varejo é do RA-07; o status se busca com a chave da subconta).
  let created;
  try {
    created = await asaasClient.asaasRequest('POST', '/accounts', buildAccountPayload(kyc));
  } catch (e) {
    // Nunca loga apiKey/payload: só a mensagem e o status HTTP.
    console.error(`[companyBaas] falha ao criar subconta Asaas (status ${e && e.asaasStatus ? e.asaasStatus : 'sem resposta'}):`, e && e.message);
    const recusada = e && e.asaasStatus >= 400 && e.asaasStatus < 500;
    if (recusada) {
      // A Asaas recusou: nada foi criado lá. Desfaz a reserva para a lojista
      // corrigir os dados e tentar de novo.
      await db.query(
        `DELETE FROM company_baas_accounts
          WHERE id = $1 AND status = 'creating' AND asaas_account_id IS NULL`,
        [reserved.id]
      );
      throw svcError(422, 'RECEBE_DADOS_RECUSADOS', `A Asaas recusou os dados do ${RECEBE_NA_AURA_NAME}: ${e.message}`);
    }
    throw svcError(502, 'RECEBE_EM_CONFERENCIA',
      `Não deu para confirmar a criação do ${RECEBE_NA_AURA_NAME} agora. A equipe da Aura vai conferir antes de uma nova tentativa.`);
  }

  if (!created || !created.apiKey) {
    console.warn('[companyBaas] Asaas criou a subconta sem devolver apiKey — subconta fica sem credencial');
  }
  const apiKeyEnc = created && created.apiKey ? encrypt(created.apiKey) : null;
  const acctNum = (created && created.accountNumber) || {};
  const onboardingUrl = (created && (created.onboardingUrl || created.onboarding_url)) || null;

  // 3. Grava o resultado na linha reservada (só a chave cifrada).
  const { rows } = await db.query(
    `UPDATE company_baas_accounts
        SET asaas_account_id = $2, api_key_enc = $3, wallet_id = $4, agency = $5,
            account = $6, account_digit = $7, status = 'created', onboarding_url = $8,
            kyc_snapshot = $9, updated_at = now()
      WHERE id = $1 AND company_id = $10
      RETURNING ${SELECT_COLS}`,
    [
      reserved.id,
      (created && created.id) || null,
      apiKeyEnc,
      (created && created.walletId) || null,
      acctNum.agency || null,
      acctNum.account || null,
      acctNum.accountDigit || null,
      onboardingUrl,
      JSON.stringify({ holder_type: holderType, ...kyc }),
      companyId,
    ]
  );
  return { created: true, ...shape(rows[0] || null) };
}

// ── Situação em 4 blocos (RA-06; o RA-07 grava pelos avisos) ──
// Grava o retrato dos quatro blocos. `at` = de quando é o retrato. Não
// sobrescreve retrato mais novo (WHERE no próprio UPDATE, contra corrida) e
// o status resumido só muda se avançar (shouldApplyStatus).
async function saveAccountStatus(companyId, raw, at) {
  const st = normalizeAccountStatus(raw);
  if (!st) return { changed: false, reason: 'sem_blocos' };
  const quando = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();

  let cur;
  try {
    const { rows } = await db.query(
      `SELECT status FROM company_baas_accounts WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    cur = rows[0] || null;
  } catch (e) {
    if (e && e.code === '42P01') throw schemaPendente();
    throw e;
  }
  if (!cur) return { changed: false, reason: 'sem_subconta' };

  const resumo = summaryFromBlocks(st);
  const novoStatus = shouldApplyStatus(cur.status, resumo) ? resumo : cur.status;
  try {
    const { rows } = await db.query(
      `UPDATE company_baas_accounts
          SET account_status = $2::jsonb, account_status_at = $3, status = $4, updated_at = now()
        WHERE company_id = $1
          AND (account_status_at IS NULL OR account_status_at <= $3)
        RETURNING status`,
      [companyId, JSON.stringify(st), quando.toISOString(), novoStatus]
    );
    if (!rows[0]) return { changed: false, reason: 'retrato_mais_velho' };
    return { changed: true, status: rows[0].status, blocks: st };
  } catch (e) {
    if (e && e.code === '42703') {
      _temColunasDeStatus = false;
      throw svcError(503, 'SCHEMA_PENDING', `O ${RECEBE_NA_AURA_NAME} ainda não está disponível (migration 447 pendente).`);
    }
    throw e;
  }
}

// Lê a situação na Asaas com a chave DA SUBCONTA e grava. Nunca loga a
// chave nem o corpo da resposta.
async function refreshStatus(companyId) {
  if (!isEnabled()) throw indisponivel();
  let row;
  try {
    const { rows } = await db.query(
      `SELECT status, api_key_enc FROM company_baas_accounts WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    row = rows[0] || null;
  } catch (e) {
    if (e && e.code === '42P01') throw schemaPendente();
    throw e;
  }
  if (!row) throw svcError(404, 'RECEBE_SEM_SUBCONTA', `Esta empresa ainda não ativou o ${RECEBE_NA_AURA_NAME}.`);
  if (!row.api_key_enc) {
    throw svcError(409, 'RECEBE_EM_CONFERENCIA', `A conta do ${RECEBE_NA_AURA_NAME} está em conferência pela equipe da Aura.`);
  }

  let apiKey;
  try {
    apiKey = decrypt(row.api_key_enc);
  } catch (e) {
    console.error('[companyBaas] não deu para decifrar a chave da subconta:', e && e.message);
    throw svcError(500, 'INTERNAL_ERROR', 'Erro interno');
  }

  let resp;
  try {
    resp = await asaasClient.asaasRequest('GET', '/myAccount/status/', null, apiKey);
  } catch (e) {
    console.error(`[companyBaas] falha ao ler a situação na Asaas (status ${e && e.asaasStatus ? e.asaasStatus : 'sem resposta'}):`, e && e.message);
    throw svcError(502, 'RECEBE_ASAAS_INDISPONIVEL',
      'Não deu para consultar a Asaas agora. Tente de novo em alguns minutos.');
  }
  await saveAccountStatus(companyId, resp, new Date());
  return shape(await loadRow(companyId));
}

module.exports = {
  RECEBE_NA_AURA_NAME,
  FLAG_ENV,
  HOLDER_TYPES,
  DEFAULT_HOLDER_TYPE,
  CUSTOMER_NOTIFICATIONS_DISABLED,
  isEnabled,
  getStatus,
  createAccount,
  refreshStatus,
  saveAccountStatus,
  buildSubaccountCustomerPayload,
  STATUS_BLOCKS,
  BLOCK_STATUSES,
  // exportados p/ teste
  validateHolder,
  normalizeHolderType,
  normalizeAccountStatus,
  summaryFromBlocks,
  _resetCacheDeColunas: () => { _temColunasDeStatus = null; },
};
