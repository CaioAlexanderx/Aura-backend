// ============================================================
// AURA KARATÊ — Testes Track J: pedido de certificado (workflow)
//
// Track J substituiu o fluxo "emissão sob demanda" (issueCertificate)
// por um modelo de PEDIDO com estados:
//   requested → in_production → printed → shipped | refused
//
// Cobertura:
//   1. createOrder — happy path (praticante aprovado, sem duplicata)
//   2. createOrder — duplicata → DUPLICATE_ORDER
//   3. advanceStatus — happy path (requested → in_production)
//   4. advanceStatus — estado inválido → INVALID_STATUS
//   5. advanceStatus — pedido já encerrado → NOT_FOUND_OR_CLOSED
//   6. refuseOrder — happy path (com motivo)
//   7. refuseOrder — motivo ausente → MISSING_REASON
//
// Estilo: mock direto de db.query (sem supertest — testa a camada de serviço).
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/karateMailer');

const db = require('../src/config/database');

// karateMailer é best-effort — silencia para não poluir o output
const { sendKarateEmail } = require('../src/services/karateMailer');
sendKarateEmail.mockResolvedValue(undefined);

const {
  createOrder,
  advanceStatus,
  refuseOrder,
} = require('../src/services/karateCertificateService');

const FED_ID       = 'fed-j-uuid-001';
const DOJO_ID      = 'dojo-j-uuid-001';
const PRACT_ID     = 'pract-j-uuid-001';
const ORDER_ID     = 'order-j-uuid-001';

// Objeto base de pedido retornado pelo banco
const baseOrder = {
  id:             ORDER_ID,
  federation_id:  FED_ID,
  dojo_id:        DOJO_ID,
  practitioner_id: PRACT_ID,
  belt_level:     5,
  belt_name:      'Faixa Azul',
  nome_impresso:  'João Silva',
  delivery_type:  'pickup',
  status:         'requested',
  created_at:     new Date().toISOString(),
  updated_at:     new Date().toISOString(),
};

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
});

// ── Suite 1: createOrder ──────────────────────────────────────
describe('createOrder — criar pedido de certificado', () => {
  it('happy path: insere pedido com status=requested e retorna a linha', async () => {
    db.query
      // 1. karate_belt_history — graduação existente
      .mockResolvedValueOnce({ rows: [{ id: 'bh-1' }] })
      // 2. karate_certificate_orders — sem duplicata
      .mockResolvedValueOnce({ rows: [] })
      // 3. INSERT karate_certificate_orders RETURNING *
      .mockResolvedValueOnce({ rows: [{ ...baseOrder }] })
      // 4. INSERT karate_certificate_order_history (fire-and-forget)
      .mockResolvedValueOnce({ rows: [] });

    const order = await createOrder({
      federationId:   FED_ID,
      dojoId:         DOJO_ID,
      practitionerId: PRACT_ID,
      beltLevel:      5,
      beltName:       'Faixa Azul',
      nomeImpresso:   'João Silva',
      deliveryType:   'pickup',
    });

    expect(order.id).toBe(ORDER_ID);
    expect(order.status).toBe('requested');
    expect(order.federation_id).toBe(FED_ID);
  });

  it('duplicata ativa → lança DUPLICATE_ORDER', async () => {
    db.query
      // 1. karate_belt_history
      .mockResolvedValueOnce({ rows: [{ id: 'bh-1' }] })
      // 2. karate_certificate_orders — pedido existente
      .mockResolvedValueOnce({ rows: [{ id: 'existing-order' }] });

    await expect(
      createOrder({
        federationId:   FED_ID,
        dojoId:         DOJO_ID,
        practitionerId: PRACT_ID,
        beltLevel:      5,
        beltName:       'Faixa Azul',
        nomeImpresso:   'João Silva',
      })
    ).rejects.toMatchObject({ code: 'DUPLICATE_ORDER' });
  });
});

// ── Suite 2: advanceStatus ────────────────────────────────────
describe('advanceStatus — avançar estado do pedido', () => {
  it('happy path: requested → in_production', async () => {
    const updatedOrder = { ...baseOrder, status: 'in_production' };

    db.query
      // 1. UPDATE karate_certificate_orders RETURNING *
      .mockResolvedValueOnce({ rows: [updatedOrder] })
      // 2. getFederationEmailData — companies
      .mockResolvedValueOnce({ rows: [{ name: 'Federação Test', email: null }] })
      // 3. getDojoEmail — companies
      .mockResolvedValueOnce({ rows: [{ email: null, name: 'Dojô Test' }] })
      // 4. INSERT karate_certificate_order_history (fire-and-forget)
      .mockResolvedValueOnce({ rows: [] });

    const order = await advanceStatus(ORDER_ID, FED_ID, 'in_production', {
      whoId: 'staff-1', whoName: 'Sensei', orgName: 'Federação',
    });

    expect(order.status).toBe('in_production');
    expect(order.id).toBe(ORDER_ID);
  });

  it('estado inválido → lança INVALID_STATUS', async () => {
    await expect(
      advanceStatus(ORDER_ID, FED_ID, 'foobar', {})
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('pedido não encontrado ou já encerrado → lança NOT_FOUND_OR_CLOSED', async () => {
    db.query
      // UPDATE não retorna linha (pedido encerrado ou federação errada)
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      advanceStatus(ORDER_ID, FED_ID, 'in_production', {})
    ).rejects.toMatchObject({ code: 'NOT_FOUND_OR_CLOSED' });
  });
});

// ── Suite 3: refuseOrder ─────────────────────────────────────
describe('refuseOrder — recusar pedido', () => {
  it('happy path: recusa com motivo e retorna pedido com status=refused', async () => {
    const refusedOrder = { ...baseOrder, status: 'refused', refusal_reason: 'Documentação incompleta' };

    db.query
      // 1. UPDATE karate_certificate_orders SET status='refused' RETURNING *
      .mockResolvedValueOnce({ rows: [refusedOrder] })
      // 2. getFederationEmailData
      .mockResolvedValueOnce({ rows: [{ name: 'Federação Test', email: null }] })
      // 3. getDojoEmail
      .mockResolvedValueOnce({ rows: [{ email: null, name: 'Dojô Test' }] })
      // 4. INSERT karate_certificate_order_history
      .mockResolvedValueOnce({ rows: [] });

    const order = await refuseOrder(ORDER_ID, FED_ID, 'Documentação incompleta', {
      whoId: 'staff-1', whoName: 'Sensei',
    });

    expect(order.status).toBe('refused');
    expect(order.refusal_reason).toBe('Documentação incompleta');
  });

  it('motivo ausente → lança MISSING_REASON (sem tocar o banco)', async () => {
    await expect(
      refuseOrder(ORDER_ID, FED_ID, '', {})
    ).rejects.toMatchObject({ code: 'MISSING_REASON' });

    // Nenhuma query deve ter sido executada
    expect(db.query).not.toHaveBeenCalled();
  });
});
