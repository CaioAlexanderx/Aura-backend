// ============================================================
// NFS-e Nacional — nota de teste rejeitada SÓ pelo ambiente de testes do
// gov.br (E0312) não trava o "Ligar".
//
// Caso real de 10/11/2026: loja de São Paulo capital (IBGE 3550308, ME/EPP)
// com o cTribNac 130501, que ela já usa no ambiente de PRODUÇÃO do Emissor
// Nacional. As três notas de teste voltaram só com o E0312 ("código de
// tributação nacional não administrado pelo município"), sem E0084: o
// município não parametrizou o código na produção restrita.
//
// Banco MOCKADO (db.query roteado pelo SQL) com o repo de verdade: o passo
// "teste" e o gate do PUT /config (avaliarLigar) leem os error_codes da nota
// em ultimo_teste_nfse_id, não só o ultimo_teste_codigo.
//
// O que fica provado aqui:
//   • E0312 sozinho: teste "ok" com aviso, Ligar liberado;
//   • E0312 junto de outro código: continua bloqueado;
//   • E0084 (e os outros da prefeitura): continua bloqueado;
//   • teste aceito continua liberando, sem ler a nota;
//   • traduzirResultadoTeste devolve status 'aviso', passo 'teste'.
// ============================================================
'use strict';

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

const certStore = require('../../src/services/sefazSp/certStore');
const nacional = require('../../src/services/nfseNacional');
const {
  ERROS_SO_DO_AMBIENTE_DE_TESTES, AVISO_SO_DO_AMBIENTE_DE_TESTES, CODIGOS_PREFEITURA,
  aceitoComAvisoDoAmbienteDeTestes, avaliarPassos,
} = require('../../src/services/nfseNacional/config');

const CID = 'empresa-sp';
const CNPJ = '11222333000181';
const NOTA_TESTE = 'b3f1c2d4-0000-4000-8000-000000000312';
const E0312 = { codigo: 'E0312', descricao: 'O código de tributação nacional informado não está administrado pelo município de incidência do ISSQN na data de competência informada na DPS' };
const company = { id: CID, cnpj: CNPJ, nome: 'Loja SP', address_city: 'São Paulo', address_state: 'SP' };
const certInfo = { subject_cn: `LOJA SP LTDA:${CNPJ}`, not_after: '2027-08-12T00:00:00Z' };

/** Loja de SP pronta para ligar; o último teste voltou rejeitado. */
function configSp(over = {}) {
  return {
    company_id: CID, provider: 'nacional', is_active: false, ambiente: 'producao_restrita',
    municipio_ibge: '3550308', ctribnac_padrao: '130501', serie: '1', next_dps_number: 1,
    serie_confirmada_em: '2026-11-10T10:00:00Z', outro_emissor: false, op_simp_nac: 3, reg_ap_trib_sn: 1,
    p_tot_trib_sn: 6.54, cliente_retem_iss: false, aliquota_iss_retencao_sn: null,
    ultimo_teste_em: '2026-11-10T13:00:00Z', ultimo_teste_status: 'rejeitado', ultimo_teste_codigo: 'E0312',
    ultimo_teste_mensagem: 'O gov.br devolveu a nota de teste com um aviso.', ultimo_teste_nfse_id: NOTA_TESTE,
    ...over,
  };
}

/** db.query roteado pelo SQL: nfse_config, companies e a nota de teste. */
function dbFalso({ config, errorCodes }) {
  const query = jest.fn(async (sql, params) => {
    if (/FROM nfse_config/.test(sql)) return { rows: config ? [{ ...config }] : [] };
    if (/FROM companies/.test(sql)) return { rows: [{ ...company }] };
    if (/SELECT error_codes FROM nfse WHERE id = \$1 AND company_id = \$2/.test(sql)) {
      return { rows: params[0] === NOTA_TESTE && params[1] === CID ? [{ error_codes: errorCodes }] : [] };
    }
    throw new Error('SQL inesperado no teste: ' + sql);
  });
  return { query, config, notaLida: () => query.mock.calls.some(([sql]) => /SELECT error_codes FROM nfse/.test(sql)) };
}

beforeEach(() => {
  certStore.getCertificateInfo.mockReset();
  certStore.getCertificateInfo.mockResolvedValue(certInfo);
  process.env.NFSE_NACIONAL_PRODUCAO = 'true';
});
afterAll(() => { delete process.env.NFSE_NACIONAL_PRODUCAO; });

// como a rota: a config final é o SELECT da nfse_config + o que veio no PUT
const ligar = (db) => nacional.avaliarLigar(db, CID, { ...db.config, is_active: true, ambiente: 'producao' });

describe('a lista ERROS_SO_DO_AMBIENTE_DE_TESTES', () => {
  test('começa com o E0312 e nunca tem código da prefeitura', () => {
    expect(ERROS_SO_DO_AMBIENTE_DE_TESTES).toEqual(['E0312']);
    for (const c of ['E0084', 'E0116', 'E0120']) {
      expect(CODIGOS_PREFEITURA.has(c)).toBe(true);
      expect(ERROS_SO_DO_AMBIENTE_DE_TESTES).not.toContain(c);
      expect(aceitoComAvisoDoAmbienteDeTestes([{ codigo: c }])).toBe(false);
    }
  });

  test('rejeição sem código não conta como aviso', () => {
    expect(aceitoComAvisoDoAmbienteDeTestes([])).toBe(false);
    expect(aceitoComAvisoDoAmbienteDeTestes(null)).toBe(false);
  });
});

describe('gate do Ligar (avaliarLigar → PUT /config is_active) com o banco mockado', () => {
  test('E0312 sozinho: libera, lendo os error_codes da nota de teste', async () => {
    const db = dbFalso({ config: configSp(), errorCodes: [E0312] });
    const v = await ligar(db);
    expect(db.notaLida()).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.motivos).toEqual([]);
    expect(v.passos.teste).toMatchObject({
      estado: 'ok', aviso: AVISO_SO_DO_AMBIENTE_DE_TESTES, motivo: AVISO_SO_DO_AMBIENTE_DE_TESTES,
      codigo: 'E0312', codigos: ['E0312'], nfse_id: NOTA_TESTE,
    });
    expect(v.passos.prefeitura.estado).toBe('ok');
  });

  test('E0312 sozinho, error_codes em texto (jsonb vindo como string): libera', async () => {
    const db = dbFalso({ config: configSp(), errorCodes: JSON.stringify([E0312]) });
    expect((await ligar(db)).ok).toBe(true);
  });

  test('E0312 junto de outro código: não libera', async () => {
    const db = dbFalso({ config: configSp(), errorCodes: [E0312, { codigo: 'E0310', descricao: 'Código inexistente' }] });
    const v = await ligar(db);
    expect(v.ok).toBe(false);
    expect(v.motivos.join(' ')).toMatch(/Antes de ligar, emita a nota de teste/);
    expect(v.passos.teste.estado).toBe('problema');
    expect(v.passos.teste.aviso).toBeUndefined();
  });

  test('E0084: não libera e cai no passo prefeitura', async () => {
    const db = dbFalso({ config: configSp({ ultimo_teste_codigo: 'E0084' }), errorCodes: [{ codigo: 'E0084', descricao: 'Contribuinte não cadastrado no CNC' }] });
    const v = await ligar(db);
    expect(v.ok).toBe(false);
    expect(v.passos.teste.estado).toBe('problema');
    expect(v.passos.prefeitura).toMatchObject({ estado: 'problema', codigo: 'E0084' });
  });

  test('E0084 junto do E0312: não libera', async () => {
    const db = dbFalso({ config: configSp({ ultimo_teste_codigo: 'E0084' }), errorCodes: [{ codigo: 'E0084' }, E0312] });
    expect((await ligar(db)).ok).toBe(false);
  });

  test('ultimo_teste_codigo E0312 mas a nota sem código (ou sem nota): não libera', async () => {
    expect((await ligar(dbFalso({ config: configSp(), errorCodes: null }))).ok).toBe(false);
    expect((await ligar(dbFalso({ config: configSp({ ultimo_teste_nfse_id: null }), errorCodes: [E0312] }))).ok).toBe(false);
  });

  test('teste aceito continua liberando, sem ler a nota', async () => {
    const db = dbFalso({ config: configSp({ ultimo_teste_status: 'ok', ultimo_teste_codigo: null }), errorCodes: null });
    const v = await ligar(db);
    expect(v.ok).toBe(true);
    expect(v.passos.teste).toMatchObject({ estado: 'ok', motivo: 'O gov.br aceitou a nota de teste.' });
    expect(v.passos.teste.aviso).toBeUndefined();
    expect(db.notaLida()).toBe(false);
  });

  test('E0312 sozinho mas falta a alíquota do Simples: bloqueia só por isso', async () => {
    const db = dbFalso({ config: configSp({ p_tot_trib_sn: null }), errorCodes: [E0312] });
    const v = await ligar(db);
    expect(v.ok).toBe(false);
    expect(v.motivos).toHaveLength(1);
    expect(v.motivos[0]).toMatch(/alíquota do Simples Nacional/);
  });
});

describe('situação da tela (GET /config) com E0312 sozinho', () => {
  test('pronta para ligar, com o aviso no passo teste', async () => {
    const db = dbFalso({ config: configSp(), errorCodes: [E0312] });
    const s = await nacional.situacaoConfig(db, CID);
    expect(s.pronta_para_ligar).toBe(true);
    expect(s.passos.teste).toMatchObject({ estado: 'ok', aviso: AVISO_SO_DO_AMBIENTE_DE_TESTES });
    expect(s.passos.ligar).toMatchObject({ estado: 'falta', motivo: 'Falta só ligar a NFS-e.' });
    expect(s.proximo).toBe('ligar');
  });

  test('avaliarPassos sem os error_codes na config: continua bloqueado (só o código gravado não basta)', () => {
    const r = avaliarPassos({ config: configSp(), company, certInfo, producaoLiberada: true });
    expect(r.passos.teste.estado).toBe('problema');
    expect(r.pronta_para_ligar).toBe(false);
  });
});

describe('traduzirResultadoTeste', () => {
  const rejeitada = (erros) => ({ status: 'rejeitada', error_codes: erros });

  test('E0312 sozinho: status aviso, passo teste, com a mensagem gentil', () => {
    const r = nacional.traduzirResultadoTeste({ nota: rejeitada([E0312]), company });
    expect(r).toMatchObject({
      status: 'aviso', passo: 'teste', codigo: 'E0312',
      mensagem: AVISO_SO_DO_AMBIENTE_DE_TESTES, aviso: AVISO_SO_DO_AMBIENTE_DE_TESTES, caminho: [],
    });
    expect(r.mensagem).toMatch(/Pode ligar: a primeira nota de verdade confirma tudo\./);
  });

  test('E0312 junto de outro código: rejeitado, sem aviso', () => {
    const r = nacional.traduzirResultadoTeste({ nota: rejeitada([E0312, { codigo: 'E0310', descricao: 'x' }]), company });
    expect(r).toMatchObject({ status: 'rejeitado', passo: 'teste', codigo: 'E0312' });
    expect(r.aviso).toBeUndefined();
  });

  test('E0084 continua no passo prefeitura', () => {
    const r = nacional.traduzirResultadoTeste({ nota: rejeitada([{ codigo: 'E0084' }]), company });
    expect(r).toMatchObject({ status: 'rejeitado', passo: 'prefeitura', codigo: 'E0084' });
  });
});
