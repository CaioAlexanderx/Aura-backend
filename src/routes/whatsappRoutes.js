// ============================================================
// AURA — WhatsApp (LEGADO): envio avulso e histórico
//
// CONSOLIDAÇÃO (25/08/2026): connect/disconnect/status/templates
// mudaram para src/routes/whatsappCloud.js (fonte única, montado em
// /companies/:id SEM gate de plano — o gate certo é o addon de
// lembretes). Aqui ficaram só /send e /messages, com o
// requirePlan('negocio','expansao') aplicado ROTA A ROTA — nunca no
// prefixo do mount, que barraria por prefixo e derrubaria as rotas do
// whatsappCloud (achado no QA de 27/08). Novas features de WhatsApp
// vão no whatsappCloud.js.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const wa = require('../services/whatsapp');
const { decrypt } = require('../services/dojoBaasCrypto');
// O gate de plano vale SÓ para estas rotas legadas — nunca no prefixo
// /whatsapp do mount (ver private.js): lá ele barrava por prefixo e
// derrubava as rotas consolidadas do whatsappCloud para dojôs essencial.
const { requirePlan } = require('../middleware/auth');
const legacyGate = requirePlan('negocio', 'expansao');

// A9 — o token permanente do Graph API é cifrado em repouso (AES-256-GCM,
// mesmo cofre do dojoBaasCrypto). Formato cifrado = "v1:...". Token legado
// (gravado em texto puro antes da cifra) NÃO tem o prefixo v1: → usado como
// está (migração transparente). Se v1: e a decifra falhar (chave errada/
// adulteração), o erro PROPAGA — nunca devolve o ciphertext como se fosse token.
function decryptToken(stored) {
  if (!stored) return stored;
  if (!/^v1:/.test(String(stored))) return stored; // legado em texto puro
  return decrypt(stored);
}

// Helper: get company WA config (token já DECIFRADO para uso nos envios)
async function getWaConfig(companyId) {
  const { rows } = await db.query(
    'SELECT wa_waba_id, wa_phone_number_id, wa_phone_display, wa_access_token FROM companies WHERE id=$1',
    [companyId]
  );
  if (!rows.length) throw new Error('Empresa nao encontrada');
  if (!rows[0].wa_access_token) throw new Error('WhatsApp nao conectado. Conecte em Configuracoes > WhatsApp.');
  rows[0].wa_access_token = decryptToken(rows[0].wa_access_token);
  return rows[0];
}

// ── POST /whatsapp/connect — Embedded Signup callback ────
// ── POST /whatsapp/send — Send message ─────────────────
router.post('/send', legacyGate, async (req, res) => {
  const cid = req.params.id;
  const { to, type = 'template', template_name, text, media_url, media_type, language, components } = req.body;
  if (!to) return res.status(400).json({ error: 'Destinatario (to) obrigatorio' });
  try {
    const config = await getWaConfig(cid);
    let result;
    if (type === 'template') {
      if (!template_name) return res.status(400).json({ error: 'template_name obrigatorio para tipo template' });
      result = await wa.sendTemplate(config.wa_phone_number_id, config.wa_access_token, to, template_name, language, components);
    } else if (type === 'text') {
      if (!text) return res.status(400).json({ error: 'text obrigatorio para tipo text' });
      result = await wa.sendText(config.wa_phone_number_id, config.wa_access_token, to, text);
    } else if (['image', 'document', 'video'].includes(type)) {
      if (!media_url) return res.status(400).json({ error: 'media_url obrigatorio' });
      result = await wa.sendMedia(config.wa_phone_number_id, config.wa_access_token, to, type, media_url, text);
    } else {
      return res.status(400).json({ error: 'Tipo invalido. Use: template, text, image, document, video' });
    }

    // Log message
    await db.query(
      `INSERT INTO wa_messages (company_id, direction, wa_message_id, to_phone, template_name, content, status)
       VALUES ($1,'outbound',$2,$3,$4,$5,'sent')`,
      [cid, result.messages?.[0]?.id || null, to, template_name || null, text || null]
    ).catch(() => {});

    res.json({ sent: true, message_id: result.messages?.[0]?.id, to });
  } catch (err) {
    console.error('[WA] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /whatsapp/messages — Message history ────────────
router.get('/messages', legacyGate, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT id, direction, to_phone, from_phone, template_name, content, status, created_at
       FROM wa_messages WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.params.id, parseInt(limit), parseInt(offset)]
    );
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) FROM wa_messages WHERE company_id=$1', [req.params.id]
    );
    res.json({ total: parseInt(countRows[0].count), messages: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar mensagens' }); }
});

module.exports = router;
