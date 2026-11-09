// ============================================================
// NFS-e Nacional — montagem da DPS e do pedido de cancelamento.
//   • campos, ordem e Id (E0004) conferidos contra o XSD OFICIAL v1.01
//     (schemas/NFSe_v1.01) pelo validador enxuto tests/helpers/xsdLite;
//   • regras do Anexo I que dependem de nós (Simples, pAliq, totTrib, xNome);
//   • assinatura verifica com o certificado embutido (mesmo verificador da NFC-e);
//   • se houver xmllint na máquina, valida também com ele (no CI é pulado).
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { buildDps, buildIdDps, validarEntrada, paraLatin1 } = require('../../src/services/nfseNacional/dpsBuilder');
const { buildCancelamento } = require('../../src/services/nfseNacional/eventoBuilder');
const { signElementById, verifyNfeSignature, signInfNfe } = require('../../src/services/sefazSp/signer');
const { createValidator } = require('../helpers/xsdLite');
const { gerarA1 } = require('../helpers/certA1Teste');

const DIR = path.join(__dirname, '../../schemas/NFSe_v1.01');
const NS = 'http://www.sped.fazenda.gov.br/nfse';
const dpsXsd = createValidator(DIR, ['tiposSimples_v1.01.xsd', 'tiposComplexos_v1.01.xsd', 'DPS_v1.01.xsd']);
const eventoXsd = createValidator(DIR, ['tiposSimples_v1.01.xsd', 'tiposEventos_v1.01.xsd', 'pedRegEvento_v1.01.xsd']);

const JACAREI = '3524402';
const CNPJ = '11222333000181';

function entradaBase(over = {}) {
  return {
    tpAmb: 2,
    dhEmi: new Date('2026-11-09T13:00:00Z'), // 10:00 em Brasília
    dCompet: '2026-11-09',
    cLocEmi: JACAREI,
    serie: '1',
    nDPS: '42',
    prestador: { cnpj: CNPJ, im: null, opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 },
    tomador: null,
    servico: { cTribNac: '010501', descricao: 'Licença de uso do sistema Aura — novembro/2026', cLocPrestacao: JACAREI },
    valores: { vServ: 199.9, tpRetISSQN: 1, pTotTribSN: 6 },
    ...over,
  };
}

describe('Id da DPS (Anexo I, E0004)', () => {
  test('"DPS" + cLocEmi(7) + 2 (CNPJ) + CNPJ(14) + série(5) + nDPS(15) = 45 caracteres', () => {
    const id = buildIdDps({ cLocEmi: JACAREI, cnpj: CNPJ, serie: '1', nDPS: '42' });
    expect(id).toBe(`DPS${JACAREI}2${CNPJ}00001000000000000042`);
    expect(id).toMatch(/^DPS[0-9]{42}$/);
  });

  test('prestador CPF: tipo 1 e CPF completado com zeros à esquerda', () => {
    const id = buildIdDps({ cLocEmi: JACAREI, cpf: '52998224725', serie: '7', nDPS: '1' });
    expect(id).toBe(`DPS${JACAREI}1` + '00052998224725' + '00007' + '000000000000001');
    expect(id).toHaveLength(45);
  });
});

describe('DPS — campos e XSD oficial', () => {
  test('ME/EPP do Simples, sem tomador: valida no XSD e segue as regras do Anexo I', () => {
    const { xml, idDps } = buildDps(entradaBase());
    expect(dpsXsd.validate(xml, { rootNamespace: NS })).toEqual([]);
    expect(xml).toContain(`<infDPS Id="${idDps}">`);
    expect(xml).toContain('<tpAmb>2</tpAmb>');
    expect(xml).toContain('<dhEmi>2026-11-09T10:00:00-03:00</dhEmi>');
    expect(xml).toContain('<serie>1</serie><nDPS>42</nDPS><dCompet>2026-11-09</dCompet><tpEmit>1</tpEmit>');
    expect(xml).toContain(`<cLocEmi>${JACAREI}</cLocEmi>`);
    expect(xml).toContain('<regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib>');
    expect(xml).toContain('<cTribNac>010501</cTribNac>');
    expect(xml).toContain('<vServ>199.90</vServ>');
    expect(xml).toContain('<tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>');
    expect(xml).toContain('<totTrib><pTotTribSN>6.00</pTotTribSN></totTrib>');
    // E0121: sem xNome do prestador; E0625: sem pAliq (SN, sem retenção)
    expect(xml).not.toMatch(/<prest>[\s\S]*<xNome>/);
    expect(xml).not.toContain('<pAliq>');
    expect(xml).not.toContain('<toma>');
    // texto fora do Latin-1 (travessão) trocado antes de entrar no XML
    expect(xml).toContain('Licença de uso do sistema Aura - novembro/2026');
  });

  test('com tomador PF e endereço completo: valida no XSD', () => {
    const { xml } = buildDps(entradaBase({
      tomador: {
        doc: '529.982.247-25', nome: '  Maria  da Silva ', email: 'maria@example.com', fone: '(12) 99999-0000',
        endereco: { cMun: JACAREI, cep: '12327-000', logradouro: 'Rua A', numero: '10', bairro: 'Centro' },
      },
    }));
    expect(dpsXsd.validate(xml, { rootNamespace: NS })).toEqual([]);
    expect(xml).toContain('<toma><CPF>52998224725</CPF><xNome>Maria da Silva</xNome><end><endNac><cMun>3524402</cMun><CEP>12327000</CEP></endNac><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro></end><fone>12999990000</fone><email>maria@example.com</email></toma>');
  });

  test('tomador PJ com endereço incompleto: endereço omitido (opcional), XSD ok', () => {
    const { xml } = buildDps(entradaBase({ tomador: { doc: '11.444.777/0001-61', nome: 'Cliente Ltda', endereco: { cep: '123' } } }));
    expect(dpsXsd.validate(xml, { rootNamespace: NS })).toEqual([]);
    expect(xml).toContain('<toma><CNPJ>11444777000161</CNPJ><xNome>Cliente Ltda</xNome></toma>');
  });

  test('ISSQN retido (ME/EPP): pAliq obrigatório (E0621) e no formato do XSD', () => {
    const { xml } = buildDps(entradaBase({
      tomador: { doc: '11444777000161', nome: 'Cliente Ltda' },
      valores: { vServ: 1000, tpRetISSQN: 2, pAliq: 2, pTotTribSN: 6 },
    }));
    expect(dpsXsd.validate(xml)).toEqual([]);
    expect(xml).toContain('<tpRetISSQN>2</tpRetISSQN><pAliq>2.00</pAliq>');
  });

  test('MEI: sem regApTribSN, indTotTrib=0, XSD ok', () => {
    const { xml } = buildDps(entradaBase({
      prestador: { cnpj: CNPJ, opSimpNac: 2, regApTribSN: null, regEspTrib: 0 },
      valores: { vServ: 50, tpRetISSQN: 1 },
    }));
    expect(dpsXsd.validate(xml)).toEqual([]);
    expect(xml).toContain('<regTrib><opSimpNac>2</opSimpNac><regEspTrib>0</regEspTrib></regTrib>');
    expect(xml).toContain('<totTrib><indTotTrib>0</indTotTrib></totTrib>');
  });

  test('inscrição municipal opcional: entra quando configurada', () => {
    const { xml } = buildDps(entradaBase({ prestador: { cnpj: CNPJ, im: '12345', opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 } }));
    expect(dpsXsd.validate(xml)).toEqual([]);
    expect(xml).toContain('<prest><CNPJ>11222333000181</CNPJ><IM>12345</IM><regTrib>');
  });

  test('o validador enxuto pega erro de verdade (prova que não passa por vácuo)', () => {
    const { xml } = buildDps(entradaBase());
    expect(dpsXsd.validate(xml.replace('<tpEmit>1</tpEmit>', ''))).not.toEqual([]);
    expect(dpsXsd.validate(xml.replace('<cTribNac>010501</cTribNac>', '<cTribNac>10501</cTribNac>'))).not.toEqual([]);
    expect(dpsXsd.validate(xml.replace('<serie>1</serie><nDPS>42</nDPS>', '<nDPS>42</nDPS><serie>1</serie>'))).not.toEqual([]);
    expect(dpsXsd.validate(xml.replace('<vServ>199.90</vServ>', '<vServ>199,90</vServ>'))).not.toEqual([]);
  });

  test('os esquemas não usam construções fora do alcance do xsdLite', () => {
    for (const f of ['tiposSimples_v1.01.xsd', 'tiposComplexos_v1.01.xsd', 'DPS_v1.01.xsd', 'tiposEventos_v1.01.xsd', 'pedRegEvento_v1.01.xsd']) {
      const txt = fs.readFileSync(path.join(DIR, f), 'utf8');
      expect(txt).not.toMatch(/xs:(union|list|all|group|any)\b|simpleContent|complexContent/);
    }
  });
});

describe('DPS — validação antes de montar', () => {
  const erros = (over) => validarEntrada(entradaBase(over));

  test('entrada boa: sem pendências', () => {
    expect(erros({})).toEqual([]);
  });
  test('CNPJ com DV errado, cTribNac curto, valor zero', () => {
    const e = validarEntrada({ ...entradaBase(), prestador: { cnpj: '11222333000182', opSimpNac: 3, regApTribSN: 1 }, servico: { cTribNac: '1051', descricao: 'x' }, valores: { vServ: 0, pTotTribSN: 6 } });
    expect(e.join(' ')).toMatch(/CNPJ da empresa/);
    expect(e.join(' ')).toMatch(/cTribNac/);
    expect(e.join(' ')).toMatch(/maior que zero/);
  });
  test('série fora da faixa de aplicativo próprio (E0010) e número com zero à esquerda', () => {
    expect(erros({ serie: '70000' }).join(' ')).toMatch(/49999/);
    expect(erros({ nDPS: '007' }).join(' ')).toMatch(/Número da DPS/);
  });
  test('competência depois da emissão (E0015)', () => {
    expect(erros({ dCompet: '2026-11-10' }).join(' ')).toMatch(/E0015/);
  });
  test('ME/EPP sem pTotTribSN; MEI com retenção (E0583); regime especial com SN (E0175)', () => {
    expect(erros({ valores: { vServ: 10, tpRetISSQN: 1 } }).join(' ')).toMatch(/pTotTribSN/);
    expect(validarEntrada({ ...entradaBase(), prestador: { cnpj: CNPJ, opSimpNac: 2, regEspTrib: 0 }, tomador: { doc: '52998224725', nome: 'A' }, valores: { vServ: 10, tpRetISSQN: 2 } }).join(' ')).toMatch(/E0583/);
    expect(validarEntrada({ ...entradaBase(), prestador: { cnpj: CNPJ, opSimpNac: 3, regApTribSN: 1, regEspTrib: 3 } }).join(' ')).toMatch(/E0175/);
  });
  test('retenção sem alíquota válida (E0621: 1,80% a 5%)', () => {
    expect(erros({ tomador: { doc: '52998224725', nome: 'A' }, valores: { vServ: 10, tpRetISSQN: 2, pAliq: 1, pTotTribSN: 6 } }).join(' ')).toMatch(/E0621/);
  });
  test('não optante precisa dos valores aproximados (E0713)', () => {
    const e = validarEntrada({ ...entradaBase(), prestador: { cnpj: CNPJ, opSimpNac: 1, regEspTrib: 0 }, valores: { vServ: 10, tpRetISSQN: 1 } });
    expect(e.join(' ')).toMatch(/E0713/);
  });
  test('CPF do tomador inválido', () => {
    expect(erros({ tomador: { doc: '12345678900', nome: 'A' } }).join(' ')).toMatch(/CPF do tomador/);
  });
  test('buildDps recusa com INVALID_INPUT e a lista de pendências', () => {
    let err;
    try { buildDps(entradaBase({ cLocEmi: '123' })); } catch (e) { err = e; }
    expect(err.code).toBe('INVALID_INPUT');
    expect(Array.isArray(err.details)).toBe(true);
  });
});

describe('paraLatin1 (TSString do XSD só aceita Latin-1)', () => {
  test('troca aspas/travessão, tira controle e emoji, mantém acentos', () => {
    expect(paraLatin1('“Ação” — teste\u0007 😀 ok')).toBe('"Ação" - teste ok');
    expect(paraLatin1('linha 1\nlinha 2', { quebraDeLinha: true })).toBe('linha 1\nlinha 2');
    expect(paraLatin1('linha 1\nlinha 2')).toBe('linha 1 linha 2');
  });
});

describe('assinatura (XMLDSig enveloped em infDPS / infPedReg)', () => {
  const cert = gerarA1();

  test('DPS assinada: Signature como último filho de <DPS>, verifica, e o XSD continua válido', () => {
    const { xml, idDps } = buildDps(entradaBase());
    const signed = signElementById(xml, { elementName: 'infDPS', keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 });
    expect(signed).toMatch(/<\/infDPS><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">[\s\S]*<\/Signature><\/DPS>$/);
    expect(signed).toContain(`URI="#${idDps}"`);
    expect(signed).toContain('rsa-sha256');
    expect(verifyNfeSignature(signed)).toEqual({ valid: true, errors: [] });
    expect(dpsXsd.validate(signed)).toEqual([]);
  });

  test('qualquer alteração depois de assinar invalida a assinatura', () => {
    const { xml } = buildDps(entradaBase());
    const signed = signElementById(xml, { elementName: 'infDPS', keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 });
    expect(verifyNfeSignature(signed.replace('<vServ>199.90</vServ>', '<vServ>1.00</vServ>')).valid).toBe(false);
  });

  test('pedido de cancelamento: Id PRE+chave+101101, XSD oficial ok, assinatura verifica', () => {
    const chave = '3524402' + '2' + '2' + CNPJ + '0000000000042' + '2611' + '123456789' + '7';
    expect(chave).toHaveLength(50);
    const { xml, idPedido } = buildCancelamento({
      tpAmb: 2, chave, cnpjAutor: CNPJ, cMotivo: 1, xMotivo: 'Valor do serviço digitado errado',
      dhEvento: new Date('2026-11-09T13:00:00Z'),
    });
    expect(idPedido).toBe(`PRE${chave}101101`);
    expect(eventoXsd.validate(xml, { rootNamespace: NS })).toEqual([]);
    expect(xml).toContain('<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Valor do serviço digitado errado</xMotivo></e101101>');
    const signed = signElementById(xml, { elementName: 'infPedReg', keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 });
    expect(verifyNfeSignature(signed).valid).toBe(true);
    expect(eventoXsd.validate(signed)).toEqual([]);
  });

  test('cancelamento recusa motivo curto e código fora de 1/2/9', () => {
    const chave = '1'.repeat(50);
    expect(() => buildCancelamento({ tpAmb: 2, chave, cnpjAutor: CNPJ, cMotivo: 1, xMotivo: 'curto' })).toThrow(/15 a 255/);
    expect(() => buildCancelamento({ tpAmb: 2, chave, cnpjAutor: CNPJ, cMotivo: 3, xMotivo: 'motivo comprido o bastante' })).toThrow(/1, 2 ou 9/);
  });

  test('signInfNfe (NFC-e) continua o mesmo: SHA-1 e Reference #NFe', () => {
    const inf = '<infNFe xmlns="http://www.portalfiscal.inf.br/nfe" Id="NFe35261111222333000181650010000000011000000019" versao="4.00"><ide/></infNFe>';
    const { signatureXml } = signInfNfe(inf, { keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 });
    expect(signatureXml).toContain('xmldsig#rsa-sha1');
    expect(signatureXml).toContain('URI="#NFe35261111222333000181650010000000011000000019"');
  });
});

// xmllint (libxml2) quando existir — no CI do GitHub não existe e é pulado.
function hasXmllint() {
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const comXmllint = hasXmllint() ? describe : describe.skip;
comXmllint('DPS contra o XSD oficial com xmllint', () => {
  test('DPS assinada valida', () => {
    const cert = gerarA1();
    const { xml } = buildDps(entradaBase());
    const signed = signElementById(xml, { elementName: 'infDPS', keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 });
    const tmp = path.join(os.tmpdir(), `dps-${crypto.randomBytes(6).toString('hex')}.xml`);
    fs.writeFileSync(tmp, `<?xml version="1.0" encoding="UTF-8"?>${signed}`);
    try {
      execFileSync('xmllint', ['--noout', '--schema', path.join(DIR, 'DPS_v1.01.xsd'), tmp], { stdio: 'pipe' });
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
