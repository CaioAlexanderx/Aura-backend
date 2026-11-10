// ============================================================
// AURA. — Peças comuns do BaaS Asaas (subconta por titular)
//
// 10/11/2026 (RA-05): extraído de karateDojoBaasService.js SEM mudar
// comportamento, para o varejo ("Recebe na Aura", companyBaasService.js)
// usar o mesmo código do dojô. O que mora aqui é puro (sem banco, sem
// Asaas): validação do KYC, payload de POST /accounts, máscara da wallet,
// hash do token de webhook e a máquina de status do onboarding.
//
// Cada serviço continua com a sua tabela, a sua flag e as suas mensagens.
// ============================================================
'use strict';

const nodeCrypto = require('crypto');

// Ordem de progressão do onboarding (monotônica). rejected é terminal.
const STATUS_RANK = { created: 0, docs_pending: 1, under_review: 2, approved: 3, rejected: 4 };

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Flag de env ligada? Aceita 1/true/on/yes (qualquer caixa). Lida a cada
// chamada (não cacheada) para o teste e a homologação poderem alternar.
function flagOn(envName) {
  const v = String(process.env[envName] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function str(v) {
  return v != null ? String(v).trim() : '';
}

function maskWallet(w) {
  const k = str(w);
  if (!k) return null;
  if (k.length <= 6) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

function hashWebhookToken(token) {
  return nodeCrypto.createHash('sha256').update(str(token)).digest('hex');
}

// ── Validação de KYC (dados do titular da subconta) ──
function validateKyc(body) {
  const b = body || {};
  const errors = [];
  const personType = str(b.person_type).toUpperCase();
  if (!['FISICA', 'JURIDICA'].includes(personType)) errors.push('person_type deve ser FISICA ou JURIDICA');

  const name = str(b.name);
  if (!name) errors.push('name é obrigatório');

  const digits = str(b.cpf_cnpj).replace(/\D/g, '');
  if (personType === 'FISICA' && digits.length !== 11) errors.push('cpf_cnpj deve ter 11 dígitos (CPF) para pessoa física');
  if (personType === 'JURIDICA' && digits.length !== 14) errors.push('cpf_cnpj deve ter 14 dígitos (CNPJ) para pessoa jurídica');
  if (!['FISICA', 'JURIDICA'].includes(personType) && !digits) errors.push('cpf_cnpj é obrigatório');

  const email = str(b.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('email inválido');

  const mobile = str(b.mobile_phone).replace(/\D/g, '');
  if (mobile.length < 10) errors.push('mobile_phone inválido (DDD + número)');

  const income = Number(b.income_value);
  if (!Number.isFinite(income) || income <= 0) errors.push('income_value deve ser maior que zero');

  const address = str(b.address);
  if (!address) errors.push('address é obrigatório');
  const addressNumber = str(b.address_number);
  if (!addressNumber) errors.push('address_number é obrigatório');
  const province = str(b.province);
  if (!province) errors.push('province (bairro) é obrigatório');
  const postal = str(b.postal_code).replace(/\D/g, '');
  if (postal.length !== 8) errors.push('postal_code deve ter 8 dígitos');

  const birthDate = str(b.birth_date);
  if (personType === 'FISICA' && (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate))) {
    errors.push('birth_date (YYYY-MM-DD) é obrigatório para pessoa física');
  }
  const companyType = str(b.company_type);
  if (personType === 'JURIDICA' && !companyType) {
    errors.push('company_type é obrigatório para pessoa jurídica');
  }

  if (errors.length) throw svcError(422, 'VALIDATION_ERROR', errors[0]);

  return {
    person_type: personType,
    name,
    cpf_cnpj: digits,
    company_type: companyType || null,
    birth_date: birthDate || null,
    email,
    mobile_phone: mobile,
    income_value: income,
    address,
    address_number: addressNumber,
    complement: str(b.complement) || null,
    province,
    postal_code: postal,
  };
}

// Corpo de POST /accounts (criação da subconta pela conta-mãe). `webhooks`
// é opcional: o dojô registra o seu na criação; quem não passar, não manda.
function buildAccountPayload(kyc, webhooks) {
  const payload = {
    name: kyc.name,
    email: kyc.email,
    cpfCnpj: kyc.cpf_cnpj,
    mobilePhone: kyc.mobile_phone,
    incomeValue: kyc.income_value,
    address: kyc.address,
    addressNumber: kyc.address_number,
    province: kyc.province,
    postalCode: kyc.postal_code,
  };
  if (webhooks) payload.webhooks = webhooks;
  if (kyc.complement) payload.complement = kyc.complement;
  if (kyc.birth_date) payload.birthDate = kyc.birth_date;
  if (kyc.company_type) payload.companyType = kyc.company_type;
  return payload;
}

// ── Status da subconta vindo da Asaas (webhook) ──
function isAccountStatusEvent(event, body) {
  const e = String(event || '').toUpperCase();
  if (e.includes('ACCOUNT_STATUS')) return true;
  if (body && (body.accountStatus || (body.account && body.account.status))) return true;
  return false;
}

function mapAccountStatus(event, body) {
  const acc = body && body.accountStatus;
  const hay = [
    event,
    body && body.status,
    typeof acc === 'string' ? acc : (acc && (acc.status || acc.general || acc.generalApproval)),
    body && body.account && body.account.status,
  ].map((x) => String(x || '').toUpperCase()).join(' ');
  if (/APPROVED|APROVAD/.test(hay)) return 'approved';
  if (/REJECT|RECUSAD|REPROVAD/.test(hay)) return 'rejected';
  if (/DOCUMENT|DOCUMENTAC/.test(hay)) return 'docs_pending';
  if (/AWAIT|PENDING|REVIEW|ANALISE|ANÁLISE/.test(hay)) return 'under_review';
  return null;
}

// Progressão monotônica + fora de ordem: nunca rebaixa 'approved' (só
// 'rejected' pode sobrescrever); 'rejected' é terminal; só avança no rank.
function shouldApplyStatus(cur, next) {
  if (!next || cur === next) return false;
  if (cur === 'rejected') return false;             // terminal
  if (next === 'rejected') return true;             // reprovação regulatória sempre aplica
  if (cur === 'approved') return false;             // nunca rebaixa aprovado (contrato)
  return (STATUS_RANK[next] || 0) > (STATUS_RANK[cur] || 0);
}

module.exports = {
  STATUS_RANK,
  svcError,
  flagOn,
  str,
  maskWallet,
  hashWebhookToken,
  validateKyc,
  buildAccountPayload,
  isAccountStatusEvent,
  mapAccountStatus,
  shouldApplyStatus,
};
