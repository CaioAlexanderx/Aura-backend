// ============================================================
// AURA. — Aba Pedidos: lista, filtros e numeros (B3 / p-61c, 17/11/2026)
//
// Os pedidos guardados no Caixa (digital_orders, origem 'balcao'), de uma
// loja ou de varias (consolidado multi-CNPJ, GET /me/pedidos). So le: nada
// aqui grava.
//
// Situacao (palavras do mockup aprovado em 17/11 -> status do pedido):
//   aguardando -> confirmed   (guardado, ninguem separou ainda)
//   separando  -> preparing   ("Separando ou em produção")
//   prontos    -> ready
//   concluidos -> delivered   (virou venda, card B5a)
//   cancelados -> cancelled
//   abertos    -> os tres primeiros (o padrao da aba)
//   todos      -> tudo
// Atrasado = aberto com promised_date antes de hoje em Sao Paulo. Na lista,
// os atrasados vem primeiro; depois a data prometida mais perto; sem data
// por ultimo; empate pelo mais novo.
//
// Sinal: soma dos studio_payments de sinal pagos do pedido (kind 'deposit',
// status 'paid'), que e onde o sinal sera gravado (card B4a). Ate o B4a
// entrar, todo pedido mostra sinal 0 e "falta" = total.
//
// Numeros da aba (sempre dos ABERTOS, qualquer que seja o filtro, para o
// cartao nao mudar quando a lojista troca o chip):
//   abertos, pecas_reservadas, atrasados, sinais_recebidos, falta_receber.
// E a contagem por situacao, para os chips.
//
// A consulta mora aqui, fora da rota, para o teste travar SQL e parametros
// sem subir Express (o Postgres conta parametros pelo maior $n).
// ============================================================
'use strict';

const { escaparLike, nomeLegivelDoItem } = require('./filaDePedidos');

const SITUACOES = {
  aguardando: ['confirmed'],
  separando: ['preparing'],
  prontos: ['ready'],
  concluidos: ['delivered'],
  cancelados: ['cancelled'],
  abertos: ['confirmed', 'preparing', 'ready'],
};
const ABERTOS = SITUACOES.abertos;

/** 'abertos' quando nao veio nada ou veio algo fora da lista; 'todos' = sem filtro. */
function lerSituacao(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'todos' || s === 'all') return 'todos';
  return SITUACOES[s] ? s : 'abertos';
}

const lista = (arr) => `ARRAY['${arr.join("','")}']`;

const SINAL_PAGO = `(SELECT COALESCE(SUM(sp.amount), 0) FROM studio_payments sp
                      WHERE sp.order_id = o.id AND sp.kind = 'deposit' AND sp.status = 'paid')`;

/**
 * @param {{empresas: string[], situacao?: string, atrasados?: boolean, q?: string,
 *          limit: number, offset: number, hoje: string}} p
 * @returns {{sql: string, params: any[]}}
 */
function montarConsultaDaLista({ empresas, situacao, atrasados = false, q, limit, offset, hoje }) {
  const params = [empresas, hoje];
  const filtros = [`o.company_id = ANY($1::uuid[])`, `o.origem = 'balcao'`];
  const sit = lerSituacao(situacao);
  if (sit !== 'todos') filtros.push(`o.status::text = ANY(${lista(SITUACOES[sit])})`);
  if (atrasados) {
    filtros.push(`o.status::text = ANY(${lista(ABERTOS)})`, `o.promised_date < $2::date`);
  }

  const busca = String(q || '').trim().slice(0, 80);
  if (busca) {
    const digitos = busca.replace(/[^0-9]/g, '');
    const soNumero = digitos.length > 0 && /^#?[\s0-9().+-]*$/.test(busca);
    if (soNumero) {
      // Numero do pedido sem o prefixo e sem zeros ("12" acha "LOJ-0012"),
      // ou telefone a partir de 4 digitos.
      params.push(digitos);
      const n = params.length;
      filtros.push(
        `(ltrim(regexp_replace(o.order_number::text, '[^0-9]', '', 'g'), '0') = ltrim($${n}, '0')` +
        ` OR (length($${n}) >= 4 AND regexp_replace(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g') LIKE '%' || $${n} || '%'))`
      );
    } else {
      params.push('%' + escaparLike(busca) + '%');
      const n = params.length;
      filtros.push(
        `(o.customer_name ILIKE $${n} ESCAPE '!'` +
        ` OR o.order_number ILIKE $${n} ESCAPE '!'` +
        ` OR EXISTS (SELECT 1 FROM digital_order_items bi WHERE bi.order_id = o.id AND bi.product_name ILIKE $${n} ESCAPE '!'))`
      );
    }
  }

  params.push(limit, offset);
  // COALESCE: sem data prometida nao e atrasado (NULL iria para o topo no DESC).
  const atrasadoExpr = `(o.status::text = ANY(${lista(ABERTOS)}) AND COALESCE(o.promised_date < $2::date, false))`;
  const sql = `
    SELECT o.id, o.company_id, COALESCE(c.trade_name, c.legal_name) AS company_name,
           o.order_number, o.status::text AS status, o.customer_id, o.customer_name, o.customer_phone,
           o.subtotal, o.discount_amount, o.total, o.promised_date::text AS promised_date,
           o.notes, o.created_by, o.created_at, o.delivered_at, o.cancelled_at, o.sale_id,
           ${atrasadoExpr} AS atrasado,
           CASE WHEN ${atrasadoExpr} THEN ($2::date - o.promised_date) ELSE 0 END AS dias_de_atraso,
           ${SINAL_PAGO} AS sinal_pago,
           (SELECT COUNT(*)::int FROM digital_order_items ic WHERE ic.order_id = o.id) AS item_count,
           (SELECT COALESCE(SUM(ic.quantity), 0)::int FROM digital_order_items ic WHERE ic.order_id = o.id) AS pecas,
           pi.product_name AS first_item_name,
           pi.imagem       AS first_item_image,
           COUNT(*) OVER() AS total_filtrado
      FROM digital_orders o
      JOIN companies c ON c.id = o.company_id
      LEFT JOIN LATERAL (
        SELECT i1.product_name,
               COALESCE(p.image_thumb_url, i1.product_image, p.image_url) AS imagem
          FROM digital_order_items i1
          LEFT JOIN products p ON p.id = i1.product_id
         WHERE i1.order_id = o.id
         ORDER BY i1.id
         LIMIT 1
      ) pi ON true
     WHERE ${filtros.join(' AND ')}
     ORDER BY ${atrasadoExpr} DESC, o.promised_date ASC NULLS LAST, o.created_at DESC, o.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`;
  return { sql, params };
}

/**
 * Numeros da aba por loja: os dos abertos e a contagem por situacao.
 * Parametros: $1 empresas (uuid[]), $2 hoje. Uma linha por loja com pedido;
 * a soma (consolidado) e feita em somarNumeros.
 */
function montarConsultaDosNumeros({ empresas, hoje }) {
  const aberto = `o.status::text = ANY(${lista(ABERTOS)})`;
  const sql = `
    SELECT
      o.company_id,
      COUNT(*) FILTER (WHERE ${aberto})::int                                   AS abertos,
      COUNT(*) FILTER (WHERE ${aberto} AND o.promised_date < $2::date)::int    AS atrasados,
      COALESCE(SUM(x.pecas) FILTER (WHERE ${aberto}), 0)::int                  AS pecas_reservadas,
      COALESCE(SUM(x.sinal) FILTER (WHERE ${aberto}), 0)                       AS sinais_recebidos,
      COALESCE(SUM(GREATEST(o.total - x.sinal, 0)) FILTER (WHERE ${aberto}), 0) AS falta_receber,
      COUNT(*) FILTER (WHERE o.status::text = 'confirmed')::int                AS aguardando,
      COUNT(*) FILTER (WHERE o.status::text = 'preparing')::int                AS separando,
      COUNT(*) FILTER (WHERE o.status::text = 'ready')::int                    AS prontos,
      COUNT(*) FILTER (WHERE o.status::text = 'delivered')::int                AS concluidos,
      COUNT(*) FILTER (WHERE o.status::text = 'cancelled')::int                AS cancelados,
      COUNT(*)::int                                                            AS todos
    FROM digital_orders o
    CROSS JOIN LATERAL (
      SELECT ${SINAL_PAGO} AS sinal,
             (SELECT COALESCE(SUM(ic.quantity), 0) FROM digital_order_items ic
               WHERE ic.order_id = o.id AND ic.product_id IS NOT NULL) AS pecas
    ) x
    WHERE o.company_id = ANY($1::uuid[]) AND o.origem = 'balcao'
    GROUP BY o.company_id`;
  return { sql, params: [empresas, hoje] };
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Linha do banco -> item da lista (numeros como numero, nome legivel). */
function apresentarLinha(r) {
  const total = Number(r.total) || 0;
  const sinal = Number(r.sinal_pago) || 0;
  return {
    id: r.id,
    company_id: r.company_id,
    company_name: r.company_name || null,
    order_number: r.order_number,
    status: r.status,
    customer_id: r.customer_id || null,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone || null,
    subtotal: Number(r.subtotal) || 0,
    discount_amount: Number(r.discount_amount) || 0,
    total,
    sinal_pago: sinal,
    falta: round2(Math.max(total - sinal, 0)),
    promised_date: r.promised_date || null,
    atrasado: r.atrasado === true,
    dias_de_atraso: Number(r.dias_de_atraso) || 0,
    item_count: Number(r.item_count) || 0,
    pecas: Number(r.pecas) || 0,
    first_item_name: nomeLegivelDoItem(r.first_item_name) || null,
    first_item_image: r.first_item_image || null,
    notes: r.notes || null,
    created_by: r.created_by || null,
    created_at: r.created_at,
    delivered_at: r.delivered_at || null,
    cancelled_at: r.cancelled_at || null,
    sale_id: r.sale_id || null,
  };
}

const CAMPOS_DOS_NUMEROS = ['abertos', 'atrasados', 'pecas_reservadas', 'sinais_recebidos', 'falta_receber',
  'aguardando', 'separando', 'prontos', 'concluidos', 'cancelados', 'todos'];

/** Soma as linhas por loja (uma loja = a propria linha). */
function somarNumeros(linhas) {
  const soma = Object.fromEntries(CAMPOS_DOS_NUMEROS.map((k) => [k, 0]));
  for (const l of linhas || []) for (const k of CAMPOS_DOS_NUMEROS) soma[k] += Number(l[k]) || 0;
  return soma;
}

function apresentarNumeros(r) {
  const n = r || {};
  return {
    kpis: {
      abertos: Number(n.abertos) || 0,
      pecas_reservadas: Number(n.pecas_reservadas) || 0,
      atrasados: Number(n.atrasados) || 0,
      sinais_recebidos: round2(Number(n.sinais_recebidos) || 0),
      falta_receber: round2(Number(n.falta_receber) || 0),
    },
    counts: {
      abertos: Number(n.abertos) || 0,
      aguardando: Number(n.aguardando) || 0,
      separando: Number(n.separando) || 0,
      prontos: Number(n.prontos) || 0,
      concluidos: Number(n.concluidos) || 0,
      cancelados: Number(n.cancelados) || 0,
      atrasados: Number(n.atrasados) || 0,
      todos: Number(n.todos) || 0,
    },
  };
}

/**
 * Lista + numeros, prontos para responder. `q` e o pool (ou um client).
 * `porEmpresa` = true acrescenta os numeros de cada loja (consolidado).
 */
async function listarPedidos(q, { empresas, situacao, atrasados, busca, page = 1, limit = 30, hoje, porEmpresa = false }) {
  const pagina = Math.max(1, parseInt(page, 10) || 1);
  const porPagina = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (pagina - 1) * porPagina;
  if (!empresas || !empresas.length) {
    return { orders: [], ...apresentarNumeros(null), pagination: { page: pagina, limit: porPagina, total: 0, pages: 0 } };
  }
  const consulta = montarConsultaDaLista({ empresas, situacao, atrasados, q: busca, limit: porPagina, offset, hoje });
  const numeros = montarConsultaDosNumeros({ empresas, hoje });
  const [{ rows }, { rows: porLoja }] = await Promise.all([
    q.query(consulta.sql, consulta.params),
    q.query(numeros.sql, numeros.params),
  ]);
  const total = rows.length ? Number(rows[0].total_filtrado) || 0 : 0;
  const out = {
    orders: rows.map(apresentarLinha),
    situacao: lerSituacao(situacao),
    ...apresentarNumeros(somarNumeros(porLoja)),
    pagination: { page: pagina, limit: porPagina, total, pages: Math.ceil(total / porPagina) },
  };
  if (porEmpresa) {
    const porId = new Map((porLoja || []).map((l) => [String(l.company_id), l]));
    out.por_empresa = empresas.map((id) => ({ company_id: id, ...apresentarNumeros(porId.get(String(id))).kpis }));
  }
  return out;
}

module.exports = {
  SITUACOES,
  lerSituacao,
  montarConsultaDaLista,
  montarConsultaDosNumeros,
  apresentarLinha,
  apresentarNumeros,
  somarNumeros,
  listarPedidos,
};
