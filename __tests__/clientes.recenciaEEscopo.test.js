// ============================================================
// AURA CLIENTES — recencia no balcao + a lista que nao pode sumir
//
// Dois achados do QA de usabilidade (29/08/2026):
//
// (1) O seletor de cliente do PDV abria em ordem alfabetica (Abbey,
//     Abdel, Adamo...). Com o cliente na frente do balcao, a ordenacao
//     util e "quem foi atendido por ultimo". Pra isso last_purchase_at
//     precisa ser verdade -- e nao era: a trigger gravava NOW() fixo,
//     entao CANCELAR uma venda marcava o cliente como atendido agora e
//     venda lancada com data retroativa virava "hoje".
//
// (2) A tela /clientes mostrava "Total de clientes: 0" com o banco cheio
//     de clientes. A tela nao tem como distinguir "nenhum cliente" de
//     "a lista morreu no caminho" -- os dois desenham zero. Este arquivo
//     fecha os dois caminhos do backend que produzem lista vazia com
//     HTTP 200 / 500 sem o dado ter sumido.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

function fonte(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('last_purchase_at — a coluna precisa dizer a verdade', () => {
  const m311 = fonte('migrations/311_customers_last_purchase_confiavel.sql');

  it('deriva de MAX(created_at) das vendas, nao de NOW()', () => {
    // NOW() fixo era o bug: a coluna media "quando alguem mexeu nesta
    // venda", nao "quando o cliente comprou".
    const fn = m311.slice(m311.indexOf('CREATE OR REPLACE FUNCTION public.update_customer_metrics'));
    expect(fn).toMatch(/last_purchase_at = \(SELECT MAX\(created_at\) FROM sales/);
    expect(fn).toMatch(/first_purchase_at = \(SELECT MIN\(created_at\) FROM sales/);
    expect(fn).not.toMatch(/last_purchase_at\s*=\s*NOW\(\)/);
  });

  it('cancelamento nao conta como atendimento', () => {
    // A trigger dispara em UPDATE OF status desde a 137. Sem o filtro,
    // cancelar a unica venda de um cliente o jogava pro topo do balcao.
    const fn = m311.slice(m311.indexOf('CREATE OR REPLACE FUNCTION public.update_customer_metrics'));
    const ocorrencias = fn.match(/COALESCE\(status, 'completed'\) != 'cancelled'/g) || [];
    // total_purchases, total_spent, last_purchase_at, first_purchase_at
    expect(ocorrencias.length).toBe(4);
  });

  it('corrige as datas ja envenenadas no banco', () => {
    expect(m311).toMatch(/UPDATE customers c/);
    expect(m311).toMatch(/IS DISTINCT FROM/);
  });

  it('cria o indice que o sort=recent usa', () => {
    // Sem indice, ordenar por recencia numa base de milhares de clientes
    // vira sort em disco a cada abertura do seletor.
    expect(m311).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_customers_last_purchase[\s\S]{0,120}last_purchase_at DESC NULLS LAST/
    );
  });

  it('mantem o escopo por empresa que a 137 ja usava', () => {
    // Mexer no escopo aqui mudaria total_spent, que alimenta LTV e
    // ranking. Nao e o assunto deste PR.
    const fn = m311.slice(m311.indexOf('CREATE OR REPLACE FUNCTION public.update_customer_metrics'));
    expect(fn).toMatch(/company_id = target_company/);
  });
});

describe('?sort=recent — quem foi atendido por ultimo primeiro', () => {
  const rotas = ['src/routes/customers.js', 'src/routes/meAggregates.js'];

  it.each(rotas)('%s ordena no BANCO, com NULLS LAST', (rel) => {
    // NULLS LAST: quem nunca comprou nao pode ocupar o topo do balcao.
    // No banco e nao no app porque o app so recebe a primeira pagina --
    // ordenar o que chegou poria no topo o mais recente ENTRE OS
    // PRIMEIROS ALFABETICAMENTE.
    const src = fonte(rel);
    expect(src).toMatch(/last_purchase_at DESC NULLS LAST, (\$\{a\}|[\w.]*)name ASC/);
  });

  it.each(rotas)('%s mantem o alfabetico como default', (rel) => {
    // A tela de Clientes e uma agenda: procurar pelo nome faz sentido
    // la. Trocar o default mudaria uma tela que ninguem reclamou.
    const src = fonte(rel);
    expect(src).toMatch(/ORDER BY (\$\{a\}|[\w.]*)name ASC/);
  });

  it('o sort e whitelist fechada — o valor entra concatenado no SQL', () => {
    const src = fonte('src/routes/customers.js');
    expect(src).toMatch(/switch \(String\(sort \|\| ''\)\.toLowerCase\(\)\)/);
    expect(src).toMatch(/default:\s*\n\s*return `ORDER BY \$\{a\}name ASC`/);
  });

  it.each(rotas)('%s expoe last_purchase_at no JSON', (rel) => {
    // Sem o campo o app nao tem como mostrar "ultima compra" nem
    // ordenar por conta propria numa lista ja carregada.
    expect(fonte(rel)).toMatch(/last_purchase_at: r\.last_purchase_at/);
  });

  it.each(rotas)('%s nao removeu last_purchase (contrato antigo)', (rel) => {
    expect(fonte(rel)).toMatch(/last_purchase: r\.last_purchase_at/);
  });
});

describe('a lista de clientes nao pode sumir em silencio', () => {
  it('a empresa pedida entra sempre no proprio escopo', () => {
    // owner_id NULL faz `WHERE owner_id = (SELECT owner_id ...)` nao
    // casar com nada, e is_active false/NULL exclui a empresa da propria
    // lista. Nos dois casos a rota respondia 200 com total: 0 -- dado no
    // banco, tela zerada, nenhum erro pra rastrear. Quem chegou aqui ja
    // passou por requireCompanyAccess, que nao olha nenhum dos dois.
    const src = fonte('src/utils/ownerScope.js');
    expect(src).toMatch(/if \(!ids\.includes\(companyId\)\) ids\.push\(companyId\)/);
  });

  it('companyId ausente devolve escopo vazio, nao query com NULL', () => {
    const src = fonte('src/utils/ownerScope.js');
    expect(src).toMatch(/if \(!companyId\) return \[\]/);
  });

  it('o saldo do crediario e enfeite: sem a view, lista mesmo assim', () => {
    // customer_credit_balances some em banco restaurado sem as migrations
    // de crediario. 42P01 no LEFT JOIN virava 500 e a tela desenhava
    // "Total de clientes: 0" -- indistinguivel de nao ter cliente.
    const src = fonte('src/routes/customers.js');
    expect(src).toMatch(/creditErr\.code !== '42P01' && creditErr\.code !== '42703'/);
    expect(src).toMatch(/selectCustomers\(false\)/);
  });
});
