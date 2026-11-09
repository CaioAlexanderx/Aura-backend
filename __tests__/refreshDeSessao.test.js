// ============================================================
// AURA. — POST /auth/refresh (services/refreshDeSessao.js)
//
// Incidente 09/11/2026: o app instalado (PWA) deslogava. Este teste segura:
//   · 401 só para token inválido, expirado, revogado ou usuário desativado;
//   · falha do servidor (banco, contexto) vira 503, nunca 401;
//   · app instalado: prazo deslizante de 30 dias sem uso;
//   · navegador comum: 7 dias do login, sem deslizar, sem token novo;
//   · resposta com refresh token novo que se perde não desloga.
// ============================================================
'use strict';

const jwt = require('jsonwebtoken');
const s = require('../src/services/refreshDeSessao');

const SECRET = 'segredo-de-teste';
const DIA = 24 * 60 * 60 * 1000;
const UID = '11111111-1111-4111-8111-111111111111';

// db falso: refresh_tokens em memória + users.
function criarDb({ usuarioAtivo = true, falhar = {} } = {}) {
  const linhas = [];
  const chamadas = [];
  const db = {
    linhas,
    chamadas,
    async query(sql, params) {
      chamadas.push(sql);
      if (/FROM refresh_tokens/.test(sql)) {
        if (falhar.refresh_tokens) throw new Error('timeout do pooler');
        return { rows: linhas.filter((l) => l.token_hash === params[0] && l.user_id === params[1]) };
      }
      if (/FROM users/.test(sql)) {
        if (falhar.users) throw new Error('connection terminated');
        return { rows: usuarioAtivo ? [{ id: params[0], role: 'user', is_staff: false }] : [] };
      }
      if (/^INSERT INTO refresh_tokens/.test(sql)) {
        if (falhar.insert) throw new Error('insert falhou');
        linhas.push({ id: 'l' + (linhas.length + 1), user_id: params[0], token_hash: params[1], expires_at: params[2], app_mode: params[5] || null, revoked: false });
        return { rows: [] };
      }
      if (/^UPDATE refresh_tokens SET expires_at/.test(sql)) {
        const l = linhas.find((x) => x.id === params[1]);
        if (l) l.expires_at = params[0];
        return { rows: [] };
      }
      throw new Error('sql inesperado: ' + sql);
    },
  };
  return db;
}

const req = (standalone) => ({ headers: standalone ? { 'x-aura-app': 'standalone', 'user-agent': 'teste' } : { 'user-agent': 'teste' }, ip: '127.0.0.1' });

function chamar(db, token, { standalone = false, agora, ctxFalha = false } = {}) {
  return s.processarRefresh({
    token,
    req: req(standalone),
    db,
    secret: SECRET,
    agora,
    resolveDefaultContext: async () => {
      if (ctxFalha) throw new Error('contexto quebrou');
      return { consolidated: false, primary: { id: 'c1' }, effectivePlan: 'negocio', count: 1 };
    },
    resolveKarateContext: () => ({ federation_id: null, karate_role: null, dojo_id: null }),
    signAccessToken: (p) => jwt.sign({ ...p, type: 'access' }, SECRET, { expiresIn: '1h' }),
  });
}

// Token emitido pelo login (com a linha gravada como o login grava).
async function login(db, { standalone, agora = Date.now() } = {}) {
  const r = s.assinarRefresh({ id: UID }, SECRET, { deslizante: !!standalone, agora });
  await s.gravarRefresh(db, { userId: UID, token: r.token, expiresAt: r.expiresAt, req: req(standalone), appMode: standalone ? 'standalone' : null });
  return r;
}

describe('401 só quando o token é de fato ruim', () => {
  test('lixo, assinatura errada e expirado são 401', async () => {
    const db = criarDb();
    expect((await chamar(db, 'nao-e-jwt')).status).toBe(401);
    const outro = jwt.sign({ id: UID, type: 'refresh' }, 'outro-segredo', { expiresIn: '7d' });
    expect((await chamar(db, outro)).status).toBe(401);
    const vencido = jwt.sign({ id: UID, type: 'refresh', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    const r = await chamar(db, vencido);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REFRESH_EXPIRED');
  });

  test('revogado é 401; usuário desativado é 401', async () => {
    const db = criarDb();
    const { token } = await login(db);
    db.linhas[0].revoked = true;
    expect((await chamar(db, token)).body.code).toBe('REFRESH_REVOKED');

    const db2 = criarDb({ usuarioAtivo: false });
    const t2 = (await login(db2)).token;
    const r = await chamar(db2, t2);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('USER_INACTIVE');
  });

  test('access token no lugar do refresh é 400 (como antes)', async () => {
    const db = criarDb();
    const access = jwt.sign({ id: UID, type: 'access' }, SECRET, { expiresIn: '1h' });
    expect((await chamar(db, access)).status).toBe(400);
  });
});

describe('falha do servidor nunca é 401', () => {
  test.each([
    ['refresh_tokens', { falhar: { refresh_tokens: true } }, {}],
    ['users', { falhar: { users: true } }, {}],
    ['contexto', {}, { ctxFalha: true }],
  ])('erro em %s vira 503 REFRESH_UNAVAILABLE', async (_nome, dbOpts, chamadaOpts) => {
    const ok = criarDb();
    const { token } = await login(ok);
    const db = criarDb(dbOpts);
    db.linhas.push(...ok.linhas);
    const r = await chamar(db, token, chamadaOpts);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('REFRESH_UNAVAILABLE');
    expect(r.limparCookie).toBeFalsy();
  });
});

describe('navegador comum: nada muda', () => {
  test('login sem X-Aura-App: 7 dias, sem sl', async () => {
    const agora = Date.now();
    const r = s.assinarRefresh({ id: UID }, SECRET, { deslizante: false, agora });
    const d = jwt.decode(r.token);
    expect(d.sl).toBeUndefined();
    expect(d.exp - d.iat).toBe(7 * 24 * 3600);
    expect(r.expiresAt.getTime()).toBe(agora + 7 * DIA);
  });

  test('/refresh não renova prazo nem devolve refresh token', async () => {
    const db = criarDb();
    const { token } = await login(db);
    const antes = db.linhas[0].expires_at;
    const r = await chamar(db, token);
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.refresh_token).toBeUndefined();
    expect(r.novoRefresh).toBeUndefined();
    expect(db.linhas).toHaveLength(1);
    expect(db.linhas[0].expires_at).toBe(antes);
    expect(db.chamadas.some((q) => /UPDATE refresh_tokens/.test(q))).toBe(false);
  });
});

describe('app instalado: prazo deslizante', () => {
  test('login standalone: sl=1, linha com 30 dias', async () => {
    const agora = Date.now();
    const db = criarDb();
    const r = await login(db, { standalone: true, agora });
    expect(jwt.decode(r.token).sl).toBe(1);
    expect(db.linhas[0].app_mode).toBe('standalone');
    expect(new Date(db.linhas[0].expires_at).getTime()).toBe(agora + 30 * DIA);
  });

  test('cada /refresh empurra o prazo para 30 dias a partir de agora (mesmo token)', async () => {
    const t0 = Date.now();
    const db = criarDb();
    const { token } = await login(db, { standalone: true, agora: t0 });
    // 20 dias sem abrir, abre: renova.
    const t1 = t0 + 20 * DIA;
    const r = await chamar(db, token, { standalone: true, agora: t1 });
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).toBeUndefined();
    expect(new Date(db.linhas[0].expires_at).getTime()).toBe(t1 + 30 * DIA);
    // mais 25 dias (45 do login, bem além dos 7 de antes): ainda entra.
    const r2 = await chamar(db, token, { standalone: true, agora: t1 + 25 * DIA });
    expect(r2.status).toBe(200);
  });

  test('31 dias sem uso: 401 REFRESH_EXPIRED', async () => {
    const t0 = Date.now();
    const db = criarDb();
    const { token } = await login(db, { standalone: true, agora: t0 });
    const r = await chamar(db, token, { standalone: true, agora: t0 + 31 * DIA });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REFRESH_EXPIRED');
  });

  test('token antigo (7 dias) de quem está no app: ganha um deslizante, e o antigo segue valendo', async () => {
    const db = criarDb();
    // linha antiga: app_mode standalone, token de 7 dias sem sl
    const antigo = s.assinarRefresh({ id: UID }, SECRET, { deslizante: false });
    await s.gravarRefresh(db, { userId: UID, token: antigo.token, expiresAt: antigo.expiresAt, req: req(true), appMode: 'standalone' });

    const r = await chamar(db, antigo.token, { standalone: true });
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).toBeTruthy();
    expect(jwt.decode(r.body.refresh_token).sl).toBe(1);
    expect(r.novoRefresh).toBe(r.body.refresh_token);
    expect(db.linhas).toHaveLength(2);
    expect(db.linhas[1].app_mode).toBe('standalone');

    // A resposta se perdeu (app suspenso): o app manda o ANTIGO de novo.
    const deNovo = await chamar(db, antigo.token, { standalone: true });
    expect(deNovo.status).toBe(200);
    expect(deNovo.body.refresh_token).toBeTruthy();
    // e o novo que chegou depois também funciona
    expect((await chamar(db, r.body.refresh_token, { standalone: true })).status).toBe(200);
  });

  test('perto do teto do JWT: refresh token novo; o atual continua valendo', async () => {
    const t0 = Date.now();
    const db = criarDb();
    const { token } = await login(db, { standalone: true, agora: t0 });
    // 350 dias depois, usando sempre: faltam 15 dias para o teto de 365.
    db.linhas[0].expires_at = new Date(t0 + 360 * DIA);
    const agora = t0 + 350 * DIA;
    const r = await chamar(db, token, { standalone: true, agora });
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).toBeTruthy();
    expect(db.linhas.filter((l) => !l.revoked)).toHaveLength(2);
  });

  test('falha ao gravar o token novo não derruba: devolve o access e segue com o atual', async () => {
    const db = criarDb();
    const antigo = s.assinarRefresh({ id: UID }, SECRET, { deslizante: false });
    await s.gravarRefresh(db, { userId: UID, token: antigo.token, expiresAt: antigo.expiresAt, req: req(true), appMode: 'standalone' });
    const quebrado = criarDb({ falhar: { insert: true } });
    quebrado.linhas.push(...db.linhas);
    const r = await chamar(quebrado, antigo.token, { standalone: true });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.refresh_token).toBeUndefined();
  });

  test('deslizante sem linha no banco (INSERT do login falhou): grava a linha no /refresh', async () => {
    const db = criarDb();
    const r0 = s.assinarRefresh({ id: UID }, SECRET, { deslizante: true });
    const r = await chamar(db, r0.token, { standalone: true });
    expect(r.status).toBe(200);
    expect(db.linhas).toHaveLength(1);
    expect(db.linhas[0].token_hash).toBe(s.hashToken(r0.token));
  });
});
