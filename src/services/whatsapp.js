// ============================================================
// AURA. — Sprint 5: WhatsApp Cloud API Service
// Multi-tenant: each client uses their OWN phone number
// Aura is the Tech Provider, clients connect via Embedded Signup
// ============================================================

const GRAPH_URL = 'https://graph.facebook.com/v21.0';
const META_APP_ID = process.env.WA_APP_ID;
const META_APP_SECRET = process.env.WA_APP_SECRET;

// Exchange short-lived code for permanent token
async function exchangeCodeForToken(code) {
  const resp = await fetch(
    `${GRAPH_URL}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}`
  );
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data.access_token;
}

// Send template message (requires pre-approved template)
async function sendTemplate(phoneNumberId, accessToken, to, templateName, language, components) {
  const body = {
    messaging_product: 'whatsapp',
    to: to.replace(/\D/g, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'pt_BR' },
    },
  };
  if (components) body.template.components = components;
  return graphPost(`/${phoneNumberId}/messages`, accessToken, body);
}

// Send free-form text (only within 24h customer-service window)
async function sendText(phoneNumberId, accessToken, to, text) {
  return graphPost(`/${phoneNumberId}/messages`, accessToken, {
    messaging_product: 'whatsapp',
    to: to.replace(/\D/g, ''),
    type: 'text',
    text: { body: text },
  });
}

// Send media message (image, document, video)
async function sendMedia(phoneNumberId, accessToken, to, mediaType, mediaUrl, caption) {
  const body = {
    messaging_product: 'whatsapp',
    to: to.replace(/\D/g, ''),
    type: mediaType,
    [mediaType]: { link: mediaUrl },
  };
  if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
    body[mediaType].caption = caption;
  }
  return graphPost(`/${phoneNumberId}/messages`, accessToken, body);
}

// List message templates for a WABA
async function listTemplates(wabaId, accessToken) {
  const resp = await fetch(`${GRAPH_URL}/${wabaId}/message_templates?limit=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

// Create a message template
async function createTemplate(wabaId, accessToken, template) {
  return graphPost(`/${wabaId}/message_templates`, accessToken, template);
}

// Get phone number info
async function getPhoneInfo(phoneNumberId, accessToken) {
  const resp = await fetch(`${GRAPH_URL}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return resp.json();
}

// Helper: POST to Graph API
async function graphPost(path, accessToken, body) {
  const resp = await fetch(`${GRAPH_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || `Graph API error ${resp.status}`);
  return data;
}

module.exports = {
  exchangeCodeForToken,
  sendTemplate, sendText, sendMedia,
  listTemplates, createTemplate,
  getPhoneInfo, graphPost,
};
