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
const {
  resolverRegime, avaliarAptidao, avaliarPassos, sugestaoDaEmpresa, faltasParaLigar, CODIGOS_PREFEITURA, SERIE_TESTE,
} = require('./config');
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

const temTexto = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Descrição da nota: a da nota, senão a do item para NFS-e (nfse_descricao),
 * senão o nome do item. Sem item, a da nota como sempre foi.
 */
function descricaoDoServico(nota, item) {
  if (!item || temTexto(nota.descricao)) return nota.descricao;
  if (temTexto(item.nfse_descricao)) return item.nfse_descricao;
  return item.name;
}

/**
 * Pedido da rota/serviço → entrada normalizada do dpsBuilder (sem série/número).
 * `item` (opcional) = serviço do estoque citado pela nota (repo.buscarItem).
 * Precedência por campo: valor explícito na nota → valor do item → padrão da
 * empresa (nfse_config). Sem item, a entrada sai igual à de antes.
 * cTribMun e IBS/CBS do item ainda não entram no leiaute (PR próprio).
 */
function montarEntrada({ nota, config, company, tpAmb, dhEmi, item = null }) {
  const regime = resolverRegime(config);
  const doItem = (col) => (item && item[col] != null && item[col] !== '' ? item[col] : null);
  const t = nota.tomador;
  const tomador = t && (t.doc || t.nome) ? {
    doc: t.doc, nome: t.nome,
    email: t.email || null, fone: t.fone || null, im: t.im || null,
    endereco: t.endereco || null,
  } : null;
  const retido = nota.iss_retido === true;
  // ISSQN retido: nota → item → alíquota efetiva do Simples da loja
  // (aliquota_iss_retencao_sn, migration 440). default_iss_rate NÃO entra:
  // ela nasce com 2,00 de fábrica (058) e a alíquota de quem retém no
  // Simples depende do faturamento — sem ela a nota para com aviso gentil.
  const aliqRetida = nota.aliquota_iss != null ? nota.aliquota_iss
    : (doItem('nfse_aliquota_iss') != null ? doItem('nfse_aliquota_iss') : config.aliquota_iss_retencao_sn);
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
      cTribNac: String(nota.ctribnac || doItem('nfse_ctribnac') || config.ctribnac_padrao || ''),
      cNBS: nota.cnbs || doItem('nfse_cnbs') || config.cnbs_padrao || null,
      descricao: descricaoDoServico(nota, item),
      cLocPrestacao: onlyDigits(nota.municipio_prestacao || config.municipio_ibge),
    },
    valores: {
      vServ: Number(nota.valor),
      tpRetISSQN: retido ? 2 : 1,
      pAliq: retido && aliqRetida != null && aliqRetida !== '' ? Number(aliqRetida) : null,
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
 *   nota = { descricao, valor, competencia?, ctribnac?, cnbs?, municipio_prestacao?, product_id?,
 *            tomador?: { doc, nome, email?, fone?, im?, endereco? }, iss_retido?, aliquota_iss?,
 *            tot_trib?: { fed, est, mun }, customer_id?, payment_id?, source_type? }
 * @param ctx  { transport?, now?, timeoutMs?, retry? } (testes)
 * @returns {{ nota, replay?: boolean, aguardando?: boolean }}
 */
async function emitir(db, { companyId, idempotencyKey, nota = {} }, ctx = {}) {
  exigirLigado();
  const key = validarChave(idempotencyKey);
  if (key.startsWith('teste:')) {
    throw new NfseNacionalError('Chaves que começam com "teste:" são da nota de teste (POST /nfse/teste).', 'IDEMPOTENCY_KEY');
  }
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

  // Serviço do estoque citado pela nota (migration 437). Só numa emissão
  // nova: a retomada usa os dados já gravados (dps_dados), então editar o
  // item depois não muda uma nota que já tem número.
  let item = null;
  if (nota.product_id) {
    item = await repo.buscarItem(db, companyId, nota.product_id);
    if (!item) {
      throw new NfseNacionalError(
        'Não encontramos este serviço no estoque desta empresa. Confira se ele não foi excluído — item de outra empresa do grupo só vale aqui quando está compartilhado.',
        'NOT_FOUND'
      );
    }
  }

  const entrada = montarEntrada({ nota, config, company, tpAmb: ep.tpAmb, dhEmi: comMargem(ctx), item });
  if (entrada.valores.tpRetISSQN === 2 && entrada.prestador.opSimpNac === 3 && entrada.valores.pAliq == null) {
    throw new NfseNacionalError(
      'Esta nota tem Retenção do ISSQN pelo cliente, e ainda falta a Alíquota do ISSQN no Simples Nacional. '
        + 'Peça o número ao seu contador e preencha em Notas fiscais > Emitir NFS-e. Nada foi enviado.',
      'ALIQUOTA_RETENCAO_AUSENTE'
    );
  }
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

// ── nota de teste (migration 440) ──────────────────────────

const NOTA_TESTE = Object.freeze({
  descricao: 'NOTA DE TESTE - SEM VALOR FISCAL. Conferencia da configuracao da NFS-e na Aura.',
  valor: 1,
  source_type: 'teste',
});

const PASSOS_DO_TESTE = ['certificado', 'dados_fiscais', 'codigo_padrao', 'serie'];

function cidadeDe(company) {
  const c = company && company.address_city;
  return c ? String(c).trim() : '';
}

function codigosDe(nota) {
  const e = nota && nota.error_codes;
  return Array.isArray(e) ? e.filter((x) => x && x.codigo) : [];
}

/**
 * Resultado da nota de teste em português simples: o que aconteceu, em que
 * passo cai e o caminho a seguir. E0084/E0116/E0120 caem no passo
 * "prefeitura" (cadastro que só a prefeitura faz). Nunca "não atendido".
 * @returns {{ status: 'ok'|'rejeitado'|'erro', passo, codigo, titulo, mensagem, caminho: string[], aguardando? }}
 */
function traduzirResultadoTeste({ nota = null, aguardando = false, erro = null, company = null }) {
  const cidade = cidadeDe(company);
  const pref = cidade ? `a prefeitura de ${cidade}` : 'a prefeitura';
  const Pref = pref.charAt(0).toUpperCase() + pref.slice(1);
  const semResposta = {
    status: 'erro', passo: 'teste', codigo: null,
    titulo: 'Não conseguimos resposta do gov.br agora.',
    mensagem: 'Nada foi cobrado e nenhuma nota de verdade saiu. Tente de novo em alguns minutos.',
    caminho: [],
  };
  if (erro) {
    if (erro.code === 'CERTIFICADO') {
      return {
        status: 'erro', passo: 'certificado', codigo: null,
        titulo: 'O certificado digital A1 não passou na conferência.',
        mensagem: erro.message,
        caminho: ['Envie de novo o certificado A1 desta empresa (arquivo .pfx e senha).', 'Depois, emita a nota de teste de novo.'],
      };
    }
    if (erro.code === 'NACIONAL_INDISPONIVEL') return semResposta;
    return {
      status: 'erro', passo: 'teste', codigo: null,
      titulo: 'A nota de teste não saiu.',
      mensagem: erro.message,
      caminho: [],
    };
  }
  if (aguardando || !nota || nota.status === 'pendente') return { ...semResposta, aguardando: true };
  if (nota.status === 'autorizada') {
    return {
      status: 'ok', passo: 'teste', codigo: null,
      titulo: 'Deu certo! O gov.br aceitou a nota de teste.',
      mensagem: 'Certificado, prefeitura e código conferem. Falta só ligar a NFS-e.',
      caminho: [],
    };
  }
  if (nota.status === 'rejeitada') {
    const cods = codigosDe(nota);
    const daPref = cods.find((c) => CODIGOS_PREFEITURA.has(c.codigo));
    if (daPref && daPref.codigo === 'E0084') {
      return {
        status: 'rejeitado', passo: 'prefeitura', codigo: 'E0084',
        titulo: `Quase lá: ${pref} ainda não liberou a sua empresa no Emissor Nacional.`,
        mensagem: 'O certificado e o código estão certos. Falta um cadastro que só a prefeitura faz: '
          + 'incluir a empresa no Cadastro Nacional de Contribuintes da NFS-e (CNC). Não é erro seu nem da Aura.',
        caminho: [
          `Peça ao setor de tributos (ISS) de ${pref} para incluir a empresa no Cadastro Nacional de Contribuintes da NFS-e (CNC).`,
          'Se a prefeitura passar uma Inscrição Municipal, preencha aqui.',
          'Assim que a prefeitura fizer o cadastro, emita a nota de teste de novo.',
        ],
      };
    }
    if (daPref && daPref.codigo === 'E0116') {
      return {
        status: 'rejeitado', passo: 'prefeitura', codigo: 'E0116',
        titulo: `${Pref} pede a Inscrição Municipal na nota.`,
        mensagem: 'O resto está certo. A sua cidade pede a Inscrição Municipal da empresa em toda NFS-e.',
        caminho: [
          'A Inscrição Municipal está no alvará ou no carnê do ISS. Se não tiver, peça à prefeitura.',
          'Preencha a Inscrição Municipal aqui.',
          'Emita a nota de teste de novo.',
        ],
      };
    }
    if (daPref && daPref.codigo === 'E0120') {
      return {
        status: 'rejeitado', passo: 'prefeitura', codigo: 'E0120',
        titulo: 'A Inscrição Municipal ainda não aparece no cadastro da prefeitura.',
        mensagem: 'O gov.br recebeu a Inscrição Municipal, mas a prefeitura ainda não cadastrou a empresa com ela no Cadastro Nacional de Contribuintes da NFS-e (CNC).',
        caminho: [
          `Peça a ${pref} para incluir a empresa e a Inscrição Municipal no CNC da NFS-e.`,
          'Se a sua cidade não pede Inscrição Municipal, apague o campo e emita a nota de teste de novo.',
        ],
      };
    }
    const primeiro = cods[0] || null;
    return {
      status: 'rejeitado', passo: 'teste', codigo: primeiro ? primeiro.codigo : null,
      titulo: 'O gov.br devolveu a nota de teste com um aviso.',
      mensagem: (primeiro && primeiro.descricao ? `Aviso do gov.br: ${primeiro.descricao}. ` : '')
        + 'Em caso de dúvidas, acione seu contador ou o suporte Aura.',
      caminho: [],
    };
  }
  return semResposta; // 'erro': falha nossa ou certificado recusado na conexão
}

/**
 * Emite a nota de teste: SEMPRE em produção restrita (tpAmb 2), valor
 * mínimo, descrição de teste, série SERIE_TESTE com contador próprio
 * (teste_next_dps_number) e chave de idempotência própria ("teste:...").
 * Não exige is_active nem a produção liberada — é o que vem ANTES de ligar.
 * Grava o resultado em nfse_config.ultimo_teste_*.
 * @param {{ companyId, idempotencyKey? }} p — sem chave, uma nova por chamada
 * @returns {{ resultado, nota, replay? }}
 */
async function emitirTeste(db, { companyId, idempotencyKey }, ctx = {}) {
  exigirLigado();
  const sufixo = String(idempotencyKey == null ? '' : idempotencyKey).trim() || crypto.randomUUID();
  const key = validarChave(`teste:${sufixo}`);

  const { config, company, certInfo } = await repo.carregarContexto(db, companyId);
  if (!config) {
    throw new NfseNacionalError(
      'Antes da nota de teste, confira os dados da nota: município, Situação perante o Simples Nacional, Código de Tributação Nacional e Série da DPS.',
      'CONFIG_MISSING'
    );
  }
  const av = avaliarPassos({ config, company, certInfo, now: agora(ctx) });
  const faltam = PASSOS_DO_TESTE.filter((k) => av.passos[k].estado !== 'ok');
  if (faltam.length) {
    throw new NfseNacionalError(
      'A nota de teste libera quando estes passos estiverem prontos: ' + faltam.map((k) => av.passos[k].motivo).join(' '),
      'TESTE_TRAVADO',
      faltam
    );
  }
  const ep = getEndpoints('producao_restrita');
  const env = { config, company, ep };

  let r;
  try {
    const existente = await repo.buscarPorChave(db, companyId, key);
    if (existente && FINAIS.has(existente.status)) {
      r = { nota: existente, replay: true };
    } else {
      if (breaker.isOpen(companyId)) {
        throw new NfseNacionalError('O Sistema Nacional NFS-e não respondeu nas últimas tentativas.', 'NACIONAL_INDISPONIVEL');
      }
      if (existente) {
        r = await retomar(db, existente, env, ctx);
      } else {
        // Teste sem valor fiscal: sem o percentual do Simples ainda (ele é
        // pedido no último passo), vai 0,00; não optante vai com tributos 0.
        const { opSimpNac } = resolverRegime(config);
        const cfgTeste = { ...config, p_tot_trib_sn: config.p_tot_trib_sn != null ? config.p_tot_trib_sn : 0 };
        const nota = { ...NOTA_TESTE, ...(opSimpNac === 1 ? { tot_trib: { fed: 0, est: 0, mun: 0 } } : {}) };
        const entrada = montarEntrada({ nota, config: cfgTeste, company, tpAmb: ep.tpAmb, dhEmi: comMargem(ctx) });
        const erros = validarEntrada(entrada, { semNumero: true });
        if (erros.length) throw new NfseNacionalError('Algum dado da nota não passou na conferência: ' + erros.join(' '), 'INVALID_INPUT', erros);
        const reserva = await repo.reservar(db, {
          companyId, key, fp: fingerprint(nota), entrada, nota, ambiente: ep.ambiente, serieTeste: SERIE_TESTE,
        });
        if (reserva.semConfig) throw new NfseNacionalError('NFS-e não configurada nesta empresa.', 'CONFIG_MISSING');
        if (reserva.corrida) {
          const outra = await repo.buscarPorChave(db, companyId, key);
          r = { nota: outra, replay: true, aguardando: !(outra && FINAIS.has(outra.status)) };
        } else {
          r = await montarETransmitir(db, reserva.row, entrada, env, ctx);
        }
      }
    }
  } catch (err) {
    if (!(err instanceof NfseNacionalError)) throw err;
    const resultado = traduzirResultadoTeste({ erro: err, company });
    await repo.gravarResultadoTeste(db, companyId, { status: resultado.status, codigo: resultado.codigo, mensagem: resultado.titulo, nfseId: null });
    return { resultado, nota: null };
  }
  const resultado = traduzirResultadoTeste({ nota: r.nota, aguardando: r.aguardando, company });
  await repo.gravarResultadoTeste(db, companyId, {
    status: resultado.status, codigo: resultado.codigo, mensagem: resultado.titulo, nfseId: r.nota && r.nota.id,
  });
  return { resultado, nota: r.nota, replay: !!r.replay };
}

/**
 * Pode ligar a NFS-e (is_active) com esta config final? Exige os passos
 * obrigatórios prontos, a nota de teste aceita em produção restrita e, no
 * Simples (ME/EPP), o percentual de tributos e a resposta sobre a retenção.
 * A trava da produção (NFSE_NACIONAL_PRODUCAO) é conferida pela rota.
 * @returns {{ ok: boolean, motivos: string[], passos }}
 */
async function avaliarLigar(db, companyId, configFinal) {
  const { company, certInfo } = await repo.carregarContexto(db, companyId);
  const av = avaliarPassos({ config: configFinal, company, certInfo, producaoLiberada: true });
  const motivos = PASSOS_DO_TESTE.filter((k) => av.passos[k].estado !== 'ok').map((k) => av.passos[k].motivo);
  if (av.passos.teste.estado !== 'ok') {
    motivos.push('Antes de ligar, emita a nota de teste: ela confere, sem valor fiscal, que o gov.br aceita as suas notas.');
  }
  motivos.push(...faltasParaLigar(configFinal));
  return { ok: motivos.length === 0, motivos, passos: av.passos };
}

/** Situação da configuração (sem segredo) para a tela/GET /config. */
async function situacaoConfig(db, companyId) {
  const { config, company, certInfo } = await repo.carregarContexto(db, companyId);
  const apt = avaliarAptidao({ config, company, certInfo, producaoLiberada: producaoHabilitada() });
  return {
    ...apt,
    ligado: nacionalHabilitado(),
    ambiente: getEndpoints(config && config.ambiente).ambiente,
    certificado: certInfo ? { subject_cn: certInfo.subject_cn, not_after: certInfo.not_after } : null,
    sugestao: sugestaoDaEmpresa(company),
    serie_teste: SERIE_TESTE,
  };
}

module.exports = {
  emitir, cancelar, consultar, danfse, situacaoConfig, emitirTeste, traduzirResultadoTeste, avaliarLigar,
  montarEntrada, fingerprint,
  _breaker: breaker,
  MARGEM_RELOGIO_MS,
};
