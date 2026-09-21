// ============================================================
// AURA. — Cliente (customer) do Asaas com CPF/CNPJ garantido
//
// 21/09/2026 — O Asaas NAO gera cobranca para cliente sem CPF/CNPJ. O
// ensureAsaasCustomer antigo (em routes/billing.js) mandava so company.cnpj —
// e 121 de 138 empresas nao tem CNPJ cadastrado (MEI/autonomo entra sem). O
// cliente nascia no Asaas sem documento, o /subscribe devolvia o erro do Asaas
// pedindo CPF/CNPJ e o checkout nao tinha campo para informar (no Pix, nenhum).
// Quase perdemos um cliente assim.
//
// Agora o documento vem, nesta ordem:
//   1. cpf_cnpj digitado no checkout (explicito — sobrescreve o do Asaas)
//   2. company.cnpj (se valido)
//   3. CPF do titular do cartao (so PREENCHE o que falta, nunca sobrescreve)
// Sem nenhum dos tres: 400 com stage='cpf_cnpj' — a tela abre o campo.
//
// Cliente que JA existe no Asaas sem documento (criado pelo fluxo antigo) e
// corrigido aqui: GET no cliente, e PUT com o documento se estiver vazio.
// ============================================================

const db = require('../config/database');
const { asaas } = require('./asaasClient');
const { validateCNPJ } = require('./cnpj');

const TAX_ID_REQUIRED_MSG = 'Informe o CPF ou CNPJ de quem vai pagar para gerar a cobrança.';
const TAX_ID_INVALID_MSG = 'CPF ou CNPJ inválido. Confira os números.';

function onlyDigits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function validateCPF(cpf) {
  const c = onlyDigits(cpf);
  if (c.length !== 11) return false;
  if (/^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += parseInt(c[i], 10) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return parseInt(c[9], 10) === calc(9) && parseInt(c[10], 10) === calc(10);
}

function isValidTaxId(v) {
  const d = onlyDigits(v);
  if (d.length === 11) return validateCPF(d);
  if (d.length === 14) return validateCNPJ(d);
  return false;
}

// Erro que a rota devolve como 400 + stage='cpf_cnpj' (a tela abre o campo).
function taxIdError(message) {
  const err = new Error(message);
  err.status = 400;
  err.stage = 'cpf_cnpj';
  return err;
}

// O Asaas recusou por falta/invalidez de documento? Rede de seguranca para o
// catch das rotas: qualquer caminho que escape da checagem acima ainda vira um
// erro que a tela sabe tratar, em vez de um 500 sem saida.
function isTaxIdAsaasError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('cpf') || msg.includes('cnpj');
}

// A empresa ja tem documento valido para cobrar sem perguntar nada?
function companyHasTaxId(company) {
  return isValidTaxId(company && company.cnpj);
}

async function ensureAsaasCustomer(company, user, opts) {
  const typed = onlyDigits(opts && opts.taxId);
  if (typed && !isValidTaxId(typed)) throw taxIdError(TAX_ID_INVALID_MSG);

  const fallback = [company.cnpj, opts && opts.fallbackTaxId].map(onlyDigits).find(isValidTaxId) || '';
  const doc = typed || fallback;

  if (!company.asaas_customer_id) {
    if (!doc) throw taxIdError(TAX_ID_REQUIRED_MSG);
    const customer = await asaas('POST', '/customers', {
      name: user.full_name || user.name,
      email: user.email,
      phone: user.phone || undefined,
      cpfCnpj: doc,
      company: company.legal_name || company.trade_name,
      externalReference: company.id,
    });
    await db.query('UPDATE companies SET asaas_customer_id=$1 WHERE id=$2', [customer.id, company.id]);
    return customer.id;
  }

  // Cliente ja existe: confere se ele tem documento la no Asaas. Se a consulta
  // falhar, segue — o Asaas recusa a cobranca se faltar e o catch da rota trata.
  let current = null;
  try { current = await asaas('GET', '/customers/' + company.asaas_customer_id); } catch (_) { current = null; }
  const onFile = onlyDigits(current && current.cpfCnpj);

  const needsUpdate = typed ? typed !== onFile : (!!current && !onFile);
  if (needsUpdate) {
    if (!doc) throw taxIdError(TAX_ID_REQUIRED_MSG);
    await asaas('PUT', '/customers/' + company.asaas_customer_id, { cpfCnpj: doc });
    console.log('[BILLING] CPF/CNPJ do cliente Asaas atualizado — company=' + company.id);
  }
  return company.asaas_customer_id;
}

module.exports = {
  ensureAsaasCustomer,
  companyHasTaxId,
  isValidTaxId,
  validateCPF,
  isTaxIdAsaasError,
  taxIdError,
  TAX_ID_REQUIRED_MSG,
  TAX_ID_INVALID_MSG,
};
