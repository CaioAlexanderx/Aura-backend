// ============================================================
// AURA VENDAS — "editar lancamento de venda nao lista os produtos" (28/08/2026)
//
// O RELATO (Eryca): abrir "Editar lancamento" de uma venda e tentar tirar um
// produto. A secao de mercadorias simplesmente nao aparecia.
//
// A CAUSA: a venda era 100% no crediario. pdv.js so insere a receita
// 'pdv-sale-<id>' quando entrou dinheiro (cashAmount > 0) — numa venda fiada
// isso e zero, entao a UNICA linha financeira dela e o 'A Receber' com chave
// 'pdv-credit-receivable-<id>'. O resolvedor de vinculo so casava 'pdv-sale-',
// devolvia null, a rota respondia has_sale=false e o front escondia os itens.
// Confirmado em producao: venda 223b1c59… (R$ 1.074,60, 7 itens, 3 parcelas)
// tinha 0 transactions 'pdv-sale-' e 1 'pdv-credit-receivable-'.
//
// Este arquivo cobre a semantica do vinculo (sem banco) e dois guarda-corpos
// estaticos que ja custaram caro:
//   1. FOR UPDATE puro num LEFT JOIN -> Postgres 0A000. O DELETE de item vivia
//      quebrado pra TODA venda por causa disso.
//   2. LIKE com padrao montado em runtime no subselect de transaction_id ->
//      perde o indice de idempotency_key (medido em prod: 98ms/30 linhas
//      contra 2.7ms com condicao de range).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveSaleLink, extractSaleId } = require('../src/utils/saleLink');

const SALE_ID = '223b1c59-1770-47c0-a90d-6dcb036d0f7b';

describe('resolveSaleLink — de qual venda o lancamento veio', () => {
  it('reconhece a receita paga na hora como origem pdv', () => {
    expect(resolveSaleLink('pdv-sale-' + SALE_ID)).toEqual({ saleId: SALE_ID, source: 'pdv' });
  });

  it('reconhece o A Receber do crediario (o bug do relato)', () => {
    expect(resolveSaleLink('pdv-credit-receivable-' + SALE_ID))
      .toEqual({ saleId: SALE_ID, source: 'credit' });
  });

  it('reconhece o saldo remanescente de pagamento parcial (-rest-<ts>)', () => {
    const key = 'pdv-credit-receivable-' + SALE_ID + '-rest-1756400000000';
    expect(resolveSaleLink(key)).toEqual({ saleId: SALE_ID, source: 'credit' });
  });

  it('NAO confunde a taxa da maquininha com a venda', () => {
    // pdv-card-fee e despesa propria: remover item por ela mexeria na linha errada.
    expect(resolveSaleLink('pdv-card-fee-' + SALE_ID)).toBeNull();
  });

  it('NAO abre a troca por aqui (ela tem fluxo Devolveu/Levou proprio)', () => {
    expect(resolveSaleLink('pdv-troca-v2-' + SALE_ID)).toBeNull();
  });

  it('ignora chave ausente, vazia ou de outro dominio', () => {
    expect(resolveSaleLink(null)).toBeNull();
    expect(resolveSaleLink(undefined)).toBeNull();
    expect(resolveSaleLink('')).toBeNull();
    expect(resolveSaleLink('credit-payment-' + SALE_ID)).toBeNull();
    expect(resolveSaleLink('refund-' + SALE_ID + '-abc')).toBeNull();
    expect(resolveSaleLink('pdv-credit-receivable-nao-e-uuid')).toBeNull();
    expect(resolveSaleLink({ nope: true })).toBeNull();
  });

  it('extractSaleId devolve so o id, mantendo o contrato antigo', () => {
    expect(extractSaleId('pdv-sale-' + SALE_ID)).toBe(SALE_ID);
    expect(extractSaleId('pdv-credit-receivable-' + SALE_ID)).toBe(SALE_ID);
    expect(extractSaleId('nada-a-ver')).toBeNull();
  });
});

// ─── Guarda-corpos estaticos ───────────────────────────────────────────

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Os guarda-corpos olham o SQL, nao a prosa: sem tirar os comentarios, um
// bloco que EXPLICA o bug faria o teste reprovar o conserto.
const semComentarios = (src) => src.replace(/^\s*\/\/.*$/gm, '');

describe('transactionSale.js — o DELETE de item nao pode voltar a quebrar', () => {
  const src = readSrc('src/routes/transactionSale.js');

  it('nao trava o LEFT JOIN inteiro com FOR UPDATE (Postgres 0A000)', () => {
    // 'FOR UPDATE' sem lista de tabelas, num SELECT que tem LEFT JOIN products,
    // e recusado com "FOR UPDATE cannot be applied to the nullable side of an
    // outer join" — o handler inteiro virava 500. A forma correta trava so o
    // lado interno: FOR UPDATE OF si, s.
    const sql = semComentarios(src);
    const trechos = sql.match(/LEFT JOIN products[\s\S]{0,400}?FOR UPDATE[^\n`]*/g) || [];
    expect(trechos.length).toBeGreaterThan(0);
    for (const t of trechos) {
      expect(t).toMatch(/FOR UPDATE\s+OF\s+si/);
    }
  });

  it('devolucao no crediario passa pelo motor oficial, nao apaga o sale_item', () => {
    // Apagar a linha aqui deixaria debit do ledger, parcelas e credit_used de
    // pe: o cliente seguiria devendo por um produto que voltou pra prateleira.
    expect(src).toContain("require('../services/credit/refund')");
    expect(src).toMatch(/link\.source === 'credit'[\s\S]{0,1200}refundCreditSale\(/);
  });

  it('bloqueia adicionar produto em venda de crediario ja fechada', () => {
    // Somar item na mao aumentaria o recebivel SEM aumentar a divida do ledger.
    expect(src).toMatch(/link\.source === 'credit'[\s\S]{0,400}AppError\(/);
  });
});

describe('transaction_id da venda — fallback pro crediario sem perder o indice', () => {
  const arquivos = ['src/routes/sales.js', 'src/routes/meAggregates.js'];

  it.each(arquivos)('%s casa tambem o A Receber do crediario', (rel) => {
    const src = semComentarios(readSrc(rel));
    expect(src).toContain("'pdv-credit-receivable-' || s.id");
  });

  it.each(arquivos)('%s usa range, nunca LIKE com padrao de runtime', (rel) => {
    const src = semComentarios(readSrc(rel));
    // LIKE 'prefixo' || s.id || '%' nao usa uq_transactions_idempotency_key:
    // o planner precisa do padrao em tempo de plano. Vira bitmap scan por linha.
    expect(src).not.toMatch(/LIKE\s+'pdv-credit-receivable-'\s*\|\|/);
    expect(src).toMatch(/idempotency_key\s*>=\s*'pdv-credit-receivable-'\s*\|\|/);
    expect(src).toMatch(/idempotency_key\s*<\s*'pdv-credit-receivable-'\s*\|\|/);
  });
});
