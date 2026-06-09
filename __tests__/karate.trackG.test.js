// ============================================================
// AURA KARATÊ — Track G (acesso real)
// Testa a função PURA resolveKarateContext (sem DB): deriva
// federationId + papel karatê a partir da company primária.
// ============================================================
'use strict';

// karateRoles importa middleware/auth (que importa config/env). Para um teste
// puro de resolveKarateContext, mockamos o middleware — só precisamos da função.
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCompanyAccess: () => (req, res, next) => next(),
  requireFeature: () => (req, res, next) => next(),
}));

const { resolveKarateContext, KARATE_ROLES } = require('../src/config/karateRoles');

describe('resolveKarateContext — federação', () => {
  it('federationId = company.id e owner vira federation_admin', () => {
    const out = resolveKarateContext({
      id: 'fed-1', vertical_active: 'karate_federation', member_role: 'owner',
    });
    expect(out.federation_id).toBe('fed-1');
    expect(out.karate_role).toBe(KARATE_ROLES.FEDERATION_ADMIN);
  });

  it('preserva papel de staff cru (role_label)', () => {
    const out = resolveKarateContext({
      id: 'fed-1', vertical_active: 'karate_federation', member_role: 'federation_staff',
    });
    expect(out.federation_id).toBe('fed-1');
    expect(out.karate_role).toBe('federation_staff');
  });

  it('examiner é preservado', () => {
    const out = resolveKarateContext({
      id: 'fed-1', vertical_active: 'karate_federation', member_role: 'federation_examiner',
    });
    expect(out.karate_role).toBe(KARATE_ROLES.FEDERATION_EXAMINER);
  });
});

describe('resolveKarateContext — dojô', () => {
  it('federationId = federation_id (pai) e owner vira dojo_owner', () => {
    const out = resolveKarateContext({
      id: 'dojo-9', vertical_active: 'karate_dojo', federation_id: 'fed-1', member_role: 'owner',
    });
    expect(out.federation_id).toBe('fed-1');
    expect(out.karate_role).toBe(KARATE_ROLES.DOJO_OWNER);
  });

  it('sensei é preservado e aponta pra federação-pai', () => {
    const out = resolveKarateContext({
      id: 'dojo-9', vertical_active: 'karate_dojo', federation_id: 'fed-1', member_role: 'sensei',
    });
    expect(out.federation_id).toBe('fed-1');
    expect(out.karate_role).toBe(KARATE_ROLES.SENSEI);
  });

  it('dojô sem federation_id (órfão) → federation_id null, papel ainda resolve', () => {
    const out = resolveKarateContext({
      id: 'dojo-9', vertical_active: 'karate_dojo', federation_id: null, member_role: 'owner',
    });
    expect(out.federation_id).toBeNull();
    expect(out.karate_role).toBe(KARATE_ROLES.DOJO_OWNER);
  });
});

describe('resolveKarateContext — fora de karatê / vazio', () => {
  it('vertical não-karatê → tudo null', () => {
    const out = resolveKarateContext({ id: 'c-1', vertical_active: 'odonto', member_role: 'owner' });
    expect(out).toEqual({ federation_id: null, karate_role: null });
  });

  it('vertical_active null → tudo null', () => {
    const out = resolveKarateContext({ id: 'c-1', vertical_active: null, member_role: 'owner' });
    expect(out).toEqual({ federation_id: null, karate_role: null });
  });

  it('company null (modo consolidado) → tudo null', () => {
    expect(resolveKarateContext(null)).toEqual({ federation_id: null, karate_role: null });
  });

  it('member_role ausente assume owner (federação → admin)', () => {
    const out = resolveKarateContext({ id: 'fed-1', vertical_active: 'karate_federation' });
    expect(out.karate_role).toBe(KARATE_ROLES.FEDERATION_ADMIN);
  });
});
