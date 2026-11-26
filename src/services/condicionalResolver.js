// ============================================================
// AURA. — Venda condicional: pecas para resolver (C16, 26/11/2026)
//
// A peca que voltou com defeito ou sem etiqueta ('voltou_defeito',
// resolved_at NULL, migrations 468/470) nao e livre. A lojista decide:
//   voltar_estoque  a peca volta a contar como livre. Grava resolved_at,
//                   resolved_by e resolved_acao; o estoque fisico NAO muda
//                   (a peca nunca saiu dele). Pode ser desfeita em
//                   JANELA_DESFAZER_S segundos, e so se nada mudou depois.
//   baixa           grava o mesmo E da baixa de 1 unidade no estoque, pelo
//                   caminho do ajuste que ja existe (conferencia de estoque):
//                   stock_movements type 'adjustment', quantity positiva,
//                   reference_type 'condicional_baixa', reference_id = a
//                   peca, variant_id e a nota com o motivo. Piso 0, como
//                   todo ajuste: estoque ja zerado nao gera movimento.
//
//   GET  …/condicionais/para-resolver          {pecas, total}
//   POST …/condicionais/itens/:itemId/resolver {acao, motivo?, motivo_texto?}
//   POST …/condicionais/itens/:itemId/resolver/desfazer
//
// Mesma transacao do C9 (condicionalDecidir.naCondicional): condicional
// FOR UPDATE e depois os itens (a mesma ordem), Idempotency-Key nos eventos.
// Resolve tambem peca de condicional ja encerrada (e onde ela costuma estar)
// e NAO encerra nada. Peca de produto compartilhado do grupo baixa o estoque
// da empresa dona do produto.
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');
const c = require('./condicional');
const decidir = require('./condicionalDecidir');

const { erro } = c;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACOES = ['voltar_estoque', 'baixa'];
const MOTIVOS = { defeito: 'Defeito', sem_etiqueta: 'Sem etiqueta', perda: 'Perda', outro: 'Outro' };
const TEXTO_MAX = 200;
const JANELA_DESFAZER_S = 60;

const assinar = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

/** Corpo do resolver. Devolve { acao, motivo, motivo_texto } ou lanca 422. */
function lerResolucao(body) {
  const b = body || {};
  const acao = typeof b.acao === 'string' ? b.acao.trim() : '';
  if (!ACOES.includes(acao)) {
    throw erro(422, 'Escolha o que fazer com a peça: voltar ao estoque ou dar baixa.', 'COND_RESOLVER_ACAO');
  }
  if (acao === 'voltar_estoque') return { acao, motivo: null, motivo_texto: null };
  const motivo = typeof b.motivo === 'string' ? b.motivo.trim() : '';
  if (!MOTIVOS[motivo]) throw erro(422, 'Diga o motivo da baixa.', 'COND_RESOLVER_MOTIVO');
  const texto = c.textoLimpo(b.motivo_texto, TEXTO_MAX);
  if (motivo === 'outro' && !texto) throw erro(422, 'Escreva qual foi o motivo.', 'COND_RESOLVER_MOTIVO');
  return { acao, motivo, motivo_texto: texto || null };
}

/** Nota do movimento de estoque. */
function notaDaBaixa({ numero, motivo, motivo_texto: texto, defect_note: nota }) {
  const partes = [`Baixa de peça da condicional ${c.numeroExibicao(numero)}`, MOTIVOS[motivo]];
  if (motivo === 'outro' && texto) partes[1] = `Outro: ${texto}`;
  else if (texto) partes.push(texto);
  if (nota) partes.push(`Anotação: ${nota}`);
  return partes.join(' · ');
}

const SQL_LISTA = `
  SELECT i.id AS item_id, i.condicional_id, c.company_id, c.numero, c.customer_name, c.status,
         i.product_id, i.variant_id, i.product_name, i.variant_label, i.color_name, i.size_label,
         i.defect_note, i.decided_at,
         CASE WHEN i.variant_id IS NOT NULL THEN v.stock_qty ELSE p.stock_qty END AS estoque
    FROM condicional_itens i
    JOIN condicionais c ON c.id = i.condicional_id
    LEFT JOIN products p ON p.id = i.product_id
    LEFT JOIN product_variants v ON v.id = i.variant_id
   WHERE c.company_id = ANY($1::uuid[])
     AND i.situacao = 'voltou_defeito'
     AND i.resolved_at IS NULL
     AND i.sale_id IS NULL
     AND c.status <> 'cancelada'
   ORDER BY i.decided_at DESC NULLS LAST, c.numero, i.id`;

/** Pecas para resolver das lojas pedidas. { pecas, total }. */
async function listarParaResolver(q, { empresas }) {
  const ids = (empresas || []).map(String).filter((e) => UUID_RE.test(e));
  if (!ids.length) return { pecas: [], total: 0 };
  const { rows } = await q.query(SQL_LISTA, [ids]);
  const pecas = rows.map((r) => ({
    item_id: r.item_id,
    condicional_id: r.condicional_id,
    company_id: r.company_id,
    numero: Number(r.numero),
    numero_exibicao: c.numeroExibicao(r.numero),
    customer_name: r.customer_name,
    product_id: r.product_id,
    variant_id: r.variant_id || null,
    product_name: r.product_name,
    variant_label: r.variant_label || null,
    color_name: r.color_name || null,
    size_label: r.size_label || null,
    nota: r.defect_note || null,
    voltou_em: r.decided_at || null,
    // Estoque de agora da peca (variante, se tiver): a janela da baixa diz "de 4 para 3".
    estoque: r.estoque === null || r.estoque === undefined ? null : Number(r.estoque),
  }));
  return { pecas, total: pecas.length };
}

async function condicionalDaPeca(companyId, itemId) {
  if (!UUID_RE.test(String(itemId || ''))) throw erro(404, 'Peça não encontrada.', 'COND_PECA_NAO_ENCONTRADA');
  const { rows: [r] } = await db.query(
    `SELECT i.condicional_id FROM condicional_itens i JOIN condicionais c ON c.id = i.condicional_id
      WHERE i.id = $1 AND c.company_id = $2`,
    [String(itemId).toLowerCase(), companyId]
  );
  if (!r) throw erro(404, 'Peça não encontrada.', 'COND_PECA_NAO_ENCONTRADA', { item_id: itemId });
  return r.condicional_id;
}

async function travarProduto(client, productId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('condicional-peca:' || $1::text))`, [String(productId)]);
}

/** Baixa de 1 unidade (piso 0) e o movimento. Devolve quantas unidades sairam de fato (0 ou 1). */
async function darBaixa(client, it, { motivo, motivo_texto: texto, numero }) {
  await travarProduto(client, it.product_id);
  const { rows: [p] } = await client.query(`SELECT company_id, stock_qty FROM products WHERE id = $1 FOR UPDATE`, [it.product_id]);
  if (!p) return 0;
  let atual;
  if (it.variant_id) {
    const { rows: [v] } = await client.query(
      `SELECT stock_qty FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE`, [it.variant_id, it.product_id]);
    atual = v ? Number(v.stock_qty) || 0 : 0;
  } else {
    atual = Number(p.stock_qty) || 0;
  }
  if (atual < 1) return 0;
  if (it.variant_id) {
    await client.query(`UPDATE product_variants SET stock_qty = stock_qty - 1, updated_at = NOW() WHERE id = $1`, [it.variant_id]);
  } else {
    await client.query(`UPDATE products SET stock_qty = stock_qty - 1, updated_at = NOW() WHERE id = $1`, [it.product_id]);
  }
  await client.query(
    `INSERT INTO stock_movements (product_id, company_id, type, quantity, variant_id, notes, reference_id, reference_type)
     VALUES ($1, $2, 'adjustment', 1, $3, $4, $5, 'condicional_baixa')`,
    [it.product_id, p.company_id, it.variant_id || null,
      notaDaBaixa({ numero, motivo, motivo_texto: texto, defect_note: it.defect_note }), it.id]
  );
  return 1;
}

/** Resolver a peca. Devolve { condicional, repetido, item_id, acao, desfazer_ate_s }. */
async function resolverPeca({ companyId, itemId, userId, body, chave, hoje, agora }) {
  const lido = lerResolucao(body);
  const id = String(itemId || '').toLowerCase();
  const condId = await condicionalDaPeca(companyId, id);
  const assinatura = assinar([id, lido.acao, lido.motivo, lido.motivo_texto]);
  return decidir.naCondicional({ companyId, condId, chave, op: 'resolver', assinatura, userId, hoje, agora }, async ({ client, cond, itens, evento }) => {
    const it = itens.find((x) => String(x.id) === id);
    if (!it) throw erro(404, 'Peça não encontrada.', 'COND_PECA_NAO_ENCONTRADA', { item_id: id });
    if (it.sale_id || it.situacao !== 'voltou_defeito') {
      throw erro(409, 'Esta peça não está em Peças para resolver.', 'COND_PECA_NAO_RESOLVER', { item_id: id });
    }
    if (it.resolved_at) {
      throw erro(409, 'Esta peça já foi resolvida. Atualize a lista.', 'COND_PECA_JA_RESOLVIDA', { item_id: id });
    }
    let efetivo = null;
    if (lido.acao === 'baixa') efetivo = await darBaixa(client, it, { ...lido, numero: cond.numero });
    await client.query(
      `UPDATE condicional_itens SET resolved_at = NOW(), resolved_by = $2, resolved_acao = $3 WHERE id = $1`,
      [id, userId || null, lido.acao]
    );
    await evento(lido.acao === 'baixa' ? 'resolvida_baixa' : 'resolvida_voltou', id, {
      acao: lido.acao,
      product_name: it.product_name,
      variant_label: it.variant_label || null,
      ...(lido.acao === 'baixa'
        ? { motivo: lido.motivo, ...(lido.motivo_texto ? { motivo_texto: lido.motivo_texto } : {}), baixa_efetiva: efetivo }
        : {}),
    });
    return {
      motivoEncerrar: false,
      extra: { item_id: id, acao: lido.acao, desfazer_ate_s: lido.acao === 'voltar_estoque' ? JANELA_DESFAZER_S : null },
    };
  });
}

/** Desfazer o "voltar ao estoque" por poucos segundos, se nada mudou depois. */
async function desfazerResolucao({ companyId, itemId, userId, chave, hoje, agora }) {
  const id = String(itemId || '').toLowerCase();
  const condId = await condicionalDaPeca(companyId, id);
  return decidir.naCondicional({ companyId, condId, chave, op: 'desfazer_resolucao', assinatura: assinar([id]), userId, hoje, agora }, async ({ client, itens, evento }) => {
    const it = itens.find((x) => String(x.id) === id);
    if (!it) throw erro(404, 'Peça não encontrada.', 'COND_PECA_NAO_ENCONTRADA', { item_id: id });
    if (!it.resolved_at) throw erro(409, 'Esta peça já está em Peças para resolver.', 'COND_DESFAZER_NADA', { item_id: id });
    const { rows: [r] } = await client.query(
      `SELECT i.resolved_acao,
              (i.resolved_at >= NOW() - ($2::int * interval '1 second')) AS na_janela,
              EXISTS (SELECT 1 FROM condicional_eventos e
                       WHERE e.item_id = i.id AND e.tipo <> 'resolvida_voltou' AND e.created_at > i.resolved_at) AS mudou
         FROM condicional_itens i WHERE i.id = $1`,
      [id, JANELA_DESFAZER_S]
    );
    if (r.resolved_acao !== 'voltar_estoque') {
      throw erro(409, 'Só dá para desfazer "Voltar ao estoque". Uma baixa já saiu do estoque.', 'COND_DESFAZER_BAIXA', { item_id: id });
    }
    if (!r.na_janela || r.mudou) {
      throw erro(409, 'Passou o tempo de desfazer. A peça já está livre no estoque.', 'COND_DESFAZER_EXPIRADO', { item_id: id });
    }
    await client.query(`UPDATE condicional_itens SET resolved_at = NULL, resolved_by = NULL, resolved_acao = NULL WHERE id = $1`, [id]);
    await evento('resolucao_desfeita', id, { product_name: it.product_name, variant_label: it.variant_label || null });
    return { motivoEncerrar: false, extra: { item_id: id } };
  });
}

module.exports = {
  ACOES, MOTIVOS, JANELA_DESFAZER_S,
  lerResolucao, notaDaBaixa, listarParaResolver, resolverPeca, desfazerResolucao,
};
