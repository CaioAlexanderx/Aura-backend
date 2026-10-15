// ============================================================
// AURA. -- Testes: POST /api/v1/public/leads com o filtro anti-robo (t2-12)
//
// O que estes testes travam:
//   1. lead de verdade (nome brasileiro, mensagem em portugues) segue o fluxo
//      de sempre: INSERT em sales_leads + lead_interactions, 201
//   2. honeypot `hp` (e os nomes antigos): 200, nada gravado em lugar nenhum
//   3. robo (tempo < 3 s, nome conhecido, mensagem-modelo, ingles com link):
//      NAO entra em sales_leads; vai para site_lead_spam com o motivo; a
//      resposta e igual a de um lead novo
//   4. Turnstile: com TURNSTILE_SECRET + token invalido = barrado; valido =
//      segue; Cloudflare fora do ar = segue; sem segredo ou sem token = nao
//      chama a Cloudflare
//   5. migration 388 pendente (42P01): o robo e descartado e nada quebra
//   6. lead parcial nao tem a regra do tempo
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const request = require('supertest');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const URL = '/api/v1/public/leads';
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();

let clientSqls;
function ligarBanco({ semTabelaSpam = false } = {}) {
  clientSqls = [];
  const client = { release: jest.fn() };
  client.query = jest.fn(async (sql) => {
    const s = limpo(sql);
    clientSqls.push(s);
    if (s.startsWith('INSERT INTO sales_leads')) return { rows: [{ id: 'lead-1' }] };
    return { rows: [] };
  });
  db.connect.mockResolvedValue(client);
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    if (s.startsWith('INSERT INTO site_lead_spam')) {
      if (semTabelaSpam) throw Object.assign(new Error('relation "site_lead_spam" does not exist'), { code: '42P01' });
      return { rows: [{ id: 'spam-1' }] };
    }
    return { rows: [] };
  });
}
const spamGravado = () => db.query.mock.calls.find((c) => limpo(c[0]).startsWith('INSERT INTO site_lead_spam'));
const leadGravado = () => clientSqls.some((s) => s.startsWith('INSERT INTO sales_leads'));

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.connect.mockReset();
  delete process.env.TURNSTILE_SECRET;
  ligarBanco();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.TURNSTILE_SECRET;
});

const real = { nome: 'Marina Prado', whatsapp: '(12) 98888-0001', mensagem: 'Quero conhecer o sistema para a minha loja de roupas.', elapsed_ms: 18000, hp: '' };

describe('lead de verdade', () => {
  test('segue o fluxo de sempre', async () => {
    const res = await request(app).post(URL).send(real);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, id: 'lead-1', partial: false });
    expect(leadGravado()).toBe(true);
    expect(clientSqls.some((s) => s.startsWith('INSERT INTO lead_interactions'))).toBe(true);
    expect(spamGravado()).toBeUndefined();
  });

  test('site antigo (sem hp nem elapsed_ms) continua entrando', async () => {
    const { hp, elapsed_ms, ...antigo } = real;
    const res = await request(app).post(URL).send(antigo);
    expect(res.status).toBe(201);
    expect(leadGravado()).toBe(true);
  });

  test('lead parcial so com telefone e tempo curto entra (a regra do tempo e do envio completo)', async () => {
    const res = await request(app).post(URL).send({ partial: true, whatsapp: '(96) 99188-9193', mensagem: 'Pediu para ser chamado no WhatsApp (site: /)', elapsed_ms: 800 });
    expect(res.status).toBe(201);
    expect(res.body.partial).toBe(true);
    expect(leadGravado()).toBe(true);
    expect(spamGravado()).toBeUndefined();
  });
});

describe('honeypot', () => {
  test.each(['hp', '_empresa', 'honeypot'])('%s preenchido: 200, nada gravado', async (campo) => {
    const res = await request(app).post(URL).send({ ...real, [campo]: 'Acme Ltda' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.connect).not.toHaveBeenCalled();
    expect(spamGravado()).toBeUndefined();
  });
});

describe('robo vai para site_lead_spam, nao para sales_leads', () => {
  const casos = [
    ['tempo < 3 s', { ...real, elapsed_ms: 900 }, 'rapido_demais'],
    ['nome conhecido', { nome: 'Harryseeno', mensagem: 'Hola, volia saber el seu preu.', elapsed_ms: 9000 }, 'nome_conhecido'],
    ['mensagem-modelo', { nome: 'Sarah', whatsapp: '', email: 'sarah@example.com', mensagem: 'Gostaria de mais informações. Por favor, contacte-me por e-mail — erp e sistema de gestão para loja.', elapsed_ms: 9000 }, 'mensagem_modelo'],
    ['ingles com link', { nome: 'Tom', email: 'tom@example.com', mensagem: 'Win a free PlayStation 5 today https://example.xyz/win', elapsed_ms: 9000 }, 'mensagem_em_ingles'],
  ];

  test.each(casos)('%s', async (_nome, corpo, motivo) => {
    const res = await request(app).post(URL).send(corpo);
    // mesma cara de um lead novo: o robo nao aprende
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, id: 'spam-1', partial: false, upgraded: false, deduped: false });
    expect(leadGravado()).toBe(false);
    expect(db.connect).not.toHaveBeenCalled();
    const [sql, params] = spamGravado();
    expect(limpo(sql)).toContain('INSERT INTO site_lead_spam');
    expect(params[0]).toBe(motivo);
    expect(params[1]).toBe('site');
  });

  test('guarda o que a pessoa mandou (para recuperar falso positivo)', async () => {
    await request(app).post(URL).send({ ...real, elapsed_ms: 1500, email: 'marina@loja.com' });
    const params = spamGravado()[1];
    expect(params).toEqual(['rapido_demais', 'site', 'Marina Prado', '(12) 98888-0001', 'marina@loja.com', null, null, null, real.mensagem, 1500]);
  });

  test('migration 388 pendente: o robo e descartado e a resposta e a mesma', async () => {
    ligarBanco({ semTabelaSpam: true });
    const res = await request(app).post(URL).send({ nome: 'Roberthaupt', mensagem: 'Hallo, ek wou jou prys ken.', elapsed_ms: 9000 });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(leadGravado()).toBe(false);
  });

  test('envio invalido continua 400 (validacao vem antes do filtro)', async () => {
    const res = await request(app).post(URL).send({ nome: 'A', elapsed_ms: 100 });
    expect(res.status).toBe(400);
    expect(spamGravado()).toBeUndefined();
  });
});

describe('Turnstile', () => {
  const resposta = (json, status = 200) => jest.spyOn(global, 'fetch').mockResolvedValue({ status, json: async () => json });

  test('com segredo e token invalido: barrado como turnstile_invalido', async () => {
    process.env.TURNSTILE_SECRET = 'segredo-de-teste';
    const f = resposta({ success: false, 'error-codes': ['invalid-input-response'] });
    const res = await request(app).post(URL).send({ ...real, turnstile_token: 'tok-ruim' });
    expect(res.status).toBe(201);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(leadGravado()).toBe(false);
    expect(spamGravado()[1][0]).toBe('turnstile_invalido');
  });

  test('com segredo e token valido: entra normalmente (campo padrao do widget)', async () => {
    process.env.TURNSTILE_SECRET = 'segredo-de-teste';
    resposta({ success: true });
    const res = await request(app).post(URL).send({ ...real, 'cf-turnstile-response': 'tok-bom' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('lead-1');
    expect(leadGravado()).toBe(true);
  });

  test('Cloudflare fora do ar: ninguem e barrado por isso', async () => {
    process.env.TURNSTILE_SECRET = 'segredo-de-teste';
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const res = await request(app).post(URL).send({ ...real, turnstile_token: 'tok' });
    expect(res.status).toBe(201);
    expect(leadGravado()).toBe(true);
  });

  test('segredo definido mas sem token: nao exige e nao chama a Cloudflare', async () => {
    process.env.TURNSTILE_SECRET = 'segredo-de-teste';
    const f = resposta({ success: true });
    const res = await request(app).post(URL).send(real);
    expect(res.status).toBe(201);
    expect(f).not.toHaveBeenCalled();
    expect(leadGravado()).toBe(true);
  });

  test('token mas sem segredo no servidor: nao chama a Cloudflare', async () => {
    const f = resposta({ success: false });
    const res = await request(app).post(URL).send({ ...real, turnstile_token: 'tok' });
    expect(res.status).toBe(201);
    expect(f).not.toHaveBeenCalled();
    expect(leadGravado()).toBe(true);
  });

  test('ja barrado pelas regras locais: nao gasta chamada na Cloudflare', async () => {
    process.env.TURNSTILE_SECRET = 'segredo-de-teste';
    const f = resposta({ success: true });
    await request(app).post(URL).send({ ...real, nome: 'Harryseeno', turnstile_token: 'tok' });
    expect(f).not.toHaveBeenCalled();
    expect(spamGravado()[1][0]).toBe('nome_conhecido');
  });
});
