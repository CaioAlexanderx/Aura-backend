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
//   - self_service_token → só as duas rotas deste arquivo, cujo body é
//     whitelist estrita de campos.
//
// (16/07/2026 — decisão do Caio: abrir a FICHA INTEIRA aqui, não só
// contato. Antes, este link só aceitava phone/email — decisão deliberada
// de segurança, porque quem tem o link poderia editar dado de terceiro.
// O Caio decidiu abrir, aceitando o risco, porque o modelo de gate por
// IDENTIDADE (2º fator) protege: só quem sabe o nascimento OU a matrícula
// FPKT do praticante consegue gravar algo. Os campos editáveis agora são
// os MESMOS do portal do sensei (SELF_SERVICE_EDITABLE_FIELDS abaixo —
// espelha PORTAL_EDITABLE_FIELDS de karateRosterPortalPublic.js 1:1, as
// duas superfícies têm que concordar).
//
// AMBIGUIDADE resolvida: birth_date agora é ao MESMO TEMPO fator de
// identidade (prova quem você é) E campo editável (o aluno pode corrigir
// a própria data de nascimento errada). Pra não misturar os dois sentidos
// no mesmo payload, o body separa explicitamente:
//   identity: { birth_date?, karate_registration_number? }  — PROVA (2º
//     fator; usa o valor ATUAL/correto no banco).
//   fields:   { ... }                                        — O QUE MUDA
//     (pode incluir birth_date, quando o aluno está CORRIGINDO a data
//     errada — nesse caso a prova de identidade tem que ser a matrícula
//     FPKT, não o próprio nascimento que está incorreto).
// A query permanece atômica: o WHERE usa o valor de identity.birth_date
// (o antigo/correto), o SET usa o valor de fields.birth_date (o novo) —
// Postgres avalia WHERE contra a linha ANTES do UPDATE, então SET e WHERE
// no mesmo campo nunca colidem (testado em
// __tests__/karate.rosterPortalScale.test.js).
//
// INTOCÁVEIS (nunca entram em fields, mesmo se mandados no body — 422
// FIELD_NOT_ALLOWED): is_active, faixa/belt, status, dojo_id,
// karate_registration_number (o nº FPKT é emitido pela federação; aqui
// ele só entra em `identity`, nunca em `fields` — ninguém além da
// federação grava essa coluna, ver CLAUDE.md).
//
//   GET  /public/roster-self/:token/search?q=nome  — busca só por nome,
//        devolve só { id, name }, no máximo 8 resultados, nunca a lista
//        inteira do dojô (evita virar diretório vazado).
//   POST /public/roster-self/:token/update          — grava a ficha do
//        PRÓPRIO praticante, após confirmar identidade com data de
//        nascimento OU nº de matrícula FPKT. Qualquer chave fora de
//        {student_id, identity, fields} — ou fora das sub-whitelists de
//        identity/fields — é 422 FIELD_NOT_ALLOWED (testado em
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
// Espelha PORTAL_EDITABLE_FIELDS de karateRosterPortalPublic.js — as duas
// superfícies (portal do sensei e auto-atendimento do aluno) têm que
// concordar na lista de campos, senão viram duas verdades.
// `karate_registration_number` PROPOSITALMENTE fica de fora daqui: só
// existe como fator de `identity`, nunca como coluna gravável (é emitida
// pela federação).
const SELF_SERVICE_EDITABLE_FIELDS = {
  phone: 'phone',
  email: 'email',
  cpf: 'cpf_cnpj',
  rg: 'rg',
  birth_date: 'birth_date',
  street: 'street',
  number: 'number',
  complement: 'complement',
  neighborhood: 'neighborhood',
  city: 'city',
  state: 'state',
  zip_code: 'zip_code',
};

const ALLOWED_TOP_KEYS = new Set(['student_id', 'identity', 'fields']);
const ALLOWED_IDENTITY_KEYS = new Set(['birth_date', 'karate_registration_number']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Normaliza + valida UM campo de `fields` (nada do body é confiável).
// Retorna { value, error }: value é o valor normalizado (string ou null
// pra limpar o campo), error é a mensagem de validação (null = ok).
function normalizeFieldValue(key, raw) {
  if (raw === null) return { value: null, error: null };
  const s = String(raw).trim();
  if (s === '') return { value: null, error: null };

  switch (key) {
    case 'phone': {
      const d = onlyDigits(s);
      if (d.length < 10 || d.length > 11) return { value: null, error: 'Telefone inválido' };
      return { value: d, error: null };
    }
    case 'email': {
      const e = s.toLowerCase();
      if (!EMAIL_REGEX.test(e)) return { value: null, error: 'E-mail inválido' };
      return { value: e, error: null };
    }
    case 'cpf': {
      const d = onlyDigits(s);
      if (d.length !== 11) return { value: null, error: 'CPF inválido' };
      return { value: d, error: null };
    }
    case 'rg': {
      // RG não tem formato único no Brasil (varia por estado, pode ter
      // dígito verificador letra) — normaliza removendo pontuação/espaços,
      // sem exigir comprimento fixo (mesma folga do portal do sensei, que
      // também não valida formato de RG).
      const v = s.replace(/[.\-\s/]/g, '').toUpperCase();
      return { value: v || null, error: null };
    }
    case 'birth_date': {
      if (!ISO_DATE_REGEX.test(s)) return { value: null, error: 'birth_date deve ser YYYY-MM-DD' };
      return { value: s, error: null };
    }
    case 'zip_code': {
      const d = onlyDigits(s);
      if (d.length !== 8) return { value: null, error: 'CEP inválido' };
      return { value: d, error: null };
    }
    case 'state': {
      const v = s.toUpperCase();
      if (!/^[A-Z]{2}$/.test(v)) return { value: null, error: 'UF inválida' };
      return { value: v, error: null };
    }
    default:
      // street, number, complement, neighborhood, city — só trim (mesma
      // folga do PATCH granular do portal do sensei).
      return { value: s, error: null };
  }
}

router.post('/:token/update', updateLimiter, async (req, res) => {
  const token = req.params.token;
  const body = req.body || {};

  // ── whitelist de chaves de topo ──────────────────────────────
  const invalidTopKeys = Object.keys(body).filter((k) => !ALLOWED_TOP_KEYS.has(k));
  if (invalidTopKeys.length) {
    return res.status(422).json({
      error: `Campo(s) não permitido(s) neste link: ${invalidTopKeys.join(', ')}`,
      code: 'FIELD_NOT_ALLOWED',
    });
  }

  const studentId = body.student_id;
  if (!studentId) {
    return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  }

  // ── identity: whitelist estrita + validação ──────────────────
  const identityBody = isPlainObject(body.identity) ? body.identity : {};
  const invalidIdentityKeys = Object.keys(identityBody).filter((k) => !ALLOWED_IDENTITY_KEYS.has(k));
  if (invalidIdentityKeys.length) {
    return res.status(422).json({
      error: `Campo(s) não permitido(s) neste link: ${invalidIdentityKeys.map((k) => `identity.${k}`).join(', ')}`,
      code: 'FIELD_NOT_ALLOWED',
    });
  }

  const identityBirthDate = identityBody.birth_date ? String(identityBody.birth_date).trim() : null;
  const identityRegNumber = identityBody.karate_registration_number ? String(identityBody.karate_registration_number).trim() : null;

  if (!identityBirthDate && !identityRegNumber) {
    return res.status(422).json({ error: 'Informe data de nascimento ou nº de matrícula para confirmar sua identidade', code: 'VALIDATION_ERROR' });
  }
  if (identityBirthDate && !ISO_DATE_REGEX.test(identityBirthDate)) {
    return res.status(422).json({ error: 'identity.birth_date deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
  }

  // ── fields: whitelist estrita + normalização/validação ────────
  const fieldsBody = isPlainObject(body.fields) ? body.fields : {};
  const invalidFieldKeys = Object.keys(fieldsBody).filter((k) => !SELF_SERVICE_EDITABLE_FIELDS[k]);
  if (invalidFieldKeys.length) {
    return res.status(422).json({
      error: `Campo(s) não permitido(s) neste link: ${invalidFieldKeys.map((k) => `fields.${k}`).join(', ')}`,
      code: 'FIELD_NOT_ALLOWED',
    });
  }
  if (!Object.keys(fieldsBody).length) {
    return res.status(422).json({ error: 'Informe ao menos um campo para atualizar', code: 'VALIDATION_ERROR' });
  }

  const normalizedFields = {};
  const validationErrors = [];
  for (const key of Object.keys(fieldsBody)) {
    const { value, error } = normalizeFieldValue(key, fieldsBody[key]);
    if (error) { validationErrors.push(error); continue; }
    normalizedFields[key] = value;
  }
  if (validationErrors.length) {
    return res.status(422).json({ error: validationErrors[0], errors: validationErrors, code: 'VALIDATION_ERROR' });
  }

  try {
    const resolved = await resolveSelfServiceToken(token);
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Peça um novo link ao seu sensei.' });

    const setParts = [];
    const params = [studentId, resolved.dojo_id];
    let n = 3;
    const changedFields = [];
    for (const [key, col] of Object.entries(SELF_SERVICE_EDITABLE_FIELDS)) {
      if (Object.prototype.hasOwnProperty.call(normalizedFields, key)) {
        setParts.push(`${col} = $${n}`);
        params.push(normalizedFields[key]);
        n++;
        changedFields.push(key);
      }
    }

    // 2º fator de identidade — usa SEMPRE o valor de `identity` (a PROVA,
    // o que o aluno digitou de cabeça), nunca o de `fields` (o valor
    // NOVO que ele pode estar corrigindo). O WHERE é avaliado pelo
    // Postgres contra a linha ANTES do UPDATE, então mesmo quando
    // fields.birth_date também está presente (corrigindo a data), o SET
    // e o WHERE não colidem — testado em
    // __tests__/karate.rosterPortalScale.test.js.
    const identityParts = [];
    if (identityBirthDate) { identityParts.push(`birth_date = $${n}::date`); params.push(identityBirthDate); n++; }
    if (identityRegNumber) { identityParts.push(`karate_registration_number = $${n}`); params.push(identityRegNumber); n++; }

    // ESCOPO + IDENTIDADE na MESMA query: só atualiza se (a) o praticante é
    // deste dojô (do self_service_token) E (b) o 2º fator bate. Nunca toca
    // is_active/faixa/status/dojo_id/karate_registration_number — essas
    // colunas não entram no SET (fora de SELF_SERVICE_EDITABLE_FIELDS).
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
          fields: changedFields,
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
    res.status(500).json({ error: 'Erro ao atualizar ficha' });
  }
});

module.exports = router;
