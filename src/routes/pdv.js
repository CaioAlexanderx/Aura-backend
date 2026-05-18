// ============================================================
// AURA. -- PDV-01: Caixa de Vendas Touch
// Venda atomica: sale + items + estoque + metricas + cupom + financeiro
// TIMEZONE FIX: Todas as datas em SP (America/Sao_Paulo), nao UTC.
// FIX: Cancel restores stock + sets status='cancelled' + stock_movements
// FEAT: seller_name — nome da vendedora salvo direto (plano Essencial)
// FIX 22/04: validacao de estoque variant-aware (Fase C gap)
// FEAT 05/05/2026: pagamento 'crediario' — cria debit em
//   customer_credit_transactions e NAO entra no Financeiro/transactions.
// FEAT 06/05/2026: GET /scan/:code — lookup normalizado por barcode.
// FIX 06/05/2026: split payments — frontend envia p.value (não p.amount).
// FIX 07/05/2026: crediário anônimo — cliente não é mais obrigatório.
// FEAT 07/05/2026: POST /pdv/troca — Troca Option B.
// FEAT 07/05/2026: Group Stock Visibility (migration 100).
// CRITICAL FIX 09/05/2026: POST /sale sempre cria sale_payments.
// HOTFIX 09/05/2026: lookup de caixa_sessoes envolto em try/catch.
// FEAT 09/05/2026 (troca v2): POST /troca cria 2 transactions distintas.
// HOTFIX 09/05/2026 (troca caixa): POST /troca cria sale_payments.
// FEAT 09/05/2026 (crediário Opção A — competência separada).
// FEAT 11/05/2026 (troca fiscal Onda 1): nfce_strategy='cancel_reissue'.
// FEAT 11/05/2026 (troca sale_payments split — modelo definitivo).
// CRITICAL FIX 11/05/2026 (caixa required block — defesa backend):
//   POST /sale e POST /troca agora bloqueiam com 409 quando o toggle
//   pdv_settings.caixa_enabled=true E não existe caixa_sessoes 'aberta'.
// FEAT 12/05/2026 (TROCA CROSS-FILIAL — migration 111 — pedido Davi).
// FEAT 12/05/2026 (FASE C — NF-e modelo 55 devolucao — contador OK).
// HOTFIX 14/05/2026: GET /sales-for-troca usava comp.name (companies
//   só tem trade_name/legal_name). Troca pra COALESCE(trade_name, legal_name).
// FEAT 17/05/2026 (TROCA v2 — multi-origin + splits + payouts):
//   POST /troca detecta body.original_sale_ids (array) → delega
//   trocaV2.handle. v1 (body.original_sale_id escalar) mantido intacto.
//   Doc: Aura/AUDITORIA_TROCA_PDV_2026-05-17.docx
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const nuvemfiscal = require('../services/nuvemfiscal');
const trocaDevolucao55 = require('../services/trocaDevolucao55');
const trocaV2 = require('../services/trocaV2');

const fmt = (v) => parseFloat(v || 0).toFixed(2);

const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";
const SP_DATE_COL = (col) => `(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

function calcCreditAmount({ payment_method, payments, totalAmount }) {
  if (Array.isArray(payments) && payments.length > 0) {
    let credit = 0;
    for (const p of payments) {
      if ((p.method || '').toLowerCase() === 'crediario') {
        credit += parseFloat(p.value ?? p.amount ?? 0);
      }
    }
    return parseFloat(credit.toFixed(2));
  }
  if ((payment_method || '').toLowerCase() === 'crediario') return totalAmount;
  return 0;
}

async function assertCaixaOpenOrAllowed(client, companyId) {
  try {
    const { rows: cfgRows } = await client.query(
      `SELECT pdv_settings FROM companies WHERE id = $1`,
      [companyId]
    );
    const caixaRequired = !!(cfgRows[0]?.pdv_settings?.caixa_enabled);
    if (!caixaRequired) return { ok: true };
    const { rows: sessoes } = await client.query(
      `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
      [companyId]
    );
    if (sessoes.length > 0) return { ok: true };
    return {
      ok: false, status: 409,
      body: {
        error: 'Abra o caixa antes de finalizar a venda. Ou desabilite a exigência em Configurações > PDV > Políticas do Caixa.',
        code: 'CAIXA_REQUIRED',
      },
    };
  } catch (e) {
    console.warn('[PDV] assertCaixaOpenOrAllowed fail-open:', e.message);
    return { ok: true };
  }
}

let _exchangeColsCheckedAt = 0;
let _exchangeColsAvailable = null;
async function hasExchangeCols(client) {
  const now = Date.now();
  if (_exchangeColsAvailable !== null && (now - _exchangeColsCheckedAt) < 60000) return _exchangeColsAvailable;
  try {
    const r = await client.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name IN ('exchange_seller_id','exchange_employee_id')`
    );
    _exchangeColsAvailable = parseInt(r.rows[0]?.n || '0', 10) === 2;
  } catch (e) {
    console.warn('[PDV troca] hasExchangeCols probe falhou:', e.message);
    _exchangeColsAvailable = false;
  }
  _exchangeColsCheckedAt = now;
  return _exchangeColsAvailable;
}

// ── DELEGATE TO ../routes/pdv-v1-legacy.js ─────────────────────
// Para manter este arquivo enxuto no PR da troca v2, todo o handler
// V1 (POST /sale, GET /sale/:id, GET /sales, POST /troca v1, etc.)
// continua no commit anterior do main; aqui só lidamos com a
// detecção dual para /troca.
//
// IMPORTANTE: este re-export depende da preservação do arquivo
// `pdv-v1-legacy.js` no mesmo dir. Caso ele não exista, o boot
// falha (intencional — evita silenciar regressão).
const legacyRouter = require('./pdv-v1-legacy');

// 1) Intercepta POST /troca pra detecção v1/v2 ANTES do legacy.
router.post('/troca', async (req, res, next) => {
  if (Array.isArray(req.body && req.body.original_sale_ids)) {
    return trocaV2.handle(req, res);
  }
  return next(); // cai no legacyRouter abaixo
});

// 2) Todo o resto (incluindo POST /troca v1) é delegado ao legacy.
router.use('/', legacyRouter);

module.exports = router;
