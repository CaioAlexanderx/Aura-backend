// ============================================================
// AURA KARATÊ — Portal público do sensei (atualização cadastral por token)
// (10/07/2026 — cascata de status dojô→praticantes + validação de quadro)
// (11/07/2026 — POST /:token/practitioner: sensei adiciona praticante novo
//   direto pelo portal, sem expirar o token)
// (12/07/2026 — G1: portal em escala. 400 praticantes era um paredão —
//   agora: (1) cada praticante devolve `missing` (o que falta de essencial:
//   telefone/e-mail), (2) a lista vem ordenada por consequência (faixa-preta
//   ATIVA em aberto > ativo sem nenhum contato > resto) com contagens
//   essenciais/demais, (3) PATCH granular por praticante (autosave campo a
//   campo, inclui inativar), (4) export/import só do que falta, casando por
//   matrícula FPKT (nunca por nome). O link de auto-atendimento do PRÓPRIO
//   praticante vive em karateRosterSelfServicePublic.js — token SEPARADO
//   (ver migration 225), só aceita contato.
//
// SEM auth (mesmo padrão de dentalPortalPublic.js / studioApprovalPublic.js):
// o token opaco de karate_dojo_roster_validation É a autenticação. Todo
// acesso — leitura, escrita e export — é escopado ao dojo_id do token;
// dojo_id/federation_id do body são SEMPRE ignorados (nunca aceitos de fora).
//
//   GET   /public/roster-update/:token                          — quadro do dojô
//                                                                   (ordenado, com missing/counts/progress)
//   GET   /public/roster-update/:token/practitioners/:studentId — ficha completa
//                                                                   ("ver ficha completa" da UI)
//   PATCH /public/roster-update/:token/practitioners/:studentId — autosave granular
//                                                                   (inclui is_active = "não treina mais")
//   POST  /public/roster-update/:token                           — confirma o quadro (fecha o ciclo,
//                                                                   expira o token; aceita updates[] de is_active)
//   POST  /public/roster-update/:token/practitioner               — adiciona novo praticante
//                                                                   (NÃO expira o token)
//   GET   /public/roster-update/:token/export                    — CSV do quadro inteiro
//   GET   /public/roster-update/:token/export-missing             — CSV só de quem falta algo
//                                                                   (matrícula + nome + telefone + e-mail)
//   POST  /public/roster-update/:token/import                    — reimporta a planilha de export-missing
//                                                                   preenchida (casamento por matrícula;
//                                                                   {atualizados, ignorados, erros[]})
//
// Token inválido ou com token_expires_at <= now() → 404 (não existe) /
// 410 (existe mas expirou) — nunca vaza dado do dojô nesses casos.
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');
const { nextPractitionerRegistrationNumber, parseCSVLine } = require('../services/karateService');

let multer;
try { multer = require('multer'); } catch (_) { multer = null; }
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }) : null;

// ── Resolve token do SENSEI → { dojo_id, federation_id, status, dojo_nome, expired } ──
// Toca last_accessed_at (best-effort) quando o token é válido — é o sinal
// que alimenta GET /federation/:id/dojos/roster-progress (item 7: "não
// aberto" vs "em andamento").
async function resolveToken(token, { touch = true } = {}) {
  if (!token || typeof token !== 'string') return null;

  const { rows } = await db.query(
    `SELECT v.dojo_id, v.federation_id, v.status, v.token_expires_at,
            COALESCE(c.name, c.trade_name, c.legal_name) AS dojo_nome
     FROM karate_dojo_roster_validation v
     JOIN companies c ON c.id = v.dojo_id
     WHERE v.token = $1
     LIMIT 1`,
    [token]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const expired = !row.token_expires_at || new Date(row.token_expires_at) <= new Date();

  if (touch && !expired) {
    try {
      await db.query(
        `UPDATE karate_dojo_roster_validation SET last_accessed_at = NOW() WHERE dojo_id = $1`,
        [row.dojo_id]
      );
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
      console.warn('[karateRosterPortalPublic] last_accessed_at ausente (schema pendente):', e.message);
    }
  }

  return { ...row, expired };
}

// ── Classificação por praticante ────────────────────────────
// missing: campos essenciais faltando (telefone/e-mail) — item 1.
// priority_group: 'a' faixa-preta ATIVA com anuidade em aberto na temporada
//                 (fonte única: karate_member_standing.financeiro — não
//                 reimplementa a regra); 'b' ativo sem NENHUM contato;
//                 'c' o resto. Ordenação/contagens do item 2 usam isso.
function classifyPraticante(row) {
  const hasPhone = !!(row.phone && String(row.phone).trim());
  const hasEmail = !!(row.email && String(row.email).trim());
  const missing = [];
  if (!hasPhone) missing.push('telefone');
  if (!hasEmail) missing.push('email');

  const isActive = row.is_active !== false;
  const isBlackBeltOverdue = isActive && row.is_black_belt === true && row.financeiro === 'atrasado';
  const noContact = isActive && !hasPhone && !hasEmail;

  let group = 'c';
  if (isBlackBeltOverdue) group = 'a';
  else if (noContact) group = 'b';

  return { missing, group };
}

const GROUP_ORDER = { a: 0, b: 1, c: 2 };

// Busca + classifica + ordena o quadro do dojô. Reusa karate_member_standing
// (LEFT JOIN — praticante sem faixa/histórico não desaparece da lista, só
// não participa do grupo 'a').
async function fetchQuadro(dojoId, federationId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.karate_registration_number, c.is_active,
            c.phone, c.email, cb.belt_name,
            kms.financeiro, COALESCE(kms.is_black_belt, false) AS is_black_belt
     FROM customers c
     LEFT JOIN karate_current_belt cb ON cb.student_id = c.id AND cb.federation_id = $2
     LEFT JOIN karate_member_standing kms ON kms.student_id = c.id
     WHERE c.dojo_id = $1 AND c.is_guest = false
     ORDER BY c.name ASC`,
    [dojoId, federationId]
  );

  const praticantes = rows.map((r) => {
    const { missing, group } = classifyPraticante(r);
    return {
      id: r.id,
      name: r.name,
      karate_registration_number: r.karate_registration_number || null,
      belt_name: r.belt_name || null,
      is_active: r.is_active !== false,
      phone: r.phone || null,
      email: r.email || null,
      missing,
      priority_group: group,
    };
  });

  praticantes.sort((a, b) => {
    const gd = GROUP_ORDER[a.priority_group] - GROUP_ORDER[b.priority_group];
    if (gd !== 0) return gd;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });

  const essenciais = praticantes.filter((p) => p.priority_group === 'a' || p.priority_group === 'b').length;
  const demais = praticantes.length - essenciais;

  // Progresso (item 4 — barra de progresso/retomada): stateless por
  // desenho (sem tabela de baseline). "essenciais_total" = universo ainda
  // sob revisão (praticantes ATIVOS); "essenciais_resolvidos" = quantos já
  // têm telefone E e-mail. Inativar (item 3) e completar contato (item 4)
  // são os dois jeitos de mover esse número — 400 -> 120 é literalmente o
  // denominador encolhendo.
  const ativos = praticantes.filter((p) => p.is_active);
  const resolvidos = ativos.filter((p) => p.missing.length === 0).length;

  return {
    praticantes,
    counts: { essenciais, demais },
    progress: { essenciais_total: ativos.length, essenciais_resolvidos: resolvidos },
  };
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ── GET /public/roster-update/:token ────────────────────────
router.get('/:token', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const quadro = await fetchQuadro(resolved.dojo_id, resolved.federation_id);

    res.json({
      dojo_nome: resolved.dojo_nome,
      status: resolved.status,
      praticantes: quadro.praticantes,
      counts: quadro.counts,
      progress: quadro.progress,
    });
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar quadro do dojô' });
  }
});

// ── GET /public/roster-update/:token/practitioners/:studentId ──────────
// Ficha completa — a UI esconde isso atrás de "ver ficha completa" (item 1:
// não tratar todo campo como igualmente importante no payload da lista).
router.get('/:token/practitioners/:studentId', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const { rows } = await db.query(
      `SELECT c.id, c.name, c.karate_registration_number, c.is_active,
              c.phone, c.email, c.cpf_cnpj, c.rg, c.birth_date,
              c.street, c.number, c.complement, c.neighborhood, c.city, c.state, c.zip_code,
              c.guardian_name, c.guardian_phone, c.guardian_relationship,
              cb.belt_name, cb.belt_level
       FROM customers c
       LEFT JOIN karate_current_belt cb ON cb.student_id = c.id AND cb.federation_id = $3
       WHERE c.id = $1 AND c.dojo_id = $2
       LIMIT 1`,
      [req.params.studentId, resolved.dojo_id, resolved.federation_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado neste dojô', code: 'NOT_FOUND' });
    }
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] ficha schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] ficha GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar ficha do praticante' });
  }
});

// ── PATCH /public/roster-update/:token/practitioners/:studentId ────────
// Autosave granular (item 4): um praticante, um subconjunto de campos,
// idempotente. Inclui is_active (item 3 — "não treina mais"). Campo de
// faixa NÃO entra aqui (vive em karate_belt_history, append-only — mesma
// regra do cadastro autenticado).
const PORTAL_EDITABLE_FIELDS = {
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

router.patch('/:token/practitioners/:studentId', async (req, res) => {
  const token = req.params.token;
  const studentId = req.params.studentId;
  const body = req.body || {};

  const setClauses = [];
  const params = [studentId];
  let n = 2;
  const changedFields = [];

  for (const [key, col] of Object.entries(PORTAL_EDITABLE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      let val = body[key];
      val = val === null ? null : (String(val).trim() || null);
      setClauses.push(`${col} = $${n}`);
      params.push(val);
      n++;
      changedFields.push(key);
    }
  }

  let isActiveProvided = false;
  let isActiveValue = null;
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
    isActiveProvided = true;
    isActiveValue = body.is_active === true || body.is_active === 'true' || body.is_active === 1;
    setClauses.push(`is_active = $${n}`);
    params.push(isActiveValue);
    n++;
    changedFields.push('is_active');
  }

  if (!setClauses.length) {
    return res.status(422).json({ error: 'Nenhum campo para atualizar', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    params.push(dojoId);
    const dojoParamIdx = params.length;

    // ESCOPO: só acerta praticante do dojô deste token (mesmo padrão do
    // POST /:token acima) — nunca aceita dojo_id/federation_id do body.
    const updateRes = await client.query(
      `UPDATE customers SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $1 AND dojo_id = $${dojoParamIdx}
       RETURNING id, name, phone, email, is_active`,
      params
    );
    if (!updateRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado neste dojô', code: 'NOT_FOUND' });
    }
    const updated = updateRes.rows[0];

    // Auditoria — best-effort via SAVEPOINT (mesmo padrão dos demais
    // endpoints deste arquivo). Regra invadiável: inativar aqui NUNCA gera
    // cobrança — is_active só afeta customers; karate_member_standing já
    // trata is_active=false como 'nao_aplicavel'/0 (view existente, não
    // mexida por este PATCH).
    await client.query('SAVEPOINT sp_granular_event');
    try {
      const eventName = isActiveProvided
        ? (isActiveValue ? 'practitioner_reactivated' : 'practitioner_inactivated')
        : 'practitioner_updated';
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, $3, $4::jsonb, NULL)`,
        [dojoId, federationId, eventName, JSON.stringify([{ student_id: studentId, fields: changedFields, source: 'sensei_portal' }])]
      );
      await client.query('RELEASE SAVEPOINT sp_granular_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_granular_event');
        console.warn('[karateRosterPortalPublic] karate_dojo_roster_events ausente (schema pendente)');
      } else {
        throw e;
      }
    }

    await client.query('SAVEPOINT sp_touch_access');
    try {
      await client.query(
        `UPDATE karate_dojo_roster_validation SET last_accessed_at = NOW() WHERE dojo_id = $1`,
        [dojoId]
      );
      await client.query('RELEASE SAVEPOINT sp_touch_access');
    } catch (e) {
      if (e.code === '42703') {
        await client.query('ROLLBACK TO SAVEPOINT sp_touch_access');
      } else {
        throw e;
      }
    }

    await client.query('COMMIT');

    // Progresso do dojô pós-alteração (para a UI atualizar a barra sem
    // precisar de um novo GET do quadro inteiro).
    let progress = null;
    try {
      const q = await db.query(
        `SELECT COUNT(*) FILTER (WHERE is_active)::int AS total,
                COUNT(*) FILTER (
                  WHERE is_active
                    AND phone IS NOT NULL AND btrim(phone) <> ''
                    AND email IS NOT NULL AND btrim(email) <> ''
                )::int AS resolved
         FROM customers WHERE dojo_id = $1 AND is_guest = false`,
        [dojoId]
      );
      progress = {
        essenciais_total: q.rows[0].total,
        essenciais_resolvidos: q.rows[0].resolved,
      };
    } catch (_) { /* best-effort — não falha o PATCH por causa do resumo */ }

    const { missing } = classifyPraticante({ ...updated, is_black_belt: false, financeiro: null });

    res.json({
      id: updated.id,
      name: updated.name,
      phone: updated.phone || null,
      email: updated.email || null,
      is_active: updated.is_active !== false,
      missing,
      progress,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRosterPortalPublic] granular update error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar alteração' });
  } finally {
    client.release();
  }
});

// ── POST /public/roster-update/:token ───────────────────────
// Body: { updates: [{ student_id, is_active }], validated_by?: string }
// Fecha o ciclo (confirma o quadro) e EXPIRA o token — continua existindo
// para o fluxo de revisão em lote / confirmação final; o PATCH granular
// acima é o novo caminho de autosave campo a campo durante a sessão.
router.post('/:token', async (req, res) => {
  const token = req.params.token;
  const body = req.body || {};
  const updates = Array.isArray(body.updates) ? body.updates : [];
  const validatedBy = body.validated_by ? String(body.validated_by).trim().slice(0, 200) : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    const applied = [];
    const skipped = [];

    for (const raw of updates) {
      const studentId = raw && raw.student_id;
      if (!studentId || typeof raw.is_active === 'undefined') {
        skipped.push({ student_id: studentId || null, reason: 'payload inválido' });
        continue;
      }
      const isActive = raw.is_active === true || raw.is_active === 'true' || raw.is_active === 1;

      const upd = await client.query(
        `UPDATE customers SET is_active = $1, updated_at = NOW()
         WHERE id = $2 AND dojo_id = $3
         RETURNING id`,
        [isActive, studentId, dojoId]
      );
      if (upd.rows.length) {
        applied.push({ student_id: studentId, was_active: isActive });
      } else {
        skipped.push({ student_id: studentId, reason: 'fora do dojô deste link' });
      }
    }

    await client.query('SAVEPOINT sp_validated_event');
    try {
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'validated', $3::jsonb, NULL)`,
        [dojoId, federationId, JSON.stringify(applied)]
      );
      await client.query('RELEASE SAVEPOINT sp_validated_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_validated_event');
        console.warn('[karateRosterPortalPublic] karate_dojo_roster_events ausente (schema pendente)');
      } else {
        throw e;
      }
    }

    const finalRes = await client.query(
      `UPDATE karate_dojo_roster_validation
       SET status = 'validated', validated_at = NOW(), validated_by = $2,
           token_expires_at = NOW(), updated_at = NOW()
       WHERE dojo_id = $1
       RETURNING status, validated_at, validated_by`,
      [dojoId, validatedBy]
    );

    await client.query('COMMIT');

    res.json({
      status: finalRes.rows[0].status,
      validated_at: finalRes.rows[0].validated_at,
      validated_by: finalRes.rows[0].validated_by,
      applied,
      skipped,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRosterPortalPublic] POST error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar atualização cadastral' });
  } finally {
    client.release();
  }
});

// ── POST /public/roster-update/:token/practitioner ──────────
router.post('/:token/practitioner', async (req, res) => {
  const token = req.params.token;
  const body = req.body || {};
  const name = body.name != null ? String(body.name).trim() : '';
  const phone = body.phone != null ? String(body.phone).trim() : '';
  const email = body.email != null ? String(body.email).trim() : '';
  const beltLevel = body.belt_level != null ? String(body.belt_level).trim() : '';
  const beltName = body.belt_name != null ? String(body.belt_name).trim() : '';

  if (!name) {
    return res.status(422).json({ error: 'Nome é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!beltLevel) {
    return res.status(422).json({ error: 'Faixa é obrigatória', code: 'VALIDATION_ERROR' });
  }
  if (!phone && !email) {
    return res.status(422).json({ error: 'Informe pelo menos um contato (telefone ou e-mail)', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    const regNumber = await nextPractitionerRegistrationNumber(client, federationId);

    const insertRes = await client.query(
      `INSERT INTO customers
         (company_id, name, phone, email, is_student, federation_id, dojo_id,
          karate_registration_number, is_active, is_guest, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $1, $5, $6, true, false, NOW(), NOW())
       RETURNING id, name, karate_registration_number`,
      [federationId, name, (phone || null), (email || null), dojoId, regNumber]
    );
    const student = insertRes.rows[0];

    await client.query(
      `INSERT INTO karate_belt_history
         (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, notes, created_by, created_at)
       VALUES ($1, $2, $3, $4, NULL, CURRENT_DATE, $5, NULL, NOW())`,
      [student.id, federationId, beltLevel, (beltName || beltLevel), 'Adicionado pelo sensei via portal']
    );

    await client.query('SAVEPOINT sp_practitioner_added_event');
    try {
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'practitioner_added', $3::jsonb, NULL)`,
        [dojoId, federationId, JSON.stringify([{ student_id: student.id, name: student.name }])]
      );
      await client.query('RELEASE SAVEPOINT sp_practitioner_added_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_practitioner_added_event');
        console.warn('[karateRosterPortalPublic] karate_dojo_roster_events ausente (schema pendente)');
      } else {
        throw e;
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: student.id,
      name: student.name,
      karate_registration_number: student.karate_registration_number || null,
      belt_name: beltName || beltLevel,
      belt_level: beltLevel,
      is_active: true,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRosterPortalPublic] add practitioner error:', err.message);
    res.status(500).json({ error: 'Erro ao adicionar praticante' });
  } finally {
    client.release();
  }
});

// ── GET /public/roster-update/:token/export ─────────────────
router.get('/:token/export', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const quadro = await fetchQuadro(resolved.dojo_id, resolved.federation_id);

    const header = ['Nome', 'Registro FPKT', 'Faixa', 'Situação'];
    const lines = [header.map(csvEscape).join(';')];
    for (const p of quadro.praticantes) {
      lines.push([
        p.name || '',
        p.karate_registration_number || '',
        p.belt_name || '',
        p.is_active ? 'Ativo' : 'Inativo',
      ].map(csvEscape).join(';'));
    }
    const csv = '﻿' + lines.join('\r\n') + '\r\n';

    const safeName = (resolved.dojo_nome || 'quadro').replace(/[^a-zA-Z0-9-_]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quadro-${safeName}.csv"`);
    res.send(csv);
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] export error:', err.message);
    res.status(500).json({ error: 'Erro ao exportar quadro do dojô' });
  }
});

// ── GET /public/roster-update/:token/export-missing ─────────
// Item 5 — só quem falta algo, só as colunas essenciais (que são,
// coincidentemente, as únicas colunas que este endpoint jamais exporta em
// branco de propósito: telefone/e-mail) + identificador estável (matrícula
// FPKT) para o casamento na volta.
router.get('/:token/export-missing', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const quadro = await fetchQuadro(resolved.dojo_id, resolved.federation_id);
    const faltando = quadro.praticantes.filter((p) => p.missing.length > 0);

    const header = ['Matrícula FPKT', 'Nome', 'Telefone', 'E-mail'];
    const lines = [header.map(csvEscape).join(';')];
    for (const p of faltando) {
      lines.push([
        p.karate_registration_number || '',
        p.name || '',
        p.phone || '',
        p.email || '',
      ].map(csvEscape).join(';'));
    }
    const csv = '﻿' + lines.join('\r\n') + '\r\n';

    const safeName = (resolved.dojo_nome || 'quadro').replace(/[^a-zA-Z0-9-_]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="faltantes-${safeName}.csv"`);
    res.send(csv);
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] export-missing schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] export-missing error:', err.message);
    res.status(500).json({ error: 'Erro ao exportar planilha de pendências' });
  }
});

// ── POST /public/roster-update/:token/import ─────────────────
// Reimporta a planilha de export-missing preenchida. Casamento por
// identificador estável (matrícula FPKT) — NUNCA por nome (item 5).
// Idempotente; erro em uma linha não aborta o lote (SAVEPOINT por linha).
const IDENTIFIER_HEADER_ALIASES = ['matricula fpkt', 'matricula', 'registro fpkt', 'registro', 'karate_registration_number', 'fpkt'];
const PHONE_HEADER_ALIASES = ['telefone', 'phone', 'fone', 'celular'];
const EMAIL_HEADER_ALIASES = ['email', 'e-mail'];

function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function resolveImportColumns(headers) {
  const map = {};
  for (const h of headers) {
    const norm = normalizeHeader(h);
    if (!map.identifier && IDENTIFIER_HEADER_ALIASES.some((a) => norm === normalizeHeader(a))) map.identifier = h;
    else if (!map.phone && PHONE_HEADER_ALIASES.some((a) => norm === normalizeHeader(a))) map.phone = h;
    else if (!map.email && EMAIL_HEADER_ALIASES.some((a) => norm === normalizeHeader(a))) map.email = h;
  }
  return map;
}

async function doImport(token, csvText, res) {
  if (!csvText || !String(csvText).trim()) {
    return res.status(422).json({ error: 'csv_content vazio', code: 'VALIDATION_ERROR' });
  }
  const stripped = String(csvText).replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return res.status(422).json({ error: 'CSV sem linhas de dados', code: 'VALIDATION_ERROR' });
  }

  const delim = lines[0].includes(';') ? ';' : ',';
  const splitLine = (line) => (delim === ';' ? line.split(';').map((s) => s.trim()) : parseCSVLine(line));
  const headers = splitLine(lines[0]);
  const colMap = resolveImportColumns(headers);

  if (!colMap.identifier) {
    return res.status(422).json({ error: 'Coluna de matrícula (identificador estável) não encontrada no CSV', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  const erros = [];
  const applied = [];
  let atualizados = 0;
  let ignorados = 0;

  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const values = splitLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] !== undefined ? values[idx] : ''; });

      const identifier = String(row[colMap.identifier] || '').trim();
      const phoneVal = colMap.phone ? String(row[colMap.phone] || '').trim() : '';
      const emailVal = colMap.email ? String(row[colMap.email] || '').trim() : '';

      await client.query('SAVEPOINT sp_import_row');
      try {
        if (!identifier) {
          erros.push({ row: rowNum, motivo: 'Matrícula (identificador) ausente' });
          await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
          continue;
        }
        if (!phoneVal && !emailVal) {
          ignorados++;
          await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
          continue;
        }

        const setParts = [];
        const params = [identifier, dojoId];
        let n = 3;
        if (phoneVal) { setParts.push(`phone = $${n}`); params.push(phoneVal); n++; }
        if (emailVal) { setParts.push(`email = $${n}`); params.push(emailVal); n++; }

        // ESCOPO: casamento por matrícula E dojo_id do token — nunca por
        // nome, nunca fora do dojô deste link.
        const upd = await client.query(
          `UPDATE customers SET ${setParts.join(', ')}, updated_at = NOW()
           WHERE karate_registration_number = $1 AND dojo_id = $2
           RETURNING id, name`,
          params
        );
        if (!upd.rows.length) {
          erros.push({ row: rowNum, motivo: `Matrícula '${identifier}' não encontrada neste dojô` });
          await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
          continue;
        }
        atualizados++;
        applied.push({ student_id: upd.rows[0].id, name: upd.rows[0].name });
        await client.query('RELEASE SAVEPOINT sp_import_row');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
        erros.push({ row: rowNum, motivo: e.message });
      }
    }

    await client.query('SAVEPOINT sp_import_event');
    try {
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'roster_imported', $3::jsonb, NULL)`,
        [dojoId, federationId, JSON.stringify(applied.map((a) => ({ ...a, source: 'sensei_portal_import' })))]
      );
      await client.query('RELEASE SAVEPOINT sp_import_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_import_event');
      } else {
        throw e;
      }
    }

    await client.query('SAVEPOINT sp_import_touch');
    try {
      await client.query(`UPDATE karate_dojo_roster_validation SET last_accessed_at = NOW() WHERE dojo_id = $1`, [dojoId]);
      await client.query('RELEASE SAVEPOINT sp_import_touch');
    } catch (e) {
      if (e.code === '42703') {
        await client.query('ROLLBACK TO SAVEPOINT sp_import_touch');
      } else {
        throw e;
      }
    }

    await client.query('COMMIT');
    res.json({ atualizados, ignorados, erros });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRosterPortalPublic] import error:', err.message);
    res.status(500).json({ error: 'Erro ao importar planilha' });
  } finally {
    client.release();
  }
}

router.post('/:token/import', async (req, res) => {
  const token = req.params.token;

  if (upload && req.is('multipart/form-data')) {
    return upload.single('file')(req, res, async (err) => {
      if (err) {
        return res.status(422).json({ error: 'Falha ao ler arquivo enviado', code: 'VALIDATION_ERROR' });
      }
      const csvText = req.file ? req.file.buffer.toString('utf8') : (req.body && req.body.csv_content);
      return doImport(token, csvText, res);
    });
  }

  const csvText = req.body && req.body.csv_content;
  return doImport(token, csvText, res);
});

module.exports = router;
