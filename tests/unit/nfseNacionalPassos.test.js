// ============================================================
// NFS-e Nacional — passo a passo da configuração (migration 441), funções
// puras de nfseNacional/config:
//   • avaliarAptidao mantém apta/pendências e passa a devolver os passos
//     por chave (certificado, prefeitura, dados_fiscais, codigo_padrao,
//     serie, teste, ligar), cada um com estado e motivo gentil;
//   • a loja pronta com a produção ainda travada fica "travado" no ligar,
//     com o aviso de que a Aura está liberando;
//   • série: faixas do Anexo I, 49999 reservada ao teste;
//   • alíquota do ISSQN retido: 1,80 a 5,00, só com cliente que retém e
//     ME/EPP; nunca preenchida;
//   • sugestão a partir do cadastro da empresa (Receita).
// ============================================================
'use strict';

const {
  avaliarAptidao, avaliarPassos, validarCamposNacional, validarRetencao, faixaDaSerie,
  sugestaoDaEmpresa, opSimpNacDoRegime, PASSOS, SERIE_TESTE,
} = require('../../src/services/nfseNacional/config');

const CNPJ = '11222333000181';
const company = { id: 'c1', cnpj: CNPJ, nome: 'Lume' };
const certInfo = { subject_cn: `LUME LTDA:${CNPJ}`, not_after: '2027-08-12T00:00:00Z' };
const now = new Date('2026-11-10T12:00:00Z');

function pronta(over = {}) {
  return {
    provider: 'nacional', is_active: false, ambiente: 'producao_restrita',
    municipio_ibge: '3524402', ctribnac_padrao: '060201', serie: '1', next_dps_number: 1,
    serie_confirmada_em: '2026-11-10T10:00:00Z', outro_emissor: false, op_simp_nac: 3, reg_ap_trib_sn: 1,
    p_tot_trib_sn: 6.54, cliente_retem_iss: false, aliquota_iss_retencao_sn: null,
    ultimo_teste_status: 'ok', ultimo_teste_em: '2026-11-10T11:00:00Z', ...over,
  };
}
const estados = (r) => Object.fromEntries(PASSOS.map((k) => [k, r.passos[k].estado]));

describe('avaliarPassos', () => {
  test('loja que nunca configurou: certificado do cofre da NFC-e já conta; resto falta; teste e ligar travados', () => {
    const r = avaliarPassos({ config: null, company, certInfo, now });
    expect(estados(r)).toEqual({
      certificado: 'ok', prefeitura: 'falta', dados_fiscais: 'falta', codigo_padrao: 'falta',
      serie: 'falta', teste: 'travado', ligar: 'travado',
    });
    expect(r).toMatchObject({ prontos: 1, total: 7, proximo: 'dados_fiscais', base_pronta: false, emitindo: false });
  });

  test('sem certificado: falta, com o motivo apontando a NFC-e', () => {
    const r = avaliarPassos({ config: pronta(), company, certInfo: null, now });
    expect(r.passos.certificado).toMatchObject({ estado: 'falta' });
    expect(r.passos.certificado.motivo).toMatch(/NFC-e/);
    expect(r.passos.teste.estado).toBe('ok'); // o teste antigo segue gravado
  });

  test('certificado vencido ou de outro CNPJ: problema', () => {
    expect(avaliarPassos({ config: pronta(), company, certInfo: { ...certInfo, not_after: '2026-01-01T00:00:00Z' }, now }).passos.certificado.estado).toBe('problema');
    const outro = avaliarPassos({ config: pronta(), company, certInfo: { subject_cn: 'MATRIZ:11444777000161', not_after: certInfo.not_after }, now });
    expect(outro.passos.certificado).toMatchObject({ estado: 'problema', cnpj_do_certificado: '11444777000161' });
  });

  test('base pronta e sem teste: teste "falta" (libera o botão), ligar travado', () => {
    const r = avaliarPassos({ config: pronta({ ultimo_teste_status: null, ultimo_teste_em: null }), company, certInfo, now });
    expect(r.passos.teste.estado).toBe('falta');
    expect(r.passos.ligar.estado).toBe('travado');
    expect(r.base_pronta).toBe(true);
  });

  test('série sem a resposta "Já emite NFS-e por outro emissor?": falta, mesmo com número andado (migration 443)', () => {
    for (const over of [{ outro_emissor: null }, { outro_emissor: null, next_dps_number: 48 }, { outro_emissor: undefined, serie_confirmada_em: null }]) {
      const s = avaliarPassos({ config: pronta(over), company, certInfo, now }).passos.serie;
      expect(s.estado).toBe('falta');
      expect(s.motivo).toMatch(/outro emissor/);
    }
  });

  test('não emite por outro emissor: ok com a série e o próximo número', () => {
    const r = avaliarPassos({ config: pronta({ outro_emissor: false, next_dps_number: 48 }), company, certInfo, now });
    expect(r.passos.serie).toMatchObject({ estado: 'ok', serie: '1', proximo_numero: '48', outro_emissor: false });
  });

  test('emite por outro emissor: pede série e último número; na mesma série o próximo da Aura vem depois do último dele', () => {
    const base = { outro_emissor: true, serie: '1', next_dps_number: 1 };
    expect(avaliarPassos({ config: pronta(base), company, certInfo, now }).passos.serie.estado).toBe('falta');
    const colide = avaliarPassos({ config: pronta({ ...base, outro_emissor_serie: '1', outro_emissor_ultimo_numero: 12 }), company, certInfo, now }).passos.serie;
    expect(colide.estado).toBe('problema');
    expect(colide.motivo).toMatch(/13/);
    const segue = avaliarPassos({ config: pronta({ ...base, next_dps_number: 13, outro_emissor_serie: '1', outro_emissor_ultimo_numero: 12 }), company, certInfo, now }).passos.serie;
    expect(segue).toMatchObject({ estado: 'ok', proximo_numero: '13', outro_emissor_serie: '1', outro_emissor_ultimo_numero: '12' });
    const outraSerie = avaliarPassos({ config: pronta({ ...base, serie: '3', outro_emissor_serie: '1', outro_emissor_ultimo_numero: 12 }), company, certInfo, now }).passos.serie;
    expect(outraSerie).toMatchObject({ estado: 'ok', serie: '3', proximo_numero: '1' });
  });

  test('conflito registrado pela emissão (DPS_NUMERO_JA_USADO): problema com a série e o número, até a loja conferir', () => {
    const s = avaliarPassos({
      config: pronta({ dps_conflito_em: '2026-11-10T15:00:00Z', dps_conflito_serie: '1', dps_conflito_numero: '1' }),
      company, certInfo, now,
    }).passos.serie;
    expect(s).toMatchObject({ estado: 'problema', codigo: 'DPS_NUMERO_JA_USADO', serie_usada: '1', numero_usado: '1' });
    expect(s.motivo).toBe('A série 1 e o número 1 da DPS já foram usados por outro emissor desta empresa. Confira na configuração da NFS-e a Série da DPS e o último Número usado e tente de novo.');
  });

  test('série fora da faixa de aplicativo próprio ou a de teste: problema', () => {
    expect(avaliarPassos({ config: pronta({ serie: '70001' }), company, certInfo, now }).passos.serie.estado).toBe('problema');
    expect(avaliarPassos({ config: pronta({ serie: SERIE_TESTE }), company, certInfo, now }).passos.serie.estado).toBe('problema');
  });

  test('teste ok e tudo preenchido, produção travada no servidor: ligar "travado" com o aviso da Aura', () => {
    const r = avaliarPassos({ config: pronta(), company, certInfo, now, producaoLiberada: false });
    expect(r.passos.ligar).toMatchObject({ estado: 'travado', aguardando_aura: true });
    expect(r.passos.ligar.motivo).toMatch(/Sua loja está pronta/);
    expect(r.pronta_para_ligar).toBe(true);
  });

  test('teste ok, produção liberada: "falta só ligar"; ligada em produção: ok e emitindo', () => {
    expect(avaliarPassos({ config: pronta(), company, certInfo, now, producaoLiberada: true }).passos.ligar).toMatchObject({ estado: 'falta' });
    const r = avaliarPassos({ config: pronta({ is_active: true, ambiente: 'producao' }), company, certInfo, now, producaoLiberada: true });
    expect(r.passos.ligar.estado).toBe('ok');
    expect(r.emitindo).toBe(true);
    expect(r.prontos).toBe(7);
  });

  test('ME/EPP: sem % do Simples, sem resposta da retenção ou retém sem alíquota → ligar "falta" com o motivo', () => {
    const op = { producaoLiberada: true, company, certInfo, now };
    expect(avaliarPassos({ ...op, config: pronta({ p_tot_trib_sn: null }) }).passos.ligar.motivo).toMatch(/alíquota do Simples Nacional/);
    expect(avaliarPassos({ ...op, config: pronta({ cliente_retem_iss: null }) }).passos.ligar.motivo).toMatch(/Retenção do ISSQN/);
    const r = avaliarPassos({ ...op, config: pronta({ cliente_retem_iss: true }) });
    expect(r.passos.ligar.motivo).toMatch(/Alíquota do ISSQN no Simples Nacional/);
    expect(r.pronta_para_ligar).toBe(false);
    expect(avaliarPassos({ ...op, config: pronta({ cliente_retem_iss: true, aliquota_iss_retencao_sn: '2.79' }) }).passos.ligar.estado).toBe('falta');
  });

  test('MEI: nada de % do Simples nem de retenção para ligar', () => {
    const r = avaliarPassos({ config: pronta({ op_simp_nac: 2, reg_ap_trib_sn: null, p_tot_trib_sn: null, cliente_retem_iss: null }), company, certInfo, now, producaoLiberada: true });
    expect(r.pronta_para_ligar).toBe(true);
  });

  test('prefeitura: ok com Inscrição Municipal + cadastro confirmado, ou com o teste ok', () => {
    const semTeste = { ultimo_teste_status: null, ultimo_teste_em: null };
    expect(avaliarPassos({ config: pronta({ ...semTeste, inscricao_municipal: '31.582-0', prefeitura_cadastro_confirmado: 'sim' }), company, certInfo, now }).passos.prefeitura.estado).toBe('ok');
    expect(avaliarPassos({ config: pronta({ ...semTeste, inscricao_municipal: '31.582-0', prefeitura_cadastro_confirmado: 'nao_sei' }), company, certInfo, now }).passos.prefeitura.estado).toBe('falta');
    expect(avaliarPassos({ config: pronta(), company, certInfo, now }).passos.prefeitura.estado).toBe('ok');
  });

  test('textos gentis: nenhum passo diz "não atendido"', () => {
    const r = avaliarPassos({ config: pronta({ ultimo_teste_status: 'rejeitado', ultimo_teste_codigo: 'E0084' }), company, certInfo, now });
    expect(JSON.stringify(r)).not.toMatch(/não atendid/i);
  });
});

describe('avaliarAptidao — contrato de sempre mantido', () => {
  test('apta/pendências como antes, mais os passos', () => {
    const r = avaliarAptidao({ config: pronta({ is_active: true }), company, certInfo, now });
    expect(r.apta).toBe(true);
    expect(r.pendencias).toEqual([]);
    expect(r.passos.certificado.estado).toBe('ok');
    const sem = avaliarAptidao({ config: null, company, certInfo, now });
    expect(sem).toMatchObject({ apta: false, pendencias: ['Configuração de NFS-e não cadastrada.'] });
    expect(sem.passos.dados_fiscais.estado).toBe('falta');
  });
});

describe('série da DPS — faixas do Anexo I', () => {
  test.each([
    ['1', 'aplicativo_proprio'], ['900', 'aplicativo_proprio'], ['49999', 'aplicativo_proprio'],
    ['50000', 'emissor_movel'], ['70000', 'emissor_web'], ['79999', 'emissor_web'], ['80000', 'transcricao_manual'], ['90000', null],
  ])('%s → %s', (s, f) => expect(faixaDaSerie(s)).toBe(f));

  test('PUT: série do emissor web recusada com a explicação; 49999 reservada ao teste', () => {
    const web = validarCamposNacional({ serie: '70001' });
    expect(web.erros.join(' ')).toMatch(/faixa do emissor do gov\.br/);
    expect(validarCamposNacional({ serie: '49999' }).erros.join(' ')).toMatch(/reservada para a nota de teste/);
    expect(validarCamposNacional({ serie: '00002' }).data.serie).toBe('2');
  });
});

describe('campos novos do PUT', () => {
  test('Inscrição Municipal: até 15 caracteres, vazio vira null', () => {
    expect(validarCamposNacional({ inscricao_municipal: ' 31.582-0 ' }).data.inscricao_municipal).toBe('31.582-0');
    expect(validarCamposNacional({ inscricao_municipal: '' }).data.inscricao_municipal).toBeNull();
    expect(validarCamposNacional({ inscricao_municipal: '1234567890123456' }).erros).toHaveLength(1);
  });

  test('prefeitura_cadastro_confirmado e cliente_retem_iss', () => {
    expect(validarCamposNacional({ prefeitura_cadastro_confirmado: 'nao_sei' }).data.prefeitura_cadastro_confirmado).toBe('nao_sei');
    expect(validarCamposNacional({ prefeitura_cadastro_confirmado: 'talvez' }).erros).toHaveLength(1);
    expect(validarCamposNacional({ cliente_retem_iss: true }).data.cliente_retem_iss).toBe(true);
    expect(validarCamposNacional({ cliente_retem_iss: 'sim' }).erros).toHaveLength(1);
  });

  test('alíquota do ISSQN retido no Simples: 1,80 a 5,00, com vírgula; fora disso recusa', () => {
    expect(validarCamposNacional({ aliquota_iss_retencao_sn: '2,79' }).data.aliquota_iss_retencao_sn).toBe(2.79);
    expect(validarCamposNacional({ aliquota_iss_retencao_sn: null }).data.aliquota_iss_retencao_sn).toBeNull();
    for (const v of ['1,79', '5,01', 'abc']) expect(validarCamposNacional({ aliquota_iss_retencao_sn: v }).erros).toHaveLength(1);
  });

  test('validarRetencao: só com cliente que retém e ME/EPP; dizer "não retém" apaga a alíquota', () => {
    expect(validarRetencao({ op_simp_nac: 3, cliente_retem_iss: true }, { aliquota_iss_retencao_sn: 2.5 })).toEqual([]);
    expect(validarRetencao({ op_simp_nac: 3, cliente_retem_iss: false }, { aliquota_iss_retencao_sn: 2.5 })[0]).toMatch(/algum cliente faz a Retenção/);
    expect(validarRetencao({ op_simp_nac: 2 }, { cliente_retem_iss: true, aliquota_iss_retencao_sn: 2.5 })[0]).toMatch(/ME\/EPP/);
    const data = { cliente_retem_iss: false };
    expect(validarRetencao({ op_simp_nac: 3, cliente_retem_iss: true, aliquota_iss_retencao_sn: 2.5 }, data)).toEqual([]);
    expect(data.aliquota_iss_retencao_sn).toBeNull();
  });
});

describe('sugestão do cadastro da empresa', () => {
  test('município, UF, IBGE e Situação perante o Simples Nacional da Receita', () => {
    expect(sugestaoDaEmpresa({ cnpj: '11.222.333/0001-81', address_city: 'Jacareí', address_state: 'SP', ibge_code: '3524402', tax_regime: 'simples_nacional' }))
      .toMatchObject({ cnpj: CNPJ, municipio: 'Jacareí', uf: 'SP', municipio_ibge: '3524402', op_simp_nac: 3, reg_ap_trib_sn: 1, fonte: 'receita' });
  });

  test('sem ibge_code: vazio para a lojista confirmar', () => {
    expect(sugestaoDaEmpresa({ address_city: 'Jacareí', address_state: 'SP', ibge_code: null }).municipio_ibge).toBeNull();
  });

  test.each([['mei', 2], ['simples_nacional', 3], ['lucro_presumido', 1], ['lucro_real', 1], [null, null]])('%s → %s', (r, op) => {
    expect(opSimpNacDoRegime(r)).toBe(op);
  });
});
