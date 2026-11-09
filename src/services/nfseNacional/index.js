// ============================================================
// AURA. — nfseNacional: emissor PRÓPRIO de NFS-e pelo Emissor Público
// Nacional (API Sefin Nacional) — orquestrador.
//
// Por quê: Resolução CGSN 191/2026 — desde 01/11/2026 ME/EPP do Simples
// emitem NFS-e pelo Emissor Nacional (web ou API). Jacareí-SP, a cidade da
// Aura, só usa o Emissor Nacional desde 15/12/2025. Multiempresa: qualquer
// empresa com A1 + configuração apta usa; a primeira será a própria Aura.
//
// Fluxo de emitir(), com chave de idempotência obrigatória do chamador:
//   0. liga NFSE_NACIONAL_ENABLED desligada → recusa (nada sai);
//   1. mesma chave já gravada:
//        autorizada/rejeitada/cancelada → devolve a MESMA nota (replay);
//        pendente/erro → retoma com o MESMO número (nunca renumera);
//      mesma chave com OUTROS dados → recusa (409);
//   2. valida os dados ANTES de numerar (dado inválido não gasta número);
//   3. numa transação (repo.reservar): reserva nDPS (UPDATE ... RETURNING
//      em nfse_config, trava a linha) e grava a nota 'pendente' com a chave.
//      Corrida com a mesma chave → o UNIQUE (company_id, idempotency_key)
//      barra a segunda, que desfaz a reserva e devolve a primeira;
//   4. monta e assina a DPS com o A1 da empresa (cofre da NFC-e), grava o
//      XML assinado e transmitted_at ANTES do POST;
//   5. POST /nfse: autorizada → chave, número, XML; rejeitada → códigos;
//      ambíguo (timeout/5xx) → consulta GET /dps/{Id} na hora; sem
//      confirmação a nota fica 'pendente' e a próxima chamada com a mesma
//      chave consulta de novo antes de reenviar o MESMO XML.
//
// Breaker por empresa (mesma semântica do engineBreaker da NFC-e, estado
// separado): falhas de transporte seguidas abrem 15 min de recusa imediata.
// ============================================================
'use strict';

const crypto = require('crypto');
const { loadCertificate } = require('../sefazSp/certStore');
const { openPfx, assertValidity } = require('../sefazSp/pfx');
const { extrairCnpjDoCertificado } = require('../sefazSp/certCnpj');
const { signElementById } = require('../sefazSp/signer');
const { createBreaker } = require('../sefazSp/engineBreaker');
const client = require('./client');
const repo = require('./repo');
const { buildDps, validarEntrada, hojeBR, paraLatin1 } = require('./dpsBuilder');
const { buildCancelamento, COD_CANCELAMENTO } = require('./eventoBuilder');
const { resolverRegime, avaliarAptidao } = require('./config');
const { getEndpoints, nacionalHabilitado, producaoHabilitada } = require('./endpoints');
const { NfseNacionalError, NfseNacionalTransportError } = require('./errors');

const breaker = createBreaker();
const MARGEM_RELOGIO_MS = 60 * 1000; // dhEmi ≤ dhProc (E0008): folga para relógio adiantado
const FINAIS = new Set(['autorizada', 'rejeitada', 'cancelada']);
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// ── utilidades ─────────────────────────────────────────────

function exigirLigado() {
  if (!nacionalHabilitado()) {
    throw new NfseNacionalError(
      'Emissor nacional de NFS-e desligado neste servidor (NFSE_NACIONAL_ENABLED). Nada foi enviado.',
      'NACIONAL_DESLIGADO'
    );
  }
}

function exigirAmbiente(ambiente) {
  const ep = getEndpoints(ambiente);
  if (ep.ambiente === 'producao' && !producaoHabilitada()) {
    throw new NfseNacionalError(
      'Emissão em PRODUÇÃO ainda não liberada neste servidor (NFSE_NACIONAL_PRODUCAO). Nada foi enviado.',
      'PRODUCAO_DESLIGADA'
    );
  }
  return ep;
}

function validarChave(key) {
  const k = String(key == null ? '' : key).trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(k)) {
    throw new NfseNacionalError(
      'Chave de idempotência obrigatória (1 a 120 caracteres: letras, números, ponto, hífen, dois-pontos, sublinhado).',
      'IDEMPOTENCY_KEY'
    );
  }
  return k;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** Impressão digital dos dados pedidos: mesma chave + dados diferentes = erro. */
function fingerprint(nota) {
  return crypto.createHash('sha256').update(stable(nota || {})).digest('hex');
}

const agora = (ctx) => (ctx && typeof ctx.now === 'function' ? ctx.now() : new Date());
const comMargem = (ctx) => new Date(agora(ctx).getTime() - MARGEM_RELOGIO_MS);

function transportOpts(cert, ctx = {}) {
  return {
    pfx: cert.pfx, passphrase: cert.password,
    transport: ctx.transport, timeoutMs: ctx.timeoutMs, retry: ctx.retry,
  };
}

function textoErros(erros) {
  return (erros || []).map((e) => [e.codigo, e.descricao, e.complemento].filter(Boolean).join(' - ')).join(' | ');
}

async function abrirCertificado(db, companyId, cnpjEmpresa) {
  let c;
  try {
    const { pfx, password } = await loadCertificate(db, companyId);
    const info = openPfx(pfx, password);
    assertValidity(info);
    c = { pfx, password, keyPem: info.keyPem, certDerBase64: info.certDerBase64, info };
  } catch (err) {
    throw new NfseNacionalError(`Certificado A1: ${err.message}`, 'CERTIFICADO');
  }
  const doCert = extrairCnpjDoCertificado(c.info);
  if (!doCert || doCert.cnpj !== onlyDigits(cnpjEmpresa)) {
    // E0718: a DPS precisa ser assinada com o certificado do próprio emitente
    throw new NfseNacionalError('O certificado A1 enviado não é do CNPJ desta empresa.', 'CERTIFICADO');
  }
  return c;
}

/** Pedido da rota/serviço → entrada normalizada do dpsBuilder (sem série/número). */
function montarEntrada({ nota, config, company, tpAmb, dhEmi }) {
  const regime = resolverRegime(config);
  const t = nota.tomador;
  const tomador = t && (t.doc || t.nome) ? {
    doc: t.doc, nome: t.nome,
    email: t.email || null, fone: t.fone || null, im: t.im || null,
    endereco: t.endereco || null,
  } : null;
  const retido = nota.iss_retido === true;
  return {
    tpAmb,
    dhEmi,
    dCompet: nota.competencia || hojeBR(dhEmi),
    cLocEmi: onlyDigits(config.municipio_ibge),
    prestador: {
      cnpj: onlyDigits(company.cnpj),
      im: config.inscricao_municipal || null,
      opSimpNac: regime.opSimpNac,
      regApTribSN: regime.regApTribSN,
      regEspTrib: regime.regEspTrib,
    },
    tomador,
    servico: {
      cTribNac: String(nota.ctribnac || config.ctribnac_padrao || ''),
      cNBS: nota.cnbs || config.cnbs_padrao || null,
      descricao: nota.descricao,
      cLocPrestacao: onlyDigits(nota.municipio_prestacao || config.municipio_ibge),
    },
    valores: {
      vServ: Number(nota.valor),
      tpRetISSQN: retido ? 2 : 1,
      pAliq: retido ? Number(nota.aliquota_iss != null ? nota.aliquota_iss : config.default_iss_rate) : null,
      pTotTribSN: config.p_tot_trib_sn != null ? Number(config.p_tot_trib_sn) : null,
      totTrib: nota.tot_trib || null,
    },
  };
}

// ── transmissão ────────────────────────────────────────────

/** GET /dps/{Id} → GET /nfse/{chave}. true = a DPS já virou nota (gravada). */
async function recuperarPelaDps(db, row, ep, cert, ctx) {
  const r = await client.consultarDps({ sefinUrl: ep.sefin, idDps: row.dps_id, ...transportOpts(cert, ctx) });
  if (!r.encontrada) return false;
  const n = await client.consultarNfse({ sefinUrl: ep.sefin, chave: r.chaveAcesso, ...transportOpts(cert, ctx) });
  if (!n) return false;
  await repo.gravarAutorizada(db, row.id, {
    chaveAcesso: r.chaveAcesso, nfseXml: n.nfseXml, alertas: [], cabecalho: { recuperada_por: 'consulta_dps' },
  });
  return true;
}

async function transmitir(db, row, signedXml, ep, cert, ctx) {
  const recarregar = () => repo.buscarPorId(db, row.company_id, row.id);
  let r;
  try {
    r = await client.enviarDps({ sefinUrl: ep.sefin, signedXml, ...transportOpts(cert, ctx) });
  } catch (err) {
    if (!(err instanceof NfseNacionalTransportError)) throw err;
    breaker.recordFailure(row.company_id);
    await repo.marcarSemConfirmacao(db, row.id, `Sem confirmação do Sistema Nacional: ${err.message}`);
    // Ambíguo: pergunta na hora se a DPS virou nota. Nunca reenvia aqui.
    try {
      if (await recuperarPelaDps(db, row, ep, cert, ctx)) return { nota: await recarregar() };
    } catch (_) { /* consulta também falhou: segue pendente */ }
    return { nota: await recarregar(), aguardando: true };
  }
  breaker.recordSuccess(row.company_id);

  if (r.kind === 'autorizada') {
    await repo.gravarAutorizada(db, row.id, r);
    return { nota: await recarregar() };
  }
  if (r.kind === 'rejeitada') {
    // E0014: esta série/número já gerou NFS-e (ex.: reenvio depois de um
    // timeout que na verdade autorizou). Recupera a nota em vez de rejeitar.
    if (r.erros.some((e) => e.codigo === 'E0014')) {
      try {
        if (await recuperarPelaDps(db, row, ep, cert, ctx)) return { nota: await recarregar() };
      } catch (_) { /* cai na rejeição */ }
    }
    await repo.gravarRejeitada(db, row.id, { texto: textoErros(r.erros), erros: r.erros, cabecalho: r.cabecalho });
    return { nota: await recarregar() };
  }
  // 'recusada' (401/403): certificado da conexão recusado — nada processado
  await repo.marcarErro(db, row.id, `Certificado recusado pelo Sistema Nacional (HTTP ${r.httpStatus}).`, r.erros);
  return { nota: await recarregar() };
}

/** Monta, assina, grava o XML e transmite uma nota reservada que ainda não saiu. */
async function montarETransmitir(db, row, entrada, env, ctx) {
  let cert;
  try {
    cert = await abrirCertificado(db, row.company_id, env.company.cnpj);
  } catch (err) {
    await repo.marcarErro(db, row.id, err.message);
    throw err;
  }
  let built;
  let signedXml;
  try {
    built = buildDps({ ...entrada, serie: row.dps_serie, nDPS: String(row.dps_number) });
    signedXml = XML_DECL + signElementById(built.xml, {
      elementName: 'infDPS', keyPem: cert.keyPem, certDerBase64: cert.certDerBase64,
    });
  } catch (err) {
    await repo.marcarErro(db, row.id, err.message);
    throw err instanceof NfseNacionalError ? err : new NfseNacionalError(`Falha ao montar a DPS: ${err.message}`, 'INVALID_INPUT');
  }
  // XML e transmitted_at ANTES do POST: se o processo cair no meio, a
  // próxima tentativa sabe que precisa consultar antes de reenviar.
  await repo.marcarTransmitindo(db, row.id, { idDps: built.idDps, xml: signedXml });
  return transmitir(db, { ...row, dps_id: built.idDps }, signedXml, env.ep, cert, ctx);
}

/** Nota da mesma chave em 'pendente'/'erro': retoma sem renumerar. */
async function retomar(db, rowCurta, env, ctx) {
  const row = await repo.buscarPorId(db, rowCurta.company_id, rowCurta.id);
  const ep = exigirAmbiente(row.ambiente);
  if (row.transmitted_at && row.xml_dps && row.dps_id) {
    const cert = await abrirCertificado(db, row.company_id, env.company.cnpj);
    let achou;
    try {
      achou = await recuperarPelaDps(db, row, ep, cert, ctx);
    } catch (err) {
      if (!(err instanceof NfseNacionalTransportError)) throw err;
      breaker.recordFailure(row.company_id);
      throw new NfseNacionalError(
        'Ainda sem confirmação do Sistema Nacional para esta nota. Tente de novo em instantes — repetir é seguro.',
        'NACIONAL_INDISPONIVEL'
      );
    }
    if (achou) return { nota: await repo.buscarPorId(db, row.company_id, row.id) };
    // A DPS não virou nota: reenvia o MESMO XML assinado (mesmo número).
    return transmitir(db, row, row.xml_dps, ep, cert, ctx);
  }
  if (!row.dps_dados) throw new NfseNacionalError('Nota sem os dados da DPS para retomar.', 'ESTADO_INVALIDO');
  const entrada = { ...row.dps_dados, dhEmi: comMargem(ctx) };
  return montarETransmitir(db, row, entrada, { ...env, ep }, ctx);
}

// ── API ────────────────────────────────────────────────────

/**
 * Emite uma NFS-e pelo emissor nacional.
 * @param db   pool pg (query + connect)
 * @param {{ companyId, idempotencyKey, nota }} p
 *   nota = { descricao, valor, competencia?, ctribnac?, cnbs?, municipio_prestacao?,
 *            tomador?: { doc, nome, email?, fone?, im?, endereco? }, iss_retido?, aliquota_iss?,
 *            tot_trib?: { fed, est, mun }, customer_id?, payment_id?, source_type? }
 * @param ctx  { transport?, now?, timeoutMs?, retry? } (testes)
 * @returns {{ nota, replay?: boolean, aguardando?: boolean }}
 */
async function emitir(db, { companyId, idempotencyKey, nota = {} }, ctx = {}) {
  exigirLigado();
  const key = validarChave(idempotencyKey);
  const fp = fingerprint(nota);

  const existente = await repo.buscarPorChave(db, companyId, key);
  if (existente && existente.idempotency_fingerprint && existente.idempotency_fingerprint !== fp) {
    throw new NfseNacionalError('Esta chave de idempotência já foi usada com outros dados de nota.', 'ESTADO_INVALIDO');
  }
  if (existente && FINAIS.has(existente.status)) return { nota: existente, replay: true };

  const { config, company, certInfo } = await repo.carregarContexto(db, companyId);
  if (!config) throw new NfseNacionalError('NFS-e não configurada nesta empresa.', 'CONFIG_MISSING');
  const apt = avaliarAptidao({ config, company, certInfo, now: agora(ctx) });
  if (!apt.apta) {
    throw new NfseNacionalError('Configuração da NFS-e incompleta: ' + apt.pendencias.join(' '), 'CONFIG_NAO_APTA', apt.pendencias);
  }
  const ep = exigirAmbiente(config.ambiente);
  if (breaker.isOpen(companyId)) {
    throw new NfseNacionalError(
      'O Sistema Nacional NFS-e não respondeu nas últimas tentativas. Nova tentativa liberada em alguns minutos.',
      'NACIONAL_INDISPONIVEL'
    );
  }
  const env = { config, company, ep };
  if (existente) return retomar(db, existente, env, ctx);

  const entrada = montarEntrada({ nota, config, company, tpAmb: ep.tpAmb, dhEmi: comMargem(ctx) });
  const erros = validarEntrada(entrada, { semNumero: true });
  if (erros.length) throw new NfseNacionalError('Dados da nota inválidos: ' + erros.join(' '), 'INVALID_INPUT', erros);

  const reserva = await repo.reservar(db, { companyId, key, fp, entrada, nota, ambiente: ep.ambiente });
  if (reserva.semConfig) throw new NfseNacionalError('NFS-e não configurada nesta empresa.', 'CONFIG_MISSING');
  if (reserva.corrida) {
    const outra = await repo.buscarPorChave(db, companyId, key);
    return { nota: outra, replay: true, aguardando: !(outra && FINAIS.has(outra.status)) };
  }
  return montarETransmitir(db, reserva.row, entrada, env, ctx);
}

/** Cancela (evento 101101). Repetir é seguro: confirma pelo evento já registrado. */
async function cancelar(db, { companyId, nfseId, cMotivo = 9, xMotivo }, ctx = {}) {
  exigirLigado();
  const row = await repo.buscarPorId(db, companyId, nfseId);
  if (!row || row.provider !== 'nacional') throw new NfseNacionalError('NFS-e não encontrada.', 'NOT_FOUND');
  if (row.status === 'cancelada') return { nota: row, replay: true };
  if (row.status !== 'autorizada' || !row.chave_acesso) {
    throw new NfseNacionalError(`Só dá para cancelar nota autorizada (situação atual: ${row.status}).`, 'ESTADO_INVALIDO');
  }
  const ep = exigirAmbiente(row.ambiente);
  const { company } = await repo.carregarContexto(db, companyId);
  const ev = buildCancelamento({
    tpAmb: ep.tpAmb, chave: row.chave_acesso, cnpjAutor: company && company.cnpj,
    cMotivo, xMotivo, dhEvento: comMargem(ctx),
  });
  const cert = await abrirCertificado(db, companyId, company.cnpj);
  const signedXml = XML_DECL + signElementById(ev.xml, {
    elementName: 'infPedReg', keyPem: cert.keyPem, certDerBase64: cert.certDerBase64,
  });

  const cancelada = async (eventoXml) => {
    await repo.gravarCancelada(db, row.id, { motivo: paraLatin1(xMotivo), eventoXml });
    return { nota: await repo.buscarPorId(db, companyId, row.id) };
  };
  const eventoJaRegistrado = () => client.consultarEvento({
    sefinUrl: ep.sefin, chave: row.chave_acesso, tipoEvento: COD_CANCELAMENTO, nSeq: 1, ...transportOpts(cert, ctx),
  });

  let r;
  try {
    r = await client.enviarEvento({ sefinUrl: ep.sefin, chave: row.chave_acesso, signedXml, ...transportOpts(cert, ctx) });
  } catch (err) {
    if (!(err instanceof NfseNacionalTransportError)) throw err;
    breaker.recordFailure(companyId);
    try {
      const ja = await eventoJaRegistrado();
      if (ja) return cancelada(ja.eventoXml);
    } catch (_) { /* consulta também falhou */ }
    throw new NfseNacionalError(
      'Sem confirmação do cancelamento pelo Sistema Nacional. Tente de novo — repetir é seguro.',
      'NACIONAL_INDISPONIVEL'
    );
  }
  breaker.recordSuccess(companyId);
  if (r.kind === 'registrado') return cancelada(r.eventoXml);

  // Rejeitado: pode ser "evento já existe" de uma tentativa anterior.
  try {
    const ja = await eventoJaRegistrado();
    if (ja) return cancelada(ja.eventoXml);
  } catch (_) { /* segue com a rejeição */ }
  await repo.gravarCancelamentoRecusado(db, row.id, r.erros);
  throw new NfseNacionalError(`Cancelamento recusado pelo Sistema Nacional: ${textoErros(r.erros) || 'sem detalhe'}`, 'REJEITADA', r.erros);
}

/** Reconsulta no Sefin (pela chave; pendente: pela DPS, sem reenviar). */
async function consultar(db, { companyId, nfseId }, ctx = {}) {
  exigirLigado();
  const row = await repo.buscarPorId(db, companyId, nfseId);
  if (!row || row.provider !== 'nacional') throw new NfseNacionalError('NFS-e não encontrada.', 'NOT_FOUND');
  const ep = exigirAmbiente(row.ambiente);
  if (!row.chave_acesso && !(row.transmitted_at && row.dps_id)) return { nota: row };
  const { company } = await repo.carregarContexto(db, companyId);
  const cert = await abrirCertificado(db, companyId, company && company.cnpj);
  if (!row.chave_acesso) {
    await recuperarPelaDps(db, row, ep, cert, ctx);
    return { nota: await repo.buscarPorId(db, companyId, row.id) };
  }
  const n = await client.consultarNfse({ sefinUrl: ep.sefin, chave: row.chave_acesso, ...transportOpts(cert, ctx) });
  if (n) await repo.atualizarXmlNfse(db, row.id, n.nfseXml);
  if (row.status === 'autorizada') {
    const ev = await client.consultarEvento({
      sefinUrl: ep.sefin, chave: row.chave_acesso, tipoEvento: COD_CANCELAMENTO, nSeq: 1, ...transportOpts(cert, ctx),
    }).catch(() => null);
    if (ev) await repo.gravarCancelada(db, row.id, { motivo: null, eventoXml: ev.eventoXml });
  }
  return { nota: await repo.buscarPorId(db, companyId, row.id) };
}

/** PDF do DANFSe (ADN). null se ainda não disponível. */
async function danfse(db, { companyId, nfseId }, ctx = {}) {
  exigirLigado();
  const row = await repo.buscarPorId(db, companyId, nfseId);
  if (!row || row.provider !== 'nacional') throw new NfseNacionalError('NFS-e não encontrada.', 'NOT_FOUND');
  if (!row.chave_acesso) throw new NfseNacionalError('A nota ainda não tem chave de acesso.', 'ESTADO_INVALIDO');
  const ep = exigirAmbiente(row.ambiente);
  const { company } = await repo.carregarContexto(db, companyId);
  const cert = await abrirCertificado(db, companyId, company && company.cnpj);
  return client.baixarDanfse({ danfseUrl: ep.danfse, chave: row.chave_acesso, ...transportOpts(cert, ctx) });
}

/** Situação da configuração (sem segredo) para a tela/GET /config. */
async function situacaoConfig(db, companyId) {
  const { config, company, certInfo } = await repo.carregarContexto(db, companyId);
  const apt = avaliarAptidao({ config, company, certInfo });
  return {
    ...apt,
    ligado: nacionalHabilitado(),
    ambiente: getEndpoints(config && config.ambiente).ambiente,
    certificado: certInfo ? { subject_cn: certInfo.subject_cn, not_after: certInfo.not_after } : null,
  };
}

module.exports = {
  emitir, cancelar, consultar, danfse, situacaoConfig,
  montarEntrada, fingerprint,
  _breaker: breaker,
  MARGEM_RELOGIO_MS,
};
