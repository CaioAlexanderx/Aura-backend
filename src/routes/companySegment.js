// ============================================================
// AURA. — Frente da empresa pelo proprio cliente (07/10/2026)
//
// PATCH /companies/:id/segment
// Body: { segment, extras?: ['os'] }
//
// Decisao do fundador (07/10/2026): o cliente PODE trocar a propria frente
// em Configuracoes. So dono/admin da empresa (req.companyRole, carimbado por
// requireCompanyAccess em routes/private.js); membro comum -> 403.
//
// Regras (a aplicacao mora em services/segment.js -> applySegment):
//   - segment fora da lista -> 400 SEGMENT_INVALID
//   - grava segment_source = 'user'
//   - ao trocar, desliga a flag propria da frente anterior (otica_enabled /
//     matcon_enabled). os_enabled e o extra: liga com extras ['os'], desliga
//     com extras [] explicito, e fica como esta quando `extras` nao vem
//   - sair do Studio desativa a vertical; entrar exige o plano
//     (409 STUDIO_PLAN_REQUIRED)
//   - empresa com OUTRA vertical ativa (odonto, food...) nao entra no Studio
//     por aqui: a troca derrubaria a vertical dela (409 VERTICAL_ACTIVE)
//
// Resposta (mesmo formato de PATCH /admin/clients/:cid/segment):
//   { segment, segment_source, vertical_active, flags: {...} }
//
// Sem migration: companies.segment/segment_source ja existem (366) e
// audit_log e a tabela da migration 023.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const { applySegment, isValidSegment, SEGMENTS, ALLOWED_EXTRAS } = require('../services/segment');

router.patch('/segment', asyncHandler(async (req, res) => {
  if (req.companyRole !== 'owner' && req.companyRole !== 'admin') {
    return res.status(403).json({
      error: 'Só o dono da conta muda a frente',
      code: 'SEGMENT_FORBIDDEN',
      your_role: req.companyRole || null,
    });
  }

  const companyId = req.params.id;
  const body = req.body || {};
  const segment = typeof body.segment === 'string' ? body.segment.trim().toLowerCase() : body.segment;
  if (!isValidSegment(segment)) {
    return res.status(400).json({
      error: 'Frente inválida. Use uma de: ' + SEGMENTS.join(', '),
      code: 'SEGMENT_INVALID',
    });
  }
  // undefined = nao mexe no extra; [] = desliga; ['os'] = liga.
  let extras;
  if (body.extras !== undefined && body.extras !== null) {
    if (!Array.isArray(body.extras) || body.extras.some((e) => !ALLOWED_EXTRAS.includes(e))) {
      return res.status(400).json({
        error: 'Recurso extra inválido. Use: ' + ALLOWED_EXTRAS.join(', '),
        code: 'EXTRAS_INVALID',
      });
    }
    extras = [...new Set(body.extras)];
  }

  const client = await pool.connect();
  let state;
  let previous = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT segment, vertical_active FROM companies WHERE id = $1 FOR UPDATE',
      [companyId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Empresa não encontrada' });
    }
    previous = rows[0].segment || null;
    const vertical = rows[0].vertical_active || null;
    if (segment === 'studio' && vertical && vertical !== 'studio') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Esta empresa já usa outro módulo da Aura. Para mudar para Personalizados, fale com a gente.',
        code: 'VERTICAL_ACTIVE',
      });
    }
    state = await applySegment(client, companyId, {
      segment,
      extras,
      source: 'user',
      replacePrevious: true,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === 'STUDIO_PLAN_REQUIRED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  } finally {
    client.release();
  }

  // Auditoria da empresa (audit_log, migration 023). So ids e a troca em si:
  // sem IP, sem user-agent. Falha aqui nunca derruba a troca ja gravada.
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user?.id || null,
        companyId,
        'segment_change_by_user',
        'Frente: ' + (previous || 'nenhuma') + ' -> ' + segment,
        JSON.stringify({ from: previous, to: segment, extras: extras === undefined ? null : extras }),
      ]
    );
  } catch (err) {
    console.warn('[companies/segment] audit log falhou:', err.message);
  }

  res.json(state);
}));

module.exports = router;
