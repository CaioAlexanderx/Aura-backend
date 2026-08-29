// ============================================================
// Loja 24h é um ESTADO, não um intervalo.
//
// A Finesse atende 24 horas. Houve duas tentativas de dizer isso com
// horário, e as duas quebraram:
//
//   00:00–23:59 → a comparação é `agora < fechamento`, e às 23:59 os dois
//                 valem 1439. Loja FECHADA no último minuto de todo dia.
//   00:00–24:00 → 24:00 não é um horário; o parse rejeita, o fechamento
//                 vira null e a função cai no ramo do "próximo dia
//                 aberto". Loja FECHADA o dia INTEIRO. Foi ao ar em
//                 29/08/2026 e a loja da cliente ficou assim até eu ver.
//
// Os dois erros têm a mesma raiz: deduzir "sempre aberta" de um intervalo
// que por acaso cobre o dia. `always_open` (migration 310) declara.
//
// Os testes abaixo prendem as DUAS armadilhas, não só a correção — se
// alguém tentar de novo pelo caminho do horário, elas reprovam.
// ============================================================
const { computeOpenState, parseHHMM } = require('../src/services/storefrontBuilder');

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const todosOsDias = (open, close) => {
  const h = {};
  for (const k of DIAS) h[k] = { open, close, closed: false };
  return h;
};

// Horário qualquer, só pra provar que always_open não olha pra ele.
const COMERCIAL = {
  dom: { closed: true },
  seg: { open: '09:00', close: '18:00', closed: false },
  ter: { open: '09:00', close: '18:00', closed: false },
  qua: { open: '09:00', close: '18:00', closed: false },
  qui: { open: '09:00', close: '18:00', closed: false },
  sex: { open: '09:00', close: '18:00', closed: false },
  sab: { open: '09:00', close: '13:00', closed: false },
};

describe('always_open vence qualquer horário', () => {
  test.each([
    ['madrugada de domingo', 3, 0, 0],
    ['meio da tarde', 14, 0, 2],
    ['depois do expediente', 23, 59, 5],
  ])('aberta na %s', (_rotulo, hour, minute, dayIndex) => {
    const r = computeOpenState(COMERCIAL, true, { hour, minute, dayIndex });
    expect(r.is_open_now).toBe(true);
    expect(r.next_open_text).toBe('');
  });

  test('em todo minuto de virada da semana', () => {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      for (const [hour, minute] of [[0, 0], [23, 59]]) {
        expect(
          computeOpenState(COMERCIAL, true, { hour, minute, dayIndex }).is_open_now,
        ).toBe(true);
      }
    }
  });

  test('domingo fechado no cadastro não fecha a loja 24h', () => {
    // O domingo do COMERCIAL tem closed:true. always_open ignora.
    expect(computeOpenState(COMERCIAL, true, { hour: 10, minute: 0, dayIndex: 0 }).is_open_now).toBe(true);
    expect(computeOpenState(COMERCIAL, false, { hour: 10, minute: 0, dayIndex: 0 }).is_open_now).toBe(false);
  });

  test('só `true` liga — undefined é base sem a migration 310', () => {
    const meioDaNoite = { hour: 3, minute: 0, dayIndex: 2 };
    expect(computeOpenState(COMERCIAL, undefined, meioDaNoite).is_open_now).toBe(false);
    expect(computeOpenState(COMERCIAL, null, meioDaNoite).is_open_now).toBe(false);
    // Um truthy qualquer não serve: a coluna é booleana, e aceitar
    // 'false' (string) ligaria a loja 24h por engano.
    expect(computeOpenState(COMERCIAL, 'false', meioDaNoite).is_open_now).toBe(false);
  });
});

describe('as duas tentativas por horário continuam quebradas — de propósito', () => {
  test('00:00–23:59 fecha a loja no último minuto do dia', () => {
    const r = computeOpenState(todosOsDias('00:00', '23:59'), false, { hour: 23, minute: 59, dayIndex: 3 });
    expect(r.is_open_now).toBe(false);
  });

  test('24:00 não é horário e nunca virou um', () => {
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('24:30')).toBeNull();
    expect(parseHHMM('25:00')).toBeNull();
  });

  test('os horários válidos não mudaram', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('23:59')).toBe(1439);
    expect(parseHHMM('abc')).toBeNull();
    expect(parseHHMM('')).toBeNull();
  });
});

describe('horário ilegível não fecha a loja calada', () => {
  // Era o pior pedaço do bug de produção: fechamento que não parseia caía
  // direto no laço do próximo dia e a loja anunciava "Fechada · Abre
  // amanhã às 00:00" — sem erro no log, sem sinal pra lojista.
  const ilegivel = todosOsDias('00:00', '24:00');

  test('fecha? não: fica aberta e grita no log', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = computeOpenState(ilegivel, false, { hour: 15, minute: 0, dayIndex: 3 });
    expect(r.is_open_now).toBe(true);
    expect(r.next_open_text).toBe('');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('não anuncia "abre amanhã" para um dia que está aberto hoje', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = computeOpenState(ilegivel, false, { hour: 23, minute: 59, dayIndex: 0 });
    expect(r.next_open_text).not.toContain('amanhã');
    spy.mockRestore();
  });
});

describe('loja com horário normal continua funcionando', () => {
  test('aberta no meio do expediente', () => {
    expect(computeOpenState(COMERCIAL, false, { hour: 14, minute: 0, dayIndex: 2 }).is_open_now).toBe(true);
  });

  test('fechada depois do expediente', () => {
    expect(computeOpenState(COMERCIAL, false, { hour: 19, minute: 0, dayIndex: 2 }).is_open_now).toBe(false);
  });

  test('no domingo, avisa quando reabre', () => {
    const r = computeOpenState(COMERCIAL, false, { hour: 10, minute: 0, dayIndex: 0 });
    expect(r.is_open_now).toBe(false);
    expect(r.next_open_text).toContain('09:00');
  });

  test('antes de abrir, avisa que abre hoje', () => {
    const r = computeOpenState(COMERCIAL, false, { hour: 7, minute: 0, dayIndex: 2 });
    expect(r.is_open_now).toBe(false);
    expect(r.next_open_text).toContain('hoje');
  });

  test('sem horário cadastrado, a loja fica sempre aberta', () => {
    // É o comportamento de hoje e não pode mudar: a maioria das lojas não
    // preenche horário, e nenhuma delas deve passar a aparecer fechada.
    expect(computeOpenState({}, false, { hour: 3, minute: 0, dayIndex: 0 }).is_open_now).toBe(true);
    expect(computeOpenState(null, false, { hour: 3, minute: 0, dayIndex: 0 }).is_open_now).toBe(true);
  });
});
