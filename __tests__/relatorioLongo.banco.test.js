// ============================================================
// AURA. — Relatório semanal longo no Postgres de verdade (tq-85, tq-85b)
//
// Banco do CI, tudo numa transação revertida (padrão de
// companyEmails.banco.test.js: o db mockado do jest.setup vai para a
// conexão desta transação). Cobre:
//   1. os sete blocos com os números certos para uma loja Negócio;
//   2. crediário (tq-85b) pela regra da tela, SEM UPDATE/INSERT/DELETE
//      (todas as consultas espionadas);
//   3. plano Essencial: os blocos que o plano não tem não existem;
//   4. consolidado (dono com duas empresas);
//   5. "Ver um exemplo" (GET /companies/:id/emails/relatorio/exemplo): só o
//      dono, devolve o HTML, não envia nem grava nada;
//   6. página pública /reports/weekly/:token/pagina;
//   7. várias lojas (26/10): base da comparação, nome pela cadeia (nome
//      fantasia -> loja online -> razão social sem o prefixo do MEI), loja
//      nova e o aviso de grupo com mais de 3 lojas.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';
const SECRET = 'aura-test-secret-2026';
const ENV = { ...process.env };

let pool;
let client;
let app;
const sqls = [];

const { resolvePeriodForReport } = require('../src/services/reportDataQueries');
const period = resolvePeriodForReport('weekly');

function dia(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// Meio-dia de São Paulo do dia `iso` (15h UTC).
const ts = (iso) => `${iso}T15:00:00Z`;
const hojeSP = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

const dono = uuid();
const vendedor = uuid();
const A = uuid(); // Negócio, com tudo
const B = uuid(); // Negócio, mesmo dono (consolidado)
const donoE = uuid();
const E = uuid(); // Essencial, com crediário e dados
const EMAIL_DONO = `dono-${dono.slice(0, 8)}@example.test`;
const token = (id, company) => ({ Authorization: `Bearer ${jwt.sign({ id, role: 'client', plan: 'negocio', company }, SECRET, { expiresIn: '1h' })}` });

async function q(sql, params) { return client.query(sql, params); }

async function venda({ empresa, total, itens = [], cliente = null, funcionario = null, pagamento = 'pix', status = 'completed', quando }) {
  const id = uuid();
  await q(`INSERT INTO sales (id, company_id, customer_id, employee_id, total_amount, payment_method, status, type, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'sale', $8)`, [id, empresa, cliente, funcionario, total, pagamento, status, quando]);
  for (const it of itens) {
    await q(`INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price, unit_cost, total_price, product_name_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'x')`, [uuid(), id, it.produto, it.qtd, it.preco, it.custo, it.qtd * it.preco]);
  }
  return id;
}

let P1; let P2; let PB; let C1; let C2; let C3; let C4; let C5; let ANA; let S2;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  const db = require('../src/config/database');
  let fila = Promise.resolve();
  db.query.mockImplementation((sql, params) => {
    sqls.push(String(sql));
    const p = fila.then(() => client.query(sql, params));
    fila = p.catch(() => {});
    return p;
  });

  // company_health_snapshots existe em produção (src/migrations/102), mas não
  // em migrations/ (o banco do CI): o relatório de sempre lê o histórico dela.
  await q(`CREATE TABLE IF NOT EXISTS company_health_snapshots (
             id SERIAL PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
             score INTEGER NOT NULL, label VARCHAR(20), period DATE NOT NULL,
             driver_margem INTEGER, driver_runway INTEGER, driver_crescimento INTEGER, driver_ticket INTEGER,
             created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT uq_health_snapshot_teste UNIQUE (company_id, period))`);
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES
           ($1, $2, 'x', 'Maria Dona'), ($3, $4, 'x', 'Vendedor'), ($5, $6, 'x', 'Dona E')`,
  [dono, EMAIL_DONO, vendedor, `vend-${vendedor.slice(0, 8)}@example.test`, donoE, `e-${donoE.slice(0, 8)}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, email, plan, billing_status, is_primary, pdv_settings)
           VALUES ($1, $2, 'A LTDA', 'Loja A', 'a@example.test', 'negocio', 'active', true, '{"crediario_enabled": true}'::jsonb),
                  ($3, $2, 'B LTDA', 'Loja B', 'b@example.test', 'negocio', 'active', false, '{}'::jsonb),
                  ($4, $5, 'E LTDA', 'Loja E', 'e@example.test', 'essencial', 'active', true, '{"crediario_enabled": true}'::jsonb)`,
  [A, dono, B, E, donoE]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, 'vendedor', 'active', true)`, [A, vendedor]);

  // Produtos: P1 com custo e estoque baixo; P2 sem custo.
  P1 = uuid(); P2 = uuid(); PB = uuid();
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty, stock_min, is_active) VALUES
           ($1, $4, 'Vestido', 100, 1, 3, true), ($2, $4, 'Meia', 50, 10, 0, true), ($3, $5, 'Bolsa', 100, 5, 0, true)`,
  [P1, P2, PB, A, B]);
  ANA = uuid();
  await q(`INSERT INTO employees (id, company_id, name, cpf, base_salary, admission_date, is_active)
           VALUES ($1, $2, 'Ana', '00000000000', 1500, '2026-01-01', true)`, [ANA, A]);

  // Clientes: C1 já comprava; C2 nova; C3 faz aniversário em 2 dias; C4 parado há 40 dias; C5 devedora antiga.
  C1 = uuid(); C2 = uuid(); C3 = uuid(); C4 = uuid(); C5 = uuid();
  const aniversario = '1990-' + dia(hojeSP(), 2).slice(5);
  await q(`INSERT INTO customers (id, company_id, name, birth_date) VALUES
           ($1, $6, 'Cliente Um', NULL), ($2, $6, 'Cliente Dois', NULL), ($3, $6, 'Cliente Tres', $7::date),
           ($4, $6, 'Cliente Quatro', NULL), ($5, $6, 'Cliente Cinco', NULL)`,
  [C1, C2, C3, C4, C5, A, aniversario]);

  const seg = period.startDate;
  // Semana anterior: C1 compra (P1, com custo).
  await venda({ empresa: A, total: 100, cliente: C1, itens: [{ produto: P1, qtd: 1, preco: 100, custo: 30 }], quando: ts(dia(seg, -7)) });
  // Semana: S1 (C1, Ana, 2x P1), S2 (C2, crediário, 1x P1), S3 (sem cliente, P2 sem custo), S4 cancelada.
  await venda({ empresa: A, total: 200, cliente: C1, funcionario: ANA, itens: [{ produto: P1, qtd: 2, preco: 100, custo: 30 }], quando: ts(seg) });
  S2 = await venda({ empresa: A, total: 100, cliente: C2, pagamento: 'crediario', itens: [{ produto: P1, qtd: 1, preco: 100, custo: 30 }], quando: ts(dia(seg, 1)) });
  await venda({ empresa: A, total: 50, pagamento: 'dinheiro', itens: [{ produto: P2, qtd: 1, preco: 50, custo: null }], quando: ts(dia(seg, 2)) });
  await venda({ empresa: A, total: 999, status: 'cancelled', itens: [{ produto: P1, qtd: 9, preco: 111, custo: 30 }], quando: ts(dia(seg, 3)) });
  // B: uma venda na semana.
  await venda({ empresa: B, total: 100, itens: [{ produto: PB, qtd: 1, preco: 100, custo: 50 }], quando: ts(dia(seg, 4)) });
  // C4 parado há 40 dias (depois das vendas: o gatilho de métricas não mexe nele).
  await q(`UPDATE customers SET last_purchase_at = NOW() - INTERVAL '40 days' WHERE id = $1`, [C4]);

  // Contas: a pagar em 2 dias; a receber do crediário (fica fora) e outra (entra).
  const hoje = hojeSP();
  await q(`INSERT INTO transactions (company_id, type, status, amount, description, category, due_date) VALUES
           ($1, 'expense', 'pending', 150, 'Aluguel', 'Aluguel', $2::date),
           ($1, 'income', 'pending', 70, 'Parcela', 'Crediario - A Receber', $3::date),
           ($1, 'income', 'pending', 80, 'Serviço', 'Outros', $4::date)`,
  [A, dia(hoje, 2), dia(hoje, 1), dia(hoje, 3)]);

  // Loja online publicada: 1 pedido confirmado e 1 cancelado na semana.
  await q(`INSERT INTO digital_channel_config (company_id, is_published) VALUES ($1, true)`, [A]);
  await q(`INSERT INTO digital_orders (company_id, order_number, customer_name, customer_phone, subtotal, total, status, created_at) VALUES
           ($1, 'P-1', 'Cliente Web', '11999990000', 120, 120, 'confirmed', $2),
           ($1, 'P-2', 'Cliente Web', '11999990000', 300, 300, 'cancelled', $2)`, [A, ts(dia(seg, 2))]);

  // Crediário (razão + parcelas). C2: débito 100 da venda S2, pagamento 30 e crédito de troca 20 na semana.
  // C5: débito antigo 500 com parcela vencida há 40 dias.
  await q(`INSERT INTO customer_credit_transactions (company_id, customer_id, sale_id, type, amount, payment_method, created_at) VALUES
           ($1, $2, $3, 'debit', 100, NULL, $4),
           ($1, $2, NULL, 'payment', 30, 'pix', $5),
           ($1, $2, NULL, 'payment', 20, 'crediario_credito', $5),
           ($1, $6, NULL, 'debit', 500, NULL, NOW() - INTERVAL '60 days')`,
  [A, C2, S2, ts(dia(seg, 1)), ts(dia(seg, 2)), C5]);
  await q(`INSERT INTO credit_installments (company_id, customer_id, sale_id, installment_number, total_installments, amount_due, covered_amount, due_date, status, created_at) VALUES
           ($1, $2, $3, 1, 2, 50, 0, $4::date, 'pending', NOW()),
           ($1, $2, $3, 2, 2, 50, 0, $5::date, 'pending', NOW()),
           ($1, $6, $7, 1, 1, 500, 0, $8::date, 'pending', NOW() - INTERVAL '60 days')`,
  [A, C2, S2, dia(hoje, 3), dia(hoje, 33), C5, uuid(), dia(hoje, -40)]);

  // E (Essencial) também usa crediário e vende: o bloco não pode aparecer.
  const CE = uuid();
  await q(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente E')`, [CE, E]);
  const SE = await venda({ empresa: E, total: 80, cliente: CE, pagamento: 'crediario', quando: ts(seg) });
  await q(`INSERT INTO customer_credit_transactions (company_id, customer_id, sale_id, type, amount, created_at) VALUES ($1, $2, $3, 'debit', 80, $4)`,
    [E, CE, SE, ts(seg)]);

  const { requireAuth, requireCompanyAccess } = require('../src/middleware/auth');
  app = express();
  app.use(express.json());
  app.use('/companies/:id/emails', requireAuth, requireCompanyAccess(), require('../src/routes/companyEmails'));
  app.use('/reports', require('../src/routes/publicReports'));
});

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  delete process.env.RELATORIO_BLOCOS_DESLIGADOS;
  delete process.env.RELATORIO_LONGO_ENABLED;
  delete process.env.RELATORIO_PAGINA_NO_BACKEND;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  sqls.length = 0;
});
afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  process.env = { ...ENV };
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const ESCRITA = /^\s*(WITH[\s\S]*\)\s*)?(INSERT|UPDATE|DELETE)\b|\bUPDATE\s+credit_installments\b/i;

describe('loja Negócio: os sete blocos', () => {
  let data;
  let consultas;
  beforeAll(async () => {
    const { buildReportData } = require('../src/services/reportGenerator');
    sqls.length = 0;
    data = await buildReportData(A, 'weekly', period, { semNarrativas: true });
    consultas = [...sqls]; // o beforeEach zera `sqls`
  });

  test('nenhuma escrita ao montar o relatório (crediário incluído)', () => {
    expect(consultas.length).toBeGreaterThan(10);
    expect(consultas.some((s) => /customer_credit_transactions/.test(s))).toBe(true);
    expect(consultas.some((s) => /credit_installments/.test(s))).toBe(true);
    expect(consultas.filter((s) => ESCRITA.test(s))).toEqual([]);
    // Nem /credit/dashboard nem /credit/installments: nada de status ao ler.
    expect(consultas.some((s) => /SET\s+status\s*=\s*'overdue'/i.test(s))).toBe(false);
  });

  test('vendas, mais vendidos e pagamentos/estoque', () => {
    const r = data.relatorio;
    expect(r.blocos).toEqual(['vendas', 'mais_vendidos', 'pagamentos_estoque', 'crediario', 'equipe_margem', 'clientes', 'loja_online']);
    expect(r.vendas).toMatchObject({ receita: 350, vendas: 3, receitaAnterior: 100, variacaoPct: 250 });
    expect(r.vendas.semanas).toHaveLength(4);
    expect(r.vendas.semanas[2].receita).toBe(100);
    expect(r.mais_vendidos.top[0]).toEqual({ nome: 'Vestido', qtd: 3, receita: 300 });
    expect(r.mais_vendidos.top[1]).toEqual({ nome: 'Meia', qtd: 1, receita: 50 });
    const pe = r.pagamentos_estoque;
    expect(pe.pagamentos.map((p) => p.rotulo)).toEqual(['Pix', 'Crediário', 'Dinheiro']);
    expect(pe.contas.pagar).toEqual({ valor: 150, qtd: 1 });
    expect(pe.contas.receber).toEqual({ valor: 80, qtd: 1 }); // o "a receber" do crediário fica fora
    expect(pe.estoqueBaixo.qtd).toBe(1);
    expect(pe.estoqueBaixo.itens[0]).toEqual({ nome: 'Vestido', estoque: 1, minimo: 3 });
  });

  test('equipe pela regra da tela e margem bruta com a semana anterior', () => {
    const em = data.relatorio.equipe_margem;
    expect(em.equipe).toEqual([{ nome: 'Ana', vendas: 1, receita: 200 }]);
    // Semana: vendas com custo 300, custo 90 -> 70%; cobertura 300/350.
    expect(em.margem.atual).toEqual({ pct: 70, cobertura: 86 });
    expect(em.margem.anterior).toEqual({ pct: 70, cobertura: 100 });
  });

  test('clientes, loja online', () => {
    expect(data.relatorio.clientes).toEqual({ atendidos: 2, novos: 1, voltaram: 1, aniversariantes: 1, parados: 1, diasParado: 30 });
    expect(data.relatorio.loja_online).toEqual({ pedidos: 1, valor: 120 });
  });

  test('crediário (tq-85b) com a regra da tela', () => {
    const c = data.relatorio.crediario;
    expect(c.recebido).toBe(30); // sem o crédito de troca de 20
    expect(c.novoFiado).toBe(100);
    expect(c.saldo).toBe(550); // C2 50 + C5 500
    expect(c.vencido).toBe(500);
    expect(c.pctVencido).toBe(91);
    expect(c.aVencer).toEqual({ valor: 50, parcelas: 1, dias: 7 });
    expect(c.clientesAtrasoLongo).toBe(1);
    expect(c.fiadoNasVendas).toEqual({ vendas: 1, valor: 100, pct: 33 });
    expect(JSON.stringify(c)).not.toMatch(/Cliente/);
  });

  test('bloco desligado nas preferências some', async () => {
    await q(`INSERT INTO company_email_prefs (company_id, tipo, ligado, config) VALUES ($1, 'relatorio', true, '{"blocos": ["vendas", "clientes"]}'::jsonb)`, [A]);
    try {
      const { buildReportData } = require('../src/services/reportGenerator');
      const d = await buildReportData(A, 'weekly', period, { semNarrativas: true });
      expect(d.relatorio.blocos).toEqual(['vendas', 'clientes']);
      expect(d.relatorio.crediario).toBeUndefined();
      expect(d.relatorio.equipe_margem).toBeUndefined();
    } finally {
      await q(`DELETE FROM company_email_prefs WHERE company_id = $1`, [A]);
    }
  });
});

describe('plano Essencial', () => {
  test('crediário, equipe, clientes e loja online não existem, mesmo com dado', async () => {
    const { buildReportData } = require('../src/services/reportGenerator');
    const d = await buildReportData(E, 'weekly', period, { semNarrativas: true });
    expect(d.relatorio.blocos).toEqual(['vendas', 'mais_vendidos', 'pagamentos_estoque']);
    for (const b of ['crediario', 'equipe_margem', 'clientes', 'loja_online']) expect(d.relatorio[b]).toBeUndefined();
    const { crediarioDaSemana } = require('../src/services/relatorioCrediario');
    expect(await crediarioDaSemana(require('../src/config/database'), E, period, { plano: 'essencial' })).toBeNull();
  });
});

describe('consolidado (dono com duas empresas)', () => {
  test('soma o que é somável, refaz margem, equipe por empresa, crediário só de quem tem', async () => {
    const { buildConsolidatedReportData } = require('../src/services/reportGenerator');
    sqls.length = 0;
    const d = await buildConsolidatedReportData([A, B], 'weekly', period, { decisorId: A, semNarrativas: true });
    expect(sqls.filter((s) => ESCRITA.test(s))).toEqual([]);
    const r = d.relatorio;
    expect(d.company.consolidated).toBe(true);
    expect(d.company.name).toBe('Loja A e Loja B');
    expect(r.grupo.nome).toBe('Loja A e Loja B');
    // B não vendeu na semana anterior: a comparação é só de A (350 contra 100).
    expect(r.grupo.base).toMatchObject({ ids: [A], lojas: 1, todasQueVenderam: false });
    expect(r.vendas.variacaoPct).toBe(250);
    expect(r.vendas.receitaAnterior).toBe(100);
    expect(r.equipe_margem.margem.anterior).toEqual({ pct: 70, cobertura: 100 });
    expect(Object.keys(r.porLoja).sort()).toEqual([A, B].sort());
    expect(r.vendas.receita).toBe(450);
    expect(r.vendas.vendas).toBe(4);
    expect(r.mais_vendidos.top.map((p) => p.nome)).toEqual(['Vestido', 'Bolsa', 'Meia']);
    // (300 + 100 - 90 - 50) / 400 = 65%; cobertura 400/450.
    expect(r.equipe_margem.margem.atual).toEqual({ pct: 65, cobertura: 89 });
    expect(r.equipe_margem.porEmpresa.map((x) => [x.nome, x.equipe.length])).toEqual([['Loja A', 1], ['Loja B', 0]]);
    expect(r.crediario.saldo).toBe(550);
    expect(r.crediario.porEmpresa.map((x) => x.companyId)).toEqual([A]);
    expect(r.crediario.fiadoNasVendas.pct).toBe(25); // 1 de 4 vendas do grupo
    expect(r.loja_online).toEqual({ pedidos: 1, valor: 120 });
  });
});

describe('"Ver um exemplo" (GET /companies/:id/emails/relatorio/exemplo)', () => {
  const contar = async () => {
    const { rows: [r] } = await q(`SELECT (SELECT count(*) FROM report_deliveries)::int AS rd,
                                          (SELECT count(*) FROM email_log)::int AS el,
                                          (SELECT count(*) FROM company_health_snapshots)::int AS hs`);
    return r;
  };

  test('dono recebe o HTML da última semana fechada; nada é enviado nem gravado', async () => {
    const antes = await contar();
    global.fetch = jest.fn();
    sqls.length = 0;
    const r = await request(app).get(`/companies/${A}/emails/relatorio/exemplo`).set(token(dono, A));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('Sua semana na Loja A');
    expect(r.text).toContain('Crediário da semana');
    expect(r.text).toContain(`/crediario?empresa=${A}`);
    expect(r.text).not.toContain('Cliente Dois');
    expect(global.fetch).not.toHaveBeenCalled(); // nem Resend nem Claude
    expect(sqls.filter((s) => ESCRITA.test(s))).toEqual([]);
    expect(await contar()).toEqual(antes);
  });

  test('?versao=resumo, ?formato=json e ?formato=pagina', async () => {
    const r1 = await request(app).get(`/companies/${A}/emails/relatorio/exemplo?versao=resumo&formato=json`).set(token(dono, A));
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ versao: 'resumo', assunto: 'Relatório semanal — Loja A', periodo: { inicio: period.startDate, fim: period.endDate } });
    expect(r1.body.html).not.toContain('Crediário da semana');
    const r2 = await request(app).get(`/companies/${A}/emails/relatorio/exemplo?formato=pagina`).set(token(dono, A));
    expect(r2.status).toBe(200);
    expect(r2.text).toContain('Últimas 4 semanas');
  });

  test('funcionário recebe 403', async () => {
    const r = await request(app).get(`/companies/${A}/emails/relatorio/exemplo`).set(token(vendedor, A));
    expect(r.status).toBe(403);
  });
});

describe('página pública /reports/weekly/:token/pagina', () => {
  test('consolidado pelo token: HTML com os blocos e por unidade; token ruim dá 401', async () => {
    const { signWeeklyReportToken } = require('../src/utils/reportToken');
    const tk = signWeeklyReportToken({ company_id: A, company_ids: [A, B], period_start: period.startDate, period_end: period.endDate });
    sqls.length = 0;
    const r = await request(app).get(`/reports/weekly/${tk}/pagina`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toContain("img-src https://app.getaura.com.br");
    expect(r.text).toContain('Sua semana nas suas 2 lojas');
    expect(r.text).toContain('Loja B');
    expect(r.text).toContain('/vendas?empresa=todas');
    expect(r.text).not.toContain('&rarr;');
    expect(sqls.filter((s) => ESCRITA.test(s))).toEqual([]);
    const j = await request(app).get(`/reports/weekly/${tk}`);
    expect(j.status).toBe(200);
    expect(j.body.blocos.vendas.receita).toBe(450);
    expect(j.body.blocos.mais_vendidos._todos).toBeUndefined();
    expect((await request(app).get('/reports/weekly/abc/pagina')).status).toBe(401);
  });
});

describe('várias lojas: nome, loja nova e grupo com mais de 3 lojas (26/10)', () => {
  const donoM = uuid();
  const M = uuid(); const N = uuid(); const O = uuid(); const Q = uuid();
  const MEI_M = '53.000.000 LUIS EXEMPLO FERREIRA'; // fictício, no formato do caso real
  const MEI_N = '68.000.000 JORGE EXEMPLO VIEIRA';

  beforeAll(async () => {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dono M')`, [donoM, `m-${donoM.slice(0, 8)}@example.test`]);
    await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, email, plan, billing_status, is_primary, pdv_settings, created_at)
             VALUES ($1, $5, $6, $6, 'm@example.test', 'negocio', 'active', true, '{}'::jsonb, NOW() - INTERVAL '400 days'),
                    ($2, $5, $7, $7, 'n@example.test', 'negocio', 'active', false, '{}'::jsonb, NOW() - INTERVAL '300 days'),
                    ($3, $5, 'O LTDA', 'Loja O', 'o@example.test', 'negocio', 'active', false, '{}'::jsonb, NOW() - INTERVAL '2 days'),
                    ($4, $5, 'Q LTDA', 'Loja Q', 'q@example.test', 'negocio', 'active', false, '{}'::jsonb, NOW() - INTERVAL '3 days')`,
    [M, N, O, Q, donoM, MEI_M, MEI_N]);
    // M tem loja online com nome; N não.
    await q(`INSERT INTO digital_channel_config (company_id, is_published, site_name) VALUES ($1, true, 'Adega Exemplo')`, [M]);
    const pm = uuid(); const pn = uuid(); const pq = uuid();
    await q(`INSERT INTO products (id, company_id, name, price, stock_qty, stock_min, is_active) VALUES
             ($1, $4, 'Vinho', 80, 10, 0, true), ($2, $5, 'Cerveja', 80, 10, 0, true), ($3, $6, 'Taça', 20, 5, 0, true)`, [pm, pn, pq, M, N, Q]);
    const seg = period.startDate;
    await venda({ empresa: M, total: 160, itens: [{ produto: pm, qtd: 2, preco: 80, custo: 40 }], quando: ts(dia(seg, -6)) });
    await venda({ empresa: M, total: 240, itens: [{ produto: pm, qtd: 3, preco: 80, custo: 40 }], quando: ts(dia(seg, 1)) });
    await venda({ empresa: N, total: 80, itens: [{ produto: pn, qtd: 1, preco: 80, custo: 40 }], quando: ts(dia(seg, 2)) });
  });

  test('nome pela cadeia, lojas novas marcadas, aviso de mais de 3 lojas, sem escrita', async () => {
    const { buildConsolidatedReportData } = require('../src/services/reportGenerator');
    sqls.length = 0;
    const d = await buildConsolidatedReportData([M, N, O, Q], 'weekly', period, { decisorId: M, semNarrativas: true });
    expect(sqls.filter((s) => ESCRITA.test(s))).toEqual([]);
    const g = d.relatorio.grupo;
    expect(g.lojas.map((l) => l.nome)).toEqual(['Adega Exemplo', 'JORGE EXEMPLO VIEIRA', 'Loja O', 'Loja Q']);
    expect(d.company.name).toBe('suas 4 lojas');
    expect(g.lojas.map((l) => [l.nova, l.produtos])).toEqual([[false, null], [false, null], [true, 0], [true, 1]]);
    expect(g.base).toMatchObject({ ids: [M], receita: 240, receitaAnterior: 160, variacaoPct: 50 });
    expect(console.warn).toHaveBeenCalledWith(`[reportGenerator] grupo com mais de 3 lojas: primary=${M} lojas=4`);
    // Nada do que vai para o e-mail, a página e o JSON público leva o prefixo.
    expect(JSON.stringify(d.relatorio)).not.toMatch(/\d{2}\.\d{3}\.\d{3} /);
    expect(JSON.stringify(d.breakdown)).not.toMatch(/\d{2}\.\d{3}\.\d{3} /);
    // Uma loja só: o nome também segue a cadeia.
    const { buildReportData } = require('../src/services/reportGenerator');
    expect((await buildReportData(N, 'weekly', period, { semNarrativas: true, semBlocos: true })).company.name).toBe('JORGE EXEMPLO VIEIRA');
  });

  test('o e-mail das 4 lojas: as 3 maiores e "Outra loja"; cadastrar os produtos da loja nova vazia', async () => {
    const { buildConsolidatedReportData } = require('../src/services/reportGenerator');
    const { montarEmailDoRelatorio } = require('../src/services/mailer');
    const { semInternos } = require('../src/services/relatorioBlocos');
    const d = await buildConsolidatedReportData([M, N, O, Q], 'weekly', period, { decisorId: M, semNarrativas: true });
    const e = montarEmailDoRelatorio({ id: M, name: d.company.name }, d.kpis, 'https://app.getaura.com.br/relatorios/semanal/t',
      { relatorio: semInternos(d.relatorio), versao: 'completa', periodo: { inicio: period.startDate, fim: period.endDate }, grupo: true });
    expect(e.assunto).toBe('Sua semana nas suas 4 lojas: R$ 320,00 (+50%)');
    expect(e.html).toContain('Outra loja');
    expect(e.html).toContain(`/estoque?empresa=${O}`); // Loja O: sem produto
    expect(e.html).toContain(`/pdv?empresa=${Q}`); // Loja Q: já tem produto, o passo é o Caixa
    expect(e.html).not.toContain('53.000.000');
  });
});
