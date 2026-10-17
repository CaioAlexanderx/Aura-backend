// ============================================================
// Login falho no audit_log (t3-04, 17/10/2026)
//
// Medido: 96 falhas em 30 dias (10,1%) sem motivo e com ip_address nulo; nao
// separava senha errada de falha do servidor. Agora cada falha grava
// metadata.motivo (lista fechada), ip_address (req.ip, que respeita o
// `trust proxy 1` do app.js) e user_agent. Nunca a senha.
// ============================================================
const request = require('supertest');
const bcrypt = require('bcrypt');

let app, db, auditLog;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  auditLog = require('../../src/middleware/auditLog');
});

const SENHA = 'senha-certa-123';
let hash;
beforeAll(async () => { hash = await bcrypt.hash(SENHA, 4); });

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const entrar = (corpo, headers = {}) =>
  request(app).post('/api/v1/auth/login').set(headers).send(corpo);

// A linha de audit_log gravada como 'login_failed' (ou undefined).
function falhaGravada() {
  const chamada = db.query.mock.calls.find(
    ([sql, params]) => /INSERT INTO audit_log/.test(sql) && Array.isArray(params) && params[2] === 'login_failed'
  );
  if (!chamada) return undefined;
  const [sql, p] = chamada;
  return {
    sql: sql.replace(/\s+/g, ' '),
    userId: p[0], companyId: p[1], action: p[2], detail: p[3],
    metadata: JSON.parse(p[4]),
    ip: p[5], userAgent: p[6],
  };
}

describe('POST /auth/login — falha grava motivo, IP e user agent', () => {
  test('usuario_inexistente: grava a falha (antes nao deixava rastro), com e-mail mascarado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT users

    const res = await entrar(
      { email: 'Fulano@Loja.com', password: 'qualquer-coisa' },
      { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'jest-agent/1.0' }
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Credenciais invalidas');
    const f = falhaGravada();
    expect(f).toBeDefined();
    expect(f.sql).toContain('ip_address, user_agent');
    expect(f.metadata.motivo).toBe('usuario_inexistente');
    expect(f.ip).toBe('203.0.113.9');
    expect(f.userAgent).toBe('jest-agent/1.0');
    expect(f.userId).toBeNull();
    expect(f.detail).toContain('fu***@loja.com');
    expect(f.detail).not.toContain('fulano@loja.com');
  });

  test('senha_errada: motivo + IP; detail de sempre; a senha nunca e gravada', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', password_hash: hash, role: 'client', is_active: true }],
    });

    const res = await entrar(
      { email: 'ana@loja.com', password: 'senha-ERRADA-999' },
      { 'X-Forwarded-For': '198.51.100.7', 'User-Agent': 'Mozilla/5.0 (teste)' }
    );

    expect(res.status).toBe(401);
    const f = falhaGravada();
    expect(f.metadata.motivo).toBe('senha_errada');
    expect(f.ip).toBe('198.51.100.7');
    expect(f.metadata.ip).toBe('198.51.100.7'); // compat com o que ja existia
    expect(f.userAgent).toBe('Mozilla/5.0 (teste)');
    expect(f.detail).toBe('Failed login for ana@loja.com'); // igual ao de antes
    expect(JSON.stringify(db.query.mock.calls)).not.toContain('senha-ERRADA-999');
  });

  test('conta_desativada: 403 e grava a falha com o user_id', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'u9', name: 'Bia', email: 'bia@loja.com', password_hash: hash, role: 'client', is_active: false }],
    });

    const res = await entrar({ email: 'bia@loja.com', password: SENHA }, { 'X-Forwarded-For': '192.0.2.5' });

    expect(res.status).toBe(403);
    const f = falhaGravada();
    expect(f.metadata.motivo).toBe('conta_desativada');
    expect(f.userId).toBe('u9');
    expect(f.ip).toBe('192.0.2.5');
    expect(f.detail).toContain('bi***@loja.com');
  });

  test('erro_servidor: falha do banco no login vira 500 e e separada da senha errada', async () => {
    db.query.mockRejectedValueOnce(new Error('connection terminated')); // SELECT users

    const res = await entrar({ email: 'ana@loja.com', password: SENHA });

    expect(res.status).toBe(500);
    const f = falhaGravada();
    expect(f).toBeDefined();
    expect(f.metadata.motivo).toBe('erro_servidor');
  });

  test('sem IP valido (req.ip ausente) grava null no lugar de quebrar o INSERT', async () => {
    const ctx = auditLog.contextoDaRequisicao({ ip: 'nao-e-ip', headers: {} });
    expect(ctx).toEqual({ ip: null, userAgent: null });
  });

  test('login que da certo nao grava login_failed', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', password_hash: hash, role: 'client', is_active: true, totp_enabled: true }],
    });

    const res = await entrar({ email: 'ana@loja.com', password: SENHA });

    expect(res.status).toBe(200);
    expect(res.body.requires_2fa).toBe(true);
    expect(falhaGravada()).toBeUndefined();
  });
});

describe('middleware/auditLog', () => {
  test('contextoDaRequisicao: tira o prefixo IPv4-mapeado e corta o user agent em 200', () => {
    const ctx = auditLog.contextoDaRequisicao({
      ip: '::ffff:10.1.2.3',
      headers: { 'user-agent': 'x'.repeat(300) },
    });
    expect(ctx.ip).toBe('10.1.2.3');
    expect(ctx.userAgent).toHaveLength(200);
    expect(auditLog.contextoDaRequisicao({ ip: '2001:db8::1', headers: {} }).ip).toBe('2001:db8::1');
  });

  test('logAuditAction sem contexto continua com o INSERT de 5 colunas', async () => {
    await auditLog.logAuditAction('u1', null, 'logout', 'User logged out');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql.replace(/\s+/g, ' ')).toContain('(user_id, company_id, action, detail, metadata) VALUES ($1, $2, $3, $4, $5)');
    expect(params).toHaveLength(5);
  });

  test('logAuditAction nunca lanca, mesmo com o banco fora', async () => {
    db.query.mockRejectedValueOnce(new Error('down'));
    await expect(auditLog.logAuditAction(null, null, 'login_failed', 'x', {}, { ip: '1.2.3.4', userAgent: 'a' })).resolves.toBeUndefined();
  });
});
