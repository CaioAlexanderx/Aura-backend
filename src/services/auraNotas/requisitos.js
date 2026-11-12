// ============================================================
// AURA. — Gestão Aura > Aura Notas: requisitos de emissão (12/11/2026)
//
// Para cada empresa, a tela da equipe mostra o que está ok e o que falta
// para emitir NFC-e e NFS-e. Funções PURAS: recebem as linhas já lidas
// (companies, nfce_config, nfse_config, company_certificates) e devolvem
// a lista. Nenhum segredo entra nem sai daqui (pfx, senha e CSC token
// nunca são lidos; do CSC só se sabe se está preenchido).
//
// Nada aqui é regra nova: cada item espelha o que a emissão já exige.
//
// NFC-e (engine própria, routes/nfce.js + services/sefazSp):
//   - certificado A1 vigente ......... routes/nfce.js (engineCapable)
//   - CNPJ da empresa (14 dígitos) e
//     o mesmo do certificado ......... services/sefazSp/xmlBuilder.js (buildEmitXml)
//                                       + services/sefazSp/certCnpj.js (cnpjDoCn)
//   - inscrição estadual ............. routes/nfce.js (POST /emit) e xmlBuilder.js
//                                       (NT 2026.007, regra C17-42)
//   - regime tributário (CRT) ........ xmlBuilder.js (buildEmitXml: tax_regime)
//   - código IBGE do município ....... routes/nfce.js (POST /emit) e xmlBuilder.js
//   - UF atendida .................... services/sefazSp/endpoints.js (ENDPOINTS)
//   - CSC (id + código) .............. routes/nfce.js (engineCapable)
//   - série e próximo número ......... routes/nfce.js (serie_sefaz_sp/next_number_sefaz_sp)
//   - ambiente e NFC-e ativa ......... routes/nfce.js (POST /emit: is_active)
//
// NFS-e (emissor nacional, services/nfseNacional/config.js):
//   - avaliarPendencias / avaliarPassos são a fonte. A aptidão final
//     (`apta`) vem de avaliarAptidao, a MESMA função que a emissão usa.
//   - inscrição municipal e NBS padrão são OPCIONAIS no código (a API
//     nacional não exige IM; o NBS só vai na nota quando existe).
// ============================================================
'use strict';

const { ENDPOINTS } = require('../sefazSp/endpoints');
const { cnpjDoCn } = require('../sefazSp/certCnpj');
const { isValidCnpj } = require('../../utils/cpfCnpj');
const nfseRegras = require('../nfseNacional/config');
const { normalizarSerie } = require('../nfseNacional/dpsBuilder');
const { normalizarAmbiente } = require('../nfseNacional/endpoints');
const { TAX_REGIMES, cscOk, daysLeft } = require('./gestao');

const DIAS_AVISO_CERT = 30;
const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const temTexto = (v) => v != null && String(v).trim() !== '';

const item = (chave, rotulo, estado, detalhe, extra) => ({ chave, rotulo, estado, detalhe, ...(extra || {}) });

/** UFs que a emissão própria de NFC-e atende hoje (chaves do mapa de endpoints). */
function ufsAtendidas() {
  return Object.keys(ENDPOINTS).sort();
}

/**
 * Situação do certificado A1 (só metadados). null quando não há certificado
 * no cofre. vencido/vence_em_breve olham o not_after.
 */
function situacaoCertificado(certRow, now = new Date()) {
  if (!certRow) return null;
  const dias = daysLeft(certRow.not_after, now);
  const vencido = !!certRow.not_after && new Date(certRow.not_after) <= now;
  return {
    subject_cn: certRow.subject_cn || null,
    not_after: certRow.not_after || null,
    days_left: dias,
    vencido,
    vence_em_breve: !vencido && dias != null && dias <= DIAS_AVISO_CERT,
  };
}

function itemCertificado(cert) {
  if (!cert) return item('certificado', 'Certificado digital A1', 'falta', 'Ainda não recebemos o certificado A1 desta empresa.');
  if (cert.vencido) return item('certificado', 'Certificado digital A1', 'problema', 'O certificado A1 venceu. Precisa de um certificado novo.', { vale_ate: cert.not_after });
  if (cert.vence_em_breve) {
    return item('certificado', 'Certificado digital A1', 'aviso',
      cert.days_left === 0 ? 'O certificado vence hoje.' : `O certificado vence em ${cert.days_left} ${cert.days_left === 1 ? 'dia' : 'dias'}.`,
      { vale_ate: cert.not_after });
  }
  return item('certificado', 'Certificado digital A1', 'ok', 'Certificado vigente.', { vale_ate: cert.not_after });
}

function itemCnpjCertificado(company, cert) {
  const cnpj = onlyDigits(company && company.cnpj);
  const rot = 'CNPJ da empresa igual ao do certificado';
  if (!isValidCnpj(cnpj)) return item('cnpj_certificado', rot, 'problema', 'O CNPJ da empresa está vazio ou inválido no cadastro.');
  if (!cert) return item('cnpj_certificado', rot, 'falta', 'Confere quando o certificado chegar.');
  const doCert = cnpjDoCn(cert.subject_cn);
  if (!doCert) return item('cnpj_certificado', rot, 'aviso', 'Não deu para ler o CNPJ no nome do certificado. Vale conferir à mão.');
  if (doCert !== cnpj) return item('cnpj_certificado', rot, 'problema', 'O certificado é de outro CNPJ. Cada CNPJ precisa do seu próprio A1.', { cnpj_do_certificado: doCert });
  return item('cnpj_certificado', rot, 'ok', 'O certificado é desta empresa.');
}

/**
 * Requisitos da NFC-e. `nfce` = linha de nfce_config (ou null).
 * @returns {{ configurada: boolean, pronta: boolean, itens: object[] }}
 */
function requisitosNfce({ company, nfce, certRow, now = new Date() }) {
  const co = company || {};
  const cfg = nfce || null;
  const cert = situacaoCertificado(certRow, now);
  const itens = [itemCertificado(cert), itemCnpjCertificado(co, cert)];

  const ie = temTexto(co.inscricao_estadual) ? co.inscricao_estadual : (cfg && cfg.inscricao_estadual);
  itens.push(temTexto(ie)
    ? item('inscricao_estadual', 'Inscrição estadual', 'ok', 'Preenchida.')
    : item('inscricao_estadual', 'Inscrição estadual', 'falta', 'A inscrição estadual é obrigatória na NFC-e (NT 2026.007).'));

  const regime = String(co.tax_regime || '').trim().toLowerCase();
  if (!regime) itens.push(item('regime_tributario', 'Regime tributário', 'falta', 'Sem o regime, a nota sai como Simples Nacional.'));
  else if (!TAX_REGIMES.includes(regime)) itens.push(item('regime_tributario', 'Regime tributário', 'problema', 'O regime cadastrado não é reconhecido pela emissão.'));
  else itens.push(item('regime_tributario', 'Regime tributário', 'ok', 'Preenchido.'));

  itens.push(/^\d{7}$/.test(onlyDigits(co.ibge_code))
    ? item('municipio_ibge', 'Código IBGE do município', 'ok', 'Preenchido.')
    : item('municipio_ibge', 'Código IBGE do município', 'falta', 'A NFC-e pede o código IBGE do município (7 dígitos).'));

  const ufs = ufsAtendidas();
  // A emissão usa nfce_config.uf (padrão SP). Sem config, sugere a UF do endereço.
  const uf = String((cfg && cfg.uf) || (cfg ? 'SP' : co.address_state) || '').trim().toUpperCase();
  if (!uf) itens.push(item('uf', 'UF atendida pela emissão própria', 'falta', `Informe a UF de emissão. Hoje atendemos ${ufs.join(', ')}.`));
  else if (!ufs.includes(uf)) itens.push(item('uf', 'UF atendida pela emissão própria', 'problema', `A emissão própria ainda não atende ${uf}. Hoje atendemos ${ufs.join(', ')}.`, { uf }));
  else if (cfg && !temTexto(cfg.uf)) itens.push(item('uf', 'UF atendida pela emissão própria', 'aviso', 'Sem UF salva: a emissão usa SP. Confira se é a UF da empresa.', { uf }));
  else itens.push(item('uf', 'UF atendida pela emissão própria', 'ok', `UF ${uf}.`, { uf }));

  if (!cfg) {
    const msg = 'NFC-e ainda não configurada nesta empresa.';
    itens.push(item('csc', 'CSC e id do CSC', 'falta', msg));
    itens.push(item('serie_numero', 'Série e próximo número', 'falta', msg));
    itens.push(item('ambiente', 'Ambiente', 'falta', msg));
    itens.push(item('ativa', 'NFC-e ativa', 'falta', msg));
  } else {
    const temId = temTexto(cfg.csc_id);
    if (cscOk(cfg)) itens.push(item('csc', 'CSC e id do CSC', 'ok', 'Preenchidos.'));
    else itens.push(item('csc', 'CSC e id do CSC', 'falta', temId ? 'Falta o código do CSC.' : 'Falta o CSC (id e código), que a empresa pega no portal da SEFAZ.'));

    const serie = cfg.serie_sefaz_sp === undefined ? null : cfg.serie_sefaz_sp;
    const prox = cfg.next_number_sefaz_sp === undefined ? null : cfg.next_number_sefaz_sp;
    if (serie == null) itens.push(item('serie_numero', 'Série e próximo número', 'falta', 'Falta a série da emissão própria.'));
    else itens.push(item('serie_numero', 'Série e próximo número', 'ok', `Série ${serie}, próximo número ${prox == null ? 1 : prox}.`, { serie, proximo_numero: prox == null ? 1 : prox }));

    if (cfg.ambiente === 'producao') itens.push(item('ambiente', 'Ambiente', 'ok', 'Produção.', { ambiente: 'producao' }));
    else itens.push(item('ambiente', 'Ambiente', 'aviso', 'Homologação: as notas saem sem valor fiscal.', { ambiente: cfg.ambiente || 'homologacao' }));

    itens.push(cfg.is_active === true
      ? item('ativa', 'NFC-e ativa', 'ok', 'Ativa para emissão.')
      : item('ativa', 'NFC-e ativa', 'falta', 'A emissão de NFC-e está desligada nesta empresa.'));
  }

  const pronta = itens.every((i) => i.estado === 'ok' || i.estado === 'aviso' || i.estado === 'opcional')
    && itens.find((i) => i.chave === 'ambiente').estado === 'ok';
  return { configurada: !!cfg, pronta, itens };
}

/**
 * Requisitos da NFS-e (emissor nacional). `nfse` = linha de nfse_config
 * (ou null). `apta` e `pendencias` vêm de avaliarAptidao — a mesma conta
 * da emissão; os itens detalham cada campo para a tela.
 */
function requisitosNfse({ company, nfse, certRow, now = new Date() }) {
  const co = company || {};
  const cfg = nfse || null;
  const certInfo = certRow ? { subject_cn: certRow.subject_cn, not_after: certRow.not_after } : null;
  const apt = nfseRegras.avaliarAptidao({ config: cfg, company: co, certInfo, now });
  const passos = apt.passos;
  const c = cfg || {};
  const cert = situacaoCertificado(certRow, now);
  const itens = [itemCertificado(cert), itemCnpjCertificado(co, cert)];

  itens.push(/^\d{7}$/.test(onlyDigits(c.municipio_ibge))
    ? item('municipio_ibge', 'Município (código IBGE)', 'ok', 'Preenchido.')
    : item('municipio_ibge', 'Município (código IBGE)', 'falta', 'Falta o código IBGE do município emissor (7 dígitos).'));

  if (c.op_simp_nac == null) {
    itens.push(item('regime_simples', 'Situação no Simples Nacional', 'falta', 'Falta dizer se é não optante, MEI ou ME/EPP.'));
  } else {
    const { opSimpNac } = nfseRegras.resolverRegime(c);
    const p = Number(c.p_tot_trib_sn);
    const faltaPercentual = opSimpNac === 3 && (c.p_tot_trib_sn == null || !Number.isFinite(p) || p < 0 || p >= 100);
    itens.push(faltaPercentual
      ? item('regime_simples', 'Situação no Simples Nacional', 'falta', 'ME/EPP precisa do percentual aproximado de tributos do Simples.')
      : item('regime_simples', 'Situação no Simples Nacional', 'ok', 'Preenchida.', { op_simp_nac: opSimpNac }));
  }

  itens.push(/^\d{6}$/.test(String(c.ctribnac_padrao || ''))
    ? item('ctribnac_padrao', 'Código de tributação nacional padrão', 'ok', 'Preenchido.')
    : item('ctribnac_padrao', 'Código de tributação nacional padrão', 'falta', 'Falta o código de tributação nacional (6 dígitos) usado quando o serviço não tem o seu.'));

  itens.push(/^\d{9}$/.test(onlyDigits(c.cnbs_padrao))
    ? item('cnbs_padrao', 'NBS padrão do serviço', 'ok', 'Preenchido.')
    : item('cnbs_padrao', 'NBS padrão do serviço', 'opcional', 'Opcional: só vai na nota quando existe.'));

  itens.push(temTexto(c.inscricao_municipal)
    ? item('inscricao_municipal', 'Inscrição municipal', 'ok', 'Preenchida.')
    : item('inscricao_municipal', 'Inscrição municipal', 'opcional', 'Opcional, a não ser que a prefeitura peça (a nota de teste mostra).'));

  const ps = passos.serie;
  const serieExtra = cfg ? { serie: normalizarSerie(c.serie || '1'), proximo_numero: String(Number(c.next_dps_number) || 1) } : undefined;
  itens.push(item('serie_numero', 'Série e próximo número da DPS', ps.estado === 'ok' ? 'ok' : ps.estado, ps.motivo, serieExtra));

  if (!cfg) {
    itens.push(item('ambiente', 'Ambiente', 'falta', 'NFS-e ainda não configurada nesta empresa.'));
  } else if (normalizarAmbiente(c.ambiente) === 'producao') {
    itens.push(item('ambiente', 'Ambiente', 'ok', 'Produção.', { ambiente: 'producao' }));
  } else {
    itens.push(item('ambiente', 'Ambiente', 'aviso', 'Produção restrita (testes do gov.br): as notas saem sem valor fiscal.', { ambiente: 'producao_restrita' }));
  }

  const pt = passos.teste;
  itens.push(item('nota_teste', 'Nota de teste aceita', pt.estado === 'travado' ? 'falta' : pt.estado, pt.motivo));

  const ativa = !!cfg && c.is_active === true && c.provider === 'nacional';
  itens.push(ativa
    ? item('ativa', 'NFS-e ativa', 'ok', 'Ligada.')
    : item('ativa', 'NFS-e ativa', 'falta', !cfg ? 'NFS-e ainda não configurada nesta empresa.'
      : (c.provider !== 'nacional' ? 'O emissor configurado não é o nacional.' : 'A emissão de NFS-e está desligada nesta empresa.')));

  return {
    configurada: !!cfg,
    apta: apt.apta,
    pendencias: apt.pendencias,
    itens,
  };
}

module.exports = {
  ufsAtendidas, situacaoCertificado, requisitosNfce, requisitosNfse, DIAS_AVISO_CERT,
};
