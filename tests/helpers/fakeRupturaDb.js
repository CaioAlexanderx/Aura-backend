// ============================================================
// Banco de mentira de "O que vai faltar" (services/ruptura.js).
//
// Um grupo de duas lojas inventadas — Matriz (A) e Filial (B) — e uma loja
// avulsa (C). O relógio é 13/10/2026, uma terça; a janela de 14 dias vai de
// 29/09 a 12/10. A Matriz abre de segunda a sábado (12 dias na janela); a
// Filial abre todo dia (14).
//
// As linhas saem no formato do node-postgres: NUMERIC como string.
// ============================================================
'use strict';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const C = 'aaaaaaaa-0000-4000-8000-000000000003';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const HOJE = '2026-10-13';
const AGORA = new Date('2026-10-13T15:00:00.000Z'); // 12h em Brasília

const JANELA = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 29 + i)).toISOString().slice(0, 10));
const domingo = (ymd) => new Date(ymd + 'T00:00:00Z').getUTCDay() === 0;
const DIAS_A = JANELA.filter((d) => !domingo(d));
const DIAS_B = JANELA;

const pid = (n) => `cccccccc-0000-4000-8000-00000000000${n}`;
const vid = (n) => `dddddddd-0000-4000-8000-00000000000${n}`;

function linha(extra) {
  return {
    variant_id: null, company_id: A, grupo_id: A, loja: 'Boutique Aurora — Matriz', is_group_shared: false,
    variante: null, sku: null, sku_suffix: null, barcode: null, unidade: 'un',
    ultima_venda: '2026-10-12T19:10:00.000Z',
    ...extra,
  };
}

// Vestido: 24 vendidos em 12 dias abertos = 2/dia, 10 no estoque → acaba 17/10.
const VESTIDO = linha({
  product_id: pid(1), variant_id: vid(1), nome: 'Vestido Midi Canelado', variante: 'Preto / M',
  barcode: '7890000000011', sku: 'VMC', sku_suffix: 'PRETO-M',
  preco: '129.90', estoque: '10.000', unidades: '24.000',
});
// Cinto: 2/dia, 60 no estoque → acaba 16/11, antes de 30/11.
const CINTO = linha({
  product_id: pid(2), nome: 'Cinto Couro Fivela Dourada', sku: 'CCF-01',
  preco: '79.90', estoque: '60.000', unidades: '24.000',
});
// Calça: 0,5/dia, 40 no estoque → passa de 30/11 com folga.
const CALCA = linha({
  product_id: pid(3), variant_id: vid(3), nome: 'Calça Jeans Wide Leg', variante: '40',
  barcode: '7890000000035', preco: '159.90', estoque: '40.000', unidades: '6.000',
});
// Meia: estoque compartilhado, cadastrado na Filial e vendido nas duas lojas.
const MEIA = linha({
  product_id: pid(4), company_id: B, loja: 'Boutique Aurora — Filial', is_group_shared: true,
  nome: 'Meia Cano Curto Kit 3 Pares', barcode: '7890000000042',
  preco: '24.90', estoque: '30.000', unidades: '16.000',
});
// Blusa: vendeu 12 na janela e já zerou.
const BLUSA = linha({
  product_id: pid(5), variant_id: vid(5), nome: 'Blusa Básica Algodão', variante: 'Branco / P',
  sku: 'BBA', sku_suffix: 'BRANCO-P', preco: '59.90', estoque: '0.000', unidades: '12.000',
});
// Só da Filial: a Matriz não vê; o consolidado e o painel veem.
const BOLSA = linha({
  product_id: pid(6), company_id: B, loja: 'Boutique Aurora — Filial',
  nome: 'Bolsa Tiracolo Caramelo', barcode: '7890000000066',
  preco: '189.90', estoque: '5.000', unidades: '7.000',
});
// Loja avulsa, com folga: não tem nada em risco.
const CANECA = linha({
  product_id: pid(7), company_id: C, grupo_id: C, loja: 'Empório do Bairro',
  nome: 'Caneca Esmaltada 300ml', preco: '39.90', estoque: '500.000', unidades: '4.000',
});

const dias = (company, grupo, lista) => lista.map((dia) => ({ company_id: company, grupo_id: grupo, dia }));
const DIAS_GRUPO = [...dias(A, A, DIAS_A), ...dias(B, A, DIAS_B)];
const DIAS_C = dias(C, C, ['2026-10-02', '2026-10-03', '2026-10-09', '2026-10-10']);

// O que o banco devolveria conforme as empresas de referência ($3) e o escopo.
function itensPara(sql, empresas) {
  const proprio = !/is_group_shared = true AND p\.company_id IN/.test(sql);
  const todas = [VESTIDO, CINTO, CALCA, MEIA, BLUSA, BOLSA, CANECA];
  return todas.filter((l) => empresas.includes(l.company_id)
    || (!proprio && l.is_group_shared && empresas.some((e) => [A, B].includes(e)) && [A, B].includes(l.company_id)));
}
function diasPara(empresas) {
  return [
    ...(empresas.some((e) => [A, B].includes(e)) ? DIAS_GRUPO : []),
    ...(empresas.includes(C) ? DIAS_C : []),
  ];
}

const EMPRESAS_DO_PAINEL = [
  { company_id: A, nome: 'Boutique Aurora — Matriz', telefone: '11999990001', status: 'active' },
  { company_id: B, nome: 'Boutique Aurora — Filial', telefone: null, status: 'active' },
  { company_id: C, nome: 'Empório do Bairro', telefone: '11999990003', status: 'trial' },
];

/**
 * Liga o banco de mentira num jest.fn (db.query).
 * @param {object} [opcoes]
 * @param {string[]} [opcoes.alcanca] lojas do grupo que o usuário alcança (padrão: A e B)
 */
function ligar(query, { alcanca = [A, B] } = {}) {
  query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    let rows = [];
    if (/SELECT 'owner' AS role/.test(s)) rows = [{ role: 'owner' }];
    else if (/AS alcanca/.test(s)) rows = [A, B].map((id) => ({ id, alcanca: alcanca.includes(id) }));
    else if (/WITH vendas AS/.test(s)) rows = itensPara(s, params[2]);
    else if (/GROUP BY 1, 2, 3/.test(s)) rows = diasPara(params[2]);
    else if (/FROM companies c\s+LEFT JOIN users u/.test(s)) rows = EMPRESAS_DO_PAINEL;
    return Promise.resolve({ rows });
  });
}

const chamadas = (query, re) => query.mock.calls.filter((c) => re.test(String(c[0] || '')));

module.exports = {
  A, B, C, USER, HOJE, AGORA, JANELA, DIAS_A, DIAS_B, DIAS_GRUPO,
  VESTIDO, CINTO, CALCA, MEIA, BLUSA, BOLSA, CANECA,
  ligar, chamadas,
};
