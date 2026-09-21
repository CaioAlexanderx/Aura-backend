// ============================================================
// AURA. — Odonto: máquina de estados, conflitos de horário e validações
// QA do módulo odonto (dentista solo), 16/09/2026 — fase 1 (1.1 e 1.5)
//
// O que estes testes travam:
//   1. a tabela de transições (inclui confirmado, paciente_consultorio,
//      falta_justificada e o "concluir sem iniciar")
//   2. o cálculo de conflito (mesmo profissional, null só com null, status
//      que liberam o horário, intervalos semiabertos)
//   3. validação de scheduled_at e birth_date no futuro
//   4. PATCH com status + clinical_notes aplica os dois (antes descartava)
//   5. transição inválida → 400 INVALID_TRANSITION com mensagem legível
//   6. POST devolve conflicts; reject_on_conflict → 409 SCHEDULE_CONFLICT
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

const S = require('../src/services/dentalSchedule');

const CID = '11111111-1111-4111-8111-111111111111';
const AID = '22222222-2222-4222-8222-222222222222';
const PAC = '33333333-3333-4333-8333-333333333333';
const DR1 = '44444444-4444-4444-8444-444444444444';
const DR2 = '55555555-5555-4555-8555-555555555555';

// ── 1. transições ────────────────────────────────────────────────────────
describe('tabela de transições', () => {
  const permitidas = [
    ['agendado', 'confirmado'], ['agendado', 'avaliacao'], ['agendado', 'em_atendimento'],
    ['agendado', 'cancelado'], ['agendado', 'faltou'], ['agendado', 'falta_justificada'],
    ['agendado', 'paciente_consultorio'], ['agendado', 'concluido'],
    ['confirmado', 'agendado'], ['confirmado', 'paciente_consultorio'], ['confirmado', 'em_atendimento'],
    ['confirmado', 'cancelado'], ['confirmado', 'faltou'], ['confirmado', 'falta_justificada'],
    ['confirmado', 'concluido'],
    ['paciente_consultorio', 'em_atendimento'], ['paciente_consultorio', 'cancelado'],
    ['paciente_consultorio', 'concluido'],
    ['avaliacao', 'aprovado'], ['avaliacao', 'cancelado'],
    ['aprovado', 'em_atendimento'], ['aprovado', 'cancelado'],
    ['em_atendimento', 'concluido'], ['em_atendimento', 'cancelado'],
    ['faltou', 'agendado'], ['faltou', 'falta_justificada'],
    ['falta_justificada', 'agendado'], ['falta_justificada', 'faltou'],
  ];
  test.each(permitidas)('%s → %s permitido', (de, para) => {
    expect(S.canTransition(de, para)).toBe(true);
    expect(() => S.assertTransition(de, para)).not.toThrow();
  });

  const proibidas = [
    ['concluido', 'agendado'], ['cancelado', 'agendado'], ['em_atendimento', 'agendado'],
    ['paciente_consultorio', 'faltou'], ['paciente_consultorio', 'agendado'],
    ['avaliacao', 'concluido'], ['faltou', 'concluido'], ['falta_justificada', 'cancelado'],
    ['aprovado', 'confirmado'],
  ];
  test.each(proibidas)('%s → %s proibido, com mensagem legível', (de, para) => {
    expect(S.canTransition(de, para)).toBe(false);
    let err;
    try { S.assertTransition(de, para); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(S.ScheduleError);
    expect(err.code).toBe('INVALID_TRANSITION');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe(`Não é possível mudar de "${de}" para "${para}"`);
  });

  test('toda transição cobre só status conhecidos e terminais não saem', () => {
    for (const [de, paras] of Object.entries(S.TRANSITIONS)) {
      for (const p of paras) expect(S.isKnownStatus(p)).toBe(true);
      expect(paras).not.toContain(de);
    }
    expect(S.TRANSITIONS.concluido).toEqual([]);
    expect(S.TRANSITIONS.cancelado).toEqual([]);
  });

  test('mesmo status é no-op aceito; status desconhecido → INVALID_STATUS', () => {
    expect(S.canTransition('confirmado', 'confirmado')).toBe(true);
    expect(S.timestampSetsFor('confirmado', 'confirmado')).toEqual([]);
    expect(() => S.assertTransition('agendado', 'xyz')).toThrow(expect.objectContaining({ code: 'INVALID_STATUS' }));
  });

  test('timestamps coerentes', () => {
    expect(S.timestampSetsFor('confirmado', 'em_atendimento')).toEqual(['started_at = COALESCE(started_at, NOW())']);
    const concl = S.timestampSetsFor('agendado', 'concluido');
    expect(concl).toContain('concluded_at = NOW()');
    expect(concl.join(' ')).toMatch(/started_at = COALESCE\(started_at, LEAST\(scheduled_at, NOW\(\)\)\)/);
    expect(S.timestampSetsFor('agendado', 'cancelado')).toEqual(['cancelled_at = NOW()']);
    expect(S.timestampSetsFor('agendado', 'confirmado')).toEqual([]);
  });
});

// ── 2. conflitos ─────────────────────────────────────────────────────────
describe('findConflicts', () => {
  const base = { scheduled_at: '2026-09-20T13:00:00Z', duration_min: 60, practitioner_id: DR1 };
  const cand = (over) => ({
    id: 'x', patient_name: 'Ana', scheduled_at: '2026-09-20T13:30:00Z', duration_min: 30,
    practitioner_id: DR1, status: 'agendado', ...over,
  });

  test('sobreposição com o mesmo profissional aparece, no formato do contrato', () => {
    expect(S.findConflicts(base, [cand({ id: 'a1' })])).toEqual([
      { id: 'a1', patient_name: 'Ana', scheduled_at: '2026-09-20T13:30:00Z', duration_min: 30 },
    ]);
  });

  test('outro profissional não conflita; null só conflita com null', () => {
    expect(S.findConflicts(base, [cand({ practitioner_id: DR2 })])).toEqual([]);
    expect(S.findConflicts(base, [cand({ practitioner_id: null })])).toEqual([]);
    const semDr = { ...base, practitioner_id: null };
    expect(S.findConflicts(semDr, [cand({ practitioner_id: null })])).toHaveLength(1);
    expect(S.findConflicts(semDr, [cand({ practitioner_id: undefined })])).toHaveLength(1);
    expect(S.findConflicts(semDr, [cand({ practitioner_id: DR1 })])).toEqual([]);
  });

  test.each(['cancelado', 'faltou', 'falta_justificada'])('status %s libera o horário', (status) => {
    expect(S.findConflicts(base, [cand({ status })])).toEqual([]);
  });

  test.each(['agendado', 'confirmado', 'paciente_consultorio', 'em_atendimento', 'concluido', 'aprovado'])(
    'status %s ocupa o horário', (status) => {
      expect(S.findConflicts(base, [cand({ status })])).toHaveLength(1);
    });

  test('encostar não é conflito; 1 minuto de sobreposição é', () => {
    expect(S.findConflicts(base, [cand({ scheduled_at: '2026-09-20T14:00:00Z' })])).toEqual([]);
    expect(S.findConflicts(base, [cand({ scheduled_at: '2026-09-20T12:00:00Z', duration_min: 60 })])).toEqual([]);
    expect(S.findConflicts(base, [cand({ scheduled_at: '2026-09-20T12:00:00Z', duration_min: 61 })])).toHaveLength(1);
    expect(S.findConflicts(base, [cand({ scheduled_at: '2026-09-20T13:59:00Z' })])).toHaveLength(1);
  });

  test('consulta longa que engloba a outra, fusos diferentes e Date do driver', () => {
    const longa = cand({ scheduled_at: new Date('2026-09-20T12:00:00Z'), duration_min: 240 });
    expect(S.findConflicts(base, [longa])).toHaveLength(1);
    // 10:30 em São Paulo = 13:30Z
    expect(S.findConflicts(base, [cand({ scheduled_at: '2026-09-20T10:30:00-03:00' })])).toHaveLength(1);
  });

  test('ignora o próprio agendamento e ordena por horário', () => {
    const r = S.findConflicts({ ...base, id: 'eu' }, [
      cand({ id: 'eu' }),
      cand({ id: 'b', scheduled_at: '2026-09-20T13:45:00Z' }),
      cand({ id: 'a', scheduled_at: '2026-09-20T12:45:00Z' }),
    ]);
    expect(r.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

// ── 3. validações ────────────────────────────────────────────────────────
describe('validações de data', () => {
  test.each([
    '2026-09-20T13:00:00Z', '2026-09-20T10:00:00-03:00', '2026-09-20T10:00', '2026-09-20 10:00:00',
    '2026-09-20T10:00:00.000Z', '2026-09-20', '2028-02-29T08:00:00Z',
  ])('scheduled_at válido: %s', (v) => expect(S.isValidTimestamp(v)).toBe(true));

  test.each([
    '', 'amanhã', '20/09/2026 10:00', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z',
    '2026-09-20T25:00:00Z', '2027-02-29', null, undefined, 12345, {},
  ])('scheduled_at inválido: %p', (v) => expect(S.isValidTimestamp(v)).toBe(false));

  test('duração', () => {
    expect(S.isValidDuration(30)).toBe(true);
    expect(S.isValidDuration('45')).toBe(true);
    expect(S.isValidDuration(0)).toBe(false);
    expect(S.isValidDuration(1441)).toBe(false);
    expect(S.isValidDuration(30.5)).toBe(false);
    expect(S.isValidDuration(null)).toBe(false);
    expect(S.isValidDuration('abc')).toBe(false);
  });

  test('birth_date no futuro usa o dia de São Paulo', () => {
    // 16/09 23:30 em SP = 17/09 02:30Z
    const now = new Date('2026-09-17T02:30:00Z');
    expect(S.todayInSaoPaulo(now)).toBe('2026-09-16');
    expect(S.isBirthDateInFuture('2026-09-17', now)).toBe(true);
    expect(S.isBirthDateInFuture('2026-09-16', now)).toBe(false);
    expect(S.isBirthDateInFuture('1990-01-01', now)).toBe(false);
    expect(S.isBirthDateInFuture('2030-01-01T00:00:00.000Z', now)).toBe(true);
    expect(S.isBirthDateInFuture(null, now)).toBe(false);
    expect(S.isBirthDateInFuture('', now)).toBe(false);
  });
});

// ── 4-6. rotas ───────────────────────────────────────────────────────────
describe('rotas de agendamento', () => {
  const dentalRouter = require('../src/routes/dental');
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/dental', dentalRouter);

  let client;
  let atual;       // linha atual do agendamento (SELECT ... FOR UPDATE)
  let candidatos;  // linhas devolvidas pela busca de conflito

  beforeEach(() => {
    jest.clearAllMocks();
    atual = { id: AID, status: 'confirmado', scheduled_at: new Date('2026-09-20T13:00:00Z'), duration_min: 60, practitioner_id: DR1 };
    candidatos = [];
    const responder = (sql, params) => {
      const s = String(sql || '');
      if (/FOR UPDATE/.test(s)) return Promise.resolve({ rows: atual ? [atual] : [] });
      if (/IS NOT DISTINCT FROM/.test(s)) return Promise.resolve({ rows: candidatos });
      if (/^\s*UPDATE dental_appointments/.test(s)) {
        return Promise.resolve({ rows: [{ id: AID, status: 'x', _sql: s, _params: params }] });
      }
      if (/FROM customers\s+WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: PAC }] });
      if (/INSERT INTO dental_appointments/.test(s)) return Promise.resolve({ rows: [{ id: 'novo' }] });
      return Promise.resolve({ rows: [] });
    };
    client = { query: jest.fn(responder), release: jest.fn() };
    db.connect.mockResolvedValue(client);
    db.query.mockImplementation(responder);
  });

  const sqls = () => client.query.mock.calls.map((c) => String(c[0]).trim());
  const updateCall = () => client.query.mock.calls.find((c) => /^\s*UPDATE dental_appointments/.test(c[0]));

  test('status + clinical_notes vão no MESMO UPDATE, dentro de BEGIN/COMMIT', async () => {
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ status: 'concluido', clinical_notes: 'Restauração 26 OK' });
    expect(res.status).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toMatch(/clinical_notes = \$1/);
    expect(sql).toMatch(/status = \$2/);
    expect(sql).toMatch(/concluded_at = NOW\(\)/);
    expect(sql).toMatch(/started_at = COALESCE\(started_at, LEAST\(scheduled_at, NOW\(\)\)\)/);
    expect(params).toEqual(['Restauração 26 OK', 'concluido', AID, CID]);
    expect(sqls()[0]).toBe('BEGIN');
    expect(sqls()).toContain('COMMIT');
    expect(sqls()).not.toContain('ROLLBACK');
    expect(res.body.conflicts).toEqual([]);
    expect(client.release).toHaveBeenCalled();
  });

  test('confirmado → paciente_consultorio aceito', async () => {
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ status: 'paciente_consultorio' });
    expect(res.status).toBe(200);
    expect(updateCall()[1]).toEqual(['paciente_consultorio', AID, CID]);
  });

  test('transição inválida → 400 INVALID_TRANSITION, nada gravado', async () => {
    atual.status = 'concluido';
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ status: 'agendado', clinical_notes: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Não é possível mudar de "concluido" para "agendado"',
      code: 'INVALID_TRANSITION', from: 'concluido', to: 'agendado',
    });
    expect(updateCall()).toBeUndefined();
    expect(sqls()).toContain('ROLLBACK');
  });

  test('agendamento inexistente → 404', async () => {
    atual = null;
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ status: 'confirmado' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('remarcar devolve conflitos sem bloquear', async () => {
    candidatos = [{ id: 'outro', patient_name: 'Bia', scheduled_at: '2026-09-21T13:30:00Z', duration_min: 30, practitioner_id: DR1, status: 'confirmado' }];
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ scheduled_at: '2026-09-21T13:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toEqual([
      { id: 'outro', patient_name: 'Bia', scheduled_at: '2026-09-21T13:30:00Z', duration_min: 30 },
    ]);
    const busca = client.query.mock.calls.find((c) => /IS NOT DISTINCT FROM/.test(c[0]));
    expect(busca[1]).toEqual([CID, DR1, ['cancelado', 'faltou', 'falta_justificada'], '2026-09-21T13:00:00Z', 60, AID]);
    expect(updateCall()).toBeDefined();
  });

  test('remarcar com reject_on_conflict → 409 e ROLLBACK', async () => {
    candidatos = [{ id: 'outro', patient_name: 'Bia', scheduled_at: '2026-09-21T13:30:00Z', duration_min: 30, practitioner_id: DR1, status: 'agendado' }];
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ scheduled_at: '2026-09-21T13:00:00Z', reject_on_conflict: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SCHEDULE_CONFLICT');
    expect(res.body.conflicts).toHaveLength(1);
    expect(updateCall()).toBeUndefined();
    expect(sqls()).toContain('ROLLBACK');
  });

  test('PATCH com scheduled_at inválido → 400 sem abrir transação', async () => {
    const res = await request(app)
      .patch(`/companies/${CID}/dental/appointments/${AID}`)
      .send({ scheduled_at: '2026-02-30T10:00' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCHEDULED_AT');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('PATCH sem nada → 400 NO_FIELDS', async () => {
    const res = await request(app).patch(`/companies/${CID}/dental/appointments/${AID}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_FIELDS');
  });

  test('POST devolve conflicts e cria mesmo assim', async () => {
    candidatos = [{ id: 'outro', patient_name: 'Bia', scheduled_at: '2026-09-21T13:30:00Z', duration_min: 30, practitioner_id: null, status: 'agendado' }];
    const res = await request(app)
      .post(`/companies/${CID}/dental/appointments`)
      .send({ customer_id: PAC, scheduled_at: '2026-09-21T13:00:00Z', duration_min: 60 });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toEqual({ id: 'novo' });
    expect(res.body.conflicts).toHaveLength(1);
  });

  test('POST com reject_on_conflict → 409 e não insere', async () => {
    candidatos = [{ id: 'outro', patient_name: 'Bia', scheduled_at: '2026-09-21T13:30:00Z', duration_min: 30, practitioner_id: null, status: 'agendado' }];
    const res = await request(app)
      .post(`/companies/${CID}/dental/appointments`)
      .send({ customer_id: PAC, scheduled_at: '2026-09-21T13:00:00Z', reject_on_conflict: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SCHEDULE_CONFLICT');
    expect(db.query.mock.calls.some((c) => /INSERT INTO dental_appointments/.test(c[0]))).toBe(false);
  });

  test('POST com scheduled_at inválido → 400', async () => {
    const res = await request(app)
      .post(`/companies/${CID}/dental/appointments`)
      .send({ customer_id: PAC, scheduled_at: 'amanhã às 10h' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCHEDULED_AT');
  });
});

describe('pacientes: birth_date no futuro', () => {
  const dentalRouter = require('../src/routes/dental');
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/dental', dentalRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
  });

  test('POST recusa com BIRTH_DATE_FUTURE', async () => {
    const res = await request(app)
      .post(`/companies/${CID}/dental/patients`)
      .send({ name: 'Bebê do Futuro', birth_date: '2999-01-01', lgpd_consent: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BIRTH_DATE_FUTURE');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('PATCH recusa com BIRTH_DATE_FUTURE', async () => {
    const res = await request(app)
      .patch(`/companies/${CID}/dental/patients/${PAC}`)
      .send({ birth_date: '2999-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BIRTH_DATE_FUTURE');
    expect(db.query).not.toHaveBeenCalled();
  });
});
