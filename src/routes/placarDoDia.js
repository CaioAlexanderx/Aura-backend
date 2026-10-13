// ============================================================
// AURA. — Placar do dia: preferencia da loja (13/10/2026)
//
//   GET /companies/:id/placar-do-dia
//   PUT /companies/:id/placar-do-dia   { enabled: boolean, always?: boolean }
//
// O placar e o resumo de fim de dia enviado ao dono pelo WhatsApp da propria
// loja (services/placarDoDia). Default DESLIGADO. `always` e o segundo campo:
// sem ele o placar roda so na temporada (services/temporada.TEMPORADA).
//
// Gate do PUT: so dono/admin da empresa (req.companyRole, carimbado por
// requireCompanyAccess em routes/private.js). A resposta ja traz o que a tela
// precisa para explicar por que um placar ligado nao chega: WhatsApp
// conectado, telefone do dono e template aprovado.
//
// Migration 377 pendente (42703): 503 MIGRATION_PENDING, sem quebrar o resto.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const waOutbox = require('../services/waOutbox');
const placar = require('../services/placarDoDia');
const { TEMPORADA } = require('../services/temporada');

function podeMexer(req) {
  return req.companyRole === 'owner' || req.companyRole === 'admin';
}

const PENDENTE = {
  error: 'Placar do dia indisponivel (migration 377 pendente).',
  code: 'MIGRATION_PENDING',
};

async function estado(companyId) {
  const loja = await placar.carregarLoja(companyId);
  if (!loja) return null;
  // "Hoje esta dentro da validade?" — independe do toggle, por isso o
  // enabled forcado: a tela mostra a janela mesmo com o placar desligado.
  const hoje = placar.ativoNoDia({ ...loja, placar_do_dia_enabled: true }, placar.hojeBRT());
  const conn = await waOutbox.connectionState(companyId);
  const templateOk = await waOutbox.isTemplateApproved(
    companyId, placar.TEMPLATE.name, placar.TEMPLATE.language
  );
  return {
    enabled: loja.placar_do_dia_enabled === true,
    always: loja.placar_do_dia_sempre === true,
    season: { starts_at: TEMPORADA.starts_at, ends_at: TEMPORADA.ends_at },
    in_season_today: hoje.ativo,
    whatsapp_connected: conn.connected,
    owner_phone_present: !!waOutbox.normalizePhone(loja.owner_phone),
    template_name: placar.TEMPLATE.name,
    template_approved: templateOk,
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const out = await estado(req.params.id);
  if (!out) return res.status(503).json(PENDENTE);
  res.json(out);
}));

router.put('/', asyncHandler(async (req, res) => {
  if (!podeMexer(req)) {
    return res.status(403).json({
      error: 'So o dono da conta liga o placar do dia.',
      code: 'PLACAR_FORBIDDEN',
      your_role: req.companyRole || null,
    });
  }
  const body = req.body || {};
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled deve ser true ou false.', code: 'PLACAR_ENABLED_INVALID' });
  }
  if (body.always !== undefined && typeof body.always !== 'boolean') {
    return res.status(400).json({ error: 'always deve ser true ou false.', code: 'PLACAR_ALWAYS_INVALID' });
  }

  const companyId = req.params.id;
  try {
    const { rowCount } = await db.query(
      `UPDATE companies
          SET placar_do_dia_enabled = $2,
              placar_do_dia_sempre  = COALESCE($3, placar_do_dia_sempre)
        WHERE id = $1`,
      [companyId, body.enabled, body.always === undefined ? null : body.always]
    );
    if (!rowCount) return res.status(404).json({ error: 'Empresa nao encontrada.' });
  } catch (e) {
    if (e.code === '42703') return res.status(503).json(PENDENTE);
    throw e;
  }

  // Best-effort: a trilha nunca derruba a gravacao da preferencia.
  Promise.resolve(db.query(
    `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
     VALUES ($1, $2, 'placar.preferencia', $3, $4::jsonb)`,
    [req.user?.id || null, companyId, body.enabled ? 'ligado' : 'desligado',
      JSON.stringify({ enabled: body.enabled, always: body.always === undefined ? null : body.always })]
  )).catch(() => {});

  res.json(await estado(companyId));
}));

module.exports = router;
