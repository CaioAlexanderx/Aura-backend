// ============================================================
// AURA. — sefazSp/xmlBuilder: montagem do XML NFC-e (modelo 65, layout 4.00)
// Roadmap NFC-e própria v1 — S1.2.
//
// CONTRATO: consome o MESMO payload que os gateways (company resolvida por
// routes/nfce.js + nfceData {items, payments, serie, numero, ...}) — paridade
// byte-a-byte de semântica com nuvemfiscal.emitNfce (shadow-mode S2.6 diffa).
//
// Reusa de services/nuvemfiscal (funções puras, sem I/O):
//   ufToCodigo, isoBR, generateCNF, buildAccessKey44, validateTpag.
//
// Ordem dos elementos segue o XSD leiauteNFe_v4.00 (a ordem IMPORTA:
// elemento fora de ordem = rejeição 215/225). Nenhuma tag vazia é emitida.
//
// Saída: infNFe SEM assinatura (signer S1.3 assina; qrcode S1.5 monta
// infNFeSupl; composeNfe junta tudo).
// ============================================================
'use strict';

const {
  ufToCodigo, isoBR, generateCNF, buildAccessKey44, validateTpag,
} = require('../nuvemfiscal');

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

// Razão social obrigatória no dest em homologação (rejeição 703).
const HOMOLOG_DEST_XNOME =
  'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

// ---------- helpers ----------

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Sanitiza texto p/ campos livres (xProd/xNome/infCpl/...): colapsa
 * espaços e restringe ao charset do schema TString ([ -\u00FF], Latin-1).
 * Travessão/aspas tipográficas/reticências viram equivalente ASCII; o resto
 * fora do Latin-1 (emoji etc.) é removido — senão a SEFAZ devolve
 * Rejeição 225 (Falha no Schema XML). Caso real: 16/07, "—" no xFant. */
const TXT_MAP = {
  '\u2013': '-', '\u2014': '-',            // en/em dash
  '\u2018': "'", '\u2019': "'",            // aspas simples tipográficas
  '\u201C': '"', '\u201D': '"',            // aspas duplas tipográficas
  '\u2026': '...', '\u00A0': ' ',          // reticências, nbsp
  '\u2022': '-', '\u2122': 'TM',           // bullet, trademark
};
function txt(s, max) {
  const clean = String(s || '')
    .replace(/[\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u00A0\u2022\u2122]/g, (ch) => TXT_MAP[ch])
    .replace(/[^\u0020-\u00FF]/g, '')
    .replace(/\s+/g, ' ').trim();
  return max ? clean.slice(0, max) : clean;
}

function tag(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<${name}>${esc(value)}</${name}>`;
}

/** Valor monetário/total: sempre 2 casas (TDec_1302). */
function fmt2(n) {
  const v = Number(n);
  if (!isFinite(v)) throw new Error(`xmlBuilder: número inválido (${n})`);
  return v.toFixed(2);
}

/** Quantidade comercial (TDec_1104v): até 4 casas, mínimo inteiro. */
function fmtQty(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) throw new Error(`xmlBuilder: quantidade inválida (${n})`);
  return v.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Valor unitário (TDec_1110v): até 10 casas, mínimo 2. */
function fmtUnit(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) throw new Error(`xmlBuilder: preço unitário inválido (${n})`);
  let s = v.toFixed(10).replace(/0+$/, '');
  const [, dec = ''] = s.split('.');
  if (dec.length < 2) s = v.toFixed(2);
  return s.replace(/\.$/, '.00');
}

function round2(n) { return Math.round(n * 100) / 100; }

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

// ---------- blocos ----------

function buildIdeXml(p) {
  // Ordem XSD: cUF,cNF,natOp,mod,serie,nNF,dhEmi,tpNF,idDest,cMunFG,tpImp,
  // tpEmis,cDV,tpAmb,finNFe,indFinal,indPres,procEmi,verProc[,dhCont,xJust]
  return '<ide>'
    + tag('cUF', p.cUF)
    + tag('cNF', p.cNF)
    + tag('natOp', p.natOp)
    + tag('mod', '65')
    + tag('serie', p.serie)
    + tag('nNF', p.nNF)
    + tag('dhEmi', p.dhEmi)
    + tag('tpNF', '1')
    + tag('idDest', '1')
    + tag('cMunFG', p.cMunFG)
    + tag('tpImp', '4')          // DANFE NFC-e
    + tag('tpEmis', p.tpEmis)
    + tag('cDV', p.cDV)
    + tag('tpAmb', p.tpAmb)
    + tag('finNFe', '1')
    + tag('indFinal', '1')
    + tag('indPres', '1')
    + tag('procEmi', '0')
    + tag('verProc', p.verProc || 'Aura/1.0')
    + (Number(p.tpEmis) === 9
        ? tag('dhCont', p.dhCont) + tag('xJust', p.xJust)
        : '')
    + '</ide>';
}

function buildEmitXml(company) {
  const cnpj = onlyDigits(company.cnpj);
  if (cnpj.length !== 14) throw new Error('xmlBuilder: CNPJ do emitente inválido');
  const ie = onlyDigits(company.inscricao_estadual);
  if (!ie) throw new Error('xmlBuilder: IE do emitente obrigatória');
  if (!company.ibge_code) throw new Error('xmlBuilder: ibge_code (cMun) do emitente obrigatório');

  const crt = company.tax_regime === 'mei' ? 4
    : (company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real') ? 3 : 1;

  return '<emit>'
    + tag('CNPJ', cnpj)
    + tag('xNome', txt(company.legal_name || company.trade_name, 60))
    + (company.trade_name ? tag('xFant', txt(company.trade_name, 60)) : '')
    + '<enderEmit>'
    + tag('xLgr', txt(company.address_street, 60) || 'Nao informado')
    + tag('nro', txt(company.address_number, 60) || 'S/N')
    + tag('xBairro', txt(company.address_neighborhood, 60) || 'Centro')
    + tag('cMun', onlyDigits(company.ibge_code))
    + tag('xMun', txt(company.address_city, 60))
    + tag('UF', String(company.address_state || 'SP').toUpperCase())
    + tag('CEP', onlyDigits(company.address_zip))
    + tag('cPais', '1058')
    + tag('xPais', 'Brasil')
    + (onlyDigits(company.phone) ? tag('fone', onlyDigits(company.phone)) : '')
    + '</enderEmit>'
    + tag('IE', ie)
    + tag('CRT', crt)
    + '</emit>';
}

function buildDestXml({ cpf, cnpj, name }, tpAmb) {
  const cpfClean = onlyDigits(cpf);
  const cnpjClean = onlyDigits(cnpj);
  if (!cpfClean && !cnpjClean) return ''; // consumidor não identificado
  const xNome = Number(tpAmb) === 2
    ? HOMOLOG_DEST_XNOME
    : txt(name, 60) || 'CONSUMIDOR';
  return '<dest>'
    + (cnpjClean ? tag('CNPJ', cnpjClean) : tag('CPF', cpfClean))
    + tag('xNome', xNome)
    + tag('indIEDest', '9')
    + '</dest>';
}

// Homologação (tpAmb=2): a SEFAZ exige que a descrição do PRIMEIRO item
// seja exatamente este literal (Rejeição 373 caso contrário; caso real
// 16/07 no smoke). Vale só pro xProd do item 1 — os demais ficam reais.
const XPROD_HOMOLOG = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

function buildDetXml(items, { crt, tpAmb }) {
  const isSimples = crt === 1 || crt === 4;
  return items.map((item, i) => {
    const qty = Number(item.quantity || 1);
    const price = Number(item.price || 0);
    const total = round2(qty * price);
    const ncm = onlyDigits(item.ncm) || '00000000';
    if (ncm !== '00000000' && ncm.length !== 8) {
      throw new Error(`xmlBuilder: NCM inválido no item ${i + 1} ("${item.ncm}") — esperado 8 dígitos`);
    }
    const ean = (item.barcode && /^\d{8,14}$/.test(onlyDigits(item.barcode)))
      ? onlyDigits(item.barcode) : 'SEM GTIN';

    // S3.2: CSOSN por item (taxEngine resolve via products.tax_profile).
    // Grupos do XSD: 102/103/300/400→ICMSSN102 · 500→ICMSSN500 · 900→ICMSSN900.
    let icms;
    if (isSimples) {
      const csosn = String(item.csosn || '102');
      const orig = String(item.orig || '0');
      const group = ['102', '103', '300', '400'].includes(csosn) ? 'ICMSSN102'
        : csosn === '500' ? 'ICMSSN500'
        : csosn === '900' ? 'ICMSSN900' : null;
      if (!group) throw new Error(`xmlBuilder: CSOSN não suportado no item ${i + 1} (${csosn})`);
      icms = `<ICMS><${group}>` + tag('orig', orig) + tag('CSOSN', csosn) + `</${group}></ICMS>`;
    } else {
      icms = '<ICMS><ICMS00>' + tag('orig', '0') + tag('CST', '00') + tag('modBC', '3')
        + tag('vBC', fmt2(total)) + tag('pICMS', '0.00') + tag('vICMS', '0.00')
        + '</ICMS00></ICMS>';
    }

    return `<det nItem="${i + 1}">`
      + '<prod>'
      + tag('cProd', txt(item.code || item.product_id || String(i + 1), 60))
      + tag('cEAN', ean)
      + tag('xProd', (Number(tpAmb) === 2 && i === 0)
          ? XPROD_HOMOLOG
          : txt(item.name || item.description || `Item ${i + 1}`, 120))
      + tag('NCM', ncm)
      + tag('CFOP', item.cfop || '5102')
      + tag('uCom', txt(item.unit, 6) || 'UN')
      + tag('qCom', fmtQty(qty))
      + tag('vUnCom', fmtUnit(price))
      + tag('vProd', fmt2(total))
      + tag('cEANTrib', ean)
      + tag('uTrib', txt(item.unit, 6) || 'UN')
      + tag('qTrib', fmtQty(qty))
      + tag('vUnTrib', fmtUnit(price))
      + (Number(item.discount) > 0 ? tag('vDesc', fmt2(item.discount)) : '')
      + tag('indTot', '1')
      + '</prod>'
      + '<imposto>'
      + icms
      + buildPisCofinsXml('PIS', item.pisCst)
      + buildPisCofinsXml('COFINS', item.cofinsCst)
      + '</imposto>'
      + '</det>';
  }).join('');
}

/** PIS/COFINS varejo: CST 07 → grupo NT; demais (49/99) → grupo Outr zerado. */
function buildPisCofinsXml(tributo, cst) {
  const c = String(cst || '07');
  const low = tributo === 'PIS' ? 'PIS' : 'COFINS';
  if (c === '07') {
    return `<${low}><${low}NT>` + tag('CST', '07') + `</${low}NT></${low}>`;
  }
  const aliqTag = tributo === 'PIS' ? 'pPIS' : 'pCOFINS';
  const valTag = tributo === 'PIS' ? 'vPIS' : 'vCOFINS';
  return `<${low}><${low}Outr>` + tag('CST', c)
    + tag('vBC', '0.00') + tag(aliqTag, '0.00') + tag(valTag, '0.00')
    + `</${low}Outr></${low}>`;
}

function buildTotalXml(items) {
  let vProd = 0, vDesc = 0;
  for (const it of items) {
    vProd += round2(Number(it.quantity || 1) * Number(it.price || 0));
    vDesc += Number(it.discount) || 0;
  }
  vProd = round2(vProd); vDesc = round2(vDesc);
  const vNF = round2(vProd - vDesc);
  // Ordem XSD ICMSTot
  return '<total><ICMSTot>'
    + tag('vBC', '0.00') + tag('vICMS', '0.00') + tag('vICMSDeson', '0.00')
    + tag('vFCP', '0.00')
    + tag('vBCST', '0.00') + tag('vST', '0.00') + tag('vFCPST', '0.00') + tag('vFCPSTRet', '0.00')
    + tag('vProd', fmt2(vProd))
    + tag('vFrete', '0.00') + tag('vSeg', '0.00') + tag('vDesc', fmt2(vDesc))
    + tag('vII', '0.00') + tag('vIPI', '0.00') + tag('vIPIDevol', '0.00')
    + tag('vPIS', '0.00') + tag('vCOFINS', '0.00')
    + tag('vOutro', '0.00')
    + tag('vNF', fmt2(vNF))
    + '</ICMSTot></total>';
}

function buildPagXml(payments, totalFallback) {
  const list = (Array.isArray(payments) && payments.length)
    ? payments
    : [{ method: '01', value: totalFallback }];

  let troco = 0;
  const det = list.map((p) => {
    let tPag = validateTpag(p.method);
    let xPag = null;
    if (tPag === '17') { tPag = '99'; xPag = 'PIX'; } // paridade c/ gateway (SP aceita 17; manter contrato até shadow-mode dizer o contrário)
    if (tPag === '99' && !xPag) xPag = 'Outros';
    troco += Number(p.change) || 0;
    // Ordem TDetPag: indPag, tPag, xPag, vPag, card
    return '<detPag>'
      + tag('indPag', p.indPag === undefined ? '0' : String(p.indPag))
      + tag('tPag', tPag)
      + (xPag ? tag('xPag', xPag) : '')
      + tag('vPag', fmt2(p.value))
      + (tPag === '03' || tPag === '04'
          ? '<card>' + tag('tpIntegra', '2') + '</card>'
          : '')
      + '</detPag>';
  }).join('');

  return '<pag>' + det + (troco > 0 ? tag('vTroco', fmt2(troco)) : '') + '</pag>';
}

function buildInfAdicXml({ observacoes, infAdFisco }) {
  if (!observacoes && !infAdFisco) return '';
  return '<infAdic>'
    + (infAdFisco ? tag('infAdFisco', txt(infAdFisco, 2000)) : '')
    + (observacoes ? tag('infCpl', txt(observacoes, 5000)) : '')
    + '</infAdic>';
}

// ---------- API principal ----------

/**
 * Monta o infNFe (modelo 65) SEM assinatura.
 * @param company  — mesma shape que routes/nfce.js resolve p/ os gateways
 * @param nfceData — { items[], payments[]?, total_value, serie, numero,
 *                     recipient_cpf?, recipient_cnpj?, recipient_name?,
 *                     observacoes?, natureza_operacao? }
 * @param opts     — { tpAmb: 1|2, tpEmis: 1|9, cNF?, dhEmi?,
 *                     dhCont?, xJust? (contingência), verProc? }
 * @returns { infNfeXml, chave, cNF, dhEmi, tpAmb, tpEmis }
 */
function buildInfNfe(company, nfceData, opts = {}) {
  const tpAmb = Number(opts.tpAmb);
  if (tpAmb !== 1 && tpAmb !== 2) throw new Error('xmlBuilder: tpAmb obrigatório (1=produção, 2=homologação)');
  const tpEmis = Number(opts.tpEmis || 1);
  if (tpEmis !== 1 && tpEmis !== 9) throw new Error('xmlBuilder: tpEmis deve ser 1 (normal) ou 9 (contingência offline)');
  if (tpEmis === 9 && (!opts.dhCont || !opts.xJust)) {
    throw new Error('xmlBuilder: contingência (tpEmis=9) exige dhCont e xJust');
  }
  if (!Array.isArray(nfceData.items) || nfceData.items.length === 0) {
    throw new Error('xmlBuilder: items obrigatórios');
  }
  const serie = Number(nfceData.serie || 1);
  const nNF = Number(nfceData.numero);
  if (!Number.isInteger(nNF) || nNF < 1) throw new Error('xmlBuilder: numero (nNF) inválido');

  const dhEmi = opts.dhEmi || isoBR();
  const cNF = opts.cNF || generateCNF();
  const cUF = ufToCodigo(company.address_state);
  const cnpj = onlyDigits(company.cnpj);

  const chave = buildAccessKey44({
    cUF, ano2: dhEmi.slice(2, 4), mes2: dhEmi.slice(5, 7),
    cnpj, mod: 65, serie, nNF, tpEmis, cNF,
  });
  const cDV = chave.slice(-1);

  const crt = company.tax_regime === 'mei' ? 4
    : (company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real') ? 3 : 1;

  const totalValue = nfceData.total_value !== undefined
    ? Number(nfceData.total_value)
    : nfceData.items.reduce((s, it) => s + round2(Number(it.quantity || 1) * Number(it.price || 0)) - (Number(it.discount) || 0), 0);

  const infNfeXml = `<infNFe xmlns="${NFE_NS}" Id="NFe${chave}" versao="4.00">`
    + buildIdeXml({
        cUF: String(cUF), cNF,
        natOp: txt(nfceData.natureza_operacao, 60) || 'Venda ao consumidor',
        serie: String(serie), nNF: String(nNF), dhEmi,
        cMunFG: onlyDigits(company.ibge_code),
        tpEmis: String(tpEmis), cDV, tpAmb: String(tpAmb),
        verProc: opts.verProc,
        dhCont: opts.dhCont, xJust: opts.xJust ? txt(opts.xJust, 256) : undefined,
      })
    + buildEmitXml(company)
    + buildDestXml({
        cpf: nfceData.recipient_cpf, cnpj: nfceData.recipient_cnpj,
        name: nfceData.recipient_name,
      }, tpAmb)
    + buildDetXml(nfceData.items, { crt, tpAmb })
    + buildTotalXml(nfceData.items)
    + '<transp>' + tag('modFrete', '9') + '</transp>'
    + buildPagXml(nfceData.payments, totalValue)
    + buildInfAdicXml({ observacoes: nfceData.observacoes, infAdFisco: nfceData.infAdFisco })
    + '</infNFe>';

  return { infNfeXml, chave, cNF, dhEmi, tpAmb, tpEmis };
}

/**
 * Compõe o documento <NFe> final: infNFe assinado + infNFeSupl (QR, S1.5)
 * + Signature (S1.3). Ordem do XSD: infNFe, infNFeSupl, Signature.
 */
function composeNfe({ signedInfNfeXml, infNfeSuplXml, signatureXml }) {
  if (!signedInfNfeXml && !signatureXml) throw new Error('composeNfe: infNFe/assinatura obrigatórios');
  // signer pode devolver infNFe+Signature já concatenados (signedInfNfeXml)
  return `<NFe xmlns="${NFE_NS}">`
    + (signedInfNfeXml || '')
    + (infNfeSuplXml || '')
    + (signatureXml || '')
    + '</NFe>';
}

module.exports = {
  buildInfNfe, composeNfe,
  // exporta blocos p/ teste unitário
  buildIdeXml, buildEmitXml, buildDestXml, buildDetXml, buildTotalXml, buildPisCofinsXml,
  buildPagXml, buildInfAdicXml,
  esc, fmt2, fmtQty, fmtUnit,
  XML_HEADER, NFE_NS, HOMOLOG_DEST_XNOME,
};
