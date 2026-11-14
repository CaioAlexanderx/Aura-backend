// ============================================================
// NF-e 55 de VENDA contra o XSD oficial (leiauteNFe_v4.00, PL_010c) —
// mesmo mecanismo de xsdValidationNfe55.test.js (devolução): xmllint.
// A lição da devolução (05/08/2026, Rejeição 225 por elemento fora de
// ordem) é que a 55 nunca deve ir à SEFAZ sem este crivo.
// Pula com aviso se schemas/ ou xmllint não estiverem disponíveis.
// Dados fictícios (CNPJ/CPF/IE de teste).
// ============================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const forge = require('node-forge');

const SCHEMAS_DIR = path.join(__dirname, '../../schemas/PL_010c_NT2022_002v1.30');
const NFE_XSD = path.join(SCHEMAS_DIR, 'nfe_v4.00.xsd');

function hasXmllint() {
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const available = fs.existsSync(NFE_XSD) && hasXmllint();
const d = available ? describe : describe.skip;
if (!available) {
  console.warn('[xsdValidationNfe55Venda] PULADO — schemas/PL_010c ou xmllint ausentes');
}

d('Validação XSD oficial — NF-e 55 de venda (engine própria)', () => {
  const { buildInfNfe55Venda } = require('../../src/services/sefazSp/nfe55Venda');
  const { composeNfe } = require('../../src/services/sefazSp/xmlBuilder');
  const { signInfNfe } = require('../../src/services/sefazSp/signer');

  const EMITENTE = {
    id: 'e1', cnpj: '11222333000181', legal_name: 'Loja Exemplo Materiais Ltda', trade_name: 'Loja Exemplo',
    address_street: 'Rua das Palmeiras', address_number: '100', address_neighborhood: 'Centro',
    address_city: 'Jacarei', address_state: 'SP', address_zip: '12327000',
    ibge_code: '3524402', inscricao_estadual: '110042490114', phone: '1239510000',
    tax_regime: 'simples_nacional',
  };
  const ITEM = (o = {}) => ({
    code: 'p1', name: 'Cimento CP II 50kg', ncm: '25232910', unit: 'SC',
    quantity: 10, price: 35.9, csosn: '102', orig: '0', pisCst: '07', cofinsCst: '07', ...o,
  });
  const END_SP = {
    logradouro: 'Avenida Central', numero: '200', complemento: 'Sala 3', bairro: 'Jardim Exemplo',
    codigo_municipio: '3549904', municipio: 'Sao Jose dos Campos', uf: 'SP', cep: '12245000', fone: '12999990000',
  };

  let cert;
  beforeAll(() => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const c = forge.pki.createCertificate();
    c.publicKey = keys.publicKey; c.serialNumber = '07';
    c.validity.notBefore = new Date(Date.now() - 864e5);
    c.validity.notAfter = new Date(Date.now() + 365 * 864e5);
    const attrs = [{ name: 'commonName', value: 'TESTE' }];
    c.setSubject(attrs); c.setIssuer(attrs);
    c.sign(keys.privateKey, forge.md.sha256.create());
    cert = {
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
      certDerBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()),
    };
  });

  function validate(nfeXml) {
    const tmp = path.join(os.tmpdir(), `nfe55venda-xsd-${crypto.randomBytes(6).toString('hex')}.xml`);
    fs.writeFileSync(tmp, '<?xml version="1.0" encoding="UTF-8"?>' + nfeXml);
    try {
      execFileSync('xmllint', ['--noout', '--schema', NFE_XSD, tmp], { stdio: 'pipe' });
      return { valid: true, errors: '' };
    } catch (e) {
      return { valid: false, errors: String(e.stderr || e.message) };
    } finally {
      fs.unlinkSync(tmp);
    }
  }

  function nfe(data, opts = {}) {
    const built = buildInfNfe55Venda(EMITENTE, { serie: 2, numero: 15, ...data }, {
      tpAmb: 2, cNF: '12345678', dhEmi: '2026-11-14T10:00:00-03:00', ...opts,
    });
    const { signatureXml } = signInfNfe(built.infNfeXml, cert);
    return composeNfe({ signedInfNfeXml: built.infNfeXml, infNfeSuplXml: '', signatureXml });
  }

  test('mesma UF, CNPJ contribuinte, 2 itens (102 + ST 500 com CEST), PIX + crediário', () => {
    const r = validate(nfe({
      items: [ITEM(), ITEM({ code: 'p2', name: 'Tinta', ncm: '32091010', csosn: '500', cest: '2400700', quantity: 1, price: 90 })],
      dest: { cnpj: '11444777000161', nome: 'Construtora Exemplo', ie: '110042490114', indIEDest: '1', email: 'compras@exemplo.com', endereco: END_SP },
      payments: [{ method: '17', value: 249, indPag: 0 }, { method: '05', value: 200, indPag: 1 }],
      observacoes: 'Pedido 123',
    }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });

  test('CPF não contribuinte, produção (sem IBS/CBS), sem número no endereço', () => {
    const r = validate(nfe({
      items: [ITEM()],
      dest: { cpf: '39053344705', nome: 'Cliente Teste', indIEDest: '9', endereco: { ...END_SP, numero: '', complemento: '' } },
      payments: [{ method: '01', value: 359 }],
    }, { tpAmb: 1 }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });

  test('outra UF, contribuinte, frete rateado + transportadora + desconto, não presencial', () => {
    const r = validate(nfe({
      items: [ITEM({ freight: 12.5, discount: 5 }), ITEM({ code: 'p2', csosn: '500', quantity: 2, price: 120, freight: 7.5 })],
      dest: {
        cnpj: '11444777000161', nome: 'Construtora Exemplo', ie: '0623079040081', indIEDest: '1',
        endereco: { logradouro: 'Rua Dois', numero: '50', bairro: 'Centro', codigo_municipio: '3106200', municipio: 'Belo Horizonte', uf: 'MG', cep: '30110000' },
      },
      payments: [{ method: '15', value: 614, indPag: 1 }],
      frete: { modalidade: '0', transportadora: { documento: '11444777000161', nome: 'Transportes Exemplo', ie: 'ISENTO', endereco: 'Rua Tres, 1', municipio: 'Jacarei', uf: 'SP' } },
      indPres: '2',
    }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });
});
