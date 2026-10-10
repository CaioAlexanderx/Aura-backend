// ============================================================
// Carnê: "O que foi comprado" — seleção dos débitos por carnê (10/10/2026)
//
// A parcela muitas vezes não aponta para a venda (sale_id nulo), então a
// lista de produtos sai do DÉBITO do razão. O que estes testes travam:
//   1. o alvo é a soma das parcelas NÃO canceladas do grupo;
//   2. anda do débito mais novo para o mais antigo até cobrir o alvo, e o
//      débito que cruza o alvo entra inteiro;
//   3. débito sem venda vira uma linha com a descrição do lançamento;
//   4. grupo sem parcela não tem lista;
//   5. "Sem carnê" (account_id nulo) e carnê não se misturam.
// ============================================================
const {
  NO_ACCOUNT_KEY,
  groupTarget,
  selectDebitsForTarget,
  buildPurchaseLines,
  purchasesByGroup,
} = require('../../src/services/credit/carnePurchases');

const dia = (d) => new Date(`2026-09-${String(d).padStart(2, '0')}T15:00:00Z`);
const debito = (id, d, amount, extra = {}) => ({
  id, amount: String(amount), created_at: dia(d), sale_id: null, account_id: null, notes: null, ...extra,
});
const parcela = (amount, extra = {}) => ({ amount_due: String(amount), status: 'pending', account_id: null, ...extra });

describe('groupTarget — alvo do grupo', () => {
  test('soma amount_due e ignora parcela cancelada', () => {
    expect(groupTarget([parcela(100), parcela(50.5, { status: 'paid' }), parcela(999, { status: 'cancelled' })])).toBe(150.5);
  });

  test('grupo vazio tem alvo zero', () => {
    expect(groupTarget([])).toBe(0);
    expect(groupTarget(undefined)).toBe(0);
  });
});

describe('selectDebitsForTarget — do mais novo para o mais antigo', () => {
  const debitos = [debito('antigo', 1, 300), debito('meio', 10, 200), debito('novo', 20, 100)];

  test('alvo exato: para no débito que fecha a conta', () => {
    const r = selectDebitsForTarget(debitos, 300);
    expect(r.map(d => d.id)).toEqual(['meio', 'novo']); // cronológico
  });

  test('cruzando o alvo: o débito que cruza entra inteiro', () => {
    const r = selectDebitsForTarget(debitos, 150);
    expect(r.map(d => d.id)).toEqual(['meio', 'novo']);
  });

  test('alvo menor que o débito mais novo: só ele', () => {
    expect(selectDebitsForTarget(debitos, 80).map(d => d.id)).toEqual(['novo']);
  });

  test('tolerância de centavos: 99,999 fecha um alvo de 100', () => {
    const r = selectDebitsForTarget([debito('a', 1, 500), debito('b', 2, 99.999)], 100);
    expect(r.map(d => d.id)).toEqual(['b']);
  });

  test('débitos não cobrem o alvo (juros de renegociação): entram todos', () => {
    expect(selectDebitsForTarget(debitos, 5000).map(d => d.id)).toEqual(['antigo', 'meio', 'novo']);
  });

  test('alvo zero ou sem débito: lista vazia', () => {
    expect(selectDebitsForTarget(debitos, 0)).toEqual([]);
    expect(selectDebitsForTarget([], 100)).toEqual([]);
    expect(selectDebitsForTarget(undefined, 100)).toEqual([]);
  });

  test('a ordem de entrada não importa, e débito zerado é ignorado', () => {
    const embaralhado = [debitos[2], debito('zero', 25, 0), debitos[0], debitos[1]];
    expect(selectDebitsForTarget(embaralhado, 300).map(d => d.id)).toEqual(['meio', 'novo']);
  });

  test('não altera o array recebido', () => {
    const copia = debitos.slice();
    selectDebitsForTarget(debitos, 300);
    expect(debitos).toEqual(copia);
  });
});

describe('buildPurchaseLines — linhas do papel', () => {
  test('débito com venda: uma linha por item, com a data do débito', () => {
    const d = debito('d1', 13, 280, { sale_id: 's1' });
    const linhas = buildPurchaseLines([d], {
      s1: [
        { product_name: 'Vans Hylane 40/41', quantity: '1', unit_price: '120.00', total_price: '120.00' },
        { product_name: 'Slide Alta 40/41', quantity: '2', unit_price: '80.00', total_price: '160.00' },
      ],
    });
    expect(linhas).toEqual([
      { date: d.created_at, description: 'Vans Hylane 40/41', quantity: 1, amount: 120, manual: false },
      { date: d.created_at, description: 'Slide Alta 40/41', quantity: 2, amount: 160, manual: false },
    ]);
  });

  test('débito manual: uma linha com a descrição de notes', () => {
    const d = debito('m1', 5, 75.5, { notes: '  Saldo do caderno antigo ' });
    expect(buildPurchaseLines([d], {})).toEqual([
      { date: d.created_at, description: 'Saldo do caderno antigo', quantity: null, amount: 75.5, manual: true },
    ]);
  });

  test('débito manual sem notes: "Lançamento manual"', () => {
    const [l] = buildPurchaseLines([debito('m2', 5, 40)], {});
    expect(l.description).toBe('Lançamento manual');
    expect(l.amount).toBe(40);
  });

  test('venda sem itens carregados: a compra não some, sai numa linha com o valor do débito', () => {
    const [l] = buildPurchaseLines([debito('d2', 5, 200, { sale_id: 's-sumiu' })], {});
    expect(l).toMatchObject({ description: 'Compra', quantity: null, amount: 200, manual: false });
  });

  test('item sem total_price usa unit_price x quantidade', () => {
    const [l] = buildPurchaseLines(
      [debito('d3', 5, 90, { sale_id: 's3' })],
      { s3: [{ product_name: 'Meia', quantity: '3', unit_price: '30.00', total_price: null }] },
    );
    expect(l.amount).toBe(90);
  });
});

describe('purchasesByGroup — um carnê não enxerga a compra do outro', () => {
  const CARNE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const CARNE_B = 'bbbbbbbb-0000-4000-8000-000000000002';

  test('account null vs. carnê: cada grupo só com os próprios débitos', () => {
    const r = purchasesByGroup({
      installments: [
        parcela(100, { account_id: CARNE_A }), parcela(100, { account_id: CARNE_A }),
        parcela(50),
      ],
      debits: [
        debito('a1', 1, 200, { account_id: CARNE_A, notes: 'do carne A' }),
        debito('n1', 2, 50, { notes: 'sem carne' }),
        debito('b1', 3, 999, { account_id: CARNE_B, notes: 'do carne B' }),
      ],
    });
    expect(Object.keys(r).sort()).toEqual([CARNE_A, NO_ACCOUNT_KEY].sort());
    expect(r[CARNE_A].lines.map(l => l.description)).toEqual(['do carne A']);
    expect(r[CARNE_A].target).toBe(200);
    expect(r[NO_ACCOUNT_KEY].lines.map(l => l.description)).toEqual(['sem carne']);
    expect(r[NO_ACCOUNT_KEY].total).toBe(50);
  });

  test('grupo sem parcela não tem lista, mesmo com débito', () => {
    const r = purchasesByGroup({
      installments: [parcela(100)],
      debits: [debito('b1', 3, 999, { account_id: CARNE_B }), debito('n1', 2, 100)],
    });
    expect(r[CARNE_B]).toBeUndefined();
    expect(r[NO_ACCOUNT_KEY]).toBeDefined();
  });

  test('grupo só com parcela cancelada (alvo zero) não tem lista', () => {
    const r = purchasesByGroup({
      installments: [parcela(100, { account_id: CARNE_A, status: 'cancelled' })],
      debits: [debito('a1', 1, 100, { account_id: CARNE_A })],
    });
    expect(r).toEqual({});
  });

  test('legado sem carnê: compra antiga já quitada fica fora, a que o cronograma cobra entra', () => {
    const r = purchasesByGroup({
      installments: [parcela(60, { status: 'paid' }), parcela(60), parcela(60)], // alvo 180
      debits: [
        debito('velha', 1, 500, { sale_id: 's-velha' }),
        debito('nova', 20, 180, { sale_id: 's-nova' }),
      ],
      itemsBySale: {
        's-velha': [{ product_name: 'Bota antiga', quantity: 1, total_price: 500 }],
        's-nova': [{ product_name: 'Tenis novo', quantity: 1, total_price: 180 }],
      },
    });
    expect(r[NO_ACCOUNT_KEY].lines.map(l => l.description)).toEqual(['Tenis novo']);
  });

  test('sem argumentos não lança', () => {
    expect(purchasesByGroup()).toEqual({});
  });
});
