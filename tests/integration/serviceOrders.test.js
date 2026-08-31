// ============================================================================
// AURA. — Testes de integração: Ordem de Serviço (migration 313)
//
// db.query é mockado globalmente em tests/jest.setup.js e os testes encadeiam
// mockResolvedValueOnce NA ORDEM em que a rota consulta. A primeira query de
// toda request é o role check do requireCompanyAccess.
//
// O que estes testes seguram, em ordem de importância:
//   1. O gate os_enabled vale na ESCRITA e NÃO na leitura.
//   2. A máquina de status recusa transição inválida.
//   3. 'entregue' NÃO exige venda (existe entrega em garantia).
//   4. Orçamento aprovado não é reescrito por baixo do "sim" do cliente.
//   5. Nada atravessa a fronteira do tenant (cliente/técnico/venda de outra
//      empresa).
// ============================================================================

const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const osId   = '00000000-0000-0000-0000-0000000000a1';
const custId = '00000000-0000-0000-0000-0000000000c1';
const saleId = '00000000-0000-0000-0000-0000000000e1';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };

const base = `/api/v1/companies/${cid}/service-orders`;

function osRow(over = {}) {
  return {
    id: osId,
    company_id: cid,
    os_number: 42,
    status: 'aberta',
    customer_id: custId,
    customer_name: 'Marina Alves',
    customer_phone: '(12) 98888-1234',
    reported_issue: 'Não liga.',
    warranty_days: 90,
    estimated_amount: '480.00',
    approved_at: null,
    sale_id: null,
    created_at: '2026-08-25T09:15:00Z',
    ...over,
  };
}

// Atalhos pros dois primeiros degraus de toda request de escrita.
function comAcesso(osEnabled = true) {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });               // requireCompanyAccess
  db.query.mockResolvedValueOnce({ rows: [{ enabled: String(osEnabled) }] });  // assertOsEnabled
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

// ────────────────────────────────────────────────────────────
describe('gate os_enabled', () => {
  test('GET da listagem funciona mesmo com o toggle DESLIGADO', async () => {
    // Decisão de projeto: se a loja desliga a OS depois de ter aparelhos no
    // balcão, bloquear a leitura esconderia dela o que precisa devolver.
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [osRow()] });

    const res = await request(app).get(base).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
  });

  test('POST é bloqueado com 403 quando o toggle está desligado', async () => {
    comAcesso(false);
    const res = await request(app).post(base).set(auth)
      .send({ customer_id: custId, reported_issue: 'Não liga.' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OS_DISABLED');
  });

  test('o toggle é lido do BANCO, não do JWT', async () => {
    // O JWT carrega plano/módulos de quando foi emitido e nunca revalida:
    // uma loja que acabou de ativar a OS ficaria sem o módulo até deslogar.
    comAcesso(true);
    db.query.mockResolvedValueOnce({ rows: [] }); // cliente não encontrado

    await request(app).post(base).set(auth)
      .send({ customer_id: custId, reported_issue: 'Não liga.' });

    const sqls = db.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("pdv_settings->>'os_enabled'"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
describe('POST /service-orders — abertura', () => {
  test('exige customer_id: sem cliente não há pra quem devolver o aparelho', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const res = await request(app).post(base).set(auth).send({ reported_issue: 'Não liga.' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer_id/);
  });

  test('exige reported_issue', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const res = await request(app).post(base).set(auth).send({ customer_id: custId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reported_issue/);
  });

  test('recusa cliente de OUTRA empresa', async () => {
    // A FK só olha customers.id — sem este SELECT a OS nasceria apontando
    // pra fora do tenant.
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(base).set(auth)
      .send({ customer_id: custId, reported_issue: 'Não liga.' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Cliente/);
  });

  test('recusa técnico de OUTRA empresa', async () => {
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [{ id: custId }] }); // cliente ok
    db.query.mockResolvedValueOnce({ rows: [] });               // técnico não

    const res = await request(app).post(base).set(auth)
      .send({ customer_id: custId, reported_issue: 'Não liga.', technician_id: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/T.cnico/);
  });

  test('rejeita item sem descrição antes de tocar no banco', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const res = await request(app).post(base).set(auth).send({
      customer_id: custId, reported_issue: 'Não liga.',
      items: [{ description: '  ', quantity: 1, unit_price: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/);
  });

  test('abre a OS em status aberta e soma o orçamento dos itens', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [osRow()] }), release: jest.fn() };
    db.connect.mockReturnValue(client);

    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [{ id: custId }] });  // cliente ok
    db.query.mockResolvedValueOnce({ rows: [osRow()] });         // carregarOs
    db.query.mockResolvedValueOnce({ rows: [] });                // carregarItens

    const res = await request(app).post(base).set(auth).send({
      customer_id: custId, reported_issue: 'Não liga.',
      items: [
        { description: 'Reparo', quantity: 2, unit_price: 100 },
        { kind: 'peca', description: 'Fonte', quantity: 1, unit_price: 280 },
      ],
    });

    expect(res.status).toBe(201);
    const insert = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO service_orders'));
    expect(insert).toBeTruthy();
    expect(String(insert[0])).toContain("'aberta'");
    // 2×100 + 1×280 = 480 — estimated_amount é o penúltimo parâmetro.
    expect(insert[1]).toContain('480.00');
    expect(client.query.mock.calls.some((c) => String(c[0]) === 'COMMIT')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
describe('POST /service-orders/:osId/status — máquina de estados', () => {
  test('recusa transição inválida com 409 e diz quais são permitidas', async () => {
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'aberta' })] });

    const res = await request(app).post(`${base}/${osId}/status`).set(auth)
      .send({ status: 'entregue' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSICAO_INVALIDA');
    expect(res.body.permitidas).toEqual(['em_execucao', 'cancelada']);
  });

  test('status inválido não chega no banco', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const res = await request(app).post(`${base}/${osId}/status`).set(auth)
      .send({ status: 'inventado' });
    expect(res.status).toBe(400);
  });

  test('entregar NÃO exige venda — existe entrega em garantia', async () => {
    // Se 'entregue' exigisse sale_id, retrabalho e cortesia ficariam presos
    // em 'pronta' pra sempre. Por isso status é campo próprio e não
    // "tem venda => entregue".
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'pronta' })] }); // carregarOs
    db.query.mockResolvedValueOnce({ rows: [] });                            // UPDATE
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'entregue' })] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`${base}/${osId}/status`).set(auth)
      .send({ status: 'entregue' });

    expect(res.status).toBe(200);
    const upd = db.query.mock.calls.find((c) => String(c[0]).includes('UPDATE service_orders SET status'));
    expect(String(upd[0])).toContain('delivered_at = NOW()');
  });

  test('venda de outra empresa é recusada na entrega', async () => {
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'pronta' })] });
    db.query.mockResolvedValueOnce({ rows: [] }); // venda não é desta empresa

    const res = await request(app).post(`${base}/${osId}/status`).set(auth)
      .send({ status: 'entregue', sale_id: saleId });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Venda/);
  });

  test('retrabalho (pronta -> em_execucao) limpa a entrega anterior', async () => {
    // Senão a OS ficaria "em execução" carimbada como entregue no passado, e
    // o relatório de prazo mentiria.
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'pronta', delivered_at: '2026-08-30T10:00:00Z' })] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'em_execucao' })] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`${base}/${osId}/status`).set(auth)
      .send({ status: 'em_execucao' });

    expect(res.status).toBe(200);
    const upd = db.query.mock.calls.find((c) => String(c[0]).includes('UPDATE service_orders SET status'));
    expect(String(upd[0])).toContain('delivered_at = NULL');
  });

  test('repetir o mesmo status é no-op, não erro', async () => {
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'pronta' })] });
    db.query.mockResolvedValueOnce({ rows: [] }); // carregarItens

    const res = await request(app).post(`${base}/${osId}/status`).set(auth)
      .send({ status: 'pronta' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls.some((c) => String(c[0]).includes('UPDATE service_orders SET status'))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
describe('PUT /service-orders/:osId/items — orçamento', () => {
  test('orçamento aprovado não pode ser alterado sem nova aprovação', async () => {
    // Trocar o preço por baixo de um "sim" que já foi dado.
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ approved_at: '2026-08-26T14:00:00Z' })] });

    const res = await request(app).put(`${base}/${osId}/items`).set(auth)
      .send({ items: [{ description: 'Outro serviço', quantity: 1, unit_price: 900 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORCAMENTO_APROVADO');
  });

  test('OS entregue não aceita mais edição de itens', async () => {
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'entregue' })] });

    const res = await request(app).put(`${base}/${osId}/items`).set(auth)
      .send({ items: [{ description: 'X', quantity: 1, unit_price: 10 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OS_FECHADA');
  });
});

// ────────────────────────────────────────────────────────────
describe('DELETE /service-orders/:osId', () => {
  test('OS em execução não é excluída — cancela, não apaga', async () => {
    // A OS é o histórico do que aconteceu com um bem de terceiro.
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'em_execucao' })] });

    const res = await request(app).delete(`${base}/${osId}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OS_NAO_EXCLUIVEL');
  });

  test('OS aberta e sem venda pode ser excluída', async () => {
    comAcesso();
    db.query.mockResolvedValueOnce({ rows: [osRow({ status: 'aberta', sale_id: null })] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete(`${base}/${osId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
describe('GET /print/os/:osId — documento A4', () => {
  const printUrl = `/api/v1/companies/${cid}/print/os/${osId}`;

  test('devolve HTML com a marca do cliente e Aura só no rodapé', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [osRow()] });     // OS
    db.query.mockResolvedValueOnce({ rows: [] });            // itens
    db.query.mockResolvedValueOnce({ rows: [{              // company
      trade_name: 'Davi Assistência Técnica', legal_name: 'Davi Ltda',
      cnpj: '47123119000204', logo_url: 'https://r2.exemplo/logo.png',
    }] });
    db.query.mockResolvedValueOnce({ rows: [{ logo_url: null, primary_color: '#7c3aed', whatsapp: null }] });

    const res = await request(app).get(printUrl).set(auth);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Davi Assistência Técnica');
    expect(res.text).toContain('https://r2.exemplo/logo.png');
    expect(res.text).toContain('gerado por Aura');
    expect(res.text).toContain('@page{size:A4');
  });

  test('404 quando a OS não é desta empresa', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(printUrl).set(auth);
    expect(res.status).toBe(404);
  });

  test('o documento sai mesmo com o toggle desligado (segunda via)', async () => {
    // A OS já foi impressa e entregue ao cliente; ele volta pedindo segunda
    // via. Nenhuma query de os_enabled deve aparecer.
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [osRow()] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ trade_name: 'Davi' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(printUrl).set(auth);
    expect(res.status).toBe(200);
    const sqls = db.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("os_enabled"))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
describe('toggle em Configurações > PDV', () => {
  const settingsUrl = `/api/v1/companies/${cid}/pdv-settings`;

  test('os_enabled vem false por padrão pra quem nunca configurou', async () => {
    // O GET faz {...DEFAULT_SETTINGS, ...saved}: empresa antiga não precisa de
    // migration pra ganhar a chave nova.
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ pdv_settings: { require_seller: true } }] });

    const res = await request(app).get(settingsUrl).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.os_enabled).toBe(false);
    expect(res.body.settings.require_seller).toBe(true); // não atropela o que já existia
  });

  test('ligar a OS não apaga os outros toggles', async () => {
    // O PUT é merge sobre o salvo, não replace.
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ pdv_settings: { caixa_enabled: true, label_offset_mm: -2 } }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).put(settingsUrl).set(auth).send({ settings: { os_enabled: true } });

    expect(res.status).toBe(200);
    expect(res.body.settings.os_enabled).toBe(true);
    expect(res.body.settings.caixa_enabled).toBe(true);
    expect(res.body.settings.label_offset_mm).toBe(-2);
  });

  test('os_enabled só aceita boolean', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ pdv_settings: {} }] });

    const res = await request(app).put(settingsUrl).set(auth).send({ settings: { os_enabled: 'sim' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/os_enabled/);
  });
});

// ────────────────────────────────────────────────────────────
describe('deploy parcial (migration 313 ainda não aplicada)', () => {
  test('a listagem devolve lista vazia em vez de 500', async () => {
    // Armadilha #1 do CLAUDE.md: o backend sobe antes da migration.
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const err = new Error('relation "service_orders" does not exist');
    err.code = '42P01';
    db.query.mockRejectedValueOnce(err);

    const res = await request(app).get(base).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  test('a impressão devolve 503 explicando, não 500 genérico', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const err = new Error('relation "service_orders" does not exist');
    err.code = '42P01';
    db.query.mockRejectedValueOnce(err);

    const res = await request(app).get(`/api/v1/companies/${cid}/print/os/${osId}`).set(auth);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Ordem de Servico/);
  });
});
