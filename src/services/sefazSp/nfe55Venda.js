// ============================================================
// AURA. — sefazSp/nfe55Venda: NF-e modelo 55 de VENDA pela emissão própria
// (SEFAZ direto). 14/11/2026 — CP2a.
//
// Irmã da devolução (sefazSp/nfe55.js): mesmos endpoints da 55 por UF,
// mesmo certificado A1 (sem CSC, sem QR Code, sem infNFeSupl), mesmo envio
// síncrono (indSinc=1) e a mesma regra de ouro do timeout ambíguo: consulta
// pela chave ANTES de qualquer outra coisa e nunca renumera.
//
// O que muda vs. a devolução:
//   • tpNF=1 (saída), finNFe=1 (normal), idDest 1 (mesma UF) | 2 (outra UF)
//   • indFinal 0 (destinatário contribuinte com IE) | 1 (os demais)
//   • dest = o CLIENTE da venda (CPF/CNPJ, nome, enderDest completo,
//     indIEDest 1|2|9 e IE quando 1). Homologação: xNome literal da SEFAZ.
//   • CFOP por item pelo destino (taxEngine.cfopVenda55): 5102/5405 na
//     mesma UF, 6102/6404 fora dela
//   • frete rateado no vFrete dos itens (xmlBuilder) + <transp> com
//     modFrete 0|1|2|3|4|9 e transportadora opcional
//   • pag = os pagamentos reais da venda (buildPagXml, indPag do crediário)
//   • infAdic: observações + texto do Simples Nacional
//   • infRespTec quando os dados da Aura estão configurados (respTec.js)
//
// Fora do v1 (quem chama barra antes, com texto gentil): regime normal
// (CRT 3), DIFAL (outra UF + não contribuinte), exterior (idDest=3),
// contingência (SVC/EPEC), cobr/duplicatas.
// ============================================================
'use strict';

const {
  buildEmitXml, buildDetXml, buildTotalXml, buildPagXml, buildInfAdicXml,
  buildInfRespTecXml, composeNfe, tag, txt, round2, HOMOLOG_DEST_XNOME,
} = require('./xmlBuilder');
const { signInfNfe } = require('./signer');
const { openPfx, assertValidity } = require('./pfx');
const { loadCertificate } = require('./certStore');
const soap = require('./soapClient');
const { getEndpoints55 } = require('./nfe55');
const { loadRespTec } = require('./respTec');
const { cfopVenda55 } = require('./taxEngine');
const {
  ufToCodigo, isoBR, generateCNF, buildAccessKey44,
} = require('./nfeHelpers');

function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

const NATOP_PADRAO = 'Venda de mercadoria';

// Texto do Simples Nacional no infCpl (LC 123/2006, art. 23; Resolução
// CGSN 140/2018, art. 59). CSOSN 102 = sem permissão de crédito de ICMS.
const TEXTO_SIMPLES = {
  1: 'Documento emitido por ME ou EPP optante pelo Simples Nacional. Nao gera direito a credito fiscal de IPI.',
  4: 'Documento emitido por MEI optante pelo Simples Nacional (SIMEI). Nao gera direito a credito fiscal de IPI.',
};

const MOD_FRETE_VALIDOS = ['0', '1', '2', '3', '4', '9'];
const IND_PRES_VALIDOS = ['0', '1', '2', '3', '4', '5', '9'];

function crtDaEmpresa(company) {
  return company.tax_regime === 'mei' ? 4
    : (company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real') ? 3 : 1;
}

/**
 * ide da 55 de venda. Ordem TIde (leiauteNFe_v4.00): cUF, cNF, natOp, mod,
 * serie, nNF, dhEmi, [dhSaiEnt, dPrevEntrega], tpNF, idDest, cMunFG,
 * [cMunFGIBS], tpImp, tpEmis, cDV, tpAmb, finNFe, [tpNFDebito,
 * tpNFCredito], indFinal, indPres, [indIntermed], procEmi, verProc.
 * indIntermed só nas vendas não presenciais (indPres 2/3/4/9): 0 = sem
 * intermediador (venda no próprio canal da loja).
 */
function buildIde55VendaXml(p) {
  const naoPresencial = ['2', '3', '4', '9'].includes(String(p.indPres));
  return '<ide>'
    + tag('cUF', p.cUF)
    + tag('cNF', p.cNF)
    + tag('natOp', p.natOp)
    + tag('mod', '55')
    + tag('serie', p.serie)
    + tag('nNF', p.nNF)
    + tag('dhEmi', p.dhEmi)
    + tag('tpNF', '1')            // 1 = saída
    + tag('idDest', p.idDest)
    + tag('cMunFG', p.cMunFG)
    + tag('tpImp', '1')           // DANFE retrato
    + tag('tpEmis', '1')
    + tag('cDV', p.cDV)
    + tag('tpAmb', p.tpAmb)
    + tag('finNFe', '1')          // 1 = NF-e normal
    + tag('indFinal', p.indFinal)
    + tag('indPres', p.indPres)
    + (naoPresencial ? tag('indIntermed', '0') : '')
    + tag('procEmi', '0')
    + tag('verProc', p.verProc || 'Aura/1.0')
    + '</ide>';
}

/**
 * dest = cliente da venda. Ordem TDest: CNPJ|CPF, xNome, enderDest,
 * indIEDest, IE, ISUF, IM, email. enderDest (TEndereco): xLgr, nro, xCpl,
 * xBairro, cMun, xMun, UF, CEP, cPais, xPais, fone.
 * Homologação: xNome = literal obrigatório (regra da SEFAZ).
 */
function buildDest55VendaXml(dest, tpAmb) {
  const cnpj = onlyDigits(dest.cnpj);
  const cpf = onlyDigits(dest.cpf);
  if (!cnpj && !cpf) throw new Error('nfe55Venda: destinatário sem CPF/CNPJ');
  const e = dest.endereco || {};
  const ind = String(dest.indIEDest);
  if (!['1', '2', '9'].includes(ind)) throw new Error(`nfe55Venda: indIEDest inválido (${dest.indIEDest})`);
  const ie = onlyDigits(dest.ie);
  if (ind === '1' && !ie) throw new Error('nfe55Venda: indIEDest=1 exige a IE do destinatário');
  const xNome = Number(tpAmb) === 2 ? HOMOLOG_DEST_XNOME : txt(dest.nome, 60);
  const email = String(dest.email || '').trim().slice(0, 60);
  return '<dest>'
    + (cnpj ? tag('CNPJ', cnpj) : tag('CPF', cpf))
    + tag('xNome', xNome)
    + '<enderDest>'
    + tag('xLgr', txt(e.logradouro, 60))
    + tag('nro', txt(e.numero, 60) || 'S/N')
    + (txt(e.complemento) ? tag('xCpl', txt(e.complemento, 60)) : '')
    + tag('xBairro', txt(e.bairro, 60))
    + tag('cMun', onlyDigits(e.codigo_municipio))
    + tag('xMun', txt(e.municipio, 60))
    + tag('UF', String(e.uf || '').toUpperCase())
    + (onlyDigits(e.cep) ? tag('CEP', onlyDigits(e.cep)) : '')
    + tag('cPais', '1058')
    + tag('xPais', 'Brasil')
    + (onlyDigits(e.fone).length >= 6 ? tag('fone', onlyDigits(e.fone).slice(0, 14)) : '')
    + '</enderDest>'
    + tag('indIEDest', ind)
    + (ind === '1' ? tag('IE', ie) : '')
    + (email ? tag('email', email) : '')
    + '</dest>';
}

/**
 * transp: modFrete + transportadora opcional. Ordem: modFrete, transporta
 * (CNPJ|CPF, xNome, IE, xEnder, xMun, UF).
 */
function buildTransp55VendaXml(frete) {
  const f = frete || {};
  const mod = String(f.modalidade == null ? '9' : f.modalidade);
  if (!MOD_FRETE_VALIDOS.includes(mod)) throw new Error(`nfe55Venda: modFrete inválido (${f.modalidade})`);
  const t = f.transportadora;
  let transporta = '';
  if (t && (t.documento || t.nome)) {
    const doc = onlyDigits(t.documento);
    const ie = String(t.ie || '').trim().toUpperCase() === 'ISENTO' ? 'ISENTO' : onlyDigits(t.ie);
    transporta = '<transporta>'
      + (doc.length === 14 ? tag('CNPJ', doc) : doc.length === 11 ? tag('CPF', doc) : '')
      + (txt(t.nome) ? tag('xNome', txt(t.nome, 60)) : '')
      + (ie ? tag('IE', ie) : '')
      + (txt(t.endereco) ? tag('xEnder', txt(t.endereco, 60)) : '')
      + (txt(t.municipio) ? tag('xMun', txt(t.municipio, 60)) : '')
      + (t.uf ? tag('UF', String(t.uf).toUpperCase()) : '')
      + '</transporta>';
  }
  return '<transp>' + tag('modFrete', mod) + transporta + '</transp>';
}

/**
 * Monta o infNFe da 55 de venda SEM assinatura.
 * @param company — linha de companies (mesma shape do /nfce/emit)
 * @param nfeData — { items[], dest, payments[], serie, numero,
 *                    natureza_operacao?, indPres?, indFinal?, frete?,
 *                    observacoes? }
 *   items[i]: { code, name, ncm, cest?, unit, quantity, price, discount?,
 *               freight?, barcode?, csosn, orig, pisCst, cofinsCst, cfop? }
 *   dest: { cpf|cnpj, nome, ie?, indIEDest, email?, endereco{logradouro,
 *           numero, complemento, bairro, codigo_municipio, municipio, uf,
 *           cep, fone} }
 * @param opts — { tpAmb: 1|2, cNF?, dhEmi?, verProc?, respTec? }
 * @returns { infNfeXml, chave, cNF, dhEmi, tpAmb, tpEmis, idDest, indFinal, items }
 */
function buildInfNfe55Venda(company, nfeData, opts = {}) {
  const tpAmb = Number(opts.tpAmb);
  if (tpAmb !== 1 && tpAmb !== 2) throw new Error('nfe55Venda: tpAmb obrigatório (1=produção, 2=homologação)');
  if (!Array.isArray(nfeData.items) || nfeData.items.length === 0) throw new Error('nfe55Venda: items obrigatórios');
  if (!nfeData.dest) throw new Error('nfe55Venda: destinatário obrigatório');
  const serie = Number(nfeData.serie);
  if (!Number.isInteger(serie) || serie < 0 || serie > 999) throw new Error('nfe55Venda: série inválida');
  const nNF = Number(nfeData.numero);
  if (!Number.isInteger(nNF) || nNF < 1) throw new Error('nfe55Venda: numero (nNF) inválido');

  const crt = crtDaEmpresa(company);
  if (crt === 3) throw new Error('nfe55Venda: regime normal (CRT 3) fora do v1');

  const ufEmit = String(company.address_state || 'SP').toUpperCase();
  const ufDest = String((nfeData.dest.endereco || {}).uf || '').toUpperCase();
  if (!ufDest) throw new Error('nfe55Venda: UF do destinatário obrigatória');
  if (ufDest === 'EX') throw new Error('nfe55Venda: operação com exterior (idDest=3) fora do v1');
  const interestadual = ufDest !== ufEmit;
  const idDest = interestadual ? '2' : '1';
  const indIEDest = String(nfeData.dest.indIEDest);
  const indFinal = nfeData.indFinal != null
    ? String(Number(nfeData.indFinal) ? 1 : 0)
    : (indIEDest === '1' ? '0' : '1');
  if (interestadual && indIEDest === '9') {
    throw new Error('nfe55Venda: DIFAL (outra UF + não contribuinte) fora do v1');
  }
  const indPres = String(nfeData.indPres == null ? '1' : nfeData.indPres);
  if (!IND_PRES_VALIDOS.includes(indPres)) throw new Error(`nfe55Venda: indPres inválido (${nfeData.indPres})`);

  const dhEmi = opts.dhEmi || isoBR();
  const cNF = opts.cNF || generateCNF();
  if (!/^\d{8}$/.test(String(cNF))) throw new Error('nfe55Venda: cNF deve ter 8 dígitos');
  const cUF = ufToCodigo(company.address_state);
  const cnpj = onlyDigits(company.cnpj);

  const chave = buildAccessKey44({
    cUF, ano2: dhEmi.slice(2, 4), mes2: dhEmi.slice(5, 7),
    cnpj, mod: 55, serie, nNF, tpEmis: 1, cNF,
  });
  const cDV = chave.slice(-1);

  // CFOP pelo destino; CFOP explícito no item vence (ajuste fino).
  const items = nfeData.items.map((it) => ({
    ...it,
    cfop: it.cfop || cfopVenda55(it.csosn || '102', { interestadual }),
  }));

  const vNF = round2(items.reduce((s, it) =>
    s + round2(Number(it.quantity || 1) * Number(it.price || 0))
      - (Number(it.discount) || 0) + (Number(it.freight) || 0), 0));

  const obs = [txt(nfeData.observacoes, 4000), TEXTO_SIMPLES[crt]].filter(Boolean).join(' | ');

  const infNfeXml = `<infNFe Id="NFe${chave}" versao="4.00">`
    + buildIde55VendaXml({
        cUF: String(cUF), cNF,
        natOp: txt(nfeData.natureza_operacao, 60) || NATOP_PADRAO,
        serie: String(serie), nNF: String(nNF), dhEmi,
        idDest, cMunFG: onlyDigits(company.ibge_code),
        cDV, tpAmb: String(tpAmb), indFinal, indPres,
        verProc: opts.verProc,
      })
    + buildEmitXml(company)
    + buildDest55VendaXml(nfeData.dest, tpAmb)
    + buildDetXml(items, { crt, tpAmb })
    + buildTotalXml(items, { crt, tpAmb })
    + buildTransp55VendaXml(nfeData.frete)
    + buildPagXml(nfeData.payments, vNF)
    + buildInfAdicXml({ observacoes: obs })
    + buildInfRespTecXml(opts.respTec)
    + '</infNFe>';

  return { infNfeXml, chave, cNF: String(cNF), dhEmi, tpAmb, tpEmis: 1, idDest, indFinal, items, vNF };
}

function resolveTpAmb(config) {
  return config && config.ambiente === 'producao' ? 1 : 2;
}

/**
 * Emite a NF-e 55 de venda na SEFAZ (síncrona, indSinc=1).
 * @param ctx — { db, config, transport?, cNF?, dhEmi?, onBeforeTransmit? }
 *   cNF: reaproveita o código numérico de uma tentativa anterior com o
 *        MESMO número (mesma chave no mesmo mês — sem 539).
 *   onBeforeTransmit({chave, xml_signed, cNF, dhEmi}): chamado depois de
 *        assinar e ANTES de enviar — a rota grava a chave real e o XML, de
 *        modo que uma queda no meio do envio deixa como conferir depois.
 * @returns { status: 'autorizado'|'rejeitado'|'processando'|'nao_consta',
 *            chave_acesso, protocolo, codigo_status, motivo_status,
 *            xml_signed, cNF, ambiguous, provider }
 *   'nao_consta' = timeout ambíguo e a consulta confirmou que a nota NÃO
 *   está na base (217): seguro reenviar com o mesmo número.
 *   'processando' = timeout ambíguo e nem a consulta respondeu: NÃO é
 *   seguro reenviar sem consultar de novo.
 */
async function emitNfeVenda55(company, nfeData, ctx) {
  const { db, config } = ctx || {};
  if (!db || !config) throw new Error('sefazSp.emitNfeVenda55: ctx {db, config} obrigatório');
  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints55(config.uf || company.address_state || 'SP', tpAmb);
  const respTec = loadRespTec();

  const { pfx, password } = await loadCertificate(db, company.id);
  const cert = openPfx(pfx, password);
  assertValidity(cert);

  const built = buildInfNfe55Venda(company, nfeData, {
    tpAmb, cNF: ctx.cNF, dhEmi: ctx.dhEmi, respTec,
  });
  const { signatureXml } = signInfNfe(built.infNfeXml, {
    keyPem: cert.keyPem, certDerBase64: cert.certDerBase64,
  });
  const nfeXml = composeNfe({ signedInfNfeXml: built.infNfeXml, infNfeSuplXml: '', signatureXml });

  if (typeof ctx.onBeforeTransmit === 'function') {
    await ctx.onBeforeTransmit({ chave: built.chave, xml_signed: nfeXml, cNF: built.cNF, dhEmi: built.dhEmi });
  }

  const base = {
    id: null, chave_acesso: built.chave, xml_signed: nfeXml, cNF: built.cNF,
    tp_emis: 1, provider: 'sefaz_sp', ambiguous: false,
  };

  let result;
  try {
    result = await soap.autorizar({
      signedNfeXml: nfeXml, idLote: String(nfeData.numero), tpAmb, endpoints,
      pfx, passphrase: password, transport: ctx.transport,
    });
  } catch (err) {
    if (!(err instanceof soap.SefazTransportError && err.ambiguous)) throw err;
    // Timeout ambíguo: pode ter autorizado. Consulta pela chave; nunca renumera.
    let consulta;
    try {
      consulta = await soap.consultarChave({
        chave: built.chave, tpAmb, endpoints, pfx, passphrase: password, transport: ctx.transport,
      });
    } catch (_) {
      return {
        ...base, ambiguous: true, status: 'processando', protocolo: null, codigo_status: null,
        motivo_status: 'A SEFAZ nao respondeu a tempo e a consulta tambem nao respondeu. '
          + 'A nota pode ter sido autorizada: tente de novo em instantes (o numero e a chave sao os mesmos).',
      };
    }
    if (consulta.autorizada) {
      return {
        ...base, ambiguous: true, status: 'autorizado', protocolo: consulta.protocolo || null,
        codigo_status: consulta.cStat, motivo_status: consulta.xMotivo || null,
      };
    }
    return {
      ...base, ambiguous: true, status: consulta.naoConsta ? 'nao_consta' : 'processando',
      protocolo: null, codigo_status: consulta.cStat || null,
      motivo_status: 'A SEFAZ nao respondeu a tempo; a consulta pela chave diz que a nota nao foi autorizada '
        + `(cStat ${consulta.cStat}). Pode tentar de novo: o numero e a chave sao os mesmos.`,
    };
  }

  const status = result.autorizada ? 'autorizado' : (result.rejeitada ? 'rejeitado' : 'processando');
  return {
    ...base, status,
    protocolo: result.protocolo || null,
    codigo_status: result.cStat || null,
    motivo_status: result.xMotivo || null,
  };
}

/** Consulta a situação de uma 55 já transmitida (retentativa após timeout). */
async function consultarNfe55({ db, config, companyId, chave, transport }) {
  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints55(config.uf || 'SP', tpAmb);
  const { pfx, password } = await loadCertificate(db, companyId);
  return soap.consultarChave({ chave, tpAmb, endpoints, pfx, passphrase: password, transport });
}

module.exports = {
  buildInfNfe55Venda, buildIde55VendaXml, buildDest55VendaXml, buildTransp55VendaXml,
  emitNfeVenda55, consultarNfe55, resolveTpAmb, crtDaEmpresa,
  NATOP_PADRAO, TEXTO_SIMPLES, MOD_FRETE_VALIDOS,
};
