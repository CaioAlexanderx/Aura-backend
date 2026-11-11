// ============================================================
// NFS-e Nacional — orquestrador (emitir / cancelar / consultar / DANFSe)
// com o Sefin SIMULADO (transport injetado) e o banco em memória (repo
// trocado por um fake com a mesma semântica; o SQL real roda no teste
// __tests__/nfseNacional.banco.test.js, no Postgres do CI).
//
// O que fica provado aqui:
//   • liga desligada → nada sai (nem consulta), nem número é gasto;
//   • autorizada: chave, número, XML; POST vai para a PRODUÇÃO RESTRITA;
//     o XML enviado é gzip+base64 e a assinatura verifica;
//   • idempotência: mesma chave duas vezes = UMA nota e UM POST; mesma
//     chave com outros dados = recusa;
//   • rejeição: códigos gravados; timeout: consulta pela DPS, retomada
//     reenvia o MESMO XML com o MESMO número; E0014 recupera a nota;
//   • certificado de outro CNPJ: recusa e não transmite; produção sem a
//     segunda trava: recusa; breaker abre depois de falhas seguidas;
//   • cancelamento (evento 101101) e DANFSe.
// ============================================================
'use strict';

const zlib = require('zlib');

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

// banco em memória com a mesma semântica do repo real
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
        xml_nfse: null, error_codes: null, rejection_reason: null, cancel_event_xml: null,
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
    gravarAutorizada: jest.fn(async (db, id, { chaveAcesso, nfseXml }) => {
      const m = String(nfseXml).match(/<nNFSe>(\d+)<\/nNFSe>/);
      Object.assign(find(id), { status: 'autorizada', chave_acesso: chaveAcesso, nfse_number: m ? m[1] : null, xml_nfse: nfseXml, error_codes: null, rejection_reason: null });
    }),
    gravarRejeitada: jest.fn(async (db, id, { texto, erros }) => Object.assign(find(id), { status: 'rejeitada', rejection_reason: texto, error_codes: erros })),
    gravarCancelada: jest.fn(async (db, id, { motivo, eventoXml }) => Object.assign(find(id), { status: 'cancelada', cancel_reason: motivo || find(id).cancel_reason, cancel_event_xml: eventoXml })),
    gravarCancelamentoRecusado: jest.fn(async () => {}),
    atualizarXmlNfse: jest.fn(async (db, id, xml) => { find(id).xml_nfse = xml; }),
    anexarEvidencia: jest.fn(async (db, id, ev) => { find(id).provider_response = { ...(find(id).provider_response || {}), ...clone(ev) }; }),
    notasDeProducao: jest.fn(async () => []),
  };
});

const repo = require('../../src/services/nfseNacional/repo');
const certStore = require('../../src/services/sefazSp/certStore');
const nacional = require('../../src/services/nfseNacional');
const { getProvider, NfseProviderError } = require('../../src/services/nfseProvider');
const { verifyNfeSignature } = require('../../src/services/sefazSp/signer');
const { gerarA1 } = require('../helpers/certA1Teste');

const CID = 'empresa-aura';
const CNPJ = '11222333000181';
const RESTRITA = 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
const CHAVE = '35244022' + '2' + CNPJ + '0000000000007' + '2611' + '123456789' + '1';
const db = {}; // o repo é o fake; o db não é tocado
const ctxBase = { retry: { attempts: 1, baseDelayMs: 0 }, now: () => new Date('2026-11-09T13:00:00Z') };

const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const ungz = (b) => zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8');
const json = (status, body) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const nfseXml = (chave = CHAVE, n = '7') => `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}"><nNFSe>${n}</nNFSe><cStat>100</cStat><dhProc>2026-11-09T10:00:05-03:00</dhProc><valores><vLiq>199.90</vLiq></valores></infNFSe></NFSe>`;

const NOTA = { descricao: 'Licença de uso do sistema Aura - novembro/2026', valor: 199.9, competencia: '2026-11-09' };

// A NFS-e traz a DPS que a gerou (infNFSe/DPS): a recuperação pela consulta
// só adota a nota quando ela é da DPS que a Aura assinou.
const dpsPostada = (t, i = 0) => ungz(t.posts()[i].body.dpsXmlGZipB64).replace(/^<\?xml[^>]*\?>/, '');
const nfseXmlCom = (dps, chave = CHAVE, n = '7') => nfseXml(chave, n).replace('</infNFSe>', `${dps}</infNFSe>`);
// O 201 de verdade traz a NFS-e com a DPS que acabou de ser enviada (mesmo Id).
const nfseDaPostada = (req) => nfseXmlCom(ungz(req.body.dpsXmlGZipB64).replace(/^<\?xml[^>]*\?>/, ''));
const ultimaPostada = (chamadas) => {
  const p = chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/nfse')).pop();
  return p ? nfseDaPostada(p) : nfseXml();
};

/** Sefin falso: cada rota responde pelo `plano` do teste. Registra as chamadas. */
function sefinFalso(plano = {}) {
  const chamadas = [];
  const t = jest.fn(async (req) => {
    chamadas.push(req);
    const u = new URL(req.url);
    const p = u.pathname;
    if (req.method === 'POST' && p.endsWith('/SefinNacional/nfse')) return (plano.postDps || ((r) => json(201, { chaveAcesso: CHAVE, idDps: 'x', nfseXmlGZipB64: gz(nfseDaPostada(r)), alertas: [] })))(req, chamadas);
    if (req.method === 'GET' && /\/dps\//.test(p)) return (plano.getDps || (() => json(404, { erro: { codigo: 'E2404', descricao: 'Não foi gerada' } })))(req);
    if (req.method === 'GET' && /\/eventos\//.test(p)) return (plano.getEvento || (() => json(404, {})))(req);
    if (req.method === 'POST' && /\/eventos$/.test(p)) return (plano.postEvento || (() => json(201, { eventoXmlGZipB64: gz('<evento/>') })))(req);
    if (req.method === 'GET' && /\/nfse\/\d{50}$/.test(p)) return (plano.getNfse || (() => json(200, { chaveAcesso: CHAVE, nfseXmlGZipB64: gz(ultimaPostada(chamadas)) })))(req);
    if (req.method === 'GET' && /\/danfse\//.test(p)) return { status: 200, headers: {}, body: Buffer.from('%PDF-1.4 teste') };
    return json(500, {});
  });
  t.chamadas = chamadas;
  t.posts = () => chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/nfse'));
  return t;
}

function configApta(over = {}) {
  return {
    company_id: CID, provider: 'nacional', is_active: true, ambiente: 'producao_restrita',
    municipio_ibge: '3524402', ctribnac_padrao: '010501', serie: '1', next_dps_number: 1,
    regime_tributario: 'simples_nacional', optante_simples_nacional: true, p_tot_trib_sn: 6,
    inscricao_municipal: null, outro_emissor: false, ...over,
  };
}

let a1;
beforeAll(() => { a1 = gerarA1({ cnpj: CNPJ }); });

beforeEach(() => {
  process.env.NFSE_NACIONAL_ENABLED = 'true';
  delete process.env.NFSE_NACIONAL_PRODUCAO;
  nacional._breaker.reset();
  repo.__reset({
    config: configApta(),
    company: { id: CID, cnpj: CNPJ, nome: 'Aura' },
    certInfo: { subject_cn: `EMPRESA TESTE LTDA:${CNPJ}`, not_after: a1.notAfter },
  });
  certStore.loadCertificate.mockReset();
  certStore.loadCertificate.mockResolvedValue({ pfx: a1.pfx, password: a1.senha });
});

afterAll(() => { delete process.env.NFSE_NACIONAL_ENABLED; });

describe('liga NFSE_NACIONAL_ENABLED', () => {
  test('desligada: recusa com erro claro, sem chamar o Sefin nem gastar número', async () => {
    delete process.env.NFSE_NACIONAL_ENABLED;
    const t = sefinFalso();
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'k1', nota: NOTA }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'NACIONAL_DESLIGADO' });
    expect(t).not.toHaveBeenCalled();
    expect(repo.__state.config.next_dps_number).toBe(1);
    expect(repo.__state.notas).toHaveLength(0);
  });

  test('desligada também bloqueia cancelamento, consulta e DANFSe', async () => {
    delete process.env.NFSE_NACIONAL_ENABLED;
    for (const fn of ['cancelar', 'consultar', 'danfse']) {
      await expect(nacional[fn](db, { companyId: CID, nfseId: 'x', xMotivo: 'motivo bem explicado aqui' }, ctxBase))
        .rejects.toMatchObject({ code: 'NACIONAL_DESLIGADO' });
    }
  });

  test('provider via getProvider: desligada → NfseProviderError NACIONAL_DESLIGADO', async () => {
    delete process.env.NFSE_NACIONAL_ENABLED;
    const p = getProvider({ provider: 'nacional', is_active: true }, { db, companyId: CID });
    await expect(p.emit({ idempotency_key: 'k', nota: NOTA })).rejects.toBeInstanceOf(NfseProviderError);
    await expect(p.emit({ idempotency_key: 'k', nota: NOTA })).rejects.toMatchObject({ code: 'NACIONAL_DESLIGADO' });
  });
});

describe('emissão', () => {
  test('autorizada: grava chave, número e XML; POST na produção restrita com DPS gzip+base64 assinada', async () => {
    const t = sefinFalso();
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-1', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r.nota).toMatchObject({ status: 'autorizada', chave_acesso: CHAVE, nfse_number: '7', dps_serie: '1', dps_number: '1' });
    const [post] = t.posts();
    expect(post.url).toBe(`${RESTRITA}/nfse`);
    const dps = ungz(post.body.dpsXmlGZipB64);
    expect(dps.startsWith('<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">')).toBe(true);
    expect(dps).toContain('<tpAmb>2</tpAmb>');
    expect(dps).toContain('<tpEmit>1</tpEmit><finNFSe>0</finNFSe><cLocEmi>'); // leiaute PRODREST-20261020 (NT 009)
    expect(dps).toContain('<dhEmi>2026-11-09T09:59:00-03:00</dhEmi>'); // 60 s de folga (E0008)
    expect(dps).toContain('Id="DPS35244022112223330001810000100000000000000');
    expect(verifyNfeSignature(dps).valid).toBe(true);
    expect(repo.__state.config.next_dps_number).toBe(2);
    expect(repo.__state.notas[0].xml_dps).toBe(dps);
  });

  test('mesma chave duas vezes: UMA nota, UM POST; a segunda é replay', async () => {
    const t = sefinFalso();
    const a = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-2', nota: NOTA }, { ...ctxBase, transport: t });
    const b = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-2', nota: NOTA }, { ...ctxBase, transport: t });
    expect(b.replay).toBe(true);
    expect(b.nota.id).toBe(a.nota.id);
    expect(t.posts()).toHaveLength(1);
    expect(repo.__state.notas).toHaveLength(1);
    expect(repo.__state.config.next_dps_number).toBe(2);
  });

  test('mesma chave com outro valor: recusa (409), sem nova nota', async () => {
    const t = sefinFalso();
    await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-3', nota: NOTA }, { ...ctxBase, transport: t });
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-3', nota: { ...NOTA, valor: 10 } }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'ESTADO_INVALIDO' });
    expect(repo.__state.notas).toHaveLength(1);
  });

  test('corrida: o UNIQUE barra a segunda reserva e ela devolve a primeira', async () => {
    const t = sefinFalso();
    await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-c', nota: NOTA }, { ...ctxBase, transport: t });
    // simula a segunda requisição que não viu a primeira na leitura inicial
    repo.buscarPorChave.mockResolvedValueOnce(null);
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-c', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r.replay).toBe(true);
    expect(r.nota.status).toBe('autorizada');
    expect(t.posts()).toHaveLength(1);
  });

  test('chave de idempotência ausente: recusa antes de tudo', async () => {
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: '', nota: NOTA }, ctxBase))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY' });
  });

  test('rejeitada (400): códigos gravados; repetir a chave não reenvia', async () => {
    const t = sefinFalso({
      postDps: () => json(400, { idDPS: 'x', erros: [{ Codigo: 'E0310', Descricao: 'Código de tributação nacional inexistente' }] }),
    });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-4', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('rejeitada');
    expect(r.nota.error_codes).toEqual([{ codigo: 'E0310', descricao: 'Código de tributação nacional inexistente', complemento: null }]);
    expect(r.nota.rejection_reason).toContain('E0310');
    const again = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-4', nota: NOTA }, { ...ctxBase, transport: t });
    expect(again.replay).toBe(true);
    expect(t.posts()).toHaveLength(1);
  });

  test('timeout: fica pendente; a retomada consulta a DPS e reenvia o MESMO XML com o MESMO número', async () => {
    let primeira = true;
    const t = sefinFalso({
      postDps: (req) => {
        if (primeira) { primeira = false; throw new Error('timeout após 30000ms'); }
        return json(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: gz(nfseDaPostada(req)) });
      },
    });
    const r1 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-5', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r1.aguardando).toBe(true);
    expect(r1.nota.status).toBe('pendente');
    const xml1 = ungz(t.posts()[0].body.dpsXmlGZipB64);

    const r2 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-5', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r2.nota.status).toBe('autorizada');
    const posts = t.posts();
    expect(posts).toHaveLength(2);
    expect(ungz(posts[1].body.dpsXmlGZipB64)).toBe(xml1);           // mesmo XML, mesma assinatura
    expect(t.chamadas.filter((c) => /\/dps\//.test(c.url)).length).toBe(2); // consultou antes de reenviar
    expect(repo.__state.config.next_dps_number).toBe(2);              // um número só
  });

  test('timeout mas a DPS virou nota: recupera pela consulta, sem reenviar', async () => {
    let t = null;
    t = sefinFalso({
      postDps: () => { throw new Error('socket hang up'); },
      getDps: () => json(200, { idDps: 'x', chaveAcesso: CHAVE }),
      getNfse: () => json(200, { chaveAcesso: CHAVE, nfseXmlGZipB64: gz(nfseXmlCom(dpsPostada(t))) }),
    });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-6', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('autorizada');
    expect(r.nota.chave_acesso).toBe(CHAVE);
    expect(t.posts()).toHaveLength(1);
  });

  test('HTTP 500 do Sefin é ambíguo (não vira rejeição)', async () => {
    const t = sefinFalso({ postDps: () => json(500, { erros: [{ codigo: 'E999' }] }) });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-7', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r.aguardando).toBe(true);
    expect(r.nota.status).toBe('pendente');
  });

  test('E0014 (a própria DPS já gerou nota): recupera a nota em vez de marcar rejeitada', async () => {
    let t = null;
    t = sefinFalso({
      postDps: () => json(400, { erros: [{ codigo: 'E0014', descricao: 'Conjunto já existe' }] }),
      getDps: () => json(200, { chaveAcesso: CHAVE }),
      getNfse: () => json(200, { chaveAcesso: CHAVE, nfseXmlGZipB64: gz(nfseXmlCom(dpsPostada(t))) }),
    });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'fatura-8', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('autorizada');
  });

  test('breaker: duas falhas de transporte seguidas → a próxima emissão nem tenta', async () => {
    const t = sefinFalso({ postDps: () => { throw new Error('ECONNRESET'); }, getDps: () => { throw new Error('ECONNRESET'); } });
    await nacional.emitir(db, { companyId: CID, idempotencyKey: 'b1', nota: NOTA }, { ...ctxBase, transport: t });
    await nacional.emitir(db, { companyId: CID, idempotencyKey: 'b2', nota: NOTA }, { ...ctxBase, transport: t });
    const antes = t.mock.calls.length;
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'b3', nota: NOTA }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'NACIONAL_INDISPONIVEL' });
    expect(t.mock.calls.length).toBe(antes);
  });
});

describe('configuração e certificado', () => {
  test('sem certificado: CONFIG_NAO_APTA com a pendência, sem número gasto', async () => {
    repo.__state.certInfo = null;
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'c1', nota: NOTA }, { ...ctxBase, transport: sefinFalso() }))
      .rejects.toMatchObject({ code: 'CONFIG_NAO_APTA' });
    expect(repo.__state.config.next_dps_number).toBe(1);
  });

  test('sem IBGE e sem cTribNac: pendências listadas', async () => {
    repo.__state.config = configApta({ municipio_ibge: null, ctribnac_padrao: null });
    let err;
    try { await nacional.emitir(db, { companyId: CID, idempotencyKey: 'c2', nota: NOTA }, ctxBase); } catch (e) { err = e; }
    expect(err.code).toBe('CONFIG_NAO_APTA');
    expect(err.details.join(' ')).toMatch(/IBGE/);
    expect(err.details.join(' ')).toMatch(/tributação nacional/);
  });

  test('dado inválido não gasta número', async () => {
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'c3', nota: { ...NOTA, valor: 0 } }, ctxBase))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(repo.__state.config.next_dps_number).toBe(1);
    expect(repo.__state.notas).toHaveLength(0);
  });

  test('o A1 salvo chega ao emissor: lido do cofre da empresa, e A1 de outro CNPJ é recusado sem transmitir', async () => {
    const outro = gerarA1({ cnpj: '11444777000161' });
    certStore.loadCertificate.mockResolvedValueOnce({ pfx: outro.pfx, password: outro.senha });
    const t = sefinFalso();
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'c4', nota: NOTA }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'CERTIFICADO' });
    expect(certStore.loadCertificate).toHaveBeenCalledWith(db, CID);
    expect(t).not.toHaveBeenCalled();
    expect(repo.__state.notas[0].status).toBe('erro');
    // com o A1 certo, a mesma chave retoma com o MESMO número
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'c4', nota: NOTA }, { ...ctxBase, transport: t });
    expect(r.nota).toMatchObject({ status: 'autorizada', dps_number: '1' });
    expect(repo.__state.config.next_dps_number).toBe(2);
  });

  test('ambiente producao sem NFSE_NACIONAL_PRODUCAO: recusa; com a trava aberta usa o host de produção', async () => {
    repo.__state.config = configApta({ ambiente: 'producao' });
    const t = sefinFalso();
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'p1', nota: NOTA }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'PRODUCAO_DESLIGADA' });
    expect(t).not.toHaveBeenCalled();
    process.env.NFSE_NACIONAL_PRODUCAO = 'true';
    await nacional.emitir(db, { companyId: CID, idempotencyKey: 'p1', nota: NOTA }, { ...ctxBase, transport: t });
    expect(t.posts()[0].url).toBe('https://sefin.nfse.gov.br/SefinNacional/nfse');
    const dpsProd = ungz(t.posts()[0].body.dpsXmlGZipB64);
    expect(dpsProd).toContain('<tpAmb>1</tpAmb>');
    expect(dpsProd).not.toContain('<finNFSe>'); // produção ainda no leiaute v1.01-20260209
  });

  test('ambiente antigo "homologacao" vai para a produção restrita', async () => {
    repo.__state.config = configApta({ ambiente: 'homologacao' });
    const t = sefinFalso();
    await nacional.emitir(db, { companyId: CID, idempotencyKey: 'h1', nota: NOTA }, { ...ctxBase, transport: t });
    expect(t.posts()[0].url).toBe(`${RESTRITA}/nfse`);
  });
});

describe('cancelamento, consulta e DANFSe', () => {
  async function notaAutorizada(t) {
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: `n-${Math.random()}`, nota: NOTA }, { ...ctxBase, transport: t });
    return r.nota;
  }

  test('cancela: evento 101101 assinado, POST em /nfse/{chave}/eventos, nota cancelada', async () => {
    const t = sefinFalso();
    const n = await notaAutorizada(t);
    const r = await nacional.cancelar(db, { companyId: CID, nfseId: n.id, cMotivo: 1, xMotivo: 'Valor digitado errado na fatura' }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('cancelada');
    const post = t.chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/eventos'));
    expect(post.url).toBe(`${RESTRITA}/nfse/${CHAVE}/eventos`);
    const ev = ungz(post.body.pedidoRegistroEventoXmlGZipB64);
    expect(ev).toContain(`<infPedReg Id="PRE${CHAVE}101101">`);
    expect(ev).toContain(`<CNPJAutor>${CNPJ}</CNPJAutor>`);
    expect(verifyNfeSignature(ev).valid).toBe(true);
    // repetir é seguro
    const again = await nacional.cancelar(db, { companyId: CID, nfseId: n.id, cMotivo: 1, xMotivo: 'Valor digitado errado na fatura' }, { ...ctxBase, transport: t });
    expect(again.replay).toBe(true);
  });

  test('cancelamento rejeitado: nota segue autorizada e o erro volta com os códigos', async () => {
    const t = sefinFalso({ postEvento: () => json(400, { erro: { codigo: 'E0840', descricao: 'Prazo de cancelamento expirado' } }) });
    const n = await notaAutorizada(t);
    await expect(nacional.cancelar(db, { companyId: CID, nfseId: n.id, xMotivo: 'Serviço cancelado pelo cliente' }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'REJEITADA' });
    expect(repo.__state.notas.find((x) => x.id === n.id).status).toBe('autorizada');
  });

  test('cancelamento com timeout mas evento registrado: confirma pela consulta do evento', async () => {
    const t = sefinFalso({
      postEvento: () => { throw new Error('timeout'); },
      getEvento: () => json(200, { eventoXmlGZipB64: gz('<evento>ok</evento>') }),
    });
    const n = await notaAutorizada(t);
    const r = await nacional.cancelar(db, { companyId: CID, nfseId: n.id, xMotivo: 'Serviço cancelado pelo cliente' }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('cancelada');
    expect(r.nota.cancel_event_xml).toBe('<evento>ok</evento>');
  });

  test('não cancela nota que não está autorizada', async () => {
    const t = sefinFalso({ postDps: () => json(400, { erros: [{ codigo: 'E0310' }] }) });
    const n = await notaAutorizada(t);
    await expect(nacional.cancelar(db, { companyId: CID, nfseId: n.id, xMotivo: 'motivo comprido o bastante' }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'ESTADO_INVALIDO' });
  });

  test('consulta pela chave atualiza o XML; DANFSe devolve o PDF do ADN', async () => {
    const t = sefinFalso();
    const n = await notaAutorizada(t);
    await nacional.consultar(db, { companyId: CID, nfseId: n.id }, { ...ctxBase, transport: t });
    expect(t.chamadas.some((c) => c.method === 'GET' && c.url === `${RESTRITA}/nfse/${CHAVE}`)).toBe(true);
    const pdf = await nacional.danfse(db, { companyId: CID, nfseId: n.id }, { ...ctxBase, transport: t });
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(t.chamadas.some((c) => c.url === `https://adn.producaorestrita.nfse.gov.br/danfse/${CHAVE}`)).toBe(true);
  });
});
