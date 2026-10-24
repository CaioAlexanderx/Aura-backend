// ============================================================
// services/asaasVencimentos — acerto de companies.next_billing_date pela Asaas.
//
// Dry-run não grava nada; aplicar grava a data e uma linha em audit_log por
// empresa alterada, com o valor antigo e o novo.
// ============================================================
'use strict';

const { corrigirVencimentos, ACAO } = require('../../src/services/asaasVencimentos');

const id = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';

// Datas inventadas no formato do problema real: paradas no ciclo já pago.
const EMPRESAS = [
  { company_id: id(1), nome: 'Loja Atrasada', status: 'active', asaas_subscription_id: 'sub_1', atual: '2026-09-15' },
  { company_id: id(2), nome: 'Loja Certa', status: 'active', asaas_subscription_id: 'sub_2', atual: '2026-11-08' },
  { company_id: id(3), nome: 'Loja Cancelada na Asaas', status: 'active', asaas_subscription_id: 'sub_3', atual: '2026-06-18' },
  { company_id: id(4), nome: 'Loja Sem Data', status: 'active', asaas_subscription_id: 'sub_4', atual: null },
  { company_id: id(5), nome: 'Loja Sem Resposta', status: 'active', asaas_subscription_id: 'sub_5', atual: '2026-08-08' },
];

const ASSINATURAS = {
  sub_1: { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-10-15' },
  sub_2: { id: 'sub_2', status: 'ACTIVE', nextDueDate: '2026-11-08' },
  sub_3: { id: 'sub_3', status: 'INACTIVE', nextDueDate: '2026-07-18' },
  sub_4: { id: 'sub_4', status: 'ACTIVE', nextDueDate: '2026-12-01' },
};
const PENDENTES = { sub_4: [{ status: 'PENDING', dueDate: '2026-11-01' }] };

const asaas = jest.fn(async (metodo, caminho) => {
  const sub = /\/subscriptions\/(sub_\d)/.exec(caminho)[1];
  if (caminho.includes('/payments')) return { data: PENDENTES[sub] || [] };
  if (!ASSINATURAS[sub]) throw new Error('Asaas error 503');
  return ASSINATURAS[sub];
});

function makeDb() {
  const escritas = [];
  return {
    escritas,
    query: jest.fn(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT')) return { rows: EMPRESAS.map((e) => ({ ...e })) };
      escritas.push({ sql: s, params });
      return { rows: [], rowCount: 1 };
    }),
  };
}

const resumo = (r) => r.linhas.map((l) => [l.nome, l.antes, l.depois, l.situacao]);

beforeEach(() => {
  asaas.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('corrigirVencimentos', () => {
  test('dry-run (padrão): mostra antes/depois e não grava nada', async () => {
    const db = makeDb();
    const r = await corrigirVencimentos({ db, asaas });

    expect(r).toMatchObject({ aplicado: false, total: 5, corrigir: 2, corrigidos: 0, iguais: 1, inativas: 1, erros: 1 });
    expect(resumo(r)).toEqual([
      ['Loja Atrasada', '2026-09-15', '2026-10-15', 'corrigir'],
      ['Loja Certa', '2026-11-08', '2026-11-08', 'igual'],
      ['Loja Cancelada na Asaas', '2026-06-18', null, 'assinatura_inativa'],
      ['Loja Sem Data', null, '2026-11-01', 'corrigir'], // cobrança pendente vem antes do nextDueDate
      ['Loja Sem Resposta', '2026-08-08', null, 'erro'],
    ]);
    expect(db.escritas).toHaveLength(0);
    // só empresas com assinatura
    expect(db.query.mock.calls[0][0]).toContain('c.asaas_subscription_id IS NOT NULL');
  });

  test('aplicar: grava a data e o audit_log com o valor antigo e o novo', async () => {
    const db = makeDb();
    const r = await corrigirVencimentos({ db, asaas, aplicar: true, userId: USER });

    expect(r).toMatchObject({ aplicado: true, corrigir: 0, corrigidos: 2, iguais: 1, inativas: 1, erros: 1 });
    expect(r.linhas.filter((l) => l.situacao === 'corrigido').map((l) => l.nome)).toEqual(['Loja Atrasada', 'Loja Sem Data']);

    const updates = db.escritas.filter((e) => e.sql.startsWith('UPDATE companies'));
    expect(updates.map((u) => u.params)).toEqual([
      ['2026-10-15', id(1), 'sub_1'],
      ['2026-11-01', id(4), 'sub_4'],
    ]);
    // só mexe na data: status e último pagamento ficam como estão
    expect(updates[0].sql).toBe('UPDATE companies SET next_billing_date = $1::date, updated_at = NOW() WHERE id = $2 AND asaas_subscription_id = $3');

    const audits = db.escritas.filter((e) => e.sql.startsWith('INSERT INTO audit_log'));
    expect(audits).toHaveLength(2);
    const [userId, companyId, action, detail, metadata] = audits[0].params;
    expect([userId, companyId, action, detail]).toEqual([USER, id(1), 'billing.next_due_corrected', '2026-09-15 -> 2026-10-15']);
    expect(ACAO).toBe('billing.next_due_corrected');
    expect(JSON.parse(metadata)).toEqual({
      antes: '2026-09-15', depois: '2026-10-15', origem: 'assinatura', asaas_subscription_id: 'sub_1',
    });
    expect(JSON.parse(audits[1].params[4])).toMatchObject({ antes: null, depois: '2026-11-01', origem: 'cobranca_pendente' });
    expect(db.escritas).toHaveLength(4);
  });

  test('empresa que trocou de assinatura no meio não é gravada nem auditada', async () => {
    const db = makeDb();
    db.query.mockImplementation(async (sql) => {
      if (/^\s*SELECT/.test(sql)) return { rows: [{ ...EMPRESAS[0] }] };
      db.escritas.push(sql.replace(/\s+/g, ' ').trim());
      return { rows: [], rowCount: 0 };
    });
    const r = await corrigirVencimentos({ db, asaas, aplicar: true });
    expect(r.linhas[0].situacao).toBe('erro');
    expect(db.escritas.some((s) => s.startsWith('INSERT INTO audit_log'))).toBe(false);
  });

  test('rodar de novo depois de aplicar não muda nada', async () => {
    const db = makeDb();
    db.query.mockImplementation(async (sql) => {
      if (/^\s*SELECT/.test(sql)) return { rows: [{ ...EMPRESAS[0], atual: '2026-10-15' }] };
      db.escritas.push(sql);
      return { rows: [], rowCount: 1 };
    });
    const r = await corrigirVencimentos({ db, asaas, aplicar: true });
    expect(r).toMatchObject({ corrigidos: 0, iguais: 1 });
    expect(db.escritas).toHaveLength(0);
  });
});

// tq-86 (24/10/2026): o caso da MHT em 21/10 — cobrança de 20/10 vencida e
// em aberto, a de 20/11 pendente. A correção levou a data para 20/11; agora
// fica na vencida mais antiga.
describe('corrigirVencimentos com cobrança vencida em aberto', () => {
  test('não avança além da OVERDUE mais antiga', async () => {
    const empresa = { company_id: id(6), nome: 'Loja em Atraso', status: 'overdue', asaas_subscription_id: 'sub_6', atual: '2026-10-20' };
    const db = {
      query: jest.fn(async (sql) => (sql.trim().startsWith('SELECT') ? { rows: [empresa] } : { rows: [], rowCount: 1 })),
    };
    const asaasAtraso = jest.fn(async (metodo, caminho) => {
      if (caminho.includes('status=OVERDUE')) return { data: [{ status: 'OVERDUE', dueDate: '2026-10-20' }] };
      if (caminho.includes('status=PENDING')) return { data: [{ status: 'PENDING', dueDate: '2026-11-20' }] };
      return { id: 'sub_6', status: 'ACTIVE', nextDueDate: '2026-12-20' };
    });
    const r = await corrigirVencimentos({ db, asaas: asaasAtraso, aplicar: true });
    expect(r.linhas[0]).toMatchObject({ antes: '2026-10-20', depois: '2026-10-20', origem: 'cobranca_vencida', situacao: 'igual' });
    expect(db.query).toHaveBeenCalledTimes(1); // nada gravado
  });
});
