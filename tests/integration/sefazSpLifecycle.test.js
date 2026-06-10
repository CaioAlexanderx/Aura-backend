// ============================================================
// S2.5 — Integração com mock SOAP: ciclo de vida completo da NFC-e
// própria SEM depender da SEFAZ de pé (critério de aceite da Sessão 2):
//   emitir → consultar → cancelar → consultar(cancelada) → inutilizar
// + 10 rejeições simuladas com mensagem amigável correta.
// ============================================================
const crypto = require('crypto');
const forge = require('node-forge');

process.env.CERT_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const sefazSp = require('../../src/services/sefazSp');
const rejectionCatalog = require('../../src/services/sefazSp/rejectionCatalog');
const { encryptBuffer, encryptString } = require('../../src/utils/secretCrypto');
const { companyDavi, nfceDataVendaTipica } = require('../fixtures/nfceDavi');

const PFX_PASSWORD = 'senha-a1';

function makeTestPfx() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '04';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'AURA TESTE' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(
    forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PFX_PASSWORD, { algorithm: '3des' })
  ).getBytes(), 'binary');
}

const pfxBuf = makeTestPfx();
const { enc, iv } = encryptBuffer(pfxBuf);

function fakeDb() {
  return {
    query: async (sql) => {
      if (sql.includes('FROM company_certificates')) {
        return { rows: [{ pfx_enc: enc, pfx_iv: iv, password_enc: encryptString(PFX_PASSWORD), not_after: new Date(Date.now() + 365 * 86400e3) }] };
      }
      return { rows: [] };
    },
  };
}

const CONFIG = {
  uf: 'SP', ambiente: 'homologacao', serie_nfce: 1,
  csc_id: '000001', csc_token_enc: encryptString('CSC-TOKEN'), provider: 'sefaz_sp',
};

/** SEFAZ-SP fake e stateful: autoriza, cancela, inutiliza, consulta. */
class FakeSefaz {
  constructor() {
    this.notas = new Map(); // chave → { status: 'autorizada'|'cancelada', protocolo }
    this.inutilizadas = [];
    this.proximaRejeicao = null; // { cStat, xMotivo } p/ próxima autorização
  }

  soap(inner) {
    return {
      status: 200,
      body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
        + inner + '</nfeResultMsg></soap:Body></soap:Envelope>',
    };
  }

  transport = async (url, envelope) => {
    if (url.includes('NFeAutorizacao4')) {
      const chave = envelope.match(/Id="NFe(\d{44})"/)[1];
      if (this.proximaRejeicao) {
        const { cStat, xMotivo } = this.proximaRejeicao;
        this.proximaRejeicao = null;
        return this.soap(`<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo></infProt></protNFe></retEnviNFe>`);
      }
      const protocolo = '1352600000' + String(this.notas.size + 1).padStart(5, '0');
      this.notas.set(chave, { status: 'autorizada', protocolo });
      return this.soap(`<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><nProt>${protocolo}</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><dhRecbto>2026-06-10T10:00:00-03:00</dhRecbto></infProt></protNFe></retEnviNFe>`);
    }
    if (url.includes('NFeConsultaProtocolo4')) {
      const chave = envelope.match(/<chNFe>(\d{44})<\/chNFe>/)[1];
      const nota = this.notas.get(chave);
      if (!nota) return this.soap('<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>217</cStat><xMotivo>NF-e nao consta na base</xMotivo></retConsSitNFe>');
      const cStat = nota.status === 'cancelada' ? '101' : '100';
      return this.soap(`<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>${cStat}</cStat><xMotivo>ok</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><nProt>${nota.protocolo}</nProt><cStat>${cStat}</cStat></infProt></protNFe></retConsSitNFe>`);
    }
    if (url.includes('NFeRecepcaoEvento4')) {
      const chave = envelope.match(/<chNFe>(\d{44})<\/chNFe>/)[1];
      const nota = this.notas.get(chave);
      if (!nota) return this.soap('<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>128</cStat><retEvento><infEvento><cStat>494</cStat><xMotivo>Chave de Acesso inexistente</xMotivo></infEvento></retEvento></retEnvEvento>');
      if (nota.status === 'cancelada') return this.soap('<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>128</cStat><retEvento><infEvento><cStat>573</cStat><xMotivo>Duplicidade de Evento</xMotivo></infEvento></retEvento></retEnvEvento>');
      nota.status = 'cancelada';
      return this.soap(`<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>128</cStat><retEvento><infEvento><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${chave}</chNFe><nProt>EVT${nota.protocolo}</nProt></infEvento></retEvento></retEnvEvento>`);
    }
    if (url.includes('NFeInutilizacao4')) {
      const ini = envelope.match(/<nNFIni>(\d+)<\/nNFIni>/)[1];
      const fin = envelope.match(/<nNFFin>(\d+)<\/nNFFin>/)[1];
      this.inutilizadas.push([Number(ini), Number(fin)]);
      return this.soap('<retInutNFe xmlns="http://www.portalfiscal.inf.br/nfe"><infInut><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo><nProt>INUT001</nProt></infInut></retInutNFe>');
    }
    throw new Error('serviço não mapeado: ' + url);
  };
}

describe('S2.5 — ciclo de vida completo (mock SOAP, sem SEFAZ de pé)', () => {
  const fake = new FakeSefaz();
  const db = fakeDb();
  const ctx = { db, config: CONFIG, transport: fake.transport };
  let emissao;

  test('1. emitir: autorizada com protocolo', async () => {
    emissao = await sefazSp.emitNfce(companyDavi, nfceDataVendaTipica, ctx);
    expect(emissao.status).toBe('autorizado');
    expect(emissao.protocolo).toMatch(/^1352600000/);
  });

  test('2. consultar: 100 (autorizada)', async () => {
    const r = await sefazSp.queryNfce({
      chave: emissao.chave_acesso, config: CONFIG, db, companyId: 'c-1', transport: fake.transport,
    });
    expect(r.status).toBe('autorizado');
    expect(r.protocolo).toBe(emissao.protocolo);
  });

  test('3. cancelar: evento 135 vinculado', async () => {
    const r = await sefazSp.cancelNfce({
      db, config: CONFIG, companyId: 'c-1',
      chave: emissao.chave_acesso, protocolo: emissao.protocolo,
      justificativa: 'Cancelamento de teste do ciclo de homologacao',
      transport: fake.transport,
    });
    expect(r.sucesso).toBe(true);
    expect(r.cStat).toBe('135');
  });

  test('4. cancelar de novo: 573 idempotente', async () => {
    const r = await sefazSp.cancelNfce({
      db, config: CONFIG, companyId: 'c-1',
      chave: emissao.chave_acesso, protocolo: emissao.protocolo,
      justificativa: 'Cancelamento de teste do ciclo de homologacao',
      transport: fake.transport,
    });
    expect(r.sucesso).toBe(true);
    expect(r.jaCancelada).toBe(true);
  });

  test('5. consultar pós-cancelamento: 101', async () => {
    const r = await sefazSp.queryNfce({
      chave: emissao.chave_acesso, config: CONFIG, db, companyId: 'c-1', transport: fake.transport,
    });
    expect(r.codigo_status).toBe('101');
    expect(r.status).not.toBe('autorizado');
  });

  test('6. inutilizar a faixa abandonada: 102', async () => {
    const r = await sefazSp.inutilizarFaixa({
      db, config: CONFIG, companyId: 'c-1', cnpj: companyDavi.cnpj,
      serie: 1, nIni: 232, nFin: 235,
      justificativa: 'Numeros reservados e nao utilizados em teste',
      transport: fake.transport,
    });
    expect(r.sucesso).toBe(true);
    expect(fake.inutilizadas).toContainEqual([232, 235]);
  });
});

describe('S2.5 — 10 rejeições simuladas → mensagem amigável correta', () => {
  const rejeicoes = [
    ['778', 'Rejeicao: Informado NCM inexistente', /NCM/],
    ['391', 'Rejeicao: Nao informados os dados do cartao', /cart[ãa]o/i],
    ['442', 'Rejeicao: Descricao do pagamento nao permitida', /pagamento/i],
    ['204', 'Rejeicao: Duplicidade de NF-e', /duplicada/i],
    ['539', 'Rejeicao: Duplicidade com diferenca na chave', /duplicada/i],
    ['215', 'Rejeicao: Falha no schema XML', /t[ée]cnico/i],
    ['280', 'Rejeicao: Certificado transmissor invalido', /certificado/i],
    ['704', 'Rejeicao: data de emissao posterior', /futuro/i],
    ['786', 'Rejeicao: CPF do destinatario invalido', /CPF/],
    ['865', 'Rejeicao: total da nota difere do somatorio', /soma|total/i],
  ];

  test.each(rejeicoes)('cStat %s: rejeitado + catálogo com título certo', async (cStat, xMotivo, regex) => {
    const fake = new FakeSefaz();
    fake.proximaRejeicao = { cStat, xMotivo };
    const r = await sefazSp.emitNfce(companyDavi, nfceDataVendaTipica,
      { db: fakeDb(), config: CONFIG, transport: fake.transport });
    expect(r.status).toBe('rejeitado');
    expect(r.codigo_status).toBe(cStat);
    const amigavel = rejectionCatalog.lookup(r.codigo_status, r.motivo_status);
    expect(amigavel.conhecida).toBe(true);
    expect(amigavel.titulo).toMatch(regex);
  });
});
