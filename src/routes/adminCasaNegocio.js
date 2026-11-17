// ============================================================
// AURA. — Gestão Aura: "Casa no Negócio" de UMA empresa (p-189, 17/11/2026)
//
//   GET   /admin/clients/:cid/casa-negocio
//     → { company_id, casa_negocio, casa_negocio_em, vertical_active,
//         studio_enabled, personalizados_ativado_em, pode_ligar,
//         motivo_ligar, pode_desligar, motivo_desligar }
//   PATCH /admin/clients/:cid/casa-negocio   body: { ligada: true | false }
//     → { changed, estado, data_original? }
//
// A regra mora em services/casaNegocio.js. Ligar tira a empresa do /studio
// (vertical_active = NULL) sem tocar em studio_enabled e grava a data
// original da frente; desligar devolve vertical_active = 'studio'. Cada
// troca grava admin_audit_log ('casa_negocio_on' / 'casa_negocio_off') na
// mesma transação.
//
// Portões, nesta ordem: requireAuth; role 'admin' no token (o mesmo das
// outras rotas /admin); users.is_staff = true LIDO DO BANCO. Quem não é
// da equipe recebe 403. Nada aqui roda sozinho e nenhuma empresa é trocada
// por este código: só a equipe, uma empresa por vez (passo a passo no PR).
// ============================================================
'use strict';

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const casa = require('../services/casaNegocio');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function soEquipe(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT is_staff FROM users WHERE id = $1 LIMIT 1', [req.user && req.user.id]);
    if (rows[0] && rows[0].is_staff === true) return next();
  } catch (err) {
    console.error('[admin/casa-negocio] falha ao conferir is_staff:', err && err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
  return res.status(403).json({ error: 'Só a equipe Aura troca a casa de uma empresa', code: 'STAFF_ONLY' });
}

const equipe = [requireAuth, requireRole('admin'), soEquipe];

function idValido(req, res) {
  if (!UUID_RE.test(String(req.params.cid || ''))) {
    res.status(400).json({ error: 'Empresa inválida', code: 'COMPANY_INVALID' });
    return false;
  }
  return true;
}

function responderErro(res, err) {
  if (err && err.code && String(err.code).startsWith('CASA_')) {
    res.status(err.statusCode || 409).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

router.get('/clients/:cid/casa-negocio', ...equipe, asyncHandler(async (req, res) => {
  if (!idValido(req, res)) return;
  try {
    res.json(await casa.estadoDaEmpresa(pool, req.params.cid));
  } catch (err) {
    if (!responderErro(res, err)) throw err;
  }
}));

router.patch('/clients/:cid/casa-negocio', ...equipe, asyncHandler(async (req, res) => {
  if (!idValido(req, res)) return;
  const ligada = req.body ? req.body.ligada : undefined;
  if (ligada !== true && ligada !== false) {
    return res.status(400).json({ error: 'Envie ligada: true ou false', code: 'LIGADA_INVALIDA' });
  }

  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const opts = { staffUserId: req.user ? req.user.id : null };
    out = ligada
      ? await casa.ligarCasa(client, req.params.cid, opts)
      : await casa.desligarCasa(client, req.params.cid, opts);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (responderErro(res, err)) return undefined;
    throw err;
  } finally {
    client.release();
  }
  return res.json(out);
}));

module.exports = router;
