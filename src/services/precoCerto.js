// ============================================================
// AURA. — Preco certo: o custo fixo dentro do preco da peca
//
// ── O QUE JA EXISTIA ───────────────────────────────────────────────────
// A ficha tecnica diz quanto custa o INSUMO de cada peca, a regra de
// precificacao diz a mao de obra, e o alerta de margem (margemEmRisco.js)
// avisa quando o preco ficou abaixo do custo.
//
// ── O QUE FALTAVA ──────────────────────────────────────────────────────
// O aluguel. A caneca que custa R$ 12 de insumo e vende a R$ 20 parece
// dar 40% — e o estudio fecha o mes no vermelho, porque energia, internet
// e aluguel nao estao em ficha nenhuma. A lojista sente no caixa e nao
// consegue apontar em qual peca.
//
// ── O METODO (markup divisor) ──────────────────────────────────────────
// O custo fixo entra como PERCENTUAL DO PRECO, nao como valor por peca:
//
//   taxa (%)        = custos fixos do mes ÷ faturamento medio mensal × 100
//   preco sugerido  = custo da peca ÷ (1 − taxa/100 − margem/100)
//   margem que sobra = (1 − taxa/100 − custo/preco) × 100
//
// Ratear aluguel "por peca" exigiria saber quantas pecas ela vai vender —
// o numero que ninguem tem. Percentual sobre o preco so pede o que o
// financeiro ja sabe.
//
// ── A REGRA DE OURO ────────────────────────────────────────────────────
// O sistema SUGERE, nunca altera. Vale para o preco e vale para a taxa:
// existe a taxa EM USO (gravada, a que entra nas contas) e a taxa REAL
// (calculada agora). Um mes ruim de vendas nao pode mexer sozinho no
// preco sugerido de todas as pecas — a taxa em uso so muda quando ela
// aceita.
//
// Tudo aqui e conta pura: sem banco, sem relogio.
// ============================================================
'use strict';

const crypto = require('crypto');
const margem = require('./margemEmRisco');

/** Acima disto a taxa nao e custo fixo, e erro de cadastro. */
const TAXA_MAXIMA = 90;
/** Taxa + margem a partir daqui deixam o divisor pequeno demais para sugerir preco. */
const TETO_TAXA_MAIS_MARGEM = 95;
const MAXIMO_DE_ITENS = 30;
const NOME_MAXIMO = 60;
/** Trava de digitacao: R$ 10 milhoes por mes numa linha de custo e dedo a mais. */
const VALOR_MAXIMO = 9999999.99;
const ORIGENS = ['financeiro', 'manual'];
/** Menos meses do que isto com receita e pouco para chamar de media. */
const MESES_MINIMOS_DE_HISTORICO = 3;

function numero(v) {
  if (typeof v === 'boolean' || v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function duasCasas(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * A taxa de custo fixo, se for uma taxa.
 *
 * Fora de 0–90 devolve null: taxa negativa nao existe, e acima de 90% o
 * estudio gasta mais de aluguel do que fatura — nenhum preco resolve, e
 * usar o numero so produziria sugestoes absurdas.
 */
function taxaValida(v) {
  const n = numero(v);
  if (n == null || n < 0 || n > TAXA_MAXIMA) return null;
  return n;
}

/**
 * A taxa EM USO: a que a lojista aceitou. Ausente = recurso nao
 * configurado = 0 em todas as contas, que e exatamente o comportamento
 * de antes do recurso existir.
 */
function taxaEmUso(studioSettings) {
  return taxaValida((studioSettings || {}).taxa_custo_fixo_pct) || 0;
}

/** Ela ja aceitou alguma taxa? (0 aceito conta: e uma escolha.) */
function taxaConfigurada(studioSettings) {
  return taxaValida((studioSettings || {}).taxa_custo_fixo_pct) != null;
}

/**
 * A taxa REAL de agora: quanto do faturamento os custos fixos comem.
 *
 * Sem faturamento nao ha taxa — dividir por zero daria "infinito", e
 * chutar um numero faria ela precificar em cima de um chute. Pode passar
 * de 90: e informacao (o estudio nao se paga), so nao pode ser ACEITA.
 */
function taxaReal(totalFixos, faturamento) {
  const t = numero(totalFixos);
  const f = numero(faturamento);
  if (t == null || t < 0 || f == null || f <= 0) return null;
  return duasCasas((t / f) * 100);
}

/**
 * Por quanto vender para pagar o custo da peca, a parte dela no custo
 * fixo e ainda sobrar a margem pedida.
 *
 * Arredonda para CIMA em centavos, com o mesmo cuidado de ponto flutuante
 * de `precoParaOPiso`: 21/0.7 da 30.000000000000004, e sugerir R$ 30,01
 * para uma peca que fecha em R$ 30,00 parece descuido justo na tela que
 * existe para ela confiar na conta.
 */
function precoSugerido(custo, taxaPct, margemPct) {
  const c = numero(custo);
  const t = numero(taxaPct) || 0;
  const m = numero(margemPct);
  if (c == null || c <= 0 || m == null || t < 0) return null;
  if (t + m >= TETO_TAXA_MAIS_MARGEM) return null;

  const centavos = (c / (1 - t / 100 - m / 100)) * 100;
  return Math.ceil(Number(centavos.toFixed(6))) / 100;
}

/**
 * A margem que SOBRA num preco, depois do custo da peca e da parte do
 * custo fixo. Com taxa 0 e a margem bruta de sempre.
 */
function margemQueSobra(custo, preco, taxaPct) {
  const c = numero(custo);
  const p = numero(preco);
  const t = numero(taxaPct) || 0;
  if (c == null || p == null || p <= 0) return null;
  return duasCasas((1 - t / 100 - c / p) * 100);
}

/**
 * Como esta a peca neste preco. Os rotulos sao os do alerta de margem
 * (`prejuizo` | `abaixo` | `ok` | `sem_dado`) — duas telas com palavras
 * diferentes para a mesma coisa ensinariam a lojista a desconfiar das duas.
 *
 * Peca sem custo (ficha vazia) e `sem_dado`: margem de 100% numa ficha
 * que ninguem preencheu nao e boa noticia, e ausencia de medida.
 */
function situacao(custo, preco, taxaPct, piso) {
  const c = numero(custo);
  if (c == null || c <= 0) return 'sem_dado';
  return margem.situacao(margemQueSobra(c, preco, taxaPct), piso);
}

/**
 * Quanto o estudio precisa faturar no mes para pagar os custos fixos.
 *
 * `fracaoVariavelMedia` e a parte do preco que vai embora no custo da
 * peca (0.4 = de cada R$ 100 vendidos, R$ 40 sao insumo e mao de obra).
 * Se a peca custa o que vende ou mais, nao ha faturamento que pague o
 * aluguel — null, nao um numero gigante.
 */
function pontoDeEquilibrio(totalFixos, fracaoVariavelMedia) {
  const t = numero(totalFixos);
  const f = numero(fracaoVariavelMedia);
  if (t == null || t < 0 || f == null || f < 0 || f >= 1) return null;
  return duasCasas(t / (1 - f));
}

/**
 * A fracao variavel media das pecas: custo ÷ preco, peca a peca, na media
 * simples. So entram pecas com custo e preco — as outras nao dizem nada.
 */
function fracaoVariavelMedia(pecas) {
  const lista = Array.isArray(pecas) ? pecas : [];
  const fracoes = [];
  for (const p of lista) {
    const c = numero(p && p.custo);
    const v = numero(p && p.preco);
    if (c == null || c <= 0 || v == null || v <= 0) continue;
    fracoes.push(c / v);
  }
  if (!fracoes.length) return null;
  return fracoes.reduce((s, f) => s + f, 0) / fracoes.length;
}

/** A soma mensal dos custos que ela marcou como contando. */
function totalDosCustos(itens) {
  const lista = Array.isArray(itens) ? itens : [];
  let total = 0;
  for (const it of lista) {
    if (!it || it.ativo !== true) continue;
    const v = numero(it.valor);
    if (v != null && v > 0) total += v;
  }
  return duasCasas(total);
}

/**
 * Valida e normaliza a lista de custos fixos que a tela mandou.
 *
 * Devolve `{ ok: true, value }` ou `{ ok: false, error }` com uma frase
 * que da para mostrar a lojista. Nada aqui "conserta" valor ruim em
 * silencio: aluguel de R$ -500 gravado como 0 mudaria a taxa sem ela ver.
 */
function normalizarCustos(itens) {
  if (!Array.isArray(itens)) return { ok: false, error: 'itens deve ser uma lista de custos' };
  if (itens.length > MAXIMO_DE_ITENS) {
    return { ok: false, error: `No máximo ${MAXIMO_DE_ITENS} custos fixos` };
  }
  const vistos = new Set();
  const value = [];
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    const onde = `item ${i + 1}`;
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      return { ok: false, error: `Custo inválido (${onde})` };
    }

    const nome = typeof it.nome === 'string' ? it.nome.trim() : '';
    if (!nome) return { ok: false, error: `Dê um nome ao custo (${onde})` };
    if (nome.length > NOME_MAXIMO) {
      return { ok: false, error: `O nome do custo pode ter até ${NOME_MAXIMO} caracteres (${onde})` };
    }

    if (typeof it.valor !== 'number' || !Number.isFinite(it.valor) || it.valor < 0) {
      return { ok: false, error: `O valor de "${nome}" deve ser um número maior ou igual a zero` };
    }
    if (it.valor > VALOR_MAXIMO) {
      return { ok: false, error: `O valor de "${nome}" está alto demais` };
    }

    const origem = it.origem === undefined ? 'manual' : it.origem;
    if (!ORIGENS.includes(origem)) {
      return { ok: false, error: `origem inválida em "${nome}" (use financeiro ou manual)` };
    }

    let chave = null;
    if (it.chave_financeiro !== undefined && it.chave_financeiro !== null) {
      if (typeof it.chave_financeiro !== 'string' || !it.chave_financeiro.trim() || it.chave_financeiro.length > 120) {
        return { ok: false, error: `chave_financeiro inválida em "${nome}"` };
      }
      chave = it.chave_financeiro.trim();
    }
    if (origem === 'financeiro' && !chave) {
      return { ok: false, error: `"${nome}" veio do financeiro e precisa de chave_financeiro` };
    }

    if (it.ativo !== undefined && typeof it.ativo !== 'boolean') {
      return { ok: false, error: `ativo deve ser verdadeiro ou falso em "${nome}"` };
    }

    let id = it.id;
    if (id === undefined || id === null || id === '') id = crypto.randomUUID();
    if (typeof id !== 'string' || id.length > 64) {
      return { ok: false, error: `id inválido em "${nome}"` };
    }
    if (vistos.has(id)) return { ok: false, error: `Custo repetido na lista ("${nome}")` };
    vistos.add(id);

    const limpo = { id, nome, valor: duasCasas(it.valor), origem, ativo: it.ativo !== false };
    if (origem === 'financeiro') limpo.chave_financeiro = chave;
    value.push(limpo);
  }
  return { ok: true, value };
}

/** Os custos gravados, lidos com desconfianca (JSONB aceita qualquer coisa). */
function custosSalvos(studioSettings) {
  const bruto = (studioSettings || {}).custos_fixos;
  if (!Array.isArray(bruto)) return [];
  const r = normalizarCustos(bruto.slice(0, MAXIMO_DE_ITENS));
  return r.ok ? r.value : [];
}

/** O faturamento que ela ESPERA ter — a saida para estudio sem historico. */
function faturamentoEsperado(studioSettings) {
  const n = numero((studioSettings || {}).faturamento_esperado);
  return n != null && n > 0 ? n : null;
}

function mesesEntre(de, ate) {
  const [a1, m1] = String(de).split('-').map(Number);
  const [a2, m2] = String(ate).split('-').map(Number);
  return (a2 - a1) * 12 + (m2 - m1);
}

/**
 * O faturamento medio mensal, e de onde ele saiu.
 *
 * `linhas` sao os meses FECHADOS com receita (`{ mes: 'AAAA-MM', receita }`)
 * e `mesAtual` e o mes corrente, que fica de fora por estar pela metade.
 *
 * A media divide pelo numero de meses desde o PRIMEIRO mes com receita
 * ate o ultimo mes fechado — nem por 6 fixo (o estudio que abriu ha
 * quatro meses pareceria faturar um terco a menos), nem so pelos meses
 * com venda (um mes parado no meio sumiria e a taxa sairia otimista).
 *
 * Com menos de 3 meses com receita vale o faturamento esperado, se ela
 * informou. Sem esperado, usa o pouco historico que ha: um numero fraco
 * e declarado como fraco (`meses_com_dado`) serve mais do que nenhum.
 */
function faturamentoMedio(linhas, mesAtual, esperado) {
  const comDado = (Array.isArray(linhas) ? linhas : [])
    .map((l) => ({ mes: String(l.mes || ''), receita: numero(l.receita) || 0 }))
    .filter((l) => /^\d{4}-\d{2}$/.test(l.mes) && l.receita > 0 && l.mes < mesAtual)
    .sort((a, b) => (a.mes < b.mes ? -1 : 1));

  const meses = comDado.length;
  let historico = null;
  if (meses > 0) {
    const janela = Math.max(1, mesesEntre(comDado[0].mes, mesAtual));
    historico = duasCasas(comDado.reduce((s, l) => s + l.receita, 0) / janela);
  }
  const esp = numero(esperado);
  const temEsperado = esp != null && esp > 0;

  if (meses >= MESES_MINIMOS_DE_HISTORICO) return { medio: historico, meses_com_dado: meses, origem: 'historico' };
  if (temEsperado) return { medio: duasCasas(esp), meses_com_dado: meses, origem: 'esperado' };
  if (meses > 0) return { medio: historico, meses_com_dado: meses, origem: 'historico' };
  return { medio: null, meses_com_dado: 0, origem: 'nenhum' };
}

/** Quantas vezes por mes cada tipo de recorrencia acontece, em media. */
const VEZES_POR_MES = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };

function chaveDoFinanceiro(descricao) {
  const slug = String(descricao || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .substring(0, 80);
  return 'rec:' + (slug || 'sem-nome');
}

/**
 * As despesas recorrentes do financeiro, viradas em sugestao de custo fixo.
 *
 * `grupos` vem um por serie recorrente (`recurrence_group_id`). A chave e
 * a DESCRICAO, nao o id da serie: a serie do aluguel acaba depois de 12
 * parcelas, ela cadastra outra, e o item que ja estava marcado tem de
 * continuar casando. Duas series vivas com a mesma descricao (dois
 * salarios) somam.
 *
 * `eFixa(categoria)` diz se a categoria e despesa fixa no DRE — serve so
 * de dica para a tela pre-marcar; quem decide o que conta e ela.
 */
function sugestoesDoFinanceiro(grupos, itensSalvos, eFixa) {
  const porChave = new Map();
  for (const g of Array.isArray(grupos) ? grupos : []) {
    const valor = numero(g && g.valor);
    const vezes = VEZES_POR_MES[g && g.tipo];
    const nome = String((g && g.descricao) || '').trim();
    if (valor == null || valor <= 0 || !vezes || !nome) continue;
    const chave = chaveDoFinanceiro(nome);
    const atual = porChave.get(chave) || {
      chave_financeiro: chave,
      nome: nome.substring(0, NOME_MAXIMO),
      valor: 0,
      categoria: g.categoria || null,
      recorrencia: g.tipo,
      despesa_fixa: typeof eFixa === 'function' ? Boolean(eFixa(g.categoria)) : false,
    };
    atual.valor += valor * vezes;
    porChave.set(chave, atual);
  }
  const jaIncluidas = new Set(
    (Array.isArray(itensSalvos) ? itensSalvos : []).map((i) => i && i.chave_financeiro).filter(Boolean)
  );
  return Array.from(porChave.values())
    .map((s) => ({ ...s, valor: duasCasas(s.valor), ja_incluida: jaIncluidas.has(s.chave_financeiro) }))
    .sort((a, b) => b.valor - a.valor);
}

/** Do pior para o melhor; quem nao da para julgar fica no fim. */
const ORDEM_DA_SITUACAO = { prejuizo: 0, abaixo: 1, ok: 2, sem_dado: 3 };

/**
 * O diagnostico peca a peca.
 *
 * `linhas` vem de `studio_compositions_summary`; `maoDeObraDe(productId)`
 * devolve o `labor_cost` da regra ativa (do produto, senao a global,
 * senao 0). O setup NAO entra: ele se dilui na tiragem, e aqui nao ha
 * tiragem — somar setup inteiro reprovaria toda peca vendida em lote.
 */
function diagnostico(linhas, { taxaPct, piso, maoDeObraDe }) {
  const pecas = (Array.isArray(linhas) ? linhas : []).map((l) => {
    const insumos = numero(l.total_cost) || 0;
    const mao = Math.max(0, numero(typeof maoDeObraDe === 'function' ? maoDeObraDe(l.product_id) : 0) || 0);
    const custo = duasCasas(insumos + mao);
    const preco = numero(l.product_price);
    const temPreco = preco != null && preco > 0;
    const sit = situacao(custo, temPreco ? preco : null, taxaPct, piso);
    return {
      product_id: l.product_id,
      nome: l.product_name,
      image_url: l.image_url || null,
      custo_insumos: duasCasas(insumos),
      mao_de_obra: duasCasas(mao),
      custo_da_peca: custo,
      preco_atual: temPreco ? preco : null,
      margem_que_sobra_pct: sit === 'sem_dado' ? null : margemQueSobra(custo, preco, taxaPct),
      situacao: sit,
      preco_sugerido: precoSugerido(custo, taxaPct, piso),
    };
  });
  pecas.sort((a, b) => {
    const o = ORDEM_DA_SITUACAO[a.situacao] - ORDEM_DA_SITUACAO[b.situacao];
    if (o !== 0) return o;
    return (a.margem_que_sobra_pct ?? 0) - (b.margem_que_sobra_pct ?? 0);
  });
  const conta = (s) => pecas.filter((p) => p.situacao === s).length;
  return {
    pecas,
    resumo: { prejuizo: conta('prejuizo'), abaixo: conta('abaixo'), ok: conta('ok'), sem_dado: conta('sem_dado') },
  };
}

module.exports = {
  TAXA_MAXIMA,
  TETO_TAXA_MAIS_MARGEM,
  MAXIMO_DE_ITENS,
  NOME_MAXIMO,
  MESES_MINIMOS_DE_HISTORICO,
  taxaValida,
  taxaEmUso,
  taxaConfigurada,
  taxaReal,
  precoSugerido,
  margemQueSobra,
  situacao,
  pontoDeEquilibrio,
  fracaoVariavelMedia,
  totalDosCustos,
  normalizarCustos,
  custosSalvos,
  faturamentoEsperado,
  faturamentoMedio,
  chaveDoFinanceiro,
  sugestoesDoFinanceiro,
  diagnostico,
};
