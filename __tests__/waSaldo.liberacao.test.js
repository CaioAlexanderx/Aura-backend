// ============================================================
// AURA. — Liberacao do WhatsApp por loja (28/11/2026), sem banco.
// waSaldo.emTeste / liberacaoDe / lerLiberacao e o campo whatsapp_loja
// do /auth/me. A prova no banco esta em waSaldo.banco.test.js.
// ============================================================
'use strict';

const waSaldo = require('../src/services/waSaldo');

const AGORA = new Date('2026-12-01T12:00:00Z');
const futuro = '2026-12-10T12:00:00Z';
const passado = '2026-11-20T12:00:00Z';

describe('emTeste', () => {
  test('trial no futuro, sem assinatura e sem cobranca ativa', () => {
    expect(waSaldo.emTeste({ trial_ends_at: futuro }, AGORA)).toBe(true);
  });
  test('trial vencido, assinado ou com cobranca ativa nao e teste', () => {
    expect(waSaldo.emTeste({ trial_ends_at: passado }, AGORA)).toBe(false);
    expect(waSaldo.emTeste({ trial_ends_at: futuro, asaas_subscription_id: 'sub_1' }, AGORA)).toBe(false);
    expect(waSaldo.emTeste({ trial_ends_at: futuro, billing_status: 'active' }, AGORA)).toBe(false);
    expect(waSaldo.emTeste({}, AGORA)).toBe(false);
  });
});

describe('liberacaoDe', () => {
  test('teste: so depois da 1a venda', () => {
    expect(waSaldo.liberacaoDe({ origem: 'teste', primeiraVenda: false }))
      .toMatchObject({ liberado: false, fase: 'teste_aguardando_venda' });
    expect(waSaldo.liberacaoDe({ origem: 'teste', primeiraVenda: true, testeAte: '2026-12-10T12:00:00.000Z' }))
      .toEqual({ liberado: true, fase: 'teste', teste_ate: '2026-12-10T12:00:00.000Z' });
  });
  test('Negocio (plano, add-on, vertical) segue liberado por plano', () => {
    for (const origem of ['plano', 'addon', 'vertical']) {
      expect(waSaldo.liberacaoDe({ origem })).toMatchObject({ liberado: true, fase: 'plano' });
    }
  });
  test('Essencial pago sem teste fica fechado', () => {
    expect(waSaldo.liberacaoDe({ origem: 'essencial' })).toMatchObject({ liberado: false, fase: 'fechado' });
  });
});

describe('lerLiberacao', () => {
  const linha = (extra) => ({ rows: [{ plan: 'negocio', trial_ends_at: futuro, tem_venda: true, ...extra }] });
  test('Negocio em teste com venda: liberado; assinando, passa para o plano', async () => {
    const runner = { query: jest.fn().mockResolvedValueOnce(linha({})) };
    expect(await waSaldo.lerLiberacao('c1', { agora: AGORA, runner })).toMatchObject({ liberado: true, fase: 'teste' });
    const r2 = { query: jest.fn().mockResolvedValueOnce(linha({ asaas_subscription_id: 'sub' })) };
    expect(await waSaldo.lerLiberacao('c1', { agora: AGORA, runner: r2 })).toMatchObject({ liberado: true, fase: 'plano' });
  });
  test('teste sem venda: nao liberado', async () => {
    const runner = { query: jest.fn().mockResolvedValueOnce(linha({ tem_venda: false })) };
    expect(await waSaldo.lerLiberacao('c1', { agora: AGORA, runner })).toMatchObject({ liberado: false });
  });
  test('erro de banco: null (o app cai no plano)', async () => {
    const runner = { query: jest.fn().mockRejectedValueOnce(new Error('x')) };
    expect(await waSaldo.lerLiberacao('c1', { agora: AGORA, runner })).toBeNull();
  });
});
