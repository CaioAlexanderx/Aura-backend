// ============================================================
// AURA. — personalizados_ativado_em no Postgres real (p-172, 17/11/2026)
// Schema das migrations (inclui a 454, que cria a view studio_orders no CI).
//
//   1. vertical Studio ligada pela primeira vez grava a data; religar,
//      desligar e ligar de novo nunca trocam a primeira data
//   2. PUT /pdv-settings: corpo ignorado; o PUT que liga a frente grava; e a
//      corrida (data gravada entre a leitura e a escrita do PUT) nao apaga
//      a data
//   3. migracao: a data original e a mais antiga entre a empresa e o
//      primeiro pedido; nada da Fila fica antes dela; nunca sobrescreve;
//      frente desligada nao recebe data
//
// Uma transacao revertida no afterAll (nada fica no banco). Sem Postgres
// local a suite e pulada; no CI o servico existe e ela e obrigatoria.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const ativacao = require('../src/services/personalizadosAtivacao');
const { setCompanyVertical } = require('../src/services/segment');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';
const CHAVE = ativacao.CHAVE;

let pool;
let client;
let app;
let temBanco = false;
let antesDoUpdateDoPut = null; // gancho da corrida do item 2

let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}
let qn = 0;
async function comSavepoint(sql, params) {
  qn += 1;
  const sp = `q_${qn}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const r = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return r;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}
const q = (sql, params) => naFila(() => comSavepoint(sql, params));
// conn com a mesma interface do pool, para os servicos
const conn = { query: (sql, params) => q(sql, params) };

const dono = uuid();

async function empresa({ criadaEm = '2026-05-22T10:00:00Z', vertical = null, settings = {} } = {}) {
  const id = uuid();
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, vertical_active, pdv_settings, created_at)
     VALUES ($1, $2, 'Fixture p-172 LTDA', 'Fixture p-172', 'negocio', $3, $4::jsonb, $5)`,
    [id, dono, vertical, JSON.stringify(settings), criadaEm]
  );
  return id;
}
async function settingsDe(id) {
  const { rows } = await q('SELECT pdv_settings FROM companies WHERE id = $1', [id]);
  return rows[0].pdv_settings || {};
}
async function vendaDoCaixa(companyId, criadaEm, status = 'pending_art') {
  await q(
    `INSERT INTO sales (company_id, total_amount, studio_production_status, created_at)
     VALUES ($1, 50, $2, $3)`,
    [companyId, status, criadaEm]
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), connectionTimeoutMillis: 3000 });
  try {
    client = await pool.connect();
    temBanco = true;
  } catch (err) {
    if (process.env.CI) throw err;
    return;
  }
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => naFila(async () => {
    if (antesDoUpdateDoPut && /^\s*UPDATE companies SET pdv_settings = \$1/.test(sql)) {
      const gancho = antesDoUpdateDoPut;
      antesDoUpdateDoPut = null;
      await gancho();
    }
    return comSavepoint(sql, params);
  }));

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture p-172')`,
    [dono, `fixture-${dono}@example.test`]);

  app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/pdvSettings'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
});

afterAll(async () => {
  await fila;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end().catch(() => {});
});

const ehIsoRecente = (v) => typeof v === 'string' && Math.abs(Date.now() - Date.parse(v)) < 5 * 60 * 1000;

describe('1. vertical Studio ligada (setCompanyVertical)', () => {
  it('primeira vez grava a data; religar, desligar e ligar de novo nao trocam', async () => {
    if (!temBanco) return;
    const id = await empresa({ settings: { caixa_enabled: true } });
    await setCompanyVertical(conn, id, 'studio', null);
    const s1 = await settingsDe(id);
    expect(s1.studio_enabled).toBe(true);
    expect(s1.caixa_enabled).toBe(true);
    expect(ehIsoRecente(s1[CHAVE])).toBe(true);

    await setCompanyVertical(conn, id, 'studio', 'studio');
    await setCompanyVertical(conn, id, null, 'studio');
    expect((await settingsDe(id)).studio_enabled).toBe(false);
    await setCompanyVertical(conn, id, 'studio', null);
    const s2 = await settingsDe(id);
    expect(s2.studio_enabled).toBe(true);
    expect(s2[CHAVE]).toBe(s1[CHAVE]);
  });

  it('empresa ja ligada antes (sem data) nao ganha data por religar', async () => {
    if (!temBanco) return;
    const id = await empresa({ vertical: 'studio', settings: { studio_enabled: true } });
    await setCompanyVertical(conn, id, 'studio', null);
    expect(await settingsDe(id)).not.toHaveProperty(CHAVE);
  });

  it('a guarda do SQL nao troca a data mesmo quando o JS manda uma', async () => {
    if (!temBanco) return;
    const id = await empresa({ settings: { studio_enabled: false, [CHAVE]: '2026-05-22T12:00:00.000Z' } });
    await q(
      `UPDATE companies SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                       || jsonb_build_object('studio_enabled', true) || ${ativacao.sqlMarcaSeAusente('$2')}
        WHERE id = $1`,
      [id, '2026-11-17T13:00:00.000Z']
    );
    expect((await settingsDe(id))[CHAVE]).toBe('2026-05-22T12:00:00.000Z');
  });
});

describe('2. PUT /pdv-settings', () => {
  it('o PUT que liga a frente grava a hora; o corpo nunca grava a chave', async () => {
    if (!temBanco) return;
    const id = await empresa();
    const r1 = await request(app).put(`/companies/${id}/pdv-settings`)
      .send({ settings: { [CHAVE]: '2020-01-01T00:00:00.000Z', require_seller: true } });
    expect(r1.status).toBe(200);
    expect(await settingsDe(id)).not.toHaveProperty(CHAVE);

    const r2 = await request(app).put(`/companies/${id}/pdv-settings`).send({ settings: { studio_enabled: true } });
    expect(r2.status).toBe(200);
    const s = await settingsDe(id);
    expect(ehIsoRecente(s[CHAVE])).toBe(true);
    expect(s.require_seller).toBe(true);

    const r3 = await request(app).put(`/companies/${id}/pdv-settings`)
      .send({ settings: { [CHAVE]: '2020-01-01T00:00:00.000Z', studio_enabled: false } });
    expect(r3.body.settings[CHAVE]).toBe(s[CHAVE]);
    expect((await settingsDe(id))[CHAVE]).toBe(s[CHAVE]);

    const get = await request(app).get(`/companies/${id}/pdv-settings`);
    expect(get.body.settings[CHAVE]).toBe(s[CHAVE]);
  });

  it('corrida: a data gravada entre a leitura e a escrita do PUT nao some', async () => {
    if (!temBanco) return;
    const id = await empresa({ settings: { studio_enabled: false } });
    antesDoUpdateDoPut = () => comSavepoint(
      `UPDATE companies SET pdv_settings = pdv_settings || jsonb_build_object('${CHAVE}', '2026-05-22T12:00:00.000Z'::text)
        WHERE id = $1`,
      [id]
    );
    const r = await request(app).put(`/companies/${id}/pdv-settings`).send({ settings: { caixa_enabled: true } });
    expect(r.status).toBe(200);
    const s = await settingsDe(id);
    expect(s[CHAVE]).toBe('2026-05-22T12:00:00.000Z');
    expect(s.caixa_enabled).toBe(true);
  });
});

describe('3. migracao: data original do Studio', () => {
  it('a data e a da empresa; nada da Fila fica antes dela; segunda chamada nao muda', async () => {
    if (!temBanco) return;
    const id = await empresa({ criadaEm: '2026-05-22T10:00:00Z', vertical: 'studio', settings: { studio_enabled: true } });
    await vendaDoCaixa(id, '2026-06-15T10:00:00Z', 'delivered');
    await vendaDoCaixa(id, '2026-09-21T10:00:00Z');

    const retrato = await ativacao.inicioDoUsoDoStudio(conn, id);
    expect(retrato).toMatchObject({ ligada: true, data_gravada: null, data_original: '2026-05-22T10:00:00.000Z', origem: 'empresa' });
    expect(await settingsDe(id)).not.toHaveProperty(CHAVE); // so leitura

    const r1 = await ativacao.gravarDataOriginalDoStudio(conn, id);
    expect(r1).toEqual({ gravada: true, motivo: 'empresa', data: '2026-05-22T10:00:00.000Z' });

    const { rows } = await q(
      `SELECT COUNT(*)::int AS antes FROM studio_orders
        WHERE company_id = $1 AND created_at < ($2::text)::timestamptz`,
      [id, r1.data]
    );
    expect(rows[0].antes).toBe(0);

    const r2 = await ativacao.gravarDataOriginalDoStudio(conn, id);
    expect(r2).toMatchObject({ gravada: false, motivo: 'ja_tem_data', data: '2026-05-22T10:00:00.000Z' });
  });

  it('pedido mais antigo que a empresa (importado) manda', async () => {
    if (!temBanco) return;
    const id = await empresa({ criadaEm: '2026-05-22T10:00:00Z', vertical: 'studio', settings: { studio_enabled: true } });
    await vendaDoCaixa(id, '2026-01-02T10:00:00Z');
    const r = await ativacao.gravarDataOriginalDoStudio(conn, id);
    expect(r).toEqual({ gravada: true, motivo: 'primeiro_pedido', data: '2026-01-02T10:00:00.000Z' });
  });

  it('frente desligada nao recebe data', async () => {
    if (!temBanco) return;
    const id = await empresa({ settings: { studio_enabled: false } });
    const r = await ativacao.gravarDataOriginalDoStudio(conn, id);
    expect(r).toMatchObject({ gravada: false, motivo: 'frente_desligada' });
    expect(await settingsDe(id)).not.toHaveProperty(CHAVE);
  });

  it('data ja gravada (ligada depois deste PR) nao e trocada pela original', async () => {
    if (!temBanco) return;
    const id = await empresa({ criadaEm: '2026-05-22T10:00:00Z', settings: { studio_enabled: true, [CHAVE]: '2026-11-17T13:00:00.000Z' } });
    const r = await ativacao.gravarDataOriginalDoStudio(conn, id);
    expect(r).toMatchObject({ gravada: false, motivo: 'ja_tem_data', data: '2026-11-17T13:00:00.000Z' });
    expect((await settingsDe(id))[CHAVE]).toBe('2026-11-17T13:00:00.000Z');
  });
});
