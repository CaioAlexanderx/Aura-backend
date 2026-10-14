// ============================================================
// services/bannerIndicacaoTrial + jobs/bannerIndicacaoTrialJob
// (banner "Indique um lojista" para empresas em teste, 14/10/2026).
//
// O que estes testes travam:
//   1. A regra: o caso verdadeiro e cada um dos 7 critérios falhando
//      sozinho (e as exclusões de conta interna, teste, canário, filial).
//   2. O banner: texto, rota, validade de 7 dias, dedupe_key e INATIVO por
//      padrão; só PUBLICAR=true cria ativo.
//   3. Desligado não consulta nada; DRY_RUN não escreve; a chave que já
//      existe não vira segundo banner.
//   4. Quem assinou tem o banner de indicação desativado.
//   5. Horário: antes das 06h30 BRT não roda; depois roda uma vez por dia.
// ============================================================
'use strict';

const svc = require('../../src/services/bannerIndicacaoTrial');
const job = require('../../src/jobs/bannerIndicacaoTrialJob');

const { avaliarEmpresa, tickBannerIndicacaoTrial, montarBanner, dedupeKeyDe } = svc;

// 06h30 de 14/10/2026 em Brasília = 09h30 UTC.
const AGORA = new Date('2026-10-14T12:00:00.000Z');
const DIA = 24 * 3600 * 1000;
const CID = '11111111-2222-3333-4444-555555555555';
const CID2 = '66666666-7777-8888-9999-000000000000';
const CANARIO = 'b0463109-e68e-4d55-a2d4-40c8a758ae0b';

const fatos = (extra = {}) => ({
  company_id: CID,
  shell: 'negocio',
  company_email: 'loja@gmail.com',
  owner_email: 'dona@gmail.com',
  email_verificado: true,
  is_sandbox: false,
  paga_por_outra: false,
  trial_ends_at: new Date(AGORA.getTime() + 8 * DIA).toISOString(),
  billing_status: 'trial',
  tem_assinatura: false,
  tem_venda: true,
  conversa_recente: false,
  avisou_checkout: false,
  ja_tem_banner: false,
  ...extra,
});

const avalia = (extra, opts) => avaliarEmpresa(fatos(extra), { agora: AGORA, ...opts });

// ── 1. a regra ──────────────────────────────────────────────
describe('avaliarEmpresa', () => {
  it('empresa que cumpre tudo é elegível', () => {
    expect(avalia()).toEqual({ elegivel: true, motivo: null });
  });

  it('shell ausente (NULL no banco já vira negocio na consulta) segue elegível', () => {
    expect(avalia({ shell: undefined }).elegivel).toBe(true);
  });

  it.each([
    ['karate_dojo'], ['karate_federation'], ['odonto'], ['food'], ['studio'],
  ])('fora do shell Negócio (%s) não recebe', (shell) => {
    expect(avalia({ shell })).toEqual({ elegivel: false, motivo: 'fora_do_shell_negocio' });
  });

  it('conta interna @getaura.com.br (empresa ou dono) não recebe', () => {
    expect(avalia({ company_email: 'time@getaura.com.br' }).motivo).toBe('conta_interna');
    expect(avalia({ owner_email: 'Caio@GetAura.com.br' }).motivo).toBe('conta_interna');
  });

  it('conta de teste (is_sandbox) e o canário não recebem', () => {
    expect(avalia({ is_sandbox: true }).motivo).toBe('conta_de_teste');
    expect(avalia({ company_id: CANARIO.toUpperCase() }, { canaryId: CANARIO }).motivo).toBe('canario');
    // sem CANARY_COMPANY_ID configurado, o id comum passa
    expect(avalia({ company_id: CANARIO }, { canaryId: null }).elegivel).toBe(true);
  });

  it('filial paga por outra empresa não recebe', () => {
    expect(avalia({ paga_por_outra: true }).motivo).toBe('paga_por_outra');
  });

  describe('2. em teste, com mais de 3 dias, sem assinatura', () => {
    it('3 dias exatos NÃO bastam; 3 dias e 1 minuto bastam', () => {
      const exato = new Date(AGORA.getTime() + 3 * DIA).toISOString();
      const um = new Date(AGORA.getTime() + 3 * DIA + 60000).toISOString();
      expect(avalia({ trial_ends_at: exato }).motivo).toBe('teste_perto_do_fim_ou_vencido');
      expect(avalia({ trial_ends_at: um }).elegivel).toBe(true);
    });

    it('teste vencido ou sem data não recebe', () => {
      const ontem = new Date(AGORA.getTime() - DIA).toISOString();
      expect(avalia({ trial_ends_at: ontem }).motivo).toBe('teste_perto_do_fim_ou_vencido');
      expect(avalia({ trial_ends_at: null }).motivo).toBe('sem_fim_de_teste');
    });

    it('com assinatura no Asaas ou billing_status active não recebe', () => {
      expect(avalia({ tem_assinatura: true }).motivo).toBe('com_assinatura');
      expect(avalia({ billing_status: 'active' }).motivo).toBe('com_assinatura');
    });
  });

  it('3. sem nenhuma venda válida não recebe', () => {
    expect(avalia({ tem_venda: false }).motivo).toBe('sem_venda');
  });

  it('4. conversa registrada nos últimos 3 dias não recebe', () => {
    expect(avalia({ conversa_recente: true }).motivo).toBe('conversa_recente');
  });

  it('5. quem já recebeu aviso de fim de teste não recebe', () => {
    expect(avalia({ avisou_checkout: true }).motivo).toBe('aviso_de_fim_de_teste');
  });

  it('6. dono sem e-mail verificado não recebe', () => {
    expect(avalia({ email_verificado: false }).motivo).toBe('email_nao_verificado');
    expect(avalia({ email_verificado: null }).motivo).toBe('email_nao_verificado');
  });

  it('7. quem já teve banner de indicação não recebe', () => {
    expect(avalia({ ja_tem_banner: true }).motivo).toBe('ja_tem_banner');
  });
});

// ── 2. o banner ─────────────────────────────────────────────
describe('montarBanner', () => {
  it('texto, rota, alvo, validade de 7 dias e chave de dedupe', () => {
    const b = montarBanner(CID, { agora: AGORA });
    expect(b).toMatchObject({
      type: 'banner',
      title: 'Indique um lojista e ganhe seu mês grátis',
      ctaLabel: 'Gerar meu código',
      ctaRoute: '/configuracoes',
      targetCompanyId: CID,
      dedupeKey: 'indicacao-trial:' + CID,
    });
    expect(b.body).toBe(
      'Gere seu código em Configurações. Quando o lojista que você indicar pagar a primeira mensalidade, '
      + 'seu mês grátis fica reservado por 60 dias a partir desse pagamento: assine a Aura nesse prazo e a '
      + 'sua segunda mensalidade sai por nossa conta.'
    );
    expect(new Date(b.expiresAt).getTime() - AGORA.getTime()).toBe(7 * DIA);
  });

  it('nasce inativo por padrão e ativo só com publicar=true', () => {
    expect(montarBanner(CID, { agora: AGORA }).isActive).toBe(false);
    expect(montarBanner(CID, { agora: AGORA, publicar: false }).isActive).toBe(false);
    expect(montarBanner(CID, { agora: AGORA, publicar: true }).isActive).toBe(true);
  });
});

// ── banco simulado ──────────────────────────────────────────
function makeDb({ empresas = [fatos()], assinaram = [] } = {}) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ s, params });
    if (s.startsWith('SELECT c.id AS company_id')) return { rows: empresas };
    if (s.startsWith('UPDATE app_notifications SET is_active = false')) {
      return { rows: assinaram.map((a) => ({ id: a.id, target_company_id: a.company_id })) };
    }
    if (s.startsWith('SELECT n.id, n.target_company_id')) {
      return { rows: assinaram.map((a) => ({ id: a.id, target_company_id: a.company_id })) };
    }
    return { rows: [] };
  });
  return { query, calls };
}

function makeNotifications(impl) {
  const criados = [];
  return {
    criados,
    createAppNotification: jest.fn(async (p) => {
      criados.push(p);
      return impl ? impl(p) : { id: 'banner-' + criados.length, ...p };
    }),
  };
}

const ENV_LIGADO = { BANNER_INDICACAO_TRIAL_ENABLED: 'true' };
const escritas = (db) => db.calls.filter((c) => /^(UPDATE|INSERT|DELETE)/.test(c.s));

describe('tickBannerIndicacaoTrial', () => {
  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  it('desligado (padrão) não consulta nem escreve nada', async () => {
    const db = makeDb();
    const notifications = makeNotifications();
    const r = await tickBannerIndicacaoTrial({ db, notifications, now: AGORA.getTime(), env: {} });
    expect(r.ligado).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
  });

  it('ENABLED diferente de "true" também não liga', async () => {
    const db = makeDb();
    const notifications = makeNotifications();
    await tickBannerIndicacaoTrial({
      db, notifications, now: AGORA.getTime(), env: { BANNER_INDICACAO_TRIAL_ENABLED: '1' },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('ligado: cria o banner INATIVO só para quem passa na regra', async () => {
    const db = makeDb({
      empresas: [
        fatos({ company_id: CID }),
        fatos({ company_id: CID2, tem_venda: false }),
        fatos({ company_id: 'c3', conversa_recente: true }),
      ],
    });
    const notifications = makeNotifications();
    const r = await tickBannerIndicacaoTrial({ db, notifications, now: AGORA.getTime(), env: ENV_LIGADO });

    expect(notifications.criados).toHaveLength(1);
    expect(notifications.criados[0]).toMatchObject({
      targetCompanyId: CID, dedupeKey: dedupeKeyDe(CID), isActive: false, ctaRoute: '/configuracoes',
    });
    expect(r).toMatchObject({ avaliadas: 3, candidatas: 1, criadas: 1, jaExistiam: 0, falhas: 0 });
  });

  it('PUBLICAR=true cria o banner ativo', async () => {
    const db = makeDb();
    const notifications = makeNotifications();
    await tickBannerIndicacaoTrial({
      db, notifications, now: AGORA.getTime(),
      env: { ...ENV_LIGADO, BANNER_INDICACAO_TRIAL_PUBLICAR: 'true' },
    });
    expect(notifications.criados[0].isActive).toBe(true);
  });

  it('o canário (CANARY_COMPANY_ID) fica de fora', async () => {
    const db = makeDb({ empresas: [fatos({ company_id: CANARIO })] });
    const notifications = makeNotifications();
    const r = await tickBannerIndicacaoTrial({
      db, notifications, now: AGORA.getTime(), env: { ...ENV_LIGADO, CANARY_COMPANY_ID: CANARIO },
    });
    expect(r.candidatas).toBe(0);
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
  });

  it('dedupe: chave que já existe (createAppNotification devolve null) conta como já existente', async () => {
    const db = makeDb();
    const notifications = makeNotifications(() => null);
    const r = await tickBannerIndicacaoTrial({ db, notifications, now: AGORA.getTime(), env: ENV_LIGADO });
    expect(r).toMatchObject({ candidatas: 1, criadas: 0, jaExistiam: 1 });
  });

  it('empresa com banner anterior (ja_tem_banner) nem chega a tentar criar', async () => {
    const db = makeDb({ empresas: [fatos({ ja_tem_banner: true })] });
    const notifications = makeNotifications();
    await tickBannerIndicacaoTrial({ db, notifications, now: AGORA.getTime(), env: ENV_LIGADO });
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
  });

  it('DRY_RUN só loga: nenhuma escrita e nenhum banner criado', async () => {
    const db = makeDb({ assinaram: [{ id: 'b-velho', company_id: CID2 }] });
    const notifications = makeNotifications();
    const r = await tickBannerIndicacaoTrial({
      db, notifications, now: AGORA.getTime(),
      env: { ...ENV_LIGADO, BANNER_INDICACAO_TRIAL_DRY_RUN: 'true' },
    });
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
    expect(escritas(db)).toHaveLength(0);
    expect(r).toMatchObject({ dryRun: true, candidatas: 1, criadas: 0, desativadas: 1 });
    const linhas = log.mock.calls.map((c) => c[0]).join('\n');
    expect(linhas).toContain('dry-run: criaria banner para company=' + CID);
    expect(linhas).toContain('desativaria');
  });

  it('desativa o banner de indicação de quem passou a ter assinatura ativa', async () => {
    const db = makeDb({ empresas: [], assinaram: [{ id: 'b1', company_id: CID }] });
    const notifications = makeNotifications();
    const r = await tickBannerIndicacaoTrial({ db, notifications, now: AGORA.getTime(), env: ENV_LIGADO });

    const upd = db.calls.find((c) => c.s.startsWith('UPDATE app_notifications SET is_active = false'));
    expect(upd).toBeTruthy();
    expect(upd.s).toContain("c.billing_status = 'active'");
    expect(upd.s).toContain('n.dedupe_key LIKE $1');
    expect(upd.s).toContain('n.is_active = true');
    expect(upd.params).toEqual(['indicacao-trial:%']);
    expect(r.desativadas).toBe(1);
  });

  it('falha ao criar o banner de uma empresa não derruba as outras', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({ empresas: [fatos({ company_id: CID }), fatos({ company_id: CID2 })] });
    const notifications = makeNotifications((p) => {
      if (p.targetCompanyId === CID) throw new Error('boom');
      return { id: 'ok', ...p };
    });
    const r = await tickBannerIndicacaoTrial({ db, notifications, now: AGORA.getTime(), env: ENV_LIGADO });
    expect(r).toMatchObject({ candidatas: 2, criadas: 1, falhas: 1 });
    err.mockRestore();
  });
});

describe('buscarFatos (consulta)', () => {
  it('lê só teste futuro sem assinatura e junta os sinais da regra', async () => {
    const db = makeDb({ empresas: [] });
    await svc.buscarFatos(db, AGORA);
    const { s, params } = db.calls[0];
    expect(s).toContain('c.trial_ends_at > $1::timestamptz');
    expect(s).toContain('c.asaas_subscription_id IS NULL');
    expect(s).toContain("COALESCE(c.vertical_active, c.vertical, 'negocio') AS shell");
    expect(s).toContain('FROM sales s');
    expect(s).toContain('company_admin_notes n');
    expect(s).toContain('n.canal IS NOT NULL');
    expect(s).toContain("a.action = 'notify_checkout'");
    expect(s).toContain('b.dedupe_key = $3::text || c.id::text');
    expect(params).toEqual([AGORA.toISOString(), 3, 'indicacao-trial:']);
  });
});

// ── 5. horário ──────────────────────────────────────────────
describe('jobs/bannerIndicacaoTrialJob', () => {
  const brt = (iso, hh, mm = 0) => Date.parse(iso + 'T00:00:00Z') + ((hh + 3) * 60 + mm) * 60000;

  describe('passouDoHorario / devePassarAgora', () => {
    it('06h29 BRT ainda não; 06h30 em diante sim', () => {
      expect(job.passouDoHorario(brt('2026-10-14', 6, 29))).toBe(false);
      expect(job.passouDoHorario(brt('2026-10-14', 6, 30))).toBe(true);
      expect(job.passouDoHorario(brt('2026-10-14', 7, 0))).toBe(true);
      expect(job.passouDoHorario(brt('2026-10-14', 0, 5))).toBe(false);
    });

    it('só roda de novo quando o dia muda', () => {
      const t = brt('2026-10-14', 6, 40);
      expect(job.devePassarAgora(t, null)).toBe(true);
      expect(job.devePassarAgora(t, '2026-10-14')).toBe(false);
      expect(job.devePassarAgora(brt('2026-10-15', 6, 35), '2026-10-14')).toBe(true);
    });

    it('usa o dia de Brasília (23h BRT ainda é o mesmo dia)', () => {
      expect(job.agoraBrt(brt('2026-10-14', 23, 30)).dia).toBe('2026-10-14');
      expect(job.agoraBrt(brt('2026-10-15', 0, 10)).dia).toBe('2026-10-15');
    });
  });

  describe('runOnce', () => {
    const db = require('../../src/config/database');
    const notificationsReal = require('../../src/services/appNotifications');
    let logSpy;
    let errSpy;

    beforeEach(() => {
      job._resetForTests();
      db.query.mockReset();
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.BANNER_INDICACAO_TRIAL_ENABLED = 'true';
      delete process.env.BANNER_INDICACAO_TRIAL_DRY_RUN;
      delete process.env.BANNER_INDICACAO_TRIAL_PUBLICAR;
      db.query.mockImplementation(async (sql) => {
        const s = sql.replace(/\s+/g, ' ');
        if (s.includes('FROM companies c LEFT JOIN users')) return { rows: [] };
        return { rows: [] };
      });
    });
    afterEach(() => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      delete process.env.BANNER_INDICACAO_TRIAL_ENABLED;
    });

    it('antes das 06h30 não consulta o banco', async () => {
      const r = await job.runOnce(brt('2026-10-14', 6, 29));
      expect(r).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('depois das 06h30 roda uma vez no dia e não repete', async () => {
      const r1 = await job.runOnce(brt('2026-10-14', 6, 31));
      expect(r1).toMatchObject({ ligado: true });
      const chamadas = db.query.mock.calls.length;
      expect(chamadas).toBeGreaterThan(0);

      const r2 = await job.runOnce(brt('2026-10-14', 6, 36));
      expect(r2).toBeNull();
      expect(db.query.mock.calls.length).toBe(chamadas);

      // no dia seguinte, roda de novo
      const r3 = await job.runOnce(brt('2026-10-15', 6, 31));
      expect(r3).toMatchObject({ ligado: true });
    });

    it('desligado não roda nem marca o dia', async () => {
      delete process.env.BANNER_INDICACAO_TRIAL_ENABLED;
      expect(await job.runOnce(brt('2026-10-14', 8))).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
      // ligado depois, no mesmo dia, ainda roda
      process.env.BANNER_INDICACAO_TRIAL_ENABLED = 'true';
      expect(await job.runOnce(brt('2026-10-14', 9))).toMatchObject({ ligado: true });
    });

    it('banco fora do ar não marca o dia: a volta seguinte tenta de novo', async () => {
      db.query.mockRejectedValueOnce(new Error('connection terminated'));
      expect(await job.runOnce(brt('2026-10-14', 7, 0))).toBeNull();
      expect(errSpy).toHaveBeenCalled();
      expect(await job.runOnce(brt('2026-10-14', 7, 5))).toMatchObject({ ligado: true });
    });

    it('com empresa elegível, grava o banner inativo pelo appNotifications', async () => {
      db.query.mockImplementation(async (sql) => {
        const s = sql.replace(/\s+/g, ' ');
        if (s.includes('FROM companies c LEFT JOIN users')) {
          return {
            rows: [fatos({
              trial_ends_at: new Date(brt('2026-10-14', 7) + 10 * DIA).toISOString(),
            })],
          };
        }
        if (s.startsWith('INSERT INTO app_notifications')) return { rows: [{ id: 'novo' }] };
        return { rows: [] };
      });
      const r = await job.runOnce(brt('2026-10-14', 7, 0));
      expect(r).toMatchObject({ candidatas: 1, criadas: 1 });
      const ins = db.query.mock.calls.find((c) => /INSERT INTO app_notifications/.test(c[0]));
      expect(ins).toBeTruthy();
      // [..., target_company_id, target_plan, target_vertical, expires_at, is_active, dedupe_key]
      const p = ins[1];
      expect(p[0]).toBe('banner');
      expect(p[7]).toBe(CID);
      expect(p[11]).toBe(false);
      expect(p[12]).toBe('indicacao-trial:' + CID);
      expect(notificationsReal.createAppNotification).toBeDefined();
    });
  });

  it('o stop* do job entra no encerramento gracioso', () => {
    const { stopsDosJobsCarregados } = require('../../src/utils/encerrar');
    expect(stopsDosJobsCarregados().map((f) => f.name)).toContain('stopBannerIndicacaoTrialJob');
  });
});
