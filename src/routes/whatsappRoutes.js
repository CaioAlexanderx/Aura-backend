// ============================================================
// AURA. — Sprint 5: WhatsApp Routes
// Multi-tenant: each client uses their own number
// Mounted at: /companies/:id/whatsapp
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const wa = require('../services/whatsapp');

// Helper: get company WA config
async function getWaConfig(companyId) {
  const { rows } = await db.query(
    'SELECT wa_waba_id, wa_phone_number_id, wa_phone_display, wa_access_token FROM companies WHERE id=$1',
    [companyId]
  );
  if (!rows.length) throw new Error('Empresa nao encontrada');
  if (!rows[0].wa_access_token) throw new Error('WhatsApp nao conectado. Conecte em Configuracoes > WhatsApp.');
  return rows[0];
}

// ── POST /whatsapp/connect — Embedded Signup callback ────
router.post('/connect', async (req, res) => {
  const cid = req.params.id;
  const { code, waba_id, phone_number_id } = req.body;
  if (!code) return res.status(400).json({ error: 'Authorization code obrigatorio' });
  try {
    // Exchange code for permanent token
    const accessToken = await wa.exchangeCodeForToken(code);

    // Get phone display number
    let phoneDisplay = '';
    if (phone_number_id) {
      try {
        const info = await wa.getPhoneInfo(phone_number_id, accessToken);
        phoneDisplay = info.display_phone_number || '';
      } catch {}
    }

    // Save to company
    await db.query(
      `UPDATE companies SET
        wa_waba_id=$1, wa_phone_number_id=$2, wa_phone_display=$3,
        wa_access_token=$4, wa_connected_at=NOW(), updated_at=NOW()
       WHERE id=$5`,
      [waba_id || null, phone_number_id || null, phoneDisplay, accessToken, cid]
    );

    res.json({
      connected: true,
      phone_display: phoneDisplay,
      waba_id: waba_id,
      message: 'WhatsApp conectado com sucesso!',
    });
  } catch (err) {
    console.error('[WA] Connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /whatsapp/status — Connection status ────────────
router.get('/status', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT wa_waba_id, wa_phone_number_id, wa_phone_display, wa_connected_at FROM companies WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const c = rows[0];
    res.json({
      connected: !!c.wa_access_token || !!c.wa_phone_number_id,
      phone_display: c.wa_phone_display || null,
      waba_id: c.wa_waba_id || null,
      connected_at: c.wa_connected_at || null,
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao verificar status' }); }
});

// ── POST /whatsapp/disconnect — Remove connection ───────
router.post('/disconnect', async (req, res) => {
  try {
    await db.query(
      `UPDATE companies SET wa_waba_id=NULL, wa_phone_number_id=NULL, wa_phone_display=NULL,
       wa_access_token=NULL, wa_connected_at=NULL, updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ disconnected: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao desconectar' }); }
});

// ── POST /whatsapp/send — Send message ─────────────────
router.post('/send', async (req, res) => {
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

// ── GET /whatsapp/templates — List templates ────────────
router.get('/templates', async (req, res) => {
  try {
    const config = await getWaConfig(req.params.id);
    if (!config.wa_waba_id) return res.json({ templates: [] });
    const templates = await wa.listTemplates(config.wa_waba_id, config.wa_access_token);
    res.json({
      total: templates.length,
      templates: templates.map(t => ({
        name: t.name, status: t.status, category: t.category,
        language: t.language, components: t.components,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /whatsapp/messages — Message history ────────────
router.get('/messages', async (req, res) => {
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
