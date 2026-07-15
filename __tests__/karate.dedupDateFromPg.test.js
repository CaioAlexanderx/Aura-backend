// ============================================================
// Regressão P0 (15/07/2026) — data vinda do driver `pg` como OBJETO Date.
//
// A fila de solicitações da federação devolvia 500 para QUALQUER solicitação
// com data de nascimento (~96% dos casos reais): `String(dateObj).slice(0,10)`
// produz "Sun Apr 17" em vez de "2011-04-18", o Postgres rejeitava o cast
// `$4::date` e a query estourava. Só o tipo `numeric` tem parser customizado
// neste projeto (src/config/database.js) — TODA coluna date/timestamptz chega
// como Date. Este teste quebra se alguém voltar a usar String(x).slice(0,10).
// ============================================================
const { buildDedupKey, findPossibleMatches } = require('../src/services/karatePractitionerDedup');

describe('dedup — data vinda do banco como objeto Date', () => {
  const ISO = '2011-04-18';
  const pgDate = new Date(`${ISO}T00:00:00.000Z`); // exatamente o que o driver devolve

  test('buildDedupKey trata Date do pg igual a string ISO (idempotência não pode furar)', () => {
    expect(buildDedupKey('Mariana Yumi Tanaka', pgDate))
      .toBe(buildDedupKey('Mariana Yumi Tanaka', ISO));
    expect(buildDedupKey('Mariana Yumi Tanaka', pgDate)).toContain(ISO);
  });

  test('buildDedupKey NUNCA produz o toString() do Date (o bug original)', () => {
    const key = buildDedupKey('Mariana Yumi Tanaka', pgDate);
    expect(key).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  test('findPossibleMatches manda YYYY-MM-DD para o $4::date, não "Sun Apr 17"', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await findPossibleMatches(db, {
      federationId: '00000000-0000-0000-0000-000000000001',
      fullName: 'Mariana Yumi Tanaka',
      birthDate: pgDate,
    });
    expect(db.query).toHaveBeenCalled();
    const params = db.query.mock.calls[0][1];
    const birthParam = params.find((p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p));
    expect(birthParam).toBe(ISO);
    // e nenhum parâmetro pode ser o toString() do Date
    params.forEach((p) => {
      if (typeof p === 'string') expect(p).not.toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
    });
  });

  test('data inválida/nula degrada para null, sem quebrar', () => {
    expect(buildDedupKey('Fulano', null)).toBe(buildDedupKey('Fulano', undefined));
    expect(buildDedupKey('Fulano', new Date('data-invalida'))).not.toMatch(/Invalid/);
  });
});
