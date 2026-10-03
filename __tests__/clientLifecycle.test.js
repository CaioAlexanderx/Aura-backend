const { classifyLifecycle, RECOVERY_WINDOW_DAYS } = require('../src/services/clientLifecycle');

const NOW = new Date('2026-10-03T15:00:00Z');
const daysFromNow = (d) => new Date(NOW.getTime() + d * 86400000).toISOString();
const company = (over) => ({
  trade_name: 'Loja', legal_name: 'Loja LTDA', is_active: true, is_sandbox: false,
  owner_is_staff: false, billing_status: 'trial', created_at: daysFromNow(-5),
  trial_ends_at: daysFromNow(2), ...over,
});

describe('classifyLifecycle', () => {
  test('trial dentro do prazo: etapa trial com dias restantes arredondados para cima', () => {
    expect(classifyLifecycle(company({ trial_ends_at: daysFromNow(2.2) }), NOW))
      .toMatchObject({ stage: 'trial', trial_days_left: 3, days_since_expiry: null });
  });

  test('trial vencido dentro da janela: vencido, mesmo com billing_status ainda trial', () => {
    expect(classifyLifecycle(company({ trial_ends_at: daysFromNow(-0.9) }), NOW))
      .toMatchObject({ stage: 'vencido', days_since_expiry: 0 });
    expect(classifyLifecycle(company({ trial_ends_at: daysFromNow(-RECOVERY_WINDOW_DAYS) }), NOW))
      .toMatchObject({ stage: 'vencido', days_since_expiry: RECOVERY_WINDOW_DAYS });
  });

  test('trial vencido além da janela: arquivo como não aderiu', () => {
    expect(classifyLifecycle(company({ trial_ends_at: daysFromNow(-(RECOVERY_WINDOW_DAYS + 1)) }), NOW))
      .toMatchObject({ stage: 'arquivo', archive_reason: 'nao_aderiu' });
  });

  test('sem trial_ends_at conta o prazo a partir do cadastro', () => {
    expect(classifyLifecycle(company({ trial_ends_at: null, created_at: daysFromNow(-3) }), NOW).stage).toBe('vencido');
    expect(classifyLifecycle(company({ trial_ends_at: null, created_at: daysFromNow(-90) }), NOW))
      .toMatchObject({ stage: 'arquivo', archive_reason: 'nao_aderiu' });
  });

  test('assinatura ativa, pendente ou em atraso é cliente, com trial vencido ou não', () => {
    ['active', 'pending', 'overdue'].forEach((st) => {
      expect(classifyLifecycle(company({ billing_status: st, trial_ends_at: daysFromNow(-40) }), NOW).stage).toBe('cliente');
    });
  });

  test('cancelada e desativada vão para o arquivo com o motivo', () => {
    expect(classifyLifecycle(company({ billing_status: 'cancelled' }), NOW))
      .toMatchObject({ stage: 'arquivo', archive_reason: 'cancelado' });
    expect(classifyLifecycle(company({ is_active: false, billing_status: 'active' }), NOW))
      .toMatchObject({ stage: 'arquivo', archive_reason: 'inativo' });
  });

  test('sandbox, conta de staff e empresa [TESTE] são internas, qualquer que seja o status', () => {
    expect(classifyLifecycle(company({ is_sandbox: true, billing_status: 'active' }), NOW).stage).toBe('interno');
    expect(classifyLifecycle(company({ owner_is_staff: true }), NOW).stage).toBe('interno');
    expect(classifyLifecycle(company({ trade_name: '[TESTE] Homolog NFC-e', trial_ends_at: null }), NOW).stage).toBe('interno');
  });
});
