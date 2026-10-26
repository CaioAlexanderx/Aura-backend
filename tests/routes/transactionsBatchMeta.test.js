// ============================================================
// POST /companies/:id/transactions/batch — o que fica no import_logs.meta
// (tq-102, 26/10/2026)
//
// Para a equipe entender por que uma importação de lançamentos deu errado
// sem pedir o arquivo: contagem por motivo de erro e as colunas recebidas,
// SEM dado pessoal (nenhum valor de linha, nenhuma mensagem do banco, e o
// nome de coluna desconhecida também não, porque planilha sem cabeçalho usa
// a primeira linha como nome de coluna).
// A resposta da rota não muda (o app#1134 mostra errors[].errors[0]).
// Mock do banco por CONTEÚDO DO SQL.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-0000000000aa';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

let app, db, client, falharInsert;
beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  falharInsert = null;
  client = {
    query: jest.fn(async (sql, params) => {
      if (falharInsert && /INSERT INTO transactions/i.test(sql) && falharInsert(params)) {
        throw Object.assign(new Error('invalid input syntax for type numeric: "Maria da Silva 123.456.789-00"'), { code: '22P02' });
      }
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn(),
  };
  db.query.mockReset();
  db.query.mockImplementation(async () => ({ rows: [] }));
  db.connect.mockReset();
  db.connect.mockImplementation(async () => client);
  app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../../src/routes/transactionsBatch'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const importar = (transactions) => request(app).post(`/companies/${cid}/transactions/batch?partial=true`).set(auth).send({ transactions });
const logs = () => client.query.mock.calls.filter(([sql]) => /INSERT INTO import_logs/i.test(sql));
const meta = () => JSON.parse(logs()[0][1][6]);

describe('import_logs.meta da planilha de lançamentos', () => {
  test('sem erro: motivos vazio, colunas reconhecidas e nenhuma outra', async () => {
    const res = await importar([{ tipo: 'despesa', valor: '89,90', descricao: 'Luz', data: '05/09/2020' }]);
    expect(res.status).toBe(201);
    expect(logs()).toHaveLength(1);
    expect(logs()[0][0]).toMatch(/meta\) VALUES/);
    expect(meta()).toEqual({
      motivos: {},
      linhas_com_erro: 0,
      colunas_reconhecidas: ['data', 'descricao', 'tipo', 'valor'],
      colunas_outras: 0,
    });
  });

  test('conta as linhas por motivo (uma linha pode ter dois)', async () => {
    await importar([
      { tipo: 'despesa', valor: '10,00', data: '01/09/2020' },          // ok
      { tipo: 'transferencia', valor: '10,00', data: '01/09/2020' },    // tipo
      { tipo: 'despesa', valor: 'abc', data: '01/09/2020' },            // valor
      { tipo: 'receita', valor: '0', data: '31/02/2020x' },             // valor + data
      { tipo: 'pix', valor: '5', data: 'ontem' },                        // tipo + data
    ]);
    expect(meta()).toMatchObject({
      motivos: { tipo_invalido: 2, valor_invalido: 2, data_invalida: 2 },
      linhas_com_erro: 4,
    });
    expect(meta()).not.toHaveProperty('erros_do_banco');
  });

  test('erro ao salvar: conta o motivo e o SQLSTATE, sem a mensagem do banco', async () => {
    falharInsert = (p) => p[3] === 'Quebra';
    const res = await importar([
      { tipo: 'despesa', valor: '10', descricao: 'Quebra', data: '01/09/2020' },
      { tipo: 'despesa', valor: '10', descricao: 'Inteira', data: '01/09/2020' },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(1);
    expect(meta()).toMatchObject({ motivos: { erro_ao_salvar: 1 }, erros_do_banco: { '22P02': 1 }, linhas_com_erro: 1 });
    expect(logs()[0][1][6]).not.toMatch(/Maria|123\.456|invalid input/);
    // a resposta segue como antes: sem o code novo
    expect(res.body.errors[0]).toEqual(expect.objectContaining({ index: 0, error: expect.any(String) }));
    expect(res.body.errors[0]).not.toHaveProperty('code');
  });

  test('coluna desconhecida: só a contagem, nunca o nome (planilha sem cabeçalho)', async () => {
    // Sem cabeçalho, a primeira linha vira o nome das colunas.
    await importar([
      { 'Maria da Silva': 'Joana Souza', '123.456.789-00': '987.654.321-00', valor: '10', tipo: 'despesa', data: '01/09/2020' },
    ]);
    const m = meta();
    expect(m.colunas_reconhecidas).toEqual(['data', 'tipo', 'valor']);
    expect(m.colunas_outras).toBe(2);
    const gravado = logs()[0][1][6];
    expect(gravado).not.toMatch(/Maria|Joana|123\.456|987\.654/);
  });

  test('nada dos valores das linhas vai para o meta', async () => {
    await importar([
      { tipo: 'despesa', valor: 'R$ 1.234,56', descricao: 'Pagamento Maria CPF 111.222.333-44', categoria: 'Fornecedor X', data: '10/10/2020', vendedor: 'Ana' },
      { tipo: 'nada', valor: '-3', descricao: 'Cliente Joana', data: 'xx' },
    ]);
    const gravado = logs()[0][1][6];
    expect(gravado).not.toMatch(/Maria|111\.222|Fornecedor|Ana"|Joana|1\.234|nada|xx/);
    expect(meta().colunas_reconhecidas).toEqual(['categoria', 'data', 'descricao', 'tipo', 'valor', 'vendedor']);
  });

  test('as mensagens de erro da resposta são as de sempre', async () => {
    const res = await importar([{ tipo: 'pix', valor: 'abc', data: 'ontem' }]);
    expect(res.body.errors[0].errors).toEqual([
      "Linha 1: tipo invalido 'pix' (use 'income' ou 'expense')",
      "Linha 1: valor invalido 'abc'",
      "Linha 1: data invalida 'ontem' (use YYYY-MM-DD ou DD/MM/YYYY)",
    ]);
  });
});
