// ============================================================
// AURA KARATÊ — Portal público do sensei (atualização cadastral por token)
// (10/07/2026 — cascata de status dojô→praticantes + validação de quadro)
// (11/07/2026 — POST /:token/practitioner: sensei adiciona praticante novo
//   direto pelo portal, sem expirar o token)
//
// SEM auth (mesmo padrão de dentalPortalPublic.js / studioApprovalPublic.js):
// o token opaco de karate_dojo_roster_validation É a autenticação. Todo
// acesso — leitura, escrita e export — é escopado ao dojo_id do token;
// dojo_id/federation_id do body são SEMPRE ignorados (nunca aceitos de fora).
//
//   GET  /public/roster-update/:token             — dados do dojô + quadro
//   POST /public/roster-update/:token             — aplica alterações de is_active
//   POST /public/roster-update/:token/practitioner — adiciona novo praticante
//                                                     (NÃO expira o token)
//   GET  /public/roster-update/:token/export      — CSV do quadro (nome, registro,
//                                                     faixa, situação)
//
// Token inválido ou com token_expires_at <= now() → 404 (não existe) /
// 410 (existe mas expirou) — nunca vaza dado do dojô nesses casos.
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');
const { nextPractitionerRegistrationNumber } = require('../services/karateService');

// Resolve token → { dojo_id, federation_id, status, token_expires_at, dojo_nome }.
// Retorna null (token não existe) ou { expired: true, ... } (existe mas venceu).
async function resolveToken(token) {
  if (!token || typeof token !== 'string') return null;

  const { rows } = await db.query(
    `SELECT v.dojo_id, v.federation_id, v.status, v.token_expires_at,
            c.name AS dojo_nome
     FROM karate_dojo_roster_validation v
     JOIN companies c ON c.id = v.dojo_id
     WHERE v.token = $1
     LIMIT 1`,
    [token]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const expired = !row.token_expires_at || new Date(row.token_expires_at) <= new Date();
  return { ...row, expired };
}

async function fetchPraticantes(dojoId, federationId) {
  const { rows } = await db.query(
    `SELECT cu.id, cu.name, cu.karate_registration_number, cu.is_active, cb.belt_name
     FROM customers cu
     LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $2
     WHERE cu.dojo_id = $1
     ORDER BY cu.name ASC`,
    [dojoId, federationId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    karate_registration_number: r.karate_registration_number || null,
    belt_name: r.belt_name || null,
    is_active: r.is_active !== false,
  }));
}

// ── GET /public/roster-update/:token ────────────────────────
router.get('/:token', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const praticantes = await fetchPraticantes(resolved.dojo_id, resolved.federation_id);

    res.json({
      dojo_nome: resolved.dojo_nome,
      status: resolved.status,
      praticantes,
    });
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[karateRosterPortalPublic] schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar quadro do dojô' });
  }
});

// ── POST /public/roster-update/:token ───────────────────────
// Body: { updates: [{ student_id, is_active }], validated_by?: string }
router.post('/:token', async (req, res) => {
  const token = req.params.token;
  const body = req.body || {};
  const updates = Array.isArray(body.updates) ? body.updates : [];
  const validatedBy = body.validated_by ? String(body.validated_by).trim().slice(0, 200) : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Trava a linha do token e revalida dentro da transação (evita corrida
    // com outro POST concorrente usando o mesmo token, ou com o token
    // expirando/mudando entre o GET e o POST do sensei).
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

      // ESCOPO: o UPDATE só acerta praticantes do dojô deste token — ids de
      // fora do dojô (mesmo que existam em outro dojô) são ignorados aqui,
      // nunca editados. Não aceitamos dojo_id/federation_id do body.
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

    // Evento de auditoria — best-effort via SAVEPOINT (não derruba a
    // validação/expiração do token se a tabela de eventos não existir).
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

    // Marca validado e EXPIRA o token (uso único) — status='validated',
    // token_expires_at=now(). Mantemos o token na tabela (não null) para
    // preservar rastreabilidade, mas ele já não passa mais no filtro de
    // expiração em nenhum GET/POST subsequente.
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
// Adiciona um novo praticante ao dojô do token. Body:
//   { name, phone, email, belt_level, belt_name }
// Validação: name + belt_level obrigatórios, e pelo menos um contato
// (phone OU email). O praticante entra ATIVO no dojô do token.
//
// Diferente do POST /:token acima: este endpoint NÃO expira o token — o
// sensei pode adicionar vários praticantes ao longo da sessão no portal e
// só confirmar (e assim expirar o link) no final, via POST /:token.
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

    // Trava e revalida o token dentro da transação — mesmo padrão do POST
    // de confirmação acima. Evita adicionar praticante num link que expirou
    // entre o GET da página e este POST (ou que foi confirmado em outra aba).
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

    // Matrícula sequencial automática — mesma função usada pelo cadastro
    // autenticado (POST /federation/:id/practitioners em karatePractitioners.js),
    // reaproveitada aqui para que a numeração continue centralizada e sem
    // colisão mesmo quando o praticante entra pelo portal do sensei.
    const regNumber = await nextPractitionerRegistrationNumber(client, federationId);

    // ESCOPO: company_id/federation_id/dojo_id vêm SEMPRE do token (nunca do
    // body) — o sensei só pode cadastrar dentro do próprio dojô.
    const insertRes = await client.query(
      `INSERT INTO customers
         (company_id, name, phone, email, is_student, federation_id, dojo_id,
          karate_registration_number, is_active, is_guest, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $1, $5, $6, true, false, NOW(), NOW())
       RETURNING id, name, karate_registration_number`,
      [federationId, name, (phone || null), (email || null), dojoId, regNumber]
    );
    const student = insertRes.rows[0];

    // Semeia a trajetória de faixa (mesmo estilo do POST autenticado em
    // karatePractitioners.js) — a view karate_current_belt deriva a faixa
    // atual a partir do histórico, então isso já faz o praticante aparecer
    // com faixa no quadro do portal e no painel da federação.
    await client.query(
      `INSERT INTO karate_belt_history
         (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, notes, created_by, created_at)
       VALUES ($1, $2, $3, $4, NULL, CURRENT_DATE, $5, NULL, NOW())`,
      [student.id, federationId, beltLevel, (beltName || beltLevel), 'Adicionado pelo sensei via portal']
    );

    // Evento de auditoria — best-effort via SAVEPOINT (mesmo padrão do POST
    // de confirmação de quadro acima); não derruba o cadastro se a tabela
    // de eventos ainda não existir (deployment parcial).
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

    // NÃO expira o token aqui — só o POST /:token (confirmação de quadro)
    // marca status='validated' e expira o link.
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
// CSV (nome, registro, faixa, situação) do quadro do dojô deste token.
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/:token/export', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const praticantes = await fetchPraticantes(resolved.dojo_id, resolved.federation_id);

    const header = ['Nome', 'Registro FPKT', 'Faixa', 'Situação'];
    const lines = [header.map(csvEscape).join(';')];
    for (const p of praticantes) {
      lines.push([
        p.name || '',
        p.karate_registration_number || '',
        p.belt_name || '',
        p.is_active ? 'Ativo' : 'Inativo',
      ].map(csvEscape).join(';'));
    }
    const csv = '﻿' + lines.join('\r\n') + '\r\n'; // BOM p/ Excel abrir acentuação correta

    const safeName = (resolved.dojo_nome || 'quadro').replace(/[^a-zA-Z0-9-_]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quadro-${safeName}.csv"`);
    res.send(csv);
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[karateRosterPortalPublic] schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] export error:', err.message);
    res.status(500).json({ error: 'Erro ao exportar quadro do dojô' });
  }
});

module.exports = router;
