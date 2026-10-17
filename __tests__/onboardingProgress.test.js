// ============================================================
// AURA — onboarding_step que avança sozinho (17/10/2026, card t2-04)
//
// 30 de 30 cadastros ficaram em onboarding_step='cnpj' porque o wizard que
// avançava o passo saiu do app. services/onboardingProgress.js passa a
// avançá-lo pelos marcos reais (perfil → produto → venda).
// ============================================================
'use strict';

jest.unmock('../src/services/onboardingProgress');

const {
  POSTO, PASSOS, SQL_AVANCAR, avancarPasso, avancarSemEsperar, _resetForTests,
} = require('../src/services/onboardingProgress');

const CID = 'company-1';

// Banco fake que aplica a MESMA regra do SQL (posto atual < posto novo) sobre
// um passo em memória, para provar idempotência e "nunca regride".
function fakeConn(passoInicial) {
  const estado = { passo: passoInicial };
  const chamadas = [];
  return {
    estado,
    chamadas,
    query: jest.fn(async (sql, params) => {
      chamadas.push({ sql, params });
      const [, novo, posto] = params;
      const atual = Object.prototype.hasOwnProperty.call(POSTO, estado.passo) ? POSTO[estado.passo] : 0;
      if (atual < posto) { estado.passo = novo; return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    }),
  };
}

let warn;
beforeEach(() => {
  _resetForTests();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('escada de passos', () => {
  test('ordem: cnpj < regime < perfil < produto < venda < done', () => {
    const ordem = ['cnpj', 'regime', 'perfil', 'produto', 'venda', 'done'];
    expect(PASSOS).toEqual(ordem);
    for (let i = 1; i < ordem.length; i++) expect(POSTO[ordem[i]]).toBeGreaterThan(POSTO[ordem[i - 1]]);
  });

  test("os apelidos do legado ('complete', 'completed') valem o mesmo que 'done'", () => {
    expect(POSTO.complete).toBe(POSTO.done);
    expect(POSTO.completed).toBe(POSTO.done);
  });

  test('o SQL só avança: compara o posto atual com o novo e mapeia o legado', () => {
    expect(SQL_AVANCAR).toMatch(/UPDATE companies/);
    expect(SQL_AVANCAR).toMatch(/SET onboarding_step = \$2/);
    expect(SQL_AVANCAR).toMatch(/< \$3::int/);
    expect(SQL_AVANCAR).toContain("WHEN 'completed' THEN 5");
    expect(SQL_AVANCAR).toContain('ELSE 0 END');
  });
});

describe('avancarPasso', () => {
  test("cadastro novo ('cnpj') vai para 'produto' e depois 'venda'", async () => {
    const conn = fakeConn('cnpj');
    expect(await avancarPasso(CID, 'produto', { conn })).toBe(true);
    expect(conn.estado.passo).toBe('produto');
    expect(await avancarPasso(CID, 'venda', { conn })).toBe(true);
    expect(conn.estado.passo).toBe('venda');
  });

  test('idempotente: repetir o mesmo marco não grava de novo nem volta ao banco', async () => {
    const conn = fakeConn('cnpj');
    await avancarPasso(CID, 'venda', { conn });
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(await avancarPasso(CID, 'venda', { conn })).toBe(false);
    expect(await avancarPasso(CID, 'produto', { conn })).toBe(false); // marco menor, já passou
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(conn.estado.passo).toBe('venda');
  });

  test('nunca regride: conta em venda que cadastra produto continua em venda', async () => {
    const conn = fakeConn('venda');
    expect(await avancarPasso(CID, 'produto', { conn })).toBe(false);
    expect(conn.estado.passo).toBe('venda');
  });

  test("conta do legado em 'done' ou 'completed' não é rebaixada", async () => {
    for (const legado of ['done', 'complete', 'completed']) {
      _resetForTests();
      const conn = fakeConn(legado);
      expect(await avancarPasso(CID, 'venda', { conn })).toBe(false);
      expect(conn.estado.passo).toBe(legado);
    }
  });

  test('valor desconhecido ou nulo no banco conta como cnpj e avança', async () => {
    const conn = fakeConn(null);
    expect(await avancarPasso(CID, 'perfil', { conn })).toBe(true);
    expect(conn.estado.passo).toBe('perfil');
  });

  test('empresas diferentes não se misturam na memória', async () => {
    const a = fakeConn('cnpj');
    const b = fakeConn('cnpj');
    await avancarPasso('A', 'venda', { conn: a });
    expect(await avancarPasso('B', 'venda', { conn: b })).toBe(true);
    expect(b.estado.passo).toBe('venda');
  });

  test('passo inválido ou empresa vazia não toca no banco', async () => {
    const conn = fakeConn('cnpj');
    expect(await avancarPasso(CID, 'inexistente', { conn })).toBe(false);
    expect(await avancarPasso(CID, 'complete', { conn })).toBe(false); // apelido: nunca é gravado
    expect(await avancarPasso(null, 'venda', { conn })).toBe(false);
    expect(conn.query).not.toHaveBeenCalled();
  });

  test('erro do banco não lança, avisa uma vez e a próxima tentativa volta ao banco', async () => {
    const conn = { query: jest.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ rowCount: 1 }) };
    expect(await avancarPasso(CID, 'venda', { conn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await avancarPasso(CID, 'venda', { conn })).toBe(true);
    expect(conn.query).toHaveBeenCalledTimes(2);
  });

  test('o SQL recebe empresa, passo e posto nessa ordem', async () => {
    const conn = fakeConn('cnpj');
    await avancarPasso(CID, 'perfil', { conn });
    expect(conn.chamadas[0].sql).toBe(SQL_AVANCAR);
    expect(conn.chamadas[0].params).toEqual([CID, 'perfil', POSTO.perfil]);
  });
});

describe('avancarSemEsperar', () => {
  test('não lança nem devolve promessa pendurada para quem chama', () => {
    const db = require('../src/config/database');
    db.query.mockReset();
    db.query.mockRejectedValue(new Error('banco fora'));
    expect(avancarSemEsperar('C-sem-esperar', 'venda')).toBeUndefined();
  });
});
