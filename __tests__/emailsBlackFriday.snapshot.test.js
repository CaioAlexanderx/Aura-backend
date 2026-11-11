// ============================================================
// AURA. — E-mails da Black Friday 2026: snapshot de cada variante (11/11/2026)
//
// E-mail 1 (página Black Friday): Negócio (texto inteiro), Essencial (sem a
// frase do carnê) e Expansão (texto inteiro). E-mail 2 (retorno): Negócio e
// Essencial com o BLACK50 e o preço do plano, Studio com as funções do
// Studio, conta em atraso (sem código, frase da régua) e o kill switch sem
// código. Mais as regras de toda carta: a letra, o WhatsApp da Aura, o
// rodapé de descadastro e as frases proibidas fora.
// ============================================================
'use strict';

const BF = require('../src/services/emailsBlackFriday');
const { rodapeDoTipo, comRodape } = require('../src/services/emailsRelacionamento');

const LETRA = 'assinatura-caio-alexander-v1.png';
const WA_AURA = 'https://wa.me/5511956305269';
const PROIBIDAS = [/nada se perde/i, /tudo volta na hora/i];
const LINKS = {
  descadastro: 'https://api.exemplo.test/api/v1/emails/descadastro/TOKEN',
  ajustar: 'https://app.getaura.com.br/configuracoes?foco=emails&empresa=emp-1',
};
const CHECKOUT = 'https://app.getaura.com.br/checkout?empresa=emp-1';
const FRASE_CARNE = 'se você vende no carnê, lançar já com a primeira parcela em janeiro';

const rodape = (motivo) => rodapeDoTipo({ ...LINKS, motivo });
const usa = rodape('Você recebe este e-mail porque usa a Aura com a Modas da Maria.');
const testou = rodape('Você recebe este e-mail porque testou a Aura com a Modas da Maria.');

function regras(c) {
  expect(c.html).toContain(LETRA);
  expect(c.html).toContain('Caio Alexander, fundador da Aura');
  expect(c.html).toContain(WA_AURA);
  expect(c.html).not.toContain('cid:');
  expect(c.html).toContain(LINKS.descadastro);
  expect(c.html).toContain('Parar de receber');
  expect(c.html).toContain('Ajustar meus e-mails');
  // Assinatura só com o nome (sem "Um abraço").
  expect(c.text).not.toContain('Um abraço');
  for (const f of PROIBIDAS) {
    expect(c.html).not.toMatch(f);
    expect(c.text).not.toMatch(f);
  }
}

describe('e-mail 1: página Black Friday', () => {
  test('Negócio: texto inteiro, com a frase do carnê, botão para /black-friday', () => {
    const c = comRodape(BF.paginaBlackFriday({ nome: 'Maria', plano: 'negocio', rodape: usa }), LINKS);
    regras(c);
    expect(c.assunto).toBe('A Black Friday da sua loja já tem uma página na Aura');
    expect(c.text).toContain(FRASE_CARNE);
    expect(c.html).toContain('href="https://app.getaura.com.br/black-friday"');
    expect(c.text).toContain('Abrir a página Black Friday: https://app.getaura.com.br/black-friday');
    expect(c.text).toContain(`Parar de receber: ${LINKS.descadastro}`);
    expect(c.html).toMatchSnapshot();
    expect(c.text).toMatchSnapshot();
  });

  test('Essencial: o mesmo texto, sem a frase do carnê', () => {
    const c = comRodape(BF.paginaBlackFriday({ nome: 'Maria', plano: 'essencial', rodape: usa }), LINKS);
    regras(c);
    expect(c.text).not.toContain('carnê');
    expect(c.html).not.toContain('carnê');
    expect(c.previa).toBe('Promoção em lote e o que vai faltar, numa página só');
    expect(c.text).toContain('ver o que deve acabar antes da data e quanto comprar.');
    expect(c.html).toMatchSnapshot();
  });

  test('Expansão: texto inteiro, como o Negócio', () => {
    const neg = BF.paginaBlackFriday({ nome: 'Maria', plano: 'negocio', rodape: usa });
    const exp = BF.paginaBlackFriday({ nome: 'Maria', plano: 'expansao', rodape: usa });
    expect(exp.html).toBe(neg.html);
    expect(exp.text).toBe(neg.text);
  });
});

describe('e-mail 2: retorno', () => {
  test('Negócio com BLACK50 e o preço do Negócio', () => {
    const c = comRodape(BF.callbackBlackFriday({ nome: 'Maria', loja: 'Modas da Maria', plano: 'negocio', link: CHECKOUT, rodape: testou }), LINKS);
    regras(c);
    expect(c.text).toContain('BLACK50: R$ 84,50 (depois R$ 169), no plano mensal.');
    expect(c.text).toContain('o carnê já com a primeira parcela em janeiro.');
    expect(c.text).toContain(`Voltar para a Aura: ${CHECKOUT}`);
    expect(c.html).toMatchSnapshot();
    expect(c.text).toMatchSnapshot();
  });

  test('Essencial com BLACK50, o preço do Essencial e sem o carnê', () => {
    const c = comRodape(BF.callbackBlackFriday({ nome: 'Maria', loja: 'Modas da Maria', plano: 'essencial', link: CHECKOUT, rodape: testou }), LINKS);
    regras(c);
    expect(c.text).toContain('BLACK50: R$ 44,50 (depois R$ 89), no plano mensal.');
    expect(c.text).not.toContain('carnê');
    expect(c.html).toMatchSnapshot();
  });

  test('Studio: as funções do Studio, com BLACK50', () => {
    const c = comRodape(BF.callbackBlackFriday({ nome: 'Maria', loja: 'Modas da Maria', plano: 'negocio', studio: true, link: CHECKOUT, rodape: testou }), LINKS);
    regras(c);
    expect(c.text).toContain('orçamento com prévia da arte, fila de produção e o Caixa no mesmo lugar.');
    expect(c.text).not.toContain('carnê');
    expect(c.text).toContain('BLACK50');
    expect(c.html).toMatchSnapshot();
  });

  test('em atraso: sem código, com a frase da régua', () => {
    const c = comRodape(BF.callbackBlackFriday({
      nome: 'Maria', loja: 'Modas da Maria', plano: 'negocio', comCodigo: false, atraso: true, link: CHECKOUT, rodape: usa,
    }), LINKS);
    regras(c);
    expect(c.text).not.toContain('BLACK50');
    expect(c.text).not.toContain('R$');
    expect(c.text).toContain('Assim que o pagamento for confirmado, o acesso volta.');
    expect(c.previa).toBe('Seus dados continuam guardados. Vamos deixar a loja pronta para as vendas de fim de ano');
    expect(c.html).toMatchSnapshot();
  });

  test('kill switch (sem código): sem BLACK50 e sem preço', () => {
    const c = comRodape(BF.callbackBlackFriday({ nome: 'Maria', loja: 'Modas da Maria', plano: 'negocio', comCodigo: false, link: CHECKOUT, rodape: testou }), LINKS);
    regras(c);
    expect(c.text).not.toContain('BLACK50');
    expect(c.text).toContain('é só entrar quando quiser');
    expect(c.html).toMatchSnapshot();
  });
});

describe('aviso no app', () => {
  test('mesmo corte por plano', () => {
    expect(BF.avisoNoApp('essencial').corpo).not.toContain('crédito');
    expect(BF.avisoNoApp('negocio').corpo).toContain('crédito para janeiro');
    expect(BF.avisoNoApp('negocio').rota).toBe('/black-friday');
  });
});
