// ============================================================
// Os selos de confianca padrao nascem do que a lojista LIGOU (decisao 7)
//
// Selo que afirma o que a loja nao faz e pior que selo nenhum. Cada um
// aqui tem uma configuracao real por tras; "Troca em 7 dias" tem a lei.
// ============================================================
const { selosPadrao } = require('../src/services/storefrontBuilder');

describe('selos padrao', () => {
  test('loja so com Pix e retirada: compra segura, troca, retirada', () => {
    const s = selosPadrao({ has_pix: true, pickup_enabled: true, whatsapp: null });
    expect(s.map((x) => x.title)).toEqual(['Compra segura', 'Troca em até 7 dias', 'Retire na loja']);
    expect(s[0].body).toBe('Pix, pagamento protegido');
  });
  test('Pix E cartao: os dois no texto', () => {
    expect(selosPadrao({ has_pix: true, has_card: true })[0].body).toBe('Pix ou cartão, pagamento protegido');
  });
  test('entrega ligada com frete gratis acima de X diz o X; sem X, o prazo', () => {
    expect(selosPadrao({ delivery_enabled: true, delivery_free_above_amount: 299 }).find((x) => x.title === 'Entrega').body).toBe('Grátis acima de R$ 299');
    expect(selosPadrao({ delivery_enabled: true, delivery_eta_text: 'Em até 2 dias' }).find((x) => x.title === 'Entrega').body).toBe('Em até 2 dias');
  });
  test('nunca "Envio para todo o Brasil" nem "primeira troca gratis"', () => {
    const txt = JSON.stringify(selosPadrao({ has_pix: true, has_card: true, delivery_enabled: true, whatsapp: '55' }));
    expect(txt).not.toMatch(/todo o Brasil/i);
    expect(txt).not.toMatch(/primeira troca/i);
    expect(txt).not.toMatch(/Correios/i);
  });
  test('WhatsApp so com numero; no maximo quatro', () => {
    expect(selosPadrao({ whatsapp: null }).some((x) => x.title === 'Atendimento humano')).toBe(false);
    expect(selosPadrao({ has_pix: true, delivery_enabled: true, whatsapp: '55349' }).length).toBeLessThanOrEqual(4);
  });
  test('troca em 7 dias esta sempre', () => {
    expect(selosPadrao({}).some((x) => x.title === 'Troca em até 7 dias')).toBe(true);
  });
});
