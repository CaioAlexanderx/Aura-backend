// ============================================================
// AURA. -- services/placarDoDia + jobs/placarDoDiaJob (13/10/2026)
//
// Placar do dia no WhatsApp do dono. O que estes testes travam:
//   1. texto: vendas, ticket medio, mais vendido, comparacao com a media do
//      MESMO dia da semana do mes anterior, crediario recebido;
//   2. loja sem vendas / sem base de comparacao / sem crediario nao quebram;
//   3. temporada (01/11/2026 a 31/01/2027) e o campo `sempre`;
//   4. disparo no fechamento do caixa (e a virada de madrugada) e no job das
//      21h, UMA vez por dia por loja (dedupe entre fechamento e job);
//   5. sem canal (sem WhatsApp, sem telefone, template nao aprovado):
//      audit 'placar.sem_canal' uma vez e segue.
//
// Mock por CONTEUDO DO SQL (comentarios `-- placar:*`), nunca fila posicional.
// ============================================================
'use strict';

const db = require('../../src/config/database');
const placar = require('../../src/services/placarDoDia');
const job = require('../../src/jobs/placarDoDiaJob');
const { TEMPORADA, dentroDaTemporada } = require('../../src/services/temporada');

const LOJA_ID = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';

// 15/12/2026 e uma terca. Tercas de novembro/2026: 3, 10, 17 e 24.
const DIA = '2026-12-15';
const NOV = [
  { dia: '2026-11-03', qtd: 10, total: '1000.00' },
  { dia: '2026-11-10', qtd: 12, total: '2000.00' },
  { dia: '2026-11-17', qtd: 11, total: '1500.00' },
  { dia: '2026-11-24', qtd: 9, total: '1500.00' },
  // quarta: nao entra na media das tercas
  { dia: '2026-11-04', qtd: 99, total: '9999.00' },
];

// Banco falso. `outbox` e `audit` guardam o que foi gravado.
function bancoFake({
  loja = {},
  vendas = [{ dia: DIA, qtd: 12, total: '1680.00' }, ...NOV],
  destaque = { nome: 'Camiseta Azul', qtd: '8' },
  crediario = { qtd: 3, total: '350.00' },
  outbox = new Set(),
  auditJaTem = false,
  crediarioAusente = false,
} = {}) {
  const estado = { outbox, audit: [], queries: [] };
  const row = {
    id: LOJA_ID, loja: 'Loja Exemplo',
    placar_do_dia_enabled: true, placar_do_dia_sempre: false,
    owner_phone: '11988887777',
    ...loja,
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    estado.queries.push(s);
    if (/-- placar:loja/.test(s)) return Promise.resolve({ rows: row ? [row] : [] });
    if (/-- placar:vendas-por-dia/.test(s)) return Promise.resolve({ rows: vendas });
    if (/-- placar:mais-vendido/.test(s)) return Promise.resolve({ rows: destaque ? [destaque] : [] });
    if (/-- placar:crediario-recebido/.test(s)) {
      if (crediarioAusente) { const e = new Error('relation does not exist'); e.code = '42P01'; return Promise.reject(e); }
      return Promise.resolve({ rows: [crediario] });
    }
    if (/-- placar:ja-enfileirado/.test(s)) {
      return Promise.resolve({ rows: outbox.has(params[0]) ? [{ '?column?': 1 }] : [] });
    }
    if (/-- placar:sem-canal-ja-registrado/.test(s)) {
      return Promise.resolve({ rows: auditJaTem || estado.audit.length ? [{ '?column?': 1 }] : [] });
    }
    if (/INSERT INTO audit_log/.test(s)) {
      estado.audit.push({ companyId: params[0], action: params[1], detail: params[2] });
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  return estado;
}

// waOutbox falso: a fila grava a dedupe_key no mesmo Set que o banco consulta.
function waFake(estado, { connected = true, token_expired = false, enqueue = null } = {}) {
  return {
    normalizePhone: (raw) => {
      const d = String(raw || '').replace(/\D/g, '');
      return d.length >= 10 ? (d.startsWith('55') ? d : `55${d}`) : null;
    },
    connectionState: jest.fn(async () => ({ connected, token_expired })),
    enqueue: jest.fn(enqueue || (async (args) => {
      if (estado.outbox.has(args.dedupeKey)) return { queued: false, reason: 'DUPLICADO' };
      estado.outbox.add(args.dedupeKey);
      return { queued: true, id: `ob-${estado.outbox.size}`, status: 'pending' };
    })),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  job._resetForTests();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ── texto ───────────────────────────────────────────────────────
describe('montarPlacar -- texto', () => {
  test('vendas, ticket medio, mais vendido, comparacao e crediario', async () => {
    bancoFake();
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });

    expect(p.vendas).toEqual({ qtd: 12, total: 1680 });
    expect(p.ticket_medio).toBe(140);
    expect(p.mais_vendido).toEqual({ nome: 'Camiseta Azul', qtd: 8 });
    // media das tercas de novembro: (1000+2000+1500+1500)/4 = 1500; a quarta fica de fora
    expect(p.comparacao).toMatchObject({ media_total: 1500, variacao_pct: 12, ocorrencias: 4, dia_da_semana: 'terças', mes: 'novembro' });
    expect(p.crediario).toEqual({ qtd: 3, total: 350 });

    expect(p.parametros).toEqual([
      'Loja Exemplo',
      'terça, 15/12',
      '12 vendas, R$ 1.680,00',
      'R$ 140,00',
      'Camiseta Azul (8 un.)',
      '12% acima da média das terças de novembro (R$ 1.500,00)',
      'R$ 350,00 (3 pagamentos)',
    ]);
    expect(p.texto).toBe(
      'Placar do dia — Loja Exemplo, terça, 15/12. Vendas: 12 vendas, R$ 1.680,00. '
      + 'Ticket médio: R$ 140,00. Mais vendido: Camiseta Azul (8 un.). '
      + '12% acima da média das terças de novembro (R$ 1.500,00). '
      + 'Crediário recebido: R$ 350,00 (3 pagamentos). Bom descanso!'
    );
  });

  test('abaixo da media', async () => {
    bancoFake({ vendas: [{ dia: DIA, qtd: 8, total: '1200.00' }, ...NOV] });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });
    expect(p.comparacao.variacao_pct).toBe(-20);
    expect(p.parametros[5]).toBe('20% abaixo da média das terças de novembro (R$ 1.500,00)');
  });

  test('igual a media: "em linha"', async () => {
    bancoFake({ vendas: [{ dia: DIA, qtd: 10, total: '1500.00' }, ...NOV] });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });
    expect(p.parametros[5]).toBe('Em linha com a média das terças de novembro (R$ 1.500,00)');
  });

  test('loja sem vendas no dia: nao quebra, ticket e mais vendido viram "—"', async () => {
    bancoFake({ vendas: NOV, destaque: null, crediario: { qtd: 0, total: '0' } });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });

    expect(p.vendas).toEqual({ qtd: 0, total: 0 });
    expect(p.ticket_medio).toBeNull();
    expect(p.mais_vendido).toBeNull();
    expect(p.parametros[2]).toBe('nenhuma venda hoje');
    expect(p.parametros[3]).toBe('—');
    expect(p.parametros[4]).toBe('—');
    expect(p.comparacao.variacao_pct).toBe(-100);
    expect(p.parametros[5]).toBe('100% abaixo da média das terças de novembro (R$ 1.500,00)');
  });

  test('sem base de comparacao (mes anterior sem venda nesse dia da semana)', async () => {
    // so uma quarta em novembro: nenhuma terca vendeu
    bancoFake({ vendas: [{ dia: DIA, qtd: 2, total: '300.00' }, { dia: '2026-11-04', qtd: 5, total: '700.00' }] });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });
    expect(p.comparacao).toBeNull();
    expect(p.parametros[5]).toBe('Sem base de comparação com o mês anterior');
  });

  test('sem crediario: recebimento zero vira "nada hoje"', async () => {
    bancoFake({ crediario: { qtd: 0, total: '0' } });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });
    expect(p.crediario).toEqual({ qtd: 0, total: 0 });
    expect(p.parametros[6]).toBe('nada hoje');
    expect(p.texto).toMatch(/Crediário recebido: nada hoje\./);
  });

  test('loja sem a tabela do crediario (42P01): segue sem a linha', async () => {
    bancoFake({ crediarioAusente: true });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });
    expect(p.crediario).toEqual({ qtd: 0, total: 0 });
    expect(p.parametros[6]).toBe('nada hoje');
  });

  test('singular: 1 venda, 1 pagamento', async () => {
    bancoFake({ vendas: [{ dia: DIA, qtd: 1, total: '89.90' }, ...NOV], crediario: { qtd: 1, total: '50.00' } });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja Exemplo' });
    expect(p.parametros[2]).toBe('1 venda, R$ 89,90');
    expect(p.parametros[6]).toBe('R$ 50,00 (1 pagamento)');
  });

  test('parametros nunca levam quebra de linha nem ficam vazios (regra da Meta)', async () => {
    bancoFake({ destaque: { nome: 'Vestido\nlongo\tfloral', qtd: '2.5' } });
    const p = await placar.montarPlacar(LOJA_ID, DIA, { loja: 'Loja\nCentro' });
    expect(p.parametros).toHaveLength(7);
    for (const par of p.parametros) {
      expect(par).not.toMatch(/[\r\n\t]/);
      expect(par.trim().length).toBeGreaterThan(0);
    }
    expect(p.parametros[0]).toBe('Loja Centro');
    expect(p.parametros[4]).toBe('Vestido longo floral (2,5 un.)');
  });

  test('o mes anterior vira o ano: janeiro compara com dezembro', async () => {
    // 05/01/2027 e uma terca; tercas de dez/2026: 1, 8, 15, 22, 29
    const dez = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29']
      .map((dia) => ({ dia, qtd: 10, total: '1000.00' }));
    bancoFake({ vendas: [{ dia: '2027-01-05', qtd: 10, total: '1100.00' }, ...dez] });
    const p = await placar.montarPlacar(LOJA_ID, '2027-01-05', { loja: 'Loja Exemplo' });
    expect(p.comparacao).toMatchObject({ ocorrencias: 5, media_total: 1000, variacao_pct: 10, mes: 'dezembro' });
  });
});

// ── temporada ───────────────────────────────────────────────────
describe('temporada e o campo "sempre"', () => {
  test('dentroDaTemporada: 01/11/2026 a 31/01/2027, pontas inclusivas', () => {
    expect(dentroDaTemporada('2026-10-31')).toBe(false);
    expect(dentroDaTemporada('2026-11-01')).toBe(true);
    expect(dentroDaTemporada('2027-01-31')).toBe(true);
    expect(dentroDaTemporada('2027-02-01')).toBe(false);
    expect(TEMPORADA.starts_at).toBe('2026-11-01');
  });

  test.each([
    ['desligado', { placar_do_dia_enabled: false }, DIA, false, 'DESLIGADO'],
    ['ligado em plena temporada', {}, DIA, true, null],
    ['ligado, 1o dia da temporada', {}, '2026-11-01', true, null],
    ['ligado, ultimo dia da temporada', {}, '2027-01-31', true, null],
    ['ligado, antes da temporada', {}, '2026-10-31', false, 'FORA_DA_TEMPORADA'],
    ['ligado, depois da temporada', {}, '2027-02-01', false, 'FORA_DA_TEMPORADA'],
    ['ligado + sempre, fora da temporada', { placar_do_dia_sempre: true }, '2027-06-10', true, null],
    ['sempre mas desligado', { placar_do_dia_sempre: true, placar_do_dia_enabled: false }, '2027-06-10', false, 'DESLIGADO'],
    ['migration pendente (campo ausente)', { placar_do_dia_enabled: undefined }, DIA, false, 'DESLIGADO'],
  ])('%s', (_nome, extra, dia, ativo, motivo) => {
    const loja = { placar_do_dia_enabled: true, placar_do_dia_sempre: false, ...extra };
    expect(placar.ativoNoDia(loja, dia)).toEqual({ ativo, motivo });
  });

  test('enviarPlacar fora da temporada nao monta nem enfileira', async () => {
    const estado = bancoFake();
    const wa = waFake(estado);
    const r = await placar.enviarPlacar(LOJA_ID, { dia: '2027-02-01' }, { waOutbox: wa });
    expect(r).toMatchObject({ sent: false, reason: 'FORA_DA_TEMPORADA' });
    expect(wa.enqueue).not.toHaveBeenCalled();
    expect(estado.queries.some((q) => /placar:vendas-por-dia/.test(q))).toBe(false);
  });

  test('enviarPlacar fora da temporada, com "sempre" ligado, envia', async () => {
    const estado = bancoFake({ loja: { placar_do_dia_sempre: true }, vendas: [{ dia: '2027-06-08', qtd: 1, total: '10.00' }] });
    const wa = waFake(estado);
    const r = await placar.enviarPlacar(LOJA_ID, { dia: '2027-06-08' }, { waOutbox: wa });
    expect(r.sent).toBe(true);
    expect(wa.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ── envio ───────────────────────────────────────────────────────
describe('enviarPlacar', () => {
  test('enfileira o template placar_dia para o telefone do dono com os 7 parametros', async () => {
    const estado = bancoFake();
    const wa = waFake(estado);
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA, origem: 'fechamento' }, { waOutbox: wa });

    expect(r).toMatchObject({ sent: true, origem: 'fechamento', dia: DIA });
    expect(wa.enqueue).toHaveBeenCalledTimes(1);
    const args = wa.enqueue.mock.calls[0][0];
    expect(args).toMatchObject({
      companyId: LOJA_ID,
      toPhone: '5511988887777',
      kind: 'template',
      templateName: 'placar_dia',
      templateLanguage: 'pt_BR',
      sourceType: 'placar_dia',
      dedupeKey: `placar_dia:${LOJA_ID}:${DIA}`,
    });
    expect(args.components[0].type).toBe('body');
    expect(args.components[0].parameters).toHaveLength(7);
    expect(args.components[0].parameters[2]).toEqual({ type: 'text', text: '12 vendas, R$ 1.680,00' });
    expect(estado.audit).toHaveLength(0);
  });

  test('o corpo do template tem exatamente 7 variaveis e nao comeca nem termina em variavel', () => {
    const vars = placar.TEMPLATE.body.match(/\{\{\d\}\}/g);
    expect(vars).toEqual(['{{1}}', '{{2}}', '{{3}}', '{{4}}', '{{5}}', '{{6}}', '{{7}}']);
    expect(placar.TEMPLATE.body).not.toMatch(/^\{\{/);
    expect(placar.TEMPLATE.body).not.toMatch(/\}\}$/);
    expect(placar.TEMPLATE.category).toBe('UTILITY');
    expect(placar.TEMPLATE.example).toHaveLength(7);
  });

  test('uma vez por dia: segunda chamada no mesmo dia nao envia', async () => {
    const estado = bancoFake();
    const wa = waFake(estado);
    const a = await placar.enviarPlacar(LOJA_ID, { dia: DIA, origem: 'fechamento' }, { waOutbox: wa });
    const b = await placar.enviarPlacar(LOJA_ID, { dia: DIA, origem: 'job' }, { waOutbox: wa });
    const c = await placar.enviarPlacar(LOJA_ID, { dia: DIA, origem: 'fechamento' }, { waOutbox: wa });

    expect(a.sent).toBe(true);
    expect(b).toMatchObject({ sent: false, reason: 'JA_ENVIADO' });
    expect(c).toMatchObject({ sent: false, reason: 'JA_ENVIADO' });
    expect(wa.enqueue).toHaveBeenCalledTimes(1);
  });

  test('dia seguinte envia de novo', async () => {
    const estado = bancoFake({ vendas: [{ dia: '2026-12-16', qtd: 1, total: '10.00' }, ...NOV] });
    const wa = waFake(estado);
    await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: '2026-12-16' }, { waOutbox: wa });
    expect(r.sent).toBe(true);
    expect(wa.enqueue).toHaveBeenCalledTimes(2);
  });

  test('corrida entre duas instancias: DUPLICADO da fila tambem vira JA_ENVIADO', async () => {
    const estado = bancoFake();
    const wa = waFake(estado, { enqueue: async () => ({ queued: false, reason: 'DUPLICADO' }) });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    expect(r).toMatchObject({ sent: false, reason: 'JA_ENVIADO' });
    expect(estado.audit).toHaveLength(0);
  });

  test('loja inexistente ou migration 377 pendente (42703): desligado, sem erro', async () => {
    db.query.mockImplementation((sql) => {
      if (/-- placar:loja/.test(String(sql))) { const e = new Error('column does not exist'); e.code = '42703'; return Promise.reject(e); }
      return Promise.resolve({ rows: [] });
    });
    const wa = waFake({ outbox: new Set() });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    expect(r).toMatchObject({ sent: false, reason: 'DESLIGADO' });
    expect(wa.enqueue).not.toHaveBeenCalled();
  });
});

// ── sem canal ───────────────────────────────────────────────────
describe('sem canal: audit placar.sem_canal uma vez e segue', () => {
  test('sem WhatsApp conectado', async () => {
    const estado = bancoFake();
    const wa = waFake(estado, { connected: false });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });

    expect(r).toMatchObject({ sent: false, reason: 'SEM_CANAL', detail: 'whatsapp_nao_conectado' });
    expect(wa.enqueue).not.toHaveBeenCalled();
    expect(estado.audit).toEqual([{ companyId: LOJA_ID, action: 'placar.sem_canal', detail: 'whatsapp_nao_conectado' }]);
  });

  test('token expirado tem motivo proprio', async () => {
    const estado = bancoFake();
    const wa = waFake(estado, { connected: false, token_expired: true });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    expect(r.detail).toBe('whatsapp_token_expirado');
  });

  test('so grava UMA vez, mesmo em dias seguintes', async () => {
    const estado = bancoFake({ vendas: NOV });
    const wa = waFake(estado, { connected: false });
    await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    await placar.enviarPlacar(LOJA_ID, { dia: '2026-12-16' }, { waOutbox: wa });
    await placar.enviarPlacar(LOJA_ID, { dia: '2026-12-17' }, { waOutbox: wa });
    expect(estado.audit).toHaveLength(1);
  });

  test('ja registrado antes (outra instancia / outro dia): nao grava de novo', async () => {
    const estado = bancoFake({ auditJaTem: true });
    const wa = waFake(estado, { connected: false });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    expect(r.reason).toBe('SEM_CANAL');
    expect(estado.audit).toHaveLength(0);
  });

  test('sem telefone do dono', async () => {
    const estado = bancoFake({ loja: { owner_phone: null } });
    const wa = waFake(estado);
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    expect(r).toMatchObject({ sent: false, reason: 'SEM_CANAL', detail: 'telefone_do_dono_ausente' });
    expect(wa.enqueue).not.toHaveBeenCalled();
    expect(estado.audit).toHaveLength(1);
  });

  test('template nao aprovado na loja: a fila pula e o placar registra sem canal', async () => {
    const estado = bancoFake();
    const wa = waFake(estado, {
      enqueue: async () => ({ queued: false, id: 'ob-1', status: 'skipped', reason: 'TEMPLATE_NAO_APROVADO' }),
    });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    expect(r).toMatchObject({ sent: false, reason: 'SEM_CANAL', detail: 'template_nao_aprovado' });
    expect(estado.audit).toEqual([{ companyId: LOJA_ID, action: 'placar.sem_canal', detail: 'template_nao_aprovado' }]);
  });

  test('falha ao gravar o audit nao derruba o envio', async () => {
    const estado = bancoFake();
    const impl = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => (/INSERT INTO audit_log/.test(String(sql))
      ? Promise.reject(new Error('audit fora do ar'))
      : impl(sql, params)));
    const wa = waFake(estado, { connected: false });
    const r = await placar.enviarPlacar(LOJA_ID, { dia: DIA }, { waOutbox: wa });
    expect(r.reason).toBe('SEM_CANAL');
  });
});

// ── fechamento do caixa ─────────────────────────────────────────
describe('dispararNoFechamento', () => {
  test.each([
    ['fim da tarde', '2026-12-15T21:00:00Z', '2026-12-15'], // 18h BRT
    ['23h30 BRT', '2026-12-16T02:30:00Z', '2026-12-15'],
    ['00h30 BRT fecha o dia anterior', '2026-12-16T03:30:00Z', '2026-12-15'],
    ['03h59 BRT ainda e o dia anterior', '2026-12-16T06:59:00Z', '2026-12-15'],
    ['04h00 BRT ja e o novo dia', '2026-12-16T07:00:00Z', '2026-12-16'],
  ])('%s', (_n, closedAt, esperado) => {
    expect(placar.diaDoFechamento(new Date(closedAt))).toBe(esperado);
  });

  test('envia o placar do dia do fechamento', async () => {
    const estado = bancoFake();
    const wa = waFake(estado);
    const r = await placar.dispararNoFechamento(LOJA_ID, { closedAt: new Date('2026-12-15T21:00:00Z') }, { waOutbox: wa });
    expect(r).toMatchObject({ sent: true, origem: 'fechamento', dia: DIA });
  });

  test('nunca lanca: erro vira { sent:false, reason:"ERRO" }', async () => {
    db.query.mockRejectedValue(new Error('banco caiu'));
    const r = await placar.dispararNoFechamento(LOJA_ID, { closedAt: new Date() }, { waOutbox: waFake({ outbox: new Set() }) });
    expect(r).toEqual({ sent: false, reason: 'ERRO' });
  });
});

// ── job das 21h ─────────────────────────────────────────────────
describe('job das 21h BRT', () => {
  // Banco do job: lojas ligadas e quais tem caixa aberto.
  function bancoJob({ lojas = ['loja-a', 'loja-b', 'loja-c'], abertas = [] } = {}) {
    const q = jest.fn((sql, params) => {
      const s = String(sql);
      if (/-- placar:lojas-ligadas/.test(s)) return Promise.resolve({ rows: lojas.map((id) => ({ id })) });
      if (/-- placar:caixa-aberto/.test(s)) return Promise.resolve({ rows: abertas.includes(params[0]) ? [{ x: 1 }] : [] });
      return Promise.resolve({ rows: [] });
    });
    return { query: q };
  }

  test('21h: envia para quem nao fecha caixa e espera quem tem caixa aberto', async () => {
    const enviarPlacar = jest.fn(async () => ({ sent: true }));
    const r = await job.rodarDoDia(DIA, { esperarFechamento: true }, {
      db: bancoJob({ abertas: ['loja-b'] }), enviarPlacar,
    });
    expect(r).toMatchObject({ lojas: 3, enviados: 2, aguardando: 1, pulados: 0, erros: 0 });
    expect(enviarPlacar.mock.calls.map((c) => c[0])).toEqual(['loja-a', 'loja-c']);
    expect(enviarPlacar.mock.calls[0][1]).toEqual({ dia: DIA, origem: 'job' });
  });

  test('23h: nao espera mais o caixa esquecido aberto', async () => {
    const enviarPlacar = jest.fn(async () => ({ sent: true }));
    const r = await job.rodarDoDia(DIA, { esperarFechamento: false }, {
      db: bancoJob({ abertas: ['loja-b'] }), enviarPlacar,
    });
    expect(r.enviados).toBe(3);
    expect(r.aguardando).toBe(0);
  });

  test('uma loja com erro nao para as outras; ja enviada conta como pulada', async () => {
    const enviarPlacar = jest.fn(async (id) => {
      if (id === 'loja-a') throw new Error('falhou');
      if (id === 'loja-b') return { sent: false, reason: 'JA_ENVIADO' };
      return { sent: true };
    });
    const r = await job.rodarDoDia(DIA, {}, { db: bancoJob(), enviarPlacar });
    expect(r).toMatchObject({ enviados: 1, pulados: 1, erros: 1 });
  });

  test('migration 377 pendente: nenhuma loja, sem erro', async () => {
    const banco = { query: jest.fn(() => { const e = new Error('x'); e.code = '42703'; return Promise.reject(e); }) };
    const r = await job.rodarDoDia(DIA, {}, { db: banco, enviarPlacar: jest.fn() });
    expect(r.lojas).toBe(0);
  });

  describe('tick', () => {
    const agora = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000); // "BRT" do relogio do job
    const deps = (iso, extra = {}) => ({
      now: agora(iso), db: bancoJob({ lojas: ['loja-a'] }), enviarPlacar: jest.fn(async () => ({ sent: true })), ...extra,
    });

    test('antes das 21h BRT nao dispara', () => {
      expect(job.tick(deps('2026-12-15T23:59:00Z'))).toBeNull(); // 20h59 BRT
    });

    test('21h dispara uma vez; o tick do minuto seguinte nao repete', async () => {
      const d1 = deps('2026-12-16T00:00:00Z'); // 21h00 BRT
      const p1 = job.tick(d1);
      expect(p1).not.toBeNull();
      const r = await p1;
      expect(r).toMatchObject({ dia: '2026-12-15', enviados: 1 });
      expect(job.tick(deps('2026-12-16T00:01:00Z'))).toBeNull();
      expect(job.tick(deps('2026-12-16T01:30:00Z'))).toBeNull(); // 22h30
    });

    test('23h faz a segunda passada (caixa esquecido aberto), uma vez', async () => {
      await job.tick(deps('2026-12-16T00:00:00Z'));
      const d = deps('2026-12-16T02:00:00Z'); // 23h00 BRT
      const r = await job.tick(d);
      expect(r).not.toBeNull();
      expect(job.tick(deps('2026-12-16T02:05:00Z'))).toBeNull();
    });

    test('a passada das 21h espera o fechamento; a das 23h nao', async () => {
      const abertas = ['loja-a'];
      const noite = deps('2026-12-16T00:00:00Z', { db: bancoJob({ lojas: ['loja-a'], abertas }) });
      expect(await job.tick(noite)).toMatchObject({ enviados: 0, aguardando: 1 });
      const tarde = deps('2026-12-16T02:00:00Z', { db: bancoJob({ lojas: ['loja-a'], abertas }) });
      expect(await job.tick(tarde)).toMatchObject({ enviados: 1, aguardando: 0 });
    });

    test('no dia seguinte roda de novo', async () => {
      await job.tick(deps('2026-12-16T00:00:00Z'));
      const r = await job.tick(deps('2026-12-17T00:00:00Z'));
      expect(r).toMatchObject({ dia: '2026-12-16' });
    });

    test('kill switch PLACAR_DO_DIA_ENABLED=false', () => {
      process.env.PLACAR_DO_DIA_ENABLED = 'false';
      try {
        expect(job.tick(deps('2026-12-16T00:00:00Z'))).toBeNull();
      } finally {
        delete process.env.PLACAR_DO_DIA_ENABLED;
      }
    });
  });

  test('fechamento e job no mesmo dia: a loja recebe UM placar so', async () => {
    const outbox = new Set();
    const estado = bancoFake({ outbox });
    const wa = waFake(estado);
    // 1) o dono fecha o caixa as 18h
    const f = await placar.dispararNoFechamento(LOJA_ID, { closedAt: new Date('2026-12-15T21:00:00Z') }, { waOutbox: wa });
    // 2) o job das 21h varre a mesma loja
    const banco = {
      query: (sql, params) => (/-- placar:lojas-ligadas/.test(sql)
        ? Promise.resolve({ rows: [{ id: LOJA_ID }] })
        : /-- placar:caixa-aberto/.test(sql) ? Promise.resolve({ rows: [] })
          : db.query(sql, params)),
    };
    const r = await job.rodarDoDia(DIA, { esperarFechamento: true }, { db: banco, waOutbox: wa });

    expect(f.sent).toBe(true);
    expect(r).toMatchObject({ lojas: 1, enviados: 0, pulados: 1 });
    expect(wa.enqueue).toHaveBeenCalledTimes(1);
  });
});
