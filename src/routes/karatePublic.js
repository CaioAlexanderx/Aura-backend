// ============================================================
// AURA KARATÊ — Rotas Públicas (Track D / Fase 3 + Track E / P0-0.4)
// Montado em /public/karate (SEM auth de empresa). Auth própria:
//   - verify de carteirinha: token opaco (dados mínimos / LGPD)
//   - portal do praticante: OTP → JWT type:'portal' (requirePractitionerToken)
//   - portal público compartilhável: opt-in + public_token (nunca menores)
//   - inscrição pública: lookup por CPF + PIX (exame/curso/competição —
//                        campeonatos 'open' entram na agenda e aceitam
//                        inscrição por categoria, P0-0.4).
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

// Migration 200 — registration_fields (karate_belt_exams) / registration_responses
// (karate_belt_exam_candidates / karate_event_enrollments). Cache module-level
// otimista (armadilha_schema_pre_migration do CLAUDE.md): vira false em 42703.
let HAS_REGISTRATION_FIELDS_COL = true;

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

// A4 — resolução de praticante por identificador flexível (CPF / e-mail /
// nº de registro FPKT), MESMA lógica usada por POST /:slug/lookup:
//   - contém '@'                → e-mail
//   - só dígitos e 11 dígitos   → CPF (normaliza pontuação)
//   - qualquer outro formato    → karate_registration_number (FPKT)
// Compartilhado entre /:slug/lookup (consulta) e o funil de inscrição
// (/:slug/inscricao/:eventId/lookup e POST /:slug/inscricao/:eventId), que
// hoje só aceitavam `cpf` puro. Aceita `identifier` (novo) OU `cpf` (compat).
function detectIdentifierQuery(rawIdentifier) {
  const id = String(rawIdentifier || '').trim();
  if (!id) return null;

  if (id.includes('@')) {
    return {
      queryText: `
        SELECT id, name, email, phone, dojo_id, karate_registration_number
        FROM customers
        WHERE federation_id = $1
          AND lower(email) = lower($2)
        LIMIT 1`,
      queryParam: id,
    };
  }

  const digits = id.replace(/\D/g, '');
  if (digits.length === 11 && digits === id.replace(/[.\-\s]/g, '')) {
    return {
      queryText: `
        SELECT id, name, email, phone, dojo_id, karate_registration_number
        FROM customers
        WHERE federation_id = $1
          AND regexp_replace(COALESCE(cpf_cnpj,''), '[^0-9]', '', 'g') = $2
        LIMIT 1`,
      queryParam: digits,
    };
  }

  return {
    queryText: `
      SELECT id, name, email, phone, dojo_id, karate_registration_number
      FROM customers
      WHERE federation_id = $1
        AND karate_registration_number = $2
      LIMIT 1`,
    queryParam: id,
  };
}

// Resolve o praticante aceitando tanto `{ cpf }` (compat, fluxo de inscrição
// original) quanto `{ identifier }` (novo, CPF/e-mail/FPKT). `cpf` sempre
// usa o caminho de CPF puro (portalAuth._findPractitionerByCpf); `identifier`
// detecta o tipo (ver detectIdentifierQuery). Retorna null se nada casar.
async function resolvePractitionerByIdentifier(federationId, { cpf, identifier } = {}) {
  if (identifier && String(identifier).trim()) {
    const q = detectIdentifierQuery(identifier);
    if (!q) return null;
    const r = await db.query(q.queryText, [federationId, q.queryParam]);
    return r.rows[0] || null;
  }
  if (cpf) {
    return portalAuth._findPractitionerByCpf(federationId, cpf);
  }
  return null;
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
      // `card` reaproveita karateCardService.getCurrentCard (mesma função da
      // rota admin GET /federation/:id/practitioners/:pid/card) — já inclui
      // student_name, belt, belt_name, card_number, dojo_name, birth_date,
      // cpf, photo_url, issued_at, verify_token, federation_name,
      // federation_logo, is_minor, status, revoked_at.
      // Seguro expor aqui: o praticante autenticou com o próprio CPF via OTP
      // (req.practitioner vem do JWT type:'portal', requirePractitionerToken).
      // NUNCA reaproveitar este objeto na rota pública de verify (LGPD) —
      // ver GET /verify/:token, que usa cards.verifyByToken (dados mínimos:
      // sem CPF, sem nascimento, sem foto p/ menor).
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

// ── GET /:slug/eventos — eventos ABERTOS do portal (Bloco B) ──
// karate_belt_exams com status='open' (exame/curso/graus reais da
// federação) UNION karate_competitions com status='open' (Track E/P0-0.4).
// Diferente de /:slug/events (agenda ampla, mistura karate_events legada e
// usa NOT IN done/cancelled): aqui o filtro é estritamente status='open'.
// kind: 'exam' | 'competition' — o card do hub e a tela de inscrição usam
// esse campo para decidir o fluxo (registration_fields vs. categorias).
router.get('/:slug/eventos', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });

    const exams = await db.query(
      `SELECT id, name, exam_type, event_date, location, fee_amount, 'exam' AS kind
       FROM karate_belt_exams
       WHERE federation_id = $1
         AND status = 'open'
       ORDER BY event_date ASC NULLS LAST`,
      [fed.id]
    );

    let competitions = { rows: [] };
    try {
      competitions = await db.query(
        `SELECT id, name, NULL AS exam_type, event_date, location, fee_amount, 'competition' AS kind
         FROM karate_competitions
         WHERE federation_id = $1
           AND status = 'open'
         ORDER BY event_date ASC NULLS LAST`,
        [fed.id]
      );
    } catch (e) {
      if (e.code === '42P01') {
        console.warn('[karatePublic] karate_competitions ausente em /eventos (deployment parcial)');
      } else throw e;
    }

    const merged = [...exams.rows, ...competitions.rows].sort((a, b) => {
      if (!a.event_date) return 1;
      if (!b.event_date) return -1;
      return new Date(a.event_date) - new Date(b.event_date);
    });

    // A3 — from_price: menor preço positivo entre fee_amount do evento e (p/
    // competição) fee_amount das categorias. null = realmente gratuito.
    const events = await Promise.all(merged.map(async (ev) => ({
      ...ev,
      from_price: await computeFromPrice(ev),
    })));

    res.json({
      federation: { name: fed.name, logo: fed.logo },
      events,
    });
  } catch (err) {
    console.error('[karatePublic] eventos error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar eventos abertos' });
  }
});

// Resolve um evento (exame ou curso) por id dentro da federação.
// registration_fields (migration 200) só existe em karate_belt_exams — eventos
// 'course' (karate_events) sempre voltam registration_fields: [] (sem coluna).
async function resolveEvent(fedId, eventId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(eventId)) return null;

  if (HAS_REGISTRATION_FIELDS_COL) {
    try {
      const ex = await db.query(
        `SELECT id, name, exam_type, event_date, location, fee_amount, max_candidates, status,
                registration_fields, description, 'exam' AS kind
         FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
        [eventId, fedId]
      );
      if (ex.rows.length) return ex.rows[0];
    } catch (e) {
      if (e.code === '42703') {
        HAS_REGISTRATION_FIELDS_COL = false;
        console.warn('[karatePublic] registration_fields ausente em resolveEvent (migration 200 pendente)');
      } else throw e;
    }
  }
  if (!HAS_REGISTRATION_FIELDS_COL) {
    const ex = await db.query(
      `SELECT id, name, exam_type, event_date, location, fee_amount, max_candidates, status, description, 'exam' AS kind
       FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [eventId, fedId]
    );
    if (ex.rows.length) return ex.rows[0];
  }

  const co = await db.query(
    `SELECT id, name, event_type, event_date, location, fee_amount, status, 'course' AS kind
     FROM karate_events WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [eventId, fedId]
  );
  if (co.rows.length) return co.rows[0];

  // Campeonato (karate_competitions / Track E / P0-0.4). Sem registration_fields
  // (formulário livre não existe pra competição — a "resposta" é a categoria
  // escolhida). Código defensivo 42P01: deployment parcial da migration 168/169.
  try {
    // karate_competitions NÃO tem coluna description (migration 168) — ao
    // contrário de karate_belt_exams/karate_events. Não selecionar; a
    // resposta ao cliente sempre traz description: null pra competição.
    const comp = await db.query(
      `SELECT id, name, event_date, location, fee_amount, status, 'competition' AS kind
       FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [eventId, fedId]
    );
    if (comp.rows.length) return comp.rows[0];
  } catch (e) {
    if (e.code !== '42P01') throw e;
    console.warn('[karatePublic] karate_competitions ausente em resolveEvent (deployment parcial)');
  }

  return null;
}

// Menor preço positivo entre uma lista de valores (fee_amount de evento +
// categorias, quando aplicável). Usado para exibir "a partir de R$ X" nos
// cards de evento/competição em vez de "Gratuito" quando só a categoria tem
// preço (A3). Retorna null se nenhum valor for > 0 (realmente gratuito).
function lowestPositivePrice(values) {
  let min = null;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      if (min === null || n < min) min = n;
    }
  }
  return min;
}

// Calcula from_price (A3) de um evento resolvido (kind exam|course|competition).
// Competição: considera fee_amount do evento + fee_amount de cada categoria
// (resolveCompetitionCategories já é defensivo p/ 42P01 -> []). Exam/course:
// só o fee_amount do próprio evento.
async function computeFromPrice(ev) {
  try {
    if (ev.kind === 'competition') {
      const categories = await resolveCompetitionCategories(ev.id);
      const values = [ev.fee_amount, ...categories.map(c => c.fee_amount)];
      return lowestPositivePrice(values);
    }
    return lowestPositivePrice([ev.fee_amount]);
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') {
      console.warn('[karatePublic] computeFromPrice fallback (tabela/coluna ausente):', e.code);
      return lowestPositivePrice([ev.fee_amount]);
    }
    throw e;
  }
}

// Busca as categorias de uma competição (id, nome, modalidade, faixa etária,
// faixa de graduação, sexo, peso) — usadas pelo GET de inscrição e pela
// tela pública para o praticante escolher em qual categoria se inscrever.
// Banner do evento (karate_promo_banners escopado por event_id, ativo e dentro
// da janela). Retorna a URL da imagem ou null. Defensivo p/ tabela/coluna
// ausente (42P01/42703 — deployment parcial).
async function resolveEventBannerUrl(eventId) {
  try {
    const r = await db.query(
      `SELECT image_url FROM karate_promo_banners
        WHERE event_id = $1 AND active = true
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at   IS NULL OR ends_at   >= NOW())
        ORDER BY sort_order ASC, created_at DESC
        LIMIT 1`,
      [eventId]
    );
    return r.rows[0]?.image_url || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

async function resolveCompetitionCategories(competitionId) {
  try {
    const { rows } = await db.query(
      `SELECT cat.id, cat.name, cat.modality, cat.min_age, cat.max_age,
              cat.belt_min, cat.belt_max, cat.sex, cat.weight_class,
              cat.max_entries, cat.fee_amount,
              COUNT(e.id)::int AS entry_count
       FROM karate_competition_categories cat
       LEFT JOIN karate_competition_entries e ON e.category_id = cat.id
       WHERE cat.competition_id = $1
       GROUP BY cat.id
       ORDER BY cat.created_at ASC`,
      [competitionId]
    );
    return rows.map(c => ({
      id: c.id, name: c.name, modality: c.modality,
      min_age: c.min_age != null ? c.min_age : null,
      max_age: c.max_age != null ? c.max_age : null,
      belt_min: c.belt_min || null, belt_max: c.belt_max || null,
      sex: c.sex, weight_class: c.weight_class || null,
      max_entries: c.max_entries != null ? c.max_entries : null,
      fee_amount: c.fee_amount != null ? c.fee_amount : null,
      entry_count: c.entry_count,
    }));
  } catch (e) {
    if (e.code === '42P01') {
      console.warn('[karatePublic] karate_competition_categories ausente (deployment parcial)');
      return [];
    }
    throw e;
  }
}

// ── GET /:slug/inscricao/:eventId — dados do evento p/ inscrição ──
// kind === 'competition': em vez de registration_fields, retorna `categories`
// (o praticante escolhe uma categoria em vez de preencher formulário livre).
router.get('/:slug/inscricao/:eventId', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const ev = await resolveEvent(fed.id, req.params.eventId);
    if (!ev) {
      return res.status(404).json({
        error: 'Evento não encontrado ou inscrição online indisponível.',
        code: 'EVENT_NOT_FOUND',
      });
    }
    if (['done', 'cancelled', 'closed'].includes(ev.status)) {
      return res.status(409).json({ error: 'Inscrições encerradas para este evento', code: 'CLOSED' });
    }
    if (ev.kind === 'competition' && ev.status !== 'open') {
      return res.status(409).json({ error: 'Inscrições encerradas para esta competição', code: 'CLOSED' });
    }

    const banner_url = await resolveEventBannerUrl(ev.id);
    if (ev.kind === 'competition') {
      const categories = await resolveCompetitionCategories(ev.id);
      // A3 — reaproveita as categorias já buscadas (evita 2ª query).
      const from_price = lowestPositivePrice([ev.fee_amount, ...categories.map(c => c.fee_amount)]);
      return res.json({
        federation: { name: fed.name, logo: fed.logo },
        event: {
          id: ev.id, name: ev.name, kind: 'competition',
          type: null,
          description: ev.description || null,
          banner_url,
          event_date: ev.event_date, location: ev.location,
          fee_amount: ev.fee_amount,
          from_price,
          capacity: null,
          registration_fields: [],
          categories,
        },
        requires: ['cpf', 'category_id'],
      });
    }

    // Vagas (apenas exames têm max_candidates; cursos não têm capacidade modelada)
    let capacity = null;
    if (ev.kind === 'exam') {
      const cap = await db.query(
        `SELECT COUNT(*)::int AS filled FROM karate_belt_exam_candidates WHERE exam_id = $1`,
        [ev.id]
      );
      capacity = { max: ev.max_candidates || null, filled: cap.rows[0].filled };
    }

    res.json({
      federation: { name: fed.name, logo: fed.logo },
      event: {
        id: ev.id, name: ev.name, kind: ev.kind,
        type: ev.exam_type || ev.event_type || null,
        description: ev.description || null,
        banner_url,
        event_date: ev.event_date, location: ev.location,
        fee_amount: ev.fee_amount,
        from_price: lowestPositivePrice([ev.fee_amount]),
        capacity,
        registration_fields: ev.registration_fields || [],
      },
      requires: ['cpf'],
    });
  } catch (err) {
    console.error('[karatePublic] inscricao GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar inscrição' });
  }
});

// ── POST /:slug/inscricao/:eventId/lookup — localizar praticante por CPF ──
// Passo intermediário do wizard (cpf → confirma): retorna a faixa atual + se já
// está inscrito, SEM efetivar a inscrição. Erros: 404 (não localizado),
// 409 (encerrado/já inscrito).
// Competição (kind==='competition'): body precisa de `category_id` (a
// categoria escolhida pelo praticante) — already_enrolled é avaliado POR
// CATEGORIA (UNIQUE(category_id, student_id) em karate_competition_entries).
router.post('/:slug/inscricao/:eventId/lookup', async (req, res) => {
  const { cpf, identifier, category_id } = req.body || {};
  if (!cpf && (!identifier || !String(identifier).trim())) {
    return res.status(422).json({ error: 'Informe cpf ou identifier', code: 'VALIDATION_ERROR' });
  }
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });
    const ev = await resolveEvent(fed.id, req.params.eventId);
    if (!ev) {
      return res.status(404).json({ error: 'Evento não encontrado', code: 'EVENT_NOT_FOUND' });
    }
    if (['done', 'cancelled', 'closed'].includes(ev.status)) {
      return res.status(409).json({ error: 'Inscrições encerradas', code: 'CLOSED' });
    }
    if (ev.kind === 'competition') {
      if (ev.status !== 'open') {
        return res.status(409).json({ error: 'Inscrições encerradas', code: 'CLOSED' });
      }
      if (!category_id) {
        return res.status(422).json({ error: 'category_id é obrigatório', code: 'VALIDATION_ERROR' });
      }
      const catCheck = await db.query(
        `SELECT id FROM karate_competition_categories WHERE id = $1 AND competition_id = $2 LIMIT 1`,
        [category_id, ev.id]
      );
      if (!catCheck.rows.length) {
        return res.status(404).json({ error: 'Categoria não encontrada nesta competição', code: 'CATEGORY_NOT_FOUND' });
      }
    }

    const student = await resolvePractitionerByIdentifier(fed.id, { cpf, identifier });
    if (!student) {
      return res.status(404).json({
        error: 'Cadastro não localizado nesta federação. Procure seu dojô ou a secretaria.',
        code: 'PRACTITIONER_NOT_FOUND',
      });
    }

    const cb = await db.query(
      `SELECT belt_level, belt_name FROM karate_current_belt
       WHERE student_id = $1 AND federation_id = $2 LIMIT 1`,
      [student.id, fed.id]
    );

    let already = false;
    if (ev.kind === 'exam') {
      const d = await db.query(
        `SELECT id FROM karate_belt_exam_candidates WHERE exam_id = $1 AND student_id = $2 LIMIT 1`,
        [ev.id, student.id]
      );
      already = d.rows.length > 0;
    } else if (ev.kind === 'competition') {
      const d = await db.query(
        `SELECT id FROM karate_competition_entries WHERE category_id = $1 AND student_id = $2 LIMIT 1`,
        [category_id, student.id]
      );
      already = d.rows.length > 0;
    } else {
      const d = await db.query(
        `SELECT id FROM karate_event_enrollments WHERE event_id = $1 AND student_id = $2 LIMIT 1`,
        [ev.id, student.id]
      );
      already = d.rows.length > 0;
    }

    res.json({
      found: true,
      already_enrolled: already,
      practitioner: {
        id: student.id,
        name: student.name,
        current_belt: cb.rows[0]?.belt_level || null,
        current_belt_name: cb.rows[0]?.belt_name || null,
      },
      event: {
        id: ev.id, name: ev.name, kind: ev.kind, fee_amount: ev.fee_amount,
        requires: [],
      },
    });
  } catch (err) {
    console.error('[karatePublic] lookup error:', err.message);
    res.status(500).json({ error: 'Erro na consulta' });
  }
});

// Verifica se todo campo obrigatório de registration_fields foi preenchido em
// `responses` (não vazio/undefined/null). Retorna array de labels faltantes
// (vazio = tudo ok). `fields` pode ser undefined/[] quando o evento não tem
// formulário configurável (curso, ou migration 200 ainda não aplicada).
function missingRequiredFields(fields, responses) {
  if (!Array.isArray(fields) || fields.length === 0) return [];
  const r = responses && typeof responses === 'object' ? responses : {};
  const missing = [];
  for (const f of fields) {
    if (!f || !f.required) continue;
    const v = r[f.key];
    const isEmpty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (isEmpty) missing.push(f.label || f.key);
  }
  return missing;
}

// ── POST /:slug/inscricao/:eventId — submeter inscrição pública ──
// Exame E curso (ambos em karate_belt_exams): insere candidato em
// karate_belt_exam_candidates com status 'registered' (CHECK: registered|...).
// karate_events (tabela legada) usa o outro branch com status 'enrolled'.
// Competição (Track E / P0-0.4): body precisa de `category_id`; insere em
// karate_competition_entries com status 'registered'. Anti-dupla-inscrição
// por categoria: advisory lock (mesmo padrão do exame) + UNIQUE(category_id,
// student_id) como rede de segurança (23505 -> 409). PIX via karatePaymentProvider.
router.post('/:slug/inscricao/:eventId', async (req, res) => {
  const { cpf, identifier, responses, category_id } = req.body || {};
  if (!cpf && (!identifier || !String(identifier).trim())) {
    return res.status(422).json({ error: 'Informe cpf ou identifier', code: 'VALIDATION_ERROR' });
  }
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });

    const ev = await resolveEvent(fed.id, req.params.eventId);
    if (!ev) {
      return res.status(404).json({ error: 'Evento não encontrado', code: 'EVENT_NOT_FOUND' });
    }
    if (['done', 'cancelled', 'closed'].includes(ev.status)) {
      return res.status(409).json({ error: 'Inscrições encerradas', code: 'CLOSED' });
    }
    if (ev.kind === 'competition' && ev.status !== 'open') {
      return res.status(409).json({ error: 'Inscrições encerradas', code: 'CLOSED' });
    }

    let category = null;
    if (ev.kind === 'competition') {
      if (!category_id) {
        return res.status(422).json({ error: 'category_id é obrigatório', code: 'VALIDATION_ERROR' });
      }
      const catRes = await db.query(
        `SELECT id, name, max_entries, fee_amount FROM karate_competition_categories
         WHERE id = $1 AND competition_id = $2 LIMIT 1`,
        [category_id, ev.id]
      );
      if (!catRes.rows.length) {
        return res.status(404).json({ error: 'Categoria não encontrada nesta competição', code: 'CATEGORY_NOT_FOUND' });
      }
      category = catRes.rows[0];
    }

    // Campos obrigatórios do formulário configurável (migration 200) — só
    // existe em eventos 'exam'. Curso/competição => registration_fields: [].
    const missingFields = missingRequiredFields(ev.registration_fields, responses);
    if (missingFields.length > 0) {
      return res.status(422).json({
        error: 'Preencha os campos obrigatórios do formulário de inscrição.',
        code: 'VALIDATION_ERROR',
        missingFields,
      });
    }

    // Lookup do praticante por CPF/e-mail/FPKT (precisa estar cadastrado na federação)
    const student = await resolvePractitionerByIdentifier(fed.id, { cpf, identifier });
    if (!student) {
      return res.status(404).json({
        error: 'Cadastro não localizado nesta federação. Procure seu dojô ou a secretaria.',
        code: 'PRACTITIONER_NOT_FOUND',
      });
    }

    const responsesJson = JSON.stringify(responses && typeof responses === 'object' ? responses : {});

    let inscription;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (ev.kind === 'competition') {
        // Mesmo padrão de advisory lock do admin (POST /competitions/:cid/entries),
        // trocando o namespace pra não colidir com o lock do fluxo admin.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1::text || '-pubcomp-' || $2::text))`,
          [category_id, student.id]
        );

        const dup = await client.query(
          `SELECT id FROM karate_competition_entries WHERE category_id = $1 AND student_id = $2 LIMIT 1`,
          [category_id, student.id]
        );
        if (dup.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Você já está inscrito nesta categoria', code: 'CONFLICT', entry_id: dup.rows[0].id });
        }

        let ins;
        try {
          ins = await client.query(
            `INSERT INTO karate_competition_entries
               (competition_id, category_id, student_id, dojo_id, status, fee_paid, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'registered', false, NOW(), NOW())
             RETURNING id`,
            [ev.id, category_id, student.id, student.dojo_id || null]
          );
        } catch (e) {
          if (e.code === '23505') {
            // Rede de segurança do UNIQUE(category_id, student_id) — corrida
            // entre o SELECT de dup acima e o INSERT (não deveria acontecer
            // com o advisory lock, mas cobre qualquer brecha).
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Você já está inscrito nesta categoria', code: 'CONFLICT' });
          }
          throw e;
        }
        inscription = { type: 'competition', id: ins.rows[0].id, category_id, category_name: category.name };

        await client.query('COMMIT');
      } else {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text || '-pubinsc-' || $2::text))`,
        [ev.id, student.id]
      );

      if (ev.kind === 'exam') {
        // Faixa pretendida removida (decisao Caio 08/06): a federacao/banca define depois.
        const dup = await client.query(
          `SELECT id, status FROM karate_belt_exam_candidates WHERE exam_id = $1 AND student_id = $2 LIMIT 1`,
          [ev.id, student.id]
        );
        if (dup.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Você já está inscrito neste exame', code: 'CONFLICT', candidate_id: dup.rows[0].id });
        }
        let ins;
        if (HAS_REGISTRATION_FIELDS_COL) {
          try {
            ins = await client.query(
              `INSERT INTO karate_belt_exam_candidates
                 (exam_id, student_id, status, fee_paid, registration_responses, created_at, updated_at)
               VALUES ($1,$2,'registered', false, $3::jsonb, NOW(), NOW())
               RETURNING id`,
              [ev.id, student.id, responsesJson]
            );
          } catch (e) {
            if (e.code === '42703') {
              HAS_REGISTRATION_FIELDS_COL = false;
              console.warn('[karatePublic] registration_responses ausente no INSERT candidate (migration 200 pendente)');
            } else throw e;
          }
        }
        if (!ins) {
          ins = await client.query(
            `INSERT INTO karate_belt_exam_candidates (exam_id, student_id, status, fee_paid, created_at, updated_at)
             VALUES ($1,$2,'registered', false, NOW(), NOW())
             RETURNING id`,
            [ev.id, student.id]
          );
        }
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
        let ins;
        if (HAS_REGISTRATION_FIELDS_COL) {
          try {
            ins = await client.query(
              `INSERT INTO karate_event_enrollments
                 (event_id, student_id, dojo_id, status, fee_paid, registration_responses, created_at)
               VALUES ($1,$2,$3,'enrolled', false, $4::jsonb, NOW())
               RETURNING id`,
              [ev.id, student.id, student.dojo_id || null, responsesJson]
            );
          } catch (e) {
            if (e.code === '42703') {
              HAS_REGISTRATION_FIELDS_COL = false;
              console.warn('[karatePublic] registration_responses ausente no INSERT enrollment (migration 200 pendente)');
            } else throw e;
          }
        }
        if (!ins) {
          ins = await client.query(
            `INSERT INTO karate_event_enrollments (event_id, student_id, dojo_id, status, fee_paid, created_at)
             VALUES ($1,$2,$3,'enrolled', false, NOW())
             RETURNING id`,
            [ev.id, student.id, student.dojo_id || null]
          );
        }
        inscription = { type: 'course', id: ins.rows[0].id };
      }

      await client.query('COMMIT');
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }

    // PIX da taxa (se houver e provider disponível) — best-effort.
    // Competição: categoria pode sobrescrever a taxa da competição
    // (fee_amount em karate_competition_categories, quando != null).
    let payment = null;
    const fee = ev.kind === 'competition' && category && category.fee_amount != null
      ? Number(category.fee_amount) || 0
      : Number(ev.fee_amount) || 0;
    const kindLabel = ev.kind === 'exam' ? 'exame' : ev.kind === 'competition' ? 'campeonato' : 'curso';
    if (fee > 0 && paymentProvider && paymentProvider.createPixCharge) {
      try {
        const txid = `insc-${String(inscription.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)}`;
        const charge = await paymentProvider.createPixCharge({
          federationId: fed.id, amount: fee, txid,
          description: `Inscrição ${kindLabel} - ${ev.name || ''}`,
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

// BUG A2 (corrigido): `module.exports = router;` estava ANTES das rotas
// abaixo (POST /:slug/lookup e GET /:slug/banners), tornando-as código morto
// — nunca registradas no router. Export movido para o fim real do arquivo.

// Busca payment_status (karate_payment_intents) para as inscrições ativas
// retornadas por /:slug/lookup. karate_payment_intents não tem FK direta pra
// inscrição (é vinculada por federation_id + criada no momento do PIX) —
// então casamos pelo txid, que o fluxo de inscrição gera como
// `insc-<inscriptionId>` (ver POST /:slug/inscricao/:eventId). Código
// defensivo: 42P01/42703 (tabela/coluna ausente) -> payment_status null p/
// todos os itens, sem quebrar o lookup.
async function resolvePaymentStatuses(federationId, inscriptionIds) {
  const statuses = {};
  if (!inscriptionIds.length) return statuses;
  try {
    const txids = inscriptionIds.map((id) => `insc-${String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18)}`);
    const { rows } = await db.query(
      `SELECT payment_intent_id, status
       FROM karate_payment_intents
       WHERE federation_id = $1 AND payment_intent_id = ANY($2::text[])`,
      [federationId, txids]
    );
    const byTxid = {};
    for (const r of rows) byTxid[r.payment_intent_id] = r.status;
    inscriptionIds.forEach((id, i) => {
      statuses[id] = byTxid[txids[i]] || null;
    });
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') {
      console.warn('[karatePublic] karate_payment_intents ausente/coluna faltando em resolvePaymentStatuses:', e.code);
      inscriptionIds.forEach((id) => { statuses[id] = null; });
    } else throw e;
  }
  return statuses;
}

// A2 — inscrições ativas do praticante nesta federação (exame + competição +
// curso), usadas por POST /:slug/lookup para o praticante ver o que já se
// inscreveu (fluxo pós-compra/consulta). Cada tabela é buscada com try/catch
// independente (42P01/42703 -> array vazio) pra não derrubar o lookup inteiro
// se uma delas ainda não tiver sido migrada (deployment parcial).
async function resolveActiveRegistrations(fed, studentId) {
  const items = [];

  try {
    const { rows } = await db.query(
      `SELECT ec.id, ec.status, ec.created_at, be.id AS event_id, be.name AS event_name
       FROM karate_belt_exam_candidates ec
       JOIN karate_belt_exams be ON be.id = ec.exam_id
       WHERE ec.student_id = $1 AND be.federation_id = $2
         AND ec.status NOT IN ('cancelled','rejected')
       ORDER BY ec.created_at DESC`,
      [studentId, fed.id]
    );
    for (const r of rows) {
      items.push({
        kind: 'exam', event_id: r.event_id, event_name: r.event_name,
        category_name: null, status: r.status,
        payment_status: null, created_at: r.created_at,
        _inscriptionId: r.id,
      });
    }
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    console.warn('[karatePublic] karate_belt_exam_candidates ausente em resolveActiveRegistrations:', e.code);
  }

  try {
    const { rows } = await db.query(
      `SELECT en.id, en.status, en.created_at, co.id AS event_id, co.name AS event_name,
              cat.name AS category_name
       FROM karate_competition_entries en
       JOIN karate_competitions co ON co.id = en.competition_id
       JOIN karate_competition_categories cat ON cat.id = en.category_id
       WHERE en.student_id = $1 AND co.federation_id = $2
         AND en.status NOT IN ('cancelled','rejected','withdrawn')
       ORDER BY en.created_at DESC`,
      [studentId, fed.id]
    );
    for (const r of rows) {
      items.push({
        kind: 'competition', event_id: r.event_id, event_name: r.event_name,
        category_name: r.category_name || null, status: r.status,
        payment_status: null, created_at: r.created_at,
        _inscriptionId: r.id,
      });
    }
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    console.warn('[karatePublic] karate_competition_entries ausente em resolveActiveRegistrations:', e.code);
  }

  try {
    const { rows } = await db.query(
      `SELECT ee.id, ee.status, ee.created_at, ke.id AS event_id, ke.name AS event_name
       FROM karate_event_enrollments ee
       JOIN karate_events ke ON ke.id = ee.event_id
       WHERE ee.student_id = $1 AND ke.federation_id = $2
         AND ee.status NOT IN ('absent','cancelled')
       ORDER BY ee.created_at DESC`,
      [studentId, fed.id]
    );
    for (const r of rows) {
      items.push({
        kind: 'course', event_id: r.event_id, event_name: r.event_name,
        category_name: null, status: r.status,
        payment_status: null, created_at: r.created_at,
        _inscriptionId: r.id,
      });
    }
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    console.warn('[karatePublic] karate_event_enrollments ausente em resolveActiveRegistrations:', e.code);
  }

  // payment_status best-effort (nunca derruba o lookup)
  try {
    const statuses = await resolvePaymentStatuses(fed.id, items.map((i) => i._inscriptionId));
    for (const item of items) item.payment_status = statuses[item._inscriptionId] || null;
  } catch (e) {
    console.warn('[karatePublic] resolvePaymentStatuses falhou em resolveActiveRegistrations:', e.message);
  }

  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return items.map(({ _inscriptionId, ...rest }) => rest);
}

// ── POST /:slug/lookup — localizar praticante por CPF, e-mail ou FPKT ──
// Identificador flexível (ver detectIdentifierQuery, compartilhado com o
// funil de inscrição — A4):
//   - Só dígitos + comprimento 11 → CPF (regexp_replace para normalizar)
//   - Contém '@' → e-mail
//   - Qualquer outro → karate_registration_number (FPKT)
// Retorna perfil público + faixa atual + inscrições ativas (`registrations`,
// A2) + `active_enrollments` (legado, mantido p/ compat). Read-only.
router.post('/:slug/lookup', async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
    return res.status(422).json({ error: 'Parâmetro `identifier` obrigatório', code: 'VALIDATION_ERROR' });
  }
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });

    const q = detectIdentifierQuery(identifier);
    const studentRes = await db.query(q.queryText, [fed.id, q.queryParam]);
    if (!studentRes.rows.length) {
      return res.status(404).json({
        error: 'Cadastro não localizado nesta federação.',
        code: 'PRACTITIONER_NOT_FOUND',
      });
    }

    const s = studentRes.rows[0];

    // Faixa atual
    const beltRes = await db.query(
      `SELECT belt_level, belt_name
       FROM karate_current_belt
       WHERE student_id = $1 AND federation_id = $2 LIMIT 1`,
      [s.id, fed.id]
    );

    // Inscrições ativas (exames + cursos não finalizados) — legado, mantido
    // pra não quebrar consumidores atuais de active_enrollments.
    const examsRes = await db.query(
      `SELECT ec.id, ec.status, be.id AS event_id, be.name AS event_name,
              be.event_date, 'exam' AS kind
       FROM karate_belt_exam_candidates ec
       JOIN karate_belt_exams be ON be.id = ec.exam_id
       WHERE ec.student_id = $1 AND be.federation_id = $2
         AND ec.status NOT IN ('cancelled','rejected')
         AND be.status NOT IN ('done','cancelled')
       ORDER BY be.event_date DESC NULLS LAST`,
      [s.id, fed.id]
    );

    const coursesRes = await db.query(
      `SELECT ee.id, ee.status, ke.id AS event_id, ke.name AS event_name,
              ke.event_date, 'course' AS kind
       FROM karate_event_enrollments ee
       JOIN karate_events ke ON ke.id = ee.event_id
       WHERE ee.student_id = $1 AND ke.federation_id = $2
         AND ee.status NOT IN ('absent')
         AND ke.status NOT IN ('done','cancelled','closed')
       ORDER BY ke.event_date DESC NULLS LAST`,
      [s.id, fed.id]
    );

    // A2 — inscrições ativas (exame + competição + curso) com payment_status.
    const registrations = await resolveActiveRegistrations(fed, s.id);

    return res.json({
      federation: { name: fed.name, logo: fed.logo },
      practitioner: {
        id: s.id,
        name: s.name,
        karate_registration_number: s.karate_registration_number || null,
        dojo_id: s.dojo_id || null,
        current_belt: beltRes.rows[0]?.belt_level || null,
        current_belt_name: beltRes.rows[0]?.belt_name || null,
      },
      active_enrollments: [...examsRes.rows, ...coursesRes.rows],
      registrations,
    });
  } catch (err) {
    console.error('[karatePublic] lookup error:', err.message);
    return res.status(500).json({ error: 'Erro ao localizar praticante' });
  }
});

// ── GET /:slug/banners?placement=hub — banners públicos ativos ──
// Filtra por federação (via slug), active=true, janela starts_at/ends_at,
// placement (hub|inscricao|ambos). Sem auth. Ordenados por sort_order ASC.
router.get('/:slug/banners', async (req, res) => {
  try {
    const fed = await resolveFederation(req.params.slug);
    if (!fed) return res.status(404).json({ error: 'Federação não encontrada' });

    const placement = req.query.placement || 'hub';
    const allowed = ['hub', 'inscricao', 'ambos'];
    const placementFilter = allowed.includes(placement) ? placement : 'hub';

    // Banners onde placement = filtro solicitado OU = 'ambos'
    const rows = await db.query(
      `SELECT id, title, image_url, format, event_id, placement, sort_order
       FROM karate_promo_banners
       WHERE federation_id = $1
         AND active = true
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at   IS NULL OR ends_at   >= NOW())
         AND (placement = $2 OR placement = 'ambos')
       ORDER BY sort_order ASC, created_at DESC`,
      [fed.id, placementFilter]
    );

    return res.json({
      federation: { name: fed.name, logo: fed.logo },
      banners: rows.rows,
    });
  } catch (err) {
    console.error('[karatePublic] banners GET error:', err.message);
    return res.status(500).json({ error: 'Erro ao carregar banners' });
  }
});

module.exports = router;
