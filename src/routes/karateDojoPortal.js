// ============================================================
// AURA KARATÊ — Portal do Dojô (Canal B / link fixo, dojô SEM Aura)
// Montado em /federation/:id/dojo (mergeParams). Auth = Guard B
// (requireDojoPortal + requireDojoOfFederation): o token resolve dojo_id +
// federation_id; o escopo é SEMPRE o próprio dojô (req.dojo.dojo_id), nunca
// vindo do corpo/query.
//
// Escopo DECIDIDO (consulta + pagar anuidade — nada destrutivo):
//   GET  /federation/:id/dojo/me            — dados do próprio dojô
//   GET  /federation/:id/dojo/practitioners — lista nominal read-only
//   GET  /federation/:id/dojo/annuity       — status + histórico de anuidade
//   POST /federation/:id/dojo/annuity/pix   — PIX self-service da anuidade pendente
//   GET  /federation/:id/dojo/certificates  — status dos próprios pedidos de cert.
//
// Inscrição em evento, ranking e verificação NÃO ficam aqui — o sensei usa as
// páginas públicas normais. Gestão (inscrição em lote, submissão a exame) é
// exclusiva do Aura Dojô (Canal A).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireDojoPortal, requireDojoOfFederation } = require('../middleware/karateDojoPortalToken');
const { createPixCharge } = require('../services/karatePaymentProvider');

// Todas as rotas exigem Guard B + pertencimento à federação da rota.
router.use(requireDojoPortal, requireDojoOfFederation);

// status simples do dojô (sem depender do helper privado de karateDojos)
function dojoStatus(isActive, affiliationSince) {
  if (!isActive) return 'inactive';
  return affiliationSince ? 'active' : 'pending';
}

// ── GET /me — dados do próprio dojô ─────────────────────────
router.get('/me', async (req, res) => {
  const { dojo_id, federation_id } = req.dojo;
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.region, c.fpkt_affiliation_id,
              c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
              c.phone, c.email, c.is_active, c.karate_logo_url,
              COUNT(cu.id) AS practitioner_count
         FROM companies c
         LEFT JOIN customers cu ON cu.dojo_id = c.id
        WHERE c.id = $1 AND c.federation_id = $2 AND c.vertical = 'karate_dojo'
        GROUP BY c.id`,
      [dojo_id, federation_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    const d = rows[0];
    res.json({
      id: d.id,
      name: d.name,
      cnpj: d.cnpj || null,
      sensei_cpf: d.sensei_cpf || null,
      region: d.region || null,
      fpkt_affiliation_id: d.fpkt_affiliation_id || null,
      affiliation_model: d.affiliation_model || null,
      affiliation_since: d.affiliation_since || null,
      dojo_founded_year: d.dojo_founded_year || null,
      phone: d.phone || null,
      email: d.email || null,
      karate_logo_url: d.karate_logo_url || null,
      status: dojoStatus(d.is_active, d.affiliation_since),
      practitioner_count: parseInt(d.practitioner_count, 10) || 0,
    });
  } catch (err) {
    console.error('[karateDojoPortal] me error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dojô' });
  }
});

// ── GET /practitioners — lista nominal read-only ────────────
router.get('/practitioners', async (req, res) => {
  const { dojo_id, federation_id } = req.dojo;
  try {
    const { rows } = await db.query(
      `SELECT cu.id AS practitioner_id, cu.name,
              cb.belt_level, cb.belt_name
         FROM customers cu
         LEFT JOIN karate_current_belt cb
                ON cb.student_id = cu.id AND cb.federation_id = $1
        WHERE cu.dojo_id = $2
        ORDER BY cu.name ASC`,
      [federation_id, dojo_id]
    );
    res.json({
      practitioners: rows.map(r => ({
        practitioner_id: r.practitioner_id,
        name: r.name,
        belt_level: r.belt_level || null,
        belt_name: r.belt_name || null,
      })),
      count: rows.length,
    });
  } catch (err) {
    console.error('[karateDojoPortal] practitioners error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar praticantes' });
  }
});

// ── GET /annuity — status + histórico da anuidade do dojô ───
router.get('/annuity', async (req, res) => {
  const { dojo_id, federation_id } = req.dojo;
  try {
    let history = [];
    try {
      const { rows } = await db.query(
        `SELECT id, reference_period, amount, status, paid_at, due_date
           FROM karate_dojo_annuity_history
          WHERE dojo_id = $1 AND federation_id = $2
          ORDER BY reference_period DESC
          LIMIT 24`,
        [dojo_id, federation_id]
      );
      history = rows;
    } catch (_) { /* tabela ainda não aplicada — degradação graceful */ }

    const pending = history.find(h => h.status !== 'paid') || null;
    res.json({
      pending: pending
        ? { annuity_history_id: pending.id, reference_period: pending.reference_period,
            amount: pending.amount, status: pending.status, due_date: pending.due_date || null }
        : null,
      history: history.map(h => ({
        annuity_history_id: h.id,
        reference_period: h.reference_period,
        amount: h.amount,
        status: h.status,
        paid_at: h.paid_at || null,
      })),
    });
  } catch (err) {
    console.error('[karateDojoPortal] annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar anuidade' });
  }
});

// ── POST /annuity/pix — PIX self-service da anuidade pendente ──
// O dojô gera o PIX da PRÓPRIA anuidade (sem depender do admin). Reusa
// createPixCharge + karate_payment_intents. Idempotente: reaproveita intent
// pendente existente.
router.post('/annuity/pix', async (req, res) => {
  const { dojo_id, federation_id } = req.dojo;
  const { annuity_history_id } = req.body || {};
  if (!annuity_history_id) {
    return res.status(422).json({ error: 'annuity_history_id obrigatório', code: 'VALIDATION_ERROR' });
  }
  try {
    // A cobrança DEVE ser do próprio dojô (escopo do servidor).
    const { rows } = await db.query(
      `SELECT h.*, c.name AS dojo_name
         FROM karate_dojo_annuity_history h
         JOIN companies c ON c.id = h.dojo_id
        WHERE h.id = $1 AND h.dojo_id = $2 AND h.federation_id = $3
        LIMIT 1`,
      [annuity_history_id, dojo_id, federation_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cobrança não encontrada', code: 'NOT_FOUND' });
    const annuity = rows[0];
    if (annuity.status === 'paid') {
      return res.status(409).json({ error: 'Anuidade já paga', code: 'CONFLICT' });
    }

    // Reaproveita intent pendente, se houver.
    const { rows: existing } = await db.query(
      `SELECT id, payment_intent_id, payload, qr_image, status, expires_at, provider
         FROM karate_payment_intents
        WHERE annuity_history_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [annuity_history_id]
    );
    if (existing.length) {
      const i = existing[0];
      return res.json({
        intent_id: i.id, payment_intent_id: i.payment_intent_id, payload: i.payload,
        qr_image: i.qr_image, status: i.status, expires_at: i.expires_at, provider: i.provider,
      });
    }

    const txid = `dojo-${dojo_id.slice(0, 8)}-${annuity.reference_period}`;
    const pix = await createPixCharge({
      federationId: federation_id,
      amount: parseFloat(annuity.amount),
      txid,
      description: `Anuidade ${annuity.dojo_name} — ${annuity.reference_period}`,
    });

    const { rows: intentRows } = await db.query(
      `INSERT INTO karate_payment_intents
         (federation_id, annuity_history_id, transaction_id, provider,
          payment_intent_id, payload, qr_image, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW())
       RETURNING id`,
      [federation_id, annuity_history_id, annuity.transaction_id, pix.provider,
       pix.payment_intent_id, pix.payload, pix.qr_image || null, pix.expires_at]
    );

    res.status(201).json({
      intent_id: intentRows[0].id, payment_intent_id: pix.payment_intent_id,
      payload: pix.payload, qr_image: pix.qr_image, status: pix.status,
      expires_at: pix.expires_at, provider: pix.provider, _warn: pix._warn,
    });
  } catch (err) {
    console.error('[karateDojoPortal] pix error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar PIX', detail: err.message });
  }
});

// ── GET /certificates — status dos próprios pedidos de cert. ──
router.get('/certificates', async (req, res) => {
  const { dojo_id, federation_id } = req.dojo;
  try {
    let orders = [];
    try {
      const { rows } = await db.query(
        `SELECT co.id, co.practitioner_id, cu.name AS practitioner_name,
                co.belt_level, co.belt_name, co.status, co.created_at
           FROM karate_certificate_orders co
           LEFT JOIN customers cu ON cu.id::text = co.practitioner_id
          WHERE co.dojo_id = $1 AND co.federation_id = $2
          ORDER BY co.created_at DESC
          LIMIT 50`,
        [dojo_id, federation_id]
      );
      orders = rows;
    } catch (_) { /* tabela ainda não aplicada — degradação graceful */ }

    res.json({
      orders: orders.map(o => ({
        id: o.id,
        practitioner_id: o.practitioner_id,
        practitioner_name: o.practitioner_name || null,
        belt_level: o.belt_level,
        belt_name: o.belt_name,
        status: o.status,
        created_at: o.created_at,
      })),
      count: orders.length,
    });
  } catch (err) {
    console.error('[karateDojoPortal] certificates error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar certificados' });
  }
});

module.exports = router;
