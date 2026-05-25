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
// - Workaround PIX: tPag=17 mapeia automaticamente para tPag=99 + xPag="PIX"
//   pra contornar Rejeição 391 disparada erroneamente pela SEFAZ-SP em
//   produção (problema confirmado via diagnóstico, NF-e válido pelo schema).
//
// 12/05/2026 (Fase C — NF-e/55 devolução):
// - buildIde aceita tpNF (0=entrada / 1=saída) e finNFe (1=normal /
//   2=complementar / 3=ajuste / 4=devolução). Default 1/1 preserva
//   comportamento atual em qualquer chamada existente.
// - emitNfe propaga esses params + monta `NFref: [{ refNFe }]` quando
//   nfeData.refNFe é fornecido. Necessário pra devolução referenciar
//   a NFC-e/55 original (chave 44 dígitos).
// - Helper emitNfeDevolucao(company, params) — NF-e/55 de entrada,
//   tpNF=0 + finNFe=4 + refNFe + CFOP 1.202.
//
// 25/05/2026 (Polish v3 — auditoria atrito):
// - emitNfe aceita nfeData.infAdFisco; popula infNFe.infAdic.infAdFisco
//   além de infCpl. Necessário pra NF-e 55 de devolução de venda a
//   consumidor final (SEFAZ exige dados do cliente em infAdFisco texto
//   livre — FAQ SEFAZ-MG NFC-e item 7, regra nacional NT 2018.005).
// - emitNfeDevolucao reescrita: dest = PRÓPRIO EMITENTE (a loja). Schema
//   NF-e 4.00 aceita dest.CNPJ == emit.CNPJ; enderDest = enderEmit.
//   Dados do consumidor vão em infAdFisco texto livre (nome, CPF se
//   conhecido, motivo). Anônima (sem CPF) é caso suportado.
//   CSOSN 102 (default buildDet) e CFOP 1.202 mantidos — contador OK.
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

// 25/05/2026: dest = própria loja (SEFAZ FAQ MG #7 — devolução varejo).
// Construído a partir de buildEmit pra garantir consistência total
// (mesmo CNPJ, mesmo endereço). Schema NF-e 4.00 aceita dest == emit.
function buildSelfDest(company) {
  const emit = buildEmit(company);
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

// Monta infAdic com infCpl (livre) e/ou infAdFisco (interesse do fisco).
// SEFAZ trata os dois como texto livre até ~2000 chars cada. NF-e 55 de
// devolução exige infAdFisco com dados do consumidor (FAQ SEFAZ-MG #7).
function buildInfAdic({ observacoes, infAdFisco }) {
  const infAdic = {};
  if (observacoes) infAdic.infCpl = String(observacoes).slice(0, 5000);
  if (infAdFisco) infAdic.infAdFisco = String(infAdFisco).slice(0, 2000);
  return Object.keys(infAdic).length ? infAdic : undefined;
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

// emitNfe — 12/05/2026: propaga tpNF / finNFe pra buildIde e monta NFref
// quando nfeData.refNFe é fornecido. Default segue saída + normal pra
// retrocompat com chamadas existentes.
//
// 25/05/2026: aceita nfeData.selfDest (boolean) — quando true, dest =
// próprio emitente (NF-e 55 devolução varejo, SEFAZ FAQ MG #7).
// Também aceita nfeData.infAdFisco — vai pra infNFe.infAdic.infAdFisco.
async function emitNfe(company, nfeData) {
  const tpAmb = NUVEM_URL.includes('sandbox') ? 2 : 1;
  const crt   = company.tax_regime === 'mei' ? 4 :
                company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real' ? 3 : 1;

  const det = buildDet(nfeData.items || [], { crt });
  const total = buildICMSTot(det);
  const totalValue = nfeData.total_value !== undefined ? Number(nfeData.total_value) : total.vNF;

  let dest;
  if (nfeData.selfDest) {
    // 25/05/2026: NF-e 55 devolução varejo a consumidor final —
    // destinatário = a própria loja emitente.
    dest = buildSelfDest(company);
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
        tpNF: nfeData.tpNF,
        finNFe: nfeData.finNFe,
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
      infAdic: buildInfAdic({ observacoes: nfeData.observacoes, infAdFisco: nfeData.infAdFisco }),
    },
  };

  if (!body.infNFe.infAdic) delete body.infNFe.infAdic;

  if (nfeData.refNFe) {
    const cleanRef = String(nfeData.refNFe).replace(/\D/g, '');
    if (cleanRef.length === 44) {
      body.infNFe.NFref = [{ refNFe: cleanRef }];
    } else {
      console.warn('[nuvemfiscal] emitNfe: refNFe ignorada — esperado 44 dígitos, recebido', cleanRef.length);
    }
  }

  return nuvemRequest('POST', '/nfe', body);
}

async function queryNfe(nfeId)              { return nuvemRequest('GET',  `/nfe/${nfeId}`); }
async function cancelNfe(nfeId, justificativa) {
  return nuvemRequest('POST', `/nfe/${nfeId}/cancelamento`, {
    justificativa: justificativa || 'Cancelamento solicitado pelo emissor',
  });
}

// ============================================================
// emitNfeDevolucao — NF-e modelo 55 de devolução de venda varejo
//
// Fonte: FAQ SEFAZ-MG NFC-e item 7 (regra nacional NT 2018.005 / MOC NF-e).
//
// Em devolução de venda feita a consumidor final via NFC-e:
//   - dest = PRÓPRIO EMITENTE (mesma loja, mesmo CNPJ)
//   - natOp = literal "devolução de mercadoria adquirida por não contribuinte"
//   - refNFe = chave 44 dígitos da NFC-e original
//   - CFOP = 1.202 (devolução de venda mesma UF — contador OK)
//   - CSOSN = 102 (Simples Nacional sem permissão de crédito — default buildDet)
//   - tpNF = 0 (entrada), finNFe = 4 (devolução)
//   - Dados do consumidor (nome, CPF, motivo) vão em infAdFisco texto livre,
//     todos opcionais. NFC-e anônima (sem CPF) é caso suportado.
//
// Histórico: até 24/05/2026 essa função exigia CPF e endereço completo
// do cliente — atrito artificial que não vinha da SEFAZ. Removido.
// ============================================================
async function emitNfeDevolucao(company, params) {
  const {
    originalChave,    // string 44 dígitos — chave da NFC-e original
    items,            // array de items pra devolução
    consumerInfo,     // { name?, cpf?, motivo? } — tudo opcional
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

  // CFOP 1.202 default — contador confirmou 12/05/2026, não alterar.
  const enrichedItems = items.map(item => ({
    ...item,
    cfop: item.cfop || '1202',
  }));

  // infAdFisco: SEFAZ exige dados do consumidor em texto livre quando
  // dest = próprio emitente. Anônima (sem CPF) é OK.
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
    tpNF: 0,            // entrada
    finNFe: 4,          // devolução
    refNFe: cleanChave, // referência à NFC-e original
    indFinal: 1,
    indPres: 1,
    idDest: 1,          // operação interna
    items: enrichedItems,
    selfDest: true,     // dest = própria loja (SEFAZ FAQ MG #7)
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
  buildInfAdic, resolvePagInput,
  registerCompany, uploadCertificate,
  emitNfce, queryNfce, cancelNfce,
  emitNfe,  queryNfe,  cancelNfe,
  emitNfeDevolucao,
  emitNfse, queryNfse, cancelNfse,
};
