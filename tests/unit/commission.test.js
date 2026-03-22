// Testa apenas a lógica pura de cálculo — sem banco

// Cálculo inline (extração da lógica do service para teste isolado)
function calcCommission(total_sales, commission_rate) {
  return Math.round(total_sales * commission_rate) / 100;
}

function getStatus(achieved, goal_amount) {
  if (!goal_amount) return 'no_goal';
  const pct = Math.round((achieved / goal_amount) * 100);
  if (pct >= 100) return 'achieved';
  if (pct >= 75)  return 'on_track';
  return 'behind';
}

function parseMonth(str) {
  if (!str) return null;
  if (!/^\d{4}-\d{2}$/.test(str)) return null;
  const [, m] = str.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return str;
}

describe('calcCommission', () => {
  test('5% sobre R$1.000 = R$50', () => {
    expect(calcCommission(1000, 5)).toBe(50);
  });
  test('2.5% sobre R$1.200 = R$30', () => {
    expect(calcCommission(1200, 2.5)).toBe(30);
  });
  test('10% sobre R$0 = R$0', () => {
    expect(calcCommission(0, 10)).toBe(0);
  });
  test('arredondamento correto', () => {
    // 3% de R$100.01 = R$3.0003 → R$3
    expect(calcCommission(100.01, 3)).toBe(3);
  });
});

describe('getStatus', () => {
  test('sem meta = no_goal', () => {
    expect(getStatus(500, null)).toBe('no_goal');
    expect(getStatus(0, 0)).toBe('no_goal');
  });
  test('100% = achieved', () => {
    expect(getStatus(1000, 1000)).toBe('achieved');
    expect(getStatus(1200, 1000)).toBe('achieved');
  });
  test('75-99% = on_track', () => {
    expect(getStatus(750, 1000)).toBe('on_track');
    expect(getStatus(990, 1000)).toBe('on_track');
  });
  test('< 75% = behind', () => {
    expect(getStatus(500, 1000)).toBe('behind');
    expect(getStatus(0, 1000)).toBe('behind');
  });
});

describe('parseMonth', () => {
  test('formato válido', () => {
    expect(parseMonth('2026-03')).toBe('2026-03');
    expect(parseMonth('2025-12')).toBe('2025-12');
  });
  test('mês inválido', () => {
    expect(parseMonth('2026-00')).toBeNull();
    expect(parseMonth('2026-13')).toBeNull();
  });
  test('formato errado', () => {
    expect(parseMonth('202603')).toBeNull();
    expect(parseMonth('2026-3')).toBeNull();
    expect(parseMonth(null)).toBeNull();
  });
});
