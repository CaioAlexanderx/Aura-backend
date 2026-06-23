// ============================================================
// AURA KARATÊ — Rotas de Dojôs (Track A)
// GET  /federation/:id/dojos
// POST /federation/:id/dojos
// GET  /federation/:id/dojos/:dojoId
// PATCH /federation/:id/dojos/:dojoId
//
// Status computado (ver karateService.computeDojoStatus):
//   active      → vencimento > 60 dias
//   expiring    → vencimento em 0–60 dias
//   overdue     → vencido há até 90 dias
//   defaulting  → vencido há 90–180 dias
//   suspended   → vencido há > 180 dias ou is_active=false
//
// FPKT-NNN gerado com advisory lock por federação (ver karateService).
//
// companies exige owner_id + legal_name (NOT NULL). O dojô pertence a um usuário
// de SISTEMA (não ao admin da federação — evita o bug de login multi-empresa).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { nextDojoAffiliationId, computeDojoStatus } = require('../services/karateService');

// ── GET /federation/:id/dojos ───────────────────────────────
router.get('/', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { region, status, affiliation_model, q } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const conditions = [`c.federation_id = $1`, `c.vertical = 'karate_dojo'`];
    const params = [federationId];
    let n = 2;

    if (region) {
      conditions.push(`c.region ILIKE $${n}`);
      params.push(`%${region}%`);
      n++;
    }
    if (affiliation_model) {
      conditions.push(`c.affiliation_model = $${n}`);
      params.push(affiliation_model);
      n++;
    }
    if (q) {
      conditions.push(`(c.name ILIKE $${n} OR c.fpkt_affiliation_id ILIKE $${n})`);
      params.push(`%${q}%`);
      n++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    if (status) {
      // Status is computed in JS (rolling-period logic cannot be pushed to SQL
      // without a PL/pgSQL function). When ?status= is requested we must fetch
      // the full filtered set to compute correct total, then slice for the page.
      // NOTE: this is acceptable because status-filtered queries are typically
      // dashboard-scoped and the result set per federation is bounded (~hundreds).
      // A future optimisation would be to materialise dojo_status in a VIEW or
      // computed column and filter in SQL.
      const allRes = await db.query(
        `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.region, c.fpkt_affiliation_id,
                c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
                c.address, c.phone, c.email, c.is_active, c.karate_logo_url,
                COUNT(cu.id) AS practitioner_count
         FROM companies c
         LEFT JOIN customers cu ON cu.dojo_id = c.id
         ${where}
         GROUP BY c.id
         ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC`,
        params
      );

      const allDojosWithStatus = allRes.rows.map(r => ({
        id: r.id,
        name: r.name,
        cnpj: r.cnpj || null,
        sensei_cpf: r.sensei_cpf || null,
        region: r.region || null,
        fpkt_affiliation_id: r.fpkt_affiliation_id || null,
        affiliation_model: r.affiliation_model || null,
        affiliation_since: r.affiliation_since || null,
        dojo_founded_year: r.dojo_founded_year || null,
        address: r.address || null,
        phone: r.phone || null,
        email: r.email || null,
        karate_logo_url: r.karate_logo_url || null,
        status: computeDojoStatus(r.affiliation_model, r.affiliation_since, r.is_active),
        practitioner_count: parseInt(r.practitioner_count, 10) || 0,
      }));

      const filtered = allDojosWithStatus.filter(d => d.status === status);
      const total = filtered.length;
      const data  = filtered.slice(offset, offset + pageSize);

      return res.json({ page, page_size: pageSize, total, data });
    }

    // No status filter — use SQL-level COUNT + paginated fetch (fast path)
    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM companies c ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const dataRes = await db.query(
      `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.region, c.fpkt_affiliation_id,
              c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
              c.address, c.phone, c.email, c.is_active, c.karate_logo_url,
              COUNT(cu.id) AS practitioner_count
       FROM companies c
       LEFT JOIN customers cu ON cu.dojo_id = c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSize, offset]
    );

    const dojos = dataRes.rows.map(r => ({
      id: r.id,
      name: r.name,
      cnpj: r.cnpj || null,
      sensei_cpf: r.sensei_cpf || null,
      region: r.region || null,
      fpkt_affiliation_id: r.fpkt_affiliation_id || null,
      affiliation_model: r.affiliation_model || null,
      affiliation_since: r.affiliation_since || null,
      dojo_founded_year: r.dojo_founded_year || null,
      address: r.address || null,
      phone: r.phone || null,
      email: r.email || null,
      karate_logo_url: r.karate_logo_url || null,
      status: computeDojoStatus(r.affiliation_model, r.affiliation_since, r.is_active),
      practitioner_count: parseInt(r.practitioner_count, 10) || 0,
    }));

    res.json({ page, page_size: pageSize, total, data: dojos });
  } catch (err) {
    console.error('[karateDojos] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar dojôs' });
  }
});

// ── POST /federation/:id/dojos ──────────────────────────────
router.post('/', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const {
    name, cnpj, sensei_cpf, region, affiliation_model, affiliation_since,
    dojo_founded_year, address, phone, email,
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'Campo name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!affiliation_model || !['annual', 'biannual', 'quarterly'].includes(affiliation_model)) {
    return res.status(422).json({
      error: 'affiliation_model deve ser annual, biannual ou quarterly',
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica que a federação existe
    const fedRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    // companies.owner_id é NOT NULL. Dojô NÃO pode pertencer ao admin da federação
    // (faz o login do admin cair em "visão consolidada" por ter >1 empresa). Reusa
    // o dono de um dojô já existente da federação (usuário de sistema); senão
    // acha/cria um usuário de sistema dedicado com login travado.
    let systemOwnerId = null;
    const ownerRes = await client.query(
      `SELECT owner_id FROM companies
       WHERE federation_id = $1 AND vertical = 'karate_dojo' AND owner_id IS NOT NULL
       LIMIT 1`,
      [federationId]
    );
    if (ownerRes.rows.length) {
      systemOwnerId = ownerRes.rows[0].owner_id;
    } else {
      const sysEmail = `sistema-dojos-${federationId}@getaura.com.br`;
      const u = await client.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [sysEmail]);
      if (u.rows.length) {
        systemOwnerId = u.rows[0].id;
      } else {
        const c = await client.query(
          `INSERT INTO users (email, password_hash, full_name)
           VALUES ($1, '!locked-system-no-login', 'Sistema Dojôs')
           RETURNING id`,
          [sysEmail]
        );
        systemOwnerId = c.rows[0].id;
      }
    }

    // Gera FPKT-NNN dentro da transação (com advisory lock)
    const fpktId = await nextDojoAffiliationId(client, federationId);

    // companies exige legal_name + owner_id (NOT NULL). legal_name = name.
    const insertRes = await client.query(
      `INSERT INTO companies
         (name, legal_name, cnpj, sensei_cpf, region, fpkt_affiliation_id, affiliation_model,
          affiliation_since, dojo_founded_year, address, phone, email, federation_id, owner_id,
          vertical, is_active, created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'karate_dojo', true, NOW(), NOW())
       RETURNING id, name, cnpj, sensei_cpf, region, fpkt_affiliation_id, affiliation_model,
                 affiliation_since, dojo_founded_year, address, phone, email, is_active`,
      [
        String(name).trim(),
        cnpj || null,
        sensei_cpf || null,
        region || null,
        fpktId,
        affiliation_model,
        affiliation_since || null,
        dojo_founded_year || null,
        address || null,
        phone || null,
        email || null,
        federationId,
        systemOwnerId,
      ]
    );

    await client.query('COMMIT');

    const dojo = insertRes.rows[0];
    res.status(201).json({
      id: dojo.id,
      name: dojo.name,
      cnpj: dojo.cnpj || null,
      sensei_cpf: dojo.sensei_cpf || null,
      region: dojo.region || null,
      fpkt_affiliation_id: dojo.fpkt_affiliation_id,
      affiliation_model: dojo.affiliation_model,
      affiliation_since: dojo.affiliation_since || null,
      dojo_founded_year: dojo.dojo_founded_year || null,
      address: dojo.address || null,
      phone: dojo.phone || null,
      email: dojo.email || null,
      status: computeDojoStatus(dojo.affiliation_model, dojo.affiliation_since, dojo.is_active),
      practitioner_count: 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateDojos] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar dojô', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /federation/:id/dojos/:dojoId ──────────────────────
router.get('/:dojoId', ...guards.dojoScope(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  try {
    const dojoRes = await db.query(
      `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.region, c.fpkt_affiliation_id,
              c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
              c.address, c.phone, c.email, c.is_active, c.karate_logo_url,
              COUNT(cu.id) AS practitioner_count
       FROM companies c
       LEFT JOIN customers cu ON cu.dojo_id = c.id
       WHERE c.id = $1 AND c.federation_id = $2 AND c.vertical = 'karate_dojo'
       GROUP BY c.id`,
      [dojoId, federationId]
    );

    if (!dojoRes.rows.length) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }

    const d = dojoRes.rows[0];

    // Time técnico: praticantes com função
    const teamRes = await db.query(
      `SELECT cu.id AS practitioner_id, cu.name AS name,
              cb.belt_level, cb.belt_name,
              cu.is_arbiter, cu.is_instructor, cu.is_examiner
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $1
       WHERE cu.dojo_id = $2
         AND (cu.is_arbiter = true OR cu.is_instructor = true OR cu.is_examiner = true)`,
      [federationId, dojoId]
    );

    const technicalTeam = teamRes.rows.map(r => ({
      practitioner_id: r.practitioner_id,
      name: r.name,
      belt_level: r.belt_level || null,
      roles: [
        ...(r.is_arbiter    ? ['arbiter']    : []),
        ...(r.is_instructor ? ['instructor'] : []),
        ...(r.is_examiner   ? ['examiner']   : []),
      ],
    }));

    // Histórico de anuidades (tabela karate_dojo_annuity_history — migration 152)
    // Se a tabela não existir ainda, retorna array vazio com degradação graceful
    let annuityHistory = [];
    try {
      const annuityRes = await db.query(
        `SELECT reference_period, amount, paid_at, status
         FROM karate_dojo_annuity_history
         WHERE dojo_id = $1
         ORDER BY reference_period DESC
         LIMIT 20`,
        [dojoId]
      );
      annuityHistory = annuityRes.rows;
    } catch (_) {
      // tabela ainda não aplicada — degradação graceful
    }

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
      address: d.address || null,
      phone: d.phone || null,
      email: d.email || null,
      karate_logo_url: d.karate_logo_url || null,
      status: computeDojoStatus(d.affiliation_model, d.affiliation_since, d.is_active),
      practitioner_count: parseInt(d.practitioner_count, 10) || 0,
      technical_team: technicalTeam,
      annuity_history: annuityHistory,
    });
  } catch (err) {
    console.error('[karateDojos] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dojô' });
  }
});

// ── PATCH /federation/:id/dojos/:dojoId ────────────────────
router.patch('/:dojoId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  const fieldMap = {
    name: 'name',
    cnpj: 'cnpj',
    sensei_cpf: 'sensei_cpf',
    region: 'region',
    affiliation_model: 'affiliation_model',
    affiliation_since: 'affiliation_since',
    dojo_founded_year: 'dojo_founded_year',
    address: 'address',
    phone: 'phone',
    email: 'email',
    karate_logo_url: 'karate_logo_url',
  };

  const updates = [];
  const values = [];
  let idx = 1;

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined) {
      updates.push(`${dbCol} = $${idx}`);
      values.push(req.body[bodyKey]);
      idx++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(dojoId, federationId);

  try {
    const result = await db.query(
      `UPDATE companies
       SET ${updates.join(', ')}
       WHERE id = $${idx} AND federation_id = $${idx + 1} AND vertical = 'karate_dojo'
       RETURNING id, name, cnpj, sensei_cpf, region, fpkt_affiliation_id, affiliation_model,
                 affiliation_since, dojo_founded_year, address, phone, email, is_active`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }

    const d = result.rows[0];
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
      address: d.address || null,
      phone: d.phone || null,
      email: d.email || null,
      status: computeDojoStatus(d.affiliation_model, d.affiliation_since, d.is_active),
      practitioner_count: 0, // não recomputado no PATCH por performance
    });
  } catch (err) {
    console.error('[karateDojos] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar dojô' });
  }
});

module.exports = router;
