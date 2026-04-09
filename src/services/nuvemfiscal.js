// ============================================================
// AURA. — Sprint 4 v2: Nuvem Fiscal API Service
// Replaces Focus NFe — FREE tier with unlimited CNPJs
// Auth: OAuth 2.0 client_credentials
// Docs: https://dev.nuvemfiscal.com.br/docs/
// ============================================================

const NUVEM_URL = process.env.NUVEM_FISCAL_URL || 'https://api.sandbox.nuvemfiscal.com.br';
const AUTH_URL = 'https://auth.nuvemfiscal.com.br/oauth/token';
const CLIENT_ID = process.env.NUVEM_FISCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.NUVEM_FISCAL_CLIENT_SECRET;

// Token cache
let _token = null;
let _tokenExpires = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpires - 60000) return _token;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('NUVEM_FISCAL_CLIENT_ID e NUVEM_FISCAL_CLIENT_SECRET nao configurados');

  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}&scope=empresa%20cnpj%20cep%20nfe%20nfce%20nfse`,
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error(data.error_description || 'Erro ao obter token Nuvem Fiscal');
  _token = data.access_token;
  _tokenExpires = Date.now() + (data.expires_in || 2592000) * 1000;
  return _token;
}

async function nuvemRequest(method, path, body) {
  const token = await getToken();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const resp = await fetch(`${NUVEM_URL}${path}`, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data.error?.message || data.mensagem || data.message || `Nuvem Fiscal error ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Empresas ───────────────────────────────────────────
async function registerCompany(company) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ obrigatorio para emitir NF-e');

  // Check if already registered
  try {
    const existing = await nuvemRequest('GET', `/empresas/${cnpj}`);
    if (existing?.cpf_cnpj) return existing;
  } catch {}

  return nuvemRequest('POST', '/empresas', {
    cpf_cnpj: cnpj,
    nome_razao_social: company.legal_name || company.trade_name || company.name,
    nome_fantasia: company.trade_name || company.name,
    inscricao_estadual: company.inscricao_estadual || '',
    inscricao_municipal: company.inscricao_municipal || '',
    regime_tributario: company.tax_regime === 'mei' ? 1 : 1, // 1=Simples Nacional
    email: company.email || '',
    fone: (company.phone || '').replace(/\D/g, ''),
    endereco: {
      logradouro: company.address_street || '',
      numero: company.address_number || 'S/N',
      bairro: company.address_neighborhood || '',
      codigo_municipio: company.ibge_code || '',
      cidade: company.address_city || '',
      uf: company.address_state || 'SP',
      cep: (company.address_zip || '').replace(/\D/g, ''),
    },
  });
}

// Upload certificate A1 for a company
async function uploadCertificate(cnpj, certificateBase64, password) {
  const cleanCnpj = cnpj.replace(/\D/g, '');
  return nuvemRequest('PUT', `/empresas/${cleanCnpj}/certificado`, {
    certificado: certificateBase64,
    password: password,
  });
}

// ── NFS-e (Nota Fiscal de Servico) ──────────────────
async function emitNfse(company, nfseData) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  return nuvemRequest('POST', '/nfse', {
    ambiente: NUVEM_URL.includes('sandbox') ? 'homologacao' : 'producao',
    prestador: {
      cpf_cnpj: cnpj,
    },
    tomador: {
      cpf_cnpj: (nfseData.recipient_cnpj || nfseData.recipient_cpf || '').replace(/\D/g, '') || undefined,
      nome_razao_social: nfseData.recipient_name || 'Consumidor',
      email: nfseData.recipient_email || undefined,
    },
    servico: {
      discriminacao: nfseData.description || 'Servico prestado',
      codigo_tributacao_nacional: nfseData.service_code || '',
      valor_servicos: nfseData.value,
      aliquota_iss: nfseData.iss_rate || 2,
      iss_retido: nfseData.iss_retained || false,
    },
  });
}

async function queryNfse(nfseId) {
  return nuvemRequest('GET', `/nfse/${nfseId}`);
}

async function cancelNfse(nfseId, justificativa) {
  return nuvemRequest('POST', `/nfse/${nfseId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

// ── NFC-e (Nota Fiscal do Consumidor) ───────────────
async function emitNfce(company, nfceData) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  return nuvemRequest('POST', '/nfce', {
    ambiente: NUVEM_URL.includes('sandbox') ? 2 : 1,
    natureza_operacao: 'Venda ao consumidor',
    tipo_documento: 1,
    finalidade_emissao: 1,
    cnpj_emitente: cnpj,
    modalidade_frete: 9,
    items: (nfceData.items || []).map((item, i) => ({
      numero_item: i + 1,
      codigo_produto: item.code || String(i + 1),
      descricao: item.description || item.name,
      cfop: item.cfop || '5102',
      unidade_comercial: item.unit || 'UN',
      quantidade_comercial: item.quantity || 1,
      valor_unitario_comercial: item.price,
      valor_bruto: (item.quantity || 1) * item.price,
      icms: { situacao_tributaria: '102' },
    })),
    pagamento: {
      formas_pagamento: [{
        meio_pagamento: nfceData.payment_method || '01',
        valor_pagamento: nfceData.total_value,
      }],
    },
  });
}

async function queryNfce(nfceId) {
  return nuvemRequest('GET', `/nfce/${nfceId}`);
}

async function cancelNfce(nfceId, justificativa) {
  return nuvemRequest('POST', `/nfce/${nfceId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

module.exports = {
  getToken, nuvemRequest,
  registerCompany, uploadCertificate,
  emitNfse, queryNfse, cancelNfse,
  emitNfce, queryNfce, cancelNfce,
};
