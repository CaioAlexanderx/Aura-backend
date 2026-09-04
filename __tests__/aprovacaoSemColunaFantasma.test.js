// ============================================================
// A aprovação de arte não pode ler uma coluna que não existe
// (QA de 04/09/2026)
//
// `digital_orders` nunca teve `customer_data`. Duas consultas — a página
// pública /aprovacao/:token e o POST que cria o link no painel — faziam
// COALESCE(o.customer_data->>'name', o.customer_name). O Postgres
// devolve 42703, a rota cai no catch e a cliente vê "Link inválido ou
// expirado" para um link recém-criado; a lojista, "Erro ao solicitar".
// O ciclo inteiro da prova de arte — o núcleo do Studio — estava morto,
// e o erro ficava escondido atrás de um catch genérico.
//
// O que este teste guarda: nenhuma consulta às tabelas de pedido cita a
// coluna fantasma.
// ============================================================
const fs = require('fs');
const path = require('path');

const ROTAS = [
  'src/routes/studioApprovalPublic.js',
  'src/routes/studioKdsApproval.js',
  'src/routes/studioTrackPublic.js',
  'src/routes/studioQuotePublic.js',
  'src/routes/studioStorefront.js',
];

describe('a coluna fantasma customer_data', () => {
  test.each(ROTAS)('%s não a consulta', (rel) => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(fonte).not.toMatch(/\bo\.customer_data\b/);
  });

  test('a página pública lê o total pelo nome que a tabela tem (total, não total_amount)', () => {
    // digital_orders guarda `total`; `total_amount` é da view studio_orders.
    // A consulta foi validada contra o banco em 04/09/2026.
    const fonte = fs.readFileSync(
      path.join(__dirname, '..', 'src/routes/studioApprovalPublic.js'), 'utf8');
    expect(fonte).toContain('o.total AS total_amount');
    expect(fonte).not.toMatch(/o.total_amount/);
  });

  test('a página pública lê o nome do pedido direto', () => {
    const fonte = fs.readFileSync(
      path.join(__dirname, '..', 'src/routes/studioApprovalPublic.js'), 'utf8');
    expect(fonte).toMatch(/o\.customer_name,/);
  });
});
