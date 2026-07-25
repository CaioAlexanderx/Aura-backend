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
//
// ── GATE DE CONEXÃO (polish 25/07/2026) ─────────────────────
// companies.karate_dojo_linked_at (migration 251, PR #420) é a CONEXÃO do
// dojô com a federação; federation_id é só vínculo TÉCNICO (roteamento +
// guard). O #420 fechou o lado da federação (ela não enxerga dojô não
// conectado); o QA de produção mostrou o buraco INVERSO — /dojo/events
// devolvia os exames/cursos reais da FPKT e /dojo/annuity falava em
// "filiação à federação" para um dojô que nunca se conectou.
//
// Regra: as superfícies FEDERATIVAS só existem depois da conexão.
//   /dojo/me      → sempre responde; ganha linked + linked_at (aditivo)
//   /dojo/events  → não conectado: 200 vazio + not_linked:true
//   /dojo/annuity → não conectado: 200 vazio + not_linked:true
// NUNCA 403: o front precisa distinguir "sem eventos" de "não conectado"
// para mostrar o estado explicativo certo (403 vira erro genérico).
//
// /dojo/practitioners NÃO é gateado: é a lista dos praticantes DO PRÓPRIO
// dojô — para um dojô não conectado ela simplesmente vem vazia, e não há
// conteúdo da federação vazando.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const { getDojoLinkStatus } = require('../services/karateDojoLinkStatus');

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

    // Status de conexão com a federação (ADITIVO — nada foi removido ou
    // renomeado; o front atual depende do shape acima). Query separada de
    // propósito: se karate_dojo_linked_at entrasse no SELECT principal, a
    // ausência da coluna (migration 251 pendente) derrubaria o /dojo/me
    // inteiro com 42703. Fail-open dentro do helper → linked:true.
    const link = await getDojoLinkStatus(req.dojoId);

    res.json({
      dojo: {
        id: dojo.id,
        name: dojo.trade_name || dojo.legal_name,
        phone: dojo.phone,
        federation_id: dojo.federation_id,
        auth_channel: req.dojoAuthChannel, // 'A' | 'B'
        linked: link.linked,               // karate_dojo_linked_at IS NOT NULL
        linked_at: link.linked_at,         // ISO 8601 UTC | null
      },
      // Espelhados no topo para o front não precisar cavar o objeto só
      // para decidir se renderiza a área da federação.
      linked: link.linked,
      linked_at: link.linked_at,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/me error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /federation/:id/dojo/events
// Lista eventos (exames/cursos) ABERTOS da federação — consulta read-only
// para o painel do sensei. A inscrição é intermediada pela federação.
// Dojô NÃO conectado: 200 vazio + not_linked:true (nunca 403 — ver topo).
router.get('/dojo/events', requireDojoAccess, async (req, res) => {
  try {
    const link = await getDojoLinkStatus(req.dojoId);
    if (!link.linked) {
      // Mesmas chaves do caso conectado (`events`, `count`, `federation`)
      // + `data` (alias) para o front novo. Nada da federação é lido.
      return res.json({
        events: [],
        data: [],
        count: 0,
        federation: null,
        not_linked: true,
      });
    }

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

// GET /federation/:id/dojo/practitioners
// Lista nominal (read-only) dos praticantes do dojô + faixa atual.
router.get('/dojo/practitioners', requireDojoAccess, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cu.id AS practitioner_id, cu.name, cu.is_active,
              cb.belt_level, cb.belt_name
         FROM customers cu
         LEFT JOIN karate_current_belt cb
                ON cb.student_id = cu.id AND cb.federation_id = $1
        WHERE cu.dojo_id = $2
        ORDER BY cu.name ASC`,
      [req.federationId, req.dojoId]
    );
    res.json({
      practitioners: rows.map(r => ({
        practitioner_id: r.practitioner_id,
        name: r.name,
        is_active: r.is_active !== false,
        belt_level: r.belt_level || null,
        belt_name: r.belt_name || null,
      })),
      count: rows.length,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/practitioners error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar praticantes' });
  }
});

// GET /federation/:id/dojo/annuity
// Situacao + historico da anuidade do dojo (read-only) + chave PIX da
// federacao para pagamento. "Pago" = paid_at nao-nulo. Degradacao graceful
// se a tabela/coluna ainda nao existir.
// A anuidade AQUI é a da FILIAÇÃO à federação (não a mensalidade que o
// dojô cobra dos alunos — essa é F3a, interna, e não é gateada). Dojô NÃO
// conectado: 200 vazio + not_linked:true, mesmas chaves de sempre.
router.get('/dojo/annuity', requireDojoAccess, async (req, res) => {
  try {
    const link = await getDojoLinkStatus(req.dojoId);
    if (!link.linked) {
      return res.json({
        pending: null,
        history: [],
        pix: null,
        not_linked: true,
      });
    }

    let history = [];
    try {
      const { rows } = await db.query(
        `SELECT id, reference_period, amount, status, paid_at, due_date
           FROM karate_dojo_annuity_history
          WHERE dojo_id = $1 AND federation_id = $2
          ORDER BY reference_period DESC
          LIMIT 24`,
        [req.dojoId, req.federationId]
      );
      history = rows;
    } catch (_) { /* tabela ausente — degradacao graceful */ }

    const pending = history.find(h => !h.paid_at) || null;

    let pix = null;
    try {
      const { rows: dcc } = await db.query(
        `SELECT pix_key, pix_key_type, pix_holder_name
           FROM digital_channel_config WHERE company_id = $1 LIMIT 1`,
        [req.federationId]
      );
      if (dcc.length && dcc[0].pix_key) {
        pix = {
          key: dcc[0].pix_key,
          key_type: dcc[0].pix_key_type || null,
          holder_name: dcc[0].pix_holder_name || null,
        };
      }
    } catch (_) { /* pix opcional */ }

    res.json({
      pending: pending ? {
        annuity_history_id: pending.id,
        reference_period: pending.reference_period,
        amount: pending.amount != null ? Number(pending.amount) : null,
        status: pending.status,
        due_date: pending.due_date || null,
      } : null,
      history: history.map(h => ({
        annuity_history_id: h.id,
        reference_period: h.reference_period,
        amount: h.amount != null ? Number(h.amount) : null,
        status: h.status,
        paid_at: h.paid_at || null,
        due_date: h.due_date || null,
      })),
      pix,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar anuidade' });
  }
});

module.exports = router;
