// ============================================================
// AURA. — Aba Pedidos (B3): consulta e numeros sem banco
// services/listaDePedidos.js e a regra de lojas de /me/pedidos. O resultado
// de verdade, no Postgres, esta em listaDePedidos.banco.test.js.
// ============================================================
'use strict';

const L = require('../src/services/listaDePedidos');
const { _lojaEntra } = require('../src/routes/mePedidos');
const { MODULE_PLAN_MAP } = require('../src/services/modules');

const E = ['11111111-2222-3333-4444-555555555555'];

function conferirParametros({ sql, params }) {
  const citados = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  expect(Math.max(...citados)).toBe(params.length);
  for (let i = 1; i <= params.length; i++) expect(citados.has(i)).toBe(true);
}

test.each([
  [undefined, 'abertos'], ['', 'abertos'], ['qualquer', 'abertos'], ['TODOS', 'todos'], ['all', 'todos'],
  ['aguardando', 'aguardando'], ['separando', 'separando'], ['prontos', 'prontos'],
  ['concluidos', 'concluidos'], ['cancelados', 'cancelados'],
])('situacao %p -> %s', (raw, esperado) => expect(L.lerSituacao(raw)).toBe(esperado));

describe('consulta da lista', () => {
  test('so pedido do balcao das lojas pedidas; parametros contados', () => {
    for (const p of [{}, { situacao: 'todos' }, { atrasados: true }, { q: 'marina' }, { q: '12' }, { q: '(11) 98888' }]) {
      const c = L.montarConsultaDaLista({ empresas: E, limit: 30, offset: 0, hoje: '2026-11-17', ...p });
      expect(c.sql).toContain("o.origem = 'balcao'");
      expect(c.sql).toContain('o.company_id = ANY($1::uuid[])');
      expect(c.params[0]).toBe(E);
      expect(c.params[1]).toBe('2026-11-17');
      conferirParametros(c);
    }
  });
  test('abertos por padrao; todos sem filtro de situacao', () => {
    const padrao = L.montarConsultaDaLista({ empresas: E, limit: 30, offset: 0, hoje: '2026-11-17' });
    expect(padrao.sql).toContain("o.status::text = ANY(ARRAY['confirmed','preparing','ready'])");
    const todos = L.montarConsultaDaLista({ empresas: E, situacao: 'todos', limit: 30, offset: 0, hoje: '2026-11-17' });
    const where = (sql) => sql.split('WHERE o.company_id')[1].split('ORDER BY')[0];
    expect(where(padrao.sql)).toContain('o.status::text = ANY');
    expect(where(todos.sql)).not.toContain('o.status::text = ANY');
  });
  test('busca com curinga e texto, nao padrao', () => {
    const c = L.montarConsultaDaLista({ empresas: E, q: '100%_x', limit: 30, offset: 0, hoje: '2026-11-17' });
    expect(c.params[2]).toBe('%100!%!_x%');
  });
  test('atrasados primeiro, sem data por ultimo', () => {
    const { sql } = L.montarConsultaDaLista({ empresas: E, limit: 30, offset: 0, hoje: '2026-11-17' });
    expect(sql).toMatch(/ORDER BY \(o\.status::text = ANY\(ARRAY\['confirmed','preparing','ready'\]\) AND COALESCE\(o\.promised_date < \$2::date, false\)\) DESC, o\.promised_date ASC NULLS LAST/);
  });
});

test('numeros: soma das lojas e falta nunca negativa no SQL', () => {
  const c = L.montarConsultaDosNumeros({ empresas: E, hoje: '2026-11-17' });
  conferirParametros(c);
  expect(c.sql).toContain('GREATEST(o.total - x.sinal, 0)');
  expect(c.sql).toContain('GROUP BY o.company_id');
  const soma = L.somarNumeros([{ abertos: 2, falta_receber: '10.5' }, { abertos: 1, falta_receber: 4 }]);
  expect(soma).toMatchObject({ abertos: 3, falta_receber: 14.5, todos: 0 });
  expect(L.apresentarNumeros(null).kpis).toEqual({ abertos: 0, pecas_reservadas: 0, atrasados: 0, sinais_recebidos: 0, falta_receber: 0 });
});

test('/me/pedidos: que lojas entram', () => {
  expect(_lojaEntra({ isOwner: true, permissions: { pdv: false } })).toBe(true);
  expect(_lojaEntra({ roleLabel: 'owner', permissions: {} })).toBe(true);
  expect(_lojaEntra({ permissions: null })).toBe(true);
  expect(_lojaEntra({ permissions: { pdv: true } })).toBe(true);
  expect(_lojaEntra({ permissions: { 'vendas.pedidos': true } })).toBe(true);
  expect(_lojaEntra({ permissions: { financeiro: true } })).toBe(false);
});

test('chave de modulo propria, no Essencial', () => {
  expect(MODULE_PLAN_MAP['vendas.pedidos']).toBe('essencial');
});
