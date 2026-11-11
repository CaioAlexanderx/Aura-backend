// ============================================================
// NFS-e Nacional — DPS com série/número já usados por OUTRO emissor da
// empresa (incidente de 10/11/2026). Sefin simulado (transport injetado) e
// banco em memória (repo trocado por um fake com a mesma semântica).
//
// O que fica provado aqui:
//   • a NFS-e devolvida pela consulta da DPS é conferida com a DPS que a
//     Aura assinou (assinatura; sem ela, valor, cTribNac, dhEmi, dCompet e
//     tomador);
//   • igual → adota (o caso legítimo de timeout);
//   • diferente (o caso real do incidente, como fixture) → nota em 'erro'
//     DPS_NUMERO_JA_USADO com a mensagem gentil, NADA gravado como
//     autorizada (sem chave, sem número, sem xml_nfse), a NFS-e do outro
//     emissor só como evidência, e a loja bloqueada até conferir a série;
//   • rejeição direta E0014 → mesmo erro, sem queimar número em loop;
//   • repetir a mesma chave não reenvia nem renumera.
// ============================================================
'use strict';

const zlib = require('zlib');

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

jest.mock('../../src/services/nfseNacional/repo', () => {
  const state = { config: null, company: null, certInfo: null, notas: [], seq: 0 };
  const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  const find = (id) => state.notas.find((n) => n.id === id);
  return {
    __state: state,
    __reset(over = {}) {
      Object.assign(state, { config: null, company: null, certInfo: null, notas: [], seq: 0 }, over);
    },
    buscarPorChave: jest.fn(async (db, companyId, key) => clone(state.notas.find((n) => n.company_id === companyId && n.idempotency_key === key)) || null),
    buscarPorId: jest.fn(async (db, companyId, id) => clone(state.notas.find((n) => n.company_id === companyId && n.id === id)) || null),
    carregarContexto: jest.fn(async () => ({ config: clone(state.config), company: clone(state.company), certInfo: clone(state.certInfo) })),
    reservar: jest.fn(async (db, { companyId, key, fp, entrada, ambiente }) => {
      if (!state.config) return { semConfig: true };
      if (state.notas.some((n) => n.company_id === companyId && n.idempotency_key === key)) return { corrida: true };
      const n = state.config.next_dps_number++;
      const row = {
        id: `nota-${++state.seq}`, company_id: companyId, status: 'pendente', provider: 'nacional',
        idempotency_key: key, idempotency_fingerprint: fp, ambiente,
        dps_serie: String(parseInt(state.config.serie || '1', 10)), dps_number: String(n), dps_id: null,
        dps_dados: clone(entrada), xml_dps: null, transmitted_at: null, chave_acesso: null, nfse_number: null,
        xml_nfse: null, error_codes: null, rejection_reason: null, provider_response: null,
      };
      state.notas.push(row);
      return { row: clone(row) };
    }),
    marcarTransmitindo: jest.fn(async (db, id, { idDps, xml }) => Object.assign(find(id), { dps_id: idDps, xml_dps: xml, transmitted_at: new Date().toISOString(), status: 'pendente', rejection_reason: null })),
    marcarSemConfirmacao: jest.fn(async (db, id, msg) => { find(id).rejection_reason = msg; }),
    marcarErro: jest.fn(async (db, id, msg, codigos) => {
      const n = find(id);
      if (['pendente', 'erro'].includes(n.status)) Object.assign(n, { status: 'erro', rejection_reason: msg, error_codes: codigos || n.error_codes });
    }),
    marcarNumeroJaUsado: jest.fn(async (db, row, { mensagem, evidencia, bloquearConfig }) => {
      const n = find(row.id);
      if (!['pendente', 'erro'].includes(n.status)) return false;
      Object.assign(n, {
        status: 'erro', rejection_reason: mensagem,
        error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO', descricao: mensagem }],
        provider_response: { ...(n.provider_response || {}), nfse_de_outro_emissor: clone(evidencia) },
      });
      if (bloquearConfig) {
        Object.assign(state.config, { dps_conflito_em: new Date().toISOString(), dps_conflito_serie: row.dps_serie, dps_conflito_numero: row.dps_number });
      }
      return true;
    }),
    gravarAutorizada: jest.fn(async (db, id, { chaveAcesso, nfseXml, cabecalho }) => {
      const m = String(nfseXml).match(/<nNFSe>(\d+)<\/nNFSe>/);
      Object.assign(find(id), {
        status: 'autorizada', chave_acesso: chaveAcesso, nfse_number: m ? m[1] : null, xml_nfse: nfseXml,
        error_codes: null, rejection_reason: null, provider_response: { cabecalho: cabecalho || {} },
      });
    }),
    gravarRejeitada: jest.fn(async (db, id, { texto, erros }) => Object.assign(find(id), { status: 'rejeitada', rejection_reason: texto, error_codes: erros })),
    gravarCancelada: jest.fn(async () => {}),
    gravarCancelamentoRecusado: jest.fn(async () => {}),
    atualizarXmlNfse: jest.fn(async (db, id, xml) => { find(id).xml_nfse = xml; }),
    gravarResultadoTeste: jest.fn(async () => {}),
    anexarEvidencia: jest.fn(async (db, id, ev) => { find(id).provider_response = { ...(find(id).provider_response || {}), ...clone(ev) }; }),
    notasDeProducao: jest.fn(async () => []),
  };
});

const repo = require('../../src/services/nfseNacional/repo');
const certStore = require('../../src/services/sefazSp/certStore');
const nacional = require('../../src/services/nfseNacional');
const { conferirNfseComDps } = require('../../src/services/nfseNacional/conferenciaDps');
const { lerNfse, lerDps } = require('../../src/services/nfseNacional/nfseParser');
const { gerarA1 } = require('../helpers/certA1Teste');
const incidente = require('../fixtures/nfseDpsNumeroJaUsado');

const CID = 'loja-sp';
const CNPJ = incidente.CNPJ;
const db = {};
const ctxBase = { retry: { attempts: 1, baseDelayMs: 0 }, now: () => new Date('2026-11-10T15:00:00Z') };
const MSG_SERIE1_N1 = 'A série 1 e o número 1 da DPS já foram usados por outro emissor desta empresa. '
  + 'Confira na configuração da NFS-e a Série da DPS e o último Número usado e tente de novo.';
// chave da NFS-e legítima (a da própria DPS da Aura)
const CHAVE_DA_AURA = `${incidente.IBGE_SP}1${'2'}${CNPJ}${'2'.padStart(13, '0')}2611${'987654321'}3`;

const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const ungz = (b) => zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8');
const json = (status, body) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const semDeclaracao = (xml) => String(xml).replace(/^<\?xml[^>]*\?>/, '');
const nfseCom = (dps, chave = CHAVE_DA_AURA, n = '2') => '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe Id="NFS${chave}"><nNFSe>${n}</nNFSe><verAplic>SefinNacional_1.6.0</verAplic><cStat>100</cStat>`
  + '<dhProc>2026-11-10T12:00:05-03:00</dhProc><valores><vLiq>44.00</vLiq></valores>'
  + `${semDeclaracao(dps)}</infNFSe></NFSe>`;

/** Sefin falso: cada rota responde pelo `plano` do teste. */
function sefinFalso(plano = {}) {
  const chamadas = [];
  const t = jest.fn(async (req) => {
    chamadas.push(req);
    const p = new URL(req.url).pathname;
    if (req.method === 'POST' && p.endsWith('/SefinNacional/nfse')) return plano.postDps(req);
    if (req.method === 'GET' && /\/dps\//.test(p)) return (plano.getDps || (() => json(404, {})))(req);
    if (req.method === 'GET' && /\/nfse\/\d{50}$/.test(p)) return (plano.getNfse || (() => json(404, {})))(req);
    return json(500, {});
  });
  t.chamadas = chamadas;
  t.posts = () => chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/nfse'));
  t.dpsPostada = (i = 0) => ungz(t.posts()[i].body.dpsXmlGZipB64);
  return t;
}

const timeout = () => { throw new Error('timeout após 30000ms'); };
const e0014 = () => json(400, { erros: [{
  codigo: 'E0014',
  descricao: 'Conjunto de Série, Número, Código do Município Emissor e CNPJ/CPF informado nesta DPS já existe em uma NFS-e gerada a partir de uma DPS enviada anteriormente.',
}] });
const devolveDoOutroEmissor = () => json(200, { chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR, nfseXmlGZipB64: gz(incidente.NFSE_DO_OUTRO_EMISSOR) });
const achouDps = () => json(200, { idDps: incidente.ID_DPS_SERIE1_N1, chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR });

function configDaLoja(over = {}) {
  return {
    company_id: CID, provider: 'nacional', is_active: true, ambiente: 'producao_restrita',
    municipio_ibge: incidente.IBGE_SP, ctribnac_padrao: '130501', serie: '1', next_dps_number: 1,
    regime_tributario: 'simples_nacional', optante_simples_nacional: true, op_simp_nac: 3, p_tot_trib_sn: 6,
    inscricao_municipal: null, outro_emissor: null, ...over,
  };
}

let a1;
beforeAll(() => { a1 = gerarA1({ cnpj: CNPJ }); });

beforeEach(() => {
  process.env.NFSE_NACIONAL_ENABLED = 'true';
  delete process.env.NFSE_NACIONAL_PRODUCAO;
  nacional._breaker.reset();
  jest.clearAllMocks();
  repo.__reset({
    config: configDaLoja(),
    company: { id: CID, cnpj: CNPJ, nome: 'Loja Ficticia' },
    certInfo: { subject_cn: `LOJA FICTICIA LTDA:${CNPJ}`, not_after: a1.notAfter },
  });
  certStore.loadCertificate.mockReset();
  certStore.loadCertificate.mockResolvedValue({ pfx: a1.pfx, password: a1.senha });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => { console.warn.mockRestore(); });
afterAll(() => { delete process.env.NFSE_NACIONAL_ENABLED; });

function semNadaDeAutorizada(nota) {
  expect(nota.status).toBe('erro');
  expect(nota.chave_acesso).toBeNull();
  expect(nota.nfse_number).toBeNull();
  expect(nota.xml_nfse).toBeNull();
  expect(nota.error_codes).toEqual([{ codigo: 'DPS_NUMERO_JA_USADO', descricao: MSG_SERIE1_N1 }]);
  expect(nota.rejection_reason).toBe(MSG_SERIE1_N1);
}

// ── conferência pura ──────────────────────────────────────────

describe('conferenciaDps (pura)', () => {
  const nossaDps = '<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
    + `<infDPS Id="${incidente.ID_DPS_SERIE1_N1}"><tpAmb>1</tpAmb><dhEmi>2026-11-10T11:59:00-03:00</dhEmi>`
    + '<serie>1</serie><nDPS>1</nDPS><dCompet>2026-11-10</dCompet>'
    + `<prest><CNPJ>${CNPJ}</CNPJ></prest>`
    + '<serv><cServ><cTribNac>240101</cTribNac></cServ></serv>'
    + '<valores><vServPrest><vServ>44.00</vServ></vServPrest></valores></infDPS>'
    + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI="#x"><DigestValue>AAAhashDaAura=</DigestValue></Reference></SignedInfo></Signature>'
    + '</DPS>';

  test('o leitor tira da NFS-e a DPS embutida (infNFSe/DPS)', () => {
    const lida = lerNfse(incidente.NFSE_DO_OUTRO_EMISSOR);
    expect(lida.nNFSe).toBe('1');
    expect(lida.dps).toMatchObject({
      id: incidente.ID_DPS_SERIE1_N1, serie: '1', nDPS: '1', dhEmi: '2026-10-22T14:30:52-03:00',
      dCompet: '2026-10-22', cTribNac: '130501', vServ: 25, verAplic: '1.6.0+910FFC', digest: null,
    });
    expect(lerDps(nossaDps)).toMatchObject({ vServ: 44, cTribNac: '240101', digest: 'AAAhashDaAura=' });
  });

  test('caso real do incidente: mesmo Id, valor, código, data e competência diferentes → diferente', () => {
    const c = conferirNfseComDps({ nfseXml: incidente.NFSE_DO_OUTRO_EMISSOR, dpsXml: nossaDps });
    expect(c.resultado).toBe('diferente');
    expect(c.por).toBe('campos');
    expect(c.divergencias).toEqual(['vServ', 'cTribNac', 'dhEmi', 'dCompet']);
    expect(c.devolvida.id).toBe(c.nossa.id); // o Id da DPS NÃO distingue as duas
  });

  test('mesma DPS assinada (DigestValue igual) → igual, pela assinatura', () => {
    const c = conferirNfseComDps({ nfseXml: nfseCom(nossaDps), dpsXml: nossaDps });
    expect(c).toMatchObject({ resultado: 'igual', por: 'assinatura', divergencias: [] });
  });

  test('mesmos campos mas outra assinatura → diferente (outra DPS)', () => {
    const outra = nossaDps.replace('AAAhashDaAura=', 'BBBoutroHash=');
    const c = conferirNfseComDps({ nfseXml: nfseCom(outra), dpsXml: nossaDps });
    expect(c).toMatchObject({ resultado: 'diferente', por: 'assinatura', divergencias: ['assinatura'] });
  });

  test('sem assinatura na devolvida e campos iguais → igual; dhEmi no mesmo instante em outro fuso conta como igual', () => {
    const semAss = nossaDps.replace(/<Signature[\s\S]*<\/Signature>/, '').replace('2026-11-10T11:59:00-03:00', '2026-11-10T14:59:00Z');
    expect(conferirNfseComDps({ nfseXml: nfseCom(semAss), dpsXml: nossaDps })).toMatchObject({ resultado: 'igual', por: 'campos' });
  });

  test('tomador diferente → diferente', () => {
    const nossaComToma = nossaDps.replace('<serv>', '<toma><CPF>52998224725</CPF><xNome>A</xNome></toma><serv>').replace(/<Signature[\s\S]*<\/Signature>/, '');
    const devolvida = nossaComToma.replace('52998224725', '11144477735');
    const c = conferirNfseComDps({ nfseXml: nfseCom(devolvida), dpsXml: nossaComToma });
    expect(c).toMatchObject({ resultado: 'diferente', divergencias: ['tomador'] });
  });

  test('NFS-e sem a DPS embutida, ou ilegível → indeterminado (nem adota, nem marca)', () => {
    const sem = `<NFSe><infNFSe Id="NFS${CHAVE_DA_AURA}"><nNFSe>2</nNFSe></infNFSe></NFSe>`;
    expect(conferirNfseComDps({ nfseXml: sem, dpsXml: nossaDps }).resultado).toBe('indeterminado');
    expect(conferirNfseComDps({ nfseXml: 'não é xml', dpsXml: nossaDps }).resultado).toBe('indeterminado');
  });
});

// ── emissão ───────────────────────────────────────────────────

describe('recuperação pela consulta da DPS', () => {
  test('consulta_dps devolve a NFS-e da PRÓPRIA DPS (timeout legítimo) → adota', async () => {
    let t = null;
    t = sefinFalso({
      postDps: timeout,
      getDps: () => json(200, { chaveAcesso: CHAVE_DA_AURA }),
      getNfse: () => json(200, { chaveAcesso: CHAVE_DA_AURA, nfseXmlGZipB64: gz(nfseCom(t.dpsPostada())) }),
    });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('autorizada');
    expect(r.nota.chave_acesso).toBe(CHAVE_DA_AURA);
    expect(repo.__state.notas[0].provider_response.cabecalho).toEqual({ recuperada_por: 'consulta_dps', conferida_por: 'assinatura' });
    expect(repo.__state.config.dps_conflito_em).toBeUndefined();
  });

  test('incidente de 10/11: timeout, consulta_dps devolve a NFS-e de 22/10 do outro emissor → erro DPS_NUMERO_JA_USADO, nada autorizado', async () => {
    const t = sefinFalso({ postDps: timeout, getDps: achouDps, getNfse: devolveDoOutroEmissor });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });

    // a DPS da Aura tem o MESMO Id da DPS antiga (série 1, número 1)
    expect(repo.__state.notas[0].dps_id).toBe(incidente.ID_DPS_SERIE1_N1);
    expect(r.aguardando).toBeUndefined();
    semNadaDeAutorizada(r.nota);

    // a NFS-e do outro emissor fica SÓ como evidência
    const ev = repo.__state.notas[0].provider_response.nfse_de_outro_emissor;
    expect(ev).toMatchObject({
      motivo: 'nfse_de_outra_dps', conferida_por: 'campos', divergencias: ['vServ', 'cTribNac', 'dhEmi', 'dCompet'],
      chave_acesso: incidente.CHAVE_DO_OUTRO_EMISSOR, nNFSe: '1',
      dps_devolvida: { vServ: 25, cTribNac: '130501', dCompet: '2026-10-22', verAplic: '1.6.0+910FFC' },
      dps_da_aura: { vServ: 44, cTribNac: '240101', dCompet: '2026-11-10' },
    });
    expect(ev.xml_nfse).toBe(incidente.NFSE_DO_OUTRO_EMISSOR);

    // a loja fica com o conflito: série 1, número 1
    expect(repo.__state.config).toMatchObject({ dps_conflito_serie: '1', dps_conflito_numero: '1' });
    expect(repo.__state.config.dps_conflito_em).toBeTruthy();
    expect(repo.gravarAutorizada).not.toHaveBeenCalled();
  });

  test('depois do conflito: a mesma chave não reenvia; venda nova não gasta número até a loja conferir', async () => {
    const t = sefinFalso({ postDps: timeout, getDps: achouDps, getNfse: devolveDoOutroEmissor });
    await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    const chamadas = t.mock.calls.length;
    expect(repo.__state.config.next_dps_number).toBe(2);

    const again = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(again.replay).toBe(true);
    semNadaDeAutorizada(again.nota);

    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-2', nota: { ...incidente.VENDA_DA_AURA, valor: 10 } }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'DPS_NUMERO_JA_USADO', message: MSG_SERIE1_N1 });
    expect(t.mock.calls.length).toBe(chamadas);              // nada saiu
    expect(repo.__state.config.next_dps_number).toBe(2);     // nenhum número queimado
    expect(repo.__state.notas).toHaveLength(1);

    // a loja confere a série (PUT /config limpa o conflito): volta a emitir, na série nova
    Object.assign(repo.__state.config, { dps_conflito_em: null, serie: '3', next_dps_number: 1, outro_emissor: true });
    const t2 = sefinFalso({ postDps: (req) => json(201, { chaveAcesso: CHAVE_DA_AURA, nfseXmlGZipB64: gz(nfseCom(ungz(req.body.dpsXmlGZipB64))) }) });
    const nova = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1-b', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t2 });
    expect(nova.nota).toMatchObject({ status: 'autorizada', dps_serie: '3', dps_number: '1' });
    expect(t2.dpsPostada()).toContain('<serie>3</serie><nDPS>1</nDPS>');
  });

  test('a consulta com nota já marcada não remarca nem reabre o conflito', async () => {
    const t = sefinFalso({ postDps: timeout, getDps: achouDps, getNfse: devolveDoOutroEmissor });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    repo.__state.config.dps_conflito_em = null; // a loja já conferiu
    const antes = t.mock.calls.length;
    const c = await nacional.consultar(db, { companyId: CID, nfseId: r.nota.id }, { ...ctxBase, transport: t });
    semNadaDeAutorizada(c.nota);
    expect(t.mock.calls.length).toBe(antes);
    expect(repo.__state.config.dps_conflito_em).toBeNull();
  });
});

describe('rejeição direta de duplicidade (E0014)', () => {
  test('E0014 e a consulta devolve a NFS-e do outro emissor → mesmo erro DPS_NUMERO_JA_USADO', async () => {
    const t = sefinFalso({ postDps: e0014, getDps: achouDps, getNfse: devolveDoOutroEmissor });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    semNadaDeAutorizada(r.nota);
    expect(t.posts()).toHaveLength(1);
    expect(repo.gravarRejeitada).not.toHaveBeenCalled();
    expect(repo.__state.config.dps_conflito_numero).toBe('1');
  });

  test('E0014 no primeiro envio e a consulta da DPS sem nota → número de outro emissor, mesmo erro', async () => {
    const t = sefinFalso({ postDps: e0014 });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    semNadaDeAutorizada(r.nota);
    expect(repo.__state.notas[0].provider_response.nfse_de_outro_emissor).toMatchObject({ motivo: 'rejeicao_e0014' });
    expect(repo.__state.notas[0].provider_response.nfse_de_outro_emissor.erros[0].codigo).toBe('E0014');
  });

  test('E0014 com a consulta fora do ar → segue pendente (nada adotado, nada marcado, repetir é seguro)', async () => {
    const t = sefinFalso({ postDps: e0014, getDps: () => { throw new Error('ECONNRESET'); } });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r.aguardando).toBe(true);
    expect(r.nota.status).toBe('pendente');
    expect(r.nota.chave_acesso).toBeNull();
    expect(repo.__state.config.dps_conflito_em).toBeUndefined();
  });

  test('reenvio depois de timeout com E0014 e a consulta devolvendo a nota do outro emissor → erro; sem loop de números', async () => {
    let n = 0;
    const t = sefinFalso({
      postDps: () => (++n === 1 ? timeout() : e0014()),
      getDps: () => (n === 1 ? json(404, {}) : achouDps()),
      getNfse: devolveDoOutroEmissor,
    });
    const r1 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r1.aguardando).toBe(true);
    const r2 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    semNadaDeAutorizada(r2.nota);
    expect(t.posts()).toHaveLength(2);
    expect(t.dpsPostada(1)).toBe(t.dpsPostada(0));          // mesmo XML, mesmo número
    expect(repo.__state.config.next_dps_number).toBe(2);    // um número só
  });
});
