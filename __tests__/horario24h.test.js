// ============================================================
// Loja 24h: aberta às 23:59:30 também.
//
// A Finesse atende 24 horas. A forma óbvia de gravar isso é
// `00:00`–`23:59` para os sete dias — e ela deixaria a loja marcada como
// FECHADA no último minuto de cada dia, porque a comparação é
// `agora < fechamento` e às 23:59 os dois valem 1439.
//
// Um minuto por dia parece nada até a cliente cair nesse minuto e ver
// "Fechada" numa loja que atende 24 horas.
//
// `24:00` não é um horário, é um LIMITE — a forma de escrever "até o fim
// do dia". Com ele o intervalo cobre o dia inteiro.
// ============================================================
const { computeOpenState, parseHHMM } = require('../src/services/storefrontBuilder');

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const todosOsDias = (close) => {
  const h = {};
  for (const k of DIAS) h[k] = { open: '00:00', close, closed: false };
  return h;
};
const VINTE_E_QUATRO = todosOsDias('24:00');

describe('24:00 é o fim do dia, não um horário', () => {
  test('vale 1440 — um minuto além do último minuto do dia', () => {
    expect(parseHHMM('24:00')).toBe(24 * 60);
  });

  test('24:30 continua inválido, porque não quer dizer nada', () => {
    expect(parseHHMM('24:30')).toBeNull();
    expect(parseHHMM('25:00')).toBeNull();
  });

  test('os horários normais não mudaram', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('23:59')).toBe(1439);
    expect(parseHHMM('abc')).toBeNull();
  });
});

describe('a loja 24h nunca aparece fechada', () => {
  test.each([['00:00', 0, 0], ['00:01', 0, 1], ['12:00', 12, 0], ['23:58', 23, 58], ['23:59', 23, 59]])(
    'aberta às %s',
    (_rotulo, hour, minute) => {
      expect(computeOpenState(VINTE_E_QUATRO, { hour, minute, dayIndex: 3 }).is_open_now).toBe(true);
    },
  );

  test('em todos os dias da semana', () => {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      expect(computeOpenState(VINTE_E_QUATRO, { hour: 23, minute: 59, dayIndex }).is_open_now).toBe(true);
    }
  });

  test('com 23:59 no lugar de 24:00, o bug aparece', () => {
    // A prova de que a mudança era necessária, e não preciosismo.
    expect(computeOpenState(todosOsDias('23:59'), { hour: 23, minute: 59, dayIndex: 3 }).is_open_now).toBe(false);
  });
});

describe('loja com horário normal continua funcionando', () => {
  const comercial = {
    dom: { closed: true },
    seg: { open: '09:00', close: '18:00', closed: false },
    ter: { open: '09:00', close: '18:00', closed: false },
    qua: { open: '09:00', close: '18:00', closed: false },
    qui: { open: '09:00', close: '18:00', closed: false },
    sex: { open: '09:00', close: '18:00', closed: false },
    sab: { open: '09:00', close: '13:00', closed: false },
  };

  test('aberta no meio do expediente', () => {
    expect(computeOpenState(comercial, { hour: 14, minute: 0, dayIndex: 2 }).is_open_now).toBe(true);
  });

  test('fechada depois do expediente', () => {
    expect(computeOpenState(comercial, { hour: 19, minute: 0, dayIndex: 2 }).is_open_now).toBe(false);
  });

  test('no domingo, avisa quando reabre', () => {
    const r = computeOpenState(comercial, { hour: 10, minute: 0, dayIndex: 0 });
    expect(r.is_open_now).toBe(false);
    expect(r.next_open_text).toContain('09:00');
  });

  test('sem horário cadastrado, a loja fica sempre aberta', () => {
    // É o comportamento de hoje e não pode mudar: a maioria das lojas não
    // preenche horário, e nenhuma delas deve passar a aparecer fechada.
    expect(computeOpenState({}, { hour: 3, minute: 0, dayIndex: 0 }).is_open_now).toBe(true);
    expect(computeOpenState(null, { hour: 3, minute: 0, dayIndex: 0 }).is_open_now).toBe(true);
  });
});
