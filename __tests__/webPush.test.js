// ============================================================
// Web Push do painel (10/09/2026)
//
// A cifra e o VAPID sao feitos a mao sobre o crypto do Node. O que trava:
//   1. RFC 8291, Apendice A: com as chaves e o salt do exemplo, o corpo tem
//      que sair IDENTICO ao da RFC. E o unico jeito de saber que um
//      navegador real consegue decifrar — ida e volta com a nossa propria
//      decifragem provaria so coerencia, nao compatibilidade.
//   2. VAPID: a assinatura confere com a chave publica, aud e a origem.
//   3. SSRF: so servicos de push de navegador sao aceitos como destino.
//   4. Faxina: 404/410 apaga a inscricao; tabela ausente nao derruba nada.
// ============================================================
'use strict';

const crypto = require('crypto');

jest.mock('../src/config/database');
const db = require('../src/config/database');
const webPush = require('../src/services/webPush');

const { _b64u: b64u, _deB64u: deB64u } = webPush;

beforeEach(() => {
  jest.resetAllMocks();
  webPush._resetCache();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});

describe('RFC 8291 — vetor de teste do Apendice A', () => {
  const PLAINTEXT = 'When I grow up, I want to be a watermelon';
  const AS_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
  const AS_PUBLIC = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
  const SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
  const ESPERADO =
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

  test('o corpo cifrado sai identico ao da RFC', () => {
    const corpo = webPush.cifrarConteudo(PLAINTEXT, UA_PUBLIC, AUTH, { chavePrivadaServidor: AS_PRIVATE, salt: SALT });
    expect(b64u(corpo)).toBe(ESPERADO);
  });

  test('o cabecalho carrega salt, rs=4096 e a chave publica do servidor', () => {
    const corpo = webPush.cifrarConteudo(PLAINTEXT, UA_PUBLIC, AUTH, { chavePrivadaServidor: AS_PRIVATE, salt: SALT });
    expect(b64u(corpo.subarray(0, 16))).toBe(SALT);
    expect(corpo.readUInt32BE(16)).toBe(4096);
    expect(corpo[20]).toBe(65);
    expect(b64u(corpo.subarray(21, 86))).toBe(AS_PUBLIC);
  });
});

describe('ida e volta com chaves novas', () => {
  // Decifragem do lado do navegador, escrita a partir da RFC, so para o teste.
  function decifrar(corpo, ecdhNavegador, segredo) {
    const salt = corpo.subarray(0, 16);
    const idlen = corpo[20];
    const chaveServidor = corpo.subarray(21, 21 + idlen);
    const cifrado = corpo.subarray(21 + idlen);
    const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const segredoEcdh = ecdhNavegador.computeSecret(chaveServidor);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ecdhNavegador.getPublicKey(), chaveServidor]);
    const prk = h(salt, h(h(segredo, segredoEcdh), Buffer.concat([keyInfo, Buffer.from([1])])));
    const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1')).subarray(0, 16);
    const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0', 'latin1')).subarray(0, 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(cifrado.subarray(cifrado.length - 16));
    const texto = Buffer.concat([d.update(cifrado.subarray(0, cifrado.length - 16)), d.final()]);
    return texto.subarray(0, texto.lastIndexOf(2)).toString();
  }

  test('o navegador decifra o que o servidor cifrou', () => {
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const segredo = crypto.randomBytes(16);
    const conteudo = JSON.stringify({ title: 'Pedido novo #00042', body: 'R$ 129,90 — Davi' });
    const corpo = webPush.cifrarConteudo(conteudo, b64u(ua.getPublicKey()), b64u(segredo));
    expect(decifrar(corpo, ua, segredo)).toBe(conteudo);
  });

  test('chave de navegador ou segredo invalidos sao recusados', () => {
    expect(() => webPush.cifrarConteudo('x', b64u(Buffer.alloc(33)), b64u(crypto.randomBytes(16)))).toThrow('p256dh');
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    expect(() => webPush.cifrarConteudo('x', b64u(ua.getPublicKey()), b64u(Buffer.alloc(8)))).toThrow('auth');
  });
});

describe('VAPID', () => {
  test('chaves geradas tem 65 e 32 bytes', () => {
    const k = webPush.gerarChavesVapid();
    expect(deB64u(k.publicKey)).toHaveLength(65);
    expect(deB64u(k.privateKey)).toHaveLength(32);
  });

  test('o JWT confere com a chave publica, aud e a origem e vale 12h', () => {
    const k = webPush.gerarChavesVapid();
    const agora = 1_788_000_000;
    const cab = webPush.cabecalhoVapid('https://fcm.googleapis.com/fcm/send/abc:def', { ...k, subject: 'https://getaura.com.br' }, agora);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(cab);
    expect(m).toBeTruthy();
    expect(m[4]).toBe(k.publicKey);
    const carga = JSON.parse(deB64u(m[2]).toString());
    expect(carga).toEqual({ aud: 'https://fcm.googleapis.com', exp: agora + 12 * 3600, sub: 'https://getaura.com.br' });
    const pub = deB64u(k.publicKey);
    const chavePublica = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk',
    });
    const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: chavePublica, dsaEncoding: 'ieee-p1363' }, deB64u(m[3]));
    expect(ok).toBe(true);
  });

  test('chaves do ambiente vencem o banco', async () => {
    const k = webPush.gerarChavesVapid();
    process.env.VAPID_PUBLIC_KEY = k.publicKey;
    process.env.VAPID_PRIVATE_KEY = k.privateKey;
    const chaves = await webPush.getVapidKeys();
    expect(chaves.publicKey).toBe(k.publicKey);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sem ambiente e sem linha no banco, gera UMA vez e le o que ficou gravado', async () => {
    const gravadas = [];
    db.query.mockImplementation((sql, params) => {
      if (/^SELECT public_key/.test(sql)) {
        return Promise.resolve({ rows: gravadas.length ? [gravadas[0]] : [] });
      }
      if (/INSERT INTO web_push_config/.test(sql)) {
        gravadas.push({ public_key: params[0], private_key: params[1], subject: params[2] });
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const a = await webPush.getVapidKeys();
    const b = await webPush.getVapidKeys();
    expect(a.publicKey).toBe(gravadas[0].public_key);
    expect(b).toBe(a);
    expect(db.query.mock.calls.filter(([s]) => /INSERT/.test(s))).toHaveLength(1);
  });
});

describe('inscricao: so servicos de push de navegador', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };

  test.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGuQ',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
  ])('aceita %s', (endpoint) => {
    expect(webPush.validarInscricao({ endpoint, keys })).toEqual({ endpoint, ...keys });
  });

  test.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://localhost/push',
    'https://api.getaura.com.br/api/v1/admin',
    'https://fcm.googleapis.com.evil.com/x',
    'https://169.254.169.254/latest/meta-data',
    'nao-e-url',
  ])('recusa %s', (endpoint) => {
    expect(webPush.validarInscricao({ endpoint, keys }).erro).toBeTruthy();
  });

  test('recusa chaves quebradas', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(webPush.validarInscricao({ endpoint, keys: { ...keys, p256dh: 'abc' } }).erro).toBeTruthy();
    expect(webPush.validarInscricao({ endpoint, keys: { ...keys, auth: 'abc' } }).erro).toBeTruthy();
    expect(webPush.validarInscricao({ endpoint }).erro).toBeTruthy();
  });
});

describe('envio e faxina', () => {
  function navegador(id) {
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    return { id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
  }

  beforeEach(() => {
    const k = webPush.gerarChavesVapid();
    process.env.VAPID_PUBLIC_KEY = k.publicKey;
    process.env.VAPID_PRIVATE_KEY = k.privateKey;
  });

  test('201 conta como enviado; 410 apaga a inscricao; 500 e falha', async () => {
    const subs = [navegador('a'), navegador('b'), navegador('c')];
    db.query.mockImplementation((sql) => {
      if (/FROM web_push_subscriptions/.test(sql)) return Promise.resolve({ rows: subs });
      return Promise.resolve({ rows: [] });
    });
    const status = { a: 201, b: 410, c: 500 };
    global.fetch = jest.fn((url) => Promise.resolve({ status: status[url.split('/').pop()] }));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const r = await webPush.notifyCompany('c1', { title: 'Pedido novo #1', body: 'R$ 10', url: '/canal', tag: 'pedido:1' });

    expect(r).toEqual({ enviados: 1, removidos: 1, falhas: 1 });
    const apagou = db.query.mock.calls.filter(([s]) => /DELETE FROM web_push_subscriptions/.test(s));
    expect(apagou).toHaveLength(1);
    expect(apagou[0][1]).toEqual(['b']);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['Content-Encoding']).toBe('aes128gcm');
    expect(opts.headers.TTL).toBe(String(webPush.TTL_SEGUNDOS));
    expect(opts.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    console.error.mockRestore();
  });

  test('empresa sem inscricao nao chama ninguem', async () => {
    db.query.mockResolvedValue({ rows: [] });
    global.fetch = jest.fn();
    expect(await webPush.notifyCompany('c1', { title: 'x' })).toEqual({ enviados: 0, removidos: 0, falhas: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('migration 324 ausente nao derruba o aviso', async () => {
    db.query.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    global.fetch = jest.fn();
    expect(await webPush.notifyCompany('c1', { title: 'x' })).toEqual({ enviados: 0, removidos: 0, falhas: 0 });
  });
});
