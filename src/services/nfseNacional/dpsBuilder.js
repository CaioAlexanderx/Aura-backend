// ============================================================
// AURA. — nfseNacional/dpsBuilder: monta a DPS (Declaração de Prestação de
// Serviço) do Sistema Nacional NFS-e, leiaute 1.01 — funções PURAS.
//
// DOIS AMBIENTES, DOIS ESQUEMAS (situação em 09/11/2026, gov.br/nfse):
//   tpAmb=1 PRODUÇÃO           XSD NFSe-ESQUEMAS_XSD-v1.01-20260209
//                              (Documentação atual) — schemas/NFSe_v1.01/
//   tpAmb=2 PRODUÇÃO RESTRITA  XSD NFSe-ESQUEMAS_XSD-PRODREST-v1.01-20261020
//                              (NT SE/CGNFS-e 009 v1.01, no ar desde
//                              20/10/2026) — schemas/NFSe_v1.01_PRODREST_20261020/
//   O atributo versao continua "1.01" nos dois; o que muda é o conteúdo:
//   na produção restrita, finNFSe (=0, NFS-e regular) passou a ser filho
//   obrigatório de infDPS logo depois de tpEmit/cMotivoEmisTI (NT 009, item
//   2.2) e, em cServ, cNBS/cIntContrib vêm ANTES de xDescServ. A produção
//   ainda não recebeu a NT 009 ("Atualizações e Implantações", coluna
//   PRODUÇÃO vazia em 20/10/2026) e recusaria finNFSe em infDPS. Quando o
//   portal anunciar a NT 009 em produção, troque LEIAUTE_POR_AMBIENTE[1].
//   Anexo I  produção:  ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe-v1.01-20260209
//            restrita:  ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe-PRODREST-v1.01-20261020
//
// O que sai daqui (TCInfDPS, na ordem do XSD):
//   tpAmb, dhEmi, verAplic, serie, nDPS, dCompet, tpEmit=1, [finNFSe=0],
//   cLocEmi, prest (CNPJ, IM?, regTrib), toma?, serv (locPrest, cServ),
//   valores.
// Regras do Anexo I aplicadas na montagem (as que dependem só de nós):
//   Id (E0004) "DPS" + cLocEmi(7) + tpInsc(1: 1=CPF, 2=CNPJ) + inscrição(14)
//        + série(5, zeros à esquerda) + nDPS(15, zeros à esquerda)
//   série 00001–49999 = "aplicativo próprio" (E0010)
//   prest/xNome NÃO vai quando o emitente é o prestador (E0121)
//   regApTribSN obrigatório p/ ME/EPP (E0166) e proibido p/ não optante/MEI (E0162)
//   regEspTrib = 0 p/ MEI (E0174) e p/ ME/EPP apurando pelo SN (E0175)
//   pAliq: ME/EPP no SN sem retenção NÃO informa (E0625); com retenção
//        informa (E0621, mínimo 1,8%); não optante com convênio ativo não
//        informa (E0617); MEI nunca (E0600); teto 5% (E0595)
//   retenção do ISSQN proibida p/ MEI (E0583) e com regime especial (E0588)
//   totTrib: ME/EPP não usa indTotTrib (E0712); não optante não usa
//        indTotTrib nem pTotTribSN (E0713); MEI não usa pTotTribSN (E0710)
//   dCompet ≤ dhEmi (E0015)
//   finNFSe: o XSD da produção restrita só aceita 0 (NFS-e regular); notas
//        de ajuste de crédito/débito (1/2) ainda não existem no esquema
//   texto: TSString aceita só a faixa Latin-1 sem quebra de linha — o que
//        vier fora disso é trocado/removido antes de entrar no XML
//
// Grupo IBSCBS: opcional (0-1) nos dois esquemas; o Anexo I da produção
// restrita diz que "para optantes do Simples Nacional, os grupos IBSCBS só
// serão obrigatórios a partir de 2027". Não montamos.
//
// Fora do escopo (não monta, e recusa se pedirem): tomador no exterior
// (NIF), intermediário, substituição, obra/evento, deduções, benefício
// municipal, tributos federais retidos, grupo IBSCBS, tribISSQN diferente
// de 1 (operação tributável).
// ============================================================
'use strict';

const { isValidCnpj, isValidCpf } = require('../../utils/cpfCnpj');
const { isoBR } = require('../sefazSp/nfeHelpers');
const { NfseNacionalError } = require('./errors');

const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';
const VERSAO_LEIAUTE = '1.01';
const VER_APLIC = 'Aura-NFSe-1.0'; // TSVerAplic: 1–20 caracteres

// Diferenças de conteúdo entre os dois esquemas "1.01" (ver cabeçalho).
const LEIAUTES = {
  'v1.01-20260209': { id: 'v1.01-20260209', finNFSeEmInfDps: false, nbsAntesDaDescricao: false },
  'v1.01-PRODREST-20261020': { id: 'v1.01-PRODREST-20261020', finNFSeEmInfDps: true, nbsAntesDaDescricao: true },
};
const LEIAUTE_POR_AMBIENTE = {
  1: 'v1.01-20260209',          // produção: NT 009 ainda não implantada
  2: 'v1.01-PRODREST-20261020', // produção restrita: NT 009 desde 20/10/2026
};

/** Leiaute que a Sefin Nacional valida em cada ambiente (tpAmb 1 ou 2). */
function leiauteDoAmbiente(tpAmb) {
  const id = LEIAUTE_POR_AMBIENTE[Number(tpAmb)];
  if (!id) throw new NfseNacionalError('Ambiente inválido (tpAmb deve ser 1 ou 2).', 'INVALID_INPUT');
  return LEIAUTES[id];
}

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// Caracteres comuns fora do Latin-1 que aparecem em texto digitado/colado.
const TROCAS = {
  '–': '-', '—': '-', '−': '-', '•': '-',
  '“': '"', '”': '"', '„': '"',
  '‘': "'", '’': "'", '‚': "'",
  '…': '...', ' ': ' ', '€': 'EUR',
};

function paraLatin1(s, { quebraDeLinha = false } = {}) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    if (TROCAS[ch] !== undefined) { out += TROCAS[ch]; continue; }
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === '\r' || ch === '\t') { out += quebraDeLinha ? (ch === '\t' ? ' ' : ch) : ' '; continue; }
    if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) continue; // controle
    if (cp <= 0xFF) { out += ch; continue; }
    // fora do Latin-1: tenta a letra base (ex.: "ő" → "o"); senão some
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (base && [...base].every((c) => c.codePointAt(0) <= 0xFF)) out += base;
  }
  out = quebraDeLinha ? out.replace(/\r\n?/g, '\n') : out.replace(/\s+/g, ' ');
  return out.trim();
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;
const optTag = (name, value) => (value === null || value === undefined || value === '' ? '' : tag(name, value));

function money(v) {
  const n = Math.round(Number(v) * 100) / 100;
  return n.toFixed(2);
}

function isDataISO(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** Data de hoje no fuso de Brasília (AAAA-MM-DD). */
function hojeBR(now = new Date()) {
  return isoBR(now).slice(0, 10);
}

function normalizarSerie(serie) {
  const d = onlyDigits(serie);
  if (!d) return null;
  const n = parseInt(d, 10);
  return Number.isFinite(n) ? String(n) : null;
}

/** "DPS" + cLocEmi(7) + tpInsc(1) + inscrição(14) + série(5) + nDPS(15) — Anexo I, E0004. */
function buildIdDps({ cLocEmi, cnpj, cpf, serie, nDPS }) {
  const tpInsc = cnpj ? '2' : '1';
  const insc = cnpj ? onlyDigits(cnpj) : onlyDigits(cpf).padStart(14, '0');
  return 'DPS'
    + onlyDigits(cLocEmi)
    + tpInsc
    + insc
    + String(normalizarSerie(serie)).padStart(5, '0')
    + String(nDPS).padStart(15, '0');
}

/**
 * Valida a entrada normalizada. Devolve lista de pendências em português
 * (vazia = ok). `semNumero` valida tudo menos série/número (usado ANTES de
 * reservar o número, para dado inválido nunca gastar numeração).
 */
function validarEntrada(input, { semNumero = false } = {}) {
  const e = [];
  const p = input.prestador || {};
  const s = input.servico || {};
  const v = input.valores || {};

  if (![1, 2].includes(Number(input.tpAmb))) e.push('Ambiente inválido (tpAmb deve ser 1 ou 2).');
  if (!/^\d{7}$/.test(onlyDigits(input.cLocEmi))) e.push('Código IBGE do município emissor deve ter 7 dígitos.');

  if (!semNumero) {
    const serie = normalizarSerie(input.serie);
    if (!serie || Number(serie) < 1 || Number(serie) > 49999) {
      e.push('Série da DPS deve estar entre 1 e 49999 (faixa de aplicativo próprio).');
    }
    if (!/^[1-9]\d{0,14}$/.test(String(input.nDPS || ''))) e.push('Número da DPS deve ser inteiro de 1 a 15 dígitos.');
  }

  const cnpj = onlyDigits(p.cnpj);
  if (!isValidCnpj(cnpj)) e.push('CNPJ da empresa inválido ou ausente.');
  if (p.im != null && p.im !== '' && String(p.im).length > 15) e.push('Inscrição municipal com mais de 15 caracteres.');

  const op = Number(p.opSimpNac);
  if (![1, 2, 3].includes(op)) e.push('Situação no Simples Nacional não definida (opSimpNac 1, 2 ou 3).');
  const regAp = p.regApTribSN == null ? null : Number(p.regApTribSN);
  if (op === 3 && ![1, 2, 3].includes(regAp)) e.push('ME/EPP do Simples: informe o regime de apuração (regApTribSN 1, 2 ou 3).');
  if ((op === 1 || op === 2) && regAp != null) e.push('regApTribSN só existe para ME/EPP do Simples (E0162).');
  const regEsp = Number(p.regEspTrib == null ? 0 : p.regEspTrib);
  if (![0, 1, 2, 3, 4, 5, 6, 9].includes(regEsp)) e.push('Regime especial de tributação inválido.');
  if (op === 2 && regEsp !== 0) e.push('MEI não tem regime especial de tributação (E0174).');
  if (op === 3 && regAp === 1 && regEsp !== 0) e.push('ME/EPP apurando pelo Simples não tem regime especial (E0175).');

  if (!/^\d{6}$/.test(String(s.cTribNac || ''))) e.push('Código de tributação nacional (cTribNac) deve ter 6 dígitos.');
  if (s.cNBS != null && s.cNBS !== '' && !/^\d{9}$/.test(String(s.cNBS))) e.push('Código NBS deve ter 9 dígitos.');
  const desc = paraLatin1(s.descricao, { quebraDeLinha: true });
  if (!desc) e.push('Descrição do serviço obrigatória.');
  if (desc.length > 2000) e.push('Descrição do serviço com mais de 2000 caracteres.');
  if (!/^\d{7}$/.test(onlyDigits(s.cLocPrestacao || input.cLocEmi))) e.push('Código IBGE do local da prestação deve ter 7 dígitos.');

  const vServ = Number(v.vServ);
  if (!Number.isFinite(vServ) || vServ <= 0) e.push('Valor do serviço deve ser maior que zero.');
  if (Number.isFinite(vServ) && vServ >= 1e15) e.push('Valor do serviço acima do limite do leiaute.');

  const ret = Number(v.tpRetISSQN == null ? 1 : v.tpRetISSQN);
  if (![1, 2].includes(ret)) e.push('Retenção do ISSQN: use 1 (não retido) ou 2 (retido pelo tomador).');
  if (ret === 2 && op === 2) e.push('MEI não pode ter ISSQN retido (E0583).');
  if (ret === 2 && regEsp !== 0) e.push('Com regime especial não há retenção do ISSQN (E0588).');
  if (ret === 2 && !input.tomador) e.push('ISSQN retido exige o tomador identificado.');
  if (ret === 2 && op === 3) {
    const a = Number(v.pAliq);
    if (!Number.isFinite(a) || a < 1.8 || a > 5) e.push('ISSQN retido: informe a alíquota entre 1,80% e 5,00% (E0621/E0595).');
  }
  if (op === 1 && ret === 2) e.push('Não optante com ISSQN retido ainda não é suportado por este emissor.');

  if (op === 3) {
    const pt = v.totTrib ? null : Number(v.pTotTribSN);
    if (!v.totTrib && (!Number.isFinite(pt) || pt < 0 || pt >= 100)) {
      e.push('ME/EPP: configure o percentual aproximado de tributos do Simples (pTotTribSN).');
    }
  }
  if (op === 1 && !v.totTrib) {
    e.push('Não optante do Simples: informe os valores aproximados de tributos (E0713).');
  }
  if (v.totTrib) {
    for (const k of ['fed', 'est', 'mun']) {
      const n = Number(v.totTrib[k]);
      if (!Number.isFinite(n) || n < 0 || (Number.isFinite(vServ) && n > vServ)) e.push(`Valor aproximado de tributos (${k}) inválido.`);
    }
  }

  if (!isDataISO(input.dCompet)) e.push('Data de competência deve estar no formato AAAA-MM-DD.');
  else if (input.dhEmi && input.dCompet > hojeBR(input.dhEmi)) e.push('Data de competência não pode ser depois da emissão (E0015).');

  const t = input.tomador;
  if (t) {
    const d = onlyDigits(t.doc);
    if (d.length === 11) { if (!isValidCpf(d)) e.push('CPF do tomador inválido.'); }
    else if (d.length === 14) { if (!isValidCnpj(d)) e.push('CNPJ do tomador inválido.'); }
    else e.push('Documento do tomador deve ser CPF (11) ou CNPJ (14 dígitos).');
    const nome = paraLatin1(t.nome);
    if (!nome) e.push('Nome do tomador obrigatório.');
    if (nome.length > 300) e.push('Nome do tomador com mais de 300 caracteres.');
    if (t.email && (paraLatin1(t.email).length > 80 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(paraLatin1(t.email)))) {
      e.push('E-mail do tomador inválido.');
    }
  }
  return e;
}

function enderecoTomadorXml(end) {
  if (!end) return '';
  const cMun = onlyDigits(end.cMun || end.codigo_municipio);
  const cep = onlyDigits(end.cep);
  const xLgr = paraLatin1(end.logradouro).slice(0, 255);
  const nro = paraLatin1(end.numero).slice(0, 60);
  const xBairro = paraLatin1(end.bairro).slice(0, 60);
  // Endereço é opcional: só entra completo (cMun, CEP, logradouro, número, bairro).
  if (!/^\d{7}$/.test(cMun) || !/^\d{8}$/.test(cep) || !xLgr || !nro || !xBairro) return '';
  const xCpl = paraLatin1(end.complemento).slice(0, 156);
  return '<end>'
    + `<endNac>${tag('cMun', cMun)}${tag('CEP', cep)}</endNac>`
    + tag('xLgr', xLgr) + tag('nro', nro) + optTag('xCpl', xCpl) + tag('xBairro', xBairro)
    + '</end>';
}

function tomadorXml(t) {
  if (!t) return '';
  const d = onlyDigits(t.doc);
  const fone = onlyDigits(t.fone);
  const email = paraLatin1(t.email);
  return '<toma>'
    + (d.length === 14 ? tag('CNPJ', d) : tag('CPF', d))
    + optTag('IM', t.im ? paraLatin1(t.im).slice(0, 15) : '')
    + tag('xNome', paraLatin1(t.nome).slice(0, 300))
    + enderecoTomadorXml(t.endereco)
    + (/^\d{6,20}$/.test(fone) ? tag('fone', fone) : '')
    + optTag('email', email)
    + '</toma>';
}

function totTribXml(op, v) {
  if (v.totTrib) {
    return '<totTrib><vTotTrib>'
      + tag('vTotTribFed', money(v.totTrib.fed))
      + tag('vTotTribEst', money(v.totTrib.est))
      + tag('vTotTribMun', money(v.totTrib.mun))
      + '</vTotTrib></totTrib>';
  }
  if (op === 3) return `<totTrib>${tag('pTotTribSN', money(v.pTotTribSN))}</totTrib>`;
  // MEI e não optante sem valores: indTotTrib=0 só é permitido ao MEI (E0712/E0713)
  if (op === 2) return '<totTrib><indTotTrib>0</indTotTrib></totTrib>';
  throw new NfseNacionalError(
    'Não optante do Simples: informe os valores aproximados de tributos (totTrib).',
    'INVALID_INPUT'
  );
}

/**
 * Monta a DPS SEM assinatura.
 * O leiaute segue o ambiente (tpAmb) — ver LEIAUTE_POR_AMBIENTE.
 * @returns {{ xml: string, idDps: string, serie: string, nDPS: string, dhEmi: string, leiaute: string }}
 */
function buildDps(input) {
  const erros = validarEntrada(input);
  if (erros.length) {
    throw new NfseNacionalError('Dados da nota inválidos: ' + erros.join(' '), 'INVALID_INPUT', erros);
  }
  const p = input.prestador;
  const s = input.servico;
  const v = input.valores;
  const op = Number(p.opSimpNac);
  const regAp = p.regApTribSN == null ? null : Number(p.regApTribSN);
  const regEsp = Number(p.regEspTrib == null ? 0 : p.regEspTrib);
  const ret = Number(v.tpRetISSQN == null ? 1 : v.tpRetISSQN);
  const cnpj = onlyDigits(p.cnpj);
  const cLocEmi = onlyDigits(input.cLocEmi);
  const serie = normalizarSerie(input.serie);
  const nDPS = String(input.nDPS);
  const dhEmi = isoBR(input.dhEmi || new Date());
  const idDps = buildIdDps({ cLocEmi, cnpj, serie, nDPS });
  const leiaute = leiauteDoAmbiente(input.tpAmb);

  // pAliq só quando o Anexo I manda informar (ME/EPP com retenção — E0621).
  const pAliq = ret === 2 && op === 3 ? money(v.pAliq) : null;

  const xml = `<DPS xmlns="${NFSE_NS}" versao="${VERSAO_LEIAUTE}">`
    + `<infDPS Id="${idDps}">`
    + tag('tpAmb', Number(input.tpAmb))
    + tag('dhEmi', dhEmi)
    + tag('verAplic', VER_APLIC)
    + tag('serie', serie)
    + tag('nDPS', nDPS)
    + tag('dCompet', input.dCompet)
    + tag('tpEmit', 1)
    // NT 009 (produção restrita): finalidade obrigatória; 0 = NFS-e regular
    + (leiaute.finNFSeEmInfDps ? tag('finNFSe', 0) : '')
    + tag('cLocEmi', cLocEmi)
    + '<prest>'
    + tag('CNPJ', cnpj)
    + optTag('IM', p.im ? paraLatin1(p.im).slice(0, 15) : '')
    + '<regTrib>'
    + tag('opSimpNac', op)
    + (op === 3 ? tag('regApTribSN', regAp) : '')
    + tag('regEspTrib', regEsp)
    + '</regTrib>'
    + '</prest>'
    + tomadorXml(input.tomador)
    + '<serv>'
    + `<locPrest>${tag('cLocPrestacao', onlyDigits(s.cLocPrestacao || cLocEmi))}</locPrest>`
    + '<cServ>'
    + tag('cTribNac', s.cTribNac)
    + (leiaute.nbsAntesDaDescricao
      ? optTag('cNBS', s.cNBS) + tag('xDescServ', paraLatin1(s.descricao, { quebraDeLinha: true }))
      : tag('xDescServ', paraLatin1(s.descricao, { quebraDeLinha: true })) + optTag('cNBS', s.cNBS))
    + '</cServ>'
    + '</serv>'
    + '<valores>'
    + `<vServPrest>${tag('vServ', money(v.vServ))}</vServPrest>`
    + '<trib>'
    + '<tribMun>'
    + tag('tribISSQN', 1)
    + tag('tpRetISSQN', ret)
    + (pAliq ? tag('pAliq', pAliq) : '')
    + '</tribMun>'
    + totTribXml(op, v)
    + '</trib>'
    + '</valores>'
    + '</infDPS>'
    + '</DPS>';

  return { xml, idDps, serie, nDPS, dhEmi, leiaute: leiaute.id };
}

module.exports = {
  buildDps, buildIdDps, validarEntrada, paraLatin1, normalizarSerie, hojeBR, money,
  leiauteDoAmbiente, LEIAUTES, LEIAUTE_POR_AMBIENTE,
  NFSE_NS, VERSAO_LEIAUTE, VER_APLIC,
};
