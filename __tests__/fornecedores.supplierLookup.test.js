// ============================================================
// AURA. — Fase 1 fornecedores: achar-ou-criar por CNPJ
// (src/services/supplierLookup.js), usado pelo import de NF-e/DANFE.
// ============================================================
'use strict';

const { findOrCreateSupplierByCnpj } = require('../src/services/supplierLookup');

const CID = 'c1111111-1111-1111-1111-111111111111';
const SID = 's5555555-5555-5555-5555-555555555555';

function fakeClient(handlers) {
  return { query: jest.fn((sql, params) => {
    for (const [re, fn] of handlers) {
      if (re.test(sql)) return Promise.resolve(fn(params));
    }
    return Promise.resolve({ rows: [] });
  }) };
}

describe('findOrCreateSupplierByCnpj', () => {
  test('CNPJ ja cadastrado no grupo -> reusa, nao insere', async () => {
    const client = fakeClient([
      [/SELECT id FROM suppliers WHERE cnpj = \$1 AND/, () => ({ rows: [{ id: SID }] })],
    ]);

    const id = await findOrCreateSupplierByCnpj(client, CID, { cnpj: '11.222.333/0001-81', name: 'Fornecedor XPTO' });

    expect(id).toBe(SID);
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO suppliers/.test(sql))).toBe(false);
  });

  test('CNPJ novo -> cria', async () => {
    const client = fakeClient([
      [/SELECT id FROM suppliers WHERE cnpj = \$1 AND/, () => ({ rows: [] })],
      [/INSERT INTO suppliers/, () => ({ rows: [{ id: SID }] })],
    ]);

    const id = await findOrCreateSupplierByCnpj(client, CID, { cnpj: '11.444.777/0001-61', name: 'Fornecedor Novo' });

    expect(id).toBe(SID);
    const insertCall = client.query.mock.calls.find(([sql]) => /INSERT INTO suppliers/.test(sql));
    expect(insertCall[1]).toEqual([CID, 'Fornecedor Novo', '11444777000161']);
  });

  test('sem CNPJ nem nome -> null, nenhuma query roda', async () => {
    const client = fakeClient([]);
    const id = await findOrCreateSupplierByCnpj(client, CID, {});
    expect(id).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('sem CNPJ mas com nome -> cria por nome, sem buscar duplicata (sem chave confiavel)', async () => {
    const client = fakeClient([
      [/INSERT INTO suppliers/, () => ({ rows: [{ id: SID }] })],
    ]);

    const id = await findOrCreateSupplierByCnpj(client, CID, { name: 'Fornecedor Sem Cnpj' });

    expect(id).toBe(SID);
    expect(client.query.mock.calls.some(([sql]) => /SELECT id FROM suppliers WHERE cnpj/.test(sql))).toBe(false);
  });
});
