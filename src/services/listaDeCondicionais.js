// ============================================================
// AURA. — Aba Condicionais: lista, filtros e totalizador (C2, 25/11/2026)
//
// As condicionais de uma loja ou de varias (consolidado multi-CNPJ,
// GET /me/condicionais). So le: nada aqui grava.
//
// Filtros (chips do mockup aprovado em 25/11; decisao da Nina de 25/11):
//   em_aberto    todas as abertas (o padrao da aba): com a cliente, vence
//                hoje, atrasadas e a_cobrar
//   com_cliente  "Com a cliente"  abertas com peca ainda com a cliente
//   vence_hoje   "Vence hoje"     abertas, peca com a cliente, due_date = hoje
//   atrasadas    "Atrasadas"      abertas, peca com a cliente, hoje > due_date
//   a_cobrar     ("Falta cobrar", rotulo do app) abertas sem peca com a
//                cliente, mas com peca que "ficou" sem venda. Nao e atrasada.
//   concluidas   "Concluídas"     encerradas (com ou sem venda)
//   canceladas                    canceladas
//   todas                         sem filtro
// "Hoje" e o dia em Sao Paulo (R11). A situacao de cada linha sai de
// condicional.derivarSituacao, a mesma do detalhe.
//
// Ordem (R11): atrasadas primeiro; depois as a_cobrar; depois as outras
// abertas pelo prazo mais perto; depois as fechadas, a mais recente primeiro.
//
// Totalizador "com clientes agora" (sempre das ABERTAS, qualquer que seja o
// filtro, para o cartao nao mudar quando a lojista troca o chip):
// "R$ X em N peças com M clientes" = soma do preco da retirada das pecas
// AINDA COM A CLIENTE (situacao com_cliente; a peca que "ficou" sem venda nao
// entra, decisao da Nina de 25/11), quantas sao, e quantas clientes
// diferentes (cadastro, ou telefone). No consolidado a cliente que tem
// condicional em duas lojas conta uma vez (GROUPING SETS). O que falta
// cobrar sai a parte, em valor_a_cobrar. O estoque (C3, comClientes.js)
// continua contando a "ficou" sem venda: a peca saiu da loja.
//
// A consulta mora aqui, fora da rota, para o teste travar SQL e parametros
// sem subir Express.
// ============================================================
'use strict';

const { escaparLike } = require('./filaDePedidos');
const { PECA_FORA } = require('./comClientes');
const { derivarSituacao, numeroExibicao } = require('./condicional');

const FILTROS = ['em_aberto', 'com_cliente', 'vence_hoje', 'atrasadas', 'a_cobrar', 'concluidas', 'canceladas', 'todas'];
const FILTRO_PADRAO = 'em_aberto';

/** 'em_aberto' quando nao veio nada ou veio algo fora da lista. */
function lerFiltro(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'todos' || s === 'all') return 'todas';
  if (s === 'atrasada') return 'atrasadas';
  if (s === 'concluida' || s === 'encerradas') return 'concluidas';
  if (s === 'cancelada') return 'canceladas';
  if (s === 'abertas') return 'em_aberto';
  return FILTROS.includes(s) ? s : FILTRO_PADRAO;
}

// $2 e sempre o "hoje" de SP. r.* vem do LATERAL das pecas.
const ABERTA = `c.status = 'aberta'`;
const ATRASADA = `(${ABERTA} AND r.com_cliente > 0 AND c.due_date < $2::date)`;
const VENCE_HOJE = `(${ABERTA} AND r.com_cliente > 0 AND c.due_date = $2::date)`;
const COM_CLIENTE = `(${ABERTA} AND r.com_cliente > 0)`;
const A_COBRAR = `(${ABERTA} AND r.com_cliente = 0)`;

const WHERE_DO_FILTRO = {
  em_aberto: ABERTA,
  com_cliente: COM_CLIENTE,
  vence_hoje: VENCE_HOJE,
  atrasadas: ATRASADA,
  a_cobrar: A_COBRAR,
  concluidas: `c.status = 'encerrada'`,
  canceladas: `c.status = 'cancelada'`,
  todas: null,
};

const PECAS_LATERAL = `
  CROSS JOIN LATERAL (
    SELECT COUNT(*)::int                                                     AS pecas,
           COUNT(*) FILTER (WHERE i.situacao = 'com_cliente' AND i.sale_id IS NULL)::int AS com_cliente,
           COUNT(*) FILTER (WHERE i.situacao = 'ficou')::int                 AS ficou,
           COUNT(*) FILTER (WHERE i.situacao = 'ficou' AND i.sale_id IS NULL)::int AS a_cobrar,
           COUNT(*) FILTER (WHERE i.situacao = 'voltou')::int                AS voltou,
           COUNT(*) FILTER (WHERE i.situacao = 'voltou_defeito')::int        AS voltou_defeito,
           COUNT(*) FILTER (WHERE ${PECA_FORA})::int                         AS fora,
           COALESCE(SUM(i.unit_price), 0)                                    AS valor_total,
           COALESCE(SUM(i.unit_price) FILTER (WHERE ${PECA_FORA}), 0)        AS valor_fora,
           COALESCE(SUM(i.unit_price) FILTER (WHERE i.situacao = 'com_cliente' AND i.sale_id IS NULL), 0) AS valor_com_cliente,
           COALESCE(SUM(i.unit_price) FILTER (WHERE i.situacao = 'ficou' AND i.sale_id IS NULL), 0) AS valor_a_cobrar,
           (array_agg(i.product_name ORDER BY i.added_at, i.id))[1]          AS primeira_peca
      FROM condicional_itens i
     WHERE i.condicional_id = c.id
  ) r`;

// Ordem das linhas (R11), usada na janela que numera a pagina.
const ORDEM_DA_LISTA = `${ATRASADA} DESC,
              ${A_COBRAR} DESC,
              (${ABERTA}) DESC,
              CASE WHEN ${ABERTA} THEN c.due_date END ASC NULLS LAST,
              COALESCE(c.closed_at, c.cancelled_at, c.created_at) DESC,
              c.numero DESC`;

// C18: so das linhas da PAGINA (a consulta de dentro ja cortou no LIMIT).
// Primeiras pecas: nas abertas, com a cliente, depois as que ficaram, depois
// as que voltaram; dentro do grupo, ordem de retirada. Nas fechadas, so a
// ordem de retirada. Usa idx_condicional_itens_condicional.
const PRIMEIRAS_PECAS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(json_build_object('nome', t.nome, 'cor', t.cor, 'tamanho', t.tamanho)
                             ORDER BY t.grupo, t.added_at, t.id), '[]'::json) AS primeiras_pecas
      FROM (
        SELECT i.id, i.added_at, i.product_name AS nome, i.color_name AS cor, i.size_label AS tamanho,
               CASE WHEN pg.status <> 'aberta' THEN 0
                    WHEN i.situacao = 'com_cliente' AND i.sale_id IS NULL THEN 0
                    WHEN i.situacao = 'ficou' OR i.situacao = 'com_cliente' THEN 1
                    ELSE 2 END AS grupo
          FROM condicional_itens i
         WHERE i.condicional_id = pg.id
         ORDER BY grupo, i.added_at, i.id
         LIMIT 2
      ) t
  ) pp ON TRUE`;

// Vendas da condicional encerrada: valor somado (nao canceladas) e numero da
// ultima. Usa o indice parcial idx_sales_condicional_id.
const VENDAS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS vendas,
           COALESCE(SUM(s.total_amount), 0) AS venda_valor,
           (array_agg(s.sale_number ORDER BY s.created_at DESC, s.id DESC))[1] AS venda_numero
      FROM sales s
     WHERE pg.status = 'encerrada'
       AND s.condicional_id = pg.id
       AND s.status != 'cancelled'
  ) v ON TRUE`;

/**
 * @param {{empresas: string[], filtro?: string, q?: string, limit: number, offset: number, hoje: string}} p
 * @returns {{sql: string, params: any[]}}
 */
function montarConsultaDaLista({ empresas, filtro, q, limit, offset, hoje }) {
  const params = [empresas, hoje];
  const filtros = [`c.company_id = ANY($1::uuid[])`];
  const f = WHERE_DO_FILTRO[lerFiltro(filtro)];
  if (f) filtros.push(f);

  const busca = String(q || '').trim().slice(0, 80);
  if (busca) {
    const digitos = busca.replace(/[^0-9]/g, '');
    // "31", "C-0031", "c31", "#31" ou telefone.
    const soNumero = digitos.length > 0 && /^\s*(c\s*-?\s*)?#?[\s0-9().+-]*$/i.test(busca);
    if (soNumero) {
      params.push(digitos);
      const n = params.length;
      filtros.push(
        `(c.numero::text = ltrim($${n}, '0')` +
        ` OR (length($${n}) >= 4 AND regexp_replace(COALESCE(c.customer_phone, ''), '[^0-9]', '', 'g') LIKE '%' || $${n} || '%'))`
      );
    } else {
      params.push('%' + escaparLike(busca) + '%');
      const n = params.length;
      filtros.push(
        `(c.customer_name ILIKE $${n} ESCAPE '!'` +
        ` OR EXISTS (SELECT 1 FROM condicional_itens bi WHERE bi.condicional_id = c.id AND bi.product_name ILIKE $${n} ESCAPE '!'))`
      );
    }
  }

  params.push(limit, offset);
  const sql = `
    WITH pagina AS (
      SELECT c.id, c.company_id, COALESCE(co.trade_name, co.legal_name) AS company_name,
             c.numero, c.status, c.customer_id, c.customer_name, c.customer_phone, c.seller_name,
             c.due_date::text AS due_date, c.notes, c.created_at, c.closed_at, c.cancelled_at,
             r.pecas, r.com_cliente, r.ficou, r.a_cobrar, r.voltou, r.voltou_defeito, r.fora,
             r.valor_total, r.valor_com_cliente, r.valor_a_cobrar, r.primeira_peca,
             COUNT(*) OVER() AS total_filtrado,
             ROW_NUMBER() OVER (ORDER BY ${ORDEM_DA_LISTA}) AS ord
        FROM condicionais c
        JOIN companies co ON co.id = c.company_id
        ${PECAS_LATERAL}
       WHERE ${filtros.join(' AND ')}
       ORDER BY ${ORDEM_DA_LISTA}
       LIMIT $${params.length - 1} OFFSET $${params.length}
    )
    SELECT pg.*, pp.primeiras_pecas, v.vendas, v.venda_valor, v.venda_numero
      FROM pagina pg
      ${PRIMEIRAS_PECAS_LATERAL}
      ${VENDAS_LATERAL}
     ORDER BY pg.ord`;
  return { sql, params };
}

/**
 * Totalizador e contagem dos chips, por loja e do conjunto (GROUPING SETS:
 * a linha com company_id NULL e o total, com a cliente contada uma vez).
 * Parametros: $1 empresas, $2 hoje.
 */
function montarConsultaDosNumeros({ empresas, hoje }) {
  const sql = `
    SELECT c.company_id,
           COUNT(*) FILTER (WHERE ${ABERTA})::int                                 AS em_aberto,
           COUNT(*) FILTER (WHERE ${COM_CLIENTE})::int                            AS com_cliente,
           COUNT(*) FILTER (WHERE ${VENCE_HOJE})::int                             AS vence_hoje,
           COUNT(*) FILTER (WHERE ${ATRASADA})::int                               AS atrasadas,
           COUNT(*) FILTER (WHERE ${A_COBRAR})::int                               AS a_cobrar,
           COUNT(*) FILTER (WHERE c.status = 'encerrada')::int                    AS concluidas,
           COUNT(*) FILTER (WHERE c.status = 'cancelada')::int                    AS canceladas,
           COUNT(*)::int                                                          AS todas,
           COALESCE(SUM(r.valor_com_cliente) FILTER (WHERE ${ABERTA}), 0)         AS valor,
           COALESCE(SUM(r.com_cliente) FILTER (WHERE ${ABERTA}), 0)::int          AS pecas,
           COALESCE(SUM(r.valor_a_cobrar) FILTER (WHERE ${ABERTA}), 0)            AS valor_a_cobrar,
           COALESCE(SUM(r.a_cobrar) FILTER (WHERE ${ABERTA}), 0)::int             AS pecas_a_cobrar,
           COALESCE(SUM(r.valor_com_cliente) FILTER (WHERE ${VENCE_HOJE}), 0)     AS vence_hoje_valor,
           COALESCE(SUM(r.com_cliente) FILTER (WHERE ${VENCE_HOJE}), 0)::int      AS vence_hoje_pecas,
           COALESCE(SUM(r.valor_com_cliente) FILTER (WHERE ${ATRASADA}), 0)       AS atrasadas_valor,
           COALESCE(SUM(r.com_cliente) FILTER (WHERE ${ATRASADA}), 0)::int        AS atrasadas_pecas,
           COUNT(DISTINCT COALESCE(c.customer_id::text, regexp_replace(c.customer_phone, '[^0-9]', '', 'g')))
             FILTER (WHERE ${ABERTA} AND r.com_cliente > 0)::int                  AS clientes
      FROM condicionais c
      ${PECAS_LATERAL}
     WHERE c.company_id = ANY($1::uuid[])
     GROUP BY GROUPING SETS ((c.company_id), ())`;
  return { sql, params: [empresas, hoje] };
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function reais(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(round2(v)).replace(/ /g, ' ');
}

/** "R$ 1.379,00 em 7 peças com 3 clientes" */
function textoDoTotalizador({ valor, pecas, clientes }) {
  return `${reais(valor)} em ${pecas} ${pecas === 1 ? 'peça' : 'peças'} com ${clientes} ${clientes === 1 ? 'cliente' : 'clientes'}`;
}

function apresentarNumeros(r) {
  const n = r || {};
  const totalizador = {
    valor: round2(Number(n.valor) || 0),
    pecas: Number(n.pecas) || 0,
    clientes: Number(n.clientes) || 0,
  };
  totalizador.texto = textoDoTotalizador(totalizador);
  return {
    totalizador,
    // Pecas que "ficou" sem venda (falta cobrar): fora do totalizador.
    valor_a_cobrar: round2(Number(n.valor_a_cobrar) || 0),
    counts: Object.fromEntries(FILTROS.map((k) => [k, Number(n[k]) || 0])),
  };
}

/**
 * C18: totais do topo, sobre TODAS as condicionais abertas (independem da
 * pagina e do filtro). vence_hoje e atrasadas somam as pecas ainda com a
 * cliente das condicionais naquela situacao; a_cobrar soma as pecas que
 * "ficou" sem venda de toda condicional aberta.
 */
function apresentarTotais(r) {
  const n = r || {};
  const par = (v, p) => ({ valor: round2(Number(n[v]) || 0), pecas: Number(n[p]) || 0 });
  return {
    vence_hoje: par('vence_hoje_valor', 'vence_hoje_pecas'),
    atrasadas: par('atrasadas_valor', 'atrasadas_pecas'),
    a_cobrar: par('valor_a_cobrar', 'pecas_a_cobrar'),
  };
}

function lerPrimeiras(v) {
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { arr = []; } }
  return Array.isArray(arr)
    ? arr.map((p) => ({ nome: p.nome, cor: p.cor || null, tamanho: p.tamanho || null }))
    : [];
}

/** Linha do banco -> item da lista. */
function apresentarLinha(r, hoje) {
  const sit = derivarSituacao({
    status: r.status, due_date: r.due_date, com_cliente: r.com_cliente,
    decididas: (Number(r.pecas) || 0) - (Number(r.com_cliente) || 0),
  }, hoje);
  const pecas = Number(r.pecas) || 0;
  const primeiras = lerPrimeiras(r.primeiras_pecas);
  const temVenda = r.status === 'encerrada' && (Number(r.vendas) || 0) > 0;
  return {
    id: r.id,
    company_id: r.company_id,
    company_name: r.company_name || null,
    numero: Number(r.numero),
    numero_exibicao: numeroExibicao(r.numero),
    status: r.status,
    ...sit,
    customer_id: r.customer_id || null,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    seller_name: r.seller_name || null,
    due_date: r.due_date,
    notes: r.notes || null,
    pecas: Number(r.pecas) || 0,
    pecas_com_cliente: Number(r.com_cliente) || 0,
    pecas_ficou: Number(r.ficou) || 0,
    pecas_a_cobrar: Number(r.a_cobrar) || 0,
    pecas_voltou: (Number(r.voltou) || 0) + (Number(r.voltou_defeito) || 0),
    valor_total: round2(Number(r.valor_total) || 0),
    valor_com_cliente: round2(Number(r.valor_com_cliente) || 0),
    valor_a_cobrar: round2(Number(r.valor_a_cobrar) || 0),
    primeira_peca: r.primeira_peca || null,
    resumo: {
      com_cliente: Number(r.com_cliente) || 0,
      voltaram: (Number(r.voltou) || 0) + (Number(r.voltou_defeito) || 0),
      ficaram: Number(r.ficou) || 0,
      a_cobrar: Number(r.a_cobrar) || 0,
      valor_com_cliente: round2(Number(r.valor_com_cliente) || 0),
      valor_a_cobrar: round2(Number(r.valor_a_cobrar) || 0),
    },
    primeiras_pecas: primeiras,
    outras_pecas: Math.max(0, pecas - primeiras.length),
    venda: temVenda
      ? { numero: r.venda_numero == null ? null : Number(r.venda_numero), valor: round2(Number(r.venda_valor) || 0) }
      : null,
    created_at: r.created_at,
    closed_at: r.closed_at || null,
    cancelled_at: r.cancelled_at || null,
  };
}

/**
 * Lista + numeros, prontos para responder. `q` e o pool.
 * `porEmpresa` = true acrescenta os numeros de cada loja (consolidado).
 */
async function listarCondicionais(q, { empresas, filtro, busca, page = 1, limit = 30, hoje, porEmpresa = false }) {
  const pagina = Math.max(1, parseInt(page, 10) || 1);
  const porPagina = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (pagina - 1) * porPagina;
  const filtroLido = lerFiltro(filtro);
  if (!empresas || !empresas.length) {
    return {
      condicionais: [], filtro: filtroLido, hoje, ...apresentarNumeros(null), totais: apresentarTotais(null),
      pagination: { page: pagina, limit: porPagina, total: 0, pages: 0 },
      ...(porEmpresa ? { por_empresa: [] } : {}),
    };
  }
  const consulta = montarConsultaDaLista({ empresas, filtro, q: busca, limit: porPagina, offset, hoje });
  const numeros = montarConsultaDosNumeros({ empresas, hoje });
  const [{ rows }, { rows: grupos }] = await Promise.all([
    q.query(consulta.sql, consulta.params),
    q.query(numeros.sql, numeros.params),
  ]);
  const total = rows.length ? Number(rows[0].total_filtrado) || 0 : 0;
  const totalGeral = (grupos || []).find((g) => g.company_id === null || g.company_id === undefined);
  const out = {
    condicionais: rows.map((r) => apresentarLinha(r, hoje)),
    filtro: filtroLido,
    hoje,
    ...apresentarNumeros(totalGeral),
    totais: apresentarTotais(totalGeral),
    pagination: { page: pagina, limit: porPagina, total, pages: Math.ceil(total / porPagina) },
  };
  if (porEmpresa) {
    const porId = new Map((grupos || []).filter((g) => g.company_id).map((g) => [String(g.company_id), g]));
    out.por_empresa = empresas.map((id) => ({ company_id: id, ...apresentarNumeros(porId.get(String(id))) }));
  }
  return out;
}

module.exports = {
  FILTROS,
  FILTRO_PADRAO,
  lerFiltro,
  montarConsultaDaLista,
  montarConsultaDosNumeros,
  apresentarLinha,
  apresentarNumeros,
  apresentarTotais,
  textoDoTotalizador,
  listarCondicionais,
};
