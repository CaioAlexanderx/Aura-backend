// ============================================================
// AURA. -- GET/POST /companies/:id/fiscal-certificate (14/10/2026)
//
// O dono da empresa envia o proprio certificado A1 (mesmo certStore da Gestao
// Aura). O que estes testes travam:
//   1. so o dono (ou staff) envia; outro papel => 403 APENAS_DONO, nada gravado
//   2. o CNPJ do certificado confere com o da empresa ANTES de gravar
//      (divergente => 422; e-CPF/sem CNPJ => 422; OID 2.16.76.1.3.3 e CN valem)
//   3. erros amigaveis com `code` estavel (senha, vencido, arquivo invalido)
//   4. limite de tamanho (413) e freio de tentativas por empresa (429)
//   5. sem CERT_MASTER_KEY => 503
//   6. segredo (senha, base64) nunca chega a console.* nem a resposta/auditoria
//
// Mock por CONTEUDO DO SQL (marcadores), nunca fila posicional. O .pfx de teste
// e gerado em memoria com node-forge (como tests/unit/sefazSpSigner.test.js).
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const forge = require('node-forge');

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const CNPJ_EMPRESA = '11222333000181';
const SENHA = 'SenhaSecreta#2026';
const CHAVE_MESTRA = 'a'.repeat(64);

const token = (extra = {}) => ({ Authorization: `Bearer ${jwt.sign({ id: 'u-dono', role: 'user', ...extra }, SECRET, { expiresIn: '1h' })}` });
const dono = token();
const outroMembro = token({ id: 'u-funcionario' });
const staffAdmin = token({ id: 'u-staff', role: 'admin' });
const staffFlag = token({ id: 'u-staff2', is_staff: true });

let db;
let router;
let requireAuth;
let requireCompanyAccess;
let teste;

// ── fabrica de .pfx em memoria ────────────────────────────────────────────
let parChaves;
function makePfx({ cn = `LOJA TESTE LTDA:${CNPJ_EMPRESA}`, oidCnpj = null, expired = false, password = SENHA } = {}) {
  if (!parChaves) parChaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = parChaves.publicKey;
  cert.serialNumber = '01';
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 2 * 86400e3);
  cert.validity.notAfter = expired
    ? new Date(now.getTime() - 3600e3)
    : new Date(now.getTime() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  if (oidCnpj) {
    // subjectAltName com otherName { 2.16.76.1.3.3, [0] UTF8String CNPJ } (e-CNPJ ICP-Brasil)
    const A = forge.asn1;
    const outro = A.create(A.Class.CONTEXT_SPECIFIC, 0, true, [
      A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer('2.16.76.1.3.3').getBytes()),
      A.create(A.Class.CONTEXT_SPECIFIC, 0, true, [
        A.create(A.Class.UNIVERSAL, A.Type.UTF8, false, forge.util.encodeUtf8(oidCnpj)),
      ]),
    ]);
    const san = A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [outro]);
    cert.setExtensions([{ id: '2.5.29.17', critical: false, value: A.toDer(san).getBytes() }]);
  }
  cert.sign(parChaves.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(parChaves.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}
const b64 = (buf) => buf.toString('base64');

// ── app + banco ───────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/fiscal-certificate', router);
  app.use('/api/v1/companies/:id', scoped);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}
const url = `/api/v1/companies/${cid}/fiscal-certificate`;

// membro: papel do usuario na empresa (null => sem acesso). ownerId: dono da empresa.
function mockBanco({ ownerId = 'u-dono', cnpj = CNPJ_EMPRESA, membro = 'owner', existe = true, certRow = null, erroAudit = null, erroCertInfo = null } = {}) {
  const visto = { inserts: [], audit: [] };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/SELECT 'owner' AS role/i.test(s)) return Promise.resolve({ rows: membro ? [{ role: membro }] : [] });
    if (/-- fiscalcert:empresa/.test(s)) return Promise.resolve({ rows: existe ? [{ owner_id: ownerId, cnpj }] : [] });
    if (/INSERT INTO company_certificates/i.test(s)) { visto.inserts.push(params); return Promise.resolve({ rows: [], rowCount: 1 }); }
    if (/FROM company_certificates/i.test(s)) {
      if (erroCertInfo) return Promise.reject(erroCertInfo);
      return Promise.resolve({ rows: certRow ? [certRow] : [] });
    }
    if (/INSERT INTO audit_log/i.test(s)) {
      if (erroAudit) return Promise.reject(erroAudit);
      visto.audit.push(params); return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return visto;
}

// ── espiao de console: nenhum segredo pode aparecer ──────────────────────
let espioes;
function consoleTexto() {
  return espioes.flatMap((e) => e.mock.calls).map((args) => args.map((a) => (a instanceof Error ? a.message + a.stack : String(a))).join(' ')).join('\n');
}
function semSegredo(visto, base64) {
  const texto = consoleTexto();
  expect(texto).not.toContain(SENHA);
  expect(texto).not.toContain(base64.slice(0, 60));
  expect(JSON.stringify(visto.audit)).not.toContain(SENHA);
  expect(JSON.stringify(visto.audit)).not.toContain(base64.slice(0, 60));
}

beforeAll(() => {
  process.env.CERT_MASTER_KEY = CHAVE_MESTRA;
  db = require('../../src/config/database');
  router = require('../../src/routes/fiscalCertificate');
  teste = router._testing;
  ({ requireAuth, requireCompanyAccess } = require('../../src/middleware/auth'));
  parChaves = forge.pki.rsa.generateKeyPair(2048);
});

beforeEach(() => {
  db.query.mockReset();
  process.env.CERT_MASTER_KEY = CHAVE_MESTRA;
  delete process.env.CERT_CNPJ_ACEITA_RAIZ;
  teste.tentativas.clear();
  espioes = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  espioes.forEach((e) => e.mockRestore());
});

afterAll(() => {
  delete process.env.CERT_MASTER_KEY;
});

describe('POST /fiscal-certificate -- quem envia', () => {
  test('dono envia => 201, grava cifrado e audita sem segredo', async () => {
    const visto = mockBanco();
    const pfx = b64(makePfx());
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: pfx, password: SENHA });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['days_left', 'not_after', 'not_before', 'subject_cn']);
    expect(res.body.subject_cn).toContain(CNPJ_EMPRESA);
    expect(res.body.days_left).toBeGreaterThan(300);
    // gravou uma vez, cifrado (senha em envelope v1:, nunca em claro)
    expect(visto.inserts).toHaveLength(1);
    expect(visto.inserts[0][0]).toBe(cid);
    expect(String(visto.inserts[0][3])).toMatch(/^v1:/);
    expect(String(visto.inserts[0][3])).not.toContain(SENHA);
    // auditoria registrada
    expect(visto.audit).toHaveLength(1);
    expect(visto.audit[0][2]).toBe('fiscal.certificado_enviado');
    expect(res.text).not.toContain(SENHA);
    semSegredo(visto, pfx);
  });

  test('outro membro da empresa => 403 APENAS_DONO e nada gravado', async () => {
    const visto = mockBanco({ ownerId: 'u-dono', membro: 'manager' });
    const res = await request(buildApp()).post(url).set(outroMembro).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('APENAS_DONO');
    expect(res.body.error).toMatch(/dono/i);
    expect(visto.inserts).toHaveLength(0);
  });

  test('staff (role admin) passa para suporte', async () => {
    const visto = mockBanco({ ownerId: 'outra-pessoa' });
    const res = await request(buildApp()).post(url).set(staffAdmin).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(201);
    expect(visto.inserts).toHaveLength(1);
    expect(JSON.parse(visto.audit[0][4]).por).toBe('staff');
  });

  test('staff (is_staff no token) passa', async () => {
    const visto = mockBanco({ ownerId: 'outra-pessoa', membro: 'manager' });
    const res = await request(buildApp()).post(url).set(staffFlag).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(201);
    expect(visto.inserts).toHaveLength(1);
  });

  test('empresa inexistente => 404', async () => {
    mockBanco({ existe: false });
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(404);
  });
});

describe('POST /fiscal-certificate -- CNPJ do certificado', () => {
  test('CNPJ do CN confere (mascara na empresa nao atrapalha)', async () => {
    const visto = mockBanco({ cnpj: '11.222.333/0001-81' });
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(201);
    expect(visto.inserts).toHaveLength(1);
  });

  test('CNPJ so no OID 2.16.76.1.3.3 (CN sem CNPJ) tambem confere', async () => {
    const visto = mockBanco();
    const pfx = makePfx({ cn: 'LOJA TESTE LTDA', oidCnpj: CNPJ_EMPRESA });
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(pfx), password: SENHA });
    expect(res.status).toBe(201);
    expect(visto.inserts).toHaveLength(1);
    expect(JSON.parse(visto.audit[0][4]).origem_cnpj).toBe('oid');
  });

  test('CNPJ divergente => 422 CERT_CNPJ_DIVERGENTE e nada gravado', async () => {
    const visto = mockBanco({ cnpj: '99888777000166' });
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CERT_CNPJ_DIVERGENTE');
    expect(visto.inserts).toHaveLength(0);
    expect(visto.audit[0][2]).toBe('fiscal.certificado_recusado');
    // nao revela o CNPJ do certificado nem a senha
    expect(res.text).not.toContain(CNPJ_EMPRESA);
    expect(res.text).not.toContain(SENHA);
  });

  test('filial do mesmo grupo: recusa por padrao, aceita com CERT_CNPJ_ACEITA_RAIZ=1', async () => {
    const filial = '11222333000262'; // mesma raiz 11222333
    let visto = mockBanco({ cnpj: filial });
    let res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CERT_CNPJ_DIVERGENTE');
    expect(visto.inserts).toHaveLength(0);

    process.env.CERT_CNPJ_ACEITA_RAIZ = '1';
    teste.tentativas.clear();
    visto = mockBanco({ cnpj: filial });
    res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(201);
    expect(visto.inserts).toHaveLength(1);
  });

  test('e-CPF (sem CNPJ) => 422 CERT_SEM_CNPJ', async () => {
    const visto = mockBanco();
    const pfx = makePfx({ cn: 'MARIA DA SILVA:12345678901' });
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(pfx), password: SENHA });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CERT_SEM_CNPJ');
    expect(visto.inserts).toHaveLength(0);
  });

  test('empresa sem CNPJ cadastrado => 422 EMPRESA_SEM_CNPJ', async () => {
    const visto = mockBanco({ cnpj: null });
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMPRESA_SEM_CNPJ');
    expect(visto.inserts).toHaveLength(0);
  });
});

describe('POST /fiscal-certificate -- erros amigaveis', () => {
  test('senha incorreta => 400 CERT_SENHA_INCORRETA, sem ecoar a senha', async () => {
    const visto = mockBanco();
    const pfx = b64(makePfx());
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: pfx, password: 'senha-errada-xyz' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CERT_SENHA_INCORRETA');
    expect(res.text).not.toContain('senha-errada-xyz');
    expect(res.text).not.toMatch(/openPfx|openssl|PKCS/i);
    expect(visto.inserts).toHaveLength(0);
    expect(consoleTexto()).not.toContain('senha-errada-xyz');
  });

  test('certificado vencido => 422 CERT_VENCIDO', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx({ expired: true })), password: SENHA });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CERT_VENCIDO');
    expect(visto.inserts).toHaveLength(0);
  });

  test('arquivo que nao e certificado => 400 CERT_ARQUIVO_INVALIDO', async () => {
    const visto = mockBanco();
    const lixo = Buffer.from('isto nao e um arquivo pfx, e so texto qualquer');
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(lixo), password: SENHA });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CERT_ARQUIVO_INVALIDO');
    expect(visto.inserts).toHaveLength(0);
  });

  test('base64 invalido => 400 CERT_ARQUIVO_INVALIDO', async () => {
    mockBanco();
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: '@@@ nao e base64 @@@', password: SENHA });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CERT_ARQUIVO_INVALIDO');
  });

  test('sem arquivo ou sem senha => 400', async () => {
    mockBanco();
    let res = await request(buildApp()).post(url).set(dono).send({ password: SENHA });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CERT_ARQUIVO_OBRIGATORIO');
    res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CERT_SENHA_OBRIGATORIA');
  });

  test('sem CERT_MASTER_KEY => 503 amigavel', async () => {
    delete process.env.CERT_MASTER_KEY;
    const visto = mockBanco();
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CERT_INDISPONIVEL');
    expect(res.text).not.toMatch(/CERT_MASTER_KEY/);
    expect(visto.inserts).toHaveLength(0);
  });

  test('falha do banco ao gravar => 500 generico, sem vazar segredo', async () => {
    const visto = mockBanco();
    const original = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      if (/INSERT INTO company_certificates/i.test(String(sql))) return Promise.reject(Object.assign(new Error(`falhou com ${SENHA}`), { code: 'XX000' }));
      return original(sql, params);
    });
    const pfx = b64(makePfx());
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: pfx, password: SENHA });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('CERT_ERRO_INTERNO');
    expect(res.text).not.toContain(SENHA);
    semSegredo(visto, pfx);
  });

  test('falha da auditoria (tabela ausente) nao derruba o envio', async () => {
    const visto = mockBanco({ erroAudit: Object.assign(new Error('relation "audit_log" does not exist'), { code: '42P01' }) });
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(makePfx()), password: SENHA });
    expect(res.status).toBe(201);
    expect(visto.inserts).toHaveLength(1);
  });
});

describe('POST /fiscal-certificate -- limites', () => {
  test('arquivo grande demais => 413', async () => {
    const visto = mockBanco();
    const grande = Buffer.alloc(300 * 1024, 7);
    const res = await request(buildApp()).post(url).set(dono).send({ pfx_base64: b64(grande), password: SENHA });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('CERT_GRANDE_DEMAIS');
    expect(visto.inserts).toHaveLength(0);
  });

  test('mais de 5 envios em 10 minutos na mesma empresa => 429', async () => {
    mockBanco();
    const pfx = b64(makePfx());
    const app = buildApp();
    for (let i = 0; i < teste.TENTATIVAS_MAX; i += 1) {
      const r = await request(app).post(url).set(dono).send({ pfx_base64: pfx, password: 'errada' });
      expect(r.status).toBe(400);
    }
    const res = await request(app).post(url).set(dono).send({ pfx_base64: pfx, password: SENHA });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('CERT_MUITAS_TENTATIVAS');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('tentativa de quem nao e dono nao gasta a cota da empresa', async () => {
    mockBanco({ ownerId: 'u-dono', membro: 'manager' });
    const pfx = b64(makePfx());
    const app = buildApp();
    for (let i = 0; i < teste.TENTATIVAS_MAX + 2; i += 1) {
      const r = await request(app).post(url).set(outroMembro).send({ pfx_base64: pfx, password: SENHA });
      expect(r.status).toBe(403);
    }
    expect(teste.tentativas.get(cid)).toBeUndefined();
  });

  test('o freio e por empresa e libera depois da janela', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < teste.TENTATIVAS_MAX; i += 1) expect(teste.registrarTentativa('emp-a', t0 + i).ok).toBe(true);
    expect(teste.registrarTentativa('emp-a', t0 + 10).ok).toBe(false);
    expect(teste.registrarTentativa('emp-b', t0 + 10).ok).toBe(true);
    expect(teste.registrarTentativa('emp-a', t0 + teste.JANELA_MS + 1000).ok).toBe(true);
  });
});

describe('GET /fiscal-certificate', () => {
  test('sem certificado => cert null, CNPJ da empresa e pode_enviar para o dono', async () => {
    mockBanco();
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cert: null, empresa_cnpj: CNPJ_EMPRESA, pode_enviar: true });
  });

  test('com certificado => so metadados, sem segredo', async () => {
    const fim = new Date(Date.now() + 30 * 86400e3 + 3600e3);
    mockBanco({
      certRow: { subject_cn: `LOJA TESTE LTDA:${CNPJ_EMPRESA}`, not_before: new Date('2026-01-01'), not_after: fim, updated_at: new Date('2026-10-14') },
    });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.cert).sort()).toEqual(['days_left', 'not_after', 'not_before', 'subject_cn', 'updated_at']);
    expect(res.body.cert.days_left).toBe(30);
    expect(res.body.pode_enviar).toBe(true);
    expect(res.text).not.toMatch(/pfx|password|senha/i);
  });

  test('outro membro enxerga o estado mas pode_enviar e false', async () => {
    mockBanco({ ownerId: 'u-dono', membro: 'manager' });
    const res = await request(buildApp()).get(url).set(outroMembro);
    expect(res.status).toBe(200);
    expect(res.body.pode_enviar).toBe(false);
  });

  test('tabela company_certificates ausente (42P01) => cert null', async () => {
    mockBanco({ erroCertInfo: Object.assign(new Error('relation does not exist'), { code: '42P01' }) });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(res.body.cert).toBeNull();
  });

  test('sem token => 401', async () => {
    mockBanco();
    const res = await request(buildApp()).get(url);
    expect(res.status).toBe(401);
  });
});
