// ============================================================
// Segundo CNPJ do Negócio a 50% do plano (decisão do Caio, 25/10/2026)
//
//   - tabela única (billingPricing): Negócio 1 incluído, extra = 50% do plano
//     no ciclo com centavo para cima; Essencial e Expansão sem mudança;
//     exceção explícita do Davi (2 incluídos).
//   - sync (multicnpjBilling): sem retroatividade. Só grava quando a loja
//     adiciona/remove empresa E a assinatura de hoje bate com a tabela de
//     antes; valor combinado e assinatura fora da tabela não são sobrescritos
//     (avisa no sino da empresa Aura).
//   - nenhum caminho além de POST/DELETE /me/companies chama o recálculo.
// A Asaas nunca é chamada: deps.asaas é um jest.fn.
// ============================================================
jest.mock('../../src/services/subscriptionDiscount', () => ({
  ...jest.requireActual('../../src/services/subscriptionDiscount'),
  getSyncAdjustment: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const db = require('../../src/config/database');
const { getSyncAdjustment } = require('../../src/services/subscriptionDiscount');
const pricing = require('../../src/services/billingPricing');
const {
  arredondarCentavoParaCima,
  getMulticnpjBreakdown,
  getExtraCompanyValue,
  getIncludedCompanies,
  getPlanValue,
  getTotalValue,
  NEGOCIO_DOIS_CNPJS_INCLUIDOS,
} = pricing;
const multicnpj = require('../../src/utils/multicnpjBilling');

const DAVI_MATRIZ = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const VILLA_BRANCA = 'aaaaaaaa-0000-4000-8000-000000000002';
const PRIMARY = '11111111-1111-4111-8111-111111111111';
const FILHA = '22222222-2222-4222-8222-222222222222';
const TERCEIRA = '33333333-3333-4333-8333-333333333333';
const ALERTA = '645c1325-8865-48be-af6f-430d93fb2b6c';

// ── Tabela (pura) ───────────────────────────────────────────

describe('arredondarCentavoParaCima', () => {
  test.each([
    [70.415, 70.42],
    [84.5, 84.5],
    [70.42, 70.42],
    [0.1 + 0.2, 0.3],
    [140.83 * 0.5, 70.42],
    [169 * 0.5, 84.5],
    [10.001, 10.01],
    [0, 0],
  ])('%p -> %p', (entrada, saida) => {
    expect(arredondarCentavoParaCima(entrada)).toBe(saida);
  });
});

describe('Negócio: segundo CNPJ a 50% do plano no ciclo', () => {
  test('anual: 140,83 + 70,42 = 211,25', () => {
    const b = getMulticnpjBreakdown('negocio', 'annual', { totalCompanies: 2 });
    expect(b.base_price).toBe(140.83);
    expect(b.extra_unit_price).toBe(70.42);
    expect(b.included_in_plan).toBe(1);
    expect(b.extra_cnpjs).toBe(1);
    expect(b.total_monthly).toBe(211.25);
  });

  test('mensal: 169,00 + 84,50 = 253,50', () => {
    const b = getMulticnpjBreakdown('negocio', 'monthly', { totalCompanies: 2 });
    expect(b.base_price).toBe(169);
    expect(b.extra_unit_price).toBe(84.5);
    expect(b.total_monthly).toBe(253.5);
  });

  test('uma empresa só: o plano, como sempre', () => {
    expect(getMulticnpjBreakdown('negocio', 'monthly', { totalCompanies: 1 }).total_monthly).toBe(169);
    expect(getMulticnpjBreakdown('negocio', 'annual', { totalCompanies: 1 }).total_monthly).toBe(140.83);
  });

  test('três empresas: dois extras', () => {
    expect(getMulticnpjBreakdown('negocio', 'monthly', { totalCompanies: 3 }).total_monthly).toBe(338);
    expect(getMulticnpjBreakdown('negocio', 'annual', { totalCompanies: 3 }).total_monthly).toBe(281.67);
  });

  test('acessos extras entram cheios, fora do percentual', () => {
    const b = getMulticnpjBreakdown('negocio', 'annual', { totalCompanies: 2, extraSeats: 1 });
    expect(b.extra_unit_price).toBe(70.42);
    expect(b.seats_value).toBe(19);
    expect(b.total_monthly).toBe(230.25);
  });

  test('plano sem preço na tabela não gera cobrança automática', () => {
    expect(getMulticnpjBreakdown('personalizado', 'monthly', { totalCompanies: 5 })).toBeNull();
    expect(getExtraCompanyValue('personalizado', 'monthly')).toBeNull();
  });
});

describe('Exceção explícita do Davi', () => {
  test('constante nomeada, com a decisão e a data', () => {
    expect(NEGOCIO_DOIS_CNPJS_INCLUIDOS[DAVI_MATRIZ]).toMatch(/Davi/);
    expect(NEGOCIO_DOIS_CNPJS_INCLUIDOS[DAVI_MATRIZ]).toMatch(/25\/10\/2026/);
    expect(Object.isFrozen(NEGOCIO_DOIS_CNPJS_INCLUIDOS)).toBe(true);
  });

  test('grupo do Davi continua com 2 CNPJs incluídos', () => {
    const b = getMulticnpjBreakdown('negocio', 'monthly', { totalCompanies: 2, companyIds: [DAVI_MATRIZ, VILLA_BRANCA] });
    expect(b.included_in_plan).toBe(2);
    expect(b.extra_cnpjs).toBe(0);
    expect(b.total_monthly).toBe(169);
    expect(b.excecao).toMatch(/Davi/);
  });

  test('vale mesmo se a principal for transferida para a Villa Branca', () => {
    expect(getIncludedCompanies('negocio', [VILLA_BRANCA, DAVI_MATRIZ])).toBe(2);
  });

  test('terceira empresa do Davi paga um extra pela regra nova', () => {
    const b = getMulticnpjBreakdown('negocio', 'annual', { totalCompanies: 3, companyIds: [DAVI_MATRIZ, VILLA_BRANCA, TERCEIRA] });
    expect(b.extra_cnpjs).toBe(1);
    expect(b.total_monthly).toBe(211.25);
  });

  test('outro grupo do Negócio não herda a exceção', () => {
    expect(getIncludedCompanies('negocio', [PRIMARY, FILHA])).toBe(1);
  });
});

describe('Essencial e Expansão sem mudança', () => {
  test('preço dos planos na tabela continua o mesmo', () => {
    expect(getPlanValue('essencial', 'monthly')).toBe(89);
    expect(getPlanValue('negocio', 'monthly')).toBe(169);
    expect(getPlanValue('negocio', 'annual')).toBe(140.83);
    expect(getPlanValue('expansao', 'monthly')).toBe(269);
    expect(getTotalValue('negocio', 'annual', 'PIX', 2)).toBe(178.83);
  });

  test('Essencial: 1 incluído, extra fixo de R$ 45 nos dois ciclos', () => {
    expect(getIncludedCompanies('essencial')).toBe(1);
    expect(getExtraCompanyValue('essencial', 'monthly')).toBe(45);
    expect(getExtraCompanyValue('essencial', 'annual')).toBe(45);
  });

  test('Expansão: 2 incluídos, extra fixo de R$ 135 nos dois ciclos', () => {
    expect(getIncludedCompanies('expansao')).toBe(2);
    expect(getExtraCompanyValue('expansao', 'monthly')).toBe(135);
    expect(getExtraCompanyValue('expansao', 'annual')).toBe(135);
    expect(getMulticnpjBreakdown('expansao', 'monthly', { totalCompanies: 2 }).total_monthly).toBe(269);
    expect(getMulticnpjBreakdown('expansao', 'monthly', { totalCompanies: 3 }).total_monthly).toBe(404);
  });

  test('a exceção do Davi não vale fora do Negócio', () => {
    expect(getIncludedCompanies('essencial', [DAVI_MATRIZ])).toBe(1);
  });
});

// ── Sync (sem retroatividade) ───────────────────────────────

// Banco falso por SQL. `grupo` = ids ativos do grupo (inclui a principal).
function banco({ primaryId = PRIMARY, plan = 'negocio', cycle = 'monthly', grupo = [PRIMARY], subId = 'sub_1', seats = 0, combinado = null }) {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql || '');
    if (/SELECT id, plan, owner_id, billing_cycle FROM companies WHERE id = \$1 AND is_primary = true/.test(s)) {
      return { rows: params[0] === primaryId ? [{ id: primaryId, plan, owner_id: 'u1', billing_cycle: cycle }] : [] };
    }
    if (/WHERE \(id = \$1 OR billing_owner_company_id = \$1\)/.test(s)) {
      return { rows: grupo.map((id) => ({ id })) };
    }
    if (/extra_seats_granted/.test(s)) return { rows: [{ id: params[0] && params[0][0], extra_seats_granted: seats }] };
    if (/custom_subscription_value/.test(s)) {
      return { rows: [combinado || { custom_subscription_value: null }] };
    }
    if (/SELECT asaas_subscription_id/.test(s)) return { rows: [{ asaas_subscription_id: subId, asaas_customer_id: 'cus_1' }] };
    if (/AS loja FROM companies/.test(s)) return { rows: [{ loja: 'Loja Teste' }] };
    if (/UPDATE companies SET asaas_subscription_id=NULL/.test(s)) return { rows: [] };
    throw new Error('SQL inesperado no teste: ' + s.slice(0, 80));
  });
}

function asaasCobrando(valor) {
  return jest.fn(async (method) => {
    if (method === 'GET') return { id: 'sub_1', value: valor, status: 'ACTIVE' };
    return { id: 'sub_1' };
  });
}

const notifications = () => ({ notifyCompany: jest.fn(async () => ({ id: 'n1' })) });

beforeEach(() => {
  db.query.mockReset();
  getSyncAdjustment.mockReset();
  getSyncAdjustment.mockResolvedValue({ discountAmount: 0, updatePendingPayments: true });
});

describe('syncSubscriptionValue: loja adiciona a 2ª empresa no Negócio', () => {
  test('mensal: R$ 169,00 vira R$ 253,50', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY, FILHA] });
    const asaas = asaasCobrando(169);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', companyId: FILHA, deps: { asaas } });
    expect(r).toMatchObject({ synced: true, old_value: 169, new_value: 253.5 });
    expect(asaas).toHaveBeenCalledWith('POST', '/subscriptions/sub_1', { value: 253.5, updatePendingPayments: true });
  });

  test('anual: R$ 140,83 vira R$ 211,25', async () => {
    banco({ cycle: 'annual', grupo: [PRIMARY, FILHA] });
    const asaas = asaasCobrando(140.83);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', companyId: FILHA, deps: { asaas } });
    expect(r).toMatchObject({ synced: true, old_value: 140.83, new_value: 211.25 });
    expect(r.preview).toMatchObject({ base_price: 140.83, extra_unit_price: 70.42, extra_cnpjs: 1, total_monthly: 211.25 });
  });

  test('cupom de vários meses em andamento: o desconto continua abatido', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY, FILHA] });
    getSyncAdjustment.mockResolvedValue({ discountAmount: 50, updatePendingPayments: false });
    const asaas = asaasCobrando(119); // 169 - 50
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', companyId: FILHA, deps: { asaas } });
    expect(r).toMatchObject({ synced: true, new_value: 203.5 });
    expect(asaas).toHaveBeenCalledWith('POST', '/subscriptions/sub_1', { value: 203.5, updatePendingPayments: false });
  });

  test('em teste (sem assinatura): nada a gravar, só o cálculo', async () => {
    banco({ grupo: [PRIMARY, FILHA], subId: null });
    const asaas = asaasCobrando(169);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', deps: { asaas } });
    expect(r).toMatchObject({ synced: false, reason: 'no_subscription', new_value: 253.5 });
    expect(asaas).not.toHaveBeenCalled();
  });
});

describe('syncSubscriptionValue: Davi', () => {
  test('com 2 empresas a assinatura continua o plano (nada a gravar)', async () => {
    banco({ primaryId: DAVI_MATRIZ, grupo: [DAVI_MATRIZ, VILLA_BRANCA] });
    const asaas = asaasCobrando(169);
    const r = await multicnpj.syncSubscriptionValue(DAVI_MATRIZ, { evento: 'add', deps: { asaas } });
    expect(r).toMatchObject({ synced: false, reason: 'no_change' });
    expect(r.preview.included_in_plan).toBe(2);
    expect(asaas).toHaveBeenCalledTimes(1); // só o GET
  });
});

describe('valor combinado não é sobrescrito', () => {
  const luis = {
    custom_subscription_value: '211.20',
    custom_subscription_plan: 'negocio',
    custom_subscription_cycle: 'annual',
    custom_subscription_note: 'Acordo de 2 lojas',
  };

  test('adicionar empresa: não lê nem grava a Asaas, devolve o cálculo e avisa no sino', async () => {
    banco({ cycle: 'annual', grupo: [PRIMARY, FILHA, TERCEIRA], combinado: luis });
    const asaas = asaasCobrando(211.2);
    const notif = notifications();
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, {
      evento: 'add', companyId: TERCEIRA, companyName: 'Loja 3', deps: { asaas, notifications: notif, env: {} },
    });
    expect(r).toMatchObject({ synced: false, reason: 'valor_combinado', combined_value: 211.2, new_value: 281.67 });
    expect(asaas).not.toHaveBeenCalled();
    expect(notif.notifyCompany).toHaveBeenCalledTimes(1);
    const [empresa, payload] = notif.notifyCompany.mock.calls[0];
    expect(empresa).toBe(ALERTA);
    expect(payload.title).toMatch(/valor combinado/);
    expect(payload.body).toMatch(/R\$ 211\.20/);
    expect(payload.body).toMatch(/R\$ 281\.67/);
    expect(payload.dedupeKey).toBe(`multicnpj:valor_combinado:add:${PRIMARY}:${TERCEIRA}`);
  });

  test('combinado de outro ciclo não trava (o checkout também não usa)', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY, FILHA], combinado: luis });
    const asaas = asaasCobrando(169);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', deps: { asaas } });
    expect(r).toMatchObject({ synced: true, new_value: 253.5 });
  });
});

describe('sem retroatividade', () => {
  test('assinatura fora da tabela (ex.: 2 empresas pagando só o plano) não é sobrescrita ao adicionar a 3ª', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY, FILHA, TERCEIRA] });
    const asaas = asaasCobrando(169);
    const notif = notifications();
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, {
      evento: 'add', companyId: TERCEIRA, deps: { asaas, notifications: notif, env: {} },
    });
    expect(r).toMatchObject({ synced: false, reason: 'fora_da_tabela', current_value: 169, expected_before: 253.5, new_value: 338 });
    expect(asaas).toHaveBeenCalledTimes(1);
    expect(asaas.mock.calls[0][0]).toBe('GET');
    expect(notif.notifyCompany).toHaveBeenCalledTimes(1);
    expect(notif.notifyCompany.mock.calls[0][1].title).toMatch(/fora da tabela/);
  });

  test('preço antigo (Negócio 169,90 da regra anterior) também não é sobrescrito', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY, FILHA, TERCEIRA] });
    const asaas = asaasCobrando(254.9); // 169,90 + 85 da regra antiga
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', deps: { asaas, notifications: notifications(), env: {} } });
    expect(r.reason).toBe('fora_da_tabela');
    expect(asaas).toHaveBeenCalledTimes(1);
  });

  test('sem ação da loja o sync não lê nem grava a Asaas', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY, FILHA] });
    const asaas = asaasCobrando(169);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { deps: { asaas } });
    expect(r).toMatchObject({ synced: false, reason: 'sem_acao_da_loja' });
    expect(asaas).not.toHaveBeenCalled();
  });

  test('remover a 2ª empresa volta ao plano quando a assinatura estava na tabela', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY] });
    const asaas = asaasCobrando(253.5);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'remove', companyId: FILHA, deps: { asaas } });
    expect(r).toMatchObject({ synced: true, old_value: 253.5, new_value: 169 });
  });

  test('remover empresa de quem paga só o plano (fora da tabela) não mexe', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY] });
    const asaas = asaasCobrando(140.83); // anual cobrado, cadastro diz mensal: fora da tabela
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'remove', deps: { asaas, notifications: notifications(), env: {} } });
    expect(r.reason).toBe('fora_da_tabela');
    expect(asaas).toHaveBeenCalledTimes(1);
  });

  test('só POST e DELETE /me/companies chamam o recálculo, sempre com a ação da loja', () => {
    const raiz = path.join(__dirname, '../../src');
    const chamadores = [];
    const varrer = (dir) => {
      for (const nome of fs.readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (fs.statSync(p).isDirectory()) { varrer(p); continue; }
        if (!p.endsWith('.js') || p.endsWith(path.join('utils', 'multicnpjBilling.js'))) continue;
        const src = fs.readFileSync(p, 'utf8');
        const chamadas = src.match(/(?:safeS|s)yncSubscriptionValue\([^)]*(?:\{[\s\S]*?\})?\s*\)/g) || [];
        if (chamadas.length) chamadores.push({ arquivo: path.relative(raiz, p).replace(/\\/g, '/'), chamadas });
      }
    };
    varrer(raiz);
    expect(chamadores.map((c) => c.arquivo)).toEqual(['routes/userCompanies.js']);
    const chamadas = chamadores[0].chamadas;
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]).toMatch(/evento: 'add'/);
    expect(chamadas[1]).toMatch(/evento: 'remove'/);
  });
});

describe('Expansão no sync: regra de extra sem mudança', () => {
  test('3ª empresa no mensal: 269 + 135 = 404', async () => {
    banco({ plan: 'expansao', cycle: 'monthly', grupo: [PRIMARY, FILHA, TERCEIRA] });
    const asaas = asaasCobrando(269);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', deps: { asaas } });
    expect(r).toMatchObject({ synced: true, new_value: 404 });
  });

  test('2ª empresa no Expansão continua incluída', async () => {
    banco({ plan: 'expansao', cycle: 'monthly', grupo: [PRIMARY, FILHA] });
    const asaas = asaasCobrando(269);
    const r = await multicnpj.syncSubscriptionValue(PRIMARY, { evento: 'add', deps: { asaas } });
    expect(r).toMatchObject({ synced: false, reason: 'no_change' });
  });
});

// ── Preview (só leitura) ────────────────────────────────────

describe('previewDaAssinatura', () => {
  test('Negócio mensal com 1 empresa: próxima custa R$ 84,50 (total R$ 253,50)', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY] });
    const asaas = asaasCobrando(169);
    const p = await multicnpj.previewDaAssinatura(PRIMARY, { deps: { asaas } });
    expect(p.current).toMatchObject({ total_monthly: 169, table_monthly: 169, fonte: 'asaas', extra_cnpjs: 0 });
    expect(p.if_add_one).toMatchObject({
      total_companies: 2, extra_cnpjs: 1, extra_unit_price: 84.5,
      new_total_monthly: 253.5, delta_monthly: 84.5, ajuste_pela_equipe: false,
    });
    expect(asaas.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });

  test('Negócio anual em teste: próxima custa R$ 70,42 (total R$ 211,25)', async () => {
    banco({ cycle: 'annual', grupo: [PRIMARY], subId: null });
    const asaas = asaasCobrando(0);
    const p = await multicnpj.previewDaAssinatura(PRIMARY, { deps: { asaas } });
    expect(p.current).toMatchObject({ total_monthly: 140.83, fonte: 'tabela' });
    expect(p.if_add_one).toMatchObject({ new_total_monthly: 211.25, delta_monthly: 70.42, ajuste_pela_equipe: false });
    expect(asaas).not.toHaveBeenCalled();
  });

  test('quem já tem 2 empresas e paga só o plano vê o que paga, sem extra', async () => {
    banco({ cycle: 'monthly', grupo: [PRIMARY, FILHA] });
    const p = await multicnpj.previewDaAssinatura(PRIMARY, { deps: { asaas: asaasCobrando(169) } });
    expect(p.current).toMatchObject({ total_monthly: 169, extra_cnpjs: 0, extras_value: 0, table_monthly: 253.5 });
    expect(p.if_add_one.ajuste_pela_equipe).toBe(true);
  });

  test('valor combinado: mostra o combinado e marca ajuste pela equipe', async () => {
    banco({
      cycle: 'annual', grupo: [PRIMARY, FILHA],
      combinado: { custom_subscription_value: '211.20', custom_subscription_plan: 'negocio', custom_subscription_cycle: 'annual' },
    });
    const asaas = asaasCobrando(211.2);
    const p = await multicnpj.previewDaAssinatura(PRIMARY, { deps: { asaas } });
    expect(p.current).toMatchObject({ total_monthly: 211.2, fonte: 'valor_combinado', table_monthly: 211.25 });
    expect(p.if_add_one).toMatchObject({ new_total_monthly: 281.67, ajuste_pela_equipe: true });
    expect(asaas).not.toHaveBeenCalled();
  });
});
