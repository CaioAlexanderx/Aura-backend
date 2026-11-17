// ============================================================
// AURA. — Pedido separado de venda, guardado no Caixa (B1 / p-61a, 17/11/2026)
//
// O Caixa guarda a venda como PEDIDO: as pecas ficam separadas para a
// cliente buscar depois. Regras do Caio (17/11):
//   - pedido nao e venda: nao baixa estoque nem mexe no caixa ate concluir,
//     so reserva (a reserva e CALCULADA dos pedidos abertos, card B2);
//   - a venda so nasce na conclusao (POST /pdv/sale com order_id, card B5a);
//   - a conta a receber e o sinal sao dos cards B4a em diante. Este card nao
//     lanca nada no Financeiro.
//
// Onde mora: digital_orders com origem = 'balcao' (coluna da 313), mais
// promised_date / created_by (459). Nasce 'confirmed' por INSERT direto,
// como o orcamento do Studio (services/studioPedido.js), SEM passar por
// aplicarConfirmacao / onOrderConfirmed (digitalOrderConfirmation.js): a
// confirmacao da loja online baixa estoque, liga cliente, lanca receita e
// emite NFC-e — nada disso vale para o pedido do balcao. stock_deducted fica
// FALSE para sempre (a venda e quem baixa; a Troca so oferece pedido com
// stock_deducted = TRUE, entao o pedido do balcao nunca vira "pedido online"
// para trocar).
//
// O Canal Digital nao ve o pedido do balcao: a fila e as contagens excluem a
// origem (filaDePedidos.js / digitalOrders.js), o PATCH /status do Canal o
// recusa, e a loja online nao consegue gravar essa origem pela atribuicao
// (atribuicaoDoPedido.js).
//
// Itens: produto (visivel para a loja pela regra unica do grupo,
// utils/companyGroup.js), variante do proprio produto, quantidade inteira
// (digital_order_items.quantity e INTEGER) e o preco CONGELADO que o Caixa
// mostrava: unit_price e o preco de tabela da linha e item_discount o
// desconto da linha (lapis do Caixa), como no POST /pdv/sale. subtotal do
// item = quantidade x preco − desconto; total do pedido = soma − desconto do
// pedido (discount_amount, 316). Item sem cadastro (product_id nulo) entra
// com o nome e nao reserva nada.
//
// Cliente opcional: customer_id (cliente da loja ou de outra loja ativa do
// mesmo dono, utils/customerScope.js, a regra do Caixa) ou so um nome
// ("Seguir sem cliente"). Aqui NAO se cria cadastro: o app cria pelo
// NovoClienteNaTroca antes de guardar, quando a lojista quer.
//
// Idempotency-Key (cabecalho, ou idempotency_key no corpo): mesma chave da
// mesma loja devolve o pedido ja guardado (200, Idempotent-Replayed), com
// outros itens e 409 IDEMPOTENCY_KEY_REUSED. Mesmo desenho do pedido da loja
// online (pedidoOnlineIdempotente.js, 416): trava de transacao na chave +
// indice unico parcial (company_id, idempotency_key) como garantia final.
//
// Multi-CNPJ: o pedido e de UMA loja (a do :id, ja conferida pelo
// requireCompanyAccess). Guardar no consolidado nao existe; a leitura
// consolidada e do card B3.
// ============================================================
'use strict';

const db = require('../config/database');
const { productVisibilityWhere } = require('../utils/companyGroup');
const { findOwnerScopedCustomer } = require('../utils/customerScope');
const { normalizarTelefone } = require('../utils/telefone');
const { mesmosItens, INDICE } = require('./pedidoOnlineIdempotente');
const { lerReservas, reservadoDaVariante } = require('./reservaDoPedido');
const { vendaSemEstoqueLiberada } = require('../utils/vendaSemEstoque');

const ORIGEM_BALCAO = 'balcao';
const MAX_ITENS = 100;
const MAX_QTD = 100000;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function erro(status, message, code, extra) {
  return Object.assign(new Error(message), { status, code, ...(extra || {}) });
}

/**
 * A trava do recurso. Desligada (padrao) = so a equipe Aura usa a rota, para
 * QA em producao. PEDIDO_LIBERADO=true no ambiente libera para todo lojista,
 * junto com a trava de mesmo nome do app.
 */
function pedidoLiberado(req) {
  const env = String(process.env.PEDIDO_LIBERADO || '').trim().toLowerCase();
  if (env === 'true' || env === '1') return true;
  const u = req && req.user;
  return !!u && (u.is_staff === true || u.role === 'admin');
}

/** Hoje em Sao Paulo, 'YYYY-MM-DD'. */
function hojeSP(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
}

function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function textoLimpo(raw, max) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, max).join('').trim();
}

/** Chave de idempotencia do corpo ou do cabecalho. null = sem protecao. */
function lerChave(req) {
  const doCabecalho = req?.headers?.['idempotency-key'];
  const raw = (doCabecalho !== undefined && doCabecalho !== null && doCabecalho !== '')
    ? doCabecalho
    : req?.body?.idempotency_key;
  if (raw === undefined || raw === null) return null;
  const k = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!k) return null;
  return KEY_RE.test(k) ? k : null;
}

/**
 * Le e confere o corpo, sem banco. Devolve { dados } ou { erro: {status, message, code} }.
 * Mensagens em portugues, prontas para a tela.
 */
function lerCorpo(body, { hoje = hojeSP() } = {}) {
  const b = body || {};
  const brutos = b.items;
  if (!Array.isArray(brutos) || brutos.length === 0) {
    return { erro: { status: 422, code: 'PEDIDO_SEM_ITENS', message: 'Adicione pelo menos uma peça ao pedido.' } };
  }
  if (brutos.length > MAX_ITENS) {
    return { erro: { status: 422, code: 'PEDIDO_ITENS_DEMAIS', message: `Um pedido leva até ${MAX_ITENS} itens.` } };
  }

  const itens = [];
  for (let i = 0; i < brutos.length; i++) {
    const it = brutos[i] || {};
    const pid = it.product_id ? String(it.product_id) : null;
    const vid = it.variant_id ? String(it.variant_id) : null;
    if (pid && !UUID_RE.test(pid)) {
      return { erro: { status: 422, code: 'PEDIDO_ITEM_INVALIDO', message: `O item ${i + 1} tem um produto inválido.` } };
    }
    if (vid && (!pid || !UUID_RE.test(vid))) {
      return { erro: { status: 422, code: 'PEDIDO_ITEM_INVALIDO', message: `O item ${i + 1} tem uma variação inválida.` } };
    }
    const nome = textoLimpo(it.product_name ?? it.name, 255);
    if (!pid && !nome) {
      return { erro: { status: 422, code: 'PEDIDO_ITEM_INVALIDO', message: `O item ${i + 1} está sem nome.` } };
    }
    const rotulo = nome || `item ${i + 1}`;
    const qtd = Number(it.quantity);
    if (!Number.isFinite(qtd) || qtd <= 0) {
      return { erro: { status: 422, code: 'PEDIDO_QUANTIDADE', message: `"${rotulo}": informe uma quantidade maior que zero.` } };
    }
    if (!Number.isInteger(qtd) || qtd > MAX_QTD) {
      return { erro: { status: 422, code: 'PEDIDO_QUANTIDADE', message: `"${rotulo}": o pedido aceita só quantidade inteira (peças).` } };
    }
    const preco = Number(it.unit_price);
    if (!Number.isFinite(preco) || preco < 0) {
      return { erro: { status: 422, code: 'PEDIDO_PRECO', message: `"${rotulo}": preço inválido.` } };
    }
    const bruto = round2(qtd * round2(preco));
    const desc = it.item_discount == null || it.item_discount === '' ? 0 : Number(it.item_discount);
    if (!Number.isFinite(desc) || desc < 0) {
      return { erro: { status: 422, code: 'PEDIDO_DESCONTO', message: `"${rotulo}": desconto inválido.` } };
    }
    const descontoDoItem = Math.min(round2(desc), bruto);
    itens.push({
      product_id: pid,
      variant_id: vid,
      nome,
      variant_label: textoLimpo(it.variant_label, 120),
      quantity: qtd,
      unit_price: round2(preco),
      item_discount: descontoDoItem,
      subtotal: round2(bruto - descontoDoItem),
    });
  }

  const subtotal = round2(itens.reduce((s, it) => s + it.subtotal, 0));
  const descPedido = b.discount == null || b.discount === '' ? 0 : Number(b.discount);
  if (!Number.isFinite(descPedido) || descPedido < 0) {
    return { erro: { status: 422, code: 'PEDIDO_DESCONTO', message: 'Desconto do pedido inválido.' } };
  }
  if (round2(descPedido) > subtotal) {
    return { erro: { status: 422, code: 'PEDIDO_DESCONTO', message: 'O desconto passou do valor do pedido.' } };
  }
  const desconto = round2(descPedido);

  let promisedDate = null;
  if (b.promised_date != null && b.promised_date !== '') {
    const s = String(b.promised_date).trim();
    if (!dataValida(s)) {
      return { erro: { status: 422, code: 'PEDIDO_DATA', message: 'A data em que ela vem buscar está inválida.' } };
    }
    if (s < hoje) {
      return { erro: { status: 422, code: 'PEDIDO_DATA', message: 'A data em que ela vem buscar já passou. Escolha hoje ou um dia depois.' } };
    }
    promisedDate = s;
  }

  const cid = b.customer_id ? String(b.customer_id) : null;
  if (cid && !UUID_RE.test(cid)) {
    return { erro: { status: 404, code: 'CUSTOMER_NOT_FOUND', message: 'Cliente não encontrado nesta empresa.' } };
  }
  const tel = normalizarTelefone(textoLimpo(b.customer_phone, 30));
  if (!tel.ok) return { erro: { status: 422, code: tel.code, message: tel.error } };

  return {
    dados: {
      itens,
      subtotal,
      desconto,
      total: round2(subtotal - desconto),
      promisedDate,
      customerId: cid,
      customerName: textoLimpo(b.customer_name, 255),
      customerPhone: tel.valor || null,
      notes: textoLimpo(b.notes, 500),
    },
  };
}

/** Produtos e variantes do pedido numa consulta, pela regra unica de visibilidade. */
async function conferirProdutos(client, companyId, itens) {
  const ids = [...new Set(itens.filter((i) => i.product_id).map((i) => i.product_id))];
  if (!ids.length) return;
  const { rows } = await client.query(
    `SELECT p.id, p.name, p.stock_qty,
            (p.is_personalizable IS TRUE AND p.customization_config IS NOT NULL) AS sob_encomenda
       FROM products p
      WHERE p.id = ANY($1::uuid[])
        AND ${productVisibilityWhere('$2', 'p.')}`,
    [ids, companyId]
  );
  const porId = new Map(rows.map((r) => [String(r.id), r]));
  const vids = [...new Set(itens.filter((i) => i.variant_id).map((i) => i.variant_id))];
  let variantes = new Map();
  if (vids.length) {
    const { rows: vs } = await client.query(
      `SELECT id, product_id, sku_suffix, stock_qty FROM product_variants WHERE id = ANY($1::uuid[])`,
      [vids]
    );
    variantes = new Map(vs.map((v) => [String(v.id), v]));
  }
  for (const it of itens) {
    if (!it.product_id) continue;
    const p = porId.get(it.product_id);
    if (!p) {
      throw erro(404, `Produto não encontrado nesta loja${it.nome ? `: "${it.nome}"` : ''}.`, 'PRODUCT_NOT_FOUND');
    }
    // Nome gravado: o do cadastro (o do corpo so vale para item sem cadastro).
    it.nome = p.name || it.nome;
    it.sobEncomenda = p.sob_encomenda === true;
    it.estoque = Number(p.stock_qty) || 0;
    if (it.variant_id) {
      const v = variantes.get(it.variant_id);
      if (!v || String(v.product_id) !== it.product_id) {
        throw erro(422, `"${it.nome}": essa variação não é deste produto.`, 'PEDIDO_ITEM_INVALIDO');
      }
      if (!it.variant_label && v.sku_suffix) it.variant_label = String(v.sku_suffix).slice(0, 120);
      it.estoque = Number(v.stock_qty) || 0;
    }
  }
}

/**
 * B2 (p-61b): o pedido so separa o que esta livre. Livre = estoque da
 * prateleira (da variante, ou do produto sem variante — a mesma leitura do
 * POST /pdv/sale) menos o que ja esta reservado em outros pedidos do balcao
 * abertos do grupo. Peca sob encomenda e item sem cadastro nao sao
 * conferidos. Devolve a lista do que falta ([] = tudo livre).
 */
async function conferirSaldo(client, companyId, itens) {
  const linhas = new Map();
  for (const it of itens) {
    if (!it.product_id || it.sobEncomenda) continue;
    const k = `${it.product_id}|${it.variant_id || ''}`;
    const l = linhas.get(k) || { it, quantidade: 0 };
    l.quantidade += it.quantity;
    linhas.set(k, l);
  }
  if (!linhas.size) return [];
  const reservas = await lerReservas(client, companyId, [...linhas.values()].map((l) => l.it.product_id));
  const faltas = [];
  for (const { it, quantidade } of linhas.values()) {
    const reservado = reservadoDaVariante(reservas, it.product_id, it.variant_id);
    const livre = Math.max(0, it.estoque - reservado);
    if (livre < quantidade) {
      faltas.push({
        product_id: it.product_id,
        variant_id: it.variant_id || null,
        nome: it.nome + (it.variant_label ? ` (${it.variant_label})` : ''),
        quantidade,
        estoque: it.estoque,
        reservado,
        livre,
      });
    }
  }
  return faltas;
}

function fraseDaFalta(f) {
  const n = (x) => String(x).replace('.', ',');
  if (f.reservado > 0) {
    return `"${f.nome}": só ${n(f.livre)} livre${f.livre === 1 ? '' : 's'} (${n(f.reservado)} já separada${f.reservado === 1 ? '' : 's'} em outro pedido).`;
  }
  return `"${f.nome}": só ${n(f.livre)} no estoque.`;
}

async function resolverCliente(client, companyId, dados) {
  if (!dados.customerId) {
    return { id: null, nome: dados.customerName || 'Cliente', telefone: dados.customerPhone || '' };
  }
  const c = await findOwnerScopedCustomer(client, companyId, dados.customerId, 'id, name, phone');
  if (!c) throw erro(404, 'Cliente não encontrado nesta empresa.', 'CUSTOMER_NOT_FOUND');
  return {
    id: c.id,
    nome: dados.customerName || c.name || 'Cliente',
    telefone: dados.customerPhone || c.phone || '',
  };
}

async function lerPedidoCompleto(q, companyId, orderId) {
  const { rows } = await q.query(
    `SELECT id, order_number, origem, status, payment_status, customer_id, customer_name,
            customer_phone, subtotal, discount_amount, total, promised_date::text AS promised_date,
            notes, created_by, confirmed_at, created_at
       FROM digital_orders WHERE id = $1 AND company_id = $2`,
    [orderId, companyId]
  );
  if (!rows.length) return null;
  const { rows: itens } = await q.query(
    `SELECT id, product_id, variant_id, variant_label, product_name, unit_price, quantity, subtotal
       FROM digital_order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  return apresentarPedido(rows[0], itens);
}

/** Linha do banco -> corpo da resposta (numeros como numero). */
function apresentarPedido(o, itens) {
  return {
    id: o.id,
    order_number: o.order_number,
    origem: o.origem,
    status: o.status,
    payment_status: o.payment_status,
    customer_id: o.customer_id || null,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone || null,
    subtotal: Number(o.subtotal),
    discount_amount: Number(o.discount_amount || 0),
    total: Number(o.total),
    promised_date: o.promised_date || null,
    notes: o.notes || null,
    created_by: o.created_by || null,
    confirmed_at: o.confirmed_at,
    created_at: o.created_at,
    items: (itens || []).map((i) => {
      const quantity = Number(i.quantity);
      const unitPrice = Number(i.unit_price);
      const subtotal = Number(i.subtotal);
      return {
        id: String(i.id),
        product_id: i.product_id || null,
        variant_id: i.variant_id || null,
        variant_label: i.variant_label || null,
        product_name: i.product_name,
        quantity,
        unit_price: unitPrice,
        item_discount: round2(quantity * unitPrice - subtotal),
        subtotal,
      };
    }),
  };
}

const REPETIDO = Symbol('pedido-repetido');

/**
 * Guarda o pedido. Devolve { status: 201|200, pedido, repetido }.
 * Lanca erro com .status (4xx) para a rota responder.
 */
async function guardarPedido({ companyId, userId, body, chave, hoje }) {
  const lido = lerCorpo(body, { hoje });
  if (lido.erro) throw erro(lido.erro.status, lido.erro.message, lido.erro.code);
  const dados = lido.dados;

  // Repeticao que chega depois da primeira ter terminado: responde logo.
  if (chave) {
    const ja = await buscarPorChave(db, companyId, chave);
    if (ja) return responderRepeticao(companyId, ja, dados.itens);
  }

  const client = await db.connect();
  let orderId;
  let repetidoDe = null;
  let avisos = [];
  try {
    await client.query('BEGIN');
    if (chave) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pedido-balcao:${companyId}:${chave}`]);
      const ja = await buscarPorChave(client, companyId, chave);
      if (ja) throw Object.assign(new Error('repetido'), { [REPETIDO]: ja });
    }
    await conferirProdutos(client, companyId, dados.itens);
    // B2: sem saldo livre, o pedido nao separa (409). Com "vender sem estoque"
    // ligado (allow_sale_without_stock), entra com o aviso.
    avisos = await conferirSaldo(client, companyId, dados.itens);
    if (avisos.length && !(await vendaSemEstoqueLiberada(client, companyId))) {
      throw erro(409, `Não dá para separar: ${avisos.map(fraseDaFalta).join(' ')}`, 'PEDIDO_SEM_SALDO', { faltas: avisos });
    }
    const cliente = await resolverCliente(client, companyId, dados);

    const { rows: [o] } = await client.query(
      `INSERT INTO digital_orders
         (company_id, order_number, origem, status, payment_status, payment_method, delivery_type,
          customer_id, customer_name, customer_phone,
          subtotal, discount_amount, delivery_fee, total,
          promised_date, notes, created_by, confirmed_at, idempotency_key)
       VALUES ($1, next_digital_order_number($1), '${ORIGEM_BALCAO}', 'confirmed', 'pending', 'balcao', 'pickup',
               $2, $3, $4,
               $5, $6, 0, $7,
               $8::date, $9, $10, NOW(), $11)
       RETURNING id`,
      [
        companyId, cliente.id, cliente.nome, cliente.telefone,
        dados.subtotal, dados.desconto, dados.total,
        dados.promisedDate, dados.notes, userId || null, chave,
      ]
    );
    orderId = o.id;
    for (const it of dados.itens) {
      await client.query(
        `INSERT INTO digital_order_items
           (order_id, product_id, variant_id, variant_label, product_name, unit_price, quantity, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, it.product_id, it.variant_id, it.variant_label, it.nome, it.unit_price, it.quantity, it.subtotal]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e[REPETIDO]) repetidoDe = e[REPETIDO];
    else if (chave && e && e.code === '23505' && String(e.constraint || '') === INDICE) repetidoDe = 'buscar';
    else throw e;
  } finally {
    client.release();
  }
  if (repetidoDe === 'buscar') {
    repetidoDe = await buscarPorChave(db, companyId, chave);
    if (!repetidoDe) throw erro(409, 'Este pedido mudou enquanto era guardado. Tente de novo.', 'PEDIDO_CONFLITO');
  }
  if (repetidoDe) return responderRepeticao(companyId, repetidoDe, dados.itens);
  const pedido = await lerPedidoCompleto(db, companyId, orderId);
  return { status: 201, pedido, repetido: false, avisos };
}

async function buscarPorChave(q, companyId, chave) {
  const { rows } = await q.query(
    `SELECT id, origem FROM digital_orders WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, chave]
  );
  return rows[0] || null;
}

async function responderRepeticao(companyId, ja, itensDoCorpo) {
  const pedido = await lerPedidoCompleto(db, companyId, ja.id);
  if (!pedido || pedido.origem !== ORIGEM_BALCAO || !mesmosItens(itensDoCorpo, pedido.items)) {
    throw erro(409,
      `Já guardamos um pedido${pedido ? ` (${pedido.order_number})` : ''} com outros itens nesta tentativa. Se este for um pedido novo, toque de novo em Guardar pedido.`,
      'IDEMPOTENCY_KEY_REUSED',
      { order_id: ja.id });
  }
  return { status: 200, pedido, repetido: true };
}

module.exports = {
  ORIGEM_BALCAO,
  pedidoLiberado,
  hojeSP,
  lerChave,
  lerCorpo,
  guardarPedido,
  lerPedidoCompleto,
  apresentarPedido,
};
