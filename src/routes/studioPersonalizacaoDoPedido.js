// ============================================================
// AURA. — Folha "Recolher a arte e o texto" da Fila de produção (p-177)
//
// Mount em private.js sob /studio, como as outras rotas do quadro:
//   GET  /companies/:id/studio/orders/:oid/personalizacao
//   POST /companies/:id/studio/orders/:oid/personalizacao
//
// Para que serve: o Caixa do Negócio não pede o texto nem a arte na hora da
// venda. Com a frente Personalizados ligada no Negócio, a venda de peça
// personalizável cai em "Aguardando personalização" (migration 456) e a
// lojista registra depois, pela Fila (app, p-176), a arte e o texto de cada
// item. Ao salvar, o pedido segue para "Aguardando arte" (pending_art).
//
// O que reusa do Studio (e não muda nele):
//   - o pedido vem da view studio_orders, igual ao quadro (GET /orders);
//   - o customization é o mesmo objeto plano { [field.id]: valor } que a
//     vitrine e o Caixa do Studio gravam, com a mesma limpeza das chaves de
//     ajuste (sanitizarAjustesDaArte), igual ao PATCH
//     /studio/sale-items/:id/customization;
//   - a arte é a URL devolvida pelo POST /studio/upload-mockup.
// Nenhuma rota existente do Studio foi alterada.
//
// Diferença de propósito em relação ao PATCH por item: aqui a gravação dos
// itens e a mudança de etapa vão numa transação só, com o pedido travado.
// Sem isso, dois cliques (ou duas abas) gravariam a arte e deixariam o
// pedido parado em "Aguardando personalização", ou o moveriam sem arte.
//
// Escopo: pedido do Caixa (source 'pdv') e da loja online (source
// 'digital'). Marketplace tem rota própria (PATCH
// /studio/marketplace-orders/:oid/customization) e fica de fora (D7).
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { sanitizarAjustesDaArte } = require('../services/ajusteDaArte');

const ETAPA_SEM_PERSONALIZACAO = 'awaiting_customization';
const ETAPA_SEGUINTE = 'pending_art';
const MAX_ITENS = 200;

function ehObjeto(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function configValida(cfg) {
  return ehObjeto(cfg) && Array.isArray(cfg.fields) ? cfg : null;
}

// p-184: temPersonalizacao mora em services/personalizavel.js, porque o
// pedido da loja comum usa a mesma conta para escolher a etapa da Fila.
const { temPersonalizacao } = require('../services/personalizavel');

/** Corpo do POST validado, ou { erro }. Pura. */
function lerCorpo(body) {
  const b = ehObjeto(body) ? body : {};
  const itens = b.itens;
  if (!Array.isArray(itens) || !itens.length) {
    return { erro: 'Envie a arte e o texto de pelo menos um item (itens).', codigo: 'ITENS_OBRIGATORIOS' };
  }
  if (itens.length > MAX_ITENS) {
    return { erro: `No máximo ${MAX_ITENS} itens por vez.`, codigo: 'ITENS_DEMAIS' };
  }
  const vistos = new Set();
  const limpos = [];
  for (const it of itens) {
    const id = ehObjeto(it) && (typeof it.id === 'string' || typeof it.id === 'number') ? String(it.id).trim() : '';
    if (!id) return { erro: 'Cada item precisa do id do item do pedido.', codigo: 'ITEM_SEM_ID' };
    if (!ehObjeto(it.customization)) {
      return { erro: 'customization (objeto JSON) obrigatório em cada item.', codigo: 'CUSTOMIZATION_INVALIDA' };
    }
    if (vistos.has(id)) return { erro: 'O mesmo item veio duas vezes.', codigo: 'ITEM_REPETIDO' };
    vistos.add(id);
    limpos.push({ id, customization: it.customization });
  }
  // Sem `avancar`, avança: é o botão principal da folha. `avancar: false`
  // só guarda (a lojista ainda espera a arte do cliente).
  const avancar = b.avancar === undefined ? true : b.avancar !== false;
  return { itens: limpos, avancar };
}

// ── Onde mora cada origem ────────────────────────────────────────────────
// Tudo escopado pela empresa. Os ids saem do banco com o tipo nativo; a
// comparação com o que veio do app é feita por texto, em JS.
const ORIGENS = {
  pdv: {
    travar: `SELECT id, studio_production_status
               FROM sales
              WHERE id = $1 AND company_id = $2
              FOR UPDATE`,
    itens: `SELECT si.id, si.product_id,
                   COALESCE(NULLIF(TRIM(si.product_name_snapshot), ''), p.name) AS product_name,
                   si.quantity, si.customization,
                   COALESCE(p.is_personalizable, false) AS is_personalizable,
                   p.customization_config
              FROM sale_items si
              LEFT JOIN products p ON p.id = si.product_id
             WHERE si.sale_id = $1
             ORDER BY si.id`,
    gravarItem: `UPDATE sale_items SET customization = $1::jsonb WHERE id = $2 AND sale_id = $3`,
    avancar: `UPDATE sales
                 SET studio_production_status = '${ETAPA_SEGUINTE}', updated_at = NOW()
               WHERE id = $1 AND company_id = $2
                 AND studio_production_status = '${ETAPA_SEM_PERSONALIZACAO}'
               RETURNING studio_production_status`,
    idDoPedido: (head) => head.pdv_sale_id,
  },
  digital: {
    travar: `SELECT id, studio_production_status, status
               FROM digital_orders
              WHERE id = $1 AND company_id = $2 AND vertical = 'studio'
              FOR UPDATE`,
    itens: `SELECT doi.id, doi.product_id,
                   COALESCE(NULLIF(TRIM(doi.product_name), ''), p.name) AS product_name,
                   doi.quantity, doi.customization,
                   COALESCE(p.is_personalizable, false) AS is_personalizable,
                   p.customization_config
              FROM digital_order_items doi
              LEFT JOIN products p ON p.id = doi.product_id
             WHERE doi.order_id = $1
             ORDER BY doi.id`,
    gravarItem: `UPDATE digital_order_items SET customization = $1::jsonb WHERE id = $2 AND order_id = $3`,
    avancar: `UPDATE digital_orders
                 SET studio_production_status = '${ETAPA_SEGUINTE}', updated_at = NOW()
               WHERE id = $1 AND company_id = $2 AND vertical = 'studio'
                 AND studio_production_status = '${ETAPA_SEM_PERSONALIZACAO}'
               RETURNING studio_production_status`,
    idDoPedido: (head) => head.digital_order_id,
  },
};

function itemDaResposta(r) {
  return {
    id: r.id,
    product_id: r.product_id || null,
    product_name: r.product_name || null,
    quantity: r.quantity == null ? null : Number(r.quantity),
    is_personalizable: r.is_personalizable === true,
    customization_config: configValida(r.customization_config),
    customization: ehObjeto(r.customization) ? r.customization : null,
    tem_personalizacao: temPersonalizacao(r.customization, r.customization_config),
  };
}

async function cabecaDoPedido(oid, cid) {
  const { rows } = await db.query(
    `SELECT id, source, status, studio_production_status, customer_name, display_name,
            digital_order_id, pdv_sale_id
       FROM studio_orders
      WHERE id = $1 AND company_id = $2
      LIMIT 1`,
    [oid, cid]
  );
  return rows[0] || null;
}

function recusaDaOrigem(head) {
  if (head.source === 'marketplace') {
    return {
      status: 409,
      body: {
        error: 'Pedido de marketplace tem a personalização recolhida pela tela do marketplace.',
        code: 'MARKETPLACE_USA_OUTRA_ROTA',
      },
    };
  }
  if (!ORIGENS[head.source]) {
    return { status: 409, body: { error: 'Origem do pedido não suportada.', code: 'ORIGEM_NAO_SUPORTADA' } };
  }
  if (String(head.status || '') === 'cancelled') {
    return {
      status: 409,
      body: { error: 'Este pedido foi cancelado e não volta para a produção.', code: 'order_cancelled' },
    };
  }
  return null;
}

// ─── GET: o que a folha mostra ───────────────────────────────────────────
router.get('/orders/:oid/personalizacao', async (req, res) => {
  const cid = req.params.id;
  try {
    const head = await cabecaDoPedido(req.params.oid, cid);
    if (!head) return res.status(404).json({ error: 'Pedido não encontrado', code: 'PEDIDO_NAO_ENCONTRADO' });
    const recusa = recusaDaOrigem(head);
    if (recusa) return res.status(recusa.status).json(recusa.body);

    const origem = ORIGENS[head.source];
    const { rows } = await db.query(origem.itens, [origem.idDoPedido(head)]);
    const itens = rows.map(itemDaResposta);
    return res.json({
      order: {
        id: head.id,
        source: head.source,
        studio_production_status: head.studio_production_status || null,
        customer_name: head.customer_name || null,
        display_name: head.display_name || null,
      },
      itens,
      faltam: itens.filter((i) => i.is_personalizable && !i.tem_personalizacao).map((i) => i.id),
    });
  } catch (err) {
    console.error('[studio/orders/:oid/personalizacao GET]', err.message);
    return res.status(500).json({ error: 'Erro ao abrir a personalização do pedido' });
  }
});

// ─── POST: grava a arte e o texto e move a etapa ─────────────────────────
router.post('/orders/:oid/personalizacao', async (req, res) => {
  const cid = req.params.id;
  const corpo = lerCorpo(req.body);
  if (corpo.erro) return res.status(400).json({ error: corpo.erro, code: corpo.codigo });

  let head;
  try {
    head = await cabecaDoPedido(req.params.oid, cid);
  } catch (err) {
    console.error('[studio/orders/:oid/personalizacao POST][head]', err.message);
    return res.status(500).json({ error: 'Erro ao salvar a personalização do pedido' });
  }
  if (!head) return res.status(404).json({ error: 'Pedido não encontrado', code: 'PEDIDO_NAO_ENCONTRADO' });
  const recusa = recusaDaOrigem(head);
  if (recusa) return res.status(recusa.status).json(recusa.body);

  const origem = ORIGENS[head.source];
  const pedidoId = origem.idDoPedido(head);
  let client;
  let aberta = false;
  const desfazer = async () => {
    if (aberta) { try { await client.query('ROLLBACK'); } catch (_) { /* conexão caiu */ } }
    aberta = false;
  };
  try {
    client = await db.connect();
    await client.query('BEGIN');
    aberta = true;

    // Trava o pedido: a segunda requisição espera a primeira terminar.
    const trava = await client.query(origem.travar, [pedidoId, cid]);
    if (!trava.rows.length) {
      await desfazer();
      return res.status(404).json({ error: 'Pedido não encontrado', code: 'PEDIDO_NAO_ENCONTRADO' });
    }
    if (String(trava.rows[0].status || '') === 'cancelled') {
      await desfazer();
      return res.status(409).json({ error: 'Este pedido foi cancelado e não volta para a produção.', code: 'order_cancelled' });
    }
    const etapaAntes = trava.rows[0].studio_production_status || null;

    const { rows: doPedido } = await client.query(origem.itens, [pedidoId]);
    const porId = new Map(doPedido.map((r) => [String(r.id), r]));

    const fora = corpo.itens.filter((it) => !porId.has(it.id)).map((it) => it.id);
    if (fora.length) {
      await desfazer();
      return res.status(404).json({
        error: 'Item que não é deste pedido.',
        code: 'ITEM_FORA_DO_PEDIDO',
        itens: fora,
      });
    }

    for (const it of corpo.itens) {
      const linha = porId.get(it.id);
      const cfg = configValida(linha.customization_config);
      const limpo = cfg ? sanitizarAjustesDaArte(it.customization, cfg) : it.customization;
      await client.query(origem.gravarItem, [JSON.stringify(limpo), linha.id, pedidoId]);
      linha.customization = limpo;
    }

    const itens = doPedido.map(itemDaResposta);
    const faltam = itens.filter((i) => i.is_personalizable && !i.tem_personalizacao).map((i) => i.id);

    let etapa = etapaAntes;
    let avancou = false;
    if (corpo.avancar) {
      // Avança só com todas as peças personalizáveis registradas. Nada é
      // gravado pela metade: a resposta diz quais faltam.
      if (faltam.length) {
        await desfazer();
        return res.status(422).json({
          error: 'Falta a arte ou o texto de alguma peça personalizável.',
          code: 'FALTA_PERSONALIZACAO',
          faltam,
        });
      }
      // Só sai de "Aguardando personalização". Pedido que já andou fica onde
      // está: a folha também serve para corrigir a arte depois.
      if (etapaAntes === ETAPA_SEM_PERSONALIZACAO) {
        const mov = await client.query(origem.avancar, [pedidoId, cid]);
        if (mov.rows.length) {
          etapa = mov.rows[0].studio_production_status;
          avancou = true;
        }
      }
    }

    await client.query('COMMIT');
    aberta = false;
    return res.json({
      ok: true,
      order_id: head.id,
      source: head.source,
      studio_production_status: etapa,
      avancou,
      itens,
      faltam,
    });
  } catch (err) {
    await desfazer();
    if (err && err.code === '42703') {
      console.error('[studio/orders/:oid/personalizacao POST] coluna ausente:', err.message);
      return res.status(503).json({
        error: 'Schema da personalização ainda não aplicado. Aguarde alguns minutos.',
        code: 'MIGRATION_PENDENTE',
      });
    }
    console.error('[studio/orders/:oid/personalizacao POST]', err.message);
    return res.status(500).json({ error: 'Erro ao salvar a personalização do pedido' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
module.exports._internals = { temPersonalizacao, lerCorpo, ETAPA_SEM_PERSONALIZACAO, ETAPA_SEGUINTE };
