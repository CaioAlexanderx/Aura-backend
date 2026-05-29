// ============================================================
// AURA. — services/trocaDevolucao55.js
// Helper de orquestração da NF-e modelo 55 de devolução de venda.
//
// 27/05/2026 (log detalhado): catch do emit agora console.error
// estruturado com message, status, payload completo, array erros, e
// contexto da troca (company_id, chave original, número, valor).
//
// 25/05/2026 (Polish v3): removidas validações NFCE_ORIGINAL_ANONIMA
// e CUSTOMER_ADDRESS_REQUIRED. dest = próprio emitente (SEFAZ FAQ MG #7).
//
// 12/05/2026 (Fase C): CFOP 1.202 + CSOSN 102 + tpNF=0 + finNFe=4 +
// refNFe. Contador OK.
//
// 29/05/2026 (fix null-client): handle() agora aceita client=null
// (chamada pós-COMMIT em trocaV2) — usa pool db como fallback.
// Antes explodia com "Cannot read properties of null (reading 'query')".
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

async function handle(client, {
  saleCompanyId,
  originalSaleId,
  trocaSaleId,
  returnedItems,
  returnedValue,
  customerAddress,       // ACEITO por compat mas IGNORADO
  notes,
  userId,
}) {
  // Suporta client=null (chamada pós-COMMIT): fallback para pool db.
  const q = (sql, params) => (client || db).query(sql, params);

  // 1. Busca NFC-e original autorizada
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

  // 2. Próximo numero da serie 1 NF-e/55
  const { rows: nfeSeq } = await q(
    `SELECT COALESCE(MAX(numero), 0) + 1 AS next_numero
       FROM nfce_emissions
      WHERE company_id = $1 AND tipo = 'nfe' AND COALESCE(serie, 1) = 1`,
    [saleCompanyId]
  );
  const nextNumero = parseInt(nfeSeq[0] && nfeSeq[0].next_numero, 10) || 1;

  // 3. Dados da empresa
  const { rows: companyRows } = await q(
    `SELECT * FROM companies WHERE id = $1`,
    [saleCompanyId]
  );
  if (!companyRows.length) {
    throw new TrocaDevolucao55Error(500, { error: 'Empresa de origem nao encontrada' });
  }
  const company = companyRows[0];

  // 4. Items da devolução
  const devolucaoItems = (returnedItems || []).map((ret, idx) => ({
    code: ret.product_id || ('item-' + (idx + 1)),
    name: ret.product_name_snapshot || ('Item ' + (idx + 1)),
    quantity: parseFloat(ret.quantity),
    price: parseFloat(ret.unit_price),
    cfop: '1202',
    ncm: ret.ncm || '00000000',
    unit: 'UN',
  }));

  // 5. consumerInfo (todos opcionais)
  const consumerInfo = {
    name: orig.customer_name || null,
    cpf: orig.customer_cpf || null,
    motivo: notes || 'Troca',
  };

  // 6. Emite NF-e/55 via Nuvem Fiscal
  let nfeResult;
  try {
    nfeResult = await nuvemfiscal.emitNfeDevolucao(company, {
      originalChave: orig.chave_acesso,
      items: devolucaoItems,
      consumerInfo,
      serie: 1,
      numero: nextNumero,
      reference: `troca-${trocaSaleId}`,
    });
  } catch (sefazErr) {
    // 27/05/2026: log estruturado com tudo que precisa pra debugar
    // rejeições "Validation failed" da Nuvem Fiscal.
    let payloadStr = null;
    try { payloadStr = JSON.stringify(sefazErr.payload, null, 2); } catch (_) {}
    console.error('[trocaDevolucao55] SEFAZ error:', {
      message: sefazErr.message,
      status: sefazErr.status,
      erros: sefazErr.erros || [],
      context: {
        company_id: saleCompanyId,
        company_cnpj: company.cnpj,
        company_uf: company.address_state,
        company_ie: company.inscricao_estadual,
        company_ibge: company.ibge_code,
        company_crt: company.tax_regime,
        original_chave: orig.chave_acesso,
        original_numero: orig.numero,
        original_authorized_at: orig.authorized_at,
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
  const nuvemId        = (nfeResult && nfeResult.id) || null;
  const nfeStatus      = (nfeResult && nfeResult.status) || 'processando';

  // 7. Insere registro em nfce_emissions
  await q(
    `INSERT INTO nfce_emissions
       (company_id, sale_id, numero, serie, chave_acesso, tipo, finalidade,
        ref_chave_nfe, status, nuvemfiscal_id, customer_cpf, customer_name,
        items, total_products, total_nfce, emitted_by)
     VALUES ($1, $2, $3, 1, $4, 'nfe', 4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
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
    ]
  );

  // 8. Marca a trocaSale com strategy + chaves
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
  };
}

module.exports = {
  handle,
  TrocaDevolucao55Error,
};
