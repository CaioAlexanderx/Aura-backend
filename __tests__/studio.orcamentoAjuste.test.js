// ============================================================
// Studio · "Cliente pediu ajuste" no orçamento em vídeo (migration 362)
//
// O que os testes seguram:
//   - só orçamento enviado ('sent') aceita ajuste; texto obrigatório, até 500;
//   - registra texto + versão que o cliente viu e volta a 'draft' num só SQL;
//   - reenviar depois do ajuste sobe a versão e apaga o selo;
//   - o vídeo antigo NÃO é apagado ao pedir ajuste;
//   - multi-CNPJ: toda consulta filtra por id E company_id.
//
// Mock do db por CONTEÚDO DO SQL, nunca por ordem de chamada.
// ============================================================
'use strict';

jest.mock('../src/utils/r2Storage', () => ({
  uploadToR2: jest.fn(async (key) => ({ success: true, key })),
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

const CID = 'c0000000-0000-0000-0000-000000000001';
const OUTRA = 'c0000000-0000-0000-0000-000000000002';
const QID = 'q0000000-0000-0000-0000-000000000001';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
  a.use('/companies/:id/studio', rotaVideo);
  a.use('/companies/:id/studio', rotaQuotes);
  return a;
}

function orcamento(extra) {
  return {
    id: QID, company_id: CID, status: 'sent', total: '532.80', validity_days: 7,
    versao: 1, ajuste_pedido_em: null, video_key: 'studio/v1.mp4', ...extra,
  };
}

function bancoCom(q) {
  const estado = { q, sqls: [], params: [], ajustes: [] };
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    estado.sqls.push(s); estado.params.push(params);
    if (/SELECT \* FROM studio_quotes WHERE id = \$1 AND company_id = \$2/.test(s)
      || /SELECT \* FROM studio_quotes\s+WHERE id = \$1 AND company_id = \$2/.test(s)) {
      return { rows: estado.q && params[1] === estado.q.company_id ? [estado.q] : [] };
    }
    if (/INSERT INTO studio_quote_ajustes/.test(s)) {
      const ok = estado.q && estado.q.status === 'sent' && params[1] === estado.q.company_id;
      if (!ok) return { rows: [{ quote: null, ajuste: null }] };
      const ajuste = { id: 'a' + (estado.ajustes.length + 1), texto: params[2], versao: estado.q.versao, created_at: '2026-09-28T12:00:00Z' };
      estado.ajustes.unshift(ajuste);
      estado.q = { ...estado.q, status: 'draft', ajuste_pedido_em: '2026-09-28T12:00:00Z' };
      return { rows: [{ quote: estado.q, ajuste }] };
    }
    if (/FROM studio_quote_ajustes/.test(s)) {
      return { rows: params[1] === estado.q.company_id ? estado.ajustes : [] };
    }
    if (/UPDATE studio_quotes/.test(s) && /SET status      = 'sent'/.test(s)) {
      const novo = { ...estado.q, status: 'sent', canal_envio: params[1] };
      if (/versao           = versao \+ 1/.test(s)) Object.assign(novo, { versao: novo.versao + 1, ajuste_pedido_em: null });
      estado.q = novo;
      return { rows: [novo] };
    }
    return { rows: [] };
  });
  return estado;
}

const pedir = (corpo, cid = CID) =>
  request(app()).post(`/companies/${cid}/studio/quotes/${QID}/ajuste`).send(corpo);

describe('regra do texto', () => {
  test('obrigatório, aparado e até 500 caracteres', () => {
    expect(regras.lerPedidoDeAjuste({}).ok).toBe(false);
    expect(regras.lerPedidoDeAjuste({ texto: '   ' }).ok).toBe(false);
    expect(regras.lerPedidoDeAjuste({ texto: '  Trocar para azul  ' })).toEqual({ ok: true, texto: 'Trocar para azul' });
    expect(regras.lerPedidoDeAjuste({ texto: 'x'.repeat(500) }).ok).toBe(true);
    expect(regras.lerPedidoDeAjuste({ texto: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('POST /quotes/:qid/ajuste', () => {
  beforeEach(() => r2.deleteFromR2.mockClear());

  test('registra texto e versão vista e volta o orçamento a draft', async () => {
    const e = bancoCom(orcamento());
    const r = await pedir({ texto: 'Cliente quer a caneca preta e o nome maior' });
    expect(r.status).toBe(201);
    expect(r.body.quote.status).toBe('draft');
    expect(r.body.quote.ajuste_pedido_em).toBeTruthy();
    expect(r.body.ajuste).toMatchObject({ texto: 'Cliente quer a caneca preta e o nome maior', versao: 1 });

    const sql = e.sqls.find((s) => /INSERT INTO studio_quote_ajustes/.test(s));
    expect(sql).toMatch(/WHERE id = \$1 AND company_id = \$2 AND status = 'sent'/);
    const params = e.params[e.sqls.indexOf(sql)];
    expect(params).toEqual([QID, CID, 'Cliente quer a caneca preta e o nome maior', 'u1']);
    // O vídeo antigo continua guardado até a lojista gerar outro.
    expect(r2.deleteFromR2).not.toHaveBeenCalled();
    expect(sql).not.toMatch(/video_key/);
  });

  test('texto vazio ou longo demais é recusado sem tocar no banco', async () => {
    const e = bancoCom(orcamento());
    expect((await pedir({ texto: '' })).status).toBe(400);
    expect((await pedir({ texto: 'x'.repeat(501) })).status).toBe(400);
    expect(e.sqls).toHaveLength(0);
  });

  test('só orçamento enviado aceita ajuste', async () => {
    for (const status of ['draft', 'converted', 'closed']) {
      bancoCom(orcamento({ status }));
      expect((await pedir({ texto: 'Mudar a cor' })).status).toBe(400);
    }
  });

  test('multi-CNPJ: orçamento de outra empresa do grupo não é encontrado', async () => {
    const e = bancoCom(orcamento());
    expect((await pedir({ texto: 'Mudar a cor' }, OUTRA)).status).toBe(404);
    expect(e.sqls.some((s) => /INSERT INTO studio_quote_ajustes/.test(s))).toBe(false);
  });

  test('sem a 362 responde 503 em vez de 500', async () => {
    bancoCom(orcamento());
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/studio_quote_ajustes/.test(String(sql))) throw Object.assign(new Error('relation'), { code: '42P01' });
      return original(sql, params);
    });
    expect((await pedir({ texto: 'Mudar a cor' })).status).toBe(503);
  });
});

describe('ciclo: ajuste, reenvio e histórico', () => {
  test('reenviar depois do ajuste passa para a versão 2, depois 3, e apaga o selo', async () => {
    const e = bancoCom(orcamento());
    await pedir({ texto: 'Trocar para azul' });
    let r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/marcar-enviado`).send({ canal: 'whatsapp' });
    expect(r.body.quote).toMatchObject({ status: 'sent', versao: 2, ajuste_pedido_em: null });

    await pedir({ texto: 'Agora com o logo menor' });
    expect(e.q.versao).toBe(2);
    r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/marcar-enviado`).send({ canal: 'whatsapp' });
    expect(r.body.quote.versao).toBe(3);

    // Reenviar sem ajuste pendente não mexe na versão.
    r = await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/marcar-enviado`).send({ canal: 'copiar' });
    expect(r.body.quote.versao).toBe(3);
    const ultimo = e.sqls.filter((s) => /SET status      = 'sent'/.test(s)).pop();
    expect(ultimo).not.toMatch(/versao/);
  });

  test('GET do orçamento traz o histórico do mais novo ao mais antigo, filtrado pela empresa', async () => {
    const e = bancoCom(orcamento());
    await pedir({ texto: 'Primeiro pedido' });
    await request(app()).post(`/companies/${CID}/studio/quotes/${QID}/marcar-enviado`).send({});
    await pedir({ texto: 'Segundo pedido' });
    const r = await request(app()).get(`/companies/${CID}/studio/quotes/${QID}`);
    expect(r.status).toBe(200);
    expect(r.body.ajustes.map((a) => [a.texto, a.versao])).toEqual([['Segundo pedido', 2], ['Primeiro pedido', 1]]);
    const sql = e.sqls.find((s) => /FROM studio_quote_ajustes/.test(s) && /ORDER BY/.test(s));
    expect(sql).toMatch(/WHERE quote_id = \$1 AND company_id = \$2/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
  });

  test('GET sem a tabela (sem a 362) devolve histórico vazio', async () => {
    bancoCom(orcamento());
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM studio_quote_ajustes/.test(String(sql))) throw Object.assign(new Error('relation'), { code: '42P01' });
      return original(sql, params);
    });
    const r = await request(app()).get(`/companies/${CID}/studio/quotes/${QID}`);
    expect(r.status).toBe(200);
    expect(r.body.ajustes).toEqual([]);
  });
});
