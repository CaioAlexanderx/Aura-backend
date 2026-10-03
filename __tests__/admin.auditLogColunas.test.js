// ============================================================
// AURA — admin_audit_log: o INSERT usa as colunas que a tabela tem
//
// A tabela (src/migrations/108_admin_audit_log.sql) tem staff_user_id e
// company_id. As rotas de vertical, plano, sub-vertical e karate gravavam em
// actor_user_id / target_company_id — colunas que nao existem. O 42703 era
// engolido pelo catch "best-effort" e nenhuma dessas acoes ficava auditada.
//
// O mock de banco aqui se comporta como o Postgres nesse ponto: INSERT em
// admin_audit_log com coluna fora do schema rejeita com 42703.
//
// Cobertura:
//  (1) PATCH /admin/clients/:cid/vertical grava vertical_change com o staff,
//      a empresa e o payload {from,to}.
//  (2) Nenhuma rota em src/routes grava em admin_audit_log com coluna que a
//      migration 108 nao cria.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const router = require('../src/routes/adminVertical');

const CID = '45d92b02-165d-44d6-928a-ac8e0183d5bd';
const STAFF = 'user-staff-aura';

const AUDIT_COLUMNS = ['id', 'staff_user_id', 'company_id', 'action', 'payload', 'reason', 'created_at'];
const AUDIT_INSERT = /INSERT INTO admin_audit_log\s*\(([^)]*)\)/gi;

const token = jwt.sign({ id: STAFF, role: 'admin' }, 'aura-test-secret-2026', { expiresIn: '1h' });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

function insertColumns(sql) {
  const m = /INSERT INTO admin_audit_log\s*\(([^)]*)\)/i.exec(sql);
  return m ? m[1].split(',').map(c => c.trim()) : null;
}

function mockDb(company) {
  const audit = [];
  db.query.mockImplementation(async (sql, params) => {
    const cols = insertColumns(sql);
    if (cols) {
      const unknown = cols.find(c => !AUDIT_COLUMNS.includes(c));
      if (unknown) {
        const err = new Error('column "' + unknown + '" of relation "admin_audit_log" does not exist');
        err.code = '42703';
        throw err;
      }
      const row = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      audit.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*SELECT/i.test(sql)) return { rows: [company] };
    if (/RETURNING/i.test(sql)) return { rows: [{ ...company, vertical_active: params[0] }] };
    return { rows: [], rowCount: 1 };
  });
  return audit;
}

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { db.query.mockReset(); warn.mockRestore(); });

describe('admin_audit_log — colunas do INSERT', () => {
  test('(1) troca de vertical grava vertical_change', async () => {
    const audit = mockDb({ id: CID, plan: 'essencial', trade_name: 'Loja', vertical_active: null, pdv_settings: {} });

    const res = await request(makeApp())
      .patch('/admin/clients/' + CID + '/vertical')
      .set('Authorization', 'Bearer ' + token)
      .send({ vertical: 'studio' });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ staff_user_id: STAFF, company_id: CID, action: 'vertical_change' });
    expect(JSON.parse(audit[0].payload)).toEqual({ from: null, to: 'studio' });
  });

  test('(2) nenhuma rota grava em coluna que a tabela nao tem', () => {
    const dir = path.join(__dirname, '..', 'src', 'routes');
    const offenders = [];
    let inserts = 0;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const m of src.matchAll(AUDIT_INSERT)) {
        inserts++;
        const unknown = m[1].split(',').map(c => c.trim()).filter(c => !AUDIT_COLUMNS.includes(c));
        if (unknown.length) offenders.push(file + ': ' + unknown.join(', '));
      }
    }
    expect(inserts).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
