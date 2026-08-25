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

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireCompanyAccess } = require('../middleware/auth');
const waOutbox = require('../services/waOutbox');
const wa = require('../services/whatsapp');
const { encrypt } = require('../services/dojoBaasCrypto');

const guard = [requireAuth, requireCompanyAccess({})];

function schemaPending(res) {
  return res.status(503).json({ error: 'WhatsApp indisponível (migração 307 pendente)', code: 'SCHEMA_PENDING' });
}

async function loadCompanyWa(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT wa_waba_id, wa_phone_number_id, wa_phone_display, wa_connected_at,
              wa_access_token IS NOT NULL AS has_token
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42703') return null;
    throw e;
  }
}

// ── POST /whatsapp/connect — Embedded Signup ────────────────
// Body: { code, waba_id, phone_number_id }. O token permanente é
// gravado CIFRADO em repouso (A9) — quem envia decifra (waOutbox).
router.post('/whatsapp/connect', ...guard, async (req, res) => {
  const { code, waba_id, phone_number_id } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Authorization code obrigatorio', code: 'VALIDATION_ERROR' });
  try {
    const accessToken = await wa.exchangeCodeForToken(code);
    let phoneDisplay = '';
    if (phone_number_id) {
      try {
        const info = await wa.getPhoneInfo(phone_number_id, accessToken);
        phoneDisplay = info.display_phone_number || '';
      } catch { /* display é conforto, não requisito */ }
    }
    await db.query(
      `UPDATE companies SET
         wa_waba_id=$1, wa_phone_number_id=$2, wa_phone_display=$3,
         wa_access_token=$4, wa_connected_at=NOW(), updated_at=NOW()
       WHERE id=$5`,
      [waba_id || null, phone_number_id || null, phoneDisplay, encrypt(accessToken), req.params.id]
    );
    return res.json({ connected: true, phone_display: phoneDisplay, waba_id: waba_id || null });
  } catch (err) {
    console.error('[whatsappCloud] connect error:', err.message);
    return res.status(502).json({ error: String(err.message).slice(0, 200) });
  }
});

// ── POST /whatsapp/disconnect ───────────────────────────────
router.post('/whatsapp/disconnect', ...guard, async (req, res) => {
  try {
    await db.query(
      `UPDATE companies SET wa_waba_id=NULL, wa_phone_number_id=NULL, wa_phone_display=NULL,
              wa_access_token=NULL, wa_connected_at=NULL, updated_at=NOW()
        WHERE id=$1`,
      [req.params.id]
    );
    return res.json({ disconnected: true });
  } catch (err) {
    console.error('[whatsappCloud] disconnect error:', err.message);
    return res.status(500).json({ error: 'Erro ao desconectar' });
  }
});

// ── GET /whatsapp/status ────────────────────────────────────
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
    return res.json({
      connected: !!(conn && conn.wa_phone_number_id && conn.has_token),
      phone_display: (conn && conn.wa_phone_display) || null,
      waba_id: (conn && conn.wa_waba_id) || null,
      connected_at: (conn && conn.wa_connected_at) || null, // compat legado
      queue: queue || {},
      schema_pending: queue === null,
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
