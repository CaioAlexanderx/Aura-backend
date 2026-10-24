// ============================================================
// AURA. — Configurações > E-mails (tq-87/tq-88/tq-90, 24/10/2026)
// Montado em /companies/:id/emails (routes/private.js: requireAuth +
// requireCompanyAccess já rodaram e carimbaram req.companyRole).
//
//   GET    /                          preferências, endereços, plano
//   PUT    /                          muda preferências (parcial)
//   POST   /enderecos                 { email } adiciona extra e manda o link
//   DELETE /enderecos/:enderecoId     remove extra
//   GET    /ultimos                   últimos e-mails (30 dias, email_log)
//   POST   /relatorio/enviar-agora    "Me enviar um agora" (3 por dia)
//
// Só o dono da empresa (e a equipe Aura em modo admin). Funcionário recebe
// 403. Multi-CNPJ: vale a empresa da rota, como as outras seções de
// Configurações; o app troca a empresa pelo seletor do topo.
// Migration 409 pendente (42P01): 503 MIGRATION_PENDING.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const P = require('../services/emailPreferencias');
const E = require('../services/emailEnderecos');
const { ultimosEmailsDaEmpresa } = require('../services/emailUltimos');
const scheduler = require('../jobs/reportScheduler');

const PENDENTE = { error: 'E-mails indisponíveis (migration 409 pendente).', code: 'MIGRATION_PENDING' };

function ehDono(req) {
  return req.companyRole === 'owner' || (req.user && req.user.role === 'admin');
}

router.use((req, res, next) => {
  if (!ehDono(req)) {
    return res.status(403).json({
      error: 'Só o dono da conta mexe nos e-mails.',
      code: 'EMAILS_FORBIDDEN',
      your_role: req.companyRole || null,
    });
  }
  next();
});

function pendente(err, res) {
  if (err && err.code === '42P01') {
    res.status(503).json(PENDENTE);
    return true;
  }
  return false;
}

/** Corpo do GET (e da resposta do PUT e dos endereços). */
async function estado(companyId) {
  const dono = await P.donoDaEmpresa(db, companyId);
  if (!dono) return null;
  const prefs = await P.preferenciasDaEmpresa(db, companyId);
  const extras = await P.enderecosExtras(db, companyId);

  const enderecos = [];
  if (dono.email) enderecos.push({ id: null, email: dono.email, principal: true, confirmado: true, confirmado_em: null, confirmacao_enviada_em: null });
  for (const x of extras) {
    enderecos.push({
      id: x.id,
      email: P.normalizarEmail(x.email) || x.email,
      principal: false,
      confirmado: !!x.confirmado_em,
      confirmado_em: x.confirmado_em || null,
      confirmacao_enviada_em: x.confirmacao_enviada_em || null,
    });
  }

  const tipo = (t) => {
    const p = prefs[t];
    const out = { ligado: p.ligado, explicito: p.explicito, ...p.config };
    if (t === 'relatorio' || t === 'pedido_loja') {
      out.destinatarios_efetivos = P.destinatariosDe({ principal: dono.email, extras, config: p.config });
    }
    if (t === 'pedido_loja') out.pedido_destino_escolhido = !!p.pedido_destino_escolhido;
    return out;
  };

  return {
    remetente: 'contato@getaura.com.br',
    plano: dono.plano || 'essencial',
    sempre_enviamos: [...P.TIPOS_SEMPRE],
    blocos: [...P.BLOCOS],
    blocos_do_plano: P.blocosDoPlano(dono.plano),
    enderecos,
    preferencias: {
      relatorio: tipo('relatorio'),
      ajuda: tipo('ajuda'),
      acompanhamento: tipo('acompanhamento'),
      novidades: tipo('novidades'),
      pedido_loja: tipo('pedido_loja'),
    },
    limites: { enderecos_extras: E.MAX_EXTRAS, relatorio_agora_por_dia: scheduler.MAX_AGORA_POR_DIA },
  };
}

router.get('/', asyncHandler(async (req, res) => {
  try {
    const out = await estado(req.params.id);
    if (!out) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json(out);
  } catch (err) {
    if (!pendente(err, res)) throw err;
  }
}));

router.put('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  try {
    const dono = await P.donoDaEmpresa(db, companyId);
    if (!dono) return res.status(404).json({ error: 'Empresa não encontrada.' });
    const extras = await P.enderecosExtras(db, companyId);
    const conhecidos = new Set([dono.email, ...extras.map((x) => P.normalizarEmail(x.email))].filter(Boolean));
    const v = P.validarMudancas(req.body, conhecidos);
    if (!v.ok) return res.status(400).json({ error: v.mensagem, code: v.codigo });
    await P.salvarPreferencias(db, companyId, v.mudancas, { userId: req.user && req.user.id, origem: 'tela' });
    res.json(await estado(companyId));
  } catch (err) {
    if (!pendente(err, res)) throw err;
  }
}));

router.post('/enderecos', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  try {
    const r = await E.adicionarEndereco(db, companyId, req.body && req.body.email, { userId: req.user && req.user.id });
    if (!r.ok) {
      const status = r.codigo === 'EMPRESA_NAO_ENCONTRADA' ? 404 : r.codigo === 'LIMITE_DE_ENDERECOS' ? 409 : 400;
      return res.status(status).json({ error: r.mensagem, code: r.codigo });
    }
    res.status(r.jaConfirmado ? 200 : 201).json({
      endereco: { id: r.endereco.id, email: r.endereco.email, confirmado: !!r.endereco.confirmado_em },
      // 'sent' = link enviado agora; 'duplicate' = já foi enviado nesta hora
      confirmacao: r.jaConfirmado ? 'ja_confirmado' : r.envio,
      estado: await estado(companyId),
    });
  } catch (err) {
    if (!pendente(err, res)) throw err;
  }
}));

router.delete('/enderecos/:enderecoId', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  try {
    const ok = await E.removerEndereco(db, companyId, req.params.enderecoId);
    if (!ok) return res.status(404).json({ error: 'Endereço não encontrado.', code: 'ENDERECO_NAO_ENCONTRADO' });
    res.json({ ok: true, estado: await estado(companyId) });
  } catch (err) {
    if (!pendente(err, res)) throw err;
  }
}));

router.get('/ultimos', asyncHandler(async (req, res) => {
  res.json(await ultimosEmailsDaEmpresa(db, req.params.id));
}));

router.post('/relatorio/enviar-agora', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  let email = null;
  if (req.companyRole === 'owner') {
    const dono = await P.donoDaEmpresa(db, companyId);
    email = dono && dono.email;
  } else {
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    email = rows && rows[0] && rows[0].email;
  }
  const r = await scheduler.enviarRelatorioAgora({ companyId, userId: req.user.id, email });
  if (r.ok) return res.json({ ok: true, para: r.para, restantes: r.restantes });
  const mapa = {
    SEM_EMAIL: [400, 'A conta não tem e-mail para receber o relatório.'],
    LIMITE_DIARIO: [429, `Dá para pedir até ${scheduler.MAX_AGORA_POR_DIA} relatórios por dia. Tente amanhã.`],
    RELATORIO_INDISPONIVEL: [409, 'Não deu para montar o relatório agora.'],
    ENVIO_FALHOU: [502, 'Não consegui enviar agora. Tente de novo em alguns minutos.'],
  };
  const [status, error] = mapa[r.codigo] || [500, 'Erro ao enviar.'];
  res.status(status).json({ error, code: r.codigo });
}));

module.exports = router;
module.exports.estado = estado;
