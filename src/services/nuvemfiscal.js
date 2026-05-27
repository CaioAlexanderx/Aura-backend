// ============================================================
// AURA. — Nuvem Fiscal API Service
// Auth: OAuth 2.0 client_credentials
// Docs: https://dev.nuvemfiscal.com.br/docs/api
//
// 27/05/2026 (buildEmit via Nuvem Fiscal — caminho A):
// - fetchNuvemEmpresa(cnpj) com cache 5min puxa cadastro fiscal
//   completo (endereço, IE, IM, razão) direto da Nuvem Fiscal,
//   que é fonte da verdade. Banco do Aura (tabela companies) só
//   fornece tax_regime e fallback.
// - buildEmit, buildSelfDest viram ASYNC. emitNfce, emitNfe ajustados.
// - Caio confirmou que edita cadastro direto na Nuvem Fiscal;
//   nosso banco fica defasado em campos como address_neighborhood.
//
// 27/05/2026 (hotfix endereço defensivo): safeAddrField fallback
// quando company.address_* vazio/curto. Aplicado em xLgr e xBairro.
//
// 27/05/2026 (log detalhado de erro fiscal): nuvemRequest extrai
// erros[]/errors[] e enriquece msg; emitNfe loga body NF-e 55.
//
// 26/05/2026 (hotfix NFref): NFref vai em ide.NFref (TIde), não em
// infNFe.NFref (TInfNFe).
//
// 25/05/2026 (Polish v3): emitNfeDevolucao com dest = próprio emitente
// (SEFAZ FAQ MG #7). CSOSN 102 + CFOP 1.202 imutáveis.
//
// 12/05/2026 (Fase C): emitNfeDevolucao(company, params) com tpNF=0 +
// finNFe=4 + refNFe + CFOP 1.202.
//
// Mai/2026 (foundation): buildPag multi-pagamento, card.tpIntegra=2,
// xPag só pra tPag=99, workaround PIX (tPag=17 → 99+xPag=PIX).
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

function extractErros(data) {
  if (Array.isArray(data?.erros)) return data.erros;
  if (Array.isArray(data?.errors)) return data.errors;
  if (Array.isArray(data?.error?.errors)) return data.error.errors;
  if (Array.isArray(data?.error?.erros)) return data.error.erros;
  return [];
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
    const erros = extractErros(data);
    const firstErro = erros[0];
    const erroDetail = firstErro && (firstErro.mensagem || firstErro.message || firstErro.descricao || firstErro.detail);
    const erroCampo  = firstErro && (firstErro.campo || firstErro.field || firstErro.property);

    let msg = data?.error?.message || data?.mensagem || data?.message ||
              erroDetail || `Nuvem Fiscal error ${resp.status}`;
    if (erroCampo && erroDetail && !String(msg).includes(erroCampo)) {
      msg = `${msg} (campo: ${erroCampo})`;
    } else if (erros.length > 1) {
      msg = `${msg} (+${erros.length - 1} outros erros)`;
    }

    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    err.erros = erros;
    throw err;
  }
  return data;
}

// ============================================================
// 27/05/2026 — Cadastro fiscal via Nuvem Fiscal (caminho A)
// ============================================================
// Cache module-level com TTL pra reduzir overhead nas emissões.
// Pra forçar refresh após edição na Nuvem Fiscal: clearEmpresaCache(cnpj).
const _empresaCache = new Map();
const EMPRESA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

async function fetchNuvemEmpresa(cnpj) {
  const cleanCnpj = String(cnpj || '').replace(/\D/g, '');
  if (cleanCnpj.length !== 14 && cleanCnpj.length !== 11) return null;

  const cached = _empresaCache.get(cleanCnpj);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const data = await nuvemRequest('GET', `/empresas/${cleanCnpj}`);
    if (data && data.cpf_cnpj) {
      _empresaCache.set(cleanCnpj, { data, expiresAt: Date.now() + EMPRESA_CACHE_TTL_MS });
      return data;
    }
    return null;
  } catch (e) {
    console.warn(`[nuvemfiscal] fetchNuvemEmpresa(${cleanCnpj}) falhou (${e.status || '?'}): ${e.message}. Fallback pro banco Aura.`);
    // Cache negativo curto (1min) pra não bombardear API em CNPJs ainda não cadastrados
    _empresaCache.set(cleanCnpj, { data: null, expiresAt: Date.now() + 60 * 1000 });
    return null;
  }
}

function clearEmpresaCache(cnpj) {
  if (!cnpj) {
    _empresaCache.clear();
    return;
  }
  const cleanCnpj = String(cnpj).replace(/\D/g, '');
  _empresaCache.delete(cleanCnpj);
}

// Merge company (banco Aura) com cadastro fiscal da Nuvem Fiscal.
// Prioriza Nuvem em campos fiscais (endereço, IE, IM, razão).
// Mantém Aura pra campos operacionais (id, tax_regime, billing_*).
function mergeCompanyWithNuvem(company, nuvem) {
  if (!nuvem) return company;
  const end = nuvem.endereco || {};
  return {
    ...company,
    cnpj: nuvem.cpf_cnpj || company.cnpj,
    legal_name: nuvem.nome_razao_social || company.legal_name,
    trade_name: nuvem.nome_fantasia || company.trade_name,
    inscricao_estadual: nuvem.inscricao_estadual || company.inscricao_estadual,
    inscricao_municipal: nuvem.inscricao_municipal || company.inscricao_municipal,
    email: nuvem.email || company.email,
    phone: nuvem.fone || company.phone,
    address_street: end.logradouro || company.address_street,
    address_number: end.numero || company.address_number,
    address_neighborhood: end.bairro || company.address_neighborhood,
    ibge_code: end.codigo_municipio || company.ibge_code,
    address_city: end.cidade || company.address_city,
    address_state: end.uf || company.address_state,
    address_zip: end.cep || company.address_zip,
  };
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

const CARD_TPAG = new Set(['03', '04']);

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

// Helper defensivo pra campos de endereço que ainda venham vazios mesmo
// após merge com Nuvem Fiscal (caso muito raro, mas cobre).
function safeAddrField(value, minLen, fallback, fieldName, companyCnpj) {
  const v = String(value || '').trim();
  if (v.length >= minLen) return v;
  console.warn(
    `[nuvemfiscal] cadastro company ${companyCnpj || '?'} sem ${fieldName} ` +
    `(valor atual: "${v}", min: ${minLen} chars). Usando fallback "${fallback}". ` +
    `Verifique se o cadastro na Nuvem Fiscal está completo.`
  );
  return fallback;
}

// 27/05/2026: buildEmit agora é ASYNC. Busca cadastro fiscal da Nuvem
// Fiscal (com cache 5min) e mescla com company do banco Aura, priorizando
// dados fiscais da Nuvem. Banco Aura é fallback se Nuvem indisponível.
async function buildEmit(company) {
  const cnpjRaw = String(company.cnpj || '').replace(/\D/g, '');
  const nuvem = cnpjRaw ? await fetchNuvemEmpresa(cnpjRaw) : null;
  const eff = mergeCompanyWithNuvem(company, nuvem);

  const cnpj = (eff.cnpj || '').replace(/\D/g, '');
  return {
    CNPJ: cnpj,
    xNome: eff.legal_name || eff.trade_name || eff.name || 'Emitente',
    xFant: eff.trade_name || eff.name || undefined,
    enderEmit: {
      xLgr: safeAddrField(eff.address_street, 2, 'Nao informado', 'address_street', cnpj),
      nro: String(eff.address_number || 'S/N').trim() || 'S/N',
      xBairro: safeAddrField(eff.address_neighborhood, 2, 'Centro', 'address_neighborhood', cnpj),
      cMun: eff.ibge_code || '',
      xMun: eff.address_city || '',
      UF: (eff.address_state || 'SP').toUpperCase(),
      CEP: (eff.address_zip || '').replace(/\D/g, ''),
      cPais: '1058',
      xPais: 'Brasil',
      fone: (eff.phone || '').replace(/\D/g, '') || undefined,
    },
    IE: eff.inscricao_estadual || undefined,
    IM: eff.inscricao_municipal || undefined,
    CRT: eff.tax_regime === 'mei' ? 4 :
         eff.tax_regime === 'lucro_presumido' || eff.tax_regime === 'lucro_real' ? 3 : 1,
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

// 27/05/2026: buildSelfDest agora é ASYNC (chama await buildEmit).
async function buildSelfDest(company) {
  const emit = await buildEmit(company);
  return {
    CNPJ: emit.CNPJ,
    xNome: emit.xNome,
    indIEDest: emit.IE ? 1 : 9,
    IE: emit.IE,
    enderDest: { ...emit.enderEmit },
  };
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
    let tPag = validateTpag(p.method);

    let xPagOverride = null;
    if (tPag === '17') {
      tPag = '99';
      xPagOverride = 'PIX';
    }

    const entry = {
      indPag: p.indPag === undefined ? 0 : p.indPag,
      tPag,
      vPag: round(Number(p.value || 0)),
    };
    if (tPag === '99') {
      entry.xPag = xPagOverride || TPAG_DESCRIPTIONS['99'];
    }
    if (CARD_TPAG.has(tPag)) {
      entry.card = { tpIntegra: 2 };
    }
    return entry;
  });

  const vTroco = list.reduce((s, p) => s + (Number(p.change) || 0), 0);
  return { detPag, vTroco: round(vTroco) };
}

function buildIde({ company, mod, serie, nNF, tpAmb, tpImp, indFinal, indPres, idDest, natOp, verProc, tpNF, finNFe }) {
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
    tpNF: tpNF === undefined ? 1 : Number(tpNF),
    idDest: idDest || 1,
    cMunFG: company.ibge_code || '',
    tpImp, tpEmis,
    cDV: Number(cDV),
    tpAmb,
    finNFe: finNFe || 1,
    indFinal, indPres,
    procEmi: 0,
    verProc: verProc || 'Aura/1.0',
  };
}

function resolvePagInput(data) {
  if (Array.isArray(data.payments) && data.payments.length) return data.payments;
  return {
    method: data.payment_method || '01',
    change: data.payment_change,
  };
}

function buildInfAdic({ observacoes, infAdFisco }) {
  const infAdic = {};
  if (observacoes) infAdic.infCpl = String(observacoes).slice(0, 5000);
  if (infAdFisco) infAdic.infAdFisco = String(infAdFisco).slice(0, 2000);
  return Object.keys(infAdic).length ? infAdic : undefined;
}

async function emitNfce(company, nfceData) {
  const tpAmb = NUVEM_URL.includes('sandbox') ? 2 : 1;

  // 27/05/2026: buscar Nuvem ANTES de tudo pra também usar tax_regime
  // efetivo (e tudo derivado dele) consistente com o que vai pro emit.
  const cnpjRaw = String(company.cnpj || '').replace(/\D/g, '');
  const nuvem = cnpjRaw ? await fetchNuvemEmpresa(cnpjRaw) : null;
  const effective = mergeCompanyWithNuvem(company, nuvem);

  const crt = effective.tax_regime === 'mei' ? 4 :
              effective.tax_regime === 'lucro_presumido' || effective.tax_regime === 'lucro_real' ? 3 : 1;

  const det = buildDet(nfceData.items || [], { crt });
  const total = buildICMSTot(det);
  const totalValue = nfceData.total_value !== undefined ? Number(nfceData.total_value) : total.vNF;

  const emit = await buildEmit(effective);

  const body = {
    ambiente: tpAmb === 2 ? 'homologacao' : 'producao',
    referencia: nfceData.reference || `nfce-${Date.now()}`,
    infNFe: {
      versao: '4.00',
      ide: buildIde({
        company: effective, mod: 65,
        serie: nfceData.serie || 1,
        nNF: nfceData.numero || 1,
        tpAmb, tpImp: 4,
        indFinal: 1, indPres: 1, idDest: 1,
        natOp: nfceData.natureza_operacao || 'Venda ao consumidor',
      }),
      emit,
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
      infAdic: buildInfAdic({ observacoes: nfceData.observacoes, infAdFisco: nfceData.infAdFisco }),
    },
  };

  if (!body.infNFe.dest) delete body.infNFe.dest;
  if (!body.infNFe.infAdic) delete body.infNFe.infAdic;

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

  // 27/05/2026: buscar Nuvem ANTES pra usar dados consistentes em todo
  // o body (emit, dest=self, ide.cMunFG, etc).
  const cnpjRaw = String(company.cnpj || '').replace(/\D/g, '');
  const nuvem = cnpjRaw ? await fetchNuvemEmpresa(cnpjRaw) : null;
  const effective = mergeCompanyWithNuvem(company, nuvem);

  const crt   = effective.tax_regime === 'mei' ? 4 :
                effective.tax_regime === 'lucro_presumido' || effective.tax_regime === 'lucro_real' ? 3 : 1;

  const det = buildDet(nfeData.items || [], { crt });
  const total = buildICMSTot(det);
  const totalValue = nfeData.total_value !== undefined ? Number(nfeData.total_value) : total.vNF;

  let dest;
  if (nfeData.selfDest) {
    dest = await buildSelfDest(effective);
  } else {
    dest = buildDest({
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
  }

  const ide = buildIde({
    company: effective, mod: 55,
    serie: nfeData.serie || 1,
    nNF: nfeData.numero || 1,
    tpAmb, tpImp: 1,
    tpNF: nfeData.tpNF,
    finNFe: nfeData.finNFe,
    indFinal: nfeData.indFinal === undefined ? 1 : nfeData.indFinal,
    indPres: nfeData.indPres === undefined ? 1 : nfeData.indPres,
    idDest: nfeData.idDest || 1,
    natOp: nfeData.natureza_operacao || 'Venda',
  });

  if (nfeData.refNFe) {
    const cleanRef = String(nfeData.refNFe).replace(/\D/g, '');
    if (cleanRef.length === 44) {
      ide.NFref = [{ refNFe: cleanRef }];
    } else {
      console.warn('[nuvemfiscal] emitNfe: refNFe ignorada — esperado 44 dígitos, recebido', cleanRef.length);
    }
  }

  const emit = await buildEmit(effective);

  const body = {
    ambiente: tpAmb === 2 ? 'homologacao' : 'producao',
    referencia: nfeData.reference || `nfe-${Date.now()}`,
    infNFe: {
      versao: '4.00',
      ide,
      emit,
      dest, det,
      total: { ICMSTot: total },
      transp: { modFrete: 9 },
      pag: buildPag(resolvePagInput(nfeData), totalValue),
      infAdic: buildInfAdic({ observacoes: nfeData.observacoes, infAdFisco: nfeData.infAdFisco }),
    },
  };

  if (!body.infNFe.infAdic) delete body.infNFe.infAdic;

  if (nfeData.refNFe) {
    try {
      console.log('[nuvemfiscal] emitNfe NF-55 devolução body:', JSON.stringify(body, null, 2));
    } catch (_) {}
  }

  return nuvemRequest('POST', '/nfe', body);
}

async function queryNfe(nfeId)              { return nuvemRequest('GET',  `/nfe/${nfeId}`); }
async function cancelNfe(nfeId, justificativa) {
  return nuvemRequest('POST', `/nfe/${nfeId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

async function emitNfeDevolucao(company, params) {
  const {
    originalChave,
    items,
    consumerInfo,
    serie,
    numero,
    reference,
  } = params || {};

  const cleanChave = String(originalChave || '').replace(/\D/g, '');
  if (cleanChave.length !== 44) {
    throw new Error('emitNfeDevolucao: originalChave deve ter 44 dígitos (chave de acesso NFC-e/NF-e)');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('emitNfeDevolucao: items obrigatórios');
  }

  const enrichedItems = items.map(item => ({
    ...item,
    cfop: item.cfop || '1202',
  }));

  const consumerName = consumerInfo?.name || 'Consumidor não identificado';
  const consumerCpf = consumerInfo?.cpf ? ` (CPF ${consumerInfo.cpf})` : '';
  const motivo = consumerInfo?.motivo || 'Troca';
  const infAdFisco =
    `Devolução de mercadoria referente à NFC-e chave ${cleanChave}. ` +
    `Consumidor: ${consumerName}${consumerCpf}. ` +
    `Motivo: ${motivo}.`;

  return emitNfe(company, {
    reference: reference || `nfe-devolucao-${Date.now()}`,
    serie: serie || 1,
    numero: numero || 1,
    natureza_operacao: 'devolução de mercadoria adquirida por não contribuinte',
    tpNF: 0,
    finNFe: 4,
    refNFe: cleanChave,
    indFinal: 1,
    indPres: 1,
    idDest: 1,
    items: enrichedItems,
    selfDest: true,
    infAdFisco,
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
  isoBR, generateCNF, calcDvChaveAcesso, buildAccessKey44, validateTpag,
  buildEmit, buildDest, buildSelfDest, buildDet, buildICMSTot, buildPag, buildIde,
  buildInfAdic, resolvePagInput, extractErros, safeAddrField,
  fetchNuvemEmpresa, clearEmpresaCache, mergeCompanyWithNuvem,
  registerCompany, uploadCertificate,
  emitNfce, queryNfce, cancelNfce,
  emitNfe,  queryNfe,  cancelNfe,
  emitNfeDevolucao,
  emitNfse, queryNfse, cancelNfse,
};
