// ============================================================
// AURA Studio — Triagem da arte enviada pelo cliente (S5)
//
// GET   /companies/:id/studio/art-review        — fila
// PATCH /companies/:id/studio/art-review/:itemId — decide
//
// O que existe hoje vai no sentido LOJISTA -> CLIENTE (`/aprovacao/:token`:
// a lojista manda o render, o cliente aprova). O inverso nao existia.
//
// DEC-11: a triagem e PARTE DO PROCESSO, nao um portao. Ajustar a arte do
// cliente para caber no produto e para as cores de impressao e rotina,
// acontece na maioria dos pedidos. Entao:
//
//   - nao ha estado novo de pedido e nao ha prazo suspenso;
//   - o pedido segue seu curso enquanto a arte e tratada;
//   - a fila e uma VISAO sobre itens que ja existem.
//
// A pergunta que a tela responde nao e "aprovo ou rejeito", e "ajusto por
// conta ou cobro por isso" — e o preco do ajuste ja existe desde o S4,
// escolhido pelo cliente na propria vitrine.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { STATUS, STATUS_VALIDOS } = require('../services/artReview');

// 42703/42P01: migration 289 ausente. Rota de lojista — melhor dizer o
// que falta do que devolver fila vazia e o lojista achar que nao ha
// arte para revisar (CLAUDE.md, armadilha 1).
function migrationPendente(err) {
  return err && (err.code === '42703' || err.code === '42P01');
}
function respostaMigracao(res) {
  return res.status(503).json({
    error: 'Triagem de arte ainda nao disponivel nesta base. Aplique a migration 289.',
    code: 'MIGRATION_289_PENDENTE',
  });
}

// ── GET /studio/art-review ───────────────────────────────────
// ?status=pendente|aceita|ajustando|devolvida (default: pendente)
router.get('/art-review', async (req, res) => {
  const cid = req.params.id;
  const status = req.query.status ? String(req.query.status) : STATUS.PENDENTE;
  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({
      error: 'status invalido', valid_status: STATUS_VALIDOS,
    });
  }

  try {
    const { rows } = await db.query(
      `SELECT i.id, i.order_id, i.product_id, i.product_name, i.product_image,
              i.quantity, i.customization,
              i.art_review_status, i.art_review_note, i.art_reviewed_at,
              o.order_number, o.customer_name, o.customer_phone,
              o.status AS order_status, o.created_at AS order_created_at
         FROM digital_order_items i
         JOIN digital_orders o ON o.id = i.order_id
        WHERE o.company_id = $1
          AND i.art_review_status = $2
        ORDER BY o.created_at DESC, i.id
        LIMIT 200`,
      [cid, status]
    );
    res.json({ items: rows, status, total: rows.length });
  } catch (err) {
    if (migrationPendente(err)) return respostaMigracao(res);
    console.error('[studio/art-review] list error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar a fila de triagem' });
  }
});

// ── PATCH /studio/art-review/:itemId ─────────────────────────
// body: { status, note? }
router.patch('/art-review/:itemId', async (req, res) => {
  const cid = req.params.id;
  const { status, note } = req.body || {};

  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({
      error: 'status invalido', valid_status: STATUS_VALIDOS,
    });
  }
  if (note != null && typeof note !== 'string') {
    return res.status(400).json({ error: 'note deve ser texto' });
  }

  try {
    // O WHERE amarra o item a ESTA empresa pelo pedido — o :itemId vem da
    // URL e nao pode ser o unico criterio. E `art_review_status IS NOT
    // NULL` impede marcar triagem em item que nunca teve arte de cliente.
    const { rows } = await db.query(
      `UPDATE digital_order_items i
          SET art_review_status = $1,
              art_review_note   = COALESCE($2, i.art_review_note),
              art_reviewed_at   = NOW(),
              art_reviewed_by   = $3
         FROM digital_orders o
        WHERE o.id = i.order_id
          AND i.id = $4
          AND o.company_id = $5
          AND i.art_review_status IS NOT NULL
      RETURNING i.id, i.order_id, i.art_review_status, i.art_review_note, i.art_reviewed_at`,
      [status, note ?? null, req.user?.id || null, req.params.itemId, cid]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Item nao encontrado nesta empresa, ou sem arte para revisar' });
    }
    res.json({ item: rows[0] });
  } catch (err) {
    if (migrationPendente(err)) return respostaMigracao(res);
    console.error('[studio/art-review] patch error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar a triagem' });
  }
});

module.exports = router;
