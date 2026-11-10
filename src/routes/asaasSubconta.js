// ============================================================
// AURA. — Asaas Conta Filha (Canal Digital) — DESATIVADA (RA-04, 10/11/2026)
// POST /companies/:id/digital-channel/asaas/onboard
// GET  /companies/:id/digital-channel/asaas/status
// POST /companies/:id/digital-channel/asaas/bank-account
//
// Estas rotas gravavam e liam companies.asaas_subconta_* — colunas que nao
// existem no banco de producao (a migration 071 nunca chegou la). O
// onboarding chegava a criar a conta na Asaas com o token mestre e so
// depois caia em 500 ao gravar, deixando uma conta orfa do lado de la.
// Nenhuma tela do app chama estas rotas.
//
// O Recebe na Aura tera tabela propria de subconta por empresa, em outro
// PR. Ate la, as rotas respondem sem tocar no banco nem na Asaas:
//   GET /status        -> 200 "nao configurado" (leitura nunca quebra)
//   POST /onboard      -> 410 SUBCONTA_LEGADA_DESATIVADA
//   POST /bank-account -> 410 SUBCONTA_LEGADA_DESATIVADA
// O Pix da loja online usa a chave Pix cadastrada em Pagamentos.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireRole } = require('../middleware/auth');

const CODIGO = 'SUBCONTA_LEGADA_DESATIVADA';
const MENSAGEM =
  'Esta forma de ativar o recebimento foi desativada. Para receber Pix na loja, cadastre a sua chave Pix em Pagamentos.';

function desativada(req, res) {
  res.status(410).json({ error: MENSAGEM, code: CODIGO });
}

router.post('/onboard', requireRole('client', 'analyst', 'admin'), desativada);

router.get('/status', (req, res) => {
  res.json({
    onboarded: false,
    subconta_status: 'none',
    code: CODIGO,
    message: MENSAGEM,
  });
});

router.post('/bank-account', requireRole('client', 'analyst', 'admin'), desativada);

module.exports = router;
module.exports.CODIGO = CODIGO;
module.exports.MENSAGEM = MENSAGEM;
