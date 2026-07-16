// ============================================================
// Fixtures S1.2 — espelham a matriz tributária REAL da empresa-piloto
// (Davi Calçados: Simples Nacional, série 1, NCMs de calçados/bolsas
// minerados de products em 10/06/2026). CNPJ/IE fictícios de teste.
// ============================================================
'use strict';

const companyDavi = {
  id: '00000000-0000-4000-8000-000000000001',
  cnpj: '11222333000181',           // fictício válido p/ teste
  legal_name: 'Davi Calcados Ltda',
  trade_name: 'Davi Calçados Matriz',
  address_street: 'Rua Quinze de Novembro',
  address_number: '123',
  address_neighborhood: 'Centro',
  address_city: 'Jacareí',
  address_state: 'SP',
  address_zip: '12327000',
  ibge_code: '3524402',             // Jacareí-SP
  inscricao_estadual: '111222333444',
  phone: '(12) 3951-0000',
  email: 'fiscal@davicalcados.com.br',
  tax_regime: 'simples_nacional',
};

// NCMs reais da piloto: 64022000 (rasteirinha), 64041100 (tênis),
// 42029220 (bolsa), 61159500 (meia)
const itemsVendaTipica = [
  { product_id: 'a1', code: 'a1', name: 'Azaleia Rasteirinha Amarelo', ncm: '64022000',
    cfop: '5102', unit: 'PAR', quantity: 1, price: 89.99 },
  { product_id: 'b2', code: 'b2', name: 'Activita Tênis Gaspea Preto - 40', ncm: '64041100',
    cfop: '5102', unit: 'PAR', quantity: 2, price: 159.99, discount: 10 },
  { product_id: 'c3', code: 'c3', name: 'Bolsa Arezzo Croco', ncm: '42029220',
    cfop: '5102', unit: 'UN', quantity: 1, price: 149.99 },
];
// total: 89.99 + 319.98 + 149.99 = 559.96 − 10 = 549.96

const paymentsMulti = [
  { method: '17', value: 300, indPag: 0 },              // PIX
  { method: '01', value: 150, change: 0.04, indPag: 0 }, // dinheiro c/ troco
  { method: '05', value: 99.96, indPag: 1 },             // crediário (a prazo)
];

const nfceDataVendaTipica = {
  items: itemsVendaTipica,
  payments: paymentsMulti,
  total_value: 549.96,
  serie: 1,
  numero: 231,
  recipient_cpf: '39053344705',     // CPF de teste (válido por DV)
  recipient_name: 'Cliente Teste',
};

module.exports = { companyDavi, itemsVendaTipica, paymentsMulti, nfceDataVendaTipica };
