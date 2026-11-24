// ============================================================
// AURA ÓTICA — Foto do papel da receita (p-212, 23/11/2026)
//
// O que este arquivo trava:
//   1. capabilities.prescription_photo só com o bucket privado configurado
//   2. POST /photo: tipo, tamanho, base64 e assinatura dos bytes; 503 sem
//      bucket; 404 para receita de outra empresa; grava a CHAVE no prefixo
//      da empresa/receita e apaga a foto anterior
//   3. leitura: só assina chave do próprio prefixo; chave de outra empresa
//      vira null; nunca devolve URL pública do bucket
//   4. PATCH/POST não gravam chave forjada nem soltam a foto existente
//   5. DELETE /photo e DELETE da receita apagam o arquivo
//   6. r2Privado não liga sem bucket, nem com o bucket público
//   7. parser de 8 MB só na rota da foto, com 413 que fala da foto
//
// Banco e bucket mockados.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/utils/r2Privado', () => ({
  disponivel: jest.fn(() => true),
  enviar: jest.fn(async () => ({ ok: true })),
  urlAssinada: jest.fn(async (key) => `https://assinada.example/${key}?X-Amz-Expires=900`),
  apagar: jest.fn(async () => ({ ok: true })),
}));

const db = require('../src/config/database');
const r2Privado = require('../src/utils/r2Privado');
const oticaRouter = require('../src/routes/otica');

const CO = '11111111-1111-4111-8111-111111111111';
const OUTRA = '22222222-2222-4222-8222-222222222222';
const RX = '33333333-3333-4333-8333-333333333333';
const PREFIXO = `otica/${CO}/prescriptions/${RX}/`;

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use('/companies/:id/otica', (req, res, next) => { req.user = { id: null }; next(); }, oticaRouter);

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(60, 3)]);

function rx(over) {
  return { id: RX, company_id: CO, customer_id: 'c1', customer_name: 'Maria', photo_url: null, ...over };
}

// Estado do "banco": a receita e o que os UPDATEs fizeram nela.
let receita;
let updates;
function mockBanco({ oticaLigada = true, existe = true } = {}) {
  updates = [];
  db.query.mockImplementation(async (sql, params) => {
    if (/pdv_settings->>'otica_enabled'/.test(sql)) return { rows: [{ enabled: oticaLigada ? 'true' : 'false' }] };
    if (/SELECT otica_settings FROM companies/.test(sql)) return { rows: [{ otica_settings: {} }] };
    if (/FROM optical_prescriptions p/.test(sql) && /WHERE p\.id = \$1 AND p\.company_id = \$2/.test(sql)) {
      return { rows: existe && params[1] === CO ? [receita] : [] };
    }
    if (/FROM optical_prescriptions p/.test(sql)) return { rows: [receita] };
    if (/UPDATE optical_prescriptions SET photo_url = \$1/.test(sql)) {
      updates.push({ sql, params });
      receita = { ...receita, photo_url: params[0] };
      return { rows: [] };
    }
    if (/UPDATE optical_prescriptions SET photo_url = NULL/.test(sql)) {
      updates.push({ sql, params });
      receita = { ...receita, photo_url: null };
      return { rows: [] };
    }
    if (/UPDATE optical_prescriptions SET/.test(sql)) {
      updates.push({ sql, params });
      return { rows: [] };
    }
    if (/FROM service_orders/.test(sql)) return { rows: [] };
    if (/DELETE FROM optical_prescriptions/.test(sql)) return { rows: [] };
    if (/INSERT INTO optical_prescriptions/.test(sql)) {
      updates.push({ sql, params });
      return { rows: [{ id: RX }] };
    }
    if (/FROM customers WHERE id/.test(sql)) return { rows: [{ id: 'c1' }] };
    throw new Error('inesperada: ' + sql);
  });
}

const enviarFoto = (body, empresa = CO) => request(app).post(`/companies/${empresa}/otica/prescriptions/${RX}/photo`).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  r2Privado.disponivel.mockReturnValue(true);
  r2Privado.enviar.mockResolvedValue({ ok: true });
  receita = rx();
  mockBanco();
});

// ── 1 ─────────────────────────────────────────────────────
describe('GET /otica/settings — capabilities', () => {
  it('com bucket privado: prescription_photo true', async () => {
    const r = await request(app).get(`/companies/${CO}/otica/settings`);
    expect(r.status).toBe(200);
    expect(r.body.capabilities).toEqual({ prescription_photo: true });
    expect(r.body.settings).toBeDefined();
  });
  it('sem bucket privado: false', async () => {
    r2Privado.disponivel.mockReturnValue(false);
    const r = await request(app).get(`/companies/${CO}/otica/settings`);
    expect(r.body.capabilities).toEqual({ prescription_photo: false });
  });
});

// ── 2 ─────────────────────────────────────────────────────
describe('POST /prescriptions/:rxId/photo', () => {
  it.each([
    ['JPG', JPG, 'image/jpeg', 'jpg'],
    ['PNG', PNG, 'image/png', 'png'],
    ['WEBP', WEBP, 'image/webp', 'webp'],
  ])('%s: grava a chave no prefixo da empresa e devolve URL assinada', async (_n, buf, tipo, ext) => {
    const r = await enviarFoto({ content: buf.toString('base64'), content_type: tipo });
    expect(r.status).toBe(200);
    const key = r2Privado.enviar.mock.calls[0][0];
    expect(key).toMatch(new RegExp(`^${PREFIXO}[0-9a-f-]{36}\\.${ext}$`));
    expect(r2Privado.enviar.mock.calls[0][1].equals(buf)).toBe(true);
    expect(updates[0].params).toEqual([key, RX, CO]);
    expect(r.body.prescription.photo_url).toBe(`https://assinada.example/${key}?X-Amz-Expires=900`);
    expect(r2Privado.urlAssinada).toHaveBeenCalledWith(key, 900);
  });

  it('aceita o prefixo data: e quebras de linha no base64', async () => {
    const b64 = JPG.toString('base64');
    const r = await enviarFoto({ content: `data:image/jpeg;base64,${b64.slice(0, 10)}\n${b64.slice(10)}`, content_type: 'image/jpeg' });
    expect(r.status).toBe(200);
  });

  it('trocar a foto apaga a anterior', async () => {
    receita = rx({ photo_url: `${PREFIXO}antiga.jpg` });
    const r = await enviarFoto({ content: JPG.toString('base64'), content_type: 'image/jpeg' });
    expect(r.status).toBe(200);
    expect(r2Privado.apagar).toHaveBeenCalledWith(`${PREFIXO}antiga.jpg`);
  });

  it.each([
    ['tipo fora da lista', { content: JPG.toString('base64'), content_type: 'application/pdf' }],
    ['sem conteúdo', { content_type: 'image/jpeg' }],
    ['base64 quebrado', { content: '@@@###', content_type: 'image/jpeg' }],
    ['bytes não são do tipo', { content: PNG.toString('base64'), content_type: 'image/jpeg' }],
    ['texto disfarçado', { content: Buffer.from('<html>oi</html> xxxxxxxx').toString('base64'), content_type: 'image/png' }],
  ])('%s -> 400 FOTO_INVALIDA, nada enviado', async (_n, body) => {
    const r = await enviarFoto(body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FOTO_INVALIDA');
    expect(r2Privado.enviar).not.toHaveBeenCalled();
  });

  it('mais de 5 MB -> 400 FOTO_INVALIDA', async () => {
    const grande = Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)]);
    const r = await enviarFoto({ content: grande.toString('base64'), content_type: 'image/jpeg' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FOTO_INVALIDA');
  });

  it('sem bucket privado -> 503, nada enviado', async () => {
    r2Privado.disponivel.mockReturnValue(false);
    const r = await enviarFoto({ content: JPG.toString('base64'), content_type: 'image/jpeg' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('FOTO_INDISPONIVEL');
    expect(r2Privado.enviar).not.toHaveBeenCalled();
  });

  it('ótica desligada -> 403 OTICA_DISABLED', async () => {
    mockBanco({ oticaLigada: false });
    const r = await enviarFoto({ content: JPG.toString('base64'), content_type: 'image/jpeg' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('OTICA_DISABLED');
  });

  it('receita de outra empresa -> 404, nada enviado', async () => {
    const r = await enviarFoto({ content: JPG.toString('base64'), content_type: 'image/jpeg' }, OUTRA);
    expect(r.status).toBe(404);
    expect(r2Privado.enviar).not.toHaveBeenCalled();
  });

  it('falha no bucket -> 502 e photo_url não muda', async () => {
    r2Privado.enviar.mockResolvedValue({ ok: false });
    const r = await enviarFoto({ content: JPG.toString('base64'), content_type: 'image/jpeg' });
    expect(r.status).toBe(502);
    expect(updates).toHaveLength(0);
  });
});

// ── 3 ─────────────────────────────────────────────────────
describe('leitura: só a chave da própria receita é assinada', () => {
  const { _comFotoAssinada } = oticaRouter;
  it('chave própria -> URL assinada', async () => {
    const out = await _comFotoAssinada(rx({ photo_url: `${PREFIXO}a.jpg` }));
    expect(out.photo_url).toMatch(/^https:\/\/assinada\.example\//);
  });
  it('chave de outra empresa ou de outra receita -> null, sem assinar', async () => {
    expect((await _comFotoAssinada(rx({ photo_url: `otica/${OUTRA}/prescriptions/${RX}/a.jpg` }))).photo_url).toBeNull();
    expect((await _comFotoAssinada(rx({ photo_url: `otica/${CO}/prescriptions/outra/a.jpg` }))).photo_url).toBeNull();
    expect(r2Privado.urlAssinada).not.toHaveBeenCalled();
  });
  it('link http(s) antigo fica; lixo vira null; sem foto, null', async () => {
    expect((await _comFotoAssinada(rx({ photo_url: 'https://exemplo.com/f.jpg' }))).photo_url).toBe('https://exemplo.com/f.jpg');
    expect((await _comFotoAssinada(rx({ photo_url: 'qualquer/coisa.jpg' }))).photo_url).toBeNull();
    expect((await _comFotoAssinada(rx())).photo_url).toBeNull();
  });
  it('GET da receita e da lista assinam', async () => {
    receita = rx({ photo_url: `${PREFIXO}a.jpg` });
    const um = await request(app).get(`/companies/${CO}/otica/prescriptions/${RX}`);
    expect(um.body.prescription.photo_url).toMatch(/^https:\/\/assinada\.example\//);
    const lista = await request(app).get(`/companies/${CO}/otica/prescriptions`);
    expect(lista.body.prescriptions[0].photo_url).toMatch(/^https:\/\/assinada\.example\//);
    expect(JSON.stringify(lista.body)).not.toMatch(/r2\.getaura\.com\.br/);
  });
});

// ── 4 ─────────────────────────────────────────────────────
describe('PATCH/POST não mexem na chave privada', () => {
  it('PATCH com chave forjada não grava photo_url', async () => {
    const r = await request(app).patch(`/companies/${CO}/otica/prescriptions/${RX}`)
      .send({ photo_url: `otica/${OUTRA}/prescriptions/x/y.jpg`, notes: 'oi' });
    expect(r.status).toBe(200);
    expect(updates[0].sql).not.toMatch(/photo_url/);
    expect(updates[0].sql).toMatch(/notes = \$1/);
  });
  it('PATCH com texto não solta a foto privada que já existe', async () => {
    receita = rx({ photo_url: `${PREFIXO}a.jpg` });
    const r = await request(app).patch(`/companies/${CO}/otica/prescriptions/${RX}`).send({ photo_url: null });
    expect(r.status).toBe(200);
    expect(updates).toHaveLength(0);
  });
  it('POST com chave forjada cria a receita sem photo_url', async () => {
    const r = await request(app).post(`/companies/${CO}/otica/prescriptions`)
      .send({ customer_id: 'c1', issued_at: '2026-11-20', photo_url: `otica/${OUTRA}/prescriptions/x/y.jpg` });
    expect(r.status).toBe(201);
    const insert = updates.find(u => /INSERT INTO optical_prescriptions/.test(u.sql));
    expect(insert.sql).not.toMatch(/photo_url/);
  });
});

// ── 5 ─────────────────────────────────────────────────────
describe('DELETE apaga o arquivo', () => {
  it('DELETE /photo zera e apaga', async () => {
    receita = rx({ photo_url: `${PREFIXO}a.jpg` });
    const r = await request(app).delete(`/companies/${CO}/otica/prescriptions/${RX}/photo`);
    expect(r.status).toBe(200);
    expect(r.body.prescription.photo_url).toBeNull();
    expect(r2Privado.apagar).toHaveBeenCalledWith(`${PREFIXO}a.jpg`);
  });
  it('DELETE da receita apaga a foto junto', async () => {
    receita = rx({ photo_url: `${PREFIXO}a.jpg` });
    const r = await request(app).delete(`/companies/${CO}/otica/prescriptions/${RX}`);
    expect(r.status).toBe(200);
    expect(r2Privado.apagar).toHaveBeenCalledWith(`${PREFIXO}a.jpg`);
  });
  it('link antigo não é apagado do bucket', async () => {
    receita = rx({ photo_url: 'https://exemplo.com/f.jpg' });
    await request(app).delete(`/companies/${CO}/otica/prescriptions/${RX}/photo`);
    expect(r2Privado.apagar).not.toHaveBeenCalled();
  });
});

// ── 6 ─────────────────────────────────────────────────────
describe('r2Privado.disponivel', () => {
  const real = jest.requireActual('../src/utils/r2Privado');
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; });
  const credenciais = () => {
    process.env.R2_ACCOUNT_ID = 'acc'; process.env.R2_ACCESS_KEY_ID = 'k'; process.env.R2_SECRET_ACCESS_KEY = 's';
  };
  it('sem R2_PRIVATE_BUCKET_NAME: false', () => {
    credenciais();
    delete process.env.R2_PRIVATE_BUCKET_NAME;
    expect(real.disponivel()).toBe(false);
  });
  it('bucket privado igual ao público: false', () => {
    credenciais();
    process.env.R2_BUCKET_NAME = 'aura-storage';
    process.env.R2_PRIVATE_BUCKET_NAME = 'aura-storage';
    expect(real.disponivel()).toBe(false);
  });
  it('bucket próprio e credenciais: true', () => {
    credenciais();
    process.env.R2_PRIVATE_BUCKET_NAME = 'aura-privado';
    expect(real.disponivel()).toBe(true);
  });
  it('sem configuração, nunca devolve URL pública', async () => {
    delete process.env.R2_PRIVATE_BUCKET_NAME;
    expect(await real.urlAssinada('otica/x/prescriptions/y/z.jpg')).toBeNull();
    expect(await real.enviar('k', Buffer.from('x'), 'image/jpeg')).toEqual({ ok: false });
  });
});

// ── 7 ─────────────────────────────────────────────────────
describe('parser de 8 MB só na rota da foto', () => {
  const { montarJsonDeUpload, ROTA_DA_FOTO_DA_RECEITA } = require('../src/middleware/jsonDeUpload');
  const appReal = express();
  montarJsonDeUpload(appReal);
  appReal.use(express.json({ limit: '5mb' }));
  appReal.post(ROTA_DA_FOTO_DA_RECEITA, (req, res) => res.json({ tamanho: req.body.content.length }));
  appReal.post('/api/v1/companies/:id/outra', (req, res) => res.json({ ok: true }));
  const corpo = { content: 'A'.repeat(6.5 * 1024 * 1024), content_type: 'image/jpeg' };

  it('6,5 MB de base64 passam na rota da foto', async () => {
    const r = await request(appReal).post(`/api/v1/companies/${CO}/otica/prescriptions/${RX}/photo`).send(corpo);
    expect(r.status).toBe(200);
  });
  it('acima de 8 MB: 413 que fala da foto', async () => {
    const r = await request(appReal).post(`/api/v1/companies/${CO}/otica/prescriptions/${RX}/photo`)
      .send({ ...corpo, content: 'A'.repeat(9 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('FOTO_INVALIDA');
  });
  it('outra rota continua com 5 MB', async () => {
    const r = await request(appReal).post(`/api/v1/companies/${CO}/outra`).send(corpo);
    expect(r.status).toBe(413);
  });
});
