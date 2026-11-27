// ============================================================
// AURA. — Conferencia x "com clientes": pendencias do C14 (migration 475)
// Servico direto, conexao falsa (sem banco). O que este arquivo trava:
//   1. sem piso: sistema < com clientes aparece negativo + `inconsistente`;
//      aplicar recusa o item (409 ITENS_COM_AVISO) e nao grava ajuste
//   2. rascunho de antes da trava (com_clientes_no_bipe NULL): `contagem_antiga`
//      nas diferencas; aplicar recusa; desmarcar o item deixa aplicar; contar
//      de novo refaz o snapshot
//   3. regressao: sem a trava (ou sem peca fora) nenhum campo novo, nenhuma
//      consulta nova e o aplicar e o de sempre
// ============================================================
'use strict';

const svc = require('../src/services/conferenciaDeEstoque');

const LOJA = '11111111-1111-4111-8111-111111111111';
const CONT = '44444444-4444-4444-8444-444444444444';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM = 'dddddddd-0000-4000-8000-000000000001';

const conferencia = (extra = {}) => ({
  id: CONT, company_id: LOJA, numero: 3, status: 'rascunho', escopo: { tipo: 'loja_toda' }, as_cegas: false,
  motivo: null, criada_em: '2026-11-11T10:00:00Z', criada_por: 'dono', criada_por_nome: 'Dono',
  aplicada_em: null, aplicada_por: null, desfeita_em: null, desfeita_por: null, zerou_nao_contados: false,
  pode_desfazer_ate: null, dentro_do_prazo: false, ...extra,
});

/**
 * Conexao falsa. `estoque`: stock_qty do produto; `fora`: pecas com clientes;
 * `marca`: valor de com_clientes_no_bipe (undefined = coluna inexistente).
 */
function conn({ estoque = 10, fora = 0, marca = undefined, contado = 8, noBipe = 10, escopo = [] } = {}) {
  const chamadas = [];
  const temColuna = marca !== undefined;
  const item = {
    id: ITEM, product_id: P1, variant_id: null, contado, estoque_no_bipe: noBipe, custo_no_bipe: null,
    contado_em: 'x', atualizado_em: 'x', diferenca_aplicada: null, diferenca_desfeita: null, nao_contado: false,
    nome: 'Blusa', barcode: '789', sku: null, v_barcode: null, sku_suffix: null, color_name: null, estoque_atual: estoque,
    ...(temColuna ? { com_clientes_no_bipe: marca } : {}),
  };
  return {
    chamadas,
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      chamadas.push({ sql: s, params });
      if (/FROM stock_counts c/.test(s)) return { rows: [conferencia()] };
      if (/AS tem_grade/.test(s)) return { rows: [{ id: P1, company_id: LOJA, name: 'Blusa', is_active: true, unit: 'un', stock_qty: String(estoque), custo: null, tem_grade: false, v_id: null }] };
      if (/information_schema\.columns/.test(s) && /com_clientes_no_bipe/.test(s)) return { rows: temColuna ? [{ '?column?': 1 }] : [] };
      if (/FROM stock_count_items i\s+JOIN products p/.test(s)) return { rows: [item] };
      if (/FROM stock_count_items WHERE stock_count_id = \$1 AND NOT nao_contado/.test(s)) return { rows: [item] };
      if (/condicional_itens/.test(s)) return { rows: fora > 0 ? [{ product_id: P1, variant_id: null, qtd: String(fora) }] : [] };
      if (/FROM products\s+WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2\s+ORDER BY id FOR UPDATE/.test(s)
        || /SELECT id, stock_qty, is_active FROM products/.test(s)) {
        return { rows: [{ id: P1, stock_qty: String(estoque), is_active: true }] };
      }
      if (/FROM products p\b/.test(s) && /stock_qty/.test(s) && escopo) return { rows: escopo };
      return { rows: [] };
    }),
  };
}

const gravou = (c) => c.chamadas.some((x) => /UPDATE products|UPDATE product_variants|INSERT INTO stock_movements/.test(x.sql));

describe('esperado sem piso', () => {
  test('esperadoDe nao corta em 0: sistema menor que com clientes fica negativo', () => {
    expect(svc.esperadoDe(1, 3)).toBe(-2);
    expect(svc.esperadoDe(10, 2)).toBe(8);
    expect(svc.esperadoDe(10, 0)).toBe(10);
    expect(svc.esperadoDe(-2, 0)).toBe(-2);
  });
  test('inconsistenteDe', () => {
    expect(svc.inconsistenteDe(1, 3)).toBe(true);
    expect(svc.inconsistenteDe(3, 3)).toBe(false);
    expect(svc.inconsistenteDe(0, 0)).toBe(false);
    expect(svc.inconsistenteDe(-1, 0)).toBe(false); // sem peca fora, como sempre foi
  });
});

describe('diferencas: aviso de inconsistencia', () => {
  beforeEach(() => svc._resetMarca());

  test('estoque 1, com clientes 3: mostra -2, com aviso, e conta no resumo', async () => {
    const c = conn({ estoque: 1, fora: 3, marca: 3, contado: 0, noBipe: 1 });
    const out = await svc.diferencas(c, LOJA, CONT, { comCondicional: true });
    expect(out.itens[0]).toMatchObject({ estoque_atual: -2, com_clientes: 3, inconsistente: true });
    expect(out.itens[0].aviso).toMatch(/menor que as peças com clientes/);
    expect(out.resumo.com_aviso).toBe(1);
  });

  test('rascunho antigo (marca NULL) com peca fora: contagem_antiga', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: null, contado: 8, noBipe: 10 });
    const out = await svc.diferencas(c, LOJA, CONT, { comCondicional: true });
    expect(out.itens[0]).toMatchObject({ contagem_antiga: true });
    expect(out.itens[0].inconsistente).toBeUndefined();
    expect(out.resumo.com_aviso).toBe(1);
  });

  test('regressao: sem a trava nenhum campo novo e nenhuma consulta nova', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: null, contado: 8, noBipe: 10 });
    const out = await svc.diferencas(c, LOJA, CONT, { comCondicional: false });
    expect(out.itens[0].aviso).toBeUndefined();
    expect(out.itens[0].inconsistente).toBeUndefined();
    expect(out.itens[0].contagem_antiga).toBeUndefined();
    expect(out.itens[0].com_clientes).toBeUndefined();
    expect(out.resumo.com_aviso).toBeUndefined();
    expect(c.chamadas.some((x) => /condicional_itens|com_clientes_no_bipe/.test(x.sql))).toBe(false);
  });

  test('com a trava mas ninguem com peca fora: sem aviso, mesma forma de antes', async () => {
    const c = conn({ estoque: 10, fora: 0, marca: null });
    const out = await svc.diferencas(c, LOJA, CONT, { comCondicional: true });
    expect(out.itens[0].aviso).toBeUndefined();
    expect(out.resumo.com_aviso).toBeUndefined();
  });
});

describe('aplicar', () => {
  beforeEach(() => svc._resetMarca());

  test('estoque menor que com clientes: 409 ITENS_COM_AVISO e nada gravado', async () => {
    const c = conn({ estoque: 1, fora: 3, marca: 3, contado: 0, noBipe: -2 });
    await expect(svc.aplicar(c, { companyId: LOJA, countId: CONT, userId: 'u', comCondicional: true }))
      .rejects.toMatchObject({ status: 409, code: 'ITENS_COM_AVISO', extra: { itens: [expect.objectContaining({ item_id: ITEM, motivo: 'estoque_menor_que_com_clientes' })] } });
    expect(gravou(c)).toBe(false);
  });

  test('rascunho antigo (marca NULL) com peca fora: 409 contagem_antiga e nada gravado', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: null, contado: 8, noBipe: 10 });
    await expect(svc.aplicar(c, { companyId: LOJA, countId: CONT, userId: 'u', comCondicional: true }))
      .rejects.toMatchObject({ status: 409, code: 'ITENS_COM_AVISO', extra: { itens: [expect.objectContaining({ motivo: 'contagem_antiga' })] } });
    expect(gravou(c)).toBe(false);
  });

  test('item desmarcado nao trava o aplicar', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: null });
    const out = await svc.aplicar(c, { companyId: LOJA, countId: CONT, userId: 'u', comCondicional: true, ignorarItemIds: [ITEM] });
    expect(out.ignorados).toEqual([{ item_id: ITEM, motivo: 'desmarcado' }]);
  });

  test('item contado depois da trava (marca = 2) aplica normal', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: 2, contado: 7, noBipe: 8 });
    const out = await svc.aplicar(c, { companyId: LOJA, countId: CONT, userId: 'u', comCondicional: true });
    expect(out.ajustados).toBe(1);
    expect(out.ignorados).toEqual([]);
  });

  test('regressao: sem a trava aplica como sempre, sem consultar com clientes', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: null, contado: 8, noBipe: 10 });
    const out = await svc.aplicar(c, { companyId: LOJA, countId: CONT, userId: 'u', comCondicional: false });
    expect(out.ajustados).toBe(1);
    expect(c.chamadas.some((x) => /condicional_itens|com_clientes_no_bipe/.test(x.sql))).toBe(false);
  });

  test('base sem a coluna da 475: com a trava, item sem marca nao e tratado como antigo', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: undefined, contado: 8, noBipe: 8 });
    const out = await svc.aplicar(c, { companyId: LOJA, countId: CONT, userId: 'u', comCondicional: true });
    expect(out.ignorados).toEqual([]);
  });
});

describe('registrarItem: contar de novo refaz o snapshot do item antigo', () => {
  beforeEach(() => svc._resetMarca());

  test('com a coluna, o UPSERT grava a marca e so troca o snapshot de quem tem marca NULL', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: null });
    await svc.registrarItem(c, { companyId: LOJA, countId: CONT, productId: P1, variantId: null, quantidade: 8, modo: 'definir', comCondicional: true })
      .catch(() => {});
    const ins = c.chamadas.find((x) => /INSERT INTO stock_count_items/.test(x.sql));
    expect(ins).toBeDefined();
    expect(ins.sql).toMatch(/com_clientes_no_bipe/);
    expect(ins.sql).toMatch(/CASE WHEN stock_count_items\.com_clientes_no_bipe IS NULL THEN EXCLUDED\.estoque_no_bipe/);
    expect(ins.params[9]).toBe(2);
  });

  test('regressao: sem a trava o INSERT e o de antes (sem a coluna nova)', async () => {
    const c = conn({ estoque: 10, fora: 2, marca: null });
    await svc.registrarItem(c, { companyId: LOJA, countId: CONT, productId: P1, variantId: null, quantidade: 8, modo: 'definir', comCondicional: false })
      .catch(() => {});
    const ins = c.chamadas.find((x) => /INSERT INTO stock_count_items/.test(x.sql));
    expect(ins).toBeDefined();
    expect(ins.sql).not.toMatch(/com_clientes_no_bipe/);
    expect(ins.params).toHaveLength(9);
  });
});
