// ============================================================
// AURA. -- Testes: OS de otica (kind='otica') em /service-orders
//
// O que estes testes travam:
//   1. /lab: transicoes validas carimbam lab_sent_at/lab_received_at e
//      promovem 'aberta' -> 'em_execucao' quando a lente sai
//   2. /lab: transicao invalida -> 409 TRANSICAO_LAB_INVALIDA c/ permitidas
//   3. /lab: refacao exige motivo e incrementa lab_redo_count
//   4. /lab: OS pronta/entregue/cancelada -> 409 OS_FECHADA
//   5. /status pronta exige lente recebida (LENTES_NAO_RECEBIDAS)
//   6. /notify-ready nunca 500: fila pulou -> queued:false + wa_link
//   7. gate por kind: OS de otica usa otica_enabled, nao os_enabled
//   8. POST kind='otica' exige receita/lente/armacao e gera reported_issue
//
// Router ISOLADO. Mock por CONTEUDO DO SQL, nunca fila posicional.
// A fila do WhatsApp e mockada inteira: o que importa aqui e a resposta
// da rota diante do que a fila devolve, nao a fila em si.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/waOutbox', () => ({
  enqueue: jest.fn(),
  normalizePhone: (raw) => {
    const d = String(raw || '').replace(/\D+/g, '');
    if (d.length === 11) return `55${d}`;
    return d || null;
  },
}));

const waOutbox = require('../../src/services/waOutbox');
const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const osRouter = require('../../src/routes/serviceOrders');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => { jest.resetAllMocks(); osRouter._resetSchemaCache(); });

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cust = '11111111-2222-3333-4444-555555555555';
const osId = '33333333-4444-5555-6666-777777777777';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/service-orders', osRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

const OS = {
  id: osId, company_id: cid, os_number: 12, customer_id: cust,
  kind: 'otica', status: 'aberta', lab_status: 'aguardando_envio', lab_redo_count: 0,
  notes: null, tracker_token: 'a'.repeat(32),
  customer_name: 'Maria Fernanda Souza', customer_phone: '(11) 99999-0000',
  optical: { prescription: { od: {}, oe: {} }, lens: {}, frame: {}, use: 'multifocal' },
};

function mockDb({ os = OS, otica = 'true', osEnabled = 'false', settings = {} } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    // Uma query com os DOIS toggles (rotas sobre OS existente) ou uma com
    // um so (abertura), na mesma ordem em que o codigo le.
    if (/os_enabled[\s\S]*otica_enabled/i.test(s)) return Promise.resolve({ rows: [{ enabled: osEnabled, otica_enabled: otica }] });
    if (/pdv_settings->>'otica_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: otica }] });
    if (/pdv_settings->>'os_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: osEnabled }] });
    if (/SELECT otica_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ otica_settings: settings }] });
    if (/COALESCE\(trade_name, legal_name\)/i.test(s)) return Promise.resolve({ rows: [{ nome: 'Ótica Bairro' }] });
    if (/FROM service_orders so/i.test(s)) return Promise.resolve({ rows: os ? [os] : [] });
    if (/FROM service_order_items/i.test(s)) return Promise.resolve({ rows: [] });
    if (/UPDATE service_orders/i.test(s)) return Promise.resolve({ rows: [{ id: osId }] });
    if (/SELECT id FROM customers/i.test(s)) return Promise.resolve({ rows: [{ id: cust }] });
    return Promise.resolve({ rows: [] });
  });
}

const callsMatching = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const updateOs = () => callsMatching(/UPDATE service_orders SET/i)[0];

const lab = (body) => request(app).post(`/api/v1/companies/${cid}/service-orders/${osId}/lab`).set(adminAuth).send(body);
const status = (body) => request(app).post(`/api/v1/companies/${cid}/service-orders/${osId}/status`).set(adminAuth).send(body);

describe('POST /service-orders/:osId/lab -- maquina do laboratorio', () => {
  test('aguardando_envio -> no_laboratorio carimba lab_sent_at e promove pra em_execucao', async () => {
    mockDb();
    const res = await lab({ lab_status: 'no_laboratorio', lab_order_ref: 'LAB-778' });
    expect(res.status).toBe(200);

    const [sql, params] = updateOs();
    expect(sql).toMatch(/lab_sent_at = NOW\(\)/);
    expect(sql).toMatch(/status = 'em_execucao'/);
    expect(params).toContain('no_laboratorio');
    expect(params).toContain('LAB-778');
  });

  test('no_laboratorio -> recebida carimba lab_received_at e NAO mexe no status', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'no_laboratorio' } });
    const res = await lab({ lab_status: 'recebida' });
    expect(res.status).toBe(200);
    const [sql] = updateOs();
    expect(sql).toMatch(/lab_received_at = NOW\(\)/);
    expect(sql).not.toMatch(/status = 'em_execucao'/);
  });

  test('transicao invalida -> 409 TRANSICAO_LAB_INVALIDA com permitidas', async () => {
    mockDb();
    const res = await lab({ lab_status: 'em_montagem' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSICAO_LAB_INVALIDA');
    expect(res.body.permitidas).toEqual(['no_laboratorio']);
    expect(callsMatching(/UPDATE service_orders/i)).toHaveLength(0);
  });

  test('refacao sem motivo -> 400', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'recebida' } });
    const res = await lab({ lab_status: 'refacao' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MOTIVO_OBRIGATORIO');
  });

  test('refacao incrementa lab_redo_count e carimba o motivo nas notas', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'em_montagem', lab_redo_count: 1 } });
    const res = await lab({ lab_status: 'refacao', note: 'eixo errado' });
    expect(res.status).toBe(200);

    const [sql, params] = updateOs();
    expect(sql).toMatch(/lab_redo_count = COALESCE\(lab_redo_count, 0\) \+ 1/);
    expect(sql).toMatch(/notes = CASE/);
    const carimbo = params.find((p) => /^\[Refação #2 \d{2}\/\d{2}\] eixo errado$/.test(String(p)));
    expect(carimbo).toBeDefined();
  });

  test('refacao -> no_laboratorio limpa lab_received_at', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'refacao' } });
    const res = await lab({ lab_status: 'no_laboratorio' });
    expect(res.status).toBe(200);
    const [sql] = updateOs();
    expect(sql).toMatch(/lab_received_at = NULL/);
    expect(sql).toMatch(/lab_sent_at = NOW\(\)/);
  });

  test('OS pronta -> 409 OS_FECHADA', async () => {
    mockDb({ os: { ...OS, status: 'pronta', lab_status: 'em_montagem' } });
    const res = await lab({ lab_status: 'refacao', note: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OS_FECHADA');
  });

  test('OS de reparo -> 400 OS_NAO_E_OTICA', async () => {
    mockDb({ os: { ...OS, kind: 'reparo', lab_status: null } });
    const res = await lab({ lab_status: 'no_laboratorio' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OS_NAO_E_OTICA');
  });

  test('lab_status desconhecido -> 400', async () => {
    mockDb();
    const res = await lab({ lab_status: 'perdida' });
    expect(res.status).toBe(400);
  });
});

describe('POST /service-orders/:osId/status -- pronta exige lente recebida', () => {
  test('em_execucao -> pronta com lente no laboratorio -> 409 LENTES_NAO_RECEBIDAS', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'no_laboratorio' } });
    const res = await status({ status: 'pronta' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LENTES_NAO_RECEBIDAS');
    expect(callsMatching(/UPDATE service_orders/i)).toHaveLength(0);
  });

  test('em_execucao -> pronta com lente em montagem passa e nao dispara aviso sem wa_ready_auto', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'em_montagem' } });
    const res = await status({ status: 'pronta' });
    expect(res.status).toBe(200);
    expect(updateOs()[1]).toContain('pronta');
    expect(waOutbox.enqueue).not.toHaveBeenCalled();
  });

  test('wa_ready_auto ligado enfileira otica_pronta e a transicao sobrevive a fila pulando', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'recebida' }, settings: { wa_ready_auto: true } });
    waOutbox.enqueue.mockResolvedValue({ queued: false, reason: 'TEMPLATE_NAO_APROVADO' });
    const res = await status({ status: 'pronta' });
    expect(res.status).toBe(200);
    expect(waOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(waOutbox.enqueue.mock.calls[0][0]).toMatchObject({
      templateName: 'otica_pronta', sourceType: 'otica_pronta', dedupeKey: `otica_pronta:${osId}`,
    });
  });

  test('OS de reparo continua sem a regra do laboratorio', async () => {
    mockDb({ os: { ...OS, kind: 'reparo', status: 'em_execucao', lab_status: null }, osEnabled: 'true' });
    const res = await status({ status: 'pronta' });
    expect(res.status).toBe(200);
  });
});

describe('POST /service-orders/:osId/notify-ready', () => {
  const notify = () => request(app).post(`/api/v1/companies/${cid}/service-orders/${osId}/notify-ready`).set(adminAuth).send({});

  test('fila pulou -> 200 queued:false com skip_reason, track_url e wa.me sem dado de receita', async () => {
    process.env.APP_PUBLIC_URL = 'https://app.getaura.com.br';
    mockDb({ os: { ...OS, status: 'pronta', lab_status: 'em_montagem' } });
    waOutbox.enqueue.mockResolvedValue({ queued: false, status: 'skipped', reason: 'TEMPLATE_NAO_APROVADO' });

    const res = await notify();
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(res.body.skip_reason).toBe('TEMPLATE_NAO_APROVADO');
    expect(res.body.track_url).toBe(`https://app.getaura.com.br/acompanhar/${'a'.repeat(32)}`);
    expect(res.body.wa_link).toMatch(/^https:\/\/wa\.me\/5511999990000\?text=/);
    const texto = decodeURIComponent(res.body.wa_link.split('text=')[1]);
    expect(texto).toContain('Maria');
    expect(texto).not.toContain('Fernanda');
    expect(texto).not.toMatch(/multifocal|esf|cil|eixo|dioptria/i);
    // nao marca ready_notified_at quando nao enfileirou
    expect(callsMatching(/ready_notified_at = NOW\(\)/i)).toHaveLength(0);
  });

  test('fila aceitou -> queued:true e ready_notified_at carimbado', async () => {
    mockDb({ os: { ...OS, status: 'pronta', lab_status: 'recebida' } });
    waOutbox.enqueue.mockResolvedValue({ queued: true, id: 'wa-1', status: 'pending', reason: null });

    const res = await notify();
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(res.body.skip_reason).toBeNull();
    expect(callsMatching(/ready_notified_at = NOW\(\)/i)).toHaveLength(1);
    // parametros do template: primeiro nome, loja, link — nunca a receita
    const comp = waOutbox.enqueue.mock.calls[0][0].components[0].parameters.map((p) => p.text);
    expect(comp[0]).toBe('Maria');
    expect(comp[1]).toBe('Ótica Bairro');
    expect(comp.join(' ')).not.toMatch(/multifocal/);
  });

  test('fila explodiu -> 200 queued:false ERRO_FILA (nunca 500)', async () => {
    mockDb({ os: { ...OS, status: 'pronta', lab_status: 'recebida' } });
    waOutbox.enqueue.mockRejectedValue(new Error('meta caiu'));
    const res = await notify();
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(res.body.skip_reason).toBe('ERRO_FILA');
  });

  test('OS ainda nao pronta -> 409 OS_NAO_PRONTA', async () => {
    mockDb({ os: { ...OS, status: 'em_execucao', lab_status: 'recebida' } });
    const res = await notify();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OS_NAO_PRONTA');
    expect(waOutbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('gate por kind', () => {
  test('OS de otica com otica desligada -> 403 OTICA_DISABLED, mesmo com os_enabled', async () => {
    mockDb({ otica: 'false', osEnabled: 'true' });
    const res = await lab({ lab_status: 'no_laboratorio' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OTICA_DISABLED');
  });

  test('PATCH em OS de otica usa o gate da otica (os_enabled=false nao barra)', async () => {
    mockDb({ otica: 'true', osEnabled: 'false' });
    const res = await request(app).patch(`/api/v1/companies/${cid}/service-orders/${osId}`).set(adminAuth).send({ lab_order_ref: 'X-1' });
    expect(res.status).toBe(200);
    expect(updateOs()[1]).toContain('X-1');
  });

  test('OS de reparo com os_enabled=false -> 403 OS_DISABLED, mesmo com a otica ligada', async () => {
    mockDb({ os: { ...OS, kind: 'reparo', lab_status: null }, otica: 'true', osEnabled: 'false' });
    const res = await request(app).patch(`/api/v1/companies/${cid}/service-orders/${osId}`).set(adminAuth).send({ notes: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OS_DISABLED');
  });
});

describe('POST /service-orders kind=otica -- abertura', () => {
  const post = (body) => request(app).post(`/api/v1/companies/${cid}/service-orders`).set(adminAuth).send(body);
  const OPTICAL = {
    prescription: { od: { sph: -1.75 }, oe: { sph: -1.5 }, prescriber_type: 'medico' },
    frame: { source: 'estoque', description: 'RB5154' },
    lens: { type: 'surfacada', brand: 'Essilor' },
    use: 'multifocal',
  };

  function mockInsert() {
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (/INSERT INTO service_orders/i.test(String(sql))) return Promise.resolve({ rows: [{ id: osId }] });
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(client);
    return client;
  }

  test('sem receita -> 400 RECEITA_OBRIGATORIA', async () => {
    mockDb();
    const res = await post({ kind: 'otica', customer_id: cust, optical: { lens: {}, frame: {} } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RECEITA_OBRIGATORIA');
  });

  test('sem lente -> 400 LENTE_OBRIGATORIA', async () => {
    mockDb();
    const res = await post({ kind: 'otica', customer_id: cust, optical: { ...OPTICAL, lens: undefined } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LENTE_OBRIGATORIA');
  });

  test('201: reported_issue gerado, lab_status aguardando_envio, garantia de adaptacao da loja', async () => {
    mockDb({ settings: { adaptation_warranty_days: 60 } });
    const client = mockInsert();
    const res = await post({ kind: 'otica', customer_id: cust, optical: OPTICAL });
    expect(res.status).toBe(201);

    const [sql, params] = client.query.mock.calls.find((c) => /INSERT INTO service_orders/i.test(String(c[0])));
    expect(sql).toMatch(/'otica'/);
    expect(sql).toMatch(/'aguardando_envio'/);
    expect(params).toContain('Óculos de grau — multifocal');
    const snapshot = JSON.parse(params.find((p) => typeof p === 'string' && p.startsWith('{"prescription"')));
    expect(snapshot.adaptation_warranty_days).toBe(60);
    expect(snapshot.prescription_id).toBeNull();
  });

  test('otica desligada -> 403 mesmo com os_enabled', async () => {
    mockDb({ otica: 'false', osEnabled: 'true' });
    const res = await post({ kind: 'otica', customer_id: cust, optical: OPTICAL });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OTICA_DISABLED');
  });
});
