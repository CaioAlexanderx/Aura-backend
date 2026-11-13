// ============================================================
// Banco de mentira do relatório de Produtos (services/relatorioProdutos.js).
//
// Um grupo de duas lojas inventadas — Matriz (A) e Filial (B). O relógio é
// 13/11/2026 (sexta), 12h em Brasília; o período padrão vai de 15/10 a
// 13/11. A Matriz abriu nos 20 últimos dias (25/10 a 13/11, todos os dias da
// semana); a Filial, nos 30.
//
// Catálogo (Matriz, salvo dito):
//   Calça Jeans Reta  grade P/M/G, custo 40, preço 100; estoque 10 / 0 / 30
//                     P: 10 vendidas por 1.000 (custo 400)
//                     M: 4 por 200 (desconto grande; custo 160) — e zerou
//                     G: 2 por 200 (custo 80)
//                     + 1 vendida numa variante hoje desativada (90, custo 40)
//   Vestido Linho     sem custo, preço 150, estoque 5; 3 vendidos por 450
//   Meia Soquete      compartilhada, cadastrada na Filial; custo 5, preço 20,
//                     estoque 100; a Matriz vendeu 20 (400), a Filial 30 (600)
//   Cinto Trançado    custo 30, preço 80, estoque 12; última venda 01/08
//   Caneca Nova       custo 10, preço 50, estoque 8; cadastrada em 10/11, nunca vendeu
//   Bolsa Palha       só da Filial; custo 60, preço 150, estoque 3; 2 por 300
//
// As linhas saem no formato do node-postgres: NUMERIC como string.
// ============================================================
'use strict';

const A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const B = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const HOJE = '2026-11-13';
const AGORA = new Date('2026-11-13T15:00:00.000Z');

const P = {
  calca: 'cccccccc-0000-4000-8000-000000000001',
  vestido: 'cccccccc-0000-4000-8000-000000000002',
  meia: 'cccccccc-0000-4000-8000-000000000003',
  cinto: 'cccccccc-0000-4000-8000-000000000004',
  caneca: 'cccccccc-0000-4000-8000-000000000005',
  bolsa: 'cccccccc-0000-4000-8000-000000000006',
};
const V = {
  p: 'dddddddd-0000-4000-8000-000000000001',
  m: 'dddddddd-0000-4000-8000-000000000002',
  g: 'dddddddd-0000-4000-8000-000000000003',
  antiga: 'dddddddd-0000-4000-8000-000000000009',
};
const CAT_ROUPAS = 'eeeeeeee-0000-4000-8000-000000000001';

function item(extra) {
  return {
    variant_id: null, company_id: A, grupo_id: A, loja: 'Loja Matriz', is_group_shared: false, is_active: true,
    variante: null, sku: null, sku_suffix: null, barcode_produto: null, barcode: null, unidade: 'un',
    marca: null, categoria_id: CAT_ROUPAS, categoria: 'Roupas', cadastrado_em: '2026-03-01',
    ...extra,
  };
}

const calca = (variant_id, variante, estoque) => item({
  product_id: P.calca, variant_id, variante, nome: 'Calça Jeans Reta', sku: 'CJR', sku_suffix: variante,
  barcode: `78900000000${variante === 'P' ? 1 : variante === 'M' ? 2 : 3}`, marca: 'Marca Teste',
  preco_produto: '100.00', preco: '100.00', estoque, custo: '40.0000',
});

const CATALOGO_A = [
  calca(V.p, 'P', '10.000'),
  calca(V.m, 'M', '0.000'),
  calca(V.g, 'G', '30.000'),
  item({ product_id: P.vestido, nome: 'Vestido Linho', preco_produto: '150.00', preco: '150.00', estoque: '5.000', custo: null }),
  item({
    product_id: P.meia, company_id: B, loja: 'Loja Filial', is_group_shared: true, nome: 'Meia Soquete',
    categoria_id: null, categoria: 'Acessórios', preco_produto: '20.00', preco: '20.00', estoque: '100.000', custo: '5.00',
  }),
  item({ product_id: P.cinto, nome: 'Cinto Trançado', preco_produto: '80.00', preco: '80.00', estoque: '12.000', custo: '30.00', cadastrado_em: '2026-01-10' }),
  item({ product_id: P.caneca, nome: 'Caneca Nova', categoria: null, categoria_id: null, preco_produto: '50.00', preco: '50.00', estoque: '8.000', custo: '10.00', cadastrado_em: '2026-11-10' }),
];
const BOLSA = item({
  product_id: P.bolsa, company_id: B, loja: 'Loja Filial', nome: 'Bolsa Palha', categoria: 'Acessórios', categoria_id: null,
  preco_produto: '150.00', preco: '150.00', estoque: '3.000', custo: '60.00',
});

const venda = (product_id, variant_id, vendidos, faturamento, cmv, saida, ultima_venda) => ({
  product_id, variant_id, vendidos: String(vendidos), faturamento: String(faturamento), cmv: String(cmv),
  saida: String(saida), ultima_venda,
});

// Na loja A: o que é dinheiro conta só a Matriz; a saída da Meia conta o grupo.
const VENDAS_A = [
  venda(P.calca, V.p, 10, '1000.00', '400.00', 10, '2026-11-12'),
  venda(P.calca, V.m, 4, '200.00', '160.00', 4, '2026-11-13'),
  venda(P.calca, V.g, 2, '200.00', '80.00', 2, '2026-11-01'),
  venda(P.calca, V.antiga, 1, '90.00', '40.00', 1, '2026-10-20'),
  venda(P.vestido, null, 3, '450.00', '0', 3, '2026-11-11'),
  venda(P.meia, null, 20, '400.00', '100.00', 50, '2026-11-13'),
  // Venda antiga (fora do período), só para o último dia vendido.
  venda(P.cinto, null, 0, '0', '0', 0, '2026-08-01'),
];
const VENDAS_GRUPO = [
  ...VENDAS_A.filter((v) => v.product_id !== P.meia),
  venda(P.meia, null, 50, '1000.00', '250.00', 50, '2026-11-13'),
  venda(P.bolsa, null, 2, '300.00', '120.00', 2, '2026-11-05'),
];

const diasSeguidos = (fim, n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 10, 13) - i * 86400000).toISOString().slice(0, 10)).reverse();
const DIAS_A = diasSeguidos(HOJE, 20);
const DIAS_B = diasSeguidos(HOJE, 30);
const DIAS = [
  ...DIAS_A.map((dia) => ({ company_id: A, grupo_id: A, dia })),
  ...DIAS_B.map((dia) => ({ company_id: B, grupo_id: A, dia })),
];

/**
 * Liga o banco de mentira num jest.fn (db.query).
 * @param {object} [o]
 * @param {object} [o.membro]   linha de company_members (permissions...) — sem ela, dono
 * @param {object} [o.membroB]  permissões na Filial (consolidado)
 */
function ligar(query, { membro = null, membroB = null } = {}) {
  query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    let rows = [];
    if (/SELECT 'owner' AS role/.test(s)) rows = [{ role: membro ? (membro.role_label || 'Colaborador') : 'owner' }];
    else if (/cm\.role_label, cm\.permissions\s+FROM companies c/.test(s)) {
      rows = [membro ? { is_owner: false, role_label: membro.role_label || 'Colaborador', permissions: membro.permissions } : { is_owner: true, role_label: null, permissions: null }];
    } else if (/AS alcanca/.test(s)) {
      const linha = (id, m) => (m
        ? { id, is_owner: false, role_label: m.role_label || 'Colaborador', permissions: m.permissions, alcanca: m.alcanca !== false }
        : { id, is_owner: true, role_label: null, permissions: null, alcanca: true });
      rows = [linha(A, membro), linha(B, membroB || membro)];
    } else if (/FROM products p\s+JOIN companies c/.test(s)) {
      const empresas = params[0];
      rows = empresas.includes(B) ? [...CATALOGO_A, BOLSA] : CATALOGO_A;
    } else if (/WITH v AS/.test(s)) {
      rows = params[0].includes(B) ? VENDAS_GRUPO : VENDAS_A;
    } else if (/GROUP BY 1, 2, 3/.test(s)) {
      rows = DIAS;
    }
    return Promise.resolve({ rows });
  });
}

const chamadas = (query, re) => query.mock.calls.filter((c) => re.test(String(c[0] || '')));

module.exports = {
  A, B, USER, HOJE, AGORA, P, V, CAT_ROUPAS,
  CATALOGO_A, BOLSA, VENDAS_A, VENDAS_GRUPO, DIAS, DIAS_A, DIAS_B,
  ligar, chamadas,
};
