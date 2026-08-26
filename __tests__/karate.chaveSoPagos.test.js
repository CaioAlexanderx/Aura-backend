// ============================================================
// AURA KARATÊ — só entra na chave quem pagou (regra de 26/08)
//
// Achado no QA: o sorteio incluiu uma inscrição com fee_paid=false
// enquanto a própria tela prometia que ela entraria "após a federação
// confirmar o pagamento". O código dizia uma coisa e a tela, outra.
//
// Cobertura:
//  (1) categoria PAGA: quem não quitou fica de fora do sorteio.
//  (2) categoria GRATUITA: fee_paid=false não é dívida — ninguém é
//      excluído (senão nenhuma categoria sem taxa geraria chave).
//  (3) sobrando menos de 2 elegíveis por causa de pagamento, o erro diz
//      ISSO — "faltam atletas" mandaria procurar inscrição que existe.
//  (4) o GET devolve eligible_count junto de athletes_count: a tela
//      precisa dos dois para não chamar de "confirmado" quem não é.
//  (5) o filtro é SÓ na geração: quem já está na chave não some porque
//      o financeiro mudou depois.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const FED = 'fed-uuid-pagos';
const COMP = 'comp-uuid-pagos';
const CAT = 'cat-uuid-pagos';
const PAGO_1 = 'entry-pago-1';
const PAGO_2 = 'entry-pago-2';
const DEVENDO = 'entry-devendo';

const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateBrackets'));
  return app;
}

// fee: taxa efetiva da categoria. pagos: ids com fee_paid=true.
// inscritos: todas as entries não-withdrawn.
function mockDb({ fee = 50, pagos = [PAGO_1, PAGO_2], inscritos = [PAGO_1, PAGO_2, DEVENDO] } = {}) {
  const nome = { [PAGO_1]: 'Marina Kobayashi', [PAGO_2]: 'Rafael Tanaka', [DEVENDO]: 'Beatriz Souza' };
  db.connect.mockImplementation(() => Promise.resolve({
    query: (sql) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM karate_competitions WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: COMP, status: 'open' }] });
      if (/FROM karate_competition_categories WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: CAT, modality: 'kata' }] });
      if (/effective_fee/.test(s)) return Promise.resolve({ rows: [{ effective_fee: fee }] });
      if (/COUNT\(\*\)::int AS pending/.test(s)) {
        const devendo = inscritos.filter((i) => !pagos.includes(i)).length;
        return Promise.resolve({ rows: [{ pending: fee > 0 ? devendo : 0 }] });
      }
      if (/SELECT id FROM karate_competition_entries/.test(s)) {
        return Promise.resolve({ rows: pagos.map((id) => ({ id })) });
      }
      if (/FROM karate_competition_entries e/.test(s)) {
        return Promise.resolve({ rows: inscritos.map((id) => ({
          id, student_id: 's-' + id, team_id: null, dojo_id: 'd1',
          student_name: nome[id], dojo_name: 'Kondei',
        })) });
      }
      if (/FROM karate_brackets WHERE category_id/.test(s)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO karate_brackets/i.test(s)) return Promise.resolve({ rows: [{ id: 'bracket-novo' }] });
      if (/FROM karate_bracket_matches/.test(s)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  }));
  db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
}

function generate() {
  return request(buildApp())
    .post(`/federation/${FED}/competitions/${COMP}/categories/${CAT}/bracket/generate`)
    .set('Authorization', 'Bearer ' + token)
    .send({});
}

function getBracket() {
  return request(buildApp())
    .get(`/federation/${FED}/competitions/${COMP}/categories/${CAT}/bracket`)
    .set('Authorization', 'Bearer ' + token);
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

it('(1) categoria paga: quem não quitou fica fora do sorteio', async () => {
  mockDb({ fee: 50 });
  const res = await generate();
  expect(res.status).toBe(200);
  const ordem = res.body.presentation_order.map((p) => p.entry_id);
  expect(ordem).toHaveLength(2);
  expect(ordem).toEqual(expect.arrayContaining([PAGO_1, PAGO_2]));
  expect(ordem).not.toContain(DEVENDO);
});

it('(2) categoria gratuita: fee_paid=false não exclui ninguém', async () => {
  mockDb({ fee: 0, pagos: [] });
  const res = await generate();
  expect(res.status).toBe(200);
  expect(res.body.presentation_order).toHaveLength(3);
});

it('(3) sem 2 elegíveis por pagamento, o erro fala de PAGAMENTO, não de falta de atleta', async () => {
  mockDb({ fee: 50, pagos: [PAGO_1] });
  const res = await generate();
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('PAGAMENTO_PENDENTE');
  expect(res.body.error).toMatch(/aguardam confirmação de pagamento/);
  expect(res.body.error).toMatch(/Delegações/); // diz ONDE resolver
  expect(res.body.eligible_count).toBe(1);
});

it('(4) GET devolve eligible_count ao lado de athletes_count', async () => {
  mockDb({ fee: 50 });
  const res = await getBracket();
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('not_generated');
  expect(res.body.athletes_count).toBe(3);   // todos os inscritos
  expect(res.body.eligible_count).toBe(2);   // os que entram na chave hoje
  expect(res.body.pending_payment_count).toBe(1);
});

it('(5) o filtro é só na geração — a leitura não tira ninguém da chave', async () => {
  // Chave já existente com os 3; o financeiro mudou depois. A leitura
  // NÃO pode apagar quem já foi sorteado.
  db.connect.mockImplementation(() => Promise.resolve({
    query: (sql) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: COMP, status: 'open' }] });
      if (/effective_fee/.test(s)) return Promise.resolve({ rows: [{ effective_fee: 50 }] });
      if (/COUNT\(\*\)::int AS pending/.test(s)) return Promise.resolve({ rows: [{ pending: 3 }] });
      if (/checked_in_at, no_show_at/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM karate_competition_entries e/.test(s)) {
        return Promise.resolve({ rows: [PAGO_1, PAGO_2, DEVENDO].map((id) => ({
          id, student_id: 's-' + id, team_id: null, dojo_id: 'd1', student_name: 'X', dojo_name: 'Kondei',
        })) });
      }
      if (/FROM karate_brackets WHERE category_id/.test(s)) {
        return Promise.resolve({ rows: [{
          id: 'b1', status: 'locked', modality: 'kata', kata_mode: 'score_rounds',
          draw_seed: 1, options: {}, phase_plan: {},
        }] });
      }
      if (/FROM karate_bracket_matches/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM karate_kata_scores ks/.test(s)) {
        return Promise.resolve({ rows: [PAGO_1, PAGO_2, DEVENDO].map((id, i) => ({
          entry_id: id, student_name: 'X', dojo_name: 'Kondei', phase: 'eliminatoria',
          nota: null, presentation_order: i + 1, advances: null,
        })) });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  }));
  db.query.mockImplementation(() => Promise.resolve({ rows: [] }));

  const res = await getBracket();
  expect(res.status).toBe(200);
  expect(res.body.kata_scores).toHaveLength(3); // ninguém sumiu
});
