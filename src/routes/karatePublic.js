// ============================================================
// AURA KARATÊ — Rotas Públicas (Track D / Fase 3)
// Montado em /public/karate (SEM auth de empresa). Auth própria:
//   - verify de carteirinha: token opaco (dados mínimos / LGPD)
//   - portal do praticante: OTP → JWT type:'portal' (requirePractitionerToken)
//   - portal público compartilhável: opt-in + public_token (nunca menores)
//   - inscrição pública: lookup por CPF + PIX (exame/curso reais;
//                        competição = stub 501 até a Track E)
//
// Ordem das rotas: caminhos LITERAIS antes dos :slug param.
// ============================================================
'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const db = require('../config/database');
const cards = require('../services/karateCardService');
const portalAuth = require('../services/karatePortalAuthService');
const { requirePractitionerToken } = require('../middleware/karatePortalToken');

let paymentProvider = null;
try { paymentProvider = require('../services/karatePaymentProvider'); } catch (_) {}

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

async function resolveFederation(slugOrId) {
  let fedId = null;
  const r = await db.query(
    `SELECT company_id FROM digital_channel_config WHERE slug = $1 LIMIT 1`,
    [slugOrId]
  );
  if (r.rows.length) fedId = r.rows[0].company_id;
  if (!fedId && /^[0-9a-fA-F-]{36}$/.test(slugOrId)) fedId = slugOrId;
  if (!fedId) return null;
  const c = await db.query(
    `SELECT id, COALESCE(trade_name, legal_name) AS name,
            COALESCE(karate_logo_url, logo_url) AS logo
     FROM companies WHERE id = $1 LIMIT 1`,
    [fedId]
  );
  return c.rows[0] || null;
}

// ── GET /verify/:token — verificação pública da carteirinha (mínimo) ──
router.get('/verify/:token', async (req, res) => {
  try {
    const data = await cards.verifyByToken(req.params.token);
    if (!data) {
      return res.status(404).json({ valid: false, error: 'Carteirinha não encontrada' });
    }
    res.json(data);
  } catch (err) {
    console.error('[karatePublic] verify error:', err.message);
    res.status(500).json({ error: 'Erro ao verificar carteirinha' });
  }
});

// ── GET /portal/me — portal AUTENTICADO (trajetória completa) ──
router.get('/portal/me', requirePractitionerToken, async (req, res) => {
  const { practitioner_id, federation_id } = req.practitioner;
  try {
    const pRes = await db.query(
      `SELECT cu.id, cu.name, cu.karate_registration_number, cu.dojo_id,
              COALESCE(cu.karate_photo_url, cu.photo_url) AS photo_url,
              COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
              cb.belt_level AS current_belt, cb.belt_name AS current_belt_name
       FROM customers cu
       LEFT JOIN companies dj ON dj.id = cu.dojo_id
       LEFT JOIN karate_current_belt cb
         ON cb.student_id = cu.id AND cb.federation_id = $2
       WHERE cu.id = $1 AND cu.federation_id = $2
       LIMIT 1`,
      [practitioner_id, federation_id]
    );
    if (!pRes.rows.length) return res.status(404).json({ error: 'Praticante não encontrado' });
    const p = pRes.rows[0];

    const [history, exams, certs, card, portal] = await Promise.all([
      db.query(
        `SELECT belt_level, belt_name, belt_schema, graduated_at, notes
         FROM karate_belt_history
         WHERE student_id = $1 AND federation_id = $2
         ORDER BY graduated_at ASC`,
        [practitioner_id, federation_id]
      ),
      db.query(
        `SELECT ec.target_belt, ec.target_belt_name, ec.status, be.event_date, be.location
         FROM karate_belt_exam_candidates ec
         JOIN karate_belt_exams be ON be.id = ec.exam_id
         WHERE ec.student_id = $1 AND be.federation_id = $2
         ORDER BY be.event_date DESC`,
        [practitioner_id, federation_id]
      ),
      db.query(
        `SELECT target_belt, status, certificate_url, issued_at
         FROM karate_certificates
         WHERE student_id = $1 AND federation_id = $2
         ORDER BY created_at DESC`,
        [practitioner_id, federation_id]
      ),
      cards.getCurrentCard({ federation_id, student_id: practitioner_id }),
      db.query(
        `SELECT public_opt_in, public_token FROM karate_practitioner_portal WHERE student_id = $1 LIMIT 1`,
        [practitioner_id]
      ),
    ]);

    res.json({
      practitioner: {
        id: p.id,
        name: p.name,
        karate_registration_number: p.karate_registration_number || null,
        dojo_id: p.dojo_id,
        dojo_name: p.dojo_name || null,
        photo_url: p.photo_url || null,
        current_belt: p.current_belt || null,
        current_belt_name: p.current_belt_name || null,
      },
      belt_history: history.rows,
      exams: exams.rows,
      certificates: certs.rows,
      card: card || null,
      public_portal: {
        opt_in: portal.rows[0]?.public_opt_in || false,
        public_token: portal.rows[0]?.public_token || null,
      },
    });
  } catch (err) {
    console.error('[karatePublic] portal/me error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar portal' });
  }
});

// ── POST /portal/opt-in — liga/desliga portal público (autenticado) ──
// Menores NUNCA podem habilitar (LGPD Art. 14).
router.post('/portal/opt-in', requirePractitionerToken, async (req, res) => {
  const { practitioner_id, federation_id } = req.practitioner;
  const optIn = req.body?.opt_in === true;
  try {
    const card = await cards.getCurrentCard({ federation_id, student_id: practitioner_id });
    const isMinor = card ? card.is_minor : cards.computeIsMinor(
      (await db.query(`SELECT birth_date FROM customers WHERE id = $1`, [practitioner_id])).rows[0]?.birth_date
    );

    if (optIn && isMinor) {
      return res.status(403).json({
        error: 'Perfil público não é permitido para menores de idade (LGPD Art. 14).',
        code: 'MINOR_PUBLIC_BLOCKED',
      });
    }

    const publicToken = optIn ? crypto.randomBytes(16).toString('hex') : null;
    await db.query(
      `INSERT INTO karate_practitioner_portal (student_id, federation_id, public_opt_in, public_token, opt_in_at, updated_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (student_id) DO UPDATE
         SET public_opt_in = EXCLUDED.public_opt_in,
             public_token  = EXCLUDED.public_token,
             opt_in_at     = EXCLUDED.opt_in_at,
             updated_at    = NOW()`,
      [practitioner_id, federation_id, optIn, publicToken]
    );
    res.json({ ok: true, opt_in: optIn, public_token: publicToken });
  } catch (err) {
    console.error('[karatePublic] opt-in error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar preferência' });
  }
});

// ── POST /:slug/portal/request-otp ────────────────────────
router.post('/:slug/portal/request-otp', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const out = await portalAuth.requestOtp({ federationId: fed.id, cpf: req.body?.cpf });
    res.json(out); // resposta genérica (anti-enumeração)
  } catch (err) {
    console.error('[karatePublic] request-otp error:', err.message);
    res.status(500).json({ error: 'Erro ao solicitar código' });
  }
});

// ── POST /:slug/portal/verify-otp ───────────────────────
router.post('/:slug/portal/verify-otp', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const out = await portalAuth.verifyOtp({ federationId: fed.id, cpf: req.body?.cpf, code: req.body?.code });
    if (!out.ok) return res.status(401).json(out);
    res.json(out);
  } catch (err) {
    console.error('[karatePublic] verify-otp error:', err.message);
    res.status(500).json({ error: 'Erro ao validar código' });
  }
});

// ── GET /:slug/p/:publicToken — portal público compartilhável (reduzido) ──
router.get('/:slug/p/:publicToken', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });

    const r = await db.query(
      `SELECT pp.student_id
       FROM karate_practitioner_portal pp
       WHERE pp.public_token = $1 AND pp.public_opt_in = true AND pp.federation_id = $2
       LIMIT 1`,
      [req.params.publicToken, fed.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Perfil não disponível' });
    const studentId = r.rows[0].student_id;

    const pRes = await db.query(
      `SELECT cu.name, cu.karate_registration_number,
              COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
              cb.belt_name AS current_belt_name
       FROM customers cu
       LEFT JOIN companies dj ON dj.id = cu.dojo_id
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $2
       WHERE cu.id = $1 LIMIT 1`,
      [studentId, fed.id]
    );
    if (!pRes.rows.length) return res.status(404).json({ error: 'Perfil não disponível' });
    const p = pRes.rows[0];

    // Trajetória reduzida (só cores + ano) — sem datas exatas/observações
    const hist = await db.query(
      `SELECT belt_name, EXTRACT(YEAR FROM graduated_at)::int AS year
       FROM karate_belt_history
       WHERE student_id = $1 AND federation_id = $2
       ORDER BY graduated_at ASC`,
      [studentId, fed.id]
    );

    res.json({
      federation: { name: fed.name, logo: fed.logo },
      name: p.name,
      registration: p.karate_registration_number || null,
      dojo_name: p.dojo_name || null,
      current_belt_name: p.current_belt_name || null,
      belt_path: hist.rows,
    });
  } catch (err) {
    console.error('[karatePublic] public portal error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar perfil' });
  }
});

// ── GET /:slug/events — agenda pública (exames + cursos abertos) ──
router.get('/:slug/events', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });

    const exams = await db.query(
      `SELECT id, name, exam_type, event_date, location, fee_amount, 'exam' AS kind
       FROM karate_belt_exams
       WHERE federation_id = $1
         AND status NOT IN ('done','cancelled')
         AND (event_date IS NULL OR event_date >= CURRENT_DATE)
       ORDER BY event_date ASC NULLS LAST`,
      [fed.id]
    );
    const courses = await db.query(
      `SELECT id, name, event_type, event_date, location, fee_amount, 'course' AS kind
       FROM karate_events
       WHERE federation_id = $1
         AND status NOT IN ('done','cancelled','closed')
         AND (event_date IS NULL OR event_date >= CURRENT_DATE)
       ORDER BY event_date ASC NULLS LAST`,
      [fed.id]
    );

    res.json({
      federation: { name: fed.name, logo: fed.logo },
      events: [...exams.rows, ...courses.rows],
      _note: 'Competições (Track E) entrarão nesta agenda quando o módulo existir.',
    });
  } catch (err) {
    console.error('[karatePublic] events error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar agenda' });
  }
});

// Resolve um evento (exame ou curso) por id dentro da federação.
async function resolveEvent(fedId, eventId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(eventId)) return null;
  const ex = await db.query(
    `SELECT id, name, exam_type, event_date, location, fee_amount, status, 'exam' AS kind
     FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [eventId, fedId]
  );
  if (ex.rows.length) return ex.rows[0];
  const co = await db.query(
    `SELECT id, name, event_type, event_date, location, fee_amount, status, 'course' AS kind
     FROM karate_events WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [eventId, fedId]
  );
  if (co.rows.length) return co.rows[0];
  return null;
}

// ── GET /:slug/inscricao/:eventId — dados do evento p/ inscrição ──
router.get('/:slug/inscricao/:eventId', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const ev = await resolveEvent(fed.id, req.params.eventId);
    if (!ev) {
      return res.status(404).json({
        error: 'Evento não encontrado ou inscrição online indisponível.',
        code: 'EVENT_NOT_FOUND',
        _note: 'Inscrição em competições chega com a Track E.',
      });
    }
    if (['done', 'cancelled', 'closed'].includes(ev.status)) {
      return res.status(409).json({ error: 'Inscrições encerradas para este evento', code: 'CLOSED' });
    }
    res.json({
      federation: { name: fed.name, logo: fed.logo },
      event: {
        id: ev.id, name: ev.name, kind: ev.kind,
        type: ev.exam_type || ev.event_type || null,
        event_date: ev.event_date, location: ev.location,
        fee_amount: ev.fee_amount,
      },
      requires: ev.kind === 'exam' ? ['cpf', 'target_belt'] : ['cpf'],
    });
  } catch (err) {
    console.error('[karatePublic] inscricao GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar inscrição' });
  }
});

// ── POST /:slug/inscricao/:eventId — submeter inscrição pública ──
// Exame: insere candidato (status enrolled). Curso: enrollment.
// Competição: 501 (stub, depende da Track E). PIX via karatePaymentProvider.
router.post('/:slug/inscricao/:eventId', async (req, res) => {
  const { cpf, target_belt } = req.body || {};
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });

    const ev = await resolveEvent(fed.id, req.params.eventId);
    if (!ev) {
      return res.status(501).json({
        error: 'Inscrição online para este tipo de evento ainda não disponível (ex.: competições — Track E).',
        code: 'NOT_IMPLEMENTED',
      });
    }
    if (['done', 'cancelled', 'closed'].includes(ev.status)) {
      return res.status(409).json({ error: 'Inscrições encerradas', code: 'CLOSED' });
    }

    // Lookup do praticante por CPF (precisa estar cadastrado na federação)
    const student = await portalAuth._findPractitionerByCpf(fed.id, cpf);
    if (!student) {
      return res.status(404).json({
        error: 'Cadastro não localizado nesta federação. Procure seu dojô ou a secretaria.',
        code: 'PRACTITIONER_NOT_FOUND',
      });
    }

    let inscription;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text || '-pubinsc-' || $2::text))`,
        [ev.id, student.id]
      );

      if (ev.kind === 'exam') {
        if (!target_belt) {
          await client.query('ROLLBACK');
          return res.status(422).json({ error: 'target_belt é obrigatório para exame', code: 'VALIDATION_ERROR' });
        }
        const dup = await client.query(
          `SELECT id, status FROM karate_belt_exam_candidates WHERE exam_id = $1 AND student_id = $2 LIMIT 1`,
          [ev.id, student.id]
        );
        if (dup.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Você já está inscrito neste exame', code: 'CONFLICT', candidate_id: dup.rows[0].id });
        }
        const ins = await client.query(
          `INSERT INTO karate_belt_exam_candidates (exam_id, student_id, target_belt, status, fee_paid, created_at, updated_at)
           VALUES ($1,$2,$3,'enrolled', false, NOW(), NOW())
           RETURNING id`,
          [ev.id, student.id, target_belt]
        );
        inscription = { type: 'exam', id: ins.rows[0].id };
      } else {
        const dup = await client.query(
          `SELECT id FROM karate_event_enrollments WHERE event_id = $1 AND student_id = $2 LIMIT 1`,
          [ev.id, student.id]
        );
        if (dup.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Você já está inscrito neste curso', code: 'CONFLICT', enrollment_id: dup.rows[0].id });
        }
        const ins = await client.query(
          `INSERT INTO karate_event_enrollments (event_id, student_id, dojo_id, status, fee_paid, created_at)
           VALUES ($1,$2,$3,'enrolled', false, NOW())
           RETURNING id`,
          [ev.id, student.id, student.dojo_id || null]
        );
        inscription = { type: 'course', id: ins.rows[0].id };
      }

      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }

    // PIX da taxa (se houver e provider disponível) — best-effort
    let payment = null;
    const fee = Number(ev.fee_amount) || 0;
    if (fee > 0 && paymentProvider && paymentProvider.createPixCharge) {
      try {
        const txid = `insc-${String(inscription.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)}`;
        const charge = await paymentProvider.createPixCharge({
          federationId: fed.id, amount: fee, txid,
          description: `Inscrição ${ev.kind === 'exam' ? 'exame' : 'curso'} - ${ev.name || ''}`,
        });
        await db.query(
          `INSERT INTO karate_payment_intents
             (federation_id, provider, payment_intent_id, payload, qr_image, status, expires_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,'pending',$6, NOW(), NOW())`,
          [fed.id, charge.provider, charge.payment_intent_id, charge.payload, charge.qr_image || null, charge.expires_at]
        );
        payment = {
          payment_intent_id: charge.payment_intent_id,
          payload: charge.payload,
          qr_image: charge.qr_image || null,
          expires_at: charge.expires_at,
          provider: charge.provider,
          amount: fee,
        };
      } catch (e) {
        console.error('[karatePublic] PIX inscricao error:', e.message);
        payment = { error: 'Não foi possível gerar o PIX agora. A federação confirmará o pagamento.' };
      }
    }

    res.status(201).json({
      ok: true,
      inscription,
      practitioner: { id: student.id, name: student.name },
      fee_amount: fee,
      payment,
      _note: 'Inscrição registrada. Confirmação/aprovação é processada pela federação.',
    });
  } catch (err) {
    console.error('[karatePublic] inscricao POST error:', err.message);
    res.status(500).json({ error: 'Erro ao processar inscrição', detail: err.message });
  }
});

module.exports = router;
