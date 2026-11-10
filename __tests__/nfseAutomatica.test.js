// ============================================================
// AURA. — Emissão automática da NFS-e (migration 438)
//
// Banco em memória no lugar do nfseAutomaticaRepo (mesmo desenho dos testes
// do nfseNacional) e emissor nacional trocado por um jest.fn. Cobre:
//   - cada gatilho (venda, OS entregue, recebimento) emite uma vez;
//   - o segundo gatilho da mesma prestação não emite de novo (só vínculo);
//   - sem CPF/CNPJ → pendente_dados com motivo; completar emite;
//   - venda sem serviço → nada; flag ou opt-in desligados → nada;
//   - uma nota por código de tributação, descrição concatenada;
//   - serviço sem código → problema SEM_CODIGO, nada sai; com código, sai;
//   - falha do emissor vira registro 'erro', nunca exceção no gatilho;
//   - rejeitada não reemite sozinha; "tentar de novo" usa chave nova;
//   - rotas: situação da origem, completar e 2ª via.
// ============================================================
'use strict';

const mockMem = {
  cfg: new Map(), vendas: new Map(), itensVenda: new Map(), oss: new Map(), itensOs: new Map(),
  parcelas: new Map(), clientes: new Map(), regs: new Map(), notas: new Map(), seq: 0,
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
    gravarOptIn: jest.fn(async (c, v) => { const cfg = mockMem.cfg.get(c); cfg.emissao_automatica = v; return clone(cfg); }),
    buscarVenda: jest.fn(async (c, id) => { const v = mockMem.vendas.get(id); return v && v.company_id === c ? clone(v) : null; }),
    itensDaVenda: jest.fn(async (c, id) => clone(mockMem.itensVenda.get(id) || [])),
    buscarOs: jest.fn(async (c, id) => { const o = mockMem.oss.get(id); return o && o.company_id === c ? clone(o) : null; }),
    itensDaOs: jest.fn(async (c, id) => clone(mockMem.itensOs.get(id) || [])),
    vendasDasParcelas: jest.fn(async (c, ids) => [...new Set(ids.map((i) => mockMem.parcelas.get(i)).filter(Boolean))]),
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
    retomar: jest.fn(async (id, { de = [], staleSeg = 0, novaTentativa = false }) => {
      const r = mockMem.regs.get(id);
      const parado = staleSeg > 0 && r.status === 'emitindo' && Date.now() - new Date(r.updated_at).getTime() > staleSeg * 1000;
      if (!de.includes(r.status) && !parado) return null;
      r.status = 'emitindo'; r.motivo = null; r.motivo_codigo = null;
      if (novaTentativa) { r.tentativa += 1; r.nfse_id = null; }
      return comNota(r);
    }),
    anotarVinculo: jest.fn(async (id, v) => { mockMem.regs.get(id).vinculos.push(v); }),
    gravar: jest.fn(async (id, campos) => {
      const r = mockMem.regs.get(id);
      for (const [k, v] of Object.entries(campos)) if (v !== undefined) r[k] = clone(v);
      r.updated_at = new Date().toISOString();
    }),
    removerSemCodigo: jest.fn(async (c, t, o, k) => {
      const r = achar(c, t, o, k);
      if (r && !r.nfse_id) mockMem.regs.delete(r.id);
    }),
    ligarNotaAOrigem: jest.fn(async (c, nid, sid) => { mockMem.notas.get(nid).source_id = sid; }),
    notaPorChave: jest.fn(async (c, key) => [...mockMem.notas.values()].find((n) => n.idempotency_key === key) || null),
    listarPorOrigens: jest.fn(async (c, origens) => [...mockMem.regs.values()]
      .filter((r) => r.company_id === c && origens.some((o) => o.tipo === r.origem_tipo && o.id === r.origem_id))
      .map(comNota)),
  };
});

jest.mock('../src/services/nfseNacional', () => {
  const crypto = require('crypto');
  return {
    emitir: jest.fn(),
    danfse: jest.fn(async () => Buffer.from('%PDF-1.4 teste')),
    fingerprint: (n) => crypto.createHash('sha256').update(JSON.stringify(n)).digest('hex'),
  };
});

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'u1', role: 'client' }; next(); },
  requireRole: () => (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const repo = require('../src/services/nfseAutomaticaRepo');
const nacional = require('../src/services/nfseNacional');
const { NfseNacionalError } = require('../src/services/nfseNacional/errors');
const auto = require('../src/services/nfseAutomatica');

const C1 = '11111111-1111-4111-8111-111111111111';
const VENDA = '22222222-2222-4222-8222-222222222222';
const OS = '33333333-3333-4333-8333-333333333333';
const CLI = '44444444-4444-4444-8444-444444444444';
const CPF = '52998224725'; // válido

let fila = [];
async function rodarFila() {
  while (fila.length) {
    const f = fila.shift();
    await f();
  }
}

function emissorAutoriza() {
  nacional.emitir.mockImplementation(async (_db, { companyId, idempotencyKey, nota }) => {
    const existente = [...mockMem.notas.values()].find((n) => n.idempotency_key === idempotencyKey);
    if (existente) return { nota: existente, replay: true };
    const id = `nfse-${mockMem.notas.size + 1}`;
    const n = { id, company_id: companyId, idempotency_key: idempotencyKey, status: 'autorizada', nfse_number: String(mockMem.notas.size + 1), nota };
    mockMem.notas.set(id, n);
    return { nota: n };
  });
}

function venda({ itens, total, customer = CLI, created_at = '2026-11-10T13:00:00Z' }) {
  mockMem.vendas.set(VENDA, { id: VENDA, company_id: C1, customer_id: customer, status: 'completed', type: 'sale', total_amount: total, created_at });
  mockMem.itensVenda.set(VENDA, itens);
}

const SRV = (id, valor, extra = {}) => ({ id, product_id: `p-${id}`, quantity: 1, total_price: valor, product_name_snapshot: `Serviço ${id}`, unit: 'srv', ...extra });
const PROD = (id, valor) => ({ id, product_id: `p-${id}`, quantity: 1, total_price: valor, product_name_snapshot: `Produto ${id}`, unit: 'un' });

beforeEach(() => {
  for (const k of ['cfg', 'vendas', 'itensVenda', 'oss', 'itensOs', 'parcelas', 'clientes', 'regs', 'notas']) mockMem[k].clear();
  mockMem.seq = 0;
  jest.clearAllMocks();
  process.env.NFSE_AUTOMATICA_ENABLED = 'true';
  fila = [];
  auto._setAgendador((fn) => fila.push(fn));
  mockMem.cfg.set(C1, { company_id: C1, provider: 'nacional', is_active: true, ctribnac_padrao: '010501', cnbs_padrao: null, emissao_automatica: true, emissao_automatica_desde: '2026-11-01T00:00:00Z' });
  mockMem.clientes.set(CLI, { id: CLI, name: 'Maria', full_name: 'Maria Souza', cpf_cnpj: CPF, email: 'maria@exemplo.com', phone: '12999990000' });
  emissorAutoriza();
});

afterAll(() => {
  delete process.env.NFSE_AUTOMATICA_ENABLED;
  auto._setAgendador(null);
});

describe('gatilhos', () => {
  test('venda com serviço emite uma vez, só os serviços, depois do agendamento', async () => {
    venda({ itens: [SRV('a', 100), PROD('b', 50)], total: 150 });
    expect(auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA })).toBe(true);
    expect(nacional.emitir).not.toHaveBeenCalled(); // nada síncrono
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    const [, arg] = nacional.emitir.mock.calls[0];
    expect(arg.idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-1`);
    expect(arg.nota).toMatchObject({ valor: 100, ctribnac: '010501', source_type: 'pdv_sale', descricao: 'Serviço a' });
    expect(arg.nota.tomador).toMatchObject({ doc: CPF, nome: 'Maria Souza' });
    const reg = [...mockMem.regs.values()][0];
    expect(reg).toMatchObject({ status: 'emitida', gatilho: 'venda', nfse_id: 'nfse-1' });
    expect(mockMem.notas.get('nfse-1').source_id).toBe(VENDA);
  });

  test('desconto da venda é rateado no valor do serviço', async () => {
    venda({ itens: [SRV('a', 100), PROD('b', 100)], total: 180 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir.mock.calls[0][1].nota.valor).toBe(90);
  });

  test('recebimento da mesma venda não emite de novo (anota o vínculo)', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    mockMem.parcelas.set('inst-1', VENDA);
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }], transaction: { id: 'tx-9' } } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    const reg = [...mockMem.regs.values()][0];
    expect(reg.vinculos).toEqual([expect.objectContaining({ gatilho: 'pagamento', ref: 'tx-9' })]);
  });

  test('recebimento emite quando a venda ainda não tinha nota', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    mockMem.parcelas.set('inst-1', VENDA);
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }], transaction: { id: 'tx-1' } } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect([...mockMem.regs.values()][0].gatilho).toBe('pagamento');
    // segunda parcela paga depois: nada novo (regra b)
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }], transaction: { id: 'tx-2' } } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
  });

  test('recebimento repetido (replay idempotente) nem agenda', () => {
    expect(auto.aoReceberPagamento({ companyId: C1, result: { replayed: true, covered_installments: [{ id: 'x' }] } })).toBe(false);
    expect(fila).toHaveLength(0);
  });

  test('recebimento de venda anterior ao opt-in não gera nota retroativa', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, created_at: '2026-10-01T13:00:00Z' });
    mockMem.parcelas.set('inst-1', VENDA);
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }] } });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(repo.reivindicar).not.toHaveBeenCalled();
  });

  test('OS entregue sem venda emite pelos serviços da OS', async () => {
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: auto.STATUS_OS_QUE_EMITE, sale_id: null, delivered_at: '2026-11-10T15:00:00Z' });
    mockMem.itensOs.set(OS, [
      { id: 'i1', kind: 'servico', description: 'Troca de tela', quantity: 1, total_price: 200, unit: null },
      { id: 'i2', kind: 'peca', description: 'Tela', quantity: 1, total_price: 300, unit: 'un' },
    ]);
    auto.aoConcluirOs({ companyId: C1, osId: OS });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota).toMatchObject({ valor: 200, descricao: 'Troca de tela', source_type: 'service_order' });
    expect(nacional.emitir.mock.calls[0][1].idempotencyKey).toBe(`aura-auto-os-${OS}-010501-1`);
  });

  test('OS só emite no status da regra (a): pronta não emite', async () => {
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: 'pronta', sale_id: null });
    mockMem.itensOs.set(OS, [{ id: 'i1', kind: 'servico', description: 'Reparo', quantity: 1, total_price: 200 }]);
    auto.aoConcluirOs({ companyId: C1, osId: OS });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
  });

  test('OS entregue ligada a venda com serviço já emitida não emite de novo', async () => {
    venda({ itens: [SRV('a', 200)], total: 200 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: 'entregue', sale_id: VENDA, delivered_at: '2026-11-10T15:00:00Z' });
    mockMem.itensOs.set(OS, [{ id: 'i1', kind: 'servico', description: 'Reparo', quantity: 1, total_price: 200 }]);
    auto.aoConcluirOs({ companyId: C1, osId: OS });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect([...mockMem.regs.values()]).toHaveLength(1);
    expect([...mockMem.regs.values()][0].vinculos).toEqual([expect.objectContaining({ gatilho: 'os', ref: OS })]);
  });
});

describe('quando nada sai', () => {
  test('venda sem serviço: nada (nem registro)', async () => {
    venda({ itens: [PROD('b', 50)], total: 50 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(repo.reivindicar).not.toHaveBeenCalled();
  });

  test('flag do servidor desligada: o gatilho não agenda nem consulta', () => {
    process.env.NFSE_AUTOMATICA_ENABLED = 'false';
    venda({ itens: [SRV('a', 100)], total: 100 });
    expect(auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA })).toBe(false);
    expect(auto.aoConcluirOs({ companyId: C1, osId: OS })).toBe(false);
    expect(auto.aoReceberPagamento({ companyId: C1, saleId: VENDA })).toBe(false);
    expect(fila).toHaveLength(0);
    expect(repo.carregarConfig).not.toHaveBeenCalled();
  });

  test('opt-in da empresa desligado: só lê a config', async () => {
    mockMem.cfg.get(C1).emissao_automatica = false;
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(repo.carregarConfig).toHaveBeenCalledTimes(1);
    expect(repo.buscarVenda).not.toHaveBeenCalled();
    expect(nacional.emitir).not.toHaveBeenCalled();
  });

  test('sem CPF/CNPJ: pendente_dados com motivo legível; completar emite', async () => {
    mockMem.clientes.get(CLI).cpf_cnpj = null;
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
    const reg = [...mockMem.regs.values()][0];
    expect(reg).toMatchObject({ status: 'pendente_dados', motivo_codigo: 'SEM_TOMADOR' });
    expect(reg.motivo).toMatch(/falta o CPF\/CNPJ de quem contratou/i);

    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'manual', manual: true, tomador: { doc: '529.982.247-25', nome: 'Maria Souza' } });
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota.tomador.doc).toBe(CPF);
    expect([...mockMem.regs.values()][0].status).toBe('emitida');
  });

  test('CPF inválido também fica pendente', async () => {
    mockMem.clientes.get(CLI).cpf_cnpj = '11111111111';
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'pendente_dados', motivo_codigo: 'TOMADOR_INVALIDO' });
  });

  test('regra (c): serviço sem código → problema SEM_CODIGO e nada sai; com código, emite e o problema some', async () => {
    mockMem.cfg.get(C1).ctribnac_padrao = null;
    venda({ itens: [SRV('a', 100), SRV('b', 40, { nfse_ctribnac: '070101' })], total: 140 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
    const regs = [...mockMem.regs.values()];
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ ctribnac: auto.CTRIBNAC_SEM_CODIGO, status: 'erro', motivo_codigo: 'SEM_CODIGO' });
    expect(regs[0].motivo).toMatch(/falta o código de tributação nacional do serviço/i);
    const sit = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(sit).toMatchObject({ estado: 'erro', acao: 'cadastrar_codigo', tem_nota: false });

    mockMem.itensVenda.get(VENDA)[0].nfse_ctribnac = '010501';
    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'manual', manual: true, forcar: true });
    expect(nacional.emitir).toHaveBeenCalledTimes(2);
    expect([...mockMem.regs.values()].map((r) => r.ctribnac).sort()).toEqual(['010501', '070101']);
  });
});

describe('agrupamento e falhas', () => {
  test('uma nota por código de tributação; mesmo código junta a descrição', async () => {
    venda({
      itens: [
        SRV('a', 100, { nfse_ctribnac: '060101', product_name_snapshot: 'Corte' }),
        SRV('b', 50, { nfse_ctribnac: '060101', quantity: 2, product_name_snapshot: 'Escova' }),
        SRV('c', 80, { nfse_ctribnac: '060201', nfse_descricao: 'Manicure e pedicure' }),
      ],
      total: 230,
    });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(2);
    const notas = nacional.emitir.mock.calls.map((c) => c[1].nota);
    expect(notas[0]).toMatchObject({ ctribnac: '060101', valor: 150, descricao: 'Corte; 2x Escova' });
    expect(notas[1]).toMatchObject({ ctribnac: '060201', valor: 80, descricao: 'Manicure e pedicure' });
    const chaves = nacional.emitir.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(chaves).size).toBe(2);
  });

  test('falha do emissor vira registro de erro, nunca exceção no gatilho; outro gatilho retoma com a MESMA chave', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    nacional.emitir.mockRejectedValueOnce(new NfseNacionalError('Certificado A1: vencido', 'CERTIFICADO'));
    expect(() => auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA })).not.toThrow();
    await expect(rodarFila()).resolves.toBeUndefined();
    const reg = [...mockMem.regs.values()][0];
    expect(reg).toMatchObject({ status: 'erro', motivo_codigo: 'CERTIFICADO' });
    expect(reg.motivo).toMatch(/^Não conseguimos emitir a NFS-e: Certificado A1/);

    mockMem.parcelas.set('inst-1', VENDA);
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }] } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(2);
    expect(nacional.emitir.mock.calls[1][1].idempotencyKey).toBe(nacional.emitir.mock.calls[0][1].idempotencyKey);
    expect([...mockMem.regs.values()][0].status).toBe('emitida');
  });

  test('erro inesperado (banco fora) no processamento não escapa do gatilho', async () => {
    repo.carregarConfig.mockRejectedValueOnce(new Error('conexão caiu'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await expect(rodarFila()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('nota aguardando confirmação: retomada (parada há 10 min) usa a MESMA chave e os MESMOS dados', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    nacional.emitir.mockImplementationOnce(async (_db, { idempotencyKey, nota }) => {
      const n = { id: 'nfse-p', idempotency_key: idempotencyKey, status: 'pendente', nota };
      mockMem.notas.set(n.id, n);
      return { nota: n, aguardando: true };
    });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    const reg = [...mockMem.regs.values()][0];
    expect(reg.status).toBe('emitindo');
    // gatilho logo em seguida: não retoma (outro processo pode estar no meio)
    mockMem.parcelas.set('inst-1', VENDA);
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }] } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    // parada há 11 min e o cadastro mudou: retoma com a nota já enviada
    reg.updated_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    mockMem.clientes.get(CLI).email = 'outro@exemplo.com';
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }] } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(2);
    const [primeira, segunda] = nacional.emitir.mock.calls.map((c) => c[1]);
    expect(segunda.idempotencyKey).toBe(primeira.idempotencyKey);
    expect(segunda.nota).toEqual(primeira.nota);
  });

  test('rejeitada não reemite sozinha; "tentar de novo" usa a tentativa 2', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    nacional.emitir.mockImplementationOnce(async (_db, { idempotencyKey, nota }) => {
      const n = { id: 'nfse-r', idempotency_key: idempotencyKey, status: 'rejeitada', rejection_reason: 'E0310 - código inválido', nota };
      mockMem.notas.set(n.id, n);
      return { nota: n };
    });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect([...mockMem.regs.values()][0].status).toBe('rejeitada');

    mockMem.parcelas.set('inst-1', VENDA);
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }] } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);

    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'manual', manual: true, forcar: true });
    expect(nacional.emitir).toHaveBeenCalledTimes(2);
    expect(nacional.emitir.mock.calls[1][1].idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-2`);
  });
});

describe('rotas /nfse/automatica', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/companies/:id/nfse/automatica', require('../src/routes/nfseAutomatica'));
    return a;
  }

  test('situação: nenhuma → emitida (2ª via) com links', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    let r = await request(app()).get(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'nenhuma', acao: 'emitir', tem_nota: false });

    r = await request(app()).post(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}/emitir`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'emitida', acao: 'imprimir_2a_via', tem_nota: true });

    r = await request(app()).get(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}/segunda-via`);
    expect(r.status).toBe(200);
    expect(r.body.notas[0]).toMatchObject({ nfse_id: 'nfse-1', pdf_path: `/companies/${C1}/nfse/nfse-1/pdf` });

    r = await request(app()).get(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}/segunda-via?formato=pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('completar exige CPF/CNPJ válido e emite', async () => {
    mockMem.clientes.get(CLI).cpf_cnpj = null;
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    let r = await request(app()).get(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}`);
    expect(r.body).toMatchObject({ estado: 'pendente_dados', acao: 'completar_dados' });
    expect(r.body.notas[0].motivo).toMatch(/CPF\/CNPJ/);

    r = await request(app()).post(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}/completar`).send({ tomador: { doc: '123' } });
    expect(r.status).toBe(422);

    r = await request(app()).post(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}/completar`).send({ tomador: { doc: CPF } });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('emitida');
  });

  test('escritas respondem 404 com a flag desligada; leitura segue', async () => {
    process.env.NFSE_AUTOMATICA_ENABLED = 'false';
    venda({ itens: [SRV('a', 100)], total: 100 });
    let r = await request(app()).post(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}/emitir`).send({});
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NFSE_AUTOMATICA_DESLIGADA');
    r = await request(app()).get(`/companies/${C1}/nfse/automatica/origem/venda/${VENDA}`);
    expect(r.status).toBe(200);
    expect(nacional.emitir).not.toHaveBeenCalled();
  });

  test('tipo e id da origem validados', async () => {
    let r = await request(app()).get(`/companies/${C1}/nfse/automatica/origem/cobranca/${VENDA}`);
    expect(r.status).toBe(400);
    r = await request(app()).get(`/companies/${C1}/nfse/automatica/origem/venda/abc`);
    expect(r.status).toBe(400);
  });
});
