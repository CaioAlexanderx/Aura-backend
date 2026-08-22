// ============================================================
// AURA Studio — Aceite público do orçamento (Camada 1, Fase A)
// Rota pública (sem auth) — espelha studioApprovalPublic.
// Montada em /api/v1/orcamento/:token (via index.js público).
//
// GET  /:token          → PublicQuote (loja + itens + validade + status)
// POST /:token/respond  → {action: accept|reject, note?}
// ============================================================
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');

/**
 * Carimba a PRIMEIRA abertura do link (migration 292).
 *
 * Sem isto a lojista fica no escuro entre "enviei" e "respondeu": nao sabe
 * se o cliente ao menos abriu. So a primeira visita grava — a pergunta e
 * "chegou?", nao "quantas vezes olhou".
 *
 * Fire-and-forget de proposito: se a coluna ainda nao existe (42703) ou o
 * UPDATE falhar, o cliente continua vendo o orcamento normalmente. Nunca
 * derrubar a proposta por causa de um dado de acompanhamento.
 */
function marcarVisualizado(quoteId) {
  db.query(
    `UPDATE studio_quotes SET viewed_at = NOW()
      WHERE id = $1 AND viewed_at IS NULL`,
    [quoteId]
  ).catch(function(err) {
    if (err && err.code === '42703') return; // migration 292 ainda nao aplicada
    console.error('[orcamento/:token] viewed_at:', err.message);
  });
}

// GET /orcamento/:token — dados públicos do orçamento
router.get('/:token', async function(req, res) {
  try {
    // 19/08/2026 — marca do lojista no orçamento: logo, cores e contato
    // vêm do digital_channel_config (mesma fonte da vitrine pública).
    const r = await db.query(
      `SELECT q.id, q.token, q.status, q.expires_at,
              q.customer_name, q.subtotal, q.discount, q.total,
              q.deposit_pct, q.deposit_amount, q.response_note, q.responded_at,
              c.trade_name, c.legal_name,
              dc.site_name, dc.logo_url, dc.primary_color, dc.secondary_color,
              dc.font_family,
              dc.whatsapp AS dc_whatsapp, dc.phone AS dc_phone, dc.instagram,
              (SELECT json_agg(json_build_object(
                'description', qi.description,
                'quantity', qi.quantity,
                'unit_price', qi.unit_price,
                'customization', qi.customization
              ) ORDER BY qi.sort_order, qi.created_at)
               FROM studio_quote_items qi WHERE qi.quote_id = q.id) AS items
         FROM studio_quotes q
         JOIN companies c ON c.id = q.company_id
         LEFT JOIN digital_channel_config dc ON dc.company_id = q.company_id
        WHERE q.token = $1 LIMIT 1`,
      [req.params.token]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }

    const q = r.rows[0];

    // Primeira abertura do link — a lojista precisa saber se chegou.
    // Nao aguarda: acompanhar nao pode atrasar (nem derrubar) a proposta.
    marcarVisualizado(q.id);

    // Verificar expiração: se status ainda é 'sent' mas já venceu → retornar 'expired'
    const expired = q.expires_at && new Date(q.expires_at) < new Date();
    const status  = expired && q.status === 'sent' ? 'expired' : q.status;

    // WhatsApp: só dígitos, pra montar wa.me no front
    const waDigits = String(q.dc_whatsapp || q.dc_phone || '').replace(/\D/g, '') || null;

    res.json({
      token:          q.token,
      status,
      expires_at:     q.expires_at,
      shop: {
        name:            q.site_name || q.trade_name || q.legal_name || 'Estúdio',
        logo_url:        q.logo_url || null,
        primary_color:   q.primary_color || null,
        secondary_color: q.secondary_color || null,
        // Fase 05 do rebrand: cor e logo ja chegavam, a tipografia nao — a
        // lojista escolhia o par no painel e o orcamento saia na fonte do
        // sistema. Mesmo buraco que a vitrine tinha.
        font_family:     q.font_family || 'classic',
        whatsapp:        waDigits,
        instagram:       q.instagram || null,
      },
      customer_name:  q.customer_name,
      subtotal:       parseFloat(q.subtotal) || 0,
      discount:       parseFloat(q.discount) || 0,
      total:          parseFloat(q.total) || 0,
      deposit_pct:    q.deposit_pct   != null ? parseFloat(q.deposit_pct)   : null,
      deposit_amount: q.deposit_amount != null ? parseFloat(q.deposit_amount) : null,
      items:          q.items || [],
      response_note:  q.response_note,
      responded_at:   q.responded_at,
    });
  } catch (err) {
    console.error('[orcamento:GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar orçamento' });
  }
});

// POST /orcamento/:token/respond
// body: { action: 'accept' | 'reject', note?: string }
router.post('/:token/respond', async function(req, res) {
  const { action, note } = req.body;
  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: "action deve ser 'accept' ou 'reject'" });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const qRes = await client.query(
      `SELECT id, company_id, status, expires_at
         FROM studio_quotes WHERE token = $1 LIMIT 1`,
      [req.params.token]
    );
    if (!qRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const q = qRes.rows[0];

    if (q.status !== 'sent') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este orçamento já foi respondido' });
    }

    if (q.expires_at && new Date(q.expires_at) < new Date()) {
      // Marca expirado e rejeita
      await client.query(
        `UPDATE studio_quotes SET status = 'expired', updated_at = NOW() WHERE id = $1`,
        [q.id]
      );
      await client.query('COMMIT');
      return res.status(410).json({ error: 'Orçamento expirado — peça à loja um novo orçamento' });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';

    await client.query(
      `UPDATE studio_quotes
          SET status        = $1,
              response_note = $2,
              responded_at  = NOW(),
              updated_at    = NOW()
        WHERE id = $3`,
      [newStatus, note ? String(note).slice(0, 1000) : null, q.id]
    );

    await client.query('COMMIT');

    res.json({
      ok:         true,
      action,
      new_status: newStatus,
      message:    action === 'accept'
        ? 'Orçamento aceito! A loja já foi notificada e vai entrar em contato para confirmar os próximos passos.'
        : 'Orçamento recusado. A loja foi notificada.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[orcamento:respond]', err.message);
    res.status(500).json({ error: 'Erro ao registrar resposta' });
  } finally {
    client.release();
  }
});

module.exports = router;
