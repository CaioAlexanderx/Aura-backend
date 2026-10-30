// ============================================================
// Pix Automático cancelado sem ser pela Aura = sinal de saída (tq-105,
// critério 5 da Célia, 29/10/2026)
//
//   - services/pixAutomaticoCancelamentos.listarCanceladas
//   - alerta pix_auto_cancelado no painel da Gestão Aura
//   - lista "Autorizações do Pix Automático canceladas" no bloco Receita
//     (com 7 dias, a linha do board semanal)
// ============================================================
'use strict';

const { listarCanceladas, rotuloDoMotivo } = require('../src/services/pixAutomaticoCancelamentos');
const { calcularAlertas } = require('../src/services/painelAlertas');
const blocoReceita = require('../src/services/painelBlocos/receita');

const HOJE = '2099-03-10';
const LOJA = 'aaaaaaaa-0000-4000-8000-000000000001';
const VAZIO = { lista: [], porId: new Map(), pagantes: [] };

const cancelada = (extra) => ({
  authorization_id: 'auth-1', company_id: LOJA, nome: 'Loja Piloto',
  cancelled_at: '2099-03-09T14:00:00.000Z', cancellation_reason: 'REQUESTED_BY_PAYER_USER', ...extra,
});

// Banco que só responde à consulta de autorizações canceladas.
function bancoCom(canceladas, { semTabela = false } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM pix_automatico_autorizacoes/.test(sql)) {
        if (semTabela) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
        return { rows: canceladas };
      }
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('listarCanceladas', () => {
  test('a consulta deixa de fora o cancelamento pedido pela Aura e usa a janela pedida', async () => {
    const db = bancoCom([]);
    await listarCanceladas({ db, hoje: HOJE, dias: 7 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("cancellation_reason IS DISTINCT FROM 'REQUESTED_BY_RECEIVER_USER'");
    expect(sql).toContain("a.status = 'cancelled'");
    expect(sql).toContain('$1::date - 7');
    expect(params).toEqual([HOJE]);
  });

  test('normaliza as linhas e traduz o motivo', async () => {
    const r = await listarCanceladas({ db: bancoCom([cancelada(), cancelada({ authorization_id: 'auth-2', cancellation_reason: null })]), hoje: HOJE });
    expect(r).toEqual([
      expect.objectContaining({ authorization_id: 'auth-1', company_id: LOJA, motivo: 'Cliente cancelou no banco', pela_cliente: true }),
      expect.objectContaining({ authorization_id: 'auth-2', motivo: 'Motivo não informado', pela_cliente: false }),
    ]);
  });

  test('sem a migration 406: lista vazia, sem erro', async () => {
    expect(await listarCanceladas({ db: bancoCom([], { semTabela: true }), hoje: HOJE })).toEqual([]);
  });

  test('rotuloDoMotivo cobre os motivos da Asaas', () => {
    expect(rotuloDoMotivo('REQUESTED_BY_COURT_ORDER')).toBe('Ordem judicial');
    expect(rotuloDoMotivo('CONFIRMATION_ERROR')).toBe('Erro na confirmação');
    expect(rotuloDoMotivo('OTHER')).toBe('Outro motivo');
    expect(rotuloDoMotivo('NOVO_MOTIVO')).toBe('NOVO_MOTIVO');
  });
});

describe('alerta pix_auto_cancelado no painel', () => {
  test('cancelamento pela cliente vira alerta de sinal de saída, apontando para a loja e para a Receita', async () => {
    const alertas = await calcularAlertas({ hoje: HOJE, db: bancoCom([cancelada()]), empresas: VAZIO, agora: new Date() });
    const a = alertas.find((x) => x.tipo === 'pix_auto_cancelado');
    expect(a).toMatchObject({
      chave: 'auth-1', company_id: LOJA, verbo: 'Falar', bloco: 'receita',
      titulo: 'Loja Piloto cancelou o Pix Automático no banco',
    });
    expect(a.detalhe).toMatch(/^Sinal de saída · Cliente cancelou no banco · /);
  });

  test('outro motivo: título neutro', async () => {
    const alertas = await calcularAlertas({ hoje: HOJE, db: bancoCom([cancelada({ cancellation_reason: 'OTHER' })]), empresas: VAZIO, agora: new Date() });
    expect(alertas.find((x) => x.tipo === 'pix_auto_cancelado').titulo).toBe('Loja Piloto: Pix Automático cancelado');
  });

  test('a consulta falhar não derruba os outros alertas', async () => {
    const db = { query: jest.fn(async (sql) => {
      if (/FROM pix_automatico_autorizacoes/.test(sql)) throw new Error('timeout');
      return { rows: [] };
    }) };
    const alertas = await calcularAlertas({ hoje: HOJE, db, empresas: VAZIO, agora: new Date() });
    expect(alertas.find((x) => x.tipo === 'pix_auto_cancelado')).toBeUndefined();
  });
});

describe('bloco Receita', () => {
  test('lista "Autorizações do Pix Automático canceladas" com a janela do período e aviso no insight', async () => {
    const mrr = {
      mrr_total: 0, assinaturas: [], por_plano_ciclo: [], com_cobranca: 0, sem_cobranca: { clientes: 0, mrr_potencial: 0 },
      comparativo: { asaas: null, tabela: 0 }, fonte: 'companies',
    };
    const bloco = await blocoReceita.calcular({ hoje: HOJE, periodo: 7, db: bancoCom([cancelada()]), empresas: VAZIO, mrr });
    const lista = bloco.detalhe.listas.find((l) => l.titulo === 'Autorizações do Pix Automático canceladas · 7 dias');
    expect(lista).toBeDefined();
    expect(lista.linhas).toEqual([expect.objectContaining({ nome: 'Loja Piloto', motivo: 'Cliente cancelou no banco', company_id: LOJA })]);
    expect(bloco.detalhe.insight).toContain('1 autorização do Pix Automático cancelada em 7 dias');
  });
});
