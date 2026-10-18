// ============================================================
// AURA. — Oferta "vamos configurar juntos": rota do cliente (18/10/2026, f2-04)
//
//   GET  /companies/:id/onboarding/setup-call
//        → { disponivel, solicitado, dispensado }
//   POST /companies/:id/onboarding/setup-call   { acao: 'solicitou' | 'dispensou' }
//        → { registrado, acao }            (registrado: false = já estava / não vale)
//
// O Painel mostra o cartão quando `disponivel` é true. "Marcar pelo WhatsApp"
// faz POST { acao: 'solicitou' } e abre o wa.me; "Agora não" faz POST
// { acao: 'dispensou' } e o cartão some para aquela conta. Regras em
// services/setupCall.js.
//
// SEM MIGRATION: o estado vive em audit_log (uma linha por empresa e ação), que
// é também o que o painel conta:
//   onboarding.setup_call_shown      (1a vez que `disponivel` foi true no GET)
//   onboarding.setup_call_requested  (clique em "Marcar pelo WhatsApp")
//   onboarding.setup_call_dismissed  (clique em "Agora não")
// A gravação é idempotente (INSERT ... WHERE NOT EXISTS): duas chamadas juntas
// ou um toque repetido gravam uma linha só.
//
// Montada em routes/private.js, atrás de requireAuth + requireCompanyAccess:
// qualquer membro da empresa; o app só mostra para dono/admin. Staff (modo
// admin) nunca vê nem registra: GET devolve disponivel false, POST 403.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const { sqlForaDoCheckin } = require('../services/checkin');
const setupCall = require('../services/setupCall');

const ehStaff = (req) => !!req.user && req.user.role === 'admin';

async function carregar(companyId) {
  const { rows } = await db.query(
    `-- setupcall:empresa
     SELECT c.created_at, c.billing_status, c.asaas_subscription_id,
            ${sqlForaDoCheckin('c')} AS fora,
            EXISTS (SELECT 1 FROM audit_log a WHERE a.company_id = c.id AND a.action = $2) AS solicitado,
            EXISTS (SELECT 1 FROM audit_log a WHERE a.company_id = c.id AND a.action = $3) AS dispensado
       FROM companies c
      WHERE c.id = $1`,
    [companyId, setupCall.ACAO_SOLICITADA, setupCall.ACAO_DISPENSADA]
  );
  return rows[0] || null;
}

// Uma linha por (empresa, ação). Devolve true se gravou agora.
async function gravarUmaVez(req, companyId, action, detail) {
  const { rowCount } = await db.query(
    `-- setupcall:gravar
     INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
     SELECT $1::uuid, $2::uuid, $3::varchar, $4::text, $5::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE company_id = $2::uuid AND action = $3::varchar)`,
    [
      req.user && req.user.id ? req.user.id : null,
      companyId,
      action,
      detail,
      JSON.stringify({ origem: 'painel', janela_dias: setupCall.JANELA_DIAS }),
    ]
  );
  return rowCount > 0;
}

router.get('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const empresa = await carregar(companyId);
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada', code: 'COMPANY_NOT_FOUND' });

  const out = setupCall.estado({ empresa, staff: ehStaff(req) });

  // Primeira vez que o cartão é oferecido: um evento só, para medir
  // exibida -> pediu. Falha de auditoria nunca derruba a leitura.
  if (out.disponivel) {
    try {
      await gravarUmaVez(req, companyId, setupCall.ACAO_EXIBIDA, 'Oferta de configurar junto exibida');
    } catch (err) {
      console.warn('[setup-call] registro de exibição falhou:', err.message);
    }
  }
  res.json(out);
}));

router.post('/', asyncHandler(async (req, res) => {
  if (ehStaff(req)) {
    return res.status(403).json({ error: 'A oferta é respondida pelo cliente.', code: 'SETUP_CALL_STAFF' });
  }
  const { erro, acao } = setupCall.normalizarClique(req.body);
  if (erro) return res.status(400).json({ error: erro, code: 'SETUP_CALL_INVALID' });

  const companyId = req.params.id;
  const empresa = await carregar(companyId);
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada', code: 'COMPANY_NOT_FOUND' });

  // Conta que assina, filial, cadastro antigo ou oferta desligada: 200 sem
  // gravar (o toque não vira número para o painel).
  const motivo = setupCall.motivoDeFora({ empresa, staff: false });
  if (motivo) return res.json({ registrado: false, acao, motivo });

  const detail = acao === setupCall.ACAO_SOLICITADA
    ? 'Pediu a conversa de 20 minutos para configurar junto'
    : 'Dispensou a oferta de configurar junto';
  const registrado = await gravarUmaVez(req, companyId, acao, detail);
  res.json({ registrado, acao });
}));

module.exports = router;
