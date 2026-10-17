// ============================================================
// Regra do trial contado da primeira venda (services/trialRegra, migration 379)
//
// As contas de data são função pura (fimPelaPrimeiraVenda / montarTrial). O
// UPDATE da primeira venda é um SQL só, atômico — aqui se confere que ele
// carrega cada guarda da regra e que o gancho nunca lança. A semântica do SQL
// (7 dias, teto, segunda venda, venda vencida) foi conferida num Postgres de
// verdade; a tabela está na descrição do PR.
// ============================================================
jest.unmock('../../src/services/trialRegra');

const db = require('../../src/config/database');
const regra = require('../../src/services/trialRegra');

const DIA = 86400000;
const dia = (iso) => new Date(iso + 'T12:00:00.000Z');
const mais = (d, n) => new Date(d.getTime() + n * DIA);
const sql = (call) => call[0].replace(/\s+/g, ' ');

beforeEach(() => {
  db.query.mockReset();
  regra._resetForTests();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('constantes', () => {
  test('7 dias a partir da primeira venda, teto de 15 dias do cadastro', () => {
    expect(regra.DIAS_APOS_PRIMEIRA_VENDA).toBe(7);
    expect(regra.TETO_DIAS).toBe(15);
    expect(regra.MODO_FIXO).toBe('fixo');
    expect(regra.MODO_PRIMEIRA_VENDA).toBe('primeira_venda');
  });
});

describe('fimPelaPrimeiraVenda', () => {
  const cadastro = dia('2026-10-13'); // teto em 28/10

  test('primeira venda dentro do teto: 7 dias a partir dela', () => {
    // cadastro 13/10, vende 15/10 → 22/10
    expect(regra.fimPelaPrimeiraVenda(cadastro, dia('2026-10-15'))).toEqual(dia('2026-10-22'));
  });

  test('primeira venda no dia do cadastro: 7 dias, como era antes', () => {
    expect(regra.fimPelaPrimeiraVenda(cadastro, cadastro)).toEqual(dia('2026-10-20'));
  });

  test('primeira venda perto do teto: vale o teto (min)', () => {
    // vende 25/10 → 01/11 passaria do teto; fica 28/10
    expect(regra.fimPelaPrimeiraVenda(cadastro, dia('2026-10-25'))).toEqual(dia('2026-10-28'));
  });

  test('exatamente no limite: dia 8 do cadastro ainda dá 7 dias cheios', () => {
    expect(regra.fimPelaPrimeiraVenda(cadastro, dia('2026-10-21'))).toEqual(dia('2026-10-28'));
  });
});

describe('montarTrial (bloco trial do /auth/me)', () => {
  const criada = dia('2026-10-13');

  test('antes da primeira venda: o relógio não anda, o app mostra o teto', () => {
    const t = regra.montarTrial(
      { trial_mode: 'primeira_venda', trial_ends_at: mais(criada, 15), trial_started_by_sale_at: null, created_at: criada },
      dia('2026-10-16')
    );
    expect(t).toEqual({
      mode: 'primeira_venda',
      ends_at: '2026-10-28T12:00:00.000Z',
      started_by_sale_at: null,
      dias_restantes: 12,
      teto_em: '2026-10-28T12:00:00.000Z',
      aguardando_primeira_venda: true,
      dias_apos_primeira_venda: 7,
    });
  });

  test('depois da primeira venda: conta os 7 dias', () => {
    const t = regra.montarTrial(
      { trial_mode: 'primeira_venda', trial_ends_at: dia('2026-10-22'), trial_started_by_sale_at: dia('2026-10-15'), created_at: criada },
      dia('2026-10-16')
    );
    expect(t).toMatchObject({
      mode: 'primeira_venda', ends_at: '2026-10-22T12:00:00.000Z',
      started_by_sale_at: '2026-10-15T12:00:00.000Z', dias_restantes: 6, aguardando_primeira_venda: false,
    });
  });

  test('teto vencido sem venda: zero dias e não está mais "aguardando"', () => {
    const t = regra.montarTrial(
      { trial_mode: 'primeira_venda', trial_ends_at: mais(criada, 15), trial_started_by_sale_at: null, created_at: criada },
      dia('2026-10-30')
    );
    expect(t).toMatchObject({ dias_restantes: 0, aguardando_primeira_venda: false, started_by_sale_at: null });
  });

  test('conta fixa (ou sem as colunas da 379): mode fixo, sem teto', () => {
    const t = regra.montarTrial({ trial_ends_at: dia('2026-10-20'), created_at: criada }, dia('2026-10-16'));
    expect(t).toMatchObject({ mode: 'fixo', dias_restantes: 4, teto_em: null, started_by_sale_at: null, aguardando_primeira_venda: false });
  });

  test('sem trial_ends_at: dias_restantes null; sem empresa: null', () => {
    expect(regra.montarTrial({ trial_mode: 'fixo' })).toMatchObject({ ends_at: null, dias_restantes: null });
    expect(regra.montarTrial(null)).toBeNull();
  });
});

describe('codigoEntraNaPrimeiraVenda (cadastro do site com código)', () => {
  const ok = regra.codigoEntraNaPrimeiraVenda;
  test('COMECAR (trial, 7 dias), em qualquer caixa, entra', () => {
    expect(ok({ codigo: 'COMECAR', tipo: 'trial', trialDays: 7 })).toBe(true);
    expect(ok({ codigo: ' comecar ', tipo: 'trial', trialDays: 7 })).toBe(true);
  });
  test('indicação (referral) entra', () => {
    expect(ok({ codigo: 'REF-ANA1B2C', tipo: 'referral', trialDays: 7 })).toBe(true);
  });
  test('outro código trial, promo, manual e invite seguem fixos', () => {
    expect(ok({ codigo: 'TRIAL-AURA', tipo: 'trial', trialDays: 7 })).toBe(false);
    expect(ok({ codigo: 'COMECAR', tipo: 'promo', trialDays: 7 })).toBe(false);
    expect(ok({ codigo: 'X', tipo: 'manual', trialDays: 7 })).toBe(false);
    expect(ok({ codigo: 'X', tipo: 'invite', trialDays: 7 })).toBe(false);
  });
  test('sem dias de trial ou com mais dias que o teto: fica fixo (não encurta nem inventa trial)', () => {
    expect(ok({ codigo: 'COMECAR', tipo: 'trial', trialDays: 0 })).toBe(false);
    expect(ok({ codigo: 'REF-X', tipo: 'referral', trialDays: 30 })).toBe(false);
    expect(ok({ codigo: 'REF-X', tipo: 'referral', trialDays: 15 })).toBe(true);
    expect(ok()).toBe(false);
  });
});

describe('iniciarTrialPelaPrimeiraVenda (gancho do POST /pdv/sale)', () => {
  test('o UPDATE carrega cada guarda da regra e as duas constantes', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ trial_ends_at: dia('2026-10-22'), trial_started_by_sale_at: dia('2026-10-15') }] });

    const r = await regra.iniciarTrialPelaPrimeiraVenda('c1');

    expect(r).toMatchObject({ iniciou: true, trial_ends_at: dia('2026-10-22') });
    expect(db.query).toHaveBeenCalledTimes(1);
    const s = sql(db.query.mock.calls[0]);
    expect(db.query.mock.calls[0][1]).toEqual(['c1', 7, 15]);
    expect(s).toContain("LEAST(NOW() + $2::int * INTERVAL '1 day', created_at + $3::int * INTERVAL '1 day')"); // min(venda+7, cadastro+15)
    expect(s).toContain('trial_started_by_sale_at = NOW()');
    expect(s).toContain("trial_mode = 'primeira_venda'");        // conta fixa não entra
    expect(s).toContain('trial_started_by_sale_at IS NULL');     // segunda venda não mexe
    expect(s).toContain('trial_ends_at > NOW()');                // venda após o vencimento não reinicia
    expect(s).toContain('asaas_subscription_id IS NULL');        // quem assinou não tem trial a iniciar
    expect(s).toContain("billing_status IS DISTINCT FROM 'active'");
  });

  test('segunda venda no mesmo processo nem vai ao banco', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ trial_ends_at: dia('2026-10-22') }] });
    await regra.iniciarTrialPelaPrimeiraVenda('c1');
    const r = await regra.iniciarTrialPelaPrimeiraVenda('c1');
    expect(r).toEqual({ iniciou: false });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('UPDATE não casou (fixa, já iniciada ou vencida): não iniciou e não insiste', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await regra.iniciarTrialPelaPrimeiraVenda('c2')).toEqual({ iniciou: false });
    await regra.iniciarTrialPelaPrimeiraVenda('c2');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('banco falhou: não lança e a próxima venda tenta de novo', async () => {
    db.query.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(regra.iniciarTrialPelaPrimeiraVenda('c3')).resolves.toEqual({ iniciou: false, erro: true });

    db.query.mockResolvedValueOnce({ rows: [{ trial_ends_at: dia('2026-10-22') }] });
    expect((await regra.iniciarTrialPelaPrimeiraVenda('c3')).iniciou).toBe(true);
  });

  test('migration 379 pendente (42703): não lança, pausa 10 min e volta a tentar sozinho', async () => {
    const t0 = 1_000_000;
    db.query.mockRejectedValueOnce(Object.assign(new Error('column "trial_mode" does not exist'), { code: '42703' }));
    expect(await regra.iniciarTrialPelaPrimeiraVenda('c4', { agora: t0 })).toEqual({ iniciou: false, erro: true });

    await regra.iniciarTrialPelaPrimeiraVenda('c5', { agora: t0 + 60_000 }); // dentro da pausa: nem consulta
    expect(db.query).toHaveBeenCalledTimes(1);

    db.query.mockResolvedValueOnce({ rows: [{ trial_ends_at: dia('2026-10-22') }] });
    expect((await regra.iniciarTrialPelaPrimeiraVenda('c4', { agora: t0 + 11 * 60_000 })).iniciou).toBe(true);
  });

  test('sem empresa: nada', async () => {
    expect(await regra.iniciarTrialPelaPrimeiraVenda(null)).toEqual({ iniciou: false });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('marcarTrialFixo', () => {
  test('grava trial_mode fixo só na empresa pedida', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    expect(await regra.marcarTrialFixo('c1')).toBe(true);
    expect(sql(db.query.mock.calls[0])).toBe("UPDATE companies SET trial_mode = 'fixo' WHERE id = $1 AND trial_mode <> 'fixo'");
    expect(db.query.mock.calls[0][1]).toEqual(['c1']);
  });

  test('nunca lança: coluna ausente ou banco fora', async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error('no column'), { code: '42703' }));
    await expect(regra.marcarTrialFixo('c1')).resolves.toBe(false);
    db.query.mockRejectedValueOnce(new Error('boom'));
    await expect(regra.marcarTrialFixo('c1')).resolves.toBe(false);
  });
});

describe('ligarPrimeiraVendaNoCadastro', () => {
  test('atrás de um SAVEPOINT: liga o modo e troca os 7 dias pelo teto', async () => {
    const linha = { trial_mode: 'primeira_venda', trial_ends_at: dia('2026-10-28'), trial_started_by_sale_at: null, created_at: dia('2026-10-13') };
    const client = { query: jest.fn(async (q) => (/UPDATE companies/.test(q) ? { rows: [linha] } : { rows: [] })) };

    expect(await regra.ligarPrimeiraVendaNoCadastro(client, 'c1')).toBe(linha);

    const feitas = client.query.mock.calls.map((c) => c[0].replace(/\s+/g, ' ').trim());
    expect(feitas[0]).toBe('SAVEPOINT trial_primeira_venda');
    expect(feitas[1]).toContain("SET trial_mode = 'primeira_venda', trial_ends_at = created_at + $2::int * INTERVAL '1 day'");
    expect(client.query.mock.calls[1][1]).toEqual(['c1', 15]);
    expect(feitas[2]).toBe('RELEASE SAVEPOINT trial_primeira_venda');
  });

  test('migration pendente: volta ao SAVEPOINT (a transação do cadastro segue) e devolve null', async () => {
    const client = {
      query: jest.fn(async (q) => {
        if (/UPDATE companies/.test(q)) throw Object.assign(new Error('no column'), { code: '42703' });
        return { rows: [] };
      }),
    };
    expect(await regra.ligarPrimeiraVendaNoCadastro(client, 'c1')).toBeNull();
    expect(client.query.mock.calls.map((c) => c[0])).toEqual([
      'SAVEPOINT trial_primeira_venda',
      regra.SQL_LIGAR_NO_CADASTRO,
      'ROLLBACK TO SAVEPOINT trial_primeira_venda',
    ]);
  });
});
