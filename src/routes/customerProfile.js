// ============================================================
// AURA. — Fase 1 · perfil do cliente (ficha 360º)
//
// companyRouter — montado em private.js como /companies/:id/customers:
//   GET    /tags                          tags da base do dono, com contagem
//                                          (sem diferenciar maiusculas)
//   GET    /duplicates                    grupos candidatos a mesclagem
//   GET    /:cid/timeline                 linha do tempo (eventos desta empresa)
//   GET    /:cid/summary                  métricas do topo da ficha
//   POST   /:cid/notes                    { body }
//   DELETE /:cid/notes/:nid
//   POST   /:cid/merge/preview            { source_id, fields? }  (dry-run)
//   POST   /:cid/merge                    { source_id, fields }
//
// meRouter — montado em index.js como /me (visão consolidada multi-CNPJ):
//   GET    /customers/:cid/timeline       eventos de todas as empresas do dono
//   GET    /customers/:cid/summary        que o usuário acessa
//
// Clientes são do dono (src/utils/ownerScope.js): a ficha abre de qualquer
// loja do mesmo dono. A linha do tempo por empresa mostra o que aconteceu
// NAQUELA loja; a consolidada junta as lojas, com company_name em cada
// evento. O crediário continua por par cliente-empresa.
//
// Sem requirePlan (armadilha 3): o gate de mensagem/crediário é por TIPO de
// evento, lido do banco (armadilha 9) — ver src/services/customerTimeline.js.
// ============================================================
'use strict';

const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');
const { UUID_RE } = require('../utils/timelineCursor');
const timeline = require('../services/customerTimeline');
const { findDuplicates } = require('../services/customerDuplicates');
const merge = require('../services/customerMerge');

const MAX_NOTE = 5000;

function sendError(res, err, logTag) {
  if (err && err.status && err.status < 500) {
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    return res.status(err.status).json(body);
  }
  console.error(`[customerProfile] ${logTag}:`, err && err.message);
  return res.status(500).json({ error: 'Erro ao processar a ficha do cliente' });
}

function badId(res) {
  return res.status(400).json({ error: 'id de cliente invalido' });
}

async function findOwnerCustomer(companyId, cid) {
  const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
  const { rows } = await db.query(
    `-- perfil:cliente
     SELECT id, company_id, name, phone, phone_secondary
       FROM customers
      WHERE id = $1 AND company_id = ANY($2)`,
    [cid, ownerCompanyIds]
  );
  return { customer: rows[0] || null, ownerCompanyIds };
}

// ────────────────────────────────────────────────────────────
// Rotas por empresa
// ────────────────────────────────────────────────────────────
const companyRouter = express.Router({ mergeParams: true });

// Rotas ESTÁTICAS antes das paramétricas.
companyRouter.get('/tags', async (req, res) => {
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(req.params.id);
    let rows = [];
    try {
      ({ rows } = await db.query(
        `-- perfil:tags
         SELECT MIN(t.tag) AS tag, COUNT(*)::int AS count
           FROM customers c
          CROSS JOIN LATERAL unnest(c.tags) AS t(tag)
          WHERE c.company_id = ANY($1)
            AND c.merged_into_id IS NULL
          GROUP BY lower(t.tag)
          ORDER BY count DESC, MIN(t.tag) ASC`,
        [ownerCompanyIds]
      ));
    } catch (e) {
      if (e.code !== '42703') throw e; // migration 341 pendente: sem tags ainda
    }
    res.json({ tags: rows.map(r => ({ tag: r.tag, count: parseInt(r.count, 10) || 0 })) });
  } catch (err) {
    sendError(res, err, 'tags');
  }
});

companyRouter.get('/duplicates', async (req, res) => {
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(req.params.id);
    res.json(await findDuplicates(ownerCompanyIds));
  } catch (err) {
    sendError(res, err, 'duplicates');
  }
});

companyRouter.get('/:cid/timeline', async (req, res) => {
  const { id: companyId, cid } = req.params;
  if (!UUID_RE.test(cid)) return badId(res);
  try {
    timeline.parseTimelineQuery(req.query); // 400 antes de tocar o banco
    const { customer } = await findOwnerCustomer(companyId, cid);
    if (!customer) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const out = await timeline.buildTimeline({
      companyIds: [companyId], customer, query: req.query,
    });
    res.json({ customer_id: cid, scope: 'company', ...out });
  } catch (err) {
    sendError(res, err, 'timeline');
  }
});

companyRouter.get('/:cid/summary', async (req, res) => {
  const { id: companyId, cid } = req.params;
  if (!UUID_RE.test(cid)) return badId(res);
  try {
    const { customer } = await findOwnerCustomer(companyId, cid);
    if (!customer) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const out = await timeline.buildSummary({ companyIds: [companyId], customer });
    res.json({ scope: 'company', ...out });
  } catch (err) {
    sendError(res, err, 'summary');
  }
});

companyRouter.post('/:cid/notes', async (req, res) => {
  const { id: companyId, cid } = req.params;
  if (!UUID_RE.test(cid)) return badId(res);
  const body = typeof (req.body && req.body.body) === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'body e obrigatorio', field: 'body' });
  if (body.length > MAX_NOTE) {
    return res.status(400).json({ error: `nota passa de ${MAX_NOTE} caracteres`, field: 'body' });
  }
  try {
    const { customer } = await findOwnerCustomer(companyId, cid);
    if (!customer) return res.status(404).json({ error: 'Cliente nao encontrado' });
    let note;
    try {
      ({ rows: [note] } = await db.query(
        `-- perfil:nota-cria
         INSERT INTO customer_notes (company_id, customer_id, author_id, kind, body)
         VALUES ($1, $2, $3, 'manual', $4)
         RETURNING id, company_id, customer_id, author_id, kind, body, created_at`,
        [companyId, cid, (req.user && req.user.id) || null, body]
      ));
    } catch (e) {
      if (e.code === '42P01') {
        return res.status(409).json({
          error: 'Notas indisponiveis (migration 341 pendente)', code: 'PROFILE_COLUMNS_MISSING',
        });
      }
      throw e;
    }
    res.status(201).json({ note });
  } catch (err) {
    sendError(res, err, 'notes-create');
  }
});

companyRouter.delete('/:cid/notes/:nid', async (req, res) => {
  const { id: companyId, cid, nid } = req.params;
  if (!UUID_RE.test(cid) || !UUID_RE.test(nid)) return res.status(400).json({ error: 'id invalido' });
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    let rows;
    try {
      ({ rows } = await db.query(
        `-- perfil:nota-busca
         SELECT id, kind FROM customer_notes
          WHERE id = $1 AND customer_id = $2 AND company_id = ANY($3)`,
        [nid, cid, ownerCompanyIds]
      ));
    } catch (e) {
      if (e.code === '42P01') return res.status(404).json({ error: 'Nota nao encontrada' });
      throw e;
    }
    if (!rows.length) return res.status(404).json({ error: 'Nota nao encontrada' });
    if (rows[0].kind !== 'manual') {
      return res.status(409).json({
        error: 'Nota automatica da mesclagem nao pode ser apagada', code: 'NOTE_LOCKED',
      });
    }
    await db.query(
      `-- perfil:nota-apaga
       DELETE FROM customer_notes WHERE id = $1 AND kind = 'manual'`,
      [nid]
    );
    res.json({ deleted: true, id: nid });
  } catch (err) {
    sendError(res, err, 'notes-delete');
  }
});

companyRouter.post('/:cid/merge/preview', async (req, res) => {
  const { id: companyId, cid } = req.params;
  const sourceId = req.body && req.body.source_id;
  if (!UUID_RE.test(cid)) return badId(res);
  if (!sourceId || !UUID_RE.test(String(sourceId))) {
    return res.status(400).json({ error: 'source_id invalido', field: 'source_id' });
  }
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    const out = await merge.previewMerge({
      ownerCompanyIds, targetId: cid, sourceId: String(sourceId), fields: req.body.fields,
    });
    res.json(out);
  } catch (err) {
    sendError(res, err, 'merge-preview');
  }
});

companyRouter.post('/:cid/merge', async (req, res) => {
  const { id: companyId, cid } = req.params;
  const sourceId = req.body && req.body.source_id;
  if (!UUID_RE.test(cid)) return badId(res);
  if (!sourceId || !UUID_RE.test(String(sourceId))) {
    return res.status(400).json({ error: 'source_id invalido', field: 'source_id' });
  }
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    const out = await merge.executeMerge({
      ownerCompanyIds, targetId: cid, sourceId: String(sourceId),
      fields: req.body.fields, user: req.user,
    });
    res.json(out);
  } catch (err) {
    sendError(res, err, 'merge');
  }
});

// ────────────────────────────────────────────────────────────
// Visão consolidada (/me)
// ────────────────────────────────────────────────────────────
const meRouter = express.Router();
meRouter.use(requireAuth);

// Mesmo critério de meAggregates.getUserCompanies: dono OU membro ativo.
async function getUserCompanyIds(userId) {
  const { rows } = await db.query(
    `-- perfil:me-empresas
     SELECT DISTINCT c.id
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true`,
    [userId]
  );
  return rows.map(r => r.id);
}

/**
 * Cliente visível na visão consolidada + empresas cujos eventos entram:
 * as do dono do cliente que o usuário acessa.
 */
async function resolveMeScope(userId, cid) {
  const userCompanyIds = await getUserCompanyIds(userId);
  if (!userCompanyIds.length) return { customer: null, companyIds: [] };
  const { rows } = await db.query(
    `-- perfil:me-cliente
     SELECT c.id, c.company_id, c.name, c.phone, c.phone_secondary
       FROM customers c
       JOIN companies co ON co.id = c.company_id
      WHERE c.id = $1
        AND (c.company_id = ANY($2)
             OR co.owner_id IN (SELECT owner_id FROM companies
                                 WHERE id = ANY($2) AND owner_id IS NOT NULL))`,
    [cid, userCompanyIds]
  );
  const customer = rows[0] || null;
  if (!customer) return { customer: null, companyIds: [] };
  const ownerIds = await getOwnerScopedCompanyIds(customer.company_id);
  const companyIds = ownerIds.filter(id => userCompanyIds.includes(id));
  return { customer, companyIds };
}

meRouter.get('/customers/:cid/timeline', async (req, res) => {
  const { cid } = req.params;
  if (!UUID_RE.test(cid)) return badId(res);
  try {
    timeline.parseTimelineQuery(req.query);
    const { customer, companyIds } = await resolveMeScope(req.user.id, cid);
    if (!customer || !companyIds.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const out = await timeline.buildTimeline({ companyIds, customer, query: req.query });
    res.json({ customer_id: cid, scope: 'owner', company_ids: companyIds, ...out });
  } catch (err) {
    sendError(res, err, 'me-timeline');
  }
});

meRouter.get('/customers/:cid/summary', async (req, res) => {
  const { cid } = req.params;
  if (!UUID_RE.test(cid)) return badId(res);
  try {
    const { customer, companyIds } = await resolveMeScope(req.user.id, cid);
    if (!customer || !companyIds.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const out = await timeline.buildSummary({ companyIds, customer });
    res.json({ scope: 'owner', ...out });
  } catch (err) {
    sendError(res, err, 'me-summary');
  }
});

module.exports = { companyRouter, meRouter };
