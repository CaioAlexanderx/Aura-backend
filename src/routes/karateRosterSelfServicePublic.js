// ============================================================
// AURA KARATÊ — Portal de auto-atendimento do PRÓPRIO praticante (G1, item 6)
// Montado em /public/roster-self/:token — SEM auth (mesmo padrão de
// karateRosterPortalPublic.js): o token É a autenticação.
//
// DECISÃO DE SEGURANÇA (explicada também no corpo do PR): este token é
// self_service_token, um segredo SEPARADO do token do sensei
// (karate_dojo_roster_validation.token). Os dois são gerados juntos em
// POST /federation/:id/dojos/:dojoId/request-roster-update, escopados ao
// MESMO dojô, mas com propósitos diferentes:
//   - token do sensei  → poder pleno no portal (inativar, editar qualquer
//     campo, adicionar praticante, confirmar o quadro).
//   - self_service_token → só as duas rotas deste arquivo, que NUNCA tocam
//     is_active/faixa/status, e cujo body é whitelist estrita de campos de
//     contato.
// Se o sensei cola o link errado no grupo do dojô (compartilha o de
// auto-atendimento, que é o previsto), o pior caso é um estranho tentando
// mexer no telefone/e-mail de um colega — mitigado pelo 2º fator
// (nascimento OU matrícula) + rate limit. Nunca dá acesso a inativar
// ninguém nem a ver dado de terceiros além do nome (para o aluno se
// reconhecer na busca).
//
//   GET  /public/roster-self/:token/search?q=nome  — busca só por nome,
//        devolve só { id, name }, no máximo 8 resultados, nunca a lista
//        inteira do dojô (evita virar diretório vazado).
//   POST /public/roster-self/:token/update          — grava telefone e/ou
//        e-mail do PRÓPRIO praticante, após confirmar identidade com
//        data de nascimento OU nº de matrícula FPKT. Qualquer campo fora
//        de {student_id, birth_date, karate_registration_number, phone,
//        email} é 422 (whitelist estrita — testado em
//        __tests__/karate.rosterPortalScale.test.js).
// ============================================================
'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');

const isTestEnv = () => process.env.NODE_ENV === 'test';

// Chave de rate limit = token + IP: throttle por dojô E por origem, sem
// um IP compartilhado (rede da escola/ginásio) travar todo mundo por causa
// de um dojô barulhento em outro token.
function keyByTokenAndIp(req) {
  return `${req.params.token || 'no-token'}:${req.ip || 'no-ip'}`;
}

const searchLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
});

const updateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
});

// Resolve self_service_token → { dojo_id, federation_id, expired }.
async function resolveSelfServiceToken(token) {
  if (!token || typeof token !== 'string') return null;
  const { rows } = await db.query(
    `SELECT dojo_id, federation_id, self_service_token_expires_at
     FROM karate_dojo_roster_validation
     WHERE self_service_token = $1
     LIMIT 1`,
    [token]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const expired = !row.self_service_token_expires_at || new Date(row.self_service_token_expires_at) <= new Date();
  return { ...row, expired };
}

// ── GET /public/roster-self/:token/search?q=nome ────────────
router.get('/:token/search', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(422).json({ error: 'Digite ao menos 2 letras do nome', code: 'VALIDATION_ERROR' });
  }

  try {
    const resolved = await resolveSelfServiceToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Peça um novo link ao seu sensei.' });

    const { rows } = await db.query(
      `SELECT id, name FROM customers
       WHERE dojo_id = $1 AND is_guest = false AND name ILIKE $2
       ORDER BY name ASC
       LIMIT 8`,
      [resolved.dojo_id, `%${q}%`]
    );
    res.json({ data: rows });
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterSelfServicePublic] schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterSelfServicePublic] search error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar' });
  }
});

// ── POST /public/roster-self/:token/update ───────────────────
const ALLOWED_KEYS = new Set(['student_id', 'birth_date', 'karate_registration_number', 'phone', 'email']);

router.post('/:token/update', updateLimiter, async (req, res) => {
  const token = req.params.token;
  const body = req.body || {};

  const invalidKeys = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k));
  if (invalidKeys.length) {
    return res.status(422).json({
      error: `Campo(s) não permitido(s) neste link: ${invalidKeys.join(', ')}`,
      code: 'FIELD_NOT_ALLOWED',
    });
  }

  const studentId = body.student_id;
  const birthDate = body.birth_date ? String(body.birth_date).trim() : null;
  const regNumber = body.karate_registration_number ? String(body.karate_registration_number).trim() : null;
  const phone = body.phone !== undefined && body.phone !== null ? String(body.phone).trim() : undefined;
  const email = body.email !== undefined && body.email !== null ? String(body.email).trim() : undefined;

  if (!studentId) {
    return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!birthDate && !regNumber) {
    return res.status(422).json({ error: 'Informe data de nascimento ou nº de matrícula para confirmar sua identidade', code: 'VALIDATION_ERROR' });
  }
  if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    return res.status(422).json({ error: 'birth_date deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
  }
  if (phone === undefined && email === undefined) {
    return res.status(422).json({ error: 'Informe telefone e/ou e-mail para atualizar', code: 'VALIDATION_ERROR' });
  }

  try {
    const resolved = await resolveSelfServiceToken(token);
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Peça um novo link ao seu sensei.' });

    const setParts = [];
    const params = [studentId, resolved.dojo_id];
    let n = 3;
    if (phone !== undefined) { setParts.push(`phone = $${n}`); params.push(phone || null); n++; }
    if (email !== undefined) { setParts.push(`email = $${n}`); params.push(email || null); n++; }

    const identityParts = [];
    if (birthDate) { identityParts.push(`birth_date = $${n}::date`); params.push(birthDate); n++; }
    if (regNumber) { identityParts.push(`karate_registration_number = $${n}`); params.push(regNumber); n++; }

    // ESCOPO + IDENTIDADE na MESMA query: só atualiza se (a) o praticante é
    // deste dojô (do self_service_token) E (b) o 2º fator bate. Nunca toca
    // is_active/faixa/status — essas colunas não entram no SET.
    const { rows } = await db.query(
      `UPDATE customers SET ${setParts.join(', ')}, updated_at = NOW()
       WHERE id = $1 AND dojo_id = $2 AND (${identityParts.join(' OR ')})
       RETURNING id, name, phone, email`,
      params
    );

    if (!rows.length) {
      return res.status(403).json({ error: 'Não foi possível confirmar sua identidade', code: 'IDENTITY_MISMATCH' });
    }

    try {
      await db.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'self_service_updated', $3::jsonb, NULL)`,
        [resolved.dojo_id, resolved.federation_id, JSON.stringify([{
          student_id: rows[0].id,
          fields: [phone !== undefined ? 'phone' : null, email !== undefined ? 'email' : null].filter(Boolean),
          source: 'self_service',
        }])]
      );
    } catch (e) {
      if (e.code !== '42P01') console.error('[karateRosterSelfServicePublic] event log error:', e.message);
    }

    try {
      await db.query(`UPDATE karate_dojo_roster_validation SET last_accessed_at = NOW() WHERE dojo_id = $1`, [resolved.dojo_id]);
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') console.error('[karateRosterSelfServicePublic] touch error:', e.message);
    }

    res.json({ ok: true, id: rows[0].id, name: rows[0].name });
  } catch (err) {
    console.error('[karateRosterSelfServicePublic] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar contato' });
  }
});

module.exports = router;
