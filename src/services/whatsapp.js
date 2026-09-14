// ============================================================
// AURA. — Sprint 5: WhatsApp Cloud API Service
// Multi-tenant: each client uses their OWN phone number
// Aura is the Tech Provider, clients connect via Embedded Signup
// ============================================================

const GRAPH_URL = 'https://graph.facebook.com/v21.0';
const META_APP_ID = process.env.WA_APP_ID;
const META_APP_SECRET = process.env.WA_APP_SECRET;

// ── Erro ESTRUTURADO da Graph API ───────────────────────────
// A mensagem sozinha não basta para decidir o que fazer: 132001
// (template inexistente) nunca vai melhorar com retry, 131047 (fora da
// janela) é regra de produto, 190 é credencial. Quem chama precisa do
// CÓDIGO, não de uma frase em inglês para casar por regex. Por isso
// todo erro da Graph carrega `.meta` (code, error_subcode, type,
// details, fbtrace_id) e `.httpStatus`. A mensagem continua sendo a da
// Meta — os testes e o isTokenError que já existiam seguem valendo.
function graphError(data, httpStatus) {
  const e = (data && data.error) || null;
  const err = new Error((e && e.message) || `Graph API error ${httpStatus}`);
  if (e) {
    err.meta = {
      ...e,
      // error_data.details costuma trazer o motivo REAL (ex.: qual
      // parâmetro do template está errado); a message fica genérica.
      details: (e.error_data && e.error_data.details) || null,
    };
  }
  err.httpStatus = httpStatus;
  return err;
}

// Exchange short-lived code for permanent token
async function exchangeCodeForToken(code) {
  const resp = await fetch(
    `${GRAPH_URL}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}`
  );
  const data = await resp.json();
  if (data.error) throw graphError(data, resp.status);
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
  if (data.error) throw graphError(data, resp.status);
  return data.data || [];
}

// List phone numbers of a WABA — o Embedded Signup nem sempre devolve
// o phone_number_id (depende do passo em que o usuário terminou); sem
// ele não há como registrar nem enviar.
async function listPhoneNumbers(wabaId, accessToken) {
  const resp = await fetch(
    `${GRAPH_URL}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=25`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await resp.json();
  if (data.error) throw graphError(data, resp.status);
  return data.data || [];
}

// Assina o app da Aura nos webhooks da WABA. SEM ISTO o webhook nunca
// recebe evento nenhum deste número: status de entrega, aprovação de
// template e qualidade ficam para sempre desatualizados.
async function subscribeApp(wabaId, accessToken) {
  return graphPost(`/${wabaId}/subscribed_apps`, accessToken, {});
}

// Solta a WABA do app (desconectar). Best-effort: se a Meta recusar, o
// dojô ainda tem de conseguir desconectar do lado da Aura.
async function unsubscribeApp(wabaId, accessToken) {
  const resp = await fetch(`${GRAPH_URL}/${wabaId}/subscribed_apps`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (data.error) throw graphError(data, resp.status);
  return data;
}

// Registra o número na Cloud API com um PIN de 6 dígitos (two-step
// verification). Sem o /register, o primeiro envio morre com 133010
// ("phone number not registered").
async function registerPhone(phoneNumberId, accessToken, pin) {
  return graphPost(`/${phoneNumberId}/register`, accessToken, {
    messaging_product: 'whatsapp',
    pin: String(pin),
  });
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
  if (data.error) throw graphError(data, resp.status);
  return data;
}

module.exports = {
  exchangeCodeForToken,
  sendTemplate, sendText, sendMedia,
  listTemplates, createTemplate,
  getPhoneInfo, graphPost, graphError,
  listPhoneNumbers, subscribeApp, unsubscribeApp, registerPhone,
};
