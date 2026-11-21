// ============================================================
// Nome da loja — a regra unica e quem a usa (21/11/2026)
//
//   1. utils/nomeDaLoja.js: fantasia preenchido > razao social > fallback;
//      sai como esta gravado (sem trim) para o papel nao mudar.
//   2. /auth (shapeCompany): `name` e o nome da loja, nao a razao social.
//   3. PUT /companies/:id/profile: fantasia em branco vira NULL; a resposta
//      traz legal_name; a vitrine com o nome antigo acompanha o novo; nome
//      proprio da vitrine nao e tocado.
//   4. Trava: nenhum arquivo fora da lista fiscal/contrato poe a razao
//      social na frente do nome fantasia.
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { nomeDaLoja, razaoSocialDaLoja, sqlNomeDaLoja, nomeFantasiaParaGravar } = require('../src/utils/nomeDaLoja');

describe('1. nomeDaLoja', () => {
  test('nome fantasia preenchido vence', () => {
    expect(nomeDaLoja({ trade_name: 'Layali Perfumaria Árabe', legal_name: 'MARIA DA SILVA 12345678900' }))
      .toBe('Layali Perfumaria Árabe');
  });
  test('sem nome fantasia (null, "", espacos) sai a razao social', () => {
    for (const t of [null, undefined, '', '   ']) {
      expect(nomeDaLoja({ trade_name: t, legal_name: 'Ana Modas LTDA' })).toBe('Ana Modas LTDA');
    }
  });
  test('sem nome nenhum sai o fallback ("" por padrao)', () => {
    expect(nomeDaLoja(null)).toBe('');
    expect(nomeDaLoja({}, 'Loja')).toBe('Loja');
    expect(nomeDaLoja({ trade_name: ' ', legal_name: '' }, null)).toBeNull();
  });
  test('sai como esta gravado: o cupom de quem tem espaco no nome nao muda', () => {
    expect(nomeDaLoja({ trade_name: ' Doce Encanto ', legal_name: 'X' })).toBe(' Doce Encanto ');
  });
  test('razao social (fiscal/contrato) e o contrario', () => {
    expect(razaoSocialDaLoja({ trade_name: 'Layali', legal_name: 'MARIA' })).toBe('MARIA');
    expect(razaoSocialDaLoja({ trade_name: 'Layali', legal_name: '' })).toBe('Layali');
  });
  test('SQL sem aspas (cabe em string com \' ou `)', () => {
    expect(sqlNomeDaLoja('c')).toBe('COALESCE(CASE WHEN LENGTH(BTRIM(c.trade_name)) > 0 THEN c.trade_name END, c.legal_name)');
    expect(sqlNomeDaLoja()).not.toMatch(/['`]/);
  });
  test('gravar: aparado, branco vira NULL', () => {
    expect(nomeFantasiaParaGravar('  Layali  ')).toBe('Layali');
    expect(nomeFantasiaParaGravar('   ')).toBeNull();
    expect(nomeFantasiaParaGravar('')).toBeNull();
    expect(nomeFantasiaParaGravar(null)).toBeNull();
  });
});

describe('2. login e /auth/me mandam o nome da loja em `name`', () => {
  // shapeCompany nao e exportada: o teste le a linha do codigo. A trava de
  // comportamento fica no app (o app nao depende de `name`).
  test('shapeCompany usa nomeDaLoja', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
    const inicio = src.indexOf('function shapeCompany');
    const corpo = src.slice(inicio, src.indexOf('\n}\n', inicio));
    const linhasDoName = corpo.split('\n').filter((l) => /^\s+name:/.test(l));
    expect(linhasDoName).toEqual(['    name: nomeDaLoja(company, company.name || null),']);
  });
});

describe('3. PUT /profile', () => {
  const companyRouter = require('../src/routes/company');
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', companyRouter);
  const LOJA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';

  function despachar({ antes, vitrine = [] }) {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql || '');
      if (/^SELECT trade_name, legal_name FROM companies/i.test(s.trim())) return Promise.resolve({ rows: [antes] });
      if (/^UPDATE companies SET/i.test(s.trim())) {
        const trade = /trade_name = \$1/.test(s) ? params[0] : antes.trade_name;
        return Promise.resolve({ rows: [{ id: LOJA, ...antes, trade_name: trade }] });
      }
      if (/UPDATE digital_channel_config/i.test(s)) return Promise.resolve({ rows: vitrine });
      return Promise.resolve({ rows: [] });
    });
  }
  const sqls = () => db.query.mock.calls.map(([s, p]) => ({ s: String(s), p }));

  beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); });

  test('troca o nome: resposta com name, trade_name e legal_name; vitrine com o nome antigo acompanha', async () => {
    despachar({ antes: { trade_name: 'Layali', legal_name: 'MARIA DA SILVA 12345678900' }, vitrine: [{ slug: 'layali' }] });
    const res = await request(app).put(`/companies/${LOJA}/profile`).send({ trade_name: 'Layali Perfumaria Árabe' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Layali Perfumaria Árabe', trade_name: 'Layali Perfumaria Árabe', legal_name: 'MARIA DA SILVA 12345678900',
    });
    const v = sqls().find(q => /UPDATE digital_channel_config/i.test(q.s));
    expect(v).toBeTruthy();
    // So a vitrine cujo nome e o nome ANTIGO da loja.
    expect(v.s).toMatch(/BTRIM\(site_name\) = BTRIM\(\$3\)/);
    expect(v.p).toEqual([LOJA, 'Layali Perfumaria Árabe', 'Layali']);
  });

  test('fantasia em branco vira NULL e o nome cai na razao social', async () => {
    despachar({ antes: { trade_name: 'Loja Velha', legal_name: 'Ana Modas LTDA' } });
    const res = await request(app).put(`/companies/${LOJA}/profile`).send({ trade_name: '   ' });
    expect(res.status).toBe(200);
    const upd = sqls().find(q => /^UPDATE companies SET/i.test(q.s.trim()));
    expect(upd.p[0]).toBeNull();
    expect(res.body.name).toBe('Ana Modas LTDA');
  });

  test('sem mexer no nome: nao le o nome antes nem toca a vitrine', async () => {
    despachar({ antes: { trade_name: 'Layali', legal_name: 'MARIA' } });
    const res = await request(app).put(`/companies/${LOJA}/profile`).send({ email: 'loja@exemplo.com.br' });
    expect(res.status).toBe(200);
    expect(sqls().some(q => /digital_channel_config/i.test(q.s))).toBe(false);
    expect(sqls().some(q => /^SELECT trade_name, legal_name/i.test(q.s.trim()))).toBe(false);
  });

  test('mesmo nome: vitrine nao e tocada', async () => {
    despachar({ antes: { trade_name: 'Layali', legal_name: 'MARIA' } });
    await request(app).put(`/companies/${LOJA}/profile`).send({ trade_name: 'Layali' });
    expect(sqls().some(q => /digital_channel_config/i.test(q.s))).toBe(false);
  });

  test('vitrine que falha nao derruba a troca do nome', async () => {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql || '').trim();
      if (/^SELECT trade_name, legal_name/i.test(s)) return Promise.resolve({ rows: [{ trade_name: 'A', legal_name: 'B' }] });
      if (/^UPDATE companies SET/i.test(s)) return Promise.resolve({ rows: [{ id: LOJA, trade_name: params[0], legal_name: 'B' }] });
      if (/digital_channel_config/i.test(s)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).put(`/companies/${LOJA}/profile`).send({ trade_name: 'Nova' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nova');
    warn.mockRestore();
  });
});

describe('4. trava: razao social na frente so onde a lei ou o contrato pedem', () => {
  // Fiscal (xNome do emitente, relatorios de obrigacao, TISS) e a cobranca
  // da propria Aura ao lojista (Asaas). Entrar um arquivo aqui e decisao,
  // nao conveniencia: o resto da Aura mostra o nome da loja.
  const PERMITIDOS = new Set([
    'src/services/sefazSp/xmlBuilder.js',
    'src/services/sefazSp/nfe55.js',
    'src/services/nuvemfiscal.js',
    'src/services/focusnfe.js',
    'src/services/tissXml.js',
    'src/services/obligationReportGenerator.js',
    'src/services/obligationReportHandlersPF.js',
    'src/services/obligationsCalendar.js',
    'src/services/asaasCustomer.js',
    'src/services/dojoSaasCheckout.js',
    'src/utils/nomeDaLoja.js',
  ]);
  const RAZAO_NA_FRENTE = /legal_name\s*\|\|[^;\n]*trade_name|COALESCE\(\s*(\w+\.)?legal_name\s*,\s*(\w+\.)?trade_name|legal_name AS name\b/;

  function arquivos(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? arquivos(p) : (p.endsWith('.js') ? [p] : []);
    });
  }

  test('nenhum arquivo fora da lista', () => {
    const raiz = path.join(__dirname, '..');
    const achados = [];
    for (const p of arquivos(path.join(raiz, 'src'))) {
      const rel = path.relative(raiz, p).split(path.sep).join('/');
      if (PERMITIDOS.has(rel)) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((linha, i) => {
        if (RAZAO_NA_FRENTE.test(linha)) achados.push(`${rel}:${i + 1}: ${linha.trim()}`);
      });
    }
    expect(achados).toEqual([]);
  });
});
