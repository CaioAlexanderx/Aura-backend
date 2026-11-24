// ============================================================
// NFS-e Nacional — lojas da Bahia (23/11/2026).
//
// Nada no emissor depende de SP: o que faltava para a Bahia era
//   • o código IBGE do município (cLocEmi): companies.ibge_code está nulo
//     em todas as lojas baianas, e a tela pedia para a lojista digitar;
//   • a situação no Simples pela Receita: o gov.br confere a opSimpNac com
//     o cadastro do Simples (E0160) e o cadastro da Aura pode estar errado;
//   • o texto gentil para o E0039 (cidade que emite pelo sistema próprio)
//     e para o E0160.
// Rede SIMULADA (fetch e lookup injetados): nenhum teste sai para a internet.
// ============================================================
'use strict';

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(async () => null),
  saveCertificate: jest.fn(),
}));

const municipio = require('../../src/services/nfseNacional/municipio');
const nacional = require('../../src/services/nfseNacional');
const { buildDps } = require('../../src/services/nfseNacional/dpsBuilder');
const { avaliarPassos, CODIGOS_PREFEITURA, aceitoComAvisoDoAmbienteDeTestes } = require('../../src/services/nfseNacional/config');

const LISTA_BA = [
  { id: 2933307, nome: 'Vitória da Conquista' },
  { id: 2911303, nome: 'Gentio do Ouro' },
  { id: 2924801, nome: 'Piritiba' },
  { id: 2927408, nome: 'Salvador' },
  { id: 2910800, nome: 'Feira de Santana' },
  { id: 2905701, nome: 'Camaçari' },
  { id: 2919207, nome: 'Lauro de Freitas' },
  { id: 2910057, nome: "Dias d'Ávila" },
  { id: 2933604, nome: 'Xique-Xique' },
];

function fetchFalso(rotas) {
  const chamadas = [];
  const f = jest.fn(async (url) => {
    chamadas.push(url);
    const corpo = rotas[url];
    if (corpo === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => corpo };
  });
  f.chamadas = chamadas;
  return f;
}

const URL_BA = `${municipio.IBGE_BASE}/BA/municipios`;

beforeEach(() => municipio._limparCaches());

describe('nome da cidade → código IBGE', () => {
  test('acento, caixa, apóstrofo e hífen não atrapalham', async () => {
    const f = fetchFalso({ [URL_BA]: LISTA_BA });
    expect(await municipio.ibgePeloNome('VITORIA DA CONQUISTA', 'ba', { fetchImpl: f })).toBe('2933307');
    expect(await municipio.ibgePeloNome('gentio do ouro', 'BA', { fetchImpl: f })).toBe('2911303');
    expect(await municipio.ibgePeloNome('Dias D Avila', 'BA', { fetchImpl: f })).toBe('2910057');
    expect(await municipio.ibgePeloNome('Xique Xique', 'BA', { fetchImpl: f })).toBe('2933604');
    expect(await municipio.ibgePeloNome('Camacari', 'BA', { fetchImpl: f })).toBe('2905701');
    // a lista da UF é buscada uma vez só
    expect(f).toHaveBeenCalledTimes(1);
  });

  test('cidade que não existe na UF, UF inválida ou IBGE fora do ar: null (nunca inventa)', async () => {
    const f = fetchFalso({ [URL_BA]: LISTA_BA });
    expect(await municipio.ibgePeloNome('Jacareí', 'BA', { fetchImpl: f })).toBeNull();
    expect(await municipio.ibgePeloNome('Salvador', 'XX', { fetchImpl: f })).toBeNull();
    municipio._limparCaches();
    const fora = jest.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await municipio.ibgePeloNome('Salvador', 'BA', { fetchImpl: fora })).toBeNull();
    // falha não é cacheada: com o IBGE de volta, resolve
    expect(await municipio.ibgePeloNome('Salvador', 'BA', { fetchImpl: fetchFalso({ [URL_BA]: LISTA_BA }) })).toBe('2927408');
  });
});

describe('resolverMunicipioERegime — ordem cadastro → CEP → nome → Receita', () => {
  test('ibge_code do cadastro vence e não consulta nada fora', async () => {
    const f = fetchFalso({});
    const r = await municipio.resolverMunicipioERegime(
      { ibge_code: '3524402', address_city: 'Jacareí', address_state: 'SP' },
      { fetchImpl: f, buscarCep: jest.fn(), consultarReceita: false }
    );
    expect(r).toMatchObject({ municipio_ibge: '3524402', fonte_municipio: 'cadastro' });
    expect(f).not.toHaveBeenCalled();
  });

  test('Gentio do Ouro e Piritiba (sem CEP e sem IBGE no cadastro): pelo nome da cidade', async () => {
    const f = fetchFalso({ [URL_BA]: LISTA_BA });
    const buscarCep = jest.fn();
    const deps = { fetchImpl: f, buscarCep, consultarReceita: false };
    const gentio = await municipio.resolverMunicipioERegime({ address_city: 'Gentio do Ouro', address_state: 'BA', address_zip: null, ibge_code: null }, deps);
    const piritiba = await municipio.resolverMunicipioERegime({ address_city: 'Piritiba', address_state: 'BA', address_zip: null, ibge_code: null }, deps);
    expect(gentio).toMatchObject({ municipio_ibge: '2911303', fonte_municipio: 'nome_da_cidade', uf: 'BA' });
    expect(piritiba).toMatchObject({ municipio_ibge: '2924801', fonte_municipio: 'nome_da_cidade' });
    expect(buscarCep).not.toHaveBeenCalled();
  });

  test('CEP do cadastro: ViaCEP primeiro', async () => {
    const buscarCep = jest.fn(async () => ({ ibge: '2933307', municipio: 'Vitória da Conquista', uf: 'BA' }));
    const r = await municipio.resolverMunicipioERegime(
      { address_zip: '45000-240', address_city: null, address_state: null },
      { fetchImpl: fetchFalso({}), buscarCep, consultarReceita: false }
    );
    expect(buscarCep).toHaveBeenCalledWith('45000240');
    expect(r).toMatchObject({ municipio_ibge: '2933307', fonte_municipio: 'cep', municipio: 'Vitória da Conquista', uf: 'BA' });
  });

  test('ótica de Vitória da Conquista sem endereço nenhum: a Receita dá a cidade e o regime', async () => {
    const lookupReceita = jest.fn(async () => ({
      address_city: 'Vitória da Conquista', address_state: 'BA', address_zip: '',
      suggested_regime: 'mei', regime_fonte: 'receita',
    }));
    const r = await municipio.resolverMunicipioERegime(
      { cnpj: '63870608000197', address_city: null, address_state: null, tax_regime: 'simples_nacional' },
      { fetchImpl: fetchFalso({ [URL_BA]: LISTA_BA }), buscarCep: jest.fn(), lookupReceita }
    );
    expect(r).toMatchObject({
      municipio_ibge: '2933307', fonte_municipio: 'receita', municipio: 'Vitória da Conquista', uf: 'BA',
      receita: { op_simp_nac: 2, regime: 'mei', fonte: 'receita' },
    });
    // repetir não consulta a Receita de novo (cache por CNPJ)
    await municipio.resolverMunicipioERegime({ cnpj: '63870608000197' }, { fetchImpl: fetchFalso({ [URL_BA]: LISTA_BA }), buscarCep: jest.fn(), lookupReceita });
    expect(lookupReceita).toHaveBeenCalledTimes(1);
  });

  test('regime só estimado pela Receita não entra na sugestão', async () => {
    const r = await municipio.resolverMunicipioERegime(
      { cnpj: '41988099000169', address_city: 'Gentio do Ouro', address_state: 'BA' },
      {
        fetchImpl: fetchFalso({ [URL_BA]: LISTA_BA }), buscarCep: jest.fn(),
        lookupReceita: async () => ({ suggested_regime: 'simples_nacional', regime_fonte: 'estimado' }),
      }
    );
    expect(r.municipio_ibge).toBe('2911303');
    expect(r.receita).toBeNull();
  });

  test('Receita fora do ar: segue sem ela', async () => {
    const r = await municipio.resolverMunicipioERegime(
      { cnpj: '41988099000169', address_city: 'Gentio do Ouro', address_state: 'BA' },
      { fetchImpl: fetchFalso({ [URL_BA]: LISTA_BA }), buscarCep: jest.fn(), lookupReceita: async () => { throw new Error('503'); } }
    );
    expect(r).toMatchObject({ municipio_ibge: '2911303', receita: null });
  });
});

describe('completarSugestao', () => {
  test('preenche o IBGE e diz de onde veio; o do cadastro nunca é trocado', () => {
    const s = municipio.completarSugestao({ municipio_ibge: null, municipio: 'Piritiba', uf: 'BA', op_simp_nac: 2 },
      { municipio_ibge: '2924801', fonte_municipio: 'nome_da_cidade', receita: null }, { tax_regime: 'mei' });
    expect(s).toMatchObject({ municipio_ibge: '2924801', municipio_ibge_fonte: 'nome_da_cidade', op_simp_nac: 2 });
    expect(s.regime_divergente).toBeUndefined();
    const c = municipio.completarSugestao({ municipio_ibge: '3550308' }, { municipio_ibge: '9999999' }, {});
    expect(c).toMatchObject({ municipio_ibge: '3550308', municipio_ibge_fonte: 'cadastro' });
  });

  test('cadastro da Aura diz Simples, Receita diz MEI: sugere MEI e conta a divergência', () => {
    const s = municipio.completarSugestao(
      { municipio_ibge: null, op_simp_nac: 3, reg_ap_trib_sn: 1 },
      { municipio_ibge: '2933307', fonte_municipio: 'receita', receita: { op_simp_nac: 2, regime: 'mei', fonte: 'receita' } },
      { tax_regime: 'simples_nacional' },
      { op_simp_nac: 3 }
    );
    expect(s).toMatchObject({
      op_simp_nac: 2, reg_ap_trib_sn: null, fonte: 'receita',
      regime_divergente: { cadastro_aura: 'simples_nacional', receita: 'mei' },
    });
    expect(s.aviso_regime).toMatch(/ME\/EPP do Simples Nacional/);
    expect(s.aviso_regime).toMatch(/\(MEI\)/);
  });
});

describe('situacaoConfig — a tela já vem com o município da Bahia', () => {
  function dbFalso({ company, config = null }) {
    return {
      query: jest.fn(async (sql) => {
        if (/FROM nfse_config/i.test(sql)) return { rows: config ? [config] : [] };
        if (/FROM companies/i.test(sql)) return { rows: [company] };
        return { rows: [] };
      }),
    };
  }

  test('Farmácia Carvalho (Gentio do Ouro, sem ibge_code): sugestão 2911303', async () => {
    const db = dbFalso({ company: { id: 'c1', cnpj: '41988099000169', nome: 'FARMACIA CARVALHO', address_city: 'Gentio do Ouro', address_state: 'BA', ibge_code: null, tax_regime: 'simples_nacional' } });
    const s = await nacional.situacaoConfig(db, 'c1', {
      municipioDeps: { fetchImpl: fetchFalso({ [URL_BA]: LISTA_BA }), buscarCep: jest.fn(), lookupReceita: async () => null },
    });
    expect(s.sugestao).toMatchObject({ municipio: 'Gentio do Ouro', uf: 'BA', municipio_ibge: '2911303', municipio_ibge_fonte: 'nome_da_cidade', op_simp_nac: 3 });
  });

  test('IBGE lento: a tela não espera além do prazo e volta com a sugestão de sempre', async () => {
    const db = dbFalso({ company: { id: 'c2', cnpj: '65314499000157', address_city: 'Piritiba', address_state: 'BA', tax_regime: 'mei' } });
    // só responde quando o pedido é abortado (o prazo da tela vence antes)
    const lento = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('abortado')));
    }));
    const s = await nacional.situacaoConfig(db, 'c2', {
      municipioDeps: { fetchImpl: lento, timeoutMs: 80, buscarCep: jest.fn(), lookupReceita: async () => null, prazoMs: 30 },
    });
    expect(s.sugestao).toMatchObject({ municipio: 'Piritiba', municipio_ibge: null, op_simp_nac: 2 });
  });

  test('loja já emitindo (dados e teste ok): nenhuma consulta fora', async () => {
    const company = { id: 'c3', cnpj: '11222333000181', address_city: 'Jacareí', address_state: 'SP', ibge_code: null };
    const config = {
      provider: 'nacional', is_active: true, ambiente: 'producao_restrita', municipio_ibge: '3524402', op_simp_nac: 3,
      ctribnac_padrao: '060201', serie: '1', next_dps_number: 5, outro_emissor: false, ultimo_teste_status: 'ok',
    };
    const f = fetchFalso({});
    const lookupReceita = jest.fn();
    const s = await nacional.situacaoConfig(dbFalso({ company, config }), 'c3', { municipioDeps: { fetchImpl: f, buscarCep: jest.fn(), lookupReceita } });
    expect(f).not.toHaveBeenCalled();
    expect(lookupReceita).not.toHaveBeenCalled();
    expect(s.sugestao.municipio_ibge).toBeNull();
  });
});

describe('E0039 e E0160 na nota de teste', () => {
  const rejeitada = (erros) => ({ status: 'rejeitada', error_codes: erros });
  const E0039 = { codigo: 'E0039', descricao: 'O município emissor informado na DPS deve estar parametrizado para utilizar os emissores públicos nacionais' };
  const E0160 = { codigo: 'E0160', descricao: 'No mês de competência da NFS-e, a opção de situação perante o Simples Nacional, do prestador, informada na DPS não está de acordo com o cadastro Simples Nacional' };

  test('E0039: passo prefeitura, texto gentil com a cidade e o caminho assistido; nunca libera o Ligar', () => {
    const r = nacional.traduzirResultadoTeste({ nota: rejeitada([E0039]), company: { address_city: 'Salvador' } });
    expect(r).toMatchObject({ status: 'rejeitado', passo: 'prefeitura', codigo: 'E0039' });
    expect(r.titulo).toMatch(/A prefeitura de Salvador ainda emite NFS-e pelo sistema próprio/);
    expect(r.caminho.join(' ')).toMatch(/continue emitindo a NFS-e no site da prefeitura/);
    expect(r.caminho.join(' ')).toMatch(/suporte Aura/);
    expect(CODIGOS_PREFEITURA.has('E0039')).toBe(true);
    expect(aceitoComAvisoDoAmbienteDeTestes([E0039])).toBe(false);
  });

  test('E0039 gravado: passo prefeitura em problema, mas a nota de teste pode ser refeita', () => {
    const config = {
      provider: 'nacional', municipio_ibge: '2927408', op_simp_nac: 1, ctribnac_padrao: '060201', serie: '1',
      next_dps_number: 1, outro_emissor: false, ultimo_teste_status: 'rejeitado', ultimo_teste_codigo: 'E0039',
    };
    const company = { cnpj: '11222333000181' };
    const certInfo = { subject_cn: 'LOJA:11222333000181', not_after: '2030-01-01T00:00:00Z' };
    const r = avaliarPassos({ config, company, certInfo, now: new Date('2026-11-23T12:00:00Z') });
    expect(r.passos.prefeitura).toMatchObject({ estado: 'problema', codigo: 'E0039' });
    expect(r.base_pronta).toBe(true);
    expect(r.passos.ligar.estado).not.toBe('ok');
  });

  test('E0160: passo dados_fiscais, pede para conferir a Situação perante o Simples', () => {
    const r = nacional.traduzirResultadoTeste({ nota: rejeitada([E0160]), company: { address_city: 'Vitória da Conquista' } });
    expect(r).toMatchObject({ status: 'rejeitado', passo: 'dados_fiscais', codigo: 'E0160' });
    expect(r.caminho.join(' ')).toMatch(/passo Dados da nota/);
  });
});

describe('DPS de loja baiana: nada de SP no XML', () => {
  const base = {
    tpAmb: 2, serie: '1', nDPS: '1', dCompet: '2026-11-23', dhEmi: new Date('2026-11-23T13:00:00Z'),
    servico: { cTribNac: '140101', descricao: 'Ajuste e conserto de oculos' }, valores: { vServ: 50 },
  };

  test('MEI de Vitória da Conquista: cLocEmi/cLocPrestacao 2933307, opSimpNac 2, sem regApTribSN, indTotTrib 0', () => {
    const { xml, idDps } = buildDps({ ...base, cLocEmi: '2933307', prestador: { cnpj: '63870608000197', opSimpNac: 2 } });
    expect(idDps.startsWith('DPS2933307263870608000197')).toBe(true);
    expect(xml).toContain('<cLocEmi>2933307</cLocEmi>');
    expect(xml).toContain('<cLocPrestacao>2933307</cLocPrestacao>');
    expect(xml).toContain('<opSimpNac>2</opSimpNac>');
    expect(xml).not.toContain('regApTribSN');
    expect(xml).toContain('<indTotTrib>0</indTotTrib>');
    expect(xml).not.toMatch(/3550308|3524402/);
  });

  test('ME/EPP de Gentio do Ouro: opSimpNac 3 + regApTribSN 1 + pTotTribSN; sem Inscrição Municipal', () => {
    const { xml } = buildDps({ ...base, cLocEmi: '2911303', prestador: { cnpj: '41988099000169', opSimpNac: 3, regApTribSN: 1 }, valores: { vServ: 50, pTotTribSN: 6 } });
    expect(xml).toContain('<cLocEmi>2911303</cLocEmi>');
    expect(xml).toContain('<opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN>');
    expect(xml).toContain('<pTotTribSN>6.00</pTotTribSN>');
    expect(xml).not.toContain('<IM>');
  });
});
