// ============================================================
// AURA. -- K3: acompanhamento publico da encomenda
//
// GET /acompanhar/:token -- SEM auth. O token e a credencial, mesmo padrao
// do link de aprovacao.
//
// Uma rota publica e a superficie mais perigosa do sistema: qualquer campo
// a mais no SELECT vira vazamento, e ninguem percebe olhando a tela. Por
// isso o teste central aqui nao e o caminho feliz -- e a lista do que NAO
// pode sair: CPF, telefone, endereco, sobrenome, custo, vendedor.
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');

let db;
let app;

const TOKEN = 'a'.repeat(32);

const VENDA = {
  id: '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
  company_id: 'comp-1',
  created_at: '2026-08-15T12:00:00Z',
  total_amount: '240.00',
  status: 'completed',
  studio_production_status: 'in_production',
  promised_date: '2026-08-22',
  customer_name: 'Maria Fernanda Souza',
  loja: 'Sheid Mania',
  itens: [{ nome: 'Camisa personalizada', qtd: 2 }],
  imagem: 'https://cdn/camisa.png',
};

function buildApp() {
  jest.resetModules();
  process.env.JWT_SECRET = 'aura-test-secret-2026';
  db = require('../../src/config/database');
  const router = require('../../src/routes/studioTrackPublic');
  const a = express();
  a.use(express.json());
  a.use('/acompanhar', router);   // sem auth, igual ao mount real
  return a;
}

function mockDb({ venda = VENDA, saldo = [], saldoFalha = null } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM credit_installments/i.test(s)) {
      if (saldoFalha) return Promise.reject(Object.assign(new Error('x'), { code: saldoFalha }));
      return Promise.resolve({ rows: saldo });
    }
    if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: venda ? [venda] : [] });
    return Promise.resolve({ rows: [] });
  });
}

const track = (tk = TOKEN) => request(app).get(`/acompanhar/${tk}`);
const saleSql = () => db.query.mock.calls.map((c) => String(c[0] || '')).find((s) => /FROM sales s/i.test(s)) || '';

beforeEach(() => { jest.resetAllMocks(); app = buildApp(); });

describe('o que o cliente vê', () => {
  test('etapas, etapa atual e dados do pedido', async () => {
    mockDb();
    const res = await track();

    expect(res.status).toBe(200);
    expect(res.body.loja).toBe('Sheid Mania');
    expect(res.body.etapas).toHaveLength(4);
    expect(res.body.etapa_atual).toBe(2);            // in_production
    expect(res.body.entrega_combinada).toBe('2026-08-22');
    expect(res.body.itens[0]).toMatchObject({ nome: 'Camisa personalizada', qtd: 2 });
  });

  // A promessa é etapa, nunca hora. Previsão furada destrói mais confiança
  // do que a ausência dela — lição da própria indústria do pizza tracker.
  test('não promete horário em lugar nenhum', async () => {
    mockDb();
    const res = await track();

    const corpo = JSON.stringify(res.body).toLowerCase();
    expect(corpo).not.toMatch(/previs|estimat|\bhora\b|minuto/);
  });

  test('venda cancelada avisa, em vez de fingir que está em produção', async () => {
    mockDb({ venda: { ...VENDA, status: 'cancelled' } });
    const res = await track();

    expect(res.status).toBe(200);
    expect(res.body.cancelado).toBe(true);
    expect(res.body.etapa_atual).toBeUndefined();
  });
});

// O teste que mais importa nesta rota.
describe('o que NÃO pode vazar', () => {
  test('só o primeiro nome do cliente', async () => {
    mockDb();
    const res = await track();

    expect(res.body.cliente).toBe('Maria');
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain('Fernanda');
    expect(corpo).not.toContain('Souza');
  });

  test('a consulta não busca dado sensível do cliente', async () => {
    mockDb();
    await track();

    const sql = saleSql();
    expect(sql).not.toMatch(/cpf|cnpj/i);
    expect(sql).not.toMatch(/cu\.phone|cu\.email|address/i);
  });

  test('a consulta não busca dado comercial da loja', async () => {
    mockDb();
    await track();

    const sql = saleSql();
    expect(sql).not.toMatch(/cost_price|unit_cost|discount|seller|employee/i);
    expect(sql).not.toMatch(/payment_method/i);
  });

  test('o corpo não devolve ids internos além do pedido', async () => {
    mockDb();
    const res = await track();

    expect(res.body.pedido).toBe('9F1C2D3E');       // curto, não o UUID
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain(VENDA.id);
    expect(corpo).not.toContain('comp-1');
  });
});

describe('saldo em aberto', () => {
  test('mostra valor, vencimento e Pix quando há saldo', async () => {
    mockDb({ saldo: [{ id: 'i1', valor: '140.00', due_date: '2026-08-24' }] });
    const res = await track();

    expect(res.body.saldo).toMatchObject({ valor: 140, vencimento: '2026-08-24' });
    expect(res.body.saldo).toHaveProperty('pix');
  });

  test('sem saldo, o campo vem nulo — nada de cobrança fantasma', async () => {
    mockDb({ saldo: [] });
    const res = await track();
    expect(res.body.saldo).toBeNull();
  });

  // Acompanhar é o serviço principal; cobrar é o acessório. Se a tabela de
  // parcelas sumir, o cliente ainda vê onde está a encomenda dele.
  test('falha ao buscar saldo não derruba o acompanhamento', async () => {
    mockDb({ saldoFalha: '42P01' });
    const res = await track();

    expect(res.status).toBe(200);
    expect(res.body.etapa_atual).toBe(2);
    expect(res.body.saldo).toBeNull();
  });
});

describe('token é a credencial', () => {
  test('token curto nem chega ao banco', async () => {
    mockDb();
    const res = await track('abc');

    expect(res.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('token válido mas inexistente dá 404, sem vazar se existe', async () => {
    mockDb({ venda: null });
    const res = await track();

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/sql|column|relation/i);
  });

  test('a busca é pelo token, escopada na coluna certa', async () => {
    mockDb();
    await track();
    expect(saleSql()).toMatch(/s\.tracker_token = \$1/);
  });
});

describe('mapa de etapas', () => {
  const { _etapaDoStatus: etapa } = require('../../src/routes/studioTrackPublic');

  test('os 6 status do board viram 4 marcos do cliente', () => {
    expect(etapa('awaiting_customization')).toBe(0);
    expect(etapa('pending_art')).toBe(1);
    // "aprovado" e "em produção" são a mesma promessa pra quem espera
    expect(etapa('approved')).toBe(2);
    expect(etapa('in_production')).toBe(2);
    expect(etapa('ready')).toBe(3);
    expect(etapa('delivered')).toBe(3);
  });

  // Venda sem fabricação (produto não-personalizável) também tem tracker:
  // ela mostra "recebido" e o saldo, que é o que existe pra acompanhar.
  test('venda sem produção fica em “recebido”, não quebra', () => {
    expect(etapa(null)).toBe(0);
    expect(etapa('qualquer_coisa')).toBe(0);
  });
});

// ── Pedido da vitrine (05/09/2026) ──────────────────────────────────────
// O token da vitrine mora em digital_orders (migration 322). A pagina e a
// mesma; o cliente nao sabe por qual porta entrou.
describe('pedido feito pela vitrine', () => {
  const PEDIDO = {
    id: '11111111-2222-3333-4444-555555555555',
    order_number: 'SM-0042',
    company_id: 'comp-1',
    created_at: '2026-09-05T12:00:00Z',
    total: '89.90',
    status: 'confirmed',
    studio_production_status: 'pending_art',
    customer_name: 'Ana Paula Ribeiro',
    loja: 'Sheid Mania',
    itens: [{ nome: 'Caneca personalizada', qtd: 1 }],
    imagem: 'https://cdn/caneca.png',
  };

  function mockVitrine({ pedido = PEDIDO, semColuna = false } = {}) {
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM digital_orders o/i.test(s)) {
        if (semColuna) return Promise.reject(Object.assign(new Error('x'), { code: '42703' }));
        return Promise.resolve({ rows: pedido ? [pedido] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('quando nao e venda do balcao, procura em digital_orders e responde no mesmo formato', async () => {
    mockVitrine();
    const res = await track();

    expect(res.status).toBe(200);
    expect(res.body.loja).toBe('Sheid Mania');
    expect(res.body.pedido).toBe('SM-0042');
    expect(res.body.cliente).toBe('Ana');
    expect(res.body.etapas).toHaveLength(4);
    expect(res.body.etapa_atual).toBe(1);            // pending_art
    expect(res.body.itens[0]).toMatchObject({ nome: 'Caneca personalizada', qtd: 1 });
    expect(res.body.total).toBe(89.9);
    expect(res.body.saldo).toBeNull();
  });

  test('pedido cancelado avisa', async () => {
    mockVitrine({ pedido: { ...PEDIDO, status: 'cancelled' } });
    const res = await track();
    expect(res.body.cancelado).toBe(true);
    expect(res.body.etapa_atual).toBeUndefined();
  });

  test('so o primeiro nome, e nada de telefone, e-mail ou endereco na consulta', async () => {
    mockVitrine();
    const res = await track();
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain('Ribeiro');
    const sql = db.query.mock.calls.map((c) => String(c[0] || '')).find((s) => /FROM digital_orders o/i.test(s)) || '';
    expect(sql).not.toMatch(/customer_phone|customer_email|customer_cpf|address_|payment_method/i);
  });

  test('antes da migration 322, token desconhecido e 404 e nao 500', async () => {
    mockVitrine({ semColuna: true });
    const res = await track();
    expect(res.status).toBe(404);
  });

  test('token que nao existe em lugar nenhum e 404', async () => {
    mockVitrine({ pedido: null });
    const res = await track();
    expect(res.status).toBe(404);
  });
});
