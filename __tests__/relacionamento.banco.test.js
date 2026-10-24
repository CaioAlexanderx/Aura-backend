// ============================================================
// AURA. — E-mails de relacionamento no Postgres de verdade (24/10/2026;
// migration 410; tq-73, tq-79, tq-80, tq-81, tq-82)
//
// Prova o SQL: as janelas de dia em São Paulo (nada retroativo), os filtros
// (conta interna, sandbox, e-mail não confirmado, Karatê, outra vertical,
// filial, quem já assinou, quem já vendeu), o último acesso por dono, o
// espelho das assinaturas (ordem dos eventos, encerramento uma vez, marca
// de quem pediu) e a idempotência de ponta a ponta pelo email_log. Tudo numa
// transação revertida no banco do CI, como emailsCobranca.banco.test.js.
// ============================================================
'use strict';

jest.unmock('../src/services/relacionamento');
jest.unmock('../src/services/assinaturasAsaas');

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;

const R = require('../src/services/relacionamento');
const A = require('../src/services/assinaturasAsaas');

// 24/10/2026, 10h em São Paulo.
const AGORA = Date.parse('2026-10-24T13:00:00Z');
const HOJE = '2026-10-24';
const ISO = new Date(AGORA).toISOString();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  // A 410 roda de novo dentro da transação: prova que é idempotente.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '410_assinaturas_asaas.sql'), 'utf8');
  await client.query(sql);
  await client.query(sql);
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const conn = () => ({ query: (s, p) => client.query(s, p) });

/** "AAAA-MM-DD HH:MM" em São Paulo -> timestamptz. */
const brt = (s) => `${s}:00-03`;

/**
 * Cria dono + empresa. Defaults: varejo, em teste sem assinatura, e-mail
 * confirmado, ativa, fora de sandbox.
 */
async function loja(o = {}) {
  const dono = o.dono || uuid();
  const id = uuid();
  if (!o.dono) {
    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name, is_staff, email_verified)
       VALUES ($1, $2, 'x', 'Maria Fixture', $3, $4)`,
      [dono, o.email || `maria-${dono.slice(0, 8)}@example.test`, !!o.staff, o.verificado !== false]
    );
  }
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_status, asaas_subscription_id, trial_mode,
                            trial_ends_at, created_at, is_sandbox, is_active, vertical, vertical_active,
                            billing_owner_company_id, last_active_at, asaas_customer_id)
     VALUES ($1, $2, 'Fixture Ltda', $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12, $13, $14::timestamptz, $15)`,
    [
      id, dono, o.loja || 'Modas Fixture', o.billing || 'trial', o.sub || null, o.modo || 'primeira_venda',
      o.fim ? brt(o.fim) : brt('2026-11-05 12:00'), o.criada ? brt(o.criada) : brt('2026-10-22 12:00'),
      !!o.sandbox, o.ativa !== false, o.vertical || 'negocio', o.verticalAtiva || null,
      o.matriz || null, o.acesso ? brt(o.acesso) : null, o.cliente || null,
    ]
  );
  for (let i = 0; i < (o.produtos || 0); i++) {
    await client.query(`INSERT INTO products (company_id, name) VALUES ($1, $2)`, [id, 'Produto ' + i]);
  }
  if (o.produtoArquivado) {
    await client.query(`INSERT INTO products (company_id, name, is_active) VALUES ($1, 'Arquivado', false)`, [id]);
  }
  for (let i = 0; i < (o.clientes || 0); i++) {
    await client.query(`INSERT INTO customers (company_id, name) VALUES ($1, $2)`, [id, 'Cliente ' + i]);
  }
  if (o.vendeu) await client.query(`INSERT INTO sales (company_id) VALUES ($1)`, [id]);
  return { id, dono };
}

async function selecionar(sql, params = [HOJE, ISO]) {
  const { rows } = await client.query(sql, params);
  return rows;
}

const ids = (rows) => new Set(rows.map((r) => r.company_id));

describe('4.2 primeira venda que não saiu: 2 dias depois do cadastro (3 na recuperação)', () => {
  let casos;
  beforeAll(async () => {
    casos = {
      dia1: await loja({ criada: '2026-10-23 09:00' }),
      dia2: await loja({ criada: '2026-10-22 23:30', produtos: 2, produtoArquivado: true }),
      dia3: await loja({ criada: '2026-10-21 08:00' }),
      dia4: await loja({ criada: '2026-10-20 12:00' }),
      vendeu: await loja({ vendeu: true }),
      interna: await loja({ staff: true }),
      internaEmail: await loja({ email: 'teste-fix@getaura.com.br' }),
      sandbox: await loja({ sandbox: true }),
      naoConfirmou: await loja({ verificado: false }),
      inativa: await loja({ ativa: false }),
      odonto: await loja({ verticalAtiva: 'odonto' }),
      karate: await loja({ vertical: 'karate_dojo' }),
      assinou: await loja({ billing: 'active' }),
      cupomCartao: await loja({ sub: 'sub_cupom' }),
      vencido: await loja({ fim: '2026-10-23 12:00' }),
    };
    casos.filial = await loja({ matriz: casos.dia2.id });
  });

  test('só os dias 2 e 3, com a contagem de produtos ativos', async () => {
    const rows = await selecionar(R.SQL_SEM_VENDA);
    const achou = ids(rows);
    expect(achou.has(casos.dia2.id)).toBe(true);
    expect(achou.has(casos.dia3.id)).toBe(true);
    for (const k of ['dia1', 'dia4', 'vendeu', 'interna', 'internaEmail', 'sandbox', 'naoConfirmou', 'inativa',
      'odonto', 'karate', 'assinou', 'cupomCartao', 'vencido', 'filial']) {
      expect([k, achou.has(casos[k].id)]).toEqual([k, false]);
    }
    expect(rows.find((r) => r.company_id === casos.dia2.id).n_produtos).toBe(2);
  });

  test('de ponta a ponta: a volta manda uma vez; a segunda não repete', async () => {
    const enviar = jest.fn(async () => ({ id: 're_x' }));
    const db = conn();
    const r1 = await R.voltaDoTeste({ db, enviar, env: {}, now: AGORA });
    const r2 = await R.voltaDoTeste({ db, enviar, env: {}, now: AGORA });
    const nossas = enviar.mock.calls.filter(([m]) => /Já fez a primeira venda/.test(m.subject)).length;
    expect(nossas).toBeGreaterThanOrEqual(2);
    expect(r2.sem_venda.sent || 0).toBe(0);
    const { rows } = await client.query(
      `SELECT chave_idempotencia, status FROM email_log WHERE chave_idempotencia = ANY($1::text[])`,
      [[`primeira-venda:${casos.dia2.id}`, `primeira-venda:${casos.dia3.id}`]]
    );
    expect(rows.map((x) => x.status).sort()).toEqual(['sent', 'sent']);
    expect(r1.sem_venda.sent).toBeGreaterThanOrEqual(2);
  });
});

describe('4.3 teste terminando e 4.4 teste encerrado (só varejo)', () => {
  let c;
  beforeAll(async () => {
    c = {
      em2: await loja({ fim: '2026-10-26 15:00' }),
      em1: await loja({ fim: '2026-10-25 15:00' }),
      em3: await loja({ fim: '2026-10-27 15:00' }),
      emHojeMaisTarde: await loja({ fim: '2026-10-24 18:00' }),
      acabouHojeCedo: await loja({ fim: '2026-10-24 08:00', produtos: 3, clientes: 2 }),
      acabouOntem: await loja({ fim: '2026-10-23 20:00' }),
      acabouHa2: await loja({ fim: '2026-10-22 20:00' }),
      acabouHa20: await loja({ fim: '2026-10-04 20:00' }),
      studio2: await loja({ fim: '2026-10-26 15:00', verticalAtiva: 'studio' }),
      foodAcabou: await loja({ fim: '2026-10-24 08:00', verticalAtiva: 'food' }),
      assinouAcabou: await loja({ fim: '2026-10-24 08:00', billing: 'active' }),
      atrasoAcabou: await loja({ fim: '2026-10-24 08:00', billing: 'overdue' }),
    };
  });

  test('4.3: 2 dias antes e 1 (recuperação); nunca no dia nem 3 antes; outra vertical fora', async () => {
    const achou = ids(await selecionar(R.SQL_TERMINANDO));
    expect(achou.has(c.em2.id)).toBe(true);
    expect(achou.has(c.em1.id)).toBe(true);
    for (const k of ['em3', 'emHojeMaisTarde', 'studio2', 'acabouHojeCedo']) expect([k, achou.has(c[k].id)]).toEqual([k, false]);
  });

  test('4.4: acabou hoje (antes da volta) ou ontem; nada de 2 ou 20 dias atrás; só teste e varejo', async () => {
    const rows = await selecionar(R.SQL_ENCERRADO);
    const achou = ids(rows);
    expect(achou.has(c.acabouHojeCedo.id)).toBe(true);
    expect(achou.has(c.acabouOntem.id)).toBe(true);
    for (const k of ['acabouHa2', 'acabouHa20', 'emHojeMaisTarde', 'foodAcabou', 'assinouAcabou', 'atrasoAcabou']) {
      expect([k, achou.has(c[k].id)]).toEqual([k, false]);
    }
    const r = rows.find((x) => x.company_id === c.acabouHojeCedo.id);
    expect(r).toMatchObject({ n_produtos: 3, n_clientes: 2, fim: '2026-10-24' });
  });

  test('a chave leva a data do fim: teste estendido ganha o seu aviso, o mesmo fim não repete', async () => {
    const enviar = jest.fn(async () => ({ id: 're_y' }));
    await R.voltaDoTeste({ db: conn(), enviar, env: {}, now: AGORA });
    const { rows } = await client.query(
      `SELECT chave_idempotencia FROM email_log WHERE company_id = $1 AND tipo = 'ajuda_teste_terminando'`,
      [c.em2.id]
    );
    expect(rows.map((x) => x.chave_idempotencia)).toEqual([`teste-terminando:${c.em2.id}:2026-10-26`]);
  });
});

describe('sumiu: 7 dias sem acesso (8 na recuperação), por dono', () => {
  let c;
  beforeAll(async () => {
    c = {
      d7: await loja({ billing: 'active', acesso: '2026-10-17 15:00' }),
      d8: await loja({ billing: 'active', acesso: '2026-10-16 15:00' }),
      d6: await loja({ billing: 'active', acesso: '2026-10-18 15:00' }),
      d9: await loja({ billing: 'active', acesso: '2026-10-15 15:00' }),
      nunca: await loja({ billing: 'active', acesso: null }),
      testeVigente: await loja({ acesso: '2026-10-17 10:00', fim: '2026-11-01 12:00' }),
      testeVencido: await loja({ acesso: '2026-10-17 10:00', fim: '2026-10-20 12:00' }),
      atraso: await loja({ billing: 'overdue', acesso: '2026-10-17 10:00' }),
      interna: await loja({ billing: 'active', staff: true, acesso: '2026-10-17 10:00' }),
    };
    // Dono com duas empresas: uma parada há 7 dias e a outra usada ontem.
    const g = await loja({ billing: 'active', acesso: '2026-10-17 10:00' });
    c.grupoParada = g;
    c.grupoAtiva = await loja({ dono: g.dono, billing: 'active', acesso: '2026-10-23 10:00' });
  });

  test('janela exata, NULL fora, só pagante ou teste vigente, grupo pelo acesso mais recente', async () => {
    const rows = await selecionar(R.SQL_SUMIU, [HOJE, ISO, R.DIAS_SEM_ACESSO]);
    const achou = ids(rows);
    expect(achou.has(c.d7.id)).toBe(true);
    expect(achou.has(c.d8.id)).toBe(true);
    expect(achou.has(c.testeVigente.id)).toBe(true);
    for (const k of ['d6', 'd9', 'nunca', 'testeVencido', 'atraso', 'interna', 'grupoParada', 'grupoAtiva']) {
      expect([k, achou.has(c[k].id)]).toEqual([k, false]);
    }
    expect(rows.find((r) => r.company_id === c.d7.id).ultimo_dia).toBe('2026-10-17');
  });

  test('de ponta a ponta (flag ligada): uma vez por período; carta recente do Caio segura', async () => {
    await client.query(
      `INSERT INTO email_log (chave_idempotencia, tipo, company_id, status, created_at)
       VALUES ($1, 'ajuda_teste_terminando', $2, 'sent', $3::timestamptz)`,
      ['fixture-carta-' + c.d8.id, c.d8.id, new Date(AGORA - 86400000).toISOString()]
    );
    const enviar = jest.fn(async () => ({ id: 're_s' }));
    const env = { EMAIL_SUMIU_ENABLED: 'true' };
    const r1 = await R.voltaDoSumiu({ db: conn(), enviar, env, now: AGORA });
    const r2 = await R.voltaDoSumiu({ db: conn(), enviar, env, now: AGORA });
    expect(r1.carta_recente).toBeGreaterThanOrEqual(1);
    expect(r2.sent || 0).toBe(0);
    const { rows } = await client.query(
      `SELECT chave_idempotencia, tipo FROM email_log WHERE company_id = ANY($1::uuid[]) AND tipo = 'acompanhamento_sumiu'`,
      [[c.d7.id, c.d8.id]]
    );
    expect(rows).toEqual([{ chave_idempotencia: `sumiu:${c.d7.dono}:2026-10-17`, tipo: 'acompanhamento_sumiu' }]);
  });
});

describe('boas-vindas no banco: dono uma vez, convidado não', () => {
  test('dono recebe; convidado (sem empresa própria) não', async () => {
    const d = await loja({ criada: '2026-10-24 09:00', fim: '2026-11-08 09:00' });
    await client.query(`UPDATE users SET created_at = $2::timestamptz WHERE id = $1`, [d.dono, brt('2026-10-24 09:00')]);
    const enviar = jest.fn(async () => ({ id: 're_bv' }));
    expect(await R.aoConfirmarEmail(d.dono, { db: conn(), enviar, env: {}, now: AGORA })).toBe('sent');
    expect(await R.aoConfirmarEmail(d.dono, { db: conn(), enviar, env: {}, now: AGORA })).toBe('duplicate');
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0][0].text).toContain('termina no máximo em 08/11');

    const convidado = uuid();
    await client.query(`INSERT INTO users (id, email, password_hash, full_name, email_verified) VALUES ($1, $2, 'x', 'João', true)`,
      [convidado, `joao-${convidado.slice(0, 8)}@example.test`]);
    expect(await R.aoConfirmarEmail(convidado, { db: conn(), enviar, env: {}, now: AGORA })).toBe('nao_e_dono');
  });
});

describe('espelho das assinaturas (410)', () => {
  test('evento, encerramento uma vez, ordem dos eventos e nunca toca em companies', async () => {
    const l = await loja({ billing: 'active', sub: 'sub_esp1', cliente: 'cus_esp1' });
    const db = conn();
    const asaas = jest.fn();
    const ev = (event, extra = {}, sub = {}) => ({
      id: `evt_${event}_${Math.random()}`, event, dateCreated: '2026-10-24 10:00:00',
      subscription: { id: 'sub_esp1', customer: 'cus_esp1', value: 169, status: 'ACTIVE', deleted: false, nextDueDate: '2026-11-20', ...sub },
      ...extra,
    });
    let r = await A.processarEventoDeAssinatura({ body: ev('SUBSCRIPTION_CREATED', { dateCreated: '2026-10-01 10:00:00' }), hasSecret: true, db, asaas });
    expect(r).toMatchObject({ handled: true, company_found: true, encerrada: false });
    r = await A.processarEventoDeAssinatura({ body: ev('SUBSCRIPTION_DELETED', {}, { deleted: true }), hasSecret: true, db, asaas });
    expect(r.encerrada).toBe(true);
    // UPDATED antigo chegando depois não revive a removida.
    await A.processarEventoDeAssinatura({ body: ev('SUBSCRIPTION_UPDATED', { dateCreated: '2026-10-05 10:00:00' }), hasSecret: true, db, asaas });
    const { rows } = await client.query(
      `SELECT status, removida, ultimo_evento, encerrada_em IS NOT NULL AS encerrada, evento_de_encerramento,
              era_atual_no_encerramento, company_id FROM assinaturas_asaas WHERE asaas_subscription_id = 'sub_esp1'`
    );
    expect(rows[0]).toMatchObject({
      status: 'DELETED', removida: true, ultimo_evento: 'SUBSCRIPTION_DELETED', encerrada: true,
      evento_de_encerramento: 'SUBSCRIPTION_DELETED', era_atual_no_encerramento: true, company_id: l.id,
    });
    const emp = await client.query(`SELECT billing_status, asaas_subscription_id FROM companies WHERE id = $1`, [l.id]);
    expect(emp.rows[0]).toEqual({ billing_status: 'active', asaas_subscription_id: 'sub_esp1' });
    const logs = await client.query(
      `SELECT event FROM webhook_logs WHERE company_id = $1 AND provider = 'asaas' ORDER BY processed_at`, [l.id]
    );
    // NOW() é o mesmo dentro da transação: compara o conjunto.
    expect(logs.rows.map((x) => x.event).sort()).toEqual(['SUBSCRIPTION_CREATED', 'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_UPDATED']);
  });

  test('reenvio do mesmo evento (mesmo evt_) não grava outra linha', async () => {
    const l = await loja({ billing: 'active', sub: 'sub_esp2', cliente: 'cus_esp2' });
    const body = { id: 'evt_repetido_1', event: 'SUBSCRIPTION_UPDATED', dateCreated: '2026-10-24 10:00:00', subscription: { id: 'sub_esp2', customer: 'cus_esp2', status: 'ACTIVE' } };
    await A.processarEventoDeAssinatura({ body, hasSecret: true, db: conn(), asaas: jest.fn() });
    const r = await A.processarEventoDeAssinatura({ body, hasSecret: true, db: conn(), asaas: jest.fn() });
    expect(r.duplicate).toBe(true);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM webhook_logs WHERE company_id = $1`, [l.id]);
    expect(rows[0].n).toBe(1);
  });

  test('marca de troca de plano antes do DELETE; o aviso decide "pela_aura" e não envia', async () => {
    const l = await loja({ billing: 'active', sub: 'sub_troca', cliente: 'cus_troca' });
    const db = conn();
    expect(await A.marcarEncerramentoPedido(db, 'sub_troca', { companyId: l.id, motivo: 'troca_de_plano' })).toBe(true);
    await A.processarEventoDeAssinatura({
      body: { id: 'evt_troca', event: 'SUBSCRIPTION_DELETED', dateCreated: '2026-10-24 07:00:00', subscription: { id: 'sub_troca', customer: 'cus_troca', deleted: true } },
      hasSecret: true, db, asaas: jest.fn(),
    });
    // Encerrada há 3 h (fora da espera de 2 h).
    await client.query(`UPDATE assinaturas_asaas SET encerrada_em = $2::timestamptz WHERE asaas_subscription_id = $1`, ['sub_troca', new Date(AGORA - 3 * 3600000).toISOString()]);
    const enviar = jest.fn();
    const r = await A.avisosDeCancelamento({ db, asaas: jest.fn(), enviar, env: { EMAIL_ASSINATURA_CANCELADA_ENABLED: 'true' }, now: AGORA });
    expect(r.pela_aura).toBeGreaterThanOrEqual(1);
    expect(enviar).not.toHaveBeenCalled();
    const { rows } = await client.query(`SELECT aviso_resultado, encerramento_pedido_por FROM assinaturas_asaas WHERE asaas_subscription_id = 'sub_troca'`);
    expect(rows[0]).toEqual({ aviso_resultado: 'pela_aura', encerramento_pedido_por: 'troca_de_plano' });
  });

  test('cancelada de verdade: avisa uma vez; encerrada há 30 h fica fora (nada retroativo)', async () => {
    const l = await loja({ billing: 'active', sub: 'sub_real', cliente: 'cus_real' });
    const velha = await loja({ billing: 'active', sub: 'sub_velha', cliente: 'cus_velha' });
    const db = conn();
    for (const [sub, cus] of [['sub_real', 'cus_real'], ['sub_velha', 'cus_velha']]) {
      await A.processarEventoDeAssinatura({
        body: { id: 'evt_' + sub, event: 'SUBSCRIPTION_DELETED', dateCreated: '2026-10-24 07:00:00', subscription: { id: sub, customer: cus, deleted: true } },
        hasSecret: true, db, asaas: jest.fn(),
      });
    }
    await client.query(`UPDATE assinaturas_asaas SET encerrada_em = $1::timestamptz WHERE asaas_subscription_id = 'sub_real'`, [new Date(AGORA - 3 * 3600000).toISOString()]);
    await client.query(`UPDATE assinaturas_asaas SET encerrada_em = $1::timestamptz WHERE asaas_subscription_id = 'sub_velha'`, [new Date(AGORA - 30 * 3600000).toISOString()]);
    const asaas = jest.fn(async (m, caminho) => {
      if (caminho.startsWith('/subscriptions/')) return { id: caminho.split('/').pop(), deleted: true, status: 'INACTIVE' };
      return { data: [] };
    });
    const enviar = jest.fn(async () => ({ id: 're_c' }));
    const env = { EMAIL_ASSINATURA_CANCELADA_ENABLED: 'true' };
    await A.avisosDeCancelamento({ db, asaas, enviar, env, now: AGORA });
    await A.avisosDeCancelamento({ db, asaas, enviar, env, now: AGORA });
    const paraReal = enviar.mock.calls.filter(([m]) => m.subject === 'A assinatura da Aura foi cancelada');
    expect(paraReal).toHaveLength(1);
    const { rows } = await client.query(
      `SELECT asaas_subscription_id, aviso_resultado FROM assinaturas_asaas WHERE asaas_subscription_id IN ('sub_real', 'sub_velha') ORDER BY 1`
    );
    expect(rows).toEqual([
      { asaas_subscription_id: 'sub_real', aviso_resultado: 'enviado' },
      { asaas_subscription_id: 'sub_velha', aviso_resultado: null },
    ]);
    const log = await client.query(`SELECT status FROM email_log WHERE chave_idempotencia = 'assinatura-cancelada:sub_real'`);
    expect(log.rows).toEqual([{ status: 'sent' }]);
    expect(l.id).toBeTruthy();
    expect(velha.id).toBeTruthy();
  });
});
