// ============================================================
// AURA. — Food Service
// NFC-e (Nota Fiscal de Consumidor Eletrônica) por pedido
// Comanda física para cozinha/bar (impressora térmica 80mm)
// ============================================================
// ATENÇÃO: A emissão real de NFC-e exige:
//   - Certificado digital e-CNPJ A1 da empresa
//   - Credenciais no portal SEFAZ do estado
//   - Homologação com a SEFAZ antes do go-live
//   - Parceiro emissor: NFE.io, Focus NFe ou similar
// Este módulo gera o payload pronto para envio ao parceiro emissor
// e o HTML de impressão térmica (80mm) independente da NFC-e real.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
const guard = [requirePlan('negocio', 'expansao')];
const notFound = (res, e='Pedido') => res.status(404).json({ error: `${e} não encontrado` });

// ── helpers ──────────────────────────────────────────────────
function fmt(v) { return parseFloat(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2}); }
function fmtDate(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo',
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit' });
}

// ── NFC-e payload para parceiro emissor (NFE.io / Focus NFe) ─
function buildNfcePayload(order, items, company) {
  return {
    naturezaOperacao:     'VENDA AO CONSUMIDOR',
    dataEmissao:          new Date().toISOString(),
    dataEntradaSaida:     new Date().toISOString(),
    tipoDocumento:        'saida',
    finalidade:           'normal',
    consumidorFinal:      true,
    presencaComprador:    order.channel === 'presencial' ? 'operacao_presencial' : 'internet',
    emitente: {
      cnpj:              company.tax_id   || '',
      razaoSocial:       company.legal_name || company.name,
      nomeFantasia:      company.name,
      endereco: {
        logradouro:      company.address_street   || '',
        numero:          company.address_number    || 'S/N',
        bairro:          company.address_district  || '',
        municipio:       company.address_city      || '',
        uf:              company.address_state     || 'SP',
        cep:             (company.address_zip||'').replace(/\D/g,''),
        codigoPais:      '1058',
        nomePais:        'Brasil',
      },
    },
    destinatario: order.customer_phone || order.customer_name ? {
      nome:    order.customer_name || 'Consumidor',
      cpfCnpj: '',
    } : undefined,
    itens: items.map((item, idx) => ({
      numero:            idx + 1,
      codigo:            item.item_id || `ITEM${idx+1}`,
      descricao:         item.item_name + (item.variation_name ? ` (${item.variation_name})` : ''),
      ncm:               '21069090',
      cfop:              '5102',
      unidadeComercial:  'UN',
      quantidade:        item.quantity,
      valorUnitario:     parseFloat(item.unit_price),
      valorTotal:        parseFloat(item.total_price),
      impostos: {
        simplesNacional: { csosn: '400' }
      },
    })),
    pagamentos: [{
      formaPagamento: _mapPayment(order.payment_method),
      valor:          parseFloat(order.total),
    }],
    informacoesAdicionais: `Pedido #${order.id.slice(-6).toUpperCase()} | ${order.channel} | ${fmtDate(order.created_at)}`,
    totais: {
      baseCalculoIcms:    0,
      valorIcms:          0,
      valorTotalProdutos: parseFloat(order.subtotal),
      valorDesconto:      parseFloat(order.discount||0),
      valorFrete:         parseFloat(order.delivery_fee||0),
      valorTotalNota:     parseFloat(order.total),
    },
  };
}

function _mapPayment(method) {
  const map = {
    pix:        '17',
    cartao:     '03',
    debito:     '04',
    dinheiro:   '01',
    credito:    '03',
    fiado:      '99',
  };
  return map[(method||'').toLowerCase()] || '99';
}

// ── HTML para impressora térmica 80mm ────────────────────────
function buildThermalHtml(order, items, company, type) {
  const isComanda = type === 'comanda';
  const isCupom   = type === 'cupom';

  const itemsHtml = items.map(item => {
    const addonList = (() => {
      try {
        const a = typeof item.addons === 'string' ? JSON.parse(item.addons) : (item.addons || []);
        return a.length ? a.map(x => `<div style="font-size:10px;padding-left:10px">+ ${x.name}</div>`).join('') : '';
      } catch { return ''; }
    })();
    return `
      <div style="margin:4px 0;padding-bottom:4px;border-bottom:1px dashed #ccc">
        <div style="display:flex;justify-content:space-between">
          <span><b>${item.quantity}x</b> ${item.item_name}${item.variation_name ? ` <small>(${item.variation_name})</small>` : ''}</span>
          ${isCupom ? `<span>R$ ${fmt(item.total_price)}</span>` : ''}
        </div>
        ${addonList}
        ${item.notes ? `<div style="font-size:10px;color:#555">Obs: ${item.notes}</div>` : ''}
      </div>`;
  }).join('');

  if (isComanda) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { margin:0;padding:0;box-sizing:border-box }
  body { font-family:monospace;font-size:13px;width:72mm;padding:4mm;color:#000 }
  h2 { font-size:16px;text-align:center;margin-bottom:4px }
  .info { font-size:11px;text-align:center;border-bottom:2px solid #000;padding-bottom:4px;margin-bottom:6px }
  @media print { body { margin:0 } button { display:none } }
</style>
</head><body>
<h2>⚡ COMANDA</h2>
<div class="info">
  Mesa: <b>${order.table_number || '—'}</b> &nbsp;|
  Pedido: <b>#${order.id.slice(-6).toUpperCase()}</b><br>
  ${fmtDate(order.created_at)}
  ${order.customer_name ? `<br>Cliente: ${order.customer_name}` : ''}
  ${order.notes ? `<br>⚠ OBS GERAL: <b>${order.notes}</b>` : ''}
</div>
${itemsHtml}
<div style="text-align:center;margin-top:8px;font-size:11px">— COZINHA —</div>
<br><button onclick="window.print()">🖨 Imprimir</button>
</body></html>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { margin:0;padding:0;box-sizing:border-box }
  body { font-family:monospace;font-size:12px;width:72mm;padding:4mm;color:#000 }
  h1 { font-size:13px;text-align:center }
  .center { text-align:center }
  .sep  { border-top:1px dashed #000;margin:4px 0 }
  .row  { display:flex;justify-content:space-between }
  @media print { body { margin:0 } button { display:none } }
</style>
</head><body>
<h1>${company.name || 'Estabelecimento'}</h1>
<div class="center" style="font-size:10px">
  ${company.tax_id ? `CNPJ: ${company.tax_id}` : 'CNPJ: aguardando aprovação'}<br>
  ${[company.address_street, company.address_number, company.address_city].filter(Boolean).join(', ')}
</div>
<div class="sep"></div>
<div class="center" style="font-size:11px">CUPOM NÃO FISCAL</div>
<div class="center" style="font-size:10px;margin-bottom:4px">${fmtDate(order.created_at)}</div>
<div class="sep"></div>
${itemsHtml}
<div class="sep"></div>
<div class="row"><span>Subtotal</span><span>R$ ${fmt(order.subtotal)}</span></div>
${parseFloat(order.discount||0)>0 ? `<div class="row"><span>Desconto</span><span>-R$ ${fmt(order.discount)}</span></div>` : ''}
${parseFloat(order.delivery_fee||0)>0 ? `<div class="row"><span>Entrega</span><span>R$ ${fmt(order.delivery_fee)}</span></div>` : ''}
<div class="sep"></div>
<div class="row" style="font-size:14px"><b>TOTAL</b><b>R$ ${fmt(order.total)}</b></div>
<div style="font-size:11px;margin-top:2px">Pgto: ${order.payment_method || 'não informado'}</div>
<div class="sep"></div>
<div class="center" style="font-size:10px">
  Pedido #${order.id.slice(-6).toUpperCase()}<br>
  ${order.channel === 'delivery_proprio' ? '🛵 Delivery' : order.channel === 'presencial' ? '🍽 Consumo local' : order.channel}<br>
  ${order.customer_name ? `Cliente: ${order.customer_name}` : ''}
</div>
<div class="sep"></div>
<div class="center" style="font-size:10px">Obrigado pela preferência!<br>getaura.com.br</div>
<br><button onclick="window.print()">🖨 Imprimir</button>
</body></html>`;
}

// ── Busca pedido + itens + empresa ───────────────────────────
async function _fetchOrderData(orderId, companyId) {
  const { rows: orders } = await db.query(
    `SELECT fo.*, ft.number AS table_number
     FROM food_orders fo
     LEFT JOIN food_tables ft ON ft.id=fo.table_id
     WHERE fo.id=$1 AND fo.company_id=$2`,
    [orderId, companyId]
  );
  if (!orders.length) return null;

  const { rows: items } = await db.query(
    `SELECT * FROM food_order_items WHERE order_id=$1 ORDER BY id`, [orderId]
  );
  const { rows: companies } = await db.query(
    `SELECT * FROM companies WHERE id=$1`, [companyId]
  );
  return { order: orders[0], items, company: companies[0] || {} };
}

// ============================================================
// ROTAS
// ============================================================

router.get('/:oid/payload', guard, async (req, res) => {
  try {
    const data = await _fetchOrderData(req.params.oid, req.params.id);
    if (!data) return notFound(res);
    const payload = buildNfcePayload(data.order, data.items, data.company);
    res.json(payload);
  } catch (e) {
    console.error('[food/nfce/payload] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao gerar payload NFC-e' });
  }
});

router.get('/:oid/cupom', guard, async (req, res) => {
  try {
    const data = await _fetchOrderData(req.params.oid, req.params.id);
    if (!data) return notFound(res);
    await db.query(
      `UPDATE food_orders SET comanda_print_count=comanda_print_count+1 WHERE id=$1`,
      [req.params.oid]
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildThermalHtml(data.order, data.items, data.company, 'cupom'));
  } catch (e) {
    console.error('[food/nfce/cupom] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao gerar cupom' });
  }
});

router.get('/:oid/comanda', guard, async (req, res) => {
  try {
    const data = await _fetchOrderData(req.params.oid, req.params.id);
    if (!data) return notFound(res);
    await db.query(
      `UPDATE food_orders SET comanda_print_count=comanda_print_count+1 WHERE id=$1`,
      [req.params.oid]
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildThermalHtml(data.order, data.items, data.company, 'comanda'));
  } catch (e) {
    console.error('[food/nfce/comanda] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao gerar comanda' });
  }
});

router.post('/:oid/emit', guard, async (req, res) => {
  try {
    const data = await _fetchOrderData(req.params.oid, req.params.id);
    if (!data) return notFound(res);
    const payload = buildNfcePayload(data.order, data.items, data.company);

    if (!data.company.tax_id) {
      return res.status(400).json({
        error: 'CNPJ não cadastrado — a emissão real exige CNPJ aprovado e certificado digital.',
        payload,
      });
    }

    // TODO pós-CNPJ + homologação SEFAZ:
    // const response = await nfeioClient.emit('nfce', payload);
    // return res.json({ nfce_id: response.id, status: response.status, url: response.pdf_url });

    res.status(202).json({
      status:   'stub',
      message:  'Emissão real disponível após CNPJ aprovado e homologação SEFAZ.',
      payload,
    });
  } catch (e) {
    console.error('[food/nfce/emit] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao emitir NFC-e' });
  }
});

module.exports = router;
