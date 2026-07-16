// ============================================================
// AURA. — sefazSp: emissão PRÓPRIA de NFC-e (SEFAZ-SP) — orquestrador
// Roadmap NFC-e própria v1 — S1.6 (caminho feliz).
//
// MESMA interface dos gateways (decisão de arquitetura nº 1):
//   emitNfce(company, nfceData, ctx) → resultado que extractProvFields
//   (routes/nfce.js) entende: status, chave_acesso, protocolo,
//   codigo_status, motivo_status, qr_code, url_consulta.
//   + extras próprios: xml_signed, tp_emis (persistidos pela rota).
//
// ctx = { db, config } — config é a linha de nfce_config (provider,
// ambiente, csc_id, csc_token_enc/csc_token; serie/numero vêm do payload).
//
// Timeout ambíguo: consulta por chave ANTES de desistir; nunca renumera.
// ============================================================
'use strict';

const { buildInfNfe, composeNfe } = require('./xmlBuilder');
const { signInfNfe } = require('./signer');
const { openPfx, assertValidity } = require('./pfx');
const { loadCertificate } = require('./certStore');
const { buildQrCodeUrl, buildInfNfeSupl } = require('./qrcode');
const soap = require('./soapClient');
const eventos = require('./eventos');
const contingency = require('./contingency');
const { getEndpoints } = require('./endpoints');
const { decryptString } = require('../../utils/secretCrypto');

const { isoBR: soapIsoNow } = require('../nuvemfiscal');

function totalParaQr(nfceData) {
  if (nfceData.total_value !== undefined) return Number(nfceData.total_value);
  return (nfceData.items || []).reduce((s, it) =>
    s + Math.round(Number(it.quantity || 1) * Number(it.price || 0) * 100) / 100 - (Number(it.discount) || 0), 0);
}

function resolveTpAmb(config) {
  return config.ambiente === 'producao' ? 1 : 2;
}

function resolveCscToken(config) {
  if (config.csc_token_enc) return decryptString(config.csc_token_enc);
  if (config.csc_token) return config.csc_token; // legado em claro (até o backfill)
  throw new Error('CSC token não configurado (nfce_config.csc_token_enc). Configure em Nota Fiscal.');
}

/**
 * Emite NFC-e direto na SEFAZ-SP (síncrono).
 * @param company  — mesma shape resolvida por routes/nfce.js
 * @param nfceData — mesmo payload passado aos gateways (items/payments/
 *                   serie/numero/recipient/observacoes)
 * @param ctx      — { db, config, transport? (testes) }
 */
async function emitNfce(company, nfceData, ctx) {
  const { db, config } = ctx || {};
  if (!db || !config) throw new Error('sefazSp.emitNfce: ctx {db, config} obrigatório');
  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints(config.uf || 'SP', tpAmb);
  const cscToken = resolveCscToken(config);
  if (!config.csc_id) throw new Error('CSC ID não configurado (nfce_config.csc_id).');

  // Certificado A1: decifrado e aberto SÓ em memória
  const { pfx, password } = await loadCertificate(db, company.id);
  const cert = openPfx(pfx, password);
  assertValidity(cert);

  // 1. monta + 2. assina + 3. QR + 4. compõe
  const built = buildInfNfe(company, nfceData, { tpAmb, tpEmis: 1 });
  const { signatureXml } = signInfNfe(built.infNfeXml, {
    keyPem: cert.keyPem, certDerBase64: cert.certDerBase64,
  });
  const qrCodeUrl = buildQrCodeUrl({
    chave: built.chave, tpAmb,
    cscId: config.csc_id, cscToken,
    qrCodeBase: endpoints.qrCodeBase,
  });
  const infNfeSuplXml = buildInfNfeSupl({ qrCodeUrl, urlConsulta: endpoints.urlConsulta });
  const nfeXml = composeNfe({
    signedInfNfeXml: built.infNfeXml, infNfeSuplXml, signatureXml,
  });

  // S3.1: contingência offline. PDV nunca trava — detector offline pula a
  // SEFAZ; falha de transporte na hora cai pra tpEmis=9 na mesma requisição.
  const allowContingency = ctx.allowContingency === true;

  function emitContingency() {
    const dhCont = soapIsoNow();
    const builtC = buildInfNfe(company, nfceData, {
      tpAmb, tpEmis: 9, dhCont, xJust: contingency.XJUST_DEFAULT,
    });
    const sigC = signInfNfe(builtC.infNfeXml, {
      keyPem: cert.keyPem, certDerBase64: cert.certDerBase64,
    });
    const digVal = (sigC.signatureXml.match(/<DigestValue>([^<]+)<\/DigestValue>/) || [])[1];
    const qrC = buildQrCodeUrl({
      chave: builtC.chave, tpAmb, cscId: config.csc_id, cscToken,
      qrCodeBase: endpoints.qrCodeBase,
      tpEmis: 9, dhEmi: builtC.dhEmi, vNF: totalParaQr(nfceData), digVal,
    });
    const nfeXmlC = composeNfe({
      signedInfNfeXml: builtC.infNfeXml,
      infNfeSuplXml: buildInfNfeSupl({ qrCodeUrl: qrC, urlConsulta: endpoints.urlConsulta }),
      signatureXml: sigC.signatureXml,
    });
    return {
      id: null,
      status: 'contingencia',
      chave_acesso: builtC.chave,
      protocolo: null,
      codigo_status: null,
      motivo_status: 'Emitida em contingência offline (tpEmis=9) — transmissão pendente',
      qr_code: qrC,
      url_consulta: endpoints.urlConsulta,
      xml_signed: nfeXmlC,
      tp_emis: 9,
      contingency_at: dhCont,
      provider: 'sefaz_sp',
    };
  }

  if (allowContingency && contingency.isLikelyOffline(tpAmb)) {
    return emitContingency();
  }

  // 5. transmite (síncrono). Ambíguo → consulta por chave, nunca renumera.
  let result;
  try {
    result = await soap.autorizar({
      signedNfeXml: nfeXml, idLote: String(nfceData.numero), tpAmb, endpoints,
      pfx, passphrase: password, transport: ctx.transport,
    });
    contingency.recordSuccess(tpAmb);
  } catch (err) {
    if (err instanceof soap.SefazTransportError && err.ambiguous) {
      contingency.recordFailure(tpAmb);
      let consulta;
      try {
        consulta = await soap.consultarChave({
          chave: built.chave, tpAmb, endpoints,
          pfx, passphrase: password, transport: ctx.transport,
        });
      } catch (_) {
        // consulta TAMBÉM falhou: SEFAZ realmente fora
        contingency.recordFailure(tpAmb);
        if (allowContingency) return emitContingency();
        throw err; // mantém o erro ambíguo original
      }
      contingency.recordSuccess(tpAmb); // consulta respondeu
      if (consulta.autorizada) {
        result = {
          cStat: consulta.cStat, xMotivo: consulta.xMotivo,
          protocolo: consulta.protocolo, chNFe: built.chave,
          autorizada: true, rejeitada: false,
        };
      } else if (allowContingency) {
        // autorização caída mas consulta de pé (pane parcial): caixa não
        // espera — contingência. A tentativa não consta (217): sem duplicidade.
        return emitContingency();
      } else {
        // não consta na base: seguro reprocessar depois com o MESMO número
        err.message += ' (consulta pós-timeout: cStat ' + consulta.cStat + ' — nota não autorizada; reprocessar com o mesmo número)';
        throw err;
      }
    } else {
      throw err;
    }
  }

  const status = result.autorizada ? 'autorizado' : (result.rejeitada ? 'rejeitado' : 'processando');

  // Shape que extractProvFields (routes/nfce.js) entende + extras próprios
  return {
    id: null,                              // não há id de gateway
    status,
    chave_acesso: built.chave,
    protocolo: result.protocolo || null,
    codigo_status: result.cStat || null,
    motivo_status: result.xMotivo || null,
    qr_code: qrCodeUrl,
    url_consulta: endpoints.urlConsulta,
    // extras persistidos pela rota (colunas da migration 234)
    xml_signed: nfeXml,
    tp_emis: 1,
    provider: 'sefaz_sp',
  };
}

/** Consulta situação por chave (paridade c/ queryNfce dos gateways). */
async function queryNfce({ chave, config, db, companyId, transport }) {
  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints(config.uf || 'SP', tpAmb);
  const { pfx, password } = await loadCertificate(db, companyId);
  const r = await soap.consultarChave({ chave, tpAmb, endpoints, pfx, passphrase: password, transport });
  return {
    status: r.autorizada ? 'autorizado' : 'processando',
    chave_acesso: chave,
    protocolo: r.protocolo,
    codigo_status: r.cStat,
    motivo_status: r.xMotivo,
  };
}

/** Status do serviço SEFAZ-SP (telemetria S3.3 / circuit breaker S4.2). */
async function statusServico({ config, db, companyId, transport }) {
  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints(config.uf || 'SP', tpAmb);
  const { pfx, password } = await loadCertificate(db, companyId);
  return soap.statusServico({ tpAmb, endpoints, pfx, passphrase: password, transport });
}

/**
 * S2.1 — Cancelamento via evento 110111 (NFeRecepcaoEvento4).
 * Sucesso: cStat 135/136; 573 (duplicidade) = idempotente.
 */
async function cancelNfce({ db, config, companyId, chave, protocolo, justificativa, transport }) {
  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints(config.uf || 'SP', tpAmb);
  const { pfx, password } = await loadCertificate(db, companyId);
  const cert = openPfx(pfx, password);
  const cnpj = String(chave).slice(6, 20); // CNPJ do emitente embutido na chave
  return eventos.cancelarNfce({
    chave, cnpj, tpAmb, protocolo, justificativa, endpoints,
    cert: { keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 },
    pfx, passphrase: password, transport,
  });
}

/**
 * S2.1 — Inutilização de faixa (NFeInutilizacao4). Sucesso: cStat 102.
 * Usar pros números reservados e abandonados (gap de numeração).
 */
async function inutilizarFaixa({ db, config, companyId, cnpj, serie, nIni, nFin, justificativa, ano2, transport }) {
  const tpAmb = resolveTpAmb(config);
  const endpoints = getEndpoints(config.uf || 'SP', tpAmb);
  const { pfx, password } = await loadCertificate(db, companyId);
  const cert = openPfx(pfx, password);
  return eventos.inutilizar({
    tpAmb, ano2, cnpj, serie, nIni, nFin, justificativa, endpoints,
    cert: { keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 },
    pfx, passphrase: password, transport,
  });
}

module.exports = {
  emitNfce, queryNfce, statusServico, cancelNfce, inutilizarFaixa,
  resolveTpAmb, resolveCscToken,
};
