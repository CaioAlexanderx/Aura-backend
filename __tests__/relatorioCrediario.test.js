// ============================================================
// AURA. — Bloco do crediário do relatório semanal (tq-85b): só leitura
//
// Diretriz do Caio (18/10): nada de reparo de parcela; só medir. O banco é
// um falso que guarda cada SQL: nenhum pode ser UPDATE, INSERT ou DELETE.
// O teste com o Postgres de verdade está em relatorioLongo.banco.test.js.
// ============================================================
'use strict';

const C = require('../src/services/relatorioCrediario');

const PERIODO = { startDate: '2026-10-19', endDate: '2026-10-24' };

function bancoFalso(respostas) {
  const sqls = [];
  return {
    sqls,
    query: jest.fn(async (sql) => {
      sqls.push(String(sql));
      for (const [re, rows] of respostas) {
        if (re.test(sql)) {
          if (rows instanceof Error) throw rows;
          return { rows };
        }
      }
      return { rows: [] };
    }),
  };
}

const RESPOSTAS = (o = {}) => [
  [/pdv_settings->>'crediario_enabled'/, [{ ligado: o.ligado !== false, tem_lancamentos: o.lancamentos !== false }]],
  [/FROM customer_credit_transactions\s+WHERE company_id = \$1 AND/, [{ recebido: '860', recebimentos: 7, novo_fiado: '1150' }]],
  // As consultas de parcelas também citam a view (condição 5): vêm antes.
  [/AS parcelas_vencidas/, [{ vencido: o.vencido != null ? String(o.vencido) : '1240', parcelas_vencidas: 5, a_vencer: '980', parcelas_a_vencer: 6 }]],
  [/AS mais_antigo/, [{ clientes: 3 }]],
  [/FROM customer_credit_balances\s+WHERE company_id = \$1/, [{ saldo: o.saldo != null ? String(o.saldo) : '6480', clientes: 22 }]],
  [/FROM credit_plan_configs/, [{ late_grace_days: 3, late_charges_enabled: false }]],
  [/COUNT\(DISTINCT t\.sale_id\)/, [{ vendas: 9, valor: '1150' }]],
];

const ESCRITA = /\b(UPDATE|INSERT|DELETE)\b/i;

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('Negócio com crediário: as métricas do card, só com SELECT', async () => {
  const db = bancoFalso(RESPOSTAS());
  const r = await C.crediarioDaSemana(db, 'co-1', PERIODO, { plano: 'negocio', totalVendas: 31 });
  expect(r).toEqual({
    recebido: 860, recebimentos: 7, novoFiado: 1150, saldo: 6480, clientesComSaldo: 22,
    vencido: 1240, parcelasVencidas: 5, pctVencido: 19,
    aVencer: { valor: 980, parcelas: 6, dias: 7 },
    clientesAtrasoLongo: 3, diasAtrasoLongo: 30,
    fiadoNasVendas: { vendas: 9, valor: 1150, pct: 29 },
  });
  expect(db.sqls.length).toBe(7);
  for (const s of db.sqls) expect(s).not.toMatch(ESCRITA);
  // Recebido sem o crédito de troca; regra única de atraso com a condição 5.
  expect(db.sqls.join('\n')).toContain("payment_method IS DISTINCT FROM 'crediario_credito'");
  expect(db.sqls.join('\n')).toContain('customer_credit_balances cb_atraso');
  expect(db.sqls.join('\n')).toContain("(created_at AT TIME ZONE 'America/Sao_Paulo')::date < ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 7)");
  // Período: segunda a sábado (fim exclusivo no domingo).
  const params = db.query.mock.calls.find(([sql]) => /recebimentos/.test(sql))[1];
  expect(params).toEqual(['co-1', '2026-10-19', '2026-10-25']);
});

test('Expansão também tem; Essencial e plano desconhecido não (nem consulta)', async () => {
  expect(await C.crediarioDaSemana(bancoFalso(RESPOSTAS()), 'co-1', PERIODO, { plano: 'expansao' })).not.toBeNull();
  for (const plano of ['essencial', null, 'personalizado']) {
    const db = bancoFalso(RESPOSTAS());
    expect(await C.crediarioDaSemana(db, 'co-1', PERIODO, { plano })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  }
});

test('toggle desligado ou nenhum lançamento no razão: o bloco não existe', async () => {
  for (const o of [{ ligado: false }, { lancamentos: false }]) {
    const db = bancoFalso(RESPOSTAS(o));
    expect(await C.crediarioDaSemana(db, 'co-1', PERIODO, { plano: 'negocio' })).toBeNull();
    expect(db.sqls).toHaveLength(1);
  }
});

test('vencido acima do saldo (parcelas x razão): mostra 100% e registra, sem nome de cliente', async () => {
  const db = bancoFalso(RESPOSTAS({ vencido: 700, saldo: 500 }));
  const r = await C.crediarioDaSemana(db, 'co-1', PERIODO, { plano: 'negocio' });
  expect(r.pctVencido).toBe(100);
  expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/vencido acima do saldo: company=co-1 vencido=700 saldo=500/));
  expect(C.percentualVencido(50, 500)).toEqual({ pct: 10, passou: false });
  expect(C.percentualVencido(0, 0)).toEqual({ pct: null, passou: false });
  expect(C.percentualDasVendas(40, 31)).toBe(100);
  expect(C.percentualDasVendas(3, 0)).toBeNull();
});

test('nada em aberto e nada na semana: some', async () => {
  const db = bancoFalso([
    [/pdv_settings/, [{ ligado: true, tem_lancamentos: true }]],
    [/AS parcelas_vencidas/, [{ vencido: '0', parcelas_vencidas: 0, a_vencer: '0', parcelas_a_vencer: 0 }]],
  ]);
  expect(await C.crediarioDaSemana(db, 'co-1', PERIODO, { plano: 'negocio' })).toBeNull();
});

test('erro de banco (tabela ausente) desliga o bloco e não derruba o relatório', async () => {
  const e = Object.assign(new Error('relation "credit_installments" does not exist'), { code: '42P01' });
  const db = bancoFalso([[/pdv_settings/, [{ ligado: true, tem_lancamentos: true }]], [/AS parcelas_vencidas/, e], ...RESPOSTAS()]);
  await expect(C.crediarioDaSemana(db, 'co-1', PERIODO, { plano: 'negocio' })).resolves.toBeNull();
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/bloco desligado: company=co-1 code=42P01/));
});

test('consolidado: soma e refaz os percentuais', () => {
  const base = {
    recebido: 100, recebimentos: 1, novoFiado: 200, saldo: 1000, clientesComSaldo: 2, vencido: 300, parcelasVencidas: 2,
    aVencer: { valor: 50, parcelas: 1, dias: 7 }, clientesAtrasoLongo: 1, diasAtrasoLongo: 30, fiadoNasVendas: { vendas: 2, valor: 200, pct: 50 },
  };
  const s = C.somarCrediarios([
    { companyId: 'a', nome: 'A', crediario: base },
    { companyId: 'b', nome: 'B', crediario: { ...base, saldo: 200, vencido: 900 } },
    { companyId: 'c', nome: 'C', crediario: null },
  ], 10);
  expect(s.saldo).toBe(1200);
  expect(s.vencido).toBe(1200);
  expect(s.pctVencido).toBe(100);
  expect(s.fiadoNasVendas).toEqual({ vendas: 4, valor: 400, pct: 40 });
  expect(s.porEmpresa.map((x) => x.companyId)).toEqual(['a', 'b']);
  expect(C.somarCrediarios([{ companyId: 'c', crediario: null }], 3)).toBeNull();
});
