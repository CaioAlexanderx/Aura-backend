// ============================================================
// Revisões "0" = ilimitadas — QA da vitrine Studio, achado A3 (26/09/2026)
//
// "0 revisões" tinha dois sentidos: o painel dizia ilimitadas, a página
// da cliente dizia "nenhuma inclusa" e avisava de cobrança. Vale o painel
// (decisão do Tech Lead): 0 (ou nada) = ilimitadas, sem preço de extra,
// em todo payload que fala de revisão (services/politicaDeRevisoes.js).
//
// Mock do db por CONTEÚDO DO SQL, nunca por ordem de chamada.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const {
  politicaDeRevisoes, revisoesInclusas, revisoesIlimitadas, precoDaRevisaoExtra,
} = require('../src/services/politicaDeRevisoes');
const rota = require('../src/routes/studioApprovalPublic');

const CID = 'c0000000-0000-0000-0000-000000000001';
const OID = 'o0000000-0000-0000-0000-000000000001';
const APROV = 'hx7k2mq1hx7k2mq1hx7k2mq1';

// ─────────────────────────────────────────────────────────────
// A3 — política de revisões
// ─────────────────────────────────────────────────────────────
describe('politicaDeRevisoes — 0 e ilimitado', () => {
  test.each([
    ['0', { max_revisions_included: 0 }],
    ['"0" (texto)', { max_revisions_included: '0' }],
    ['ausente', {}],
    ['null', { max_revisions_included: null }],
    ['vazio', { max_revisions_included: '' }],
    ['negativo', { max_revisions_included: -2 }],
    ['lixo', { max_revisions_included: 'abc' }],
  ])('%s = ilimitadas', (_, ss) => {
    expect(revisoesInclusas(ss)).toBeNull();
    expect(revisoesIlimitadas(ss)).toBe(true);
  });

  test('sem studio_settings nenhum tambem e ilimitado', () => {
    expect(revisoesIlimitadas(null)).toBe(true);
    expect(politicaDeRevisoes(undefined)).toEqual({
      max_included: 0, extra_price: 0, policy_text: null, ilimitadas: true,
    });
  });

  test('ilimitadas nunca tem preco de extra, mesmo com um salvo de antes', () => {
    // O painel diz "Como você definiu revisões ilimitadas, este preço não
    // será cobrado" e deixa o campo preenchido: o valor antigo fica salvo.
    const ss = { max_revisions_included: 0, extra_revision_price: 10, revision_policy_text: 'Pode pedir.' };
    expect(precoDaRevisaoExtra(ss)).toBe(0);
    expect(politicaDeRevisoes(ss)).toEqual({
      max_included: 0, extra_price: 0, policy_text: 'Pode pedir.', ilimitadas: true,
    });
  });

  test('limite positivo continua limitando e cobrando a extra', () => {
    const ss = { max_revisions_included: '2', extra_revision_price: '10.00' };
    expect(politicaDeRevisoes(ss)).toEqual({
      max_included: 2, extra_price: 10, policy_text: null, ilimitadas: false,
    });
  });

  test('preco de extra invalido vira 0, nunca NaN', () => {
    expect(precoDaRevisaoExtra({ max_revisions_included: 2, extra_revision_price: 'x' })).toBe(0);
    expect(precoDaRevisaoExtra({ max_revisions_included: 2, extra_revision_price: -5 })).toBe(0);
  });
});

describe('placar de revisoes da pagina de aprovacao', () => {
  test('0 inclusas = ilimitadas: sem numero de inclusas e sem preco', () => {
    expect(rota._placarDeRevisoes({ max_revisions_included: 0, extra_revision_price: 10 }, 3))
      .toEqual({ inclusas: null, usadas: 3, valor_extra: 0, ilimitadas: true });
  });

  test('2 inclusas e R$ 10: o placar de sempre, com ilimitadas false', () => {
    expect(rota._placarDeRevisoes({ max_revisions_included: 2, extra_revision_price: 10 }, 1))
      .toEqual({ inclusas: 2, usadas: 1, valor_extra: 10, ilimitadas: false });
  });

  test('GET /aprovacao/:token com a loja em 0 (Sheid, aura-qa)', async () => {
    const app = express();
    app.use('/aprovacao', rota);
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM studio_approval_links a/.test(s)) {
        return { rows: [{
          id: 'ap1', token: APROV, mockup_url: 'https://r2/m.png', status: 'pending',
          expires_at: new Date(Date.now() + 86400000).toISOString(), company_id: CID,
          order_id: OID, total_amount: '49.90', customer_name: 'Helena', order_number: '00123',
          trade_name: 'Sheid', items: [], revisions: [], ajustes_pedidos: 0,
        }] };
      }
      if (/FROM digital_channel_config dcc/.test(s)) {
        return { rows: [{
          company_id: CID, slug: 'sheid-mania', site_name: 'Sheid', is_published: true,
          studio_settings: { vitrine_v2: true, max_revisions_included: 0, extra_revision_price: 10 },
        }] };
      }
      return { rows: [] };
    });
    const r = await request(app).get(`/aprovacao/${APROV}`);
    expect(r.status).toBe(200);
    expect(r.body.revisoes).toEqual({ inclusas: null, usadas: 0, valor_extra: 0, ilimitadas: true });
  });
});
