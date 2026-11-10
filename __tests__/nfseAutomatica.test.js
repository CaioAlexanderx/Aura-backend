// ============================================================
// AURA. — Emissão automática da NFS-e (migration 438)
//
// Banco em memória no lugar do nfseAutomaticaRepo (mesmo desenho dos testes
// do nfseNacional) e emissor nacional trocado por um jest.fn. Cobre:
//   - cada gatilho (venda, OS entregue, recebimento) emite uma vez;
//   - o segundo gatilho da mesma prestação não emite de novo (só vínculo);
//   - tomador opcional (10/11/2026): sem CPF/CNPJ emite sem <toma>; dígito
//     errado ou documento sem nome → pendente_dados; completar emite;
//   - venda sem serviço → nada; flag ou opt-in desligados → nada;
//   - uma nota por código de tributação, descrição concatenada;
//   - serviço sem código → problema SEM_CODIGO, nada sai; com código, sai;
//   - falha do emissor vira registro 'erro', nunca exceção no gatilho;
//   - rejeitada não reemite sozinha; "tentar de novo" usa chave nova;
//   - rotas: situação da origem, completar e 2ª via;
//   - tomador junto com a venda (migration 440): o do Caixa vence o
//     cadastro, sobrevive à queda (sales.nfse_tomador) e perde para o
//     completado pelo app;
//   - emissão MANUAL ("Emitir NFS-e"): funciona com a automática desligada
//     quando a loja emite (is_active + nacional + NFSE_NACIONAL_ENABLED),
//     recusa quando não emite e nunca gera duas notas para a mesma origem.
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

function venda({ itens, total, customer = CLI, created_at = '2026-11-10T13:00:00Z', nfse_tomador = null }) {
  mockMem.vendas.set(VENDA, { id: VENDA, company_id: C1, customer_id: customer, status: 'completed', type: 'sale', total_amount: total, created_at, nfse_tomador });
  mockMem.itensVenda.set(VENDA, itens);
}

const SRV = (id, valor, extra = {}) => ({ id, product_id: `p-${id}`, quantity: 1, total_price: valor, product_name_snapshot: `Serviço ${id}`, unit: 'srv', ...extra });
const PROD = (id, valor) => ({ id, product_id: `p-${id}`, quantity: 1, total_price: valor, product_name_snapshot: `Produto ${id}`, unit: 'un' });

beforeEach(() => {
  for (const k of ['cfg', 'vendas', 'itensVenda', 'oss', 'itensOs', 'parcelas', 'clientes', 'regs', 'notas']) mockMem[k].clear();
  mockMem.seq = 0;
  jest.clearAllMocks();
  process.env.NFSE_AUTOMATICA_ENABLED = 'true';
  process.env.NFSE_NACIONAL_ENABLED = 'true';
  fila = [];
  auto._setAgendador((fn) => fila.push(fn));
  mockMem.cfg.set(C1, { company_id: C1, provider: 'nacional', is_active: true, ctribnac_padrao: '010501', cnbs_padrao: null, emissao_automatica: true, emissao_automatica_desde: '2026-11-01T00:00:00Z' });
  mockMem.clientes.set(CLI, { id: CLI, name: 'Maria', full_name: 'Maria Souza', cpf_cnpj: CPF, email: 'maria@exemplo.com', phone: '12999990000' });
  emissorAutoriza();
});

afterAll(() => {
  delete process.env.NFSE_AUTOMATICA_ENABLED;
  delete process.env.NFSE_NACIONAL_ENABLED;
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

  test('sem CPF/CNPJ em lugar nenhum: emite sem tomador (consumidor não identificado)', async () => {
    mockMem.clientes.get(CLI).cpf_cnpj = null;
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota).not.toHaveProperty('tomador');
    const reg = [...mockMem.regs.values()][0];
    expect(reg).toMatchObject({ status: 'emitida', motivo_codigo: null });
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

describe('DPS com série/número já usados por outro emissor (incidente de 10/11/2026)', () => {
  const MSG = 'A série 1 e o número 1 da DPS já foram usados por outro emissor desta empresa. '
    + 'Confira na configuração da NFS-e a Série da DPS e o último Número usado e tente de novo.';

  test('nota marcada DPS_NUMERO_JA_USADO: registro em erro com o motivo e o código; o app oferece tentar de novo', async () => {
    venda({ itens: [SRV('a', 44)], total: 44 });
    nacional.emitir.mockImplementationOnce(async (_db, { idempotencyKey, nota }) => {
      const n = {
        id: 'nfse-d', idempotency_key: idempotencyKey, status: 'erro', dps_serie: '1', dps_number: '1',
        rejection_reason: MSG, error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO', descricao: MSG }], nota,
      };
      mockMem.notas.set(n.id, n);
      return { nota: n };
    });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    const reg = [...mockMem.regs.values()][0];
    expect(reg).toMatchObject({ status: 'erro', motivo: MSG, motivo_codigo: 'DPS_NUMERO_JA_USADO', nfse_id: 'nfse-d' });
    const sit = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(sit).toMatchObject({ estado: 'erro', acao: 'tentar_de_novo', tem_nota: false });
    expect(sit.notas[0]).toMatchObject({ estado: 'erro', motivo: MSG, motivo_codigo: 'DPS_NUMERO_JA_USADO' });
  });

  test('loja ainda sem conferir a série: o emissor recusa e o registro fica em erro com a mensagem dele', async () => {
    venda({ itens: [SRV('a', 44)], total: 44 });
    nacional.emitir.mockRejectedValueOnce(new NfseNacionalError(MSG, 'DPS_NUMERO_JA_USADO'));
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'erro', motivo: MSG, motivo_codigo: 'DPS_NUMERO_JA_USADO' });
  });

  test('"Tentar de novo" depois da correção: chave nova (a nota anterior está morta), mesmo com os mesmos dados', async () => {
    venda({ itens: [SRV('a', 44)], total: 44 });
    nacional.emitir.mockImplementationOnce(async (_db, { idempotencyKey, nota }) => {
      // forma da correção manual dos dados do incidente: código no começo do rejection_reason, sem error_codes
      const n = { id: 'nfse-d', idempotency_key: idempotencyKey, status: 'erro', rejection_reason: `DPS_NUMERO_JA_USADO: ${MSG}`, nota };
      mockMem.notas.set(n.id, n);
      return { nota: n };
    });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'erro', motivo: MSG, motivo_codigo: 'DPS_NUMERO_JA_USADO' });

    const r = await auto.emitirManual({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(r.grupos[0].acao).toBe('emitida');
    expect(nacional.emitir).toHaveBeenCalledTimes(2);
    expect(nacional.emitir.mock.calls[0][1].idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-1`);
    expect(nacional.emitir.mock.calls[1][1].idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-2`);
    expect(nacional.emitir.mock.calls[1][1].nota).toEqual(nacional.emitir.mock.calls[0][1].nota);
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'emitida', tentativa: 2, motivo_codigo: null });
  });

  test('erro comum (não é número já usado) segue retomando com a MESMA chave', async () => {
    venda({ itens: [SRV('a', 44)], total: 44 });
    nacional.emitir.mockImplementationOnce(async (_db, { idempotencyKey, nota }) => {
      const n = { id: 'nfse-e', idempotency_key: idempotencyKey, status: 'erro', rejection_reason: 'Certificado recusado', nota };
      mockMem.notas.set(n.id, n);
      return { nota: n };
    });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    nacional.emitir.mockImplementationOnce(async (_db, { idempotencyKey }) => {
      const n = mockMem.notas.get('nfse-e');
      expect(idempotencyKey).toBe(n.idempotency_key);
      n.status = 'autorizada';
      return { nota: n };
    });
    await auto.emitirManual({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(nacional.emitir.mock.calls[1][1].idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-1`);
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
    mockMem.clientes.get(CLI).cpf_cnpj = '11111111111'; // dígito errado: pendente
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

  test('flag da automática desligada: só o opt-in (PUT /config) responde 404; leitura segue', async () => {
    process.env.NFSE_AUTOMATICA_ENABLED = 'false';
    venda({ itens: [SRV('a', 100)], total: 100 });
    let r = await request(app()).put(`/companies/${C1}/nfse/automatica/config`).send({ emissao_automatica: true });
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

describe('tomador junto com a venda do Caixa (migration 440)', () => {
  const CNPJ = '11222333000181'; // válido
  const CPF2 = '11144477735'; // válido

  test('tomadorDaVendaDoCorpo: ausente, válido (com máscara), inválido e formato', () => {
    expect(auto.tomadorDaVendaDoCorpo(undefined)).toEqual({ tomador: null, aviso: null });
    expect(auto.tomadorDaVendaDoCorpo(null)).toEqual({ tomador: null, aviso: null });
    expect(auto.tomadorDaVendaDoCorpo({ doc: '' })).toEqual({ tomador: null, aviso: null });
    expect(auto.tomadorDaVendaDoCorpo({ doc: '11.222.333/0001-81', nome: '  Loja X Ltda ' }))
      .toEqual({ tomador: { doc: CNPJ, nome: 'Loja X Ltda' }, aviso: null });
    expect(auto.tomadorDaVendaDoCorpo({ doc: '529.982.247-25' })).toEqual({ tomador: { doc: CPF, nome: null }, aviso: null });
    expect(auto.tomadorDaVendaDoCorpo({ doc: '529.982.247-24' })).toEqual({ tomador: null, aviso: 'TOMADOR_INVALIDO' });
    expect(auto.tomadorDaVendaDoCorpo({ doc: '11111111111' })).toEqual({ tomador: null, aviso: 'TOMADOR_INVALIDO' });
    expect(auto.tomadorDaVendaDoCorpo({ doc: '123' })).toEqual({ tomador: null, aviso: 'TOMADOR_INVALIDO' });
    expect(auto.tomadorDaVendaDoCorpo('52998224725')).toEqual({ tomador: null, aviso: 'FORMATO' });
    expect(auto.tomadorDaVendaDoCorpo([CPF])).toEqual({ tomador: null, aviso: 'FORMATO' });
  });

  test('o documento digitado no Caixa vence o do cadastro do cliente', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA, tomador: { doc: CNPJ, nome: 'Loja X Ltda' } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota.tomador).toMatchObject({ doc: CNPJ, nome: 'Loja X Ltda' });
    expect(repo.buscarCliente).not.toHaveBeenCalled(); // doc e nome já vieram
    expect(mockMem.clientes.get(CLI).cpf_cnpj).toBe(CPF); // cadastro intacto
  });

  test('sem nome no Caixa: documento da venda, nome do cadastro', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA, tomador: { doc: CPF2, nome: null } });
    await rodarFila();
    expect(nacional.emitir.mock.calls[0][1].nota.tomador).toMatchObject({ doc: CPF2, nome: 'Maria Souza' });
  });

  test('venda sem cliente e com o tomador do Caixa: emite (antes ficava pendente)', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, customer: null });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA, tomador: { doc: CPF2, nome: 'João Lima' } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'emitida', tomador: { doc: CPF2, nome: 'João Lima' } });
  });

  test('processo caiu antes do agendamento: o próximo gatilho lê sales.nfse_tomador', async () => {
    mockMem.clientes.get(CLI).cpf_cnpj = null;
    venda({ itens: [SRV('a', 100)], total: 100, nfse_tomador: { doc: CPF2, nome: 'João Lima' } });
    // nenhum aoFinalizarVenda (o processo caiu); depois chega o recebimento
    mockMem.parcelas.set('inst-1', VENDA);
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }], transaction: { id: 'tx-1' } } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota.tomador).toMatchObject({ doc: CPF2, nome: 'João Lima' });
  });

  test('"Emitir NFS-e" manual sem tomador também usa o da venda', async () => {
    mockMem.clientes.get(CLI).cpf_cnpj = null;
    venda({ itens: [SRV('a', 100)], total: 100, nfse_tomador: { doc: CNPJ, nome: 'Loja X Ltda' } });
    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'manual', manual: true });
    expect(nacional.emitir.mock.calls[0][1].nota.tomador.doc).toBe(CNPJ);
  });

  test('sales.nfse_tomador com dígito errado é ignorado: vale o cadastro', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, nfse_tomador: { doc: '52998224724', nome: 'X' } });
    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'venda' });
    expect(nacional.emitir.mock.calls[0][1].nota.tomador).toMatchObject({ doc: CPF, nome: 'Maria Souza' });
  });

  test('o completado pelo app vence o da venda', async () => {
    // tomador do Caixa sem nome e venda sem cliente: pendente por falta de nome
    venda({ itens: [SRV('a', 100)], total: 100, customer: null, nfse_tomador: { doc: CPF2, nome: null } });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA, tomador: { doc: CPF2, nome: null } });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'pendente_dados', motivo_codigo: 'SEM_NOME', tomador: { doc: CPF2 } });

    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'manual', manual: true, tomador: { doc: CPF, nome: 'Maria Souza' } });
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(nacional.emitir.mock.calls[0][1].nota.tomador).toMatchObject({ doc: CPF, nome: 'Maria Souza' });
    // o do app fica gravado no registro: gatilhos seguintes não voltam ao da venda
    expect([...mockMem.regs.values()][0].tomador).toMatchObject({ doc: CPF });
  });

  test('venda sem nfse_tomador: aoFinalizarVenda de sempre, tomador do cadastro', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir.mock.calls[0][1].nota.tomador).toMatchObject({ doc: CPF, nome: 'Maria Souza' });
    expect([...mockMem.regs.values()][0].tomador).toBeNull();
  });
});

describe('emissão manual ("Emitir NFS-e"), separada da automática', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/companies/:id/nfse/automatica', require('../src/routes/nfseAutomatica'));
    return a;
  }
  const base = `/companies/${C1}/nfse/automatica`;
  const emitir = (body = {}) => request(app()).post(`${base}/origem/venda/${VENDA}/emitir`).send(body);

  function semAutomatica() {
    process.env.NFSE_AUTOMATICA_ENABLED = 'false';
    mockMem.cfg.get(C1).emissao_automatica = false;
  }

  test('GET /config: emite (botão) separado de ativa (automática)', async () => {
    let r = await request(app()).get(`${base}/config`);
    expect(r.body).toMatchObject({ ativa: true, emite: true });

    semAutomatica();
    r = await request(app()).get(`${base}/config`);
    expect(r.body).toMatchObject({ ligada_no_servidor: false, emissao_automatica: false, ativa: false, emite: true });

    mockMem.cfg.get(C1).is_active = false;
    r = await request(app()).get(`${base}/config`);
    expect(r.body).toMatchObject({ ativa: false, emite: false });

    process.env.NFSE_NACIONAL_ENABLED = 'false';
    mockMem.cfg.get(C1).is_active = true;
    r = await request(app()).get(`${base}/config`);
    expect(r.body).toMatchObject({ emite: false });

    mockMem.cfg.delete(C1);
    r = await request(app()).get(`${base}/config`);
    expect(r.body).toMatchObject({ tem_config: false, ativa: false, emite: false });
  });

  test('emite com a flag automática desligada e sem opt-in', async () => {
    semAutomatica();
    venda({ itens: [SRV('a', 100), PROD('b', 30)], total: 130 });
    const r = await emitir();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'emitida', acao: 'imprimir_2a_via', tem_nota: true });
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    const [, arg] = nacional.emitir.mock.calls[0];
    expect(arg.idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-1`);
    expect(arg.nota).toMatchObject({ valor: 100, source_type: 'pdv_sale' });
    expect([...mockMem.regs.values()][0]).toMatchObject({ gatilho: 'manual', status: 'emitida' });
  });

  test('venda anterior ao opt-in também emite pelo botão (o botão não olha a data)', async () => {
    semAutomatica();
    venda({ itens: [SRV('a', 100)], total: 100, created_at: '2026-10-01T10:00:00Z' });
    const r = await emitir();
    expect(r.body.estado).toBe('emitida');
  });

  test('completar e tentar de novo também funcionam sem a automática', async () => {
    semAutomatica();
    // cadastro com CPF e sem nome: o <toma> exige xNome → pendente SEM_NOME
    Object.assign(mockMem.clientes.get(CLI), { full_name: null, name: null });
    venda({ itens: [SRV('a', 100)], total: 100 });
    let r = await emitir();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'pendente_dados', acao: 'completar_dados' });
    expect(nacional.emitir).not.toHaveBeenCalled();

    r = await request(app()).post(`${base}/origem/venda/${VENDA}/completar`).send({ tomador: { doc: CPF, nome: 'Maria Souza' } });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('emitida');

    // nota cancelada depois: "tentar de novo" emite outra, com tentativa nova
    mockMem.notas.get('nfse-1').status = 'cancelada';
    r = await request(app()).post(`${base}/origem/venda/${VENDA}/tentar-de-novo`).send({});
    expect(r.status).toBe(200);
    expect(nacional.emitir).toHaveBeenCalledTimes(2);
    expect(nacional.emitir.mock.calls[1][1].idempotencyKey).toBe(`aura-auto-venda-${VENDA}-010501-2`);
  });

  test('recusa quando a loja não emite (is_active, provider, sem config): 409, nada sai', async () => {
    semAutomatica();
    venda({ itens: [SRV('a', 100)], total: 100 });

    mockMem.cfg.get(C1).is_active = false;
    let r = await emitir();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LOJA_NAO_EMITE');
    r = await request(app()).post(`${base}/origem/venda/${VENDA}/completar`).send({ tomador: { doc: CPF } });
    expect(r.status).toBe(409);
    r = await request(app()).post(`${base}/origem/venda/${VENDA}/tentar-de-novo`).send({});
    expect(r.status).toBe(409);

    mockMem.cfg.get(C1).is_active = true;
    mockMem.cfg.get(C1).provider = 'focus';
    r = await emitir();
    expect(r.status).toBe(409);

    mockMem.cfg.delete(C1);
    r = await emitir();
    expect(r.status).toBe(409);

    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(mockMem.regs.size).toBe(0);
  });

  test('recusa com o emissor nacional desligado no servidor: 404', async () => {
    process.env.NFSE_NACIONAL_ENABLED = 'false';
    venda({ itens: [SRV('a', 100)], total: 100 });
    const r = await emitir();
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NFSE_NACIONAL_DESLIGADA');
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(repo.carregarConfig).not.toHaveBeenCalled();
  });

  test('emitirManual (serviço) também recusa sem a loja emitir, sem ler a venda', async () => {
    mockMem.cfg.get(C1).is_active = false;
    venda({ itens: [SRV('a', 100)], total: 100 });
    const r = await auto.emitirManual({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(r).toMatchObject({ acao: 'recusada', codigo: 'LOJA_NAO_EMITE' });
    expect(repo.buscarVenda).not.toHaveBeenCalled();
  });

  test('gatilhos automáticos continuam sem disparar sem a flag, mesmo com a loja emitindo', async () => {
    process.env.NFSE_AUTOMATICA_ENABLED = 'false';
    venda({ itens: [SRV('a', 100)], total: 100 });
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: 'entregue', delivered_at: '2026-11-10T15:00:00Z', sale_id: null });
    mockMem.itensOs.set(OS, [{ id: 'oi1', kind: 'servico', quantity: 1, total_price: 80, description: 'Conserto' }]);
    mockMem.parcelas.set('inst-1', VENDA);
    expect(auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA })).toBe(false);
    expect(auto.aoConcluirOs({ companyId: C1, osId: OS })).toBe(false);
    expect(auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }] } })).toBe(false);
    expect(fila).toEqual([]);
    expect(repo.carregarConfig).not.toHaveBeenCalled();
    expect(nacional.emitir).not.toHaveBeenCalled();

    // flag ligada, opt-in desligado: o gatilho só lê a config, não emite
    process.env.NFSE_AUTOMATICA_ENABLED = 'true';
    mockMem.cfg.get(C1).emissao_automatica = false;
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    auto.aoConcluirOs({ companyId: C1, osId: OS });
    auto.aoReceberPagamento({ companyId: C1, result: { covered_installments: [{ id: 'inst-1' }] } });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(mockMem.regs.size).toBe(0);
  });

  test('clicar duas vezes (em sequência) não gera duas notas', async () => {
    semAutomatica();
    venda({ itens: [SRV('a', 100)], total: 100 });
    const r1 = await emitir();
    const r2 = await emitir();
    expect(r1.body.estado).toBe('emitida');
    expect(r2.status).toBe(200);
    expect(r2.body.estado).toBe('emitida');
    expect(r2.body.notas).toHaveLength(1);
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(mockMem.regs.size).toBe(1);
    expect(mockMem.notas.size).toBe(1);
  });

  test('dois toques ao mesmo tempo: só um emite, o outro só vê a nota', async () => {
    semAutomatica();
    venda({ itens: [SRV('a', 100)], total: 100 });
    // o emissor demora: o segundo toque chega com o primeiro ainda no ar
    let soltar;
    const segura = new Promise((res) => { soltar = res; });
    const real = nacional.emitir.getMockImplementation();
    nacional.emitir.mockImplementation(async (...args) => { await segura; return real(...args); });
    const p1 = emitir().then((r) => r);
    const p2 = emitir().then((r) => r);
    await new Promise((res) => setTimeout(res, 100));
    soltar();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(mockMem.regs.size).toBe(1);
    expect(mockMem.notas.size).toBe(1);
  });

  test('botão depois da automática já ter emitido: não emite de novo', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    const r = await emitir();
    expect(r.body.estado).toBe('emitida');
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect([...mockMem.regs.values()][0].vinculos).toEqual([expect.objectContaining({ gatilho: 'manual' })]);
  });

  test('o tomador digitado no Caixa (sales.nfse_tomador) vale no botão sem a automática', async () => {
    semAutomatica();
    venda({ itens: [SRV('a', 100)], total: 100, customer: null, nfse_tomador: { doc: CPF, nome: 'Joana Lima' } });
    const r = await emitir();
    expect(r.body.estado).toBe('emitida');
    expect(nacional.emitir.mock.calls[0][1].nota.tomador).toMatchObject({ doc: CPF, nome: 'Joana Lima' });
  });

  test('2ª via e situação funcionam sem a automática', async () => {
    semAutomatica();
    venda({ itens: [SRV('a', 100)], total: 100 });
    await emitir();
    let r = await request(app()).get(`${base}/origem/venda/${VENDA}`);
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('emitida');
    r = await request(app()).get(`${base}/origem/venda/${VENDA}/segunda-via`);
    expect(r.status).toBe(200);
    expect(r.body.notas).toHaveLength(1);
  });
});

describe('situação da origem diz se o botão "Emitir NFS-e" cabe', () => {
  test('venda com serviço e loja que emite: pode_emitir; só produto, cancelada ou loja sem NFS-e: não', async () => {
    process.env.NFSE_AUTOMATICA_ENABLED = 'false';
    venda({ itens: [SRV('a', 100), PROD('b', 30)], total: 130 });
    let s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(s).toMatchObject({ estado: 'nenhuma', emite: true, tem_servico: true, pode_emitir: true });

    venda({ itens: [PROD('b', 30)], total: 30 });
    s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(s).toMatchObject({ tem_servico: false, pode_emitir: false });

    venda({ itens: [SRV('a', 100)], total: 100 });
    mockMem.vendas.get(VENDA).status = 'cancelled';
    s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(s).toMatchObject({ tem_servico: true, pode_emitir: false });

    venda({ itens: [SRV('a', 100)], total: 100 });
    mockMem.cfg.get(C1).is_active = false;
    s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(s).toMatchObject({ emite: false, pode_emitir: false });
  });

  test('OS: só entregue pode emitir; serviço da OS ou da venda ligada conta', async () => {
    mockMem.oss.set(OS, { id: OS, company_id: C1, customer_id: CLI, status: 'pronta', delivered_at: null, sale_id: null });
    mockMem.itensOs.set(OS, [{ id: 'oi1', kind: 'servico', quantity: 1, total_price: 80, description: 'Conserto' }]);
    let s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'os', id: OS });
    expect(s).toMatchObject({ tem_servico: true, pode_emitir: false });
    mockMem.oss.get(OS).status = 'entregue';
    s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'os', id: OS });
    expect(s).toMatchObject({ pode_emitir: true });

    mockMem.itensOs.set(OS, [{ id: 'oi2', kind: 'peca', quantity: 1, total_price: 20, description: 'Peça', unit: 'un' }]);
    s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'os', id: OS });
    expect(s).toMatchObject({ tem_servico: false, pode_emitir: false });
    venda({ itens: [SRV('a', 100)], total: 100 });
    mockMem.oss.get(OS).sale_id = VENDA;
    s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'os', id: OS });
    expect(s).toMatchObject({ tem_servico: true, pode_emitir: true });
  });

  test('com nota já registrada não relê os itens (polling leve)', async () => {
    venda({ itens: [SRV('a', 100)], total: 100 });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    repo.itensDaVenda.mockClear();
    const s = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(s).toMatchObject({ estado: 'emitida', tem_servico: true });
    expect(repo.itensDaVenda).not.toHaveBeenCalled();
  });
});

describe('tomador opcional — consumidor não identificado (decisão de 10/11/2026)', () => {
  const CPF2 = '11144477735'; // válido
  const CNPJ = '11222333000181'; // válido
  const ultimaNota = () => nacional.emitir.mock.calls[nacional.emitir.mock.calls.length - 1][1].nota;

  test('venda sem tomador e sem cliente emite, sem o grupo toma (gatilho e botão)', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, customer: null });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(ultimaNota()).not.toHaveProperty('tomador');
    expect(ultimaNota()).toMatchObject({ valor: 100, ctribnac: '010501' });
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'emitida', tomador: null });
    expect(repo.buscarCliente).toHaveBeenCalledWith(null);

    // o botão "Emitir NFS-e" com a automática desligada também emite direto
    mockMem.regs.clear(); mockMem.notas.clear(); nacional.emitir.mockClear();
    mockMem.cfg.get(C1).emissao_automatica = false;
    const r = await auto.emitirManual({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(r.acao).toBe('processada');
    expect(r.grupos[0]).toMatchObject({ acao: 'emitida' });
    expect(ultimaNota()).not.toHaveProperty('tomador');
  });

  test('cliente cadastrado sem CPF/CNPJ: emite sem tomador (o nome sozinho não entra)', async () => {
    mockMem.clientes.get(CLI).cpf_cnpj = '';
    venda({ itens: [SRV('a', 100)], total: 100 });
    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'venda' });
    expect(ultimaNota()).not.toHaveProperty('tomador');
  });

  test('CPF com nome informado no Caixa: emite com toma', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, customer: null });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA, tomador: { doc: CPF2, nome: 'João Lima' } });
    await rodarFila();
    expect(ultimaNota().tomador).toMatchObject({ doc: CPF2, nome: 'João Lima' });
  });

  test('CPF sem nome e com cliente vinculado: usa o nome do cliente', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, nfse_tomador: { doc: CNPJ, nome: null } });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA, tomador: { doc: CNPJ, nome: null } });
    await rodarFila();
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(ultimaNota().tomador).toMatchObject({ doc: CNPJ, nome: 'Maria Souza' });
  });

  test('CPF sem nome e sem cliente: pendente SEM_NOME, nada sai', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, customer: null });
    auto.aoFinalizarVenda({ companyId: C1, saleId: VENDA, tomador: { doc: CPF2 } });
    await rodarFila();
    expect(nacional.emitir).not.toHaveBeenCalled();
    const reg = [...mockMem.regs.values()][0];
    expect(reg).toMatchObject({ status: 'pendente_dados', motivo_codigo: 'SEM_NOME' });
    const sit = await auto.situacaoDaOrigem({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(sit).toMatchObject({ estado: 'pendente_dados', acao: 'completar_dados' });
  });

  test('documento com dígito errado (completado pelo app ou no cadastro): pendente TOMADOR_INVALIDO, nunca emite', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, customer: null });
    const r = await auto.emitirManual({ companyId: C1, tipo: 'venda', id: VENDA, tomador: { doc: '52998224724', nome: 'Maria' } });
    expect(r.grupos[0]).toMatchObject({ acao: 'pendente_dados' });
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect([...mockMem.regs.values()][0]).toMatchObject({ status: 'pendente_dados', motivo_codigo: 'TOMADOR_INVALIDO' });

    mockMem.regs.clear();
    mockMem.clientes.get(CLI).cpf_cnpj = '123.456.789-00';
    venda({ itens: [SRV('a', 100)], total: 100 });
    await auto.processarVenda({ companyId: C1, saleId: VENDA, gatilho: 'venda' });
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect([...mockMem.regs.values()][0]).toMatchObject({ motivo_codigo: 'TOMADOR_INVALIDO' });
  });

  test('pendência antiga por falta de documento: o botão agora emite sem tomador', async () => {
    venda({ itens: [SRV('a', 100)], total: 100, customer: null });
    const { row } = await repo.reivindicar({ companyId: C1, origemTipo: 'venda', origemId: VENDA, ctribnac: '010501', gatilho: 'venda', itens: [], valor: 100 });
    await repo.gravar(row.id, { status: 'pendente_dados', motivo_codigo: 'SEM_TOMADOR', motivo: 'antigo' });
    await auto.emitirManual({ companyId: C1, tipo: 'venda', id: VENDA });
    expect(nacional.emitir).toHaveBeenCalledTimes(1);
    expect(ultimaNota()).not.toHaveProperty('tomador');
    expect(mockMem.regs.get(row.id).status).toBe('emitida');
  });

  test('ISSQN retido continua exigindo o tomador', () => {
    expect(auto.resolverTomador(null, null)).toEqual({ ok: true, tomador: null });
    expect(auto.resolverTomador(null, null, { exigir: true })).toMatchObject({ ok: false, codigo: 'SEM_TOMADOR' });
    expect(auto.resolverTomador(null, { full_name: 'Maria', cpf_cnpj: null }, { exigir: true })).toMatchObject({ ok: false, codigo: 'SEM_TOMADOR' });
    expect(auto.resolverTomador({ doc: CPF2, nome: 'João' }, null, { exigir: true })).toMatchObject({ ok: true, tomador: { doc: CPF2 } });
    // dígito errado e falta de nome seguem pendentes com ou sem retenção
    expect(auto.resolverTomador({ doc: '11111111111', nome: 'X' }, null).codigo).toBe('TOMADOR_INVALIDO');
    expect(auto.resolverTomador({ doc: CPF2 }, null).codigo).toBe('SEM_NOME');
    // informado só com nome não apaga o documento do cadastro
    expect(auto.resolverTomador({ nome: 'Outro' }, { full_name: 'Maria Souza', cpf_cnpj: CPF })).toMatchObject({ ok: true, tomador: { doc: CPF, nome: 'Maria Souza' } });
  });
});
