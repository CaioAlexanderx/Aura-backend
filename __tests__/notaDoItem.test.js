// ============================================================
// AURA. — O item escolhe a nota: "Sai em" NFC-e ou NFS-e (migration 442)
//
// Trava:
//   1. vaiNaNfse/vaiNaNfce: os quatro casos (produto/servico x nulo/escolha);
//   2. lerNotaFiscal: o que o POST/PATCH aceita e a mensagem do 400;
//   3. emissao automatica da NFS-e: produto com nota_fiscal 'nfse' entra na
//      NFS-e da venda e da OS; servico com 'nfce' fica de fora; nulo = hoje;
//   4. repo: SELECT traz nota_fiscal e, na base sem a 442, cai um degrau
//      sem perder as colunas fiscais da 437.
// Banco em memoria no lugar do nfseAutomaticaRepo (mesmo desenho de
// __tests__/nfseAutomatica.test.js).
// ============================================================
'use strict';

const mockMem = {
  cfg: new Map(), vendas: new Map(), itensVenda: new Map(), oss: new Map(), itensOs: new Map(),
  clientes: new Map(), regs: new Map(), notas: new Map(), seq: 0,
};

jest.mock('../src/services/nfseAutomaticaRepo', () => {
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const comNota = (r) => {
    if (!r) return null;
    const n = r.nfse_id ? mockMem.notas.get(r.nfse_id) : null;
    return { ...clone(r), nfse_status: n ? n.status : null, nfse_number: n ? n.nfse_number : null, nfse_motivo: n ? n.rejection_reason : null };
  };
  const achar = (c, t, o, k) => [...mockMem.regs.values()].find((r) => r.company_id === c && r.origem_tipo === t && r.origem_id === o && r.ctribnac === k);
  return {
    schemaAusente: (e) => !!(e && (e.code === '42703' || e.code === '42P01')),
    carregarConfig: jest.fn(async (c) => clone(mockMem.cfg.get(c) || null)),
    buscarVenda: jest.fn(async (c, id) => { const v = mockMem.vendas.get(id); return v && v.company_id === c ? clone(v) : null; }),
    itensDaVenda: jest.fn(async (c, id) => clone(mockMem.itensVenda.get(id) || [])),
    buscarOs: jest.fn(async (c, id) => { const o = mockMem.oss.get(id); return o && o.company_id === c ? clone(o) : null; }),
    itensDaOs: jest.fn(async (c, id) => clone(mockMem.itensOs.get(id) || [])),
    vendasDasParcelas: jest.fn(async () => []),
    buscarCliente: jest.fn(async (id) => clone(mockMem.clientes.get(id) || null)),
    buscarRegistro: jest.fn(async (id) => comNota(mockMem.regs.get(id))),
    reivindicar: jest.fn(async (p) => {
      const ex = achar(p.companyId, p.origemTipo, p.origemId, p.ctribnac);
      if (ex) return { row: comNota(ex), criado: false };
      const id = `reg-${++mockMem.seq}`;
      mockMem.regs.set(id, {
        id, company_id: p.companyId, origem_tipo: p.origemTipo, origem_id: p.origemId, ctribnac: p.ctribnac,
        gatilho: p.gatilho, status: 'emitindo', tentativa: 1, itens: p.itens, valor: p.valor,
        customer_id: p.customerId, vinculos: [], tomador: null, nota: null, nfse_id: null,
        idempotency_key: null, updated_at: new Date().toISOString(),
      });
      return { row: comNota(mockMem.regs.get(id)), criado: true };
    }),
    retomar: jest.fn(async () => null),
    anotarVinculo: jest.fn(async (id, v) => { mockMem.regs.get(id).vinculos.push(v); }),
    gravar: jest.fn(async (id, campos) => {
      const r = mockMem.regs.get(id);
      for (const [k, v] of Object.entries(campos)) if (v !== undefined) r[k] = clone(v);
    }),
    removerSemCodigo: jest.fn(async () => {}),
    ligarNotaAOrigem: jest.fn(async () => {}),
    notaPorChave: jest.fn(async () => null),
    listarPorOrigens: jest.fn(async () => []),
  };
});

jest.mock('../src/services/nfseNacional', () => ({
  emitir: jest.fn(),
  danfse: jest.fn(),
  fingerprint: () => 'x',
}));

const nacional = require('../src/services/nfseNacional');
const auto = require('../src/services/nfseAutomatica');
const { vaiNaNfse, vaiNaNfce, lerNotaFiscal, notaFiscalOut, MSG_NOTA } = require('../src/services/notaDoItem');

const C1 = '11111111-1111-4111-8111-111111111111';
const VENDA = '22222222-2222-4222-8222-222222222222';
const OS = '33333333-3333-4333-8333-333333333333';
const CLI = '44444444-4444-4444-8444-444444444444';
const CPF = '52998224725';

let fila = [];
async function rodarFila() { while (fila.length) await fila.shift()(); }

const ITEM = (id, valor, extra) => ({ id, product_id: `p-${id}`, quantity: 1, total_price: valor, product_name_snapshot: `Item ${id}`, ...extra });
function venda(itens, total) {
  mockMem.vendas.set(VENDA, { id: VENDA, company_id: C1, customer_id: CLI, status: 'completed', type: 'sale', total_amount: total, created_at: '2026-11-10T13:00:00Z', nfse_tomador: null });
  mockMem.itensVenda.set(VENDA, itens);
}

beforeEach(() => {
  for (const k of ['cfg', 'vendas', 'itensVenda', 'oss', 'itensOs', 'clientes', 'regs', 'notas']) mockMem[k].clear();
  mockMem.seq = 0;
  jest.clearAllMocks();
  process.env.NFSE_AUTOMATICA_ENABLED = 'true';
  fila = [];
  auto._setAgendador((fn) => fila.push(fn));
  mockMem.cfg.set(C1, { company_id: C1, provider: 'nacional', is_active: true, ctribnac_padrao: '010501', cnbs_padrao: null, emissao_automatica: true, emissao_automatica_desde: '2026-11-01T00:00:00Z' });
  mockMem.clientes.set(CLI, { id: CLI, name: 'Maria', full_name: 'Maria Souza', cpf_cnpj: CPF });
  nacional.emitir.mockImplementation(async (_db, { companyId, idempotencyKey, nota }) => {
    const id = `nfse-${mockMem.notas.size + 1}`;
    const n = { id, company_id: companyId, idempotency_key: idempotencyKey, status: 'autorizada', nfse_number: '1', nota };
    mockMem.notas.set(id, n);
    return { nota: n };
  });
});

afterAll(() => {
  delete process.env.NFSE_AUTOMATICA_ENABLED;
  auto._setAgendador(null);
});

describe('vaiNaNfse / vaiNaNfce', () => {
  test.each([
    ['produto, nulo', { unit: 'un', nota_fiscal: null }, false],
    ['servico, nulo', { unit: 'srv', nota_fiscal: null }, true],
    ['produto, NFS-e', { unit: 'un', nota_fiscal: 'nfse' }, true],
    ['servico, NFC-e', { unit: 'srv', nota_fiscal: 'nfce' }, false],
    ['servico sem a coluna (undefined)', { unit: 'SRV' }, true],
    ['produto sem unidade', { unit: null }, false],
    ['valor estranho conta como nulo', { unit: 'un', nota_fiscal: 'xyz' }, false],
  ])('%s', (_n, item, esperado) => {
    expect(vaiNaNfse(item)).toBe(esperado);
    expect(vaiNaNfce(item)).toBe(!esperado);
  });

  test('item nulo: NFC-e', () => {
    expect(vaiNaNfse(null)).toBe(false);
    expect(vaiNaNfce(undefined)).toBe(true);
  });
});

describe('lerNotaFiscal', () => {
  test.each([
    [{}, { presente: false }],
    [{ nota_fiscal: 'nfse' }, { presente: true, value: 'nfse' }],
    [{ nota_fiscal: 'NFC-e' }, { presente: true, value: 'nfce' }],
    [{ notaFiscal: ' NFS-e ' }, { presente: true, value: 'nfse' }],
    [{ nota_fiscal: null }, { presente: true, value: null }],
    [{ nota_fiscal: '' }, { presente: true, value: null }],
    [{ nota_fiscal: 'nfe' }, { presente: true, erro: MSG_NOTA }],
    [{ nota_fiscal: 1 }, { presente: true, erro: MSG_NOTA }],
  ])('%j', (body, esperado) => {
    expect(lerNotaFiscal(body)).toEqual(esperado);
  });

  test('notaFiscalOut', () => {
    expect([notaFiscalOut('nfse'), notaFiscalOut('nfce'), notaFiscalOut(null), notaFiscalOut(undefined), notaFiscalOut('x')])
      .toEqual(['nfse', 'nfce', null, null, null]);
  });
});

describe('emissao automatica da NFS-e', () => {
  test('produto com nota_fiscal nfse entra na NFS-e da venda; produto nulo fica fora', async () => {
    venda([
      ITEM('carimbo', 30, { unit: 'un', nota_fiscal: 'nfse', product_name_snapshot: 'Carimbo' }),
      ITEM('caneta', 10, { unit: 'un', nota_fiscal: null }),
    ], 40);
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota).toMatchObject({ valor: 30, descricao: 'Carimbo' });
  });

  test('servico com nota_fiscal nfce fica fora da NFS-e', async () => {
    venda([ITEM('impressao', 25, { unit: 'srv', nota_fiscal: 'nfce' })], 25);
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
  });

  test('nulo mantem a regra de hoje: servico (srv) na NFS-e, mesmo sem a coluna na linha', async () => {
    venda([ITEM('ajuste', 40, { unit: 'srv', product_name_snapshot: 'Ajuste' }), ITEM('meia', 10, { unit: 'un' })], 50);
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota).toMatchObject({ valor: 40, descricao: 'Ajuste' });
  });

  test('OS: peca com nota_fiscal nfse entra; mao de obra (kind servico) segue entrando', async () => {
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: auto.STATUS_OS_QUE_EMITE, sale_id: null, delivered_at: '2026-11-10T15:00:00Z' });
    mockMem.itensOs.set(OS, [
      { id: 'i1', kind: 'servico', description: 'Montagem', quantity: 1, total_price: 20, unit: null },
      { id: 'i2', kind: 'peca', description: 'Carimbo', quantity: 1, total_price: 30, unit: 'un', nota_fiscal: 'nfse' },
      { id: 'i3', kind: 'peca', description: 'Almofada', quantity: 1, total_price: 15, unit: 'un', nota_fiscal: null },
    ]);
    auto.aoConcluirOs({ companyId: C1, osId: OS });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota).toMatchObject({ valor: 50 });
  });

  test('OS ligada a venda cujo unico item NFS-e e produto: a prestacao e a da venda', async () => {
    venda([ITEM('carimbo', 30, { unit: 'un', nota_fiscal: 'nfse' })], 30);
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: auto.STATUS_OS_QUE_EMITE, sale_id: VENDA, delivered_at: '2026-11-10T15:00:00Z' });
    mockMem.itensOs.set(OS, []);
    auto.aoConcluirOs({ companyId: C1, osId: OS });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-1`);
  });
});

describe('situacaoDaOrigem (botao "Emitir NFS-e"): tem_servico pelo predicado', () => {
  test('venda so do produto NFS-e tem servico; servico NFC-e nao', async () => {
    venda([ITEM('carimbo', 30, { unit: 'un', nota_fiscal: 'nfse' })], 30);
    expect(await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA })).toMatchObject({ tem_servico: true });
    venda([ITEM('impressao', 25, { unit: 'srv', nota_fiscal: 'nfce' })], 25);
    expect(await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA })).toMatchObject({ tem_servico: false });
  });

  test('OS ligada a venda com produto NFS-e tem servico', async () => {
    venda([ITEM('carimbo', 30, { unit: 'un', nota_fiscal: 'nfse' })], 30);
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: auto.STATUS_OS_QUE_EMITE, sale_id: VENDA });
    mockMem.itensOs.set(OS, [{ id: 'i1', kind: 'peca', description: 'Almofada', quantity: 1, total_price: 5, unit: 'un' }]);
    expect(await auto.situacaoDaOrigem({ companyId: C1, tipo: 'os', id: OS })).toMatchObject({ tem_servico: true });
  });
});

describe('nfseAutomaticaRepo: SELECT com nota_fiscal', () => {
  const realRepo = () => jest.requireActual('../src/services/nfseAutomaticaRepo');
  const erro = (msg) => Object.assign(new Error(msg), { code: '42703' });
  let db;
  beforeEach(() => {
    db = require('../src/config/database');
    db.query.mockReset();
    realRepo()._resetCache();
  });

  test('traz p.nota_fiscal junto com as colunas fiscais', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'i1', unit: 'un', nota_fiscal: 'nfse' }] });
    const rows = await realRepo().itensDaVenda('c1', 's1');
    expect(rows).toEqual([{ id: 'i1', unit: 'un', nota_fiscal: 'nfse' }]);
    expect(db.query.mock.calls[0][0]).toMatch(/p\.nfse_ctribnac[\s\S]*p\.nota_fiscal/);
  });

  test('base sem a 442: cai para as fiscais (437) e nao pergunta de novo', async () => {
    db.query
      .mockRejectedValueOnce(erro('column p.nota_fiscal does not exist'))
      .mockResolvedValueOnce({ rows: [{ id: 'i1', unit: 'srv' }] })
      .mockResolvedValueOnce({ rows: [] });
    await realRepo().itensDaVenda('c1', 's1');
    expect(db.query.mock.calls[1][0]).toMatch(/p\.nfse_ctribnac/);
    expect(db.query.mock.calls[1][0]).not.toMatch(/nota_fiscal/);
    await realRepo().itensDaOs('c1', 'o1');
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[2][0]).toMatch(/p\.nfse_ctribnac/);
    expect(db.query.mock.calls[2][0]).not.toMatch(/nota_fiscal/);
  });
});
