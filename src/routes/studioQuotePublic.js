// ============================================================
// AURA Studio — Aceite público do orçamento (Camada 1, Fase A)
// Rota pública (sem auth) — espelha studioApprovalPublic.
// Montada em /api/v1/orcamento/:token (via index.js público).
//
// GET  /:token          → PublicQuote (loja + itens + validade + status)
// POST /:token/respond  → {action: accept|reject, note?}
//
// 23/09/2026 (Matcon M1, migration 352): o MESMO link resolve orcamento
// de material de construcao. Quando o token nao esta em studio_quotes,
// procura em matcon_quotes.public_token e responde no formato PublicQuote
// + `kind: "matcon"` (o app troca personalizacao por unidade de venda).
// A pagina publica fala a lingua do Studio, entao o status e traduzido:
//   open -> 'sent' (ou 'expired' se a validade ja passou), approved ->
//   'accepted', lost -> 'rejected', expired -> 'expired'.
// Aceitar grava approved (+ approved_at); recusar grava lost. Do cliente
// sai so o primeiro nome (o link pode ser reencaminhado).
// ============================================================
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');

// ─── Matcon ─────────────────────────────────────────────────
const SP_TODAY = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

const STATUS_PUBLICO_MATCON = {
  open:     'sent',
  approved: 'accepted',
  lost:     'rejected',
  expired:  'expired',
};

async function orcamentoMatcon(token) {
  try {
    const { rows } = await db.query(
      `SELECT q.id, q.public_token, q.status,
              to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
              (q.valid_until < ${SP_TODAY}) AS vencido,
              q.customer_name, q.items, q.total, q.responded_at, q.response_note,
              c.trade_name, c.legal_name,
              dc.site_name, dc.logo_url, dc.primary_color, dc.secondary_color,
              dc.font_family,
              dc.whatsapp AS dc_whatsapp, dc.phone AS dc_phone, dc.instagram
         FROM matcon_quotes q
         JOIN companies c ON c.id = q.company_id
         LEFT JOIN digital_channel_config dc ON dc.company_id = q.company_id
        WHERE q.public_token = $1 LIMIT 1`,
      [token]
    );
    return rows[0] || null;
  } catch (e) {
    // 352 ainda nao aplicada: segue o 404 de sempre.
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

function respostaMatcon(q) {
  const itens = Array.isArray(q.items) ? q.items : [];
  // Na pagina a linha mostra quantidade x preco cheio; desconto por item e
  // desconto do orcamento viram UM desconto no rodape, pra conta fechar.
  const subtotal = Math.round(itens.reduce(function(acc, it) {
    return acc + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
  }, 0) * 100) / 100;
  const total = parseFloat(q.total) || 0;
  const status = q.status === 'open' && q.vencido ? 'expired' : (STATUS_PUBLICO_MATCON[q.status] || 'expired');
  const waDigits = String(q.dc_whatsapp || q.dc_phone || '').replace(/\D/g, '') || null;
  const primeiro = String(q.customer_name || '').trim().split(/\s+/)[0] || null;
  return {
    token:      q.public_token,
    kind:       'matcon',
    status,
    // Fim do dia de validade em Sao Paulo: o app faz new Date(expires_at)
    // e uma data pura viraria o dia anterior no fuso do Brasil.
    expires_at: q.valid_until + 'T23:59:59-03:00',
    shop: {
      name:            q.site_name || q.trade_name || q.legal_name || 'Loja',
      logo_url:        q.logo_url || null,
      primary_color:   q.primary_color || null,
      secondary_color: q.secondary_color || null,
      font_family:     q.font_family || 'classic',
      whatsapp:        waDigits,
      instagram:       q.instagram || null,
    },
    customer_name:  primeiro,
    subtotal,
    discount:       Math.max(0, Math.round((subtotal - total) * 100) / 100),
    total,
    deposit_pct:    null,
    deposit_amount: null,
    items: itens.map(function(it) {
      return {
        description:   String(it.name || ''),
        quantity:      Number(it.quantity) || 0,
        unit_price:    Number(it.unit_price) || 0,
        customization: null,
        unit:          it.unit || null,
      };
    }),
    response_note:  q.response_note || null,
    responded_at:   q.responded_at || null,
  };
}

// Matcon: aceitar/recusar dentro da transacao do respond. Devolve null
// quando o token nao e de orcamento Matcon (segue o 404 de sempre); senao
// ja fez COMMIT/ROLLBACK e devolve {status, body}.
async function responderMatcon(client, token, action, note) {
  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT id, status, (valid_until < ${SP_TODAY}) AS vencido
         FROM matcon_quotes WHERE public_token = $1 LIMIT 1
         FOR UPDATE`,
      [token]
    ));
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
  if (!rows || !rows.length) return null;
  const q = rows[0];

  if (q.status === 'expired' || (q.status === 'open' && q.vencido)) {
    if (q.status === 'open') {
      await client.query(`UPDATE matcon_quotes SET status = 'expired' WHERE id = $1`, [q.id]);
    }
    await client.query('COMMIT');
    return { status: 410, body: { error: 'Orçamento vencido — peça à loja um orçamento novo' } };
  }
  if (q.status !== 'open') {
    await client.query('ROLLBACK');
    return { status: 409, body: { error: 'Este orçamento já foi respondido' } };
  }

  const aceitar = action === 'accept';
  await client.query(
    `UPDATE matcon_quotes
        SET status        = $1,
            approved_at   = CASE WHEN $1 = 'approved' THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
            response_note = $2,
            responded_at  = NOW()
      WHERE id = $3`,
    [aceitar ? 'approved' : 'lost', note ? String(note).slice(0, 1000) : null, q.id]
  );
  await client.query('COMMIT');
  return {
    status: 200,
    body: {
      ok:         true,
      action,
      new_status: aceitar ? 'accepted' : 'rejected',
      message:    aceitar
        ? 'Orçamento aprovado! Agora é só combinar o pagamento e a entrega com a loja.'
        : 'Orçamento recusado. Obrigado por avisar a loja.',
    },
  };
}

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
      const matcon = await orcamentoMatcon(req.params.token);
      if (matcon) return res.json(respostaMatcon(matcon));
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
      const matcon = await responderMatcon(client, req.params.token, action, note);
      if (matcon) return res.status(matcon.status).json(matcon.body);
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
module.exports._respostaMatcon = respostaMatcon;
