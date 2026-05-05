// Smoke test: gera o body NFC-e do nosso service e valida contra o schema
// oficial Nuvem Fiscal. Sem rede — só monta o payload e checa estrutura.
//
// Rodar: node __tests__/nuvemfiscal_payload.test.js

process.env.NUVEM_FISCAL_URL = 'https://api.sandbox.nuvemfiscal.com.br';
process.env.NUVEM_FISCAL_CLIENT_ID = 'fake_id';
process.env.NUVEM_FISCAL_CLIENT_SECRET = 'fake_secret';

let capturedBody = null;
let capturedPath = null;
global.fetch = async (url, opts) => {
  if (url.includes('/oauth/token')) {
    return { ok: true, json: async () => ({ access_token: 'fake_token', expires_in: 3600 }) };
  }
  capturedPath = url;
  capturedBody = JSON.parse(opts.body);
  return { ok: true, json: async () => ({ id: 'nfce_fake_001', status: 'autorizado',
    chave_acesso: '35260512345678901234650010000000011000000011',
    protocolo: '135260000000001',
    link_pdf: 'https://danfe.nuvemfiscal.com.br/fake.pdf',
    link_xml: 'https://xml.nuvemfiscal.com.br/fake.xml',
  }) };
};

const nf = require('../src/services/nuvemfiscal');

const company = {
  cnpj: '12345678000199',
  legal_name: 'Aura Pilot LTDA',
  trade_name: 'Aura Odonto',
  address_street: 'Rua das Flores',
  address_number: '100',
  address_neighborhood: 'Centro',
  address_city: 'São Paulo',
  address_state: 'SP',
  address_zip: '01310100',
  ibge_code: '3550308',
  inscricao_estadual: '110042490114',
  inscricao_municipal: '12345',
  email: 'fiscal@aura.test',
  phone: '11999998888',
  tax_regime: 'simples',
};

const nfceData = {
  serie: 1,
  numero: 42,
  reference: 'nfce-test-001',
  items: [
    { code: 'SKU001', name: 'Limpeza dental', quantity: 1, price: 150.00, ncm: '00000000', cfop: '5102' },
    { code: 'SKU002', name: 'Aplicação de flúor', quantity: 2, price: 45.00 },
  ],
  total_value: 240.00,
  payment_method: '17',
  recipient_cpf: '12345678901',
  recipient_name: 'Cliente Teste',
};

(async () => {
  console.log('▶ Chamando emitNfce com mock company + 2 items + Pix...');
  await nf.emitNfce(company, nfceData);
  console.log('✔ Endpoint chamado:', capturedPath);

  const checks = [
    ['endpoint = /nfce',                                capturedPath.endsWith('/nfce')],
    ['top.ambiente = "homologacao"',                    capturedBody.ambiente === 'homologacao'],
    ['top.referencia preenchido',                       !!capturedBody.referencia],
    ['top.infNFe presente',                             !!capturedBody.infNFe],
    ['infNFe.versao = "4.00"',                          capturedBody.infNFe.versao === '4.00'],
    ['ide.cUF = 35 (SP)',                               capturedBody.infNFe.ide.cUF === 35],
    ['ide.mod = 65 (NFC-e)',                            capturedBody.infNFe.ide.mod === 65],
    ['ide.serie = 1',                                   capturedBody.infNFe.ide.serie === 1],
    ['ide.nNF = 42',                                    capturedBody.infNFe.ide.nNF === 42],
    ['ide.tpNF = 1 (saída)',                            capturedBody.infNFe.ide.tpNF === 1],
    ['ide.idDest = 1',                                  capturedBody.infNFe.ide.idDest === 1],
    ['ide.cMunFG = 3550308',                            capturedBody.infNFe.ide.cMunFG === '3550308'],
    ['ide.tpImp = 4 (DANFE NFC-e)',                     capturedBody.infNFe.ide.tpImp === 4],
    ['ide.tpEmis = 1 (normal)',                         capturedBody.infNFe.ide.tpEmis === 1],
    ['ide.tpAmb = 2 (homologação)',                     capturedBody.infNFe.ide.tpAmb === 2],
    ['ide.indFinal = 1 (consumidor final)',             capturedBody.infNFe.ide.indFinal === 1],
    ['ide.indPres = 1 (presencial)',                    capturedBody.infNFe.ide.indPres === 1],
    ['ide.dhEmi é ISO datetime',                        /\d{4}-\d{2}-\d{2}T/.test(capturedBody.infNFe.ide.dhEmi)],
    ['emit.CNPJ só dígitos',                            /^\d{14}$/.test(capturedBody.infNFe.emit.CNPJ)],
    ['emit.xNome preenchido',                           !!capturedBody.infNFe.emit.xNome],
    ['emit.CRT = 1 (Simples Nacional)',                 capturedBody.infNFe.emit.CRT === 1],
    ['emit.enderEmit.UF = "SP"',                        capturedBody.infNFe.emit.enderEmit.UF === 'SP'],
    ['emit.enderEmit.CEP só dígitos',                   /^\d{8}$/.test(capturedBody.infNFe.emit.enderEmit.CEP)],
    ['emit.enderEmit.cPais = "1058"',                   capturedBody.infNFe.emit.enderEmit.cPais === '1058'],
    ['dest existe (CPF informado)',                     !!capturedBody.infNFe.dest],
    ['dest.CPF só dígitos',                             /^\d{11}$/.test(capturedBody.infNFe.dest.CPF)],
    ['dest.indIEDest = 9',                              capturedBody.infNFe.dest.indIEDest === 9],
    ['det.length = 2',                                  capturedBody.infNFe.det.length === 2],
    ['det[0].nItem = 1',                                capturedBody.infNFe.det[0].nItem === 1],
    ['det[0].prod.cProd preenchido',                    !!capturedBody.infNFe.det[0].prod.cProd],
    ['det[0].prod.NCM = "00000000"',                    capturedBody.infNFe.det[0].prod.NCM === '00000000'],
    ['det[0].prod.CFOP = "5102"',                       capturedBody.infNFe.det[0].prod.CFOP === '5102'],
    ['det[0].prod.uCom = "UN"',                         capturedBody.infNFe.det[0].prod.uCom === 'UN'],
    ['det[0].prod.qCom = 1',                            capturedBody.infNFe.det[0].prod.qCom === 1],
    ['det[0].prod.vUnCom = 150',                        capturedBody.infNFe.det[0].prod.vUnCom === 150],
    ['det[0].prod.vProd = 150',                         capturedBody.infNFe.det[0].prod.vProd === 150],
    ['det[0].prod.indTot = 1',                          capturedBody.infNFe.det[0].prod.indTot === 1],
    ['det[0].imposto.ICMS.ICMSSN102.CSOSN = "102"',     capturedBody.infNFe.det[0].imposto.ICMS.ICMSSN102?.CSOSN === '102'],
    ['det[0].imposto.PIS.PISNT.CST = "07"',             capturedBody.infNFe.det[0].imposto.PIS.PISNT?.CST === '07'],
    ['det[0].imposto.COFINS.COFINSNT.CST = "07"',       capturedBody.infNFe.det[0].imposto.COFINS.COFINSNT?.CST === '07'],
    ['det[1].prod.qCom = 2',                            capturedBody.infNFe.det[1].prod.qCom === 2],
    ['det[1].prod.vProd = 90 (2 * 45)',                 capturedBody.infNFe.det[1].prod.vProd === 90],
    ['total.ICMSTot.vProd = 240',                       capturedBody.infNFe.total.ICMSTot.vProd === 240],
    ['total.ICMSTot.vNF = 240',                         capturedBody.infNFe.total.ICMSTot.vNF === 240],
    ['total.ICMSTot.vICMS = 0 (Simples)',               capturedBody.infNFe.total.ICMSTot.vICMS === 0],
    ['transp.modFrete = 9',                             capturedBody.infNFe.transp.modFrete === 9],
    ['pag.detPag[0].tPag = "17" (Pix)',                 capturedBody.infNFe.pag.detPag[0].tPag === '17'],
    ['pag.detPag[0].vPag = 240',                        capturedBody.infNFe.pag.detPag[0].vPag === 240],
    ['pag.vTroco = 0',                                  capturedBody.infNFe.pag.vTroco === 0],
  ];

  let pass = 0, fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? '  ✔ ' : '  ✘ ') + name);
    ok ? pass++ : fail++;
  }
  console.log(`\nResultado: ${pass} passaram / ${fail} falharam`);

  // Sanity 2: NFC-e sem dest (consumidor não identificado)
  capturedBody = null;
  await nf.emitNfce(company, { ...nfceData, recipient_cpf: undefined, recipient_name: undefined });
  if (capturedBody.infNFe.dest !== undefined) { console.log('✘ dest deveria estar omitido'); process.exit(1); }
  console.log('✔ NFC-e sem CPF: dest omitido');

  // Sanity 3: NF-e sem destinatário deve falhar
  try {
    await nf.emitNfe(company, { ...nfceData, recipient_cpf: undefined, recipient_cnpj: undefined });
    console.log('✘ NF-e sem dest deveria ter lançado erro'); process.exit(1);
  } catch (e) {
    if (!/CPF ou CNPJ/.test(e.message)) { console.log('✘ erro inesperado:', e.message); process.exit(1); }
    console.log('✔ NF-e sem dest → erro correto');
  }

  if (fail > 0) process.exit(1);
  console.log('\n✅ Todos os testes passaram');
})().catch(e => { console.error('✘ Falha:', e); process.exit(1); });
