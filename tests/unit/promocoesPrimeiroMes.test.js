// ============================================================
// Promocao "primeiro mes pelo calendario" (services/promocoes.js) — regras
// puras e o cupom automatico: bordas do prazo, dias ate a 1a cobranca, quem
// conta como "assinatura anterior", resgate previo e linha ausente.
//
// Bordas de data: o prazo e 31/10/2026 23:59:59.999 em Brasilia (UTC-3).
// ============================================================
const db = require('../../src/config/database');
const promocoes = require('../../src/services/promocoes');

const {
  PRIMEIRO_MES, dentroDoPrazo, temAssinaturaAnterior, avaliarElegibilidade,
  diasAteAPrimeiraCobranca, aplicarCampanha, buscarCupomAutomatico, promocaoAtiva,
} = promocoes;

const brt = (iso) => new Date(iso + '-03:00');

const acRow = (extra = {}) => ({
  id: 'ac-pm', code: 'PRIMEIROMES', type: 'promo', plan: 'negocio',
  discount_pct: 0, discount_value: 0, discount_months: 1, restrict_to_plan: false,
  trial_days: 7, max_uses: 1000000, uses: 3, expires_at: null, is_active: true, referrer_id: null,
  ...extra,
});

function arrangeDb({ row = acRow(), redeemed = false } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('FROM access_codes WHERE code')) return { rows: row ? [row] : [] };
    if (s.includes('FROM coupon_redemptions WHERE company_id')) return { rows: redeemed ? [{ '?column?': 1 }] : [] };
    return { rows: [] };
  });
}

const empresaNova = { id: 'c1', billing_status: 'trial', asaas_subscription_id: null, last_payment_date: null };

beforeEach(() => {
  db.query.mockReset();
  promocoes._resetAvisos();
});

describe('dentroDoPrazo — bordas do dia 31/10 em Brasilia', () => {
  test('ultimo milissegundo de 31/10 ainda vale', () => {
    expect(dentroDoPrazo(brt('2026-10-31T23:59:59.999'))).toBe(true);
  });

  test('31/10 23:59:59 vale', () => {
    expect(dentroDoPrazo(brt('2026-10-31T23:59:59.000'))).toBe(true);
  });

  test('01/11 00:00:00.000 ja nao vale', () => {
    expect(dentroDoPrazo(brt('2026-11-01T00:00:00.000'))).toBe(false);
  });

  test('meia-noite UTC de 01/11 (21h de 31/10 em Brasilia) ainda vale', () => {
    expect(dentroDoPrazo(new Date('2026-11-01T00:00:00.000Z'))).toBe(true);
  });

  test('03h UTC de 01/11 (00h em Brasilia) nao vale', () => {
    expect(dentroDoPrazo(new Date('2026-11-01T03:00:00.000Z'))).toBe(false);
  });

  test('dias antes do prazo valem', () => {
    expect(dentroDoPrazo(brt('2026-10-13T10:00:00'))).toBe(true);
  });
});

describe('diasAteAPrimeiraCobranca — conta pelo calendario de Brasilia', () => {
  test('14/10 -> 48 dias ate 01/12', () => {
    expect(diasAteAPrimeiraCobranca(brt('2026-10-14T09:00:00'))).toBe(48);
  });

  test('31/10 -> 31 dias', () => {
    expect(diasAteAPrimeiraCobranca(brt('2026-10-31T23:59:59'))).toBe(31);
  });

  test('21h-24h de Brasilia (ja e dia seguinte em UTC) nao adianta um dia', () => {
    // 22h BRT de 31/10 = 01h UTC de 01/11.
    expect(diasAteAPrimeiraCobranca(new Date('2026-11-01T01:00:00.000Z'))).toBe(31);
  });

  test('nunca menor que 1', () => {
    expect(diasAteAPrimeiraCobranca(brt('2026-12-05T10:00:00'))).toBe(1);
  });
});

describe('temAssinaturaAnterior', () => {
  test.each([
    ['trial de cadastro, sem assinatura', { billing_status: 'trial' }, false],
    ['status ausente', {}, false],
    ['trial vencido sem assinatura', { billing_status: 'trial', trial_ends_at: '2026-09-01' }, false],
    ['Pix pendente nunca pago', { billing_status: 'pending', asaas_subscription_id: 'sub_x' }, false],
    ['ja pagou alguma vez', { billing_status: 'trial', last_payment_date: '2026-08-10' }, true],
    ['ativa', { billing_status: 'active', asaas_subscription_id: 'sub_1' }, true],
    ['em atraso', { billing_status: 'overdue' }, true],
    ['cancelou (assinatura zerada, status fica)', { billing_status: 'cancelled', asaas_subscription_id: null }, true],
    ['trial com cartao salvo de outro cupom', { billing_status: 'trial', asaas_subscription_id: 'sub_2' }, true],
    ['cartao com cobranca em analise', { billing_status: 'pending', asaas_subscription_id: 'sub_3', asaas_pending_payment_id: 'pay_9' }, true],
  ])('%s', (_nome, company, esperado) => {
    expect(temAssinaturaAnterior(company)).toBe(esperado);
  });

  test('empresa nula nao quebra', () => {
    expect(temAssinaturaAnterior(null)).toBe(false);
  });
});

describe('avaliarElegibilidade', () => {
  test('empresa nova dentro do prazo', () => {
    expect(avaliarElegibilidade(empresaNova, brt('2026-10-20T12:00:00'))).toEqual({
      elegivel: true, motivo: null, mensagem: null,
    });
  });

  test('fora do prazo: encerrada (mesmo sendo empresa nova)', () => {
    const r = avaliarElegibilidade(empresaNova, brt('2026-11-01T00:00:00'));
    expect(r.elegivel).toBe(false);
    expect(r.motivo).toBe('encerrada');
  });

  test('com assinatura anterior: inelegivel', () => {
    const r = avaliarElegibilidade({ ...empresaNova, billing_status: 'active' }, brt('2026-10-20T12:00:00'));
    expect(r).toMatchObject({ elegivel: false, motivo: 'assinatura_anterior' });
  });
});

describe('aplicarCampanha', () => {
  const validado = { valid: true, id: 'ac-pm', code: 'PRIMEIROMES', type: 'promo', trial_days: 7, discount_pct: 0 };

  test('cupom que nao e da campanha volta intacto', () => {
    const outro = { valid: true, code: 'SHEID50', discount_pct: 50, trial_days: 0 };
    expect(aplicarCampanha(outro, { ...empresaNova, billing_status: 'active' }, brt('2026-12-20T12:00:00'))).toBe(outro);
  });

  test('cupom invalido volta como veio', () => {
    const invalido = { valid: false, error: 'Cupom expirado.' };
    expect(aplicarCampanha(invalido, empresaNova, brt('2026-10-20T12:00:00'))).toBe(invalido);
  });

  test('campanha elegivel: periodo gratis ate 01/12, sem desconto percentual', () => {
    const r = aplicarCampanha(validado, empresaNova, brt('2026-10-14T09:00:00'));
    expect(r).toMatchObject({
      valid: true, code: 'PRIMEIROMES', campaign: true,
      trial_days: 48, first_charge_date: '2026-12-01',
      discount_pct: 0, discount_value: 0, discount_months: 1,
    });
  });

  test('campanha com empresa inelegivel: recusa com a mensagem', () => {
    const r = aplicarCampanha(validado, { ...empresaNova, billing_status: 'active' }, brt('2026-10-20T12:00:00'));
    expect(r).toEqual({ valid: false, error: 'Esta promoção vale só para quem ainda não assinou o Aura.' });
  });

  test('campanha digitada depois do prazo: recusa', () => {
    const r = aplicarCampanha(validado, empresaNova, brt('2026-11-01T00:00:00'));
    expect(r).toEqual({ valid: false, error: 'Esta promoção já foi encerrada.' });
  });
});

describe('buscarCupomAutomatico', () => {
  test('empresa elegivel recebe o cupom da campanha', async () => {
    arrangeDb();
    const r = await buscarCupomAutomatico(empresaNova, brt('2026-10-20T12:00:00'));
    expect(r).toMatchObject({ id: 'ac-pm', code: 'PRIMEIROMES', campaign: true, first_charge_date: '2026-12-01' });
  });

  test('fora do prazo nem consulta o banco', async () => {
    arrangeDb();
    expect(await buscarCupomAutomatico(empresaNova, brt('2026-11-01T00:00:00'))).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('assinatura anterior: null sem consultar o banco', async () => {
    arrangeDb();
    expect(await buscarCupomAutomatico({ ...empresaNova, billing_status: 'overdue' }, brt('2026-10-20T12:00:00'))).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('uma vez por empresa: ja resgatou -> null', async () => {
    arrangeDb({ redeemed: true });
    expect(await buscarCupomAutomatico(empresaNova, brt('2026-10-20T12:00:00'))).toBeNull();
  });

  test('migration 372 pendente (linha ausente): null e avisa uma unica vez', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    arrangeDb({ row: null });
    expect(await buscarCupomAutomatico(empresaNova, brt('2026-10-20T12:00:00'))).toBeNull();
    expect(await buscarCupomAutomatico(empresaNova, brt('2026-10-20T12:00:00'))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('codigo desativado: null', async () => {
    arrangeDb({ row: acRow({ is_active: false }) });
    expect(await buscarCupomAutomatico(empresaNova, brt('2026-10-20T12:00:00'))).toBeNull();
  });

  test('erro de banco no cupom nao derruba: null', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValue(new Error('conexao'));
    expect(await buscarCupomAutomatico(empresaNova, brt('2026-10-20T12:00:00'))).toBeNull();
    console.error.mockRestore();
  });
});

describe('promocaoAtiva', () => {
  test('dentro do prazo e elegivel: payload completo', async () => {
    arrangeDb();
    const r = await promocaoAtiva(empresaNova, brt('2026-10-20T12:00:00'));
    expect(r).toEqual({
      codigo: 'PRIMEIROMES',
      titulo: PRIMEIRO_MES.titulo,
      descricao: PRIMEIRO_MES.descricao,
      termina_em: '2026-11-01T02:59:59.999Z',
      primeira_cobranca_em: '2026-12-01',
      elegivel: true,
    });
  });

  test('fora do prazo: elegivel false, mesmo payload', async () => {
    arrangeDb();
    const r = await promocaoAtiva(empresaNova, brt('2026-11-02T10:00:00'));
    expect(r.elegivel).toBe(false);
    expect(r.codigo).toBe('PRIMEIROMES');
  });

  test('inelegivel por assinatura anterior: elegivel false', async () => {
    arrangeDb();
    const r = await promocaoAtiva({ ...empresaNova, billing_status: 'active' }, brt('2026-10-20T12:00:00'));
    expect(r.elegivel).toBe(false);
  });
});
