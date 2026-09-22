// ============================================================
// AURA. — PWA Fase 2: por onde o cliente abriu o painel (X-Aura-App)
//
// O front instalado como app manda X-Aura-App: standalone em toda
// requisicao. Tres coisas precisam andar juntas, e este teste segura as
// tres pelo fonte, porque quebram em silencio:
//
//   1. o CORS global aceita o cabecalho -- sem isso o preflight recusa e
//      NADA funciona pelo app instalado (o erro aparece como "Failed to
//      fetch", longe da causa);
//   2. o login grava o valor em refresh_tokens.app_mode, com fallback para
//      o INSERT antigo quando a coluna ainda nao existe (42703);
//   3. a migration 349 cria a coluna, idempotente.
//
// E a unidade: appModeDoCabecalho so aceita os dois valores conhecidos.
// Cabecalho e entrada do cliente; qualquer outra coisa vira null.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { appModeDoCabecalho, VALORES_DE_APP_MODE } = require('../src/utils/appMode');

const ler = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('appModeDoCabecalho', () => {
  test('aceita os dois valores conhecidos, em qualquer caixa e com espaco', () => {
    expect(appModeDoCabecalho('standalone')).toBe('standalone');
    expect(appModeDoCabecalho('  Standalone ')).toBe('standalone');
    expect(appModeDoCabecalho('browser')).toBe('browser');
    expect(appModeDoCabecalho('BROWSER')).toBe('browser');
  });

  test('qualquer outra coisa e null: ausente, vazio, lixo, array, numero', () => {
    expect(appModeDoCabecalho(undefined)).toBeNull();
    expect(appModeDoCabecalho(null)).toBeNull();
    expect(appModeDoCabecalho('')).toBeNull();
    expect(appModeDoCabecalho('pwa')).toBeNull();
    expect(appModeDoCabecalho("standalone'; DROP TABLE refresh_tokens;--")).toBeNull();
    expect(appModeDoCabecalho(['standalone'])).toBeNull();
    expect(appModeDoCabecalho(42)).toBeNull();
  });

  test('a lista de valores e fechada e cabe na coluna VARCHAR(20)', () => {
    expect(Array.from(VALORES_DE_APP_MODE).sort()).toEqual(['browser', 'standalone']);
    VALORES_DE_APP_MODE.forEach((v) => expect(v.length).toBeLessThanOrEqual(20));
  });
});

describe('CORS global aceita X-Aura-App', () => {
  test('allowedHeaders do cors() inclui o cabecalho, sem tirar os que ja existiam', () => {
    const app = ler('src', 'app.js');
    const m = app.match(/allowedHeaders:\s*\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const lista = Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
    expect(lista).toEqual(expect.arrayContaining(['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key', 'Idempotency-Key', 'X-Aura-App']));
  });
});

describe('login grava app_mode', () => {
  const auth = ler('src', 'routes', 'auth.js');

  test('storeRefreshToken le X-Aura-App pelo helper e insere em app_mode', () => {
    const i = auth.indexOf('async function storeRefreshToken(');
    expect(i).toBeGreaterThan(-1);
    const corpo = auth.slice(i, auth.indexOf('\n}', i));
    expect(corpo).toMatch(/appModeDoCabecalho\(req\.headers\['x-aura-app'\]\)/);
    expect(corpo).toMatch(/INSERT INTO refresh_tokens \(user_id, token_hash, expires_at, ip_address, user_agent, app_mode\)/);
  });

  test('sem a coluna (42703) cai no INSERT antigo em vez de perder o refresh token', () => {
    const i = auth.indexOf('async function storeRefreshToken(');
    const corpo = auth.slice(i, auth.indexOf('\n}', i));
    expect(corpo).toMatch(/err\.code === '42703'/);
    expect(corpo).toMatch(/INSERT INTO refresh_tokens \(user_id, token_hash, expires_at, ip_address, user_agent\) VALUES \(\$1, \$2, \$3, \$4, \$5\)/);
  });

  test('o helper esta importado no topo do arquivo', () => {
    expect(auth).toMatch(/require\('\.\.\/utils\/appMode'\)/);
  });
});

describe('migration 349', () => {
  test('cria refresh_tokens.app_mode de forma idempotente', () => {
    const sql = ler('migrations', '349_refresh_tokens_app_mode.sql');
    expect(sql).toMatch(/ALTER TABLE refresh_tokens\s+ADD COLUMN IF NOT EXISTS app_mode VARCHAR\(20\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_refresh_tokens_app_mode_created/);
  });

  test('e a unica 349 e nao colide com o que ja existe', () => {
    const nomes = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((n) => /^349_/.test(n));
    expect(nomes).toEqual(['349_refresh_tokens_app_mode.sql']);
  });
});
