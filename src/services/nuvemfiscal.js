// ============================================================
// AURA. — Nuvem Fiscal API Service
// Auth: OAuth 2.0 client_credentials
// Docs: https://dev.nuvemfiscal.com.br/docs/api
//
// Documentos suportados:
//   NFC-e — modelo 65 (consumidor final, CPF opcional, PDV)
//   NF-e  — modelo 55 (B2B, CPF/CNPJ obrigatório)
//   NFS-e — Nota Fiscal de Serviço
//
// Mai/2026: emitNfce/emitNfe reescritos para o layout SEFAZ correto
// (envelope `infNFe` com ide/emit/dest/det/total/transp/pag).
// O body antigo (snake_case "items") ficou anos sendo rejeitado.
// ============================================================

const NUVEM_URL    = process.env.NUVEM_FISCAL_URL || 'https://api.sandbox.nuvemfiscal.com.br';
const AUTH_URL     = 'https://auth.nuvemfiscal.com.br/oauth/token';
const CLIENT_ID    = process.env.NUVEM_FISCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.NUVEM_FISCAL_CLIENT_SECRET;

// ── Token cache (renovado 60s antes de expirar) ─────────────
let _token = null;
let _tokenExpires = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpires - 60000) return _token;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('NUVEM_FISCAL_CLIENT_ID e NUVEM_FISCAL_CLIENT_SECRET nao configurados');
  }
  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}&scope=empresa%20cnpj%20cep%20nfe%20nfce%20nfse`,
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(data.error_description || 'Erro ao obter token Nuvem Fiscal');
  }
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
    // Nuvem Fiscal devolve { error: { message } }, { mensagem }, ou message
    const msg = data?.error?.message || data?.mensagem || data?.message ||
                data?.erros?.[0]?.mensagem || `Nuvem Fiscal error ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ── Tabela UF → cUF IBGE ────────────────────────────────────
const UF_CUF = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53,
};
function ufToCodigo(uf) { return UF_CUF[(uf || '').toUpperCase().trim()] || 35; }

// ── Empresas ────────────────────────────────────────────────
async function registerCompany(company) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ obrigatorio para emitir NF-e');

  // Idempotência: se já registrada, retorna existente
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
    regime_tributario: 1,
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

async function uploadCertificate(cnpj, certificateBase64, password) {
  const cleanCnpj = (cnpj || '').replace(/\D/g, '');
  return nuvemRequest('PUT', `/empresas/${cleanCnpj}/certificado`, {
    certificado: certificateBase64,
    password,
  });
}

// ── Helpers de payload NF-e/NFC-e ───────────────────────────

// Bloco emit (emitente da nota)
function buildEmit(company) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  return {
    CNPJ: cnpj,
    xNome: company.legal_name || company.trade_name || company.name || 'Emitente',
    xFant: company.trade_name || company.name || undefined,
    enderEmit: {
      xLgr: company.address_street || '',
      nro: company.address_number || 'S/N',
      xBairro: company.address_neighborhood || '',
      cMun: company.ibge_code || '',
      xMun: company.address_city || '',
      UF: (company.address_state || 'SP').toUpperCase(),
      CEP: (company.address_zip || '').replace(/\D/g, ''),
      cPais: '1058',
      xPais: 'Brasil',
      fone: (company.phone || '').replace(/\D/g, '') || undefined,
    },
    IE: company.inscricao_estadual || undefined,
    IM: company.inscricao_municipal || undefined,
    // CRT (Código de Regime Tributário): 1=Simples Nacional, 2=SN excesso sublimite,
    // 3=Regime Normal, 4=MEI
    CRT: company.tax_regime === 'mei' ? 4 :
         company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real' ? 3 : 1,
  };
}

// Bloco dest (destinatário; opcional na NFC-e quando consumidor não identificado)
function buildDest({ cpf, cnpj, name, email }) {
  const cpfClean  = (cpf || '').replace(/\D/g, '');
  const cnpjClean = (cnpj || '').replace(/\D/g, '');
  if (!cpfClean && !cnpjClean) return undefined;

  const dest = {
    xNome: name || 'CONSUMIDOR',
    indIEDest: 9,
  };
  if (cnpjClean) dest.CNPJ = cnpjClean;
  else dest.CPF = cpfClean;
  if (email) dest.email = email;
  return dest;
}

// Bloco det[] (itens da nota) — Simples Nacional usa ICMSSN102
function buildDet(items, opts = {}) {
  const isSimples = opts.crt === 1 || opts.crt === 4;

  return (items || []).map((item, i) => {
    const qty   = Number(item.quantity || 1);
    const price = Number(item.price || 0);
    const total = Math.round(qty * price * 100) / 100;

    const prod = {
      cProd: String(item.code || item.product_id || (i + 1)),
      cEAN: item.barcode || 'SEM GTIN',
      xProd: (item.name || item.description || `Item ${i + 1}`).slice(0, 120),
      NCM: item.ncm || '00000000',
      CFOP: item.cfop || '5102',
      uCom: item.unit || 'UN',
      qCom: qty,
      vUnCom: price,
      vProd: total,
      cEANTrib: item.barcode || 'SEM GTIN',
      uTrib: item.unit || 'UN',
      qTrib: qty,
      vUnTrib: price,
      indTot: 1,
    };

    const ICMS = isSimples
      ? { ICMSSN102: { orig: 0, CSOSN: '102' } }
      : { ICMS00:    { orig: 0, CST: '00', modBC: 3, vBC: total, pICMS: 0, vICMS: 0 } };

    return {
      nItem: i + 1,
      prod,
      imposto: {
        ICMS,
        PIS:    { PISNT:    { CST: '07' } },
        COFINS: { COFINSNT: { CST: '07' } },
      },
    };
  });
}

function buildICMSTot(det) {
  const vProd = det.reduce((s, d) => s + Number(d.prod.vProd || 0), 0);
  const round = (n) => Math.round(n * 100) / 100;
  return {
    vBC: 0, vICMS: 0, vICMSDeson: 0, vFCP: 0,
    vBCST: 0, vST: 0, vFCPST: 0, vFCPSTRet: 0,
    vProd: round(vProd),
    vFrete: 0, vSeg: 0, vDesc: 0,
    vII: 0, vIPI: 0, vIPIDevol: 0,
    vPIS: 0, vCOFINS: 0,
    vOutro: 0,
    vNF: round(vProd),
    vTotTrib: 0,
  };
}

// 01=dinheiro, 02=cheque, 03=cartão crédito, 04=cartão débito,
// 05=crédito loja, 10=vale alimentação, 15=boleto, 17=Pix, 99=outros
function buildPag(payment, total) {
  const tPag = String(payment.method || '01').padStart(2, '0');
  const pay = {
    indPag: payment.indPag === undefined ? 0 : payment.indPag,
    tPag,
    vPag: Number(total || 0),
  };
  return {
    detPag: [pay],
    vTroco: Number(payment.change || 0) || 0,
  };
}

// ── NFC-e (modelo 65) ───────────────────────────────────────
async function emitNfce(company, nfceData) {
  const tpAmb = NUVEM_URL.includes('sandbox') ? 2 : 1;

  const det = buildDet(nfceData.items || [], {
    crt: company.tax_regime === 'mei' ? 4 :
         company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real' ? 3 : 1,
  });

  const total = buildICMSTot(det);
  const totalValue = nfceData.total_value !== undefined
    ? Number(nfceData.total_value)
    : total.vNF;

  const body = {
    ambiente: tpAmb === 2 ? 'homologacao' : 'producao',
    referencia: nfceData.reference || `nfce-${Date.now()}`,
    infNFe: {
      versao: '4.00',
      ide: {
        cUF: ufToCodigo(company.address_state),
        natOp: nfceData.natureza_operacao || 'Venda ao consumidor',
        mod: 65,
        serie: Number(nfceData.serie || 1),
        nNF: Number(nfceData.numero || 1),
        dhEmi: new Date().toISOString(),
        tpNF: 1,
        idDest: 1,
        cMunFG: company.ibge_code || '',
        tpImp: 4,
        tpEmis: 1,
        tpAmb,
        finNFe: 1,
        indFinal: 1,
        indPres: 1,
        procEmi: 0,
        verProc: 'Aura/1.0',
      },
      emit: buildEmit(company),
      dest: buildDest({
        cpf: nfceData.recipient_cpf,
        cnpj: nfceData.recipient_cnpj,
        name: nfceData.recipient_name,
        email: nfceData.recipient_email,
      }),
      det,
      total: { ICMSTot: total },
      transp: { modFrete: 9 },
      pag: buildPag({
        method: nfceData.payment_method || '01',
        change: nfceData.payment_change,
      }, totalValue),
      infAdic: nfceData.observacoes ? { infCpl: String(nfceData.observacoes).slice(0, 5000) } : undefined,
    },
  };

  if (!body.infNFe.dest) delete body.infNFe.dest;

  return nuvemRequest('POST', '/nfce', body);
}

async function queryNfce(nfceId)             { return nuvemRequest('GET',  `/nfce/${nfceId}`); }
async function cancelNfce(nfceId, justificativa) {
  return nuvemRequest('POST', `/nfce/${nfceId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

// ── NF-e (modelo 55) ────────────────────────────────────────
async function emitNfe(company, nfeData) {
  const tpAmb = NUVEM_URL.includes('sandbox') ? 2 : 1;
  const crt   = company.tax_regime === 'mei' ? 4 :
                company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real' ? 3 : 1;

  const det = buildDet(nfeData.items || [], { crt });
  const total = buildICMSTot(det);
  const totalValue = nfeData.total_value !== undefined ? Number(nfeData.total_value) : total.vNF;

  const dest = buildDest({
    cpf:   nfeData.recipient_cpf,
    cnpj:  nfeData.recipient_cnpj,
    name:  nfeData.recipient_name,
    email: nfeData.recipient_email,
  });
  if (!dest) throw new Error('NF-e (modelo 55) exige CPF ou CNPJ do destinatário');

  if (nfeData.recipient_zip) {
    dest.enderDest = {
      xLgr: nfeData.recipient_address      || '',
      nro:  nfeData.recipient_number       || 'S/N',
      xBairro: nfeData.recipient_neighborhood || '',
      cMun: nfeData.recipient_ibge   || '',
      xMun: nfeData.recipient_city   || '',
      UF:   (nfeData.recipient_state || 'SP').toUpperCase(),
      CEP:  (nfeData.recipient_zip || '').replace(/\D/g, ''),
      cPais: '1058',
      xPais: 'Brasil',
    };
  }

  const body = {
    ambiente: tpAmb === 2 ? 'homologacao' : 'producao',
    referencia: nfeData.reference || `nfe-${Date.now()}`,
    infNFe: {
      versao: '4.00',
      ide: {
        cUF: ufToCodigo(company.address_state),
        natOp: nfeData.natureza_operacao || 'Venda',
        mod: 55,
        serie: Number(nfeData.serie || 1),
        nNF: Number(nfeData.numero || 1),
        dhEmi: new Date().toISOString(),
        tpNF: 1,
        idDest: nfeData.idDest || 1,
        cMunFG: company.ibge_code || '',
        tpImp: 1,
        tpEmis: 1,
        tpAmb,
        finNFe: 1,
        indFinal: nfeData.indFinal === undefined ? 1 : nfeData.indFinal,
        indPres: nfeData.indPres === undefined ? 1 : nfeData.indPres,
        procEmi: 0,
        verProc: 'Aura/1.0',
      },
      emit: buildEmit(company),
      dest,
      det,
      total: { ICMSTot: total },
      transp: { modFrete: 9 },
      pag: buildPag({
        method: nfeData.payment_method || '01',
        change: nfeData.payment_change,
      }, totalValue),
      infAdic: nfeData.observacoes ? { infCpl: String(nfeData.observacoes).slice(0, 5000) } : undefined,
    },
  };

  return nuvemRequest('POST', '/nfe', body);
}

async function queryNfe(nfeId)              { return nuvemRequest('GET',  `/nfe/${nfeId}`); }
async function cancelNfe(nfeId, justificativa) {
  return nuvemRequest('POST', `/nfe/${nfeId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

// ── NFS-e (mantida no formato anterior — schema próprio) ────
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
async function queryNfse(nfseId)              { return nuvemRequest('GET',  `/nfse/${nfseId}`); }
async function cancelNfse(nfseId, justificativa) {
  return nuvemRequest('POST', `/nfse/${nfseId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

module.exports = {
  getToken, nuvemRequest, ufToCodigo,
  buildEmit, buildDest, buildDet, buildICMSTot, buildPag,
  registerCompany, uploadCertificate,
  emitNfce, queryNfce, cancelNfce,
  emitNfe,  queryNfe,  cancelNfe,
  emitNfse, queryNfse, cancelNfse,
};
