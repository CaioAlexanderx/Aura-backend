// ============================================================
// AURA — SALDO DO WHATSAPP (tela nova, 26/11/2026)
//
//   GET /companies/:id/whatsapp/saldo   — os tres saldos da loja
//
// So leitura: quem decide e o servidor (waSaldo.reservar). A tela mostra
// o medidor; "sem resposta" ou erro aqui = a tela trata como TRAVADO
// (mesma regra do waGuards: na duvida, bloqueia).
//
// Multi-CNPJ: o saldo e POR LOJA (cada loja tem o proprio numero e o
// proprio livro-razao). Nao ha saldo consolidado; a tela do grupo soma
// chamando uma vez por loja.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireAuth, requireCompanyAccess } = require('../middleware/auth');
const waSaldo = require('../services/waSaldo');

const guard = [requireAuth, requireCompanyAccess({})];

router.get('/whatsapp/saldo', ...guard, async (req, res) => {
  try {
    const data = await waSaldo.getSaldos(req.params.id);
    return res.json(data);
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) {
      return res.status(503).json({
        error: 'Saldo do WhatsApp ainda nao disponivel (migration 472 pendente)',
        code: 'SCHEMA_PENDING',
      });
    }
    console.error('[whatsappSaldo] leitura falhou:', e.code || '', e.message);
    return res.status(500).json({ error: 'Nao foi possivel ler o saldo agora', code: 'SALDO_INDISPONIVEL' });
  }
});

module.exports = router;
