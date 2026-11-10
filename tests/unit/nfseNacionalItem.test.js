// ============================================================
// NFS-e Nacional — campos do serviço no cadastro do item (migration 437)
//
// O que fica provado aqui (banco simulado, nada sai para o Sefin):
//   • montarEntrada: precedência por campo nota → item → padrão da
//     empresa; descrição nota → nfse_descricao → nome do item; sem item a
//     entrada sai igual à de antes;
//   • emitir com product_id: o item entra na DPS reservada (dps_dados);
//     item inexistente/invisível → NOT_FOUND (404) sem gastar número;
//   • item compartilhado do grupo lido por OUTRA empresa do grupo vale;
//   • repo.buscarItem lê pela regra de visibilidade do grupo
//     (productVisibilityWhere), nunca por company_id = empresa só.
// ============================================================
'use strict';

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

jest.mock('../../src/services/nfseNacional/repo', () => {
  const actual = jest.requireActual('../../src/services/nfseNacional/repo');
  return {
    __actualBuscarItem: actual.buscarItem,
    buscarPorChave: jest.fn(async () => null),
    buscarPorId: jest.fn(async () => null),
    carregarContexto: jest.fn(),
    buscarItem: jest.fn(),
    reservar: jest.fn(),
    marcarErro: jest.fn(async () => {}),
    marcarTransmitindo: jest.fn(),
  };
});

const repo = require('../../src/services/nfseNacional/repo');
const certStore = require('../../src/services/sefazSp/certStore');
const nacional = require('../../src/services/nfseNacional');
const { productVisibilityWhere } = require('../../src/utils/companyGroup');

const MATRIZ = '11111111-1111-1111-1111-111111111111';
const FILIAL = '22222222-2222-2222-2222-222222222222';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CNPJ = '11222333000181';
const dhEmi = new Date('2026-11-10T13:00:00Z');

function config(over = {}) {
  return {
    company_id: FILIAL, provider: 'nacional', is_active: true, ambiente: 'producao_restrita',
    municipio_ibge: '3524402', ctribnac_padrao: '010501', cnbs_padrao: '115013000',
    default_iss_rate: '2.00', aliquota_iss_retencao_sn: '2.79', serie: '1', next_dps_number: 1,
    regime_tributario: 'simples_nacional', optante_simples_nacional: true, p_tot_trib_sn: 6,
    inscricao_municipal: null, ...over,
  };
}
const company = { id: FILIAL, cnpj: CNPJ, nome: 'Filial' };

function item(over = {}) {
  return {
    id: PID, company_id: MATRIZ, name: 'Instalação de ar-condicionado', unit: 'srv',
    nfse_ctribnac: '140101', nfse_cnbs: '120011000', nfse_ctribmun: '001',
    nfse_aliquota_iss: '3.50', nfse_descricao: 'Instalação de ar-condicionado split até 12.000 BTU',
    ibscbs_cst: '000', ibscbs_cclasstrib: '000001', ibscbs_cindop: '030101',
    ...over,
  };
}

const entrada = (nota, it, cfg = config()) => nacional.montarEntrada({
  nota, config: cfg, company, tpAmb: 2, dhEmi, item: it,
});

describe('montarEntrada — precedência nota → item → empresa', () => {
  test('sem item: padrão da empresa, igual a antes', () => {
    const e = entrada({ descricao: 'Manutenção', valor: 100 }, null);
    const antes = nacional.montarEntrada({ nota: { descricao: 'Manutenção', valor: 100 }, config: config(), company, tpAmb: 2, dhEmi });
    expect(e).toEqual(antes);
    expect(e.servico).toMatchObject({ cTribNac: '010501', cNBS: '115013000', descricao: 'Manutenção' });
  });

  test('com item: códigos e descrição do item vencem o padrão da empresa', () => {
    const e = entrada({ valor: 350 }, item());
    expect(e.servico).toMatchObject({
      cTribNac: '140101', cNBS: '120011000',
      descricao: 'Instalação de ar-condicionado split até 12.000 BTU',
    });
  });

  test('valor explícito na nota vence o item', () => {
    const e = entrada({ valor: 350, ctribnac: '070201', cnbs: '101010101', descricao: 'Instalação na loja 2', iss_retido: true, aliquota_iss: 4, tomador: { doc: '11222333000181', nome: 'Cliente PJ' } }, item());
    expect(e.servico).toMatchObject({ cTribNac: '070201', cNBS: '101010101', descricao: 'Instalação na loja 2' });
    expect(e.valores.pAliq).toBe(4);
  });

  test('item sem descrição para a nota: usa o nome do item', () => {
    const e = entrada({ valor: 350 }, item({ nfse_descricao: null }));
    expect(e.servico.descricao).toBe('Instalação de ar-condicionado');
  });

  test('descrição da nota em branco conta como ausente quando há item', () => {
    const e = entrada({ valor: 350, descricao: '   ' }, item());
    expect(e.servico.descricao).toBe('Instalação de ar-condicionado split até 12.000 BTU');
  });

  test('item com campos vazios cai no padrão da empresa campo a campo', () => {
    const e = entrada({ valor: 350, iss_retido: true, tomador: { doc: '11222333000181', nome: 'X' } },
      item({ nfse_ctribnac: null, nfse_cnbs: '', nfse_aliquota_iss: null }));
    expect(e.servico.cTribNac).toBe('010501');
    expect(e.servico.cNBS).toBe('115013000');
    expect(e.valores.pAliq).toBe(2.79);
  });

  test('alíquota do ISS (retido): nota → item → alíquota do Simples da loja (migration 441)', () => {
    const tom = { doc: '11222333000181', nome: 'Cliente PJ' };
    expect(entrada({ valor: 1, iss_retido: true, tomador: tom }, item()).valores.pAliq).toBe(3.5);
    expect(entrada({ valor: 1, iss_retido: true, tomador: tom, aliquota_iss: 5 }, item()).valores.pAliq).toBe(5);
    expect(entrada({ valor: 1, iss_retido: true, tomador: tom }, null).valores.pAliq).toBe(2.79);
  });

  test('retido sem aliquota_iss_retencao_sn: default_iss_rate (2,00 de fábrica) NÃO entra', () => {
    const tom = { doc: '11222333000181', nome: 'Cliente PJ' };
    const e = nacional.montarEntrada({
      nota: { valor: 1, descricao: 'x', iss_retido: true, tomador: tom },
      config: config({ aliquota_iss_retencao_sn: null }), company, tpAmb: 2, dhEmi, item: null,
    });
    expect(e.valores.pAliq).toBeNull();
    // sem retenção a alíquota nem entra
    expect(entrada({ valor: 1 }, null).valores.pAliq).toBeNull();
  });

  test('cTribMun e IBS/CBS do item ainda não entram no leiaute', () => {
    const e = entrada({ valor: 350 }, item());
    const txt = JSON.stringify(e);
    expect(txt).not.toMatch(/030101|000001|ctribmun|ibscbs/i);
  });
});

describe('emitir com product_id', () => {
  beforeEach(() => {
    process.env.NFSE_NACIONAL_ENABLED = 'true';
    nacional._breaker.reset();
    Object.values(repo).forEach((f) => typeof f === 'function' && f.mockClear && f.mockClear());
    repo.carregarContexto.mockResolvedValue({
      config: config(), company, certInfo: { subject_cn: `EMPRESA:${CNPJ}`, not_after: '2030-01-01T00:00:00Z' },
    });
    repo.reservar.mockImplementation(async (db, { entrada: ent }) => ({
      row: { id: 'n1', company_id: FILIAL, dps_serie: '1', dps_number: '1', dps_dados: ent },
    }));
    // para logo depois da reserva: o certificado não abre (nada vai ao Sefin)
    certStore.loadCertificate.mockReset();
    certStore.loadCertificate.mockRejectedValue(new Error('sem A1 no teste'));
  });
  afterAll(() => { delete process.env.NFSE_NACIONAL_ENABLED; });

  test('item compartilhado da MATRIZ emitido pela FILIAL: campos do item na DPS reservada', async () => {
    repo.buscarItem.mockResolvedValueOnce(item({ company_id: MATRIZ }));
    await expect(nacional.emitir({}, { companyId: FILIAL, idempotencyKey: 'k-item', nota: { valor: 350, product_id: PID } }))
      .rejects.toMatchObject({ code: 'CERTIFICADO' });
    expect(repo.buscarItem).toHaveBeenCalledWith({}, FILIAL, PID);
    const { entrada: ent } = repo.reservar.mock.calls[0][1];
    expect(ent.servico).toMatchObject({ cTribNac: '140101', cNBS: '120011000', descricao: 'Instalação de ar-condicionado split até 12.000 BTU' });
  });

  test('sem item: padrão da empresa, buscarItem nem é chamado', async () => {
    await expect(nacional.emitir({}, { companyId: FILIAL, idempotencyKey: 'k-sem', nota: { valor: 99, descricao: 'Consultoria' } }))
      .rejects.toMatchObject({ code: 'CERTIFICADO' });
    expect(repo.buscarItem).not.toHaveBeenCalled();
    const { entrada: ent } = repo.reservar.mock.calls[0][1];
    expect(ent.servico).toMatchObject({ cTribNac: '010501', cNBS: '115013000', descricao: 'Consultoria' });
  });

  test('nota explícita vence o item na emissão', async () => {
    repo.buscarItem.mockResolvedValueOnce(item());
    await expect(nacional.emitir({}, { companyId: FILIAL, idempotencyKey: 'k-exp', nota: { valor: 350, product_id: PID, ctribnac: '070201', descricao: 'Instalação especial' } }))
      .rejects.toMatchObject({ code: 'CERTIFICADO' });
    const { entrada: ent } = repo.reservar.mock.calls[0][1];
    expect(ent.servico).toMatchObject({ cTribNac: '070201', cNBS: '120011000', descricao: 'Instalação especial' });
  });

  test('item inexistente ou invisível → NOT_FOUND (404), sem reservar número', async () => {
    repo.buscarItem.mockResolvedValueOnce(null);
    const err = await nacional.emitir({}, { companyId: FILIAL, idempotencyKey: 'k-404', nota: { valor: 350, product_id: PID } }).catch((e) => e);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toMatch(/Não encontramos este serviço/);
    expect(require('../../src/services/nfseNacional/errors').httpStatusDe(err.code)).toBe(404);
    expect(repo.reservar).not.toHaveBeenCalled();
  });

  test('a impressão digital (idempotência) sem product_id não muda', () => {
    const nota = { descricao: 'x', valor: 1 };
    expect(nacional.fingerprint({ ...nota, product_id: undefined })).toBe(nacional.fingerprint(nota));
    expect(nacional.fingerprint({ ...nota, product_id: PID })).not.toBe(nacional.fingerprint(nota));
  });
});

describe('repo.buscarItem — visibilidade do grupo', () => {
  const buscarItem = repo.__actualBuscarItem;

  test('lê pela regra do grupo (productVisibilityWhere), com o id e a empresa que emite', async () => {
    const db = { query: jest.fn(async () => ({ rows: [item({ company_id: MATRIZ })] })) };
    const r = await buscarItem(db, FILIAL, PID);
    expect(r.company_id).toBe(MATRIZ);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain(productVisibilityWhere('$2'));
    expect(sql).toMatch(/is_group_shared = true/);
    expect(sql).toMatch(/is_active IS NOT FALSE/);
    expect(sql).toMatch(/nfse_ctribnac/);
    expect(sql).not.toMatch(/WHERE\s+company_id\s*=\s*\$2/);
    expect(params).toEqual([PID, FILIAL]);
  });

  test('id que não é uuid: null sem consultar o banco', async () => {
    const db = { query: jest.fn() };
    expect(await buscarItem(db, FILIAL, 'nao-e-uuid')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('não encontrado → null', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    expect(await buscarItem(db, FILIAL, PID)).toBeNull();
  });

  test('base sem a 437 (42703): devolve o item sem os campos', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const e = Object.assign(new Error('column "nfse_ctribnac" does not exist'), { code: '42703' });
    const db = { query: jest.fn().mockRejectedValueOnce(e).mockResolvedValueOnce({ rows: [{ id: PID, name: 'Corte' }] }) };
    expect(await buscarItem(db, FILIAL, PID)).toEqual({ id: PID, name: 'Corte' });
    expect(db.query.mock.calls[1][0]).not.toMatch(/nfse_/);
    console.warn.mockRestore();
  });
});
