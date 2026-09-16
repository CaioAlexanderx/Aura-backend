// ============================================================
// AURA. — Fila de pedidos da loja online (painel)
// Criado: 10/09/2026
//
// O que a fila precisava e nao tinha:
//   - identificar a venda de relance: foto e nome do primeiro item. A
//     lista so devolvia a contagem de itens.
//   - achar um pedido: busca por numero ("3", "#00003"), telefone e texto
//     (cliente, e-mail ou nome do produto).
//   - nome de item legivel: a sacola gravava a cor em hex
//     ("Conjunto luka (Cor: #92400E / Tamanho: G)"). Mostramos o nome da
//     cor pela mesma tabela da vitrine (coresDaLoja.rotuloDaCor). O banco
//     continua com o que foi gravado.
//
// A consulta mora aqui, fora da rota, para o teste travar SQL e
// parametros sem subir Express — o Postgres conta parametros pelo maior
// $n, e um sobrando ja derrubou o catalogo uma vez.
// ============================================================
'use strict';

const { rotuloDaCor } = require('./coresDaLoja');

const HEX = /#[0-9A-Fa-f]{6}\b/g;

/** "(Cor: #92400E / Tamanho: G)" -> "(Cor: Ferrugem / Tamanho: G)". Hex sem nome proximo fica. */
function nomeLegivelDoItem(nome) {
  if (nome === null || nome === undefined) return nome;
  return String(nome).replace(HEX, (hex) => rotuloDaCor(hex) || hex);
}

/** ILIKE com ESCAPE '!': o que a lojista digita e texto, nao curinga. */
function escaparLike(texto) {
  return String(texto).replace(/[!%_]/g, (c) => '!' + c);
}

const COLUNAS = `
  o.id, o.order_number, o.customer_name, o.customer_phone, o.customer_email,
  o.delivery_type, o.subtotal, o.total, o.delivery_fee,
  o.status, o.payment_status, o.payment_method, o.notes,
  o.payment_proof_url, o.payment_proof_uploaded_at,
  o.confirmed_at, o.delivered_at, o.cancelled_at, o.created_at,
  o.customer_id, o.transaction_id, o.stock_deducted, o.nfce_id,
  o.courier_name, o.courier_plate`;

/**
 * @param {{cid: string, status?: string, q?: string, limit: number, offset: number}} p
 * @returns {{sql: string, params: any[]}}
 */
function montarConsultaDaFila({ cid, status, q, limit, offset }) {
  const params = [cid];
  const filtros = ['o.company_id = $1'];

  if (status && status !== 'all') {
    params.push(status);
    filtros.push(`o.status = $${params.length}`);
  }

  const busca = String(q || '').trim().slice(0, 80);
  if (busca) {
    const digitos = busca.replace(/[^0-9]/g, '');
    const soNumero = digitos.length > 0 && /^#?[\s0-9().+-]*$/.test(busca);
    if (soNumero) {
      // Numero do pedido sem os zeros a esquerda ("3" acha "00003"), ou
      // telefone a partir de 4 digitos — menos que isso casaria meio mundo.
      params.push(digitos);
      const n = params.length;
      filtros.push(
        `(ltrim(o.order_number::text, '0') = ltrim($${n}, '0')` +
        ` OR (length($${n}) >= 4 AND regexp_replace(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g') LIKE '%' || $${n} || '%'))`
      );
    } else {
      params.push('%' + escaparLike(busca) + '%');
      const n = params.length;
      filtros.push(
        `(o.customer_name ILIKE $${n} ESCAPE '!'` +
        ` OR o.customer_email ILIKE $${n} ESCAPE '!'` +
        ` OR EXISTS (SELECT 1 FROM digital_order_items bi WHERE bi.order_id = o.id AND bi.product_name ILIKE $${n} ESCAPE '!'))`
      );
    }
  }

  params.push(limit, offset);
  const sql = `
    SELECT ${COLUNAS},
      (SELECT COUNT(*)::int FROM digital_order_items ic WHERE ic.order_id = o.id) AS item_count,
      pi.product_name AS first_item_name,
      pi.imagem       AS first_item_image,
      COUNT(*) OVER() AS total_filtrado
    FROM digital_orders o
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
    ORDER BY o.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  return { sql, params };
}

/** Linha do banco -> item da fila: nome legivel e sem a coluna tecnica. */
function apresentarLinhaDaFila(linha) {
  const { total_filtrado, ...resto } = linha;
  return { ...resto, first_item_name: nomeLegivelDoItem(resto.first_item_name) };
}

module.exports = { nomeLegivelDoItem, escaparLike, montarConsultaDaFila, apresentarLinhaDaFila };
