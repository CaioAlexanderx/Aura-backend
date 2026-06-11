// ============================================================
// AURA. — Impressao de Cupom via window.print() (INF-04 + PDV-01)
// P0 #6 FIX: seller_name now shows employee name (cashier), not owner
// 29/05/2026: GET /danfe/devolucao/:saleId — baixa o PDF do DANFE da
//   NF-e (modelo 55) de devolucao emitida pra troca, via Nuvem Fiscal.
// 07/06/2026: GET /print/credit/:cid/carne — carnê/extrato imprimível
//   do crediário do cliente (agrupado por carnê + Pix estático manual).
// 11/06/2026: GET /print/credit/receipts/:transactionId — recibo de
//   pagamento de crediário (B5): empresa, cliente, encargos, saldo,
//   crédito a favor + texto WhatsApp.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const nuvemfiscal = require('../services/nuvemfiscal');
const { buildStaticBrCode, validatePixKey } = require('../services/staticPixService');

const NUVEM_URL = process.env.NUVEM_FISCAL_URL || 'https://api.sandbox.nuvemfiscal.com.br';

function fmt(v) { return parseFloat(v || 0).toFixed(2); }

// A1-BE: sanitize all user-controlled values before embedding in HTML
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

// ============================================================
// GET /print/credit/:cid/carne
// Gera HTML imprimível do carnê/extrato de crediário do cliente,
// agrupado por carnê (credit_accounts), com bloco Pix estático manual
// se a loja tiver pix_key em digital_channel_config.
//
// requireAuth: frontend deve chamar via fetch com Authorization header
// e renderizar via document.write (mesmo padrão das outras rotas /print/*).
//
// 3T3 (11/06/2026): cada parcela EM ABERTO ganha Pix copia-e-cola + QR
//   POR PARCELA, reusando buildStaticBrCode (mesmo gerador do B2). O valor
//   do Pix da parcela e o PRINCIPAL restante (amount_due - covered_amount);
//   encargos lazy (mora/multa) NAO entram no papel pois mudam diariamente —
//   uma nota fixa avisa que atrasos sao calculados no pagamento. As somas
//   impressas batem com customer_credit_balances (sem encargos).
// ============================================================
router.get('/credit/:cid/carne', requireAuth, async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;

  try {
    // 1. Dados da empresa (companies NÃO tem coluna `name`)
    const { rows: companyRows } = await db.query(
      `SELECT COALESCE(trade_name, legal_name) AS display_name,
              legal_name, trade_name, cnpj, phone,
              address_city, address_state
         FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!companyRows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companyRows[0];

    // 2. Dados do cliente
    const { rows: custRows } = await db.query(
      `SELECT id, name, phone, cpf_cnpj FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    if (!custRows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const customer = custRows[0];

    // 3. Saldo total em aberto (view customer_credit_balances)
    let totalBalance = 0;
    try {
      const { rows: balRows } = await db.query(
        `SELECT COALESCE(balance, 0) AS balance
           FROM customer_credit_balances
          WHERE customer_id = $1 AND company_id = $2`,
        [customerId, companyId]
      );
      totalBalance = parseFloat(balRows[0]?.balance || 0);
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.warn('[print/carne] balance warn:', e.message);
    }

    // 4. Parcelas (todas, não só em aberto) para montar o cronograma
    let allInstallments = [];
    try {
      const r = await db.query(
        `SELECT id, installment_number, total_installments,
                amount_due, covered_amount, due_date, status, account_id
           FROM credit_installments
          WHERE customer_id = $1 AND company_id = $2
          ORDER BY due_date ASC`,
        [customerId, companyId]
      );
      allInstallments = r.rows;
    } catch (instErr) {
      if (instErr.code === '42703') {
        // account_id ainda não existe — fallback sem a coluna
        try {
          const r = await db.query(
            `SELECT id, installment_number, total_installments,
                    amount_due, covered_amount, due_date, status
               FROM credit_installments
              WHERE customer_id = $1 AND company_id = $2
              ORDER BY due_date ASC`,
            [customerId, companyId]
          );
          allInstallments = r.rows.map(i => ({ ...i, account_id: null }));
        } catch (_) {}
      } else if (instErr.code !== '42P01') {
        console.warn('[print/carne] installments warn:', instErr.message);
      }
    }

    // 5. Carnês cadastrados
    let accounts = [];
    try {
      const { rows: accRows } = await db.query(
        `SELECT id, name, status FROM credit_accounts
          WHERE company_id = $1 AND customer_id = $2
          ORDER BY created_at ASC`,
        [companyId, customerId]
      );
      accounts = accRows;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.warn('[print/carne] accounts warn:', e.message);
    }

    // 6. Chave Pix da loja (digital_channel_config). Captura pixSetup p/ reuso
    //    no bloco global E nos blocos por parcela (3T3).
    let pixSetup = null;   // { pixKey, name, city }
    let pixPayload = null; // bloco global (saldo total)
    try {
      const { rows: cfgRows } = await db.query(
        `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city, site_name, address
           FROM digital_channel_config WHERE company_id = $1`,
        [companyId]
      );
      const cfg = cfgRows[0];
      if (cfg && cfg.pix_key && String(cfg.pix_key).trim()) {
        const validation = validatePixKey(cfg.pix_key, cfg.pix_key_type);
        if (validation.valid) {
          let city = cfg.pix_holder_city;
          if (!city && cfg.address) {
            const parts = String(cfg.address).split(',').map(s => s.trim());
            city = parts[parts.length - 2] || parts[parts.length - 1] || '';
          }
          pixSetup = {
            pixKey: validation.normalized,
            name:   cfg.pix_holder_name || cfg.site_name || company.display_name || 'AURA NEGOCIO',
            city:   city || company.address_city || 'BRASIL',
          };
          // Se saldo > 0 inclui o valor; senão gera sem valor fixo (comprador digita)
          pixPayload = buildStaticBrCode({
            pixKey:          pixSetup.pixKey,
            amount:          totalBalance > 0 ? totalBalance : undefined,
            beneficiaryName: pixSetup.name,
            beneficiaryCity: pixSetup.city,
            txid:            `CRED${customerId.replace(/-/g, '').slice(0, 20)}`,
          });
        }
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.warn('[print/carne] pix warn:', e.message);
    }

    // 7. Montar grupos de parcelas por carnê
    // Agrupa: account_id null → "Sem carnê"
    const accountMap = {};
    for (const acc of accounts) accountMap[acc.id] = acc;

    const groups = {}; // key: account_id ou '__none__'
    for (const inst of allInstallments) {
      const key = inst.account_id || '__none__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(inst);
    }

    // Ordem: carnês cadastrados primeiro, depois "Sem carnê"
    const orderedKeys = [
      ...accounts.map(a => a.id),
      ...(groups['__none__'] ? ['__none__'] : []),
    ].filter(k => groups[k]);

    function statusLabel(s) {
      if (s === 'paid') return '<span style="color:#166534">Paga</span>';
      if (s === 'overdue') return '<span style="color:#991b1b;font-weight:bold">Atrasada</span>';
      return '<span style="color:#1e40af">Pendente</span>';
    }

    function fmtDate(d) {
      if (!d) return '—';
      const dt = new Date(d);
      return dt.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    }

    // 3T3: coleta os QRs (global + por parcela) p/ renderizar 1x no fim do body.
    const pixQrJobs = [];

    let accountsHTML = '';
    if (orderedKeys.length === 0) {
      accountsHTML = '<p style="color:#666;font-size:12px">Nenhuma parcela registrada.</p>';
    } else {
      for (const key of orderedKeys) {
        const instList = groups[key] || [];
        const acc = key === '__none__' ? null : accountMap[key];
        const accName = acc ? acc.name : 'Sem carne';
        const accStatus = acc ? acc.status : null;
        const accBalance = instList
          .filter(i => i.status !== 'paid')
          .reduce((s, i) => s + Math.max(0, parseFloat(i.amount_due) - parseFloat(i.covered_amount || 0)), 0);

        const rowsHTML = instList.map(inst => {
          const remaining = Math.max(0, parseFloat(inst.amount_due) - parseFloat(inst.covered_amount || 0));

          // 3T3: Pix por parcela (so em aberto, com valor de PRINCIPAL restante).
          let pixRow = '';
          if (pixSetup && inst.status !== 'paid' && remaining > 0.005) {
            const instPix = buildStaticBrCode({
              pixKey:          pixSetup.pixKey,
              amount:          remaining,
              beneficiaryName: pixSetup.name,
              beneficiaryCity: pixSetup.city,
              txid:            `CRED${String(inst.id).replace(/-/g, '').slice(0, 20)}`,
            });
            const qrId = 'qr-' + String(inst.id).replace(/-/g, '');
            pixQrJobs.push({ id: qrId, payload: instPix });
            pixRow = `<tr><td colspan="5" style="padding:2px 4px 10px">
              <div style="border:1px solid #ccc;background:#fafafa;padding:6px;page-break-inside:avoid">
                <div style="font-size:10px;font-weight:bold;margin-bottom:3px">
                  Pix da parcela ${inst.installment_number}/${inst.total_installments} — R$${fmt(remaining)}
                </div>
                <div style="font-family:'Courier New',monospace;font-size:8px;word-break:break-all;
                            background:#fff;border:1px solid #ddd;padding:4px;margin-bottom:5px;
                            user-select:all">${instPix}</div>
                <div id="${qrId}" style="text-align:center"></div>
              </div>
            </td></tr>`;
          }

          return `<tr>
            <td style="padding:3px 4px">${inst.installment_number}/${inst.total_installments}</td>
            <td style="padding:3px 4px">${fmtDate(inst.due_date)}</td>
            <td style="padding:3px 4px;text-align:right">R$${fmt(inst.amount_due)}</td>
            <td style="padding:3px 4px;text-align:right">${inst.status !== 'paid' ? 'R$' + fmt(remaining) : '—'}</td>
            <td style="padding:3px 4px;text-align:center">${statusLabel(inst.status)}</td>
          </tr>${pixRow}`;
        }).join('');

        accountsHTML += `
          <div style="margin-bottom:16px">
            <div style="font-weight:bold;font-size:13px;margin-bottom:4px">
              ${esc(accName)}${accStatus === 'closed' ? ' <span style="font-size:10px;color:#666">(encerrado)</span>' : ''}
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:11px">
              <thead>
                <tr style="border-bottom:1px solid #333">
                  <th style="text-align:left;padding:3px 4px">Parcela</th>
                  <th style="text-align:left;padding:3px 4px">Vencimento</th>
                  <th style="text-align:right;padding:3px 4px">Valor</th>
                  <th style="text-align:right;padding:3px 4px">Restante</th>
                  <th style="text-align:center;padding:3px 4px">Status</th>
                </tr>
              </thead>
              <tbody>${rowsHTML}</tbody>
            </table>
            <div style="text-align:right;font-size:11px;margin-top:4px;color:#444">
              Saldo em aberto: <strong>R$${fmt(accBalance)}</strong>
            </div>
          </div>`;
      }
    }

    // 8. Bloco Pix global (pagar tudo de uma vez)
    let pixHTML = '';
    if (pixPayload) {
      pixQrJobs.push({ id: 'carne-qr', payload: pixPayload });
      const balLabel = totalBalance > 0 ? ` — R$ ${fmt(totalBalance)}` : '';
      pixHTML = `
        <div style="border:1px solid #000;padding:10px;margin-top:12px;page-break-inside:avoid">
          <div style="font-weight:bold;font-size:13px;margin-bottom:6px">Pagar tudo de uma vez via Pix${balLabel}</div>
          <div style="font-size:10px;margin-bottom:6px;color:#444">
            Copie o codigo abaixo ou escaneie o QR Code com o app do seu banco.
          </div>
          <div style="font-family:'Courier New',monospace;font-size:9px;word-break:break-all;
                      background:#f5f5f5;padding:6px;border:1px solid #ccc;margin-bottom:8px;
                      user-select:all">${pixPayload}</div>
          <div style="text-align:center">
            <div id="carne-qr"></div>
          </div>
          <div style="font-size:9px;color:#666;margin-top:6px;text-align:center">
            Pagamento confirmado manualmente pela loja.
          </div>
        </div>`;
    } else {
      pixHTML = `
        <div style="border:1px dashed #999;padding:8px;margin-top:12px;font-size:10px;color:#666;text-align:center">
          Pagamento confirmado manualmente pela loja. Nenhuma chave Pix configurada.
        </div>`;
    }

    // 3T3: script unico que renderiza todos os QRs (global + por parcela).
    const qrScript = pixQrJobs.length
      ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
         <script>
           (function() {
             var jobs = ${JSON.stringify(pixQrJobs)};
             if (typeof QRCode === 'undefined') return;
             jobs.forEach(function(j) {
               var el = document.getElementById(j.id);
               if (el) new QRCode(el, { text: j.payload, width: 116, height: 116, correctLevel: QRCode.CorrectLevel.M });
             });
           })();
         </script>`
      : '';

    // 9. Montar HTML final
    const printDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Carne - ${esc(company.display_name)}</title>
  <style>
    @page { margin: 10mm 12mm; size: A4; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Courier New',monospace; font-size:12px; color:#000; max-width:700px; margin:0 auto; }
    .center { text-align:center; }
    .bold { font-weight:bold; }
    .divider { border-top:1px dashed #000; margin:8px 0; }
    .company-name { font-size:18px; font-weight:bold; }
    .section-title { font-size:14px; font-weight:bold; border-bottom:2px solid #000; padding-bottom:3px; margin-bottom:8px; }
    @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } button { display:none !important; } }
  </style>
</head>
<body>
  <div class="center" style="margin-bottom:8px">
    <div class="company-name">${esc(company.display_name)}</div>
    ${company.cnpj ? '<div>CNPJ: ' + company.cnpj + '</div>' : ''}
    ${company.phone ? '<div>Tel: ' + esc(company.phone) + '</div>' : ''}
    ${company.address_city ? '<div>' + esc(company.address_city) + (company.address_state ? ' - ' + esc(company.address_state) : '') + '</div>' : ''}
  </div>
  <div class="divider"></div>
  <div class="center bold" style="font-size:15px;margin-bottom:4px">CARNE / EXTRATO DE CREDIARIO</div>
  <div style="font-size:10px;text-align:center;margin-bottom:8px">Emitido em: ${printDate}</div>
  <div class="divider"></div>
  <div style="margin-bottom:8px">
    <div><strong>Cliente:</strong> ${esc(customer.name)}</div>
    ${customer.phone ? '<div><strong>Telefone:</strong> ' + esc(customer.phone) + '</div>' : ''}
    ${customer.cpf_cnpj ? '<div><strong>CPF/CNPJ:</strong> ' + esc(customer.cpf_cnpj) + '</div>' : ''}
  </div>
  <div class="divider"></div>
  <div class="section-title">Cronograma de Parcelas</div>
  <div style="font-size:10px;color:#444;margin-bottom:10px">
    Os valores exibidos sao de <strong>principal</strong>. Parcelas em atraso estao sujeitas a
    multa e mora, calculadas no momento do pagamento.
  </div>
  ${accountsHTML}
  <div class="divider"></div>
  <div style="text-align:right;font-size:13px;font-weight:bold;margin-bottom:8px">
    SALDO TOTAL EM ABERTO: R$${fmt(totalBalance)}
  </div>
  ${pixHTML}
  <div class="divider"></div>
  <div style="font-size:9px;text-align:center;margin-top:6px;color:#666">
    ${esc(company.display_name)} &mdash; Powered by Aura. &mdash; getaura.com.br
  </div>
  <br>
  <button onclick="window.print()" style="width:100%;padding:10px;cursor:pointer;font-size:14px">Imprimir</button>
  ${qrScript}
  <script>window.onload = function() { setTimeout(function(){ window.print(); }, 350); };</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[print] carne error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar carne de crediario' });
  }
});

// ============================================================
// GET /print/credit/receipts/:transactionId  (B5)
// Recibo de pagamento de crediário — HTML imprimível.
//
// Fonte: customer_credit_transactions WHERE id=:transactionId
//        AND company_id=:id AND type='payment'.
// Encargos: transactions WHERE idempotency_key='credit-charges-<txId>'
//           (defensivo a 42703/42P01 — campo opcional).
// Saldo: customer_credit_balances.balance (defensivo).
// Crédito a favor: balance < 0 → exibe valor absoluto.
//
// Frontend chama via fetch + Authorization header + document.write
// (mesmo padrão /print/credit/:cid/carne).
// ============================================================
router.get('/credit/receipts/:transactionId', requireAuth, async (req, res) => {
  const companyId     = req.params.id;
  const transactionId = req.params.transactionId;

  try {
    // 1. Dados da empresa
    const { rows: companyRows } = await db.query(
      `SELECT COALESCE(trade_name, legal_name) AS display_name,
              cnpj, phone, address_city, address_state
         FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!companyRows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companyRows[0];

    // 2. Transação de pagamento
    const { rows: txRows } = await db.query(
      `SELECT id, customer_id, amount, payment_method, created_at, account_id
         FROM customer_credit_transactions
        WHERE id = $1 AND company_id = $2 AND type = 'payment'`,
      [transactionId, companyId]
    );
    if (!txRows.length) return res.status(404).json({ error: 'Transacao nao encontrada' });
    const tx = txRows[0];

    // 3. Cliente
    const { rows: custRows } = await db.query(
      `SELECT name, phone, cpf_cnpj FROM customers WHERE id = $1 AND company_id = $2`,
      [tx.customer_id, companyId]
    );
    const customer = custRows[0] || { name: 'Cliente', phone: null, cpf_cnpj: null };

    // 4. Encargos vinculados (mora/multa) — opcional, defensivo
    let chargesAmount = 0;
    try {
      const { rows: chRows } = await db.query(
        `SELECT amount FROM transactions
          WHERE idempotency_key = $1
            AND company_id = $2
            AND category LIKE 'Crediario - Encargos%'
          LIMIT 1`,
        ['credit-charges-' + transactionId, companyId]
      );
      if (chRows.length) chargesAmount = Math.abs(parseFloat(chRows[0].amount || 0));
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.warn('[print/recibo] charges warn:', e.message);
    }

    // 5. Saldo restante após pagamento — defensivo
    let balance = null;
    try {
      const { rows: balRows } = await db.query(
        `SELECT COALESCE(balance, 0) AS balance
           FROM customer_credit_balances
          WHERE customer_id = $1 AND company_id = $2`,
        [tx.customer_id, companyId]
      );
      if (balRows.length) balance = parseFloat(balRows[0].balance);
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.warn('[print/recibo] balance warn:', e.message);
    }

    // 6. Montar HTML
    const payDate = new Date(tx.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const amountPaid = parseFloat(tx.amount || 0);

    const payMethodLabel = _payLabel(tx.payment_method || 'outro');

    const chargesRow = chargesAmount > 0
      ? '<tr><td style="padding:3px 0;color:#666">Encargos (mora/multa)</td>' +
        '<td style="text-align:right;padding:3px 0;color:#666">R$' + fmt(chargesAmount) + '</td></tr>'
      : '';

    let balanceRow = '';
    if (balance !== null) {
      if (balance < 0) {
        balanceRow =
          '<tr><td style="padding:3px 0;color:#166534;font-weight:bold">Credito a favor</td>' +
          '<td style="text-align:right;padding:3px 0;color:#166534;font-weight:bold">R$' + fmt(Math.abs(balance)) + '</td></tr>';
      } else {
        balanceRow =
          '<tr><td style="padding:3px 0">Saldo restante</td>' +
          '<td style="text-align:right;padding:3px 0">R$' + fmt(balance) + '</td></tr>';
      }
    }

    // Bloco WhatsApp (texto pré-formatado — trivial pois é só concatenar)
    const waLines = [
      '*Recibo de Pagamento — Crediario*',
      company.display_name,
      '',
      'Cliente: ' + customer.name,
      'Data: ' + payDate,
      'Valor pago: R$' + fmt(amountPaid),
      'Metodo: ' + payMethodLabel,
    ];
    if (chargesAmount > 0) waLines.push('Encargos: R$' + fmt(chargesAmount));
    if (balance !== null) {
      if (balance < 0) {
        waLines.push('Credito a favor: R$' + fmt(Math.abs(balance)));
      } else {
        waLines.push('Saldo restante: R$' + fmt(balance));
      }
    }
    waLines.push('', 'Powered by Aura. - getaura.com.br');
    const waText = waLines.join('\n');

    const html = '<!DOCTYPE html>\n' +
      '<html lang="pt-BR">\n' +
      '<head>\n' +
      '  <meta charset="UTF-8">\n' +
      '  <title>Recibo Crediario - ' + esc(company.display_name) + '</title>\n' +
      '  <style>\n' +
      '    @page { margin: 10mm 12mm; size: A4; }\n' +
      '    * { margin:0; padding:0; box-sizing:border-box; }\n' +
      '    body { font-family:\'Courier New\',monospace; font-size:12px; color:#000; max-width:500px; margin:0 auto; }\n' +
      '    .center { text-align:center; }\n' +
      '    .bold { font-weight:bold; }\n' +
      '    .divider { border-top:1px dashed #000; margin:8px 0; }\n' +
      '    .company-name { font-size:16px; font-weight:bold; }\n' +
      '    table { width:100%; border-collapse:collapse; }\n' +
      '    td { vertical-align:top; font-size:12px; }\n' +
      '    .total-row td { font-weight:bold; font-size:14px; border-top:2px solid #000; padding-top:5px; }\n' +
      '    .footer { font-size:9px; text-align:center; margin-top:8px; color:#666; }\n' +
      '    .wa-block { background:#f0fdf4; border:1px solid #86efac; border-radius:4px; padding:10px; margin-top:12px; }\n' +
      '    .wa-block textarea { width:100%; font-family:monospace; font-size:11px; border:none; background:transparent; resize:none; outline:none; }\n' +
      '    @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } button, .wa-block { display:none !important; } }\n' +
      '  </style>\n' +
      '</head>\n' +
      '<body>\n' +
      '  <div class="center" style="margin-bottom:8px">\n' +
      '    <div class="company-name">' + esc(company.display_name) + '</div>\n' +
      (company.cnpj ? '    <div>CNPJ: ' + company.cnpj + '</div>\n' : '') +
      (company.phone ? '    <div>Tel: ' + esc(company.phone) + '</div>\n' : '') +
      (company.address_city ? '    <div>' + esc(company.address_city) + (company.address_state ? ' - ' + esc(company.address_state) : '') + '</div>\n' : '') +
      '  </div>\n' +
      '  <div class="divider"></div>\n' +
      '  <div class="center bold" style="font-size:14px;margin-bottom:4px">RECIBO DE PAGAMENTO — CREDIARIO</div>\n' +
      '  <div class="divider"></div>\n' +
      '  <div style="margin-bottom:8px">\n' +
      '    <div><strong>Cliente:</strong> ' + esc(customer.name) + '</div>\n' +
      (customer.phone ? '    <div><strong>Telefone:</strong> ' + esc(customer.phone) + '</div>\n' : '') +
      (customer.cpf_cnpj ? '    <div><strong>CPF/CNPJ:</strong> ' + esc(customer.cpf_cnpj) + '</div>\n' : '') +
      '  </div>\n' +
      '  <div class="divider"></div>\n' +
      '  <table>\n' +
      '    <tr><td style="padding:3px 0">Data</td><td style="text-align:right;padding:3px 0">' + payDate + '</td></tr>\n' +
      '    <tr><td style="padding:3px 0">Metodo</td><td style="text-align:right;padding:3px 0">' + payMethodLabel + '</td></tr>\n' +
      chargesRow +
      '    <tr class="total-row"><td>Valor pago</td><td style="text-align:right">R$' + fmt(amountPaid) + '</td></tr>\n' +
      balanceRow +
      '  </table>\n' +
      '  <div class="divider"></div>\n' +
      '  <div class="footer">Powered by Aura. - getaura.com.br</div>\n' +
      '  <br>\n' +
      '  <button onclick="window.print()" style="width:100%;padding:10px;cursor:pointer;font-size:14px">Imprimir</button>\n' +
      '  <div class="wa-block" style="margin-top:12px">\n' +
      '    <div style="font-size:11px;font-weight:bold;margin-bottom:6px;color:#166534">Texto para WhatsApp</div>\n' +
      '    <textarea rows="' + waLines.length + '" readonly onclick="this.select()">' + waText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</textarea>\n' +
      '  </div>\n' +
      '  <script>window.onload = function() { window.print(); };</script>\n' +
      '</body>\n' +
      '</html>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[print] recibo crediario error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar recibo de crediario' });
  }
});

module.exports = router;
