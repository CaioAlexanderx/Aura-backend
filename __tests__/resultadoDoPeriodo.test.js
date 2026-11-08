// ============================================================
// AURA. — Resultado do período (p-81): regras puras e a rota
//
// O cálculo com Postgres de verdade está em resultadoDoPeriodo.banco.test.js.
// Aqui: a montagem dos números (troca, item sem custo, fornecedores fora,
// consolidado), a validação do período e o 403 para quem não vê custo.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const R = require('../src/services/resultadoDoPeriodo');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const TOKEN = jwt.sign({ id: 'u1', role: 'client' }, 'aura-test-secret-2026', { expiresIn: '1h' });

function linhaVendas(over = {}) {
  return {
    company_id: A, n_vendas: 3, vendas: '1000.00', receita_com_custo: '600.00', cmv: '250.00',
    itens: 5, itens_com_custo: 3, produtos_sem_custo: 2, ...over,
  };
}
function linhaLanc(over = {}) {
  return {
    company_id: A, troca_venda: '150.00', troca_devolucao: '100.00', compras: '800.00',
    n_compras: 2, despesas: '320.00', ...over,
  };
}

describe('numerosDasSomas / montarResultado', () => {
  test('faturamento líquido soma a troca-venda e tira a troca-devolução', () => {
    const r = R.montarResultado({
      empresas: [{ id: A }], de: '2026-11-01', ate: '2026-11-30',
      vendas: [linhaVendas()], lancamentos: [linhaLanc()],
    });
    expect(r.faturamento).toBe(1050);
    expect(r.vendas).toBe(1000);
    expect(r.trocas).toEqual({ entrou: 150, devolvido: 100 });
    expect(r.consolidado).toBe(false);
    expect(r.por_empresa).toBeUndefined();
  });

  test('lucro bruto só nos itens com custo, com margem e cobertura por valor', () => {
    const r = R.montarResultado({
      empresas: [{ id: A }], de: '2026-11-01', ate: '2026-11-30',
      vendas: [linhaVendas()], lancamentos: [linhaLanc()],
    });
    expect(r.custos).toBe(250);
    expect(r.receita_com_custo).toBe(600);
    expect(r.lucro_bruto).toBe(350);
    expect(r.margem_pct).toBe(58.3);
    expect(r.cobertura.pct).toBe(60);
    expect(r.cobertura.receita_sem_custo).toBe(400);
    expect(r.cobertura.produtos_sem_custo).toBe(2);
  });

  test('despesas e compras pagas vêm separadas', () => {
    const r = R.montarResultado({
      empresas: [{ id: A }], de: '2026-11-01', ate: '2026-11-30',
      vendas: [linhaVendas()], lancamentos: [linhaLanc()],
    });
    expect(r.despesas).toBe(320);
    expect(r.compras_pagas).toEqual({ total: 800, lancamentos: 2 });
  });

  test('sem nenhum custo: lucro e margem são null (a tela pede o custo, não mostra R$ 0)', () => {
    const r = R.montarResultado({
      empresas: [{ id: A }], de: '2026-11-01', ate: '2026-11-30',
      vendas: [linhaVendas({ receita_com_custo: '0', cmv: '0', itens_com_custo: 0 })], lancamentos: [],
    });
    expect(r.lucro_bruto).toBeNull();
    expect(r.margem_pct).toBeNull();
    expect(r.cobertura.pct).toBe(0);
    expect(r.custos).toBe(0);
  });

  test('sem venda no período: cobertura null, tudo zero', () => {
    const r = R.montarResultado({ empresas: [{ id: A }], de: '2026-11-01', ate: '2026-11-30' });
    expect(r.faturamento).toBe(0);
    expect(r.cobertura.pct).toBeNull();
    expect(r.lucro_bruto).toBeNull();
    expect(r.despesas).toBe(0);
  });

  test('consolidado soma as lojas e conta as lojas com pouco custo', () => {
    const r = R.montarResultado({
      empresas: [{ id: A, nome: 'Loja A' }, { id: B, nome: 'Loja B' }], de: '2026-11-01', ate: '2026-11-30',
      vendas: [
        linhaVendas(),
        linhaVendas({ company_id: B, vendas: '500', receita_com_custo: '100', cmv: '40', itens_com_custo: 1, produtos_sem_custo: 4 }),
      ],
      lancamentos: [linhaLanc(), linhaLanc({ company_id: B, troca_venda: '0', troca_devolucao: '0', compras: '0', n_compras: 0, despesas: '80' })],
    });
    expect(r.consolidado).toBe(true);
    expect(r.empresas).toBe(2);
    expect(r.faturamento).toBe(1550);
    expect(r.custos).toBe(290);
    expect(r.lucro_bruto).toBe(410);
    expect(r.despesas).toBe(400);
    expect(r.compras_pagas.total).toBe(800);
    expect(r.cobertura.pct).toBe(47);
    expect(r.cobertura.produtos_sem_custo).toBe(6);
    expect(r.cobertura.lojas_com_pouco_custo).toBe(1);
    expect(r.cobertura.lojas_com_venda).toBe(2);
    expect(r.por_empresa.map((e) => [e.nome, e.faturamento, e.cobertura.pct])).toEqual([['Loja A', 1050, 60], ['Loja B', 500, 20]]);
  });

  test('linha de empresa que não está na lista é ignorada', () => {
    const r = R.montarResultado({
      empresas: [{ id: A }], de: '2026-11-01', ate: '2026-11-30',
      vendas: [linhaVendas({ company_id: B })], lancamentos: [linhaLanc({ company_id: B })],
    });
    expect(r.faturamento).toBe(0);
  });

  test('periodoAnterior cola o mesmo tamanho antes do início', () => {
    expect(R.periodoAnterior('2026-11-01', '2026-11-30')).toEqual({ de: '2026-10-02', ate: '2026-10-31' });
    expect(R.periodoAnterior('2026-11-08', '2026-11-08')).toEqual({ de: '2026-11-07', ate: '2026-11-07' });
  });

  test('dataValida recusa formato e data inexistente', () => {
    expect(R.dataValida('2026-02-30')).toBe(false);
    expect(R.dataValida('08/11/2026')).toBe(false);
    expect(R.dataValida('2026-11-08')).toBe(true);
  });
});

describe('resultadoDoPeriodo (consultas)', () => {
  beforeEach(() => db.query.mockReset());

  test('três consultas, todas com a lista de empresas e o período', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM transactions/.test(sql)) return { rows: [linhaLanc()] };
      if (/LIMIT \$4/.test(sql)) return { rows: [{ product_id: 'p1', nome: 'Meia', receita: '40', quantidade: '2' }] };
      return { rows: [linhaVendas()] };
    });
    const r = await R.resultadoDoPeriodo({ empresas: [A], de: '2026-11-01', ate: '2026-11-30' });
    expect(db.query).toHaveBeenCalledTimes(3);
    for (const [, params] of db.query.mock.calls) {
      expect(params.slice(0, 3)).toEqual([[A], '2026-11-01', '2026-11-30']);
    }
    expect(r.faturamento).toBe(1050);
    expect(r.produtos_sem_custo).toEqual([{ product_id: 'p1', nome: 'Meia', receita: 40, quantidade: 2 }]);
  });

  test('comProdutos false pula a lista', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await R.resultadoDoPeriodo({ empresas: [A], de: '2026-11-01', ate: '2026-11-30', comProdutos: false });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('período inválido é 400', async () => {
    await expect(R.resultadoDoPeriodo({ empresas: [A], de: '2026-11-30', ate: '2026-11-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(R.resultadoDoPeriodo({ empresas: [A], de: 'ontem', ate: '2026-11-01' })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a regra das categorias: fornecedores e troca-devolução fora de despesas', () => {
    const sql = R._sql.SQL_LANCAMENTOS;
    expect(sql).toMatch(/NOT \(cat = ANY\(\$5::text\[\]\)\)/);
    expect(sql).toMatch(/NOT \(cat = ANY\(\$6::text\[\]\)\)/);
    expect(sql).toMatch(/status = 'confirmed'/);
    expect(R.CAT_FORNECEDORES).toEqual(['fornecedores']);
    expect(R.CAT_TROCA_DEVOLUCAO).toContain('troca - devolucao');
  });
});

describe('rotas', () => {
  const rotas = require('../src/routes/resultadoDoPeriodo');
  function app(user, mount = 'company') {
    const a = express();
    if (user) a.use((req, res, next) => { req.user = user; next(); });
    if (mount === 'company') a.use('/companies/:id/financeiro', rotas.companyRouter);
    else a.use('/me/financeiro', rotas.meRouter);
    return a;
  }

  beforeEach(() => db.query.mockReset());

  function bancoCom({ permissao = null, empresas = null } = {}) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM companies c\s+LEFT JOIN company_members cm\s+ON cm.company_id = c.id AND cm.user_id = \$2/.test(sql)) {
        return { rows: [permissao] };
      }
      if (/DISTINCT ON \(c.id\)/.test(sql)) return { rows: empresas || [] };
      if (/FROM transactions/.test(sql)) return { rows: [linhaLanc()] };
      if (/LIMIT \$4/.test(sql)) return { rows: [] };
      return { rows: [linhaVendas()] };
    });
  }

  test('dono recebe os números e o anterior quando pede', async () => {
    bancoCom();
    const res = await request(app({ id: 'u1', role: 'admin' }))
      .get(`/companies/${A}/financeiro/resultado?de=2026-11-01&ate=2026-11-30&anterior_de=2026-10-01&anterior_ate=2026-10-31`);
    expect(res.status).toBe(200);
    expect(res.body.faturamento).toBe(1050);
    expect(res.body.lucro_bruto).toBe(350);
    expect(res.body.anterior).toMatchObject({ periodo: { de: '2026-10-01', ate: '2026-10-31' }, faturamento: 1050 });
    expect(res.body.anterior.produtos_sem_custo).toBeUndefined();
  });

  test('aceita start/end e responde sem anterior', async () => {
    bancoCom();
    const res = await request(app({ id: 'u1', role: 'admin' })).get(`/companies/${A}/financeiro/resultado?start=2026-11-01&end=2026-11-30`);
    expect(res.status).toBe(200);
    expect(res.body.anterior).toBeNull();
  });

  test('período inválido: 400 com texto legível', async () => {
    bancoCom();
    const res = await request(app({ id: 'u1', role: 'admin' })).get(`/companies/${A}/financeiro/resultado?de=2026-11-30&ate=2026-11-01`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Período inválido/);
  });

  test('estoque só consulta: 403, nada de número', async () => {
    bancoCom({ permissao: { is_owner: false, role_label: 'vendedor', permissions: { estoque_consulta: true } } });
    const res = await request(app({ id: 'u2', role: 'client' })).get(`/companies/${A}/financeiro/resultado?de=2026-11-01&ate=2026-11-30`);
    expect(res.status).toBe(403);
    expect(res.body.faturamento).toBeUndefined();
  });

  test('funcionário sem retaguarda (custo oculto): 403', async () => {
    bancoCom({ permissao: { is_owner: false, role_label: 'vendedor', permissions: { pdv: true, estoque: true, painel: false } } });
    const res = await request(app({ id: 'u2', role: 'client' })).get(`/companies/${A}/financeiro/resultado?de=2026-11-01&ate=2026-11-30`);
    expect(res.status).toBe(403);
  });

  test('membro com Financeiro vê', async () => {
    bancoCom({ permissao: { is_owner: false, role_label: 'gerente', permissions: { financeiro: true, painel: true } } });
    const res = await request(app({ id: 'u2', role: 'client' })).get(`/companies/${A}/financeiro/resultado?de=2026-11-01&ate=2026-11-30`);
    expect(res.status).toBe(200);
  });

  test('/me: soma as lojas do usuário', async () => {
    bancoCom({
      empresas: [
        { id: A, nome: 'Loja A', is_primary: true, created_at: '2026-01-01', is_owner: true, role_label: null, permissions: null },
        { id: B, nome: 'Loja B', is_primary: false, created_at: '2026-02-01', is_owner: true, role_label: null, permissions: null },
      ],
    });
    const res = await request(app(null, 'me')).get('/me/financeiro/resultado?de=2026-11-01&ate=2026-11-30').set('Authorization', 'Bearer ' + TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.consolidado).toBe(true);
    expect(res.body.por_empresa).toHaveLength(2);
    const consultaDeVendas = db.query.mock.calls.find(([sql]) => /FROM sales s/.test(sql) && !/LIMIT \$4/.test(sql));
    expect(consultaDeVendas[1][0]).toEqual([A, B]);
  });

  test('/me: se em alguma loja a pessoa não vê custo, 403', async () => {
    bancoCom({
      empresas: [
        { id: A, nome: 'Loja A', is_primary: true, created_at: '2026-01-01', is_owner: true, role_label: null, permissions: null },
        { id: B, nome: 'Loja B', is_primary: false, created_at: '2026-02-01', is_owner: false, role_label: 'vendedor', permissions: { estoque_consulta: true } },
      ],
    });
    const res = await request(app(null, 'me')).get('/me/financeiro/resultado?de=2026-11-01&ate=2026-11-30').set('Authorization', 'Bearer ' + TOKEN);
    expect(res.status).toBe(403);
  });

  test('erro do banco: 500 com texto gentil', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app({ id: 'u1', role: 'admin' })).get(`/companies/${A}/financeiro/resultado?de=2026-11-01&ate=2026-11-30`);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Tente de novo/);
  });
});
