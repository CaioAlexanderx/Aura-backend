// ============================================================
// AURA. — Vendas por produto e numeração (03/11/2026)
//
// Pedido do PO: "quantidade exata de produtos vendidos no período,
// separados por modelo, tipo e numeração, em TABELA — quantos pares de cada
// modelo no mês, quais numerações saíram mais, quais produtos giraram mais".
// Mockup aprovado: aura-app docs/mockups/relatorio-vendas-por-numeracao.html.
// Contrato: GET /companies/:id/reports/vendas-por-numeracao
// (src/routes/relatorioVendasPorNumeracao.js).
//
// DE ONDE VEM CADA COISA
//   Modelo = produto. Tipo = categoria.
//   Numeração = valor da variante com atributo Tamanho/Numeração/Número
//     (product_variant_values; 23 lojas em 03/11) → senão products.size
//     (9 lojas cadastram assim) → senão "Sem numeração".
//   A venda guarda a variante (sale_items.variant_id): a contagem por
//   numeração é exata, inclusive no passado. Variante desativada depois
//   continua dando a numeração da venda antiga.
//   Estoque = o de HOJE (variantes ativas; sem variante, o do produto).
//
// MESMAS REGRAS DA CURVA ABC (services/productsRanking.js): venda cancelada
// fora, troca fora (type = 'sale'), fuso America/Sao_Paulo. Serviço
// (unit 'srv') fora: o relatório é de mercadoria.
//
// CONTAS (linguagem de balcão, legenda na tela):
//   giro  = vendidos ÷ (vendidos + estoque de hoje)        "vendeu X% do que teve"
//   dura  = estoque ÷ (vendidos ÷ dias do período)         "o estoque dura ~N dias"
//   repor = Σ por numeração de max(0, vendidos − estoque)  "comprar para vender o mesmo de novo"
//   (a sobra de uma numeração não cobre a falta de outra: ninguém calça 39 no lugar de 37)
// ============================================================
'use strict';

const SEM_NUMERACAO = 'Sem numeração';
const ATRIBUTOS_DE_NUMERACAO = ['tamanho', 'tamanhos', 'numeracao', 'numero', 'num', 'tam', 'tamanho/numeracao'];
const ATRIBUTOS_DE_COR = ['cor', 'cores', 'color'];
// Ordem das letras de roupa (depois dos números).
const ORDEM_LETRAS = ['RN', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG', 'EXG', 'G1', 'G2', 'G3', 'G4', 'G5', 'U', 'UN', 'UNICO', 'TAMANHO UNICO'];
const CALCADO = /cal[cç]ad|t[eê]nis|sand[aá]li|\bbotas?\b|chinel|sapat|tamanc|rasteir|scarpin|mocassim|papete|mule|slide|sapatilh/i;
const HEX = /^#[0-9a-f]{6}$/i;
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const round = (n, c = 2) => { const f = 10 ** c; return Math.round((Number(n) + Number.EPSILON) * f) / f; };

// ── Período ───────────────────────────────────────────────────────

function hojeSP(agora = Date.now()) {
  return new Date(agora - 3 * 3600000).toISOString().slice(0, 10);
}
function somarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diasEntre(inicio, fim) {
  return Math.round((new Date(fim + 'T12:00:00Z') - new Date(inicio + 'T12:00:00Z')) / 86400000) + 1;
}
function ultimoDiaDoMes(ano, mes) { // mes 1-12
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

const PERIODOS = ['week', 'month', 'last_month', 'd90', 'custom'];

/**
 * { inicio, fim, dias, rotulo, anterior: { inicio, fim } } — datas
 * 'YYYY-MM-DD' de Brasília, fim inclusivo. Lança { status: 400 } no
 * período inválido.
 */
function resolverPeriodo(period = 'month', start, end, hoje = hojeSP()) {
  const erro = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!PERIODOS.includes(period)) throw erro(`period inválido. Use: ${PERIODOS.join(', ')}`);
  const [y, m, d] = hoje.split('-').map(Number);
  let inicio; let fim; let rotulo; let anterior;
  if (period === 'week') {
    inicio = somarDias(hoje, -6); fim = hoje; rotulo = 'Últimos 7 dias';
  } else if (period === 'd90') {
    inicio = somarDias(hoje, -89); fim = hoje; rotulo = 'Últimos 90 dias';
  } else if (period === 'month') {
    inicio = `${y}-${String(m).padStart(2, '0')}-01`; fim = hoje;
    rotulo = `${MESES[m - 1]} de ${y}`;
    // Mesmos dias do mês anterior (1 a d, cortando no fim do mês).
    const [ya, ma] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const dAnt = Math.min(d, ultimoDiaDoMes(ya, ma));
    anterior = { inicio: `${ya}-${String(ma).padStart(2, '0')}-01`, fim: `${ya}-${String(ma).padStart(2, '0')}-${String(dAnt).padStart(2, '0')}` };
  } else if (period === 'last_month') {
    const [ya, ma] = m === 1 ? [y - 1, 12] : [y, m - 1];
    inicio = `${ya}-${String(ma).padStart(2, '0')}-01`;
    fim = `${ya}-${String(ma).padStart(2, '0')}-${String(ultimoDiaDoMes(ya, ma)).padStart(2, '0')}`;
    rotulo = `${MESES[ma - 1]} de ${ya}`;
    const [yb, mb] = ma === 1 ? [ya - 1, 12] : [ya, ma - 1];
    anterior = { inicio: `${yb}-${String(mb).padStart(2, '0')}-01`, fim: `${yb}-${String(mb).padStart(2, '0')}-${String(ultimoDiaDoMes(yb, mb)).padStart(2, '0')}` };
  } else {
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00Z'));
    if (!ok(start) || !ok(end)) throw erro('Escolha as duas datas (início e fim)');
    if (start > end) throw erro('A data de início vem depois do fim');
    if (diasEntre(start, end) > 366) throw erro('O período pode ter no máximo 1 ano');
    inicio = start; fim = end; rotulo = `${dataBR(start)} a ${dataBR(end)}`;
  }
  const dias = diasEntre(inicio, fim);
  if (!anterior) anterior = { inicio: somarDias(inicio, -dias), fim: somarDias(inicio, -1) };
  return { inicio, fim, dias, rotulo, anterior };
}

// ── Numeração e cor ───────────────────────────────────────────────

function limparNumeracao(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return /[a-z]/i.test(s) && !/\d/.test(s) ? s.toUpperCase() : s;
}

/** Valor do atributo de numeração da variante (ou null). */
function numeracaoDaVariante(valores) {
  for (const { a, v } of valores || []) {
    if (ATRIBUTOS_DE_NUMERACAO.includes(semAcento(a))) return limparNumeracao(v);
  }
  return null;
}

function corDaVariante(valores, colorName) {
  for (const { a, v } of valores || []) {
    if (ATRIBUTOS_DE_COR.includes(semAcento(a))) {
      const t = String(v || '').trim();
      if (!t) continue;
      return HEX.test(t) ? (String(colorName || '').trim() || t.toUpperCase()) : t;
    }
  }
  return String(colorName || '').trim() || null;
}

/** Ordem de vitrine: números (34, 34/35, 37.5), letras de roupa, o resto, "Sem numeração". */
function compararNumeracao(a, b) {
  const chave = (s) => {
    if (s === SEM_NUMERACAO) return [3, 0, ''];
    const n = String(s).replace(',', '.').match(/^\d+(\.\d+)?/);
    if (n) return [0, parseFloat(n[0]), String(s)];
    const i = ORDEM_LETRAS.indexOf(semAcento(s).toUpperCase());
    if (i >= 0) return [1, i, ''];
    return [2, 0, semAcento(s)];
  };
  const ka = chave(a); const kb = chave(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
}

function ehCalcado(prod) {
  return semAcento(prod.unit) === 'par' || CALCADO.test(semAcento(prod.category || '')) || CALCADO.test(semAcento(prod.name || '').split(' ')[0] || '');
}

// ── Montagem (puro) ───────────────────────────────────────────────

function giro(vendidos, estoque) {
  const base = vendidos + Math.max(estoque, 0);
  return base > 0 ? Math.round((vendidos / base) * 100) : null;
}
function dura(vendidos, estoque, dias) {
  if (!(vendidos > 0)) return null;
  if (!(estoque > 0)) return 0;
  return Math.floor(estoque / (vendidos / dias));
}

/**
 * @param produtos  [{ id, name, sku, category, unit, size, stock_qty, is_active, supplier }]
 * @param variantes [{ id, product_id, stock_qty, is_active, color_name, valores: [{a, v}] }]
 * @param vendas    [{ product_id, variant_id, qtd, receita, snapshot }]
 * @param opts      { dias, porCor, category, q, vendidosAnterior }
 */
function montarRelatorio({ produtos, variantes, vendas, opts }) {
  const { dias, porCor = false, category = null, q = null, vendidosAnterior = 0 } = opts;
  const prodPorId = new Map(produtos.map((p) => [String(p.id), p]));
  const varPorId = new Map(variantes.map((v) => [String(v.id), v]));
  const varsDoProduto = new Map();
  for (const v of variantes) {
    const k = String(v.product_id);
    if (!varsDoProduto.has(k)) varsDoProduto.set(k, []);
    varsDoProduto.get(k).push(v);
  }

  const busca = q ? semAcento(q) : null;
  const passa = (p) => {
    if (!p || p.unit === 'srv') return false;
    if (category && String(p.category || '') !== category) return false;
    if (busca && !semAcento(p.name).includes(busca) && !semAcento(p.sku).includes(busca)) return false;
    return true;
  };

  const chaveModelo = (pid, cor) => (porCor ? `${pid}|${cor || ''}` : String(pid));
  const modelos = new Map(); // chave -> modelo
  const porNumeracao = new Map(); // numeração -> { vendidos, estoque, repor }
  const numeracaoGeral = (n) => {
    if (!porNumeracao.has(n)) porNumeracao.set(n, { numeracao: n, vendidos: 0, estoque: 0, repor: 0 });
    return porNumeracao.get(n);
  };
  const modelo = (p, cor, snapshot) => {
    const k = chaveModelo(p ? p.id : snapshot.id, cor);
    if (!modelos.has(k)) {
      modelos.set(k, {
        product_id: p ? String(p.id) : String(snapshot.id),
        nome: p ? p.name : (snapshot.nome || 'Produto removido'),
        sku: p ? (p.sku || null) : null,
        tipo: p ? (p.category || 'Sem categoria') : 'Sem categoria',
        cor: porCor ? (cor || null) : null,
        vendidos: 0, receita: 0, estoque: 0,
        fornecedor: p && p.supplier ? p.supplier : null,
        _num: new Map(),
      });
    }
    return modelos.get(k);
  };
  const celula = (m, n) => {
    if (!m._num.has(n)) m._num.set(n, { numeracao: n, vendidos: 0, estoque: 0 });
    return m._num.get(n);
  };

  // 1. Estoque de hoje de TODOS os produtos ativos do filtro.
  let modelosTotal = 0;
  const contados = new Set();
  for (const p of produtos) {
    if (!p.is_active || !passa(p)) continue;
    const vs = (varsDoProduto.get(String(p.id)) || []).filter((v) => v.is_active);
    const linhas = vs.length
      ? vs.map((v) => ({ n: numeracaoDaVariante(v.valores) || limparNumeracao(p.size) || SEM_NUMERACAO, cor: corDaVariante(v.valores, v.color_name), q: Number(v.stock_qty) || 0 }))
      : [{ n: limparNumeracao(p.size) || SEM_NUMERACAO, cor: null, q: Number(p.stock_qty) || 0 }];
    for (const l of linhas) {
      const k = chaveModelo(p.id, l.cor);
      if (!contados.has(k)) { contados.add(k); modelosTotal += 1; }
      const q = Math.max(l.q, 0);
      numeracaoGeral(l.n).estoque += q;
      // estoque do modelo só conta se ele vendeu (ver passo 3)
      const m = modelo(p, l.cor);
      m.estoque += q;
      celula(m, l.n).estoque += q;
    }
  }

  // 2. Vendas do período.
  let unidadesPar = 0; let unidadesOutra = 0;
  for (const s of vendas) {
    const p = prodPorId.get(String(s.product_id)) || null;
    if (p ? !passa(p) : (category || busca)) continue;
    const v = s.variant_id ? varPorId.get(String(s.variant_id)) : null;
    const n = (v && numeracaoDaVariante(v.valores)) || (p && limparNumeracao(p.size)) || SEM_NUMERACAO;
    const cor = v ? corDaVariante(v.valores, v.color_name) : null;
    const qtd = Number(s.qtd) || 0;
    const m = modelo(p, cor, { id: s.product_id, nome: s.snapshot });
    m.vendidos += qtd;
    m.receita += Number(s.receita) || 0;
    celula(m, n).vendidos += qtd;
    numeracaoGeral(n).vendidos += qtd;
    if (p && ehCalcado(p)) unidadesPar += qtd; else unidadesOutra += qtd;
  }

  // 3. Só quem vendeu vira linha; contas por modelo.
  const lista = [...modelos.values()].filter((m) => m.vendidos > 0).map((m) => {
    const numeracoes = [...m._num.values()]
      .filter((c) => c.vendidos > 0 || c.estoque > 0)
      .sort((a, b) => compararNumeracao(a.numeracao, b.numeracao))
      .map((c) => ({ numeracao: c.numeracao, vendidos: round(c.vendidos, 3), estoque: round(c.estoque, 3) }));
    const repor = numeracoes.reduce((s, c) => s + Math.max(0, c.vendidos - c.estoque), 0);
    for (const c of numeracoes) numeracaoGeral(c.numeracao).repor += Math.max(0, c.vendidos - c.estoque);
    return {
      product_id: m.product_id, nome: m.nome, sku: m.sku, tipo: m.tipo, cor: m.cor,
      vendidos: round(m.vendidos, 3), receita: round(m.receita), estoque: round(m.estoque, 3),
      giro_pct: giro(m.vendidos, m.estoque), dura_dias: dura(m.vendidos, m.estoque, dias),
      repor: round(repor, 3), fornecedor: m.fornecedor, numeracoes,
    };
  }).sort((a, b) => b.vendidos - a.vendidos || b.receita - a.receita || a.nome.localeCompare(b.nome, 'pt-BR'));

  const vendidos = lista.reduce((s, m) => s + m.vendidos, 0);
  const receita = lista.reduce((s, m) => s + m.receita, 0);
  const estoqueListados = lista.reduce((s, m) => s + m.estoque, 0);

  const numeracoes = [...porNumeracao.values()]
    .filter((n) => n.vendidos > 0 || n.estoque > 0)
    .map((n) => ({ numeracao: n.numeracao, vendidos: round(n.vendidos, 3), pct: vendidos > 0 ? Math.round((n.vendidos / vendidos) * 100) : 0, estoque: round(n.estoque, 3), repor: n.numeracao === SEM_NUMERACAO ? null : round(n.repor, 3) }))
    .sort((a, b) => (a.numeracao === SEM_NUMERACAO) - (b.numeracao === SEM_NUMERACAO) || b.vendidos - a.vendidos || compararNumeracao(a.numeracao, b.numeracao));

  const campeaN = numeracoes.find((n) => n.numeracao !== SEM_NUMERACAO && n.vendidos > 0) || null;
  const colunas = [...new Set(lista.flatMap((m) => m.numeracoes.map((c) => c.numeracao)))].sort(compararNumeracao);
  const categorias = [...new Set(produtos.filter((p) => p.is_active && p.unit !== 'srv' && p.category).map((p) => String(p.category)))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));

  return {
    unidade: unidadesPar && !unidadesOutra ? 'pares' : unidadesPar ? 'itens' : 'peças',
    kpis: {
      vendidos: round(vendidos, 3),
      receita: round(receita),
      ticket_medio: vendidos > 0 ? round(receita / vendidos) : null,
      modelos_venderam: lista.length,
      modelos_total: modelosTotal,
      campea: campeaN ? { numeracao: campeaN.numeracao, vendidos: campeaN.vendidos, pct: campeaN.pct } : null,
      vendidos_anterior: round(vendidosAnterior, 3),
      variacao_pct: vendidosAnterior > 0 ? Math.round(((vendidos - vendidosAnterior) / vendidosAnterior) * 100) : null,
    },
    colunas,
    categorias,
    modelos: lista,
    numeracoes,
    totais: {
      vendidos: round(vendidos, 3),
      receita: round(receita),
      estoque: round(estoqueListados, 3),
      giro_pct: giro(vendidos, estoqueListados),
      dura_dias: dura(vendidos, estoqueListados, dias),
      repor: round(lista.reduce((s, m) => s + m.repor, 0), 3),
    },
  };
}

// ── Banco ─────────────────────────────────────────────────────────

const FILTRO_VENDA = `COALESCE(s.status, 'completed') != 'cancelled' AND COALESCE(s.type, 'sale') = 'sale'`;
const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

async function somaVendida(db, companyIds, inicio, fim) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(si.quantity), 0)::float AS qtd
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
      WHERE s.company_id = ANY($1::uuid[]) AND ${FILTRO_VENDA}
        AND (s.created_at ${SP}) >= $2::date AND (s.created_at ${SP}) < ($3::date + 1)
        AND si.product_id IS NOT NULL AND COALESCE(p.unit, '') <> 'srv'`,
    [companyIds, inicio, fim]
  );
  return Number(rows[0] && rows[0].qtd) || 0;
}

/**
 * Lê do banco e monta. `companyId` = a loja de :id; `companyIds` = as lojas
 * cujas vendas entram (só ela, ou o grupo no consolidado).
 */
async function vendasPorNumeracao(db, { companyId, companyIds, periodo, porCor, category, q }) {
  const ids = companyIds && companyIds.length ? companyIds : [companyId];
  const [{ rows: vendas }, vendidosAnterior] = await Promise.all([
    db.query(
      `SELECT si.product_id, si.variant_id,
              SUM(si.quantity)::float AS qtd,
              COALESCE(SUM(si.total_price), 0)::float AS receita,
              MAX(si.product_name_snapshot) AS snapshot
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
        WHERE s.company_id = ANY($1::uuid[]) AND ${FILTRO_VENDA}
          AND (s.created_at ${SP}) >= $2::date AND (s.created_at ${SP}) < ($3::date + 1)
          AND si.product_id IS NOT NULL
        GROUP BY si.product_id, si.variant_id`,
      [ids, periodo.inicio, periodo.fim]
    ),
    somaVendida(db, ids, periodo.anterior.inicio, periodo.anterior.fim),
  ]);

  const vendidosIds = [...new Set(vendas.map((v) => String(v.product_id)))];
  // Produtos: os ativos das lojas (+ compartilhados do grupo) e os vendidos,
  // mesmo que hoje inativos/apagados do catálogo.
  const { rows: produtos } = await db.query(
    `SELECT p.id, p.name, p.sku, p.category, p.unit, p.size, p.stock_qty, p.is_active,
            s.id AS supplier_id, s.name AS supplier_name, s.phone AS supplier_phone
       FROM products p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE (p.is_active AND (p.company_id = ANY($1::uuid[]) OR (p.is_group_shared = true AND p.company_id IN (
               SELECT id FROM companies
                WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
                  SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $2)))))
         OR p.id = ANY($3::uuid[])`,
    [ids, companyId, vendidosIds]
  );
  const prodIds = produtos.map((p) => p.id);
  const { rows: variantes } = await db.query(
    // Um JOIN agregado (não subconsulta por variante): product_variant_values
    // não tinha índice nenhum em 03/11/2026 (migration 425 cria).
    `SELECT v.id, v.product_id, v.stock_qty, v.is_active, v.color_name,
            COALESCE(json_agg(json_build_object('a', vv.attribute_name, 'v', vv.value))
                       FILTER (WHERE vv.variant_id IS NOT NULL), '[]'::json) AS valores
       FROM product_variants v
       LEFT JOIN product_variant_values vv ON vv.variant_id = v.id
      WHERE v.product_id = ANY($1::uuid[])
      GROUP BY v.id`,
    [prodIds]
  );

  const relatorio = montarRelatorio({
    produtos: produtos.map((p) => ({
      ...p,
      supplier: p.supplier_id ? { id: p.supplier_id, nome: p.supplier_name, telefone: p.supplier_phone || null } : null,
    })),
    variantes: variantes.map((v) => ({ ...v, valores: Array.isArray(v.valores) ? v.valores : [] })),
    vendas,
    opts: { dias: periodo.dias, porCor, category, q, vendidosAnterior },
  });
  return {
    periodo: { inicio: periodo.inicio, fim: periodo.fim, dias: periodo.dias, rotulo: periodo.rotulo },
    ...relatorio,
  };
}

module.exports = {
  SEM_NUMERACAO,
  resolverPeriodo,
  hojeSP,
  numeracaoDaVariante,
  corDaVariante,
  compararNumeracao,
  ehCalcado,
  montarRelatorio,
  vendasPorNumeracao,
};
