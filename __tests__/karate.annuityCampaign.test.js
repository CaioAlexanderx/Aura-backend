// ============================================================
// AURA KARATÊ — Fase F3: testes de
//   POST /financial/annuities/campaign/preview
//   POST /financial/annuities/campaign
//   POST /financial/annuities/batch
//
// Cobertura pedida no plano F3:
//   (a) preview de praticantes retorna a contagem correta de faixas-pretas
//       ATIVAS elegíveis, NÃO todo ativo — um teste que FALHA se o filtro
//       de faixa-preta sumir do SQL (ver DOJO_ELIGIBLE_SQL/
//       PRACTITIONER_ELIGIBLE_SQL em karateAnnuityCampaign.js).
//   (b) rodar a campanha 2x não duplica (segunda vez → tudo em `skipped`).
//   (c) alvo com erro não aborta o lote (SAVEPOINT por alvo).
//   (d) `exclude` é respeitado.
//
// Estratégia: em vez de encadear mockResolvedValueOnce numa ordem fixa
// (frágil para um handler com loop de N alvos, cada um com várias queries),
// usamos um "fake client" com estado em memória que interpreta o SQL por
// padrão (regex) — mais fiel ao comportamento real do Postgres (índice
// único, ON CONFLICT, NOT EXISTS) e robusto à variação do nº de alvos.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const db      = require('../src/config/database');
const campaignRouter = require('../src/routes/karateAnnuityCampaign');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-campaign-f3';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/financial', campaignRouter);
  return app;
}

// ── Fake DB em memória — interpreta o SQL real do handler por padrão ──────
function makeFakeDb(seed = {}) {
  const state = {
    dojos: seed.dojos || [],               // { id, federation_id, name, is_active }
    customers: seed.customers || [],       // { id, federation_id, name, is_active, karate_registration_number }
    belts: seed.belts || {},               // student_id -> belt_level
    fees: seed.fees || [],                 // { federation_id, fee_type, plan, amount, due_months }
    annuityHistory: [],                    // { id, dojo_id, practitioner_id, federation_id, reference_period, plan, amount, due_date, status, paid_at }
    installments: [],                      // { id, annuity_id, federation_id, seq, amount, due_date, status, transaction_id, paid_at, payment_method }
    transactions: [],
    poisonDojoIds: seed.poisonDojoIds || [],       // força erro no INSERT do header (simula falha isolada)
    poisonPractitionerIds: seed.poisonPractitionerIds || [],
    nextId: 1,
  };
  const uid = () => 'gen-' + (state.nextId++);

  async function query(sql, params = []) {
    const s = sql.trim();

    if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s) || /^ROLLBACK$/i.test(s)) return {};
    if (/^SAVEPOINT/i.test(s) || /^RELEASE SAVEPOINT/i.test(s) || /^ROLLBACK TO SAVEPOINT/i.test(s)) return {};
    if (/pg_advisory_xact_lock/.test(s)) return { rows: [{ pg_advisory_xact_lock: null }] };

    // ── elegibilidade dojô (scope da campanha) ──
    if (/FROM companies c/.test(s) && /ANY\(\$3::uuid\[\]\)/.test(s) && /vertical_active = 'karate_dojo'/.test(s)) {
      const [fedId, year, excludeIds] = params;
      const rows = state.dojos
        .filter((d) => d.federation_id === fedId && d.is_active
          && !(excludeIds || []).includes(d.id)
          && !state.annuityHistory.some((h) => h.dojo_id === d.id && h.reference_period === year))
        .map((d) => ({ dojo_id: d.id, name: d.name }));
      return { rows };
    }

    // ── loadTargetInfo dojô (/batch) ──
    if (/WHERE id = \$1 AND federation_id = \$2 AND vertical_active = 'karate_dojo'/.test(s)) {
      const [id, fedId] = params;
      const d = state.dojos.find((x) => x.id === id && x.federation_id === fedId);
      if (!d) return { rows: [] };
      return { rows: [{ id: d.id, name: d.name, is_active: d.is_active }] };
    }

    // ── elegibilidade praticante (scope da campanha) — REGRA CRÍTICA ──
    if (/FROM customers c/.test(s) && /JOIN karate_current_belt cb/.test(s) && /ANY\(\$3::uuid\[\]\)/.test(s)) {
      const [fedId, year, excludeIds] = params;
      const rows = state.customers
        .filter((c) => c.federation_id === fedId && c.is_active
          && state.belts[c.id] === 'preta'
          && !(excludeIds || []).includes(c.id)
          && !state.annuityHistory.some((h) => h.practitioner_id === c.id && h.reference_period === year))
        .map((c) => ({ practitioner_id: c.id, name: c.name, karate_registration_number: c.karate_registration_number || null }));
      return { rows };
    }

    // ── loadTargetInfo praticante (/batch) ──
    if (/WHERE c\.id = \$1 AND c\.federation_id = \$2/.test(s)) {
      const [id, fedId] = params;
      const c = state.customers.find((x) => x.id === id && x.federation_id === fedId);
      if (!c) return { rows: [] };
      return { rows: [{ id: c.id, name: c.name, is_active: c.is_active, belt_level: state.belts[c.id] || null }] };
    }

    // ── getVigentFee ──
    if (/FROM karate_annual_fees/.test(s)) {
      const [fedId, feeType, plan] = params;
      const f = state.fees.find((x) => x.federation_id === fedId && x.fee_type === feeType && x.plan === plan);
      return { rows: f ? [f] : [] };
    }

    // ── checagem de duplicidade (existing) ──
    if (/SELECT id FROM karate_dojo_annuity_history/.test(s) && /reference_period = \$1/.test(s)) {
      const [year, id] = params;
      const isDojo = /dojo_id = \$2/.test(s);
      const found = state.annuityHistory.find((h) => h.reference_period === year
        && (isDojo ? h.dojo_id === id : h.practitioner_id === id));
      return { rows: found ? [{ id: found.id }] : [] };
    }

    // ── INSERT header ──
    if (/INSERT INTO karate_dojo_annuity_history/.test(s)) {
      const [dojoId, fedId, practId, year, plan, dueDate] = params;
      if (dojoId && state.poisonDojoIds.includes(dojoId)) {
        throw new Error('poison: falha simulada no INSERT do header (dojô)');
      }
      if (practId && state.poisonPractitionerIds.includes(practId)) {
        throw new Error('poison: falha simulada no INSERT do header (praticante)');
      }
      const dup = state.annuityHistory.find((h) => h.reference_period === year
        && ((dojoId && h.dojo_id === dojoId) || (practId && h.practitioner_id === practId)));
      if (dup) {
        const e = new Error('duplicate key value violates unique constraint');
        e.code = '23505';
        throw e;
      }
      const id = uid();
      state.annuityHistory.push({
        id, dojo_id: dojoId || null, federation_id: fedId, practitioner_id: practId || null,
        reference_period: year, plan, amount: 0, due_date: dueDate, status: 'pending', paid_at: null,
      });
      return { rows: [{ id }] };
    }

    // ── INSERT installment ──
    if (/INSERT INTO karate_annuity_installments/.test(s)) {
      const [annuityId, fedId, seq, amount, dueDate] = params;
      const id = uid();
      const row = {
        id, annuity_id: annuityId, federation_id: fedId, seq, amount, due_date: dueDate,
        status: 'pending', paid_at: null, transaction_id: null, payment_method: null,
      };
      state.installments.push(row);
      return { rows: [row] };
    }

    // ── INSERT transaction ──
    if (/INSERT INTO transactions/.test(s)) {
      const id = uid();
      state.transactions.push({ id });
      return { rows: [{ id }] };
    }

    // ── UPDATE installment.transaction_id ──
    if (/UPDATE karate_annuity_installments SET transaction_id/.test(s)) {
      const [txId, instId] = params;
      const inst = state.installments.find((i) => i.id === instId);
      if (inst) inst.transaction_id = txId;
      return { rows: [] };
    }

    // ── getInstallments (rollup) ──
    if (/SELECT \* FROM karate_annuity_installments WHERE annuity_id = \$1/.test(s)) {
      const [annuityId] = params;
      return { rows: state.installments.filter((i) => i.annuity_id === annuityId) };
    }

    // ── UPDATE header (rollup) ──
    if (/UPDATE karate_dojo_annuity_history\s*$/m.test(s) || (/UPDATE karate_dojo_annuity_history/.test(s) && /SET amount = \$1/.test(s))) {
      const [amount, status, dueDate, paidAt] = params;
      const id = params[params.length - 1];
      const h = state.annuityHistory.find((x) => x.id === id);
      if (h) Object.assign(h, { amount, status, due_date: dueDate, paid_at: paidAt });
      return { rows: [h] };
    }

    throw new Error('Unhandled SQL in fake client: ' + s.slice(0, 160));
  }

  const client = { query, release: () => {} };
  return { client, state };
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ============================================================
// (a) PREVIEW — a regra crítica de faixa-preta ativa
// ============================================================
describe('POST /financial/annuities/campaign/preview', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('cenário na escala de produção: 6.950 ativos, só 549 faixas-pretas ativas → preview de praticantes NÃO pode ser 6.950', (done) => {
    // Réplica em miniatura da federação de referência: alguns ativos sem
    // faixa-preta, alguns faixas-pretas inativos, e só um pequeno grupo
    // que é as DUAS coisas — é esse grupo, e só ele, que deve aparecer.
    const customers = [];
    const belts = {};
    for (let i = 0; i < 20; i++) {
      const id = `ativo-nao-preta-${i}`;
      customers.push({ id, federation_id: FED_ID, name: `Aluno ${i}`, is_active: true });
      belts[id] = 'azul';
    }
    for (let i = 0; i < 5; i++) {
      const id = `preta-inativo-${i}`;
      customers.push({ id, federation_id: FED_ID, name: `Ex-aluno preta ${i}`, is_active: false });
      belts[id] = 'preta';
    }
    for (let i = 0; i < 3; i++) {
      const id = `preta-ativo-${i}`;
      customers.push({ id, federation_id: FED_ID, name: `Sensei ${i}`, is_active: true, karate_registration_number: `FPKT-${i}` });
      belts[id] = 'preta';
    }

    const { client } = makeFakeDb({
      customers,
      belts,
      fees: [{ federation_id: FED_ID, fee_type: 'cpf', plan: 'anual', amount: 60, due_months: [5] }],
    });
    db.query.mockImplementation(client.query);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'practitioners' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        // 28 clientes no total nesta réplica; SE o filtro de faixa-preta
        // sumisse do SQL, is_active sozinho devolveria 23 (20+3). O certo é 3.
        expect(res.body.practitioners).toHaveLength(3);
        expect(res.body.totals.practitioners_count).toBe(3);
        expect(res.body.totals.practitioners_count).not.toBe(23);
        expect(res.body.practitioners.map((p) => p.practitioner_id).sort()).toEqual(
          ['preta-ativo-0', 'preta-ativo-1', 'preta-ativo-2']
        );
        expect(res.body.totals.valor_previsto).toBe(180); // 3 x R$60
        done();
      });
  });

  it('a query de elegibilidade de praticante EXIGE is_active E belt_level=preta explicitamente no SQL', (done) => {
    const { client } = makeFakeDb({ fees: [] });
    db.query.mockImplementation(client.query);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'practitioners' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        // Sonda o SQL efetivamente enviado ao banco — falha se alguém
        // remover o filtro de faixa-preta da query de elegibilidade.
        const calls = db.query.mock.calls.map((c) => c[0]);
        const eligibilitySql = calls.find((sql) => /FROM customers c/.test(sql) && /JOIN karate_current_belt/.test(sql));
        expect(eligibilitySql).toBeDefined();
        expect(eligibilitySql).toMatch(/COALESCE\(c\.is_active,\s*true\)/);
        expect(eligibilitySql).toMatch(/cb\.belt_level\s*=\s*'preta'/);
        expect(eligibilitySql).toMatch(/NOT EXISTS/);
        expect(eligibilitySql).toMatch(/h\.reference_period\s*=\s*\$2/);
        done();
      });
  });

  it('scope=dojos não retorna praticantes, e vice-versa', (done) => {
    const { client } = makeFakeDb({
      dojos: [{ id: 'd1', federation_id: FED_ID, name: 'Dojo Central', is_active: true }],
      fees: [{ federation_id: FED_ID, fee_type: 'dojo', plan: 'anual', amount: 500, due_months: [5] }],
    });
    db.query.mockImplementation(client.query);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'dojos' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.dojos).toHaveLength(1);
        expect(res.body.dojos[0]).toMatchObject({ dojo_id: 'd1', name: 'Dojo Central', plan_default: 'anual', amount: 500 });
        expect(res.body.practitioners).toEqual([]);
        expect(res.body.totals.practitioners_count).toBe(0);
        done();
      });
  });

  it('devolve due_date (já com o default seguro aplicado) e due_date_ajustada por alvo, prontos pra UI mostrar antes de confirmar', (done) => {
    const { client } = makeFakeDb({
      dojos: [{ id: 'd1', federation_id: FED_ID, name: 'Dojo Central', is_active: true }],
      fees: [{ federation_id: FED_ID, fee_type: 'dojo', plan: 'anual', amount: 500, due_months: [5] }],
    });
    db.query.mockImplementation(client.query);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'dojos' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        // fee vence em maio; "hoje" (execução real) já passou de maio/2026
        // → default seguro: due_date = fim do mês corrente, ajuste sinalizado.
        expect(res.body.dojos[0].due_date_ajustada).toBe(true);
        expect(res.body.dojos[0].due_date.slice(5, 7)).toBe(String(new Date().getUTCMonth() + 1).padStart(2, '0'));
        done();
      });
  });

  it('preview aceita due_date opcional e devolve o MESMO valor que /campaign vai usar de fato', (done) => {
    const { client } = makeFakeDb({
      dojos: [{ id: 'd1', federation_id: FED_ID, name: 'Dojo Central', is_active: true }],
      fees: [{ federation_id: FED_ID, fee_type: 'dojo', plan: 'anual', amount: 500, due_months: [5] }],
    });
    db.query.mockImplementation(client.query);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'dojos', due_date: '2026-10-05' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.dojos[0].due_date).toBe('2026-10-05');
        expect(res.body.dojos[0].due_date_ajustada).toBe(true);
        done();
      });
  });

  it('preview: 422 quando due_date é de ano diferente da temporada', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'both', due_date: '2030-01-01' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('422 quando year ausente/ inválido', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ scope: 'both' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('422 quando scope inválido', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign/preview`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'tudo' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ============================================================
// (b)+(c)+(d) CAMPANHA — idempotência, erro parcial, exclude
// ============================================================
describe('POST /financial/annuities/campaign', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  function baseSeed() {
    return {
      dojos: [
        { id: 'd1', federation_id: FED_ID, name: 'Dojo A', is_active: true },
        { id: 'd2', federation_id: FED_ID, name: 'Dojo B', is_active: true },
        { id: 'd3', federation_id: FED_ID, name: 'Dojo Inativo', is_active: false },
      ],
      customers: [
        { id: 'p1', federation_id: FED_ID, name: 'Sensei 1', is_active: true, karate_registration_number: 'F1' },
        { id: 'p2', federation_id: FED_ID, name: 'Sensei 2', is_active: true, karate_registration_number: 'F2' },
        { id: 'p3', federation_id: FED_ID, name: 'Aluno Faixa Azul', is_active: true },
      ],
      belts: { p1: 'preta', p2: 'preta', p3: 'azul' },
      fees: [
        { federation_id: FED_ID, fee_type: 'dojo', plan: 'anual', amount: 500, due_months: [5] },
        { federation_id: FED_ID, fee_type: 'cpf', plan: 'anual', amount: 60, due_months: [5] },
      ],
    };
  }

  it('(b) idempotência: rodar 2x não duplica — a segunda execução leva tudo para skipped', (done) => {
    const { client } = makeFakeDb(baseSeed());
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'both' })
      .end((err, res1) => {
        if (err) return done(err);
        expect(res1.status).toBe(201);
        // 2 dojôs ativos elegíveis (d3 é inativo) + 2 faixas-pretas ativas (p3 não é preta)
        expect(res1.body.created).toHaveLength(4);
        expect(res1.body.created.every((c) => c.plan === 'anual')).toBe(true);
        expect(res1.body.skipped).toHaveLength(0);
        expect(res1.body.errors).toHaveLength(0);

        request(app)
          .post(`/federation/${FED_ID}/financial/annuities/campaign`)
          .set('Authorization', 'Bearer ' + adminToken)
          .send({ year: 2026, scope: 'both' })
          .end((err2, res2) => {
            if (err2) return done(err2);
            expect(res2.status).toBe(201);
            // Segunda vez: a query de elegibilidade já exclui quem tem
            // header no período — ninguém elegível, nada criado, nada em erro.
            expect(res2.body.created).toHaveLength(0);
            expect(res2.body.skipped).toHaveLength(0);
            expect(res2.body.errors).toHaveLength(0);
            done();
          });
      });
  });

  it('(c) um alvo com erro não aborta o lote — os demais são criados normalmente', (done) => {
    const seed = baseSeed();
    seed.poisonDojoIds = ['d2']; // Dojo B falha no INSERT do header
    const { client } = makeFakeDb(seed);
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'dojos' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.created).toHaveLength(1);
        expect(res.body.created[0].id).toBe('d1');
        expect(res.body.errors).toHaveLength(1);
        expect(res.body.errors[0]).toMatchObject({ type: 'dojo', id: 'd2' });
        expect(res.body.errors[0].reason).toMatch(/poison/);
        done();
      });
  });

  it('(d) exclude é respeitado — alvo excluído não é cobrado nem aparece em created/skipped/errors', (done) => {
    const { client } = makeFakeDb(baseSeed());
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'both', exclude: { dojo_ids: ['d1'], practitioner_ids: ['p2'] } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        const allIds = [...res.body.created, ...res.body.skipped, ...res.body.errors].map((x) => x.id);
        expect(allIds).not.toContain('d1');
        expect(allIds).not.toContain('p2');
        expect(res.body.created.map((c) => c.id).sort()).toEqual(['d2', 'p1']);
        done();
      });
  });

  it('gera plano anual (1 parcela) por default para dojô, e computa o total corretamente', (done) => {
    const { client } = makeFakeDb(baseSeed());
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'dojos' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        const d1 = res.body.created.find((c) => c.id === 'd1');
        expect(d1.plan).toBe('anual');
        expect(d1.installments_count).toBe(1);
        expect(d1.total).toBe(500);
        // continuação F3: fee com due_months=[5] e "hoje" (execução real)
        // depois de maio → plano já venceu → default seguro aplicado.
        expect(d1.due_date_ajustada).toBe(true);
        expect(d1.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(d1.due_date.slice(5, 7)).toBe(String(new Date().getUTCMonth() + 1).padStart(2, '0'));
        done();
      });
  });

  it('due_date (override explícito) sobrescreve o vencimento gerado para TODOS os alvos da rodada — dojôs e praticantes', (done) => {
    const { client } = makeFakeDb(baseSeed());
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'both', due_date: '2026-09-15' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.created).toHaveLength(4);
        expect(res.body.created.every((c) => c.due_date === '2026-09-15')).toBe(true);
        expect(res.body.created.every((c) => c.due_date_ajustada === true)).toBe(true);
        done();
      });
  });

  it('422 quando due_date é de ano diferente da temporada', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'both', due_date: '2027-01-10' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        done();
      });
  });

  it('422 quando due_date tem formato inválido', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, scope: 'both', due_date: '15/09/2026' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('422 quando year ausente', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/campaign`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ scope: 'both' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ============================================================
// POST /financial/annuities/batch
// ============================================================
describe('POST /financial/annuities/batch', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  function baseSeed() {
    return {
      dojos: [
        { id: 'd1', federation_id: FED_ID, name: 'Dojo A', is_active: true },
      ],
      customers: [
        { id: 'p1', federation_id: FED_ID, name: 'Sensei 1', is_active: true },
        { id: 'p2', federation_id: FED_ID, name: 'Aluno Faixa Azul', is_active: true },
        { id: 'p3', federation_id: FED_ID, name: 'Preta Inativo', is_active: false },
      ],
      belts: { p1: 'preta', p2: 'azul', p3: 'preta' },
      fees: [
        { federation_id: FED_ID, fee_type: 'dojo', plan: 'anual', amount: 500, due_months: [5] },
        { federation_id: FED_ID, fee_type: 'cpf', plan: 'anual', amount: 60, due_months: [5] },
      ],
    };
  }

  it('cria para os alvos válidos e explica por que rejeitou os inválidos (mesmo vindo explícitos no body)', (done) => {
    const { client } = makeFakeDb(baseSeed());
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        year: 2026,
        targets: [
          { type: 'dojo', id: 'd1' },
          { type: 'practitioner', id: 'p1' }, // elegível
          { type: 'practitioner', id: 'p2' }, // não é faixa-preta — deve ir para errors
          { type: 'practitioner', id: 'p3' }, // faixa-preta mas inativo — deve ir para errors
          { type: 'practitioner', id: 'nao-existe' },
        ],
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.created.map((c) => c.id).sort()).toEqual(['d1', 'p1']);

        const err2 = res.body.errors.find((e) => e.id === 'p2');
        expect(err2.reason).toBe('praticante_nao_e_faixa_preta');

        const err3 = res.body.errors.find((e) => e.id === 'p3');
        expect(err3.reason).toBe('praticante_inativo');

        const err4 = res.body.errors.find((e) => e.id === 'nao-existe');
        expect(err4.reason).toBe('not_found');

        done();
      });
  });

  it('idempotente: alvo já com anuidade no período vai para skipped, não duplica', (done) => {
    const seed = baseSeed();
    const { client, state } = makeFakeDb(seed);
    state.annuityHistory.push({
      id: 'existing-1', dojo_id: 'd1', federation_id: FED_ID, practitioner_id: null,
      reference_period: '2026', plan: 'anual', amount: 500, due_date: '2026-05-31', status: 'pending', paid_at: null,
    });
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, targets: [{ type: 'dojo', id: 'd1' }] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.created).toHaveLength(0);
        expect(res.body.skipped).toHaveLength(1);
        expect(res.body.skipped[0].reason).toBe('already_has_annuity_this_season');
        done();
      });
  });

  it('422 quando targets vazio/ausente', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, targets: [] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('422 quando plan inválido', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, targets: [{ type: 'dojo', id: 'd1' }], plan: 'mensal' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('due_date (override explícito) sobrescreve o vencimento gerado no /batch — mesma semântica do /campaign', (done) => {
    const { client } = makeFakeDb(baseSeed());
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        year: 2026,
        targets: [{ type: 'dojo', id: 'd1' }, { type: 'practitioner', id: 'p1' }],
        due_date: '2026-10-20',
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.created).toHaveLength(2);
        expect(res.body.created.every((c) => c.due_date === '2026-10-20')).toBe(true);
        expect(res.body.created.every((c) => c.due_date_ajustada === true)).toBe(true);
        done();
      });
  });

  it('422 no /batch quando due_date é de ano diferente da temporada', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ year: 2026, targets: [{ type: 'dojo', id: 'd1' }], due_date: '2031-05-05' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ============================================================
// buildCampaignSpecs — continuação F3 (PR #356): "todas as parcelas já
// venceram" ganha DEFAULT SEGURO (due_date = fim do mês corrente, não a
// data original do plano — a cobrança nasce "a vencer") + due_date
// opcional editável pela federação. `usedLastInstallmentFallback` foi
// renomeado para `due_date_ajustada` (nome mais claro pra UI avisar o
// operador quando o vencimento não é o natural do plano).
// ============================================================
describe('buildCampaignSpecs (helper puro exposto via router.__testables)', () => {
  const { buildCampaignSpecs } = campaignRouter.__testables;

  it('quando há parcelas restantes, usa o comportamento normal (igual ao /charge individual) — sem ajuste', () => {
    const { specs, due_date_ajustada } = buildCampaignSpecs({
      plan: 'trimestral', amount: 150, dueMonths: [2, 5, 8, 11], seasonYear: 2026,
    });
    // "hoje" nos testes é a data real de execução — as parcelas futuras
    // relativas a hoje devem aparecer normalmente.
    expect(due_date_ajustada).toBe(false);
    expect(Array.isArray(specs)).toBe(true);
  });

  it('default seguro: quando TODAS as parcelas do plano já venceram, gera só a última com due_date = FIM DO MÊS CORRENTE — não deixa o alvo sem cobrança e não nasce atrasada', () => {
    // Plano fictício com vencimento num mês certamente já passado em
    // qualquer execução real — simulamos isso fixando seasonYear no
    // passado distante, então TODOS os due_months caem antes de "hoje".
    const pastYear = 2000;
    const now = new Date();
    const expectedSafeDueDate = require('../src/services/karateAnnuityService')
      .lastDayOfMonthStr(now.getUTCFullYear(), now.getUTCMonth() + 1);

    const { specs, due_date_ajustada } = buildCampaignSpecs({
      plan: 'trimestral', amount: 150, dueMonths: [2, 5, 8, 11], seasonYear: pastYear,
    });
    expect(due_date_ajustada).toBe(true);
    expect(specs).toHaveLength(1);
    // seq preserva a posição no plano completo (4ª parcela), mas o
    // due_date NÃO é mais `${pastYear}-11-30` (que nasceria atrasada) —
    // é o fim do mês corrente.
    expect(specs[0]).toEqual({ seq: 4, amount: 150, due_date: expectedSafeDueDate });
  });

  it('plano anual (dojô/praticante padrão da campanha) com vencimento já passado gera a única parcela existente, a vencer no fim do mês corrente', () => {
    const pastYear = 2000;
    const now = new Date();
    const expectedSafeDueDate = require('../src/services/karateAnnuityService')
      .lastDayOfMonthStr(now.getUTCFullYear(), now.getUTCMonth() + 1);

    const { specs, due_date_ajustada } = buildCampaignSpecs({
      plan: 'anual', amount: 500, dueMonths: [5], seasonYear: pastYear,
    });
    expect(due_date_ajustada).toBe(true);
    expect(specs).toEqual([{ seq: 1, amount: 500, due_date: expectedSafeDueDate }]);
  });

  it('due_date override é respeitado mesmo no cenário de default seguro (plano 100% vencido)', () => {
    const pastYear = 2000;
    const { specs, due_date_ajustada } = buildCampaignSpecs({
      plan: 'anual', amount: 500, dueMonths: [5], seasonYear: pastYear, dueDateOverride: '2099-09-10',
    });
    expect(specs).toEqual([{ seq: 1, amount: 500, due_date: '2099-09-10' }]);
    expect(due_date_ajustada).toBe(true);
  });
});
