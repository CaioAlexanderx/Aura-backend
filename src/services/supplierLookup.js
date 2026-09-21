// ============================================================
// AURA. — Achar-ou-criar fornecedor por CNPJ (Fase 1, 16/09/2026)
//
// Usado pelo import de NF-e/DANFE (src/routes/importData.js): o CNPJ do
// emitente vem PRONTO do XML (autoridade fiscal ja validou), entao aqui
// NAO valida digito verificador -- so normaliza (digitos) e faz
// find-or-create. Validar de novo um CNPJ que ja passou pela SEFAZ so
// rejeitaria import legitimo por causa de um bug de normalizacao daqui.
//
// Busca no GRUPO ECONOMICO inteiro (nao so a empresa do import) -- se a
// matriz ja cadastrou "Fornecedor X" via outra nota, a filial que importa
// uma NF-e do mesmo CNPJ reusa o mesmo supplier em vez de duplicar
// (mesma decisao de src/routes/suppliers.js no POST).
//
// Sem CNPJ (emit sem CNPJ no XML, raro mas existe pra alguns regimes):
// cria por nome dentro da EMPRESA do import, sem dedupe (nao ha chave
// confiavel pra achar duplicata so pelo nome sem CNPJ).
// ============================================================
'use strict';

const db = require('../config/database');
const { onlyDigits } = require('../utils/cnpj');
const { companyGroupWhere } = require('../utils/companyGroup');

/**
 * @param {object} client - db.query-compatible (pool ou client de transacao)
 * @param {string} companyId
 * @param {{cnpj?: string, name?: string}} emitente
 * @returns {Promise<string|null>} supplier id, ou null se nao ha cnpj nem nome
 */
async function findOrCreateSupplierByCnpj(client, companyId, emitente) {
  const cnpjDigits = onlyDigits(emitente?.cnpj);
  const name = emitente?.name ? String(emitente.name).trim().slice(0, 200) : null;

  if (!cnpjDigits && !name) return null;

  if (cnpjDigits) {
    const { rows: found } = await client.query(
      `SELECT id FROM suppliers WHERE cnpj = $1 AND ${companyGroupWhere('$2')} LIMIT 1`,
      [cnpjDigits, companyId]
    );
    if (found.length) return found[0].id;
  }

  const { rows: created } = await client.query(
    `INSERT INTO suppliers (company_id, name, cnpj)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, cnpj) WHERE cnpj IS NOT NULL DO UPDATE SET name = suppliers.name
     RETURNING id`,
    [companyId, name || 'Fornecedor sem nome', cnpjDigits || null]
  );
  return created[0]?.id || null;
}

module.exports = { findOrCreateSupplierByCnpj };
