// ============================================================
// Aprovação da arte do Studio avisa a lojista — QA da vitrine, achado A4
// (26/09/2026)
//
// "Aprovar" e "Pedir ajuste" não avisavam a lojista, embora a página
// dissesse que sim. Agora viram evento no sino + push, e a frase da
// cliente é verdadeira e sem emoji. (O "0 = ilimitadas" do achado A3
// está em revisoesIlimitadas.test.js.)
//
// Mock do db por CONTEÚDO DO SQL, nunca por ordem de chamada.
// ============================================================
'use strict';

jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(() => Promise.resolve()),
  notifyStatusChange: jest.fn(() => Promise.resolve()),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const lojaEvents = require('../src/services/lojaEvents');
const appNotifications = require('../src/services/appNotifications');
const webPush = require('../src/services/webPush');
const digitalOrderNotifications = require('../src/services/digitalOrderNotifications');
const rota = require('../src/routes/studioApprovalPublic');

const CID = 'c0000000-0000-0000-0000-000000000001';
const OID = 'o0000000-0000-0000-0000-000000000001';
const APROV = 'hx7k2mq1hx7k2mq1hx7k2mq1';
const EMOJI = /\p{Extended_Pictographic}/u;

// ─────────────────────────────────────────────────────────────
// A4 — a resposta da cliente avisa a lojista
// ─────────────────────────────────────────────────────────────
describe('POST /aprovacao/:token/respond — avisa a loja', () => {
  const app = express();
  app.use(express.json());
  app.use('/aprovacao', rota);

  let link;
  let emit;
  beforeEach(() => {
    link = {
      id: 'ap1', company_id: CID, order_id: OID, status: 'pending',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };
    emit = jest.spyOn(lojaEvents, 'emit').mockImplementation(() => {});
    db.connect.mockReset();
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql) => {
        const s = String(sql);
        if (/FROM studio_approval_links WHERE token/.test(s)) return { rows: link ? [link] : [] };
        if (/COALESCE\(MAX\(revision_number\)/.test(s)) return { rows: [{ next: 2 }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    }));
  });
  afterEach(() => emit.mockRestore());

  test('aprovar: evento loja_arte_aprovada, um por link, abrindo o pedido do Studio', async () => {
    const r = await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'approve' });
    expect(r.status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'loja_arte_aprovada',
      { id: OID, company_id: CID, vertical: 'studio' },
      { dedupeSuffix: 'ap1' },
    );
  });

  test('pedir ajuste: evento loja_ajuste_pedido com o texto e o aviso da referencia', async () => {
    const r = await request(app).post(`/aprovacao/${APROV}/respond`).send({
      action: 'request_changes', note: 'Trocar a fonte por uma mais redonda',
      referencia_url: 'https://r2.getaura.com.br/ref.png',
    });
    expect(r.status).toBe(200);
    expect(emit).toHaveBeenCalledWith(
      'loja_ajuste_pedido',
      expect.objectContaining({
        id: OID, company_id: CID, vertical: 'studio',
        ajuste_texto: 'Trocar a fonte por uma mais redonda', ajuste_com_referencia: true,
      }),
      { dedupeSuffix: 'ap1' },
    );
  });

  test('referencia que nao e https nao e anunciada', async () => {
    await request(app).post(`/aprovacao/${APROV}/respond`).send({
      action: 'request_changes', note: 'Mais rosa', referencia_url: 'http://x.com/a.png',
    });
    expect(emit.mock.calls[0][1].ajuste_com_referencia).toBe(false);
  });

  test('a frase da cliente e verdadeira e sem emoji', async () => {
    const ok = await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'approve' });
    expect(ok.body.message).toBe('Arte aprovada. A loja já foi avisada e segue para a produção.');
    link.status = 'pending';
    const aj = await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'request_changes', note: 'x' });
    expect(aj.body.message).toBe('Pedido de ajuste enviado. A loja já foi avisada.');
    expect(ok.body.message + aj.body.message).not.toMatch(EMOJI);
  });

  test('link ja respondido, expirado ou inexistente nao avisa ninguem', async () => {
    link.status = 'approved';
    expect((await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'approve' })).status).toBe(409);
    link.status = 'pending';
    link.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'approve' })).status).toBe(410);
    link = null;
    expect((await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'approve' })).status).toBe(404);
    expect(emit).not.toHaveBeenCalled();
  });

  test('falha ao gravar nao avisa (o aviso so sai depois do COMMIT)', async () => {
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql) => {
        const s = String(sql);
        if (/FROM studio_approval_links WHERE token/.test(s)) return { rows: [link] };
        if (/UPDATE studio_approval_links/.test(s)) throw new Error('boom');
        return { rows: [] };
      }),
      release: jest.fn(),
    }));
    const r = await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'approve' });
    expect(r.status).toBe(500);
    expect(emit).not.toHaveBeenCalled();
  });

  test('action invalida continua 400 e sem aviso', async () => {
    const r = await request(app).post(`/aprovacao/${APROV}/respond`).send({ action: 'talvez' });
    expect(r.status).toBe(400);
    expect(emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// Os dois eventos novos na taxonomia do sino
// ─────────────────────────────────────────────────────────────
describe('loja_arte_aprovada e loja_ajuste_pedido', () => {
  const PEDIDO = {
    id: OID, company_id: CID, order_number: '00123', customer_name: 'Helena Martins',
    total: '49.90', vertical: 'studio',
  };
  let sandbox;
  let criados;

  beforeEach(() => {
    lojaEvents._resetCaches();
    sandbox = false;
    criados = [];
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/is_sandbox/.test(s)) return { rows: [{ is_sandbox: sandbox }] };
      if (/company_notification_prefs/.test(s)) return { rows: [] };
      if (/FROM digital_orders/.test(s)) return { rows: [PEDIDO] };
      return { rows: [] };
    });
    jest.spyOn(appNotifications, 'notifyCompany').mockImplementation(async (cid, p) => {
      criados.push({ cid, ...p });
      return { id: 'n' + criados.length, ...p };
    });
    jest.spyOn(webPush, 'notifyCompany').mockResolvedValue({ enviados: 1 });
    digitalOrderNotifications.notifyPaymentConfirmed.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  test('arte aprovada: informativa, com numero e nome da cliente, e vai ao navegador', async () => {
    expect(lojaEvents.severityOf('loja_arte_aprovada')).toBe('info');
    await lojaEvents.emitLojaEvent('loja_arte_aprovada',
      { id: OID, company_id: CID, vertical: 'studio' }, { dedupeSuffix: 'ap1' });
    expect(criados).toHaveLength(1);
    expect(criados[0].title).toBe('Arte aprovada #00123 — Helena Martins');
    expect(criados[0].ctaRoute).toBe(`/studio/pedidos/${OID}`);
    expect(criados[0].dedupeKey).toBe('loja:arte_aprovada:ap1');
    expect(webPush.notifyCompany).toHaveBeenCalledWith(CID, expect.objectContaining({
      title: 'Arte aprovada #00123 — Helena Martins', url: `/studio/pedidos/${OID}`, tag: `pedido:${OID}`,
    }));
  });

  test('ajuste pedido: pede acao, corpo com o comeco do texto', async () => {
    expect(lojaEvents.severityOf('loja_ajuste_pedido')).toBe('atencao');
    await lojaEvents.emitLojaEvent('loja_ajuste_pedido', {
      id: OID, company_id: CID, vertical: 'studio',
      ajuste_texto: 'Trocar a fonte\npor uma mais redonda', ajuste_com_referencia: true,
    }, { dedupeSuffix: 'ap2' });
    expect(criados[0].title).toBe('Ajuste pedido #00123 — Helena Martins');
    expect(criados[0].body).toBe('"Trocar a fonte por uma mais redonda" Com referência anexada.');
    expect(criados[0].ctaLabel).toBe('Ver ajuste');
    expect(criados[0].dedupeKey).toBe('loja:ajuste_pedido:ap2');
  });

  test('texto longo e cortado na palavra, com reticencias', async () => {
    const longo = 'deixar o nome bem maior e trocar a cor da letra pra dourado '.repeat(5);
    await lojaEvents.emitLojaEvent('loja_ajuste_pedido',
      { id: OID, company_id: CID, ajuste_texto: longo }, { dedupeSuffix: 'ap3' });
    const corpo = criados[0].body;
    expect(corpo.length).toBeLessThanOrEqual(124);
    expect(corpo).toMatch(/…"$/);
    expect(corpo).not.toMatch(/ …/);
  });

  test('sem texto: frase generica, nunca aspas vazias', async () => {
    await lojaEvents.emitLojaEvent('loja_ajuste_pedido',
      { id: OID, company_id: CID, ajuste_texto: '  ' }, { dedupeSuffix: 'ap4' });
    expect(criados[0].body).toBe('A cliente pediu ajuste na arte.');
  });

  test('loja de teste (is_sandbox): segue a regra dos eventos da loja — o sino da propria loja recebe', async () => {
    // A trava de services/lojaDeTeste.js e para o que sai para o mundo
    // (WhatsApp, e-mail, push de celular). O sino e o navegador da propria
    // loja de teste sao justamente onde o QA confere a aprovacao (LJ-37).
    sandbox = true;
    await lojaEvents.emitLojaEvent('loja_arte_aprovada',
      { id: OID, company_id: CID, vertical: 'studio' }, { dedupeSuffix: 'ap5' });
    expect(criados).toHaveLength(1);
    expect(digitalOrderNotifications.notifyPaymentConfirmed).not.toHaveBeenCalled();
  });

  test('preferencia desligada nao cria nada', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/company_notification_prefs/.test(String(sql))) {
        return { rows: [{ event_type: 'loja_arte_aprovada', enabled: false }] };
      }
      return { rows: [PEDIDO] };
    });
    expect(await lojaEvents.emitLojaEvent('loja_arte_aprovada', PEDIDO, { dedupeSuffix: 'ap6' })).toBeNull();
    expect(criados).toHaveLength(0);
  });

  test('os dois aparecem nas preferencias, ligados por padrao', () => {
    const cat = lojaEvents.listEventTypes();
    expect(cat.find((e) => e.type === 'loja_arte_aprovada')).toMatchObject({ label: 'Arte aprovada', default_enabled: true });
    expect(cat.find((e) => e.type === 'loja_ajuste_pedido')).toMatchObject({ label: 'Ajuste pedido', default_enabled: true });
    expect(lojaEvents.isPrefKey('loja_ajuste_pedido')).toBe(true);
  });
});
