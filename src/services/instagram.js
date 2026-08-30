// ============================================================
// AURA. — instagram.js
// Cliente cru da Instagram API (API with Instagram Login).
// Espelho do services/whatsapp.js, mas para DMs do Instagram.
//
// Endpoint de envio (doc Meta, Instagram Login):
//   POST https://graph.instagram.com/v25.0/{IG_ID}/messages
//   Authorization: Bearer {ig_access_token}
//   { recipient: { id: IGSID }, message: { text } }
// Texto: UTF-8, máx. 1000 bytes. Janela de 24h após inbound do cliente.
// ============================================================
'use strict';

const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch
  : require('node-fetch');

const IG_GRAPH_URL = 'https://graph.instagram.com/v25.0';

async function graphPost(igAccountId, accessToken, body) {
  const resp = await fetch(`${IG_GRAPH_URL}/${igAccountId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const meta = data && data.error ? data.error : {};
    const err = new Error(
      `IG Graph API ${resp.status}: ${meta.message || 'erro desconhecido'} (code ${meta.code || '?'})`
    );
    err.status = resp.status;
    err.igCode = meta.code;
    err.body = data;
    throw err;
  }
  return data; // { recipient_id, message_id }
}

// Meta limita o texto a 1000 BYTES (não chars) — corta em limite de
// caractere UTF-8 válido para não enviar byte quebrado.
function clampText(text, maxBytes = 1000) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let cut = s;
  while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > maxBytes - 1) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

async function sendText(igAccountId, accessToken, recipientIgsid, text) {
  return graphPost(igAccountId, accessToken, {
    recipient: { id: recipientIgsid },
    message: { text: clampText(text) },
  });
}

async function sendImage(igAccountId, accessToken, recipientIgsid, imageUrl) {
  return graphPost(igAccountId, accessToken, {
    recipient: { id: recipientIgsid },
    message: { attachment: { type: 'image', payload: { url: imageUrl } } },
  });
}

module.exports = { IG_GRAPH_URL, sendText, sendImage, clampText };
