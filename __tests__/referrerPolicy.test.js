// ============================================================
// RA-02 — Referrer-Policy da API e da vitrine (12/11/2026)
//
// O playbook da Asaas (Recebe na Aura) proibe Referrer-Policy no-referrer:
// a Asaas confere pelo Referer de onde vem a imagem do selo dela. O helmet
// manda strict-origin-when-cross-origin, que entrega so a origem a outro
// site (nunca caminho nem query, que podem ter token) e nada em http.
// Este teste segura a politica nas respostas da API e da vitrine servida
// por este processo, no app DE VERDADE (src/app.js).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../src/config/database');

let app;
beforeAll(() => {
  app = require('../src/app');
});

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const POLITICA = 'strict-origin-when-cross-origin';

describe('Referrer-Policy', () => {
  test('API: /health e rota inexistente', async () => {
    const health = await request(app).get('/health').set('Host', 'api.getaura.com.br');
    expect(health.headers['referrer-policy']).toBe(POLITICA);
    const nada = await request(app).get('/api/v1/nao-existe').set('Host', 'api.getaura.com.br');
    expect(nada.headers['referrer-policy']).toBe(POLITICA);
  });

  test('vitrine em loja.getaura.com.br e em dominio proprio', async () => {
    const loja = await request(app).get('/loja-qualquer').set('Host', 'loja.getaura.com.br');
    expect(loja.headers['referrer-policy']).toBe(POLITICA);
    const proprio = await request(app).get('/').set('Host', 'www.loja-do-cliente.com.br');
    expect(proprio.headers['referrer-policy']).toBe(POLITICA);
  });

  test('nada no codigo manda no-referrer', () => {
    const achados = [];
    const re = /(['"]no-referrer['"])|(name=["']referrer["'][^>]*content=["']no-referrer)/i;
    function varrer(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { varrer(p); continue; }
        if (!/\.(js|html|hbs|ejs)$/.test(e.name)) continue;
        const t = fs.readFileSync(p, 'utf8');
        if (re.test(t)) achados.push(path.relative(path.join(__dirname, '..'), p));
      }
    }
    varrer(path.join(__dirname, '..', 'src'));
    varrer(path.join(__dirname, '..', 'templates'));
    expect(achados).toEqual([]);
  });
});
