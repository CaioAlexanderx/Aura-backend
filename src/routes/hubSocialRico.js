// ============================================================
// AURA. — hubSocialRico.js
// Mensagens ricas da conversa aberta (WhatsApp): catálogo, orçamentos
// do cliente e o envio de produto, orçamento, Pix e link da loja.
// Montado dentro de hubSocial.js (herda requireAuth + company access).
// Tudo grátis: só funciona com a conversa aberta (24 h).
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/database');
const envio = require('../services/hubWhatsappEnvio');
const { camposDoProduto, colunasPromo, colunasPromoNulas, comColunasPromo } = require('../services/precoEfetivo');

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

// Erro de regra vira resposta legível; o resto é 500 genérico.
function responderErro(res, e, rotulo) {
  if (e && e.code && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
  if (e && e.meta) {
    return res.status(502).json({ error: 'O WhatsApp recusou a mensagem. Tente de novo em instantes.', code: 'META_RECUSOU' });
  }
  if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
  console.error('[HUB] %s error:', rotulo, e && e.message);
  return res.status(500).json({ error: 'Erro ao enviar a mensagem' });
}

// ── GET /hub/catalogo?q= ─────────────────────────────────────
// Produtos da loja para o seletor da conversa (nome, preço e foto).
router.get('/catalogo', async (req, res) => {
  const cid = req.params.id;
  const q = String(req.query.q || '').trim().slice(0, 80);
  try {
    const { rows } = await comColunasPromo((comPromo) => db.query(
      `-- hub:catalogo
       SELECT id, name, price, image_url, ${comPromo ? colunasPromo() : colunasPromoNulas()}
         FROM products
        WHERE company_id = $1 AND COALESCE(is_active, true) = true
          AND ($2 = '' OR name ILIKE $3 OR sku ILIKE $3)
        ORDER BY (image_url IS NOT NULL AND image_url <> '') DESC, name ASC
        LIMIT 24`,
      [cid, q, `%${q}%`]
    ));
    res.json({
      products: rows.map((p) => ({
        id: p.id, name: p.name, price: camposDoProduto(p).preco_efetivo, image_url: p.image_url || null,
      })),
    });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ products: [] });
    console.error('[HUB] catalogo error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar produtos' });
  }
});

// ── GET /hub/conversations/:convId/orcamentos ────────────────
// Orçamentos já enviados (com link) para o cliente desta conversa: pelo
// cadastro ligado ("É ela") ou pelo telefone.
router.get('/conversations/:convId/orcamentos', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows: conv } = await db.query(
      `SELECT customer_id, external_id FROM hub_conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.convId, cid]
    );
    if (!conv.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    const fone = String(conv[0].external_id || '').replace(/\D+/g, '');
    const { rows } = await db.query(
      `-- hub:orcamentos-da-conversa
       SELECT id, status, total, expires_at, customer_name, sent_at
         FROM studio_quotes
        WHERE company_id = $1 AND status = 'sent' AND token IS NOT NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND ( ($2::uuid IS NOT NULL AND customer_id = $2::uuid)
             OR ($3 <> '' AND RIGHT(regexp_replace(COALESCE(customer_phone,''), '\\D', '', 'g'), 11) = RIGHT($3, 11)) )
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 10`,
      [cid, conv[0].customer_id || null, fone]
    );
    res.json({ quotes: rows });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ quotes: [] });
    console.error('[HUB] orcamentos error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar orçamentos' });
  }
});

// ── POST /hub/conversations/:convId/send ─────────────────────
// { type: 'produto'|'orcamento'|'pix'|'link_loja', product_id|quote_id|amount }
router.post('/conversations/:convId/send', async (req, res) => {
  const { type, ...dados } = req.body || {};
  if (!envio.TIPOS.includes(type)) {
    return res.status(400).json({ error: `type inválido (${envio.TIPOS.join(', ')})` });
  }
  try {
    const r = await envio.enviarSessao({
      companyId: req.params.id, conversationId: req.params.convId,
      userId: req.user && req.user.id, tipo: type, dados,
    });
    res.json({ ok: true, wamid: r.wamid });
  } catch (e) {
    responderErro(res, e, 'send');
  }
});

module.exports = router;
