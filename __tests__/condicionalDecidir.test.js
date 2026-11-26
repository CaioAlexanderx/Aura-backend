// ============================================================
// AURA. — Venda condicional (C9): decidir as pecas, sem banco
// services/condicionalDecidir.js. Regras puras (corpo, prazo em SP,
// cancelar, encerrar) e a transacao com um client falso (ordem das travas,
// 409s, repeticao pela Idempotency-Key, encerramento). O banco de verdade
// esta em condicionalDecidir.banco.test.js.
// ============================================================
'use strict';

const db = require('../src/config/database');
const c = require('../src/services/condicional');
const d = require('../src/services/condicionalDecidir');

const COND = '11111111-2222-3333-4444-555555555555';
const LOJA = '99999999-8888-7777-6666-555555555555';
const I1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const I2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const P = 'bbbbbbbb-0000-0000-0000-000000000001';
const VENDA = 'cccccccc-0000-0000-0000-000000000001';
const HOJE = '2026-11-26';

describe('lerMarcacoes', () => {
  test('aceita items ou o proprio array; nota so no defeito', () => {
    const { marcacoes } = d.lerMarcacoes({ items: [
      { item_id: I1.toUpperCase(), situacao: 'voltou_defeito', defect_note: '  sem   etiqueta ' },
      { item_id: I2, situacao: 'voltou', defect_note: 'ignorada' },
    ] });
    expect(marcacoes).toEqual([
      { item_id: I1, situacao: 'voltou_defeito', defect_note: 'sem etiqueta' },
      { item_id: I2, situacao: 'voltou', defect_note: null },
    ]);
    expect(d.lerMarcacoes([{ item_id: I1, situacao: 'ficou' }]).marcacoes).toHaveLength(1);
  });

  test('recusa vazio, peca sem id, repetida e situacao desconhecida', () => {
    expect(d.lerMarcacoes({ items: [] }).erro.code).toBe('COND_SEM_PECAS');
    expect(d.lerMarcacoes({}).erro.code).toBe('COND_SEM_PECAS');
    expect(d.lerMarcacoes({ items: [{ item_id: 'x', situacao: 'voltou' }] }).erro.code).toBe('COND_ITEM_INVALIDO');
    expect(d.lerMarcacoes({ items: [{ item_id: I1, situacao: 'voltou' }, { item_id: I1, situacao: 'ficou' }] }).erro.code)
      .toBe('COND_ITEM_REPETIDO');
    expect(d.lerMarcacoes({ items: [{ item_id: I1, situacao: 'vendida' }] }).erro).toMatchObject({ status: 422, code: 'COND_SITUACAO' });
    expect(d.lerMarcacoes({ items: new Array(d.MAX_MARCACOES + 1).fill({ item_id: I1, situacao: 'voltou' }) }).erro.code)
      .toBe('COND_PECAS_DEMAIS');
  });
});

describe('lerPrazo (fuso de Sao Paulo)', () => {
  test('hoje vale, ontem nao, ate hoje + 30', () => {
    expect(d.lerPrazo({ due_date: HOJE }, { hoje: HOJE }).dueDate).toBe(HOJE);
    expect(d.lerPrazo({ due_date: '2026-11-25' }, { hoje: HOJE }).erro.code).toBe('COND_DATA');
    expect(d.lerPrazo({ due_date: '2026-12-26' }, { hoje: HOJE }).dueDate).toBe('2026-12-26');
    expect(d.lerPrazo({ due_date: '2026-12-27' }, { hoje: HOJE }).erro.code).toBe('COND_DATA');
    expect(d.lerPrazo({ due_date: '2026-02-30' }, { hoje: HOJE }).erro.code).toBe('COND_DATA');
    expect(d.lerPrazo({}, { hoje: HOJE }).erro.code).toBe('COND_DATA');
  });

  test('23h30 em SP (02h30 UTC do dia seguinte): hoje ainda e o dia de SP', () => {
    const agora = new Date('2026-11-27T02:30:00Z');
    expect(agora.toISOString().slice(0, 10)).toBe('2026-11-27');
    const hoje = c.hojeSP(agora);
    expect(hoje).toBe('2026-11-26');
    expect(d.lerPrazo({ due_date: '2026-11-26' }, { hoje }).dueDate).toBe('2026-11-26');
    expect(d.lerPrazo({ due_date: '2026-11-25' }, { hoje }).erro.code).toBe('COND_DATA');
    expect(d.lerPrazo({ due_date: '2026-12-26' }, { hoje }).dueDate).toBe('2026-12-26');
  });
});

describe('cancelar e encerrar (regras puras)', () => {
  test('cancelar so sem peca decidida', () => {
    expect(d.motivoParaNaoCancelar([{ situacao: 'com_cliente' }, { situacao: 'com_cliente' }])).toBeNull();
    expect(d.motivoParaNaoCancelar([{ situacao: 'com_cliente' }, { situacao: 'voltou' }]))
      .toMatchObject({ status: 409, code: 'COND_CANCELAR_DECIDIDA' });
    expect(d.motivoParaNaoCancelar([{ situacao: 'ficou' }]).message).toMatch(/Voltou/);
  });

  test('encerra sem peca com ela e sem "ficou" sem venda', () => {
    expect(d.podeEncerrar([{ situacao: 'voltou' }, { situacao: 'voltou_defeito' }])).toBe(true);
    expect(d.podeEncerrar([{ situacao: 'voltou' }, { situacao: 'ficou', sale_id: VENDA }])).toBe(true);
    expect(d.podeEncerrar([{ situacao: 'voltou' }, { situacao: 'ficou', sale_id: null }])).toBe(false);
    expect(d.podeEncerrar([{ situacao: 'com_cliente' }])).toBe(false);
  });

  test('a situacao derivada de "ficou sem venda e nada com ela" e a_cobrar', () => {
    const r = c.resumoDosItens([{ situacao: 'ficou', unit_price: 10 }, { situacao: 'voltou', unit_price: 5 }]);
    expect(c.derivarSituacao({ status: 'aberta', due_date: HOJE, com_cliente: r.com_cliente, decididas: 2 }, HOJE).situacao)
      .toBe('a_cobrar');
  });
});

// ─── Transacao com client falso ───────────────────────────────

function clientFalso({ cond, itens, ja = null }) {
  const chamadas = [];
  const client = {
    chamadas,
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      chamadas.push({ sql, params });
      if (/FROM condicionais WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(sql)) return { rows: cond ? [{ ...cond }] : [] };
      if (/dados->>'idempotency_key'/.test(sql)) return { rows: ja ? [ja] : [] };
      if (/FROM condicional_itens WHERE condicional_id = \$1/.test(sql)) return { rows: itens.map((i) => ({ ...i })) };
      if (/SELECT pdv_settings FROM companies/.test(sql)) return { rows: [{ pdv_settings: {} }] };
      return { rows: [] };
    }),
  };
  return client;
}

const item = (id, situacao, extra) => ({
  id, product_id: P, variant_id: null, product_name: 'Saia', variant_label: null, unit_price: '100',
  situacao, defect_note: null, decided_at: null, sale_id: null, resolved_at: null, ...(extra || {}),
});
const aberta = { id: COND, company_id: LOJA, numero: 31, status: 'aberta', due_date: HOJE };
const sqls = (client) => client.chamadas.map((x) => x.sql);
const eventos = (client) => client.chamadas.filter((x) => /INSERT INTO condicional_eventos/.test(x.sql)).map((x) => x.params[2]);

let lerCompleta;
let livres;
beforeEach(() => {
  lerCompleta = jest.spyOn(c, 'lerCondicionalCompleta').mockResolvedValue({ id: COND });
  livres = jest.spyOn(c, 'conferirLivres').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

function usar(client) { db.connect.mockImplementation(async () => client); }

describe('marcar pecas', () => {
  test('tudo voltou: trava a condicional antes dos itens, grava evento por peca e encerra (R6)', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente'), item(I2, 'com_cliente')] });
    usar(client);
    const r = await d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'voltou' }, { item_id: I2, situacao: 'voltou' }] }, hoje: HOJE });
    expect(r.repetido).toBe(false);
    const s = sqls(client);
    const iCond = s.findIndex((x) => /FROM condicionais WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(x));
    const iItens = s.findIndex((x) => /FROM condicional_itens WHERE condicional_id = \$1/.test(x) && /FOR UPDATE/.test(x));
    expect(iCond).toBeGreaterThan(0);
    expect(iItens).toBeGreaterThan(iCond);
    expect(eventos(client)).toEqual(['voltou', 'voltou', 'encerrada']);
    expect(s.some((x) => /SET status = 'encerrada'/.test(x))).toBe(true);
    expect(s[s.length - 1]).toBe('COMMIT');
    // Voltou nao passa pela conta do livre.
    expect(livres).not.toHaveBeenCalled();
    // R1: nada de venda, lancamento ou caixa.
    expect(s.some((x) => /INSERT INTO (sales|transactions|caixa_movimentos|stock_movements)/.test(x))).toBe(false);
  });

  test('ficou + voltou: segue aberta (falta cobrar)', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente'), item(I2, 'com_cliente')] });
    usar(client);
    await d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'ficou' }, { item_id: I2, situacao: 'voltou' }] }, hoje: HOJE });
    expect(eventos(client)).toEqual(['ficou', 'voltou']);
    expect(sqls(client).some((x) => /SET status = 'encerrada'/.test(x))).toBe(false);
  });

  test('peca ja cobrada nao muda: 409 e nada gravado', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'ficou', { sale_id: VENDA }), item(I2, 'com_cliente')] });
    usar(client);
    await expect(d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I2, situacao: 'voltou' }, { item_id: I1, situacao: 'voltou' }] }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_PECA_COBRADA', sale_id: VENDA, item_id: I1 });
    expect(eventos(client)).toEqual([]);
    expect(sqls(client)).toContain('ROLLBACK');
    expect(sqls(client).some((x) => /UPDATE condicional_itens/.test(x))).toBe(false);
  });

  test('peca resolvida (C16) nao muda', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'voltou_defeito', { resolved_at: new Date() }), item(I2, 'com_cliente')] });
    usar(client);
    await expect(d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'voltou' }] }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_PECA_RESOLVIDA' });
  });

  test('peca de outra condicional: 404', async () => {
    usar(clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente')] }));
    await expect(d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I2, situacao: 'voltou' }] }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 404, code: 'COND_PECA_NAO_ENCONTRADA' });
  });

  test('condicional encerrada ou cancelada: 409 COND_FECHADA', async () => {
    usar(clientFalso({ cond: { ...aberta, status: 'encerrada' }, itens: [item(I1, 'voltou')] }));
    await expect(d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'ficou' }] }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_FECHADA' });
    usar(clientFalso({ cond: { ...aberta, status: 'cancelada' }, itens: [item(I1, 'com_cliente')] }));
    await expect(d.cancelarCondicional({ companyId: LOJA, condId: COND, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_FECHADA' });
  });

  test('peca que tinha voltado e sai de novo passa pela conta do livre (sem saldo: 409)', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'voltou'), item(I2, 'com_cliente')] });
    usar(client);
    livres.mockResolvedValue([{ product_id: P, variant_id: null, nome: 'Saia', condicionais: [], reservado: 0, para_resolver: 0 }]);
    await expect(d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'com_cliente' }] }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_SEM_SALDO' });
    expect(livres).toHaveBeenCalledWith(client, LOJA, [{ product_id: P, variant_id: null, nome: 'Saia', variant_label: null }]);
    expect(sqls(client).some((x) => /pg_advisory_xact_lock/.test(x))).toBe(true);
  });

  test('voltou com defeito: nao passa pela conta do livre e guarda a nota', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente'), item(I2, 'com_cliente')] });
    usar(client);
    await d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'voltou_defeito', defect_note: 'Sem etiqueta' }] }, hoje: HOJE });
    const up = client.chamadas.find((x) => /UPDATE condicional_itens/.test(x.sql));
    expect(up.params.slice(0, 3)).toEqual([I1, 'voltou_defeito', 'Sem etiqueta']);
    expect(livres).not.toHaveBeenCalled();
    expect(eventos(client)).toEqual(['voltou_defeito']);
  });

  test('marcar de novo a mesma situacao nao grava nada', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'ficou'), item(I2, 'com_cliente')] });
    usar(client);
    await d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'ficou' }] }, hoje: HOJE });
    expect(eventos(client)).toEqual([]);
    expect(sqls(client).some((x) => /^\s*UPDATE/.test(x))).toBe(false);
  });
});

describe('Idempotency-Key', () => {
  test('a mesma chave e a mesma alteracao: repeticao, nada gravado', async () => {
    const body = { items: [{ item_id: I1, situacao: 'voltou' }] };
    // Assinatura gravada na primeira vez: a mesma que a repeticao calcula.
    const primeira = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente'), item(I2, 'com_cliente')] });
    usar(primeira);
    await d.marcarPecas({ companyId: LOJA, condId: COND, body, chave: 'chave-12345678', hoje: HOJE });
    const dados = JSON.parse(primeira.chamadas.find((x) => /INSERT INTO condicional_eventos/.test(x.sql)).params[4]);
    expect(dados).toMatchObject({ op: 'marcar', idempotency_key: 'chave-12345678' });

    const segunda = clientFalso({ cond: aberta, itens: [item(I1, 'voltou'), item(I2, 'com_cliente')], ja: { op: 'marcar', assinatura: dados.assinatura } });
    usar(segunda);
    const r = await d.marcarPecas({ companyId: LOJA, condId: COND, body, chave: 'chave-12345678', hoje: HOJE });
    expect(r.repetido).toBe(true);
    expect(eventos(segunda)).toEqual([]);
    expect(sqls(segunda).some((x) => /^\s*UPDATE/.test(x))).toBe(false);
    expect(lerCompleta).toHaveBeenCalled();
  });

  test('a mesma chave com outra alteracao: 409 IDEMPOTENCY_KEY_REUSED', async () => {
    usar(clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente')], ja: { op: 'marcar', assinatura: 'outra' } }));
    await expect(d.marcarPecas({ companyId: LOJA, condId: COND, body: { items: [{ item_id: I1, situacao: 'ficou' }] }, chave: 'chave-12345678', hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    usar(clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente')], ja: { op: 'cancelar', assinatura: null } }));
    await expect(d.tudoDevolvido({ companyId: LOJA, condId: COND, chave: 'chave-12345678', hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('tudo devolvido repetido depois de encerrar: 200 de repeticao, nao 409', async () => {
    usar(clientFalso({ cond: { ...aberta, status: 'encerrada' }, itens: [item(I1, 'voltou')], ja: { op: 'tudo_devolvido', assinatura: null } }));
    const r = await d.tudoDevolvido({ companyId: LOJA, condId: COND, chave: 'chave-12345678', hoje: HOJE });
    expect(r.repetido).toBe(true);
  });
});

describe('prazo, tudo devolvido e cancelar', () => {
  test('nova data grava evento nova_data; a mesma data nao grava', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente')] });
    usar(client);
    await d.mudarPrazo({ companyId: LOJA, condId: COND, body: { due_date: '2026-11-30' }, hoje: HOJE });
    expect(eventos(client)).toEqual(['nova_data']);
    const ev = client.chamadas.find((x) => /INSERT INTO condicional_eventos/.test(x.sql));
    expect(JSON.parse(ev.params[4])).toMatchObject({ de: HOJE, para: '2026-11-30' });

    const mesma = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente')] });
    usar(mesma);
    await d.mudarPrazo({ companyId: LOJA, condId: COND, body: { due_date: HOJE }, hoje: HOJE });
    expect(eventos(mesma)).toEqual([]);
  });

  test('nova data sem nada com ela (falta cobrar): 409', async () => {
    usar(clientFalso({ cond: aberta, itens: [item(I1, 'ficou')] }));
    await expect(d.mudarPrazo({ companyId: LOJA, condId: COND, body: { due_date: HOJE }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_NADA_COM_ELA' });
  });

  test('data fora do prazo: 422 antes de abrir transacao', async () => {
    db.connect.mockClear();
    await expect(d.mudarPrazo({ companyId: LOJA, condId: COND, body: { due_date: '2026-11-25' }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 422, code: 'COND_DATA' });
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('tudo devolvido: as com_cliente viram voltou e encerra (R10)', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente'), item(I2, 'voltou_defeito')] });
    usar(client);
    await d.tudoDevolvido({ companyId: LOJA, condId: COND, hoje: HOJE });
    const up = client.chamadas.find((x) => /UPDATE condicional_itens SET situacao = 'voltou'/.test(x.sql));
    expect(up.params[0]).toEqual([I1]);
    expect(eventos(client)).toEqual(['voltou', 'encerrada']);
  });

  test('tudo devolvido com peca "ficou" sem venda: 409', async () => {
    usar(clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente'), item(I2, 'ficou')] }));
    await expect(d.tudoDevolvido({ companyId: LOJA, condId: COND, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_TEM_FICOU' });
  });

  test('cancelar: so sem peca decidida', async () => {
    const client = clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente')] });
    usar(client);
    await d.cancelarCondicional({ companyId: LOJA, condId: COND, body: { reason: 'Abri na cliente errada' }, hoje: HOJE });
    const up = client.chamadas.find((x) => /SET status = 'cancelada'/.test(x.sql));
    expect(up.params).toEqual([COND, 'Abri na cliente errada']);
    expect(eventos(client)).toEqual(['cancelada']);
    expect(sqls(client).some((x) => /SET status = 'encerrada'/.test(x))).toBe(false);

    usar(clientFalso({ cond: aberta, itens: [item(I1, 'com_cliente'), item(I2, 'voltou')] }));
    await expect(d.cancelarCondicional({ companyId: LOJA, condId: COND, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'COND_CANCELAR_DECIDIDA' });
  });

  test('condicional que nao e da loja: 404', async () => {
    usar(clientFalso({ cond: null, itens: [] }));
    await expect(d.tudoDevolvido({ companyId: LOJA, condId: COND, hoje: HOJE }))
      .rejects.toMatchObject({ status: 404, code: 'COND_NAO_ENCONTRADA' });
    await expect(d.tudoDevolvido({ companyId: LOJA, condId: 'nao-e-uuid', hoje: HOJE }))
      .rejects.toMatchObject({ status: 404, code: 'COND_NAO_ENCONTRADA' });
  });
});

describe('livre desconta as pecas para resolver', () => {
  test('frase da falta quando a unidade esta em Pecas para resolver', () => {
    expect(c.fraseDaFalta({ nome: 'Saia', condicionais: [], reservado: 0, para_resolver: 1 }))
      .toBe('"Saia": a unidade que sobrou está em Peças para resolver.');
  });
});
