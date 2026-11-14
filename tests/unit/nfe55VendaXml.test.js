// ============================================================
// NF-e modelo 55 de VENDA — montagem do XML (CP2a, 14/11/2026).
// sefazSp/nfe55Venda.buildInfNfe55Venda contra fixtures de dados FICTÍCIOS
// (CNPJ/CPF/IE de teste válidos por dígito, nada de cliente real).
//
// Casos: mesma UF contribuinte (5102), CPF (não contribuinte), item ST
// (5405), outra UF contribuinte (6102/6404), transporte e frete rateado,
// desconto, homologação, ordem do <ide>/<dest> pelo XSD, recusas do v1.
// ============================================================
'use strict';

const {
  buildInfNfe55Venda, buildIde55VendaXml, buildTransp55VendaXml,
} = require('../../src/services/sefazSp/nfe55Venda');
const { cfopVenda55 } = require('../../src/services/sefazSp/taxEngine');
const { ieSpValida, ieValida, ratearFrete } = require('../../src/services/nfe55Venda');

const EMITENTE = {
  id: '00000000-0000-4000-8000-0000000000e1',
  cnpj: '11222333000181',
  legal_name: 'Loja Exemplo Materiais Ltda',
  trade_name: 'Loja Exemplo',
  address_street: 'Rua das Palmeiras', address_number: '100', address_neighborhood: 'Centro',
  address_city: 'Jacarei', address_state: 'SP', address_zip: '12327000',
  ibge_code: '3524402', inscricao_estadual: '110042490114', phone: '1239510000',
  tax_regime: 'simples_nacional',
};

const ITEM = (o = {}) => ({
  code: 'p1', name: 'Cimento CP II 50kg', ncm: '25232910', unit: 'SC',
  quantity: 10, price: 35.9, csosn: '102', orig: '0', pisCst: '07', cofinsCst: '07', ...o,
});

const DEST_CNPJ_SP = {
  cnpj: '11444777000161', nome: 'Construtora Exemplo Ltda', ie: '110042490114', indIEDest: '1',
  email: 'compras@exemplo.com',
  endereco: {
    logradouro: 'Avenida Central', numero: '200', complemento: 'Sala 3', bairro: 'Jardim Exemplo',
    codigo_municipio: '3549904', municipio: 'Sao Jose dos Campos', uf: 'SP', cep: '12245000',
  },
};
const DEST_CPF_SP = {
  cpf: '39053344705', nome: 'Cliente Teste', indIEDest: '9',
  endereco: {
    logradouro: 'Rua Um', numero: '', bairro: 'Vila Teste',
    codigo_municipio: '3524402', municipio: 'Jacarei', uf: 'SP', cep: '12327000',
  },
};
const DEST_CNPJ_MG = {
  cnpj: '11444777000161', nome: 'Construtora Exemplo Ltda', ie: '0623079040081', indIEDest: '1',
  endereco: {
    logradouro: 'Rua Dois', numero: '50', bairro: 'Centro',
    codigo_municipio: '3106200', municipio: 'Belo Horizonte', uf: 'MG', cep: '30110000',
  },
};

const OPTS = { tpAmb: 1, cNF: '12345678', dhEmi: '2026-11-14T10:00:00-03:00' };

function build(over = {}, opts = {}) {
  return buildInfNfe55Venda(EMITENTE, {
    items: [ITEM()],
    dest: DEST_CNPJ_SP,
    payments: [{ method: '17', value: 359, indPag: 0 }],
    serie: 2, numero: 15,
    ...over,
  }, { ...OPTS, ...opts });
}

const bloco = (xml, t) => {
  const i = xml.indexOf(`<${t}>`);
  const j = xml.indexOf(`</${t}>`);
  return i >= 0 && j >= 0 ? xml.slice(i, j + t.length + 3) : '';
};
const ordem = (xml, tags) => tags.map((t) => xml.indexOf(`<${t}>`));
const crescente = (arr) => arr.every((v, i) => v >= 0 && (i === 0 || v > arr[i - 1]));

describe('NF-e 55 de venda — mesma UF, cliente contribuinte (5102)', () => {
  const r = build();
  const ide = bloco(r.infNfeXml, 'ide');

  it('chave mod 55, série/número do contador, Id = NFe + chave', () => {
    expect(r.chave).toHaveLength(44);
    expect(r.chave.slice(20, 22)).toBe('55');
    expect(r.chave.slice(22, 25)).toBe('002');
    expect(r.chave.slice(25, 34)).toBe('000000015');
    expect(r.chave.slice(35, 43)).toBe('12345678');
    expect(r.infNfeXml.startsWith(`<infNFe Id="NFe${r.chave}" versao="4.00">`)).toBe(true);
  });

  it('ide: tpNF=1, finNFe=1, idDest=1, indFinal=0 (contribuinte), indPres=1, natOp padrão', () => {
    expect(ide).toContain('<mod>55</mod>');
    expect(ide).toContain('<tpNF>1</tpNF>');
    expect(ide).toContain('<finNFe>1</finNFe>');
    expect(ide).toContain('<idDest>1</idDest>');
    expect(ide).toContain('<indFinal>0</indFinal>');
    expect(ide).toContain('<indPres>1</indPres>');
    expect(ide).toContain('<tpImp>1</tpImp>');
    expect(ide).toContain('<natOp>Venda de mercadoria</natOp>');
    expect(ide).not.toContain('<indIntermed>');
    expect(ide).not.toContain('<NFref>');
  });

  it('ide na ordem do XSD (TIde)', () => {
    expect(crescente(ordem(ide, ['cUF', 'cNF', 'natOp', 'mod', 'serie', 'nNF', 'dhEmi', 'tpNF', 'idDest',
      'cMunFG', 'tpImp', 'tpEmis', 'cDV', 'tpAmb', 'finNFe', 'indFinal', 'indPres', 'procEmi', 'verProc']))).toBe(true);
  });

  it('dest: CNPJ, nome, enderDest completo, indIEDest=1 + IE + email, na ordem TDest', () => {
    const dest = bloco(r.infNfeXml, 'dest');
    expect(dest).toContain('<CNPJ>11444777000161</CNPJ>');
    expect(dest).toContain('<xNome>Construtora Exemplo Ltda</xNome>');
    expect(dest).toContain('<xCpl>Sala 3</xCpl>');
    expect(dest).toContain('<cMun>3549904</cMun>');
    expect(dest).toContain('<CEP>12245000</CEP>');
    expect(dest).toContain('<cPais>1058</cPais><xPais>Brasil</xPais>');
    expect(dest).toContain('<indIEDest>1</indIEDest><IE>110042490114</IE><email>compras@exemplo.com</email>');
    expect(crescente(ordem(dest, ['CNPJ', 'xNome', 'enderDest', 'indIEDest', 'IE', 'email']))).toBe(true);
    const ender = bloco(dest, 'enderDest');
    expect(crescente(ordem(ender, ['xLgr', 'nro', 'xCpl', 'xBairro', 'cMun', 'xMun', 'UF', 'CEP', 'cPais', 'xPais']))).toBe(true);
  });

  it('CFOP 5102 e CSOSN 102; sem infNFeSupl/QR; transp sem frete (9); infAdic com o texto do Simples', () => {
    expect(r.infNfeXml).toContain('<CFOP>5102</CFOP>');
    expect(r.infNfeXml).toContain('<CSOSN>102</CSOSN>');
    expect(r.infNfeXml).not.toContain('infNFeSupl');
    expect(r.infNfeXml).toContain('<transp><modFrete>9</modFrete></transp>');
    expect(r.infNfeXml).toContain('optante pelo Simples Nacional');
  });

  it('pag com os pagamentos reais (PIX = 99 + xPag, como a NFC-e)', () => {
    expect(r.infNfeXml).toContain('<pag><detPag><indPag>0</indPag><tPag>99</tPag><xPag>PIX</xPag><vPag>359.00</vPag></detPag></pag>');
  });

  it('ordem do infNFe: ide, emit, dest, det, total, transp, pag, infAdic', () => {
    const pos = ['<ide>', '<emit>', '<dest>', '<det nItem="1">', '<total>', '<transp>', '<pag>', '<infAdic>']
      .map((t) => r.infNfeXml.indexOf(t));
    expect(crescente(pos)).toBe(true);
  });
});

describe('NF-e 55 de venda — CPF (não contribuinte)', () => {
  const r = build({ dest: DEST_CPF_SP });
  const dest = bloco(r.infNfeXml, 'dest');
  it('CPF, indIEDest=9 sem IE, indFinal=1, nro S/N quando vazio, sem email', () => {
    expect(dest).toContain('<CPF>39053344705</CPF>');
    expect(dest).not.toContain('<CNPJ>');
    expect(dest).toContain('<indIEDest>9</indIEDest>');
    expect(dest).not.toContain('<IE>');
    expect(dest).toContain('<nro>S/N</nro>');
    expect(dest).not.toContain('<email>');
    expect(bloco(r.infNfeXml, 'ide')).toContain('<indFinal>1</indFinal>');
  });
});

describe('NF-e 55 de venda — item com ST (5405)', () => {
  it('CSOSN 500 → CFOP 5405 e grupo ICMSSN500; CEST do cadastro', () => {
    const r = build({ items: [ITEM(), ITEM({ code: 'p2', name: 'Tinta', ncm: '32091010', csosn: '500', cest: '2400700', quantity: 1, price: 90 })] });
    const det2 = r.infNfeXml.slice(r.infNfeXml.indexOf('<det nItem="2">'));
    expect(det2).toContain('<CEST>2400700</CEST>');
    expect(det2).toContain('<CFOP>5405</CFOP>');
    expect(det2).toContain('<ICMSSN500><orig>0</orig><CSOSN>500</CSOSN></ICMSSN500>');
    expect(r.infNfeXml.slice(0, r.infNfeXml.indexOf('<det nItem="2">'))).toContain('<CFOP>5102</CFOP>');
  });
});

describe('NF-e 55 de venda — outra UF, cliente contribuinte (6102/6404)', () => {
  const r = build({
    dest: DEST_CNPJ_MG,
    items: [ITEM(), ITEM({ code: 'p2', csosn: '500', quantity: 1, price: 90 })],
  });
  it('idDest=2, CFOP 6102 e 6404, indFinal=0', () => {
    const ide = bloco(r.infNfeXml, 'ide');
    expect(ide).toContain('<idDest>2</idDest>');
    expect(ide).toContain('<indFinal>0</indFinal>');
    expect(r.infNfeXml).toContain('<CFOP>6102</CFOP>');
    expect(r.infNfeXml).toContain('<CFOP>6404</CFOP>');
    expect(r.infNfeXml).not.toContain('<CFOP>5102</CFOP>');
    expect(bloco(r.infNfeXml, 'dest')).toContain('<UF>MG</UF>');
  });
  it('isento (indIEDest=2) em outra UF não é DIFAL do v1: sai 6102 sem IE', () => {
    const r2 = build({ dest: { ...DEST_CNPJ_MG, ie: null, indIEDest: '2' } });
    expect(bloco(r2.infNfeXml, 'dest')).toContain('<indIEDest>2</indIEDest>');
    expect(bloco(r2.infNfeXml, 'dest')).not.toContain('<IE>');
    expect(r2.infNfeXml).toContain('<CFOP>6102</CFOP>');
  });
});

describe('NF-e 55 de venda — transporte e frete', () => {
  const r = build({
    items: [ITEM({ freight: 12.5, discount: 5 }), ITEM({ code: 'p2', quantity: 2, price: 120, freight: 7.5 })],
    payments: [{ method: '01', value: 614, indPag: 0 }],
    frete: { modalidade: '0', transportadora: { documento: '11444777000161', nome: 'Transportes Exemplo', ie: '110042490114', endereco: 'Rua Tres, 1', municipio: 'Jacarei', uf: 'sp' } },
  });
  it('vFrete no item (entre vUnTrib e vDesc) e no ICMSTot; vNF = vProd - vDesc + vFrete', () => {
    const prod1 = bloco(r.infNfeXml, 'prod');
    expect(prod1).toContain('<vUnTrib>35.90</vUnTrib><vFrete>12.50</vFrete><vDesc>5.00</vDesc><indTot>1</indTot>');
    const tot = bloco(r.infNfeXml, 'ICMSTot');
    expect(tot).toContain('<vProd>599.00</vProd>');
    expect(tot).toContain('<vFrete>20.00</vFrete>');
    expect(tot).toContain('<vDesc>5.00</vDesc>');
    expect(tot).toContain('<vNF>614.00</vNF>');
    expect(r.vNF).toBe(614);
  });
  it('transp: modFrete 0 + transportadora na ordem do XSD', () => {
    expect(r.infNfeXml).toContain('<transp><modFrete>0</modFrete><transporta><CNPJ>11444777000161</CNPJ>'
      + '<xNome>Transportes Exemplo</xNome><IE>110042490114</IE><xEnder>Rua Tres, 1</xEnder>'
      + '<xMun>Jacarei</xMun><UF>SP</UF></transporta></transp>');
  });
  it('modFrete inválido derruba a montagem (a rota valida antes)', () => {
    expect(() => buildTransp55VendaXml({ modalidade: '7' })).toThrow(/modFrete/);
  });
});

describe('NF-e 55 de venda — desconto rateado nos itens', () => {
  it('vDesc de cada item soma no ICMSTot e o pagamento fecha no vNF', () => {
    const r = build({
      items: [ITEM({ quantity: 1, price: 100, discount: 10 }), ITEM({ code: 'p2', quantity: 2, price: 25, discount: 5 })],
      payments: [{ method: '04', value: 135, indPag: 0 }],
    });
    expect(r.infNfeXml).toContain('<vDesc>10.00</vDesc>');
    expect(r.infNfeXml).toContain('<vDesc>5.00</vDesc>');
    const tot = bloco(r.infNfeXml, 'ICMSTot');
    expect(tot).toContain('<vDesc>15.00</vDesc>');
    expect(tot).toContain('<vNF>135.00</vNF>');
    expect(r.infNfeXml).toContain('<tPag>04</tPag><vPag>135.00</vPag><card><tpIntegra>2</tpIntegra></card>');
  });
});

describe('NF-e 55 de venda — homologação', () => {
  it('xNome do dest = literal da SEFAZ e tpAmb=2 (IBS/CBS entra, como na NFC-e)', () => {
    const r = build({}, { tpAmb: 2 });
    expect(bloco(r.infNfeXml, 'dest')).toContain('<xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>');
    expect(bloco(r.infNfeXml, 'ide')).toContain('<tpAmb>2</tpAmb>');
    expect(r.infNfeXml).toContain('<IBSCBS>');
  });
});

describe('NF-e 55 de venda — opções e recusas do v1', () => {
  it('natOp e indPres com override; não presencial leva indIntermed=0 depois de indPres', () => {
    const r = build({ natureza_operacao: 'Venda de mercadoria adquirida de terceiros', indPres: '2' });
    const ide = bloco(r.infNfeXml, 'ide');
    expect(ide).toContain('<natOp>Venda de mercadoria adquirida de terceiros</natOp>');
    expect(ide).toContain('<indPres>2</indPres><indIntermed>0</indIntermed><procEmi>0</procEmi>');
  });
  it('MEI sai com CRT 4 e o texto do SIMEI', () => {
    const r = buildInfNfe55Venda({ ...EMITENTE, tax_regime: 'mei' }, {
      items: [ITEM()], dest: DEST_CNPJ_SP, payments: [{ method: '01', value: 359 }], serie: 2, numero: 1,
    }, OPTS);
    expect(r.infNfeXml).toContain('<CRT>4</CRT>');
    expect(r.infNfeXml).toContain('SIMEI');
  });
  it('regime normal, DIFAL e exterior não montam', () => {
    expect(() => buildInfNfe55Venda({ ...EMITENTE, tax_regime: 'lucro_presumido' }, {
      items: [ITEM()], dest: DEST_CNPJ_SP, payments: [], serie: 2, numero: 1,
    }, OPTS)).toThrow(/regime normal/);
    expect(() => build({ dest: { ...DEST_CPF_SP, endereco: { ...DEST_CNPJ_MG.endereco } } })).toThrow(/DIFAL/);
    expect(() => build({ dest: { ...DEST_CNPJ_SP, endereco: { ...DEST_CNPJ_SP.endereco, uf: 'EX' } } })).toThrow(/exterior/);
  });
  it('contribuinte sem IE não monta', () => {
    expect(() => build({ dest: { ...DEST_CNPJ_SP, ie: null } })).toThrow(/IE/);
  });
  it('buildIde55VendaXml é puro (sem relógio)', () => {
    const a = buildIde55VendaXml({ cUF: '35', cNF: '1', natOp: 'x', serie: '2', nNF: '1', dhEmi: 'd', idDest: '1', cMunFG: '1', cDV: '0', tpAmb: '2', indFinal: '1', indPres: '1' });
    expect(a).toBe(buildIde55VendaXml({ cUF: '35', cNF: '1', natOp: 'x', serie: '2', nNF: '1', dhEmi: 'd', idDest: '1', cMunFG: '1', cDV: '0', tpAmb: '2', indFinal: '1', indPres: '1' }));
  });
});

describe('regras auxiliares', () => {
  it('cfopVenda55: 5102/5405 na UF, 6102/6404 fora', () => {
    expect(cfopVenda55('102')).toBe('5102');
    expect(cfopVenda55('103')).toBe('5102');
    expect(cfopVenda55('500')).toBe('5405');
    expect(cfopVenda55('102', { interestadual: true })).toBe('6102');
    expect(cfopVenda55('500', { interestadual: true })).toBe('6404');
  });
  it('IE de SP confere os dois dígitos; outras UFs só o formato do XSD', () => {
    expect(ieSpValida('110042490114')).toBe(true);
    expect(ieSpValida('110042490115')).toBe(false);
    expect(ieSpValida('110042491114')).toBe(false);
    expect(ieValida('110.042.490.114', 'SP')).toBe(true);
    expect(ieValida('1', 'MG')).toBe(false);
    expect(ieValida('0623079040081', 'MG')).toBe(true);
  });
  it('ratearFrete: proporcional, maior resto, soma exata, sem teto por linha', () => {
    expect(ratearFrete([1000, 1000, 1000], 100)).toEqual([34, 33, 33]);
    expect(ratearFrete([100], 5000)).toEqual([5000]);
    expect(ratearFrete([0, 0], 10)).toEqual([0, 0]);
    const p = ratearFrete([3333, 2147, 999], 777);
    expect(p.reduce((s, v) => s + v, 0)).toBe(777);
  });
});
