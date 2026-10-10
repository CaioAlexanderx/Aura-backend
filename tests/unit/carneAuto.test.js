// ============================================================
// AURA. — Testes unitários: src/services/credit/carneAuto.js (10/10/2026)
//
// Um carnê por compra: nome automático "Compra de DD/MM" (dia em São Paulo),
// sufixo quando colide, e a criação que NUNCA derruba a venda.
// ============================================================

const {
  carneDayLabel, autoCarneName, dedupeCarneName,
  createAutoCarne, findCustomerCarne, cancelEmptyCarnes, withSavepoint,
} = require('../../src/services/credit/carneAuto');

const LOJA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const CLIENTE = '8fbde0b9-2ec0-4bc9-be58-f86c31465fa6';
const CARNE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

describe('carneDayLabel — dia em São Paulo', () => {
  test('dia puro (AAAA-MM-DD) não passa por fuso', () => {
    expect(carneDayLabel('2026-09-13')).toBe('13/09');
    expect(carneDayLabel('2026-01-01')).toBe('01/01');
  });

  test('instante em UTC vira o dia de São Paulo (venda às 22h de 13/09 é 13/09)', () => {
    // 01:30 UTC de 14/09 = 22:30 de 13/09 em São Paulo.
    expect(carneDayLabel(new Date('2026-09-14T01:30:00Z'))).toBe('13/09');
    expect(carneDayLabel('2026-09-14T03:00:00Z')).toBe('14/09');
  });

  test('vazio ou torto cai em hoje, sem lançar', () => {
    expect(carneDayLabel(null)).toMatch(/^\d{2}\/\d{2}$/);
    expect(carneDayLabel('nao-e-data')).toMatch(/^\d{2}\/\d{2}$/);
  });
});

describe('autoCarneName — nome e colisão', () => {
  test('sem carnê com o mesmo nome: "Compra de DD/MM"', () => {
    expect(autoCarneName('Compra', '2026-10-10', [])).toBe('Compra de 10/10');
    expect(autoCarneName('Lançamento', '2026-10-10', ['Compra de 10/10'])).toBe('Lançamento de 10/10');
  });

  test('segunda compra do dia ganha (2), a terceira (3)', () => {
    expect(autoCarneName('Compra', '2026-10-10', ['Compra de 10/10'])).toBe('Compra de 10/10 (2)');
    expect(autoCarneName('Compra', '2026-10-10', ['Compra de 10/10', 'Compra de 10/10 (2)'])).toBe('Compra de 10/10 (3)');
  });

  test('ocupa o primeiro número livre e ignora caixa/espaço', () => {
    expect(dedupeCarneName('Compra de 10/10', ['compra de 10/10 ', 'Compra de 10/10 (3)'])).toBe('Compra de 10/10 (2)');
  });
});

// Client que despacha por conteúdo do SQL e registra o que rodou.
function fakeClient(handler) {
  const query = jest.fn().mockImplementation((sql, params) => {
    const s = String(sql || '');
    const r = handler ? handler(s, params) : undefined;
    return r !== undefined ? r : Promise.resolve({ rows: [] });
  });
  return { query };
}
const sqls = (client) => client.query.mock.calls.map(c => String(c[0]));

describe('createAutoCarne', () => {
  test('cria dentro de SAVEPOINT, com o nome sem colisão', async () => {
    const client = fakeClient((s, p) => {
      if (/SELECT name FROM credit_accounts/i.test(s)) return Promise.resolve({ rows: [{ name: 'Compra de 13/09' }] });
      if (/INSERT INTO credit_accounts/i.test(s)) return Promise.resolve({ rows: [{ id: CARNE, name: p[2] }] });
    });
    const out = await createAutoCarne(client, { companyId: LOJA, customerId: CLIENTE, prefix: 'Compra', date: '2026-09-13' });

    expect(out).toEqual({ id: CARNE, name: 'Compra de 13/09 (2)' });
    const rodou = sqls(client);
    expect(rodou[0]).toBe('SAVEPOINT carne_auto');
    expect(rodou[rodou.length - 1]).toBe('RELEASE SAVEPOINT carne_auto');
    // Só carnê ABERTO conta para a colisão, e só desta empresa + cliente.
    const busca = client.query.mock.calls.find(c => /SELECT name FROM credit_accounts/i.test(c[0]));
    expect(busca[0]).toMatch(/status = 'open'/);
    expect(busca[1].slice(0, 2)).toEqual([LOJA, CLIENTE]);
  });

  test.each(['42P01', '42703', '23505'])('erro %s: volta ao savepoint e devolve null (a venda segue)', async (code) => {
    const client = fakeClient((s) => {
      if (/INSERT INTO credit_accounts/i.test(s)) return Promise.reject(Object.assign(new Error('falhou'), { code }));
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await createAutoCarne(client, { companyId: LOJA, customerId: CLIENTE });
    warn.mockRestore();

    expect(out).toBeNull();
    expect(sqls(client)).toContain('ROLLBACK TO SAVEPOINT carne_auto');
    expect(sqls(client)).not.toContain('RELEASE SAVEPOINT carne_auto');
  });

  test('sem cliente não toca no banco', async () => {
    const client = fakeClient();
    expect(await createAutoCarne(client, { companyId: LOJA, customerId: null })).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('findCustomerCarne', () => {
  test('id que não é UUID nem consulta: null', async () => {
    const client = fakeClient();
    expect(await findCustomerCarne(client, { companyId: LOJA, customerId: CLIENTE, accountId: "x' OR 1=1" })).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('confere empresa E cliente; tabela ausente devolve undefined (não deu para conferir)', async () => {
    const ok = fakeClient((s) => {
      if (/FROM credit_accounts/i.test(s)) return Promise.resolve({ rows: [{ id: CARNE, name: 'Carnê', status: 'open' }] });
    });
    expect(await findCustomerCarne(ok, { companyId: LOJA, customerId: CLIENTE, accountId: CARNE }))
      .toEqual({ id: CARNE, name: 'Carnê', status: 'open' });
    const consulta = ok.query.mock.calls.find(c => /FROM credit_accounts/i.test(c[0]));
    expect(consulta[1]).toEqual([CARNE, LOJA, CLIENTE]);

    const semTabela = fakeClient((s) => {
      if (/FROM credit_accounts/i.test(s)) return Promise.reject(Object.assign(new Error('x'), { code: '42P01' }));
    });
    expect(await findCustomerCarne(semTabela, { companyId: LOJA, customerId: CLIENTE, accountId: CARNE })).toBeUndefined();
  });
});

describe('cancelEmptyCarnes', () => {
  test('sem carnê na lista não toca no banco', async () => {
    const client = fakeClient();
    expect(await cancelEmptyCarnes(client, { companyId: LOJA, accountIds: [null, undefined] })).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('só marca o carnê sem lançamento e sem parcela viva', async () => {
    const client = fakeClient((s) => {
      if (/UPDATE credit_accounts/i.test(s)) return Promise.resolve({ rows: [{ id: CARNE }] });
    });
    expect(await cancelEmptyCarnes(client, { companyId: LOJA, accountIds: [CARNE, CARNE] })).toEqual([CARNE]);
    const upd = client.query.mock.calls.find(c => /UPDATE credit_accounts/i.test(c[0]));
    expect(upd[0]).toMatch(/status = 'cancelled'/);
    expect(upd[0]).toMatch(/NOT EXISTS[\s\S]*customer_credit_transactions/);
    expect(upd[0]).toMatch(/NOT EXISTS[\s\S]*credit_installments[\s\S]*status <> 'cancelled'/);
    expect(upd[1]).toEqual([[CARNE], LOJA]);
  });
});

describe('withSavepoint', () => {
  test('devolve o fallback informado quando o trecho falha', async () => {
    const client = fakeClient();
    const out = await withSavepoint(client, 'sp_teste', async () => {
      throw Object.assign(new Error('x'), { code: '42703' });
    }, 'reserva');
    expect(out).toBe('reserva');
    expect(sqls(client)).toEqual(['SAVEPOINT sp_teste', 'ROLLBACK TO SAVEPOINT sp_teste']);
  });
});
