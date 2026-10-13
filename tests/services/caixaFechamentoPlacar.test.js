// ============================================================
// AURA. -- Fechar o caixa dispara o placar do dia (13/10/2026)
//
// caixaService.fechar chama placarDoDia.dispararNoFechamento DEPOIS de gravar
// o fechamento, sem esperar e sem poder derrubar a resposta. O conteudo do
// placar e o envio estao em tests/unit/placarDoDia.test.js; aqui so o gancho.
//
// Mock por SQL (mockImplementation casando o texto da query), nunca fila
// posicional. beforeEach com resetAllMocks.
// ============================================================
'use strict';

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock('../../src/services/placarDoDia', () => ({
  dispararNoFechamento: jest.fn(),
}));

const pool = require('../../src/config/database');
const placar = require('../../src/services/placarDoDia');
const caixaService = require('../../src/services/caixaService');

const COMPANY = 'ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc';
const SESSAO = '14e73ece-98e3-4003-a33b-200665077fe3';

function bancoComCaixaAberto() {
  pool.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/caixa_enabled/.test(s)) return Promise.resolve({ rows: [{ caixa_enabled: 'true' }] });
    if (/FROM caixa_sessoes cs/.test(s)) {
      return Promise.resolve({ rows: [{
        id: SESSAO, company_id: COMPANY, opened_at: '2026-12-15T11:00:00.000Z', troco_inicial: '0.00',
        status: 'aberta', opened_by: 'user-1', opened_by_employee_id: null, operator_name: 'Davi', operator_id: 'user-1',
      }] });
    }
    return Promise.resolve({ rows: [] });
  });
  const client = {
    query: jest.fn((sql) => (/INSERT INTO caixa_fechamentos/.test(sql)
      ? Promise.resolve({ rows: [{ id: 'fech-1', sessao_id: SESSAO, diferenca: '0.00' }] })
      : Promise.resolve({ rows: [] }))),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => jest.resetAllMocks());

describe('caixaService.fechar -- placar do dia', () => {
  test('depois de gravar o fechamento, dispara o placar da loja com o horario do fechamento', async () => {
    bancoComCaixaAberto();
    placar.dispararNoFechamento.mockResolvedValue({ sent: true });

    const fechamento = await caixaService.fechar(COMPANY, 'user-1', 0, null);

    expect(fechamento.sessao_label).toMatch(/^#/);
    expect(placar.dispararNoFechamento).toHaveBeenCalledTimes(1);
    const [companyId, opts] = placar.dispararNoFechamento.mock.calls[0];
    expect(companyId).toBe(COMPANY);
    expect(opts.closedAt).toBeInstanceOf(Date);
    expect(opts.closedAt.getTime()).toBe(new Date(fechamento.closed_at).getTime());
  });

  test('o fechamento NAO espera o placar (promessa pendente)', async () => {
    bancoComCaixaAberto();
    placar.dispararNoFechamento.mockReturnValue(new Promise(() => {})); // nunca resolve

    const fechamento = await caixaService.fechar(COMPANY, 'user-1', 0, null);
    expect(fechamento.sessao_label).toMatch(/^#/);
  });

  test('placar que rejeita ou lanca nao derruba o fechamento', async () => {
    bancoComCaixaAberto();
    placar.dispararNoFechamento.mockRejectedValue(new Error('fila fora'));
    const a = await caixaService.fechar(COMPANY, 'user-1', 0, null);
    expect(a.sessao_label).toMatch(/^#/);

    bancoComCaixaAberto();
    placar.dispararNoFechamento.mockImplementation(() => { throw new Error('quebrou sincrono'); });
    const b = await caixaService.fechar(COMPANY, 'user-1', 0, null);
    expect(b.sessao_label).toMatch(/^#/);
  });

  test('sem caixa aberto: nao fecha e nao dispara o placar', async () => {
    pool.query.mockImplementation((sql) => (/caixa_enabled/.test(String(sql))
      ? Promise.resolve({ rows: [{ caixa_enabled: 'true' }] })
      : Promise.resolve({ rows: [] })));

    await expect(caixaService.fechar(COMPANY, 'user-1', 0, null)).rejects.toThrow(/Nenhum caixa aberto/);
    expect(placar.dispararNoFechamento).not.toHaveBeenCalled();
  });
});
