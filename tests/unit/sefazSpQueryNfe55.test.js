// ============================================================
// 14/11/2026 (NF-e 55 de venda): sefazSp.queryNfce consulta a chave 55 no
// host da NF-e. A nota 55 'processando' passa pelo job de retry
// (jobs/nfceRefreshJob) e pelo "Atualizar" da lista, que chamam queryNfce;
// antes ela iria para o serviço da NFC-e (nfce.fazenda...) e a resposta de
// recusa viraria 'rejeitada' por engano. Chave 65: mesmo host de sempre.
// ============================================================
'use strict';

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(async () => ({ pfx: null, password: null })),
}));

const sefazSp = require('../../src/services/sefazSp');

const CONFIG = { uf: 'SP', ambiente: 'homologacao' };
const CHAVE_55 = '35261111222333000181550020000000151123456786';
const CHAVE_65 = '35261111222333000181650020000000151123456780';

function retConsSit(cStat, xMotivo, chave) {
  return {
    status: 200,
    body: '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
      + `<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>`
      + (cStat === '100' ? `<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><nProt>135260000000077</nProt><cStat>100</cStat></infProt></protNFe>` : '')
      + '</retConsSitNFe></nfeResultMsg></soap:Body></soap:Envelope>',
  };
}

describe('queryNfce escolhe o host pelo modelo da chave', () => {
  it('chave 55 → nfeconsultaprotocolo4 da NF-e (homologação SP)', async () => {
    const urls = [];
    const transport = async (url) => { urls.push(url); return retConsSit('100', 'Autorizado o uso da NF-e', CHAVE_55); };
    const r = await sefazSp.queryNfce({ chave: CHAVE_55, config: CONFIG, db: {}, companyId: 'c1', transport });
    expect(urls).toEqual(['https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx']);
    expect(r).toMatchObject({ status: 'autorizado', protocolo: '135260000000077' });
  });

  it('chave 55 não consta (217) → segue processando', async () => {
    const transport = async () => retConsSit('217', 'NF-e nao consta na base de dados da SEFAZ');
    const r = await sefazSp.queryNfce({ chave: CHAVE_55, config: CONFIG, db: {}, companyId: 'c1', transport });
    expect(r.status).toBe('processando');
  });

  it('chave 65 → host da NFC-e, como sempre', async () => {
    const urls = [];
    const transport = async (url) => { urls.push(url); return retConsSit('217', 'nao consta'); };
    await sefazSp.queryNfce({ chave: CHAVE_65, config: CONFIG, db: {}, companyId: 'c1', transport });
    expect(urls[0]).toContain('nfce.fazenda.sp.gov.br');
    expect(urls[0]).not.toContain('//homologacao.nfe.fazenda');
  });
});
