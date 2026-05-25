// ============================================================
// AURA. — services/trocaDevolucao55.js
// Helper de orquestração da NF-e modelo 55 de devolução de venda,
// extraído pra fora de pdv.js pra manter o handler do POST /troca enxuto.
//
// 12/05/2026 (Fase C — contador Davi OK):
//   CFOP   = 1.202 (devolução venda, mesma UF SP, varejo)
//   CSOSN  = 102   (Simples Nacional sem permissão de crédito)
//   Serie  = 1     (próximo numero calculado por company_id + tipo='nfe')
//   tpNF   = 0     (entrada — loja recebe a mercadoria de volta)
//   finNFe = 4     (devolução)
//   refNFe = chave 44 dígitos da NFC-e original
//
// 25/05/2026 (Polish v3 — auditoria atrito):
//   - Removida validação NFCE_ORIGINAL_ANONIMA — anônima é caso suportado;
//     basta colocar "Consumidor não identificado" em infAdFisco.
//   - Removida validação CUSTOMER_ADDRESS_REQUIRED — SEFAZ FAQ MG #7
//     define que dest da NF-e 55 de devolução é o PRÓPRIO EMITENTE; o
//     endereço do cliente NÃO é exigido (e nem cabe — não há campo dest).
//     Dados do cliente vão em infAdFisco como texto livre.
//   - Parâmetro customerAddress fica aceito por compat retroativa,
//     mas é ignorado. Frontend pode parar de enviar.
//
// Doc: Aura/BACKLOG_TROCA_CROSS_FILIAL.md (Fase C)
// Memory: [[nfe55-devolucao-dest-proprio-emitente]]
// ============================================================

const nuvemfiscal = require('./nuvemfiscal');

// HttpError — sinaliza pro caller (pdv.js) qual status + body devolver.
// pdv.js intercepta isso após o ROLLBACK e responde adequado.
class TrocaDevolucao55Error extends Error {
  constructor(status, body) {
    super(body && body.error ? body.error : 'devolucao_55 error');
    this.status = status;
    this.body = body;
    this.isDevolucao55Error = true;
  }
}

// handle(client, params) → nfceFiscalResult
//
// Lança TrocaDevolucao55Error quando deve retornar 4xx/5xx ao usuário.
// Lança Error normal pra outros erros (caller faz 500).
// SE retornar, o client.query('COMMIT') ainda precisa ser chamado pelo caller.
async function handle(client, {
  saleCompanyId,         // CNPJ origem da venda (Filial 1) — emit NF-e/55
  originalSaleId,        // UUID da venda original
  trocaSaleId,           // UUID da troca (sales row já criada)
  returnedItems,         // array original do req.body
  returnedValue,         // soma de returned_items (qty*unit_price)
  customerAddress,       // 25/05/2026: ACEITO por compat mas IGNORADO
  notes,                 // observação livre — vira motivo em infAdFisco
  userId,                // req.user?.id (emitted_by)
}) {
  // 1. Busca NFC-e original autorizada (qualquer idade — strategy é
  //    justamente pra >24h)
  const { rows: origNfceList } = await client.query(
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

  // 25/05/2026: SEFAZ FAQ MG #7 define dest = próprio emitente. CPF do
  // cliente é opcional — entra em infAdFisco texto livre se conhecido.
  // NFC-e anônima é caso suportado (consumidor não identificado).

  // 2. Próximo numero da serie 1 NF-e/55 desta company
  const { rows: nfeSeq } = await client.query(
    `SELECT COALESCE(MAX(numero), 0) + 1 AS next_numero
       FROM nfce_emissions
      WHERE company_id = $1 AND tipo = 'nfe' AND COALESCE(serie, 1) = 1`,
    [saleCompanyId]
  );
  const nextNumero = parseInt(nfeSeq[0] && nfeSeq[0].next_numero, 10) || 1;

  // 3. Dados da empresa pra emissao
  const { rows: companyRows } = await client.query(
    `SELECT * FROM companies WHERE id = $1`,
    [saleCompanyId]
  );
  if (!companyRows.length) {
    throw new TrocaDevolucao55Error(500, {
      error: 'Empresa de origem nao encontrada',
    });
  }
  const company = companyRows[0];

  // 4. Items da devolucao a partir de returned_items
  const devolucaoItems = (returnedItems || []).map((ret, idx) => ({
    code: ret.product_id || ('item-' + (idx + 1)),
    name: ret.product_name_snapshot || ('Item ' + (idx + 1)),
    quantity: parseFloat(ret.quantity),
    price: parseFloat(ret.unit_price),
    cfop: '1202', // contador OK 12/05/2026 — imutável
    ncm: ret.ncm || '00000000',
    unit: 'UN',
  }));

  // 5. consumerInfo pra infAdFisco texto livre. Todos opcionais.
  const consumerInfo = {
    name: orig.customer_name || null,
    cpf: orig.customer_cpf || null,
    motivo: notes || 'Troca',
  };

  // 6. Emite NF-e/55 de devolucao via Nuvem Fiscal (dest = própria loja)
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
    console.error('[trocaDevolucao55] SEFAZ error:', sefazErr.message);
    throw new TrocaDevolucao55Error(502, {
      error: 'SEFAZ rejeitou NF-e modelo 55 de devolucao: ' + sefazErr.message,
      sefaz_payload: sefazErr.payload || null,
    });
  }

  const devolucaoChave = (nfeResult && (nfeResult.chave_acesso || nfeResult.chave)) || null;
  const nuvemId        = (nfeResult && nfeResult.id) || null;
  const nfeStatus      = (nfeResult && nfeResult.status) || 'processando';

  // 7. Insere registro em nfce_emissions (tipo='nfe', finalidade=4)
  await client.query(
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
  await client.query(
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
