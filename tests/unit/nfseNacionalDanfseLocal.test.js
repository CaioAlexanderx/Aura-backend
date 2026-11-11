// ============================================================
// NFS-e Nacional — DANFSe gerado pela Aura quando o ADN não entrega o PDF.
//
// O caso de produção (11/11/2026): NFS-e autorizada, chave e XML gravados,
// conferência 'igual', mas GET adn.nfse.gov.br/danfse/{chave} respondia
// HTTP 503 em toda tentativa — o lojista não via nem imprimia a nota.
//
// O que fica provado aqui:
//   * ADN 200 com PDF → o PDF do ADN, intacto (primeira opção);
//   * ADN 503 / timeout / resposta que não é PDF / 404 depois de alguns
//     minutos / A1 que não abre → DANFSe da Aura, com número, chave,
//     valores e emitente tirados do XML, e um aviso no log sem dado de
//     cliente;
//   * 404 logo depois da autorização → null (a rota diz "tente de novo");
//   * nota que não passa em podeServirNota (outro emissor, pendente) →
//     recusa como hoje, sem chamar o ADN e sem gerar nada;
//   * XML com outra chave → recusa;
//   * conteúdo: campo ausente no XML fica fora; texto hostil do XML entra
//     como texto (nada de script, ação ou link além da consulta pública).
// ============================================================
'use strict';

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

jest.mock('../../src/services/nfseNacional/repo', () => {
  const state = { notas: [], company: null };
  const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  return {
    __state: state,
    buscarPorId: jest.fn(async (db, companyId, id) => clone(state.notas.find((n) => n.company_id === companyId && n.id === id)) || null),
    carregarContexto: jest.fn(async () => ({ config: null, company: clone(state.company), certInfo: null })),
  };
});

const repo = require('../../src/services/nfseNacional/repo');
const certStore = require('../../src/services/sefazSp/certStore');
const nacional = require('../../src/services/nfseNacional');
const { montarDanfse, gerarDanfsePdf, CONSULTA_PUBLICA, RODAPE } = require('../../src/services/nfseNacional/danfseLocal');
const { lerDanfse } = require('../../src/services/nfseNacional/nfseParser');
const { gerarA1 } = require('../helpers/certA1Teste');
const { textoDoPdf } = require('../helpers/textoDoPdf');
const fx = require('../fixtures/nfseDanfseLocal');
const incidente = require('../fixtures/nfseDpsNumeroJaUsado');

const db = {};
const CID = 'loja-teste';
const PDF_DO_ADN = Buffer.from('%PDF-1.7 pdf do ADN');
const AUTORIZADA_EM = Date.parse('2026-11-11T12:41:15Z');
const depoisDe = (min) => () => new Date(AUTORIZADA_EM + min * 60000);
const ctx = (transport, now = depoisDe(60)) => ({ transport, retry: { attempts: 1, baseDelayMs: 0 }, now });

const resp = (status, body, headers = {}) => ({ status, headers, body: Buffer.from(body) });
const adn = (fn) => jest.fn(async (req) => fn(req));

let a1;
let warn;
beforeAll(() => { a1 = gerarA1({ cnpj: fx.CNPJ }); });

beforeEach(() => {
  process.env.NFSE_NACIONAL_ENABLED = 'true';
  process.env.NFSE_NACIONAL_PRODUCAO = 'true';
  repo.__state.notas = [fx.linhaAutorizada()];
  repo.__state.company = { id: CID, cnpj: fx.CNPJ, nome: 'Empresa Ficticia' };
  certStore.loadCertificate.mockReset();
  certStore.loadCertificate.mockResolvedValue({ pfx: a1.pfx, password: a1.senha });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.NFSE_NACIONAL_PRODUCAO;
});

const pedir = (c, nfseId = 'nfse-danfse-1') => nacional.danfse(db, { companyId: CID, nfseId }, c);

function esperarDanfseDaAura(pdf) {
  expect(Buffer.isBuffer(pdf)).toBe(true);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdf.equals(PDF_DO_ADN)).toBe(false);
  const texto = textoDoPdf(pdf);
  expect(texto).toContain('DANFSe — Documento Auxiliar da NFS-e');
  expect(texto).toContain('NFS-e nº 15');
  expect(texto).toContain(fx.CHAVE);
  expect(texto).toContain('R$ 150,00'); // valor do serviço, base e líquido
  expect(texto).toContain('R$ 3,00'); // ISSQN
  expect(texto).toContain('2,00%');
  expect(texto).toContain('11.222.333/0001-81');
  expect(texto).toContain('EMPRESA FICTICIA DE SERVICOS LTDA');
  expect(texto).toContain(RODAPE);
  return texto;
}

function avisoDoLog() {
  const chamada = warn.mock.calls.find((c) => /DANFSe|ADN/.test(String(c[0])));
  expect(chamada).toBeTruthy();
  const linha = chamada.map(String).join(' ');
  // sem dado de cliente: nem tomador, nem documento, nem chave
  expect(linha).not.toContain(fx.CPF_TOMADOR);
  expect(linha).not.toContain('CLIENTE FICTICIO');
  expect(linha).not.toContain(fx.CHAVE);
  return linha;
}

describe('DANFSe: o PDF do ADN continua sendo a primeira opção', () => {
  test('ADN 200 com PDF → o PDF do ADN, intacto, sem aviso', async () => {
    const t = adn(() => resp(200, PDF_DO_ADN));
    const pdf = await pedir(ctx(t));
    expect(pdf.equals(PDF_DO_ADN)).toBe(true);
    expect(t).toHaveBeenCalledTimes(1);
    expect(t.mock.calls[0][0].url).toBe(`https://adn.nfse.gov.br/danfse/${fx.CHAVE}`);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('DANFSe: ADN não entrega → DANFSe da Aura do XML autorizado', () => {
  test('ADN 503 em toda tentativa → DANFSe da Aura; aviso no log com o motivo', async () => {
    const t = adn(() => resp(503, '<html>Service Unavailable</html>', { 'content-type': 'text/html' }));
    const pdf = await pedir({ ...ctx(t), retry: { attempts: 2, baseDelayMs: 0 } });
    esperarDanfseDaAura(pdf);
    expect(t).toHaveBeenCalledTimes(2);
    expect(avisoDoLog()).toContain('adn_http_503');
  });

  test('timeout / erro de rede → DANFSe da Aura', async () => {
    const t = jest.fn(async () => { throw new Error('timeout após 15000ms'); });
    esperarDanfseDaAura(await pedir(ctx(t)));
    expect(avisoDoLog()).toContain('adn_transporte');
  });

  test('ADN 200 que não é PDF (página de erro) → DANFSe da Aura', async () => {
    const t = adn(() => resp(200, '<html>manutenção</html>'));
    esperarDanfseDaAura(await pedir(ctx(t)));
  });

  test('ADN 404 logo depois da autorização → null (tente de novo); depois de alguns minutos → DANFSe da Aura', async () => {
    const t = adn(() => resp(404, ''));
    expect(await pedir(ctx(t, depoisDe(2)))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    esperarDanfseDaAura(await pedir(ctx(t, depoisDe(30))));
    expect(avisoDoLog()).toContain('adn_404');
  });

  test('sem issued_at, vale o dhProc do XML para o 404', async () => {
    repo.__state.notas = [fx.linhaAutorizada({ issued_at: null })];
    const t = adn(() => resp(404, ''));
    expect(await pedir(ctx(t, depoisDe(1)))).toBeNull();
    esperarDanfseDaAura(await pedir(ctx(t, depoisDe(10))));
  });

  test('A1 que não abre mais (o ADN exige mTLS) → DANFSe da Aura, sem chamar o ADN', async () => {
    certStore.loadCertificate.mockRejectedValue(new Error('certificado vencido'));
    const t = adn(() => resp(200, PDF_DO_ADN));
    esperarDanfseDaAura(await pedir(ctx(t)));
    expect(t).not.toHaveBeenCalled();
    expect(avisoDoLog()).toContain('certificado');
  });

  test('nota cancelada (servível): DANFSe da Aura marca CANCELADA', async () => {
    repo.__state.notas = [fx.linhaAutorizada({ status: 'cancelada' })];
    const t = adn(() => resp(503, ''));
    const texto = esperarDanfseDaAura(await pedir(ctx(t)));
    expect(texto).toContain('NFS-e CANCELADA');
  });
});

describe('DANFSe: quem não pode ver a nota continua recusado (incidente de 10/11/2026)', () => {
  test('NFS-e de outro emissor (linha adotada do incidente) → NOTA_NAO_CONFERIDA, sem ADN e sem PDF', async () => {
    repo.__state.notas = [{ ...incidente.linhaAdotada(), id: 'adotada', company_id: CID, provider: 'nacional' }];
    const t = adn(() => resp(503, ''));
    await expect(pedir(ctx(t), 'adotada')).rejects.toMatchObject({ code: 'NOTA_NAO_CONFERIDA' });
    expect(t).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test('nota marcada DPS_NUMERO_JA_USADO → NOTA_NAO_CONFERIDA', async () => {
    repo.__state.notas = [fx.linhaAutorizada({ error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO' }] })];
    const t = adn(() => resp(503, ''));
    await expect(pedir(ctx(t))).rejects.toMatchObject({ code: 'NOTA_NAO_CONFERIDA' });
    expect(t).not.toHaveBeenCalled();
  });

  test('NFS-e gravada que não confere com a DPS da Aura → NOTA_NAO_CONFERIDA', async () => {
    repo.__state.notas = [fx.linhaAutorizada({ xml_dps: fx.XML_DPS.replace('<vServ>150.00</vServ>', '<vServ>99.00</vServ>') })];
    const t = adn(() => resp(503, ''));
    await expect(pedir(ctx(t))).rejects.toMatchObject({ code: 'NOTA_NAO_CONFERIDA' });
    expect(t).not.toHaveBeenCalled();
  });

  test('nota pendente → ESTADO_INVALIDO', async () => {
    repo.__state.notas = [fx.linhaAutorizada({ status: 'pendente' })];
    const t = adn(() => resp(503, ''));
    await expect(pedir(ctx(t))).rejects.toMatchObject({ code: 'ESTADO_INVALIDO' });
    expect(t).not.toHaveBeenCalled();
  });

  test('XML gravado com outra chave → não gera (NACIONAL_INDISPONIVEL)', async () => {
    const outra = `${fx.CHAVE.slice(0, -1)}0`;
    repo.__state.notas = [fx.linhaAutorizada({ chave_acesso: outra })];
    const t = adn(() => resp(503, ''));
    await expect(pedir(ctx(t))).rejects.toMatchObject({ code: 'NACIONAL_INDISPONIVEL' });
  });

  test('sem XML gravado → não gera (NACIONAL_INDISPONIVEL)', async () => {
    repo.__state.notas = [fx.linhaAutorizada({ xml_nfse: null, xml_dps: null })];
    const t = adn(() => resp(503, ''));
    await expect(pedir(ctx(t))).rejects.toMatchObject({ code: 'NACIONAL_INDISPONIVEL' });
  });
});

describe('conteúdo do DANFSe da Aura', () => {
  const todosOsValores = (m) => m.secoes.flatMap((s) => s.campos.map((c) => c.valor));
  const rotulos = (m) => m.secoes.flatMap((s) => s.campos.map((c) => c.rotulo));

  test('leiaute: identificação, emitente, tomador, serviço, valores, regime e consulta pública', () => {
    const m = montarDanfse(lerDanfse(fx.nfseXml()));
    expect(m.secoes.map((s) => s.titulo)).toEqual([
      'Identificação da NFS-e', 'Emitente / prestador do serviço', 'Tomador do serviço', 'Serviço prestado',
      'Tributação municipal (ISSQN)', 'Valores', 'Regime tributário', 'Informações complementares',
    ]);
    const v = Object.fromEntries(m.secoes.flatMap((s) => s.campos.map((c) => [c.rotulo, c.valor])));
    expect(v).toMatchObject({
      'Número da NFS-e': '15',
      'Chave de acesso': fx.CHAVE,
      'Data e hora da emissão': '11/11/2026 09:41:12',
      'Data e hora do processamento': '11/11/2026 09:41:15',
      Competência: '11/11/2026',
      'Número da DPS': '15',
      'Série da DPS': '3',
      CNPJ: '11.222.333/0001-81',
      'Inscrição municipal': '123456',
      Município: 'Jacareí / SP',
      CPF: '529.982.247-25',
      'Código NBS': '120012100 — Serviços de manutenção e reparação',
      'Município de incidência do ISSQN': 'Jacareí',
      'Descrição do serviço': 'Manutenção preventiva de equipamento & limpeza',
      'Valor do serviço': 'R$ 150,00',
      'Base de cálculo do ISSQN': 'R$ 150,00',
      'Alíquota do ISSQN': '2,00%',
      'Valor do ISSQN': 'R$ 3,00',
      'Total de retenções': 'R$ 0,00',
      'Valor líquido da NFS-e': 'R$ 150,00',
      'Simples Nacional': 'Optante pelo Simples Nacional — Microempresa ou Empresa de Pequeno Porte (ME/EPP)',
      'Tributos aproximados': '6,00% (Simples Nacional)',
      'Informações complementares': 'Pedido interno 77',
    });
    expect(v['Código de tributação nacional']).toMatch(/^14\.01\.01 — Lubrificação/);
    expect(m.consulta).toEqual({ url: CONSULTA_PUBLICA, qr: expect.stringContaining(fx.CHAVE), chave: fx.CHAVE });
    expect(m.avisos).toEqual([]);
  });

  test('campo ausente no XML fica fora: sem tomador, sem complementares, sem retenções federais', () => {
    const xml = fx.nfseXml()
      .replace(/<toma>.*<\/toma>/, '')
      .replace(/<infoCompl>.*<\/infoCompl>/, '')
      .replace('<IM>123456</IM>', '');
    const m = montarDanfse(lerDanfse(xml));
    const titulos = m.secoes.map((s) => s.titulo);
    expect(titulos).not.toContain('Tomador do serviço');
    expect(titulos).not.toContain('Informações complementares');
    expect(rotulos(m)).not.toEqual(expect.arrayContaining(['IRRF retido']));
    expect(rotulos(m)).not.toContain('CPF');
    for (const val of todosOsValores(m)) {
      expect(val).not.toMatch(/undefined|null|NaN/);
    }
  });

  test('produção restrita (tpAmb 2) → aviso de sem valor fiscal', () => {
    const m = montarDanfse(lerDanfse(fx.nfseXml({ tpAmb: 2 })));
    expect(m.avisos.join(' ')).toMatch(/sem valor fiscal/);
  });

  test('texto hostil do XML entra como texto: sem script, ação ou link além da consulta pública', async () => {
    const xml = fx.nfseXml({
      descricao: '&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(2)&gt; javascript:alert(3) 🚀',
      nomeEmitente: 'EMPRESA (TESTE) \\ &lt;b&gt;LTDA&lt;/b&gt; ) Tj /JavaScript',
    });
    const m = montarDanfse(lerDanfse(xml));
    expect(todosOsValores(m)).toContain('<script>alert(1)</script> <img src=x onerror=alert(2)> javascript:alert(3) 🚀');

    const pdf = await gerarDanfsePdf(xml, { compress: false });
    const bruto = pdf.toString('latin1');
    expect(bruto).not.toMatch(/\/JavaScript|\/JS\b|\/OpenAction|\/Launch|\/AA\b/);
    const uris = bruto.match(/\/URI\s*\(([^)]*)\)/g) || [];
    expect(uris).toEqual([`/URI (${CONSULTA_PUBLICA})`]);

    const texto = textoDoPdf(pdf);
    expect(texto).toContain('<script>alert(1)</script>');
    expect(texto).toContain('EMPRESA (TESTE) \\ <b>LTDA</b> ) Tj /JavaScript');
    expect(texto).toContain('javascript:alert(3) ?'); // emoji fora do WinAnsi vira "?"
  });

  test('PDF de uma página com o rodapé e a consulta pública', async () => {
    const pdf = await gerarDanfsePdf(fx.nfseXml());
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBe(1);
    const texto = textoDoPdf(pdf);
    expect(texto).toContain(CONSULTA_PUBLICA);
    expect(texto).toContain(`Chave de acesso: ${fx.CHAVE}`);
    expect(texto).toContain(RODAPE);
  });
});
