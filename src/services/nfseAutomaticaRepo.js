// ============================================================
// AURA. — nfseAutomaticaRepo: TODO o SQL da emissão automática da NFS-e.
//
// O orquestrador (services/nfseAutomatica.js) não escreve SQL; os testes de
// unidade trocam este módulo por um banco em memória (mesmo desenho do
// nfseNacional/repo.js). Tabela nfse_automatica e colunas novas: migration
// 438. Colunas fiscais do item (products.nfse_*): migration 437 (PR 1) —
// enquanto ela não estiver no banco, o item usa o código padrão da empresa.
//
// Multi-CNPJ: quem emite é a empresa da venda/OS (company_id da origem). O
// item compartilhado do grupo é lido pela MESMA regra de visibilidade do
// Caixa e do Estoque (utils/companyGroup.productVisibilityWhere).
// ============================================================
'use strict';

const db = require('../config/database');
const { productVisibilityWhere } = require('../utils/companyGroup');

const SCHEMA_AUSENTE = new Set(['42703', '42P01']);
const schemaAusente = (err) => !!(err && SCHEMA_AUSENTE.has(err.code));

// products.nfse_* (migration 437): null = ainda não sabemos; false = ausentes.
let _colunasFiscaisDoItem = null;
const COLUNAS_FISCAIS = ', p.nfse_ctribnac, p.nfse_cnbs, p.nfse_descricao';

async function comColunasFiscais(montarSql, params) {
  if (_colunasFiscaisDoItem !== false) {
    try {
      const r = await db.query(montarSql(COLUNAS_FISCAIS), params);
      _colunasFiscaisDoItem = true;
      return r.rows;
    } catch (err) {
      if (err.code !== '42703') throw err;
      _colunasFiscaisDoItem = false;
    }
  }
  const r = await db.query(montarSql(''), params);
  return r.rows;
}

/** Config da NFS-e da empresa. null = sem config ou migration 438 ausente. */
async function carregarConfig(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT company_id, provider, is_active, ctribnac_padrao, cnbs_padrao,
              emissao_automatica, emissao_automatica_desde
         FROM nfse_config WHERE company_id = $1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (err) {
    if (schemaAusente(err)) return null;
    throw err;
  }
}

async function gravarOptIn(companyId, ligar) {
  const { rows } = await db.query(
    `UPDATE nfse_config
        SET emissao_automatica = $2,
            emissao_automatica_desde = CASE
              WHEN $2 AND NOT emissao_automatica THEN NOW()
              WHEN $2 THEN COALESCE(emissao_automatica_desde, NOW())
              ELSE emissao_automatica_desde END
      WHERE company_id = $1
      RETURNING emissao_automatica, emissao_automatica_desde`,
    [companyId, !!ligar]
  );
  return rows[0] || null;
}

async function buscarVenda(companyId, saleId) {
  const { rows } = await db.query(
    `SELECT id, company_id, customer_id, status, type, total_amount, created_at
       FROM sales WHERE id = $1 AND company_id = $2`,
    [saleId, companyId]
  );
  return rows[0] || null;
}

/** Todos os itens da venda; `servico` = produto com unit 'srv'. */
async function itensDaVenda(companyId, saleId) {
  return comColunasFiscais((extra) => `
    SELECT si.id, si.product_id, si.quantity, si.total_price, si.product_name_snapshot,
           p.unit, p.name AS product_name${extra}
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id AND ${productVisibilityWhere('$2', 'p.')}
     WHERE si.sale_id = $1
     ORDER BY si.id`, [saleId, companyId]);
}

async function buscarOs(companyId, osId) {
  const { rows } = await db.query(
    `SELECT id, company_id, customer_id, status, sale_id, delivered_at, os_number
       FROM service_orders WHERE id = $1 AND company_id = $2`,
    [osId, companyId]
  );
  return rows[0] || null;
}

async function itensDaOs(companyId, osId) {
  return comColunasFiscais((extra) => `
    SELECT i.id, i.kind, i.description, i.product_id, i.quantity, i.total_price,
           p.unit, p.name AS product_name${extra}
      FROM service_order_items i
      LEFT JOIN products p ON p.id = i.product_id AND ${productVisibilityWhere('$2', 'p.')}
     WHERE i.service_order_id = $1
     ORDER BY i.sort_order, i.created_at`, [osId, companyId]);
}

/** Vendas das parcelas cobertas por um recebimento do crediário. */
async function vendasDasParcelas(companyId, installmentIds) {
  if (!installmentIds || !installmentIds.length) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT sale_id FROM credit_installments
      WHERE company_id = $1 AND id = ANY($2::uuid[]) AND sale_id IS NOT NULL`,
    [companyId, installmentIds]
  );
  return rows.map((r) => r.sale_id);
}

async function buscarCliente(customerId) {
  if (!customerId) return null;
  const { rows } = await db.query(
    `SELECT id, name, full_name, cpf_cnpj, email, phone FROM customers WHERE id = $1`,
    [customerId]
  );
  return rows[0] || null;
}

const COLS = `a.id, a.company_id, a.origem_tipo, a.origem_id, a.ctribnac, a.gatilho, a.status,
  a.motivo, a.motivo_codigo, a.tentativa, a.idempotency_key, a.nfse_id, a.customer_id,
  a.tomador, a.nota, a.itens, a.valor, a.vinculos, a.created_at, a.updated_at`;
const COLS_NFSE = `n.status AS nfse_status, n.nfse_number, n.chave_acesso, n.issued_at,
  n.rejection_reason AS nfse_motivo, n.dps_number`;

async function buscarRegistro(id) {
  const { rows } = await db.query(
    `SELECT ${COLS}, ${COLS_NFSE}
       FROM nfse_automatica a LEFT JOIN nfse n ON n.id = a.nfse_id
      WHERE a.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Cria o registro da prestação em 'emitindo' (é ele que "segura a vez").
 * Se já existe, devolve o existente — quem decide o que fazer é o orquestrador.
 * @returns {{ row, criado: boolean }}
 */
async function reivindicar({ companyId, origemTipo, origemId, ctribnac, gatilho, itens, valor, customerId }) {
  const { rows } = await db.query(
    `INSERT INTO nfse_automatica
       (company_id, origem_tipo, origem_id, ctribnac, gatilho, status, itens, valor, customer_id)
     VALUES ($1, $2, $3, $4, $5, 'emitindo', $6::jsonb, $7, $8)
     ON CONFLICT (company_id, origem_tipo, origem_id, ctribnac) DO NOTHING
     RETURNING id`,
    [companyId, origemTipo, origemId, ctribnac, gatilho, JSON.stringify(itens || []), valor, customerId || null]
  );
  if (rows[0]) return { row: await buscarRegistro(rows[0].id), criado: true };
  const { rows: ex } = await db.query(
    `SELECT a.id FROM nfse_automatica a
      WHERE a.company_id = $1 AND a.origem_tipo = $2 AND a.origem_id = $3 AND a.ctribnac = $4`,
    [companyId, origemTipo, origemId, ctribnac]
  );
  return { row: ex[0] ? await buscarRegistro(ex[0].id) : null, criado: false };
}

/**
 * Pega a vez de um registro existente, de forma atômica: só um processo
 * consegue passar de `de` (ou de 'emitindo' parado há mais de staleSeg) para
 * 'emitindo'. novaTentativa = nova chave de idempotência (nota anterior
 * rejeitada/cancelada continua no histórico).
 */
async function retomar(id, { de = [], staleSeg = 0, novaTentativa = false, itens, valor }) {
  const { rows } = await db.query(
    `UPDATE nfse_automatica
        SET status = 'emitindo', motivo = NULL, motivo_codigo = NULL,
            tentativa = tentativa + $3::int,
            nfse_id = CASE WHEN $3::int > 0 THEN NULL ELSE nfse_id END,
            itens = COALESCE($5::jsonb, itens),
            valor = COALESCE($6::numeric, valor)
      WHERE id = $1
        AND (status = ANY($2::text[])
             OR ($4::int > 0 AND status = 'emitindo' AND updated_at < NOW() - make_interval(secs => $4::int)))
      RETURNING id`,
    [id, de, novaTentativa ? 1 : 0, staleSeg, itens ? JSON.stringify(itens) : null, valor != null ? valor : null]
  );
  return rows[0] ? buscarRegistro(rows[0].id) : null;
}

/** Regra (c): o código apareceu — o registro-sentinela "sem código" sai de cena. */
async function removerSemCodigo(companyId, origemTipo, origemId, sentinela) {
  await db.query(
    `DELETE FROM nfse_automatica
      WHERE company_id = $1 AND origem_tipo = $2 AND origem_id = $3 AND ctribnac = $4 AND nfse_id IS NULL`,
    [companyId, origemTipo, origemId, sentinela]
  );
}

async function anotarVinculo(id, vinculo) {
  await db.query(
    `UPDATE nfse_automatica SET vinculos = COALESCE(vinculos, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify([vinculo])]
  );
}

const CAMPOS_GRAVAVEIS = new Set([
  'status', 'motivo', 'motivo_codigo', 'idempotency_key', 'nfse_id', 'tomador', 'nota', 'tentativa',
]);
const JSONB = new Set(['tomador', 'nota']);

async function gravar(id, campos) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(campos || {})) {
    if (!CAMPOS_GRAVAVEIS.has(k) || v === undefined) continue;
    vals.push(JSONB.has(k) && v !== null ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}${JSONB.has(k) ? '::jsonb' : ''}`);
  }
  if (!sets.length) return;
  vals.push(id);
  await db.query(`UPDATE nfse_automatica SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
}

/** nfse.source_id da nota emitida (rastreio / busca por origem). */
async function ligarNotaAOrigem(companyId, nfseId, sourceId) {
  try {
    await db.query(
      'UPDATE nfse SET source_id = $1 WHERE id = $2 AND company_id = $3 AND source_id IS NULL',
      [sourceId, nfseId, companyId]
    );
  } catch (err) {
    // rastreio é bônus: coluna ausente ou índice de origem não derrubam nada
    console.error('[nfse automatica] ligar nota à origem:', err.code, err.message);
  }
}

async function notaPorChave(companyId, key) {
  const { rows } = await db.query(
    'SELECT id, status, rejection_reason FROM nfse WHERE company_id = $1 AND idempotency_key = $2',
    [companyId, key]
  );
  return rows[0] || null;
}

/** Registros de uma ou mais origens, com a situação viva da nota. */
async function listarPorOrigens(companyId, origens) {
  if (!origens.length) return [];
  const tipos = origens.map((o) => o.tipo);
  const ids = origens.map((o) => o.id);
  try {
    const { rows } = await db.query(
      `SELECT ${COLS}, ${COLS_NFSE}
         FROM nfse_automatica a
         LEFT JOIN nfse n ON n.id = a.nfse_id
         JOIN unnest($2::text[], $3::uuid[]) AS o(tipo, id) ON o.tipo = a.origem_tipo AND o.id = a.origem_id
        WHERE a.company_id = $1
        ORDER BY a.created_at, a.ctribnac`,
      [companyId, tipos, ids]
    );
    return rows;
  } catch (err) {
    if (schemaAusente(err)) return [];
    throw err;
  }
}

module.exports = {
  carregarConfig, gravarOptIn,
  buscarVenda, itensDaVenda, buscarOs, itensDaOs, vendasDasParcelas, buscarCliente,
  buscarRegistro, reivindicar, retomar, anotarVinculo, gravar, removerSemCodigo,
  ligarNotaAOrigem, notaPorChave, listarPorOrigens,
  schemaAusente,
  _resetCache: () => { _colunasFiscaisDoItem = null; },
};
