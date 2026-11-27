// ============================================================
// AURA — WhatsApp: automáticas (tela nova, 26/11/2026)
// Prova: corte (quem mais compra; crediário, mais limite livre), uma
// novidade a cada 7 dias, opt-out nunca, sem telefone fora, 50 por envio,
// divisão acima do saldo recusada, aceite uma vez, o envio para quando
// o saldo acaba e nunca passa da parte.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({ createTemplate: jest.fn() }));
jest.mock('../src/services/waSaldo', () => ({ getSaldos: jest.fn() }), { virtual: true });
jest.mock('../src/services/waOutbox', () => ({
  normalizePhone: (raw) => {
    const d = String(raw || '').replace(/\D/g, '');
    if (!d) return null;
    return d.startsWith('55') ? d : `55${d}`;
  },
  simulate: jest.fn(),
  enqueue: jest.fn(),
  decryptToken: (t) => t,
  applyTemplateStatus: jest.fn(),
}));
jest.mock('../src/services/waAutomaticas/modelosStore', () => ({
  listar: jest.fn(),
  resolverParaEnvio: jest.fn(),
}));
jest.mock('../src/services/marketing/marketingCommon', () => ({
  loadMarketingSettings: jest.fn(),
  setMarketingConsent: jest.fn(),
  loadStoreName: jest.fn().mockResolvedValue('Lume Moda'),
  describeDiscount: (t, v) => (t === 'percent' ? `${v}% de desconto` : `R$ ${v},00 de desconto`),
  formatDateBR: () => '15/12/2026',
  createCoupon: jest.fn(),
  logMarketing: jest.fn(),
  KIND_ANIVERSARIO: 'aniversario',
  KIND_REATIVACAO: 'reativacao',
}));

const db = require('../src/config/database');
const waOutbox = require('../src/services/waOutbox');
const waSaldo = require('../src/services/waSaldo');
const modelosStore = require('../src/services/waAutomaticas/modelosStore');
const mkt = require('../src/services/marketing/marketingCommon');
const publico = require('../src/services/waAutomaticas/publico');
const auto = require('../src/services/waAutomaticas/automaticas');
const executor = require('../src/services/waAutomaticas/executor');
const job = require('../src/jobs/waAutomaticasJob');

const COMPANY = '22222222-2222-2222-2222-222222222222';

const cli = (i, extra = {}) => ({
  id: `c${i}`, name: `Cliente ${i}`, phone: `1190000${String(i).padStart(4, '0')}`,
  total_spent: 1000 - i, marketing_opt_out: false, ...extra,
});

describe('corte e classificação (funções puras)', () => {
  test('ordena quem mais compra primeiro; crediário, quem tem mais limite livre', () => {
    const a = publico.ordenar([cli(1, { total_spent: 50 }), cli(2, { total_spent: 900 }), cli(3, { total_spent: 300 })]);
    expect(a.map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
    const b = publico.ordenar([
      { id: 'x', name: 'X', total_spent: 9000, limite_livre: 50 },
      { id: 'y', name: 'Y', total_spent: 10, limite_livre: 480 },
    ], 'limite_livre');
    expect(b.map((c) => c.id)).toEqual(['y', 'x']);
  });

  test('sem telefone, opt-out (cliente e contato) e recebeu há menos de 7 dias ficam de fora, com motivo', () => {
    const cands = [
      cli(1), cli(2, { phone: '' }), cli(3, { marketing_opt_out: true }),
      cli(4), cli(5), cli(6),
    ];
    const recentes = new Set([waOutbox.normalizePhone(cands[3].phone)]);
    const optouts = new Set([waOutbox.normalizePhone(cands[4].phone)]);
    const { elegiveis, fora } = publico.classificar(cands, { recentes, optouts });
    expect(elegiveis.map((c) => c.id)).toEqual(['c1', 'c6']);
    expect(Object.fromEntries(fora.map((c) => [c.id, c.motivo]))).toEqual({
      c2: 'SEM_TELEFONE', c3: 'OPT_OUT', c4: 'RECEBEU_HA_MENOS_DE_7_DIAS', c5: 'OPT_OUT',
    });
    expect(publico.contarForas(fora)).toEqual({ recebeu_ha_menos_de_7_dias: 1, pediu_para_nao_receber: 2, sem_telefone: 1, sem_a_peca_da_ultima_compra: 0 });
  });

  test('cortar: nunca passa do que cabe, nem de 50', () => {
    const lista = Array.from({ length: 120 }, (_, i) => cli(i));
    expect(publico.cortar(lista, 4).vao).toHaveLength(4);
    expect(publico.cortar(lista, 4).guardados).toHaveLength(116);
    expect(publico.cortar(lista, 200).vao).toHaveLength(50);
    expect(publico.cortar(lista, 0).vao).toHaveLength(0);
    expect(publico.cortar(lista, -3).vao).toHaveLength(0);
    expect(publico.cortar(lista, 'x').vao).toHaveLength(0);
  });

  test('a prévia diz quem vai, quem fica guardado e quantas novidades faltam', () => {
    const { elegiveis, fora } = publico.classificar([cli(1), cli(2), cli(3), cli(4), cli(5, { phone: '' })]);
    const r = publico.montarPrevia({
      key: 'venda_mais', periodo: '2026-12', elegiveis: publico.ordenar(elegiveis), fora, livres: 2,
      ordem: executor.ORDEM.padrao, detalhe: (c) => `${c.total_spent}`,
    });
    expect(r).toMatchObject({ elegiveis: 4, cabem: 2, ficam_guardados: 2, falta_para_todos: 2, ordem: 'quem mais compra primeiro' });
    expect(r.vao.map((v) => v.customer_id)).toEqual(['c1', 'c2']);
    expect(r.vao[0].telefone_final).toHaveLength(4);
    expect(r.fora.sem_telefone).toBe(1);
    expect(r.fora_lista[0]).toMatchObject({ customer_id: 'c5', motivo: 'SEM_TELEFONE' });
  });
});

describe('campos extras da prévia (mockup)', () => {
  const previaDe = (cands, livres, extra = {}) => {
    const { elegiveis, fora } = publico.classificar(cands);
    return publico.montarPrevia({ key: 'x', periodo: '2026-12', elegiveis: publico.ordenar(elegiveis), fora, livres, ordem: 'o', detalhe: () => 'd', ...extra });
  };

  test('Crediário vender: limite_livre em R$ (número) em quem vai e em quem fica guardado', () => {
    const r = previaDe([
      { ...cli(1), total_spent: 10, limite_livre: '480.00' },
      { ...cli(2), total_spent: 20, limite_livre: 320.5 },
      { ...cli(3), total_spent: 30, limite_livre: 90 },
    ], 1);
    r.vao.forEach((v) => expect(typeof v.limite_livre).toBe('number'));
    expect(r.vao[0].limite_livre).toBe(90);
    expect(r.guardados.map((g) => g.limite_livre)).toEqual([320.5, 480]);
  });

  test('Venda+: ultima_compra em ISO e mes_ultima_compra em português', () => {
    const r = previaDe([
      cli(1, { ultima_compra: new Date('2026-08-14T15:00:00Z') }),
      cli(2, { ultima_compra: '2026-03-02T01:00:00Z' }),
      cli(3, { ultima_compra: null }),
    ], 5);
    const por = Object.fromEntries(r.vao.map((v) => [v.customer_id, v]));
    expect(por.c1).toMatchObject({ ultima_compra: '2026-08-14', mes_ultima_compra: 'agosto' });
    // 01:00 UTC ainda é 01/03 noite de 01/03? em Brasília é 28/02 22h: o dia é o de Brasília
    expect(por.c2).toMatchObject({ ultima_compra: '2026-03-01', mes_ultima_compra: 'março' });
    expect(por.c3.ultima_compra).toBeUndefined();
    expect(por.c3.mes_ultima_compra).toBeUndefined();
  });

  test('o mês fecha as 12 pontas e data inválida não quebra', () => {
    expect(publico.MESES_PT).toHaveLength(12);
    expect(publico.mesPorExtenso('2026-12-31')).toBe('dezembro');
    expect(publico.mesPorExtenso('2026-01-01')).toBe('janeiro');
    expect(publico.isoBRT('lixo')).toBeNull();
    expect(publico.camposExtras({})).toEqual({});
  });

  test('camposExtras devolve o telefone só em dígitos, e só quando existe', () => {
    expect(publico.camposExtras({ phone: '(11) 90000-0001' }).telefone).toBe('5511900000001');
    expect(publico.camposExtras({ phone: '' })).toEqual({});
    expect(publico.camposExtras({ phone: null })).toEqual({});
    const r = previaDe([cli(1), cli(2, { phone: '' })], 5);
    expect(r.vao[0].telefone).toMatch(/^\d+$/);
  });

  test('as consultas trazem os campos: Venda+ lê a última venda não cancelada, Crediário o limite livre', async () => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
    await publico.candidatosVendaMais(COMPANY, 'sumindo', '2026-12-01');
    await publico.candidatosCrediarioVender(COMPANY, '2026-12-01');
    const sqls = db.query.mock.calls.map((c) => c[0]);
    expect(sqls.find((q) => /wa:publico-venda-mais/.test(q))).toMatch(/s\.status <> 'cancelled'[\s\S]*AS ultima_compra/);
    expect(sqls.find((q) => /wa:publico-crediario-vender/.test(q))).toMatch(/\(p\.credit_limit - p\.credit_used\) AS limite_livre/);
  });
});

describe('divisão das novidades', () => {
  function simularDivisao({ total = 10, usadas = {} } = {}) {
    db.query.mockReset();
    waSaldo.getSaldos.mockResolvedValue({ mes: '2026-11', saldos: { novidades: { total, restante: total, bloqueado_por: null } } });
    db.query.mockImplementation(async (sql) => {
      if (/wa:auto-usadas/.test(sql)) {
        return { rows: Object.entries(usadas).map(([source_type, n]) => ({ source_type, n })) };
      }
      return { rows: [] };
    });
  }

  test('soma dentro do saldo grava; padrão é 4/4/2', async () => {
    simularDivisao();
    expect(auto.DIVISAO_PADRAO).toEqual({ aniversario: 4, venda_mais: 4, crediario: 2 });
    const r = await auto.definirDivisao(COMPANY, { aniversario: 5, venda_mais: 3, crediario: 2 });
    expect(r.divisao).toEqual({ aniversario: 5, venda_mais: 3, crediario: 2 });
    expect(r.sem_dono).toBe(0);
    expect(db.query.mock.calls.some((c) => /wa:auto-divisao-set/.test(c[0]))).toBe(true);
  });

  test('soma acima do saldo é recusada no servidor e nada é gravado', async () => {
    simularDivisao({ total: 10 });
    await expect(auto.definirDivisao(COMPANY, { aniversario: 5, venda_mais: 5, crediario: 1 }))
      .rejects.toMatchObject({ status: 422, code: 'DIVISAO_ACIMA_DO_SALDO', extra: { total: 10, soma: 11, sobra: -1 } });
    expect(db.query.mock.calls.some((c) => /wa:auto-divisao-set/.test(c[0]))).toBe(false);
  });

  test('não deixa uma parte abaixo do que já usou no mês', async () => {
    simularDivisao({ usadas: { venda_mais: 3 } });
    await expect(auto.definirDivisao(COMPANY, { aniversario: 5, venda_mais: 2, crediario: 2 }))
      .rejects.toMatchObject({ code: 'DIVISAO_ABAIXO_DO_USADO', extra: { parte: 'venda_mais', usadas: 3 } });
  });

  test('número inválido é recusado', async () => {
    simularDivisao();
    await expect(auto.definirDivisao(COMPANY, { aniversario: -1, venda_mais: 4, crediario: 2 })).rejects.toMatchObject({ code: 'CONFIG_INVALIDA' });
    await expect(auto.definirDivisao(COMPANY, { aniversario: 1.5, venda_mais: 4, crediario: 2 })).rejects.toMatchObject({ code: 'CONFIG_INVALIDA' });
  });

  test('sem conseguir ler o saldo (módulo ou erro): na dúvida, bloqueia', async () => {
    simularDivisao();
    waSaldo.getSaldos.mockRejectedValue(new Error('banco fora'));
    await expect(auto.definirDivisao(COMPANY, { aniversario: 1, venda_mais: 1, crediario: 1 }))
      .rejects.toMatchObject({ status: 503, code: 'SALDO_INDISPONIVEL' });
  });
});

describe('ligar e o aceite de novidades', () => {
  beforeEach(() => { process.env.WA_AUTOMATICAS_ENABLED = 'true'; });
  afterEach(() => { delete process.env.WA_AUTOMATICAS_ENABLED; });

  function simularLigar({ aceite = null, modelos = [] } = {}) {
    db.query.mockReset();
    mkt.setMarketingConsent.mockReset().mockResolvedValue(true);
    mkt.loadMarketingSettings.mockResolvedValue({ wa_marketing_consent_at: aceite });
    modelosStore.listar.mockResolvedValue(modelos);
    waSaldo.getSaldos.mockResolvedValue({ mes: '2026-11', saldos: { novidades: { total: 10, restante: 10 }, avisos: { restante: 100 } } });
    db.query.mockImplementation(async () => ({ rows: [] }));
  }

  test('primeira automática de novidade pergunta o aceite; com o aceite, grava e liga', async () => {
    simularLigar();
    await expect(auto.ligar(COMPANY, 'aniversario', { ligada: true })).rejects.toMatchObject({ status: 409, code: 'SEM_ACEITE_NOVIDADES' });
    expect(mkt.setMarketingConsent).not.toHaveBeenCalled();
    await auto.ligar(COMPANY, 'aniversario', { ligada: true, aceite_novidades: true });
    expect(mkt.setMarketingConsent).toHaveBeenCalledWith(COMPANY, true);
    expect(db.query.mock.calls.some((c) => /wa:auto-set/.test(c[0]) && c[1][2] === true)).toBe(true);
  });

  test('com o job novo desligado (trava) não liga nada: 409 AUTOMATICAS_DESLIGADAS e nada é gravado', async () => {
    delete process.env.WA_AUTOMATICAS_ENABLED;
    simularLigar({ aceite: 'x' });
    for (const key of auto.KEYS) {
      await expect(auto.ligar(COMPANY, key, { ligada: true, aceite_novidades: true }))
        .rejects.toMatchObject({ status: 409, code: 'AUTOMATICAS_DESLIGADAS' });
    }
    expect(db.query.mock.calls.some((c) => /wa:auto-set/.test(c[0]))).toBe(false);
    // desligar continua livre
    await expect(auto.ligar(COMPANY, 'aniversario', { ligada: false })).resolves.toBeDefined();
  });

  test('jobs antigos só saem da frente quando o job novo está ligado', async () => {
    const mkt2 = jest.requireActual('../src/services/marketing/marketingCommon');
    const collection = require('../src/services/credit/collectionAuto');
    for (const [ligado, esperaExclusao] of [[false, false], [true, true]]) {
      if (ligado) process.env.WA_AUTOMATICAS_ENABLED = 'true'; else delete process.env.WA_AUTOMATICAS_ENABLED;
      db.query.mockReset();
      db.query.mockResolvedValue({ rows: [] });
      await mkt2.listCompaniesWithAuto('wa_birthday_auto');
      await collection.runAll().catch(() => {});
      const sqls = db.query.mock.calls.map((c) => c[0]).filter((q) => /mkt:auto-companies|cred:auto-companies/.test(q));
      expect(sqls.length).toBeGreaterThan(0);
      expect(sqls.some((q) => /wa_automaticas/.test(q))).toBe(esperaExclusao);
      // a régua antiga só sai se o template NOVO do ponto ligado está aprovado
      expect(sqls.some((q) => /wa_automaticas/.test(q) && /APPROVED/.test(q) && /aura_cred_antes_pix/.test(q))).toBe(ligado && sqls.some((q) => /cred:auto-companies/.test(q)));
    }
    delete process.env.WA_AUTOMATICAS_ENABLED;
  });

  test('com o aceite já gravado não pergunta de novo', async () => {
    simularLigar({ aceite: '2026-11-01T00:00:00Z' });
    await auto.ligar(COMPANY, 'venda_mais', { ligada: true });
    expect(mkt.setMarketingConsent).not.toHaveBeenCalled();
  });

  test('cobrar usa avisos: não pede aceite de novidades; desligar nunca falha', async () => {
    simularLigar();
    await auto.ligar(COMPANY, 'crediario_cobrar', { ligada: true });
    expect(mkt.setMarketingConsent).not.toHaveBeenCalled();
    simularLigar();
    await expect(auto.ligar(COMPANY, 'aniversario', { ligada: false })).resolves.toBeDefined();
  });

  test('modelo padrão ainda não aprovado na Meta: não liga', async () => {
    simularLigar({ aceite: 'x', modelos: [{ key: 'aniv_carinhoso_com', estado: 'AGUARDANDO_PADRAO' }] });
    await expect(auto.ligar(COMPANY, 'aniversario', { ligada: true }))
      .rejects.toMatchObject({ status: 409, code: 'MODELO_NAO_APROVADO' });
  });

  test('config inválida: presente zerado, passo vazio, antes sem presente', () => {
    expect(() => auto.normalizarConfig('venda_mais', null, { presente: { tipo: 'percent', valor: 0 } })).toThrow(/maior que zero/);
    expect(() => auto.normalizarConfig('aniversario', null, { quando: 'depois' })).toThrow(/no dia, 3 dias antes ou 7/);
    expect(() => auto.normalizarConfig('aniversario', null, { presente: null, quando: '3_dias_antes' })).toThrow(/Sem presente/);
    expect(auto.normalizarConfig('aniversario', null, null).quando).toBe('no_dia');
    expect(() => auto.normalizarConfig('crediario_vender', null, { dia_do_mes: 31 })).toThrow(/entre 1 e 28/);
    expect(auto.normalizarConfig('venda_mais', null, { segmento: 'sumiu' }).segmento).toBe('sumiu');
  });

  test('modelosDaConfig escolhe os templates certos', () => {
    expect(auto.modelosDaConfig('aniversario', { tom: 'direto', presente: null, quando: 'no_dia' })).toEqual(['aniv_direto_sem']);
    expect(auto.modelosDaConfig('aniversario', { tom: 'animado', presente: { tipo: 'percent', valor: 10 }, quando: 'no_dia' })).toEqual(['aniv_animado_com']);
    expect(auto.modelosDaConfig('aniversario', { tom: 'animado', presente: { tipo: 'percent', valor: 10 }, quando: '7_dias_antes' })).toEqual(['aniv_antes']);
    expect(auto.modelosDaConfig('venda_mais', { segmento: 'sumiu', presente: null })).toEqual(['venda_sumiu_sem']);
    expect(auto.modelosDaConfig('crediario_cobrar', { pontos: { antes3: true, dia: false, depois7: true } })).toEqual(['cred_antes', 'cred_atraso']);
  });
});

// ── envio ────────────────────────────────────────────────────
let _fila = Promise.resolve();
function simularConexao() {
  db.connect = jest.fn(async () => {
    let soltar;
    const minha = new Promise((r) => { soltar = r; });
    const espera = _fila;
    _fila = _fila.then(() => minha);
    await espera;
    return { query: jest.fn().mockResolvedValue({ rows: [] }), release: soltar };
  });
}

function prepararEnvio({ candidatos, vendaParte = 4, usadasVenda = 0, recentes = [], optouts = [] }) {
  db.query.mockReset();
  simularConexao();
  let enfileiradas = 0;
  waOutbox.enqueue.mockReset(); waOutbox.simulate.mockReset();
  mkt.createCoupon.mockReset().mockResolvedValue({ id: 'cup1', code: 'VOLTA-X', expires_at: '2026-12-15' });
  mkt.logMarketing.mockReset();
  modelosStore.resolverParaEnvio.mockReset().mockResolvedValue({
    templateName: 'aura_venda_sumindo_com', language: 'pt_BR', pronto: true, categoria: 'MARKETING',
    texto: 'Oi, {Nome}. Faz pouco mais de um mês da sua última compra na {Nome da loja}: {Última compra}. Chegou novidade por aqui, e separei {Presente} para você usar até {Validade}.',
  });
  waOutbox.simulate.mockResolvedValue({ ok: true });
  let seq = 0;
  waOutbox.enqueue.mockImplementation(async () => { enfileiradas++; return { queued: true, id: `o${++seq}` }; });
  db.query.mockImplementation(async (sql) => {
    if (/wa:auto-linhas/.test(sql)) {
      return { rows: [{ automatica: 'venda_mais', ligada: true, config: { segmento: 'sumindo', presente: { tipo: 'fixed', valor: 20 }, automatico: false } }] };
    }
    if (/wa:auto-divisao\b/.test(sql)) return { rows: [{ aniversario: 4, venda_mais: vendaParte, crediario: 2 }] };
    if (/wa:auto-usadas/.test(sql)) return { rows: usadasVenda + enfileiradas ? [{ source_type: 'venda_mais', n: usadasVenda + enfileiradas }] : [] };
    if (/wa:publico-venda-mais/.test(sql)) {
      return { rows: candidatos.map((c) => ('ultima_peca_nome' in c ? c : { ...c, ultima_peca_nome: 'Vestido Verde - AB1234', ultima_compra: '2026-10-16T15:00:00Z' })) };
    }
    if (/wa:publico-recentes/.test(sql)) return { rows: recentes.map((to_phone) => ({ to_phone })) };
    if (/wa:publico-optouts/.test(sql)) return { rows: optouts.map((phone) => ({ phone })) };
    return { rows: [] };
  });
}

describe('envio da automática (Venda+)', () => {
  test('manda só para quem cabe na parte, pela ordem de quem mais compra', async () => {
    const candidatos = Array.from({ length: 10 }, (_, i) => cli(i, { total_spent: i * 10, last_purchase_at: '2026-10-20T00:00:00Z', dias_sem_comprar: 40 }));
    prepararEnvio({ candidatos });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(4);
    const idsEnviados = waOutbox.enqueue.mock.calls.map((c) => c[0].customerId);
    expect(idsEnviados).toEqual(['c9', 'c8', 'c7', 'c6']);
    const args = waOutbox.enqueue.mock.calls[0][0];
    expect(args).toMatchObject({ sourceType: 'venda_mais', kind: 'template', templateName: 'aura_venda_sumindo_com' });
    expect(args.components[0].parameters.map((p) => p.text)).toEqual(['Cliente 9'.split(' ')[0], 'Lume Moda', 'vestido verde', 'R$ 20,00 de desconto', '15/12/2026']);
  });

  test('a parte já usada abate: parte 4, usadas 3, só cabe 1', async () => {
    const candidatos = Array.from({ length: 5 }, (_, i) => cli(i, { dias_sem_comprar: 40 }));
    prepararEnvio({ candidatos, usadasVenda: 3 });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(1);
  });

  test('parte esgotada: nada é enfileirado', async () => {
    prepararEnvio({ candidatos: [cli(1, { dias_sem_comprar: 40 })], usadasVenda: 4 });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(0);
    expect(waOutbox.enqueue).not.toHaveBeenCalled();
  });

  test('opt-out, sem telefone e recebeu há <7 dias nunca entram na fila', async () => {
    const candidatos = [
      cli(1, { dias_sem_comprar: 40 }), cli(2, { phone: null, dias_sem_comprar: 40 }),
      cli(3, { marketing_opt_out: true, dias_sem_comprar: 40 }), cli(4, { dias_sem_comprar: 40 }), cli(5, { dias_sem_comprar: 40 }),
    ];
    prepararEnvio({
      candidatos,
      recentes: [waOutbox.normalizePhone(candidatos[3].phone)],
      optouts: [waOutbox.normalizePhone(candidatos[4].phone)],
    });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(1);
    expect(waOutbox.enqueue.mock.calls.map((c) => c[0].customerId)).toEqual(['c1']);
  });

  test('o saldo recusou (SALDO_ESGOTADO): o laço para, não tenta o resto', async () => {
    const candidatos = Array.from({ length: 4 }, (_, i) => cli(i, { dias_sem_comprar: 40 }));
    prepararEnvio({ candidatos });
    waOutbox.enqueue.mockReset();
    waOutbox.enqueue
      .mockResolvedValueOnce({ queued: true, id: 'o1' })
      .mockResolvedValueOnce({ queued: false, reason: 'SALDO_ESGOTADO' });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(1);
    expect(r.parou_por).toBe('SALDO_ESGOTADO');
    expect(waOutbox.enqueue).toHaveBeenCalledTimes(2);
  });

  test('máximo de 50 por envio, mesmo com parte maior', async () => {
    const candidatos = Array.from({ length: 80 }, (_, i) => cli(i, { dias_sem_comprar: 40 }));
    prepararEnvio({ candidatos, vendaParte: 100 });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(50);
  });

  test('dois envios ao mesmo tempo nunca passam da parte (4): o segundo lê o que o primeiro já usou', async () => {
    const candidatos = Array.from({ length: 10 }, (_, i) => cli(i, { dias_sem_comprar: 40 }));
    prepararEnvio({ candidatos });
    const [a, b] = await Promise.all([
      executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' }),
      executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' }),
    ]);
    expect(a.enfileiradas + b.enfileiradas).toBe(4);
    expect(waOutbox.enqueue).toHaveBeenCalledTimes(4);
  });

  test('modelo padrão ainda não aprovado: para tudo, sem cupom gasto na fila', async () => {
    prepararEnvio({ candidatos: [cli(1, { dias_sem_comprar: 40 })] });
    modelosStore.resolverParaEnvio.mockResolvedValue({ templateName: 'x', pronto: false, texto: 'Oi, {Nome}.' });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(0);
    expect(r.parou_por).toBe('MODELO_NAO_APROVADO');
    expect(waOutbox.enqueue).not.toHaveBeenCalled();
  });

  test('automática desligada não envia', async () => {
    prepararEnvio({ candidatos: [cli(1, { dias_sem_comprar: 40 })] });
    db.query.mockImplementation(async (sql) => (/wa:auto-linhas/.test(sql) ? { rows: [] } : { rows: [] }));
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r).toMatchObject({ enfileiradas: 0, parou_por: 'DESLIGADA' });
  });

  test('a mesma pessoa no mesmo mês usa a mesma dedupe_key (nunca duas novidades)', async () => {
    prepararEnvio({ candidatos: [cli(1, { dias_sem_comprar: 40 })] });
    await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(waOutbox.enqueue.mock.calls[0][0].dedupeKey).toBe('vmais-c1-2026-12');
  });
});

describe('Venda+: {Última compra} é a PEÇA, nunca a data', () => {
  test('nomeDaPeca: minúsculas, sem código nem SKU', () => {
    expect(publico.nomeDaPeca('Vestido Verde')).toBe('vestido verde');
    expect(publico.nomeDaPeca('Vestido Verde - AB1234')).toBe('vestido verde');
    expect(publico.nomeDaPeca('Blusa de Linho (M) SKU 99871')).toBe('blusa de linho');
    expect(publico.nomeDaPeca('Calça Jeans Ref: JN-2201')).toBe('calça jeans');
    expect(publico.nomeDaPeca('  Bolsa  Couro  7891234567890 ')).toBe('bolsa couro');
    expect(publico.nomeDaPeca('Camiseta 2 em 1')).toBe('camiseta 2 em 1');
    expect(publico.nomeDaPeca('')).toBeNull();
    expect(publico.nomeDaPeca(null)).toBeNull();
    expect(publico.nomeDaPeca('(M)')).toBeNull();
  });

  test('o envio manda a peça e o mês por extenso; nunca a data ISO', async () => {
    const candidatos = [cli(1, { dias_sem_comprar: 70, last_purchase_at: '2026-08-14T15:00:00Z', ultima_compra: '2026-08-14T15:00:00Z', ultima_peca_nome: 'Blusa de Linho' })];
    prepararEnvio({ candidatos });
    db.query.mockImplementation(async (sql) => {
      if (/wa:auto-linhas/.test(sql)) return { rows: [{ automatica: 'venda_mais', ligada: true, config: { segmento: 'sumiu', presente: { tipo: 'fixed', valor: 20 } } }] };
      if (/wa:auto-divisao\b/.test(sql)) return { rows: [{ aniversario: 4, venda_mais: 4, crediario: 2 }] };
      if (/wa:publico-venda-mais/.test(sql)) return { rows: candidatos };
      return { rows: [] };
    });
    modelosStore.resolverParaEnvio.mockResolvedValue({
      templateName: 'aura_venda_sumiu_com', language: 'pt_BR', pronto: true,
      texto: 'Oi, {Nome}. Sua última compra na {Nome da loja} foi em {Mês da última compra}: {Última compra}. Te dou {Presente} até {Validade}.',
    });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01', segmento: 'sumiu' });
    expect(r.enfileiradas).toBe(1);
    const textosEnviados = waOutbox.enqueue.mock.calls[0][0].components[0].parameters.map((p) => p.text);
    expect(textosEnviados).toEqual(['Cliente', 'Lume Moda', 'agosto', 'blusa de linho', 'R$ 20,00 de desconto', '15/12/2026']);
    expect(textosEnviados.join(' ')).not.toMatch(/\d{4}-\d{2}/);
  });

  test('sem a peça da última compra o cliente fica de fora (nada de "uma peça" nem data) e não gasta lugar no corte', async () => {
    const candidatos = [
      cli(1, { dias_sem_comprar: 40, total_spent: 900, ultima_peca_nome: null, ultima_compra: '2026-10-16T15:00:00Z' }),
      cli(2, { dias_sem_comprar: 40, total_spent: 100 }),
    ];
    prepararEnvio({ candidatos, vendaParte: 1 });
    const r = await executor.rodar(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(1);
    expect(waOutbox.enqueue.mock.calls[0][0].customerId).toBe('c2');
    const params = waOutbox.enqueue.mock.calls[0][0].components[0].parameters.map((p) => p.text);
    expect(params).toContain('vestido verde');
    expect(params.join(' ')).not.toMatch(/uma peça|2026-/);
  });

  test('a prévia lista quem ficou sem peça em "fora" com o motivo e a frase', async () => {
    const candidatos = [
      cli(1, { dias_sem_comprar: 40, ultima_peca_nome: null }),
      cli(2, { dias_sem_comprar: 40 }),
    ];
    prepararEnvio({ candidatos, vendaParte: 4 });
    const r = await executor.previa(COMPANY, 'venda_mais', { hoje: '2026-12-01' });
    expect(r.elegiveis).toBe(1);
    expect(r.fora.sem_a_peca_da_ultima_compra).toBe(1);
    expect(r.fora_lista[0]).toMatchObject({ customer_id: 'c1', motivo: 'SEM_PECA_ULTIMA_COMPRA', motivo_texto: 'sem a peça da última compra' });
    expect(r.vao[0].ultima_peca).toBe('vestido verde');
    expect(r.vao[0].mes_ultima_compra).toBe('outubro');
  });

  test('a consulta pega a peça da última venda não cancelada, a de maior valor', async () => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
    await publico.candidatosVendaMais(COMPANY, 'sumindo', '2026-12-01');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/AS ultima_peca_nome/);
    expect(sql).toMatch(/s\.status <> 'cancelled'\s+ORDER BY s\.created_at DESC, si\.total_price DESC NULLS LAST, si\.id ASC LIMIT 1/);
  });
});

describe('cobrança: template novo não aprovado', () => {
  test('sem template aprovado a automática não manda nada (a régua antiga segue cobrindo)', async () => {
    prepararEnvio({ candidatos: [] });
    db.query.mockImplementation(async (sql) => {
      if (/wa:auto-linhas/.test(sql)) return { rows: [{ automatica: 'crediario_cobrar', ligada: true, config: { pontos: { antes3: true, dia: true, depois1: true } } }] };
      if (/wa:publico-crediario-cobrar/.test(sql)) {
        return { rows: [{ id: 'i1', customer_id: 'c1', installment_number: 1, total_installments: 3, valor: '50', due_iso: '2026-12-01', name: 'Ana', phone: '11999990001', deslocamento: 0 }] };
      }
      return { rows: [] };
    });
    modelosStore.resolverParaEnvio.mockResolvedValue({ templateName: 'aura_cred_dia_pix', pronto: false, texto: 'Oi, {Nome}.' });
    const r = await executor.rodar(COMPANY, 'crediario_cobrar', { hoje: '2026-12-01' });
    expect(r.enfileiradas).toBe(0);
    expect(r.parou_por).toBe('MODELO_NAO_APROVADO');
    expect(waOutbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('cobrança e datas', () => {
  test('texto do vencimento em português', () => {
    expect(executor.textoDeVencimento('2026-11-26', '2026-11-26')).toBe('hoje');
    expect(executor.textoDeVencimento('2026-11-25', '2026-11-26')).toBe('ontem');
    expect(executor.textoDeVencimento('2026-11-27', '2026-11-26')).toBe('amanhã, 27/11');
    expect(executor.textoDeVencimento('2026-11-29', '2026-11-26')).toBe('no domingo, 29/11');
    expect(executor.textoDeVencimento('2026-11-19', '2026-11-26')).toBe('no dia 19/11');
  });

  test('job: venda_mais só dia 1º e com automático; crediário vender no dia escolhido', () => {
    expect(job.devidaHoje({ automatica: 'venda_mais', config: { automatico: true } }, '2026-12-01')).toBe(true);
    expect(job.devidaHoje({ automatica: 'venda_mais', config: { automatico: true } }, '2026-12-02')).toBe(false);
    expect(job.devidaHoje({ automatica: 'venda_mais', config: { automatico: false } }, '2026-12-01')).toBe(false);
    expect(job.devidaHoje({ automatica: 'crediario_vender', config: { dia_do_mes: 10 } }, '2026-12-10')).toBe(true);
    expect(job.devidaHoje({ automatica: 'crediario_vender', config: { dia_do_mes: 10 } }, '2026-12-11')).toBe(false);
    expect(job.devidaHoje({ automatica: 'aniversario', config: {} }, '2026-12-11')).toBe(true);
  });

  test('o job nasce desligado (trava)', () => {
    delete process.env.WA_AUTOMATICAS_ENABLED;
    expect(job.habilitado()).toBe(false);
  });
});

describe('Aniversário: uma mensagem, a lojista escolhe quando', () => {
  function simularAniv(quando, hojeAniv) {
    db.query.mockReset();
    waOutbox.enqueue.mockReset().mockResolvedValue({ queued: true, id: 'o1' });
    waOutbox.simulate.mockReset().mockResolvedValue({ ok: true });
    mkt.createCoupon.mockReset().mockResolvedValue({ id: 'cup', code: 'ANIV-X', expires_at: '2026-12-31' });
    modelosStore.resolverParaEnvio.mockReset().mockImplementation(async (c, key) => ({
      templateName: 'aura_' + key, language: 'pt_BR', pronto: true,
      texto: 'Oi, {Nome}. Aniversario na {Nome da loja}: {Presente} ate {Validade}, codigo {Código}.',
    }));
    db.query.mockImplementation(async (sql) => {
      if (/wa:auto-linhas/.test(sql)) return { rows: [{ automatica: 'aniversario', ligada: true, config: { tom: 'carinhoso', presente: { tipo: 'percent', valor: 10 }, quando } }] };
      if (/wa:auto-divisao\b/.test(sql)) return { rows: [{ aniversario: 4, venda_mais: 4, crediario: 2 }] };
      if (/wa:publico-aniversario/.test(sql)) return { rows: [cli(1, { dia: hojeAniv }), cli(2, { dia: hojeAniv + 1 })] };
      return { rows: [] };
    });
  }

  test.each([
    ['no_dia', 10, 'aura_aniv_carinhoso_com'],
    ['3_dias_antes', 13, 'aura_aniv_antes'],
    ['7_dias_antes', 17, 'aura_aniv_antes'],
  ])('%s: sai uma vez, no dia certo, com o modelo certo', async (quando, diaDoAniversario, modelo) => {
    simularAniv(quando, diaDoAniversario);
    const r = await executor.rodar(COMPANY, 'aniversario', { hoje: '2026-12-10' });
    expect(r.enfileiradas).toBe(1);
    const args = waOutbox.enqueue.mock.calls[0][0];
    expect(args.customerId).toBe('c1');
    expect(args.templateName).toBe(modelo);
    expect(args.dedupeKey).toBe('aniv-c1-2026');
  });

  test('fora do dia escolhido ninguém sai', async () => {
    simularAniv('3_dias_antes', 20);
    expect((await executor.rodar(COMPANY, 'aniversario', { hoje: '2026-12-10' })).enfileiradas).toBe(0);
  });
});
