// ============================================================
// AURA. — Tabela NCM da Receita (Siscomex): consulta e aviso (t3-05, 18/10/2026)
//
// Por que existe: 3 de 3 rejeicoes de NFC-e em 30 dias foram a 778 ("NCM
// inexistente"). O NCM errado entrava no cadastro sem ninguem avisar e so
// estourava na hora de emitir a nota, com o cliente no balcao.
//
// A lista vem de src/data/ncm-siscomex.json (dado versionado, gerado por
// scripts/gerar-tabela-ncm.js a partir do arquivo publico do Portal Unico
// Siscomex). E um AVISO, nunca um bloqueio: a lista pode estar atras de uma
// resolucao nova da Gecex, e bloquear derrubaria importacoes inteiras. Se o
// arquivo nao carregar, tudo aqui responde "nao sei" e nao avisa nada.
//
// NCM vazio nao gera aviso (o campo e opcional; quem nao emite nota nao usa).
// ============================================================
'use strict';

const MSG_INEXISTENTE =
  'Este NCM não existe na tabela da Receita. A nota fiscal com ele é recusada. Confira o código na nota do fornecedor.';
const MSG_FORMATO_DESCARTADO =
  'O NCM precisa ter 8 números e este não foi salvo. Confira o código na nota do fornecedor.';
const MSG_FORMATO =
  'O NCM precisa ter 8 números. Confira o código na nota do fornecedor.';

let cache; // undefined = ainda nao tentou; null = falhou; objeto = carregada

function tabela() {
  if (cache !== undefined) return cache;
  try {
    // require em vez de readFileSync: o Node guarda em cache e o empacotador
    // enxerga a dependencia.
    cache = require('../data/ncm-siscomex.json');
  } catch (e) {
    console.error('[ncmTable] tabela indisponivel:', e.message);
    cache = null;
  }
  return cache;
}

/** Só os dígitos do que veio ('6109.10.00' -> '61091000'). */
function soDigitos(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).replace(/\D/g, '');
}

/**
 * Consulta um NCM.
 *   { ncm, vazio, formatoOk, existe, descricao }
 * `existe` é true/false, ou null quando não dá para saber (formato errado ou
 * tabela indisponível).
 */
function consultarNcm(raw) {
  const ncm = soDigitos(raw);
  if (ncm === '') return { ncm, vazio: true, formatoOk: false, existe: null, descricao: null };
  if (ncm.length !== 8) return { ncm, vazio: false, formatoOk: false, existe: null, descricao: null };
  const t = tabela();
  if (!t) return { ncm, vazio: false, formatoOk: true, existe: null, descricao: null };
  const folha = t.itens[ncm];
  if (folha === undefined) return { ncm, vazio: false, formatoOk: true, existe: false, descricao: null };
  const posicao = t.posicoes && t.posicoes[ncm.slice(0, 4)];
  return { ncm, vazio: false, formatoOk: true, existe: true, descricao: posicao ? `${posicao} > ${folha}` : folha };
}

/** Metadados da versão da tabela (para a tela e para o suporte). */
function versaoDaTabela() {
  const t = tabela();
  if (!t) return null;
  return { vigente_em: t.vigente_em, ato: t.ato, fonte: t.fonte, total: t.total };
}

/**
 * Aviso para o cadastro: null quando está tudo certo (ou não dá para saber).
 * `salvo` diz se o valor errado foi guardado (planilha/XML guardam como veio)
 * ou descartado (POST/PATCH de produto zeram o campo quando não tem 8 dígitos).
 */
function avisoDeNcm(raw, { salvo = false } = {}) {
  const r = consultarNcm(raw);
  if (r.vazio) return null;
  if (!r.formatoOk) {
    return { codigo: 'ncm_formato', ncm: r.ncm, mensagem: salvo ? MSG_FORMATO : MSG_FORMATO_DESCARTADO };
  }
  if (r.existe === false) {
    return { codigo: 'ncm_inexistente', ncm: r.ncm, mensagem: MSG_INEXISTENTE };
  }
  return null;
}

/**
 * Resumo para importação em lote: { total, exemplos: [{ nome, ncm, codigo }] }
 * ou null quando nenhum item tem aviso. Os exemplos são poucos de propósito
 * (a resposta de 6.000 linhas não pode crescer).
 */
function resumirAvisosNcm(itens, { nome = (i) => i.name, ncm = (i) => i.ncm, max = 20 } = {}) {
  let total = 0;
  const exemplos = [];
  for (const it of itens || []) {
    const a = avisoDeNcm(ncm(it), { salvo: true });
    if (!a) continue;
    total++;
    if (exemplos.length < max) exemplos.push({ nome: nome(it) || null, ncm: a.ncm, codigo: a.codigo });
  }
  return total > 0 ? { total, exemplos } : null;
}

module.exports = {
  consultarNcm,
  avisoDeNcm,
  resumirAvisosNcm,
  versaoDaTabela,
  soDigitos,
  MSG_INEXISTENTE,
  MSG_FORMATO,
  MSG_FORMATO_DESCARTADO,
};
