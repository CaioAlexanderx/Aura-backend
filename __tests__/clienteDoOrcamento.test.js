// ============================================================
// AURA. — Cliente do orcamento vira cadastro (C4 do QA de 26/11/2026), sem banco.
// services/clienteDoOrcamento.js + o envio (/send e /marcar-enviado).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const { garantirClienteDoOrcamento, telefoneNacional } = require('../src/services/clienteDoOrcamento');
const quotesRouter = require('../src/routes/studioQuotes');
const videoRouter = require('../src/routes/studioQuoteVideo');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => { jest.resetAllMocks(); });

/** Banco de mentira de customers + studio_quotes, com log. */
function banco({ clientes = [] } = {}) {
  const estado = { clientes: clientes.map((c) => ({ ...c })), ligacoes: [], sqls: [] };
  const client = {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      estado.sqls.push([s, params]);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
      if (/pg_advisory_xact_lock/.test(s)) return { rows: [] };
      if (/^SELECT id FROM customers WHERE company_id = \$1/.test(s)) {
        const [cid, a, b] = params;
        const achado = estado.clientes.find((c) => c.company_id === cid && [a, b].includes(String(c.phone || '').replace(/\D/g, '')));
        return { rows: achado ? [{ id: achado.id }] : [] };
      }
      if (/^INSERT INTO customers/.test(s)) {
        const novo = { id: 'novo-' + (estado.clientes.length + 1), company_id: params[0], name: params[1], phone: params[2] };
        estado.clientes.push(novo);
        return { rows: [{ id: novo.id }] };
      }
      if (/^UPDATE studio_quotes SET customer_id/.test(s)) {
        estado.ligacoes.push(params);
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { estado, client };
}

const orc = (extra = {}) => ({ id: 'q1', company_id: 'c1', customer_id: null, customer_name: 'Ana Souza', customer_phone: '(11) 95630-5269', ...extra });

describe('telefoneNacional', () => {
  test('com e sem 55, com mascara', () => {
    expect(telefoneNacional('(11) 95630-5269')).toBe('11956305269');
    expect(telefoneNacional('+55 11 95630-5269')).toBe('11956305269');
    expect(telefoneNacional('1133334444')).toBe('1133334444');
  });
  test('curto, vazio ou longo demais: null', () => {
    expect(telefoneNacional('95630-5269')).toBeNull();
    expect(telefoneNacional('')).toBeNull();
    expect(telefoneNacional(null)).toBeNull();
    expect(telefoneNacional('5511956305269999')).toBeNull();
  });
});

describe('garantirClienteDoOrcamento', () => {
  test('sem cliente igual: cria na empresa do orcamento e liga o customer_id', async () => {
    const { estado, client } = banco();
    db.connect.mockResolvedValue(client);
    const r = await garantirClienteDoOrcamento(db, orc());
    expect(r).toEqual({ customer_id: 'novo-1', criado: true, ligado: true });
    expect(estado.clientes).toEqual([{ id: 'novo-1', company_id: 'c1', name: 'Ana Souza', phone: '(11) 95630-5269' }]);
    expect(estado.ligacoes).toEqual([['novo-1', 'q1', 'c1']]);
    // a busca olha so a empresa do orcamento, com e sem 55, e o regex de digitos e \D de verdade
    const busca = estado.sqls.find(([s]) => /^SELECT id FROM customers/.test(s));
    expect(busca[1]).toEqual(['c1', '11956305269', '5511956305269']);
    expect(busca[0]).toContain("'\\D'");
    expect(client.release).toHaveBeenCalled();
  });

  test('ja existe cliente da mesma empresa com o mesmo telefone (com ou sem 55, com mascara): so liga, nao duplica', async () => {
    for (const phone of ['11956305269', '5511956305269', '(11) 95630-5269', '+55 (11) 95630-5269']) {
      const { estado, client } = banco({ clientes: [{ id: 'cli-9', company_id: 'c1', phone }] });
      db.connect.mockResolvedValue(client);
      const r = await garantirClienteDoOrcamento(db, orc({ customer_phone: '11 95630 5269' }));
      expect(r).toEqual({ customer_id: 'cli-9', criado: false, ligado: true });
      expect(estado.clientes).toHaveLength(1);
      expect(estado.ligacoes).toEqual([['cli-9', 'q1', 'c1']]);
    }
  });

  test('mesmo telefone em OUTRA empresa nao conta: cria na empresa do orcamento (multi-CNPJ)', async () => {
    const { estado, client } = banco({ clientes: [{ id: 'cli-x', company_id: 'c2', phone: '11956305269' }] });
    db.connect.mockResolvedValue(client);
    const r = await garantirClienteDoOrcamento(db, orc());
    expect(r.criado).toBe(true);
    expect(estado.clientes.find((c) => c.id === r.customer_id).company_id).toBe('c1');
    expect(estado.clientes).toHaveLength(2);
  });

  test('ja tem customer_id, sem nome ou sem telefone valido: nao faz nada nem abre conexao', async () => {
    for (const q of [orc({ customer_id: 'ja' }), orc({ customer_name: '  ' }), orc({ customer_phone: '123' }), orc({ customer_phone: null })]) {
      db.connect.mockClear();
      const r = await garantirClienteDoOrcamento(db, q);
      expect(r.ligado).toBe(false);
      expect(r.criado).toBe(false);
      expect(db.connect).not.toHaveBeenCalled();
    }
  });

  test('erro no banco: ROLLBACK, nao propaga (o envio segue)', async () => {
    const { client } = banco();
    const orig = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, p) => {
      if (/^INSERT INTO customers/.test(String(sql).trim())) throw new Error('boom');
      return orig(sql, p);
    });
    db.connect.mockResolvedValue(client);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await garantirClienteDoOrcamento(db, orc());
    expect(r.ligado).toBe(false);
    expect(client.query.mock.calls.map((c) => String(c[0]).trim())).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('no envio do orcamento', () => {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/studio', quotesRouter);
  app.use('/companies/:id/studio', videoRouter);

  /** db.query do envio + client do cadastro. */
  function envio({ quote, clientes = [] }) {
    const { estado, client } = banco({ clientes });
    db.connect.mockResolvedValue(client);
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM studio_quotes q JOIN companies c/.test(s.replace(/\s+/g, ' ')) || /SELECT q\.\*, c\.studio_settings/.test(s)) {
        return { rows: [{ ...quote, studio_settings: {} }] };
      }
      if (/SELECT 1 FROM studio_quotes WHERE token/.test(s)) return { rows: [] };
      if (/^\s*UPDATE studio_quotes/.test(s)) return { rows: [{ ...quote, status: 'sent' }] };
      return { rows: [] };
    });
    return estado;
  }
  const QUOTE = { id: 'q1', company_id: 'c1', status: 'draft', customer_id: null, customer_name: 'Ana Souza',
    customer_phone: '(11) 95630-5269', validity_days: 7, token: null, ajuste_pedido_em: null };

  test('/send: enviar cria o cliente na empresa e devolve customer_id', async () => {
    const estado = envio({ quote: QUOTE });
    const r = await request(app).post('/companies/c1/studio/quotes/q1/send');
    expect(r.status).toBe(200);
    expect(r.body.customer_id).toBe('novo-1');
    expect(estado.clientes).toHaveLength(1);
    expect(estado.ligacoes).toEqual([['novo-1', 'q1', 'c1']]);
  });

  test('/send: cliente igual ja cadastrado so e ligado', async () => {
    const estado = envio({ quote: QUOTE, clientes: [{ id: 'cli-9', company_id: 'c1', phone: '5511956305269' }] });
    const r = await request(app).post('/companies/c1/studio/quotes/q1/send');
    expect(r.body.customer_id).toBe('cli-9');
    expect(estado.clientes).toHaveLength(1);
  });

  test('rascunho (editar/salvar) nao cria cliente: so o envio', async () => {
    const estado = envio({ quote: QUOTE });
    db.query.mockImplementation(async (sql) => (/SELECT \* FROM studio_quotes WHERE id/.test(String(sql))
      ? { rows: [QUOTE] } : { rows: [] }));
    await request(app).patch('/companies/c1/studio/quotes/q1').send({ customer_name: 'Ana Souza', customer_phone: '(11) 95630-5269' });
    expect(estado.clientes).toHaveLength(0);
    expect(estado.ligacoes).toEqual([]);
    expect(estado.sqls.some(([x]) => /INSERT INTO customers|pg_advisory_xact_lock/.test(x))).toBe(false);
  });
});
