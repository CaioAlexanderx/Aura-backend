// ============================================================
// Fixtures do CP3 (DANFE/XML/e-mail da NF-e 55). Dados FICTÍCIOS:
// CNPJ/CPF/IE de teste válidos por dígito, nomes inventados.
// O XML sai do builder real (sefazSp/nfe55Venda) com uma assinatura de
// mentira (só o DigestValue importa para o protocolo remontado).
// ============================================================
'use strict';

const { buildInfNfe55Venda } = require('../../src/services/sefazSp/nfe55Venda');
const { composeNfe } = require('../../src/services/sefazSp/xmlBuilder');

const EMITENTE = {
  id: 'e1', cnpj: '11222333000181', legal_name: 'Loja Exemplo Materiais Ltda', trade_name: 'Loja Exemplo',
  address_street: 'Rua das Palmeiras', address_number: '100', address_neighborhood: 'Centro',
  address_city: 'Jacarei', address_state: 'SP', address_zip: '12327000',
  ibge_code: '3524402', inscricao_estadual: '110042490114', phone: '1239510000', tax_regime: 'simples_nacional',
};

const ASSINATURA = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI="">'
  + '<DigestValue>ZGlnZXN0LWZpY3RpY2lv</DigestValue></Reference></SignedInfo><SignatureValue>eA==</SignatureValue></Signature>';

function itens(n) {
  return Array.from({ length: n }, (_, i) => ({
    code: `P${i + 1}`, name: `Produto ficticio ${i + 1} com descricao comprida o bastante para quebrar a linha da tabela`,
    ncm: '25232910', unit: 'UN', quantity: i + 1, price: 10.5, csosn: i % 2 ? '500' : '102', orig: '0', pisCst: '07', cofinsCst: '07',
  }));
}

/** xml_signed fictício de uma 55 de venda. */
function xmlVenda({ tpAmb = 2, nItens = 3, numero = 15, emailDest = 'compras@exemplo.com' } = {}) {
  const its = itens(nItens);
  const total = its.reduce((s, it) => s + Math.round(it.quantity * it.price * 100) / 100, 0);
  const b = buildInfNfe55Venda(EMITENTE, {
    items: its, serie: 2, numero,
    dest: {
      cnpj: '11444777000161', nome: 'Construtora Ficticia Ltda', ie: '110042490114', indIEDest: '1', email: emailDest,
      endereco: { logradouro: 'Avenida Central', numero: '200', bairro: 'Jardim Exemplo', codigo_municipio: '3549904', municipio: 'Sao Jose dos Campos', uf: 'SP', cep: '12245000' },
    },
    payments: [{ method: '01', value: total }],
    observacoes: 'Pedido ficticio 123',
  }, { tpAmb, cNF: '12345678', dhEmi: '2026-11-14T10:00:00-03:00' });
  return { xml: composeNfe({ signedInfNfeXml: b.infNfeXml, infNfeSuplXml: '', signatureXml: ASSINATURA }), chave: b.chave, total };
}

/** Retorno SOAP de autorização (o que a SEFAZ manda), com o protNFe. */
function retornoSoapAutorizado(chave) {
  return '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
    + '<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">'
    + '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cStat>104</cStat>'
    + `<protNFe versao="4.00"><infProt Id="ID135260000000001"><tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><chNFe>${chave}</chNFe>`
    + '<dhRecbto>2026-11-14T10:00:05-03:00</dhRecbto><nProt>135260000000001</nProt><digVal>ZGlnZXN0LWZpY3RpY2lv</digVal>'
    + '<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>'
    + '</retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>';
}

module.exports = { EMITENTE, xmlVenda, retornoSoapAutorizado, ASSINATURA };
