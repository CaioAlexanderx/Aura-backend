// ============================================================
// AURA. — Conferencia de estoque (card p-108, 11/11/2026)
//
// Migration 446. Rota: src/routes/estoqueConferencias.js.
//
// POR LOJA (company :id). Entra na conferencia so produto com
// company_id = :id (o estoque mora nele). Produto de grupo compartilhado
// (is_group_shared) de OUTRA loja do grupo tem estoque unico, que mora na
// loja dona: aqui recusa com 409 e o nome da loja dona.
//
// ESTOQUE POR VARIANTE (mesma regra do Caixa e da transferencia): produto
// com variante ativa e contado por variante e o ajuste vai para
// product_variants.stock_qty; o products.stock_qty do pai nao e tocado (o
// app mostra a soma das variantes ativas — variants_stock_total em
// products.js). Produto sem variante usa products.stock_qty.
//
// REGRA DO AJUSTE (nao e "contado + movimentos posteriores": cinco caminhos
// baixam estoque sem gravar stock_movements):
//   - no PRIMEIRO registro do item o servidor grava estoque_no_bipe (o
//     stock_qty daquele instante) e custo_no_bipe; os seguintes so mudam o
//     contado;
//   - aplicar: diferenca = contado - estoque_no_bipe; estoque novo =
//     GREATEST(0, estoque atual + diferenca); diferenca_aplicada = o efetivo.
//     Venda (ou transferencia) feita depois do bipe fica mantida;
//   - nao contados so com "zerar nao contados": diferenca = -estoque atual;
//   - desfazer (ate 7 dias, uma vez): GREATEST(0, atual - diferenca_aplicada).
//
// LANCAMENTOS: stock_movements type 'adjustment', quantity = |efetivo|
// (positiva, a convencao da tabela), reference_type 'stock_count' (ou
// 'stock_count_undo'), reference_id = conferencia, variant_id, unit_cost =
// custo_no_bipe. O SENTIDO do lancamento sai de
// stock_count_items.diferenca_aplicada (negativo = saiu) — 'adjustment' nao
// diz a direcao sozinho.
//
// CONCORRENCIA: registrar item trava a conferencia FOR SHARE (dois
// aparelhos contam juntos; aplicar espera); aplicar/desfazer/descartar
// travam FOR UPDATE (clique duplo: o segundo encontra 'aplicada' e leva
// 409 JA_APLICADA sem mexer em nada) e as linhas de estoque FOR UPDATE em
// ordem de id, como a transferencia.
// ============================================================
'use strict';

const { rotuloDaVariante } = require('./transferenciaDeEstoque');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QTD_MAX = 1e6;
const DIAS_PARA_DESFAZER = 7;
const MOTIVO_MAX = 200;
const TIPOS_DE_ESCOPO = ['loja_toda', 'categoria', 'com_estoque'];

class ErroDeConferencia extends Error {
  constructor(status, code, error, extra = {}) {
    super(error);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  get body() {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

const arred3 = (n) => Math.round(Number(n) * 1000) / 1000;
const arred2 = (n) => Math.round(Number(n) * 100) / 100;
const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());
const numOuNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const ehUuid = (v) => UUID.test(txt(v));

// ─── regras puras ────────────────────────────────────────────
/**
 * Ajuste de um item contado: diferenca sobre o estoque ATUAL, piso 0.
 * @returns {{ diferenca:number, novo:number, aplicada:number }}
 */
function calcularAjuste({ contado, estoqueNoBipe, estoqueAtual }) {
  const diferenca = arred3(Number(contado) - Number(estoqueNoBipe));
  const atual = arred3(Number(estoqueAtual) || 0);
  const novo = arred3(Math.max(0, atual + diferenca));
  return { diferenca, novo, aplicada: arred3(novo - atual) };
}

/** Nao contado com "zerar nao contados": vai a 0 (diferenca = -atual). */
function calcularZerar(estoqueAtual) {
  return calcularAjuste({ contado: 0, estoqueNoBipe: estoqueAtual, estoqueAtual });
}

/** Desfazer: inverso da diferenca aplicada sobre o estoque atual, piso 0. */
function calcularDesfazer({ estoqueAtual, diferencaAplicada }) {
  const atual = arred3(Number(estoqueAtual) || 0);
  const novo = arred3(Math.max(0, atual - Number(diferencaAplicada)));
  return { novo, efetiva: arred3(novo - atual) };
}

function grupoDaDiferenca(d) {
  if (d < 0) return 'faltam';
  if (d > 0) return 'sobram';
  return 'batem';
}

// ─── leitura do corpo ────────────────────────────────────────
function lerEscopo(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const tipo = e ? txt(e.tipo) : '';
  if (!TIPOS_DE_ESCOPO.includes(tipo)) {
    throw new ErroDeConferencia(400, 'ESCOPO_INVALIDO', 'Escolha o que conferir: a loja toda, uma categoria ou só o que tem estoque.');
  }
  if (tipo !== 'categoria') return { tipo };
  const ids = Array.isArray(e.category_ids) ? e.category_ids.map(txt) : [];
  if (!ids.length || ids.length > 100 || ids.some((id) => !UUID.test(id))) {
    throw new ErroDeConferencia(400, 'ESCOPO_INVALIDO', 'Escolha pelo menos uma categoria para conferir.');
  }
  return { tipo, category_ids: [...new Set(ids.map((id) => id.toLowerCase()))] };
}

function lerMotivo(raw) {
  if (raw === undefined || raw === null) return null;
  const m = txt(raw).slice(0, MOTIVO_MAX);
  return m || null;
}

function lerCriacao(body) {
  const b = body && typeof body === 'object' ? body : {};
  const escopo = lerEscopo(b.escopo);
  return {
    escopo,
    asCegas: b.as_cegas === undefined || b.as_cegas === null ? true : b.as_cegas !== false,
    motivo: lerMotivo(b.motivo),
  };
}

function lerRegistro(body) {
  const b = body && typeof body === 'object' ? body : {};
  const productId = txt(b.product_id).toLowerCase();
  const vBruto = b.variant_id === undefined || b.variant_id === null || b.variant_id === '' ? null : txt(b.variant_id).toLowerCase();
  if (!UUID.test(productId) || (vBruto !== null && !UUID.test(vBruto))) {
    throw new ErroDeConferencia(404, 'ITEM_NAO_ENCONTRADO', 'Não achamos esse produto no estoque desta loja.');
  }
  const modo = b.modo === undefined || b.modo === null || b.modo === '' ? 'somar' : txt(b.modo);
  if (modo !== 'somar' && modo !== 'definir') {
    throw new ErroDeConferencia(400, 'QUANTIDADE_INVALIDA', 'Use modo "somar" ou "definir".');
  }
  const q = Number(b.quantidade === undefined || b.quantidade === null || b.quantidade === '' ? (modo === 'somar' ? 1 : NaN) : b.quantidade);
  if (!Number.isFinite(q) || Math.abs(q) > QTD_MAX || (modo === 'definir' && q < 0)) {
    throw new ErroDeConferencia(400, 'QUANTIDADE_INVALIDA', 'A quantidade contada precisa ser um número de 0 em diante.');
  }
  return { productId, variantId: vBruto, quantidade: arred3(q), modo };
}

// ─── SQL comum ───────────────────────────────────────────────
const SELECT_CONFERENCIA = `
  SELECT c.id, c.company_id, c.numero, c.status, c.escopo, c.as_cegas, c.motivo,
         c.created_at AS criada_em, c.criada_por, u.full_name AS criada_por_nome,
         c.aplicada_em, c.aplicada_por, c.desfeita_em, c.desfeita_por, c.zerou_nao_contados,
         CASE WHEN c.status = 'aplicada' THEN c.aplicada_em + INTERVAL '${DIAS_PARA_DESFAZER} days' END AS pode_desfazer_ate,
         (c.status = 'aplicada' AND c.aplicada_em > NOW() - INTERVAL '${DIAS_PARA_DESFAZER} days') AS dentro_do_prazo
    FROM stock_counts c
    LEFT JOIN users u ON u.id = c.criada_por`;

function conferenciaOut(r) {
  if (!r) return null;
  let escopo = r.escopo;
  if (typeof escopo === 'string') { try { escopo = JSON.parse(escopo); } catch (_) { /* fica o texto */ } }
  return {
    id: r.id,
    company_id: r.company_id,
    numero: Number(r.numero),
    status: r.status,
    escopo,
    as_cegas: !!r.as_cegas,
    motivo: r.motivo || null,
    criada_em: r.criada_em,
    criada_por: r.criada_por || null,
    criada_por_nome: r.criada_por_nome || null,
    aplicada_em: r.aplicada_em || null,
    aplicada_por: r.aplicada_por || null,
    desfeita_em: r.desfeita_em || null,
    desfeita_por: r.desfeita_por || null,
    zerou_nao_contados: !!r.zerou_nao_contados,
    pode_desfazer_ate: r.pode_desfazer_ate || null,
    pode_desfazer: !!r.dentro_do_prazo,
  };
}

async function buscarConferencia(conn, companyId, countId, trava = '') {
  if (!ehUuid(countId)) return null;
  const { rows } = await conn.query(
    `${SELECT_CONFERENCIA}
     WHERE c.id = $1 AND c.company_id = $2${trava ? ` ${trava} OF c` : ''}`,
    [String(countId).toLowerCase(), companyId]
  );
  return rows[0] || null;
}

function naoAchada() {
  return new ErroDeConferencia(404, 'CONFERENCIA_NAO_ENCONTRADA', 'Não achamos essa conferência nesta loja.');
}

function exigirRascunho(c) {
  if (c.status === 'rascunho') return;
  const msg = {
    aplicada: 'Esta conferência já foi aplicada. Para mudar algo, comece uma nova.',
    desfeita: 'Esta conferência foi desfeita. Para contar de novo, comece uma nova.',
    descartada: 'Esta conferência foi descartada. Para contar de novo, comece uma nova.',
  }[c.status] || 'Esta conferência não está mais em andamento.';
  throw new ErroDeConferencia(409, 'CONFERENCIA_FECHADA', msg, { status: c.status });
}

// Categoria escolhida e as subcategorias dela, da propria loja. Texto
// comum (nao template): e um pedaco do SELECT de baixo, e o
// sqlDosTemplates.test.js julgaria um template sozinho como SQL inteiro.
const CTE_DAS_CATEGORIAS = [
  'WITH RECURSIVE cats AS (',
  '  SELECT id FROM product_categories WHERE company_id = $1 AND id = ANY($2::uuid[])',
  '  UNION',
  '  SELECT c.id FROM product_categories c JOIN cats ON c.parent_id = cats.id',
  ')',
].join(' ');

// Linhas de estoque do escopo (uma por variante ativa; produto sem variante
// e uma linha so). Servico (unit 'srv') nao tem estoque e fica de fora.
function sqlDoEscopo(escopo) {
  const params = ['$1'];
  let comCategorias = '';
  let filtro = '';
  if (escopo && escopo.tipo === 'categoria') {
    comCategorias = CTE_DAS_CATEGORIAS;
    filtro += ` AND EXISTS (SELECT 1 FROM product_category_links l WHERE l.product_id = p.id AND l.category_id IN (SELECT id FROM cats))`;
    params.push('$2');
  }
  const estoque = `COALESCE(CASE WHEN v.id IS NULL THEN p.stock_qty ELSE v.stock_qty END, 0)`;
  if (escopo && escopo.tipo === 'com_estoque') filtro += ` AND ${estoque} > 0`;
  return {
    sql: `${comCategorias}
      SELECT p.id AS product_id, v.id AS variant_id, p.name AS nome,
             p.barcode, p.sku, v.barcode AS v_barcode, v.sku_suffix, v.color_name,
             ${estoque} AS estoque_atual,
             COALESCE(NULLIF(p.weighted_avg_cost, 0), NULLIF(p.cost_price, 0)) AS custo
        FROM products p
        LEFT JOIN product_variants v ON v.product_id = p.id AND v.is_active = true
       WHERE p.company_id = $1 AND p.is_active = true
         AND lower(COALESCE(p.unit, '')) <> 'srv'${filtro}
       ORDER BY p.name ASC, v.sku_suffix ASC NULLS FIRST, v.id`,
    params: (companyId) => (escopo && escopo.tipo === 'categoria' ? [companyId, escopo.category_ids] : [companyId]),
  };
}

async function linhasDoEscopo(conn, companyId, escopo) {
  const q = sqlDoEscopo(escopo);
  const { rows } = await conn.query(q.sql, q.params(companyId));
  return rows;
}

async function contarEscopo(conn, companyId, escopo) {
  const q = sqlDoEscopo(escopo);
  const { rows } = await conn.query(`SELECT COUNT(*) AS n FROM (${q.sql}) escopo`, q.params(companyId));
  return Number((rows[0] && rows[0].n) || 0);
}

const chaveDaLinha = (pid, vid) => `${String(pid).toLowerCase()}|${vid ? String(vid).toLowerCase() : ''}`;

async function rotulos(conn, linhas) {
  const vids = [...new Set(linhas.filter((l) => l.variant_id).map((l) => String(l.variant_id).toLowerCase()))];
  const valores = new Map();
  if (vids.length) {
    const { rows } = await conn.query(
      `SELECT variant_id, attribute_name, value FROM product_variant_values WHERE variant_id = ANY($1::uuid[])`,
      [vids]
    );
    for (const r of rows) {
      const k = String(r.variant_id).toLowerCase();
      if (!valores.has(k)) valores.set(k, []);
      valores.get(k).push(r);
    }
  }
  return (l) => (l.variant_id
    ? rotuloDaVariante({ color_name: l.color_name, sku_suffix: l.sku_suffix }, valores.get(String(l.variant_id).toLowerCase()))
    : null);
}

const codigoDaLinha = (l) => txt(l.v_barcode) || txt(l.barcode) || txt(l.sku) || null;

// Itens gravados com nome, variante e o estoque de agora.
async function itensComProduto(conn, countId) {
  const { rows } = await conn.query(
    `SELECT i.id, i.product_id, i.variant_id, i.contado, i.estoque_no_bipe, i.custo_no_bipe,
            i.contado_em, i.atualizado_em, i.diferenca_aplicada, i.diferenca_desfeita, i.nao_contado,
            p.name AS nome, p.barcode, p.sku, v.barcode AS v_barcode, v.sku_suffix, v.color_name,
            COALESCE(CASE WHEN i.variant_id IS NULL THEN p.stock_qty ELSE v.stock_qty END, 0) AS estoque_atual
       FROM stock_count_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN product_variants v ON v.id = i.variant_id
      WHERE i.stock_count_id = $1
      ORDER BY i.atualizado_em DESC, i.id`,
    [countId]
  );
  return rows;
}

// ─── criar ───────────────────────────────────────────────────
async function criar(conn, { companyId, userId, escopo, asCegas, motivo }) {
  if (escopo.tipo === 'categoria') {
    const { rows } = await conn.query(
      `SELECT id FROM product_categories WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, escopo.category_ids]
    );
    if (!rows.length) {
      throw new ErroDeConferencia(400, 'ESCOPO_INVALIDO', 'Essa categoria não é desta loja. Escolha outra.');
    }
    escopo = { tipo: 'categoria', category_ids: rows.map((r) => String(r.id).toLowerCase()) };
  }
  // numero sequencial por loja sem buraco: fila por empresa.
  await conn.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stock_count:${companyId}`]);
  const { rows: seq } = await conn.query(
    `SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM stock_counts WHERE company_id = $1`,
    [companyId]
  );
  const { rows } = await conn.query(
    `INSERT INTO stock_counts (company_id, numero, escopo, as_cegas, motivo, criada_por)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     RETURNING id`,
    [companyId, Number(seq[0].numero), JSON.stringify(escopo), asCegas, motivo, userId || null]
  );
  return conferenciaOut(await buscarConferencia(conn, companyId, rows[0].id));
}

// ─── listar (historico) ──────────────────────────────────────
async function listar(conn, companyId, { limit = 20, before = null, incluirDescartadas = false } = {}) {
  const params = [companyId, limit];
  let where = 'c.company_id = $1';
  if (!incluirDescartadas) where += ` AND c.status <> 'descartada'`;
  if (before) { params.push(before); where += ` AND c.created_at < $${params.length}::timestamptz`; }
  const { rows } = await conn.query(
    `${SELECT_CONFERENCIA}
     WHERE ${where}
     ORDER BY c.created_at DESC, c.numero DESC
     LIMIT $2`,
    params
  );
  if (!rows.length) return [];
  const { rows: resumos } = await conn.query(
    `SELECT d.stock_count_id,
            COUNT(*) FILTER (WHERE NOT d.nao_contado) AS itens_contados,
            COUNT(*) FILTER (WHERE d.dif < 0) AS faltam,
            COUNT(*) FILTER (WHERE d.dif > 0) AS sobram,
            COUNT(*) FILTER (WHERE d.dif = 0 AND NOT d.nao_contado) AS batem,
            SUM(-d.dif * d.custo_no_bipe) FILTER (WHERE d.dif < 0 AND d.custo_no_bipe IS NOT NULL) AS valor_faltam,
            SUM(d.dif * d.custo_no_bipe) FILTER (WHERE d.dif > 0 AND d.custo_no_bipe IS NOT NULL) AS valor_sobram
       FROM (SELECT stock_count_id, nao_contado, custo_no_bipe,
                    CASE WHEN nao_contado THEN COALESCE(diferenca_aplicada, 0) ELSE contado - estoque_no_bipe END AS dif
               FROM stock_count_items WHERE stock_count_id = ANY($1::uuid[])) d
      GROUP BY d.stock_count_id`,
    [rows.map((r) => r.id)]
  );
  const porId = new Map(resumos.map((r) => [String(r.stock_count_id).toLowerCase(), r]));
  return rows.map((r) => {
    const c = conferenciaOut(r);
    const s = porId.get(String(r.id).toLowerCase()) || {};
    // Rascunho as cegas: o resumo de faltas e sobras entregaria o estoque.
    const esconder = c.status === 'rascunho' && c.as_cegas;
    const n = (v) => (esconder ? null : Number(v || 0));
    const valor = (v) => (esconder ? null : arred2(Number(v || 0)));
    return {
      ...c,
      itens_contados: Number(s.itens_contados || 0),
      faltam: n(s.faltam),
      sobram: n(s.sobram),
      batem: n(s.batem),
      valor_faltam: valor(s.valor_faltam),
      valor_sobram: valor(s.valor_sobram),
    };
  });
}

// ─── obter ───────────────────────────────────────────────────
async function transferenciasDaConferencia(conn, countId) {
  const { rows } = await conn.query(
    `SELECT t.id, t.numero, t.origem_company_id, t.destino_company_id, t.criada_em, t.criada_por,
            t.observacao, t.itens_count, t.quantidade_total,
            COALESCE(cd.trade_name, cd.legal_name) AS destino_nome, u.full_name AS usuario_nome
       FROM stock_transfers t
       LEFT JOIN companies cd ON cd.id = t.destino_company_id
       LEFT JOIN users u ON u.id = t.criada_por
      WHERE t.stock_count_id = $1
      ORDER BY t.criada_em DESC, t.numero DESC`,
    [countId]
  );
  if (!rows.length) return [];
  const { rows: itens } = await conn.query(
    `SELECT transfer_id, product_id, variant_id, quantidade, nome, variante
       FROM stock_transfer_items WHERE transfer_id = ANY($1::uuid[])
      ORDER BY nome ASC NULLS LAST, variante ASC NULLS LAST, id`,
    [rows.map((r) => r.id)]
  );
  return rows.map((t) => ({
    id: t.id,
    numero: Number(t.numero),
    origem_company_id: t.origem_company_id,
    destino_company_id: t.destino_company_id,
    destino_nome: t.destino_nome || null,
    criada_em: t.criada_em,
    criada_por: t.criada_por,
    usuario_nome: t.usuario_nome || null,
    observacao: t.observacao,
    total_itens: Number(t.itens_count),
    total_pecas: Number(t.quantidade_total),
    itens: itens.filter((i) => String(i.transfer_id) === String(t.id)).map((i) => ({
      product_id: i.product_id, variant_id: i.variant_id, quantidade: Number(i.quantidade), nome: i.nome, rotulo: i.variante,
    })),
  }));
}

function itemOut(l, rotulo, mostrarEstoque) {
  const out = {
    id: l.id,
    product_id: l.product_id,
    variant_id: l.variant_id || null,
    nome: l.nome,
    variante: rotulo(l),
    codigo: codigoDaLinha(l),
    contado: Number(l.contado),
    contado_em: l.contado_em,
    atualizado_em: l.atualizado_em,
  };
  if (l.nao_contado) out.nao_contado = true;
  if (l.diferenca_aplicada !== null && l.diferenca_aplicada !== undefined) out.diferenca_aplicada = Number(l.diferenca_aplicada);
  if (mostrarEstoque) {
    out.estoque_no_bipe = Number(l.estoque_no_bipe);
    out.estoque_atual = Number(l.estoque_atual);
  }
  return out;
}

// Produtos compartilhados de OUTRA loja do grupo que a pessoa ve no
// Estoque desta loja mas que nao entram aqui (a tela avisa).
async function compartilhadosDeOutraLoja(conn, companyId) {
  const { rows } = await conn.query(
    `SELECT COUNT(*) AS n FROM products p
      WHERE p.is_active = true AND p.is_group_shared = true AND p.company_id <> $1
        AND p.company_id IN (
          SELECT id FROM companies
           WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
             SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1))`,
    [companyId]
  );
  return Number((rows[0] && rows[0].n) || 0);
}

async function obter(conn, companyId, countId) {
  const r = await buscarConferencia(conn, companyId, countId);
  if (!r) throw naoAchada();
  const c = conferenciaOut(r);
  const linhas = await itensComProduto(conn, c.id);
  const rotulo = await rotulos(conn, linhas);
  const mostrarEstoque = !(c.as_cegas && c.status === 'rascunho');
  const [escopoTotal, transferencias, compartilhados] = await Promise.all([
    contarEscopo(conn, companyId, c.escopo),
    transferenciasDaConferencia(conn, c.id),
    compartilhadosDeOutraLoja(conn, companyId),
  ]);
  return {
    conferencia: c,
    itens: linhas.map((l) => itemOut(l, rotulo, mostrarEstoque)),
    escopo_total: escopoTotal,
    compartilhados_de_outra_loja: compartilhados,
    transferencias,
  };
}

// ─── registrar item ──────────────────────────────────────────
async function produtoDaLinha(conn, companyId, productId, variantId) {
  const { rows } = await conn.query(
    `SELECT p.id, p.company_id, p.name, p.is_active, p.is_group_shared, p.unit, p.stock_qty,
            p.barcode, p.sku,
            COALESCE(NULLIF(p.weighted_avg_cost, 0), NULLIF(p.cost_price, 0)) AS custo,
            EXISTS (SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND x.is_active = true) AS tem_grade,
            v.id AS v_id, v.is_active AS v_ativa, v.stock_qty AS v_stock, v.barcode AS v_barcode,
            v.sku_suffix, v.color_name,
            COALESCE(c.trade_name, c.legal_name) AS loja_nome,
            (COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id) = (
               SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $3)) AS mesmo_grupo
       FROM products p
       JOIN companies c ON c.id = p.company_id
       LEFT JOIN product_variants v ON v.id = $2::uuid AND v.product_id = p.id
      WHERE p.id = $1`,
    [productId, variantId, companyId]
  );
  return rows[0] || null;
}

function conferirProduto(p, companyId, variantId) {
  if (!p || p.is_active === false) {
    throw new ErroDeConferencia(404, 'ITEM_NAO_ENCONTRADO', 'Não achamos esse produto no estoque desta loja.');
  }
  if (String(p.company_id).toLowerCase() !== String(companyId).toLowerCase()) {
    if (p.is_group_shared && p.mesmo_grupo) {
      throw new ErroDeConferencia(409, 'PRODUTO_DE_OUTRA_LOJA',
        `Este produto é compartilhado no grupo e o estoque dele fica na loja ${p.loja_nome || 'dona do cadastro'}. Ele entra na conferência de lá.`,
        { loja_dona: { id: p.company_id, nome: p.loja_nome || null } });
    }
    throw new ErroDeConferencia(409, 'PRODUTO_DE_OUTRA_LOJA', 'Este produto não é do estoque desta loja.');
  }
  if (txt(p.unit).toLowerCase() === 'srv') {
    throw new ErroDeConferencia(409, 'SERVICO_SEM_ESTOQUE', 'Serviço não tem estoque e não entra na conferência.');
  }
  if (variantId) {
    if (!p.v_id || p.v_ativa === false) {
      throw new ErroDeConferencia(404, 'ITEM_NAO_ENCONTRADO', 'Não achamos essa cor/tamanho neste produto.');
    }
  } else if (p.tem_grade) {
    throw new ErroDeConferencia(400, 'INFORME_A_VARIANTE', 'Este produto tem cor/tamanho. Escolha qual você está contando.');
  }
}

async function registrarItem(conn, { companyId, countId, productId, variantId, quantidade, modo }) {
  const r = await buscarConferencia(conn, companyId, countId, 'FOR SHARE');
  if (!r) throw naoAchada();
  exigirRascunho(r);
  const p = await produtoDaLinha(conn, companyId, productId, variantId);
  conferirProduto(p, companyId, variantId);
  const estoqueNoBipe = Number(variantId ? p.v_stock : p.stock_qty) || 0;
  const primeiro = modo === 'somar' ? Math.max(0, quantidade) : quantidade;
  // Snapshot so no INSERT: no conflito o estoque_no_bipe e o custo ficam.
  const { rows } = await conn.query(
    `INSERT INTO stock_count_items
       (stock_count_id, company_id, product_id, variant_id, contado, estoque_no_bipe, custo_no_bipe)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stock_count_id, product_id, (COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
     DO UPDATE SET
       contado = CASE WHEN $8::text = 'somar'
                      THEN GREATEST(0, stock_count_items.contado + $9::numeric)
                      ELSE $9::numeric END,
       atualizado_em = NOW()
     RETURNING id, (xmax = 0) AS criado`,
    [r.id, companyId, productId, variantId, primeiro, estoqueNoBipe, numOuNull(p.custo), modo, quantidade]
  );
  await conn.query(`UPDATE stock_counts SET updated_at = NOW() WHERE id = $1`, [r.id]);
  const linhas = (await itensComProduto(conn, r.id)).filter((l) => String(l.id) === String(rows[0].id));
  const rotulo = await rotulos(conn, linhas);
  const c = conferenciaOut(r);
  return {
    item: itemOut(linhas[0], rotulo, !c.as_cegas),
    primeiro_registro: !!rows[0].criado,
  };
}

async function removerItem(conn, { companyId, countId, itemId }) {
  const r = await buscarConferencia(conn, companyId, countId, 'FOR SHARE');
  if (!r) throw naoAchada();
  exigirRascunho(r);
  if (!ehUuid(itemId)) throw new ErroDeConferencia(404, 'ITEM_NAO_ENCONTRADO', 'Esse item não está nesta conferência.');
  const { rowCount } = await conn.query(
    `DELETE FROM stock_count_items WHERE id = $1 AND stock_count_id = $2`,
    [String(itemId).toLowerCase(), r.id]
  );
  if (!rowCount) throw new ErroDeConferencia(404, 'ITEM_NAO_ENCONTRADO', 'Esse item não está nesta conferência.');
  await conn.query(`UPDATE stock_counts SET updated_at = NOW() WHERE id = $1`, [r.id]);
  return { ok: true };
}

// ─── diferencas ──────────────────────────────────────────────
async function diferencas(conn, companyId, countId) {
  const r = await buscarConferencia(conn, companyId, countId);
  if (!r) throw naoAchada();
  const c = conferenciaOut(r);
  const linhas = await itensComProduto(conn, c.id);
  const contadas = new Set(linhas.map((l) => chaveDaLinha(l.product_id, l.variant_id)));
  const escopo = await linhasDoEscopo(conn, companyId, c.escopo);
  // Nao contado que importa e o que tem estoque (positivo ou negativo):
  // zerado nao muda nada ao "zerar nao contados".
  const naoContadas = c.status === 'rascunho'
    ? escopo.filter((l) => !contadas.has(chaveDaLinha(l.product_id, l.variant_id)) && Number(l.estoque_atual) !== 0)
    : [];
  const rotulo = await rotulos(conn, [...linhas, ...naoContadas]);

  const resumo = { faltam: 0, sobram: 0, batem: 0, nao_contados: naoContadas.length, valor_faltam: 0, valor_sobram: 0, itens_sem_custo: 0 };
  const itens = linhas.map((l) => {
    const diferenca = l.nao_contado
      ? Number(l.diferenca_aplicada || 0)
      : arred3(Number(l.contado) - Number(l.estoque_no_bipe));
    const custo = numOuNull(l.custo_no_bipe);
    const valor = diferenca === 0 ? 0 : (custo === null ? null : arred2(diferenca * custo));
    const grupo = grupoDaDiferenca(diferenca);
    resumo[grupo] += 1;
    if (diferenca !== 0) {
      if (custo === null) resumo.itens_sem_custo += 1;
      else if (diferenca < 0) resumo.valor_faltam += -valor;
      else resumo.valor_sobram += valor;
    }
    const out = {
      item_id: l.id,
      product_id: l.product_id,
      variant_id: l.variant_id || null,
      nome: l.nome,
      variante: rotulo(l),
      codigo: codigoDaLinha(l),
      contado: Number(l.contado),
      estoque_no_bipe: Number(l.estoque_no_bipe),
      estoque_atual: Number(l.estoque_atual),
      diferenca,
      estoque_depois: arred3(Math.max(0, Number(l.estoque_atual) + diferenca)),
      custo,
      valor,
      grupo,
    };
    if (l.nao_contado) out.nao_contado = true;
    if (l.diferenca_aplicada !== null && l.diferenca_aplicada !== undefined) out.diferenca_aplicada = Number(l.diferenca_aplicada);
    return out;
  });
  resumo.valor_faltam = arred2(resumo.valor_faltam);
  resumo.valor_sobram = arred2(resumo.valor_sobram);

  return {
    conferencia: c,
    resumo,
    itens,
    nao_contados: naoContadas.map((l) => ({
      product_id: l.product_id,
      variant_id: l.variant_id || null,
      nome: l.nome,
      variante: rotulo(l),
      codigo: codigoDaLinha(l),
      estoque_atual: Number(l.estoque_atual),
      custo: numOuNull(l.custo),
    })),
  };
}

// ─── estoque: trava, le e grava ──────────────────────────────
async function travarLinhas(conn, companyId, pids, vids) {
  const prod = pids.length ? (await conn.query(
    `SELECT id, stock_qty, is_active FROM products
      WHERE id = ANY($1::uuid[]) AND company_id = $2
      ORDER BY id FOR UPDATE`,
    [pids, companyId]
  )).rows : [];
  const vars = vids.length ? (await conn.query(
    `SELECT v.id, v.product_id, v.stock_qty, v.is_active FROM product_variants v
      WHERE v.id = ANY($1::uuid[])
        AND v.product_id IN (SELECT id FROM products WHERE company_id = $2)
      ORDER BY v.id FOR UPDATE`,
    [vids, companyId]
  )).rows : [];
  return {
    prod: new Map(prod.map((r) => [String(r.id).toLowerCase(), r])),
    vars: new Map(vars.map((r) => [String(r.id).toLowerCase(), r])),
  };
}

// Soma a diferenca sobre o estoque de agora (linhas ja travadas: o valor
// lido e o que o UPDATE enxerga), com o mesmo piso 0.
async function somarNoEstoque(conn, companyId, ajustes) {
  const prod = ajustes.filter((a) => !a.variant_id && a.efetiva !== 0);
  const vars = ajustes.filter((a) => a.variant_id && a.efetiva !== 0);
  if (prod.length) {
    await conn.query(
      `UPDATE products t SET stock_qty = GREATEST(0, t.stock_qty + u.d), updated_at = NOW()
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, d)
        WHERE t.id = u.id AND t.company_id = $3`,
      [prod.map((a) => a.product_id), prod.map((a) => a.efetiva), companyId]
    );
  }
  if (vars.length) {
    await conn.query(
      `UPDATE product_variants t SET stock_qty = GREATEST(0, t.stock_qty + u.d), updated_at = NOW()
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, d)
        WHERE t.id = u.id`,
      [vars.map((a) => a.variant_id), vars.map((a) => a.efetiva)]
    );
  }
}

async function lancarMovimentos(conn, { companyId, countId, referenceType, notas, ajustes }) {
  const lista = ajustes.filter((a) => a.efetiva !== 0);
  if (!lista.length) return 0;
  await conn.query(
    `INSERT INTO stock_movements
       (product_id, company_id, type, quantity, variant_id, unit_cost, notes, reference_id, reference_type)
     SELECT m.p, $1, 'adjustment', m.q, m.v, m.c, $2, $3, $4
       FROM unnest($5::uuid[], $6::numeric[], $7::uuid[], $8::numeric[]) AS m(p, q, v, c)`,
    [companyId, notas, countId, referenceType,
      lista.map((a) => a.product_id), lista.map((a) => Math.abs(a.efetiva)),
      lista.map((a) => a.variant_id || null), lista.map((a) => (a.custo === undefined ? null : a.custo))]
  );
  return lista.length;
}

const notaDaConferencia = (c) => `Conferência nº ${c.numero}${c.motivo ? ` · ${c.motivo}` : ''}`;

// ─── aplicar ─────────────────────────────────────────────────
/**
 * Roda DENTRO de uma transacao aberta pelo chamador.
 * `ignorarItemIds`: itens que a pessoa desmarcou na tela de diferencas
 * (ficam como estao, diferenca_aplicada nula).
 */
async function aplicar(conn, { companyId, countId, userId, zerarNaoContados = false, ignorarItemIds = [], motivo }) {
  const r = await buscarConferencia(conn, companyId, countId, 'FOR UPDATE');
  if (!r) throw naoAchada();
  if (r.status === 'aplicada') {
    throw new ErroDeConferencia(409, 'JA_APLICADA', 'Esta conferência já foi aplicada.', { conferencia: conferenciaOut(r) });
  }
  exigirRascunho(r);
  const c = conferenciaOut(r);
  if (motivo !== undefined) c.motivo = lerMotivo(motivo);

  const ignorar = new Set((ignorarItemIds || []).map((x) => String(x).toLowerCase()));
  const { rows: itens } = await conn.query(
    `SELECT id, product_id, variant_id, contado, estoque_no_bipe, custo_no_bipe
       FROM stock_count_items WHERE stock_count_id = $1 AND NOT nao_contado
      ORDER BY id`,
    [c.id]
  );
  const contadas = new Set(itens.map((i) => chaveDaLinha(i.product_id, i.variant_id)));
  const naoContadas = zerarNaoContados
    ? (await linhasDoEscopo(conn, companyId, c.escopo))
      .filter((l) => !contadas.has(chaveDaLinha(l.product_id, l.variant_id)))
    : [];

  const pids = [...new Set([...itens, ...naoContadas].map((l) => String(l.product_id).toLowerCase()))];
  const vids = [...new Set([...itens, ...naoContadas].filter((l) => l.variant_id).map((l) => String(l.variant_id).toLowerCase()))];
  const travadas = await travarLinhas(conn, companyId, pids, vids);
  const atualDe = (pid, vid) => {
    const p = travadas.prod.get(String(pid).toLowerCase());
    if (!p || p.is_active === false) return null;
    if (!vid) return Number(p.stock_qty) || 0;
    const v = travadas.vars.get(String(vid).toLowerCase());
    if (!v || v.is_active === false || String(v.product_id).toLowerCase() !== String(pid).toLowerCase()) return null;
    return Number(v.stock_qty) || 0;
  };

  const ajustes = [];
  const ignorados = [];
  for (const it of itens) {
    const atual = atualDe(it.product_id, it.variant_id);
    if (ignorar.has(String(it.id).toLowerCase())) { ignorados.push({ item_id: it.id, motivo: 'desmarcado' }); continue; }
    if (atual === null) { ignorados.push({ item_id: it.id, motivo: 'produto_indisponivel' }); continue; }
    const a = calcularAjuste({ contado: it.contado, estoqueNoBipe: it.estoque_no_bipe, estoqueAtual: atual });
    ajustes.push({ item_id: it.id, product_id: it.product_id, variant_id: it.variant_id, efetiva: a.aplicada, custo: numOuNull(it.custo_no_bipe) });
  }
  const zerados = [];
  for (const l of naoContadas) {
    const atual = atualDe(l.product_id, l.variant_id);
    if (atual === null || atual === 0) continue;
    const z = calcularZerar(atual);
    zerados.push({ product_id: l.product_id, variant_id: l.variant_id, atual, efetiva: z.aplicada, custo: numOuNull(l.custo) });
  }

  await somarNoEstoque(conn, companyId, [...ajustes, ...zerados]);
  const movimentos = await lancarMovimentos(conn, {
    companyId, countId: c.id, referenceType: 'stock_count', notas: notaDaConferencia(c), ajustes: [...ajustes, ...zerados],
  });

  if (ajustes.length) {
    await conn.query(
      `UPDATE stock_count_items i SET diferenca_aplicada = u.d
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, d)
        WHERE i.id = u.id AND i.stock_count_id = $3`,
      [ajustes.map((a) => a.item_id), ajustes.map((a) => a.efetiva), c.id]
    );
  }
  if (zerados.length) {
    await conn.query(
      `INSERT INTO stock_count_items
         (stock_count_id, company_id, product_id, variant_id, contado, estoque_no_bipe, custo_no_bipe, diferenca_aplicada, nao_contado)
       SELECT $1, $2, z.p, z.v, 0, z.e, z.c, z.d, true
         FROM unnest($3::uuid[], $4::uuid[], $5::numeric[], $6::numeric[], $7::numeric[]) AS z(p, v, e, c, d)`,
      [c.id, companyId, zerados.map((z) => z.product_id), zerados.map((z) => z.variant_id || null),
        zerados.map((z) => z.atual), zerados.map((z) => z.custo), zerados.map((z) => z.efetiva)]
    );
  }
  await conn.query(
    `UPDATE stock_counts
        SET status = 'aplicada', aplicada_por = $2, aplicada_em = NOW(), zerou_nao_contados = $3,
            motivo = $4, updated_at = NOW()
      WHERE id = $1`,
    [c.id, userId || null, !!zerarNaoContados, c.motivo]
  );
  return {
    conferencia: conferenciaOut(await buscarConferencia(conn, companyId, c.id)),
    ajustados: ajustes.filter((a) => a.efetiva !== 0).length + zerados.length,
    sem_mudanca: ajustes.filter((a) => a.efetiva === 0).length,
    zerados: zerados.length,
    ignorados,
    movimentos,
  };
}

// ─── desfazer ────────────────────────────────────────────────
async function desfazer(conn, { companyId, countId, userId }) {
  const r = await buscarConferencia(conn, companyId, countId, 'FOR UPDATE');
  if (!r) throw naoAchada();
  if (r.status === 'desfeita') {
    throw new ErroDeConferencia(409, 'JA_DESFEITA', 'Esta conferência já foi desfeita.', { conferencia: conferenciaOut(r) });
  }
  if (r.status !== 'aplicada') {
    throw new ErroDeConferencia(409, 'NAO_APLICADA', 'Só dá para desfazer uma conferência que já foi aplicada.', { status: r.status });
  }
  if (!r.dentro_do_prazo) {
    throw new ErroDeConferencia(409, 'PRAZO_ENCERRADO',
      `O prazo para desfazer esta conferência terminou (${DIAS_PARA_DESFAZER} dias depois de aplicar). Se algo ficou errado, faça uma nova conferência desses itens.`);
  }
  const c = conferenciaOut(r);
  const { rows: itens } = await conn.query(
    `SELECT id, product_id, variant_id, diferenca_aplicada, custo_no_bipe
       FROM stock_count_items
      WHERE stock_count_id = $1 AND diferenca_aplicada IS NOT NULL AND diferenca_aplicada <> 0
      ORDER BY id`,
    [c.id]
  );
  const pids = [...new Set(itens.map((i) => String(i.product_id).toLowerCase()))];
  const vids = [...new Set(itens.filter((i) => i.variant_id).map((i) => String(i.variant_id).toLowerCase()))];
  const travadas = await travarLinhas(conn, companyId, pids, vids);
  const voltas = [];
  for (const it of itens) {
    const p = travadas.prod.get(String(it.product_id).toLowerCase());
    if (!p) continue;
    let atual = Number(p.stock_qty) || 0;
    if (it.variant_id) {
      const v = travadas.vars.get(String(it.variant_id).toLowerCase());
      if (!v) continue;
      atual = Number(v.stock_qty) || 0;
    }
    const d = calcularDesfazer({ estoqueAtual: atual, diferencaAplicada: it.diferenca_aplicada });
    voltas.push({ item_id: it.id, product_id: it.product_id, variant_id: it.variant_id, efetiva: d.efetiva, custo: numOuNull(it.custo_no_bipe) });
  }
  await somarNoEstoque(conn, companyId, voltas);
  const movimentos = await lancarMovimentos(conn, {
    companyId, countId: c.id, referenceType: 'stock_count_undo', notas: `Desfeito: conferência nº ${c.numero}`, ajustes: voltas,
  });
  if (voltas.length) {
    await conn.query(
      `UPDATE stock_count_items i SET diferenca_desfeita = u.d
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, d)
        WHERE i.id = u.id AND i.stock_count_id = $3`,
      [voltas.map((v) => v.item_id), voltas.map((v) => v.efetiva), c.id]
    );
  }
  await conn.query(
    `UPDATE stock_counts SET status = 'desfeita', desfeita_por = $2, desfeita_em = NOW(), updated_at = NOW() WHERE id = $1`,
    [c.id, userId || null]
  );
  return {
    conferencia: conferenciaOut(await buscarConferencia(conn, companyId, c.id)),
    revertidos: voltas.filter((v) => v.efetiva !== 0).length,
    movimentos,
  };
}

// ─── descartar ───────────────────────────────────────────────
async function descartar(conn, { companyId, countId, userId, podeEditar }) {
  const r = await buscarConferencia(conn, companyId, countId, 'FOR UPDATE');
  if (!r) throw naoAchada();
  exigirRascunho(r);
  if (!podeEditar && String(r.criada_por || '') !== String(userId || '')) {
    throw new ErroDeConferencia(403, 'SEM_PERMISSAO_DE_EDITAR',
      'Só quem começou esta conferência ou quem pode editar o estoque consegue descartá-la.');
  }
  await conn.query(`UPDATE stock_counts SET status = 'descartada', updated_at = NOW() WHERE id = $1`, [r.id]);
  return { conferencia: conferenciaOut(await buscarConferencia(conn, companyId, r.id)) };
}

// ─── transferencia a partir da conferencia ───────────────────
// A conferencia precisa ser da loja de ORIGEM (e nao descartada).
async function conferirConferenciaDaTransferencia(conn, origemId, stockCountId) {
  if (!ehUuid(stockCountId)) {
    throw new ErroDeConferencia(400, 'CONFERENCIA_INVALIDA', 'Essa conferência não é da loja de origem.');
  }
  const { rows } = await conn.query(
    `SELECT id, status FROM stock_counts WHERE id = $1 AND company_id = $2`,
    [String(stockCountId).toLowerCase(), origemId]
  );
  if (!rows[0] || rows[0].status === 'descartada') {
    throw new ErroDeConferencia(400, 'CONFERENCIA_INVALIDA', 'Essa conferência não é da loja de origem.');
  }
  return rows[0].id;
}

module.exports = {
  DIAS_PARA_DESFAZER,
  ErroDeConferencia,
  calcularAjuste,
  calcularZerar,
  calcularDesfazer,
  grupoDaDiferenca,
  lerEscopo,
  lerCriacao,
  lerRegistro,
  lerMotivo,
  criar,
  listar,
  obter,
  registrarItem,
  removerItem,
  diferencas,
  aplicar,
  desfazer,
  descartar,
  conferirConferenciaDaTransferencia,
};
