// ============================================================
// AURA. — Teste: D-QA #8 (2026-09-16)
// Filtros por dia em agendamentos odonto precisam interpretar a data
// em America/Sao_Paulo, nao no fuso da sessao do banco (UTC no
// Supabase) nem no fuso do processo Node. Sem isso, "hoje" perde os
// agendamentos entre 21h e 24h (viram "amanha" em UTC) e pega os de
// 21h-24h do dia anterior (que ainda nao virou em UTC).
//
//   - GET /dental/appointments?from=&to= (dentalPractitioners.js)
//     -> SQL gerado deve envolver o cast em AT TIME ZONE 'America/Sao_Paulo'
//   - GET /dental/agenda (dental.js) sem start/end -> default de "hoje"
//     calculado em America/Sao_Paulo (offset fixo -03:00, sem DST desde 2019)
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

describe('GET /dental/appointments?from=&to= — filtro de dia em America/Sao_Paulo', () => {
  test('SQL gerado interpreta from/to no fuso de SP, nao faz cast direto pra date', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT appointments

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/appointments`)
      .query({ from: '2026-09-16', to: '2026-09-16' })
      .set(auth);

    expect(res.status).toBe(200);

    const listCall = db.query.mock.calls[1];
    const sql = listCall[0];
    // from ($2, apos company_id=$1): limite inferior interpretado em SP
    expect(sql).toMatch(/a\.scheduled_at >= \(\$2::date\)::timestamp AT TIME ZONE 'America\/Sao_Paulo'/);
    // to ($3): limite superior = dia seguinte, tambem interpretado em SP
    expect(sql).toMatch(/a\.scheduled_at < \(\(\$3::date \+ 1\)::timestamp AT TIME ZONE 'America\/Sao_Paulo'\)/);
    // Padrao antigo (cast direto pra date, sem TIME ZONE) nao pode mais aparecer
    expect(sql).not.toMatch(/scheduled_at >= \$\d::date(?!\))/);
    expect(listCall[1]).toEqual([cid, '2026-09-16', '2026-09-16']);
  });
});

describe('GET /dental/agenda — default de "hoje" em America/Sao_Paulo', () => {
  test('22h em SP (ja e madrugada em UTC): "hoje" continua sendo o dia de SP, nao o de UTC', async () => {
    // 2026-09-16T22:00:00-03:00 (SP) === 2026-09-17T01:00:00.000Z (UTC).
    // Com o bug antigo (fuso do processo Node = UTC em producao), "hoje"
    // seria calculado como 17/09. O correto e continuar 16/09 (fuso de SP).
    jest.useFakeTimers({ advanceTimers: false });
    jest.setSystemTime(new Date('2026-09-17T01:00:00.000Z'));

    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] }); // getAgendaByPeriod

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/agenda`)
      .set(auth);

    expect(res.status).toBe(200);
    // Meia-noite de 16/09 em SP (-03:00) = 03:00 UTC do dia 16
    expect(res.body.start).toBe('2026-09-16T03:00:00.000Z');
    // Meia-noite de 17/09 em SP = 03:00 UTC do dia 17
    expect(res.body.end).toBe('2026-09-17T03:00:00.000Z');

    const agendaCall = db.query.mock.calls[1];
    expect(agendaCall[1]).toEqual([cid, '2026-09-16T03:00:00.000Z', '2026-09-17T03:00:00.000Z']);
  });

  test('start/end explicitos no query continuam tendo prioridade sobre o default', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/agenda`)
      .query({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' })
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.start).toBe('2026-10-01T00:00:00.000Z');
    expect(res.body.end).toBe('2026-10-02T00:00:00.000Z');
  });
});
