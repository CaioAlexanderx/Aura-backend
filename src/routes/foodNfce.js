// ============================================================
// AURA. — Food Service
// NFC-e (Nota Fiscal de Consumidor Eletrônica) por pedido
// Comanda física para cozinha/bar (impressora térmica 80mm)
// ============================================================
// ATENÇÃO: A emissão real de NFC-e usa o fluxo canônico em
// /companies/:id/nfce/emit (services/nuvemfiscal.js). Este módulo
// agora foca em:
//   - GET /:oid/cupom    — cupom térmico 80mm c/ QR Code da NFC-e
//                          (busca chave em nfce_emissions.metadata.food_order_id)
//                          + linha separada de taxa de serviço (gorjeta)
//   - GET /:oid/comanda  — comanda 80mm pra cozinha, SEM preços
//   - GET /:oid/payload  — payload legado (mantido pra compat)
//   - POST /:oid/emit    — emissão stub legacy (mantida pra compat;
//                          uso real é via POST food/orders/:oid/close-and-emit)
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const QRCode = require('qrcode');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
const guard = [requirePlan('negocio', 'expansao')];
const notFound = (res, e='Pedido') => res.status(404).json({ error: `${e} não encontrado` });

// Cache module-level — armadilha_schema_pre_migration: se nfce_emissions.metadata
// ainda não foi migrado (122d), evita try/catch toda request.
let HAS_NFCE_METADATA_COL = true;

// ── helpers ──────────────────────────────────────────────────
function fmt(v) { return parseFloat(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2}); }
function fmtDate(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo',
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit' });
}
// Nome de exibição da empresa — companies não tem coluna 'name' (memory companies_sem_coluna_name).
function companyDisplayName(company) {
  return company.trade_name || company.legal_name || 'Estabelecimento';
}

// URLs públicas de consulta NFC-e por UF — espelha tabela do nfce.js
const CONSULTA_NFCE_URL = {
  SP: 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica',
  RJ: 'https://www4.fazenda.rj.gov.br/consultaNFCe/',
  MG: 'https://nfce.fazenda.mg.gov.br/portalnfce',
  RS: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
  PR: 'http://www.fazenda.pr.gov.br/nfce',
  SC: 'https://sat.sef.sc.gov.br/nfce/consulta',
};
function consultaUrlByUf(uf, chave) {
  const base = CONSULTA_NFCE_URL[(uf || '').toUpperCase()];
  if (!base) return null;  // outros estados: TODO (sem QR no cupom)
  return chave ? `${base}?chNFe=${chave}` : base;
}

// Gera <img> com QR Code embutido (data URL). Retorna '' se chave/url ausente.
async function buildQrCodeImg(consultaUrl) {
  if (!consultaUrl) return '';
  try {
    const dataUrl = await QRCode.toDataURL(consultaUrl, {
      width: 180,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return `<img src="${dataUrl}" style="width:38mm;height:38mm;display:block;margin:4px auto" alt="QR NFC-e" />`;
  } catch (e) {
    console.warn('[food/cupom] QRCode.toDataURL falhou:', e.message);
    return '';
  }
}

// ── NFC-e payload para parceiro emissor (legado — mantido pra compat) ──
function buildNfcePayload(order, items, company) {
  const displayName = companyDisplayName(company);
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
      razaoSocial:       company.legal_name || displayName,
      nomeFantasia:      displayName,
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
// Comanda 80mm (cozinha): SEM preços, layout monospace 80mm, @page size:80mm.
function buildComandaHtml({ order, items, company }) {
  const displayName = companyDisplayName(company);

  const itemsHtml = items.map(item => {
    const addonList = (() => {
      try {
        const a = typeof item.addons === 'string' ? JSON.parse(item.addons) : (item.addons || []);
        return a.length ? a.map(x => `<div style="font-size:11pt;padding-left:8px">+ ${x.name || x}</div>`).join('') : '';
      } catch { return ''; }
    })();
    return `
      <div style="margin:6px 0;padding-bottom:4px;border-bottom:1px dashed #000">
        <div style="font-size:13pt;font-weight:bold">${item.quantity}x ${item.item_name}${item.variation_name ? ` (${item.variation_name})` : ''}</div>
        ${addonList}
        ${item.notes ? `<div style="font-size:11pt;font-style:italic">Obs: ${item.notes}</div>` : ''}
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Comanda Cozinha</title>
<style>
  * { margin:0;padding:0;box-sizing:border-box }
  body { font-family:'Courier New',monospace;font-size:12pt;width:80mm;max-width:80mm;padding:0;color:#000 }
  .wrap { padding:2mm }
  h2 { font-size:14pt;text-align:center;margin-bottom:4px;font-weight:bold }
  .info { font-size:11pt;text-align:center;border-bottom:2px solid #000;padding-bottom:4px;margin-bottom:6px }
  .footer { text-align:center;margin-top:8px;font-size:10pt;border-top:1px dashed #000;padding-top:4px }
  @media print {
    html, body { margin:0; padding:0 }
    button { display:none }
  }
  @page { size: 80mm auto; margin: 2mm; }
</style>
</head><body>
<div class="wrap">
  <h2>COMANDA — ${displayName}</h2>
  <div class="info">
    Mesa: <b>${order.table_number || '—'}</b><br>
    Pedido: <b>#${order.id.slice(-6).toUpperCase()}</b><br>
    ${fmtDate(order.created_at)}
    ${order.customer_name ? `<br>Cliente: ${order.customer_name}` : ''}
    ${order.notes ? `<br><b>OBS GERAL:</b> ${order.notes}` : ''}
  </div>
  ${itemsHtml}
  <div class="footer">— ENVIAR PARA COZINHA —</div>
</div>
<br><button onclick="window.print()" style="margin:8px">Imprimir</button>
<script>setTimeout(()=>{try{window.print()}catch(e){}}, 200)</script>
</body></html>`;
}

// Cupom 80mm (cliente): preços + total + QR Code NFC-e + linha de gorjeta separada.
function buildCupomHtml({ order, items, company, nfceEmission, serviceFeeAmount, qrImg }) {
  const displayName = companyDisplayName(company);

  const itemsHtml = items.map(item => `
    <div style="margin:4px 0;padding-bottom:4px;border-bottom:1px dashed #ccc">
      <div style="display:flex;justify-content:space-between;gap:4px">
        <span><b>${item.quantity}x</b> ${item.item_name}${item.variation_name ? ` <small>(${item.variation_name})</small>` : ''}</span>
        <span>R$ ${fmt(item.total_price)}</span>
      </div>
      ${item.notes ? `<div style="font-size:10pt;color:#555">Obs: ${item.notes}</div>` : ''}
    </div>`
  ).join('');

  const subtotal = parseFloat(order.subtotal || 0);
  const feeAmt   = Number(serviceFeeAmount || 0);
  const grandTotal = subtotal + feeAmt
    + parseFloat(order.delivery_fee || 0) - parseFloat(order.discount || 0);

  // NFC-e block: chave + protocolo + QR code (se autorizada)
  const nfceBlock = nfceEmission && nfceEmission.status === 'autorizada' ? `
    <div class="sep"></div>
    <div class="center" style="font-size:10pt">
      <b>NFC-e nº ${nfceEmission.numero || '—'}</b><br>
      Chave: <span style="font-size:8pt">${(nfceEmission.chave_acesso || '').replace(/(\d{4})/g, '$1 ').trim()}</span><br>
      Protocolo: ${nfceEmission.protocolo || '—'}
    </div>
    ${qrImg ? `<div class="center">${qrImg}<div style="font-size:9pt">Consulta pela chave de acesso</div></div>` : '<div class="center" style="font-size:9pt;color:#666">QR Code disponível na consulta SEFAZ por estado</div>'}
  ` : nfceEmission ? `
    <div class="sep"></div>
    <div class="center" style="font-size:10pt;color:#a00">
      ⚠ NFC-e: ${nfceEmission.status || 'pendente'}<br>
      ${nfceEmission.error_message ? `<small>${String(nfceEmission.error_message).slice(0,200)}</small>` : ''}
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Cupom</title>
<style>
  * { margin:0;padding:0;box-sizing:border-box }
  body { font-family:'Courier New',monospace;font-size:11pt;width:80mm;max-width:80mm;padding:0;color:#000 }
  .wrap { padding:2mm }
  h1 { font-size:13pt;text-align:center;margin-bottom:2px }
  .center { text-align:center }
  .sep  { border-top:1px dashed #000;margin:4px 0 }
  .row  { display:flex;justify-content:space-between;gap:4px }
  .total { font-size:13pt;font-weight:bold }
  .gorjeta { font-size:10pt;color:#444;font-style:italic }
  @media print {
    html, body { margin:0; padding:0 }
    button { display:none }
  }
  @page { size: 80mm auto; margin: 2mm; }
</style>
</head><body>
<div class="wrap">
  <h1>${displayName}</h1>
  <div class="center" style="font-size:9pt">
    ${company.tax_id || company.cnpj ? `CNPJ: ${company.tax_id || company.cnpj}` : 'CNPJ: pendente'}<br>
    ${[company.address_street, company.address_number, company.address_city].filter(Boolean).join(', ')}
  </div>
  <div class="sep"></div>
  <div class="center" style="font-size:10pt">${nfceEmission && nfceEmission.status === 'autorizada' ? 'CUPOM FISCAL ELETRONICO — NFC-e' : 'CUPOM NÃO FISCAL'}</div>
  <div class="center" style="font-size:9pt;margin-bottom:4px">${fmtDate(order.created_at)}</div>
  <div class="sep"></div>
  ${itemsHtml}
  <div class="sep"></div>
  <div class="row"><span>Subtotal</span><span>R$ ${fmt(subtotal)}</span></div>
  ${parseFloat(order.discount||0)>0 ? `<div class="row"><span>Desconto</span><span>-R$ ${fmt(order.discount)}</span></div>` : ''}
  ${parseFloat(order.delivery_fee||0)>0 ? `<div class="row"><span>Entrega</span><span>R$ ${fmt(order.delivery_fee)}</span></div>` : ''}
  ${feeAmt > 0 ? `
    <div class="row gorjeta"><span>Taxa de serviço (não obrigatória)</span><span>R$ ${fmt(feeAmt)}</span></div>
  ` : ''}
  <div class="sep"></div>
  <div class="row total"><span>TOTAL</span><span>R$ ${fmt(grandTotal)}</span></div>
  <div style="font-size:10pt;margin-top:2px">Pgto: ${order.payment_method || 'múltiplo'}</div>
  ${nfceBlock}
  <div class="sep"></div>
  <div class="center" style="font-size:9pt">
    Pedido #${order.id.slice(-6).toUpperCase()}<br>
    ${order.customer_name ? `Cliente: ${order.customer_name}<br>` : ''}
    Obrigado pela preferência!<br>getaura.com.br
  </div>
</div>
<br><button onclick="window.print()" style="margin:8px">Imprimir</button>
<script>setTimeout(()=>{try{window.print()}catch(e){}}, 200)</script>
</body></html>`;
}

// ── Busca pedido + itens + empresa + NFC-e (se houver) ───────
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
  // SELECT explicito — companies NAO tem coluna 'name'; usa trade_name/legal_name.
  const { rows: companies } = await db.query(
    `SELECT id, tax_id, cnpj, trade_name, legal_name, pdv_settings,
            address_street, address_number, address_district,
            address_city, address_state, address_zip
     FROM companies WHERE id=$1`, [companyId]
  );

  // NFC-e do pedido (se já emitida): busca via nfce_emissions.metadata.food_order_id.
  // Defensivo: cache HAS_NFCE_METADATA_COL evita 42703 a cada request.
  let nfceEmission = null;
  if (HAS_NFCE_METADATA_COL) {
    try {
      const { rows: emRows } = await db.query(
        `SELECT id, numero, serie, chave_acesso, protocolo, status, error_message
         FROM nfce_emissions
         WHERE company_id=$1
           AND metadata ? 'food_order_id'
           AND metadata->>'food_order_id' = $2
           AND status IN ('autorizada','processando','erro','rejeitada')
         ORDER BY created_at DESC LIMIT 1`,
        [companyId, orderId]
      );
      nfceEmission = emRows[0] || null;
    } catch (e) {
      if (e.code === '42703') {
        HAS_NFCE_METADATA_COL = false;
        console.warn('[food/cupom] nfce_emissions.metadata ainda não migrado — sem QR no cupom');
      } else {
        console.warn('[food/cupom] lookup nfce_emissions falhou:', e.message);
      }
    }
  }

  return { order: orders[0], items, company: companies[0] || {}, nfceEmission };
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

// GET /:oid/cupom — Cupom térmico 80mm c/ QR Code da NFC-e (se autorizada)
// Query params:
//   service_fee_amount: number (gorjeta separada — vinda do close-and-emit)
router.get('/:oid/cupom', guard, async (req, res) => {
  try {
    const data = await _fetchOrderData(req.params.oid, req.params.id);
    if (!data) return notFound(res);

    // Incrementa contador (best-effort)
    try {
      await db.query(
        `UPDATE food_orders SET comanda_print_count=comanda_print_count+1 WHERE id=$1`,
        [req.params.oid]
      );
    } catch (e) { /* coluna pode não existir — segue */ }

    // QR Code: só monta se NFC-e autorizada + chave válida + UF mapeada.
    let qrImg = '';
    if (data.nfceEmission?.status === 'autorizada' && data.nfceEmission.chave_acesso) {
      const uf = data.company.address_state;
      const consultaUrl = consultaUrlByUf(uf, data.nfceEmission.chave_acesso);
      if (consultaUrl) qrImg = await buildQrCodeImg(consultaUrl);
      // else: UF sem URL mapeada — TODO. Cupom sai sem QR (texto de aviso já no template).
    }

    const serviceFeeAmount = Number(req.query.service_fee_amount || 0);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildCupomHtml({
      order: data.order,
      items: data.items,
      company: data.company,
      nfceEmission: data.nfceEmission,
      serviceFeeAmount,
      qrImg,
    }));
  } catch (e) {
    console.error('[food/nfce/cupom] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao gerar cupom' });
  }
});

// GET /:oid/comanda — Comanda 80mm pra cozinha, SEM preços
router.get('/:oid/comanda', guard, async (req, res) => {
  try {
    const data = await _fetchOrderData(req.params.oid, req.params.id);
    if (!data) return notFound(res);

    try {
      await db.query(
        `UPDATE food_orders SET comanda_print_count=comanda_print_count+1 WHERE id=$1`,
        [req.params.oid]
      );
    } catch (e) { /* coluna pode não existir — segue */ }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildComandaHtml({
      order: data.order,
      items: data.items,
      company: data.company,
    }));
  } catch (e) {
    console.error('[food/nfce/comanda] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao gerar comanda' });
  }
});

// POST /:oid/emit — Mantido pra compat. Emissão real agora é via
// POST /companies/:id/food/orders/:oid/close-and-emit (foodOrders.js).
router.post('/:oid/emit', guard, async (req, res) => {
  try {
    const data = await _fetchOrderData(req.params.oid, req.params.id);
    if (!data) return notFound(res);
    const payload = buildNfcePayload(data.order, data.items, data.company);

    if (!data.company.tax_id && !data.company.cnpj) {
      return res.status(400).json({
        error: 'CNPJ não cadastrado — a emissão real exige CNPJ aprovado e certificado digital.',
        payload,
      });
    }

    res.status(202).json({
      status:   'stub',
      message:  'Use POST /companies/:id/food/orders/:oid/close-and-emit (Fase 7) para emissão real.',
      payload,
    });
  } catch (e) {
    console.error('[food/nfce/emit] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao emitir NFC-e' });
  }
});

module.exports = router;
