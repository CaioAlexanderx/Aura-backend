// ============================================================
// AURA. — Lembrete de contas a pagar no sininho (25/09/2026)
// services/lembreteContasAPagar.js + jobs/expenseDueReminderJob.js
//
// O que estes testes travam:
//   1. Um aviso por empresa e dia de vencimento (não um por conta), com
//      título/corpo curtos, total e "e mais N" acima de 3 contas.
//   2. A busca é de despesa PENDENTE que vence em hoje + 2 no dia de SP, só
//      de empresa ativa.
//   3. O disparo vai como evento 'loja_conta_vencendo', com dedupe por
//      empresa+dia e expiração no fim do dia do vencimento.
//   4. O tipo novo está no catálogo: atenção, ligado por padrão, CTA para o
//      Financeiro, sem entidade de pedido.
//   5. O agendador roda uma vez por dia a partir das 8h BRT (deploy às 10h
//      não perde o lembrete).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const lojaEvents = require('../src/services/lojaEvents');
const lembrete = require('../src/services/lembreteContasAPagar');

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(() => {
  db.query.mockReset();
  jest.restoreAllMocks();
});

describe('montarLembretes', () => {
  test('uma conta: título com o dia, corpo com descrição e valor', () => {
    const [l] = lembrete.montarLembretes([
      { company_id: A, id: 't1', description: 'Compra de materiais · RB CARDOSO', amount: '544.18', due_date: '2026-09-27' },
    ]);
    expect(l).toEqual({
      company_id: A,
      due_date: '2026-09-27',
      title: 'Conta a pagar vence em 27/09',
      body: 'Compra de materiais · RB CARDOSO · R$ 544,18. Vence em 2 dias.',
      dedupeSuffix: `${A}:2026-09-27`,
      expiresAt: '2026-09-27T23:59:59-03:00',
    });
  });

  test('várias contas da mesma empresa e dia viram UM aviso, maiores primeiro, com total e "e mais N"', () => {
    const contas = [
      { company_id: A, id: '1', description: 'Energia loja', amount: 70.04, due_date: '2026-10-01' },
      { company_id: A, id: '2', description: 'Compra · RB CARDOSO', amount: 452.6, due_date: '2026-10-01' },
      { company_id: A, id: '3', description: 'Compra · CSB', amount: 2150, due_date: '2026-10-01' },
      { company_id: A, id: '4', description: 'Compra · EDS', amount: 669.38, due_date: '2026-10-01' },
    ];
    const r = lembrete.montarLembretes(contas);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('4 contas a pagar vencem em 01/10');
    expect(r[0].body).toBe('Total R$ 3.342,02: Compra · CSB (R$ 2.150,00); Compra · EDS (R$ 669,38); Compra · RB CARDOSO (R$ 452,60) e mais 1.');
  });

  test('empresas e dias diferentes viram avisos separados', () => {
    const r = lembrete.montarLembretes([
      { company_id: A, id: '1', description: 'x', amount: 1, due_date: '2026-10-01' },
      { company_id: B, id: '2', description: 'y', amount: 2, due_date: '2026-10-01' },
      { company_id: A, id: '3', description: 'z', amount: 3, due_date: '2026-10-02' },
    ]);
    expect(r.map((l) => l.dedupeSuffix).sort()).toEqual([`${A}:2026-10-01`, `${A}:2026-10-02`, `${B}:2026-10-01`].sort());
  });

  test('descrição longa é cortada', () => {
    const [l] = lembrete.montarLembretes([{ company_id: A, id: '1', description: 'x'.repeat(100), amount: 1, due_date: '2026-10-01' }]);
    expect(l.body.startsWith('x'.repeat(57) + '…')).toBe(true);
  });
});

describe('runLembretes', () => {
  test('busca pendentes que vencem em hoje+2 (SP) de empresa ativa e dispara um evento por grupo', async () => {
    db.query.mockResolvedValue({
      rows: [
        { company_id: A, id: '1', description: 'Compra · RB CARDOSO', amount: '544.18', due_date: '2026-09-27' },
        { company_id: A, id: '2', description: 'Compra · EDS', amount: '497.89', due_date: '2026-09-27' },
      ],
    });
    const emit = jest.spyOn(lojaEvents, 'emitLojaEvent').mockResolvedValue({ id: 'n1' });

    const r = await lembrete.runLembretes();

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/t\.type = 'expense'/);
    expect(sql).toMatch(/t\.status = 'pending'/);
    expect(sql).toMatch(/AT TIME ZONE 'America\/Sao_Paulo'\)::date \+ \$1::int/);
    expect(sql).toMatch(/c\.is_active = true/);
    expect(params).toEqual([2]);

    expect(emit).toHaveBeenCalledTimes(1);
    const [type, payload, opts] = emit.mock.calls[0];
    expect(type).toBe('loja_conta_vencendo');
    expect(payload).toMatchObject({ company_id: A, title: '2 contas a pagar vencem em 27/09' });
    expect(opts).toEqual({
      dedupeSuffix: `${A}:2026-09-27`,
      body: 'Total R$ 1.042,07: Compra · RB CARDOSO (R$ 544,18); Compra · EDS (R$ 497,89).',
      expiresAt: '2026-09-27T23:59:59-03:00',
    });
    expect(r).toEqual({ contas: 2, avisos: 1, criados: 1 });
  });

  test('dedupe (evento já existia) não conta como criado', async () => {
    db.query.mockResolvedValue({ rows: [{ company_id: A, id: '1', description: 'x', amount: 1, due_date: '2026-09-27' }] });
    jest.spyOn(lojaEvents, 'emitLojaEvent').mockResolvedValue(null);
    expect(await lembrete.runLembretes()).toEqual({ contas: 1, avisos: 1, criados: 0 });
  });

  test('erro de banco não derruba o job', async () => {
    db.query.mockRejectedValue(new Error('conexão caiu'));
    const emit = jest.spyOn(lojaEvents, 'emitLojaEvent');
    expect(await lembrete.runLembretes()).toEqual({ contas: 0, avisos: 0, criados: 0 });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('tipo loja_conta_vencendo no catálogo', () => {
  test('atenção, ligado por padrão, sem pedido, CTA para o Financeiro', () => {
    const spec = lojaEvents.EVENTS.loja_conta_vencendo;
    expect(spec).toMatchObject({ severity: 'atencao', defaultOn: true, orderless: true, ctaLabel: 'Ver contas a pagar' });
    expect(spec.ctaRoute()).toBe('/financeiro');
    expect(spec.title({ title: 'X' })).toBe('X');
    expect(lojaEvents.entityOf(spec, { id: 'qualquer' })).toEqual({ ref: null, label: null });
  });

  test('emitLojaEvent repassa expiresAt e usa a dedupe por empresa+dia', async () => {
    // Preferências: tabela vazia = default (ligado).
    db.query.mockResolvedValue({ rows: [] });
    const appNotifications = require('../src/services/appNotifications');
    const notify = jest.spyOn(appNotifications, 'notifyCompany').mockResolvedValue({ id: 'n1' });
    lojaEvents._resetCaches();

    await lojaEvents.emitLojaEvent('loja_conta_vencendo',
      { company_id: A, title: 'Conta a pagar vence em 27/09', body: 'b' },
      { dedupeSuffix: `${A}:2026-09-27`, body: 'b', expiresAt: '2026-09-27T23:59:59-03:00' });

    expect(notify).toHaveBeenCalledWith(A, expect.objectContaining({
      type: 'loja_conta_vencendo',
      title: 'Conta a pagar vence em 27/09',
      body: 'b',
      ctaRoute: '/financeiro',
      dedupeKey: `loja:conta_vencendo:${A}:2026-09-27`,
      expiresAt: '2026-09-27T23:59:59-03:00',
    }));
  });
});

describe('agendador', () => {
  const job = require('../src/jobs/expenseDueReminderJob');
  afterEach(() => { jest.useRealTimers(); job._reset(); });

  function em(isoUtc) {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(isoUtc));
  }

  test('antes das 8h BRT não roda; a partir das 8h roda uma vez no dia', async () => {
    const spy = jest.spyOn(lembrete, 'runLembretes');
    db.query.mockResolvedValue({ rows: [] });

    em('2026-09-26T10:30:00Z'); // 07:30 BRT
    job._tick();
    expect(db.query).not.toHaveBeenCalled();

    em('2026-09-26T13:00:00Z'); // 10:00 BRT (deploy tardio): roda
    job._tick();
    await Promise.resolve();
    expect(db.query).toHaveBeenCalledTimes(1);

    em('2026-09-26T15:00:00Z'); // mesmo dia: não repete
    job._tick();
    expect(db.query).toHaveBeenCalledTimes(1);

    em('2026-09-27T11:05:00Z'); // dia seguinte 08:05 BRT: roda de novo
    job._tick();
    await Promise.resolve();
    expect(db.query).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
