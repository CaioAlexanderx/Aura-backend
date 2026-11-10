// ============================================================
// AURA. — nfseNacional/config: regras da configuração por empresa
// (nfse_config, colunas da migration 429) — funções PURAS.
//
// Uma empresa está APTA a emitir pelo emissor nacional só com:
//   - certificado A1 válido em company_certificates (o MESMO cofre da
//     NFC-e própria — não existe "segundo certificado" para a NFS-e);
//   - CNPJ válido no cadastro da empresa;
//   - código IBGE do município emissor (7 dígitos);
//   - código de tributação nacional padrão (cTribNac, 6 dígitos);
//   - situação no Simples definida; para ME/EPP também o percentual
//     aproximado de tributos do Simples (pTotTribSN), que o leiaute
//     obriga em totTrib (E0712: ME/EPP não pode usar indTotTrib).
// Inscrição municipal é OPCIONAL (a API nacional não exige; o Sefin cobra
// só quando o município tem cadastro complementar no CNC — E0116).
// ============================================================
'use strict';

const { isValidCnpj } = require('../../utils/cpfCnpj');
const { cnpjDoCn } = require('../sefazSp/certCnpj');
const { normalizarSerie } = require('./dpsBuilder');
const { normalizarAliquotaIss } = require('../camposNfseDoItem');

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const temTexto = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Situação no Simples (opSimpNac 1/2/3) e regime de apuração.
 * Coluna explícita primeiro; senão deduz do regime_tributario/optante antigos.
 */
function resolverRegime(config = {}) {
  let op = config.op_simp_nac != null ? Number(config.op_simp_nac) : null;
  if (!op) {
    const r = String(config.regime_tributario || '').toLowerCase();
    if (r === 'mei') op = 2;
    else if (r === 'normal' || r === 'lucro_presumido' || r === 'lucro_real') op = 1;
    else if (r.startsWith('simples')) op = 3;
    else op = config.optante_simples_nacional === false ? 1 : 3;
  }
  let regAp = config.reg_ap_trib_sn != null ? Number(config.reg_ap_trib_sn) : null;
  if (op === 3 && !regAp) regAp = 1;
  if (op !== 3) regAp = null;
  const regEsp = config.reg_esp_trib != null ? Number(config.reg_esp_trib) : 0;
  return { opSimpNac: op, regApTribSN: regAp, regEspTrib: regEsp };
}

/**
 * @param {{ config, company, certInfo, now? }} p — certInfo = getCertificateInfo (sem segredo)
 * @returns {{ apta: boolean, pendencias: string[] }}
 */
function avaliarAptidao({ config, company, certInfo, now = new Date(), producaoLiberada = false }) {
  return {
    ...avaliarPendencias({ config, company, certInfo, now }),
    ...avaliarPassos({ config, company, certInfo, now, producaoLiberada }),
  };
}

/** apta + pendências em texto (o contrato de sempre; emitir() depende dele). */
function avaliarPendencias({ config, company, certInfo, now }) {
  const pend = [];
  if (!config) return { apta: false, pendencias: ['Configuração de NFS-e não cadastrada.'] };
  if (config.provider !== 'nacional') pend.push('O emissor configurado não é o nacional.');
  if (!config.is_active) pend.push('A emissão de NFS-e está desativada nesta empresa.');

  const cnpj = onlyDigits(company && company.cnpj);
  if (!isValidCnpj(cnpj)) pend.push('CNPJ da empresa ausente ou inválido no cadastro.');

  if (!certInfo) {
    pend.push('Certificado digital A1 não enviado (Configurações > Nota Fiscal).');
  } else {
    if (certInfo.not_after && new Date(certInfo.not_after) <= now) pend.push('Certificado digital A1 vencido.');
    const doCert = cnpjDoCn(certInfo.subject_cn);
    if (doCert && cnpj && doCert !== cnpj) pend.push('O certificado A1 é de outro CNPJ.');
  }

  if (!/^\d{7}$/.test(onlyDigits(config.municipio_ibge))) pend.push('Código IBGE do município emissor (7 dígitos) não configurado.');
  if (!/^\d{6}$/.test(String(config.ctribnac_padrao || ''))) pend.push('Código de tributação nacional padrão (6 dígitos) não configurado.');

  const serie = normalizarSerie(config.serie || '1');
  if (!serie || Number(serie) < 1 || Number(serie) > 49999) pend.push('Série da DPS fora da faixa 1–49999.');

  const { opSimpNac } = resolverRegime(config);
  if (opSimpNac === 3) {
    const p = Number(config.p_tot_trib_sn);
    if (config.p_tot_trib_sn == null || !Number.isFinite(p) || p < 0 || p >= 100) {
      pend.push('Percentual aproximado de tributos do Simples (pTotTribSN) não configurado.');
    }
  }
  return { apta: pend.length === 0, pendencias: pend };
}

// ── passo a passo da tela "Pronto para emitir NFS-e?" (migration 441) ──

/** Ordem dos passos na tela. As chaves são o contrato com o app. */
const PASSOS = ['certificado', 'prefeitura', 'dados_fiscais', 'codigo_padrao', 'serie', 'teste', 'ligar'];

/**
 * Avisos do Sistema Nacional que dependem de um cadastro que só a prefeitura
 * faz: E0084 (CNPJ sem estabelecimento no município / fora do CNC), E0116
 * (Inscrição Municipal exigida pelo cadastro complementar), E0120
 * (Inscrição Municipal informada sem cadastro no CNC).
 */
const CODIGOS_PREFEITURA = new Set(['E0084', 'E0116', 'E0120']);

/**
 * Rejeições que só acontecem no ambiente de testes do gov.br (produção
 * restrita), nunca por erro da loja. Quando a nota de teste volta SÓ com
 * códigos desta lista, o teste conta como pronto, com aviso, e "Ligar" fica
 * liberado. Qualquer outro código junto mantém o bloqueio.
 *
 *   E0312 — "O código de tributação nacional informado não está
 *           administrado pelo município de incidência do ISSQN na data de
 *           competência". Caso real de 10/11/2026: loja de São Paulo
 *           capital (IBGE 3550308, ME/EPP) com o MESMO cTribNac (130501)
 *           que ela já usa para emitir no ambiente de PRODUÇÃO do Emissor
 *           Nacional; as três notas de teste voltaram só com o E0312 (sem
 *           E0084). O município parametrizou o código na produção e não na
 *           produção restrita.
 *
 * Nunca entram aqui os códigos da prefeitura (E0084, E0116, E0120): eles
 * dependem de um cadastro que a loja precisa pedir, e a nota de verdade
 * voltaria com o mesmo aviso. aceitoComAvisoDoAmbienteDeTestes recusa esses
 * códigos mesmo que alguém os ponha na lista.
 */
const ERROS_SO_DO_AMBIENTE_DE_TESTES = Object.freeze(['E0312']);

const AVISO_SO_DO_AMBIENTE_DE_TESTES = 'O gov.br aceitou o certificado, os dados e o cadastro da sua empresa. '
  + 'Só o código do serviço ainda não está habilitado pela prefeitura no ambiente de testes do governo. '
  + 'Pode ligar: a primeira nota de verdade confirma tudo.';

/** Códigos ("E0312") de error_codes ([{ codigo, descricao }]) da nota. */
function codigosDoErro(errorCodes) {
  let lista = errorCodes;
  if (typeof lista === 'string') {
    try { lista = JSON.parse(lista); } catch { lista = null; }
  }
  if (!Array.isArray(lista)) return [];
  return lista
    .map((e) => (e && typeof e === 'object' ? e.codigo : e))
    .filter((c) => c != null && String(c).trim() !== '')
    .map((c) => String(c).trim().toUpperCase());
}

/**
 * A nota de teste rejeitada só com códigos de ERROS_SO_DO_AMBIENTE_DE_TESTES?
 * Lista vazia (rejeição sem código) não conta; código da prefeitura nunca conta.
 */
function aceitoComAvisoDoAmbienteDeTestes(errorCodes) {
  const cods = codigosDoErro(errorCodes);
  if (!cods.length) return false;
  return cods.every((c) => ERROS_SO_DO_AMBIENTE_DE_TESTES.includes(c) && !CODIGOS_PREFEITURA.has(c));
}

/**
 * O último teste foi rejeitado só pelo ambiente de testes? Lê os error_codes
 * da nota de teste (ultimo_teste_nfse_id), que o repo traz em
 * config.ultimo_teste_error_codes — não só o ultimo_teste_codigo, que guarda
 * um código só.
 */
function testeComAvisoDoAmbiente(config) {
  return !!config && config.ultimo_teste_status === 'rejeitado'
    && aceitoComAvisoDoAmbienteDeTestes(config.ultimo_teste_error_codes);
}

/**
 * Série reservada para a nota de teste em produção restrita. Fica na faixa
 * de "aplicativo próprio" (00001 a 49999 — Anexo I do leiaute da DPS,
 * campo serie) e tem contador próprio (teste_next_dps_number): o teste
 * nunca gasta a numeração da série de verdade da loja nem colide com ela no
 * índice único (company_id, dps_serie, dps_number). A série de verdade não
 * pode ser 49999 (validarCamposNacional recusa).
 */
const SERIE_TESTE = '49999';

/**
 * Faixas de utilização da série da DPS (Anexo I, SEFIN_ADN-DPS_NFSe
 * v1.01-20260209, campo serie): 00001–49999 aplicativo próprio (a Aura);
 * 50000–69999 Emissor Móvel; 70000–79999 Emissor Web; 80000–89999
 * transcrição manual (Web).
 */
function faixaDaSerie(serie) {
  const n = Number(normalizarSerie(serie));
  if (!Number.isInteger(n) || n < 1) return null;
  if (n <= 49999) return 'aplicativo_proprio';
  if (n <= 69999) return 'emissor_movel';
  if (n <= 79999) return 'emissor_web';
  if (n <= 89999) return 'transcricao_manual';
  return null;
}

const passo = (estado, motivo, extra) => ({ estado, motivo, ...(extra || {}) });

const MSG_PRODUCAO_AGUARDANDO = 'Sua loja está pronta! A Aura está liberando a emissão em produção e avisa você assim que terminar.';

function passoCertificado({ certInfo, cnpj, now }) {
  if (!certInfo) {
    return passo('falta', 'Envie o certificado digital A1 da empresa. É o mesmo da nota do Caixa (NFC-e): se já enviou lá, ele já vale aqui.');
  }
  if (certInfo.not_after && new Date(certInfo.not_after) <= now) {
    return passo('problema', 'O certificado digital A1 venceu. Envie o certificado novo para voltar a emitir.');
  }
  const doCert = cnpjDoCn(certInfo.subject_cn);
  if (doCert && cnpj && doCert !== cnpj) {
    return passo('problema', 'O certificado enviado é de outro CNPJ. Cada CNPJ, mesmo sendo filial, precisa do seu próprio certificado A1.', { cnpj_do_certificado: doCert });
  }
  return passo('ok', 'Certificado digital A1 enviado.', certInfo.not_after ? { vale_ate: certInfo.not_after } : undefined);
}

const MOTIVO_PREFEITURA = {
  E0084: 'A prefeitura ainda não liberou a sua empresa no Emissor Nacional. Falta um cadastro que só a prefeitura faz.',
  E0116: 'A prefeitura pede a Inscrição Municipal na nota. Preencha a Inscrição Municipal e emita a nota de teste de novo.',
  E0120: 'A Inscrição Municipal informada ainda não aparece no cadastro da prefeitura no Emissor Nacional.',
};

function passoPrefeitura(config) {
  const st = config.ultimo_teste_status;
  const cod = config.ultimo_teste_codigo;
  if (st === 'rejeitado' && CODIGOS_PREFEITURA.has(cod)) return passo('problema', MOTIVO_PREFEITURA[cod], { codigo: cod });
  if (st === 'ok') return passo('ok', 'A prefeitura já liberou a sua empresa: a nota de teste passou.');
  if (testeComAvisoDoAmbiente(config)) return passo('ok', 'O gov.br aceitou o cadastro da sua empresa na nota de teste.');
  if (temTexto(config.inscricao_municipal) && config.prefeitura_cadastro_confirmado === 'sim') {
    return passo('ok', 'Inscrição Municipal informada e cadastro na prefeitura feito.');
  }
  return passo('falta', 'Algumas prefeituras pedem um cadastro antes da primeira nota. A nota de teste mostra se falta algo.');
}

function passoDadosFiscais({ config, cnpj }) {
  if (!isValidCnpj(cnpj)) {
    return passo('problema', 'O CNPJ da empresa está ausente ou inválido no cadastro. Confira em Configurações > Empresa.');
  }
  const ibge = /^\d{7}$/.test(onlyDigits(config.municipio_ibge));
  if (!ibge || config.op_simp_nac == null) {
    return passo('falta', 'Confira o município e a Situação perante o Simples Nacional. Já trouxemos da Receita.');
  }
  return passo('ok', 'Município e Situação perante o Simples Nacional conferidos.');
}

function passoCodigoPadrao(config) {
  if (!/^\d{6}$/.test(String(config.ctribnac_padrao || ''))) {
    return passo('falta', 'Escolha o Código de Tributação Nacional usado quando o serviço não tem código próprio.');
  }
  return passo('ok', 'Código de Tributação Nacional escolhido.');
}

function passoSerie(config, temConfig) {
  if (!temConfig) return passo('falta', 'Conte se você já emite NFS-e pelo Emissor Nacional, para a numeração não se repetir.');
  const serie = normalizarSerie(config.serie || '1');
  if (faixaDaSerie(serie) !== 'aplicativo_proprio' || serie === SERIE_TESTE) {
    return passo('problema', 'A Série da DPS da Aura precisa estar entre 1 e 49998, a faixa de aplicativo próprio do Sistema Nacional.');
  }
  const proximo = String(Number(config.next_dps_number) || 1);
  if (!config.serie_confirmada_em && Number(proximo) <= 1) {
    return passo('falta', 'Conte se você já emite NFS-e pelo Emissor Nacional, para a numeração não se repetir.');
  }
  return passo('ok', `Série da DPS ${serie}, próximo Número da DPS ${proximo}.`, { serie, proximo_numero: proximo });
}

function passoTeste(config, basePronta) {
  const st = config.ultimo_teste_status;
  const extra = config.ultimo_teste_em ? {
    em: config.ultimo_teste_em,
    codigo: config.ultimo_teste_codigo || null,
    nfse_id: config.ultimo_teste_nfse_id || null,
  } : undefined;
  if (st === 'ok') return passo('ok', 'O gov.br aceitou a nota de teste.', extra);
  // Pronto com aviso: estado 'ok' (libera o Ligar), motivo = aviso e o
  // campo `aviso` com o mesmo texto, para o app pintar o cartão de aviso.
  if (testeComAvisoDoAmbiente(config)) {
    return passo('ok', AVISO_SO_DO_AMBIENTE_DE_TESTES, {
      ...extra, aviso: AVISO_SO_DO_AMBIENTE_DE_TESTES, codigos: codigosDoErro(config.ultimo_teste_error_codes),
    });
  }
  if (st === 'rejeitado' || st === 'erro') {
    return passo('problema', config.ultimo_teste_mensagem || 'A nota de teste voltou com um aviso do gov.br.', extra);
  }
  if (!basePronta) return passo('travado', 'Libera quando o certificado e os dados da nota estiverem prontos.');
  return passo('falta', 'Emita uma nota de teste, sem valor fiscal, para conferir que está tudo certo.');
}

/**
 * O que falta, além do teste, para ligar (campos do último passo). A
 * alíquota do ISSQN retido no Simples só é pedida a quem diz que algum
 * cliente retém — e nunca vem preenchida.
 */
function faltasParaLigar(config) {
  const f = [];
  const { opSimpNac } = resolverRegime(config);
  if (opSimpNac !== 3) return f;
  const p = Number(config.p_tot_trib_sn);
  if (config.p_tot_trib_sn == null || !Number.isFinite(p) || p < 0 || p >= 100) {
    f.push('Preencha a alíquota do Simples Nacional (valor aproximado dos tributos), que o seu contador tem.');
  }
  if (config.cliente_retem_iss == null) {
    f.push('Responda se algum cliente faz a Retenção do ISSQN.');
  } else if (config.cliente_retem_iss === true) {
    const a = Number(config.aliquota_iss_retencao_sn);
    if (config.aliquota_iss_retencao_sn == null || !Number.isFinite(a) || a < 1.8 || a > 5) {
      f.push('Preencha a Alíquota do ISSQN no Simples Nacional, que o seu contador tem (entre 1,80% e 5,00%).');
    }
  }
  return f;
}

function passoLigar(config, { testeOk, producaoLiberada }) {
  const emProducao = String(config.ambiente || '').trim().toLowerCase() === 'producao';
  if (config.is_active && config.provider === 'nacional' && emProducao) {
    if (!producaoLiberada) return passo('travado', MSG_PRODUCAO_AGUARDANDO, { aguardando_aura: true });
    return passo('ok', 'NFS-e ligada nesta loja.');
  }
  if (!testeOk) return passo('travado', 'Libera depois que a nota de teste passar.');
  const faltas = faltasParaLigar(config);
  if (faltas.length) return passo('falta', faltas[0], { faltas });
  if (!producaoLiberada) return passo('travado', MSG_PRODUCAO_AGUARDANDO, { aguardando_aura: true });
  return passo('falta', 'Falta só ligar a NFS-e.');
}

/**
 * Estado de cada passo por chave: { estado: ok|falta|problema|travado, motivo, ... }.
 * Pura. Sem config (loja que nunca abriu a tela) os passos aparecem como
 * "falta"/"travado" — o certificado já pode estar ok (cofre da NFC-e).
 * @param {{ config, company, certInfo, now?, producaoLiberada? }} p
 */
function avaliarPassos({ config, company, certInfo, now = new Date(), producaoLiberada = false }) {
  const cfg = config || {};
  const cnpj = onlyDigits(company && company.cnpj);
  const passos = {
    certificado: passoCertificado({ certInfo, cnpj, now }),
    prefeitura: passoPrefeitura(cfg),
    dados_fiscais: passoDadosFiscais({ config: cfg, cnpj }),
    codigo_padrao: passoCodigoPadrao(cfg),
    serie: passoSerie(cfg, !!config),
  };
  const basePronta = ['certificado', 'dados_fiscais', 'codigo_padrao', 'serie'].every((k) => passos[k].estado === 'ok');
  passos.teste = passoTeste(cfg, basePronta);
  passos.ligar = passoLigar(cfg, { testeOk: passos.teste.estado === 'ok', producaoLiberada });
  const proximo = PASSOS.find((k) => passos[k].estado === 'problema')
    // a prefeitura só vira pendência quando o teste volta com aviso dela
    || PASSOS.find((k) => k !== 'prefeitura' && passos[k].estado === 'falta') || null;
  return {
    passos,
    ordem: PASSOS,
    prontos: PASSOS.filter((k) => passos[k].estado === 'ok').length,
    total: PASSOS.length,
    proximo,
    base_pronta: basePronta,
    pronta_para_ligar: basePronta && passos.teste.estado === 'ok' && faltasParaLigar(cfg).length === 0,
    emitindo: passos.ligar.estado === 'ok',
    producao_liberada: !!producaoLiberada,
  };
}

/**
 * Situação perante o Simples Nacional (opSimpNac) a partir do regime que a
 * Receita devolve (companies.tax_regime, backend#805). null = não sabemos.
 */
function opSimpNacDoRegime(taxRegime) {
  const r = String(taxRegime || '').trim().toLowerCase();
  if (r === 'mei') return 2;
  if (r.startsWith('simples')) return 3;
  if (r === 'lucro_presumido' || r === 'lucro_real' || r === 'normal') return 1;
  return null;
}

/**
 * Dados que a tela já mostra preenchidos, vindos do cadastro da empresa
 * (companies). ibge_code nulo: sem utilitário de nome → IBGE no backend,
 * devolve vazio para a lojista confirmar.
 */
function sugestaoDaEmpresa(company) {
  const c = company || {};
  const ibge = onlyDigits(c.ibge_code);
  const op = opSimpNacDoRegime(c.tax_regime);
  return {
    cnpj: onlyDigits(c.cnpj) || null,
    nome: c.nome || null,
    municipio: c.address_city || null,
    uf: c.address_state || null,
    municipio_ibge: /^\d{7}$/.test(ibge) ? ibge : null,
    op_simp_nac: op,
    reg_ap_trib_sn: op === 3 ? 1 : null,
    fonte: 'receita',
  };
}

const AMBIENTES = new Set(['producao_restrita', 'homologacao', 'producao']);

/**
 * Valida (e normaliza) os campos do emissor nacional vindos no PUT /config.
 * Só olha o que veio. @returns {{ data: object, erros: string[] }}
 */
function validarCamposNacional(body = {}) {
  const data = {};
  const erros = [];
  if (body.ambiente !== undefined) {
    const a = String(body.ambiente || '').trim().toLowerCase();
    if (!AMBIENTES.has(a)) erros.push('ambiente deve ser producao_restrita ou producao.');
    else data.ambiente = a;
  }
  if (body.municipio_ibge !== undefined) {
    const v = onlyDigits(body.municipio_ibge);
    if (!/^\d{7}$/.test(v)) erros.push('municipio_ibge deve ter 7 dígitos.');
    else data.municipio_ibge = v;
  }
  if (body.ctribnac_padrao !== undefined) {
    const v = onlyDigits(body.ctribnac_padrao);
    if (!/^\d{6}$/.test(v)) erros.push('ctribnac_padrao deve ter 6 dígitos (ex.: 010501).');
    else data.ctribnac_padrao = v;
  }
  if (body.cnbs_padrao !== undefined) {
    const v = body.cnbs_padrao === null || body.cnbs_padrao === '' ? null : onlyDigits(body.cnbs_padrao);
    if (v !== null && !/^\d{9}$/.test(v)) erros.push('cnbs_padrao deve ter 9 dígitos.');
    else data.cnbs_padrao = v;
  }
  if (body.op_simp_nac !== undefined) {
    const v = body.op_simp_nac === null ? null : Number(body.op_simp_nac);
    if (v !== null && ![1, 2, 3].includes(v)) erros.push('op_simp_nac deve ser 1 (não optante), 2 (MEI) ou 3 (ME/EPP).');
    else data.op_simp_nac = v;
  }
  if (body.reg_ap_trib_sn !== undefined) {
    const v = body.reg_ap_trib_sn === null ? null : Number(body.reg_ap_trib_sn);
    if (v !== null && ![1, 2, 3].includes(v)) erros.push('reg_ap_trib_sn deve ser 1, 2 ou 3.');
    else data.reg_ap_trib_sn = v;
  }
  if (body.reg_esp_trib !== undefined) {
    const v = Number(body.reg_esp_trib);
    if (![0, 1, 2, 3, 4, 5, 6, 9].includes(v)) erros.push('reg_esp_trib inválido.');
    else data.reg_esp_trib = v;
  }
  if (body.p_tot_trib_sn !== undefined) {
    const v = body.p_tot_trib_sn === null ? null : Number(body.p_tot_trib_sn);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v >= 100)) erros.push('p_tot_trib_sn deve ser um percentual entre 0 e 99,99.');
    else data.p_tot_trib_sn = v;
  }
  if (body.serie !== undefined) {
    const s = normalizarSerie(body.serie);
    const faixa = faixaDaSerie(s);
    if (faixa === 'emissor_web' || faixa === 'transcricao_manual' || faixa === 'emissor_movel') {
      erros.push(`A Série da DPS (serie) ${s} é da faixa do emissor do gov.br. Pela Aura a série fica entre 1 e 49998 (faixa de aplicativo próprio, Anexo I do leiaute da DPS), então ela nunca se encontra com as notas emitidas no site ou no app do gov.br.`);
    } else if (s === SERIE_TESTE) {
      erros.push(`A Série da DPS (serie) ${SERIE_TESTE} é reservada para a nota de teste da Aura. Use outra série entre 1 e 49998.`);
    } else if (faixa !== 'aplicativo_proprio') {
      erros.push('serie deve estar entre 1 e 49998 (Série da DPS da faixa de aplicativo próprio).');
    } else data.serie = s;
  }
  if (body.next_dps_number !== undefined) {
    const v = Number(body.next_dps_number);
    if (!Number.isInteger(v) || v < 1 || v > 999999999999999) erros.push('next_dps_number deve ser inteiro positivo.');
    else data.next_dps_number = v;
  }
  // 10/11/2026 (migration 437): alíquota padrão do ISS da empresa, último
  // degrau de nota → item → empresa. Mesma régua do cadastro do item.
  if (body.default_iss_rate !== undefined) {
    const r = normalizarAliquotaIss(body.default_iss_rate);
    if (r.error || r.value === null) erros.push('default_iss_rate deve ser a alíquota do ISS em %, entre 0 e 5 (ex.: 2 ou 2,5).');
    else data.default_iss_rate = r.value;
  }
  // ── migration 441: passo a passo da configuração ──
  if (body.inscricao_municipal !== undefined) {
    const v = body.inscricao_municipal == null ? '' : String(body.inscricao_municipal).trim();
    if (v.length > 15) erros.push('A Inscrição Municipal (inscricao_municipal) tem no máximo 15 caracteres no leiaute da DPS.');
    else data.inscricao_municipal = v || null;
  }
  if (body.prefeitura_cadastro_confirmado !== undefined) {
    const v = body.prefeitura_cadastro_confirmado;
    if (v !== null && !CADASTRO_PREFEITURA.has(v)) erros.push('prefeitura_cadastro_confirmado deve ser sim, nao ou nao_sei.');
    else data.prefeitura_cadastro_confirmado = v;
  }
  if (body.cliente_retem_iss !== undefined) {
    const v = body.cliente_retem_iss;
    if (v !== null && typeof v !== 'boolean') erros.push('cliente_retem_iss deve ser true ou false.');
    else data.cliente_retem_iss = v;
  }
  if (body.aliquota_iss_retencao_sn !== undefined) {
    const r = normalizarAliquotaIss(body.aliquota_iss_retencao_sn);
    if (r.error || (r.value !== null && (r.value < 1.8 || r.value > 5))) {
      erros.push('A Alíquota do ISSQN no Simples Nacional (aliquota_iss_retencao_sn) fica entre 1,80% e 5,00%. Peça o número ao seu contador.');
    } else data.aliquota_iss_retencao_sn = r.value;
  }
  return { data, erros };
}

const CADASTRO_PREFEITURA = new Set(['sim', 'nao', 'nao_sei']);

/**
 * Regra da alíquota do ISSQN retido no Simples sobre o estado FINAL da
 * config (o que já existe + o que veio): só vale com cliente_retem_iss
 * verdadeiro e ME/EPP do Simples (opSimpNac 3). Dizer que nenhum cliente
 * retém apaga a alíquota. Muta `data` (limpeza) e devolve os erros.
 */
function validarRetencao(existing, data) {
  const final = { ...(existing || {}), ...data };
  const erros = [];
  if (data.cliente_retem_iss === false) data.aliquota_iss_retencao_sn = null;
  const aliq = data.aliquota_iss_retencao_sn;
  if (aliq != null) {
    if (final.cliente_retem_iss !== true) {
      erros.push('A Alíquota do ISSQN no Simples Nacional só é usada quando algum cliente faz a Retenção do ISSQN.');
    } else if (resolverRegime(final).opSimpNac !== 3) {
      erros.push('A Alíquota do ISSQN no Simples Nacional só vale para ME/EPP optante pelo Simples Nacional.');
    }
  }
  return erros;
}

module.exports = {
  resolverRegime, avaliarAptidao, avaliarPassos, validarCamposNacional, validarRetencao,
  faltasParaLigar, faixaDaSerie, sugestaoDaEmpresa, opSimpNacDoRegime,
  PASSOS, CODIGOS_PREFEITURA, SERIE_TESTE,
  ERROS_SO_DO_AMBIENTE_DE_TESTES, AVISO_SO_DO_AMBIENTE_DE_TESTES, aceitoComAvisoDoAmbienteDeTestes, codigosDoErro,
};
