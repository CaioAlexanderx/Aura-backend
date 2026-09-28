// ============================================================
// Studio · Orçamento em vídeo 3D pelo WhatsApp (migration 361, 28/09/2026)
//
// Decisões do PO que os testes seguram:
//   - desconto só o que a lojista definiu no orçamento (nada da loja);
//   - vídeo guardado 30 dias, "manter por mais 30" prorroga com teto;
//   - sem página pública: marcar enviado NÃO gera token;
//   - Fechar = 'closed'; Aprovar = vira pedido com as condições nas notas;
//   - multi-CNPJ: toda consulta filtra por id E company_id.
//
// Mock do db por CONTEÚDO DO SQL, nunca por ordem de chamada.
// ============================================================
'use strict';

jest.mock('../src/utils/r2Storage', () => ({
  uploadToR2: jest.fn(async (key) => ({ success: true, key, url: 'https://r2.test/' + key })),
  deleteFromR2: jest.fn(async () => ({ success: true })),
  downloadFromR2: jest.fn(async () => Buffer.from('mp4-bytes')),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const r2 = require('../src/utils/r2Storage');
const regras = require('../src/services/orcamentoEmVideo');
const rotaVideo = require('../src/routes/studioQuoteVideo');
const rotaQuotes = require('../src/routes/studioQuotes');
const { expirarVideosDeOrcamento } = require('../src/jobs/orcamentoVideoExpiryJob');

const CID = 'c0000000-0000-0000-0000-000000000001';
const OUTRA = 'c0000000-0000-0000-0000-000000000002';
const QID = 'q0000000-0000-0000-0000-000000000001';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/studio', rotaVideo);
  a.use('/companies/:id/studio', rotaQuotes);
  return a;
}

function orcamento(extra) {
  return {
    id: QID, company_id: CID, status: 'draft', total: '532.80', subtotal: '532.80', discount: '0',
    deposit_pct: null, deposit_amount: null, validity_days: 7, notes: null,
    customer_name: 'Mariana Costa', customer_phone: '11987654321',
    condicoes: null, video_key: null, video_expira_em: null, order_id: null,
    ...extra,
  };
}

// Banco de mentira: guarda o orçamento e responde pelo SQL.
function bancoCom(q) {
  const estado = { q, sqls: [], params: [] };
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    estado.sqls.push(s); estado.params.push(params);
    if (/SELECT \* FROM studio_quotes WHERE id = \$1 AND company_id = \$2/.test(s)) {
      return { rows: estado.q && params[1] === estado.q.company_id ? [estado.q] : [] };
    }
    if (/SELECT \* FROM studio_quote_items/.test(s)) {
      return { rows: [{ product_id: 'p1', description: 'Caneca 325 ml', quantity: '12', unit_price: '39.90', customization: { texto: 'Mari & Léo' } }] };
    }
    if (/UPDATE studio_quotes/.test(s)) {
      const novo = { ...estado.q };
      if (/SET condicoes/.test(s)) Object.assign(novo, { condicoes: JSON.parse(params[0]), deposit_pct: params[1], deposit_amount: params[2], validity_days: params[3] });
      if (/SET video_key/.test(s)) Object.assign(novo, { video_key: params[0], video_content_type: params[1], video_bytes: params[2], video_formato: params[3], video_expira_em: params[4] });
      if (/SET video_expira_em = \$1/.test(s)) Object.assign(novo, { video_expira_em: params[0] });
      if (/SET status      = 'sent'/.test(s)) Object.assign(novo, { status: 'sent', canal_envio: params[1] });
      if (/SET status        = 'closed'/.test(s)) Object.assign(novo, { status: 'closed', response_note: params[0] });
      estado.q = novo;
      return { rows: [novo] };
    }
    return { rows: [] };
  });
  return estado;
}

beforeEach(() => {
  r2.uploadToR2.mockClear();
  r2.deleteFromR2.mockClear();
  r2.downloadFromR2.mockClear();
});

// ─────────────────────────────────────────────────────────────
describe('regras puras', () => {
  test('condições vazias = nenhuma condição (nada pré-preenchido)', () => {
    const r = regras.lerCondicoes({});
    expect(r).toEqual({ ok: true, condicoes: { pix_desconto_pct: null, parcelas: null, prazo_dias_uteis: null, observacao: null } });
    expect(regras.valoresDasCondicoes(orcamento({ condicoes: r.condicoes }))).toEqual({});
  });

  test('valida limites', () => {
    expect(regras.lerCondicoes({ pix_desconto_pct: 0 }).ok).toBe(false);
    expect(regras.lerCondicoes({ pix_desconto_pct: 60 }).ok).toBe(false);
    expect(regras.lerCondicoes({ parcelas: 1 }).ok).toBe(false);
    expect(regras.lerCondicoes({ parcelas: 2.5 }).ok).toBe(false);
    expect(regras.lerCondicoes({ prazo_dias_uteis: 0 }).ok).toBe(false);
    expect(regras.lerCondicoes({ pix_desconto_pct: 'abc' }).ok).toBe(false);
    expect(regras.lerCondicoes({ observacao: 'x'.repeat(281) }).ok).toBe(false);
  });

  test('Pix pela regra canônica em centavos, sobre o total do orçamento', () => {
    const v = regras.valoresDasCondicoes(orcamento({
      condicoes: { pix_desconto_pct: 5, parcelas: 6, prazo_dias_uteis: 5 },
      deposit_pct: '50', deposit_amount: '266.40',
    }));
    // Math.round(53280 * 95 / 100) = 50616
    expect(v.pix).toEqual({ pct: 5, valor: 506.16 });
    expect(v.cartao).toEqual({ parcelas: 6, valor: 88.8 });
    expect(v.sinal).toEqual({ pct: 50, valor: 266.4 });
    expect(v.prazo).toEqual({ dias_uteis: 5 });
  });

  test('R$ 49,90 a 5% dá R$ 47,41 no Pix (a mesma conta da vitrine)', () => {
    const v = regras.valoresDasCondicoes(orcamento({ total: '49.90', condicoes: { pix_desconto_pct: 5 } }));
    expect(v.pix.valor).toBe(47.41);
  });

  test('notas do pedido aprovado levam as condições combinadas', () => {
    const n = regras.notasDoPedidoAprovado(orcamento({
      notes: 'Entregar no salão',
      condicoes: { pix_desconto_pct: 5, parcelas: 6, prazo_dias_uteis: 5, observacao: 'Frete por conta da cliente' },
      deposit_pct: '50', deposit_amount: '266.40',
    }));
    expect(n).toBe(
      'Entregar no salão\n\nCondições combinadas no orçamento:\n' +
      '• Pix: R$ 506,16 (5% de desconto)\n' +
      '• Cartão: até 6x de R$ 88,80 sem juros\n' +
      '• Sinal: R$ 266,40 (50%)\n' +
      '• Prazo: 5 dias úteis depois da aprovação da arte\n' +
      '• Frete por conta da cliente'
    );
    expect(regras.notasDoPedidoAprovado(orcamento({ notes: 'só isto' }))).toBe('só isto');
    expect(regras.notasDoPedidoAprovado(orcamento())).toBeNull();
  });

  test('expiração: +30 dias do maior entre hoje e a data atual, com teto de 365', () => {
    const hoje = new Date('2026-09-28T12:00:00Z');
    expect(regras.novaExpiracao(null, hoje).toISOString()).toBe('2026-10-28T12:00:00.000Z');
    expect(regras.novaExpiracao('2026-10-10T12:00:00Z', hoje).toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(regras.novaExpiracao('2026-09-01T12:00:00Z', hoje).toISOString()).toBe('2026-10-28T12:00:00.000Z');
    expect(regras.novaExpiracao('2027-09-20T12:00:00Z', hoje).toISOString()).toBe('2027-09-28T12:00:00.000Z');
  });

  test('chave do vídeo no prefixo próprio, por empresa e orçamento', () => {
    expect(regras.chaveDoVideo(CID, QID, 'video/mp4', 123)).toMatch(new RegExp(`^orcamento-video/${CID}/${QID}/123-[a-z0-9]+\\.mp4$`));
    expect(regras.chaveDoVideo(CID, QID, 'video/webm', 1)).toMatch(/\.webm$/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('PUT /quotes/:qid/condicoes', () => {
  test('grava as condições da lojista e devolve os valores', async () => {
    const e = bancoCom(orcamento());
    const r = await request(app())
      .put(`/companies/${CID}/studio/quotes/${QID}/condicoes`)
      .send({ pix_desconto_pct: 5, parcelas: 6, prazo_dias_uteis: 5, deposit_pct: 50, validity_days: 10 });
    expect(r.status).toBe(200);
    expect(r.body.quote.condicoes).toEqual({ pix_desconto_pct: 5, parcelas: 6, prazo_dias_uteis: 5, observacao: null });
    expect(r.body.quote.deposit_amount).toBe(266.4);
    expect(r.body.quote.validity_days).toBe(10);
    expect(r.body.valores.pix.valor).toBe(506.16);
    const upd = e.sqls.find((s) => /SET condicoes/.test(s));
    expect(upd).toMatch(/WHERE id = \$5 AND company_id = \$6/);
  });

  test('recusa condição inválida e orçamento fora do aberto', async () => {
    bancoCom(orcamento());
    expect((await request(app()).put(`/companies/${CID}/studio/quotes/${QID}/condicoes`).send({ parcelas: 30 })).status).toBe(400);
    bancoCom(orcamento({ status: 'converted' }));
    expect((await request(app()).put(`/companies/${CID}/studio/quotes/${QID}/condicoes`).send({})).status).toBe(400);
  });

  test('multi-CNPJ: orçamento de outra empresa é 404', async () => {
    bancoCom(orcamento());
    const r = await request(app()).put(`/companies/${OUTRA}/studio/quotes/${QID}/condicoes`).send({});
    expect(r.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────
describe('vídeo guardado', () => {
  test('PUT binário guarda no R2 por 30 dias e apaga o vídeo anterior', async () => {
    const e = bancoCom(orcamento({ video_key: 'orcamento-video/antigo.mp4' }));
    const antes = Date.now();
    const r = await request(app())
      .put(`/companies/${CID}/studio/quotes/${QID}/video?formato=mp4-webcodecs`)
      .set('Content-Type', 'video/mp4')
      .send(Buffer.from('0123456789'));
    expect(r.status).toBe(201);
    expect(r.body.video.bytes).toBe(10);
    expect(r.body.video.formato).toBe('mp4-webcodecs');
    expect(r.body.video).not.toHaveProperty('key');
    const dias = (new Date(r.body.video.expira_em).getTime() - antes) / 86400000;
    expect(dias).toBeGreaterThan(29.9);
    expect(dias).toBeLessThan(30.1);
    const [chave, corpo, tipo] = r2.uploadToR2.mock.calls[0];
    expect(chave).toMatch(new RegExp(`^orcamento-video/${CID}/${QID}/`));
    expect(Buffer.isBuffer(corpo)).toBe(true);
    expect(tipo).toBe('video/mp4');
    expect(r2.deleteFromR2).toHaveBeenCalledWith('orcamento-video/antigo.mp4');
    expect(e.q.video_key).toBe(chave);
  });

  test('recusa tipo que não é vídeo e corpo vazio', async () => {
    bancoCom(orcamento());
    const a = await request(app()).put(`/companies/${CID}/studio/quotes/${QID}/video`).set('Content-Type', 'image/png').send(Buffer.from('x'));
    expect(a.status).toBe(415);
    const b = await request(app()).put(`/companies/${CID}/studio/quotes/${QID}/video`).set('Content-Type', 'video/mp4').send(Buffer.alloc(0));
    expect(b.status).toBe(400);
    expect(r2.uploadToR2).not.toHaveBeenCalled();
  });

  test('GET devolve o arquivo só para a empresa dona; expirado é 410', async () => {
    const futuro = new Date(Date.now() + 86400000).toISOString();
    bancoCom(orcamento({ video_key: 'orcamento-video/x.mp4', video_content_type: 'video/mp4', video_expira_em: futuro }));
    const ok = await request(app()).get(`/companies/${CID}/studio/quotes/${QID}/video`).buffer(true).parse((res, cb) => {
      const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('video/mp4');
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect(ok.body.toString()).toBe('mp4-bytes');

    const outra = await request(app()).get(`/companies/${OUTRA}/studio/quotes/${QID}/video`);
    expect(outra.status).toBe(404);

    bancoCom(orcamento({ video_key: 'k', video_expira_em: new Date(Date.now() - 1000).toISOString() }));
    expect((await request(app()).get(`/companies/${CID}/studio/quotes/${QID}/video`)).status).toBe(410);
  });

  test('manter por mais 30 dias soma à data atual', async () => {
    const atual = new Date(Date.now() + 10 * 86400000);
    bancoCom(orcamento({ video_key: 'k', video_expira_em: atual.toISOString() }));
    const r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/video/manter`);
    expect(r.status).toBe(200);
    const dias = (new Date(r.body.video.expira_em).getTime() - atual.getTime()) / 86400000;
    expect(Math.round(dias)).toBe(30);
  });

  test('manter sem vídeo é 404', async () => {
    bancoCom(orcamento());
    expect((await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/video/manter`)).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────
describe('ciclo do orçamento sem página pública', () => {
  test('marcar enviado vira sent, guarda o canal e NÃO gera token', async () => {
    const e = bancoCom(orcamento());
    const r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/marcar-enviado`).send({ canal: 'compartilhar' });
    expect(r.status).toBe(200);
    expect(r.body.quote.status).toBe('sent');
    expect(r.body.quote.canal_envio).toBe('compartilhar');
    const upd = e.sqls.find((s) => /SET status      = 'sent'/.test(s));
    expect(upd).not.toMatch(/token/);
  });

  test('canal desconhecido vira null', async () => {
    bancoCom(orcamento());
    const r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/marcar-enviado`).send({ canal: 'telegrama' });
    expect(r.body.quote.canal_envio).toBeNull();
  });

  test('fechar encerra sem venda (closed) e é idempotente', async () => {
    bancoCom(orcamento({ status: 'sent' }));
    const r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/fechar`).send({ motivo: 'Cliente desistiu' });
    expect(r.status).toBe(200);
    expect(r.body.quote.status).toBe('closed');
    expect(r.body.quote.response_note).toBe('Cliente desistiu');
    const de_novo = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/fechar`);
    expect(de_novo.status).toBe(200);
    bancoCom(orcamento({ status: 'converted' }));
    expect((await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/fechar`)).status).toBe(400);
  });

  test('aprovar vira pedido na esteira com itens, arte, sinal e as condições nas notas', async () => {
    const q = orcamento({
      status: 'sent', deposit_pct: '50', deposit_amount: '266.40',
      condicoes: { pix_desconto_pct: 5, parcelas: 6, prazo_dias_uteis: 5 },
    });
    bancoCom(q);
    const chamadas = [];
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        chamadas.push({ s, params });
        if (/INSERT INTO digital_orders/.test(s)) return { rows: [{ id: 'o1' }] };
        if (/UPDATE studio_quotes/.test(s)) return { rows: [{ ...q, status: 'converted', order_id: 'o1' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    }));
    const r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/aprovar`);
    expect(r.status).toBe(200);
    expect(r.body.order_id).toBe('o1');
    expect(r.body.quote.status).toBe('converted');

    const pedido = chamadas.find((c) => /INSERT INTO digital_orders/.test(c.s));
    expect(pedido.s).toMatch(/'pending_art'/);
    expect(pedido.params[0]).toBe(CID);
    expect(pedido.params[3]).toBe(532.8);
    expect(pedido.params[5]).toMatch(/Pix: R\$ 506,16/);
    const item = chamadas.find((c) => /INSERT INTO digital_order_items/.test(c.s));
    expect(item.params[5]).toEqual({ texto: 'Mari & Léo' });
    expect(chamadas.some((c) => /INSERT INTO studio_payments/.test(c.s))).toBe(true);
    expect(chamadas.map((c) => c.s)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
  });

  test('aprovar é idempotente e recusa orçamento fechado', async () => {
    bancoCom(orcamento({ status: 'converted', order_id: 'o9' }));
    const r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/aprovar`);
    expect(r.body.order_id).toBe('o9');
    bancoCom(orcamento({ status: 'closed' }));
    expect((await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/aprovar`)).status).toBe(400);
  });

  test('convert do cliente (página pública) continua exigindo accepted', async () => {
    bancoCom(orcamento({ status: 'sent' }));
    expect((await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/convert`)).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────
describe('job de expiração', () => {
  test('apaga do R2 e limpa as colunas dos vencidos', async () => {
    db.query.mockReset();
    const sqls = [];
    db.query.mockImplementation(async (sql, params) => {
      sqls.push({ s: String(sql), params });
      if (/studio:orcamento-video-vencido/.test(String(sql))) {
        return { rows: [{ id: QID, company_id: CID, video_key: 'orcamento-video/a.mp4' }] };
      }
      return { rows: [] };
    });
    const n = await expirarVideosDeOrcamento();
    expect(n).toBe(1);
    expect(r2.deleteFromR2).toHaveBeenCalledWith('orcamento-video/a.mp4');
    const limpa = sqls.find((c) => /SET video_key = NULL/.test(c.s));
    expect(limpa.params).toEqual([QID, CID, 'orcamento-video/a.mp4']);
  });

  test('sem a 361 não quebra', async () => {
    db.query.mockReset();
    db.query.mockRejectedValue(Object.assign(new Error('column'), { code: '42703' }));
    expect(await expirarVideosDeOrcamento()).toBeNull();
  });
});
