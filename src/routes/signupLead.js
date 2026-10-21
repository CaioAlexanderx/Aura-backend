// ============================================================
// AURA. — POST /api/v1/auth/signup-lead (porta de entrada 1/5, tq-66, 21/10/2026)
//
// Rota PÚBLICA: o app grava o lead ao concluir cada etapa do cadastro, para
// a equipe não perder quem abandona no meio. Regras e SQL em
// services/signupLead.js. Contrato:
//
//   corpo   { etapa: 1, nome, email, terms_accepted: true, terms_version?, origem? }
//           { etapa: 2, lead_token, cnpj | cpf, company_name? }
//           { etapa: 3, lead_token, whatsapp }
//   200     { lead_token, etapa, whatsapp_confirmado: false }
//           (etapa 1 com e-mail que já virou conta: lead_token null)
//   400     { error, code }  — validação (codes LEAD_* e WHATSAPP_*)
//   404     { error, code: 'LEAD_NOT_FOUND' } — token desconhecido ou lead já convertido
//   429     limite por IP ou por e-mail
//   503     { code: 'MIGRATION_PENDING' } — migration 402 ainda não rodou
//
// O lead NÃO cria conta nem usuário. O register liga o lead pelo lead_token.
// Limites (memória do processo, como os outros limitadores da API):
//   por IP     30 pedidos / 10 min
//   por e-mail 10 pedidos / 10 min (etapa 1; nas etapas 2 e 3, por token)
// Log: só o código do erro, nunca o corpo (nome, e-mail, documento, telefone).
// ============================================================
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const lead = require('../services/signupLead');

const JANELA_MS = 10 * 60 * 1000;
const MSG_LIMITE = { error: 'Muitas tentativas. Tente novamente em alguns minutos.', code: 'LEAD_RATE_LIMITED' };

function chaveDaPessoa(req) {
  const b = req.body || {};
  if (typeof b.email === 'string' && b.email.trim()) return `email:${b.email.trim().toLowerCase().slice(0, 200)}`;
  if (typeof b.lead_token === 'string' && b.lead_token.trim()) return `token:${b.lead_token.trim().toLowerCase().slice(0, 64)}`;
  return 'sem-chave';
}

function criarRouter({ porIp = 30, porEmail = 10 } = {}) {
  const router = express.Router();

  const limitePorIp = rateLimit({
    windowMs: JANELA_MS, max: porIp, message: MSG_LIMITE, standardHeaders: true, legacyHeaders: false,
  });
  const limitePorPessoa = rateLimit({
    windowMs: JANELA_MS, max: porEmail, message: MSG_LIMITE, standardHeaders: true, legacyHeaders: false,
    keyGenerator: chaveDaPessoa,
  });

  router.post('/signup-lead', limitePorIp, limitePorPessoa, async (req, res) => {
    const { erro, valor } = lead.normalizar(req.body);
    if (erro) return res.status(400).json(erro);
    try {
      const r = await lead.gravarEtapa(db, valor);
      if (!r) return res.status(404).json({ error: 'Cadastro não encontrado. Comece de novo pela primeira etapa.', code: 'LEAD_NOT_FOUND' });
      return res.status(200).json({ lead_token: r.lead_token, etapa: r.etapa, whatsapp_confirmado: false });
    } catch (err) {
      if (lead.migrationPendente(err)) return res.status(503).json({ error: 'Indisponível no momento.', code: 'MIGRATION_PENDING' });
      console.error('[signup-lead] falhou:', err && err.code);
      return res.status(500).json({ error: 'Não foi possível salvar agora.', code: 'LEAD_ERROR' });
    }
  });

  return router;
}

module.exports = criarRouter();
module.exports.criarRouter = criarRouter;
module.exports.chaveDaPessoa = chaveDaPessoa;
