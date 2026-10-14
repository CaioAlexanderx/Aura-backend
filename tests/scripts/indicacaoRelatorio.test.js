// ============================================================
// scripts/indicacao-relatorio.js — conferência semanal da Célia (t2-19)
// Somente leitura: nenhum SQL de escrita, nenhuma chamada à Asaas.
// ============================================================
'use strict';

const { montarRelatorio, imprimir, lerArgs } = require('../../scripts/indicacao-relatorio');
const { HOJE, fakeDb, par, juntar } = require('../helpers/fakeIndicacao');

describe('relatório da indicação', () => {
  test('junta concessões, excluídas sem concessão, pendentes com valor potencial e teto', async () => {
    const pendenteSemPagamento = par({ indicadoPagouEm: null, indicadorValor: 140.83 });
    const elegivel = par({ indicadorValor: 93.17 });
    const concedida = par({ indicadorValor: 74.17 });
    const d = juntar([pendenteSemPagamento, elegivel, concedida]);
    const db = fakeDb({
      candidatos: d.candidatos,
      eventos: d.eventos,
      concessoes: [{ id: 'k1', tipo: 'padrao', status: 'aplicada', referral_id: concedida.candidato.referral_id,
        indicador_company_id: concedida.a, indicado_company_id: concedida.b, data_concessao: '2026-10-10', valor: 74.17,
        asaas_payment_id: 'pay_k1' }],
      relatorio: {
        concessoes: [
          { id: 'k1', tipo: 'padrao', status: 'aplicada', data_concessao: '2026-10-10', valor: '74.17', asaas_payment_id: 'pay_k1', indicador: 'Loja A' },
          { id: 'k2', tipo: 'padrao', status: 'registrada', data_concessao: '2026-09-01', valor: '93.17', asaas_payment_id: 'pay_k2', indicador: 'Loja C' },
        ],
        excluidas: [{ log_id: 'w1', dia: '2026-10-09', loja: 'Encanto', pagamento_id: 'pay_manual', valor: '93.17', vencimento: '2026-10-15' }],
      },
    });

    const r = await montarRelatorio({ db, hoje: HOJE });

    expect(r.desde).toBe('2026-10-07');
    expect(r.totalConcedidoPeriodo).toBe(74.17);
    expect(r.emConferencia.map((k) => k.id)).toEqual(['k2']);
    expect(r.excluidasSemConcessao).toEqual([expect.objectContaining({ pagamento_id: 'pay_manual', valor: 93.17 })]);
    expect(r.pendentes.map((p) => p.situacao).sort()).toEqual(['aguardando_pagamento_indicado', 'elegivel']);
    // potencial estimado pela última cobrança paga de cada indicador
    expect(r.valorPotencial).toBe(234); // 140,83 + 93,17
    expect(r.teto).toEqual({ mes: '2026-10', usado: 74.17, teto: 230, restante: 155.83 });
    expect(r.porSituacao).toMatchObject({ concedida: 1 });

    // só leitura
    expect(db.escritas()).toEqual([]);
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    jest.spyOn(console, 'table').mockImplementation(() => {});
    const linhas = [];
    imprimir(r, (l) => linhas.push(l));
    expect(linhas.join('\n')).toMatch(/PAYMENT_DELETED sem concessão: 1/);
  });

  test('a consulta de excluídas cruza pelo id da cobrança e aceita estornada como explicada', async () => {
    const db = fakeDb({});
    await montarRelatorio({ db, hoje: HOJE, desde: '2026-10-01' });
    const [sql, params] = db.query.mock.calls.find(([s]) => /relatorio-excluidas/.test(s));
    expect(params).toEqual(['2026-10-01']);
    expect(sql).toMatch(/event = 'PAYMENT_DELETED'/);
    expect(sql).toMatch(/k\.asaas_payment_id = x\.p->>'id'/);
    expect(sql).toMatch(/'registrada', 'aplicada', 'estornando', 'estornada'/);
    expect(sql).not.toMatch(/'falhou'/);
  });

  test('sem a migration 385: mensagem clara', async () => {
    const db = { query: jest.fn(async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }) };
    await expect(montarRelatorio({ db, hoje: HOJE })).rejects.toThrow(/migration 385/);
  });

  test('argumentos', () => {
    expect(lerArgs(['--desde', '2026-10-01', '--json'])).toEqual({ desde: '2026-10-01', json: true });
    expect(() => lerArgs(['--desde', '01/10'])).toThrow(/AAAA-MM-DD/);
    expect(() => lerArgs(['--apply'])).toThrow(/desconhecida/);
  });
});
