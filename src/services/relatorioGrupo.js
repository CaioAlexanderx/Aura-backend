// ============================================================
// AURA. — Relatório semanal de quem tem várias lojas (26/10/2026)
//
// Feedback do Caio (26/10): "A visualização pra quem tem mais de uma empresa
// não está muito boa". O e-mail consolidado somava tudo, chamava o grupo de
// "<principal> (2 unidades)" (às vezes com a razão social e o número do
// CNPJ), contava a loja nova vazia e misturava bases na comparação.
//
// Regras (Nina + Caio, mockup "várias lojas" v3):
//   1. total do grupo no topo; a comparação com a semana anterior usa só as
//      lojas com venda não cancelada nas DUAS semanas ("das mesmas N lojas");
//   2. uma linha por loja em vendas, estoque baixo, equipe, clientes que
//      sumiram e crediário; só o total em formas de pagamento e melhor dia;
//   3. nome do grupo pelas lojas até 3; acima, "suas N lojas". Cada loja
//      pelo nome fantasia (ou a razão social, sem nome fantasia), sem o
//      prefixo numérico do MEI (regra final do Caio, 26/10);
//   4. loja nova sem venda: "começou em dd/mm", fora da comparação, com um
//      passo ("Cadastrar os produtos ...").
//
// Funções puras (sem banco): o reportGenerator lê, aqui só se decide.
// ============================================================
'use strict';

// ── Constantes fáceis de mudar ──────────────────────────────────

// Até quantas lojas o nome do grupo lista ("Matriz, Centro e Norte").
// Acima disso: "suas N lojas".
const MAX_NOMES_NO_GRUPO = 3;

// O desenho vale para até 3 lojas (Caio, 26/10, mockup v5). Com MAIS lojas
// que isto, só o comportamento de segurança: as LOJAS_EM_DESTAQUE maiores
// (faturamento da semana) e uma linha "outras N lojas", sem variação própria;
// o reportGenerator avisa no log (console.warn) para a Nina saber quando
// revisar. A página completa mostra sempre todas.
const MAX_LOJAS_NO_EMAIL = 3;
const LOJAS_EM_DESTAQUE = 3;

// Loja sem venda na semana e criada há no máximo isto: "loja nova".
const DIAS_LOJA_NOVA = 30;

// ── Nome da loja ────────────────────────────────────────────────
//
// Regra do Caio (26/10, mockup v4): "usar o Nome Fantasia (quando
// disponível)", sem o prefixo numérico do MEI. Mais um passo, à espera do OK
// do Caio: quando o nome fantasia é só a razão social do MEI, o nome da loja
// online (digital_channel_config.site_name) é o nome que a lojista escolheu.
// Tudo numa função só (nomeDaLojaNoRelatorio), para ser fácil de tirar.
// Nada de "sua loja 1" nem nome inventado.

const RE_PREFIXO_MEI = /^\d{2}\.\d{3}\.\d{3}\s/;

function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function texto(s) {
  return String(s == null ? '' : s).trim();
}

function semPrefixoMei(s) {
  return texto(s).replace(RE_PREFIXO_MEI, '').trim();
}

/**
 * Nome da loja no relatório (e-mail, página e assunto):
 *   1. trade_name, se existe, é diferente da legal_name e não começa com o
 *      prefixo do MEI ("53.276.802 ");
 *   2. se não, o nome da loja online (digital_channel_config.site_name);
 *   3. se não, trade_name ou legal_name sem o prefixo do MEI.
 *
 * @param {{trade_name?, legal_name?}} company
 * @param {{site_name?}|null} [canal]
 * @returns {string|null}
 */
function nomeDaLojaNoRelatorio(company, canal) {
  const fantasia = texto(company && company.trade_name);
  const razao = texto(company && company.legal_name);
  if (fantasia && normalizar(fantasia) !== normalizar(razao) && !RE_PREFIXO_MEI.test(fantasia)) return fantasia;
  const site = texto(canal && canal.site_name);
  if (site) return site;
  return semPrefixoMei(fantasia || razao) || null;
}

/** Atalho com os campos soltos (testes e quem não tem a linha da empresa). */
function nomeDaLoja(tradeName, legalName, siteName) {
  return nomeDaLojaNoRelatorio({ trade_name: tradeName, legal_name: legalName }, { site_name: siteName });
}

// Primeira palavra -> artigo. Desconhecida: "da loja X" (nunca erra o gênero).
const FEMININOS = new Set(['matriz', 'filial', 'loja', 'unidade', 'casa', 'boutique', 'otica', 'farmacia', 'adega',
  'padaria', 'papelaria', 'livraria', 'sapataria', 'perfumaria', 'sede', 'galeria', 'praca', 'avenida', 'rua']);
const MASCULINOS = new Set(['centro', 'norte', 'sul', 'leste', 'oeste', 'shopping', 'outlet', 'bairro', 'atelie',
  'emporio', 'mercado', 'deposito', 'quiosque', 'espaco', 'studio', 'estudio', 'galpao', 'ponto', 'box']);

/** "da Matriz", "do Centro", "da loja Finesse Moda". */
function daLoja(loja) {
  const nome = typeof loja === 'string' ? loja : loja.nome;
  const primeira = normalizar(nome).split(' ')[0] || '';
  if (FEMININOS.has(primeira)) return `da ${nome}`;
  if (MASCULINOS.has(primeira)) return `do ${nome}`;
  return `da loja ${nome}`;
}

function capitalizar(s) {
  const t = String(s || '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** "Outra loja" / "Outras 3 lojas" (linha que junta as menores). */
function outrasLojas(k) {
  return k === 1 ? 'Outra loja' : `Outras ${k} lojas`;
}

function listaComE(nomes) {
  if (nomes.length <= 1) return nomes.join('');
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

/**
 * Nome do grupo: "Matriz e Centro", "Matriz, Centro e Norte"; acima de
 * MAX_NOMES_NO_GRUPO, "suas N lojas". `lojas` na ordem do grupo (principal
 * primeiro).
 */
function nomeDoGrupo(lojas) {
  const xs = lojas || [];
  if (xs.length > MAX_NOMES_NO_GRUPO) return `suas ${xs.length} lojas`;
  return listaComE(xs.map((l) => l.nome));
}

/** "em Matriz e Centro" / "nas suas 5 lojas". */
function emGrupo(nome) {
  return /^suas \d+ lojas$/.test(nome) ? `nas ${nome}` : `em ${nome}`;
}

/**
 * Assunto e título (mockup v5): "Sua semana nas suas 3 lojas". Conta a loja
 * nova; o valor ao lado é só das lojas que venderam. Os nomes das lojas vão
 * na linha do período (nomesNaLinha).
 */
function tituloDoGrupo(grupo) {
  return `Sua semana nas suas ${grupo.lojas.length} lojas`;
}

/** "Matriz e Centro" para a linha do período; null quando o nome já é "suas N lojas". */
function nomesNaLinha(grupo) {
  return /^suas \d+ lojas$/.test(grupo.nome) ? null : grupo.nome;
}

// ── Lojas do grupo e base da comparação ─────────────────────────

function addDias(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dataISO(v) {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - 3 * 3600000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * Lojas do grupo, cada uma com o estado da semana.
 *
 * @param {Array} entradas  { companyId, tradeName, legalName, siteName, criadaEm, vendas,
 *                            receita, vendasAnterior, receitaAnterior, produtos? }
 *                          na ordem do grupo (principal primeiro)
 * @param {{startDate, endDate}} period
 * @returns {Array} { companyId, nome, posicao, criadaEm, receita, vendas,
 *                    receitaAnterior, vendasAnterior, naBase, nova, semVenda,
 *                    semVendaAnterior, variacaoPct, produtos }
 */
function lojasDoGrupo(entradas, period) {
  return (entradas || []).map((e, i) => {
    const nome = nomeDaLoja(e.tradeName, e.legalName, e.siteName) || 'Loja sem nome';
    const vendas = Number(e.vendas) || 0;
    const vendasAnterior = Number(e.vendasAnterior) || 0;
    const receita = Number(e.receita) || 0;
    const receitaAnterior = Number(e.receitaAnterior) || 0;
    const criadaEm = dataISO(e.criadaEm);
    const semVenda = vendas <= 0;
    const nova = semVenda && !!criadaEm && criadaEm >= addDias(period.endDate, -DIAS_LOJA_NOVA);
    const naBase = vendas > 0 && vendasAnterior > 0;
    return {
      companyId: e.companyId,
      nome,
      posicao: i + 1,
      criadaEm,
      receita, vendas, receitaAnterior, vendasAnterior,
      naBase,
      nova,
      semVenda,
      semVendaAnterior: vendas > 0 && vendasAnterior <= 0,
      variacaoPct: naBase && receitaAnterior > 0 ? Math.round(((receita - receitaAnterior) / receitaAnterior) * 1000) / 10 : null,
      produtos: e.produtos == null ? null : Number(e.produtos) || 0,
    };
  });
}

/** Base da comparação: as lojas com venda nas duas semanas. */
function baseDaComparacao(lojas) {
  const base = (lojas || []).filter((l) => l.naBase);
  const receita = base.reduce((s, l) => s + l.receita, 0);
  const receitaAnterior = base.reduce((s, l) => s + l.receitaAnterior, 0);
  return {
    ids: base.map((l) => l.companyId),
    lojas: base.length,
    // Todas as lojas que venderam nesta semana estão na base?
    todasQueVenderam: base.length === (lojas || []).filter((l) => !l.semVenda).length,
    receita: Math.round(receita * 100) / 100,
    receitaAnterior: Math.round(receitaAnterior * 100) / 100,
    variacaoPct: receitaAnterior > 0 ? Math.round(((receita - receitaAnterior) / receitaAnterior) * 1000) / 10 : null,
  };
}

/** Lojas por faturamento da semana (as novas e sem venda no fim, na ordem do grupo). */
function porFaturamento(lojas) {
  return [...(lojas || [])].sort((a, b) => (b.receita - a.receita) || (a.posicao - b.posicao));
}

/**
 * Lojas que aparecem no e-mail: todas até MAX_LOJAS_NO_EMAIL; acima disso,
 * as LOJAS_EM_DESTAQUE maiores e o resto em `outras`.
 */
function cortarLojas(lojas, { modo = 'email' } = {}) {
  const ordenadas = porFaturamento(lojas);
  if (modo === 'pagina' || ordenadas.length <= MAX_LOJAS_NO_EMAIL) return { visiveis: ordenadas, outras: [] };
  return { visiveis: ordenadas.slice(0, LOJAS_EM_DESTAQUE), outras: ordenadas.slice(LOJAS_EM_DESTAQUE) };
}

module.exports = {
  MAX_NOMES_NO_GRUPO,
  MAX_LOJAS_NO_EMAIL,
  LOJAS_EM_DESTAQUE,
  DIAS_LOJA_NOVA,
  nomeDaLoja,
  nomeDaLojaNoRelatorio,
  semPrefixoMei,
  daLoja,
  capitalizar,
  listaComE,
  outrasLojas,
  nomeDoGrupo,
  emGrupo,
  tituloDoGrupo,
  nomesNaLinha,
  lojasDoGrupo,
  baseDaComparacao,
  porFaturamento,
  cortarLojas,
};
