// ============================================================
// AURA — AURINHA DE PLANTÃO: fila de saída do WhatsApp com origem hub
//
// waOutbox.enqueueHub / processBatch com linhas de hub_conversation_id:
//  (1) enqueueHub: janela de 24h da CONVERSA — dentro: texto; fora: só
//      template aprovado; sem template (ou sem aprovação) a linha fica
//      'pending' com o MOTIVO e next_attempt_at='infinity' (o dispatcher
//      nunca a pega). Dedupe, telefone inválido, pausa, teto diário.
//      Teto POR CONTATO (2/dia) e opt-out de marketing não se aplicam.
//  (2) processBatch: envio ok grava status/wamid + espelho em
//      hub_messages; janela fechada na hora do envio → skipped; erro
//      transitório → retry com backoff; 5ª tentativa e erro permanente
//      → failed; conversa assumida por humano → a Aurinha não fala.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
}));

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const outbox = require('../src/services/waOutbox');

const AURA = '11111111-1111-4111-8111-111111111111';
const CONV = 'conv-hub-1';
const CLIENTE = '5511988887777';
const h = (n) => new Date(Date.now() - n * 3600000).toISOString();

let st; // estado do fake

function fake(over = {}) {
  st = {
    queries: [],
    inserted: [],          // params do INSERT de enqueueHub
    updates: [],           // markRow / retry
    mirror: [],            // hub_messages
    waMessages: [],
    dedupeSeen: new Set(),
    contact: null,         // linha de wa_contacts
    templateStatus: null,
    pauseReason: null,
    countToday: 0,
    pick: [],
    creds: { wa_phone_number_id: 'PN_AURA', wa_access_token: 'tok' },
    hubConv: { last_inbound_at: h(1), status: 'ia', ultima_mensagem_humana_em: null },
    insertError: null,
    ...over,
  };
  db.query.mockReset();
  db.query.mockImplementation((sql, params = []) => {
    const s = String(sql);
    st.queries.push({ sql: s, params });
    const rows = (r) => Promise.resolve({ rows: r });

    if (s.includes('-- wa:contact-get')) return rows(st.contact ? [st.contact] : []);
    if (s.includes('-- wa:guard-paused')) return rows(st.pauseReason ? [{ wa_paused_reason: st.pauseReason }] : []);
    if (s.includes('-- wa:guard-count-today')) return rows([{ n: st.countToday }]);
    if (s.includes('-- wa:guard-template')) return rows(st.templateStatus ? [{ status: st.templateStatus }] : []);
    if (s.includes('-- wa:outbox-enqueue-hub')) {
      if (st.insertError) return Promise.reject(st.insertError);
      const dk = params[10];
      if (dk && st.dedupeSeen.has(dk)) return rows([]);
      if (dk) st.dedupeSeen.add(dk);
      st.inserted.push({ sql: s, params });
      return rows([{ id: 'out-1', status: params[6] }]);
    }
    if (s.includes('-- wa:outbox-pick')) return rows(st.pick);
    if (s.includes('-- wa:creds')) return rows(st.creds ? [st.creds] : []);
    if (s.includes('-- wa:hub-conv')) return rows(st.hubConv ? [st.hubConv] : []);
    if (/INSERT INTO hub_messages/.test(s)) { st.mirror.push(params); return rows([]); }
    if (/INSERT INTO wa_messages/.test(s)) { st.waMessages.push(params); return rows([]); }
    if (/UPDATE hub_conversations SET last_message_at/.test(s)) return rows([]);
    let m = /UPDATE wa_outbox SET (.+), updated_at = NOW\(\) WHERE id = \$(\d+)/s.exec(s);
    if (m && !/attempts = \$1, last_error = \$2/.test(s)) {
      const fields = {};
      m[1].split(',').forEach((p, i) => { fields[p.split('=')[0].trim()] = params[i]; });
      st.updates.push({ id: params[Number(m[2]) - 1], ...fields });
      return rows([]);
    }
    if (/UPDATE wa_outbox SET attempts = \$1, last_error = \$2/.test(s)) {
      st.updates.push({ id: params[3], retry: true, attempts: params[0], last_error: params[1], backoffMin: Number(params[2]) });
      return rows([]);
    }
    return rows([]);
  });
}

const enq = (o = {}) => outbox.enqueueHub({
  companyId: AURA, conversationId: CONV, toPhone: CLIENTE, textBody: 'Oi! Aqui é a Aurinha.',
  sourceType: 'aurinha', dedupeKey: 'hub:aurinha:conv-hub-1:1', lastInboundAt: h(1), ...o,
});
// INSERT params: [company, phone, kind, templateName, templateLanguage, textBody, status,
//                 skipReason, sourceType, sourceId, dedupeKey, conversationId, held]
const ins = () => {
  const p = st.inserted[0].params;
  return {
    company: p[0], phone: p[1], kind: p[2], templateName: p[3], templateLanguage: p[4],
    textBody: p[5], status: p[6], skipReason: p[7], sourceType: p[8], dedupeKey: p[10],
    conversationId: p[11], held: p[12],
  };
};

beforeEach(() => {
  fake();
  wa.sendText.mockReset();
  wa.sendTemplate.mockReset();
});

// ── (1) enqueueHub ──────────────────────────────────────────
describe('enqueueHub — janela de 24h da conversa', () => {
  it('dentro das 24h: texto livre, pending, ligado à conversa do hub', async () => {
    const r = await enq();
    expect(r).toMatchObject({ queued: true, status: 'pending', held: false });
    expect(ins()).toMatchObject({
      company: AURA, phone: CLIENTE, kind: 'text', status: 'pending', skipReason: null,
      sourceType: 'aurinha', conversationId: CONV, held: false, dedupeKey: 'hub:aurinha:conv-hub-1:1',
    });
  });

  it('exatamente 23h59 → ainda dentro; 24h01 → fora', async () => {
    const dentro = await enq({ lastInboundAt: new Date(Date.now() - (24 * 3600000 - 60000)).toISOString() });
    expect(dentro.held).toBe(false);
    fake();
    const fora = await enq({ lastInboundAt: new Date(Date.now() - (24 * 3600000 + 60000)).toISOString() });
    expect(fora.held).toBe(true);
  });

  it('fora das 24h SEM template: fica pendente com motivo e fora do alcance do dispatcher', async () => {
    const r = await enq({ lastInboundAt: h(30) });
    expect(r).toMatchObject({ queued: false, held: true, status: 'pending', reason: 'JANELA_FECHADA_SEM_TEMPLATE' });
    expect(ins()).toMatchObject({ kind: 'text', status: 'pending', skipReason: 'JANELA_FECHADA_SEM_TEMPLATE', held: true });
    // next_attempt_at = infinity → o SELECT do dispatcher (<= NOW()) nunca a pega
    expect(st.inserted[0].sql).toMatch(/'infinity'::timestamptz/);
  });

  it('fora das 24h com template APROVADO: sai como template', async () => {
    fake({ templateStatus: 'APPROVED' });
    const r = await enq({ lastInboundAt: h(30), template: { nome: 'aurinha_retorno', idioma: 'pt_BR' } });
    expect(r).toMatchObject({ queued: true, status: 'pending', held: false });
    expect(ins()).toMatchObject({ kind: 'template', templateName: 'aurinha_retorno', templateLanguage: 'pt_BR', held: false });
  });

  it('fora das 24h com template NÃO aprovado: pendente com motivo TEMPLATE_NAO_APROVADO', async () => {
    fake({ templateStatus: 'PENDING' });
    const r = await enq({ lastInboundAt: h(30), template: { nome: 'aurinha_retorno' } });
    expect(r).toMatchObject({ queued: false, held: true, reason: 'TEMPLATE_NAO_APROVADO' });
    expect(ins().held).toBe(true);
  });

  it('conversa sem inbound registrado conta como janela fechada', async () => {
    const r = await enq({ lastInboundAt: null });
    expect(r.held).toBe(true);
  });
});

describe('enqueueHub — guardas', () => {
  it('mesmo dedupeKey duas vezes → DUPLICADO, uma linha só', async () => {
    const a = await enq();
    const b = await enq();
    expect(a.queued).toBe(true);
    expect(b).toMatchObject({ queued: false, reason: 'DUPLICADO' });
    expect(st.inserted).toHaveLength(1);
  });

  it('teto POR CONTATO (2/dia) não vale para conversa; o teto diário da empresa vale', async () => {
    fake({ countToday: 2 });
    expect((await enq()).queued).toBe(true);
    // a contagem consultada é a da empresa (sem telefone)
    const contagens = st.queries.filter((q) => q.sql.includes('-- wa:guard-count-today'));
    expect(contagens).toHaveLength(1);
    expect(contagens[0].params[1]).toBeNull();

    fake({ countToday: outbox.dailyCap() });
    const r = await enq();
    expect(r).toMatchObject({ queued: false, status: 'skipped', reason: 'LIMITE_DIARIO' });
  });

  it('opt-out de marketing NÃO barra atendimento (cliente que escreveu "parar" ainda é atendido)', async () => {
    fake({ contact: { id: 'c1', opted_out_at: new Date().toISOString(), last_inbound_at: null } });
    const r = await enq();
    expect(r).toMatchObject({ queued: true, status: 'pending' });
  });

  it('telefone que a Meta recusou (invalid_at) → skipped', async () => {
    fake({ contact: { id: 'c1', invalid_at: new Date().toISOString() } });
    expect(await enq()).toMatchObject({ queued: false, status: 'skipped', reason: 'TELEFONE_INVALIDO_META' });
  });

  it('fila pausada: QUALIDADE_BAIXA e PAUSADO', async () => {
    fake({ pauseReason: 'QUALIDADE_BAIXA' });
    expect(await enq()).toMatchObject({ status: 'skipped', reason: 'QUALIDADE_BAIXA' });
    fake({ pauseReason: 'CONTA_RESTRITA' });
    expect(await enq()).toMatchObject({ status: 'skipped', reason: 'PAUSADO' });
  });

  it('telefone inválido e dados incompletos nem gravam', async () => {
    expect(await enq({ toPhone: 'abc' })).toMatchObject({ queued: false, reason: 'TELEFONE_INVALIDO' });
    expect(await enq({ textBody: '' })).toMatchObject({ queued: false, reason: 'DADOS_INCOMPLETOS' });
    expect(await enq({ conversationId: null })).toMatchObject({ queued: false, reason: 'DADOS_INCOMPLETOS' });
    expect(st.inserted).toHaveLength(0);
  });

  it('migration 375 pendente (coluna ausente) → SCHEMA_PENDENTE, sem exceção', async () => {
    const e = new Error('column "hub_conversation_id" does not exist'); e.code = '42703';
    fake({ insertError: e });
    expect(await enq()).toMatchObject({ queued: false, reason: 'SCHEMA_PENDENTE' });
  });
});

// ── (2) processBatch ────────────────────────────────────────
const linha = (over = {}) => ({
  id: 'out-1', company_id: AURA, to_phone: CLIENTE, kind: 'text', template_name: null,
  template_language: 'pt_BR', components: null, text_body: 'Oi! Aqui é a Aurinha.',
  status: 'pending', attempts: 0, source_type: 'aurinha', source_id: null,
  hub_conversation_id: CONV, created_at: h(0.01), ...over,
});

describe('processBatch — linhas de origem hub', () => {
  it('janela aberta: envia, grava status/wamid e espelha na thread do hub', async () => {
    fake({ pick: [linha()] });
    wa.sendText.mockResolvedValueOnce({ messages: [{ id: 'wamid.OUT1' }] });
    const r = await outbox.processBatch(10);

    expect(r).toMatchObject({ picked: 1, sent: 1, skipped: 0, failed: 0 });
    expect(wa.sendText).toHaveBeenCalledWith('PN_AURA', 'tok', CLIENTE, 'Oi! Aqui é a Aurinha.');
    expect(st.updates).toContainEqual(expect.objectContaining({ id: 'out-1', status: 'sent', wa_message_id: 'wamid.OUT1' }));
    expect(st.mirror).toHaveLength(1);
    expect(st.mirror[0].slice(0, 5)).toEqual([AURA, CONV, 'aurinha', 'wamid.OUT1', 'Oi! Aqui é a Aurinha.']);
  });

  it('a janela é a da CONVERSA: contato com janela aberta mas conversa fora → skipped, nada enviado', async () => {
    fake({
      pick: [linha()],
      hubConv: { last_inbound_at: h(30), status: 'ia', ultima_mensagem_humana_em: null },
      contact: { id: 'c1', last_inbound_at: h(1), opted_out_at: null },
    });
    const r = await outbox.processBatch(10);
    expect(r.skipped).toBe(1);
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(st.updates).toContainEqual(expect.objectContaining({ status: 'skipped', skip_reason: 'JANELA_FECHADA' }));
  });

  it('opt-out do contato não impede atendimento pela conversa', async () => {
    fake({ pick: [linha()], contact: { id: 'c1', opted_out_at: h(5), last_inbound_at: null } });
    wa.sendText.mockResolvedValueOnce({ messages: [{ id: 'wamid.OUT2' }] });
    const r = await outbox.processBatch(10);
    expect(r.sent).toBe(1);
  });

  it('fora das 24h, template aprovado: despacha como template', async () => {
    fake({
      pick: [linha({ kind: 'template', template_name: 'aurinha_retorno', text_body: 'Oi!' })],
      hubConv: { last_inbound_at: h(30), status: 'ia', ultima_mensagem_humana_em: null },
      templateStatus: 'APPROVED',
    });
    wa.sendTemplate.mockResolvedValueOnce({ messages: [{ id: 'wamid.T1' }] });
    const r = await outbox.processBatch(10);
    expect(r.sent).toBe(1);
    expect(wa.sendTemplate).toHaveBeenCalledWith('PN_AURA', 'tok', CLIENTE, 'aurinha_retorno', 'pt_BR', undefined);
  });

  it('erro transitório: retry com backoff de 2 min e attempts=1', async () => {
    fake({ pick: [linha()] });
    wa.sendText.mockRejectedValueOnce(new Error('fetch failed'));
    const r = await outbox.processBatch(10);
    expect(r).toMatchObject({ retried: 1, failed: 0 });
    expect(st.updates).toContainEqual(expect.objectContaining({ retry: true, attempts: 1, backoffMin: 2 }));
  });

  it('5ª tentativa com erro → failed, com o erro gravado', async () => {
    fake({ pick: [linha({ attempts: 4 })] });
    wa.sendText.mockRejectedValueOnce(new Error('timeout Graph'));
    const r = await outbox.processBatch(10);
    expect(r.failed).toBe(1);
    expect(st.updates).toContainEqual(expect.objectContaining({ status: 'failed', attempts: 5, last_error: 'timeout Graph' }));
  });

  it('erro permanente da Meta (131026) → failed na 1ª, sem gastar retry', async () => {
    fake({ pick: [linha()] });
    const err = new Error('Message undeliverable'); err.meta = { code: 131026 };
    wa.sendText.mockRejectedValueOnce(err);
    const r = await outbox.processBatch(10);
    expect(r).toMatchObject({ failed: 1, retried: 0 });
  });

  it('equipe assumiu a conversa: a Aurinha não fala (CONVERSA_NAO_IA)', async () => {
    fake({ pick: [linha()], hubConv: { last_inbound_at: h(1), status: 'humano', ultima_mensagem_humana_em: null } });
    const r = await outbox.processBatch(10);
    expect(r.skipped).toBe(1);
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(st.updates).toContainEqual(expect.objectContaining({ skip_reason: 'CONVERSA_NAO_IA' }));
  });

  it('humano respondeu depois que a resposta entrou na fila: HUMANO_RESPONDEU', async () => {
    fake({
      pick: [linha({ created_at: h(0.5) })],
      hubConv: { last_inbound_at: h(1), status: 'ia', ultima_mensagem_humana_em: h(0.2) },
    });
    await outbox.processBatch(10);
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(st.updates).toContainEqual(expect.objectContaining({ skip_reason: 'HUMANO_RESPONDEU' }));
  });

  it('mensagem do próprio humano (source humano) passa mesmo com a conversa assumida', async () => {
    fake({
      pick: [linha({ source_type: 'humano' })],
      hubConv: { last_inbound_at: h(1), status: 'humano', ultima_mensagem_humana_em: h(0.01) },
    });
    wa.sendText.mockResolvedValueOnce({ messages: [{ id: 'wamid.H1' }] });
    const r = await outbox.processBatch(10);
    expect(r.sent).toBe(1);
    expect(st.mirror[0][2]).toBe('humano');
  });

  it('sem credenciais: skipped SEM_CREDENCIAIS', async () => {
    fake({ pick: [linha()], creds: null });
    const r = await outbox.processBatch(10);
    expect(r.skipped).toBe(1);
    expect(st.updates).toContainEqual(expect.objectContaining({ skip_reason: 'SEM_CREDENCIAIS' }));
  });

  it('linha de LOJA (sem hub_conversation_id) mantém as regras de sempre: opt-out barra', async () => {
    fake({
      pick: [linha({ hub_conversation_id: null, source_type: 'crediario' })],
      contact: { id: 'c1', opted_out_at: h(5), last_inbound_at: h(1) },
    });
    const r = await outbox.processBatch(10);
    expect(r.skipped).toBe(1);
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(st.updates).toContainEqual(expect.objectContaining({ skip_reason: 'OPT_OUT' }));
    // …e não consultou o hub
    expect(st.queries.some((q) => q.sql.includes('-- wa:hub-conv'))).toBe(false);
  });
});
