// ============================================================
// AURA. — Testes: src/utils/birthdayCalc.js (1.2, aniversariantes odonto)
// Cobre virada de ano e nascidos em 29/02 (ano bissexto).
// ============================================================
const { daysUntilNextBirthday, todayInTimeZone } = require('../src/utils/birthdayCalc');

describe('daysUntilNextBirthday', () => {
  test('aniversario ainda nao passou este ano', () => {
    // hoje = 2026-09-16, aniversario = 09-20 -> 4 dias
    expect(daysUntilNextBirthday('1990-09-20', '2026-09-16')).toBe(4);
  });

  test('aniversario e hoje -> 0', () => {
    expect(daysUntilNextBirthday('1990-09-16', '2026-09-16')).toBe(0);
  });

  test('aniversario ja passou este ano -> usa o do ano que vem', () => {
    // hoje = 2026-09-16, nascido em 09-10 (ja passou) -> proximo em 2027-09-10
    const days = daysUntilNextBirthday('1990-09-10', '2026-09-16');
    // 2026-09-16 -> 2027-09-10 = 359 dias
    expect(days).toBe(359);
  });

  test('virada de ano — hoje em dezembro, aniversario em janeiro', () => {
    // hoje = 2026-12-28, aniversario = 01-03 -> 2027-01-03 = 6 dias
    expect(daysUntilNextBirthday('1985-01-03', '2026-12-28')).toBe(6);
  });

  test('virada de ano — hoje em janeiro, aniversario ja passou em dezembro do ano anterior', () => {
    // hoje = 2026-01-02, nascido em 12-25 -> ja passou (2025-12-25),
    // proximo e 2026-12-25
    const days = daysUntilNextBirthday('1985-12-25', '2026-01-02');
    expect(days).toBe(357); // 2026-01-02 -> 2026-12-25
  });

  test('nascido em 29/02 — ano corrente NAO bissexto, aniversario ainda nao chegou', () => {
    // 2026 nao e bissexto. hoje = 2026-02-01, aniversario cai em 2026-02-28.
    expect(daysUntilNextBirthday('1992-02-29', '2026-02-01')).toBe(27);
  });

  test('nascido em 29/02 — ano corrente NAO bissexto, hoje ja passou de 28/02', () => {
    // hoje = 2026-03-01 (28/02 ja passou) -> proximo aniversario e 2027-02-28
    const days = daysUntilNextBirthday('1992-02-29', '2026-03-01');
    expect(days).toBe(364);
  });

  test('nascido em 29/02 — ano corrente E bissexto, cai certinho em 29/02', () => {
    // 2028 e bissexto. hoje = 2028-02-20 -> aniversario 2028-02-29 = 9 dias
    expect(daysUntilNextBirthday('1992-02-29', '2028-02-20')).toBe(9);
  });

  test('nao quebra com birth_date ausente', () => {
    expect(daysUntilNextBirthday(null, '2026-09-16')).toBeNull();
    expect(daysUntilNextBirthday(undefined, '2026-09-16')).toBeNull();
  });

  test('aceita Date object alem de string YYYY-MM-DD', () => {
    const bday = new Date(Date.UTC(1990, 8, 20)); // 20/09
    const today = new Date(Date.UTC(2026, 8, 16));
    expect(daysUntilNextBirthday(bday, today)).toBe(4);
  });

  test('aceita string ISO completa (timestamp) da coluna DATE', () => {
    expect(daysUntilNextBirthday('1990-09-20T00:00:00.000Z', '2026-09-16')).toBe(4);
  });
});

describe('todayInTimeZone', () => {
  test('formata como YYYY-MM-DD', () => {
    const s = todayInTimeZone('America/Sao_Paulo', new Date('2026-09-16T12:00:00Z'));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('America/Sao_Paulo (UTC-3) pode ficar um dia atras do UTC perto da meia-noite', () => {
    // 2026-09-17T01:00:00Z ainda e 2026-09-16 22:00 em Sao Paulo (UTC-3)
    const spDate = todayInTimeZone('America/Sao_Paulo', new Date('2026-09-17T01:00:00Z'));
    expect(spDate).toBe('2026-09-16');
  });
});
