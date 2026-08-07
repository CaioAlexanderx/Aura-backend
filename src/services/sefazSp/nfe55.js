// ============================================================
// AURA. — sefazSp/nfe55: emissão PRÓPRIA da NF-e modelo 55 de DEVOLUÇÃO
// (Aura Notas). 03/08/2026 — hotfix: Nuvem Fiscal fora do ar; a devolução
// 55 da troca ainda saía só pelo gateway (S1.6 deixou a 55 de fora).
//
// MESMA interface do gateway (decisão de arquitetura nº 1):
//   emitNfeDevolucao55(company, params, ctx) → shape que
//   trocaDevolucao55.normalizeDfeStatus entende: status ('autorizado'|
//   'rejeitado'|'processando'), chave_acesso, protocolo, codigo_status,
//   motivo_status + extras próprios: xml_signed, tp_emis, provider.
//   params = MESMO payload de nuvemfiscal.emitNfeDevolucao
//   ({originalChave, items, consumerInfo, serie, numero}).
//   ctx = { db, config } (linha de nfce_config) + transport? (testes).
//
// Reusa os blocos exportados do xmlBuilder (emit, det, total, infAdic,
// composeNfe) — o que muda vs. NFC-e 65:
//   • mod=55, tpNF=0 (entrada), finNFe=4, tpImp=1
//   • NFref/refNFe: grupo referenciado NO FINAL da sequência de <ide>,
//     depois de verProc (elemento fora de ordem = Rejeição 215/225 —
//     05/08/2026: era exatamente esse o bug da 1ª devolução real em prod,
//     ver buildIde55Xml)
//   • dest = PRÓPRIO emitente (SEFAZ FAQ MG #7; paridade com
//     nuvemfiscal.buildSelfDest: indIEDest=1 quando há IE)
//   • pag tPag=90 'Sem Pagamento' vPag=0 (Rejeição 871 se for método real)
//   • SEM infNFeSupl/QR Code/CSC (exclusivos do modelo 65) — aptidão da
//     engine pra 55 exige só o A1 vigente, NÃO exige CSC
//   • SEM contingência offline (devolução não trava PDV): timeout ambíguo
//     → consulta por chave; nunca renumera (regra de ouro do soapClient)
//
// Endpoints: NF-e 55 usa host PRÓPRIO por UF (ex.: SP usa
// nfe.fazenda.sp.gov.br — diferente da NFC-e nfce.fazenda.sp.gov.br).
// Mantidos aqui (e não em endpoints.js) pra deixar o hotfix num arquivo
// só; migrar pra endpoints.js quando a engine 55 ganhar mais operações
// (evento/inutilização).
//
// 06/08/2026 — Nuvem Fiscal não existe mais: toda emissão sai pela
// engine própria. Estendido pra AP (NF-e 55 delega autorização à SVRS,
// mesmo padrão da NFC-e 65 — ver endpoints.js).
// ⚠️ Conferir contra a tabela oficial do Portal da NF-e / SVRS na
// primeira homologação real (mesmo checklist do S1.6, agora repetido
// pra AP).
//
// 07/08/2026 — infNFe NÃO declara xmlns próprio: mesmo bug do
// xmlBuilder.js (cStat 587 "Usar somente o namespace padrao da NF-e"),
// já que NFe (composeNfe) e enviNFe (soapClient.js) já declaram.
//
// Memory: [[nfe55-devolucao-dest-proprio-emitente]]
// ============================================================
'use strict';

const {
  buildEmitXml, buildDetXml, buildTotalXml, buildInfAdicXml,
  composeNfe, esc, NFE_NS, HOMOLOG_DEST_XNOME,
} = require('./xmlBuilder');
const { signInfNfe } = require('./signer');
const { openPfx, assertValidity } = require('./pfx');
const { loadCertificate } = require('./certStore');
const soap = require('./soapClient');
const {
  ufToCodigo, isoBR, generateCNF, buildAccessKey44,
} = require('../nuvemfiscal');

// ---------- endpoints NF-e 55 (serviços versão 4.00) ----------

const ENDPOINTS_NFE55 = {
  SP: {
    homologacao: {
      autorizacao:       'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
      retAutorizacao:    'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
      statusServico:     'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
      consultaProtocolo: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
      recepcaoEvento:    'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
      inutilizacao:      'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
    },
    producao: {
      autorizacao:       'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
      retAutorizacao:    'https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
      statusServico:     'https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
      consultaProtocolo: 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
      recepcaoEvento:    'https://nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
      inutilizacao:      'https://nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
    },
  },
  // AP não tem SEFAZ própria — autorização delegada à SVRS (Sefaz Virtual
  // do RS), igual à NFC-e 65 (ver endpoints.js). Fonte: portal oficial
  // SVRS (dfe-portal.svrs.rs.gov.br).
  AP: {
    homologacao: {
      autorizacao:       'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      retAutorizacao:    'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      statusServico:     'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      consultaProtocolo: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      recepcaoEvento:    'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      inutilizacao:      'https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    },
    producao: {
      autorizacao:       'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      retAutorizacao:    'https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      statusServico:     'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      consultaProtocolo: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      recepcaoEvento:    'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      inutilizacao:      'https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    },
  },
};

function getEndpoints55(uf, ambiente) {
  const ufKey = String(uf || 'SP').toUpperCase();
  if (!ENDPOINTS_NFE55[ufKey]) {
    throw new Error(`sefazSp/nfe55: UF ${ufKey} não suportada na emissão própria da NF-e 55. UFs disponíveis: ${Object.keys(ENDPOINTS_NFE55).join(', ')}.`);
  }
  const amb = ambiente === 1 || ambiente === '1' || ambiente === 'producao' ? 'producao'
    : ambiente === 2 || ambiente === '2' || ambiente === 'homologacao' ? 'homologacao'
    : null;
  if (!amb) throw new Error(`sefazSp/nfe55: ambiente inválido (${ambiente})`);
  return ENDPOINTS_NFE55[ufKey][amb];
}

// ---------- helpers (espelham os privados do xmlBuilder) ----------
// tag/txt/onlyDigits não são exportados pelo xmlBuilder; cópia fiel aqui
// (mesma sanitização Latin-1 do TString — caso real 16/07: "—" no xFant
// derrubava com Rejeição 225).

function tag(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<${name}>${esc(value)}</${name}>`;
}

const TXT_MAP = {
  '–': '-', '—': '-',            // en/em dash
  '‘': "'", '’': "'",            // aspas simples tipograficas
  '“': '"', '”': '"',            // aspas duplas tipograficas
  '…': '...', ' ': ' ',          // reticencias, nbsp
  '•': '-', '™': 'TM',           // bullet, trademark
};
function txt(s, max) {
  const clean = String(s || '')
    .replace(/[–—‘’“”… •™]/g, (ch) => TXT_MAP[ch])
    .replace(/[^ -ÿ]/g, '')
    .replace(/\s+/g, ' ').trim();
  return max ? clean.slice(0, max) : clean;
}

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

// ---------- blocos específicos do 55 de devolução ----------

/**
 * ide do modelo 55. Ordem TIde (a ordem IMPORTA — 215/225):
 * cUF,cNF,natOp,mod,serie,nNF,dhEmi,tpNF,idDest,cMunFG,tpImp,
 * tpEmis,cDV,tpAmb,finNFe,indFinal,indPres,procEmi,verProc,NFref.
 *
 * NFref é o grupo de Documento Fiscal Referenciado: fica no FINAL da
 * sequência de <ide> (depois de verProc, e de dhCont/xJust quando há
 * contingência) — NÃO logo após cMunFG.
 *
 * 05/08/2026: bug real. Este bloco tinha NFref logo após cMunFG (comentário
 * antigo dizia "posição B12a"), fora de ordem. A 1ª devolução real da engine
 * em prod (troca a5842443-836e-4302-87f2-c55b8768132a, Davi Villa Branca,
 * 04/08 21:35 UTC) foi rejeitada pela SEFAZ-SP com "225 - Rejeição: Falha no
 * Schema XML do lote de NFe" — rejeição genérica de sequence do XSD, não um
 * motivo específico de conteúdo. Confirmado contra o leiauteNFe_v4.00.xsd
 * (nfephp-org/sped-nfe): NFref é o último elemento de TIde. Corrigido movendo
 * o bloco pro fim, depois de verProc.
 */
function buildIde55Xml(p) {
  return '<ide>'
    + tag('cUF', p.cUF)
    + tag('cNF', p.cNF)
    + tag('natOp', p.natOp)
    + tag('mod', '55')
    + tag('serie', p.serie)
    + tag('nNF', p.nNF)
    + tag('dhEmi', p.dhEmi)
    + tag('tpNF', '0')           // 0 = entrada (devolução)
    + tag('idDest', '1')
    + tag('cMunFG', p.cMunFG)
    + tag('tpImp', '1')          // DANFE retrato (tpImp=4 é só NFC-e)
    + tag('tpEmis', '1')
    + tag('cDV', p.cDV)
    + tag('tpAmb', p.tpAmb)
    + tag('finNFe', '4')         // 4 = devolução de mercadoria
    + tag('indFinal', '1')
    + tag('indPres', '1')
    + tag('procEmi', '0')
    + tag('verProc', p.verProc || 'Aura/1.0')
    + (p.refNFe ? '<NFref>' + tag('refNFe', p.refNFe) + '</NFref>' : '')
    + '</ide>';
}

/**
 * dest = PRÓPRIO emitente (devolução de venda a consumidor sem cadastro —
 * SEFAZ FAQ MG #7). Ordem TDest: CNPJ, xNome, enderDest, indIEDest, IE.
 * Paridade com nuvemfiscal.buildSelfDest: indIEDest=1 quando há IE, senão 9.
 * Homologação: xNome = literal obrigatório (Rejeição 703).
 */
function buildDestSelf55Xml(company, tpAmb) {
  const cnpj = onlyDigits(company.cnpj);
  const ie = onlyDigits(company.inscricao_estadual);
  const xNome = Number(tpAmb) === 2
    ? HOMOLOG_DEST_XNOME
    : (txt(company.legal_name || company.trade_name, 60) || 'Emitente');
  return '<dest>'
    + tag('CNPJ', cnpj)
    + tag('xNome', xNome)
    + '<enderDest>'
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
    + '</enderDest>'
    + tag('indIEDest', ie ? '1' : '9')
    + (ie ? tag('IE', ie) : '')
    + '</dest>';
}

/** Devolução não movimenta caixa: tPag=90 'Sem Pagamento', vPag=0 (Rej. 871). */
function buildPagSemPagamentoXml() {
  return '<pag><detPag>' + tag('tPag', '90') + tag('vPag', '0.00') + '</detPag></pag>';
}

/**
 * Monta o infNFe do modelo 55 de devolução SEM assinatura.
 * @param company — mesma shape resolvida pelo trocaDevolucao55 (SELECT * companies)
 * @param nfeData — { items[], refNFe (44 díg.), serie, numero,
 *                    natureza_operacao?, infAdFisco?, observacoes? }
 * @param opts    — { tpAmb: 1|2, cNF?, dhEmi?, verProc? }
 */
function buildInfNfe55Devolucao(company, nfeData, opts = {}) {
  const tpAmb = Number(opts.tpAmb);
  if (tpAmb !== 1 && tpAmb !== 2) throw new Error('nfe55: tpAmb obrigatório (1=produção, 2=homologação)');
  if (!Array.isArray(nfeData.items) || nfeData.items.length === 0) {
    throw new Error('nfe55: items obrigatórios');
  }
  const refNFe = onlyDigits(nfeData.refNFe);
  if (refNFe.length !== 44) {
    throw new Error('nfe55: refNFe deve ter 44 dígitos (chave da NFC-e original)');
  }
  const serie = Number(nfeData.serie || 1);
  const nNF = Number(nfeData.numero);
  if (!Number.isInteger(nNF) || nNF < 1) throw new Error('nfe55: numero (nNF) inválido');

  const dhEmi = opts.dhEmi || isoBR();
  const cNF = opts.cNF || generateCNF();
  const cUF = ufToCodigo(company.address_state);
  const cnpj = onlyDigits(company.cnpj);
  const tpEmis = 1; // sem contingência offline no 55 (devolução não trava PDV)

  const chave = buildAccessKey44({
    cUF, ano2: dhEmi.slice(2, 4), mes2: dhEmi.slice(5, 7),
    cnpj, mod: 55, serie, nNF, tpEmis, cNF,
  });
  const cDV = chave.slice(-1);

  const crt = company.tax_regime === 'mei' ? 4
    : (company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real') ? 3 : 1;

  // CFOP 1.202 + CSOSN 102 (default do buildDetXml no Simples) — Fase C.
  const items = nfeData.items.map((it) => ({ ...it, cfop: it.cfop || '1202' }));

  const infNfeXml = `<infNFe Id="NFe${chave}" versao="4.00">`
    + buildIde55Xml({
        cUF: String(cUF), cNF,
        natOp: txt(nfeData.natureza_operacao, 60) || 'Devolucao de venda',
        serie: String(serie), nNF: String(nNF), dhEmi,
        cMunFG: onlyDigits(company.ibge_code),
        refNFe,
        cDV, tpAmb: String(tpAmb),
        verProc: opts.verProc,
      })
    + buildEmitXml(company)
    + buildDestSelf55Xml(company, tpAmb)
    + buildDetXml(items, { crt, tpAmb })
    + buildTotalXml(items, { crt, tpAmb })
    + '<transp>' + tag('modFrete', '9') + '</transp>'
    + buildPagSemPagamentoXml()
    + buildInfAdicXml({ observacoes: nfeData.observacoes, infAdFisco: nfeData.infAdFisco })
    + '</infNFe>';

  return { infNfeXml, chave, cNF, dhEmi, tpAmb, tpEmis };
}

// ---------- orquestrador ----------

function resolveTpAmb(config) {
  return config.ambiente === 'producao' ? 1 : 2;
}

/**
 * Emite a NF-e 55 de devolução direto na SEFAZ (síncrona, indSinc=1).
 * MESMO payload do gateway (nuvemfiscal.emitNfeDevolucao) + ctx.
 * Timeout ambíguo → consulta por chave ANTES de desistir; nunca renumera.
 */
async function emitNfeDevolucao55(company, params, ctx) {
  const { db, config } = ctx || {};
  if (!db || !config) throw new Error('sefazSp.emitNfeDevolucao55: ctx {db, config} obrigatório');

  const { originalChave, items, consumerInfo, serie, numero } = params || {};
  const cleanChave = String(originalChave || '').replace(/\D/g, '');
  if (cleanChave.length !== 44) {
    throw new Error('emitNfeDevolucao55: originalChave deve ter 44 dígitos (chave de acesso NFC-e/NF-e)');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('emitNfeDevolucao55: items obrigatórios');
  }

  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints55(config.uf || 'SP', tpAmb);

  // Certificado A1: decifrado e aberto SÓ em memória (sem CSC — 55 não tem QR)
  const { pfx, password } = await loadCertificate(db, company.id);
  const cert = openPfx(pfx, password);
  assertValidity(cert);

  // Texto fiscal: paridade byte-a-byte com nuvemfiscal.emitNfeDevolucao
  const consumerName = (consumerInfo && consumerInfo.name) || 'Consumidor não identificado';
  const consumerCpf = (consumerInfo && consumerInfo.cpf) ? ` (CPF ${consumerInfo.cpf})` : '';
  const motivo = (consumerInfo && consumerInfo.motivo) || 'Troca';
  const infAdFisco =
    `Devolução de mercadoria referente à NFC-e chave ${cleanChave}. ` +
    `Consumidor: ${consumerName}${consumerCpf}. ` +
    `Motivo: ${motivo}.`;

  // 1. monta + 2. assina + 3. compõe (SEM infNFeSupl — modelo 55 não tem QR)
  const built = buildInfNfe55Devolucao(company, {
    items,
    refNFe: cleanChave,
    serie: serie || 1,
    numero,
    natureza_operacao: 'devolução de mercadoria adquirida por não contribuinte',
    infAdFisco,
  }, { tpAmb });

  const { signatureXml } = signInfNfe(built.infNfeXml, {
    keyPem: cert.keyPem, certDerBase64: cert.certDerBase64,
  });
  const nfeXml = composeNfe({
    signedInfNfeXml: built.infNfeXml, infNfeSuplXml: '', signatureXml,
  });

  // 4. transmite (síncrono). Ambíguo → consulta por chave, nunca renumera.
  let result;
  try {
    result = await soap.autorizar({
      signedNfeXml: nfeXml, idLote: String(numero), tpAmb, endpoints,
      pfx, passphrase: password, transport: ctx.transport,
    });
  } catch (err) {
    if (err instanceof soap.SefazTransportError && err.ambiguous) {
      let consulta;
      try {
        consulta = await soap.consultarChave({
          chave: built.chave, tpAmb, endpoints,
          pfx, passphrase: password, transport: ctx.transport,
        });
      } catch (_) {
        throw err; // consulta TAMBÉM falhou: mantém o erro ambíguo original
      }
      if (consulta.autorizada) {
        result = {
          cStat: consulta.cStat, xMotivo: consulta.xMotivo,
          protocolo: consulta.protocolo, chNFe: built.chave,
          autorizada: true, rejeitada: false,
        };
      } else {
        err.message += ' (consulta pós-timeout: cStat ' + consulta.cStat +
          ' — nota não autorizada; reprocessar com o mesmo número)';
        throw err;
      }
    } else {
      throw err;
    }
  }

  const status = result.autorizada ? 'autorizado' : (result.rejeitada ? 'rejeitado' : 'processando');

  // Shape que trocaDevolucao55.normalizeDfeStatus entende + extras próprios
  return {
    id: null,                          // não há id de gateway
    status,
    chave_acesso: built.chave,
    protocolo: result.protocolo || null,
    codigo_status: result.cStat || null,
    motivo_status: result.xMotivo || null,
    xml_signed: nfeXml,
    tp_emis: 1,
    provider: 'sefaz_sp',
  };
}

module.exports = {
  emitNfeDevolucao55,
  // exporta blocos p/ teste unitário
  buildInfNfe55Devolucao, buildIde55Xml, buildDestSelf55Xml,
  buildPagSemPagamentoXml, getEndpoints55, ENDPOINTS_NFE55,
};
