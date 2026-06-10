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
const { getEndpoints } = require('./endpoints');
const { decryptString } = require('../../utils/secretCrypto');

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

  // 5. transmite (síncrono). Ambíguo → consulta por chave, nunca renumera.
  let result;
  try {
    result = await soap.autorizar({
      signedNfeXml: nfeXml, idLote: String(nfceData.numero), tpAmb, endpoints,
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
        throw err; // consulta também falhou: mantém o erro ambíguo original
      }
      if (consulta.autorizada) {
        result = {
          cStat: consulta.cStat, xMotivo: consulta.xMotivo,
          protocolo: consulta.protocolo, chNFe: built.chave,
          autorizada: true, rejeitada: false,
        };
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
    // extras persistidos pela rota (colunas da migration 173)
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

// cancelNfce/inutilizar chegam na S2.1 (NFeRecepcaoEvento4/NFeInutilizacao4)

module.exports = { emitNfce, queryNfce, statusServico, resolveTpAmb, resolveCscToken };
