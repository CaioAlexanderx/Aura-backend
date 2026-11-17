// ============================================================
// AURA. — Casa no Negocio no Postgres real (p-189, 17/11/2026)
// Schema das migrations (CI). Confere o SQL de services/casaNegocio.js:
//
//   1. ligar: vertical_active NULL, casa ligada, data original gravada,
//      pdv_settings (studio_enabled incluso) byte a byte igual fora a data,
//      audit log na mesma transacao
//   2. desligar: vertical_active 'studio' com o vertical_enabled_at de antes;
//      ida e volta repetida reversivel
//   3. o PATCH /studio/settings do lojista (merge com lista) nao apaga a casa
//      e o PUT /pdv-settings nao a alcanca (ela nao mora la)
//
// Uma transacao revertida no afterAll (nada fica no banco). Sem Postgres
// local a suite e pulada; no CI o servico existe e ela e obrigatoria.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const casa = require('../src/services/casaNegocio');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let temBanco = false;

let qn = 0;
async function q(sql, params) {
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
const conn = { query: (sql, params) => q(sql, params) };

const dono = uuid();
const staff = uuid();

async function empresa({ vertical = 'studio', settings = { studio_enabled: true }, studio = {}, plan = 'negocio' } = {}) {
  const id = uuid();
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, vertical_active, vertical_enabled_at,
                            pdv_settings, studio_settings, created_at)
     VALUES ($1, $2, 'Fixture p-189 LTDA', 'Fixture p-189', $3, $4, $5, $6::jsonb, $7::jsonb, '2026-05-22T10:00:00Z')`,
    [id, dono, plan, vertical, vertical ? '2026-05-25T09:00:00Z' : null, JSON.stringify(settings), JSON.stringify(studio)]
  );
  return id;
}
async function linha(id) {
  const { rows } = await q(
    'SELECT vertical_active, vertical_enabled_at, pdv_settings, studio_settings FROM companies WHERE id = $1', [id]
  );
  return rows[0];
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
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture p-189'), ($3, $4, 'x', 'Equipe p-189')`,
    [dono, `fixture-${dono}@example.test`, staff, `equipe-${staff}@example.test`]);
  // admin_audit_log vive em src/migrations/108 (fora do runner do CI). Mesma
  // definicao; a transacao e revertida no fim.
  await q(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id SERIAL PRIMARY KEY,
    staff_user_id UUID NOT NULL REFERENCES users(id),
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    payload JSONB,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end().catch(() => {});
});

async function auditDe(id) {
  const { rows } = await q('SELECT staff_user_id, action, payload FROM admin_audit_log WHERE company_id = $1 ORDER BY id', [id]);
  return rows;
}

describe('1 e 2. ligar e desligar no Postgres', () => {
  it('liga: sem vertical, casa ligada, data original; studio_enabled e o resto iguais', async () => {
    if (!temBanco) return;
    const ps = { studio_enabled: true, caixa_enabled: true, label_size: '30x25' };
    const id = await empresa({ settings: ps, studio: { default_sla_days: 3 } });

    const out = await casa.ligarCasa(conn, id, { staffUserId: staff, agora: new Date('2026-12-01T12:00:00.000Z') });
    expect(out.changed).toBe(true);
    expect(out.data_original).toEqual({ gravada: true, motivo: 'empresa', data: '2026-05-22T10:00:00.000Z' });

    const r = await linha(id);
    expect(r.vertical_active).toBeNull();
    expect(r.vertical_enabled_at).toBeNull();
    expect(r.pdv_settings).toEqual({ ...ps, personalizados_ativado_em: '2026-05-22T10:00:00.000Z' });
    expect(r.studio_settings).toEqual({
      default_sla_days: 3,
      casa_negocio: true,
      casa_negocio_em: '2026-12-01T12:00:00.000Z',
      casa_negocio_studio_desde: '2026-05-25T09:00:00.000Z',
    });
    expect(await casa.casaLigadaNoBanco(conn, id)).toBe(true);
    const audit = await auditDe(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ staff_user_id: staff, action: 'casa_negocio_on' });
    expect(audit[0].payload).toMatchObject({ to: { vertical_active: null, casa_negocio: true }, studio_enabled: true });
  });

  it('desliga: volta ao Studio com a data de antes; ida e volta 2 vezes e reversivel', async () => {
    if (!temBanco) return;
    const ps = { studio_enabled: true, require_seller: true };
    const id = await empresa({ settings: ps });
    for (let i = 0; i < 2; i += 1) {
      await casa.ligarCasa(conn, id, { staffUserId: staff });
      const out = await casa.desligarCasa(conn, id, { staffUserId: staff });
      expect(out.changed).toBe(true);
      const r = await linha(id);
      expect(r.vertical_active).toBe('studio');
      expect(new Date(r.vertical_enabled_at).toISOString()).toBe('2026-05-25T09:00:00.000Z');
      expect(r.studio_settings.casa_negocio).toBe(false);
      expect(r.pdv_settings).toEqual({ ...ps, personalizados_ativado_em: '2026-05-22T10:00:00.000Z' });
      expect(await casa.casaLigadaNoBanco(conn, id)).toBe(false);
    }
    expect((await auditDe(id)).map((a) => a.action))
      .toEqual(['casa_negocio_on', 'casa_negocio_off', 'casa_negocio_on', 'casa_negocio_off']);
  });

  it('empresa fora do Studio: recusa e nada muda', async () => {
    if (!temBanco) return;
    const id = await empresa({ vertical: null, settings: { studio_enabled: false } });
    const antes = await linha(id);
    await expect(casa.ligarCasa(conn, id, { staffUserId: staff })).rejects.toMatchObject({ code: 'CASA_NAO_ESTA_NO_STUDIO' });
    expect(await linha(id)).toEqual(antes);
    expect(await auditDe(id)).toHaveLength(0);
  });
});

describe('3. a casa nao some pelas gravacoes do lojista', () => {
  it('merge de studio_settings (como o PATCH /studio/settings) mantem a casa', async () => {
    if (!temBanco) return;
    const id = await empresa();
    await casa.ligarCasa(conn, id, { staffUserId: staff });
    // Mesmo UPDATE de routes/studio.js (PATCH /studio/settings).
    await q(
      `UPDATE companies SET studio_settings = COALESCE(studio_settings, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify({ default_sla_days: 5 }), id]
    );
    const r = await linha(id);
    expect(r.studio_settings.casa_negocio).toBe(true);
    expect(r.studio_settings.default_sla_days).toBe(5);
  });
});
