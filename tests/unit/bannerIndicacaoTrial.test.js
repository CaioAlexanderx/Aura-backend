// ============================================================
// services/bannerIndicacaoTrial + jobs/bannerIndicacaoTrialJob
// (banner "Indique um lojista" para empresas em teste, 14/10/2026).
//
// Regra (decisão do Caio, 14/10, ajustada em 24/10 no item 15): todo trial
// vigente de varejo recebe, inclusive teste perto do fim, mas só depois de
// pelo menos 1 venda NÃO cancelada.
//
// O que estes testes travam:
//   1. A regra: o caso verdadeiro, cada critério que ficou falhando sozinho
//      e os critérios removidos (venda, dias restantes, conversa, aviso de
//      fim de teste) que NÃO barram mais.
//   2. O banner: texto, rota, validade de 7 dias, dedupe_key e ATIVO por
//      padrão; PUBLICAR=false cria inativo.
//   3. Kill switch (ENABLED=false não consulta nada); DRY_RUN não escreve;
//      a chave que já existe (inclusive banner criado à mão) não vira
//      segundo banner.
//   4. Quem assinou tem o banner de indicação desativado.
//   5. Horário: antes das 06h30 BRT não roda; depois roda uma vez por dia.
// ============================================================
'use strict';

const svc = require('../../src/services/bannerIndicacaoTrial');
const job = require('../../src/jobs/bannerIndicacaoTrialJob');

const { avaliarEmpresa, tickBannerIndicacaoTrial, montarBanner, dedupeKeyDe, lerConfig } = svc;

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
  tem_venda: true,
  is_sandbox: false,
  paga_por_outra: false,
  trial_ends_at: new Date(AGORA.getTime() + 8 * DIA).toISOString(),
  billing_status: 'trial',
  tem_assinatura: false,
  ja_tem_banner: false,
  ...extra,
});

const avalia = (extra, opts) => avaliarEmpresa(fatos(extra), { agora: AGORA, ...opts });

// ── 1. a regra ──────────────────────────────────────────────
describe('avaliarEmpresa', () => {
  it('empresa em teste, de varejo, sem assinatura e com e-mail verificado é elegível', () => {
    expect(avalia()).toEqual({ elegivel: true, motivo: null });
  });

  it('shell ausente (NULL no banco já vira negocio na consulta) segue elegível', () => {
    expect(avalia({ shell: undefined }).elegivel).toBe(true);
  });

  describe('venda (item 15, 24/10/2026)', () => {
    it('cadastro novo, sem nenhuma venda (ou só com venda cancelada), não recebe', () => {
      // "só cancelada" chega aqui como tem_venda=false: a consulta já exclui as canceladas.
      expect(avalia({ tem_venda: false })).toEqual({ elegivel: false, motivo: 'sem_venda' });
      expect(avalia({ tem_venda: undefined }).motivo).toBe('sem_venda');
      expect(avalia({ tem_venda: null }).motivo).toBe('sem_venda');
    });

    it('com pelo menos 1 venda válida recebe', () => {
      expect(avalia({ tem_venda: true }).elegivel).toBe(true);
    });
  });

  describe('critérios removidos não barram mais', () => {
    it('teste com menos de 3 dias restantes entra, desde que vigente', () => {
      const amanha = new Date(AGORA.getTime() + DIA).toISOString();
      const umMinuto = new Date(AGORA.getTime() + 60000).toISOString();
      expect(avalia({ trial_ends_at: amanha }).elegivel).toBe(true);
      expect(avalia({ trial_ends_at: umMinuto }).elegivel).toBe(true);
    });

    it('conversa recente e aviso de fim de teste não barram', () => {
      expect(avalia({ conversa_recente: true }).elegivel).toBe(true);
      expect(avalia({ avisou_checkout: true }).elegivel).toBe(true);
    });
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
    expect(avalia({ company_id: CANARIO }, { canaryId: null }).elegivel).toBe(true);
  });

  it('filial paga por outra empresa não recebe', () => {
    expect(avalia({ paga_por_outra: true }).motivo).toBe('paga_por_outra');
  });

  describe('em teste e sem assinatura', () => {
    it('teste vencido (inclusive no instante exato) ou sem data não recebe', () => {
      const ontem = new Date(AGORA.getTime() - DIA).toISOString();
      expect(avalia({ trial_ends_at: ontem }).motivo).toBe('teste_vencido');
      expect(avalia({ trial_ends_at: AGORA.toISOString() }).motivo).toBe('teste_vencido');
      expect(avalia({ trial_ends_at: null }).motivo).toBe('sem_fim_de_teste');
    });

    it('com assinatura no Asaas ou billing_status active não recebe', () => {
      expect(avalia({ tem_assinatura: true }).motivo).toBe('com_assinatura');
      expect(avalia({ billing_status: 'active' }).motivo).toBe('com_assinatura');
    });
  });

  it('dono sem e-mail verificado não recebe', () => {
    expect(avalia({ email_verificado: false }).motivo).toBe('email_nao_verificado');
    expect(avalia({ email_verificado: null }).motivo).toBe('email_nao_verificado');
  });

  it('quem já tem banner de indicação (inclusive criado à mão) não recebe', () => {
    expect(avalia({ ja_tem_banner: true }).motivo).toBe('ja_tem_banner');
  });
});

// ── chaves de ambiente ──────────────────────────────────────
describe('lerConfig', () => {
  it('sem nenhuma chave: ligado e publicando, sem dry-run', () => {
    expect(lerConfig({})).toMatchObject({ enabled: true, publicar: true, dryRun: false });
  });

  it('só "false" desliga ENABLED e PUBLICAR; só "true" liga DRY_RUN', () => {
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_ENABLED: 'false' }).enabled).toBe(false);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_ENABLED: ' FALSE ' }).enabled).toBe(false);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_ENABLED: '0' }).enabled).toBe(true);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_PUBLICAR: 'false' }).publicar).toBe(false);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_PUBLICAR: 'true' }).publicar).toBe(true);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_DRY_RUN: 'true' }).dryRun).toBe(true);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_DRY_RUN: '1' }).dryRun).toBe(false);
  });
});

// ── 2. o banner ─────────────────────────────────────────────
describe('montarBanner', () => {
  it('texto, rota, alvo, validade de 7 dias e chave de dedupe', () => {
    const b = montarBanner(CID, { agora: AGORA });
    expect(b).toMatchObject({
      type: 'banner',
      title: 'Conhece outro lojista que ia gostar da Aura?',
      ctaLabel: 'Gerar meu código',
      ctaRoute: '/configuracoes?foco=indicacao',
      targetCompanyId: CID,
      dedupeKey: 'indicacao-trial:' + CID,
    });
    expect(b.body).toBe('Indique e ganhe um mês grátis quando ele assinar.');
    expect(new Date(b.expiresAt).getTime() - AGORA.getTime()).toBe(7 * DIA);
  });

  it('nasce ativo por padrão e inativo só com publicar=false', () => {
    expect(montarBanner(CID, { agora: AGORA }).isActive).toBe(true);
    expect(montarBanner(CID, { agora: AGORA, publicar: true }).isActive).toBe(true);
    expect(montarBanner(CID, { agora: AGORA, publicar: false }).isActive).toBe(false);
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

const escritas = (db) => db.calls.filter((c) => /^(UPDATE|INSERT|DELETE)/.test(c.s));
const rodar = (db, notifications, env = {}) => tickBannerIndicacaoTrial({
  db, notifications, now: AGORA.getTime(), env,
});

describe('tickBannerIndicacaoTrial', () => {
  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  it('kill switch: ENABLED=false não consulta nem escreve nada', async () => {
    const db = makeDb();
    const notifications = makeNotifications();
    const r = await rodar(db, notifications, { BANNER_INDICACAO_TRIAL_ENABLED: 'false' });
    expect(r.ligado).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
  });

  it('sem nenhuma chave de ambiente o job roda e cria o banner ATIVO', async () => {
    const db = makeDb({ empresas: [fatos({ company_id: CID }), fatos({ company_id: CID2 })] });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications, {});

    expect(notifications.criados).toHaveLength(2);
    expect(notifications.criados[0]).toMatchObject({
      targetCompanyId: CID, dedupeKey: dedupeKeyDe(CID), isActive: true, ctaRoute: '/configuracoes?foco=indicacao',
    });
    expect(r).toMatchObject({ ligado: true, publicar: true, candidatas: 2, criadas: 2, falhas: 0 });
  });

  it('PUBLICAR=false cria o banner inativo', async () => {
    const db = makeDb();
    const notifications = makeNotifications();
    await rodar(db, notifications, { BANNER_INDICACAO_TRIAL_PUBLICAR: 'false' });
    expect(notifications.criados[0].isActive).toBe(false);
  });

  it('só cria para quem passa na regra (com venda entra; sem e-mail verificado, sem venda ou de outro shell não)', async () => {
    const db = makeDb({
      empresas: [
        fatos({ company_id: CID }),
        fatos({ company_id: CID2, email_verificado: false }),
        fatos({ company_id: 'c4', tem_venda: false }),
        fatos({ company_id: 'c3', shell: 'food' }),
      ],
    });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications);
    expect(notifications.criados.map((p) => p.targetCompanyId)).toEqual([CID]);
    expect(r).toMatchObject({ avaliadas: 4, candidatas: 1, criadas: 1 });
  });

  it('o canário (CANARY_COMPANY_ID) fica de fora', async () => {
    const db = makeDb({ empresas: [fatos({ company_id: CANARIO })] });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications, { CANARY_COMPANY_ID: CANARIO });
    expect(r.candidatas).toBe(0);
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
  });

  it('banner criado à mão com a mesma chave: ja_tem_banner, o job não tenta criar outro', async () => {
    const db = makeDb({ empresas: [fatos({ ja_tem_banner: true })] });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications);
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
    expect(r).toMatchObject({ candidatas: 0, criadas: 0 });
  });

  it('corrida: a chave aparece entre a consulta e o insert (createAppNotification devolve null)', async () => {
    const db = makeDb();
    const notifications = makeNotifications(() => null);
    const r = await rodar(db, notifications);
    expect(r).toMatchObject({ candidatas: 1, criadas: 0, jaExistiam: 1 });
  });

  it('DRY_RUN só loga: nenhuma escrita e nenhum banner criado', async () => {
    const db = makeDb({ assinaram: [{ id: 'b-velho', company_id: CID2 }] });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications, { BANNER_INDICACAO_TRIAL_DRY_RUN: 'true' });
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
    expect(escritas(db)).toHaveLength(0);
    expect(r).toMatchObject({ dryRun: true, candidatas: 1, criadas: 0, desativadas: 1 });
    const linhas = log.mock.calls.map((c) => c[0]).join('\n');
    expect(linhas).toContain('dry-run: criaria banner para company=' + CID);
    expect(linhas).toContain('desativaria');
  });

  it('empresa que passou a ter assinatura ativa tem o banner de indicação desativado', async () => {
    const db = makeDb({ empresas: [], assinaram: [{ id: 'b1', company_id: CID }] });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications);

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
    const r = await rodar(db, notifications);
    expect(r).toMatchObject({ candidatas: 2, criadas: 1, falhas: 1 });
    err.mockRestore();
  });
});

describe('buscarFatos (consulta)', () => {
  it('lê teste vigente sem assinatura e se há venda NÃO cancelada; sem filtro de conversa ou aviso', async () => {
    const db = makeDb({ empresas: [] });
    await svc.buscarFatos(db, AGORA);
    const { s, params } = db.calls[0];
    expect(s).toContain('c.trial_ends_at > $1::timestamptz');
    expect(s).toContain('c.asaas_subscription_id IS NULL');
    expect(s).toContain("COALESCE(c.vertical_active, c.vertical, 'negocio') AS shell");
    expect(s).toContain('c.billing_owner_company_id <> c.id');
    expect(s).toContain('b.dedupe_key = $2::text || c.id::text');
    expect(s).toContain('FROM sales s WHERE s.company_id = c.id');
    expect(s).toContain("COALESCE(s.status, 'completed') <> 'cancelled'");
    expect(s).toContain(') AS tem_venda');
    expect(s).not.toContain('company_admin_notes');
    expect(s).not.toContain('notify_checkout');
    expect(params).toEqual([AGORA.toISOString(), 'indicacao-trial:']);
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
    let logSpy;
    let errSpy;

    const limpaEnv = () => {
      delete process.env.BANNER_INDICACAO_TRIAL_ENABLED;
      delete process.env.BANNER_INDICACAO_TRIAL_DRY_RUN;
      delete process.env.BANNER_INDICACAO_TRIAL_PUBLICAR;
    };

    beforeEach(() => {
      job._resetForTests();
      db.query.mockReset();
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      limpaEnv();
      db.query.mockImplementation(async () => ({ rows: [] }));
    });
    afterEach(() => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      limpaEnv();
    });

    it('antes das 06h30 não consulta o banco', async () => {
      const r = await job.runOnce(brt('2026-10-14', 6, 29));
      expect(r).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('depois das 06h30 roda uma vez no dia (sem nenhuma chave de ambiente) e não repete', async () => {
      const r1 = await job.runOnce(brt('2026-10-14', 6, 31));
      expect(r1).toMatchObject({ ligado: true });
      const chamadas = db.query.mock.calls.length;
      expect(chamadas).toBeGreaterThan(0);

      const r2 = await job.runOnce(brt('2026-10-14', 6, 36));
      expect(r2).toBeNull();
      expect(db.query.mock.calls.length).toBe(chamadas);

      const r3 = await job.runOnce(brt('2026-10-15', 6, 31));
      expect(r3).toMatchObject({ ligado: true });
    });

    it('kill switch (ENABLED=false) não roda nem marca o dia', async () => {
      process.env.BANNER_INDICACAO_TRIAL_ENABLED = 'false';
      expect(await job.runOnce(brt('2026-10-14', 8))).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
      // religado no mesmo dia, roda
      delete process.env.BANNER_INDICACAO_TRIAL_ENABLED;
      expect(await job.runOnce(brt('2026-10-14', 9))).toMatchObject({ ligado: true });
    });

    it('banco fora do ar não marca o dia: a volta seguinte tenta de novo', async () => {
      db.query.mockRejectedValueOnce(new Error('connection terminated'));
      expect(await job.runOnce(brt('2026-10-14', 7, 0))).toBeNull();
      expect(errSpy).toHaveBeenCalled();
      expect(await job.runOnce(brt('2026-10-14', 7, 5))).toMatchObject({ ligado: true });
    });

    it('com empresa elegível, grava o banner ATIVO pelo appNotifications', async () => {
      db.query.mockImplementation(async (sql) => {
        const s = sql.replace(/\s+/g, ' ');
        if (s.startsWith('SELECT c.id AS company_id')) {
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
      expect(ins[0]).toContain('ON CONFLICT (dedupe_key)');
      // [type, title, body, html, cta_label, cta_url, cta_route, target_company_id,
      //  target_plan, target_vertical, expires_at, is_active, dedupe_key]
      const p = ins[1];
      expect(p[0]).toBe('banner');
      expect(p[7]).toBe(CID);
      expect(p[11]).toBe(true);
      expect(p[12]).toBe('indicacao-trial:' + CID);
    });
  });

  it('o stop* do job entra no encerramento gracioso', () => {
    const { stopsDosJobsCarregados } = require('../../src/utils/encerrar');
    expect(stopsDosJobsCarregados().map((f) => f.name)).toContain('stopBannerIndicacaoTrialJob');
  });
});
