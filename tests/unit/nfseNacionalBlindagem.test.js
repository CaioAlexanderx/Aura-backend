// ============================================================
// NFS-e Nacional — blindagem contra a falha de 10/11/2026.
//
// O incidente: a loja já emitia NFS-e pela prefeitura de São Paulo na série
// 1. A Aura mandou a DPS série 1 nº 1 da venda de R$ 44,00; o gov.br
// respondeu E0014 e o código antigo adotou a NFS-e ALHEIA (R$ 25,00, de
// 22/10, ambGer 1 / tpEmis 2) como a nota da venda. O backend#992 passou a
// conferir antes de adotar, mas um "Tentar de novo" anterior ao deploy
// readotou a nota e sobrescreveu a evidência.
//
// Sefin simulado (transport injetado) e banco em memória (repo trocado por
// um fake com a MESMA semântica do SQL: a guarda de gravarAutorizada e a de
// atualizarXmlNfse estão reproduzidas aqui e provadas no SQL real em
// __tests__/nfseNacional.banco.test.js).
//
// O que fica provado aqui (os números são os itens do pedido):
//   1. cancelar: a linha adotada (fixture do caso real) e a nota marcada
//      DPS_NUMERO_JA_USADO são recusadas SEM chamar o gov.br; a nota da
//      Aura cancela normalmente;
//   2. 201 direto com a NFS-e de outra DPS (Id diferente ou sem DPS) não
//      vira autorizada; a guarda do gravarAutorizada vence a leitura antiga;
//   4. DANFSe e consulta pela chave só valem para nota autorizada/cancelada
//      da Aura; nota marcada não muda; XML de outra DPS não entra;
//   7. a primeira nota de verdade só sai com o passo da série respondido;
//      a loja do incidente (série 3 depois do conflito) não é barrada; a
//      nota adotada não conta como "nota da Aura".
// ============================================================
'use strict';

const zlib = require('zlib');

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

jest.mock('../../src/services/nfseNacional/repo', () => {
  const { temDpsNumeroJaUsado } = jest.requireActual('../../src/services/nfseNacional/errors');
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
        idempotency_key: key, idempotency_fingerprint: fp, ambiente, source_type: 'manual',
        dps_serie: String(parseInt(state.config.serie || '1', 10)), dps_number: String(n), dps_id: null,
        dps_dados: clone(entrada), xml_dps: null, transmitted_at: null, chave_acesso: null, nfse_number: null,
        xml_nfse: null, error_codes: null, rejection_reason: null, provider_response: null, cancel_event_xml: null,
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
      if (bloquearConfig) Object.assign(state.config, { dps_conflito_em: new Date().toISOString(), dps_conflito_serie: row.dps_serie, dps_conflito_numero: row.dps_number });
      return true;
    }),
    // mesma guarda do SQL (repo.SO_NOTA_ABERTA_DA_AURA) e mescla de provider_response
    gravarAutorizada: jest.fn(async (db, id, { chaveAcesso, nfseXml, cabecalho }) => {
      const n = find(id);
      if (!['pendente', 'erro'].includes(n.status) || temDpsNumeroJaUsado(n)) return { gravada: false, nota: clone(n) };
      const m = String(nfseXml).match(/<nNFSe>(\d+)<\/nNFSe>/);
      Object.assign(n, {
        status: 'autorizada', chave_acesso: chaveAcesso, nfse_number: m ? m[1] : null, xml_nfse: nfseXml,
        error_codes: null, rejection_reason: null, provider_response: { ...(n.provider_response || {}), cabecalho: cabecalho || {} },
      });
      return { gravada: true, nota: clone(n) };
    }),
    gravarRejeitada: jest.fn(async (db, id, { texto, erros }) => Object.assign(find(id), { status: 'rejeitada', rejection_reason: texto, error_codes: erros })),
    gravarCancelada: jest.fn(async (db, id, { motivo, eventoXml }) => Object.assign(find(id), { status: 'cancelada', cancel_reason: motivo, cancel_event_xml: eventoXml })),
    gravarCancelamentoRecusado: jest.fn(async () => {}),
    atualizarXmlNfse: jest.fn(async (db, id, xml) => {
      const n = find(id);
      if (['autorizada', 'cancelada'].includes(n.status)) n.xml_nfse = xml;
    }),
    anexarEvidencia: jest.fn(async (db, id, ev) => { find(id).provider_response = { ...(find(id).provider_response || {}), ...clone(ev) }; }),
    notasDeProducao: jest.fn(async (db, companyId) => clone(state.notas.filter((n) => n.company_id === companyId
      && n.ambiente === 'producao' && n.source_type !== 'teste' && n.transmitted_at))),
    gravarResultadoTeste: jest.fn(async () => {}),
  };
});

const repo = require('../../src/services/nfseNacional/repo');
const certStore = require('../../src/services/sefazSp/certStore');
const nacional = require('../../src/services/nfseNacional');
const { podeServirNota, conferirNotaGravada } = require('../../src/services/nfseNacional/notaDaAura');
const {
  pendenciaDaSerieAntesDaPrimeiraNota, MSG_SERIE_ANTES_DA_PRIMEIRA_NOTA,
} = require('../../src/services/nfseNacional/config');
const { gerarA1 } = require('../helpers/certA1Teste');
const incidente = require('../fixtures/nfseDpsNumeroJaUsado');

const CID = 'loja-sp';
const CNPJ = incidente.CNPJ;
const db = {};
const ctxBase = { retry: { attempts: 1, baseDelayMs: 0 }, now: () => new Date('2026-11-11T15:00:00Z') };
const CHAVE_DA_AURA = `${incidente.IBGE_SP}1${'2'}${CNPJ}${'2'.padStart(13, '0')}2611${'987654321'}3`;

const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const ungz = (b) => zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8');
const json = (status, body) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const semDeclaracao = (xml) => String(xml).replace(/^<\?xml[^>]*\?>/, '');
const nfseCom = (dps, chave = CHAVE_DA_AURA, n = '2') => '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe Id="NFS${chave}"><nNFSe>${n}</nNFSe><cStat>100</cStat>`
  + '<dhProc>2026-11-11T12:00:05-03:00</dhProc><valores><vLiq>44.00</vLiq></valores>'
  + `${semDeclaracao(dps)}</infNFSe></NFSe>`;
const nfseDaPostada = (req) => nfseCom(ungz(req.body.dpsXmlGZipB64));

function sefinFalso(plano = {}) {
  const chamadas = [];
  const t = jest.fn(async (req) => {
    chamadas.push(req);
    const p = new URL(req.url).pathname;
    if (req.method === 'POST' && p.endsWith('/SefinNacional/nfse')) return (plano.postDps || ((r) => json(201, { chaveAcesso: CHAVE_DA_AURA, nfseXmlGZipB64: gz(nfseDaPostada(r)) })))(req);
    if (req.method === 'GET' && /\/dps\//.test(p)) return (plano.getDps || (() => json(404, {})))(req);
    if (req.method === 'GET' && /\/nfse\/\d{50}$/.test(p)) return (plano.getNfse || (() => json(404, {})))(req);
    if (req.method === 'GET' && /\/eventos\//.test(p)) return (plano.getEvento || (() => json(404, {})))(req);
    if (req.method === 'POST' && /\/eventos$/.test(p)) return (plano.postEvento || (() => json(201, { eventoXmlGZipB64: gz('<evento/>') })))(req);
    if (req.method === 'GET' && /\/danfse\//.test(p)) return { status: 200, headers: {}, body: Buffer.from('%PDF-1.4 teste') };
    return json(500, {});
  });
  t.chamadas = chamadas;
  t.posts = () => chamadas.filter((c) => c.method === 'POST' && c.url.endsWith('/nfse'));
  return t;
}

function configDaLoja(over = {}) {
  return {
    company_id: CID, provider: 'nacional', is_active: true, ambiente: 'producao_restrita',
    municipio_ibge: incidente.IBGE_SP, ctribnac_padrao: '130501', serie: '1', next_dps_number: 1,
    regime_tributario: 'simples_nacional', optante_simples_nacional: true, op_simp_nac: 3, p_tot_trib_sn: 6,
    inscricao_municipal: null, outro_emissor: false, ...over,
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
afterAll(() => {
  delete process.env.NFSE_NACIONAL_ENABLED;
  delete process.env.NFSE_NACIONAL_PRODUCAO;
});

/** A linha do incidente (série 1 nº 1 adotada, R$ 25 da prefeitura contra R$ 44 da venda). */
function comLinhaAdotada(over = {}) {
  process.env.NFSE_NACIONAL_PRODUCAO = 'true'; // a linha é de produção, como no servidor
  const row = incidente.linhaAdotada({ company_id: CID, ...over });
  repo.__state.notas.push(row);
  return row;
}

async function notaDaAura(t) {
  const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: `venda-${Math.random()}`, nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
  expect(r.nota.status).toBe('autorizada');
  return r.nota;
}

// ── a fixture do caso real ────────────────────────────────────

describe('fixture do caso real (série 1 nº 1 adotada, ambGer 1)', () => {
  test('a NFS-e gravada é da prefeitura e não confere com a DPS da venda: R$ 25 x R$ 44', () => {
    const row = incidente.linhaAdotada();
    expect(row.xml_nfse).toContain('<ambGer>1</ambGer><tpEmis>2</tpEmis>');
    const c = conferirNotaGravada(row);
    expect(c.resultado).toBe('diferente');
    expect(c.conf.divergencias).toEqual(['vServ', 'cTribNac', 'dhEmi', 'dCompet']);
    expect(c.conf.devolvida).toMatchObject({ serie: '1', nDPS: '1', vServ: 25 });
    expect(c.conf.nossa).toMatchObject({ serie: '1', nDPS: '1', vServ: 44 });
    expect(c.conf.devolvida.id).toBe(c.conf.nossa.id); // o Id da DPS não separa as duas
  });
});

// ── item 1: cancelamento ──────────────────────────────────────

describe('item 1 — cancelar confere se a nota é da Aura antes de assinar o evento', () => {
  test('linha adotada (caso real): recusa clara, sem certificado, sem evento, sem nenhuma chamada ao gov.br', async () => {
    const row = comLinhaAdotada();
    const t = sefinFalso();
    await expect(nacional.cancelar(db, { companyId: CID, nfseId: row.id, xMotivo: 'Venda cancelada pelo cliente' }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'NOTA_NAO_CONFERIDA', message: expect.stringMatching(/nada foi enviado ao gov\.br/i) });
    expect(t).not.toHaveBeenCalled();
    expect(certStore.loadCertificate).not.toHaveBeenCalled();
    expect(repo.gravarCancelada).not.toHaveBeenCalled();
    expect(repo.__state.notas[0].status).toBe('autorizada');
  });

  test('nota com DPS_NUMERO_JA_USADO (error_codes ou prefixo do rejection_reason): recusa sem chamar o gov.br', async () => {
    const t = sefinFalso();
    const a = comLinhaAdotada({ id: 'marcada-1', error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO', descricao: 'x' }] });
    const b = comLinhaAdotada({ id: 'marcada-2', idempotency_key: 'k2', rejection_reason: 'DPS_NUMERO_JA_USADO: série 1 nº 1' });
    for (const row of [a, b]) {
      await expect(nacional.cancelar(db, { companyId: CID, nfseId: row.id, xMotivo: 'Venda cancelada pelo cliente' }, { ...ctxBase, transport: t }))
        .rejects.toMatchObject({ code: 'NOTA_NAO_CONFERIDA', message: expect.stringMatching(/não foi emitida pela Aura/) });
    }
    expect(t).not.toHaveBeenCalled();
  });

  test('NFS-e gravada sem a DPS embutida (indeterminado): também recusa', async () => {
    const row = comLinhaAdotada({ xml_nfse: `<NFSe><infNFSe Id="NFS${CHAVE_DA_AURA}"><nNFSe>2</nNFSe></infNFSe></NFSe>` });
    const t = sefinFalso();
    await expect(nacional.cancelar(db, { companyId: CID, nfseId: row.id, xMotivo: 'Venda cancelada pelo cliente' }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'NOTA_NAO_CONFERIDA', details: { resultado: 'indeterminado' } });
    expect(t).not.toHaveBeenCalled();
  });

  test('nota da Aura (NFS-e com a DPS que ela assinou): cancela normalmente', async () => {
    const t = sefinFalso();
    const n = await notaDaAura(t);
    const r = await nacional.cancelar(db, { companyId: CID, nfseId: n.id, xMotivo: 'Venda cancelada pelo cliente' }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('cancelada');
    expect(t.chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/eventos'))).toBe(true);
  });
});

// ── item 2: 201 direto e guarda do gravarAutorizada ───────────

describe('item 2 — 201 direto só grava a NFS-e da DPS enviada; a guarda do SQL vence leitura antiga', () => {
  test('201 com a NFS-e de OUTRA DPS (Id diferente): não vira autorizada; pendente, evidência guardada', async () => {
    repo.__state.config = configDaLoja({ serie: '3' }); // a DPS da Aura é a série 3; a devolvida, a série 1 da prefeitura
    const t = sefinFalso({ postDps: () => json(201, { chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR, nfseXmlGZipB64: gz(incidente.NFSE_DA_PREFEITURA) }) });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-201', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r.aguardando).toBe(true);
    expect(r.nota).toMatchObject({ status: 'pendente', chave_acesso: null, nfse_number: null });
    expect(repo.gravarAutorizada).not.toHaveBeenCalled();
    const ev = repo.__state.notas[0].provider_response.autorizada_sem_conferencia;
    expect(ev).toMatchObject({ id_dps_devolvido: incidente.ID_DPS_SERIE1_N1, chave_acesso: incidente.CHAVE_DO_OUTRO_EMISSOR });
    expect(ev.id_dps_esperado).toMatch(/^DPS3550308211222333000181000030{14}1$/);
  });

  test('201 com NFS-e sem a DPS embutida: também não grava', async () => {
    const t = sefinFalso({ postDps: () => json(201, { chaveAcesso: CHAVE_DA_AURA, nfseXmlGZipB64: gz(`<NFSe><infNFSe Id="NFS${CHAVE_DA_AURA}"><nNFSe>2</nNFSe></infNFSe></NFSe>`) }) });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-201b', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r.aguardando).toBe(true);
    expect(r.nota.status).toBe('pendente');
    expect(repo.gravarAutorizada).not.toHaveBeenCalled();
  });

  test('201 com a NFS-e da própria DPS: grava como sempre', async () => {
    const t = sefinFalso();
    const n = await notaDaAura(t);
    expect(n).toMatchObject({ status: 'autorizada', chave_acesso: CHAVE_DA_AURA, nfse_number: '2' });
  });

  test('"Tentar de novo" com leitura antiga: a guarda barra e o emissor devolve a nota como está (sem lançar)', async () => {
    // timeout: nota pendente; a consulta seguinte confere 'igual', mas outra
    // requisição marcou a nota como de outro emissor entre a leitura e a gravação
    let t = null;
    t = sefinFalso({
      postDps: () => { throw new Error('timeout após 30000ms'); },
      getDps: () => json(404, {}),
    });
    const r1 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-g', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r1.nota.status).toBe('pendente');
    const postada = ungz(t.posts()[0].body.dpsXmlGZipB64);
    t = sefinFalso({
      getDps: () => json(200, { chaveAcesso: CHAVE_DA_AURA }),
      getNfse: () => {
        Object.assign(repo.__state.notas[0], { status: 'erro', error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO', descricao: 'x' }] });
        return json(200, { chaveAcesso: CHAVE_DA_AURA, nfseXmlGZipB64: gz(nfseCom(postada)) });
      },
    });
    const r2 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-g', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(repo.gravarAutorizada).toHaveBeenCalledTimes(1);
    expect(r2.nota).toMatchObject({ status: 'erro', chave_acesso: null });
    expect(t.posts()).toHaveLength(0); // não reenviou
  });
});

// ── item 4: DANFSe, XML e consulta ────────────────────────────

describe('item 4 — PDF, XML e consulta só para nota autorizada/cancelada da Aura', () => {
  test('podeServirNota: pendente/erro/rejeitada não; marcada não; linha adotada não; nota da Aura sim', () => {
    expect(podeServirNota({ status: 'pendente' })).toMatchObject({ ok: false, code: 'ESTADO_INVALIDO' });
    expect(podeServirNota({ status: 'erro' })).toMatchObject({ ok: false, code: 'ESTADO_INVALIDO' });
    expect(podeServirNota({ status: 'rejeitada' })).toMatchObject({ ok: false, code: 'ESTADO_INVALIDO' });
    expect(podeServirNota({ status: 'autorizada', rejection_reason: 'DPS_NUMERO_JA_USADO: x' })).toMatchObject({ ok: false, code: 'NOTA_NAO_CONFERIDA' });
    expect(podeServirNota(incidente.linhaAdotada())).toMatchObject({ ok: false, code: 'NOTA_NAO_CONFERIDA' });
    expect(podeServirNota(incidente.linhaAdotada({ status: 'cancelada' }))).toMatchObject({ ok: false, code: 'NOTA_NAO_CONFERIDA' });
    const daAura = incidente.linhaAdotada({ xml_nfse: nfseCom(incidente.DPS_DA_AURA_SERIE1_N1) });
    expect(podeServirNota(daAura)).toEqual({ ok: true });
    expect(podeServirNota({ ...daAura, status: 'cancelada' })).toEqual({ ok: true });
  });

  test('DANFSe da linha adotada e da nota pendente: recusa sem baixar nada', async () => {
    const t = sefinFalso();
    const row = comLinhaAdotada();
    await expect(nacional.danfse(db, { companyId: CID, nfseId: row.id }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'NOTA_NAO_CONFERIDA' });
    const p = comLinhaAdotada({ id: 'pend', idempotency_key: 'kp', status: 'pendente' });
    await expect(nacional.danfse(db, { companyId: CID, nfseId: p.id }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'ESTADO_INVALIDO' });
    expect(t).not.toHaveBeenCalled();
  });

  test('DANFSe da nota da Aura: sai', async () => {
    const t = sefinFalso();
    const n = await notaDaAura(t);
    const pdf = await nacional.danfse(db, { companyId: CID, nfseId: n.id }, { ...ctxBase, transport: t });
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('consulta de nota em erro DPS_NUMERO_JA_USADO: não muda status nem XML, nem chama o gov.br', async () => {
    const row = comLinhaAdotada({
      status: 'erro', chave_acesso: null, nfse_number: null, xml_nfse: null,
      error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO', descricao: 'x' }],
    });
    const antes = JSON.parse(JSON.stringify(repo.__state.notas[0]));
    const t = sefinFalso({ getDps: () => json(200, { chaveAcesso: CHAVE_DA_AURA }) });
    const r = await nacional.consultar(db, { companyId: CID, nfseId: row.id }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('erro');
    expect(repo.__state.notas[0]).toEqual(antes);
    expect(t).not.toHaveBeenCalled();
  });

  test('consulta da linha adotada: não segue a chave alheia (nem XML novo, nem cancelamento do outro emissor)', async () => {
    const row = comLinhaAdotada();
    const t = sefinFalso({
      getNfse: () => json(200, { chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR, nfseXmlGZipB64: gz(incidente.NFSE_DO_OUTRO_EMISSOR) }),
      getEvento: () => json(200, { eventoXmlGZipB64: gz('<evento>cancelada pelo outro emissor</evento>') }),
    });
    const r = await nacional.consultar(db, { companyId: CID, nfseId: row.id }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('autorizada');
    expect(repo.__state.notas[0].xml_nfse).toBe(incidente.NFSE_DA_PREFEITURA);
    expect(repo.atualizarXmlNfse).not.toHaveBeenCalled();
    expect(repo.gravarCancelada).not.toHaveBeenCalled();
    expect(t).not.toHaveBeenCalled();
  });

  test('consulta da nota da Aura com o gov.br devolvendo outra NFS-e: o XML gravado não é trocado', async () => {
    const t = sefinFalso();
    const n = await notaDaAura(t);
    const xmlAntes = repo.__state.notas[0].xml_nfse;
    const t2 = sefinFalso({ getNfse: () => json(200, { chaveAcesso: CHAVE_DA_AURA, nfseXmlGZipB64: gz(incidente.NFSE_DA_PREFEITURA) }) });
    await nacional.consultar(db, { companyId: CID, nfseId: n.id }, { ...ctxBase, transport: t2 });
    expect(repo.atualizarXmlNfse).not.toHaveBeenCalled();
    expect(repo.__state.notas[0].xml_nfse).toBe(xmlAntes);
  });

  test('consulta de nota pendente (timeout) que acha a NFS-e alheia: confere e marca, nunca adota', async () => {
    const t = sefinFalso({ postDps: () => { throw new Error('timeout após 30000ms'); }, getDps: () => json(404, {}) });
    const r1 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-p', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r1.nota.status).toBe('pendente');
    const t2 = sefinFalso({
      getDps: () => json(200, { chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR }),
      getNfse: () => json(200, { chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR, nfseXmlGZipB64: gz(incidente.NFSE_DA_PREFEITURA) }),
    });
    const r = await nacional.consultar(db, { companyId: CID, nfseId: r1.nota.id }, { ...ctxBase, transport: t2 });
    expect(r.nota).toMatchObject({ status: 'erro', chave_acesso: null, xml_nfse: null });
    expect(repo.gravarAutorizada).not.toHaveBeenCalled();
    expect(repo.__state.notas[0].provider_response.nfse_de_outro_emissor.xml_nfse).toBe(incidente.NFSE_DA_PREFEITURA);
  });
});

// ── item 7: série antes da primeira nota de verdade ───────────

describe('item 7 — a primeira nota de verdade só sai com o passo da série respondido', () => {
  const sem = { notaDaAura: false, series: [] };

  test('regra pura: outro_emissor respondido libera; sem resposta e sem histórico barra com mensagem gentil', () => {
    expect(pendenciaDaSerieAntesDaPrimeiraNota({ config: { outro_emissor: false }, historico: sem })).toBeNull();
    expect(pendenciaDaSerieAntesDaPrimeiraNota({ config: { outro_emissor: true }, historico: sem })).toBeNull();
    const msg = pendenciaDaSerieAntesDaPrimeiraNota({ config: { outro_emissor: null, serie: '1' }, historico: sem });
    expect(msg).toBe(MSG_SERIE_ANTES_DA_PRIMEIRA_NOTA);
    expect(msg).toMatch(/Notas fiscais > "Pronto para emitir NFS-e\?"/);
    expect(msg).toMatch(/Nada foi enviado\.$/);
  });

  test('regra pura: nota de produção da Aura libera (exceção)', () => {
    expect(pendenciaDaSerieAntesDaPrimeiraNota({ config: { outro_emissor: null }, historico: { notaDaAura: true, series: ['1'] } })).toBeNull();
  });

  test('regra pura: série trocada depois do conflito, com a série confirmada, conta como resposta', () => {
    const cfg = { outro_emissor: null, serie: '3', serie_confirmada_em: '2026-11-10T19:47:45Z' };
    expect(pendenciaDaSerieAntesDaPrimeiraNota({ config: cfg, historico: { notaDaAura: false, series: ['1'] } })).toBeNull();
    // série confirmada mas na MESMA série da nota que já saiu: é a forma do incidente, não conta
    expect(pendenciaDaSerieAntesDaPrimeiraNota({ config: { ...cfg, serie: '1' }, historico: { notaDaAura: false, series: ['1'] } }))
      .toBe(MSG_SERIE_ANTES_DA_PRIMEIRA_NOTA);
    // série trocada sem a confirmação da loja: não conta
    expect(pendenciaDaSerieAntesDaPrimeiraNota({ config: { ...cfg, serie_confirmada_em: null }, historico: { notaDaAura: false, series: ['1'] } }))
      .toBe(MSG_SERIE_ANTES_DA_PRIMEIRA_NOTA);
    // série confirmada sozinha (sem nota nenhuma em produção) não conta
    expect(pendenciaDaSerieAntesDaPrimeiraNota({ config: { ...cfg }, historico: sem })).toBe(MSG_SERIE_ANTES_DA_PRIMEIRA_NOTA);
  });

  function emProducao(over = {}) {
    process.env.NFSE_NACIONAL_PRODUCAO = 'true';
    repo.__state.config = configDaLoja({ ambiente: 'producao', outro_emissor: null, ...over });
  }

  test('produção sem resposta e sem nota: recusa SERIE_NAO_RESPONDIDA, nada sai, nenhum número gasto', async () => {
    emProducao();
    const t = sefinFalso();
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-1', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'SERIE_NAO_RESPONDIDA', message: MSG_SERIE_ANTES_DA_PRIMEIRA_NOTA });
    expect(t).not.toHaveBeenCalled();
    expect(repo.__state.config.next_dps_number).toBe(1);
    expect(repo.__state.notas).toHaveLength(0);
  });

  test('a loja do incidente (série 3 por decisão do dono, série confirmada em 10/11, a nota adotada na série 1) NÃO é barrada', async () => {
    emProducao({ serie: '3', next_dps_number: 1, serie_confirmada_em: '2026-11-10T19:47:45.814Z' });
    comLinhaAdotada();
    const t = sefinFalso();
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-2', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r.nota).toMatchObject({ status: 'autorizada', dps_serie: '3', dps_number: '1' });
  });

  test('a nota adotada de outro emissor NÃO conta como "nota da Aura": na mesma série, segue barrada', async () => {
    emProducao({ serie: '1', next_dps_number: 2, serie_confirmada_em: '2026-11-10T19:47:45.814Z' });
    comLinhaAdotada();
    const t = sefinFalso();
    await expect(nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-3', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t }))
      .rejects.toMatchObject({ code: 'SERIE_NAO_RESPONDIDA' });
    expect(t).not.toHaveBeenCalled();
  });

  test('exceção: a loja já tem nota de produção autorizada pela Aura (conferida) → emite sem a pergunta', async () => {
    emProducao({ next_dps_number: 5 });
    comLinhaAdotada({ id: 'da-aura', dps_number: '4', xml_nfse: nfseCom(incidente.DPS_DA_AURA_SERIE1_N1) });
    const t = sefinFalso();
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-4', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r.nota.status).toBe('autorizada');
  });

  test('a nota já transmitida (retomada da mesma chave) segue para a consulta, sem a pergunta', async () => {
    emProducao({ outro_emissor: false });
    const t = sefinFalso({ postDps: () => { throw new Error('timeout após 30000ms'); } });
    const r1 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-5', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: t });
    expect(r1.nota.status).toBe('pendente');
    repo.__state.config.outro_emissor = null; // ex.: a resposta foi apagada depois
    const r2 = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-5', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: sefinFalso() });
    expect(r2.nota.status).toBe('autorizada');
  });

  test('produção restrita (homologação) não passa pela regra', async () => {
    repo.__state.config = configDaLoja({ outro_emissor: null });
    const r = await nacional.emitir(db, { companyId: CID, idempotencyKey: 'venda-6', nota: incidente.VENDA_DA_AURA }, { ...ctxBase, transport: sefinFalso() });
    expect(r.nota.status).toBe('autorizada');
  });
});
