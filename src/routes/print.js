// ============================================================
// AURA. — Impressao de Cupom via window.print() (INF-04 + PDV-01)
// P0 #6 FIX: seller_name now shows employee name (cashier), not owner
// 29/05/2026: GET /danfe/devolucao/:saleId — baixa o PDF do DANFE da
//   NF-e (modelo 55) de devolucao emitida pra troca, via Nuvem Fiscal.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const nuvemfiscal = require('../services/nuvemfiscal');

const NUVEM_URL = process.env.NUVEM_FISCAL_URL || 'https://api.sandbox.nuvemfiscal.com.br';

function fmt(v) { return parseFloat(v || 0).toFixed(2); }

function receiptHTML({ company, sale, items, payments, options = {} }) {
  const { autoprint = false, width80 = true } = options;
  const date = new Date(sale.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const itemsHTML = items.map(i => {
    const variantLabel = i.variant_label ? ` <small>(${i.variant_label})</small>` : '';
    const itemDiscount = parseFloat(i.discount || 0);
    return `<tr>
      <td>${i.product_name || i.product_name_snapshot}${variantLabel}</td>
      <td style="text-align:center">${i.quantity}</td>
      <td style="text-align:right">R$${fmt(i.unit_price)}</td>
      <td style="text-align:right">${itemDiscount > 0 ? `<s style="color:#999">R$${fmt(i.total_price + itemDiscount)}</s><br>` : ''}R$${fmt(i.total_price)}</td>
    </tr>`;
  }).join('');

  let paymentsHTML = '';
  if (payments?.length > 1) {
    paymentsHTML = payments.map(p =>
      `<tr><td>${_payLabel(p.method)}</td><td style="text-align:right">R$${fmt(p.amount)}</td></tr>`
    ).join('');
  } else {
    const method = sale.payment_method || 'outro';
    paymentsHTML = `<tr><td>${_payLabel(method)}</td><td style="text-align:right">R$${fmt(sale.total_amount)}</td></tr>`;
  }

  const isCash = (sale.payment_method === 'dinheiro');
  const cash   = payments?.find(p => p.method === 'dinheiro');
  const cashAmt= cash ? parseFloat(cash.amount) : (isCash && sale.cash_tendered ? parseFloat(sale.cash_tendered) : 0);
  const change = cashAmt > parseFloat(sale.total_amount) ? (cashAmt - parseFloat(sale.total_amount)).toFixed(2) : null;

  const pixSection = sale.pix_payload
    ? `<div style="text-align:center;margin:6px 0">
         <div style="font-size:10px;margin-bottom:3px">Pix para pagamento:</div>
         <img src="https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=${encodeURIComponent(sale.pix_payload)}" width="90" height="90" alt="QR Pix">
       </div>` : '';

  const w = width80 ? '72mm' : '100%';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Cupom - ${company.trade_name || company.legal_name}</title>
  <style>
    @page { margin: 4mm 5mm; size: ${width80 ? '80mm' : 'A4'} auto; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Courier New',monospace; font-size:11px; width:${w}; color:#000; }
    .center { text-align:center; }
    .bold { font-weight:bold; }
    .divider { border-top:1px dashed #000; margin:4px 0; }
    .company-name { font-size:14px; font-weight:bold; }
    table { width:100%; border-collapse:collapse; }
    th { font-size:10px; border-bottom:1px solid #000; padding:2px 0; }
    td { padding:2px 0; vertical-align:top; font-size:11px; }
    .total-row td { font-weight:bold; font-size:13px; border-top:1px solid #000; padding-top:4px; }
    .discount-row td { color:#555; }
    .footer { font-size:9px; text-align:center; margin-top:6px; }
    .sale-id { font-size:9px; color:#666; }
    @media print { body { -webkit-print-color-adjust:exact; } button { display:none; } }
  </style>
</head>
<body>
  <div class="center">
    <div class="company-name">${company.trade_name || company.legal_name}</div>
    ${company.cnpj ? `<div>CNPJ: ${company.cnpj}</div>` : ''}
    ${company.phone ? `<div>Tel: ${company.phone}</div>` : ''}
    ${company.address_street ? `<div>${company.address_street}${company.address_number ? ', '+company.address_number : ''}</div>` : ''}
    ${company.address_city ? `<div>${company.address_city}${company.address_state ? ' - '+company.address_state : ''}</div>` : ''}
  </div>
  <div class="divider"></div>
  <div class="center bold">CUPOM NAO FISCAL</div>
  <div class="divider"></div>
  <div>Data: ${date}</div>
  <div class="sale-id">Venda: #${sale.id.slice(-8).toUpperCase()}</div>
  ${sale.seller_name ? `<div>Vendedor: ${sale.seller_name}</div>` : ''}
  ${sale.customer_name ? `<div>Cliente: ${sale.customer_name}</div>` : ''}
  <div class="divider"></div>
  <table>
    <thead><tr>
      <th style="text-align:left">Produto</th>
      <th style="text-align:center">Qtd</th>
      <th style="text-align:right">Unit.</th>
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${itemsHTML}</tbody>
  </table>
  <div class="divider"></div>
  <table>
    <tr><td>Subtotal</td><td style="text-align:right">R$${fmt(parseFloat(sale.total_amount) + parseFloat(sale.discount_amount || 0))}</td></tr>
    ${parseFloat(sale.discount_amount||0) > 0
      ? `<tr class="discount-row"><td>Desconto</td><td style="text-align:right">-R$${fmt(sale.discount_amount)}</td></tr>` : ''}
    <tr class="total-row"><td>TOTAL</td><td style="text-align:right">R$${fmt(sale.total_amount)}</td></tr>
    ${paymentsHTML}
    ${change ? `<tr><td>Troco</td><td style="text-align:right">R$${change}</td></tr>` : ''}
  </table>
  ${pixSection}
  <div class="divider"></div>
  ${sale.notes ? `<div style="font-size:10px">Obs: ${sale.notes}</div><div class="divider"></div>` : ''}
  <div class="footer">Obrigado pela preferencia!<br>${company.trade_name || company.legal_name}<br><small>Powered by Aura. - getaura.com.br</small></div>
  ${autoprint ? `<script>window.onload=()=>window.print();</script>` : '<br><button onclick="window.print()" style="width:100%;padding:8px;margin-top:8px;cursor:pointer">Imprimir</button>'}
</body>
</html>`;
}

function _payLabel(method) {
  const m = {
    pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartao',
    debito: 'Cartao Debito', credito: 'Cartao Credito',
    fiado: 'Fiado', outro: 'Outro'
  };
  return m[method] || method;
}

async function _loadSaleData(saleId, companyId) {
  const { rows: companyRows } = await db.query(
    `SELECT legal_name, trade_name, cnpj, phone,
            address_street, address_number, address_city, address_state
     FROM companies WHERE id=$1`, [companyId]
  );
  // P0 #6 FIX: prefer employee name (cashier) over user name (owner)
  const { rows: saleRows } = await db.query(
    `SELECT s.*,
            COALESCE(e.name, u.full_name) AS seller_name,
            c.name AS customer_name
     FROM sales s
     LEFT JOIN employees e ON e.id = s.employee_id
     LEFT JOIN users u ON u.id = s.seller_id
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id=$1 AND s.company_id=$2`, [saleId, companyId]
  );
  if (!saleRows.length) return null;
  const { rows: items } = await db.query(
    `SELECT si.*,
            COALESCE(p.name, si.product_name_snapshot) AS product_name,
            pv.sku_suffix AS variant_label
     FROM sale_items si
     LEFT JOIN products p ON p.id=si.product_id
     LEFT JOIN product_variants pv ON pv.id=si.variant_id
     WHERE si.sale_id=$1`, [saleId]
  );
  const { rows: payments } = await db.query(
    `SELECT method, amount FROM sale_payments WHERE sale_id=$1`, [saleId]
  );
  return { company: companyRows[0] || {}, sale: saleRows[0], items, payments };
}

// GET /print/receipt/:saleId
router.get('/receipt/:saleId', requireAuth, async (req, res) => {
  try {
    const data = await _loadSaleData(req.params.saleId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Venda nao encontrada' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(receiptHTML({ ...data, options: { autoprint: false } }));
  } catch (err) { console.error('[print] receipt error:', err.message); res.status(500).json({ error: 'Erro ao gerar cupom' }); }
});

// GET /print/receipt/:saleId/preview — autoprint
router.get('/receipt/:saleId/preview', requireAuth, async (req, res) => {
  try {
    const data = await _loadSaleData(req.params.saleId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Venda nao encontrada' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(receiptHTML({ ...data, options: { autoprint: true } }));
  } catch (err) { console.error('[print] preview error:', err.message); res.status(500).json({ error: 'Erro ao gerar cupom' }); }
});

// GET /print/receipt/:saleId/a4
router.get('/receipt/:saleId/a4', requireAuth, async (req, res) => {
  try {
    const data = await _loadSaleData(req.params.saleId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Venda nao encontrada' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(receiptHTML({ ...data, options: { autoprint: false, width80: false } }));
  } catch (err) { console.error('[print] a4 error:', err.message); res.status(500).json({ error: 'Erro ao gerar cupom' }); }
});

// ============================================================
// GET /print/danfe/devolucao/:saleId
// Baixa o PDF do DANFE da NF-e (modelo 55) de devolucao emitida para a
// troca cujo sale_id = :saleId. Localiza a emissao autorizada com
// nuvemfiscal_id em nfce_emissions e baixa o PDF na Nuvem Fiscal.
//
// requireAuth: o frontend chama via fetch autenticado + blob (mesmo
// padrao de NfceActions), entao o Bearer chega no header normalmente.
// ============================================================
router.get('/danfe/devolucao/:saleId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT nuvemfiscal_id, chave_acesso, status, tipo
         FROM nfce_emissions
        WHERE sale_id = $1 AND company_id = $2
          AND tipo IN ('nfe', 'nfe_devolucao')
          AND nuvemfiscal_id IS NOT NULL
        ORDER BY (status = 'autorizada') DESC, created_at DESC
        LIMIT 1`,
      [req.params.saleId, req.params.id]
    );
    const em = rows[0];
    if (!em || !em.nuvemfiscal_id) {
      return res.status(404).json({
        error: 'NF-e de devolucao ainda nao autorizada para esta troca. Reemita a nota antes de imprimir o DANFE.',
        code: 'NFE_DEVOLUCAO_NOT_FOUND',
      });
    }

    const token = await nuvemfiscal.getToken();
    const nfResp = await fetch(`${NUVEM_URL}/nfe/${em.nuvemfiscal_id}/pdf`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' },
    });
    if (!nfResp.ok) {
      const detail = await nfResp.text().catch(() => '');
      console.error('[print] danfe devolucao Nuvem Fiscal error:', nfResp.status, String(detail).slice(0, 300));
      return res.status(502).json({
        error: 'Nao foi possivel obter o DANFE na Nuvem Fiscal.',
        status: nfResp.status,
      });
    }
    const arrayBuf = await nfResp.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="danfe-devolucao-${req.params.saleId}.pdf"`);
    res.send(Buffer.from(arrayBuf));
  } catch (err) {
    console.error('[print] danfe devolucao error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar DANFE de devolucao' });
  }
});

module.exports = router;
