const crypto = require('crypto');
const qr = require('../../src/services/sefazSp/qrcode');

const CHAVE = '35260611222333000181650010000002311123456786';
const BASE = {
  chave: CHAVE,
  tpAmb: 2,
  cscId: '000001',
  cscToken: 'TOKEN-SECRETO-CSC',
  qrCodeBase: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode',
};

describe('sefazSp/qrcode — QR v2 emissão normal', () => {
  test('formato p = chave|2|tpAmb|idCSC|hash, idCSC sem zeros à esquerda', () => {
    const url = qr.buildQrCodeUrl(BASE);
    const p = url.split('?p=')[1];
    const parts = p.split('|');
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe(CHAVE);
    expect(parts[1]).toBe('2');
    expect(parts[2]).toBe('2');
    expect(parts[3]).toBe('1');                 // '000001' → '1'
    expect(parts[4]).toMatch(/^[0-9A-F]{40}$/); // SHA-1 hex maiúsculo
  });

  test('hash = SHA-1(p_sem_hash + CSC) — espelho independente', () => {
    const url = qr.buildQrCodeUrl(BASE);
    const p = url.split('?p=')[1];
    const semHash = p.split('|').slice(0, 4).join('|');
    const expected = crypto.createHash('sha1')
      .update(semHash + BASE.cscToken, 'utf8').digest('hex').toUpperCase();
    expect(p.split('|')[4]).toBe(expected);
  });

  test('CSC token nunca aparece na URL', () => {
    expect(qr.buildQrCodeUrl(BASE)).not.toContain('TOKEN-SECRETO-CSC');
  });

  test('hash muda com o token (não é só da chave)', () => {
    const a = qr.buildQrCodeUrl(BASE);
    const b = qr.buildQrCodeUrl({ ...BASE, cscToken: 'OUTRO' });
    expect(a).not.toBe(b);
  });
});

describe('sefazSp/qrcode — QR v2 contingência offline', () => {
  const DIGVAL = crypto.createHash('sha1').update('xml-assinado').digest('base64'); // 28 chars
  const CONT = {
    ...BASE, tpEmis: 9,
    dhEmi: '2026-06-10T10:00:00-03:00',
    vNF: 549.96,
    digVal: DIGVAL,
  };

  test('formato p = chave|2|tpAmb|dia|vNF|digValHex|idCSC|hash', () => {
    const p = qr.buildQrCodeUrl(CONT).split('?p=')[1];
    const parts = p.split('|');
    expect(parts.length).toBe(8);
    expect(parts[3]).toBe('10');                      // dia do dhEmi
    expect(parts[4]).toBe('549.96');                  // vNF 2 casas
    // hex da STRING base64 (56 chars), conforme XSD PL_010c
    expect(parts[5]).toBe(Buffer.from(DIGVAL, 'ascii').toString('hex').toUpperCase());
    expect(parts[5]).toMatch(/^[0-9A-F]{56}$/);
    expect(parts[6]).toBe('1');
    expect(parts[7]).toMatch(/^[0-9A-F]{40}$/);
  });

  test('contingência sem digVal/vNF/dhEmi rejeita', () => {
    expect(() => qr.buildQrCodeUrl({ ...BASE, tpEmis: 9 })).toThrow(/contingência exige/);
  });
});

describe('sefazSp/qrcode — infNFeSupl', () => {
  test('qrCode em CDATA + urlChave COM esquema (878 sem ele — validado na SEFAZ 16/07)', () => {
    const xml = qr.buildInfNfeSupl({
      qrCodeUrl: qr.buildQrCodeUrl(BASE),
      urlConsulta: 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta',
    });
    expect(xml).toMatch(/^<infNFeSupl><qrCode><!\[CDATA\[https:\/\//);
    expect(xml).toContain('<urlChave>https://www.homologacao.nfce.fazenda.sp.gov.br/consulta</urlChave>');
    expect(xml).not.toContain('TOKEN-SECRETO-CSC');
  });

  test('validações de entrada', () => {
    expect(() => qr.buildQrCodeUrl({ ...BASE, chave: '123' })).toThrow(/44 dígitos/);
    expect(() => qr.buildQrCodeUrl({ ...BASE, cscToken: null })).toThrow(/cscToken/);
    expect(() => qr.buildInfNfeSupl({ qrCodeUrl: 'x' })).toThrow(/urlConsulta/);
  });
});
