// ============================================================
// AURA. — Impressão via window.print() (INF-04)
// Fase 1: HTML formatado para impressão em qualquer impressora
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');

function receiptHTML({ company, sale, items, payment }) {
  const date = new Date(sale.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const itemsHTML = items.map(i =>
    `<tr>
      <td>${i.product_name}</td>
      <td style="text-align:center">${i.quantity}</td>
      <td style="text-align:right">R$${parseFloat(i.unit_price).toFixed(2)}</td>
      <td style="text-align:right">R$${parseFloat(i.total_price).toFixed(2)}</td>
    </tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Cupom — ${company.trade_name || company.legal_name}</title>
  <style>
    @page { margin: 4mm 6mm; size: 80mm auto; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Courier New', monospace; font-size: 11px; width: 72mm; }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .divider { border-top: 1px dashed #000; margin: 4px 0; }
    .company-name { font-size: 14px; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; }
    th { font-size: 10px; border-bottom: 1px solid #000; padding: 2px 0; }
    td { padding: 2px 0; vertical-align: top; }
    .total-row { font-weight: bold; font-size: 12px; }
    .footer { font-size: 9px; text-align: center; margin-top: 6px; }
    @media print { body { -webkit-print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="center">
    <div class="company-name">${company.trade_name || company.legal_name}</div>
    ${company.cnpj ? `<div>CNPJ: ${company.cnpj}</div>` : ''}
    ${company.phone ? `<div>Tel: ${company.phone}</div>` : ''}
  </div>
  <div class="divider"></div>
  <div class="center bold">CUPOM NÃO FISCAL</div>
  <div class="divider"></div>
  <div>Data: ${date}</div>
  ${sale.seller_name ? `<div>Atendente: ${sale.seller_name}</div>` : ''}
  ${sale.customer_name ? `<div>Cliente: ${sale.customer_name}</div>` : ''}
  <div class="divider"></div>
  <table>
    <thead>
      <tr>
        <th style="text-align:left">Produto</th>
        <th style="text-align:center">Qtd</th>
        <th style="text-align:right">Unit.</th>
        <th style="text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>${itemsHTML}</tbody>
  </table>
  <div class="divider"></div>
  <table>
    <tr><td>Subtotal</td><td style="text-align:right">R$${parseFloat(sale.total_amount + (sale.discount_amount||0)).toFixed(2)}</td></tr>
    ${sale.discount_amount > 0 ? `<tr><td>Desconto</td><td style="text-align:right">-R$${parseFloat(sale.discount_amount).toFixed(2)}</td></tr>` : ''}
    <tr class="total-row"><td>TOTAL</td><td style="text-align:right">R$${parseFloat(sale.total_amount).toFixed(2)}</td></tr>
    ${payment ? `<tr><td>Pagamento</td><td style="text-align:right">${payment}</td></tr>` : ''}
  </table>
  <div class="divider"></div>
  <div class="footer">Obrigado pela preferência!<br>Powered by Aura. — getaura.com.br</div>
</body>
</html>`;
}

router.get('/receipt/:saleId', requireAuth, async (req, res) => {
  try {
    const { rows: companyRows } = await db.query(
      'SELECT legal_name, trade_name, cnpj, phone FROM companies WHERE id=$1', [req.params.id]
    );
    if (!companyRows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const { rows: saleRows } = await db.query(
      `SELECT s.*, u.name AS seller_name, c.name AS customer_name FROM sales s
       LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
       WHERE s.id=$1 AND s.company_id=$2`, [req.params.saleId, req.params.id]
    );
    if (!saleRows.length) return res.status(404).json({ error: 'Venda não encontrada' });
    const { rows: items } = await db.query(
      `SELECT si.quantity, si.unit_price, si.total_price,
              COALESCE(p.name, si.product_name_snapshot) AS product_name
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`,
      [req.params.saleId]
    );
    const html = receiptHTML({ company: companyRows[0], sale: saleRows[0], items, payment: saleRows[0].payment_method });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar cupom' }); }
});

router.get('/receipt/:saleId/preview', requireAuth, async (req, res) => {
  try {
    const { rows: companyRows } = await db.query(
      'SELECT legal_name, trade_name, cnpj, phone FROM companies WHERE id=$1', [req.params.id]
    );
    const { rows: saleRows } = await db.query(
      `SELECT s.*, u.name AS seller_name, c.name AS customer_name FROM sales s
       LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
       WHERE s.id=$1 AND s.company_id=$2`, [req.params.saleId, req.params.id]
    );
    if (!saleRows.length) return res.status(404).json({ error: 'Venda não encontrada' });
    const { rows: items } = await db.query(
      `SELECT si.quantity, si.unit_price, si.total_price,
              COALESCE(p.name, si.product_name_snapshot) AS product_name
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`,
      [req.params.saleId]
    );
    let html = receiptHTML({ company: companyRows[0], sale: saleRows[0], items, payment: saleRows[0].payment_method });
    html = html.replace('</body>', '<script>window.onload=()=>window.print();</script></body>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar cupom' }); }
});

module.exports = router;
