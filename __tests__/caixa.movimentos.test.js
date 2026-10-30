// ============================================================
// AURA. — Caixa: sangria e suprimento (30/10/2026, migration 422)
//
// A loja tira dinheiro da gaveta com o caixa aberto (depósito, motoboy) ou
// reforça o troco. Não é venda: só mexe no dinheiro esperado. Pool mockado,
// roteado pelo texto do SQL (mesmo padrão de caixa.historicoSemGate).
//
//   1. status: dinheiro_em_caixa = troco + dinheiro + suprimentos − sangrias
//   2. sangria maior que o dinheiro em caixa: 422, nada gravado
//   3. sangria dentro do caixa: INSERT com sessão, tipo, valor, motivo e
//      usuário; a resposta já traz o caixa depois dela
//   4. sem caixa aberto: 404
//   5. fechar: dinheiro_esperado desconta sangrias e soma suprimentos; o
//      snapshot leva total_sangrias/total_suprimentos
//   6. migration 422 ausente (42P01): status segue com zeros, histórico
//      cai na consulta sem as colunas, registrar avisa (422)
//   7. tipo/valor inválidos: 400
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../src/config/database');
const caixaService = require('../src/services/caixaService');

const EMPRESA = '3a95021d-62e2-417c-8863-b9c4f0a5e155';
const SESSAO = { id: 'sessao-1', status: 'aberta', opened_at: '2026-10-30T11:00:00Z', troco_inicial: '100.00', operator_id: 'u1', operator_name: 'Dona Lúcia' };

let banco;
function montarBanco({ sessao = SESSAO, dinheiro = 250, sangrias = 0, suprimentos = 0, semMigration = false } = {}) {
  banco = { inserts: [], fechamentos: [], historicoSql: [] };
  pool.query.mockReset();
  pool.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/caixa_enabled/.test(s)) return Promise.resolve({ rows: [{ caixa_enabled: 'true' }] });
    if (/FROM caixa_sessoes cs\s+JOIN users u ON/.test(s)) return Promise.resolve({ rows: sessao ? [sessao] : [] });
    if (/FROM sale_payments sp/.test(s)) return Promise.resolve({ rows: [{ method: 'dinheiro', total: String(dinheiro) }] });
    if (/FROM caixa_movimentos\s+WHERE sessao_id/.test(s)) {
      if (semMigration) { const e = new Error('relation "caixa_movimentos" does not exist'); e.code = '42P01'; return Promise.reject(e); }
      const rows = [];
      if (sangrias) rows.push({ tipo: 'sangria', total: String(sangrias) });
      if (suprimentos) rows.push({ tipo: 'suprimento', total: String(suprimentos) });
      return Promise.resolve({ rows });
    }
    if (/INSERT INTO caixa_movimentos/.test(s)) {
      banco.inserts.push(params);
      return Promise.resolve({ rows: [{ id: 'mov-1', tipo: params[2], valor: String(params[3]), motivo: params[4], created_at: '2026-10-30T12:00:00Z' }] });
    }
    if (/FROM caixa_sessoes cs\s+JOIN users u_open/.test(s)) {
      banco.historicoSql.push(s);
      if (semMigration && /total_sangrias/.test(s)) { const e = new Error('column cf.total_sangrias does not exist'); e.code = '42703'; return Promise.reject(e); }
      return Promise.resolve({ rows: [{ id: 'sessao-0', status: 'fechada' }] });
    }
    if (/COUNT\(\*\)::int AS total/.test(s)) return Promise.resolve({ rows: [{ total: 1 }] });
    return Promise.resolve({ rows: [] });
  });
  pool.connect.mockReset();
  pool.connect.mockResolvedValue({
    query: (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO caixa_fechamentos/.test(s)) {
        banco.fechamentos.push({ sql: s, params });
        return Promise.resolve({ rows: [{ id: 'f1', sessao_id: 'sessao-1', dinheiro_esperado: params[1], dinheiro_contado: params[2], diferenca: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  });
}

beforeEach(() => { caixaService._resetCache(); });

test('1. status: dinheiro em caixa soma suprimento e desconta sangria', async () => {
  montarBanco({ dinheiro: 250, sangrias: 80, suprimentos: 30 });
  const st = await caixaService.getStatus(EMPRESA);
  expect(st.sessao_ativa.sangrias).toBe(80);
  expect(st.sessao_ativa.suprimentos).toBe(30);
  // 100 (troco) + 250 (dinheiro) + 30 − 80
  expect(st.sessao_ativa.dinheiro_em_caixa).toBe(300);
  expect(st.sessao_ativa.totais_ao_vivo.geral).toBe(250); // sangria não é venda
});

test('2. sangria maior que o caixa: 422 e nada gravado', async () => {
  montarBanco({ dinheiro: 250, sangrias: 80, suprimentos: 30 }); // em caixa: 300
  await expect(caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'sangria', valor: 300.01 }))
    .rejects.toMatchObject({ statusCode: 422 });
  expect(banco.inserts).toHaveLength(0);
});

test('3. sangria dentro do caixa: grava e devolve o caixa depois dela', async () => {
  montarBanco({ dinheiro: 250, sangrias: 80, suprimentos: 30 });
  const r = await caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'sangria', valor: 300, motivo: '  depósito   no banco ' });
  expect(banco.inserts).toHaveLength(1);
  expect(banco.inserts[0]).toEqual([EMPRESA, 'sessao-1', 'sangria', 300, 'depósito no banco', 'u1']);
  expect(r.movimento).toMatchObject({ id: 'mov-1', tipo: 'sangria', valor: 300 });
  expect(r.sangrias).toBe(380);
  expect(r.suprimentos).toBe(30);
  expect(r.dinheiro_em_caixa).toBe(0);
});

test('3b. suprimento: entra sem limite e soma no caixa', async () => {
  montarBanco({ dinheiro: 0, sangrias: 0, suprimentos: 0 });
  const r = await caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'suprimento', valor: 50 });
  expect(banco.inserts[0][2]).toBe('suprimento');
  expect(r.suprimentos).toBe(50);
  expect(r.dinheiro_em_caixa).toBe(150);
});

test('4. sem caixa aberto: 404', async () => {
  montarBanco({ sessao: null });
  await expect(caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'sangria', valor: 10 }))
    .rejects.toMatchObject({ statusCode: 404 });
  const lista = await caixaService.listarMovimentos(EMPRESA);
  expect(lista).toEqual({ sessao_id: null, movimentos: [], sangrias: 0, suprimentos: 0, dinheiro_em_caixa: 0 });
});

test('5. fechar: esperado desconta sangria, soma suprimento e o snapshot leva os totais', async () => {
  montarBanco({ dinheiro: 250, sangrias: 80, suprimentos: 30 });
  const f = await caixaService.fechar(EMPRESA, 'u1', 300, null);
  expect(banco.fechamentos).toHaveLength(1);
  const { sql, params } = banco.fechamentos[0];
  expect(sql).toMatch(/total_sangrias, total_suprimentos/);
  expect(params[1]).toBe(300);            // dinheiro_esperado
  expect(params.slice(11)).toEqual([80, 30]);
  expect(f.total_sangrias).toBe(80);
  expect(f.total_suprimentos).toBe(30);
});

test('6. migration ausente: status com zeros, histórico sem as colunas, registrar avisa', async () => {
  montarBanco({ dinheiro: 250, semMigration: true });
  const st = await caixaService.getStatus(EMPRESA);
  expect(st.sessao_ativa.sangrias).toBe(0);
  expect(st.sessao_ativa.dinheiro_em_caixa).toBe(350);

  await expect(caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'sangria', valor: 10 }))
    .rejects.toMatchObject({ statusCode: 422 });
  expect(banco.inserts).toHaveLength(0);

  const f = await caixaService.fechar(EMPRESA, 'u1', 350, null);
  expect(banco.fechamentos[0].sql).not.toMatch(/total_sangrias/);
  expect(f.total_sangrias).toBe(0);

  caixaService._resetCache();
  const h = await caixaService.getHistorico(EMPRESA, {});
  expect(h.sessoes).toHaveLength(1);
  // primeira tentativa com as colunas, segunda sem
  expect(banco.historicoSql).toHaveLength(2);
  expect(banco.historicoSql[0]).toMatch(/total_sangrias/);
  expect(banco.historicoSql[1]).not.toMatch(/total_sangrias/);
});

test('7. tipo ou valor inválidos: 400', async () => {
  montarBanco({});
  await expect(caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'retirada', valor: 10 })).rejects.toMatchObject({ statusCode: 400 });
  await expect(caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'sangria', valor: 0 })).rejects.toMatchObject({ statusCode: 400 });
  await expect(caixaService.registrarMovimento(EMPRESA, 'u1', { tipo: 'sangria', valor: '10' })).rejects.toMatchObject({ statusCode: 400 });
  expect(banco.inserts).toHaveLength(0);
});
