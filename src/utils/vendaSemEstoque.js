// ============================================================
// AURA. — Vender sem estoque (Configuracoes > Politicas do Caixa)
//
// 06/10/2026 — Luciano Melo (material de construcao): 2.538 produtos
// importados do sistema antigo, todos com saldo zero porque a loja nunca
// controlou estoque. O Caixa recusava cada venda com "Estoque insuficiente".
//
// A chave `allow_sale_without_stock` mora em companies.pdv_settings (jsonb,
// sem migration) e vem DESLIGADA: quem nao ligou continua com a trava de
// sempre. Ligada, a venda passa mesmo com saldo menor que a quantidade.
//
// O saldo NAO fica negativo: a baixa usa GREATEST(0, saldo - qtd), entao
// quem vende sem estoque continua com zero ate lancar a contagem.
//
// A leitura e do banco, nunca do JWT (CLAUDE.md, armadilha 9), e so e feita
// quando o saldo falta — venda com estoque nao paga uma ida a mais ao banco
// (~190 ms cada, o banco fica em outra regiao).
//
// O SQL e o mesmo texto que pdv.js ja usa para ler pdv_settings, de
// proposito: os mocks por conteudo dos testes existentes ja o reconhecem.
// ============================================================

const CHAVE = 'allow_sale_without_stock';

/** A loja ligou "vender sem estoque"? So `true` literal liga. */
function lerVendaSemEstoque(pdvSettings) {
  return !!pdvSettings && pdvSettings[CHAVE] === true;
}

/**
 * Consulta a chave da empresa. `client` e o client da transacao em curso
 * (ou o pool). Erro de banco sobe: dentro de uma transacao, engolir o erro
 * deixaria a transacao abortada e a venda cairia mais adiante sem explicacao.
 */
async function vendaSemEstoqueLiberada(client, companyId) {
  const { rows } = await client.query(
    `SELECT pdv_settings FROM companies WHERE id = $1`, [companyId]
  );
  return lerVendaSemEstoque(rows[0] && rows[0].pdv_settings);
}

module.exports = { CHAVE, lerVendaSemEstoque, vendaSemEstoqueLiberada };
