// ============================================================
// AURA. -- Registrar contato: POST/GET /admin/painel/contatos (14/10/2026)
//
// O botão "Registrar contato" da ficha e do verbo dos alertas grava em
// company_admin_notes (empresa) ou lead_interactions (lead); a Cassie lê
// com GET ?desde= na rodada das 7h30.
//
//   1. POST empresa: 201 { id, created_at }, validação por enum
//   2. POST: motivo obrigatório quando nao_quer; company_id OU lead_id
//   3. POST com checkin: vai junto, como_chegou só na primeira vez
//   4. POST lead: lead_interactions (presencial → visita) e follow-up
//   5. GET ?desde=: empresas e leads, ordem, validação, migration pendente
//
// Mock por CONTEUDO DO SQL (marcadores `-- contato:*`), nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let db;
let router;

const SECRET = 'aura-test-secret-2026';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const CID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LID = 'cccccccc-0000-4000-8000-000000000001';
// Sem validade: um teste move o relógio (fake timers).
const staff = { Authorization: `Bearer ${jwt.sign({ id: USER, role: 'admin' }, SECRET)}` };
const cliente = { Authorization: `Bearer ${jwt.sign({ id: USER, role: 'user', company: CID }, SECRET)}` };

beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  router = require('../../src/routes/adminPainel');
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/painel', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

const pend = (code = '42703') => Object.assign(new Error('column does not exist'), { code });

function mockBanco({
  empresa = true, lead = true, notaErro = null, checkinErro = null, leadErro = null,
  listaEmpresas = [], listaLeads = [], listaErro = null,
} = {}) {
  const visto = { notas: [], leads: [], followups: [], consultas: [] };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '').replace(/\s+/g, ' ');
    if (/^SELECT id FROM companies WHERE id = \$1/.test(s)) return Promise.resolve({ rows: empresa ? [{ id: params[0] }] : [] });
    if (/^SELECT id FROM sales_leads WHERE id = \$1/.test(s)) return Promise.resolve({ rows: lead ? [{ id: params[0] }] : [] });
    if (/FROM users WHERE id = \$1/.test(s)) return Promise.resolve({ rows: [{ nome: 'Caio Pantoja' }] });
    if (/-- contato:nota\+checkin/.test(s)) {
      if (checkinErro) return Promise.reject(checkinErro);
      if (notaErro) return Promise.reject(notaErro);
      visto.notas.push({ sql: s, params, comCheckin: true });
      return Promise.resolve({ rows: [{ id: 41, created_at: '2026-10-14T12:00:00.000Z' }] });
    }
    if (/-- contato:nota/.test(s)) {
      if (notaErro) return Promise.reject(notaErro);
      visto.notas.push({ sql: s, params, comCheckin: false });
      return Promise.resolve({ rows: [{ id: 42, created_at: '2026-10-14T12:00:01.000Z' }] });
    }
    if (/-- contato:lead-followup/.test(s)) { visto.followups.push(params); return Promise.resolve({ rows: [] }); }
    if (/-- contato:lead/.test(s)) {
      if (leadErro) return Promise.reject(leadErro);
      visto.leads.push(params);
      return Promise.resolve({ rows: [{ id: 'dddddddd-0000-4000-8000-000000000001', created_at: '2026-10-14T12:00:02.000Z' }] });
    }
    if (/-- contatos:lista-empresas/.test(s)) {
      visto.consultas.push(params);
      return listaErro ? Promise.reject(listaErro) : Promise.resolve({ rows: listaEmpresas });
    }
    if (/-- contatos:lista-leads/.test(s)) return listaErro ? Promise.reject(listaErro) : Promise.resolve({ rows: listaLeads });
    return Promise.resolve({ rows: [] });
  });
  return visto;
}

const valido = { company_id: CID, canal: 'whatsapp', resultado: 'respondeu', body: 'Mandou o catálogo e pediu preço' };
const post = (body, auth = staff) => request(buildApp()).post('/admin/painel/contatos').set(auth).send(body);

describe('POST /admin/painel/contatos — empresa', () => {
  test('grava em company_admin_notes e devolve 201 { id, created_at }', async () => {
    const visto = mockBanco();
    const res = await post({ ...valido, proximo_passo: 'Ligar de novo', proximo_passo_em: '2026-10-17', prorrogou_dias: 7, marcador: 'importacao_assistida_pedida' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 42, created_at: '2026-10-14T12:00:01.000Z' });
    expect(visto.notas).toHaveLength(1);
    expect(visto.notas[0].sql).toContain('INSERT INTO company_admin_notes');
    // company_id, autor (do token), frase, canal, resultado, próximo passo, data, motivo, prorrogou, marcador
    expect(visto.notas[0].params).toEqual([
      CID, USER, 'Mandou o catálogo e pediu preço', 'whatsapp', 'respondeu',
      'Ligar de novo', '2026-10-17', null, 7, 'importacao_assistida_pedida',
    ]);
  });

  test('só o obrigatório: o resto grava NULL', async () => {
    const visto = mockBanco();
    const res = await post(valido);
    expect(res.status).toBe(201);
    expect(visto.notas[0].params.slice(5)).toEqual([null, null, null, null, null]);
  });

  test('os 6 resultados e os 4 canais valem', async () => {
    mockBanco();
    for (const resultado of ['respondeu', 'sem_resposta', 'pediu_tempo', 'combinou_ligacao', 'quer_assinar']) {
      expect((await post({ ...valido, resultado })).status).toBe(201);
    }
    expect((await post({ ...valido, resultado: 'nao_quer', motivo: 'preco_plano' })).status).toBe(201);
    for (const canal of ['whatsapp', 'ligacao', 'email', 'presencial']) {
      expect((await post({ ...valido, canal })).status).toBe(201);
    }
  });

  test('nao_quer sem motivo → 400; com motivo grava', async () => {
    const visto = mockBanco();
    const sem = await post({ ...valido, resultado: 'nao_quer' });
    expect(sem.status).toBe(400);
    expect(sem.body.error).toMatch(/motivo/);
    expect(visto.notas).toHaveLength(0);

    const com = await post({ ...valido, resultado: 'nao_quer', motivo: 'estoque_na_entrada' });
    expect(com.status).toBe(201);
    expect(visto.notas[0].params[7]).toBe('estoque_na_entrada');
  });

  test('motivo vale também em outros resultados (elogio)', async () => {
    const visto = mockBanco();
    expect((await post({ ...valido, motivo: 'elogio' })).status).toBe(201);
    expect(visto.notas[0].params[7]).toBe('elogio');
  });

  test.each([
    ['sem company_id nem lead_id', { canal: 'whatsapp', resultado: 'respondeu', body: 'x' }],
    ['company_id e lead_id juntos', { ...valido, lead_id: LID }],
    ['company_id fora do formato', { ...valido, company_id: 'abc' }],
    ['canal desconhecido', { ...valido, canal: 'telegram' }],
    ['sem canal', { company_id: CID, resultado: 'respondeu', body: 'x' }],
    ['resultado desconhecido', { ...valido, resultado: 'talvez' }],
    ['sem frase', { ...valido, body: '   ' }],
    ['frase longa demais', { ...valido, body: 'x'.repeat(501) }],
    ['motivo desconhecido', { ...valido, motivo: 'chato' }],
    ['marcador desconhecido', { ...valido, marcador: 'importacao' }],
    ['data inválida', { ...valido, proximo_passo_em: '2026-02-31' }],
    ['data em outro formato', { ...valido, proximo_passo_em: '17/10/2026' }],
    ['próximo passo longo', { ...valido, proximo_passo: 'x'.repeat(121) }],
    ['prorrogou_dias zero', { ...valido, prorrogou_dias: 0 }],
    ['prorrogou_dias texto', { ...valido, prorrogou_dias: '7' }],
    ['checkin não é objeto', { ...valido, checkin: 'indicacao' }],
    ['checkin com chave do cliente', { ...valido, checkin: { comeco: 'vender' } }],
    ['checkin como_chegou fora da lista', { ...valido, checkin: { como_chegou: 'tv' } }],
    ['checkin texto longo', { ...valido, checkin: { fiado: 'x'.repeat(41) } }],
  ])('inválido (%s) → 400 e nada gravado', async (_n, body) => {
    const visto = mockBanco();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONTATO_INVALID');
    expect(visto.notas).toHaveLength(0);
    expect(visto.leads).toHaveLength(0);
  });

  test('empresa que não existe → 404', async () => {
    const visto = mockBanco({ empresa: false });
    const res = await post(valido);
    expect(res.status).toBe(404);
    expect(visto.notas).toHaveLength(0);
  });

  test('cliente comum → 403, sem token → 401, nada consultado', async () => {
    mockBanco();
    expect((await post(valido, cliente)).status).toBe(403);
    expect((await request(buildApp()).post('/admin/painel/contatos').send(valido)).status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('migration 383 pendente (42703) → 503 MIGRATION_PENDING', async () => {
    mockBanco({ notaErro: pend() });
    const res = await post(valido);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_PENDING');
  });
});

describe('POST /admin/painel/contatos — check-in da equipe', () => {
  const comCheckin = { ...valido, checkin: { como_chegou: 'indicacao', fiado: 'sim', quem_decide: 'dono' } };

  test('nota e check-in no mesmo statement; resposta avisa que o check-in foi gravado', async () => {
    const visto = mockBanco();
    const res = await post(comCheckin);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 41, created_at: '2026-10-14T12:00:00.000Z', checkin_gravado: true });
    const n = visto.notas[0];
    expect(n.comCheckin).toBe(true);
    expect(n.sql).toContain('UPDATE companies');
    expect(n.sql).toContain('INSERT INTO company_admin_notes');
    expect(JSON.parse(n.params[10])).toEqual({ como_chegou: 'indicacao', fiado: 'sim', quem_decide: 'dono' });
    // como_chegou é uma vez por conta: o SQL não troca um valor já gravado
    expect(n.sql).toContain("? 'como_chegou'");
    expect(n.sql).toContain("- 'como_chegou'");
  });

  test('só as chaves que vieram; vazio e null são ignorados', async () => {
    const visto = mockBanco();
    await post({ ...valido, checkin: { fiado: ' não ', quem_decide: '', como_chegou: null } });
    expect(JSON.parse(visto.notas[0].params[10])).toEqual({ fiado: 'não' });
  });

  test('checkin vazio vira contato sem check-in (statement simples)', async () => {
    const visto = mockBanco();
    const res = await post({ ...valido, checkin: {} });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 42, created_at: '2026-10-14T12:00:01.000Z' });
    expect(visto.notas[0].comCheckin).toBe(false);
  });

  test('companies.checkin (384) ainda não existe: o contato entra sem ele', async () => {
    const visto = mockBanco({ checkinErro: pend() });
    const res = await post(comCheckin);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 42, created_at: '2026-10-14T12:00:01.000Z', checkin_gravado: false });
    expect(visto.notas).toHaveLength(1);
    expect(visto.notas[0].comCheckin).toBe(false);
  });
});

describe('POST /admin/painel/contatos — lead sem conta', () => {
  const doLead = { lead_id: LID, canal: 'presencial', resultado: 'combinou_ligacao', body: 'Passei na loja, combinamos ligar quinta', proximo_passo: 'Ligar', proximo_passo_em: '2026-10-16' };

  test('grava em lead_interactions: presencial vira visita, autor do token e o resto em payload', async () => {
    const visto = mockBanco();
    const res = await post(doLead);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'dddddddd-0000-4000-8000-000000000001', created_at: '2026-10-14T12:00:02.000Z' });
    expect(visto.notas).toHaveLength(0);
    const [lid, autorId, autorNome, frase, canal, payload] = visto.leads[0];
    expect([lid, autorId, autorNome, frase, canal]).toEqual([
      LID, USER, 'Caio Pantoja', 'Passei na loja, combinamos ligar quinta', 'visita',
    ]);
    expect(JSON.parse(payload)).toEqual({
      canal: 'presencial', resultado: 'combinou_ligacao', proximo_passo: 'Ligar', proximo_passo_em: '2026-10-16',
      motivo: null, marcador: null, prorrogou_dias: null, checkin: null,
    });
  });

  test('o próximo passo com data vira o follow-up do lead; sem data, não mexe', async () => {
    const visto = mockBanco();
    await post(doLead);
    expect(visto.followups).toEqual([[LID, '2026-10-16']]);

    const v2 = mockBanco();
    await post({ ...doLead, proximo_passo_em: undefined });
    expect(v2.followups).toHaveLength(0);
  });

  test('check-in do lead sem conta fica no payload', async () => {
    const visto = mockBanco();
    await post({ ...doLead, checkin: { como_chegou: 'prospeccao_caio', fiado: 'sim' } });
    expect(JSON.parse(visto.leads[0][5]).checkin).toEqual({ como_chegou: 'prospeccao_caio', fiado: 'sim' });
  });

  test('lead que não existe → 404; payload ausente (383 pendente) → 503', async () => {
    mockBanco({ lead: false });
    expect((await post(doLead)).status).toBe(404);
    mockBanco({ leadErro: pend() });
    const res = await post(doLead);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_PENDING');
  });
});

describe('GET /admin/painel/contatos?desde=', () => {
  const linhaEmpresa = (extra) => ({
    id: 7, company_id: CID, nome: 'Loja Aurora', created_at: '2026-10-13T15:00:00.000Z',
    body: 'Pediu um tempo', canal: 'whatsapp', resultado: 'pediu_tempo', proximo_passo: 'Ligar',
    proximo_passo_em: '2026-10-16', motivo: null, prorrogou_dias: null, marcador: null, autor: 'Caio', ...extra,
  });
  const linhaLead = {
    id: 'dddddddd-0000-4000-8000-000000000001', lead_id: LID, nome: 'Marina Prado', created_at: '2026-10-14T09:00:00.000Z',
    body: 'Visita na loja', channel: 'visita', autor: 'Caio',
    payload: { canal: 'presencial', resultado: 'quer_assinar', proximo_passo: null, proximo_passo_em: null, motivo: null, marcador: null, prorrogou_dias: null, checkin: { como_chegou: 'prospeccao_caio' } },
  };

  test('junta empresas e leads, do mais recente ao mais antigo', async () => {
    const visto = mockBanco({ listaEmpresas: [linhaEmpresa({}), linhaEmpresa({ id: 3, created_at: '2026-10-12T10:00:00.000Z', resultado: 'nao_quer', motivo: 'preco_plano' })], listaLeads: [linhaLead] });
    const res = await request(buildApp()).get('/admin/painel/contatos?desde=2026-10-10').set(staff);
    expect(res.status).toBe(200);
    expect(res.body.desde).toBe('2026-10-10');
    expect(res.body.total).toBe(3);
    expect(res.body.contatos.map((c) => [c.origem, c.nome, c.resultado, c.motivo])).toEqual([
      ['lead', 'Marina Prado', 'quer_assinar', null],
      ['empresa', 'Loja Aurora', 'pediu_tempo', null],
      ['empresa', 'Loja Aurora', 'nao_quer', 'preco_plano'],
    ]);
    expect(res.body.contatos[0]).toMatchObject({ company_id: null, lead_id: LID, canal: 'presencial', checkin: { como_chegou: 'prospeccao_caio' } });
    expect(res.body.contatos[1]).toMatchObject({ company_id: CID, lead_id: null, proximo_passo: 'Ligar', proximo_passo_em: '2026-10-16', autor: 'Caio' });
    // a data entra como parâmetro (dia de Brasília), nunca concatenada
    expect(visto.consultas[0][0]).toBe('2026-10-10');
  });

  test('sem desde: últimos 7 dias', async () => {
    const visto = mockBanco();
    jest.useFakeTimers({ now: new Date('2026-10-14T12:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    try {
      const res = await request(buildApp()).get('/admin/painel/contatos').set(staff);
      expect(res.status).toBe(200);
      expect(res.body.desde).toBe('2026-10-07');
      expect(visto.consultas[0][0]).toBe('2026-10-07');
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([['ontem'], ['2026-13-01'], ['10/10/2026']])('desde inválido (%s) → 400', async (desde) => {
    mockBanco();
    const res = await request(buildApp()).get('/admin/painel/contatos').query({ desde }).set(staff);
    expect(res.status).toBe(400);
  });

  test('migration 383 pendente: lista vazia e aviso, sem derrubar', async () => {
    mockBanco({ listaErro: pend() });
    const res = await request(buildApp()).get('/admin/painel/contatos?desde=2026-10-10').set(staff);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, contatos: [], migration_pendente: true });
  });

  test('cliente comum → 403', async () => {
    mockBanco();
    expect((await request(buildApp()).get('/admin/painel/contatos').set(cliente)).status).toBe(403);
  });
});
