// ============================================================
// AURA. — Rotas da emissão automática da NFS-e (10/11/2026, migration 438)
//
// Montada em private.js como /nfse/automatica, ANTES de /nfse (lá existe
// GET /:nid, que engoliria "automatica"). Mesma autenticação e escopo de
// empresa das rotas de nfse (requireAuth + requireCompanyAccess no
// private.js; escrita só para client/analyst/admin).
//
//   GET  /config                                   liga do servidor + opt-in da empresa
//   PUT  /config            { emissao_automatica } liga/desliga o opt-in
//   GET  /origem/:tipo/:origemId                   situação das notas (tela de venda/OS concluída)
//   POST /origem/:tipo/:origemId/emitir            "Emitir NFS-e" (idempotente; corpo opcional { tomador })
//   POST /origem/:tipo/:origemId/completar         { tomador: { doc, nome, email?, fone? } } e emite
//   POST /origem/:tipo/:origemId/tentar-de-novo    nova tentativa (erro, rejeitada ou cancelada)
//   GET  /origem/:tipo/:origemId/segunda-via       notas emitidas + links; ?nfse_id=&formato=pdf devolve o PDF
//
// :tipo = 'venda' (sales.id) | 'os' (service_orders.id). Um recebimento do
// crediário não é origem: a nota dele é a da venda.
//
// Liga geral NFSE_AUTOMATICA_ENABLED: desligada, as ESCRITAS respondem 404 e
// as leituras seguem (mostram o que já existe). O "Emitir NFS-e" manual por
// origem não exige o opt-in da empresa (é a lojista apertando o botão).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const auto = require('../services/nfseAutomatica');
const repo = require('../services/nfseAutomaticaRepo');
const nacional = require('../services/nfseNacional');
const { NfseNacionalError, httpStatusDe } = require('../services/nfseNacional/errors');

const requireWrite = requireRole('client', 'analyst', 'admin');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exigirLigada(req, res, next) {
  if (auto.ligadaNoServidor()) return next();
  return res.status(404).json({
    error: 'A emissão automática da NFS-e ainda não está disponível neste servidor.',
    code: 'NFSE_AUTOMATICA_DESLIGADA',
  });
}

function origemValida(req, res, next) {
  const { tipo, origemId } = req.params;
  if (!auto.TIPOS.has(tipo)) return res.status(400).json({ error: "tipo deve ser 'venda' ou 'os'", code: 'INVALID_INPUT' });
  if (!UUID.test(String(origemId))) return res.status(400).json({ error: 'id da origem inválido', code: 'INVALID_INPUT' });
  return next();
}

function falhar(res, where, err) {
  if (err instanceof NfseNacionalError) {
    return res.status(httpStatusDe(err.code)).json({ error: err.message, code: err.code });
  }
  if (repo.schemaAusente(err)) {
    return res.status(503).json({
      error: 'A emissão automática da NFS-e está sendo instalada. Tente de novo em alguns minutos.',
      code: 'NFSE_AUTOMATICA_INDISPONIVEL',
    });
  }
  console.error(`[nfse automatica ${where}]`, err && err.code, err && err.message);
  return res.status(500).json({ error: 'Não conseguimos concluir agora. Tente de novo em instantes.' });
}

// ── config ──────────────────────────────────────────────────

router.get('/config', requireAuth, async (req, res) => {
  try {
    const cfg = await repo.carregarConfig(req.params.id);
    res.json({
      ligada_no_servidor: auto.ligadaNoServidor(),
      tem_config: !!cfg,
      provider: cfg ? cfg.provider : null,
      emissao_automatica: !!(cfg && cfg.emissao_automatica),
      emissao_automatica_desde: cfg ? cfg.emissao_automatica_desde || null : null,
      ativa: auto.ligadaNoServidor() && auto.optInAtivo(cfg),
    });
  } catch (err) {
    falhar(res, 'get config', err);
  }
});

router.put('/config', requireAuth, requireWrite, exigirLigada, async (req, res) => {
  const v = (req.body || {}).emissao_automatica;
  if (typeof v !== 'boolean') {
    return res.status(400).json({ error: 'emissao_automatica deve ser true ou false', code: 'INVALID_INPUT' });
  }
  try {
    const cfg = await repo.carregarConfig(req.params.id);
    if (!cfg) {
      return res.status(409).json({
        error: 'Configure a NFS-e da empresa (Configurações > Nota Fiscal) antes de ligar a emissão automática.',
        code: 'CONFIG_MISSING',
      });
    }
    if (v && cfg.provider !== 'nacional') {
      return res.status(409).json({
        error: 'A emissão automática funciona com o Emissor Nacional da NFS-e. Troque o emissor em Configurações > Nota Fiscal.',
        code: 'PROVIDER_NAO_NACIONAL',
      });
    }
    const r = await repo.gravarOptIn(req.params.id, v);
    res.json({ ok: true, emissao_automatica: !!(r && r.emissao_automatica), emissao_automatica_desde: r ? r.emissao_automatica_desde : null });
  } catch (err) {
    falhar(res, 'put config', err);
  }
});

// ── origem ──────────────────────────────────────────────────

async function responderSituacao(req, res, extra = {}) {
  const sit = await auto.situacaoDaOrigem({ companyId: req.params.id, tipo: req.params.tipo, id: req.params.origemId });
  if (!sit) return res.status(404).json({ error: req.params.tipo === 'os' ? 'Ordem de serviço não encontrada' : 'Venda não encontrada' });
  return res.json({ ...sit, ...extra });
}

router.get('/origem/:tipo/:origemId', requireAuth, origemValida, async (req, res) => {
  try {
    await responderSituacao(req, res);
  } catch (err) {
    falhar(res, 'situacao', err);
  }
});

function tomadorDoCorpo(body) {
  const t = (body && body.tomador) || null;
  if (!t || typeof t !== 'object') return null;
  return {
    doc: t.doc != null ? String(t.doc) : null,
    nome: t.nome != null ? String(t.nome) : null,
    email: t.email != null ? String(t.email) : null,
    fone: t.fone != null ? String(t.fone) : null,
  };
}

async function processarManual(req, { forcar }) {
  const base = {
    companyId: req.params.id, gatilho: 'manual', manual: true, forcar, tomador: tomadorDoCorpo(req.body),
  };
  if (req.params.tipo === 'os') return auto.processarOs({ ...base, osId: req.params.origemId });
  return auto.processarVenda({ ...base, saleId: req.params.origemId });
}

function corpoDoResultado(r) {
  if (!r) return {};
  if (r.acao === 'erro' && r.codigo) return { aviso: r.motivo, aviso_codigo: r.codigo };
  if (r.acao === 'nada') {
    const textos = {
      sem_servico: 'Esta venda não tem serviço: não há NFS-e a emitir.',
      os_nao_concluida: 'A NFS-e da OS sai quando ela é entregue ao cliente.',
      venda_fora: 'Venda cancelada ou troca não gera NFS-e.',
    };
    return textos[r.motivo] ? { aviso: textos[r.motivo], aviso_codigo: r.motivo.toUpperCase() } : {};
  }
  return {};
}

router.post('/origem/:tipo/:origemId/emitir', requireAuth, requireWrite, exigirLigada, origemValida, async (req, res) => {
  try {
    const r = await processarManual(req, { forcar: false });
    await responderSituacao(req, res, corpoDoResultado(r));
  } catch (err) {
    falhar(res, 'emitir', err);
  }
});

router.post('/origem/:tipo/:origemId/completar', requireAuth, requireWrite, exigirLigada, origemValida, async (req, res) => {
  const t = tomadorDoCorpo(req.body);
  if (!t || !t.doc) {
    return res.status(400).json({ error: 'Informe o CPF/CNPJ de quem contratou o serviço.', code: 'SEM_TOMADOR' });
  }
  // só o documento é conferido aqui; o nome pode vir do cadastro do cliente
  const conf = auto.resolverTomador(t, { full_name: t.nome || 'conferência' });
  if (!conf.ok && conf.codigo !== 'SEM_NOME') return res.status(422).json({ error: conf.motivo, code: conf.codigo });
  try {
    const r = await processarManual(req, { forcar: false });
    await responderSituacao(req, res, corpoDoResultado(r));
  } catch (err) {
    falhar(res, 'completar', err);
  }
});

router.post('/origem/:tipo/:origemId/tentar-de-novo', requireAuth, requireWrite, exigirLigada, origemValida, async (req, res) => {
  try {
    const r = await processarManual(req, { forcar: true });
    await responderSituacao(req, res, corpoDoResultado(r));
  } catch (err) {
    falhar(res, 'tentar de novo', err);
  }
});

router.get('/origem/:tipo/:origemId/segunda-via', requireAuth, origemValida, async (req, res) => {
  const cid = req.params.id;
  try {
    const sit = await auto.situacaoDaOrigem({ companyId: cid, tipo: req.params.tipo, id: req.params.origemId });
    if (!sit) return res.status(404).json({ error: 'Origem não encontrada' });
    const emitidas = sit.notas.filter((n) => n.estado === 'emitida' && n.nfse_id);
    if (!emitidas.length) {
      return res.status(404).json({ error: 'Ainda não há NFS-e emitida para esta origem.', code: 'SEM_NOTA', estado: sit.estado });
    }
    if (String(req.query.formato || '') === 'pdf') {
      const alvo = req.query.nfse_id
        ? emitidas.find((n) => String(n.nfse_id) === String(req.query.nfse_id))
        : (emitidas.length === 1 ? emitidas[0] : null);
      if (!alvo) {
        return res.status(400).json({ error: 'Esta origem tem mais de uma NFS-e: informe nfse_id.', code: 'ESCOLHA_A_NOTA' });
      }
      const pdf = await nacional.danfse(db, { companyId: cid, nfseId: alvo.nfse_id });
      if (!pdf) return res.status(404).json({ error: 'DANFSe ainda não disponível. Tente de novo em instantes.' });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="nfse-${alvo.nfse_number || alvo.nfse_id}.pdf"`);
      return res.send(pdf);
    }
    return res.json({
      notas: emitidas.map((n) => ({
        nfse_id: n.nfse_id,
        nfse_number: n.nfse_number,
        chave_acesso: n.chave_acesso,
        ctribnac: n.ctribnac,
        valor: n.valor,
        emitida_em: n.emitida_em,
        pdf_path: `/companies/${cid}/nfse/${n.nfse_id}/pdf`,
        xml_path: `/companies/${cid}/nfse/${n.nfse_id}/xml`,
      })),
    });
  } catch (err) {
    if (err instanceof NfseNacionalError) return falhar(res, 'segunda via', err);
    console.error('[nfse automatica segunda via]', err && err.message);
    return res.status(502).json({ error: 'Não foi possível buscar a NFS-e agora. Tente de novo em instantes.' });
  }
});

module.exports = router;
