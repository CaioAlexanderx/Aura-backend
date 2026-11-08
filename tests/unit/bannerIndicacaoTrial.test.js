// ============================================================
// services/bannerIndicacaoTrial + jobs/bannerIndicacaoTrialJob
//
// 08/11/2026 (card b-mk-30, decisão do Caio via Marketing): o banner de
// indicação REPETE a cada 14 dias para toda conta real, sem data final.
//
// O que estes testes travam:
//   1. A regra: exclusões (interna, teste, canário, filial paga por outra,
//      desativada, Karatê/Odonto/Food) e o ciclo de 14 dias contado em dias
//      de Brasília. Dispensar não entra na regra.
//   2. O texto por fase: Black com BLACK50 até 30/11 23:59:59 BRT; sem
//      BLACK50 quando o cupom chega a 10 usos; fixo de 01/12 em diante.
//   3. O banner: chave por ciclo, 14 dias no ar, ativo por padrão.
//   4. A volta: kill switch, dry-run, cria e desliga o anterior, chave
//      repetida não desliga nada.
//   5. A leitura do sininho reescreve o texto pela fase e marca a campanha.
//   6. Contadores: vista/clique em audit_log, leitura para o Marketing.
//   7. Horário do job: 06h30 BRT, uma vez por dia.
// ============================================================
'use strict';

const svc = require('../../src/services/bannerIndicacaoTrial');
const job = require('../../src/jobs/bannerIndicacaoTrialJob');

const { avaliarEmpresa, tickBannerIndicacaoTrial, montarBanner, lerConfig } = svc;

const DIA = 24 * 3600 * 1000;
// Instante em Brasília (UTC-3).
const brt = (dia, hh = 12, mm = 0) => new Date(Date.parse(dia + 'T00:00:00Z') + ((hh + 3) * 60 + mm) * 60000);

const AGORA_BF = brt('2026-11-13', 6, 35);
const AGORA_DEZ = brt('2026-12-05', 6, 35);
const CID = '11111111-2222-3333-4444-555555555555';
const CID2 = '66666666-7777-8888-9999-000000000000';
const NID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CANARIO = 'b0463109-e68e-4d55-a2d4-40c8a758ae0b';

const fatos = (extra = {}) => ({
  company_id: CID,
  shell: 'negocio',
  company_email: 'loja@gmail.com',
  owner_email: 'dona@gmail.com',
  is_sandbox: false,
  paga_por_outra: false,
  empresa_inativa: false,
  ultimo_banner_em: null,
  ...extra,
});

const avalia = (extra, opts) => avaliarEmpresa(fatos(extra), { agora: AGORA_BF, ...opts });

beforeEach(() => svc._resetCacheForTests());

// ── 1. a regra ──────────────────────────────────────────────
describe('avaliarEmpresa', () => {
  it('conta real sem banner nenhum: elegível', () => {
    expect(avalia()).toEqual({ elegivel: true, motivo: null });
  });

  it.each([
    [{ shell: 'karate_dojo' }, 'shell_fora_da_campanha'],
    [{ shell: 'karate_federation' }, 'shell_fora_da_campanha'],
    [{ shell: 'odonto' }, 'shell_fora_da_campanha'],
    [{ shell: 'food' }, 'shell_fora_da_campanha'],
    [{ owner_email: 'time@getaura.com.br' }, 'conta_interna'],
    [{ company_email: 'Loja@GetAura.com.br ' }, 'conta_interna'],
    [{ is_sandbox: true }, 'conta_de_teste'],
    [{ paga_por_outra: true }, 'paga_por_outra'],
    [{ empresa_inativa: true }, 'empresa_inativa'],
  ])('exclusão %j → %s', (extra, motivo) => {
    expect(avalia(extra)).toEqual({ elegivel: false, motivo });
  });

  it('canário fica de fora', () => {
    expect(avalia({ company_id: CANARIO }, { canaryId: CANARIO })).toEqual({ elegivel: false, motivo: 'canario' });
  });

  it('Studio, pagante, em atraso e teste vencido recebem (a regra não olha cobrança)', () => {
    expect(avalia({ shell: 'studio' }).elegivel).toBe(true);
    expect(avalia({ billing_status: 'active', trial_ends_at: null }).elegivel).toBe(true);
    expect(avalia({ billing_status: 'overdue' }).elegivel).toBe(true);
  });

  it('ciclo: 13 dias depois do último banner ainda não; 14 dias sim', () => {
    expect(avalia({ ultimo_banner_em: brt('2026-10-31', 6, 35) })).toEqual({ elegivel: false, motivo: 'ciclo_em_andamento' });
    expect(avalia({ ultimo_banner_em: brt('2026-10-30', 6, 35) }).elegivel).toBe(true);
    expect(avalia({ ultimo_banner_em: brt('2026-10-01', 6, 35) }).elegivel).toBe(true);
  });

  it('ciclo conta dia de Brasília: banner criado 06h33 vale às 06h30 do 14º dia', () => {
    const ultimo = brt('2026-10-30', 6, 33);
    expect(avaliarEmpresa(fatos({ ultimo_banner_em: ultimo }), { agora: brt('2026-11-13', 6, 30) }).elegivel).toBe(true);
    // 23h30 BRT ainda é o mesmo dia: não antecipa o ciclo.
    expect(svc.diasEntre(brt('2026-10-30', 23, 30), brt('2026-11-12', 23, 59))).toBe(13);
  });

  it('dispensar não é critério: só a data do último banner decide', () => {
    expect(avalia({ ultimo_banner_em: brt('2026-10-30'), fechou_banner_antigo: true, ja_tem_banner: true }).elegivel).toBe(true);
  });
});

// ── 2. texto por fase ───────────────────────────────────────
describe('fase do texto', () => {
  const FIM = svc.FIM_BLACK_FRIDAY_INDICACAO;

  it('fim da Black Friday é 30/11/2026 23:59:59 em Brasília', () => {
    expect(FIM.toISOString()).toBe('2026-12-01T02:59:59.000Z');
  });

  it('black até 30/11 23:59:59 BRT; fixo em 01/12 00:00 BRT', () => {
    expect(svc.faseDoTexto(FIM)).toBe('black');
    expect(svc.faseDoTexto(brt('2026-12-01', 0, 0))).toBe('fixo');
    expect(svc.bannerVigente(FIM)).toBe(svc.BANNER_BLACK_FRIDAY);
    expect(svc.bannerVigente(brt('2026-12-01', 0, 0))).toBe(svc.BANNER);
  });

  it('BLACK50 esgotado na Black Friday: texto sem BLACK50', () => {
    expect(svc.faseDoTexto(AGORA_BF, { black50Esgotado: true })).toBe('sem_black50');
    const t = svc.bannerVigente(AGORA_BF, { black50Esgotado: true });
    expect(t).toBe(svc.BANNER);
    expect(t.body).not.toMatch(/BLACK50/);
  });

  it('texto fixo não fala de Black nem de BLACK50; o da Black fala', () => {
    expect(`${svc.BANNER.title} ${svc.BANNER.body}`).not.toMatch(/black/i);
    expect(svc.BANNER_BLACK_FRIDAY.body).toMatch(/BLACK50/);
    expect(svc.BANNER_BLACK_FRIDAY.ctaLabel).toBe('Gerar meu código');
    expect(svc.BANNER_BLACK_FRIDAY.ctaRoute).toBe('/configuracoes?foco=indicacao');
  });

  it('black50EstaEsgotado: fonte é access_codes (uses x max_uses, ativo)', () => {
    expect(svc.black50EstaEsgotado({ uses: 0, max_uses: 10, is_active: true })).toBe(false);
    expect(svc.black50EstaEsgotado({ uses: 9, max_uses: 10, is_active: true })).toBe(false);
    expect(svc.black50EstaEsgotado({ uses: 10, max_uses: 10, is_active: true })).toBe(true);
    expect(svc.black50EstaEsgotado({ uses: 2, max_uses: 10, is_active: false })).toBe(true);
    expect(svc.black50EstaEsgotado(null)).toBe(true);
  });

  it('lerBlack50Esgotado consulta access_codes por BLACK50 e guarda 5 min', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ uses: 10, max_uses: 10, is_active: true }] })) };
    const t = AGORA_BF.getTime();
    expect(await svc.lerBlack50Esgotado(db, { now: t })).toBe(true);
    expect(db.query.mock.calls[0][0]).toMatch(/FROM access_codes WHERE code = \$1/);
    expect(db.query.mock.calls[0][1]).toEqual(['BLACK50']);
    await svc.lerBlack50Esgotado(db, { now: t + 60000 });
    expect(db.query).toHaveBeenCalledTimes(1);
    await svc.lerBlack50Esgotado(db, { now: t + 6 * 60000 });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('lerBlack50Esgotado com banco fora: na dúvida, esgotado', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const db = { query: jest.fn(async () => { throw new Error('fora'); }) };
    expect(await svc.lerBlack50Esgotado(db, { now: AGORA_BF.getTime() })).toBe(true);
    err.mockRestore();
  });

  it('faseAtual depois de 30/11 não consulta o banco', async () => {
    const db = { query: jest.fn() };
    expect(await svc.faseAtual(db, { now: AGORA_DEZ.getTime() })).toBe('fixo');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── 3. o banner ─────────────────────────────────────────────
describe('montarBanner', () => {
  it('chave do ciclo com o dia de Brasília, 14 dias no ar, ativo', () => {
    const b = montarBanner(CID, { agora: AGORA_BF });
    expect(b.dedupeKey).toBe(`indicacao:${CID}:2026-11-13`);
    expect(b.dedupeKey).toBe(svc.dedupeKeyDoCiclo(CID, AGORA_BF));
    expect(b.expiresAt).toBe(new Date(AGORA_BF.getTime() + 14 * DIA).toISOString());
    expect(b).toMatchObject({
      type: 'banner', targetCompanyId: CID, isActive: true,
      title: svc.BANNER_BLACK_FRIDAY.title, ctaLabel: 'Gerar meu código', ctaRoute: '/configuracoes?foco=indicacao',
    });
  });

  it('23h BRT ainda é o mesmo dia do ciclo', () => {
    expect(svc.dedupeKeyDoCiclo(CID, brt('2026-11-13', 23, 50))).toBe(`indicacao:${CID}:2026-11-13`);
  });

  it('texto fixo depois de 30/11 e sem BLACK50 quando esgotado', () => {
    expect(montarBanner(CID, { agora: AGORA_DEZ }).body).toBe(svc.BANNER.body);
    expect(montarBanner(CID, { agora: AGORA_BF, black50Esgotado: true }).body).toBe(svc.BANNER.body);
  });

  it('PUBLICAR=false cria inativo', () => {
    expect(montarBanner(CID, { agora: AGORA_BF, publicar: false }).isActive).toBe(false);
  });

  it('ehChaveDeIndicacao: só as três chaves do job, não as manuais da Gestão', () => {
    expect(svc.ehChaveDeIndicacao(`indicacao:${CID}:2026-11-13`)).toBe(true);
    expect(svc.ehChaveDeIndicacao('indicacao-bf-2026:' + CID)).toBe(true);
    expect(svc.ehChaveDeIndicacao('indicacao-trial:' + CID)).toBe(true);
    expect(svc.ehChaveDeIndicacao('indicacao-pagantes-lib-2026-10-21')).toBe(false);
    expect(svc.ehChaveDeIndicacao('indicacao-2026-10-15:x')).toBe(false);
    expect(svc.ehChaveDeIndicacao(null)).toBe(false);
  });
});

describe('lerConfig', () => {
  it('ligado e publicando por padrão; só "false" desliga; só "true" liga o dry-run', () => {
    expect(lerConfig({})).toMatchObject({ enabled: true, dryRun: false, publicar: true });
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_ENABLED: 'FALSE' }).enabled).toBe(false);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_DRY_RUN: 'true' }).dryRun).toBe(true);
    expect(lerConfig({ BANNER_INDICACAO_TRIAL_PUBLICAR: 'false' }).publicar).toBe(false);
  });
});

// ── 4. a volta ──────────────────────────────────────────────
function makeDb({ empresas = [fatos()], black50 = { uses: 0, max_uses: 10, is_active: true }, desligados = 1 } = {}) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ s, params });
    if (s.startsWith('SELECT c.id AS company_id')) return { rows: empresas };
    if (s.startsWith('SELECT uses, max_uses, is_active FROM access_codes')) return { rows: black50 ? [black50] : [] };
    if (s.startsWith('UPDATE app_notifications SET is_active = false')) {
      return { rows: Array.from({ length: desligados }, (_, i) => ({ id: 'velho-' + i })) };
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
const rodar = (db, notifications, env = {}, agora = AGORA_BF) => tickBannerIndicacaoTrial({
  db, notifications, now: agora.getTime(), env,
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

  it('dry-run não escreve nada', async () => {
    const db = makeDb();
    const notifications = makeNotifications();
    const r = await rodar(db, notifications, { BANNER_INDICACAO_TRIAL_DRY_RUN: 'true' });
    expect(r.candidatas).toBe(1);
    expect(notifications.createAppNotification).not.toHaveBeenCalled();
    expect(escritas(db)).toHaveLength(0);
  });

  it('cria o banner do ciclo e desliga o anterior ainda ativo da empresa', async () => {
    const db = makeDb({
      empresas: [
        fatos({ ultimo_banner_em: brt('2026-10-30', 6, 34) }), // 14 dias: novo ciclo
        fatos({ company_id: CID2, ultimo_banner_em: brt('2026-11-08', 6, 34) }), // 5 dias: espera
      ],
    });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications);
    expect(r).toMatchObject({ fase: 'black', avaliadas: 2, candidatas: 1, criadas: 1, anterioresDesligados: 1 });
    expect(notifications.criados[0]).toMatchObject({
      targetCompanyId: CID, dedupeKey: `indicacao:${CID}:2026-11-13`, title: svc.BANNER_BLACK_FRIDAY.title,
    });
    const upd = escritas(db).find((c) => c.s.startsWith('UPDATE app_notifications SET is_active = false'));
    expect(upd.params[0]).toBe(CID);
    expect(upd.params[1]).toEqual(['indicacao-trial:%', 'indicacao-bf-2026:%', 'indicacao:%']);
    expect(upd.params[2]).toBe(`indicacao:${CID}:2026-11-13`);
    expect(upd.s).toContain('dedupe_key <> $3');
  });

  it('chave do ciclo já existe (volta repetida): conta jaExistiam e não desliga nada', async () => {
    const db = makeDb();
    const notifications = makeNotifications(() => null);
    const r = await rodar(db, notifications);
    expect(r).toMatchObject({ criadas: 0, jaExistiam: 1, anterioresDesligados: 0 });
    expect(escritas(db)).toHaveLength(0);
  });

  it('BLACK50 com 10 de 10 usos: banner novo nasce sem BLACK50', async () => {
    const db = makeDb({ black50: { uses: 10, max_uses: 10, is_active: true } });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications);
    expect(r.fase).toBe('sem_black50');
    expect(notifications.criados[0].body).toBe(svc.BANNER.body);
  });

  it('depois de 30/11: texto fixo, sem ler o BLACK50, e continua criando', async () => {
    const db = makeDb();
    const notifications = makeNotifications();
    const r = await rodar(db, notifications, {}, AGORA_DEZ);
    expect(r).toMatchObject({ fase: 'fixo', criadas: 1 });
    expect(notifications.criados[0].title).toBe(svc.BANNER.title);
    expect(db.calls.some((c) => /FROM access_codes/.test(c.s))).toBe(false);
  });

  it('exclusões não viram banner', async () => {
    const db = makeDb({
      empresas: [
        fatos({ shell: 'karate_dojo' }),
        fatos({ owner_email: 'x@getaura.com.br' }),
        fatos({ is_sandbox: true }),
        fatos({ paga_por_outra: true }),
        fatos({ empresa_inativa: true }),
      ],
    });
    const notifications = makeNotifications();
    const r = await rodar(db, notifications);
    expect(r).toMatchObject({ avaliadas: 5, candidatas: 0, criadas: 0 });
  });

  it('falha numa empresa não para as outras', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({ empresas: [fatos(), fatos({ company_id: CID2 })] });
    let n = 0;
    const notifications = makeNotifications((p) => { n++; if (n === 1) throw new Error('x'); return { id: 'ok', ...p }; });
    const r = await rodar(db, notifications);
    expect(r).toMatchObject({ falhas: 1, criadas: 1 });
    err.mockRestore();
  });
});

describe('buscarFatos (consulta)', () => {
  it('traz o último banner das três chaves por empresa, sem filtro de cobrança', async () => {
    const db = makeDb();
    await svc.buscarFatos(db);
    const c = db.calls.find((x) => x.s.startsWith('SELECT c.id AS company_id'));
    expect(c.s).toContain('MAX(n.created_at)');
    expect(c.s).toContain('LIKE ANY ($1::text[])');
    expect(c.s).not.toMatch(/notification_reads/);
    expect(c.s).not.toMatch(/trial_ends_at >/);
    expect(c.params[0]).toEqual(['indicacao-trial:%', 'indicacao-bf-2026:%', 'indicacao:%']);
  });
});

// ── 5. leitura do sininho ───────────────────────────────────
describe('textoDosBannersNaLeitura', () => {
  const comum = { id: 'b1', title: 'Novidade', body: 'x', dedupe_key: null };
  const indicacao = { id: 'b2', title: 'texto velho', body: 'BLACK50 velho', dedupe_key: 'indicacao-bf-2026:' + CID };

  it('sem banner de indicação: não consulta o banco e tira dedupe_key', async () => {
    const db = { query: jest.fn() };
    const out = await svc.textoDosBannersNaLeitura(db, [comum], { now: AGORA_BF.getTime() });
    expect(db.query).not.toHaveBeenCalled();
    expect(out).toEqual([{ id: 'b1', title: 'Novidade', body: 'x' }]);
  });

  it('Black Friday com BLACK50: texto da Black e marca da campanha', async () => {
    const db = makeDb();
    const out = await svc.textoDosBannersNaLeitura(db, [comum, indicacao], { now: AGORA_BF.getTime() });
    expect(out[0]).toEqual({ id: 'b1', title: 'Novidade', body: 'x' });
    expect(out[1]).toMatchObject({
      id: 'b2', title: svc.BANNER_BLACK_FRIDAY.title, body: svc.BANNER_BLACK_FRIDAY.body, campanha: 'indicacao', fase: 'black',
    });
    expect(out[1]).not.toHaveProperty('dedupe_key');
  });

  it('BLACK50 esgotado: banner já no ar perde o BLACK50 na hora', async () => {
    const db = makeDb({ black50: { uses: 10, max_uses: 10, is_active: true } });
    const out = await svc.textoDosBannersNaLeitura(db, [indicacao], { now: AGORA_BF.getTime() });
    expect(out[0]).toMatchObject({ title: svc.BANNER.title, body: svc.BANNER.body, fase: 'sem_black50' });
  });

  it('01/12 em diante: texto fixo mesmo para banner criado na Black Friday', async () => {
    const db = { query: jest.fn() };
    const out = await svc.textoDosBannersNaLeitura(db, [indicacao], { now: brt('2026-12-01', 0, 0).getTime() });
    expect(out[0]).toMatchObject({ title: svc.BANNER.title, body: svc.BANNER.body, fase: 'fixo' });
  });
});

// ── 6. contadores ───────────────────────────────────────────
describe('registrarEvento', () => {
  it('evento desconhecido não grava', async () => {
    const db = { query: jest.fn() };
    expect(await svc.registrarEvento(db, { companyId: CID, notificationId: NID, evento: 'outro' })).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([['vista', 'indicacao.banner_visto'], ['clique', 'indicacao.banner_clique']])(
    '%s grava audit_log %s uma vez por usuário por banner de indicação da empresa',
    async (evento, acao) => {
      const db = makeDb();
      db.query.mockImplementation(async (sql, params) => {
        db.calls.push({ s: sql.replace(/\s+/g, ' ').trim(), params });
        if (/FROM access_codes/.test(sql)) return { rows: [{ uses: 0, max_uses: 10, is_active: true }] };
        return { rows: [], rowCount: 1 };
      });
      const ok = await svc.registrarEvento(db, {
        companyId: CID, userId: CID2, notificationId: NID, evento, now: AGORA_BF.getTime(),
      });
      expect(ok).toBe(true);
      const ins = db.calls.find((c) => c.s.startsWith('INSERT INTO audit_log'));
      expect(ins.params.slice(0, 3)).toEqual([CID2, CID, acao]);
      expect(ins.params[4]).toBe('black');
      expect(ins.params[5]).toBe(NID);
      expect(ins.s).toContain('n.target_company_id = $2::uuid');
      expect(ins.s).toContain('NOT EXISTS');
      expect(ins.s).toContain('a.user_id IS NOT DISTINCT FROM $1::uuid');
    }
  );
});

describe('contadores', () => {
  it('junta banners, vistas, cliques, indicações e BLACK50', async () => {
    const db = {
      query: jest.fn(async (sql) => {
        if (/FROM app_notifications n/.test(sql)) return { rows: [{ criados: 67, empresas: 67, dispensados: 4 }] };
        if (/FROM audit_log a\s+LEFT JOIN users/.test(sql)) {
          return { rows: [
            { action: 'indicacao.banner_visto', total: 30, empresas: 20, na_fase_black: 30 },
            { action: 'indicacao.banner_clique', total: 5, empresas: 4, na_fase_black: 5 },
          ] };
        }
        if (/FROM referrals rf/.test(sql)) return { rows: [{ total: 3, depois_do_clique: 2, depois_da_vista: 2 }] };
        if (/FROM access_codes/.test(sql)) return { rows: [{ uses: 1, max_uses: 10, is_active: true }] };
        return { rows: [] };
      }),
    };
    const r = await svc.contadores(db, { desde: '2026-10-30T03:00:00Z', now: AGORA_BF.getTime() });
    expect(r).toMatchObject({
      fase_agora: 'black',
      banners: { criados: 67, empresas: 67, dispensados: 4 },
      vistas: { total: 30, empresas: 20 },
      cliques_gerar_codigo: { total: 5, empresas: 4 },
      indicacoes: { cadastros_por_link: 3, depois_do_clique_no_banner: 2, depois_de_ver_o_banner: 2 },
      black50: { usos: 1, limite: 10, ativo: true, esgotado: false },
    });
    const sqls = db.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /NOT ILIKE '%@getaura\.com\.br'/.test(s) && /audit_log a/.test(s))).toBe(true);
  });
});

// ── 7. job ──────────────────────────────────────────────────
describe('jobs/bannerIndicacaoTrialJob', () => {
  const t = (iso, hh, mm = 0) => brt(iso, hh, mm).getTime();

  it('06h29 BRT ainda não; 06h30 em diante sim; só uma vez por dia', () => {
    expect(job.passouDoHorario(t('2026-11-13', 6, 29))).toBe(false);
    expect(job.passouDoHorario(t('2026-11-13', 6, 30))).toBe(true);
    expect(job.devePassarAgora(t('2026-11-13', 6, 40), '2026-11-13')).toBe(false);
    expect(job.devePassarAgora(t('2026-11-14', 6, 35), '2026-11-13')).toBe(true);
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
      expect(await job.runOnce(t('2026-11-13', 6, 29))).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('kill switch (ENABLED=false) não roda', async () => {
      process.env.BANNER_INDICACAO_TRIAL_ENABLED = 'false';
      expect(await job.runOnce(t('2026-11-13', 8))).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('com empresa elegível grava o banner do ciclo pelo appNotifications', async () => {
      db.query.mockImplementation(async (sql) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith('SELECT c.id AS company_id')) return { rows: [fatos()] };
        if (s.startsWith('SELECT uses, max_uses')) return { rows: [{ uses: 0, max_uses: 10, is_active: true }] };
        if (s.startsWith('INSERT INTO app_notifications')) return { rows: [{ id: 'novo' }] };
        return { rows: [] };
      });
      const r = await job.runOnce(t('2026-11-13', 7, 0));
      expect(r).toMatchObject({ candidatas: 1, criadas: 1 });
      const ins = db.query.mock.calls.find((c) => /INSERT INTO app_notifications/.test(c[0]));
      expect(ins[0]).toContain('ON CONFLICT (dedupe_key)');
      // [..., target_company_id(7), ..., expires_at(10), is_active(11), dedupe_key(12)]
      expect(ins[1][7]).toBe(CID);
      expect(ins[1][11]).toBe(true);
      expect(ins[1][12]).toBe(`indicacao:${CID}:2026-11-13`);
    });
  });

  it('o stop* do job entra no encerramento gracioso', () => {
    const { stopsDosJobsCarregados } = require('../../src/utils/encerrar');
    expect(stopsDosJobsCarregados().map((f) => f.name)).toContain('stopBannerIndicacaoTrialJob');
  });
});
