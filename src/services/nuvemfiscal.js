// ============================================================
// AURA. — Nuvem Fiscal API Service
// Auth: OAuth 2.0 client_credentials
// Docs: https://dev.nuvemfiscal.com.br/docs/api
//
// Mai/2026 (foundation):
// - buildPag agora aceita array de pagamentos (multi-pagamento NFC-e)
//   ou objeto único legado { method, change }. Ambos coexistem.
// - buildPag inclui card.tpIntegra=2 para tPag 03/04 (crédito/débito)
//   evitando Rejeição 391 do SEFAZ (dados do cartão obrigatórios).
//   Atenção: a propriedade JSON é `card` (confirmado em
//   nuvem-fiscal/nuvemfiscal-sdk-php NfeSefazDetPag.php), NÃO `cartao`.
// - buildPag adiciona xPag SOMENTE para tPag=99 (Outros), conforme regra
//   W21-A do schema NF-e 4.00. Outros tPag rejeitam com cStat=442.
// ============================================================

const NUVEM_URL    = process.env.NUVEM_FISCAL_URL || 'https://api.sandbox.nuvemfiscal.com.br';
const AUTH_URL     = 'https://auth.nuvemfiscal.com.br/oauth/token';
const CLIENT_ID    = process.env.NUVEM_FISCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.NUVEM_FISCAL_CLIENT_SECRET;

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
    const msg = data?.error?.message || data?.mensagem || data?.message ||
                data?.erros?.[0]?.mensagem || `Nuvem Fiscal error ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

const UF_CUF = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53,
};
function ufToCodigo(uf) { return UF_CUF[(uf || '').toUpperCase().trim()] || 35; }

function isoBR(d = new Date()) {
  const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return local.toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

function generateCNF() {
  return String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
}

function calcDvChaveAcesso(chave43) {
  const w = [2, 3, 4, 5, 6, 7, 8, 9];
  let sum = 0;
  for (let i = chave43.length - 1, k = 0; i >= 0; i--, k = (k + 1) % w.length) {
    sum += parseInt(chave43[i], 10) * w[k];
  }
  const mod = sum % 11;
  return String(mod < 2 ? 0 : 11 - mod);
}

function buildAccessKey44({ cUF, ano2, mes2, cnpj, mod, serie, nNF, tpEmis, cNF }) {
  const k43 =
    String(cUF).padStart(2, '0') +
    String(ano2).padStart(2, '0') +
    String(mes2).padStart(2, '0') +
    String(cnpj).replace(/\D/g, '').padStart(14, '0') +
    String(mod).padStart(2, '0') +
    String(serie).padStart(3, '0') +
    String(nNF).padStart(9, '0') +
    String(tpEmis).padStart(1, '0') +
    String(cNF).padStart(8, '0');
  return k43 + calcDvChaveAcesso(k43);
}

const VALID_TPAG = new Set(['01','02','03','04','05','10','11','12','13','15','16','17','18','19','90','99']);
function validateTpag(method) {
  const t = String(method || '01').padStart(2, '0').slice(0, 2);
  return VALID_TPAG.has(t) ? t : '99';
}

// tPag que exigem o bloco `card` (NfeSefazCard) em TDetPag.
// SEFAZ NF-e 4.00: tPag=03 (crédito) e 04 (débito) → card obrigatório,
// senão Rejeição 391. tpIntegra=2 (TEF não-integrado) torna CNPJ/tBand/cAut
// opcionais. Ver: nuvem-fiscal/nuvemfiscal-sdk-php NfeSefazDetPag.php
const CARD_TPAG = new Set(['03', '04']);

// xPag: descrição amigável de cada tPag (max 60 chars no schema NF-e 4.00).
// Schema W21-A só PERMITE xPag quando tPag=99 (Outros). Pra qualquer outro
// tPag, enviar xPag dispara cStat=442 ("Descrição do pagamento não
// permitida"). Por isso só usamos abaixo quando tPag === '99'.
// Mantemos o mapa completo pra eventuais usos em logs/UI.
const TPAG_DESCRIPTIONS = {
  '01': 'Dinheiro',
  '02': 'Cheque',
  '03': 'Cartão de Crédito',
  '04': 'Cartão de Débito',
  '05': 'Crédito Loja',
  '10': 'Vale Alimentação',
  '11': 'Vale Refeição',
  '12': 'Vale Presente',
  '13': 'Vale Combustível',
  '15': 'Boleto Bancário',
  '16': 'Depósito Bancário',
  '17': 'PIX',
  '18': 'Transferência bancária',
  '19': 'Programa de fidelidade',
  '90': 'Sem pagamento',
  '99': 'Outros',
};

async function registerCompany(company) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ obrigatorio para emitir NF-e');
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
    CRT: company.tax_regime === 'mei' ? 4 :
         company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real' ? 3 : 1,
  };
}

function buildDest({ cpf, cnpj, name, email }) {
  const cpfClean  = (cpf || '').replace(/\D/g, '');
  const cnpjClean = (cnpj || '').replace(/\D/g, '');
  if (!cpfClean && !cnpjClean) return undefined;
  const dest = { xNome: name || 'CONSUMIDOR', indIEDest: 9 };
  if (cnpjClean) dest.CNPJ = cnpjClean;
  else dest.CPF = cpfClean;
  if (email) dest.email = email;
  return dest;
}

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
      nItem: i + 1, prod,
      imposto: { ICMS, PIS: { PISNT: { CST: '07' } }, COFINS: { COFINSNT: { CST: '07' } } },
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

// buildPag: aceita 2 shapes pra retrocompat.
//   - Array (novo, multi-pagamento): [{ method, value, change?, indPag? }, ...]
//   - Objeto único (legado): { method, change } — vPag = totalFallback
// Em ambos, soma de change vira vTroco.
// Para tPag 03 (crédito) e 04 (débito), inclui card.tpIntegra=2 (não-integrado)
// conforme exigência SEFAZ NF-e 4.00 — evita Rejeição 391.
// IMPORTANTE: a propriedade JSON é `card`, NÃO `cartao` (confirmado em
// NfeSefazDetPag.php do SDK oficial).
// xPag: incluído apenas pra tPag=99 (regra schema W21-A; outros tPag → 442).
function buildPag(payments, totalFallback) {
  const round = (n) => Math.round(n * 100) / 100;
  let list;
  if (Array.isArray(payments)) {
    list = payments.length ? payments : [{ method: '01', value: totalFallback }];
  } else if (payments && typeof payments === 'object') {
    list = [{
      method: payments.method,
      value: payments.value !== undefined ? payments.value : totalFallback,
      change: payments.change,
      indPag: payments.indPag,
    }];
  } else {
    list = [{ method: '01', value: totalFallback }];
  }

  const detPag = list.map(p => {
    const tPag = validateTpag(p.method);
    const entry = {
      indPag: p.indPag === undefined ? 0 : p.indPag,
      tPag,
      vPag: round(Number(p.value || 0)),
    };
    // xPag: schema NF-e 4.00 (regra W21-A) só permite quando tPag=99.
    // Outros tPag rejeitam com cStat=442 ("Descrição do pagamento não permitida").
    if (tPag === '99') {
      entry.xPag = TPAG_DESCRIPTIONS['99'];
    }
    // SEFAZ exige bloco card (NfeSefazCard) para crédito (03) e débito (04).
    // tpIntegra=2: TEF não-integrado — CNPJ/tBand/cAut são opcionais.
    if (CARD_TPAG.has(tPag)) {
      entry.card = { tpIntegra: 2 };
    }
    return entry;
  });

  const vTroco = list.reduce((s, p) => s + (Number(p.change) || 0), 0);
  return { detPag, vTroco: round(vTroco) };
}

function buildIde({ company, mod, serie, nNF, tpAmb, tpImp, indFinal, indPres, idDest, natOp, verProc }) {
  const dh = isoBR();
  const cUF = ufToCodigo(company.address_state);
  const ano2 = dh.slice(2, 4);
  const mes2 = dh.slice(5, 7);
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  const cNF = generateCNF();
  const tpEmis = 1;
  const chave44 = buildAccessKey44({ cUF, ano2, mes2, cnpj, mod, serie, nNF, tpEmis, cNF });
  const cDV = chave44.slice(-1);
  return {
    cUF, cNF,
    natOp, mod,
    serie: Number(serie),
    nNF: Number(nNF),
    dhEmi: dh,
    tpNF: 1,
    idDest: idDest || 1,
    cMunFG: company.ibge_code || '',
    tpImp, tpEmis,
    cDV: Number(cDV),
    tpAmb,
    finNFe: 1,
    indFinal, indPres,
    procEmi: 0,
    verProc: verProc || 'Aura/1.0',
  };
}

// Helper: resolve o input de pagamento(s) a partir de nfceData/nfeData.
// Prefere nfeData.payments (array novo) → objeto legado { payment_method, payment_change }.
function resolvePagInput(data) {
  if (Array.isArray(data.payments) && data.payments.length) return data.payments;
  return {
    method: data.payment_method || '01',
    change: data.payment_change,
  };
}

async function emitNfce(company, nfceData) {
  const tpAmb = NUVEM_URL.includes('sandbox') ? 2 : 1;
  const crt = company.tax_regime === 'mei' ? 4 :
              company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real' ? 3 : 1;

  const det = buildDet(nfceData.items || [], { crt });
  const total = buildICMSTot(det);
  const totalValue = nfceData.total_value !== undefined ? Number(nfceData.total_value) : total.vNF;

  const body = {
    ambiente: tpAmb === 2 ? 'homologacao' : 'producao',
    referencia: nfceData.reference || `nfce-${Date.now()}`,
    infNFe: {
      versao: '4.00',
      ide: buildIde({
        company, mod: 65,
        serie: nfceData.serie || 1,
        nNF: nfceData.numero || 1,
        tpAmb, tpImp: 4,
        indFinal: 1, indPres: 1, idDest: 1,
        natOp: nfceData.natureza_operacao || 'Venda ao consumidor',
      }),
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
      pag: buildPag(resolvePagInput(nfceData), totalValue),
      infAdic: nfceData.observacoes ? { infCpl: String(nfceData.observacoes).slice(0, 5000) } : undefined,
    },
  };

  if (!body.infNFe.dest) delete body.infNFe.dest;

  // Diagnóstico: log do bloco de pagamento que está saindo daqui pra
  // Nuvem Fiscal. Ajuda a investigar Rejeição 391 (PIX) — caso ainda
  // ocorra após o fix card/cartao, vamos saber se o tPag está chegando
  // como esperado (17 pra PIX) ou se há corrupção em algum lugar.
  console.log('[nuvemfiscal] emitNfce body.infNFe.pag:', JSON.stringify(body.infNFe.pag, null, 2));

  return nuvemRequest('POST', '/nfce', body);
}

async function queryNfce(nfceId)             { return nuvemRequest('GET',  `/nfce/${nfceId}`); }
async function cancelNfce(nfceId, justificativa) {
  return nuvemRequest('POST', `/nfce/${nfceId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

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
      ide: buildIde({
        company, mod: 55,
        serie: nfeData.serie || 1,
        nNF: nfeData.numero || 1,
        tpAmb, tpImp: 1,
        indFinal: nfeData.indFinal === undefined ? 1 : nfeData.indFinal,
        indPres: nfeData.indPres === undefined ? 1 : nfeData.indPres,
        idDest: nfeData.idDest || 1,
        natOp: nfeData.natureza_operacao || 'Venda',
      }),
      emit: buildEmit(company),
      dest, det,
      total: { ICMSTot: total },
      transp: { modFrete: 9 },
      pag: buildPag(resolvePagInput(nfeData), totalValue),
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

async function emitNfse(company, nfseData) {
  const cnpj = (company.cnpj || '').replace(/\D/g, '');
  return nuvemRequest('POST', '/nfse', {
    ambiente: NUVEM_URL.includes('sandbox') ? 'homologacao' : 'producao',
    prestador: { cpf_cnpj: cnpj },
    tomador: {
      cpf_cnpj: (nfseData.recipient_cnpj || nfseData.recipient_cpf || '').replace(/\D/g, '') || undefined,
      nome_razao_social: nfseData.recipient_name || 'Consumidor',
      email: nfeData.recipient_email || undefined,
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
  isoBR, generateCNF, calcDvChaveAcesso, buildAccessKey44, validateTpag,
  buildEmit, buildDest, buildDet, buildICMSTot, buildPag, buildIde,
  resolvePagInput,
  registerCompany, uploadCertificate,
  emitNfce, queryNfce, cancelNfce,
  emitNfe,  queryNfe,  cancelNfe,
  emitNfse, queryNfse, cancelNfse,
};
