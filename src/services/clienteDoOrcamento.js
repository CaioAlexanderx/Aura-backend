// ============================================================
// AURA. — Cliente do orcamento vira cadastro (C4 do QA de 26/11/2026)
//
// Quando a lojista ENVIA um orcamento (status vira 'sent'; rascunho nao) com
// nome e WhatsApp digitados e sem customer_id, o cliente entra em Clientes:
//   - na empresa DO ORCAMENTO (company_id do orcamento; multi-CNPJ);
//   - sem duplicar: se a empresa ja tem cliente com o mesmo telefone
//     (so digitos, com e sem o 55 do pais), so liga o customer_id;
//   - o customer_id e ligado ao orcamento.
// Nunca derruba o envio: qualquer falha aqui e logada e o orcamento segue.
// ============================================================
'use strict';

const { digitosNacionais } = require('../utils/telefone');

/** Telefone nacional (10 ou 11 digitos, DDD + numero) ou null. */
function telefoneNacional(bruto) {
  const d = digitosNacionais(bruto);
  return d.length === 10 || d.length === 11 ? d : null;
}

/**
 * @param {object} db     pool (connect/query)
 * @param {object} quote  linha de studio_quotes ja enviada (id, company_id,
 *                        customer_id, customer_name, customer_phone)
 * @returns {Promise<{customer_id: string|null, criado: boolean, ligado: boolean}>}
 *   ligado=false: nada a fazer (ja tinha cliente, ou faltou nome/telefone valido).
 */
async function garantirClienteDoOrcamento(db, quote) {
  const nada = { customer_id: quote && quote.customer_id ? quote.customer_id : null, criado: false, ligado: false };
  try {
    if (!quote || quote.customer_id) return nada;
    const nome = String(quote.customer_name || '').trim();
    const nacional = telefoneNacional(quote.customer_phone);
    if (!nome || !nacional) return nada;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Dois envios ao mesmo tempo com o mesmo telefone esperam um pelo outro.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cli-orc:${quote.company_id}:${nacional}`]);

      const { rows: achados } = await client.query(
        `SELECT id FROM customers
          WHERE company_id = $1
            AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') IN ($2, $3)
          ORDER BY created_at ASC NULLS LAST
          LIMIT 1`,
        [quote.company_id, nacional, '55' + nacional]
      );
      let customerId;
      let criado = false;
      if (achados.length) {
        customerId = achados[0].id;
      } else {
        const { rows: novo } = await client.query(
          `INSERT INTO customers (company_id, name, phone, is_active, lgpd_consent)
           VALUES ($1, $2, $3, TRUE, FALSE)
           RETURNING id`,
          [quote.company_id, nome.slice(0, 200), String(quote.customer_phone).trim()]
        );
        customerId = novo[0].id;
        criado = true;
      }
      const { rowCount } = await client.query(
        `UPDATE studio_quotes SET customer_id = $1, updated_at = NOW()
          WHERE id = $2 AND company_id = $3 AND customer_id IS NULL`,
        [customerId, quote.id, quote.company_id]
      );
      await client.query('COMMIT');
      return { customer_id: customerId, criado, ligado: rowCount > 0 };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[clienteDoOrcamento] nao ligou o cliente do orcamento:', quote && quote.id, e.message);
    return nada;
  }
}

module.exports = { garantirClienteDoOrcamento, telefoneNacional };
