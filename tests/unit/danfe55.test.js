// ============================================================
// DANFE A4 da NF-e 55 (sefazSp/danfe55) e nfeProc (sefazSp/nfeProc) —
// CP3, 14/11/2026. Dados fictícios (tests/fixtures/nfe55Documentos).
// ============================================================
'use strict';

const { gerarDanfe55Pdf, lerNfe55, code128C, CODE128, CODE128_STOP, fmtChave } = require('../../src/services/sefazSp/danfe55');
const { montarNfeProc, extrairProtNFe, dhBrasilia } = require('../../src/services/sefazSp/nfeProc');
const { textoDoPdf } = require('../helpers/textoDoPdf');
const fx = require('../fixtures/nfe55Documentos');

const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;

describe('CODE-128C da chave', () => {
  it('tabela padrão: 106 símbolos de 11 módulos (6 elementos) e STOP de 13', () => {
    expect(CODE128).toHaveLength(106);
    for (const p of CODE128) {
      expect(p).toHaveLength(6);
      expect(p.split('').reduce((a, b) => a + Number(b), 0)).toBe(11);
    }
    expect(new Set(CODE128).size).toBe(106);
    expect(CODE128_STOP.split('').reduce((a, b) => a + Number(b), 0)).toBe(13);
  });

  it('chave de 44 dígitos: START C + 22 pares + verificador + STOP (277 módulos)', () => {
    const { chave } = fx.xmlVenda();
    const larg = code128C(chave);
    expect(larg.startsWith('211232')).toBe(true); // START C
    expect(larg.endsWith('2331112')).toBe(true);
    expect(larg.split('').reduce((a, b) => a + Number(b), 0)).toBe(277);
  });

  it('verificador: módulo 103 da soma ponderada (exemplo "12" → 105 + 12 = 117 → 14)', () => {
    expect(code128C('12')).toBe('211232' + CODE128[12] + CODE128[14] + CODE128_STOP);
    expect(() => code128C('123')).toThrow();
  });
});

describe('lerNfe55', () => {
  it('lê ide, emitente, destinatário, itens e totais do XML', () => {
    const { xml, chave } = fx.xmlVenda();
    const d = lerNfe55(xml);
    expect(d.chave).toBe(chave);
    expect(d.ide).toMatchObject({ nNF: '15', serie: '2', tpNF: '1', tpAmb: '2', natOp: 'Venda de mercadoria' });
    expect(d.emit).toMatchObject({ cnpj: '11222333000181', ie: '110042490114', uf: 'SP' });
    expect(d.dest).toMatchObject({ documento: '11444777000161', email: 'compras@exemplo.com' });
    expect(d.itens).toHaveLength(3);
    expect(d.itens[1]).toMatchObject({ cfop: '5405', cst: '0500', quantidade: 2, valorTotal: 21 });
    expect(d.total.vNF).toBe(63);
  });
  it('recusa XML que não é modelo 55', () => {
    expect(() => lerNfe55('<NFe><infNFe Id="NFe1"><ide><mod>65</mod></ide></infNFe></NFe>')).toThrow();
  });
});

describe('gerarDanfe55Pdf', () => {
  it('1 folha: PDF com chave, número, série, protocolo, destinatário, produtos e dados adicionais', async () => {
    const { xml, chave } = fx.xmlVenda({ tpAmb: 1 });
    const pdf = await gerarDanfe55Pdf(xml, { protocolo: '135260000000001', dhRecbto: '2026-11-14T10:00:05-03:00', compress: false });
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(paginas(pdf)).toBe(1);
    const t = textoDoPdf(pdf);
    expect(t).toContain(fmtChave(chave));
    expect(t).toContain('Nº 000.000.015');
    expect(t).toContain('SÉRIE 2');
    expect(t).toContain('DANFE');
    expect(t).toContain('135260000000001  14/11/2026 10:00:05');
    expect(t).toContain('Construtora Ficticia Ltda');
    expect(t).toContain('11.444.777/0001-61');
    expect(t).toContain('RECEBEMOS DE LOJA EXEMPLO MATERIAIS LTDA');
    expect(t).toContain('CÁLCULO DO IMPOSTO');
    expect(t).toContain('TRANSPORTADOR / VOLUMES TRANSPORTADOS');
    expect(t).toContain('Pedido ficticio 123');
    expect(t).toContain('FOLHA 1/1');
    expect(t).not.toContain('SEM VALOR FISCAL');
    expect(t).not.toContain('CANCELADA');
  });

  it('homologação leva a marca SEM VALOR FISCAL', async () => {
    const { xml } = fx.xmlVenda({ tpAmb: 2 });
    const t = textoDoPdf(await gerarDanfe55Pdf(xml, { protocolo: '1', compress: false }));
    expect(t).toContain('SEM VALOR FISCAL');
    expect(t).toContain('NF-E EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO');
  });

  it('cancelada leva a marca CANCELADA', async () => {
    const { xml } = fx.xmlVenda({ tpAmb: 1 });
    const t = textoDoPdf(await gerarDanfe55Pdf(xml, { protocolo: '1', cancelada: true, compress: false }));
    expect(t).toContain('CANCELADA');
  });

  it('muitos itens: várias folhas, cabeçalho repetido e FOLHA x/y', async () => {
    const { xml, chave } = fx.xmlVenda({ tpAmb: 1, nItens: 60 });
    const pdf = await gerarDanfe55Pdf(xml, { protocolo: '135260000000001', compress: false });
    const n = paginas(pdf);
    expect(n).toBeGreaterThanOrEqual(2);
    const t = textoDoPdf(pdf);
    for (let i = 1; i <= n; i++) expect(t).toContain(`FOLHA ${i}/${n}`);
    expect(t.split(fmtChave(chave)).length - 1).toBe(n); // chave em toda folha
    expect(t.split('RECEBEMOS DE').length - 1).toBe(1); // canhoto só na 1ª
    expect(t).toContain('P60');
  });

  it('protocolo vem do nfeProc quando há protNFe', async () => {
    const { xml, chave } = fx.xmlVenda({ tpAmb: 1 });
    const proc = montarNfeProc(xml, { protXml: extrairProtNFe(fx.retornoSoapAutorizado(chave)) });
    const t = textoDoPdf(await gerarDanfe55Pdf(proc.xml, { compress: false }));
    expect(t).toContain('135260000000001  14/11/2026 10:00:05');
  });
});

describe('nfeProc', () => {
  it('extrai o protNFe do retorno SOAP e monta NFe + protNFe', () => {
    const { xml, chave } = fx.xmlVenda();
    const prot = extrairProtNFe(fx.retornoSoapAutorizado(chave));
    expect(prot.startsWith('<protNFe versao="4.00">')).toBe(true);
    expect(prot).toContain('<verAplic>SP_NFE_PL009_V4</verAplic>');
    const r = montarNfeProc(xml, { protXml: prot });
    expect(r.protOrigem).toBe('sefaz');
    expect(r.chave).toBe(chave);
    expect(r.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe')).toBe(true);
    expect(r.xml).toMatch(/<\/NFe><protNFe versao="4\.00">[\s\S]*<\/protNFe><\/nfeProc>$/);
    expect(lerNfe55(r.xml).prot).toMatchObject({ nProt: '135260000000001', cStat: '100' });
  });

  it('sem protNFe guardado (nota de antes do CP3): remonta com nProt, data e o digVal da assinatura', () => {
    const { xml, chave } = fx.xmlVenda();
    const r = montarNfeProc(xml, { protocolo: '135260000000002', dhRecbto: '2026-11-14T13:00:05.000Z' });
    expect(r.protOrigem).toBe('reconstruido');
    expect(r.xml).toContain(`<chNFe>${chave}</chNFe>`);
    expect(r.xml).toContain('<nProt>135260000000002</nProt>');
    expect(r.xml).toContain('<dhRecbto>2026-11-14T10:00:05-03:00</dhRecbto>');
    expect(r.xml).toContain('<digVal>ZGlnZXN0LWZpY3RpY2lv</digVal>');
    expect(r.xml).toContain('<verAplic>AURA</verAplic>');
  });

  it('protNFe de outra chave é ignorado; sem protocolo nenhum, erro', () => {
    const { xml } = fx.xmlVenda();
    const outro = extrairProtNFe(fx.retornoSoapAutorizado('3'.repeat(44)));
    expect(montarNfeProc(xml, { protXml: outro, protocolo: '9' }).protOrigem).toBe('reconstruido');
    expect(() => montarNfeProc(xml, {})).toThrow(/protocolo/);
  });

  it('dhBrasilia', () => {
    expect(dhBrasilia('2026-11-14T10:00:05-03:00')).toBe('2026-11-14T10:00:05-03:00');
    expect(dhBrasilia(new Date('2026-11-14T13:00:05Z'))).toBe('2026-11-14T10:00:05-03:00');
    expect(dhBrasilia(null)).toBe('');
  });
});
