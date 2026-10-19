// ============================================================
// AURA. — Horario da loja: a virada da meia-noite e a loja fechada
// recusando o pedido (Canal Digital, 19/10/2026)
//
// Antes: abre 18:00 e fecha 02:00 aparecia "Fechada" o tempo todo (o
// selo comparava `agora >= 18h && agora < 2h` no mesmo dia) e "Fechada"
// era so um selo — o pedido entrava igual. Agora uma regra so
// (horarioDaLoja.estaAberta) decide o selo e a recusa do servidor.
// ============================================================
'use strict';

const {
  estaAberta, parseHHMM, momentoNoFuso, problemasDoHorario, mensagemDosProblemas,
} = require('../src/services/horarioDaLoja');
const { computeOpenState } = require('../src/services/storefrontBuilder');

// dayIndex: 0 = dom ... 6 = sab
const DOM = 0, SEG = 1, SEX = 5, SAB = 6;
const as = (dayIndex, hhmm) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  return { hour, minute, dayIndex };
};

const COMERCIAL = {
  dom: { open: '', close: '', closed: true },
  seg: { open: '09:00', close: '18:00', closed: false },
  ter: { open: '09:00', close: '18:00', closed: false },
  qua: { open: '09:00', close: '18:00', closed: false },
  qui: { open: '09:00', close: '18:00', closed: false },
  sex: { open: '09:00', close: '18:00', closed: false },
  sab: { open: '09:00', close: '13:00', closed: false },
};

// Adega: qui a sab das 18h as 2h; domingo e segunda sem expediente.
const ADEGA = {
  dom: { closed: true },
  seg: { closed: true },
  ter: { open: '18:00', close: '23:00', closed: false },
  qua: { open: '18:00', close: '23:00', closed: false },
  qui: { open: '18:00', close: '02:00', closed: false },
  sex: { open: '18:00', close: '02:00', closed: false },
  sab: { open: '18:00', close: '02:00', closed: false },
};

describe('estaAberta — horario no mesmo dia', () => {
  test.each([
    ['seg 09:00 (abre)', SEG, '09:00', true],
    ['seg 14:00', SEG, '14:00', true],
    ['seg 17:59', SEG, '17:59', true],
    ['seg 18:00 (fecha)', SEG, '18:00', false],
    ['seg 08:59', SEG, '08:59', false],
    ['sab 13:30', SAB, '13:30', false],
    ['dom 10:00 (sem expediente)', DOM, '10:00', false],
  ])('%s', (_r, dia, hora, esperado) => {
    expect(estaAberta(COMERCIAL, as(dia, hora))).toBe(esperado);
  });
});

describe('estaAberta — fecha depois da meia-noite', () => {
  test('sabado 18:00 as 02:00: aberta as 19h, 23:59 e 00:00', () => {
    expect(estaAberta(ADEGA, as(SAB, '19:00'))).toBe(true);
    expect(estaAberta(ADEGA, as(SAB, '23:59'))).toBe(true);
  });

  test('o periodo de sabado vale ate 02:00 do domingo, mesmo com domingo sem expediente', () => {
    expect(estaAberta(ADEGA, as(DOM, '00:00'))).toBe(true);
    expect(estaAberta(ADEGA, as(DOM, '01:59'))).toBe(true);
    expect(estaAberta(ADEGA, as(DOM, '02:00'))).toBe(false);
    expect(estaAberta(ADEGA, as(DOM, '20:00'))).toBe(false);
  });

  test('antes de abrir no proprio dia continua fechada', () => {
    expect(estaAberta(ADEGA, as(SAB, '17:59'))).toBe(false);
    expect(estaAberta(ADEGA, as(SAB, '03:00'))).toBe(false);
  });

  test('sexta 01:00 e a madrugada da quinta', () => {
    expect(estaAberta(ADEGA, as(SEX, '01:00'))).toBe(true);
  });

  test('terca fecha 23:00 no mesmo dia: quarta 01:00 fechada', () => {
    expect(estaAberta(ADEGA, as(3, '01:00'))).toBe(false);
  });

  test('dia sem expediente nao herda madrugada de um dia que nao vira a noite', () => {
    // segunda (sem expediente) depois de domingo (sem expediente)
    expect(estaAberta(ADEGA, as(SEG, '01:00'))).toBe(false);
  });

  test('ontem sem expediente nao abre a madrugada de hoje', () => {
    const h = { ...ADEGA, sex: { closed: true, open: '18:00', close: '02:00' } };
    expect(estaAberta(h, as(SAB, '01:00'))).toBe(false);
  });
});

describe('estaAberta — o que nao muda', () => {
  test('sem horario cadastrado a loja fica aberta', () => {
    expect(estaAberta({}, as(DOM, '03:00'))).toBe(true);
    expect(estaAberta(null, as(DOM, '03:00'))).toBe(true);
    expect(estaAberta('{}', as(DOM, '03:00'))).toBe(true);
  });

  test('aceita o JSON cru da coluna', () => {
    expect(estaAberta(JSON.stringify(ADEGA), as(DOM, '01:00'))).toBe(true);
  });

  test('abertura igual ao fechamento e ilegivel: aberta, com erro no log', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = { seg: { open: '10:00', close: '10:00', closed: false } };
    expect(estaAberta(h, as(SEG, '15:00'))).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('24:00 continua nao sendo horario', () => {
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('02:00')).toBe(120);
  });
});

describe('estaAberta — fuso', () => {
  // 2026-10-18 02:30 UTC = sabado 17/10 23:30 em Sao Paulo (UTC-3).
  const instante = new Date('2026-10-18T02:30:00Z');

  test('o instante e lido no fuso de Sao Paulo por padrao', () => {
    expect(momentoNoFuso(instante)).toEqual({ hour: 23, minute: 30, dayIndex: SAB });
    expect(estaAberta(ADEGA, instante)).toBe(true);
    expect(estaAberta(COMERCIAL, instante)).toBe(false);
  });

  test('em UTC o mesmo instante ja e domingo 02:30: fora da madrugada', () => {
    expect(momentoNoFuso(instante, 'UTC')).toEqual({ hour: 2, minute: 30, dayIndex: DOM });
    expect(estaAberta(ADEGA, instante, 'UTC')).toBe(false);
  });

  test('Manaus (UTC-4) e uma hora antes', () => {
    expect(momentoNoFuso(instante, 'America/Manaus')).toEqual({ hour: 22, minute: 30, dayIndex: SAB });
  });

  test('timestamp em ms funciona igual a Date', () => {
    expect(estaAberta(ADEGA, instante.getTime())).toBe(true);
  });
});

describe('computeOpenState (o selo) usa a mesma regra', () => {
  test('adega aberta no sabado as 19h: sem "Abre hoje"', () => {
    expect(computeOpenState(ADEGA, false, as(SAB, '19:00'))).toEqual({ is_open_now: true, next_open_text: '' });
  });

  test('domingo 01:00 ainda e a noite de sabado', () => {
    expect(computeOpenState(ADEGA, false, as(DOM, '01:00')).is_open_now).toBe(true);
  });

  test('sabado 10:00: fechada, abre hoje as 18:00', () => {
    expect(computeOpenState(ADEGA, false, as(SAB, '10:00'))).toEqual({
      is_open_now: false, next_open_text: 'Abre hoje às 18:00',
    });
  });

  test('domingo 03:00: fechada, abre terca', () => {
    expect(computeOpenState(ADEGA, false, as(DOM, '03:00')).next_open_text).toBe('Abre Terça às 18:00');
  });

  test('always_open continua vencendo', () => {
    expect(computeOpenState(ADEGA, true, as(SEG, '10:00')).is_open_now).toBe(true);
  });
});

describe('problemasDoHorario — o que o PUT do canal aceita salvar', () => {
  test('fechar depois da meia-noite e valido', () => {
    expect(problemasDoHorario(ADEGA)).toEqual([]);
  });

  test('fechamento igual a abertura e recusado', () => {
    const h = { ...COMERCIAL, qua: { open: '18:00', close: '18:00', closed: false } };
    const p = problemasDoHorario(h);
    expect(p).toEqual([{ dia: 'qua', motivo: 'igual' }]);
    expect(mensagemDosProblemas(p)).toMatch(/quarta.*não pode ser igual/);
    expect(mensagemDosProblemas(p)).toMatch(/18:00 às 02:00/);
  });

  test('formato invalido e recusado; dia sem expediente nao e conferido', () => {
    const h = { seg: { open: '9h', close: '18:00', closed: false }, dom: { open: '', close: '', closed: true } };
    expect(problemasDoHorario(h)).toEqual([{ dia: 'seg', motivo: 'formato' }]);
  });

  test('dia igual ao ja gravado passa: quem ja tem horario salvo nao fica travado', () => {
    const gravado = { seg: { open: '10:00', close: '10:00', closed: false } };
    expect(problemasDoHorario({ ...gravado }, gravado)).toEqual([]);
    // mas a edicao nova continua barrada
    expect(problemasDoHorario({ seg: { open: '11:00', close: '11:00', closed: false } }, gravado))
      .toEqual([{ dia: 'seg', motivo: 'igual' }]);
  });
});

// ── O servidor recusa o pedido com a loja fechada ─────────────────────
describe('POST /storefront/:slug/order com a loja fechada', () => {
  const express = require('express');
  const request = require('supertest');
  const db = require('../src/config/database');

  const PRODUTO = { id: 'p1', name: 'CERVEJA', price: '9.90', stock_qty: 10, image_url: null, is_active: true };
  const SEM_EXPEDIENTE = {
    dom: { closed: true }, seg: { closed: true }, ter: { closed: true }, qua: { closed: true },
    qui: { closed: true }, sex: { closed: true }, sab: { open: '18:00', close: '02:00', closed: true },
  };
  let loja;

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/storefront', require('../src/routes/storefront'));
    return app;
  }

  beforeEach(() => {
    loja = { company_id: 'c1', pickup_enabled: true, pix_key: 'chave', company_display_name: 'Adega' };
    db.query.mockReset();
    db.connect.mockReset();
    db.query.mockImplementation((sql) => {
      if (/FROM digital_channel_config/.test(sql)) return Promise.resolve({ rows: [loja] });
      if (/FROM products/.test(sql)) return Promise.resolve({ rows: [PRODUTO] });
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockImplementation(() => ({
      query: jest.fn((sql) => /INSERT INTO digital_orders/.test(String(sql))
        ? Promise.resolve({ rows: [{ id: 'o1', order_number: 7, company_id: 'c1' }] })
        : Promise.resolve({ rows: [] })),
      release: jest.fn(),
    }));
  });

  const pedir = () => request(makeApp()).post('/storefront/adega/order').send({
    customer_name: 'Cliente', customer_phone: '11999999999',
    delivery_type: 'pickup', payment_method: 'pix',
    items: [{ product_id: 'p1', quantity: 1 }],
  });
  const criouPedido = () => db.connect.mock.calls.length > 0;

  test('fora do horario: 409 com mensagem para o cliente e nenhum pedido criado', async () => {
    loja.business_hours = SEM_EXPEDIENTE;
    const res = await pedir();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOJA_FECHADA');
    expect(res.body.error).toMatch(/loja está fechada agora/);
    expect(res.body.error).toMatch(/sacola fica guardada/);
    expect(criouPedido()).toBe(false);
  });

  test('sem horario cadastrado: pedido segue como hoje', async () => {
    loja.business_hours = {};
    const res = await pedir();
    expect(res.status).not.toBe(409);
    expect(criouPedido()).toBe(true);
  });

  test('"Sempre aberta" ignora o horario', async () => {
    loja.business_hours = SEM_EXPEDIENTE;
    loja.always_open = true;
    const res = await pedir();
    expect(res.status).not.toBe(409);
    expect(criouPedido()).toBe(true);
  });
});

// ── O painel nao salva horario sem sentido ─────────────────────────────
describe('PUT /companies/:id/digital-channel valida o horario', () => {
  const express = require('express');
  const request = require('supertest');
  const db = require('../src/config/database');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { role: 'client' }; next(); });
  app.use('/companies/:id/digital-channel', require('../src/routes/digitalChannel'));

  let gravado;
  beforeEach(() => {
    gravado = null;
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/SELECT business_hours FROM digital_channel_config/.test(s)) {
        return { rows: gravado ? [{ business_hours: gravado }] : [] };
      }
      if (s.includes('INSERT INTO digital_channel_config')) return { rows: [{ company_id: 'cid-1', slug: 'adega' }] };
      return { rows: [] };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const salvar = (business_hours) =>
    request(app).put('/companies/cid-1/digital-channel').send({ business_hours });
  const gravou = () => db.query.mock.calls.some(([s]) => /INSERT INTO digital_channel_config/.test(String(s)));

  test('18:00 as 02:00 salva', async () => {
    const r = await salvar(ADEGA);
    expect(r.status).toBe(200);
    expect(gravou()).toBe(true);
  });

  test('abertura igual ao fechamento: 400 explicando, nada gravado', async () => {
    const r = await salvar({ ...ADEGA, sex: { open: '18:00', close: '18:00', closed: false } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('HORARIO_INVALIDO');
    expect(r.body.error).toMatch(/sexta/);
    expect(gravou()).toBe(false);
  });

  test('o mesmo horario invalido que ja estava gravado nao trava o resto do formulario', async () => {
    gravado = { ...ADEGA, sex: { open: '18:00', close: '18:00', closed: false } };
    const r = await salvar(gravado);
    expect(r.status).toBe(200);
    expect(gravou()).toBe(true);
  });
});
