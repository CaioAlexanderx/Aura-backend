// ============================================================
// AURA — WhatsApp: modelos das mensagens automáticas (tela nova, 26/11/2026)
// Montado em /companies/:id. Contrato: contrato-automaticas.md (seção 3).
//
//   GET  /whatsapp/modelos?automatica=   — os modelos e o estado de aprovação
//   POST /whatsapp/modelos/preparar      — cria na Meta os padrões que faltam
//   POST /whatsapp/modelos/:key/validar  — checagens do Editor (não grava)
//   PUT  /whatsapp/modelos/:key          — texto novo -> aprovação da Meta
//   POST /whatsapp/modelos/:key/restaurar — volta ao texto da Aura
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireAuth, requireCompanyAccess } = require('../middleware/auth');
const catalogo = require('../services/waAutomaticas/modelos');
const store = require('../services/waAutomaticas/modelosStore');

const guard = [requireAuth, requireCompanyAccess({})];

function responderErro(res, e, rotulo) {
  if (e instanceof store.ErroModelo) {
    return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
  }
  if (e && e.code === '42P01') {
    return res.status(503).json({ error: 'Esta função ainda está sendo preparada.', code: 'SCHEMA_PENDING' });
  }
  console.error(`[waModelos] ${rotulo}:`, e && e.message);
  return res.status(500).json({ error: 'Não foi possível concluir agora.', code: 'ERRO_INTERNO' });
}

router.get('/whatsapp/modelos', ...guard, async (req, res) => {
  try {
    const automatica = req.query.automatica ? String(req.query.automatica) : null;
    if (automatica && !['aniversario', 'venda_mais', 'crediario'].includes(automatica)) {
      return res.status(422).json({ error: 'Automática desconhecida.', code: 'AUTOMATICA_DESCONHECIDA' });
    }
    return res.json({ data: await store.listar(req.params.id, automatica) });
  } catch (e) { return responderErro(res, e, 'listar'); }
});

router.post('/whatsapp/modelos/preparar', ...guard, async (req, res) => {
  try {
    return res.json(await store.prepararPadroes(req.params.id));
  } catch (e) { return responderErro(res, e, 'preparar'); }
});

router.post('/whatsapp/modelos/:key/validar', ...guard, (req, res) => {
  const mod = catalogo.obter(req.params.key);
  if (!mod) return res.status(404).json({ error: 'Esse modelo de mensagem não existe.', code: 'MODELO_DESCONHECIDO' });
  const r = catalogo.validar(mod, (req.body || {}).texto);
  return res.json({ ok: r.ok, checks: r.checks, previa: r.previa });
});

router.put('/whatsapp/modelos/:key', ...guard, async (req, res) => {
  try {
    const r = await store.enviarTextoNovo(req.params.id, req.params.key, (req.body || {}).texto);
    return res.status(202).json({ modelo: r.modelo, versao: r.versao });
  } catch (e) { return responderErro(res, e, 'enviar texto'); }
});

router.post('/whatsapp/modelos/:key/restaurar', ...guard, async (req, res) => {
  try {
    return res.json({ modelo: await store.restaurarPadrao(req.params.id, req.params.key) });
  } catch (e) { return responderErro(res, e, 'restaurar'); }
});

module.exports = router;
