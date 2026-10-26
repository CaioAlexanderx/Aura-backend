// ============================================================
// Limpeza das contas pendentes (tq-113): a regra pura e o agendamento.
// O SQL de verdade (desativar, lead, audit_log, reativar) está em
// __tests__/limpezaPendentes.banco.test.js.
// ============================================================
'use strict';

const L = require('../../src/services/limpezaPendentes');
const job = require('../../src/jobs/limpezaPendentesJob');

const AGORA = new Date('2026-10-26T12:00:00.000Z');
const HA = (dias) => new Date(AGORA.getTime() - dias * 86400000).toISOString();

const pendente = {
  company_id: '11111111-0000-4000-8000-000000000001', owner_id: 'u1', is_active: true,
  email_verified: false, is_staff: false, is_sandbox: false,
  owner_email: 'dona@gmail.com', company_email: 'dona@gmail.com',
  vertical: null, vertical_active: null, federation_id: null,
  billing_status: 'trial', asaas_subscription_id: null,
  tem_venda: false, tem_pagamento: false, empresas_do_dono: 1,
  user_created_at: HA(8), company_created_at: HA(8),
};
const avaliar = (extra, env = {}) => L.avaliar({ ...pendente, ...extra }, { agora: AGORA, env });

describe('avaliar: quem é desativado', () => {
  test('pendente há mais de 7 dias, sem nada: desativa', () => {
    expect(avaliar({})).toEqual({ desativar: true, motivo: null });
  });

  test.each([
    [{ tem_venda: true }, 'tem_venda'],
    [{ tem_pagamento: true }, 'tem_pagamento'],
    [{ asaas_subscription_id: 'sub_1' }, 'assinatura_asaas'],
    [{ billing_status: 'active' }, 'billing_ativo'],
    [{ is_sandbox: true }, 'nao_pendente'],
    [{ is_staff: true }, 'nao_pendente'],
    [{ email_verified: true }, 'nao_pendente'],
    [{ owner_email: 'caio@getaura.com.br' }, 'nao_pendente'],
    [{ vertical: 'karate_dojo' }, 'karate'],
    [{ vertical_active: 'karate_federation' }, 'karate'],
    [{ federation_id: 'f1' }, 'karate'],
    [{ empresas_do_dono: 2 }, 'dono_com_mais_de_uma_empresa'],
    [{ user_created_at: HA(6) }, 'menos_de_7_dias'],
    [{ company_created_at: HA(2) }, 'menos_de_7_dias'],
    [{ is_active: false }, 'ja_inativa'],
  ])('nunca toca: %j -> %s', (extra, motivo) => {
    expect(avaliar(extra)).toEqual({ desativar: false, motivo });
  });

  test('a empresa do canário nunca é desativada', () => {
    expect(avaliar({}, { CANARY_COMPANY_ID: pendente.company_id.toUpperCase() }))
      .toEqual({ desativar: false, motivo: 'canario' });
  });

  test('venda ou pagamento ganham de qualquer outra coisa', () => {
    expect(avaliar({ tem_venda: true, user_created_at: HA(90) }).desativar).toBe(false);
    expect(avaliar({ tem_pagamento: true, user_created_at: HA(90) }).desativar).toBe(false);
  });
});

describe('interruptores', () => {
  test('nasce ligado; LIMPEZA_PENDENTES_ENABLED=false desliga; dry-run só quando pedido', () => {
    expect(L.lerConfig({})).toEqual({ enabled: true, dryRun: false });
    expect(L.lerConfig({ LIMPEZA_PENDENTES_ENABLED: 'false' }).enabled).toBe(false);
    expect(L.lerConfig({ LIMPEZA_PENDENTES_ENABLED: '0' }).enabled).toBe(false);
    expect(L.lerConfig({ LIMPEZA_PENDENTES_DRY_RUN: 'true' }).dryRun).toBe(true);
  });

  test('desligado: não consulta o banco', async () => {
    const pool = { query: jest.fn(), connect: jest.fn() };
    const r = await L.rodarLimpeza({ pool, env: { LIMPEZA_PENDENTES_ENABLED: 'false' } });
    expect(r).toMatchObject({ ligado: false, desativadas: 0 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('sem a migration 413: não desativa ninguém', async () => {
    const erro = Object.assign(new Error('column "desativada_por" does not exist'), { code: '42703' });
    const pool = { query: jest.fn(async () => { throw erro; }), connect: jest.fn() };
    const r = await L.rodarLimpeza({ pool, env: {} });
    expect(r).toMatchObject({ migrationPendente: true, desativadas: 0 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('reativar com a migration pendente não derruba a confirmação', async () => {
    const erro = Object.assign(new Error('x'), { code: '42703' });
    const db = { query: jest.fn(async () => { throw erro; }) };
    await expect(L.reativarAoConfirmar('u1', { db })).resolves.toEqual([]);
  });
});

describe('agendamento: uma vez por dia depois das 05h BRT', () => {
  test('antes das 05h não roda; depois roda uma vez no dia', () => {
    const quatro = Date.parse('2026-10-26T07:59:00.000Z'); // 04h59 BRT
    const cinco = Date.parse('2026-10-26T08:00:00.000Z');  // 05h00 BRT
    expect(job.devePassarAgora(quatro, null)).toBe(false);
    expect(job.devePassarAgora(cinco, null)).toBe(true);
    expect(job.devePassarAgora(cinco, '2026-10-26')).toBe(false);
  });

  test('o encerramento acha o stop do job', () => {
    expect(typeof job.stopLimpezaPendentesJob).toBe('function');
  });
});
