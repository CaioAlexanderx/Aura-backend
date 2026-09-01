// ============================================================
// AURA. — Runner de migrations
//
// Descoberto no QA de 01/09/2026: o backend NÃO tinha runner. Nem
// package.json, nem o boot, nem o deploy aplicavam os .sql — eram rodados à
// mão, e foi por isso que as migrations 310/311 subiram no código e não no
// banco. Este arquivo trava o que, se falhar, faz o runner ser PIOR que não
// ter runner:
//
//   1. BASELINE — as ~315 migrations já foram aplicadas à mão em produção.
//      Se o runner encontrar o controle vazio num banco que já tem schema e
//      simplesmente rodar tudo, ele estraga a base de produção. A trava é
//      recusar e mandar rodar o baseline.
//   2. IDEMPOTÊNCIA — rodar duas vezes não pode aplicar duas vezes.
//   3. FALHA RUIDOSA — migration que quebra derruba o passo, com ROLLBACK, e
//      NÃO continua para a próxima.
//   4. CONCORRÊNCIA — advisory lock, porque duas instâncias sobem juntas.
//
// O pool é falso: o que se testa é a MÁQUINA DE DECISÃO do runner, e ela é
// legível pelas queries que ele emite.
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../src/utils/migrationRunner');

// ── Raiz de mentira com migrations de mentira ─────────────────────────
function mkRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mig-'));
  for (const [rel, sql] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, sql, 'utf8');
  }
  return root;
}

// ── Pool falso ────────────────────────────────────────────────────────
// applied: chaves já em schema_migrations. temSchema: se `companies` existe.
// falharEm: chave cujo SQL deve estourar.
function mkPool({ applied = [], temSchema = false, falharEm = null } = {}) {
  const log = [];
  const registro = new Map(applied.map((k) => [k, 'checksum-antigo']));

  const client = {
    query: jest.fn((sql, params) => {
      log.push({ sql: String(sql), params });
      const s = String(sql);

      if (/SELECT key, checksum FROM schema_migrations/.test(s)) {
        return Promise.resolve({
          rows: [...registro.entries()].map(([key, checksum]) => ({ key, checksum })),
        });
      }
      if (/to_regclass/.test(s)) {
        return Promise.resolve({ rows: [{ reg: temSchema ? 'companies' : null }] });
      }
      if (/INSERT INTO schema_migrations/.test(s)) {
        registro.set(params[0], params[1]);
        return Promise.resolve({ rows: [] });
      }
      if (falharEm && s.includes(falharEm)) {
        return Promise.reject(new Error('syntax error at or near "OPS"'));
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };

  return { pool: { connect: async () => client }, client, log, registro };
}

const sqlDe = (log) => log.map((c) => c.sql);
const silencio = () => {};

// ── Descoberta e ordem ────────────────────────────────────────────────
describe('descoberta', () => {
  test('acha .sql nos dois diretorios e ignora o resto', () => {
    const root = mkRoot({
      'migrations/300_a.sql': '-- a',
      'migrations/leiame.md': '# nao é migration',
      'src/migrations/036_b.sql': '-- b',
    });
    const keys = runner.discover(root).map((m) => m.key);
    expect(keys).toEqual(['src/migrations/036_b.sql', 'migrations/300_a.sql']);
  });

  test('ordena por numero, nao por string ("9" antes de "10")', () => {
    const root = mkRoot({
      'migrations/9_nove.sql': '--', 'migrations/10_dez.sql': '--', 'migrations/100_cem.sql': '--',
    });
    expect(runner.discover(root).map((m) => m.file))
      .toEqual(['9_nove.sql', '10_dez.sql', '100_cem.sql']);
  });

  // O repo TEM prefixo repetido (309 aparece tres vezes). A chave e o caminho
  // inteiro, entao duplicata nao colide — e a ordem entre elas e estavel.
  test('prefixo repetido nao colide e a ordem e estavel', () => {
    const root = mkRoot({
      'migrations/309_desconto.sql': '--',
      'migrations/309_wa_token.sql': '--',
      'src/migrations/309_outro.sql': '--',
    });
    const uma = runner.discover(root).map((m) => m.key);
    const outra = runner.discover(root).map((m) => m.key);
    expect(new Set(uma).size).toBe(3);
    expect(uma).toEqual(outra);
  });

  test('o repo de verdade tem migrations e nenhuma chave repetida', () => {
    const keys = runner.discover().map((m) => m.key);
    expect(keys.length).toBeGreaterThan(100);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ── A trava do baseline ───────────────────────────────────────────────
describe('trava do baseline (o que protege producao)', () => {
  test('controle vazio + banco COM schema: RECUSA e nao roda nada', async () => {
    const root = mkRoot({ 'migrations/300_a.sql': 'CREATE TABLE a();' });
    const { pool, log } = mkPool({ applied: [], temSchema: true });
    await expect(runner.runMigrations({ pool, root, log: silencio }))
      .rejects.toThrow(/baseline/i);
    expect(sqlDe(log).some((s) => s.includes('CREATE TABLE a()'))).toBe(false);
  });

  test('controle vazio + banco VAZIO: aplica tudo (CI, staging novo)', async () => {
    const root = mkRoot({ 'migrations/300_a.sql': 'CREATE TABLE a();' });
    const { pool, log } = mkPool({ applied: [], temSchema: false });
    const r = await runner.runMigrations({ pool, root, log: silencio });
    expect(r.applied).toEqual(['migrations/300_a.sql']);
    expect(sqlDe(log).some((s) => s.includes('CREATE TABLE a()'))).toBe(true);
  });

  test('baseline registra tudo SEM executar uma linha de SQL de migration', async () => {
    const root = mkRoot({
      'migrations/300_a.sql': 'CREATE TABLE a();',
      'migrations/301_b.sql': 'CREATE TABLE b();',
    });
    const { pool, log } = mkPool({ applied: [], temSchema: true });
    const r = await runner.baseline({ pool, root, log: silencio });
    expect(r.marked).toEqual(['migrations/300_a.sql', 'migrations/301_b.sql']);
    // O unico CREATE TABLE emitido e o da propria tabela de controle.
    expect(sqlDe(log).some((s) => /CREATE TABLE (a|b)\(\)/.test(s))).toBe(false);
    expect(sqlDe(log).filter((s) => /INSERT INTO schema_migrations/.test(s))).toHaveLength(2);
  });

  test('baseline e idempotente: rodar de novo nao remarca nem duplica', async () => {
    const root = mkRoot({ 'migrations/300_a.sql': 'CREATE TABLE a();' });
    const { pool } = mkPool({ applied: ['migrations/300_a.sql'], temSchema: true });
    const r = await runner.baseline({ pool, root, log: silencio });
    expect(r.marked).toEqual([]);
    expect(r.already).toBe(1);
  });

  test('depois do baseline, o up so roda o que e NOVO', async () => {
    const root = mkRoot({
      'migrations/300_velha.sql': 'CREATE TABLE velha();',
      'migrations/315_nova.sql': 'CREATE TABLE nova();',
    });
    const { pool, log } = mkPool({ applied: ['migrations/300_velha.sql'], temSchema: true });
    const r = await runner.runMigrations({ pool, root, log: silencio });
    expect(r.applied).toEqual(['migrations/315_nova.sql']);
    expect(r.skipped).toBe(1);
    expect(sqlDe(log).some((s) => s.includes('CREATE TABLE velha()'))).toBe(false);
    expect(sqlDe(log).some((s) => s.includes('CREATE TABLE nova()'))).toBe(true);
  });
});

// ── Idempotência ──────────────────────────────────────────────────────
describe('idempotencia', () => {
  test('duas passadas seguidas: a segunda nao aplica nada', async () => {
    const root = mkRoot({ 'migrations/300_a.sql': 'CREATE TABLE a();' });
    const { pool } = mkPool({ applied: [], temSchema: false });
    const um = await runner.runMigrations({ pool, root, log: silencio });
    const dois = await runner.runMigrations({ pool, root, log: silencio });
    expect(um.applied).toHaveLength(1);
    expect(dois.applied).toHaveLength(0);
    expect(dois.skipped).toBe(1);
  });

  // Migration ja aplicada que foi EDITADA: o banco tem a versao antiga.
  // Avisa alto, mas nao bloqueia o deploy por causa de um comentario.
  test('checksum diferente avisa e nao reaplica', async () => {
    const root = mkRoot({ 'migrations/300_a.sql': 'CREATE TABLE a();' });
    const { pool, log } = mkPool({ applied: ['migrations/300_a.sql'], temSchema: true });
    const avisos = [];
    const r = await runner.runMigrations({ pool, root, log: (m) => avisos.push(m) });
    expect(r.applied).toEqual([]);
    expect(avisos.join('\n')).toMatch(/AVISO.*mudou depois de aplicada/);
    expect(sqlDe(log).some((s) => s.includes('CREATE TABLE a()'))).toBe(false);
  });
});

// ── Falha ruidosa ─────────────────────────────────────────────────────
describe('falha ruidosa', () => {
  test('migration quebrada: lanca, faz ROLLBACK e NAO segue para a proxima', async () => {
    const root = mkRoot({
      'migrations/300_ok.sql': 'CREATE TABLE ok();',
      'migrations/301_ruim.sql': 'OPS isto nao e sql;',
      'migrations/302_depois.sql': 'CREATE TABLE depois();',
    });
    const { pool, log } = mkPool({ applied: [], temSchema: false, falharEm: 'OPS isto' });
    await expect(runner.runMigrations({ pool, root, log: silencio }))
      .rejects.toThrow(/301_ruim\.sql FALHOU/);
    const sqls = sqlDe(log);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some((s) => s.includes('CREATE TABLE depois()'))).toBe(false);
  });

  test('a que passou antes da falha continua registrada (transacao por migration)', async () => {
    const root = mkRoot({
      'migrations/300_ok.sql': 'CREATE TABLE ok();',
      'migrations/301_ruim.sql': 'OPS isto nao e sql;',
    });
    const { pool, registro } = mkPool({ applied: [], temSchema: false, falharEm: 'OPS isto' });
    await expect(runner.runMigrations({ pool, root, log: silencio })).rejects.toThrow();
    expect(registro.has('migrations/300_ok.sql')).toBe(true);
    expect(registro.has('migrations/301_ruim.sql')).toBe(false);
  });
});

// ── Concorrência ──────────────────────────────────────────────────────
describe('multiplas instancias subindo juntas', () => {
  test('pega e solta o advisory lock na mesma chave', async () => {
    const root = mkRoot({ 'migrations/300_a.sql': 'CREATE TABLE a();' });
    const { pool, log } = mkPool({ applied: [], temSchema: false });
    await runner.runMigrations({ pool, root, log: silencio });
    const locks = log.filter((c) => /pg_advisory_(un)?lock/.test(c.sql));
    expect(locks).toHaveLength(2);
    expect(locks[0].sql).toMatch(/SELECT pg_advisory_lock/);
    expect(locks[1].sql).toMatch(/pg_advisory_unlock/);
    expect(locks[0].params).toEqual([runner.LOCK_KEY]);
    expect(locks[1].params).toEqual([runner.LOCK_KEY]);
  });

  test('lock e liberado mesmo quando uma migration quebra', async () => {
    const root = mkRoot({ 'migrations/300_ruim.sql': 'OPS;' });
    const { pool, log, client } = mkPool({ applied: [], temSchema: false, falharEm: 'OPS;' });
    await expect(runner.runMigrations({ pool, root, log: silencio })).rejects.toThrow();
    expect(sqlDe(log).some((s) => /pg_advisory_unlock/.test(s))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});

// ── status ────────────────────────────────────────────────────────────
describe('status', () => {
  test('separa aplicadas de pendentes sem tocar em nada', async () => {
    const root = mkRoot({
      'migrations/300_a.sql': 'CREATE TABLE a();',
      'migrations/315_b.sql': 'CREATE TABLE b();',
    });
    const { pool, log } = mkPool({ applied: ['migrations/300_a.sql'], temSchema: true });
    const s = await runner.status({ pool, root });
    expect(s).toEqual({
      total: 2,
      applied: ['migrations/300_a.sql'],
      pending: ['migrations/315_b.sql'],
    });
    expect(sqlDe(log).some((x) => /CREATE TABLE (a|b)\(\)/.test(x))).toBe(false);
  });
});
