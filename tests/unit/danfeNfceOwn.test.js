const { buildDanfeNfceHtml, QR_OPTS } = require('../../src/utils/buildDanfeNfceHtml');
const { qrInlineSvg } = require('../../src/utils/qrInline');

const company = {
  cnpj: '11222333000181', legal_name: 'Davi Calcados Ltda', trade_name: 'Davi Calçados',
  inscricao_estadual: '111222333444', address_street: 'Rua XV', address_number: '123',
  address_district: 'Centro', address_city: 'Jacareí', address_state: 'SP', address_zip: '12327-000',
};

function emission(over = {}) {
  return {
    numero: 231, serie: 1,
    chave_acesso: '35260611222333000181650010000002311123456786',
    protocolo: '135260000000099',
    status: 'autorizada',
    items: [{ product_name: 'Azaleia Rasteirinha', quantity: 1, unit_price: 89.99 }],
    total_products: 89.99, total_discount: 0, total_nfce: 89.99,
    payment_method: 'dinheiro', payment_change: 0,
    authorized_at: '2026-06-10T13:00:00Z',
    qr_code: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=3526...|2|2|1|HASH',
    tp_emis: 1,
    ...over,
  };
}

describe('S2.3 — DANFE NFC-e da emissão própria', () => {
  test('homolog própria: banner SEM VALOR FISCAL + protocolo real impresso', () => {
    const html = buildDanfeNfceHtml({ emission: emission(), company });
    expect(html).toContain('AMBIENTE DE HOMOLOGAÇÃO');
    expect(html).toContain('135260000000099'); // protocolo real aparece
    expect(html).toContain('Via do Consumidor');
  });

  test('produção própria: sem banner de homolog', () => {
    const html = buildDanfeNfceHtml({
      emission: emission({ qr_code: 'https://www.nfce.fazenda.sp.gov.br/qrcode?p=...' }),
      company,
    });
    expect(html).not.toContain('AMBIENTE DE HOMOLOGAÇÃO');
  });

  // 16/07/2026: o QR passou a ser gerado local e embutido como SVG inline
  // (era <img> do qrserver.com — ver qrInline.js). O teste antigo afirmava a
  // URL do qrserver, que era detalhe de implementação; este afirma o que
  // importa de verdade: QUAL texto o QR codifica, e que não há rede no meio.
  test('QR da própria emissão (URL v2) é o que vai embutido no cupom', () => {
    const em = emission();
    const html = buildDanfeNfceHtml({ emission: em, company });
    expect(html).toContain(qrInlineSvg(em.qr_code, QR_OPTS));
    expect(html).not.toContain(qrInlineSvg(em.chave_acesso, QR_OPTS));
  });

  test('QR não depende de rede: nada de qrserver.com nem <img> no QR', () => {
    const html = buildDanfeNfceHtml({ emission: emission(), company });
    expect(html).not.toContain('qrserver.com');
    expect(html).toContain('<div class="qr-wrap"><svg');
  });

  test('sem qr_code (gateway): QR cai no fallback da chave de acesso', () => {
    const em = emission({ qr_code: null });
    const html = buildDanfeNfceHtml({ emission: em, company });
    expect(html).toContain(qrInlineSvg(em.chave_acesso, QR_OPTS));
  });

  test('auto-print não depende de onload/readyState', () => {
    const html = buildDanfeNfceHtml({ emission: emission(), company });
    expect(html).not.toContain('window.onload');
    expect(html).not.toContain('readyState');
    expect(html).toContain('document.images');
  });

  test('contingência (tpEmis=9): dizeres + DUAS vias', () => {
    const html = buildDanfeNfceHtml({
      emission: emission({ tp_emis: 9, protocolo: null }),
      company,
    });
    expect((html.match(/EMITIDA EM CONTINGÊNCIA/g) || []).length).toBe(2);
    expect(html).toContain('Pendente de autorização da SEFAZ');
    expect(html).toContain('Via do Consumidor');
    expect(html).toContain('Via do Estabelecimento');
    expect((html.match(/class="page"/g) || []).length).toBe(2);
  });

  test('contingência já autorizada (retransmitida): sem "pendente"', () => {
    const html = buildDanfeNfceHtml({
      emission: emission({ tp_emis: 9 }), // protocolo presente
      company,
    });
    expect(html).toContain('EMITIDA EM CONTINGÊNCIA');
    expect(html).not.toContain('Pendente de autorização');
  });

  test('emissão normal: uma via só', () => {
    const html = buildDanfeNfceHtml({ emission: emission(), company });
    expect((html.match(/class="page"/g) || []).length).toBe(1);
    expect(html).not.toContain('Via do Estabelecimento');
  });

  test('gateway legado (HOMOLOG-): banner sim, protocolo fake não imprime', () => {
    const html = buildDanfeNfceHtml({
      emission: emission({ protocolo: 'HOMOLOG-000231', qr_code: null }),
      company,
    });
    expect(html).toContain('AMBIENTE DE HOMOLOGAÇÃO');
    expect(html).not.toContain('Protocolo de Autorização');
  });
});
