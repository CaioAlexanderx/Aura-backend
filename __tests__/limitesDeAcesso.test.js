// ============================================================
// Limites de tentativa da porta de entrada (b-tq-71, 17/11/2026)
//
// Sobe o app DE VERDADE com NODE_ENV=development (os limitadores se
// desligam em NODE_ENV=test) e bate nas rotas como o app e um atacante
// bateriam. O que estes testes mostraram ANTES da correcao (codigo de
// origin/main em 17/11, bc6b0186):
//   - login: 11 senhas erradas seguidas para o MESMO e-mail do mesmo IP
//     davam 11 x 401 (o balde era so por IP, 20);
//   - /auth/2fa/validate (publico, user_id + codigo), /auth/verify-email,
//     /auth/verify-phone, /auth/send-verification,
//     /auth/send-phone-verification e /auth/reset-password: nenhum limite
//     de tentativa (so o global de 600/min);
//   - atras do Cloudflare (api.getaura.com.br, loja.getaura.com.br) a
//     chave era o IP da borda do Cloudflare: dois clientes diferentes
//     dividiam o mesmo balde;
//   - IPv6: cada endereco era um balde, e quem tem um /64 tem bilhoes;
//   - o webhook da Asaas passava pelo limite global (601o aviso em 1 min
//     do mesmo IP levava 429).
// ============================================================
'use strict';

const request = require('supertest');

let app;
let query;
let ambienteOriginal;

beforeAll(() => {
  ambienteOriginal = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
  query = require('../src/config/database').query;
  app = require('../src/app');
});

afterAll(() => {
  process.env.NODE_ENV = ambienteOriginal;
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const HOST = 'aura-backend-production-f805.up.railway.app';

/** O Railway poe o IP de quem conectou no fim do X-Forwarded-For. */
function post(caminho, ip, extra = {}) {
  let r = request(app).post(caminho).set('Host', HOST).set('X-Forwarded-For', ip);
  for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
  return r;
}

async function repetir(n, fazer) {
  const status = [];
  for (let i = 0; i < n; i++) status.push((await fazer(i)).status);
  return status;
}

function loginErrado(ip, email, i = 0) {
  return post('/api/v1/auth/login', ip).send({ email, password: 'errada' + i });
}

describe('login: por IP + e-mail', () => {
  test('a 11a senha errada seguida para o mesmo e-mail leva 429, com Retry-After e mensagem gentil', async () => {
    const status = await repetir(10, (i) => loginErrado('203.0.113.40', 'dona@loja.com.br', i));
    expect(status).toEqual(Array(10).fill(401));

    query.mockClear();
    const r = await loginErrado('203.0.113.40', 'Dona@Loja.com.br ', 99); // caixa e espaco nao abrem balde novo
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
    expect(r.body.error).toMatch(/Muitas tentativas/);
    expect(r.body.error).toMatch(/minuto/);
    expect(r.body.retry_after).toBe(Number(r.headers['retry-after']));
    expect(query).not.toHaveBeenCalled(); // nem chega na rota
  });

  test('uso normal: errar algumas vezes e acertar passa, e o acerto nao conta', async () => {
    const hash = require('bcrypt').hashSync('certa', 4);
    const usuario = {
      id: 'u1', name: 'Loja', email: 'caixa@loja.com.br', password_hash: hash,
      role: 'owner', is_active: true, is_staff: false, totp_enabled: true, email_verified: true,
    };
    query.mockResolvedValue({ rows: [usuario] });
    for (let rodada = 0; rodada < 3; rodada++) {
      const erradas = await repetir(3, (i) => loginErrado('203.0.113.41', 'caixa@loja.com.br', i));
      expect(erradas).toEqual(Array(3).fill(401));
      const certa = await post('/api/v1/auth/login', '203.0.113.41')
        .send({ email: 'caixa@loja.com.br', password: 'certa' });
      expect(certa.status).toBe(200);
    }
    // 9 erradas no total + 3 certas: ainda abaixo das 10
    const ultima = await loginErrado('203.0.113.41', 'caixa@loja.com.br', 50);
    expect(ultima.status).toBe(401);
  });

  test('o e-mail travado nao trava os outros do mesmo IP (loja com varios funcionarios)', async () => {
    await repetir(11, (i) => loginErrado('203.0.113.42', 'um@loja.com.br', i));
    const outro = await loginErrado('203.0.113.42', 'outro@loja.com.br');
    expect(outro.status).toBe(401);
  });

  test('IPs diferentes nao se bloqueiam entre si, nem para o mesmo e-mail', async () => {
    await repetir(11, (i) => loginErrado('203.0.113.43', 'mesma@loja.com.br', i));
    const deOutroIp = await loginErrado('198.51.100.43', 'mesma@loja.com.br');
    expect(deOutroIp.status).toBe(401);
  });

  test('o teto por IP (20 erradas) segue valendo para quem troca de e-mail a cada tentativa', async () => {
    const status = await repetir(21, (i) => loginErrado('203.0.113.44', 'chute' + i + '@exemplo.com.br', i));
    expect(status.slice(0, 20)).toEqual(Array(20).fill(401));
    expect(status[20]).toBe(429);
  });
});

describe('codigos e reenvios', () => {
  test('2FA no login (publico): o 11o codigo errado para o mesmo usuario leva 429', async () => {
    const status = await repetir(11, () => post('/api/v1/auth/2fa/validate', '203.0.113.50')
      .send({ user_id: 'u-2fa', token: '000000' }));
    expect(status.slice(0, 10)).not.toContain(429);
    expect(status[10]).toBe(429);
  });

  test.each([
    ['/api/v1/auth/verify-email', { code: '123456' }],
    ['/api/v1/auth/verify-phone', { code: '1234' }],
  ])('%s: a 11a tentativa errada do mesmo IP leva 429', async (caminho, corpo) => {
    const ip = caminho.endsWith('email') ? '203.0.113.51' : '203.0.113.52';
    const status = await repetir(11, () => post(caminho, ip).send(corpo));
    expect(status.slice(0, 10)).not.toContain(429);
    expect(status[10]).toBe(429);
  });

  test.each([
    ['/api/v1/auth/send-verification', '203.0.113.53'],
    ['/api/v1/auth/send-phone-verification', '203.0.113.54'],
  ])('%s (reenvio): o 11o pedido do mesmo IP em 15 min leva 429', async (caminho, ip) => {
    const status = await repetir(11, () => post(caminho, ip).send({}));
    expect(status.slice(0, 10)).not.toContain(429);
    expect(status[10]).toBe(429);
  });

  test('reset-password: a 21a tentativa do mesmo IP leva 429', async () => {
    const status = await repetir(21, (i) => post('/api/v1/auth/reset-password', '203.0.113.55')
      .send({ token: 'chute' + i, password: 'NovaSenha123' }));
    expect(status.slice(0, 20)).not.toContain(429);
    expect(status[20]).toBe(429);
  });

  test('forgot-password: o 6o pedido para o mesmo e-mail do mesmo IP em 1 hora leva 429', async () => {
    const status = await repetir(6, () => post('/api/v1/auth/forgot-password', '203.0.113.56')
      .send({ email: 'esqueci@loja.com.br' }));
    expect(status.slice(0, 5)).toEqual(Array(5).fill(200));
    expect(status[5]).toBe(429);
    // outro e-mail do mesmo IP segue
    const outro = await post('/api/v1/auth/forgot-password', '203.0.113.56').send({ email: 'outra@loja.com.br' });
    expect(outro.status).toBe(200);
  });
});

describe('IP real', () => {
  // 173.245.48.0/20 e uma faixa publicada do Cloudflare
  const BORDA_CF = '173.245.48.77';

  test('atras do Cloudflare, dois clientes na mesma borda nao dividem o balde', async () => {
    await repetir(21, (i) => post('/api/v1/auth/login', BORDA_CF, { 'CF-Connecting-IP': '203.0.113.60' })
      .send({ email: 'cf' + i + '@exemplo.com.br', password: 'x' }));
    const travado = await post('/api/v1/auth/login', BORDA_CF, { 'CF-Connecting-IP': '203.0.113.60' })
      .send({ email: 'cf-fim@exemplo.com.br', password: 'x' });
    expect(travado.status).toBe(429);
    const vizinho = await post('/api/v1/auth/login', BORDA_CF, { 'CF-Connecting-IP': '198.51.100.60' })
      .send({ email: 'cf-fim@exemplo.com.br', password: 'x' });
    expect(vizinho.status).toBe(401);
  });

  test('CF-Connecting-IP forjado por quem NAO e o Cloudflare e ignorado', async () => {
    const status = await repetir(21, (i) => post('/api/v1/auth/login', '203.0.113.61', { 'CF-Connecting-IP': '10.0.0.' + i })
      .send({ email: 'forja' + i + '@exemplo.com.br', password: 'x' }));
    expect(status[20]).toBe(429);
  });

  test('IPv6: enderecos do mesmo /64 sao o mesmo cliente', async () => {
    await repetir(21, (i) => post('/api/v1/auth/login', '2001:db8:1:2::' + (i + 1).toString(16))
      .send({ email: 'v6' + i + '@exemplo.com.br', password: 'x' }));
    const mesmoBloco = await post('/api/v1/auth/login', '2001:db8:1:2:ffff::1')
      .send({ email: 'v6-fim@exemplo.com.br', password: 'x' });
    expect(mesmoBloco.status).toBe(429);
    const outroBloco = await post('/api/v1/auth/login', '2001:db8:1:3::1')
      .send({ email: 'v6-fim@exemplo.com.br', password: 'x' });
    expect(outroBloco.status).toBe(401);
  });
});

describe('webhook fora do limitador', () => {
  test('700 avisos da Asaas em menos de 1 minuto, do mesmo IP, nunca levam 429', async () => {
    const status = new Set();
    for (let i = 0; i < 700; i++) {
      const r = await post('/api/v1/webhooks/asaas', '203.0.113.70').send({ event: 'PAYMENT_RECEIVED' });
      status.add(r.status);
    }
    expect(status.has(429)).toBe(false);
  }, 60000);

  test('o limite global segue valendo para o resto da API', async () => {
    let viu429 = false;
    for (let i = 0; i < 601 && !viu429; i++) {
      const r = await request(app).get('/api/v1/rota-que-nao-existe').set('Host', HOST).set('X-Forwarded-For', '203.0.113.71');
      if (r.status === 429) viu429 = true;
    }
    expect(viu429).toBe(true);
  }, 60000);
});

describe('ipDoCliente e chaveDoCliente (unidade)', () => {
  const { ipDoCliente, chaveDoCliente, _internos } = require('../src/middleware/limitesDeAcesso');
  const req = (ip, cf) => ({ ip, headers: cf ? { 'cf-connecting-ip': cf } : {} });

  test('IPv4 embrulhado em IPv6 vira IPv4', () => {
    expect(ipDoCliente(req('::ffff:203.0.113.9'))).toBe('203.0.113.9');
  });

  test('borda IPv6 do Cloudflare tambem libera o CF-Connecting-IP', () => {
    expect(ipDoCliente(req('2606:4700:10::ac43:1', '203.0.113.9'))).toBe('203.0.113.9');
  });

  test('CF-Connecting-IP invalido e ignorado', () => {
    expect(ipDoCliente(req('173.245.48.1', 'nao-e-ip'))).toBe('173.245.48.1');
  });

  test('sem IP nenhum, um balde "desconhecido" (nunca quebra)', () => {
    expect(ipDoCliente({ headers: {} })).toBe('desconhecido');
  });

  test('IPv6 vira o /64, com "::" e IPv4 no fim', () => {
    expect(chaveDoCliente(req('2001:db8::1'))).toBe('2001:0db8:0000:0000::/64');
    expect(chaveDoCliente(req('2001:db8:a:b:c:d:e:f'))).toBe('2001:0db8:000a:000b::/64');
    expect(_internos.expandirIpv6('64:ff9b::192.0.2.33')).toEqual(['0064', 'ff9b', '0000', '0000', '0000', '0000', 'c000', '0221']);
    expect(chaveDoCliente(req('::1'))).toBe('0000:0000:0000:0000::/64');
  });
});
