// ============================================================
// AURA. — Sprint 4 v2: Nuvem Fiscal API Service
// Replaces Focus NFe — FREE tier with unlimited CNPJs
// Auth: OAuth 2.0 client_credentials
// Docs: https://dev.nuvemfiscal.com.br/docs/
//
// Documentos suportados:
//   NFS-e  — Nota Fiscal de Serviço
//   NFC-e  — Nota Fiscal do Consumidor (modelo 65, PDV)
//   NF-e   — Nota Fiscal Eletrônica (modelo 55, B2B)
// ============================================================

const NUVEM_URL    = process.env.NUVEM_FISCAL_URL || 'https://api.sandbox.nuvemfiscal.com.br';
const AUTH_URL     = 'https://auth.nuvemfiscal.com.br/oauth/token';
const CLIENT_ID    = process.env.NUVEM_FISCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.NUVEM_FISCAL_CLIENT_SECRET;

// Token cache (renovado automaticamente 60s antes de expirar)
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

// ── Empresas ───────────────────────────────────────────────
async function registerCompany(company) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ obrigatorio para emitir NF-e');

  // Verifica se ja esta registrada
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
    regime_tributario: 1, // 1=Simples Nacional / MEI
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

// Upload de certificado A1 para uma empresa
async function uploadCertificate(cnpj, certificateBase64, password) {
  const cleanCnpj = cnpj.replace(/\D/g, '');
  return nuvemRequest('PUT', `/empresas/${cleanCnpj}/certificado`, {
    certificado: certificateBase64,
    password: password,
  });
}

// ── NFS-e (Nota Fiscal de Serviço) ─────────────────────────
async function emitNfse(company, nfseData) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  return nuvemRequest('POST', '/nfse', {
    ambiente: NUVEM_URL.includes('sandbox') ? 'homologacao' : 'producao',
    prestador: { cpf_cnpj: cnpj },
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

// ── NFC-e (Nota Fiscal do Consumidor Eletrônica — modelo 65) ─
// Uso: PDV, vendas a consumidor final, CPF opcional
async function emitNfce(company, nfceData) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  const body = {
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
  };

  // CPF do consumidor é opcional na NFC-e
  if (nfceData.recipient_cpf) {
    body.cpf_destinatario = nfceData.recipient_cpf.replace(/\D/g, '');
    body.nome_destinatario = nfceData.recipient_name || undefined;
  }

  return nuvemRequest('POST', '/nfce', body);
}

async function queryNfce(nfceId) {
  return nuvemRequest('GET', `/nfce/${nfceId}`);
}

async function cancelNfce(nfceId, justificativa) {
  return nuvemRequest('POST', `/nfce/${nfceId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

// ── NF-e (Nota Fiscal Eletrônica — modelo 55) ─────────────
// Uso: vendas a empresas (B2B) ou quando cliente exige CNPJ na nota
// Exige CPF ou CNPJ do destinatário
async function emitNfe(company, nfeData) {
  const cnpj    = (company.cnpj || '').replace(/\D/g, '');
  const destDoc = (nfeData.recipient_cnpj || nfeData.recipient_cpf || '').replace(/\D/g, '');

  const body = {
    ambiente: NUVEM_URL.includes('sandbox') ? 2 : 1,
    natureza_operacao: 'Venda',
    tipo_documento: 1,       // saída
    finalidade_emissao: 1,
    cnpj_emitente: cnpj,
    modalidade_frete: 9,
    destinatario: {
      cpf_cnpj: destDoc || undefined,
      nome: nfeData.recipient_name || 'Consumidor',
      email: nfeData.recipient_email || undefined,
      indicador_inscricao_estadual: 9, // não contribuinte
    },
    items: (nfeData.items || []).map((item, i) => ({
      numero_item: i + 1,
      codigo_produto: item.code || String(i + 1),
      descricao: item.description || item.name,
      cfop: item.cfop || '5102',
      unidade_comercial: item.unit || 'UN',
      quantidade_comercial: item.quantity || 1,
      valor_unitario_comercial: item.price,
      valor_bruto: (item.quantity || 1) * item.price,
      ncm: item.ncm || '00000000',
      icms: { situacao_tributaria: '102' },
    })),
    pagamento: {
      formas_pagamento: [{
        meio_pagamento: nfeData.payment_method || '01',
        valor_pagamento: nfeData.total_value,
      }],
    },
  };

  // Endereço do destinatário (opcional, mas recomendado para B2B)
  if (nfeData.recipient_zip) {
    body.destinatario.endereco = {
      logradouro: nfeData.recipient_address      || '',
      numero:     nfeData.recipient_number       || 'S/N',
      bairro:     nfeData.recipient_neighborhood || '',
      codigo_municipio: nfeData.recipient_ibge   || '',
      uf:         nfeData.recipient_state        || 'SP',
      cep:        (nfeData.recipient_zip || '').replace(/\D/g, ''),
    };
  }

  return nuvemRequest('POST', '/nfe', body);
}

async function queryNfe(nfeId) {
  return nuvemRequest('GET', `/nfe/${nfeId}`);
}

async function cancelNfe(nfeId, justificativa) {
  return nuvemRequest('POST', `/nfe/${nfeId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

module.exports = {
  getToken, nuvemRequest,
  registerCompany, uploadCertificate,
  emitNfse,  queryNfse,  cancelNfse,
  emitNfce,  queryNfce,  cancelNfce,
  emitNfe,   queryNfe,   cancelNfe,
};
