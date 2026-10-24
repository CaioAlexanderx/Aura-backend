// ============================================================
// AURA. — Gestão Aura: piloto do Pix Automático (tq-105, 24/10/2026)
//
// Montado em /admin/painel/pix-automatico (staff), antes de /admin/painel.
//
// GET  /admin/painel/pix-automatico/elegibilidade              — último evento de elegibilidade da conta
// GET  /admin/painel/pix-automatico/:companyId                 — estado (banco + Asaas, com o QR se pendente)
// POST /admin/painel/pix-automatico/:companyId/autorizar       — cria a autorização e devolve QR + copia e cola
//        body opcional: { valor, primeiro_debito, data_fim, cobrancas_restantes,
//                         valor_primeiro_pagamento, expiracao_segundos,
//                         manter_notificacoes_asaas }
// POST /admin/painel/pix-automatico/:companyId/trocar-assinatura — só com a autorização ativa:
//        cancela a assinatura Pix comum antiga e aponta para a nova
//
// A regra está em services/pixAutomaticoPiloto.js.
// ============================================================
'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../config/database');
const pixAutomatico = require('../services/pixAutomatico');
const piloto = require('../services/pixAutomaticoPiloto');

const adminOnly = [requireAuth, requireRole('admin')];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function responderErro(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[pixAutomatico] rota falhou: ' + err.message);
  return res.status(status).json({ error: err.message, code: err.code || null, ...(err.extra || {}) });
}

function comEmpresa(fn) {
  return async (req, res) => {
    if (!UUID_RE.test(req.params.companyId || '')) {
      return res.status(400).json({ error: 'companyId inválido', code: 'company_id_invalido' });
    }
    try {
      return res.json(await fn(req));
    } catch (err) {
      return responderErro(res, err);
    }
  };
}

router.get('/elegibilidade', ...adminOnly, async (req, res) => {
  try {
    res.json(await piloto.elegibilidade({ db }));
  } catch (err) {
    responderErro(res, err);
  }
});

router.get('/:companyId', ...adminOnly, comEmpresa((req) =>
  piloto.estado({ db, cliente: pixAutomatico, companyId: req.params.companyId })));

router.post('/:companyId/autorizar', ...adminOnly, comEmpresa((req) =>
  piloto.iniciarAutorizacao({
    db, cliente: pixAutomatico, companyId: req.params.companyId, userId: req.user.id, body: req.body || {},
  })));

router.post('/:companyId/trocar-assinatura', ...adminOnly, comEmpresa((req) =>
  piloto.trocarAssinatura({ db, cliente: pixAutomatico, companyId: req.params.companyId, userId: req.user.id })));

module.exports = router;
