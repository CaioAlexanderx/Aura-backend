// ============================================================
// AURA. — Check-in do prospect: regras puras (services/checkin.js)
//
//   1. parâmetros por variável de ambiente (interruptor, data de corte, limiar)
//   2. estado: quem vê a tela (habilitado) e o que o app lê
//   3. PUT: validação por chave, texto curto, sem enum
//   4. aplicar: carimbos do servidor e eventos de auditoria (uma vez cada)
// ============================================================
const c = require('../../src/services/checkin');

describe('parâmetros', () => {
  test('padrões: ligado, a partir da data de subida, limiar 0,57', () => {
    expect(c.configuracao({})).toEqual({ ligado: true, desde: '2026-10-16', limiar: 0.57, amostra: 15 });
  });

  test.each([['false'], ['0'], ['off'], ['NO'], [' False ']])('CHECKIN_ENABLED=%j desliga', (v) => {
    expect(c.configuracao({ CHECKIN_ENABLED: v }).ligado).toBe(false);
  });

  test.each([['true'], ['1'], [''], ['qualquer coisa']])('CHECKIN_ENABLED=%j segue ligado', (v) => {
    expect(c.configuracao({ CHECKIN_ENABLED: v }).ligado).toBe(true);
  });

  test('CHECKIN_DESDE válido vale; inválido volta ao padrão', () => {
    expect(c.configuracao({ CHECKIN_DESDE: '2026-11-02' }).desde).toBe('2026-11-02');
    expect(c.configuracao({ CHECKIN_DESDE: '2026-02-31' }).desde).toBe('2026-10-16');
    expect(c.configuracao({ CHECKIN_DESDE: 'ontem' }).desde).toBe('2026-10-16');
  });

  test('limiar: fração, porcentagem e vírgula; lixo volta a 0,57', () => {
    expect(c.limiarProduto24h({ CHECKIN_LIMIAR_PRODUTO_24H: '0.4' })).toBe(0.4);
    expect(c.limiarProduto24h({ CHECKIN_LIMIAR_PRODUTO_24H: '0,4' })).toBe(0.4);
    expect(c.limiarProduto24h({ CHECKIN_LIMIAR_PRODUTO_24H: '40' })).toBe(0.4);
    expect(c.limiarProduto24h({ CHECKIN_LIMIAR_PRODUTO_24H: '0' })).toBe(0.57);
    expect(c.limiarProduto24h({ CHECKIN_LIMIAR_PRODUTO_24H: '-1' })).toBe(0.57);
    expect(c.limiarProduto24h({ CHECKIN_LIMIAR_PRODUTO_24H: 'abc' })).toBe(0.57);
    expect(c.limiarProduto24h({ CHECKIN_LIMIAR_PRODUTO_24H: '150' })).toBe(0.57);
  });
});

describe('estado', () => {
  const cfg = { ligado: true, desde: '2026-10-16', limiar: 0.57, amostra: 15 };
  const novo = { created_at: '2026-10-16T12:00:00.000Z', checkin: null, eh_dojo: false };

  test('cadastro novo, sem resposta: habilitado, sem respostas', () => {
    expect(c.estado({ empresa: novo, config: cfg })).toEqual({
      habilitado: true, respondido: false, pulou: false, versao: 1, respostas: null,
    });
  });

  test('o dia de corte começa às 00h de Brasília', () => {
    const antes = { ...novo, created_at: '2026-10-16T02:59:59.000Z' }; // 23h59 de 15/10 em BRT
    const depois = { ...novo, created_at: '2026-10-16T03:00:00.000Z' };
    expect(c.estado({ empresa: antes, config: cfg }).habilitado).toBe(false);
    expect(c.estado({ empresa: depois, config: cfg }).habilitado).toBe(true);
  });

  test('conta anterior à subida não vê a tela', () => {
    expect(c.estado({ empresa: { ...novo, created_at: '2026-09-01T12:00:00.000Z' }, config: cfg }).habilitado).toBe(false);
  });

  test('interruptor desligado, staff e dojô: nunca habilitado', () => {
    expect(c.estado({ empresa: novo, config: { ...cfg, ligado: false } }).habilitado).toBe(false);
    expect(c.estado({ empresa: novo, config: cfg, staff: true }).habilitado).toBe(false);
    expect(c.estado({ empresa: { ...novo, eh_dojo: true }, config: cfg }).habilitado).toBe(false);
  });

  test('multi-CNPJ: filial de dono antigo e sede/dojô da federação ficam de fora (fora: true)', () => {
    expect(c.estado({ empresa: { ...novo, fora: false }, config: cfg }).habilitado).toBe(true);
    expect(c.estado({ empresa: { ...novo, fora: true }, config: cfg }).habilitado).toBe(false);
  });

  test('sqlForaDoCheckin: federação, billing_owner de outra empresa e dono com empresa mais antiga', () => {
    const sql = c.sqlForaDoCheckin('x');
    expect(sql).toContain('x.federation_id IS NOT NULL');
    expect(sql).toContain('x.billing_owner_company_id <> x.id');
    expect(sql).toContain('o_ck.owner_id = x.owner_id');
    expect(sql).toContain('(o_ck.created_at, o_ck.id) < (x.created_at, x.id)');
  });

  test('respondeu: respondido, com as três respostas, e não reaparece', () => {
    const empresa = {
      ...novo,
      checkin: { comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50', respondido_em: '2026-10-16T12:05:00.000Z', pulou: false },
    };
    expect(c.estado({ empresa, config: cfg })).toEqual({
      habilitado: false, respondido: true, pulou: false, versao: 1,
      respostas: { comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50' },
    });
  });

  test('pulou: não é respondido e não reaparece', () => {
    const empresa = { ...novo, checkin: { pulou: true, respondido_em: '2026-10-16T12:05:00.000Z' } };
    expect(c.estado({ empresa, config: cfg })).toEqual({
      habilitado: false, respondido: false, pulou: true, versao: 1, respostas: null,
    });
  });

  test('resposta parcial: respostas traz null nas chaves que faltam', () => {
    const empresa = { ...novo, checkin: { comeco: 'vender' } };
    expect(c.estado({ empresa, config: cfg }).respostas).toEqual({ comeco: 'vender', onde_anota: null, produtos_faixa: null });
  });

  test('como_chegou da equipe não vira "respondeu" nem muda a tela', () => {
    const empresa = { ...novo, checkin: { como_chegou: 'indicacao', fiado: 'sim' } };
    const e = c.estado({ empresa, config: cfg });
    expect(e.habilitado).toBe(true);
    expect(e.respostas).toBeNull();
  });
});

describe('normalizarPut', () => {
  test('aceita só as chaves do contrato, texto curto aparado', () => {
    expect(c.normalizarPut({ comeco: ' vender ', onde_anota: 'caderno' })).toEqual({ patch: { comeco: 'vender', onde_anota: 'caderno' }, semEfeito: false });
    expect(c.normalizarPut({ pulou: true })).toEqual({ patch: { pulou: true }, semEfeito: false });
  });

  test.each([
    ['corpo vazio', {}],
    ['corpo não é objeto', 'vender'],
    ['lista', [{ comeco: 'a' }]],
    ['chave da equipe', { como_chegou: 'indicacao' }],
    ['chave desconhecida', { comeco: 'a', outra: 'b' }],
    ['não é texto', { comeco: 3 }],
    ['vazio', { comeco: '   ' }],
    ['longo demais', { comeco: 'x'.repeat(41) }],
    ['pulou não booleano', { pulou: 'sim' }],
  ])('%s → erro', (_n, body) => {
    expect(c.normalizarPut(body).erro).toEqual(expect.any(String));
  });

  test('pulou:false sozinho é válido mas sem efeito; pulou:true e respostas têm efeito', () => {
    expect(c.normalizarPut({ pulou: false })).toEqual({ patch: { pulou: false }, semEfeito: true });
    expect(c.normalizarPut({ pulou: true }).semEfeito).toBe(false);
    expect(c.normalizarPut({ comeco: 'a', pulou: false }).semEfeito).toBe(false);
  });

  test('40 caracteres ainda valem', () => {
    expect(c.normalizarPut({ comeco: 'x'.repeat(40) }).patch.comeco).toHaveLength(40);
  });
});

describe('aplicar', () => {
  const t0 = new Date('2026-10-16T12:00:00.000Z');

  test('primeira resposta: carimba versão e respondido_em, evento respondido', () => {
    const r = c.aplicar(null, { comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50' }, t0);
    expect(r.checkin).toEqual({
      comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50',
      pulou: false, versao: 1, respondido_em: '2026-10-16T12:00:00.000Z',
    });
    expect(r.eventos).toEqual(['checkin.respondido']);
  });

  test('pular: pulou true, carimbo e evento pulou (sem respondido)', () => {
    const r = c.aplicar({ exibido_em: '2026-10-16T11:59:00.000Z' }, { pulou: true }, t0);
    expect(r.checkin).toMatchObject({ pulou: true, versao: 1, respondido_em: '2026-10-16T12:00:00.000Z', exibido_em: '2026-10-16T11:59:00.000Z' });
    expect(r.eventos).toEqual(['checkin.pulou']);
  });

  test('gravação parcial por chave preserva o resto e não repete o evento', () => {
    const primeira = c.aplicar(null, { comeco: 'vender' }, t0);
    expect(primeira.eventos).toEqual(['checkin.respondido']);
    const segunda = c.aplicar(primeira.checkin, { onde_anota: 'planilha' }, new Date('2026-10-16T12:01:00.000Z'));
    expect(segunda.checkin).toMatchObject({ comeco: 'vender', onde_anota: 'planilha', respondido_em: '2026-10-16T12:00:00.000Z' });
    expect(segunda.eventos).toEqual([]);
  });

  test('o servidor não deixa o cliente escolher o carimbo', () => {
    const r = c.aplicar(null, { comeco: 'vender', respondido_em: '1999-01-01', versao: 9 }, t0);
    expect(r.checkin.respondido_em).toBe('2026-10-16T12:00:00.000Z');
    expect(r.checkin.versao).toBe(1);
  });

  test('pular de novo não repete o evento; responder depois de pular limpa o pulou', () => {
    const pulado = c.aplicar(null, { pulou: true }, t0).checkin;
    expect(c.aplicar(pulado, { pulou: true }, t0).eventos).toEqual([]);
    const depois = c.aplicar(pulado, { comeco: 'vender' }, t0);
    expect(depois.checkin.pulou).toBe(false);
    expect(depois.eventos).toEqual(['checkin.respondido']);
  });

  test('pulou:false sem resposta não carimba nem fecha a tela', () => {
    const r = c.aplicar({ exibido_em: '2026-10-16T11:59:00.000Z' }, { pulou: false }, t0);
    expect(r.checkin).toEqual({ exibido_em: '2026-10-16T11:59:00.000Z' });
    expect(r.checkin).not.toHaveProperty('respondido_em');
    expect(r.eventos).toEqual([]);
    expect(c.aplicar(null, { pulou: false }, t0).checkin).toEqual({});
  });

  test('não mexe nas chaves da equipe', () => {
    const r = c.aplicar({ como_chegou: 'indicacao', fiado: 'sim' }, { comeco: 'vender' }, t0);
    expect(r.checkin).toMatchObject({ como_chegou: 'indicacao', fiado: 'sim' });
  });
});
