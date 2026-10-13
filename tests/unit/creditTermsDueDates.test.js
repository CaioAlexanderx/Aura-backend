// ============================================================
// AURA. -- services/credit/terms: datas de vencimento (13/10/2026)
//
// dueDateForIndex agora soma meses em UTC e fica no ultimo dia do mes quando
// o dia nao existe la. Estes testes travam:
//   1. dias 1..28: resultado IDENTICO ao algoritmo anterior (setMonth), em
//      todas as periodicidades -- nada muda para quem ja usava;
//   2. dias 29..31: nao estoura para o mes seguinte (30/01 -> 28/02);
//   3. validateFirstDueDate/defaultFirstDueDate: limites e codigos.
// ============================================================
'use strict';

const terms = require('../../src/services/credit/terms');

// O algoritmo ate 12/10/2026 como referencia. Os setters sao UTC de proposito:
// em producao (Railway, TZ=UTC) `setMonth` local e `setUTCMonth` sao a mesma
// coisa, e assim o teste nao depende do fuso da maquina que o roda.
function legado(firstDueStr, unit, count, idx) {
  const d = new Date(firstDueStr);
  const step = (parseInt(count, 10) || 1) * idx;
  if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * step);
  else if (unit === 'day') d.setUTCDate(d.getUTCDate() + step);
  else d.setUTCMonth(d.getUTCMonth() + step);
  return d.toISOString().split('T')[0];
}

describe('dueDateForIndex', () => {
  test('dias 1..28 em 24 meses: igual ao algoritmo anterior (mes, semana, dia)', () => {
    let comparados = 0;
    for (let mes = 1; mes <= 12; mes++) {
      for (let dia = 1; dia <= 28; dia++) {
        const base = `2026-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
        for (const [unit, count] of [['month', 1], ['month', 2], ['week', 1], ['week', 2], ['day', 15]]) {
          for (let idx = 0; idx < 24; idx++) {
            expect(terms.dueDateForIndex(base, unit, count, idx)).toBe(legado(base, unit, count, idx));
            comparados++;
          }
        }
      }
    }
    expect(comparados).toBeGreaterThan(10000);
  });

  test('dia 31/30/29 fica no ultimo dia do mes em vez de pular para o seguinte', () => {
    const seq = (base, n) => Array.from({ length: n }, (_, i) => terms.dueDateForIndex(base, 'month', 1, i));
    expect(seq('2027-01-31', 5)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
    expect(seq('2027-01-30', 3)).toEqual(['2027-01-30', '2027-02-28', '2027-03-30']);
    expect(seq('2028-01-29', 3)).toEqual(['2028-01-29', '2028-02-29', '2028-03-29']); // bissexto
    expect(seq('2027-01-29', 2)).toEqual(['2027-01-29', '2027-02-28']);
  });

  test('virada de ano e passo de 2 meses', () => {
    expect(terms.dueDateForIndex('2026-12-15', 'month', 1, 1)).toBe('2027-01-15');
    expect(terms.dueDateForIndex('2026-11-30', 'month', 2, 1)).toBe('2027-01-30');
    expect(terms.dueDateForIndex('2026-12-31', 'month', 1, 2)).toBe('2027-02-28');
  });

  test('indice 0 devolve a propria data', () => {
    expect(terms.dueDateForIndex('2027-01-31', 'month', 1, 0)).toBe('2027-01-31');
  });
});

describe('validateFirstDueDate', () => {
  const hoje = '2026-12-10';
  const v = (raw, extra = {}) => terms.validateFirstDueDate(raw, { today: hoje, ...extra });

  test('constante unica de 90 dias', () => {
    expect(terms.FIRST_DUE_MAX_DAYS).toBe(90);
  });

  test('janela: hoje e hoje+90 valem; ontem e hoje+91 nao', () => {
    expect(v('2026-12-10')).toEqual({ ok: true, date: '2026-12-10' });
    expect(v('2027-03-10')).toEqual({ ok: true, date: '2027-03-10' });
    expect(v('2026-12-09')).toMatchObject({ ok: false, status: 422, code: 'FIRST_DUE_DATE_PAST' });
    expect(v('2027-03-11')).toMatchObject({ ok: false, status: 422, code: 'FIRST_DUE_DATE_TOO_FAR', max_date: '2027-03-10' });
  });

  test('teto configuravel por chamada', () => {
    expect(v('2027-01-10', { maxDays: 30 })).toMatchObject({ ok: false, code: 'FIRST_DUE_DATE_TOO_FAR', max_days: 30 });
  });

  test('formato: so YYYY-MM-DD de calendario real', () => {
    for (const ruim of [undefined, null, '', 'amanha', '2027-13-01', '2027-02-30', '10/01/2027', 20270110]) {
      expect(v(ruim)).toMatchObject({ ok: false, status: 400, code: 'FIRST_DUE_DATE_INVALID' });
    }
    expect(v(' 2027-01-10 ')).toEqual({ ok: true, date: '2027-01-10' });
  });
});

describe('defaultFirstDueDate', () => {
  test('hoje + 1 mes, preso ao fim do mes', () => {
    expect(terms.defaultFirstDueDate('2026-12-10')).toBe('2027-01-10');
    expect(terms.defaultFirstDueDate('2026-12-31')).toBe('2027-01-31');
    expect(terms.defaultFirstDueDate('2027-01-31')).toBe('2027-02-28');
  });
});
