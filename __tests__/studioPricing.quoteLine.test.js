// ============================================================
// AURA Studio — quote-line: a conta de antes continua a mesma
//
// O "Preco certo" (03/10/2026) passa a embutir a taxa de custo fixo do
// estudio no divisor do preco. Quem nao configurou nada nao pode ver UM
// centavo de diferenca no orcamento: os numeros do primeiro bloco foram
// tirados do codigo ANTERIOR a mudanca, rodando este mesmo arquivo, e
// ficam aqui como trava.
//
// Mock por SQL, nunca por posicao: a rota ganhou uma leitura a mais
// (studio_settings) e a ordem das consultas nao e contrato.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');

const CID = 'c-studio';
const PID = '11111111-2222-3333-4444-555555555555';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
  a.use('/companies/:id/studio', require('../src/routes/studioPricing'));
  return a;
}

/**
 * O banco de mentira. `custo` e o total_cost da ficha, `regra` a linha de
 * studio_pricing_rules e `settings` o studio_settings da empresa.
 */
function banco({ custo = null, regra = null, settings = {} } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM studio_compositions_summary/.test(s)) {
      return { rows: custo == null ? [] : [{ total_cost: String(custo) }] };
    }
    if (/FROM studio_pricing_rules/.test(s)) return { rows: regra ? [regra] : [] };
    if (/FROM companies/.test(s)) return { rows: [{ s: settings }] };
    return { rows: [] };
  });
}

const REGRA = {
  product_id: PID, setup_fee: '30.00', labor_cost: '4.50',
  default_margin_pct: '40.00', urgency_pct: '20.00', qty_tiers: null,
};

const cotar = (body) => request(app()).post(`/companies/${CID}/studio/pricing/quote-line`).send(body);

/** So os campos que ja existiam — os novos sao conferidos a parte. */
function deAntes(body) {
  const { fixed_cost_pct, fixed_cost, ...breakdown } = body.breakdown;
  return { unit_price: body.unit_price, breakdown };
}

beforeEach(() => { db.query.mockReset(); });

describe('sem taxa de custo fixo, o orcamento e o de sempre', () => {
  test('custo + mao de obra + setup diluido, com margem', async () => {
    banco({ custo: 12.34, regra: REGRA });
    const r = await cotar({ product_id: PID, quantity: 10 });
    expect(r.status).toBe(200);
    expect(deAntes(r.body)).toEqual({
      unit_price: 33.07,
      breakdown: { base_cost: 12.34, labor: 4.5, setup: 3, tier_multiplier: 1, margin_pct: 40, urgency: 0 },
    });
  });

  test('urgencia soma sobre o custo, nao sobre o preco', async () => {
    banco({ custo: 12.34, regra: REGRA });
    const r = await cotar({ product_id: PID, quantity: 3, urgency: true });
    expect(deAntes(r.body)).toEqual({
      unit_price: 50.1,
      breakdown: { base_cost: 12.34, labor: 4.5, setup: 10, tier_multiplier: 1, margin_pct: 40, urgency: 5.368 },
    });
  });

  test('faixa com multiplicador barateia o custo base', async () => {
    banco({ custo: 20, regra: { ...REGRA, setup_fee: '0', qty_tiers: [{ min_qty: 10, max_qty: null, unit_multiplier: 0.9 }] } });
    const r = await cotar({ product_id: PID, quantity: 12 });
    expect(deAntes(r.body)).toEqual({
      unit_price: 37.5,
      breakdown: { base_cost: 18, labor: 4.5, setup: 0, tier_multiplier: 0.9, margin_pct: 40, urgency: 0 },
    });
  });

  test('preco fixo da faixa manda', async () => {
    banco({ custo: 20, regra: { ...REGRA, qty_tiers: [{ min_qty: 50, max_qty: null, unit_price: 29.9 }] } });
    const r = await cotar({ product_id: PID, quantity: 60 });
    expect(deAntes(r.body)).toEqual({
      unit_price: 29.9,
      breakdown: { base_cost: 20, labor: 4.5, setup: 0.5, tier_multiplier: 1, margin_pct: 40, urgency: 0 },
    });
  });

  test('override de unit_price manda em tudo', async () => {
    banco({ custo: 12.34, regra: REGRA });
    const r = await cotar({ product_id: PID, quantity: 10, urgency: true, overrides: { unit_price: 55 } });
    expect(deAntes(r.body)).toEqual({
      unit_price: 55,
      breakdown: { base_cost: 12.34, labor: 4.5, setup: 3, tier_multiplier: 1, margin_pct: 40, urgency: 3.968 },
    });
  });

  test('override de unit_cost passa por cima da ficha', async () => {
    banco({ custo: 12.34, regra: REGRA });
    const r = await cotar({ product_id: PID, quantity: 1, overrides: { unit_cost: 8 } });
    expect(deAntes(r.body)).toEqual({
      unit_price: 70.83,
      breakdown: { base_cost: 8, labor: 4.5, setup: 30, tier_multiplier: 1, margin_pct: 40, urgency: 0 },
    });
  });

  test('margem de 100% ou mais cai no dobro do custo', async () => {
    banco({ custo: 10, regra: { ...REGRA, setup_fee: '0', labor_cost: '0', default_margin_pct: '100' } });
    const r = await cotar({ product_id: PID, quantity: 1 });
    expect(deAntes(r.body)).toEqual({
      unit_price: 20,
      breakdown: { base_cost: 10, labor: 0, setup: 0, tier_multiplier: 1, margin_pct: 100, urgency: 0 },
    });
  });

  test('sem regra, o preco e o custo', async () => {
    banco({ custo: 12.34 });
    const r = await cotar({ product_id: PID, quantity: 2 });
    expect(deAntes(r.body)).toEqual({
      unit_price: 12.34,
      breakdown: { base_cost: 12.34, labor: 0, setup: 0, tier_multiplier: 1, margin_pct: null, urgency: 0 },
    });
  });

  test('sem regra e sem custo, tudo zero', async () => {
    banco({});
    const r = await cotar({ product_id: PID, quantity: 2 });
    expect(deAntes(r.body)).toEqual({
      unit_price: 0,
      breakdown: { base_cost: 0, labor: 0, setup: 0, tier_multiplier: 1, margin_pct: null, urgency: 0 },
    });
  });

  test('taxa gravada como zero e o mesmo que nao ter taxa', async () => {
    banco({ custo: 12.34, regra: REGRA, settings: { taxa_custo_fixo_pct: 0 } });
    const r = await cotar({ product_id: PID, quantity: 10 });
    expect(deAntes(r.body).unit_price).toBe(33.07);
  });
});
