// ============================================================
// AURA — WhatsApp Cloud API por COMPANY (fonte única)
// Montado em /companies/:id. Qualquer vertical: o canal pertence à
// company conectada (no karatê, o dojô).
//
//   POST  /whatsapp/connect           — Embedded Signup (code → token)
//   POST  /whatsapp/disconnect        — solta o número da company
//   GET   /whatsapp/status            — conexão + contadores da fila
//   GET   /whatsapp/templates         — registro local (status da Meta)
//   POST  /whatsapp/templates         — cria na Meta e registra
//   POST  /whatsapp/templates/sync    — puxa da Meta p/ o registro
//   GET   /whatsapp/outbox            — últimos itens da fila
//   POST  /whatsapp/test-send         — enfileira + despacha na hora
//   POST  /whatsapp/contacts/opt      — opt-in/opt-out manual
//
// CONSOLIDAÇÃO (25/08/2026): estas rotas viviam em DOIS routers — o
// legado (whatsappRoutes.js, atrás de requirePlan('negocio','expansao'))
// sombreava status/templates e devolvia outro shape, deixando o card de
// Templates vazio no app. Aqui NÃO há gate de plano: 104 dos 106 dojôs
// estão em 'essencial' e são justamente o público do addon de lembretes
// (R$39/mês) — o gate certo é o ADDON, não o plano. O legado ficou só
// com /send e /messages (uso antigo de outras verticais).
//
// 42P01 (307 pendente) → SCHEMA_PENDING; credenciais 039 → 42703-safe.
// ============================================================
'use strict';

const crypto = require('crypto');
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireCompanyAccess } = require('../middleware/auth');
const waOutbox = require('../services/waOutbox');
const wa = require('../services/whatsapp');
const addons = require('../services/addons');
const { encrypt } = require('../services/dojoBaasCrypto');

const guard = [requireAuth, requireCompanyAccess({})];

// Template de cobrança efetivo: o nome vive numa env porque a Meta
// aprova POR NOME e um dojô pode ter herdado outro do onboarding.
function billingTemplateName() {
  return process.env.WA_TPL_MENSALIDADE || 'mensalidade_lembrete';
}

// Teto diário de mensagens automáticas por company (Fase 2 aplica; o
// status já mostra para a tela poder avisar antes de alguém ligar).
function dailyCap() {
  const n = Number(process.env.WA_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

function schemaPending(res) {
  return res.status(503).json({ error: 'WhatsApp indisponível (migração 307 pendente)', code: 'SCHEMA_PENDING' });
}

// Coluna da 309 — consultada à parte para que a ausência dela não
// derrube o status inteiro.
let HAS_TOKEN_FLAG = true;
async function loadTokenInvalidAt(companyId) {
  if (!HAS_TOKEN_FLAG) return null;
  try {
    const { rows } = await db.query(
      'SELECT wa_token_invalid_at FROM companies WHERE id = $1 LIMIT 1', [companyId]
    );
    return (rows[0] && rows[0].wa_token_invalid_at) || null;
  } catch (e) {
    if (e.code === '42703') { HAS_TOKEN_FLAG = false; return null; }
    throw e;
  }
}

// ── Colunas da 328 (conexão completa) ───────────────────────
// Mesmo truque da 309: em bloco próprio, com cache module-level, para
// que a migration pendente no deploy não derrube o status inteiro nem
// custe um try/catch por request depois da primeira descoberta.
let HAS_CONN_COLS = true;

async function loadConnExtras(companyId) {
  if (!HAS_CONN_COLS) return null;
  try {
    const { rows } = await db.query(
      `-- wa:conn-extras-get
       SELECT wa_subscribed_at, wa_registered_at, wa_quality_rating, wa_paused_reason, wa_paused_at
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') { HAS_CONN_COLS = false; return null; }
    throw e;
  }
}

// Grava o resultado dos passos extras do connect. PIN só entra quando
// FOMOS NÓS que registramos o número agora — num número já registrado
// o PIN guardado seria uma mentira (o de verdade está com quem
// registrou antes).
async function saveConnExtras(companyId, { encryptedPin, subscribed, registered, quality }) {
  if (!HAS_CONN_COLS) return;
  try {
    await db.query(
      `-- wa:conn-extras-set
       UPDATE companies SET
         wa_register_pin   = COALESCE($2, wa_register_pin),
         wa_subscribed_at  = CASE WHEN $3 THEN NOW() ELSE wa_subscribed_at END,
         wa_registered_at  = CASE WHEN $4 THEN NOW() ELSE wa_registered_at END,
         wa_quality_rating = COALESCE($5, wa_quality_rating),
         wa_paused_reason  = NULL,
         wa_paused_at      = NULL
       WHERE id = $1`,
      [companyId, encryptedPin || null, !!subscribed, !!registered, quality || null]
    );
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') { HAS_CONN_COLS = false; return; }
    throw e;
  }
}

async function clearConnExtras(companyId) {
  if (!HAS_CONN_COLS) return;
  try {
    await db.query(
      `-- wa:conn-extras-clear
       UPDATE companies SET wa_register_pin = NULL, wa_subscribed_at = NULL,
              wa_registered_at = NULL, wa_quality_rating = NULL
        WHERE id = $1`,
      [companyId]
    );
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') { HAS_CONN_COLS = false; return; }
    throw e;
  }
}

async function loadCompanyWa(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT wa_waba_id, wa_phone_number_id, wa_phone_display, wa_connected_at,
              wa_access_token IS NOT NULL AS has_token
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const row = rows[0] || null;
    if (row) row.wa_token_invalid_at = await loadTokenInvalidAt(companyId);
    return row;
  } catch (e) {
    if (e.code === '42703') return null;
    throw e;
  }
}

// ── Token recusado pela Meta (migration 309) ────────────────
// A Meta recusa credencial com o código 190 ("Error validating access
// token: Session has expired..."). Sem tratar isso, o dojô via o selo
// verde "Conectado" com o token morto havia dias e, ao tentar usar,
// recebia o erro cru em inglês. Achado no QA de 26/08.
//
// Não checamos o token a cada tela (seria uma chamada à Graph por
// request): quem carimba é a chamada que a Meta recusou, e o /status
// passa a dizer a verdade até alguém reconectar.
// isTokenError/markTokenInvalid/clearTokenInvalid vivem no waOutbox: a
// FILA descobre a recusa antes da tela na maioria das vezes, e uma
// definição só evita as duas superfícies divergirem.
const { isTokenError, markTokenInvalid, clearTokenInvalid } = waOutbox;

// Resposta única para credencial recusada: 409 + mensagem em PORTUGUÊS
// dizendo o que fazer. O texto da Meta vai em `detail` (suporte), não na
// mensagem que o dono do dojô lê.
function tokenExpiredResponse(res, err) {
  return res.status(409).json({
    error: 'A conexão com o WhatsApp expirou. Reconecte o número do dojô para voltar a enviar.',
    code: 'TOKEN_EXPIRADO',
    detail: String((err && err.message) || '').slice(0, 300),
  });
}

// A Meta responde "already registered" de formas diferentes conforme o
// caminho (código 133005/133006 ou só a frase). Número já registrado é
// EXATAMENTE o estado que queremos — tratar como erro faria o dojô
// reconectar em looping tentando consertar o que já estava certo.
function alreadyRegistered(err) {
  const code = err && err.meta ? Number(err.meta.code) : NaN;
  if (code === 133005 || code === 133006) return true;
  return /already/i.test(String((err && err.message) || ''));
}

// ── POST /whatsapp/connect — Embedded Signup ────────────────
// Body: { code, waba_id, phone_number_id }. O token permanente é
// gravado CIFRADO em repouso (A9) — quem envia decifra (waOutbox).
//
// Trocar o code por um token NÃO deixa o número pronto: faltam os dois
// passos que ninguém vê e que, sem eles, o dojô fica com um selo verde
// que não envia nem recebe nada —
//   subscribed_apps → é o que liga o webhook deste número ao nosso app;
//   /register       → é o que autoriza o número a enviar (senão: 133010).
// Os dois são best-effort: falhar neles vira WARNING e não desfaz a
// conexão (o token já é válido e o dojô pode terminar pelo suporte),
// mas o carimbo (wa_subscribed_at/wa_registered_at) só existe em caso
// de sucesso — o status precisa contar a verdade.
router.post('/whatsapp/connect', ...guard, async (req, res) => {
  const { code, waba_id } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Authorization code obrigatorio', code: 'VALIDATION_ERROR' });

  const wabaId = waba_id || null;
  let phoneNumberId = (req.body && req.body.phone_number_id) || null;
  const warnings = [];
  const warn = (txt, e) => warnings.push(`${txt}${e ? ': ' + String(e.message || e).slice(0, 160) : ''}`);

  try {
    const accessToken = await wa.exchangeCodeForToken(code);
    let phoneDisplay = '';

    // O Embedded Signup nem sempre devolve o phone_number_id (depende
    // do passo em que a pessoa terminou) — buscar na WABA evita uma
    // conexão pela metade.
    if (!phoneNumberId && wabaId) {
      try {
        const list = await wa.listPhoneNumbers(wabaId, accessToken);
        const first = Array.isArray(list) ? list[0] : null;
        if (first && first.id) {
          phoneNumberId = String(first.id);
          phoneDisplay = first.display_phone_number || '';
        } else {
          warn('Nenhum número de telefone encontrado nesta conta do WhatsApp Business');
        }
      } catch (e) {
        warn('Não foi possível listar os números da conta', e);
      }
    }

    // Assinatura do webhook — sem isto nenhum evento deste número chega.
    let subscribed = false;
    if (wabaId) {
      try {
        await wa.subscribeApp(wabaId, accessToken);
        subscribed = true;
      } catch (e) {
        warn('Não foi possível assinar os eventos do WhatsApp (webhook)', e);
      }
    } else {
      warn('waba_id ausente: os eventos do WhatsApp (entrega, aprovação de template) não serão recebidos');
    }

    // Registro do número. PIN de 6 dígitos por crypto (randomInt é
    // uniforme — Math.random aqui seria previsível) e guardado cifrado.
    let registered = false;
    let encryptedPin = null;
    if (phoneNumberId) {
      const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      try {
        await wa.registerPhone(phoneNumberId, accessToken, pin);
        registered = true;
        encryptedPin = encrypt(pin);
      } catch (e) {
        if (alreadyRegistered(e)) {
          registered = true; // já estava pronto; o PIN é de quem registrou antes
        } else {
          warn('Não foi possível registrar o número na Cloud API', e);
        }
      }
    }

    // Display + qualidade: conforto na tela, não requisito da conexão.
    let quality = null;
    if (phoneNumberId) {
      try {
        const info = await wa.getPhoneInfo(phoneNumberId, accessToken);
        phoneDisplay = (info && info.display_phone_number) || phoneDisplay;
        quality = (info && info.quality_rating) || null;
      } catch { /* display é conforto, não requisito */ }
    }

    await db.query(
      `UPDATE companies SET
         wa_waba_id=$1, wa_phone_number_id=$2, wa_phone_display=$3,
         wa_access_token=$4, wa_connected_at=NOW(), updated_at=NOW()
       WHERE id=$5`,
      [wabaId, phoneNumberId || null, phoneDisplay, encrypt(accessToken), req.params.id]
    );
    // Reconectou: a recusa anterior (309) não vale mais.
    await clearTokenInvalid(req.params.id);
    // Colunas da 328 — em UPDATE separado, 42703-safe: migration pendente
    // não pode impedir a conexão de acontecer.
    await saveConnExtras(req.params.id, { encryptedPin, subscribed, registered, quality });

    return res.json({
      connected: true,
      phone_display: phoneDisplay,
      waba_id: wabaId,
      phone_number_id: phoneNumberId || null,
      subscribed,
      registered,
      warnings,
    });
  } catch (err) {
    console.error('[whatsappCloud] connect error:', err.message);
    return res.status(502).json({ error: String(err.message).slice(0, 200) });
  }
});

// ── POST /whatsapp/disconnect ───────────────────────────────
// Antes de esquecer a credencial, soltar a assinatura do webhook: o
// token some daqui, mas a WABA continuaria mandando evento para um app
// que não sabe mais de quem é o número.
router.post('/whatsapp/disconnect', ...guard, async (req, res) => {
  try {
    try {
      const conn = await loadCompanyWa(req.params.id);
      if (conn && conn.wa_waba_id && conn.has_token) {
        const { rows: tok } = await db.query(
          'SELECT wa_access_token FROM companies WHERE id = $1 LIMIT 1', [req.params.id]
        );
        const stored = tok[0] && tok[0].wa_access_token;
        if (stored) await wa.unsubscribeApp(conn.wa_waba_id, waOutbox.decryptToken(stored));
      }
    } catch (e) {
      // Best-effort de verdade: desconectar do lado da Aura nunca pode
      // depender da Meta responder.
      console.warn('[whatsappCloud] unsubscribe best-effort falhou:', e.message);
    }
    await db.query(
      `UPDATE companies SET wa_waba_id=NULL, wa_phone_number_id=NULL, wa_phone_display=NULL,
              wa_access_token=NULL, wa_connected_at=NULL, updated_at=NOW()
        WHERE id=$1`,
      [req.params.id]
    );
    await clearConnExtras(req.params.id);
    return res.json({ disconnected: true });
  } catch (err) {
    console.error('[whatsappCloud] disconnect error:', err.message);
    return res.status(500).json({ error: 'Erro ao desconectar' });
  }
});

// Status do template de COBRANÇA no registro local (o status verdadeiro
// vem do webhook da Meta — nunca "achamos" que está aprovado).
async function loadBillingTemplate(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:status-template
       SELECT status FROM wa_templates
        WHERE company_id = $1 AND name = $2 AND language = 'pt_BR' LIMIT 1`,
      [companyId, billingTemplateName()]
    );
    return (rows[0] && rows[0].status) || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

// Consumo: só o que a Meta COBROU (sent/delivered/read). Fuso de São
// Paulo porque "hoje" para o dono do dojô é o dia dele, não o do UTC —
// um envio das 22h viraria "amanhã" e o teto diário perderia o sentido.
async function loadUsage(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:status-usage
       SELECT
         COUNT(*) FILTER (
           WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date
               = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today_sent,
         COUNT(*) FILTER (
           WHERE date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo')
               = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS month_sent
         FROM wa_outbox
        WHERE company_id = $1 AND status IN ('sent','delivered','read')`,
      [companyId]
    );
    return {
      today_sent: Number((rows[0] && rows[0].today_sent) || 0),
      month_sent: Number((rows[0] && rows[0].month_sent) || 0),
    };
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return { today_sent: 0, month_sent: 0 };
    throw e;
  }
}

// ── GET /whatsapp/status ────────────────────────────────────
// Este endpoint é o que a tela usa para DESABILITAR o toggle de envio
// automático. Cada campo aqui é um motivo possível de "não pode ligar":
// sem adicional, sem número, template não aprovado, fila pausada.
router.get('/whatsapp/status', ...guard, async (req, res) => {
  try {
    const conn = await loadCompanyWa(req.params.id);
    let queue = null;
    try {
      const { rows } = await db.query(
        `SELECT status, COUNT(*)::int AS n FROM wa_outbox WHERE company_id = $1 GROUP BY status`,
        [req.params.id]
      );
      queue = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }
    const extras = await loadConnExtras(req.params.id);
    const addonActive = await addons.hasAddon(req.params.id, addons.ADDON_WHATSAPP_AUTO);
    const templateStatus = await loadBillingTemplate(req.params.id);
    const usage = await loadUsage(req.params.id);
    // Token recusado pela Meta derruba o "conectado": o selo verde com
    // credencial morta era pior do que não ter selo (QA 26/08).
    const tokenExpired = !!(conn && conn.wa_token_invalid_at);
    return res.json({
      connected: !!(conn && conn.wa_phone_number_id && conn.has_token && !tokenExpired),
      token_expired: tokenExpired,
      token_expired_at: (conn && conn.wa_token_invalid_at) || null,
      phone_display: (conn && conn.wa_phone_display) || null,
      waba_id: (conn && conn.wa_waba_id) || null,
      phone_number_id: (conn && conn.wa_phone_number_id) || null,
      connected_at: (conn && conn.wa_connected_at) || null, // compat legado
      queue: queue || {},
      schema_pending: queue === null,

      addon_active: addonActive,
      template_name: billingTemplateName(),
      template_status: templateStatus,
      template_ready: templateStatus === 'APPROVED',
      quality_rating: (extras && extras.wa_quality_rating) || null,
      paused_reason: (extras && extras.wa_paused_reason) || null,
      paused_at: (extras && extras.wa_paused_at) || null,
      subscribed: !!(extras && extras.wa_subscribed_at),
      registered: !!(extras && extras.wa_registered_at),
      usage: { ...usage, daily_cap: dailyCap() },
      // A tela do dojô monta o Embedded Signup com isto; sem config_id
      // não há botão (e não adianta pedir para "conectar").
      embedded_signup: {
        app_id: process.env.WA_APP_ID || null,
        config_id: process.env.WA_ES_CONFIG_ID || null,
        graph_version: 'v21.0',
      },
    });
  } catch (e) {
    console.error('[whatsappCloud] status error:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar o status do WhatsApp' });
  }
});

// ── GET /whatsapp/templates ─────────────────────────────────
router.get('/whatsapp/templates', ...guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT name, language, category, status, body_preview, last_status_at
         FROM wa_templates WHERE company_id = $1 ORDER BY name ASC, language ASC`,
      [req.params.id]
    );
    // `data` é o shape do app; `templates`/`total` mantêm o contrato do
    // router legado que esta rota substituiu.
    return res.json({ data: rows, templates: rows, total: rows.length });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res);
    console.error('[whatsappCloud] templates error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar templates' });
  }
});

// ── POST /whatsapp/templates/sync — puxa da Meta ────────────
router.post('/whatsapp/templates/sync', ...guard, async (req, res) => {
  try {
    const conn = await loadCompanyWa(req.params.id);
    if (!conn || !conn.wa_waba_id || !conn.has_token) {
      return res.status(409).json({ error: 'WhatsApp não conectado (WABA/token ausentes)', code: 'NAO_CONECTADO' });
    }
    const { rows: tok } = await db.query(
      'SELECT wa_access_token FROM companies WHERE id = $1 LIMIT 1', [req.params.id]
    );
    // Token cifrado em repouso (A9) — decifrar antes de falar com a Meta.
    const list = await wa.listTemplates(conn.wa_waba_id, waOutbox.decryptToken(tok[0].wa_access_token));
    // listTemplates JÁ devolve o array (data.data). Aceitar as duas formas
    // evita o bug de "0 sincronizados" com templates existentes.
    const items = Array.isArray(list) ? list : ((list && list.data) || []);
    let synced = 0;
    for (const t of items) {
      await waOutbox.applyTemplateStatus(req.params.id, {
        name: t.name, language: t.language, status: t.status,
        metaTemplateId: t.id != null ? String(t.id) : null,
      });
      synced++;
    }
    return res.json({ synced });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res);
    if (isTokenError(e)) {
      await markTokenInvalid(req.params.id, e.message);
      return tokenExpiredResponse(res, e);
    }
    console.error('[whatsappCloud] sync error:', e.message);
    return res.status(502).json({ error: 'Falha ao consultar a Meta: ' + String(e.message).slice(0, 200) });
  }
});

// ── POST /whatsapp/templates — cria na Meta e registra ──────
// Body: { name?, language?, category?, body?, footer? }. Sem body,
// usa o TEMPLATE PADRÃO DE COBRANÇA (4 variáveis, categoria UTILITY —
// cobrança é utilitário, não marketing: aprova mais rápido e não cai
// nas regras de opt-in de marketing).
const DEFAULT_BILLING_TEMPLATE = {
  name: 'mensalidade_lembrete',
  language: 'pt_BR',
  category: 'UTILITY',
  body: 'Olá, {{1}}! Lembrete da mensalidade de {{2}}: {{3}}, com vencimento em {{4}}. Qualquer dúvida, é só responder esta mensagem.',
  footer: 'Para não receber mais, responda SAIR.',
};

router.post('/whatsapp/templates', ...guard, async (req, res) => {
  const b = req.body || {};
  const tpl = {
    name: (b.name || DEFAULT_BILLING_TEMPLATE.name).trim(),
    language: b.language || DEFAULT_BILLING_TEMPLATE.language,
    category: b.category || DEFAULT_BILLING_TEMPLATE.category,
    body: b.body || DEFAULT_BILLING_TEMPLATE.body,
    footer: b.footer !== undefined ? b.footer : DEFAULT_BILLING_TEMPLATE.footer,
  };
  try {
    const conn = await loadCompanyWa(req.params.id);
    if (!conn || !conn.wa_waba_id || !conn.has_token) {
      return res.status(409).json({ error: 'WhatsApp não conectado (WABA/token ausentes)', code: 'NAO_CONECTADO' });
    }
    const { rows: tok } = await db.query(
      'SELECT wa_access_token FROM companies WHERE id = $1 LIMIT 1', [req.params.id]
    );
    // Exemplos são exigidos pela Meta quando o corpo tem variáveis.
    const nVars = (tpl.body.match(/\{\{\d+\}\}/g) || []).length;
    const example = nVars
      ? { body_text: [['Ana Souza', 'agosto/2026', 'R$ 150,00', '10/08/2026'].slice(0, nVars)] }
      : undefined;
    const components = [{ type: 'BODY', text: tpl.body, ...(example ? { example } : {}) }];
    if (tpl.footer) components.push({ type: 'FOOTER', text: tpl.footer });

    const created = await wa.createTemplate(conn.wa_waba_id, waOutbox.decryptToken(tok[0].wa_access_token), {
      name: tpl.name, language: tpl.language, category: tpl.category, components,
    });
    await waOutbox.applyTemplateStatus(req.params.id, {
      name: tpl.name, language: tpl.language,
      status: created && created.status ? created.status : 'PENDING',
      metaTemplateId: created && created.id != null ? String(created.id) : null,
    });
    // Guarda a prévia para a UI mostrar o texto sem ir à Meta.
    await db.query(
      `UPDATE wa_templates SET body_preview = $1, category = $2, updated_at = NOW()
        WHERE company_id = $3 AND name = $4 AND language = $5`,
      [tpl.body, tpl.category, req.params.id, tpl.name, tpl.language]
    ).catch(() => {});
    return res.status(201).json({ name: tpl.name, language: tpl.language, meta: created });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res);
    if (isTokenError(e)) {
      await markTokenInvalid(req.params.id, e.message);
      return tokenExpiredResponse(res, e);
    }
    console.error('[whatsappCloud] create template error:', e.message);
    return res.status(502).json({ error: 'Falha ao criar o template na Meta: ' + String(e.message).slice(0, 200) });
  }
});

// ── GET /whatsapp/outbox ────────────────────────────────────
router.get('/whatsapp/outbox', ...guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, to_phone, kind, template_name, status, skip_reason, attempts,
              last_error, source_type, created_at, updated_at
         FROM wa_outbox WHERE company_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    return res.json({ data: rows });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res);
    console.error('[whatsappCloud] outbox error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar a fila' });
  }
});

// ── POST /whatsapp/test-send — sandbox: enfileira e despacha ─
// Body: { to, template_name?, language?, components?, text? }
router.post('/whatsapp/test-send', ...guard, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await waOutbox.enqueue({
      companyId: req.params.id,
      toPhone: b.to,
      kind: b.text ? 'text' : 'template',
      templateName: b.template_name || null,
      templateLanguage: b.language || 'pt_BR',
      components: b.components || null,
      textBody: b.text || null,
      sourceType: 'teste',
    });
    if (!r.queued && r.reason !== 'DUPLICADO') {
      return res.status(422).json({ error: `Não enfileirado: ${r.reason}`, code: r.reason });
    }
    const batch = await waOutbox.processBatch(5);
    const { rows } = await db.query(
      `SELECT status, skip_reason, last_error, wa_message_id FROM wa_outbox WHERE id = $1`, [r.id]
    );
    return res.json({ outbox_id: r.id, result: rows[0] || null, batch });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res);
    console.error('[whatsappCloud] test-send error:', e.message);
    return res.status(500).json({ error: 'Erro no envio de teste' });
  }
});

// ── POST /whatsapp/contacts/opt — opt manual ────────────────
// Body: { phone, action: 'in' | 'out' }
router.post('/whatsapp/contacts/opt', ...guard, async (req, res) => {
  const b = req.body || {};
  const phone = waOutbox.normalizePhone(b.phone);
  if (!phone || !['in', 'out'].includes(b.action)) {
    return res.status(422).json({ error: 'phone válido e action in|out são obrigatórios', code: 'VALIDATION_ERROR' });
  }
  try {
    await db.query(
      `INSERT INTO wa_contacts (company_id, phone, opted_in_at, opted_out_at, opt_source)
       VALUES ($1,$2, CASE WHEN $3 = 'in' THEN NOW() END, CASE WHEN $3 = 'out' THEN NOW() END, 'manual')
       ON CONFLICT (company_id, phone) DO UPDATE SET
         opted_in_at  = CASE WHEN $3 = 'in' THEN NOW() ELSE NULL END,
         opted_out_at = CASE WHEN $3 = 'out' THEN NOW() ELSE NULL END,
         opt_source = 'manual', updated_at = NOW()`,
      [req.params.id, phone, b.action]
    );
    return res.json({ phone, action: b.action });
  } catch (e) {
    if (e.code === '42P01') return schemaPending(res);
    console.error('[whatsappCloud] opt error:', e.message);
    return res.status(500).json({ error: 'Erro ao registrar o opt' });
  }
});

module.exports = router;
