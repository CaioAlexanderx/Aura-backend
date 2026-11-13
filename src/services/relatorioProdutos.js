// ============================================================
// AURA. — Relatório de Produtos do Financeiro › Relatórios (p-114, 13/11/2026)
//
// Contrato: GET /companies/:id/relatorios/produtos (src/routes/relatorioProdutos.js).
// Nada é gravado. Três consultas em paralelo (catálogo, vendas, dias com
// venda), qualquer que seja o número de lojas; filtro, agrupamento, ordem e
// página são feitos aqui, em memória (a maior loja tem ~1.700 produtos).
//
// ── MODELOS ────────────────────────────────────────────────────────────
// Um modelo só preenche padrões de filtro, ordem e agrupamento; o que vier
// explícito na query vale mais (MODELOS, abaixo). Os de custo (mais
// lucrativos, margem baixa, sem custo) não existem para quem não vê custo.
//
// ── O QUE É UM ITEM ────────────────────────────────────────────────────
// Igual à ruptura (services/ruptura.js): a variante ativa quando o produto
// tem grade, o produto quando não tem. agrupar=produto soma os itens de um
// product_id: estoque, vendidos, faturamento e lucro somados; margem refeita
// sobre a soma (lucro ÷ faturamento), nunca média de margens; último dia
// vendido = o mais recente; dias_ate_acabar = o MENOR entre as variantes,
// com `primeiro_a_acabar` dizendo qual.
// Venda que não tem item onde cair — variante hoje desativada, ou venda sem
// variante num produto que hoje tem grade — fica fora no agrupar=item e soma
// no agrupar=produto (é do produto, só não é de nenhuma variante ativa).
//
// ── VENDAS ─────────────────────────────────────────────────────────────
// Mesmas regras do Resultado do período (services/resultadoDoPeriodo.js) e
// da curva ABC: venda cancelada fora, troca fora (type 'sale'), dia de São
// Paulo. Faturamento do item = total da linha rateado pelo total da venda
// (o desconto da venda inteira cai proporcionalmente em cada item), então a
// soma bate com as vendas do Financeiro. Serviço (unit 'srv' ou com
// duração) fica fora: o relatório é de mercadoria.
//
// ── CUSTO ──────────────────────────────────────────────────────────────
// Custo do produto = COALESCE(NULLIF(weighted_avg_cost, 0), NULLIF(cost_price, 0)),
// a mesma conta da conferência de estoque e do "preencher custos em massa".
// Sem custo cadastrado NÃO é custo zero: a linha sem custo fica com lucro,
// margem e valor parado nulos, fora dos totais de lucro e margem, e conta em
// cobertura_custo.sem_custo.
// Lucro da linha com custo = faturamento − Σ quantidade × custo da venda
// (sale_items.unit_cost, o que o Financeiro usa); quando a venda gravou 0 ou
// nada (vendeu antes de o custo ser cadastrado), entra o custo de hoje.
// Quem não vê custo (podeVerCusto) recebe esses campos como null — o corte é
// feito aqui, não por nome de chave.
//
// ── RITMO E DIAS ATÉ ACABAR ────────────────────────────────────────────
// A conta da ruptura (projetar), sobre o período pedido: ritmo = unidades ÷
// dias com loja aberta no período; os dias à frente seguem os dias da
// semana em que a loja abriu. media_diaria é esse ritmo. Estoque zerado ou
// negativo = 0 dias (já acabou). Sem venda no período = null.
//
// ── MULTI-CNPJ (como a ruptura) ────────────────────────────────────────
// Loja: os produtos dela + os compartilhados do grupo (is_group_shared).
// Grupo: os de todas as lojas pedidas + os compartilhados, cada produto UMA
// vez, com a loja dona (`loja`) — o estoque é a linha do produto, não se
// soma o mesmo nome entre lojas.
// O que é do estoque segue a ruptura: o compartilhado esvazia com a venda de
// qualquer loja do grupo, então ritmo, dias_ate_acabar, último dia vendido e
// dias sem vender dele contam o grupo inteiro (e os dias abertos do grupo).
// O que é dinheiro segue o Financeiro: vendidos, faturamento e lucro contam
// só as lojas do escopo — na loja, a venda dela; no grupo, a das lojas.
// ============================================================
'use strict';

const pool = require('../config/database');
const { projetar, diasDeVendaFuturos, hojeBRT } = require('./ruptura');

const TZ = 'America/Sao_Paulo';
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERIODO_PADRAO_DIAS = 30;
const PERIODO_MAX_DIAS = 366;
// Último dia vendido olha até 1 ano para trás: além disso (ou nunca) sai
// null, e dias_sem_vender null conta como "parado" (ver passaFiltros).
const HISTORICO_DIAS = 365;
const LIMIT_PADRAO = 50;
const LIMIT_MAX = 200;
// todas=1 (exportação): no máximo isto; acima, `truncado: true`. A maior
// loja tem ~1.700 produtos; 5.000 linhas cobrem a loja de grade grande.
const TETO_EXPORTACAO = 5000;
const MARGEM_BAIXA_PADRAO = 20;
const ACABA_EM_PADRAO = 30;
const PARADO_PADRAO = 30;
const TEXTO_MAX = 120;

const MODELOS = {
  estoque_acabando: {
    agrupar: 'item', com_estoque: true, acaba_em_dias: ACABA_EM_PADRAO,
    ordem: 'dias_ate_acabar', direcao: 'asc',
  },
  mais_vendidos: { agrupar: 'produto', vendeu: true, ordem: 'vendidos', direcao: 'desc' },
  parados_30: {
    agrupar: 'item', com_estoque: true, sem_vender_dias: PARADO_PADRAO,
    ordem: 'valor_parado', direcao: 'desc',
    // quem não vê custo não ordena por valor parado
    ordem_sem_custo: 'dias_sem_vender',
  },
  mais_lucrativos: {
    agrupar: 'produto', vendeu: true, sem_custo: false, ordem: 'lucro', direcao: 'desc', precisa_custo: true,
  },
  margem_baixa: {
    agrupar: 'produto', vendeu: true, sem_custo: false, margem_max: MARGEM_BAIXA_PADRAO,
    ordem: 'margem', direcao: 'asc', precisa_custo: true,
  },
  estoque_zerado: { agrupar: 'item', com_estoque: false, ordem: 'vendidos', direcao: 'desc' },
  sem_custo: { agrupar: 'produto', sem_custo: true, ordem: 'faturamento', direcao: 'desc', precisa_custo: true },
};
const MODELOS_COM_CUSTO = Object.keys(MODELOS).filter((m) => MODELOS[m].precisa_custo);

const ORDENS = [
  'nome', 'estoque', 'preco', 'custo', 'vendidos', 'faturamento', 'lucro', 'margem',
  'ultima_venda', 'dias_sem_vender', 'media_diaria', 'dias_ate_acabar', 'valor_parado', 'valor_estoque_venda',
];
const ORDENS_DE_CUSTO = ['custo', 'lucro', 'margem', 'valor_parado'];

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const numOuNull = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const round1 = (v) => Math.round(num(v) * 10) / 10;
const round2 = (v) => Math.round(num(v) * 100) / 100;
const round3 = (v) => Math.round(num(v) * 1000) / 1000;

// ── datas ('YYYY-MM-DD', sem fuso) ──────────────────────────────
const paraUTC = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const somaDias = (ymd, n) => new Date(paraUTC(ymd) + n * 86400000).toISOString().slice(0, 10);
const diasEntre = (de, ate) => Math.round((paraUTC(ate) - paraUTC(de)) / 86400000);
const dataValida = (s) => typeof s === 'string' && DIA.test(s) && somaDias(s, 0) === s;

// ── parâmetros ──────────────────────────────────────────────────
function erro(status, code, mensagem, extra = {}) {
  return Object.assign(new Error(mensagem), { statusCode: status, code, extra });
}
const erroParametro = (mensagem) => erro(400, 'RELATORIO_PARAMETRO', mensagem);

const presente = (v) => v !== undefined && v !== null && v !== '';

function lerBool(v, nome) {
  if (!presente(v)) return undefined;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'sim'].includes(s)) return true;
  if (['0', 'false', 'nao', 'não'].includes(s)) return false;
  throw erroParametro(`${nome} deve ser 1 ou 0`);
}
function lerNumero(v, nome, { min = -Infinity, max = Infinity, inteiro = false } = {}) {
  if (!presente(v)) return undefined;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || (inteiro && !Number.isInteger(n)) || n < min || n > max) {
    throw erroParametro(`${nome} inválido`);
  }
  return n;
}
function lerTexto(v) {
  if (!presente(v)) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim().slice(0, TEXTO_MAX);
  return s || null;
}

function resolverPeriodo(de, ate, hoje) {
  if (presente(de) && !dataValida(String(de))) throw erroParametro('de deve ser uma data YYYY-MM-DD');
  if (presente(ate) && !dataValida(String(ate))) throw erroParametro('ate deve ser uma data YYYY-MM-DD');
  const fim = presente(ate) ? String(ate) : hoje;
  const inicio = presente(de) ? String(de) : somaDias(fim, -(PERIODO_PADRAO_DIAS - 1));
  if (fim > hoje) throw erroParametro('ate não pode ser depois de hoje');
  if (inicio > fim) throw erroParametro('de vem depois de ate');
  const dias = diasEntre(inicio, fim) + 1;
  if (dias > PERIODO_MAX_DIAS) throw erroParametro(`O período pode ter no máximo ${PERIODO_MAX_DIAS} dias`);
  return { de: inicio, ate: fim, dias, hoje };
}

/**
 * Confere a query e devolve os parâmetros efetivos (padrões do modelo +
 * o que veio explícito). Lança 400 (RELATORIO_PARAMETRO) no parâmetro
 * inválido e 403 (RELATORIO_SEM_CUSTO) quando quem não vê custo pede um
 * modelo, filtro ou ordem de custo.
 */
function normalizarParametros(query = {}, { hoje = hojeBRT(), podeVerCusto = true } = {}) {
  const q = query || {};
  const modelo = presente(q.modelo) ? String(q.modelo) : null;
  if (modelo && !MODELOS[modelo]) {
    throw erroParametro(`modelo inválido. Use: ${Object.keys(MODELOS).join(', ')}`);
  }
  const base = modelo ? MODELOS[modelo] : {};
  const semCusto = (motivo) => erro(403, 'RELATORIO_SEM_CUSTO',
    'Este acesso não mostra custos, por isso este relatório não está disponível.',
    { motivo, modelos_sem_custo: MODELOS_COM_CUSTO });
  if (!podeVerCusto && base.precisa_custo) throw semCusto(`modelo ${modelo}`);

  const periodo = resolverPeriodo(q.de, q.ate, hoje);

  const agrupar = presente(q.agrupar) ? String(q.agrupar) : (base.agrupar || 'item');
  if (!['item', 'produto'].includes(agrupar)) throw erroParametro('agrupar deve ser item ou produto');

  let ordem = presente(q.ordem) ? String(q.ordem) : null;
  if (ordem && !ORDENS.includes(ordem)) throw erroParametro(`ordem inválida. Use: ${ORDENS.join(', ')}`);
  if (ordem && !podeVerCusto && ORDENS_DE_CUSTO.includes(ordem)) throw semCusto(`ordem ${ordem}`);
  if (!ordem) ordem = (!podeVerCusto && base.ordem_sem_custo) || base.ordem || 'nome';
  const direcao = presente(q.direcao) ? String(q.direcao).toLowerCase() : (base.direcao || (ordem === 'nome' ? 'asc' : 'desc'));
  if (!['asc', 'desc'].includes(direcao)) throw erroParametro('direcao deve ser asc ou desc');

  const escolha = (nome, lido) => (lido !== undefined ? lido : base[nome]);
  const filtros = {
    categoria: lerTexto(q.categoria),
    marca: lerTexto(q.marca),
    busca: lerTexto(q.busca),
    so_ativos: escolha('so_ativos', lerBool(q.so_ativos, 'so_ativos')),
    estoque_min: lerNumero(q.estoque_min, 'estoque_min'),
    estoque_max: lerNumero(q.estoque_max, 'estoque_max'),
    com_estoque: escolha('com_estoque', lerBool(q.com_estoque, 'com_estoque')),
    vendeu: escolha('vendeu', lerBool(q.vendeu, 'vendeu')),
    sem_custo: escolha('sem_custo', lerBool(q.sem_custo, 'sem_custo')),
    margem_max: escolha('margem_max', lerNumero(q.margem_max, 'margem_max', { min: -1000, max: 100 })),
    sem_vender_dias: escolha('sem_vender_dias', lerNumero(q.sem_vender_dias, 'sem_vender_dias', { min: 1, max: HISTORICO_DIAS, inteiro: true })),
    acaba_em_dias: escolha('acaba_em_dias', lerNumero(q.acaba_em_dias, 'acaba_em_dias', { min: 0, max: 365, inteiro: true })),
  };
  if (filtros.so_ativos === undefined) filtros.so_ativos = true;
  if (!podeVerCusto) {
    if (presente(q.sem_custo)) throw semCusto('filtro sem_custo');
    if (presente(q.margem_max)) throw semCusto('filtro margem_max');
  }
  for (const k of Object.keys(filtros)) if (filtros[k] === undefined) filtros[k] = null;

  const todas = lerBool(q.todas, 'todas') === true;
  const limit = todas ? TETO_EXPORTACAO : (lerNumero(q.limit, 'limit', { min: 1, max: LIMIT_MAX, inteiro: true }) || LIMIT_PADRAO);
  const offset = todas ? 0 : (lerNumero(q.offset, 'offset', { min: 0, inteiro: true }) || 0);

  return { modelo, periodo, agrupar, ordem, direcao, filtros, todas, limit, offset, podeVerCusto };
}

// ── consultas ───────────────────────────────────────────────────
const GRUPO = (a) => `COALESCE(NULLIF(${a}.billing_owner_company_id, ${a}.id), ${a}.id)`;
// Todas as empresas dos grupos das lojas do escopo ($1).
const EMPRESAS_DO_GRUPO = `(
    SELECT g.id FROM companies g
     WHERE ${GRUPO('g')} IN (SELECT ${GRUPO('r')} FROM companies r WHERE r.id = ANY($1::uuid[]))
  )`;
const CUSTO_DO_PRODUTO = 'COALESCE(NULLIF(p.weighted_avg_cost, 0), NULLIF(p.cost_price, 0))';

// $1 lojas do escopo, $2 categoria (uuid, com a subárvore), $3 categoria
// por texto (products.category, legado), $4 marca, $5 busca (ILIKE), $6 só ativos.
const SQL_CATALOGO = `
  SELECT p.id AS product_id,
         pv.id AS variant_id,
         p.company_id,
         ${GRUPO('c')} AS grupo_id,
         COALESCE(c.trade_name, c.legal_name) AS loja,
         p.is_group_shared,
         p.is_active,
         p.name AS nome,
         COALESCE(
           (SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
              FROM product_variant_values pvv WHERE pvv.variant_id = pv.id),
           NULLIF(pv.sku_suffix, '')
         ) AS variante,
         NULLIF(p.sku, '') AS sku,
         NULLIF(pv.sku_suffix, '') AS sku_suffix,
         NULLIF(p.barcode, '') AS barcode_produto,
         COALESCE(NULLIF(pv.barcode, ''), NULLIF(p.barcode, '')) AS barcode,
         p.unit AS unidade,
         p.price AS preco_produto,
         COALESCE(pv.price_override, p.price) AS preco,
         CASE WHEN pv.id IS NULL THEN p.stock_qty ELSE pv.stock_qty END AS estoque,
         ${CUSTO_DO_PRODUTO} AS custo,
         NULLIF(btrim(p.brand), '') AS marca,
         cat.id AS categoria_id,
         COALESCE(cat.name, NULLIF(btrim(p.category), '')) AS categoria,
         to_char((p.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS cadastrado_em
    FROM products p
    JOIN companies c ON c.id = p.company_id
    LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.is_active = true
    LEFT JOIN LATERAL (
      SELECT pc.id, pc.name
        FROM product_category_links l
        JOIN product_categories pc ON pc.id = l.category_id
       WHERE l.product_id = p.id AND l.is_primary = true
       LIMIT 1
    ) cat ON true
   WHERE (p.company_id = ANY($1::uuid[])
          OR (p.is_group_shared = true AND p.company_id IN ${EMPRESAS_DO_GRUPO}))
     AND p.duration_minutes IS NULL
     AND lower(COALESCE(p.unit, '')) <> 'srv'
     AND ($6::boolean IS NOT TRUE OR p.is_active = true)
     AND ($2::uuid IS NULL OR EXISTS (
           SELECT 1
             FROM product_category_links l
             JOIN product_categories d ON d.id = l.category_id
             JOIN product_categories raiz ON raiz.id = $2::uuid
            WHERE l.product_id = p.id
              AND d.company_id = raiz.company_id
              AND (d.id = raiz.id
                   OR (raiz.path IS NOT NULL AND left(d.path, length(raiz.path) + 1) = raiz.path || '/'))))
     AND ($3::text IS NULL OR btrim(p.category) = $3::text)
     AND ($4::text IS NULL OR lower(btrim(p.brand)) = lower($4::text))
     AND ($5::text IS NULL OR p.name ILIKE $5 OR p.sku ILIKE $5 OR p.barcode ILIKE $5
          OR EXISTS (SELECT 1 FROM product_variants x
                      WHERE x.product_id = p.id AND (x.barcode ILIKE $5 OR x.sku_suffix ILIKE $5)))`;

// $1 lojas do escopo, $2 de, $3 até (inclusivo), $4 início da leitura
// (o mais antigo entre `de` e hoje − 365), $5 hoje.
// Lê as vendas do grupo (o compartilhado esvazia com a venda de qualquer
// loja), mas só as linhas do escopo ou de produto compartilhado.
const SQL_VENDAS = `
  WITH v AS (
    SELECT s.id, s.company_id, s.total_amount::numeric AS total, s.created_at,
           (s.created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}')
            AND s.created_at < (($3::date + 1)::timestamp AT TIME ZONE '${TZ}')) AS no_periodo
      FROM sales s
     WHERE s.company_id IN ${EMPRESAS_DO_GRUPO}
       AND COALESCE(s.type, 'sale') = 'sale'
       AND COALESCE(s.status, 'completed') <> 'cancelled'
       AND s.created_at >= ($4::date::timestamp AT TIME ZONE '${TZ}')
       AND s.created_at <  (($5::date + 1)::timestamp AT TIME ZONE '${TZ}')
  ),
  linha AS (
    SELECT v.id AS sale_id, v.company_id, v.total, v.created_at, v.no_periodo,
           si.product_id, si.variant_id, si.quantity::numeric AS qtd,
           NULLIF(si.unit_cost::numeric, 0) AS custo_unit,
           COALESCE(si.total_price::numeric,
                    si.unit_price::numeric * si.quantity::numeric - COALESCE(si.discount::numeric, 0)) AS bruto
      FROM v JOIN sale_items si ON si.sale_id = v.id
  ),
  soma AS (
    SELECT sale_id, SUM(bruto) AS bruto_venda FROM linha GROUP BY sale_id
  ),
  item AS (
    SELECT l.*, (l.company_id = ANY($1::uuid[])) AS do_escopo,
           CASE WHEN s.bruto_venda > 0 THEN l.bruto * l.total / s.bruto_venda ELSE 0 END AS receita
      FROM linha l JOIN soma s ON s.sale_id = l.sale_id
     WHERE l.product_id IS NOT NULL
  )
  SELECT i.product_id, i.variant_id,
         COALESCE(SUM(i.qtd) FILTER (WHERE i.no_periodo AND i.do_escopo), 0) AS vendidos,
         COALESCE(SUM(i.receita) FILTER (WHERE i.no_periodo AND i.do_escopo), 0) AS faturamento,
         COALESCE(SUM(i.qtd * COALESCE(i.custo_unit, ${CUSTO_DO_PRODUTO}))
                    FILTER (WHERE i.no_periodo AND i.do_escopo), 0) AS cmv,
         COALESCE(SUM(i.qtd) FILTER (WHERE i.no_periodo), 0) AS saida,
         to_char((MAX(i.created_at) AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS ultima_venda
    FROM item i
    LEFT JOIN products p ON p.id = i.product_id
   WHERE i.do_escopo OR p.is_group_shared = true
   GROUP BY i.product_id, i.variant_id`;

// Dias do período com venda, por loja do grupo (para o ritmo).
const SQL_DIAS = `
  SELECT s.company_id,
         ${GRUPO('c')} AS grupo_id,
         to_char((s.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia
    FROM sales s
    JOIN companies c ON c.id = s.company_id
   WHERE s.company_id IN ${EMPRESAS_DO_GRUPO}
     AND COALESCE(s.type, 'sale') = 'sale'
     AND COALESCE(s.status, 'completed') <> 'cancelled'
     AND s.created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}')
     AND s.created_at <  (($3::date + 1)::timestamp AT TIME ZONE '${TZ}')
   GROUP BY 1, 2, 3`;

function paramsDoCatalogo(empresas, filtros) {
  const cat = filtros.categoria;
  const busca = filtros.busca ? `%${filtros.busca.replace(/[\\%_]/g, (m) => '\\' + m)}%` : null;
  return [
    empresas,
    cat && UUID.test(cat) ? cat : null,
    cat && !UUID.test(cat) ? cat : null,
    filtros.marca,
    busca,
    filtros.so_ativos === true,
  ];
}

// ── montagem (pura) ─────────────────────────────────────────────
function nomeExibicao(nome, variante) {
  return variante ? `${nome} · ${variante}` : nome;
}
function juntarSku(sku, sufixo) {
  const s = [sku, sufixo].filter(Boolean).join('-');
  return s || null;
}
const maisRecente = (a, b) => (!a ? b || null : !b ? a : (a > b ? a : b));

/**
 * Junta catálogo, vendas e dias abertos nas linhas do relatório (antes de
 * filtrar e ordenar). Pura: os testes chamam direto.
 *
 * @param {object[]} catalogo  linhas de SQL_CATALOGO
 * @param {object[]} vendas    linhas de SQL_VENDAS
 * @param {object[]} dias      linhas de SQL_DIAS
 * @param {{ agrupar: string, hoje: string }} opts
 */
function montarLinhas(catalogo, vendas, dias, { agrupar, hoje }) {
  // Dias abertos por loja e por grupo (a regra da ruptura).
  const porLoja = new Map();
  const porGrupo = new Map();
  const juntar = (mapa, chave, dia) => {
    if (!mapa.has(chave)) mapa.set(chave, new Set());
    mapa.get(chave).add(dia);
  };
  for (const d of dias || []) {
    juntar(porLoja, d.company_id, d.dia);
    juntar(porGrupo, d.grupo_id, d.dia);
  }
  const memo = new Map();
  const abertosDe = (l) => {
    const chave = l.is_group_shared ? `g:${l.grupo_id}` : `l:${l.company_id}`;
    if (!memo.has(chave)) {
      const conjunto = l.is_group_shared ? porGrupo.get(l.grupo_id) : porLoja.get(l.company_id);
      const abertos = conjunto ? Array.from(conjunto).sort() : [];
      memo.set(chave, { abertos, futuros: diasDeVendaFuturos(abertos, hoje) });
    }
    return memo.get(chave);
  };

  const vazia = () => ({ vendidos: 0, faturamento: 0, cmv: 0, saida: 0, ultima_venda: null });
  const somarVenda = (alvo, v) => {
    alvo.vendidos += num(v.vendidos);
    alvo.faturamento += num(v.faturamento);
    alvo.cmv += num(v.cmv);
    alvo.saida += num(v.saida);
    alvo.ultima_venda = maisRecente(alvo.ultima_venda, v.ultima_venda || null);
  };

  // Itens do catálogo.
  const itens = new Map(); // chave → item
  const produtos = new Map(); // product_id → { base, itens: [], orfa }
  for (const l of catalogo || []) {
    const chave = l.variant_id ? `v:${l.variant_id}` : `p:${l.product_id}`;
    if (itens.has(chave)) continue;
    const item = { l, venda: vazia() };
    itens.set(chave, item);
    if (!produtos.has(l.product_id)) produtos.set(l.product_id, { l, itens: [], orfa: vazia() });
    produtos.get(l.product_id).itens.push(item);
  }
  // Vendas: no item, ou órfã do produto.
  for (const v of vendas || []) {
    const prod = produtos.get(v.product_id);
    if (!prod) continue; // produto fora do catálogo filtrado
    const item = v.variant_id ? itens.get(`v:${v.variant_id}`) : itens.get(`p:${v.product_id}`);
    if (item && item.l.product_id === v.product_id) somarVenda(item.venda, v);
    else somarVenda(prod.orfa, v);
  }

  const diasSemVender = (ultima) => (ultima ? Math.max(0, diasEntre(ultima, hoje)) : null);
  const previsao = (l, estoque, saida) => {
    const { abertos, futuros } = abertosDe(l);
    const p = projetar({ estoque, unidades: saida, diasAbertos: abertos, futuros, hoje, ate: hoje });
    return {
      media_diaria: p ? p.ritmo_diario : 0,
      // Zerado ou negativo já acabou, com ou sem venda no período.
      dias_ate_acabar: estoque <= 0 ? 0 : (p ? p.dias_ate_acabar : null),
    };
  };
  const dinheiro = (custo, venda, estoque, preco) => {
    const temCusto = custo !== null && custo > 0;
    const faturamento = round2(venda.faturamento);
    const lucro = temCusto ? round2(venda.faturamento - venda.cmv) : null;
    return {
      custo: temCusto ? round2(custo) : null,
      tem_custo: temCusto,
      vendidos: round3(venda.vendidos),
      faturamento,
      lucro,
      margem: temCusto && venda.faturamento > 0 ? round1(((venda.faturamento - venda.cmv) / venda.faturamento) * 100) : null,
      valor_parado: temCusto ? round2(Math.max(0, estoque) * custo) : null,
      valor_estoque_venda: round2(Math.max(0, estoque) * preco),
      _faturamento_bruto: venda.faturamento,
      _lucro_bruto: temCusto ? venda.faturamento - venda.cmv : 0,
    };
  };
  const comum = (l) => ({
    product_id: l.product_id,
    nome: l.nome || '',
    categoria_id: l.categoria_id || null,
    categoria: l.categoria || null,
    marca: l.marca || null,
    unidade: l.unidade || 'un',
    loja: { company_id: l.company_id, nome: l.loja || '' },
    compartilhado: l.is_group_shared === true,
    ativo: l.is_active !== false,
    _cadastrado_em: l.cadastrado_em || null,
  });

  const linhaDoItem = (item) => {
    const { l, venda } = item;
    const estoque = round3(l.estoque);
    const preco = round2(l.preco);
    const custo = numOuNull(l.custo);
    return {
      chave: l.variant_id ? `v:${l.variant_id}` : `p:${l.product_id}`,
      ...comum(l),
      variant_id: l.variant_id || null,
      variante: l.variante || null,
      nome_exibicao: nomeExibicao(l.nome || '', l.variante || null),
      sku: juntarSku(l.sku, l.sku_suffix),
      codigo_barras: l.barcode || null,
      estoque,
      preco,
      ...dinheiro(custo, venda, estoque, preco),
      ultima_venda: venda.ultima_venda,
      dias_sem_vender: diasSemVender(venda.ultima_venda),
      ...previsao(l, estoque, venda.saida),
    };
  };

  if (agrupar !== 'produto') return Array.from(itens.values()).map(linhaDoItem);

  const linhas = [];
  for (const prod of produtos.values()) {
    const filhas = prod.itens.map(linhaDoItem);
    const { l } = prod;
    const total = vazia();
    for (const it of prod.itens) somarVenda(total, it.venda);
    somarVenda(total, prod.orfa);
    const estoque = round3(filhas.reduce((s, f) => s + f.estoque, 0));
    const custo = numOuNull(l.custo);
    const din = dinheiro(custo, total, estoque, round2(l.preco_produto));
    // O valor do estoque a preço de venda soma o preço de cada variante.
    din.valor_estoque_venda = round2(filhas.reduce((s, f) => s + f.valor_estoque_venda, 0));
    din.valor_parado = din.tem_custo ? round2(filhas.reduce((s, f) => s + f.valor_parado, 0)) : null;
    const comGrade = filhas.filter((f) => f.variant_id);
    let primeiro = null;
    for (const f of comGrade) {
      if (f.dias_ate_acabar === null) continue;
      if (!primeiro || f.dias_ate_acabar < primeiro.dias_ate_acabar
          || (f.dias_ate_acabar === primeiro.dias_ate_acabar && f.media_diaria > primeiro.media_diaria)) primeiro = f;
    }
    const prev = previsao(l, estoque, total.saida);
    linhas.push({
      chave: `p:${l.product_id}`,
      ...comum(l),
      variant_id: null,
      variante: null,
      nome_exibicao: l.nome || '',
      sku: l.sku || null,
      codigo_barras: l.barcode_produto || null,
      variantes: comGrade.length,
      estoque,
      preco: round2(l.preco_produto),
      ...din,
      ultima_venda: total.ultima_venda,
      dias_sem_vender: diasSemVender(total.ultima_venda),
      media_diaria: prev.media_diaria,
      dias_ate_acabar: comGrade.length
        ? filhas.reduce((min, f) => (f.dias_ate_acabar === null ? min : (min === null ? f.dias_ate_acabar : Math.min(min, f.dias_ate_acabar))), null)
        : filhas[0].dias_ate_acabar,
      primeiro_a_acabar: primeiro
        ? { variant_id: primeiro.variant_id, rotulo: primeiro.variante, dias: primeiro.dias_ate_acabar }
        : null,
    });
  }
  return linhas;
}

function passaFiltros(linha, f, hoje) {
  if (f.estoque_min !== null && linha.estoque < f.estoque_min) return false;
  if (f.estoque_max !== null && linha.estoque > f.estoque_max) return false;
  if (f.com_estoque === true && !(linha.estoque > 0)) return false;
  if (f.com_estoque === false && linha.estoque > 0) return false;
  if (f.vendeu === true && !(linha.vendidos > 0)) return false;
  if (f.vendeu === false && linha.vendidos > 0) return false;
  if (f.sem_custo === true && linha.tem_custo) return false;
  if (f.sem_custo === false && !linha.tem_custo) return false;
  if (f.margem_max !== null && !(linha.margem !== null && linha.margem <= f.margem_max)) return false;
  if (f.sem_vender_dias !== null) {
    if (linha.dias_sem_vender !== null) {
      if (linha.dias_sem_vender < f.sem_vender_dias) return false;
    } else if (linha._cadastrado_em && diasEntre(linha._cadastrado_em, hoje) < f.sem_vender_dias) {
      // nunca vendeu, mas foi cadastrado há menos dias do que o pedido
      return false;
    }
  }
  if (f.acaba_em_dias !== null && !(linha.dias_ate_acabar !== null && linha.dias_ate_acabar <= f.acaba_em_dias)) return false;
  return true;
}

function ordenar(linhas, ordem, direcao) {
  const sinal = direcao === 'asc' ? 1 : -1;
  // dias_sem_vender null = não vendeu em 1 ano (ou nunca): é o mais parado.
  const valor = (l) => (ordem === 'dias_sem_vender' && l.dias_sem_vender === null ? Infinity : l[ordem]);
  return linhas.sort((a, b) => {
    const va = valor(a);
    const vb = valor(b);
    const nulaA = va === null || va === undefined;
    const nulaB = vb === null || vb === undefined;
    if (nulaA !== nulaB) return nulaA ? 1 : -1; // nulos sempre no fim
    if (!nulaA && va !== vb) {
      if (typeof va === 'string' || typeof vb === 'string') return sinal * String(va).localeCompare(String(vb), 'pt-BR');
      return sinal * (va < vb ? -1 : 1);
    }
    return a.nome.localeCompare(b.nome, 'pt-BR')
      || String(a.variante || '').localeCompare(String(b.variante || ''), 'pt-BR')
      || a.chave.localeCompare(b.chave);
  });
}

function totalizar(linhas, podeVerCusto) {
  const t = {
    itens: linhas.length, estoque: 0, valor_estoque_custo: 0, valor_estoque_venda: 0,
    vendidos: 0, faturamento: 0, lucro: 0, margem: null,
  };
  let fatComCusto = 0;
  let fatSemCusto = 0;
  let comCusto = 0;
  for (const l of linhas) {
    t.estoque += l.estoque;
    t.valor_estoque_venda += l.valor_estoque_venda;
    t.vendidos += l.vendidos;
    t.faturamento += l._faturamento_bruto;
    if (l.tem_custo) {
      comCusto += 1;
      t.valor_estoque_custo += l.valor_parado;
      t.lucro += l._lucro_bruto;
      fatComCusto += l._faturamento_bruto;
    } else {
      fatSemCusto += l._faturamento_bruto;
    }
  }
  const totais = {
    itens: t.itens,
    estoque: round3(t.estoque),
    valor_estoque_custo: podeVerCusto ? round2(t.valor_estoque_custo) : null,
    valor_estoque_venda: round2(t.valor_estoque_venda),
    vendidos: round3(t.vendidos),
    faturamento: round2(t.faturamento),
    lucro: podeVerCusto ? round2(t.lucro) : null,
    margem: podeVerCusto && fatComCusto > 0 ? round1((t.lucro / fatComCusto) * 100) : null,
  };
  const cobertura = podeVerCusto
    ? {
      com_custo: comCusto,
      sem_custo: linhas.length - comCusto,
      percentual: linhas.length ? round1((comCusto / linhas.length) * 100) : null,
      faturamento_sem_custo: round2(fatSemCusto),
    }
    : null;
  return { totais, cobertura };
}

const CAMPOS_DE_CUSTO_DA_LINHA = ['custo', 'tem_custo', 'lucro', 'margem', 'valor_parado'];

function paraResposta(linha, podeVerCusto) {
  const out = {};
  for (const [k, v] of Object.entries(linha)) {
    if (k.startsWith('_')) continue;
    out[k] = !podeVerCusto && CAMPOS_DE_CUSTO_DA_LINHA.includes(k) ? null : v;
  }
  return out;
}

/**
 * Filtra, ordena, totaliza e pagina. Pura.
 */
function montarRelatorio(catalogo, vendas, dias, p) {
  const hoje = p.periodo.hoje;
  const todas = montarLinhas(catalogo, vendas, dias, { agrupar: p.agrupar, hoje });
  const filtradas = ordenar(todas.filter((l) => passaFiltros(l, p.filtros, hoje)), p.ordem, p.direcao);
  const { totais, cobertura } = totalizar(filtradas, p.podeVerCusto);
  const pagina = filtradas.slice(p.offset, p.offset + p.limit);
  return {
    linhas: pagina.map((l) => paraResposta(l, p.podeVerCusto)),
    total_linhas: filtradas.length,
    truncado: p.todas && filtradas.length > TETO_EXPORTACAO,
    totais,
    cobertura_custo: cobertura,
  };
}

/**
 * O relatório de Produtos de uma loja — ou do grupo, quando `companyIds`
 * traz mais de uma loja.
 *
 * @param {object} p
 * @param {string} p.companyId       loja de :id
 * @param {string[]} [p.companyIds]  lojas do consolidado (inclui a de :id)
 * @param {object} p.parametros      saída de normalizarParametros
 */
async function relatorioProdutos({ companyId, companyIds, parametros, db = pool }) {
  const empresas = Array.from(new Set([companyId, ...(companyIds || [])]));
  const { periodo } = parametros;
  const inicioDaLeitura = [periodo.de, somaDias(periodo.hoje, -HISTORICO_DIAS)].sort()[0];
  const [catalogo, vendas, dias] = await Promise.all([
    db.query(SQL_CATALOGO, paramsDoCatalogo(empresas, parametros.filtros)),
    db.query(SQL_VENDAS, [empresas, periodo.de, periodo.ate, inicioDaLeitura, periodo.hoje]),
    db.query(SQL_DIAS, [empresas, periodo.de, periodo.ate]),
  ]).then((rs) => rs.map((r) => (r && r.rows) || []));

  const relatorio = montarRelatorio(catalogo, vendas, dias, parametros);
  return {
    ...relatorio,
    periodo: { de: periodo.de, ate: periodo.ate, dias: periodo.dias, hoje: periodo.hoje },
    modelo: parametros.modelo,
    agrupar: parametros.agrupar,
    escopo: empresas.length > 1 ? 'grupo' : 'loja',
    empresas,
    ordem: parametros.ordem,
    direcao: parametros.direcao,
    filtros: parametros.filtros,
    paginacao: { limit: parametros.limit, offset: parametros.offset, todas: parametros.todas },
    pode_ver_custo: parametros.podeVerCusto,
  };
}

module.exports = {
  relatorioProdutos,
  normalizarParametros,
  montarLinhas,
  montarRelatorio,
  MODELOS,
  MODELOS_COM_CUSTO,
  ORDENS,
  LIMIT_PADRAO,
  LIMIT_MAX,
  TETO_EXPORTACAO,
  HISTORICO_DIAS,
  // exportadas para os testes conferirem a forma das consultas
  SQL_CATALOGO,
  SQL_VENDAS,
  SQL_DIAS,
};
