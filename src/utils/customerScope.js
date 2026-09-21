// ============================================================
// AURA. — Cliente do dono dentro do crediario (16/09/2026)
//
// Clientes sao "do dono", nao da loja (ownerScope.js, 03/05/2026): o PDV
// da Matriz lista e vende para quem foi cadastrado na Villa Branca. O
// crediario, porem, conferia `customers.company_id = loja` em toda rota.
// Resultado (Davi Calcados, Mary Lucy): a venda no crediario entrou na
// Matriz, a divida ficou na Matriz, e receber, ver o historico ou imprimir
// o recibo dava 404 "Cliente nao encontrado nesta empresa" -- que o app
// mostrava como "Confira os dados e tente de novo".
//
// A divida continua sendo da loja que vendeu (credit_installments e o
// ledger seguem por company_id). So a CONFERENCIA do cadastro passa a
// aceitar qualquer empresa ativa do mesmo dono -- a mesma regra da lista
// de clientes.
//
// Uma consulta so: o dono e resolvido dentro do SQL (latencia cross-region,
// cada ida ao banco custa caro). Sem owner_id, cai na conferencia antiga
// (so a propria loja). O texto comeca com "FROM customers WHERE id" de
// proposito: os mocks dos testes de rota casam por esse trecho.
// ============================================================

// $1 = customer_id, $2 = company_id da URL
const OWNER_SCOPED_CUSTOMER_WHERE = `id = $1
   AND (company_id = $2
        OR company_id IN (
          SELECT o.id FROM companies o
           WHERE o.owner_id = (SELECT me.owner_id FROM companies me WHERE me.id = $2)
             AND o.is_active = true))`;

/**
 * Busca o cliente se ele pertence a empresa OU a outra empresa ativa do
 * mesmo dono. `q` e o pool ou um client em transacao (qualquer coisa com
 * .query). `columns` e a lista de colunas do SELECT (texto fixo do codigo,
 * nunca entrada do usuario).
 *
 * @returns {Promise<object|null>}
 */
async function findOwnerScopedCustomer(q, companyId, customerId, columns = 'id') {
  if (!companyId || !customerId) return null;
  const { rows } = await q.query(
    `SELECT ${columns} FROM customers WHERE ${OWNER_SCOPED_CUSTOMER_WHERE}`,
    [customerId, companyId]
  );
  return rows[0] || null;
}

// Corpo padrao do 404 -- com `code`, para o app nao depender do texto.
const CUSTOMER_NOT_FOUND_BODY = Object.freeze({
  error: 'Cliente não encontrado nesta empresa.',
  code:  'CUSTOMER_NOT_FOUND',
});

module.exports = {
  findOwnerScopedCustomer,
  OWNER_SCOPED_CUSTOMER_WHERE,
  CUSTOMER_NOT_FOUND_BODY,
};
