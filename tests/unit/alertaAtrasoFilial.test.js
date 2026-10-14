// ============================================================
// Card t2-15: filial paga pela matriz (Davi Villa Branca, vencimento de
// 18/06) não gera alerta de atraso/cobrança — nem no painel da Gestão Aura
// (services/painelAlertas) nem em GET /admin/alerts (routes/adminMetrics).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const fake = require('../helpers/fakePainelDb');
const { calcularAlertas } = require('../../src/services/painelAlertas');
const b = require('../../src/services/painelBlocos/_base');

const FILIAL = fake.id(9);
const TRIAL_FILIAL = 'aaaaaaaa-0000-4000-8000-0000000000b9';
const base = {
  telefone: null, plan: 'negocio', ciclo: 'monthly', status: 'active', criado_em: '2026-04-01', trial_ate: null,
  vence_em: null, segment: null, vertical_active: null, por_codigo: false, tem_cobranca: false, eh_dojo: false,
  paga_por_outra: false, dojo_sem_assinatura: false,
};

// Filial anual que vence amanhã sem nunca ter vendido: se fosse uma conta
// comum, seria o alerta pagante_anual_vencendo.
function dadosComFilial() {
  const dados = fake.dadosPadrao();
  dados.empresas.push(
    { ...base, company_id: FILIAL, nome: 'Davi Villa Branca', ciclo: 'annual', vence_em: '2026-10-14', paga_por_outra: true },
  );
  return dados;
}

const tipos = (alertas) => alertas.map((a) => `${a.tipo}:${a.company_id}`);

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { db.query.mockReset(); jest.restoreAllMocks(); });

describe('painelAlertas', () => {
  test('controle: loja comum anual vencendo sem venda recente continua gerando o alerta', async () => {
    fake.ligar(db.query, dadosComFilial());
    const alertas = await calcularAlertas({ hoje: fake.HOJE, agora: fake.AGORA });
    expect(tipos(alertas)).toContain(`pagante_anual_vencendo:${fake.id(1)}`);
  });

  test('filial paga pela matriz não gera alerta de vencimento/atraso (universo real)', async () => {
    fake.ligar(db.query, dadosComFilial());
    const alertas = await calcularAlertas({ hoje: fake.HOJE, agora: fake.AGORA });
    expect(alertas.filter((a) => a.company_id === FILIAL)).toEqual([]);
  });

  test('mesmo se a filial chegar em pagantes/lista, as guardas dos alertas a ignoram', async () => {
    fake.ligar(db.query, dadosComFilial());
    const filialAnual = { ...base, company_id: FILIAL, nome: 'Davi Villa Branca', ciclo: 'annual', vence_em: '2026-10-14', paga_por_outra: true, pagante: true };
    const filialTrial = { ...base, company_id: TRIAL_FILIAL, nome: 'Filial em trial', status: 'trial', trial_ate: '2026-10-14', paga_por_outra: true, pagante: false };
    const empresas = {
      lista: [filialAnual, filialTrial],
      porId: new Map([filialAnual, filialTrial].map((e) => [e.company_id, e])),
      pagantes: [filialAnual],
    };
    // venda registrada na filial em trial: sem a guarda, viraria trial_com_venda_vencendo
    const dados = fake.dadosPadrao();
    dados.ultimaVenda.push({ company_id: TRIAL_FILIAL, vendas: '5', ultima: fake.ts('2026-10-12') });
    fake.ligar(db.query, dados);
    const alertas = await calcularAlertas({ hoje: fake.HOJE, agora: fake.AGORA, empresas });
    expect(alertas.filter((a) => [FILIAL, TRIAL_FILIAL].includes(a.company_id))).toEqual([]);
  });

  test('o universo marca a filial: paga_por_outra e fora da contagem', async () => {
    fake.ligar(db.query, dadosComFilial());
    const emp = await b.carregarEmpresas(db);
    expect(emp.porId.get(FILIAL).paga_por_outra).toBe(true);
    expect(emp.pagantes.map((e) => e.company_id)).not.toContain(FILIAL);
  });
});

describe('GET /admin/alerts (routes/adminMetrics)', () => {
  const router = require('../../src/routes/adminMetrics');
  const staff = jwt.sign({ id: fake.USER, role: 'admin' }, 'aura-test-secret-2026');

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/admin', router);
    // eslint-disable-next-line no-unused-vars
    a.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    return a;
  }

  test('a consulta de pagamentos vencidos exclui filial paga pela matriz', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/admin/alerts').set('Authorization', `Bearer ${staff}`);
    expect(res.status).toBe(200);
    const sql = db.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
      .find((s) => s.includes("billing_status IN ('pending','overdue')"));
    expect(sql).toBeDefined();
    expect(sql).toContain(`NOT ${b.PAGA_POR_OUTRA}`);
    expect(sql).toContain('billing_owner_company_id');
  });

  test('conta própria vencida continua alertando (o filtro é só da filial)', async () => {
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("billing_status IN ('pending','overdue')")) {
        return { rows: [{ id: 'c1', trade_name: 'Loja Atrasada', plan: 'negocio', billing_status: 'overdue', next_billing_date: '2026-09-01', email: 'a@b.c' }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).get('/admin/alerts').set('Authorization', `Bearer ${staff}`);
    expect(res.body.alerts.filter((a) => a.type === 'payment_overdue').map((a) => a.company_name)).toEqual(['Loja Atrasada']);
  });
});
