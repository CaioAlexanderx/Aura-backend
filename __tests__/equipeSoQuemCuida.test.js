// ============================================================
// AURA. — Escrita na equipe só para quem cuida dela (03/11/2026)
//
// O Caixa ganhou "Cadastrar vendedora" para dono/admin/quem tem folha ou
// configurações. A trava antes era só de tela: qualquer membro gravava em
// /employees chamando a API. Leitura segue aberta (o seletor F2 lista).
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const { podeMexerNaEquipe } = require('../src/routes/employees');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const BASE = `/companies/${COMPANY}`;
const token = () => jwt.sign({ id: 'funcionario', role: 'client', plan: 'essencial', company: COMPANY }, 'aura-test-secret-2026', { expiresIn: '1h' });

let montado;
beforeAll(() => {
  montado = express();
  montado.use(express.json());
  montado.use('/companies/:id', require('../src/routes/private'));
}, 60000);

function banco({ papel = 'Caixa', permissions }) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    const r = (rows) => Promise.resolve({ rows, rowCount: rows.length });
    if (/'owner' AS role/.test(s)) return r([{ role: papel }]);
    if (/cm\.role_label, cm\.permissions/.test(s)) return r([{ is_owner: papel === 'owner', role_label: papel, permissions }]);
    if (/SELECT COUNT\(\*\)::int AS total FROM employees/.test(s)) return r([{ total: 0 }]);
    if (/INSERT INTO employees/.test(s)) return r([{ id: 'e1', name: 'Bianca', role: 'Vendedora', is_active: true }]);
    if (/FROM employees/.test(s)) return r([{ id: 'e0', name: 'Ana', is_active: true }]);
    return r([]);
  });
}

const post = () => request(montado).post(`${BASE}/employees`).set('Authorization', `Bearer ${token()}`).send({ name: 'Bianca' });
const insertiu = () => db.query.mock.calls.some(([s]) => /INSERT INTO employees/.test(String(s)));

beforeEach(() => db.query.mockReset());

test('regra', () => {
  expect(podeMexerNaEquipe({ isOwner: true, permissions: { pdv: true } })).toBe(true);
  expect(podeMexerNaEquipe({ isOwner: false, roleLabel: 'admin', permissions: { pdv: true } })).toBe(true);
  expect(podeMexerNaEquipe({ isOwner: false, roleLabel: 'x', permissions: null })).toBe(true);
  expect(podeMexerNaEquipe({ isOwner: false, roleLabel: 'Gerente', permissions: { folha: true } })).toBe(true);
  expect(podeMexerNaEquipe({ isOwner: false, roleLabel: 'Gerente', permissions: { configuracoes: true } })).toBe(true);
  expect(podeMexerNaEquipe({ isOwner: false, roleLabel: 'Caixa', permissions: { pdv: true, painel: true } })).toBe(false);
});

test('operador de caixa não cadastra (403 e nada grava)', async () => {
  banco({ permissions: { pdv: true, painel: true, clientes: true } });
  const res = await post();
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('SEM_PERMISSAO_EQUIPE');
  expect(insertiu()).toBe(false);
});

test('quem tem folha cadastra', async () => {
  banco({ papel: 'Gerente', permissions: { pdv: true, folha: true } });
  const res = await post();
  expect(res.status).toBeLessThan(300);
  expect(insertiu()).toBe(true);
});

test('dono cadastra sem pagar a leitura de permissão', async () => {
  banco({ papel: 'owner', permissions: null });
  const res = await post();
  expect(res.status).toBeLessThan(300);
  expect(db.query.mock.calls.some(([s]) => /cm\.role_label, cm\.permissions/.test(String(s)))).toBe(false);
});

test('operador de caixa continua LENDO a equipe (seletor F2)', async () => {
  banco({ permissions: { pdv: true, painel: true } });
  const res = await request(montado).get(`${BASE}/employees`).set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(200);
});
