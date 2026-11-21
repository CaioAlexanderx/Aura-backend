// ============================================================
// AURA. — Rotas: modelos de mensagem do crediário (migration 462)
//
//   GET    /companies/:id/credit/message-templates
//   POST   /companies/:id/credit/message-templates          { name, body, situation?, replaces_aura? }
//   PATCH  /companies/:id/credit/message-templates/:tid     { name?, body?, situation? }
//   POST   /companies/:id/credit/message-templates/:tid/default  { situation }  (null = livre)
//   DELETE /companies/:id/credit/message-templates/:tid
//
// Montado em private.js no mesmo /credit das outras rotas do crediário, com o
// mesmo requirePlan('negocio','expansao') e depois de requireCompanyAccess
// (dono ou membro ativo da loja). Toda leitura e escrita filtra por
// company_id da URL: modelo de outra loja responde 404.
// Regras em src/services/credit/messageTemplates.js.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const svc = require('../services/credit/messageTemplates');

function responderErro(res, err, rotulo) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code_negocio || undefined });
  }
  // 462 ainda não aplicada (o deploy sobe antes): escrita espera; leitura
  // já cai nos prontos dentro do serviço.
  if (err && (err.code === '42P01' || err.code === '42703')) {
    return res.status(503).json({ error: 'Modelos de mensagem ainda indisponíveis.', code: 'SCHEMA_PENDING' });
  }
  // Corrida com o índice de padrão único (não deveria passar do lock).
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Outro modelo acabou de virar padrão. Tente de novo.', code: 'PADRAO_EM_USO' });
  }
  console.error('[creditMessageTemplates] ' + rotulo + ':', err && err.message);
  return res.status(500).json({ error: 'Erro ao ' + rotulo });
}

router.get('/message-templates', async (req, res) => {
  try {
    res.json(await svc.listar(req.params.id));
  } catch (err) { responderErro(res, err, 'listar os modelos'); }
});

router.post('/message-templates', async (req, res) => {
  try {
    const out = await svc.criar(req.params.id, req.body || {}, { userId: req.user && req.user.id });
    res.status(201).json(out);
  } catch (err) { responderErro(res, err, 'salvar o modelo'); }
});

router.patch('/message-templates/:tid', async (req, res) => {
  try {
    res.json(await svc.atualizar(req.params.id, req.params.tid, req.body || {}));
  } catch (err) { responderErro(res, err, 'atualizar o modelo'); }
});

router.post('/message-templates/:tid/default', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await svc.definirPadrao(req.params.id, req.params.tid, b.situation === undefined ? null : b.situation));
  } catch (err) { responderErro(res, err, 'definir o padrão'); }
});

router.delete('/message-templates/:tid', async (req, res) => {
  try {
    res.json(await svc.excluir(req.params.id, req.params.tid));
  } catch (err) { responderErro(res, err, 'excluir o modelo'); }
});

module.exports = router;
