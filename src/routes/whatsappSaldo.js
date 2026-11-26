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
const db = require('../config/database');
const waSaldo = require('../services/waSaldo');
const waSaldoPacotes = require('../services/waSaldoPacotes');
const { asaasRequest } = require('../services/asaasClient');

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

// Dias ate o vencimento da cobranca avulsa (quem compra esta sem saldo HOJE).
const PACK_DUE_DAYS = 3;
function packDueDate() {
  return new Date(Date.now() - 3 * 3600000 + PACK_DUE_DAYS * 86400000).toISOString().slice(0, 10);
}

async function loadAsaasCustomerId(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:saldo-pacote-asaas-customer
       SELECT asaas_customer_id FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return (rows[0] && rows[0].asaas_customer_id) || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return null;
    throw e;
  }
}

// Pedido que nao virou cobranca nao morre em silencio: alerta para a Gestao.
async function avisarSuportePacoteManual(companyId, pack, motivo) {
  console.warn(`[whatsappSaldo] pacote ${pack.id} (${pack.bucket}) da company ${companyId} precisa de ativacao MANUAL � ${motivo}`);
  try {
    await db.query(
      `-- wa:saldo-pacote-alerta-manual
       INSERT INTO alert_history (company_id, alert_type, severity, title, message, data)
       VALUES ($1, 'wa_saldo_pack_manual', 'warning', $2, $3, $4)`,
      [companyId, 'Pacote de mensagens aguardando ativacao',
       `A loja pediu um pacote de ${pack.qty} ${waSaldoPacotes.ROTULO[pack.bucket]} (R$ ${(pack.price_cents / 100).toFixed(2).replace('.', ',')}) e a cobranca automatica nao pode ser criada: ${motivo}. Ativar pela Gestao Aura.`,
       JSON.stringify({ pack_id: pack.id, bucket: pack.bucket, qty: pack.qty, price_cents: pack.price_cents, motivo })]
    );
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') {
      console.error('[whatsappSaldo] alerta de pacote manual falhou:', e.code || '', e.message);
    }
  }
}

router.get('/whatsapp/saldo/pacotes', ...guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `-- wa:saldo-pacote-lista
       SELECT id, bucket, qty, price_cents, status, asaas_payment_id, payment_url, source, activated_at, created_at
         FROM wa_marketing_packs WHERE company_id = $1 ORDER BY created_at DESC LIMIT 12`,
      [req.params.id]
    );
    return res.json({ data: rows });
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') {
      return res.status(503).json({ error: 'Pacotes ainda nao disponiveis (migration 472 pendente)', code: 'SCHEMA_PENDING' });
    }
    console.error('[whatsappSaldo] lista de pacotes falhou:', e.code || '', e.message);
    return res.status(500).json({ error: 'Erro ao listar os pacotes' });
  }
});

router.post('/whatsapp/saldo/pacotes', ...guard, async (req, res) => {
  const bucket = String((req.body && req.body.bucket) || '');
  const base = waSaldoPacotes.pacoteDe(bucket);
  if (!base) {
    return res.status(422).json({ error: 'bucket deve ser novidades, avisos ou aurinha', code: 'VALIDATION_ERROR' });
  }
  try {
    // Preco e quantidade saem do servidor, nunca do corpo da requisicao.
    const pack = await waSaldoPacotes.criarPacote(req.params.id, {
      bucket, status: 'pending', source: 'app', createdBy: (req.user && req.user.id) || null,
    });
    if (!pack) {
      return res.status(503).json({ error: 'Pacotes ainda nao disponiveis (migration 472 pendente)', code: 'SCHEMA_PENDING' });
    }
    const customerId = await loadAsaasCustomerId(req.params.id);
    if (!customerId) {
      await avisarSuportePacoteManual(req.params.id, pack, 'a empresa nao tem cliente no Asaas');
      return res.json({ pack, payment_url: null, needs_manual: true });
    }
    try {
      const cobranca = await asaasRequest('POST', '/payments', {
        customer: customerId,
        billingType: 'UNDEFINED',
        value: pack.price_cents / 100,
        dueDate: packDueDate(),
        description: waSaldoPacotes.descricaoCobranca(bucket, pack.qty),
        externalReference: `wa-pack-${pack.id}`,
      });
      const paymentUrl = cobranca.invoiceUrl || cobranca.bankSlipUrl || null;
      const { rows } = await db.query(
        `-- wa:saldo-pacote-pagamento
         UPDATE wa_marketing_packs
            SET asaas_payment_id = COALESCE($2, asaas_payment_id),
                payment_url = COALESCE($3, payment_url), updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [pack.id, cobranca.id || null, paymentUrl]
      );
      return res.json({ pack: rows[0] || pack, payment_url: paymentUrl, needs_manual: false });
    } catch (e) {
      await avisarSuportePacoteManual(req.params.id, pack, `o Asaas recusou a cobranca (${e.message})`);
      return res.json({ pack, payment_url: null, needs_manual: true });
    }
  } catch (e) {
    console.error('[whatsappSaldo] pedido de pacote falhou:', e.code || '', e.message);
    return res.status(500).json({ error: 'Erro ao pedir o pacote de mensagens' });
  }
});

module.exports = router;
