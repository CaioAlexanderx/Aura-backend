// ============================================================
// AURA. — Avisos no celular: venda, crediário e orçamento (04/11/2026)
//
// Pedido do PO: push do PWA para venda realizada, valor recebido no
// crediário e orçamento aprovado (o pedido da loja online já existia).
// O que este arquivo trava:
//   1. quem recebe: dono, acesso total e Financeiro; nunca quem causou o
//      evento; quem fez o orçamento entra mesmo sem Financeiro;
//   2. o push mira usuários (web_push_subscriptions.user_id) — os tipos
//      antigos seguem avisando a empresa inteira, com a chamada de sempre;
//   3. venda é SÓ push (não vira linha no sino) e agrupa em rajada;
//   4. crediário e orçamento entram no sino, com dedupe e entidade;
//   5. os textos, como a lojista lê no celular;
//   6. a recarga do que o texto consome, e a loja no corpo quando a conta
//      tem mais de um CNPJ.
//
// Mock do db despacha por CONTEÚDO DO SQL, nunca por ordem de chamada.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const appNotifications = require('../src/services/appNotifications');
const webPush = require('../src/services/webPush');
const destinatariosDoAviso = require('../src/services/destinatariosDoAviso');
const rajadaDeVendas = require('../src/services/rajadaDeVendas');
const lojaEvents = require('../src/services/lojaEvents');
const { avisarRecebimento } = require('../src/services/credit/avisoDeRecebimento');

const CID = 'c0000000-0000-0000-0000-000000000001';
const DONA = 'u0000000-0000-0000-0000-00000000d0d0';
const GERENTE = 'u0000000-0000-0000-0000-00000000a111';
const FINANCEIRO = 'u0000000-0000-0000-0000-00000000f111';
const CAIXA = 'u0000000-0000-0000-0000-00000000c111';
const SALE = 'a0000000-0000-0000-0000-00000000ab12';
const CLIENTE = 'b0000000-0000-0000-0000-0000000c1111';
const QUOTE = 'd0000000-0000-0000-0000-00000000q012';

const VENDA_DB = {
  id: SALE, company_id: CID, total: '129.90', sale_number: 1042, payment_method: 'pix',
  customer_id: CLIENTE, vendedor: 'Bianca', customer_name: 'Maria',
};

// A equipe que o SELECT de destinatários devolve (dono + quem passa na regra).
let equipe;
let empresa; // { nome, n } para o nome da loja no grupo
let vendaDb;

function mockDb() {
  db.query.mockImplementation((sql, params) => {
    if (/company_notification_prefs/i.test(sql)) return Promise.resolve({ rows: [] });
    if (/jsonb_each_text\(cm\.permissions\)/i.test(sql)) {
      return Promise.resolve({ rows: equipe.map((user_id) => ({ user_id })) });
    }
    if (/FROM companies c WHERE c\.id/i.test(sql)) return Promise.resolve({ rows: empresa ? [empresa] : [] });
    if (/FROM sales s/i.test(sql)) return Promise.resolve({ rows: vendaDb ? [vendaDb] : [] });
    if (/SELECT name FROM customers/i.test(sql)) return Promise.resolve({ rows: [{ name: 'Maria' }] });
    if (/FROM matcon_quotes WHERE id/i.test(sql)) {
      return Promise.resolve({ rows: [{ id: QUOTE, company_id: CID, number: 12, customer_name: 'Maria', total: '1200', created_by: CAIXA, seller_id: null }] });
    }
    if (/FROM studio_quotes WHERE id/i.test(sql)) {
      return Promise.resolve({ rows: [{ id: QUOTE, company_id: CID, customer_name: 'Maria', total: '1200', created_by: CAIXA }] });
    }
    if (/UPDATE app_notifications SET entity_ref/i.test(sql)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

let linhaCriada;
beforeEach(() => {
  jest.resetAllMocks();
  jest.useRealTimers();
  lojaEvents._resetCaches();
  destinatariosDoAviso._resetCache();
  rajadaDeVendas._reset();
  equipe = [DONA, GERENTE, FINANCEIRO];
  empresa = { nome: 'Loja Centro', n: 1 };
  vendaDb = VENDA_DB;
  linhaCriada = { id: 'n1' };
  mockDb();
  jest.spyOn(appNotifications, 'notifyCompany').mockImplementation(() => Promise.resolve(linhaCriada));
  jest.spyOn(webPush, 'notifyCompany').mockResolvedValue({ enviados: 1, removidos: 0, falhas: 0 });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rajadaDeVendas._reset();
  jest.restoreAllMocks();
});

const esperarPush = () => new Promise((r) => setImmediate(r));
// Com fake timers o setImmediate e falso: esvazia as microtasks na mao.
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const pushes = () => webPush.notifyCompany.mock.calls;

// ── 1. Quem recebe ────────────────────────────────────────────────────
describe('destinatarios', () => {
  test('dono + membro ativo com acesso total ou a chave; a chave vai no SQL', async () => {
    const ids = await destinatariosDoAviso.destinatarios(CID, { chaves: ['financeiro'] });
    expect(ids.sort()).toEqual([DONA, GERENTE, FINANCEIRO].sort());
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/owner_id AS user_id FROM companies/);
    expect(sql).toMatch(/cm\.permissions IS NULL/);
    expect(sql).toMatch(/status = 'active' AND cm\.is_active = true/);
    expect(params).toEqual([CID, ['financeiro']]);
  });

  test('exceto tira quem causou o evento; incluir soma quem o evento quer', async () => {
    const ids = await destinatariosDoAviso.destinatarios(CID, { exceto: DONA, incluir: [CAIXA, null] });
    expect(ids.sort()).toEqual([GERENTE, FINANCEIRO, CAIXA].sort());
  });

  test('cache de 60s: duas chamadas, um SELECT', async () => {
    await destinatariosDoAviso.destinatarios(CID);
    await destinatariosDoAviso.destinatarios(CID);
    expect(db.query.mock.calls.filter(([s]) => /jsonb_each_text/.test(s))).toHaveLength(1);
  });

  test('falha ao ler a equipe: sobra o dono, o aviso nao cala', async () => {
    db.query.mockImplementation((sql) => {
      if (/jsonb_each_text/.test(sql)) return Promise.reject(new Error('timeout'));
      if (/SELECT owner_id FROM companies/.test(sql)) return Promise.resolve({ rows: [{ owner_id: DONA }] });
      return Promise.resolve({ rows: [] });
    });
    expect(await destinatariosDoAviso.destinatarios(CID)).toEqual([DONA]);
  });
});

// ── 2. O push mira usuarios ───────────────────────────────────────────
describe('webPush.notifyCompany com userIds', () => {
  beforeEach(() => { webPush.notifyCompany.mockRestore(); global.fetch = jest.fn(); });

  test('com userIds, o SELECT filtra por user_id', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await webPush.notifyCompany(CID, { title: 'x' }, { userIds: [DONA, GERENTE] });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/user_id = ANY\(\$2::uuid\[\]\)/);
    expect(params).toEqual([CID, [DONA, GERENTE]]);
  });

  test('lista vazia: ninguem recebe e o banco nem e consultado', async () => {
    expect(await webPush.notifyCompany(CID, { title: 'x' }, { userIds: [] })).toEqual({ enviados: 0, removidos: 0, falhas: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sem opts: a consulta de sempre, da empresa inteira', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await webPush.notifyCompany(CID, { title: 'x' });
    expect(db.query.mock.calls[0][0]).not.toMatch(/user_id/);
  });
});

// ── 3. Venda realizada ────────────────────────────────────────────────
describe('loja_venda_realizada', () => {
  test('so push: nao vira linha no sino; vai para a equipe do dinheiro menos quem vendeu', async () => {
    const r = await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: SALE, company_id: CID }, { exceto: FINANCEIRO });
    await esperarPush();
    expect(appNotifications.notifyCompany).not.toHaveBeenCalled();
    expect(r).toMatchObject({ so_push: true });
    expect(pushes()).toHaveLength(1);
    const [cid, aviso, opts] = pushes()[0];
    expect(cid).toBe(CID);
    expect(opts.userIds.sort()).toEqual([DONA, GERENTE].sort());
    expect(aviso.title).toBe('Venda realizada · R$ 129,90');
    expect(aviso.body).toBe('#1042 · Pix · Bianca vendeu para Maria.');
    expect(aviso.url).toBe(`/vendas?sale_id=${SALE}`);
    expect(aviso.tag).toBe(`venda:${CID}`);
    expect(aviso.type).toBe('loja_venda_realizada');
  });

  test('recarrega a venda pelo id (vendedor, cliente, numero, meio)', async () => {
    await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: SALE, company_id: CID, total: '129.90' });
    await esperarPush();
    const sql = db.query.mock.calls.find(([s]) => /FROM sales s/.test(s))[0];
    expect(sql).toMatch(/COALESCE\(s\.seller_name, e\.name, u\.full_name\) AS vendedor/);
    expect(pushes()[0][1].body).toContain('Bianca vendeu para Maria');
  });

  test('sem vendedor nem cliente o corpo nao fica com pedaco solto', async () => {
    vendaDb = { ...VENDA_DB, vendedor: null, customer_name: null, payment_method: 'dinheiro' };
    await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: SALE, company_id: CID });
    await esperarPush();
    expect(pushes()[0][1].body).toBe('#1042 · Dinheiro.');
  });

  test('conta com mais de um CNPJ: a loja entra no corpo', async () => {
    empresa = { nome: 'Filial Centro', n: 2 };
    await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: SALE, company_id: CID });
    await esperarPush();
    expect(pushes()[0][1].body).toBe('#1042 · Pix · Bianca vendeu para Maria · Filial Centro.');
  });

  test('valor com milhar: R$ 1.240,00', async () => {
    vendaDb = { ...VENDA_DB, total: '1240' };
    await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: SALE, company_id: CID });
    await esperarPush();
    expect(pushes()[0][1].title).toBe('Venda realizada · R$ 1.240,00');
  });

  test('preferencia desligada: nada sai', async () => {
    db.query.mockImplementation((sql) => {
      if (/company_notification_prefs/.test(sql)) return Promise.resolve({ rows: [{ event_type: 'loja_venda_realizada', enabled: false }] });
      return Promise.resolve({ rows: [] });
    });
    expect(await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: SALE, company_id: CID })).toBeNull();
    await esperarPush();
    expect(pushes()).toHaveLength(0);
  });

  test('ninguem na regra (dono e quem vendeu): o push nem e chamado', async () => {
    equipe = [DONA];
    await lojaEvents.emitLojaEvent('loja_venda_realizada', { id: SALE, company_id: CID }, { exceto: DONA });
    await esperarPush();
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][2].userIds).toEqual([]);
  });

  test('rajada: a 1a vai na hora, as seguintes viram UM resumo no fim da janela, para todo mundo', async () => {
    jest.useFakeTimers();
    const emitir = (total, i) => lojaEvents.emitLojaEvent('loja_venda_realizada',
      { ...VENDA_DB, id: `${SALE.slice(0, -2)}${i}${i}`, total }, { exceto: FINANCEIRO });
    await emitir('100', 1); await tick();
    await emitir('200', 2); await tick();
    await emitir('940', 3); await tick();
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1].title).toBe('Venda realizada · R$ 100,00');

    jest.advanceTimersByTime(rajadaDeVendas.JANELA_MS + 5);
    await tick(); // o resumo passa por destinatarios (promise) antes do push
    expect(pushes()).toHaveLength(2);
    const [, resumo, opts] = pushes()[1];
    expect(resumo.title).toBe('2 vendas nos últimos minutos · R$ 1.140,00');
    expect(resumo.body).toBe('Toque para ver as vendas.');
    expect(resumo.url).toBe('/vendas');
    expect(resumo.tag).toBe(`venda:${CID}`);
    expect(opts.userIds.sort()).toEqual([DONA, GERENTE, FINANCEIRO].sort());

    // janela que fecha vazia: a proxima venda volta a sair na hora
    jest.advanceTimersByTime(rajadaDeVendas.JANELA_MS + 5);
    await emitir('50', 4); await tick();
    expect(pushes()).toHaveLength(3);
    expect(pushes()[2][1].title).toBe('Venda realizada · R$ 50,00');
  });
});

// ── 4. Recebido no crediario ──────────────────────────────────────────
describe('loja_crediario_recebido', () => {
  const PAG = { id: 'tx-1', company_id: CID, customer_id: CLIENTE, amount: 150, method: 'pix', new_balance: 350 };

  test('sino + push, dedupe pela transacao, entidade = cliente', async () => {
    await lojaEvents.emitLojaEvent('loja_crediario_recebido', PAG, { exceto: CAIXA });
    await esperarPush();
    expect(appNotifications.notifyCompany).toHaveBeenCalledTimes(1);
    const linha = appNotifications.notifyCompany.mock.calls[0][1];
    expect(linha.type).toBe('loja_crediario_recebido');
    expect(linha.dedupeKey).toBe('loja:crediario_recebido:tx-1');
    expect(linha.title).toBe('Recebido no crediário · R$ 150,00');
    expect(linha.body).toBe('Maria pagou R$ 150,00 no Pix. Ainda falta R$ 350,00.');
    expect(linha.ctaRoute).toBe(`/crediario?customer_id=${CLIENTE}`);
    const upd = db.query.mock.calls.find(([s]) => /UPDATE app_notifications SET entity_ref/.test(s));
    expect(upd[1]).toEqual([`cliente:${CLIENTE}`, 'Maria', 'n1']);
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1].tag).toBe(`cliente:${CLIENTE}`);
    expect(pushes()[0][2].userIds.sort()).toEqual([DONA, GERENTE, FINANCEIRO].sort());
  });

  test('carne quitado', async () => {
    await lojaEvents.emitLojaEvent('loja_crediario_recebido', { ...PAG, new_balance: 0, method: 'dinheiro' });
    expect(appNotifications.notifyCompany.mock.calls[0][1].body).toBe('Maria pagou R$ 150,00 no Dinheiro. Carnê quitado.');
  });

  test('dedupe: linha que ja existia nao toca o celular', async () => {
    linhaCriada = null;
    await lojaEvents.emitLojaEvent('loja_crediario_recebido', PAG);
    await esperarPush();
    expect(pushes()).toHaveLength(0);
  });

  test('avisarRecebimento: replay idempotente e transacao ausente nao avisam', () => {
    const emit = jest.spyOn(lojaEvents, 'emit').mockImplementation(() => {});
    avisarRecebimento({ companyId: CID, customerId: CLIENTE, result: { replayed: true, transaction: { id: 'tx' } }, amount: 10 });
    avisarRecebimento({ companyId: CID, customerId: CLIENTE, result: { transaction: null }, amount: 10 });
    avisarRecebimento({ companyId: CID, customerId: CLIENTE, result: null, amount: 10 });
    expect(emit).not.toHaveBeenCalled();
    avisarRecebimento({ companyId: CID, customerId: CLIENTE, result: { transaction: { id: 'tx-9' }, new_balance: 20 }, amount: '10', method: 'pix', userId: CAIXA });
    expect(emit).toHaveBeenCalledWith('loja_crediario_recebido',
      { id: 'tx-9', company_id: CID, customer_id: CLIENTE, amount: 10, method: 'pix', new_balance: 20 },
      { exceto: CAIXA });
  });
});

// ── 5. Orcamento aprovado ─────────────────────────────────────────────
describe('loja_orcamento_aprovado', () => {
  test('aceite pelo link (Matcon): recarrega o orcamento, quem fez recebe mesmo sem Financeiro', async () => {
    await lojaEvents.emitLojaEvent('loja_orcamento_aprovado', { id: QUOTE, company_id: CID, vertical: 'matcon', origem: 'link' });
    await esperarPush();
    const linha = appNotifications.notifyCompany.mock.calls[0][1];
    expect(linha.dedupeKey).toBe(`loja:orcamento_aprovado:${QUOTE}`);
    expect(linha.title).toBe('Orçamento aprovado · R$ 1.200,00');
    expect(linha.body).toBe('Maria aceitou o orçamento #12 pelo link. Combine pagamento e entrega.');
    expect(linha.ctaRoute).toBe('/matcon/orcamentos');
    const [, aviso, opts] = pushes()[0];
    expect(aviso.tag).toBe(`orcamento:${QUOTE}`);
    expect(opts.userIds.sort()).toEqual([DONA, GERENTE, FINANCEIRO, CAIXA].sort());
  });

  test('virou venda (Studio): texto, rota do Studio, quem clicou nao recebe', async () => {
    await lojaEvents.emitLojaEvent('loja_orcamento_aprovado',
      { id: QUOTE, company_id: CID, vertical: 'studio', origem: 'venda', customer_name: 'Maria', total: 1200, created_by: CAIXA },
      { exceto: DONA });
    await esperarPush();
    const linha = appNotifications.notifyCompany.mock.calls[0][1];
    expect(linha.body).toBe(`O orçamento #${QUOTE.slice(0, 8)} de Maria virou venda.`);
    expect(linha.ctaRoute).toBe(`/studio/gestao/orcamentos/${QUOTE}`);
    expect(pushes()[0][2].userIds.sort()).toEqual([GERENTE, FINANCEIRO, CAIXA].sort());
  });

  test('uma vez por orcamento: aceitou pelo link e depois virou venda = um aviso', async () => {
    await lojaEvents.emitLojaEvent('loja_orcamento_aprovado', { id: QUOTE, company_id: CID, vertical: 'matcon', origem: 'link' });
    linhaCriada = null; // a 2a cai na dedupe do indice unico
    await lojaEvents.emitLojaEvent('loja_orcamento_aprovado', { id: QUOTE, company_id: CID, vertical: 'matcon', origem: 'venda' });
    await esperarPush();
    expect(appNotifications.notifyCompany.mock.calls.map(([, p]) => p.dedupeKey)).toEqual([
      `loja:orcamento_aprovado:${QUOTE}`, `loja:orcamento_aprovado:${QUOTE}`,
    ]);
    expect(pushes()).toHaveLength(1);
  });
});

// ── 6. Os tipos antigos nao mudaram ───────────────────────────────────
test('pedido novo segue avisando a empresa inteira, com a chamada de sempre', async () => {
  db.query.mockImplementation((sql) => {
    if (/FROM digital_orders/.test(sql)) return Promise.resolve({ rows: [{ id: 'o1', company_id: CID, order_number: '7', total: '10' }] });
    return Promise.resolve({ rows: [] });
  });
  await lojaEvents.emitLojaEvent('loja_pedido_novo', { id: 'o1', company_id: CID });
  await esperarPush();
  expect(pushes()[0]).toHaveLength(2);
  expect(db.query.mock.calls.some(([s]) => /jsonb_each_text/.test(s))).toBe(false);
});

test('os tres entram na tela de preferencias, ligados por padrao', async () => {
  const cat = await lojaEvents.effectivePrefs(CID);
  for (const t of ['loja_venda_realizada', 'loja_crediario_recebido', 'loja_orcamento_aprovado']) {
    const linha = cat.find((c) => c.type === t);
    expect(linha).toBeTruthy();
    expect(linha.enabled).toBe(true);
    expect(lojaEvents.isPrefKey(t)).toBe(true);
  }
});
