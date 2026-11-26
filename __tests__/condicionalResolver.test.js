// ============================================================
// AURA. — Venda condicional (C16): pecas para resolver, sem banco
// services/condicionalResolver.js: leitura do corpo, nota da baixa, lista e
// a transacao com um client falso (travas, 409s, baixa, desfazer, repeticao).
// O banco de verdade esta em condicionalResolver.banco.test.js.
// ============================================================
'use strict';

const db = require('../src/config/database');
const c = require('../src/services/condicional');
const r = require('../src/services/condicionalResolver');

const COND = '11111111-2222-3333-4444-555555555555';
const LOJA = '99999999-8888-7777-6666-555555555555';
const I1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P = 'bbbbbbbb-0000-0000-0000-000000000001';
const V = 'dddddddd-0000-0000-0000-000000000001';
const HOJE = '2026-11-26';

describe('lerResolucao', () => {
  test('voltar_estoque nao pede motivo', () => {
    expect(r.lerResolucao({ acao: 'voltar_estoque', motivo: 'perda' })).toEqual({ acao: 'voltar_estoque', motivo: null, motivo_texto: null });
  });

  test('baixa pede um dos quatro motivos; "outro" pede o texto', () => {
    expect(r.lerResolucao({ acao: 'baixa', motivo: 'defeito' })).toEqual({ acao: 'baixa', motivo: 'defeito', motivo_texto: null });
    expect(r.lerResolucao({ acao: 'baixa', motivo: 'outro', motivo_texto: '  doada  ' }).motivo_texto).toBe('doada');
    expect(() => r.lerResolucao({ acao: 'baixa' })).toThrow(expect.objectContaining({ status: 422, code: 'COND_RESOLVER_MOTIVO' }));
    expect(() => r.lerResolucao({ acao: 'baixa', motivo: 'roubo' })).toThrow(expect.objectContaining({ code: 'COND_RESOLVER_MOTIVO' }));
    expect(() => r.lerResolucao({ acao: 'baixa', motivo: 'outro' })).toThrow(expect.objectContaining({ code: 'COND_RESOLVER_MOTIVO' }));
  });

  test('acao desconhecida ou ausente: 422', () => {
    expect(() => r.lerResolucao({})).toThrow(expect.objectContaining({ status: 422, code: 'COND_RESOLVER_ACAO' }));
    expect(() => r.lerResolucao({ acao: 'apagar' })).toThrow(expect.objectContaining({ code: 'COND_RESOLVER_ACAO' }));
  });
});

test('notaDaBaixa traz condicional, motivo e a anotacao da peca', () => {
  expect(r.notaDaBaixa({ numero: 31, motivo: 'defeito', defect_note: 'Fio puxado' }))
    .toBe('Baixa de peça da condicional C-0031 · Defeito · Anotação: Fio puxado');
  expect(r.notaDaBaixa({ numero: 31, motivo: 'outro', motivo_texto: 'Doada' }))
    .toBe('Baixa de peça da condicional C-0031 · Outro: Doada');
});

describe('listarParaResolver', () => {
  test('mapeia as linhas e conta; sem loja valida nao consulta', async () => {
    const q = { query: jest.fn(async () => ({ rows: [{
      item_id: I1, condicional_id: COND, company_id: LOJA, numero: 31, customer_name: 'Marina', status: 'encerrada',
      product_id: P, variant_id: V, product_name: 'Blusa', variant_label: 'Off-white · P', color_name: 'Off-white', size_label: 'P',
      defect_note: 'Fio puxado', decided_at: '2026-11-25T10:00:00Z', estoque: '4',
    }] })) };
    const out = await r.listarParaResolver(q, { empresas: [LOJA] });
    expect(out.total).toBe(1);
    expect(out.pecas[0]).toMatchObject({ item_id: I1, numero_exibicao: 'C-0031', customer_name: 'Marina', nota: 'Fio puxado', color_name: 'Off-white', size_label: 'P', estoque: 4 });
    expect(q.query.mock.calls[0][0]).toMatch(/resolved_at IS NULL/);
    const vazio = { query: jest.fn() };
    expect(await r.listarParaResolver(vazio, { empresas: ['x'] })).toEqual({ pecas: [], total: 0 });
    expect(vazio.query).not.toHaveBeenCalled();
  });
});

// ─── Transacao com client falso ───────────────────────────────

function clientFalso({ cond, itens, ja = null, estoque = 4, resolvido = null }) {
  const chamadas = [];
  return {
    chamadas,
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      chamadas.push({ sql, params });
      if (/FROM condicionais WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(sql)) return { rows: [{ ...cond }] };
      if (/dados->>'idempotency_key'/.test(sql)) return { rows: ja ? [ja] : [] };
      if (/FROM condicional_itens WHERE condicional_id = \$1/.test(sql)) return { rows: itens.map((i) => ({ ...i })) };
      if (/FROM products WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ company_id: LOJA, stock_qty: estoque }] };
      if (/FROM product_variants WHERE id = \$1/.test(sql)) return { rows: [{ stock_qty: estoque }] };
      if (/AS na_janela/.test(sql)) return { rows: [resolvido] };
      return { rows: [] };
    }),
  };
}

const item = (extra) => ({
  id: I1, product_id: P, variant_id: null, product_name: 'Blusa', variant_label: null, unit_price: '90',
  situacao: 'voltou_defeito', defect_note: 'Fio puxado', decided_at: new Date(), sale_id: null, resolved_at: null, ...(extra || {}),
});
const encerrada = { id: COND, company_id: LOJA, numero: 31, status: 'encerrada', due_date: HOJE };
const sqls = (cl) => cl.chamadas.map((x) => x.sql);
const eventos = (cl) => cl.chamadas.filter((x) => /INSERT INTO condicional_eventos/.test(x.sql)).map((x) => x.params[2]);
const gravou = (cl, re) => sqls(cl).some((s) => re.test(s));

beforeEach(() => {
  jest.spyOn(c, 'lerCondicionalCompleta').mockResolvedValue({ id: COND });
  db.query.mockImplementation(async () => ({ rows: [{ condicional_id: COND }] }));
});
afterEach(() => jest.restoreAllMocks());
const usar = (cl) => db.connect.mockImplementation(async () => cl);
const resolver = (extra) => r.resolverPeca({ companyId: LOJA, itemId: I1, userId: 'u1', hoje: HOJE, ...extra });

describe('voltar ao estoque', () => {
  test('so grava resolved_at/by/acao e o evento; estoque e condicional intactos (mesmo encerrada)', async () => {
    const cl = clientFalso({ cond: encerrada, itens: [item()] });
    usar(cl);
    const out = await resolver({ body: { acao: 'voltar_estoque' } });
    expect(out).toMatchObject({ repetido: false, item_id: I1, acao: 'voltar_estoque', desfazer_ate_s: r.JANELA_DESFAZER_S });
    expect(eventos(cl)).toEqual(['resolvida_voltou']);
    expect(gravou(cl, /SET resolved_at = NOW\(\), resolved_by = \$2, resolved_acao = \$3/)).toBe(true);
    expect(gravou(cl, /stock_movements|UPDATE products|UPDATE product_variants|SET status/)).toBe(false);
    // Travas na ordem do C9: condicional, depois os itens.
    const s = sqls(cl);
    const iCond = s.findIndex((x) => /FROM condicionais WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(x));
    const iItens = s.findIndex((x) => /FROM condicional_itens WHERE condicional_id = \$1/.test(x));
    expect(iItens).toBeGreaterThan(iCond);
    expect(s[s.length - 1]).toBe('COMMIT');
  });

  test('nao encerra condicional aberta so porque a peca foi resolvida', async () => {
    const cl = clientFalso({ cond: { ...encerrada, status: 'aberta' }, itens: [item()] });
    usar(cl);
    await resolver({ body: { acao: 'voltar_estoque' } });
    expect(gravou(cl, /SET status = 'encerrada'/)).toBe(false);
  });
});

describe('dar baixa', () => {
  test('baixa 1 unidade pelo ajuste (adjustment) com a nota do motivo, uma vez', async () => {
    const cl = clientFalso({ cond: encerrada, itens: [item()], estoque: 4 });
    usar(cl);
    const out = await resolver({ body: { acao: 'baixa', motivo: 'defeito' } });
    expect(out.desfazer_ate_s).toBeNull();
    expect(eventos(cl)).toEqual(['resolvida_baixa']);
    const baixa = cl.chamadas.filter((x) => /UPDATE products SET stock_qty = stock_qty - 1/.test(x.sql));
    expect(baixa).toHaveLength(1);
    const mov = cl.chamadas.find((x) => /INSERT INTO stock_movements/.test(x.sql));
    expect(mov.sql).toMatch(/'adjustment', 1, \$3, \$4, \$5, 'condicional_baixa'/);
    expect(mov.params).toEqual([P, LOJA, null, 'Baixa de peça da condicional C-0031 · Defeito · Anotação: Fio puxado', I1]);
  });

  test('variante baixa a variante, com variant_id no movimento', async () => {
    const cl = clientFalso({ cond: encerrada, itens: [item({ variant_id: V })] });
    usar(cl);
    await resolver({ body: { acao: 'baixa', motivo: 'perda' } });
    expect(gravou(cl, /UPDATE product_variants SET stock_qty = stock_qty - 1/)).toBe(true);
    expect(gravou(cl, /UPDATE products SET stock_qty/)).toBe(false);
    expect(cl.chamadas.find((x) => /INSERT INTO stock_movements/.test(x.sql)).params[2]).toBe(V);
  });

  test('estoque ja zerado: resolve sem movimento (piso 0)', async () => {
    const cl = clientFalso({ cond: encerrada, itens: [item()], estoque: 0 });
    usar(cl);
    await resolver({ body: { acao: 'baixa', motivo: 'perda' } });
    expect(gravou(cl, /INSERT INTO stock_movements/)).toBe(false);
    expect(gravou(cl, /SET resolved_at = NOW/)).toBe(true);
  });

  test('sem motivo: 422 antes de abrir a transacao', async () => {
    const cl = clientFalso({ cond: encerrada, itens: [item()] });
    usar(cl);
    await expect(resolver({ body: { acao: 'baixa' } })).rejects.toMatchObject({ status: 422, code: 'COND_RESOLVER_MOTIVO' });
    expect(cl.chamadas).toHaveLength(0);
  });
});

describe('409s e repeticao', () => {
  test('peca ja resolvida, cobrada ou que nao e defeito: 409 e nada gravado', async () => {
    for (const [extra, code] of [
      [{ resolved_at: new Date() }, 'COND_PECA_JA_RESOLVIDA'],
      [{ sale_id: 'cccccccc-0000-0000-0000-000000000001' }, 'COND_PECA_NAO_RESOLVER'],
      [{ situacao: 'voltou' }, 'COND_PECA_NAO_RESOLVER'],
    ]) {
      const cl = clientFalso({ cond: encerrada, itens: [item(extra)] });
      usar(cl);
      await expect(resolver({ body: { acao: 'baixa', motivo: 'perda' } })).rejects.toMatchObject({ status: 409, code });
      expect(sqls(cl)).toContain('ROLLBACK');
      expect(gravou(cl, /INSERT INTO stock_movements|SET resolved_at/)).toBe(false);
    }
  });

  test('mesma Idempotency-Key devolve a primeira resposta sem gravar de novo', async () => {
    const assinaturaDeVerdade = require('crypto').createHash('sha1')
      .update(JSON.stringify([I1, 'baixa', 'perda', null])).digest('hex').slice(0, 16);
    const cl = clientFalso({
      cond: encerrada, itens: [item({ resolved_at: new Date() })],
      ja: { op: 'resolver', assinatura: assinaturaDeVerdade, resposta: { item_id: I1, acao: 'baixa', desfazer_ate_s: null } },
    });
    usar(cl);
    const out = await resolver({ chave: 'k1', body: { acao: 'baixa', motivo: 'perda' } });
    expect(out).toMatchObject({ repetido: true, item_id: I1, acao: 'baixa' });
    expect(gravou(cl, /INSERT INTO stock_movements|SET resolved_at/)).toBe(false);
  });

  test('a mesma chave com outro corpo: 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const cl = clientFalso({ cond: encerrada, itens: [item()], ja: { op: 'resolver', assinatura: 'outra', resposta: {} } });
    usar(cl);
    await expect(resolver({ chave: 'k1', body: { acao: 'voltar_estoque' } })).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('peca que nao e da loja: 404', async () => {
    db.query.mockImplementation(async () => ({ rows: [] }));
    await expect(resolver({ body: { acao: 'voltar_estoque' } })).rejects.toMatchObject({ status: 404, code: 'COND_PECA_NAO_ENCONTRADA' });
    await expect(r.resolverPeca({ companyId: LOJA, itemId: 'x', body: { acao: 'voltar_estoque' } })).rejects.toMatchObject({ status: 404 });
  });
});

describe('desfazer', () => {
  const desfazer = () => r.desfazerResolucao({ companyId: LOJA, itemId: I1, userId: 'u1', hoje: HOJE });
  const resolvida = item({ resolved_at: new Date() });

  test('dentro da janela e sem mudanca: volta a para resolver', async () => {
    const cl = clientFalso({ cond: encerrada, itens: [resolvida], resolvido: { resolved_acao: 'voltar_estoque', na_janela: true, mudou: false } });
    usar(cl);
    await desfazer();
    expect(gravou(cl, /SET resolved_at = NULL, resolved_by = NULL, resolved_acao = NULL/)).toBe(true);
    expect(eventos(cl)).toEqual(['resolucao_desfeita']);
  });

  test('fora da janela ou com mudanca depois: 409 COND_DESFAZER_EXPIRADO', async () => {
    for (const estado of [{ na_janela: false, mudou: false }, { na_janela: true, mudou: true }]) {
      usar(clientFalso({ cond: encerrada, itens: [resolvida], resolvido: { resolved_acao: 'voltar_estoque', ...estado } }));
      await expect(desfazer()).rejects.toMatchObject({ status: 409, code: 'COND_DESFAZER_EXPIRADO' });
    }
  });

  test('baixa nao se desfaz; peca nao resolvida: 409', async () => {
    usar(clientFalso({ cond: encerrada, itens: [resolvida], resolvido: { resolved_acao: 'baixa', na_janela: true, mudou: false } }));
    await expect(desfazer()).rejects.toMatchObject({ status: 409, code: 'COND_DESFAZER_BAIXA' });
    usar(clientFalso({ cond: encerrada, itens: [item()] }));
    await expect(desfazer()).rejects.toMatchObject({ status: 409, code: 'COND_DESFAZER_NADA' });
  });
});
