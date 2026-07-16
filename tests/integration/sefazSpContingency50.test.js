// ============================================================
// S3 — CRITÉRIO DE ACEITE: derrubar a SEFAZ (mock) no meio de 50 vendas
// → ZERO venda travada, 100% retransmitida e reconciliada.
//
// Roteiro: vendas 1–15 com SEFAZ ok · SEFAZ CAI na venda 16 e fica fora
// até a 35 (emissões caem em contingência tpEmis=9 sem travar o caixa) ·
// SEFAZ volta · worker de retransmissão drena a fila e reconcilia
// (1 rejeitada-tardia proposital pra provar a reconciliação de rejeição).
// ============================================================
const crypto = require('crypto');
const forge = require('node-forge');

process.env.CERT_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const sefazSp = require('../../src/services/sefazSp');
const contingency = require('../../src/services/sefazSp/contingency');
const { tickContingency } = require('../../src/jobs/nfceContingencyJob');
const soapClient = require('../../src/services/sefazSp/soapClient');
const { encryptBuffer, encryptString } = require('../../src/utils/secretCrypto');
const { companyDavi } = require('../fixtures/nfceDavi');

jest.setTimeout(60000);

const PFX_PASSWORD = 'senha-a1';
function makeTestPfx() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '07';
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  const attrs = [{ name: 'commonName', value: 'AURA TESTE' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(
    forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PFX_PASSWORD, { algorithm: '3des' })
  ).getBytes(), 'binary');
}
const pfxBuf = makeTestPfx();
const { enc, iv } = encryptBuffer(pfxBuf);

const CONFIG = {
  uf: 'SP', ambiente: 'homologacao', serie_nfce: 1,
  csc_id: '000001', csc_token_enc: encryptString('CSC'), provider: 'sefaz_sp',
};

function soapBody(inner) {
  return {
    status: 200,
    body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
      + inner + '</nfeResultMsg></soap:Body></soap:Envelope>',
  };
}

/** SEFAZ fake com interruptor down/up + 1 rejeição tardia programada. */
class FakeSefaz {
  constructor() { this.down = false; this.authorized = 0; this.rejectChaves = new Set(); }
  transport = async (url, envelope) => {
    if (this.down) throw new Error('ETIMEDOUT (SEFAZ fora do ar)');
    if (url.includes('NFeAutorizacao4')) {
      const chave = envelope.match(/Id="NFe(\d{44})"/)[1];
      if (this.rejectChaves.has(chave)) {
        return soapBody(`<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>104</cStat><protNFe><infProt><chNFe>${chave}</chNFe><cStat>778</cStat><xMotivo>Rejeicao: Informado NCM inexistente</xMotivo></infProt></protNFe></retEnviNFe>`);
      }
      this.authorized++;
      return soapBody(`<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>104</cStat><protNFe><infProt><chNFe>${chave}</chNFe><nProt>135${String(this.authorized).padStart(12, '0')}</nProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe></retEnviNFe>`);
    }
    if (url.includes('NFeConsultaProtocolo4')) {
      return soapBody('<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>217</cStat><xMotivo>Nao consta</xMotivo></retConsSitNFe>');
    }
    throw new Error('serviço não mapeado');
  };
}

// "banco" em memória: emissões + fila + config + certificado
function makeDb() {
  const emissions = new Map();
  const queue = new Map();
  return {
    emissions, queue,
    query: async (sql, params = []) => {
      if (sql.includes('FROM company_certificates')) {
        return { rows: [{ pfx_enc: enc, pfx_iv: iv, password_enc: encryptString(PFX_PASSWORD), not_after: new Date(Date.now() + 365 * 864e5) }] };
      }
      if (sql.includes('FROM nfce_config')) return { rows: [{ ...CONFIG, company_id: params[0] }] };
      if (sql.includes('INSERT INTO nfce_pending_transmission')) {
        queue.set(params[1], { id: 'q-' + params[1], company_id: params[0], emission_id: params[1], status: 'pending', attempts: 0, last_attempt_at: null, deadline_at: new Date(Date.now() + 24 * 3600e3), queued_at: new Date() });
        return { rows: [] };
      }
      if (sql.includes("FROM nfce_pending_transmission q")) {
        const rows = [...queue.values()].filter((q) => q.status === 'pending')
          // emissão primeiro: q por último preserva id/attempts/status DA FILA
          .map((q) => ({ ...emissions.get(q.emission_id), ...q }));
        return { rows };
      }
      if (sql.includes('UPDATE nfce_pending_transmission')) {
        const id = params[0];
        const row = [...queue.values()].find((q) => q.id === id);
        if (row) {
          if (sql.includes("status='transmitted'")) row.status = 'transmitted';
          else if (sql.includes("status='rejected'")) row.status = 'rejected';
          else if (sql.includes("status='expired'")) row.status = 'expired';
          row.attempts++;
          row.last_attempt_at = new Date();
        }
        return { rows: [] };
      }
      if (sql.includes('UPDATE nfce_emissions')) {
        const id = params[params.length - 1];
        const em = emissions.get(id);
        if (em) {
          if (sql.includes("status='autorizada'")) { em.status = 'autorizada'; em.protocolo = params[0]; }
          if (sql.includes("status='rejeitada'")) { em.status = 'rejeitada'; em.rejection_code = params[0]; }
          if (sql.includes("status='erro'")) em.status = 'erro';
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe('S3 — 50 vendas com queda da SEFAZ no meio (critério de aceite)', () => {
  test('zero venda travada · 100% retransmitida e reconciliada', async () => {
    contingency.reset();
    const fake = new FakeSefaz();
    const db = makeDb();
    const resultados = [];

    for (let n = 1; n <= 50; n++) {
      if (n === 16) fake.down = true;   // SEFAZ CAI no meio do expediente
      if (n === 36) fake.down = false;  // e volta (fila ainda pendente)
      // a partir da volta, o detector ainda segura 60s — janela offline.
      // Vendas 36+ continuam em contingência até a janela expirar; isso é
      // comportamento desejado (sonda controlada), então NÃO mexemos no relógio.

      const nfceData = {
        items: [{ name: `Item ${n}`, ncm: '64022000', quantity: 1, price: 10 + n }],
        payments: [{ method: '01', value: 10 + n }],
        total_value: 10 + n, serie: 1, numero: 1000 + n,
      };

      // ZERO travada: emitNfce nunca pode lançar
      const r = await sefazSp.emitNfce(companyDavi, nfceData,
        { db, config: CONFIG, transport: fake.transport, allowContingency: true });
      resultados.push(r);

      // espelha o que a rota faz: persiste emissão + enfileira contingência
      const emissionId = `em-${n}`;
      db.emissions.set(emissionId, {
        id: emissionId, status: r.status === 'autorizado' ? 'autorizada' : 'processando',
        xml_signed: r.xml_signed, numero: 1000 + n, chave_acesso: r.chave_acesso,
        tp_emis: r.tp_emis,
      });
      if (r.status === 'contingencia') {
        await db.query('INSERT INTO nfce_pending_transmission (company_id, emission_id, deadline_at) VALUES ($1,$2,$3)',
          ['c-1', emissionId, null]);
      }
    }

    // 1) ZERO venda travada
    expect(resultados.length).toBe(50);
    const autorizadasNaHora = resultados.filter((r) => r.status === 'autorizado').length;
    const emContingencia = resultados.filter((r) => r.status === 'contingencia').length;
    expect(autorizadasNaHora + emContingencia).toBe(50);
    expect(emContingencia).toBeGreaterThanOrEqual(20); // 16–35 fora + janela do detector
    // todas de contingência têm XML assinado + QR + chave com tpEmis=9
    for (const r of resultados.filter((x) => x.status === 'contingencia')) {
      expect(r.xml_signed).toContain('<tpEmis>9</tpEmis>');
      expect(r.xml_signed).toContain('<dhCont>');
      expect(r.chave_acesso[34]).toBe('9');
      expect(r.qr_code).toMatch(/\|2\|2\|/); // QR v2 contingência
    }

    // 2) programa UMA rejeitada-tardia (NCM "estragou" entre a venda e a retransmissão)
    const pendentes = [...db.queue.values()].filter((q) => q.status === 'pending');
    const sacrificada = db.emissions.get(pendentes[0].emission_id);
    fake.rejectChaves.add(sacrificada.chave_acesso);

    // 3) worker drena a fila (SEFAZ de pé; sem backoff: last_attempt_at=null)
    // soap injetado: autorizar do worker passa pelo transporte FAKE
    const soapFake = {
      autorizar: (args) => soapClient.autorizar({ ...args, transport: fake.transport }),
    };
    let total = { transmitted: 0, rejectedLate: 0, expired: 0 };
    for (let i = 0; i < 10; i++) {
      const s = await tickContingency({ db, soap: soapFake });
      total.transmitted += s.transmitted;
      total.rejectedLate += s.rejectedLate;
      total.expired += s.expired;
      if ([...db.queue.values()].every((q) => q.status !== 'pending')) break;
      // zera o backoff pro teste não esperar relógio
      for (const q of db.queue.values()) q.last_attempt_at = null;
    }

    // 4) 100% retransmitida e reconciliada
    const filaFinal = [...db.queue.values()];
    expect(filaFinal.every((q) => q.status !== 'pending')).toBe(true);
    expect(total.expired).toBe(0);
    expect(total.transmitted).toBe(emContingencia - 1);
    expect(total.rejectedLate).toBe(1);

    // reconciliação: autorizada-tardia vira autorizada; rejeitada-tardia
    // vira rejeitada com rejection_code (alerta de regularização no smartAlerts)
    const ems = [...db.emissions.values()];
    expect(ems.filter((e) => e.status === 'autorizada').length).toBe(50 - 1);
    const rejeitada = ems.find((e) => e.status === 'rejeitada');
    expect(rejeitada.rejection_code).toBe('778');
  });
});
