// ============================================================
// AURA. — E-mails de relacionamento: gatilhos (tq-80, tq-81, tq-82b —
// 24/10/2026)
//
//   - boas-vindas: dono recebe uma vez; convidado, conta interna, sandbox,
//     Karatê, filial e conta antiga não; tipo "ajuda" desligado não; flag;
//     confirmação pela rota só dispara na transição para confirmado
//   - ciclo do teste: cada etapa manda uma vez por chave; outra vertical não
//     recebe 4.3/4.4 (segunda trava); flag EMAILS_TESTE_ENABLED; tipo "ajuda"
//   - sumiu: flag padrão desligada; carta recente segura; chave por período
//
// O SQL de seleção (janelas de dia, filtros) é provado no Postgres em
// relacionamento.banco.test.js. Aqui o banco é falso e só responde ao que
// cada função pergunta.
// ============================================================
'use strict';

jest.unmock('../src/services/relacionamento');

const R = require('../src/services/relacionamento');

const AGORA = Date.parse('2026-10-24T13:00:00Z'); // 10h BRT
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Banco falso. `dono`: a linha do SELECT da boas-vindas; `selecoes`: linhas
 * de cada etapa do job; `prefs`: { tipo: ligado }. O email_log é um Set de
 * chaves (a reserva devolve id só na primeira vez).
 */
function banco({ dono = null, selecoes = {}, prefs = {}, cartaRecente = false } = {}) {
  const chaves = new Set();
  const query = jest.fn(async (sql, params) => {
    const s = limpo(sql);
    if (s.startsWith('SELECT u.id AS user_id')) return { rows: dono ? [dono] : [] };
    if (s.includes('FROM company_email_prefs WHERE company_id = $1 AND tipo = $2')) {
      const t = params[1];
      return { rows: t in prefs ? [{ ligado: prefs[t], config: {} }] : [] };
    }
    if (s.startsWith('INSERT INTO email_log')) {
      if (chaves.has(params[0])) return { rows: [] };
      chaves.add(params[0]);
      return { rows: [{ id: 'log-' + chaves.size }] };
    }
    if (s.startsWith('UPDATE email_log')) return { rows: [], rowCount: 1 };
    if (s.includes('NOT EXISTS (SELECT 1 FROM sales')) return { rows: selecoes.sem_venda || [] };
    if (s.includes("BETWEEN 1 AND 2")) return { rows: selecoes.terminando || [] };
    if (s.includes('BETWEEN 0 AND 1')) return { rows: selecoes.encerrado || [] };
    if (s.startsWith('WITH elegiveis')) return { rows: selecoes.sumiu || [] };
    if (s.startsWith('SELECT 1 FROM email_log')) return { rows: cartaRecente ? [{ '?column?': 1 }] : [] };
    throw new Error('SQL inesperado: ' + s.slice(0, 80));
  });
  return { query, chaves };
}

const enviarOk = () => jest.fn(async () => ({ id: 're_1' }));

const donoPadrao = (extra) => ({
  user_id: 'u1', email: 'maria@exemplo.com', full_name: 'Maria Souza', is_staff: false, email_verified: true,
  user_created_at: '2026-10-24T12:00:00Z',
  company_id: 'emp-1', loja: 'Modas da Maria', company_email: null, is_active: true, is_sandbox: false,
  vertical: 'negocio', vertical_active: null, billing_status: 'trial', asaas_subscription_id: null,
  billing_owner_company_id: null, trial_mode: 'primeira_venda', trial_started_by_sale_at: null,
  trial_ends_at: '2026-11-08T12:00:00Z', created_at: '2026-10-24T12:00:00Z',
  ...extra,
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('tq-80 boas-vindas', () => {
  test('dono recebe uma vez, com a linha do teste certa e o descadastro do tipo ajuda', async () => {
    const db = banco({ dono: donoPadrao() });
    const enviar = enviarOk();
    expect(await R.aoConfirmarEmail('u1', { db, enviar, env: {}, now: AGORA })).toBe('sent');
    expect(await R.aoConfirmarEmail('u1', { db, enviar, env: {}, now: AGORA })).toBe('duplicate');
    expect(enviar).toHaveBeenCalledTimes(1);
    const m = enviar.mock.calls[0][0];
    expect(m.to).toBe('maria@exemplo.com');
    expect(m.subject).toBe('Oi, Maria, bem-vindo à Aura');
    expect(m.text).toContain('termina no máximo em 08/11');
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.text).toContain('Abrir minha conta: https://app.getaura.com.br/?empresa=emp-1');
    expect([...db.chaves]).toEqual(['boas-vindas:u1']);
  });

  test('convidado/funcionário (sem empresa própria) não recebe', async () => {
    const db = banco({ dono: null });
    const enviar = enviarOk();
    expect(await R.aoConfirmarEmail('u2', { db, enviar, env: {}, now: AGORA })).toBe('nao_e_dono');
    expect(enviar).not.toHaveBeenCalled();
  });

  test.each([
    ['conta interna (is_staff)', { is_staff: true }],
    ['conta interna (@getaura.com.br)', { email: 'caio@getaura.com.br' }],
    ['sandbox', { is_sandbox: true }],
    ['inativa', { is_active: false }],
    ['Karatê', { vertical: 'karate_dojo' }],
    ['filial de grupo', { billing_owner_company_id: 'emp-matriz' }],
  ])('%s fica fora', async (_, extra) => {
    const db = banco({ dono: donoPadrao(extra) });
    const enviar = enviarOk();
    expect(await R.aoConfirmarEmail('u1', { db, enviar, env: {}, now: AGORA })).toBe('fora');
    expect(enviar).not.toHaveBeenCalled();
  });

  test('conta criada há mais de 15 dias que só agora confirmou: nada retroativo', async () => {
    const db = banco({ dono: donoPadrao({ user_created_at: '2026-09-01T12:00:00Z' }) });
    const enviar = enviarOk();
    expect(await R.aoConfirmarEmail('u1', { db, enviar, env: {}, now: AGORA })).toBe('antigo');
    expect(enviar).not.toHaveBeenCalled();
  });

  test('tipo "ajuda" desligado nas preferências: não envia', async () => {
    const db = banco({ dono: donoPadrao(), prefs: { ajuda: false } });
    const enviar = enviarOk();
    expect(await R.aoConfirmarEmail('u1', { db, enviar, env: {}, now: AGORA })).toBe('desligado');
    expect(enviar).not.toHaveBeenCalled();
  });

  test('kill switch: EMAIL_BOAS_VINDAS_ENABLED=false ou EMAILS_CICLO_ENABLED=false', async () => {
    for (const env of [{ EMAIL_BOAS_VINDAS_ENABLED: 'false' }, { EMAILS_CICLO_ENABLED: 'false' }]) {
      const db = banco({ dono: donoPadrao() });
      const enviar = enviarOk();
      expect(await R.aoConfirmarEmail('u1', { db, enviar, env, now: AGORA })).toBe('desligado');
      expect(db.query).not.toHaveBeenCalled();
    }
  });

  test('código (7 dias fixos): a data do fim, não "7 dias"', async () => {
    const db = banco({ dono: donoPadrao({ trial_mode: 'fixo', trial_ends_at: '2026-10-31T12:00:00Z' }) });
    const enviar = enviarOk();
    await R.aoConfirmarEmail('u1', { db, enviar, env: {}, now: AGORA });
    expect(enviar.mock.calls[0][0].text).toContain('O seu teste grátis vai até 31/10.');
  });

  test('já assinou: sem linha do teste', async () => {
    const db = banco({ dono: donoPadrao({ billing_status: 'active' }) });
    const enviar = enviarOk();
    await R.aoConfirmarEmail('u1', { db, enviar, env: {}, now: AGORA });
    expect(enviar.mock.calls[0][0].text).not.toContain('teste grátis');
  });

  test('nunca lança: erro no banco vira "erro"', async () => {
    const db = { query: jest.fn(async () => { throw new Error('caiu'); }) };
    expect(await R.aoConfirmarEmail('u1', { db, enviar: enviarOk(), env: {}, now: AGORA })).toBe('erro');
  });
});

describe('tq-81 ciclo do teste', () => {
  const linha = (extra) => ({
    company_id: 'emp-1', loja: 'Modas da Maria', vertical: 'negocio', vertical_active: null,
    user_id: 'u1', email: 'maria@exemplo.com', full_name: 'Maria Souza',
    trial_ends_at: '2026-10-26T15:00:00Z', fim: '2026-10-26', n_produtos: 3, n_clientes: 2, ...extra,
  });

  test('cada etapa manda uma vez; a segunda volta não repete', async () => {
    const db = banco({
      selecoes: {
        sem_venda: [linha({ company_id: 'emp-a' })],
        terminando: [linha({ company_id: 'emp-b' })],
        encerrado: [linha({ company_id: 'emp-c', fim: '2026-10-24' })],
      },
    });
    const enviar = enviarOk();
    const r1 = await R.voltaDoTeste({ db, enviar, env: {}, now: AGORA });
    expect(r1).toEqual({ sem_venda: { sent: 1 }, terminando: { sent: 1 }, encerrado: { sent: 1 } });
    const r2 = await R.voltaDoTeste({ db, enviar, env: {}, now: AGORA });
    expect(r2).toEqual({ sem_venda: { duplicate: 1 }, terminando: { duplicate: 1 }, encerrado: { duplicate: 1 } });
    expect(enviar).toHaveBeenCalledTimes(3);
    expect([...db.chaves].sort()).toEqual([
      'primeira-venda:emp-a', 'teste-encerrado:emp-c:2026-10-24', 'teste-terminando:emp-b:2026-10-26',
    ]);
    const assuntos = enviar.mock.calls.map(([m]) => m.subject);
    expect(assuntos).toEqual(['Já fez a primeira venda na Aura?', 'Seu teste da Aura termina segunda-feira, dia 26/10', 'Seu teste da Aura terminou']);
    // Links com ?empresa= e o descadastro do tipo ajuda.
    expect(enviar.mock.calls[0][0].text).toContain('https://app.getaura.com.br/pdv?empresa=emp-a');
    expect(enviar.mock.calls[1][0].text).toContain('https://app.getaura.com.br/checkout?empresa=emp-b');
    for (const [m] of enviar.mock.calls) expect(m.headers['List-Unsubscribe']).toMatch(/^<https:.*\/emails\/descadastro\//);
  });

  test('outra vertical não recebe 4.3/4.4 (segunda trava além do SQL)', async () => {
    const db = banco({ selecoes: { terminando: [linha({ vertical_active: 'odonto' })], encerrado: [linha({ vertical_active: 'studio' })] } });
    const enviar = enviarOk();
    const r = await R.voltaDoTeste({ db, enviar, env: {}, now: AGORA });
    expect(r.terminando).toEqual({ fora_do_varejo: 1 });
    expect(r.encerrado).toEqual({ fora_do_varejo: 1 });
    expect(enviar).not.toHaveBeenCalled();
  });

  test('tipo "ajuda" desligado: nada sai', async () => {
    const db = banco({ selecoes: { sem_venda: [linha()] }, prefs: { ajuda: false } });
    const enviar = enviarOk();
    const r = await R.voltaDoTeste({ db, enviar, env: {}, now: AGORA });
    expect(r.sem_venda).toEqual({ desligado: 1 });
    expect(enviar).not.toHaveBeenCalled();
  });

  test('kill switch EMAILS_TESTE_ENABLED=false: nem consulta', async () => {
    const db = banco({ selecoes: { sem_venda: [linha()] } });
    const r = await R.voltaDoTeste({ db, enviar: enviarOk(), env: { EMAILS_TESTE_ENABLED: 'false' }, now: AGORA });
    expect(r.desligado).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('falha ao enviar fica "failed" e a volta seguinte tenta de novo', async () => {
    const db = banco({ selecoes: { sem_venda: [linha()] } });
    const enviar = jest.fn().mockRejectedValueOnce(new Error('Resend 500')).mockResolvedValue({ id: 're_2' });
    // O banco falso não reabre "failed": aqui só confere que a falha não derruba a volta.
    const r = await R.voltaDoTeste({ db, enviar, env: {}, now: AGORA });
    expect(r.sem_venda).toEqual({ failed: 1 });
  });

  test('ehVarejo espelha o caixaVivo do app', () => {
    expect(R.ehVarejo({ vertical: 'negocio', vertical_active: null })).toBe(true);
    expect(R.ehVarejo({ vertical: 'negocio', vertical_active: 'matcon' })).toBe(true);
    expect(R.ehVarejo({ vertical_active: 'odonto' })).toBe(false);
    expect(R.ehVarejo({ vertical_active: 'food' })).toBe(false);
    expect(R.ehVarejo({ vertical_active: 'studio' })).toBe(false);
    expect(R.ehVarejo({ vertical: 'karate_dojo', vertical_active: null })).toBe(false);
  });
});

describe('tq-82b faz uns dias que você não aparece', () => {
  const linha = (extra) => ({
    company_id: 'emp-1', owner_id: 'u1', loja: 'Modas da Maria', user_id: 'u1', email: 'maria@exemplo.com',
    full_name: 'Maria Souza', ultimo_dia: '2026-10-17', ...extra,
  });

  test('padrão DESLIGADO (texto a aprovar): sem a flag, nem consulta', async () => {
    const db = banco({ selecoes: { sumiu: [linha()] } });
    expect(await R.voltaDoSumiu({ db, enviar: enviarOk(), env: {}, now: AGORA })).toEqual({ desligado: true });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('ligado: uma vez por período de ausência (chave com o dia do último acesso)', async () => {
    const db = banco({ selecoes: { sumiu: [linha()] } });
    const enviar = enviarOk();
    const env = { EMAIL_SUMIU_ENABLED: 'true' };
    expect(await R.voltaDoSumiu({ db, enviar, env, now: AGORA })).toEqual({ sent: 1 });
    expect(await R.voltaDoSumiu({ db, enviar, env, now: AGORA })).toEqual({ duplicate: 1 });
    expect([...db.chaves]).toEqual(['sumiu:u1:2026-10-17']);
    expect(enviar.mock.calls[0][0].subject).toBe('Faz uns dias que você não aparece');
  });

  test('outra carta do Caio nos últimos 2 dias: espera', async () => {
    const db = banco({ selecoes: { sumiu: [linha()] }, cartaRecente: true });
    const enviar = enviarOk();
    expect(await R.voltaDoSumiu({ db, enviar, env: { EMAIL_SUMIU_ENABLED: '1' }, now: AGORA })).toEqual({ carta_recente: 1 });
    expect(enviar).not.toHaveBeenCalled();
  });

  test('tipo "acompanhamento" desligado: não envia', async () => {
    const db = banco({ selecoes: { sumiu: [linha()] }, prefs: { acompanhamento: false } });
    const enviar = enviarOk();
    expect(await R.voltaDoSumiu({ db, enviar, env: { EMAIL_SUMIU_ENABLED: 'true' }, now: AGORA })).toEqual({ desligado: 1 });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe('rota de confirmação: boas-vindas só na transição', () => {
  function app() {
    jest.resetModules();
    jest.doMock('../src/services/relacionamento', () => ({ aoConfirmarEmail: jest.fn(async () => 'ok') }));
    const express = require('express');
    const db = require('../src/config/database');
    const rel = require('../src/services/relacionamento');
    const a = express();
    a.use(express.json());
    a.use('/auth', require('../src/routes/verification'));
    return { a, db, rel };
  }

  test('GET /confirm-email: UPDATE devolveu a linha (virou confirmado) -> boas-vindas', async () => {
    const request = require('supertest');
    const { a, db, rel } = app();
    db.query.mockReset();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'vc1', user_id: 'u1', expires_at: new Date(Date.now() + 60000), verified_at: null, full_name: 'Maria' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] });
    const r = await request(a).get('/auth/confirm-email/tok');
    expect(r.status).toBe(302);
    await new Promise((res) => setImmediate(res));
    expect(rel.aoConfirmarEmail).toHaveBeenCalledWith('u1');
    const upd = db.query.mock.calls.find(([s]) => /UPDATE users SET email_verified=true/.test(s));
    expect(upd[0]).toContain('AND email_verified IS NOT TRUE RETURNING id');
  });

  test('já estava confirmado (UPDATE sem linha): nada sai', async () => {
    const request = require('supertest');
    const { a, db, rel } = app();
    db.query.mockReset();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'vc1', user_id: 'u1', expires_at: new Date(Date.now() + 60000), verified_at: null, full_name: 'Maria' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await request(a).get('/auth/confirm-email/tok');
    await new Promise((res) => setImmediate(res));
    expect(rel.aoConfirmarEmail).not.toHaveBeenCalled();
  });
});

describe('job: volta diária a partir das 10h BRT, uma vez por dia', () => {
  const { deveRodarODiario } = require('../src/jobs/relacionamentoJob');
  const em = (h) => Date.parse(`2026-10-24T${String(h + 3).padStart(2, '0')}:10:00Z`); // h em BRT

  test('9h não, 10h sim, 18h não; no mesmo dia, só uma vez', () => {
    expect(deveRodarODiario(em(9), null)).toBe(false);
    expect(deveRodarODiario(em(10), null)).toBe(true);
    expect(deveRodarODiario(em(15), null)).toBe(true);
    expect(deveRodarODiario(em(18), null)).toBe(false);
    expect(deveRodarODiario(em(11), '2026-10-24')).toBe(false);
    expect(deveRodarODiario(em(11), '2026-10-23')).toBe(true);
  });
});
