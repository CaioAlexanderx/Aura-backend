// ============================================================
// AURA. — Odonto: horário de funcionamento (mockup aprovado 17/09/2026)
//
// O que estes testes travam:
//   1. validateHours: HH:MM, passos de 15 min, fim > início, sem
//      sobreposição, 1–3 turnos, dias ausentes = fechado, mensagens em pt
//   2. isWithinHours no fuso de São Paulo (20:30 BRT = 23:30Z)
//   3. intersectWindow (só restringe), gridRange (±1h), generateSlots
//   4. effectiveOnlineHours (clínica / janela / legado + duração)
//   5. GET/PUT /dental/hours
//   6. agenda online: config devolve/aceita use_clinic_hours e online_window;
//      rota pública usa a interseção e recusa pedido fora dela
//   7. POST/PATCH de agendamento devolvem outside_hours só com horário salvo
// Mock do banco por CONTEÚDO DO SQL.
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
  requireModule: () => (req, res, next) => next(),
}));

const H = require('../src/services/dentalHours');

const CID = '11111111-1111-4111-8111-111111111111';
const AID = '22222222-2222-4222-8222-222222222222';
const PAC = '33333333-3333-4333-8333-333333333333';

const day = (weekday, ...shifts) => ({
  weekday, open: shifts.length > 0,
  shifts: shifts.map(([start, end]) => ({ start, end })),
});

// seg–sex 08–12 e 14–18; sáb 08–12; dom fechado
const CLINICA = [
  day(1, ['08:00', '12:00'], ['14:00', '18:00']),
  day(2, ['08:00', '12:00'], ['14:00', '18:00']),
  day(3, ['08:00', '12:00'], ['14:00', '18:00']),
  day(4, ['08:00', '12:00'], ['14:00', '18:00']),
  day(5, ['08:00', '12:00'], ['14:00', '21:00']),
  day(6, ['08:00', '12:00']),
  day(7),
];

// ── 1. validação ─────────────────────────────────────────────────────────
describe('validateHours', () => {
  test('aceita, ordena turnos e completa dias ausentes como fechados', () => {
    const v = H.validateHours([
      { weekday: 1, open: true, shifts: [{ start: '14:00', end: '18:00' }, { start: '08:00', end: '12:00' }] },
      { weekday: 3, open: false, shifts: [{ start: '08:00', end: '09:00' }] },
    ], 30);
    expect(v.ok).toBe(true);
    expect(v.default_interval_min).toBe(30);
    expect(v.hours).toHaveLength(7);
    expect(v.hours[0]).toEqual(day(1, ['08:00', '12:00'], ['14:00', '18:00']));
    expect(v.hours[2]).toEqual({ weekday: 3, open: false, shifts: [] });
    expect(v.hours[6]).toEqual({ weekday: 7, open: false, shifts: [] });
  });

  test('turnos encostados (12:00–12:00) não são sobreposição; 24:00 vale como fim', () => {
    const v = H.validateHours([day(2, ['08:00', '12:00'], ['12:00', '24:00'])], null);
    expect(v.ok).toBe(true);
    expect(v.default_interval_min).toBeNull();
  });

  test.each([
    [[day(1, ['12:00', '08:00'])], 'Segunda-feira, turno 1: o fim (08:00) precisa ser depois do início (12:00).'],
    [[day(1, ['08:00', '08:00'])], 'Segunda-feira, turno 1: o fim (08:00) precisa ser depois do início (08:00).'],
    [[day(2, ['08:10', '12:00'])], 'Terça-feira, turno 1: o início (08:10) precisa ser em intervalos de 15 minutos.'],
    [[day(3, ['08:00', '12:05'])], 'Quarta-feira, turno 1: o fim (12:05) precisa ser em intervalos de 15 minutos.'],
    [[day(4, ['8h', '12:00'])], 'Quinta-feira, turno 1: horário de início inválido (use HH:MM).'],
    [[day(5, ['08:00', '25:00'])], 'Sexta-feira, turno 1: horário de fim inválido (use HH:MM).'],
    [[day(6, ['08:00', '12:00'], ['11:00', '13:00'])], 'Sábado: os turnos 08:00–12:00 e 11:00–13:00 se sobrepõem.'],
    [[{ weekday: 7, open: true, shifts: [] }], 'Domingo: informe pelo menos um turno ou marque o dia como fechado.'],
    [[day(1, ['07:00', '08:00'], ['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '14:00'])], 'Segunda-feira: no máximo 3 turnos por dia.'],
    [[day(1, ['08:00', '12:00']), day(1, ['13:00', '14:00'])], 'Segunda-feira aparece mais de uma vez.'],
    [[{ weekday: 8, open: true, shifts: [] }], 'Dia na posição 1: dia da semana inválido (use 1 = segunda … 7 = domingo).'],
    [[day(1), day(2)], 'Abra o consultório em pelo menos um dia da semana.'],
    ['seg 8-18', 'Envie o horário como uma lista de dias da semana.'],
  ])('recusa %j', (hours, msg) => {
    const v = H.validateHours(hours, null);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message)).toContain(msg);
  });

  test('erro traz weekday e shift para o app marcar o campo', () => {
    const v = H.validateHours([day(1, ['08:00', '12:00'], ['13:00', '12:30'])], null);
    expect(v.errors[0]).toMatchObject({ weekday: 1, shift: 2, field: 'end' });
  });

  test.each([0, 10, 90, 'abc'])('intervalo padrão %p recusado', (n) => {
    const v = H.validateHours([day(1, ['08:00', '12:00'])], n);
    expect(v.ok).toBe(false);
    expect(v.errors[0].field).toBe('default_interval_min');
  });

  test.each([15, 20, 30, 45, 60, '45'])('intervalo padrão %p aceito', (n) => {
    expect(H.validateHours([day(1, ['08:00', '12:00'])], n).default_interval_min).toBe(Number(n));
  });

  test('sugestão: seg–sex 08–18, fim de semana fechado', () => {
    const s = H.suggestion();
    expect(s.hours.filter((d) => d.open).map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect(s.hours[0].shifts).toEqual([{ start: '08:00', end: '18:00' }]);
    expect(H.validateHours(s.hours, null).ok).toBe(true);
  });
});

// ── 2. fuso ──────────────────────────────────────────────────────────────
describe('isWithinHours (America/Sao_Paulo)', () => {
  // 18/09/2026 é sexta-feira (turno da tarde até 21:00)
  test('20:30 BRT (23:30Z) de sexta está dentro', () => {
    expect(H.localParts('2026-09-18T23:30:00Z')).toMatchObject({ weekday: 5, minutes: 20 * 60 + 30, date: '2026-09-18' });
    expect(H.isWithinHours(CLINICA, '2026-09-18T23:30:00Z')).toBe(true);
    expect(H.isWithinHours(CLINICA, new Date('2026-09-18T23:30:00Z'), 30)).toBe(true);
  });

  test('20:30 BRT de sexta com 45 min passa das 21:00 → fora', () => {
    expect(H.isWithinHours(CLINICA, '2026-09-18T23:30:00Z', 45)).toBe(false);
  });

  test('22:00 BRT de sexta é 01:00Z de sábado — conta como sexta, fora do turno', () => {
    expect(H.localParts('2026-09-19T01:00:00Z')).toMatchObject({ weekday: 5, minutes: 22 * 60 });
    expect(H.isWithinHours(CLINICA, '2026-09-19T01:00:00Z')).toBe(false);
  });

  test('almoço (12:30 BRT = 15:30Z de quinta) está fora', () => {
    expect(H.isWithinHours(CLINICA, '2026-09-17T15:30:00Z')).toBe(false);
  });

  test('consulta que atravessa o almoço está fora; que termina no fim do turno, dentro', () => {
    expect(H.isWithinHours(CLINICA, '2026-09-17T14:30:00Z', 60)).toBe(false); // 11:30–12:30
    expect(H.isWithinHours(CLINICA, '2026-09-17T14:00:00Z', 60)).toBe(true);  // 11:00–12:00
  });

  test('início exato do turno dentro, fim exato fora (sem duração)', () => {
    expect(H.isWithinHours(CLINICA, '2026-09-17T11:00:00Z')).toBe(true);  // 08:00
    expect(H.isWithinHours(CLINICA, '2026-09-17T15:00:00Z')).toBe(false); // 12:00
  });

  test('domingo fechado e data inválida → false', () => {
    expect(H.isWithinHours(CLINICA, '2026-09-20T13:00:00Z')).toBe(false);
    expect(H.isWithinHours(CLINICA, 'ontem')).toBe(false);
  });
});

// ── 3. interseção, grade e slots ─────────────────────────────────────────
describe('intersectWindow / gridRange / generateSlots', () => {
  test('janela só restringe: recorta turnos e fecha dias fora da lista', () => {
    const r = H.intersectWindow(CLINICA, { from: '09:00', to: '15:00', days: [1, 6, 7] });
    expect(r[0]).toEqual(day(1, ['09:00', '12:00'], ['14:00', '15:00']));
    expect(r[1]).toEqual(day(2));
    expect(r[5]).toEqual(day(6, ['09:00', '12:00']));
    expect(r[6]).toEqual(day(7)); // domingo na janela, mas a clínica não abre
  });

  test('janela maior que a clínica não amplia', () => {
    const r = H.intersectWindow(CLINICA, { from: '06:00', to: '23:00', days: [1, 2, 3, 4, 5, 6, 7] });
    expect(r).toEqual(CLINICA);
  });

  test('janela que cai toda no almoço fecha o dia', () => {
    const r = H.intersectWindow(CLINICA, { from: '12:00', to: '14:00', days: [1] });
    expect(r[0]).toEqual(day(1));
  });

  test('gridRange: 1h antes da primeira abertura e 1h depois do último fechamento', () => {
    expect(H.gridRange(CLINICA)).toEqual({ start_hour: 7, end_hour: 22 });
    expect(H.gridRange([day(1, ['08:30', '17:15'])])).toEqual({ start_hour: 7, end_hour: 19 });
    expect(H.gridRange([day(1, ['00:00', '24:00'])])).toEqual({ start_hour: 0, end_hour: 24 });
  });

  test('gridRange sem horário → 07–19', () => {
    expect(H.gridRange(null)).toEqual({ start_hour: 7, end_hour: 19 });
    expect(H.gridRange([day(1)])).toEqual({ start_hour: 7, end_hour: 19 });
  });

  test('generateSlots: só horários que cabem inteiros', () => {
    expect(H.generateSlots([{ start: '08:00', end: '09:40' }, { start: '14:00', end: '15:00' }], 30))
      .toEqual(['08:00', '08:30', '09:00', '14:00', '14:30']);
    expect(H.generateSlots([{ start: '08:00', end: '09:00' }], 0)).toEqual([]);
  });

  test('validateOnlineWindow', () => {
    expect(H.validateOnlineWindow(null)).toEqual({ ok: true, value: null });
    expect(H.validateOnlineWindow({ from: '09:00', to: '12:00', days: [5, 1] }))
      .toEqual({ ok: true, value: { from: '09:00', to: '12:00', days: [1, 5] } });
    expect(H.validateOnlineWindow({ from: '12:00', to: '09:00', days: [1] }).ok).toBe(false);
    expect(H.validateOnlineWindow({ from: '09:00', to: '12:00', days: [0] }).ok).toBe(false);
    expect(H.validateOnlineWindow({ from: '09:00', to: '12:00', days: [] }).ok).toBe(false);
    expect(H.validateOnlineWindow({ from: '09:07', to: '12:00', days: [1] }).ok).toBe(false);
    expect(H.validateOnlineWindow('9-12').ok).toBe(false);
  });
});

// ── 4. horário efetivo online ────────────────────────────────────────────
describe('effectiveOnlineHours', () => {
  const clinic = { configured: true, hours: CLINICA, default_interval_min: 45 };
  const naoConfig = { configured: false, hours: null, default_interval_min: null };
  const base = {
    start_hour: 9, end_hour: 11, available_days: [1, 2], slot_duration_min: 60,
    slot_duration_custom: false, use_clinic_hours: true, online_window: null,
  };

  test('clínica configurada + use_clinic_hours → horário da clínica e intervalo da clínica', () => {
    const e = H.effectiveOnlineHours(clinic, base);
    expect(e.source).toBe('clinic');
    expect(e.hours).toEqual(CLINICA);
    expect(e.slot_duration_min).toBe(45);
  });

  test('duração escolhida pelo dentista vence o intervalo da clínica', () => {
    const e = H.effectiveOnlineHours(clinic, { ...base, slot_duration_custom: true, slot_duration_min: 20 });
    expect(e.slot_duration_min).toBe(20);
  });

  test('clínica sem intervalo padrão → slot_duration_min da config', () => {
    const e = H.effectiveOnlineHours({ ...clinic, default_interval_min: null }, base);
    expect(e.slot_duration_min).toBe(60);
  });

  test('use_clinic_hours=false → interseção com online_window', () => {
    const e = H.effectiveOnlineHours(clinic, {
      ...base, use_clinic_hours: false, online_window: { from: '10:00', to: '16:00', days: [1] },
    });
    expect(e.source).toBe('window');
    expect(e.hours[0]).toEqual(day(1, ['10:00', '12:00'], ['14:00', '16:00']));
    expect(e.hours.filter((d) => d.open)).toHaveLength(1);
  });

  test('use_clinic_hours=false sem online_window → janela antiga (start/end_hour, 0=dom)', () => {
    const e = H.effectiveOnlineHours(clinic, { ...base, use_clinic_hours: false });
    expect(e.hours.filter((d) => d.open).map((d) => d.weekday)).toEqual([1, 2]);
    expect(e.hours[0].shifts).toEqual([{ start: '09:00', end: '11:00' }]);
  });

  test('clínica não configurada + use_clinic_hours → legado (comportamento atual)', () => {
    const e = H.effectiveOnlineHours(naoConfig, base);
    expect(e.source).toBe('legacy');
    expect(e.hours.filter((d) => d.open).map((d) => d.weekday)).toEqual([1, 2]);
    expect(e.hours[0].shifts).toEqual([{ start: '09:00', end: '11:00' }]);
    expect(e.slot_duration_min).toBe(60);
  });

  test('clínica não configurada + janela própria → janela', () => {
    const e = H.effectiveOnlineHours(naoConfig, {
      ...base, use_clinic_hours: false, online_window: { from: '13:00', to: '15:00', days: [3] },
    });
    expect(e.source).toBe('window');
    expect(e.hours[2]).toEqual(day(3, ['13:00', '15:00']));
  });

  test('toDayWindows usa chaves Date.getDay() (0 = domingo)', () => {
    const w = H.toDayWindows(CLINICA);
    expect(w['0']).toEqual([]);
    expect(w['1']).toEqual(CLINICA[0].shifts);
    expect(w['6']).toEqual(CLINICA[5].shifts);
  });

  test('isOfferedSlot respeita dia, turno e passo', () => {
    // 21/09/2026 é segunda
    expect(H.weekdayOfDate('2026-09-21')).toBe(1);
    expect(H.isOfferedSlot(CLINICA, 30, '2026-09-21', '08:30')).toBe(true);
    expect(H.isOfferedSlot(CLINICA, 30, '2026-09-21', '11:30:00')).toBe(true);
    expect(H.isOfferedSlot(CLINICA, 30, '2026-09-21', '12:00')).toBe(false); // almoço
    expect(H.isOfferedSlot(CLINICA, 30, '2026-09-21', '08:15')).toBe(false); // fora do passo
    expect(H.isOfferedSlot(CLINICA, 30, '2026-09-20', '09:00')).toBe(false); // domingo
  });
});

// ── helpers de rota ──────────────────────────────────────────────────────
function mountDental() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/dental', require('../src/routes/dental'));
  return app;
}

let clinicRow;   // linha de dental_clinic_hours (null = não configurou)
let bookingRow;  // linha de dental_booking_config
let client;

function responder(sql, params) {
  const s = String(sql || '');
  if (/FROM dental_clinic_hours/.test(s)) return Promise.resolve({ rows: clinicRow ? [clinicRow] : [] });
  if (/INSERT INTO dental_clinic_hours/.test(s)) {
    return Promise.resolve({ rows: [{ business_hours: JSON.parse(params[1]), default_interval_min: params[2] }] });
  }
  if (/FROM dental_booking_config/.test(s)) return Promise.resolve({ rows: bookingRow ? [bookingRow] : [] });
  if (/^\s*UPDATE dental_booking_config/.test(s)) return Promise.resolve({ rows: [{ ...bookingRow, _sql: s, _params: params }] });
  if (/INSERT INTO dental_booking_requests/.test(s)) return Promise.resolve({ rows: [{ id: 'req1' }] });
  if (/FOR UPDATE/.test(s)) {
    return Promise.resolve({ rows: [{ id: AID, status: 'agendado', scheduled_at: new Date('2026-09-21T12:00:00Z'), duration_min: 60, practitioner_id: null }] });
  }
  if (/^\s*UPDATE dental_appointments/.test(s)) {
    // devolve o horário gravado a partir dos parâmetros
    const sched = /scheduled_at = \$(\d+)/.exec(s);
    const dur = /duration_min = \$(\d+)/.exec(s);
    return Promise.resolve({
      rows: [{
        id: AID,
        scheduled_at: sched ? params[Number(sched[1]) - 1] : '2026-09-21T12:00:00Z',
        duration_min: dur ? params[Number(dur[1]) - 1] : 60,
      }],
    });
  }
  if (/FROM customers\s+WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: PAC }] });
  if (/INSERT INTO dental_appointments/.test(s)) return Promise.resolve({ rows: [{ id: 'novo' }] });
  return Promise.resolve({ rows: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  clinicRow = null;
  bookingRow = null;
  client = { query: jest.fn(responder), release: jest.fn() };
  db.connect.mockResolvedValue(client);
  db.query.mockImplementation(responder);
});

// ── 5. GET/PUT /hours ────────────────────────────────────────────────────
describe('GET/PUT /dental/hours', () => {
  const app = mountDental();

  test('primeiro acesso: configured false, hours null, grade 07–19 e sugestão', async () => {
    const res = await request(app).get(`/companies/${CID}/dental/hours`);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.hours).toBeNull();
    expect(res.body.default_interval_min).toBeNull();
    expect(res.body.grid).toEqual({ start_hour: 7, end_hour: 19 });
    expect(res.body.suggestion.hours).toHaveLength(7);
    const sql = db.query.mock.calls[0];
    expect(sql[1]).toEqual([CID]);
  });

  test('com horário salvo: devolve os 7 dias e a grade calculada', async () => {
    clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
    const res = await request(app).get(`/companies/${CID}/dental/hours`);
    expect(res.body.configured).toBe(true);
    expect(res.body.hours).toEqual(CLINICA);
    expect(res.body.default_interval_min).toBe(30);
    expect(res.body.grid).toEqual({ start_hour: 7, end_hour: 22 });
  });

  test('PUT válido faz upsert por company_id', async () => {
    const res = await request(app)
      .put(`/companies/${CID}/dental/hours`)
      .send({ hours: CLINICA, default_interval_min: 20 });
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.hours).toEqual(CLINICA);
    expect(res.body.default_interval_min).toBe(20);
    const [sql, params] = db.query.mock.calls.find((c) => /INSERT INTO dental_clinic_hours/.test(c[0]));
    expect(sql).toMatch(/ON CONFLICT \(company_id\) DO UPDATE/);
    expect(params[0]).toBe(CID);
    expect(JSON.parse(params[1])).toEqual(CLINICA);
    expect(params[2]).toBe(20);
  });

  test('PUT inválido → 400 com mensagens por dia/turno, nada gravado', async () => {
    const res = await request(app)
      .put(`/companies/${CID}/dental/hours`)
      .send({ hours: [day(1, ['08:00', '12:00'], ['11:00', '13:00']), day(2, ['10:00', '09:00'])] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BUSINESS_HOURS');
    expect(res.body.errors.map((e) => e.message)).toEqual([
      'Segunda-feira: os turnos 08:00–12:00 e 11:00–13:00 se sobrepõem.',
      'Terça-feira, turno 1: o fim (09:00) precisa ser depois do início (10:00).',
    ]);
    expect(res.body.error).toBe(res.body.errors[0].message);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── 6. agenda online ─────────────────────────────────────────────────────
describe('agenda online', () => {
  const baseBooking = {
    company_id: CID, company_name: 'Clínica X', slug: 'clinica-x', is_active: true,
    welcome_msg: 'Oi', min_advance_hours: 2, max_advance_days: 30, require_phone: false,
    slot_duration_min: 60, slot_duration_custom: false,
    available_days: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 18,
    use_clinic_hours: true, online_window: null,
  };

  describe('config (admin)', () => {
    const app = mountDental();

    test('GET devolve use_clinic_hours, online_window e o horário efetivo', async () => {
      bookingRow = { ...baseBooking };
      clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
      const res = await request(app).get(`/companies/${CID}/dental/booking/config`);
      expect(res.status).toBe(200);
      expect(res.body.config.use_clinic_hours).toBe(true);
      expect(res.body.config.online_window).toBeNull();
      expect(res.body.effective).toMatchObject({
        source: 'clinic', clinic_hours_configured: true, slot_duration_min: 30,
      });
      expect(res.body.effective.day_windows['1']).toEqual(CLINICA[0].shifts);
    });

    test('PUT grava use_clinic_hours e online_window normalizada', async () => {
      bookingRow = { ...baseBooking };
      const res = await request(app)
        .put(`/companies/${CID}/dental/booking/config`)
        .send({ use_clinic_hours: false, online_window: { from: '09:00', to: '12:00', days: [3, 1] } });
      expect(res.status).toBe(200);
      const [sql, params] = db.query.mock.calls.find((c) => /^\s*UPDATE dental_booking_config/.test(c[0]));
      expect(sql).toMatch(/use_clinic_hours = \$1/);
      expect(sql).toMatch(/online_window = \$2::jsonb/);
      expect(params[0]).toBe(false);
      expect(JSON.parse(params[1])).toEqual({ from: '09:00', to: '12:00', days: [1, 3] });
    });

    test('PUT online_window null limpa a janela', async () => {
      bookingRow = { ...baseBooking };
      await request(app).put(`/companies/${CID}/dental/booking/config`).send({ online_window: null });
      const [sql, params] = db.query.mock.calls.find((c) => /^\s*UPDATE dental_booking_config/.test(c[0]));
      expect(sql).toMatch(/online_window = \$1::jsonb/);
      expect(params[0]).toBeNull();
    });

    test('PUT slot_duration_min marca custom; null volta a seguir a clínica', async () => {
      bookingRow = { ...baseBooking };
      await request(app).put(`/companies/${CID}/dental/booking/config`).send({ slot_duration_min: 20 });
      let [sql, params] = db.query.mock.calls.find((c) => /^\s*UPDATE dental_booking_config/.test(c[0]));
      expect(sql).toMatch(/slot_duration_custom = \$1, slot_duration_min = \$2/);
      expect(params.slice(0, 2)).toEqual([true, 20]);

      jest.clearAllMocks();
      await request(app).put(`/companies/${CID}/dental/booking/config`).send({ slot_duration_min: null });
      [sql, params] = db.query.mock.calls.find((c) => /^\s*UPDATE dental_booking_config/.test(c[0]));
      expect(sql).toMatch(/slot_duration_custom = \$1/);
      expect(sql).not.toMatch(/slot_duration_min =/);
      expect(params[0]).toBe(false);
    });

    test.each([
      [{ online_window: { from: '14:00', to: '09:00', days: [1] } }, 'Janela online: o horário final precisa ser depois do inicial.'],
      [{ online_window: { from: '09:00', to: '12:00', days: [0, 1] } }, 'Janela online: dias devem ser uma lista de 1 (segunda) a 7 (domingo), sem repetir.'],
      [{ use_clinic_hours: 'sim' }, 'use_clinic_hours deve ser true ou false'],
    ])('PUT inválido %j → 400', async (body, msg) => {
      const res = await request(app).put(`/companies/${CID}/dental/booking/config`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(msg);
    });
  });

  describe('rota pública /dental/book/:slug', () => {
    const app = express();
    app.use(express.json());
    app.use('/dental/book', require('../src/routes/dentalBooking'));

    test('sem horário da clínica: mantém start_hour/end_hour antigos (legacy)', async () => {
      bookingRow = { ...baseBooking, start_hour: 9, end_hour: 17, available_days: [1, 3] };
      const res = await request(app).get('/dental/book/clinica-x');
      expect(res.status).toBe(200);
      expect(res.body.hours_source).toBe('legacy');
      expect(res.body).toMatchObject({ start_hour: 9, end_hour: 17, available_days: [1, 3], slot_duration_min: 60 });
      expect(res.body.day_windows['1']).toEqual([{ start: '09:00', end: '17:00' }]);
      expect(res.body.day_windows['2']).toEqual([]);
    });

    test('com horário da clínica: janelas por dia (com almoço) e intervalo da clínica', async () => {
      bookingRow = { ...baseBooking };
      clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
      const res = await request(app).get('/dental/book/clinica-x');
      expect(res.body.hours_source).toBe('clinic');
      expect(res.body.slot_duration_min).toBe(30);
      expect(res.body.day_windows['1']).toEqual([{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }]);
      expect(res.body.day_windows['0']).toEqual([]);
      expect(res.body).toMatchObject({ start_hour: 8, end_hour: 21, available_days: [1, 2, 3, 4, 5, 6] });
    });

    test('use_clinic_hours=false: vale a interseção com a janela online', async () => {
      bookingRow = { ...baseBooking, use_clinic_hours: false, online_window: { from: '10:00', to: '15:00', days: [1, 7] } };
      clinicRow = { business_hours: CLINICA, default_interval_min: null };
      const res = await request(app).get('/dental/book/clinica-x');
      expect(res.body.hours_source).toBe('window');
      expect(res.body.day_windows['1']).toEqual([{ start: '10:00', end: '12:00' }, { start: '14:00', end: '15:00' }]);
      expect(res.body.day_windows['0']).toEqual([]); // domingo na janela, clínica fechada
      expect(res.body.available_days).toEqual([1]);
      expect(res.body.slot_duration_min).toBe(60);
    });

    const pedido = (preferred_date, preferred_time) => ({
      patient_name: 'Ana', patient_phone: '11999990000', preferred_date, preferred_time,
    });

    test('POST no horário oferecido → 201', async () => {
      bookingRow = { ...baseBooking };
      clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
      const res = await request(app).post('/dental/book/clinica-x').send(pedido('2026-09-21', '14:30'));
      expect(res.status).toBe(201);
    });

    test('POST no almoço → 400 OUTSIDE_ONLINE_HOURS, nada gravado', async () => {
      bookingRow = { ...baseBooking };
      clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
      const res = await request(app).post('/dental/book/clinica-x').send(pedido('2026-09-21', '12:30'));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OUTSIDE_ONLINE_HOURS');
      expect(db.query.mock.calls.some((c) => /INSERT INTO dental_booking_requests/.test(c[0]))).toBe(false);
    });

    test('POST sem horário da clínica: comportamento antigo (não valida)', async () => {
      bookingRow = { ...baseBooking };
      const res = await request(app).post('/dental/book/clinica-x').send(pedido('2026-09-20', '12:30'));
      expect(res.status).toBe(201);
    });
  });
});

// ── 7. outside_hours nas rotas de agendamento ────────────────────────────
describe('outside_hours em POST/PATCH /appointments', () => {
  const app = mountDental();

  test('POST sem horário configurado: campo ausente', async () => {
    const res = await request(app)
      .post(`/companies/${CID}/dental/appointments`)
      .send({ customer_id: PAC, scheduled_at: '2026-09-21T15:30:00Z' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('outside_hours');
  });

  test('POST no almoço (12:30 BRT) → outside_hours true, mas cria (encaixe)', async () => {
    clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
    const res = await request(app)
      .post(`/companies/${CID}/dental/appointments`)
      .send({ customer_id: PAC, scheduled_at: '2026-09-21T15:30:00Z', duration_min: 30 });
    expect(res.status).toBe(201);
    expect(res.body.outside_hours).toBe(true);
    expect(db.query.mock.calls.some((c) => /INSERT INTO dental_appointments/.test(c[0]))).toBe(true);
  });

  test('POST 09:00 BRT (12:00Z) com 60 min → outside_hours false', async () => {
    clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
    const res = await request(app)
      .post(`/companies/${CID}/dental/appointments`)
      .send({ customer_id: PAC, scheduled_at: '2026-09-21T12:00:00Z' });
    expect(res.body.outside_hours).toBe(false);
  });

  test('POST: falha ao ler o horário não derruba a criação', async () => {
    db.query.mockImplementation((sql, params) => (/FROM dental_clinic_hours/.test(sql)
      ? Promise.reject(new Error('relation "dental_clinic_hours" does not exist'))
      : responder(sql, params)));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post(`/companies/${CID}/dental/appointments`)
      .send({ customer_id: PAC, scheduled_at: '2026-09-21T12:00:00Z' });
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('outside_hours');
  });

  test('PATCH remarcando para sexta 20:30 BRT (23:30Z) → dentro', async () => {
    clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ scheduled_at: '2026-09-18T23:30:00Z', duration_min: 30 });
    expect(res.status).toBe(200);
    expect(res.body.outside_hours).toBe(false);
  });

  test('PATCH remarcando para domingo → outside_hours true', async () => {
    clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ scheduled_at: '2026-09-20T13:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.outside_hours).toBe(true);
  });

  test('PATCH só de status: campo ausente (não consulta o horário)', async () => {
    clinicRow = { business_hours: CLINICA, default_interval_min: 30 };
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ status: 'confirmado' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('outside_hours');
    expect(db.query.mock.calls.some((c) => /dental_clinic_hours/.test(c[0]))).toBe(false);
  });
});
