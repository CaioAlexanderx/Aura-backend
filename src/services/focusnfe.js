// ============================================================
// AURA. — Sprint 4: Focus NFe API Service
// Wrapper for Focus NFe REST API v2
// Handles: NFSe, NFe, NFCe emission, query, cancellation
// ============================================================

const FOCUS_URL = process.env.FOCUS_NFE_URL || 'https://homologacao.focusnfe.com.br';
const FOCUS_TOKEN = process.env.FOCUS_NFE_TOKEN;

function authHeader() {
  if (!FOCUS_TOKEN) throw new Error('FOCUS_NFE_TOKEN nao configurado');
  const encoded = Buffer.from(`${FOCUS_TOKEN}:`).toString('base64');
  return `Basic ${encoded}`;
}

async function focusRequest(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const resp = await fetch(`${FOCUS_URL}${path}`, opts);
  // Focus returns 200/201 for success, 422 for validation errors
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok && resp.status !== 422) {
    throw new Error(data.mensagem || data.message || `Focus NFe error ${resp.status}`);
  }
  return { status: resp.status, data };
}

// ── Empresas (register company with Focus) ───────────────
async function registerCompany(company) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ obrigatorio para emitir NF-e');
  const body = {
    nome: company.legal_name || company.trade_name || company.name,
    nome_fantasia: company.trade_name || company.name,
    cnpj,
    inscricao_estadual: company.inscricao_estadual || '',
    inscricao_municipal: company.inscricao_municipal || '',
    regime_tributario: company.tax_regime === 'mei' ? 1 : 1, // 1=Simples Nacional
    email: company.email || '',
    telefone: (company.phone || '').replace(/\D/g, ''),
    logradouro: company.address_street || '',
    numero: company.address_number || 'S/N',
    bairro: company.address_neighborhood || '',
    municipio: company.address_city || '',
    uf: company.address_state || 'SP',
    cep: (company.address_zip || '').replace(/\D/g, ''),
    codigo_municipio_ibge: company.ibge_code || '',
  };
  return focusRequest('POST', `/v2/empresas`, body);
}

// ── NFSe (Nota Fiscal de Serviço) ─────────────────────────
async function emitNfse(ref, company, nfseData) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  const body = {
    // Prestador (Aura client = who provides the service)
    prestador: {
      cnpj,
      inscricao_municipal: company.inscricao_municipal || '',
      codigo_municipio: company.ibge_code || '',
    },
    // Tomador (recipient of the service)
    tomador: {
      cnpj: (nfseData.recipient_cnpj || '').replace(/\D/g, '') || undefined,
      cpf: (nfseData.recipient_cpf || '').replace(/\D/g, '') || undefined,
      razao_social: nfseData.recipient_name || 'Consumidor',
      email: nfseData.recipient_email || undefined,
      endereco: nfseData.recipient_address ? {
        logradouro: nfseData.recipient_address,
        uf: nfseData.recipient_state || 'SP',
        codigo_municipio: nfseData.recipient_ibge || '',
      } : undefined,
    },
    servico: {
      aliquota: nfseData.iss_rate || 2,
      discriminacao: nfseData.description || 'Servico prestado',
      iss_retido: nfseData.iss_retained ? 'true' : 'false',
      item_lista_servico: nfseData.service_code || '',
      codigo_tributario_municipio: nfseData.service_code_municipal || '',
      valor_servicos: nfseData.value,
    },
  };
  return focusRequest('POST', `/v2/nfse?ref=${ref}`, body);
}

async function queryNfse(ref) {
  return focusRequest('GET', `/v2/nfse/${ref}`);
}

async function cancelNfse(ref, justificativa) {
  return focusRequest('DELETE', `/v2/nfse/${ref}`, { justificativa: justificativa || 'Cancelamento solicitado pelo emissor' });
}

// ── NFCe (Nota Fiscal do Consumidor) ──────────────────────
async function emitNfce(ref, company, nfceData) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  const body = {
    natureza_operacao: 'Venda ao consumidor',
    tipo_documento: 1,
    finalidade_emissao: 1,
    cnpj_emitente: cnpj,
    nome_emitente: company.legal_name || company.trade_name,
    nome_fantasia_emitente: company.trade_name || company.name,
    inscricao_estadual_emitente: company.inscricao_estadual || '',
    logradouro_emitente: company.address_street || '',
    numero_emitente: company.address_number || 'S/N',
    bairro_emitente: company.address_neighborhood || '',
    municipio_emitente: company.address_city || '',
    uf_emitente: company.address_state || 'SP',
    cep_emitente: (company.address_zip || '').replace(/\D/g, ''),
    modalidade_frete: 9, // sem frete
    informacoes_adicionais_contribuinte: 'Emitido via Aura.',
    items: (nfceData.items || []).map((item, i) => ({
      numero_item: i + 1,
      codigo_produto: item.code || String(i + 1),
      descricao: item.description || item.name,
      cfop: item.cfop || '5102',
      unidade_comercial: item.unit || 'UN',
      quantidade_comercial: item.quantity || 1,
      valor_unitario_comercial: item.price,
      valor_bruto: (item.quantity || 1) * item.price,
      unidade_tributavel: item.unit || 'UN',
      quantidade_tributavel: item.quantity || 1,
      valor_unitario_tributavel: item.price,
      origem: '0',
      icms_situacao_tributaria: '102', // Simples Nacional
    })),
    formas_pagamento: [{
      forma_pagamento: nfceData.payment_method || '01', // 01=dinheiro
      valor_pagamento: nfceData.total_value,
    }],
  };
  // Add recipient if provided
  if (nfceData.recipient_cpf) {
    body.cpf_destinatario = nfceData.recipient_cpf.replace(/\D/g, '');
    body.nome_destinatario = nfceData.recipient_name || 'Consumidor';
  }
  return focusRequest('POST', `/v2/nfce?ref=${ref}`, body);
}

async function queryNfce(ref) {
  return focusRequest('GET', `/v2/nfce/${ref}`);
}

async function cancelNfce(ref, justificativa) {
  return focusRequest('DELETE', `/v2/nfce/${ref}`, { justificativa: justificativa || 'Cancelamento solicitado pelo emissor' });
}

// ── Query generic (works for all types) ───────────────────
async function query(type, ref) {
  return focusRequest('GET', `/v2/${type}/${ref}`);
}

module.exports = {
  registerCompany,
  emitNfse, queryNfse, cancelNfse,
  emitNfce, queryNfce, cancelNfce,
  query, focusRequest,
};
