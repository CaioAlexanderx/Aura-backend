// ============================================================
// AURA. — Recebe na Aura: rota INTERNA de staff para testar a cobrança (RA-08)
//
//   POST /admin/recebe/cobranca-teste
//     body: { company_id, billing_type: 'PIX' | 'CREDIT_CARD', value,
//             due_date?, description?, customer: { name, cpf_cnpj, email?,
//             mobile_phone? } }
//     Cria a cobrança na subconta da empresa, com split para a Aura e a
//     notificação da Asaas desligada (services/recebeCobrancaService). A
//     origem é sempre 'teste' (externalReference recebe:teste:<uuid>), para
//     nunca se confundir com pedido ou venda de verdade.
//
// Não é rota de lojista. Ordem dos portões:
//   1. flag RECEBE_NA_AURA_ENABLED desligada → 404 para todos, sem login nem banco;
//   2. requireAuth;
//   3. users.is_staff = true LIDO DO BANCO (nunca o JWT, nunca o domínio do
//      e-mail) → senão 404, para a rota não aparecer.
// ============================================================
'use strict';

const crypto = require('crypto');
const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const companyBaas = require('../services/companyBaasService');
const cobranca = require('../services/recebeCobrancaService');

function naoEncontrado(res) {
  return res.status(404).json({ error: 'Não encontrado', code: 'NOT_FOUND' });
}

async function ehStaffNoBanco(userId) {
  if (!userId) return false;
  const { rows } = await db.query('SELECT is_staff FROM users WHERE id = $1 LIMIT 1', [userId]);
  return !!(rows[0] && rows[0].is_staff === true);
}

// Flag antes do login: desligada, a rota não existe para ninguém (404).
router.use((req, res, next) => (companyBaas.isEnabled() ? next() : naoEncontrado(res)));
router.use(requireAuth, async (req, res, next) => {
  try {
    if (!(await ehStaffNoBanco(req.user && req.user.id))) return naoEncontrado(res);
  } catch (e) {
    console.error('[adminRecebe] falha ao conferir is_staff:', e && e.message);
    return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
  }
  return next();
});

router.post('/cobranca-teste', async (req, res) => {
  const b = req.body || {};
  try {
    const out = await cobranca.createCharge(b.company_id, {
      billing_type: b.billing_type,
      value: b.value,
      due_date: b.due_date,
      description: b.description,
      customer: b.customer,
      origin: { type: cobranca.TEST_ORIGIN_TYPE, id: crypto.randomUUID() },
    }, { allowTestOrigin: true });
    return res.status(out.reused ? 200 : 201).json(out);
  } catch (e) {
    if (e && e.status && e.code) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[adminRecebe] cobranca-teste:', e && e.message);
    return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
