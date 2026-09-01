// ============================================================
// AURA. — Eventos duráveis da loja online (migration 315)
//
// O sino da loja só sabia "chegou pedido", e olhando uma janela de 24h em
// digital_orders. Quem não abrisse o app em 24h perdia o aviso, e tudo que
// acontece DEPOIS do pedido não existia. Este arquivo trava as três coisas
// que, se saírem do lugar, quebram em silêncio:
//
//   1. dedupe_key — é a ÚNICA idempotência dos disparos. Webhook do Asaas/MP
//      reenviado, job de Pix rodando a cada 10min: se a chave mudar de forma,
//      o índice único parcial (285) para de casar e o sino duplica.
//   2. preferências — o gate é na ESCRITA. Um bug aqui não aparece como erro,
//      aparece como 200 sinos num dia (ou como silêncio).
//   3. recarga do pedido — 17/08/2026 já custou "R$ NaN" no push do lojista
//      porque cada caller montava o `order` com um SELECT próprio. Aqui o
//      caller pode passar só o id.
//
// Mock do db despacha por CONTEÚDO DO SQL, nunca por ordem de chamada.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const appNotifications = require('../src/services/appNotifications');
const lojaEvents = require('../src/services/lojaEvents');

const CID = 'c0000000-0000-0000-0000-000000000001';
const OID = 'bb2ffcea-0000-0000-0000-000000000009';

const ORDER = {
  id: OID,
  company_id: CID,
  order_number: '00042',
  customer_name: 'Davi Calçados',
  total: '129.90',
  vertical: null,
  courier_name: null,
  courier_plate: null,
};

// Roteia por SQL: preferências vs recarga do pedido.
function mockDb({ prefs = [], order = ORDER, prefsError = null } = {}) {
  db.query.mockImplementation((sql) => {
    if (/company_notification_prefs/i.test(sql)) {
      if (prefsError) return Promise.reject(prefsError);
      return Promise.resolve({ rows: prefs });
    }
    if (/FROM digital_orders/i.test(sql)) {
      return Promise.resolve({ rows: order ? [order] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

let created;
beforeEach(() => {
  jest.resetAllMocks();
  lojaEvents._resetCaches();
  created = [];
  jest.spyOn(appNotifications, 'notifyCompany').mockImplementation((cid, payload) => {
    created.push({ cid, ...payload });
    return Promise.resolve({ id: 'n1', ...payload });
  });
});
afterEach(() => jest.restoreAllMocks());

// ── Taxonomia ─────────────────────────────────────────────────────────
describe('taxonomia', () => {
  test('todo tipo comeca com loja_ e tem severidade valida', () => {
    for (const t of lojaEvents.TYPES) {
      expect(t.startsWith('loja_')).toBe(true);
      expect(['info', 'atencao', 'critico']).toContain(lojaEvents.severityOf(t));
    }
  });

  test('os 10 eventos do grupo A existem', () => {
    [
      'loja_pedido_novo', 'loja_pedido_pago', 'loja_comprovante_enviado',
      'loja_pix_expirado', 'loja_pedido_cancelado', 'loja_pedido_entregue',
      'loja_sinal_pago', 'loja_pedido_saiu_entrega', 'loja_estoque_baixo',
      'loja_sem_pagamento_configurado',
    ].forEach((t) => expect(lojaEvents.TYPES).toContain(t));
  });

  // A régua combinada com o cliente: o que EXIGE ação humana não pode ser
  // 'info', senão o app pinta igual a "pedido entregue" e ninguém age.
  test('o que exige acao humana nao e info', () => {
    expect(lojaEvents.severityOf('loja_comprovante_enviado')).toBe('atencao');
    expect(lojaEvents.severityOf('loja_pix_expirado')).toBe('atencao');
    expect(lojaEvents.severityOf('loja_estoque_baixo')).toBe('atencao');
    expect(lojaEvents.severityOf('loja_sem_pagamento_configurado')).toBe('critico');
    expect(lojaEvents.severityOf('loja_pedido_entregue')).toBe('info');
  });

  test('tipo desconhecido (banner da Gestao Aura) cai em info sem estourar', () => {
    expect(lojaEvents.severityOf('banner')).toBe('info');
    expect(lojaEvents.severityOf(undefined)).toBe('info');
  });
});

// ── dedupe_key ────────────────────────────────────────────────────────
describe('dedupe_key', () => {
  test('formato loja:<evento>:<order_id>', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_pedido_pago', ORDER);
    expect(created[0].dedupeKey).toBe(`loja:pedido_pago:${OID}`);
    expect(created[0].type).toBe('loja_pedido_pago');
    expect(created[0].cid).toBe(CID);
  });

  // O webhook do Asaas reenvia o mesmo evento; o job de Pix roda a cada
  // 10min pelos 7 dias da janela. A idempotencia mora na CHAVE, entao ela
  // tem que ser identica entre chamadas com recortes diferentes do pedido.
  test('mesma chave quando o caller passa so o id', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_pedido_pago', ORDER);
    await lojaEvents.emitLojaEvent('loja_pedido_pago', { id: OID, company_id: CID });
    expect(created[0].dedupeKey).toBe(created[1].dedupeKey);
  });

  test('dedupeSuffix substitui o pedido nos eventos sem pedido', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_sem_pagamento_configurado',
      { company_id: CID }, { dedupeSuffix: `${CID}:2026-09-01` });
    expect(created[0].dedupeKey).toBe(`loja:sem_pagamento_configurado:${CID}:2026-09-01`);
  });

  test('sem id e sem dedupeSuffix nao cria nada (chave nula duplicaria)', async () => {
    mockDb();
    const r = await lojaEvents.emitLojaEvent('loja_estoque_baixo', { company_id: CID });
    expect(r).toBeNull();
    expect(created).toHaveLength(0);
  });
});

// ── Preferências ──────────────────────────────────────────────────────
describe('preferencias', () => {
  test('default: pedido novo liga, pedido entregue nao', async () => {
    mockDb({ prefs: [] });
    expect(await lojaEvents.isEnabled(CID, 'loja_pedido_novo')).toBe(true);
    expect(await lojaEvents.isEnabled(CID, 'loja_pedido_entregue')).toBe(false);
  });

  test('todo evento atencao/critico vem ligado por padrao', async () => {
    mockDb({ prefs: [] });
    for (const e of lojaEvents.listEventTypes()) {
      if (e.severity !== 'info') expect(e.default_enabled).toBe(true);
    }
  });

  test('linha na tabela sobrescreve o default nos dois sentidos', async () => {
    mockDb({ prefs: [
      { event_type: 'loja_pedido_novo', enabled: false },
      { event_type: 'loja_pedido_entregue', enabled: true },
    ] });
    expect(await lojaEvents.isEnabled(CID, 'loja_pedido_novo')).toBe(false);
    expect(await lojaEvents.isEnabled(CID, 'loja_pedido_entregue')).toBe(true);
  });

  // O gate e na ESCRITA: evento desligado nao vira linha em app_notifications.
  test('evento desligado nao cria notificacao', async () => {
    mockDb({ prefs: [{ event_type: 'loja_pedido_novo', enabled: false }] });
    const r = await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
    expect(r).toBeNull();
    expect(appNotifications.notifyCompany).not.toHaveBeenCalled();
  });

  // Formato Record<type, boolean> — o que o app consome (01/09/2026).
  test('prefsRecord devolve booleano para TODO tipo + app_banner', async () => {
    mockDb({ prefs: [] });
    const rec = await lojaEvents.prefsRecord(CID);
    expect(Object.keys(rec).sort()).toEqual([...lojaEvents.TYPES, 'app_banner'].sort());
    expect(Object.values(rec).every((v) => typeof v === 'boolean')).toBe(true);
    expect(rec.loja_pedido_novo).toBe(true);
    expect(rec.loja_pedido_entregue).toBe(false);
  });

  // app_banner NAO e evento: e o interruptor das "Novidades da Aura", e o
  // gate dele e na LEITURA (banner nao e criado por empresa).
  test('app_banner: ligado por padrao, desligavel, e nao e tipo de evento', async () => {
    mockDb({ prefs: [] });
    expect(await lojaEvents.isBannerEnabled(CID)).toBe(true);
    expect(lojaEvents.isLojaType('app_banner')).toBe(false);
    expect(lojaEvents.isPrefKey('app_banner')).toBe(true);
    lojaEvents._resetCaches();
    mockDb({ prefs: [{ event_type: 'app_banner', enabled: false }] });
    expect(await lojaEvents.isBannerEnabled(CID)).toBe(false);
  });

  test('effectivePrefs marca o que a empresa customizou', async () => {
    mockDb({ prefs: [{ event_type: 'loja_pedido_entregue', enabled: true }] });
    const prefs = await lojaEvents.effectivePrefs(CID);
    const entregue = prefs.find((p) => p.type === 'loja_pedido_entregue');
    const novo = prefs.find((p) => p.type === 'loja_pedido_novo');
    expect(entregue).toMatchObject({ enabled: true, customized: true, default_enabled: false });
    expect(novo).toMatchObject({ enabled: true, customized: false });
  });

  // Defensivo (CLAUDE.md, armadilha 1): antes da migration 315 a tabela nao
  // existe. Sem este ramo, TODO disparo morreria em 42P01.
  test('tabela ausente (42P01) cai no default em vez de calar o sino', async () => {
    const err = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    mockDb({ prefsError: err });
    expect(await lojaEvents.isEnabled(CID, 'loja_pedido_novo')).toBe(true);
    await lojaEvents.emitLojaEvent('loja_pedido_novo', ORDER);
    expect(created).toHaveLength(1);
  });

  test('cache de prefs e limpo por invalidatePrefs', async () => {
    mockDb({ prefs: [] });
    await lojaEvents.isEnabled(CID, 'loja_pedido_novo');
    const antes = db.query.mock.calls.filter((c) => /company_notification_prefs/.test(c[0])).length;
    await lojaEvents.isEnabled(CID, 'loja_pedido_pago'); // cache
    expect(db.query.mock.calls.filter((c) => /company_notification_prefs/.test(c[0])).length).toBe(antes);
    lojaEvents.invalidatePrefs(CID);
    await lojaEvents.isEnabled(CID, 'loja_pedido_pago');
    expect(db.query.mock.calls.filter((c) => /company_notification_prefs/.test(c[0])).length).toBe(antes + 1);
  });
});

// ── Recarga do pedido ─────────────────────────────────────────────────
describe('recarga do pedido', () => {
  // O bug de 17/08/2026 outra vez: caller com recorte incompleto -> "R$ NaN".
  test('caller que so tem id e company_id recebe total e numero do banco', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_pedido_pago', { id: OID, company_id: CID });
    expect(created[0].title).toContain('#00042');
    expect(created[0].body).toContain('R$ 129,90');
    expect(created[0].body).not.toContain('NaN');
  });

  test('pedido completo nao gasta SELECT', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_pedido_pago', ORDER);
    expect(db.query.mock.calls.filter((c) => /FROM digital_orders/.test(c[0]))).toHaveLength(0);
  });

  test('total ausente no banco vira "R$ —", nunca NaN', async () => {
    mockDb({ order: { ...ORDER, total: null } });
    await lojaEvents.emitLojaEvent('loja_pedido_pago', { id: OID, company_id: CID });
    expect(created[0].body).toContain('R$ —');
  });

  test('evento sem pedido nao tenta recarregar', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_sem_pagamento_configurado',
      { company_id: CID }, { dedupeSuffix: `${CID}:2026-09-01` });
    expect(db.query.mock.calls.filter((c) => /FROM digital_orders/.test(c[0]))).toHaveLength(0);
  });
});

// ── CTA ───────────────────────────────────────────────────────────────
// ── Entidade (agrupamento dos cards no app) ───────────────────────────
describe('entity_ref', () => {
  // O PREFIXO foi o ponto que o frontend levantou: sem ele, ids de TABELAS
  // diferentes podem coincidir e o app agrupa duas coisas sem relacao.
  test('evento de pedido grava pedido:<uuid> e o rotulo humano', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_pedido_pago', ORDER);
    const [sql, params] = db.query.mock.calls.find((c) => /SET entity_ref/.test(c[0]));
    expect(sql).toMatch(/UPDATE app_notifications/);
    expect(params[0]).toBe(`pedido:${OID}`);
    expect(params[1]).toBe('Pedido #00042');
  });

  test('evento sem pedido nao grava entidade', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_sem_pagamento_configurado',
      { company_id: CID }, { dedupeSuffix: `${CID}:2026-09-01` });
    expect(db.query.mock.calls.some((c) => /SET entity_ref/.test(c[0]))).toBe(false);
  });

  // Migration 315 ausente: perde o agrupamento, nao o aviso.
  test('coluna ausente (42703) nao impede a criacao do evento', async () => {
    const semColuna = Object.assign(new Error('column entity_ref does not exist'), { code: '42703' });
    db.query.mockImplementation((sql) => {
      if (/SET entity_ref/.test(sql)) return Promise.reject(semColuna);
      if (/company_notification_prefs/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [ORDER] });
    });
    const r = await lojaEvents.emitLojaEvent('loja_pedido_pago', ORDER);
    expect(r).not.toBeNull();
    expect(created).toHaveLength(1);
  });

  test('entityOf sempre prefixa, ou devolve null', () => {
    expect(lojaEvents.entityOf({}, { id: OID, order_number: '42' }))
      .toEqual({ ref: `pedido:${OID}`, label: 'Pedido #42' });
    expect(lojaEvents.entityOf({ orderless: true }, { id: OID })).toEqual({ ref: null, label: null });
    expect(lojaEvents.entityOf({}, {})).toEqual({ ref: null, label: null });
  });
});

describe('rota do CTA', () => {
  test('pedido do Studio vai para a tela do pedido; loja vai para /canal', () => {
    expect(lojaEvents.routeForOrder({ id: OID, vertical: 'studio' })).toBe(`/studio/pedidos/${OID}`);
    expect(lojaEvents.routeForOrder({ id: OID })).toBe(`/canal?tab=pedidos&order_id=${OID}`);
  });

  test('estoque baixo aponta para o estoque, nao para o pedido', async () => {
    mockDb();
    await lojaEvents.emitLojaEvent('loja_estoque_baixo',
      { id: OID, company_id: CID }, { body: 'Camisa preta (2 de mínimo 5)' });
    expect(created[0].ctaRoute).toBe('/estoque');
    expect(created[0].body).toBe('Camisa preta (2 de mínimo 5)');
  });
});

// ── A regra que não pode ser quebrada ─────────────────────────────────
describe('notificar nunca derruba o fluxo de origem', () => {
  // Sem o spy: o erro atravessa ate appNotifications, que e quem tem a
  // regra ("toda falha vira null"). Com o spy o INSERT nunca falharia e o
  // teste nao provaria nada.
  test('erro no banco vira null, nao excecao', async () => {
    appNotifications.notifyCompany.mockRestore();
    db.query.mockRejectedValue(new Error('boom'));
    await expect(lojaEvents.emitLojaEvent('loja_pedido_pago', ORDER)).resolves.toBeNull();
  });

  test('tipo desconhecido vira null, nao excecao', async () => {
    mockDb();
    await expect(lojaEvents.emitLojaEvent('loja_inventado', ORDER)).resolves.toBeNull();
  });

  test('company_id ausente vira null, nao excecao', async () => {
    mockDb({ order: null });
    await expect(lojaEvents.emitLojaEvent('loja_pedido_pago', {})).resolves.toBeNull();
  });

  test('emit() e fire-and-forget: nao devolve promise pendurada no caller', () => {
    db.query.mockRejectedValue(new Error('boom'));
    expect(() => lojaEvents.emit('loja_pedido_pago', ORDER)).not.toThrow();
  });
});
