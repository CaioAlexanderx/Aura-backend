// ============================================================
// AURA KARATÊ — Endpoints escopados ao Dojô (Fase 0 Keystone)
//
// Montado em /federation/:id (via index.js).
// Aceita Canal A (JWT Aura Dojô com dojo_id) e Canal B (dojo portal token).
// Ambos são resolvidos por requireDojoAccess → req.dojoId + req.federationId.
//
// Endpoints efetivos (Fase 0):
//   GET /federation/:id/dojo/me  — contexto do dojô autenticado (piloto)
//
// Fases seguintes:
//   Fase 1: /dojo/cert-orders, /dojo/aptos
//   Fase 2: /dojo/annuity, /dojo/annuity/pix
//   Fase 3: /dojo/events, /dojo/events/:id/enroll
//   etc.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');

// GET /federation/:id/dojo/me
// Retorna dados do dojô autenticado + canal de autenticação usado.
// Usado pelo app (Canal A) e portal off-app (Canal B) para hidratar contexto.
router.get('/dojo/me', requireDojoAccess, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.legal_name, c.trade_name, c.phone,
              c.federation_id, c.vertical, c.created_at,
              u.email AS owner_email
         FROM companies c
         LEFT JOIN users u ON u.id = c.owner_id
        WHERE c.id = $1
          AND c.federation_id = $2
          AND c.vertical = 'karate_dojo'
          AND c.is_active = true`,
      [req.dojoId, req.federationId]
    );
    if (!rows.length) {
      return res.status(404).json({
        error: 'Dojô não encontrado ou não pertence a esta federação',
        code: 'DOJO_NOT_FOUND',
      });
    }
    const dojo = rows[0];
    res.json({
      dojo: {
        id: dojo.id,
        name: dojo.trade_name || dojo.legal_name,
        phone: dojo.phone,
        federation_id: dojo.federation_id,
        auth_channel: req.dojoAuthChannel, // 'A' | 'B'
      },
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/me error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /federation/:id/dojo/events
// Lista eventos (exames/cursos) ABERTOS da federação — consulta read-only
// para o painel do sensei. A inscrição é intermediada pela federação.
router.get('/dojo/events', requireDojoAccess, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, exam_type, event_date, location, fee_amount, status
         FROM karate_belt_exams
        WHERE federation_id = $1 AND status = 'open'
        ORDER BY event_date ASC NULLS LAST
        LIMIT 50`,
      [req.federationId]
    );

    // Contato da federação (best-effort) para o sensei solicitar inscrição.
    let federation = null;
    try {
      const fed = await db.query(
        `SELECT COALESCE(c.trade_name, c.legal_name) AS name, c.phone,
                u.email AS email
           FROM companies c
           LEFT JOIN users u ON u.id = c.owner_id
          WHERE c.id = $1
          LIMIT 1`,
        [req.federationId]
      );
      if (fed.rows.length) {
        federation = {
          name: fed.rows[0].name || null,
          email: fed.rows[0].email || null,
          phone: fed.rows[0].phone || null,
        };
      }
    } catch (_) { /* contato opcional — degradacao graceful */ }

    res.json({
      events: rows.map(e => ({
        id: e.id,
        name: e.name,
        exam_type: e.exam_type || 'exame',
        event_date: e.event_date,
        location: e.location || null,
        fee_amount: e.fee_amount != null ? Number(e.fee_amount) : null,
        status: e.status,
      })),
      count: rows.length,
      federation,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/events error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar eventos' });
  }
});

module.exports = router;
