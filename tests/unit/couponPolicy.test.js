// ============================================================
// QA — Teste unitario: services/couponPolicy (titularidade de cupom)
//
// Funcao pura: sem mock de db, sem supertest, sem app. E a MESMA regra
// usada pelos dois caminhos que aceitam cupom (POST /coupons/validate e
// POST /pdv/sale), entao vale testa-la isolada -- os testes de integracao
// cobrem o encaixe, este aqui cobre a regra.
//
// Cupom NOMINAL  = coupons.customer_id preenchido (birthday / credit_lead).
// Cupom GENERICO = coupons.customer_id NULL (100% dos 'manual' de hoje).
// ============================================================
const { checkCouponOwner } = require('../../src/services/couponPolicy');

describe('checkCouponOwner — cupom generico', () => {
  test('customer_id null passa COM cliente na venda', () => {
    expect(checkCouponOwner({ customer_id: null }, 'cust-1')).toEqual({ ok: true });
  });

  test('customer_id null passa SEM cliente na venda', () => {
    expect(checkCouponOwner({ customer_id: null }, null)).toEqual({ ok: true });
    expect(checkCouponOwner({ customer_id: null }, undefined)).toEqual({ ok: true });
  });

  test('customer_id undefined (coluna ausente) passa', () => {
    expect(checkCouponOwner({}, null)).toEqual({ ok: true });
  });
});

describe('checkCouponOwner — coupon ausente', () => {
  test('coupon null passa', () => {
    expect(checkCouponOwner(null, 'cust-1')).toEqual({ ok: true });
  });

  test('coupon undefined passa', () => {
    expect(checkCouponOwner(undefined, 'cust-1')).toEqual({ ok: true });
  });
});

describe('checkCouponOwner — cupom nominal, dono certo', () => {
  test('customerId igual passa', () => {
    const coupon = { customer_id: 'cust-A', owner_name: 'Maria Silva' };
    expect(checkCouponOwner(coupon, 'cust-A')).toEqual({ ok: true });
  });
});

describe('checkCouponOwner — cupom nominal, dono errado', () => {
  const coupon = { customer_id: 'cust-A', owner_name: 'Maria Silva' };

  test('customerId diferente -> COUPON_CUSTOMER_MISMATCH', () => {
    const r = checkCouponOwner(coupon, 'cust-B');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('COUPON_CUSTOMER_MISMATCH');
  });

  test('mensagem cita o primeiro nome do dono', () => {
    const r = checkCouponOwner(coupon, 'cust-B');
    expect(r.error).toContain('Maria');
    expect(r.error).not.toContain('undefined');
  });
});

describe('checkCouponOwner — cupom nominal, venda sem cliente', () => {
  const coupon = { customer_id: 'cust-A', owner_name: 'Maria Silva' };

  test.each([
    ['undefined', undefined],
    ['null',      null],
    ['string vazia', ''],
  ])('customerId %s -> COUPON_REQUIRES_CUSTOMER', (_label, customerId) => {
    const r = checkCouponOwner(coupon, customerId);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('COUPON_REQUIRES_CUSTOMER');
    expect(r.error).toContain('Maria');
    expect(r.error).not.toContain('undefined');
  });
});

describe('checkCouponOwner — owner_name', () => {
  test('owner_name ausente -> mensagem generica, sem "undefined" no texto', () => {
    const semNome = { customer_id: 'cust-A' };
    const mismatch = checkCouponOwner(semNome, 'cust-B');
    expect(mismatch.code).toBe('COUPON_CUSTOMER_MISMATCH');
    expect(mismatch.error).not.toContain('undefined');
    expect(mismatch.error).toBe('Cupom exclusivo de outro cliente.');

    const semCliente = checkCouponOwner(semNome, null);
    expect(semCliente.code).toBe('COUPON_REQUIRES_CUSTOMER');
    expect(semCliente.error).not.toContain('undefined');
    expect(semCliente.error).toBe('Cupom exclusivo de um cliente. Selecione o cliente na venda para usar.');
  });

  test('owner_name null / string vazia -> mensagem generica', () => {
    for (const owner_name of [null, '', '   ']) {
      const r = checkCouponOwner({ customer_id: 'cust-A', owner_name }, 'cust-B');
      expect(r.error).toBe('Cupom exclusivo de outro cliente.');
      expect(r.error).not.toContain('undefined');
    }
  });

  test('owner_name composto usa so o primeiro nome', () => {
    const coupon = { customer_id: 'cust-A', owner_name: 'Cleide milene' };
    const r = checkCouponOwner(coupon, 'cust-B');
    expect(r.error).toContain('Cleide');
    expect(r.error).not.toContain('milene');
  });

  test('owner_name com espacos extras nao vaza espaco na mensagem', () => {
    const coupon = { customer_id: 'cust-A', owner_name: '  Cleide   milene  ' };
    const r = checkCouponOwner(coupon, null);
    expect(r.error).toBe('Cupom exclusivo de Cleide. Selecione o cliente na venda para usar.');
  });
});

describe('checkCouponOwner — comparacao como string', () => {
  // O customer_id pode chegar do pg como string e do body como numero (ou
  // vice-versa, em base legada com id inteiro). A comparacao e feita com
  // String() dos dois lados justamente pra nao reprovar o proprio dono.
  test('numero no cupom x string na venda -> passa', () => {
    expect(checkCouponOwner({ customer_id: 123, owner_name: 'Ana' }, '123')).toEqual({ ok: true });
  });

  test('string no cupom x numero na venda -> passa', () => {
    expect(checkCouponOwner({ customer_id: '123', owner_name: 'Ana' }, 123)).toEqual({ ok: true });
  });

  test('numeros diferentes continuam reprovando', () => {
    const r = checkCouponOwner({ customer_id: 123, owner_name: 'Ana' }, 456);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('COUPON_CUSTOMER_MISMATCH');
  });

  test('UUID igual em objeto com toString -> passa', () => {
    const uuid = '00000000-0000-0000-0000-0000000000aa';
    const like = { toString: () => uuid };
    expect(checkCouponOwner({ customer_id: uuid, owner_name: 'Ana' }, like)).toEqual({ ok: true });
  });
});
