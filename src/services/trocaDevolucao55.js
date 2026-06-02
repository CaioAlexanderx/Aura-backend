// ============================================================
// AURA. — services/trocaDevolucao55.js
// Helper de orquestracao da NF-e modelo 55 de devolucao de venda.
//
// 27/05/2026 (log detalhado): catch do emit com console.error estruturado.
// 25/05/2026 (Polish v3): dest = proprio emitente (SEFAZ FAQ MG #7).
// 12/05/2026 (Fase C): CFOP 1.202 + CSOSN 102 + tpNF=0 + finNFe=4 + refNFe.
// 29/05/2026 (fix null-client): handle() aceita client=null (pos-COMMIT).
//
// 01/06/2026 (fix NCM): itens da devolucao puxam NCM + barcode REAIS do
// produto (tabela products) pelo product_id. Antes ia '00000000' e a SEFAZ
// rejeitava (Rejeicao 778).
//
// 01/06/2026 (captura motivo): status normalizado + motivo da rejeicao
// (cStat+xMotivo) gravados em error_message + metadata. Antes a NF-e 55
// voltava 'rejeitado' sem motivo nenhum no banco (caso Davi).
//
// Memory: [[nfe55-devolucao-dest-proprio-emitente]]
// ============================================================

const db = require('../config/database');
const nuvemfiscal = require('./nuvemfiscal');

class TrocaDevolucao55Error extends Error {
  constructor(status, body) {
    super(body && body.error ? body.error : 'devolucao_55 error');
    this.status = status;
    this.body = body;
    this.isDevolucao55Error = true;
  }
}

// NCM valido = 8 digitos e diferente de '00000000'. SEFAZ rejeita o resto.
function validNcm(n) {
  const s = String(n || '').replace(/\D/g, '');
  return (s.length === 8 && s !== '00000000') ? s : null;
}

// Normaliza status + motivo da resposta da Nuvem Fiscal. Status no topo
// ('autorizado'|'rejeitado'|'denegado'|'pendente'|...) e motivo em
// codigo_status/motivo_status (cStat+xMotivo da SEFAZ).
function normalizeDfeStatus(result) {
  const raw = String((result && result.status) || '').toLowerCase();
  const aut = (result && (result.autorizacao || result.protocolo_autorizacao)) || {};
  const codigo = (result && (result.codigo_status || result.cStat)) || aut.codigo_status || aut.cStat || null;
  let motivoTxt = (result && (result.motivo_status || result.xMotivo || result.mensagem || result.message)) ||
                  aut.motivo_status || aut.xMotivo || null;
  if (!motivoTxt && Array.isArray(result && result.erros) && result.erros[0]) {
    motivoTxt = result.erros[0].mensagem || result.erros[0].message || null;
  }
  let status;
  if (raw === 'autorizado' || raw === 'autorizada') status = 'autorizada';
  else if (raw === 'rejeitado' || raw === 'rejeitada') status = 'rejeitada';
  else if (raw === 'denegado' || raw === 'denegada') status = 'denegada';
  else if (raw === 'cancelado' || raw === 'cancelada') status = 'cancelada';
  else if (raw === 'erro') status = 'erro';
  else status = raw || 'processando';
  let motivo = null;
  if (codigo || motivoTxt) {
    motivo = ((codigo ? codigo + ' - ' : '') + (motivoTxt || '')).trim();
  }
  return { status: status, motivo: motivo };
}

async function handle(client, {
  saleCompanyId,
  originalSaleId,
  trocaSaleId,
  returnedItems,
  returnedValue,
  customerAddress,
  notes,
  userId,
}) {
  const q = (sql, params) => (client || db).query(sql, params);

  // 1. NFC-e original autorizada
  const { rows: origNfceList } = await q(
    `SELECT id, chave_acesso, numero, customer_cpf, customer_name, authorized_at
       FROM nfce_emissions
      WHERE sale_id = $1 AND tipo = 'nfce' AND status = 'autorizada'
      ORDER BY created_at DESC LIMIT 1`,
    [originalSaleId]
  );
  if (!origNfceList.length) {
    throw new TrocaDevolucao55Error(409, {
      error: 'devolucao_55 requer NFC-e autorizada na venda original.',
    });
  }
  const orig = origNfceList[0];

  // 2. Proximo numero serie 1 NF-e/55
  const { rows: nfeSeq } = await q(
    `SELECT COALESCE(MAX(numero), 0) + 1 AS next_numero
       FROM nfce_emissions
      WHERE company_id = $1 AND tipo = 'nfe' AND COALESCE(serie, 1) = 1`,
    [saleCompanyId]
  );
  const nextNumero = parseInt(nfeSeq[0] && nfeSeq[0].next_numero, 10) || 1;

  // 3. Empresa
  const { rows: companyRows } = await q(
    `SELECT * FROM companies WHERE id = $1`,
    [saleCompanyId]
  );
  if (!companyRows.length) {
    throw new TrocaDevolucao55Error(500, { error: 'Empresa de origem nao encontrada' });
  }
  const company = companyRows[0];

  // 3b. NCM + barcode reais por product_id (senao SEFAZ rejeita por NCM).
  const productIds = [...new Set((returnedItems || []).map((r) => r.product_id).filter(Boolean))];
  const ncmByProduct = new Map();
  const barcodeByProduct = new Map();
  if (productIds.length) {
    const ph = productIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: prodRows } = await q(
      `SELECT id, ncm, barcode FROM products WHERE id IN (${ph})`,
      productIds
    );
    for (const p of prodRows) {
      ncmByProduct.set(p.id, p.ncm);
      barcodeByProduct.set(p.id, p.barcode);
    }
  }

  // 4. Itens da devolucao
  const devolucaoItems = (returnedItems || []).map((ret, idx) => {
    const ncm = validNcm(ret.ncm) || validNcm(ncmByProduct.get(ret.product_id)) || '00000000';
    const barcode = ret.barcode || barcodeByProduct.get(ret.product_id) || null;
    return {
      code: ret.product_id || ('item-' + (idx + 1)),
      name: ret.product_name_snapshot || ('Item ' + (idx + 1)),
      quantity: parseFloat(ret.quantity),
      price: parseFloat(ret.unit_price),
      cfop: '1202',
      ncm: ncm,
      barcode: barcode,
      unit: 'UN',
    };
  });

  // 4b. Aviso se algum item ficou sem NCM valido.
  const semNcm = devolucaoItems.filter((it) => it.ncm === '00000000');
  if (semNcm.length) {
    console.warn(
      '[trocaDevolucao55] ' + semNcm.length + ' item(ns) sem NCM valido (troca ' +
      trocaSaleId + '): ' + semNcm.map((i) => i.code).join(', ') +
      '. SEFAZ vai rejeitar - cadastre o NCM do produto.'
    );
  }

  // 5. consumerInfo
  const consumerInfo = {
    name: orig.customer_name || null,
    cpf: orig.customer_cpf || null,
    motivo: notes || 'Troca',
  };

  // 6. Emite NF-e/55
  let nfeResult;
  try {
    nfeResult = await nuvemfiscal.emitNfeDevolucao(company, {
      originalChave: orig.chave_acesso,
      items: devolucaoItems,
      consumerInfo: consumerInfo,
      serie: 1,
      numero: nextNumero,
      reference: 'troca-' + trocaSaleId,
    });
  } catch (sefazErr) {
    let payloadStr = null;
    try { payloadStr = JSON.stringify(sefazErr.payload, null, 2); } catch (_) {}
    console.error('[trocaDevolucao55] SEFAZ error:', {
      message: sefazErr.message,
      status: sefazErr.status,
      erros: sefazErr.erros || [],
      context: {
        company_id: saleCompanyId,
        company_cnpj: company.cnpj,
        original_chave: orig.chave_acesso,
        troca_sale_id: trocaSaleId,
        nfe55_numero: nextNumero,
        total_devolucao: parseFloat(returnedValue.toFixed(2)),
        items_count: devolucaoItems.length,
      },
    });
    if (payloadStr) {
      console.error('[trocaDevolucao55] SEFAZ payload completo:', payloadStr);
    }
    throw new TrocaDevolucao55Error(502, {
      error: 'SEFAZ rejeitou NF-e modelo 55 de devolucao: ' + sefazErr.message,
      sefaz_payload: sefazErr.payload || null,
      erros: sefazErr.erros || [],
    });
  }

  const devolucaoChave = (nfeResult && (nfeResult.chave_acesso || nfeResult.chave)) || null;
  const nuvemId = (nfeResult && nfeResult.id) || null;

  const norm = normalizeDfeStatus(nfeResult);
  const nfeStatus = norm.status;
  const nfeMotivo = norm.motivo;
  const nfeErrorMsg = (nfeStatus !== 'autorizada' && nfeStatus !== 'processando') ? (nfeMotivo || null) : null;
  if (nfeErrorMsg) {
    console.warn('[trocaDevolucao55] NF-e 55 ' + nfeStatus + ' (troca ' + trocaSaleId + '): ' + nfeErrorMsg);
  }

  // 7. Insere registro (com error_message + metadata)
  await q(
    `INSERT INTO nfce_emissions
       (company_id, sale_id, numero, serie, chave_acesso, tipo, finalidade,
        ref_chave_nfe, status, nuvemfiscal_id, customer_cpf, customer_name,
        items, total_products, total_nfce, emitted_by, error_message, metadata)
     VALUES ($1, $2, $3, 1, $4, 'nfe', 4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15::jsonb)`,
    [
      saleCompanyId,
      trocaSaleId,
      nextNumero,
      devolucaoChave,
      orig.chave_acesso,
      nfeStatus,
      nuvemId,
      orig.customer_cpf,
      orig.customer_name || null,
      JSON.stringify(devolucaoItems),
      parseFloat(returnedValue.toFixed(2)),
      parseFloat(returnedValue.toFixed(2)),
      userId || null,
      nfeErrorMsg,
      JSON.stringify(nfeResult || {}),
    ]
  );

  // 8. Marca a trocaSale
  await q(
    `UPDATE sales
        SET nfce_strategy        = $1,
            nfce_original_chave  = $2,
            nfce_devolucao_chave = $3
      WHERE id = $4`,
    ['devolucao_55', orig.chave_acesso, devolucaoChave, trocaSaleId]
  );

  return {
    strategy: 'devolucao_55',
    original_chave: orig.chave_acesso,
    original_numero: orig.numero,
    devolucao_chave: devolucaoChave,
    devolucao_numero: nextNumero,
    devolucao_serie: 1,
    nuvemfiscal_id: nuvemId,
    status: nfeStatus,
    motivo: nfeMotivo || null,
    error_message: nfeErrorMsg,
  };
}

module.exports = {
  handle,
  TrocaDevolucao55Error,
};
