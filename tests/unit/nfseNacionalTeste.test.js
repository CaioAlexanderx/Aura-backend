// ============================================================
// NFS-e Nacional — nota de teste (POST /nfse/teste, migration 441) e a
// alíquota do ISSQN retido no Simples na emissão real.
//
// Sefin SIMULADO (transport injetado) e banco em memória (repo trocado por
// um fake com a mesma semântica; o SQL real roda em
// __tests__/nfseNacional.banco.test.js).
//
// O que fica provado aqui:
//   • o teste vai SEMPRE para a produção restrita (tpAmb 2), mesmo com a
//     loja em produção, sem exigir is_active;
//   • série 49999 com contador próprio: next_dps_number da loja não anda;
//   • chave própria "teste:..."; repetir a chave é replay (um POST só);
//   • autorizada → ultimo_teste ok; E0084/E0116/E0120 → passo prefeitura
//     com o caminho; outro código → passo teste; timeout → erro, aguardando;
//   • passos base faltando → TESTE_TRAVADO, nada sai;
//   • emissão real com ISSQN retido usa aliquota_iss_retencao_sn; sem ela,
//     recusa gentil e nenhum número gasto.
// ============================================================
'use strict';

const zlib = require('zlib');

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

jest.mock('../../src/services/nfseNacional/repo', () => {
  const state = { config: null, company: null, certInfo: null, notas: [], seq: 0, testes: [] };
  const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  const find = (id) => state.notas.find((n) => n.id === id);
  return {
    __state: state,
    __reset(over = {}) {
      Object.assign(state, { config: null, company: null, certInfo: null, notas: [], seq: 0, testes: [] }, over);
    },
    buscarPorChave: jest.fn(async (db, companyId, key) => clone(state.notas.find((n) => n.company_id === companyId && n.idempotency_key === key)) || null),
    buscarPorId: jest.fn(async (db, companyId, id) => clone(state.notas.find((n) => n.company_id === companyId && n.id === id)) || null),
    carregarContexto: jest.fn(async () => {
      // como o repo de verdade: traz os error_codes da última nota de teste rejeitada
      const config = clone(state.config);
      if (config) {
        const n = config.ultimo_teste_status === 'rejeitado' && config.ultimo_teste_nfse_id ? find(config.ultimo_teste_nfse_id) : null;
        config.ultimo_teste_error_codes = n ? clone(n.error_codes) || null : null;
      }
      return { config, company: clone(state.company), certInfo: clone(state.certInfo) };
    }),
    reservar: jest.fn(async (db, { companyId, key, fp, entrada, nota, ambiente, serieTeste }) => {
      if (!state.config) return { semConfig: true };
      if (state.notas.some((n) => n.company_id === companyId && n.idempotency_key === key)) return { corrida: true };
      const col = serieTeste ? 'teste_next_dps_number' : 'next_dps_number';
      const n = state.config[col]++;
      const row = {
        id: `nota-${++state.seq}`, company_id: companyId, status: 'pendente', provider: 'nacional',
        idempotency_key: key, idempotency_fingerprint: fp, ambiente, source_type: nota.source_type || 'manual',
        dps_serie: serieTeste || String(parseInt(state.config.serie || '1', 10)), dps_number: String(n), dps_id: null,
        dps_dados: clone(entrada), xml_dps: null, transmitted_at: null, chave_acesso: null, nfse_number: null,
        xml_nfse: null, error_codes: null, rejection_reason: null,
      };
      state.notas.push(row);
      return { row: clone(row) };
    }),
    marcarTransmitindo: jest.fn(async (db, id, { idDps, xml }) => Object.assign(find(id), { dps_id: idDps, xml_dps: xml, transmitted_at: new Date().toISOString(), status: 'pendente' })),
    marcarSemConfirmacao: jest.fn(async (db, id, msg) => { find(id).rejection_reason = msg; }),
    marcarErro: jest.fn(async (db, id, msg, codigos) => {
      const n = find(id);
      if (['pendente', 'erro'].includes(n.status)) Object.assign(n, { status: 'erro', rejection_reason: msg, error_codes: codigos || n.error_codes });
    }),
    gravarAutorizada: jest.fn(async (db, id, { chaveAcesso, nfseXml }) => Object.assign(find(id), { status: 'autorizada', chave_acesso: chaveAcesso, xml_nfse: nfseXml })),
    gravarRejeitada: jest.fn(async (db, id, { texto, erros }) => Object.assign(find(id), { status: 'rejeitada', rejection_reason: texto, error_codes: erros })),
    gravarCancelada: jest.fn(async () => {}),
    gravarCancelamentoRecusado: jest.fn(async () => {}),
    atualizarXmlNfse: jest.fn(async () => {}),
    gravarResultadoTeste: jest.fn(async (db, companyId, r) => {
      state.testes.push(r);
      Object.assign(state.config, {
        ultimo_teste_em: '2026-11-10T13:00:00.000Z', ultimo_teste_status: r.status, ultimo_teste_codigo: r.codigo || null,
        ultimo_teste_mensagem: r.mensagem || null, ultimo_teste_nfse_id: r.nfseId || null,
      });
    }),
  };
});

const repo = require('../../src/services/nfseNacional/repo');
const certStore = require('../../src/services/sefazSp/certStore');
const nacional = require('../../src/services/nfseNacional');
const { avaliarPassos } = require('../../src/services/nfseNacional/config');
const { gerarA1 } = require('../helpers/certA1Teste');

const CID = 'empresa-lume';
const CNPJ = '11222333000181';
const RESTRITA = 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
const CHAVE = '35244022' + '2' + CNPJ + '0000000000007' + '2611' + '123456789' + '1';
const db = {};
const ctxBase = { retry: { attempts: 1, baseDelayMs: 0 }, now: () => new Date('2026-11-10T13:00:00Z') };

const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const ungz = (b) => zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8');
const json = (status, body) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const nfseXml = () => `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}"><nNFSe>1</nNFSe><cStat>100</cStat><dhProc>2026-11-10T10:00:05-03:00</dhProc><valores><vLiq>1.00</vLiq></valores></infNFSe></NFSe>`;

function sefinFalso(plano = {}) {
  const chamadas = [];
  const t = jest.fn(async (req) => {
    chamadas.push(req);
    const p = new URL(req.url).pathname;
    if (req.method === 'POST' && p.endsWith('/SefinNacional/nfse')) return (plano.postDps || (() => json(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: gz(nfseXml()), alertas: [] })))(req);
    if (req.method === 'GET' && /\/dps\//.test(p)) return json(404, { erro: { codigo: 'E2404', descricao: 'Não foi gerada' } });
    return json(500, {});
  });
  t.chamadas = chamadas;
  t.posts = () => chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/nfse'));
  return t;
}
const dpsDoPost = (req) => ungz(req.body.dpsXmlGZipB64);

/** Loja com os passos base prontos, NFS-e desligada, ainda sem p_tot_trib_sn. */
function configBase(over = {}) {
  return {
    company_id: CID, provider: 'nacional', is_active: false, ambiente: 'producao_restrita',
    municipio_ibge: '3524402', ctribnac_padrao: '060201', serie: '1', next_dps_number: 48,
    teste_next_dps_number: 1, op_simp_nac: 3, reg_ap_trib_sn: 1, p_tot_trib_sn: null,
    serie_confirmada_em: '2026-11-10T12:00:00Z', inscricao_municipal: null, default_iss_rate: '2.00',
    ...over,
  };
}

let a1;
beforeAll(() => { a1 = gerarA1({ cnpj: CNPJ }); });

beforeEach(() => {
  process.env.NFSE_NACIONAL_ENABLED = 'true';
  delete process.env.NFSE_NACIONAL_PRODUCAO;
  nacional._breaker.reset();
  repo.__reset({
    config: configBase(),
    company: { id: CID, cnpj: CNPJ, nome: 'Lume Estética', address_city: 'Jacareí', address_state: 'SP' },
    certInfo: { subject_cn: `LUME ESTETICA LTDA:${CNPJ}`, not_after: a1.notAfter },
  });
  certStore.loadCertificate.mockReset();
  certStore.loadCertificate.mockResolvedValue({ pfx: a1.pfx, password: a1.senha });
});
afterAll(() => { delete process.env.NFSE_NACIONAL_ENABLED; });

describe('emitirTeste — sempre em produção restrita, série e contador próprios', () => {
  test('autorizada: tpAmb 2, série 49999 nº 1, next_dps_number da loja intacto, ultimo_teste ok', async () => {
    const t = sefinFalso();
    const r = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'clique-1' }, { ...ctxBase, transport: t });
    expect(r.resultado).toMatchObject({ status: 'ok', passo: 'teste', codigo: null });
    expect(r.nota).toMatchObject({ status: 'autorizada', dps_serie: '49999', dps_number: '1', ambiente: 'producao_restrita', source_type: 'teste' });
    expect(r.nota.idempotency_key).toBe('teste:clique-1');
    expect(t.posts()).toHaveLength(1);
    expect(t.posts()[0].url).toBe(`${RESTRITA}/nfse`);
    const dps = dpsDoPost(t.posts()[0]);
    expect(dps).toContain('<tpAmb>2</tpAmb>');
    expect(dps).toContain('<serie>49999</serie>');
    expect(dps).toContain('<nDPS>1</nDPS>');
    expect(dps).toContain('<vServ>1.00</vServ>');
    expect(dps).toContain('SEM VALOR FISCAL');
    expect(dps).toContain('<pTotTribSN>0.00</pTotTribSN>'); // sem o % ainda: teste vai com 0,00
    const st = repo.__state;
    expect(st.config.next_dps_number).toBe(48); // numeração de verdade não andou
    expect(st.config.teste_next_dps_number).toBe(2);
    expect(st.config.ultimo_teste_status).toBe('ok');
    expect(st.config.ultimo_teste_nfse_id).toBe(r.nota.id);
    expect(avaliarPassos({ config: st.config, company: st.company, certInfo: st.certInfo }).passos.teste.estado).toBe('ok');
  });

  test('loja em produção (ambiente producao) e sem a trava aberta: o teste vai mesmo assim para a restrita', async () => {
    repo.__state.config.ambiente = 'producao';
    const t = sefinFalso();
    const r = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t });
    expect(r.resultado.status).toBe('ok');
    expect(t.posts()[0].url).toBe(`${RESTRITA}/nfse`);
  });

  test('mesma chave duas vezes: replay, um POST só; sem chave, cada clique é um teste novo', async () => {
    const t = sefinFalso();
    await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k1' }, { ...ctxBase, transport: t });
    const r2 = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k1' }, { ...ctxBase, transport: t });
    expect(r2.replay).toBe(true);
    expect(t.posts()).toHaveLength(1);
    await nacional.emitirTeste(db, { companyId: CID }, { ...ctxBase, transport: t });
    expect(t.posts()).toHaveLength(2);
    expect(repo.__state.config.teste_next_dps_number).toBe(3);
  });

  test('E0084: rejeitado, cai no passo prefeitura com o caminho; os passos pintam prefeitura e teste com problema', async () => {
    const t = sefinFalso({ postDps: () => json(400, { erros: [{ Codigo: 'E0084', Descricao: 'Contribuinte não cadastrado no CNC do município' }] }) });
    const r = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t });
    expect(r.resultado).toMatchObject({ status: 'rejeitado', passo: 'prefeitura', codigo: 'E0084' });
    expect(r.resultado.titulo).toContain('prefeitura de Jacareí');
    expect(r.resultado.caminho.join(' ')).toMatch(/Cadastro Nacional de Contribuintes da NFS-e/);
    expect(JSON.stringify(r.resultado)).not.toMatch(/não atendid/i);
    const st = repo.__state;
    expect(st.config).toMatchObject({ ultimo_teste_status: 'rejeitado', ultimo_teste_codigo: 'E0084' });
    const av = avaliarPassos({ config: st.config, company: st.company, certInfo: st.certInfo });
    expect(av.passos.prefeitura).toMatchObject({ estado: 'problema', codigo: 'E0084' });
    expect(av.passos.teste.estado).toBe('problema');
    expect(av.passos.ligar.estado).toBe('travado');
    expect(av.proximo).toBe('prefeitura');
  });

  test.each([
    ['E0116', /pede a Inscrição Municipal/],
    ['E0120', /Inscrição Municipal ainda não aparece/],
  ])('%s também cai no passo prefeitura', async (codigo, re) => {
    const t = sefinFalso({ postDps: () => json(400, { erros: [{ Codigo: codigo, Descricao: 'x' }] }) });
    const r = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t });
    expect(r.resultado).toMatchObject({ status: 'rejeitado', passo: 'prefeitura', codigo });
    expect(r.resultado.titulo).toMatch(re);
  });

  test('outro código do gov.br: passo teste, código guardado para o suporte', async () => {
    const t = sefinFalso({ postDps: () => json(400, { erros: [{ Codigo: 'E0310', Descricao: 'Código de tributação nacional inexistente' }] }) });
    const r = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t });
    expect(r.resultado).toMatchObject({ status: 'rejeitado', passo: 'teste', codigo: 'E0310' });
    expect(r.resultado.mensagem).toMatch(/contador ou o suporte Aura/);
    expect(repo.__state.config.ultimo_teste_codigo).toBe('E0310');
  });

  test('E0312 sozinho (São Paulo, 10/11): status aviso, grava rejeitado, passo teste ok com aviso, Ligar liberado', async () => {
    Object.assign(repo.__state.config, { municipio_ibge: '3550308', ctribnac_padrao: '130501', p_tot_trib_sn: 6.54, cliente_retem_iss: false });
    const t = sefinFalso({ postDps: () => json(400, { erros: [{ Codigo: 'E0312', Descricao: 'O código de tributação nacional informado não está administrado pelo município' }] }) });
    const r = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t });
    expect(r.resultado).toMatchObject({ status: 'aviso', passo: 'teste', codigo: 'E0312' });
    expect(r.resultado.aviso).toMatch(/Pode ligar/);
    expect(repo.__state.config).toMatchObject({ ultimo_teste_status: 'rejeitado', ultimo_teste_codigo: 'E0312', ultimo_teste_nfse_id: r.nota.id });
    const { config, company, certInfo } = await repo.carregarContexto(db, CID);
    const av = avaliarPassos({ config, company, certInfo, producaoLiberada: true });
    expect(av.passos.teste).toMatchObject({ estado: 'ok', codigo: 'E0312' });
    expect(av.passos.teste.aviso).toMatch(/ambiente de testes do governo/);
    expect(av.pronta_para_ligar).toBe(true);
    expect(av.passos.ligar.estado).toBe('falta');
  });

  test('timeout: erro "sem resposta", aguardando; a mesma chave retoma com o MESMO número', async () => {
    const t1 = sefinFalso({ postDps: () => { throw new Error('timeout após 30000ms'); } });
    const r1 = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t1 });
    expect(r1.resultado).toMatchObject({ status: 'erro', aguardando: true });
    expect(repo.__state.config.ultimo_teste_status).toBe('erro');
    const t2 = sefinFalso();
    const r2 = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t2 });
    expect(r2.resultado.status).toBe('ok');
    expect(r2.nota.dps_number).toBe('1');
    expect(repo.__state.config.teste_next_dps_number).toBe(2);
  });

  test('certificado de outro CNPJ: resultado no passo certificado, nada transmitido', async () => {
    const outro = gerarA1({ cnpj: '11444777000161' });
    certStore.loadCertificate.mockResolvedValue({ pfx: outro.pfx, password: outro.senha });
    const t = sefinFalso();
    const r = await nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t });
    expect(r.resultado).toMatchObject({ status: 'erro', passo: 'certificado' });
    expect(t.posts()).toHaveLength(0);
  });

  test('passos base faltando (sem código padrão, série não confirmada): TESTE_TRAVADO, nada sai, nada gravado', async () => {
    repo.__state.config.ctribnac_padrao = null;
    repo.__state.config.serie_confirmada_em = null;
    repo.__state.config.next_dps_number = 1;
    const t = sefinFalso();
    await expect(nacional.emitirTeste(db, { companyId: CID, idempotencyKey: 'k' }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'TESTE_TRAVADO', details: ['codigo_padrao', 'serie'] });
    expect(t.posts()).toHaveLength(0);
    expect(repo.__state.testes).toHaveLength(0);
  });

  test('liga geral desligada: recusa sem nada gravado', async () => {
    delete process.env.NFSE_NACIONAL_ENABLED;
    await expect(nacional.emitirTeste(db, { companyId: CID }, ctxBase)).rejects.toMatchObject({ code: 'NACIONAL_DESLIGADO' });
    expect(repo.__state.testes).toHaveLength(0);
  });

  test('a emissão real não aceita chave do espaço de teste', async () => {
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'teste:x', nota: { descricao: 'x', valor: 1 } }, ctxBase))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY' });
  });
});

describe('emissão real com Retenção do ISSQN (ME/EPP)', () => {
  const tomador = { doc: '11444777000161', nome: 'Cliente PJ' };
  beforeEach(() => {
    Object.assign(repo.__state.config, { is_active: true, p_tot_trib_sn: 6, cliente_retem_iss: true });
  });

  test('usa aliquota_iss_retencao_sn, não o default_iss_rate de fábrica', async () => {
    repo.__state.config.aliquota_iss_retencao_sn = '3.12';
    const t = sefinFalso();
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'v1', nota: { descricao: 'Limpeza de pele', valor: 200, iss_retido: true, tomador } }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('autorizada');
    const dps = dpsDoPost(t.posts()[0]);
    expect(dps).toContain('<tpRetISSQN>2</tpRetISSQN>');
    expect(dps).toContain('<pAliq>3.12</pAliq>');
    expect(dps).not.toContain('<pAliq>2.00</pAliq>');
  });

  test('sem a alíquota: recusa gentil ALIQUOTA_RETENCAO_AUSENTE, nenhum número gasto', async () => {
    repo.__state.config.aliquota_iss_retencao_sn = null;
    const t = sefinFalso();
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'v2', nota: { descricao: 'Limpeza de pele', valor: 200, iss_retido: true, tomador } }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'ALIQUOTA_RETENCAO_AUSENTE' });
    expect(t.posts()).toHaveLength(0);
    expect(repo.__state.config.next_dps_number).toBe(48);
  });
});
