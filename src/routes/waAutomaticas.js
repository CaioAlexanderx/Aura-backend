// ============================================================
// AURA — WhatsApp: automáticas (tela nova, 26/11/2026)
// Montado em /companies/:id. Contrato: contrato-automaticas.md.
//
//   GET  /whatsapp/automaticas                    — lista, divisão e saldo
//   PUT  /whatsapp/automaticas/divisao            — divide as novidades (4/4/2)
//   PUT  /whatsapp/automaticas/:key               — liga/desliga e ajusta
//   GET  /whatsapp/automaticas/:key/publico       — prévia (quem cabe, quem fica de fora)
//   POST /whatsapp/automaticas/:key/enviar-agora  — o botão "Mandar para as N"
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireAuth, requireCompanyAccess } = require('../middleware/auth');
const auto = require('../services/waAutomaticas/automaticas');
const executor = require('../services/waAutomaticas/executor');

const guard = [requireAuth, requireCompanyAccess({})];

function responderErro(res, e, rotulo) {
  if (e instanceof auto.ErroAuto) {
    return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
  }
  if (e && e.code === '42P01') {
    return res.status(503).json({ error: 'Esta função ainda está sendo preparada.', code: 'SCHEMA_PENDING' });
  }
  console.error(`[waAutomaticas] ${rotulo}:`, e && e.message);
  return res.status(500).json({ error: 'Não foi possível concluir agora.', code: 'ERRO_INTERNO' });
}

router.get('/whatsapp/automaticas', ...guard, async (req, res) => {
  try { return res.json(await auto.listar(req.params.id)); } catch (e) { return responderErro(res, e, 'listar'); }
});

// Antes de /:key para "divisao" não virar chave.
router.put('/whatsapp/automaticas/divisao', ...guard, async (req, res) => {
  try { return res.json(await auto.definirDivisao(req.params.id, req.body || {})); } catch (e) { return responderErro(res, e, 'divisao'); }
});

router.put('/whatsapp/automaticas/:key', ...guard, async (req, res) => {
  try { return res.json(await auto.ligar(req.params.id, req.params.key, req.body || {})); } catch (e) { return responderErro(res, e, 'ligar'); }
});

router.get('/whatsapp/automaticas/:key/publico', ...guard, async (req, res) => {
  try {
    const segmento = req.query.segmento ? String(req.query.segmento) : null;
    return res.json(await executor.previa(req.params.id, req.params.key, { segmento }));
  } catch (e) { return responderErro(res, e, 'publico'); }
});

router.post('/whatsapp/automaticas/:key/enviar-agora', ...guard, async (req, res) => {
  try {
    const key = req.params.key;
    if (!['venda_mais', 'crediario_vender'].includes(key)) {
      return res.status(422).json({ error: 'Essa automática não tem envio manual.', code: 'AUTOMATICA_DESCONHECIDA' });
    }
    const r = await executor.rodar(req.params.id, key, { segmento: (req.body || {}).segmento || null, ignorarLigada: true });
    const semSaldo = ['SEM_SALDO', 'SALDO_ESGOTADO', 'SALDO_INDISPONIVEL', 'NUMERO_EM_ATENCAO'].includes(r.parou_por);
    if (r.enfileiradas === 0 && semSaldo) {
      return res.status(409).json({
        error: r.parou_por === 'NUMERO_EM_ATENCAO'
          ? 'O WhatsApp pediu uma pausa nas novidades. Avisos e cobranças continuam.'
          : 'Acabaram as novidades desta parte neste mês.',
        code: r.parou_por === 'NUMERO_EM_ATENCAO' ? 'NUMERO_EM_ATENCAO' : 'SEM_SALDO',
        tipo: 'novidades', parte: auto.PARTE[key], livres: 0,
      });
    }
    return res.json({ enfileiradas: r.enfileiradas, guardadas: r.guardadas, sem_saldo: semSaldo, puladas: r.puladas });
  } catch (e) { return responderErro(res, e, 'enviar-agora'); }
});

module.exports = router;
