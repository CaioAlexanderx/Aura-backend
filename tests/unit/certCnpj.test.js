// AURA. -- sefazSp/certCnpj: extracao e conferencia do CNPJ do certificado (14/10/2026)
const { extrairCnpjDoCertificado, cnpjDoCn, cnpjDoOid, cnpjConfere } = require('../../src/services/sefazSp/certCnpj');

describe('cnpjDoCn', () => {
  test('padrao ICP-Brasil RAZAO:CNPJ', () => {
    expect(cnpjDoCn('LOJA DA ANA LTDA:11222333000181')).toBe('11222333000181');
  });
  test('razao social com dois pontos e CNPJ mascarado', () => {
    expect(cnpjDoCn('COMERCIO A:B LTDA:11.222.333/0001-81')).toBe('11222333000181');
  });
  test('e-CPF (11 digitos) e CN sem numero => null', () => {
    expect(cnpjDoCn('MARIA DA SILVA:12345678901')).toBeNull();
    expect(cnpjDoCn('MARIA DA SILVA')).toBeNull();
    expect(cnpjDoCn(null)).toBeNull();
  });
});

describe('cnpjDoOid', () => {
  const oid = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03]);
  test('le os 14 digitos que vem depois do OID 2.16.76.1.3.3', () => {
    const der = Buffer.concat([Buffer.from([0x30, 0x20]), oid, Buffer.from([0xa0, 0x10, 0x0c, 0x0e]), Buffer.from('11222333000181'), Buffer.from([0x00])]);
    expect(cnpjDoOid(der)).toBe('11222333000181');
  });
  test('ignora outro OID da familia (2.16.76.1.3.4 => CPF do responsavel)', () => {
    const outro = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x04]);
    const der = Buffer.concat([outro, Buffer.from([0xa0, 0x10, 0x0c, 0x0e]), Buffer.from('01012000123456789012')]);
    expect(cnpjDoOid(der)).toBeNull();
  });
  test('sem OID ou entrada invalida => null', () => {
    expect(cnpjDoOid(Buffer.from('nada aqui'))).toBeNull();
    expect(cnpjDoOid(null)).toBeNull();
  });
});

describe('extrairCnpjDoCertificado', () => {
  test('OID tem prioridade sobre o CN', () => {
    const oid = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03]);
    const der = Buffer.concat([oid, Buffer.from([0xa0, 0x10, 0x0c, 0x0e]), Buffer.from('11222333000181')]);
    const r = extrairCnpjDoCertificado({ certDerBase64: der.toString('base64'), subjectCN: 'X:99888777000166' });
    expect(r).toEqual({ cnpj: '11222333000181', origem: 'oid' });
  });
  test('cai para o CN', () => {
    expect(extrairCnpjDoCertificado({ subjectCN: 'LOJA:11222333000181' })).toEqual({ cnpj: '11222333000181', origem: 'cn' });
  });
  test('nada encontrado => null', () => {
    expect(extrairCnpjDoCertificado({ subjectCN: 'FULANO:12345678901' })).toBeNull();
    expect(extrairCnpjDoCertificado(null)).toBeNull();
  });
});

describe('cnpjConfere', () => {
  test('igualdade so por digitos', () => {
    expect(cnpjConfere('11222333000181', '11.222.333/0001-81')).toBe(true);
    expect(cnpjConfere('11222333000181', '99888777000166')).toBe(false);
  });
  test('raiz so quando pedido', () => {
    expect(cnpjConfere('11222333000181', '11222333000262')).toBe(false);
    expect(cnpjConfere('11222333000181', '11222333000262', true)).toBe(true);
    expect(cnpjConfere('11222333000181', '99222333000262', true)).toBe(false);
  });
  test('tamanho invalido nunca confere', () => {
    expect(cnpjConfere('', '')).toBe(false);
    expect(cnpjConfere('123', '123', true)).toBe(false);
  });
});
