// ============================================================
// AURA. — E-mails da Black Friday 2026 (texto aprovado pelo Caio, 11/11)
// Conteúdo puro, no layout `carta` de emailsCobranca. Não envia nada: quem
// envia, com a trava do email_log, é scripts/enviarBlackFriday.js.
//
//   paginaBlackFriday: e-mail 1. Contas em teste vigente e ativas.
//                      Negócio = texto do Caio inteiro; Essencial = o mesmo,
//                      sem a frase do carnê (Crediário é do Negócio).
//   callbackBlackFriday: e-mail 2. Só teste vencido sem assinatura.
//                      Preço da PRÓPRIA conta, em uma linha. Sem BLACK50
//                      quando comCodigo=false (kill switch).
//
// Textos do Caio (11/11). Fecho "bater recorde" mantido por decisão dele.
// Assinatura 'nome' (sem "Um abraço"), como nos e-mails de cobrança.
// ============================================================
'use strict';
const L = require('./emailLayout');
const { carta } = require('./emailsCobranca');

const LINK_PAGINA = 'https://app.getaura.com.br/black-friday';

function paginaBlackFriday(d) {
  // d: { nome, plano: 'negocio'|'essencial'|'expansao', link?, rodape? }
  const negocio = d.plano !== 'essencial';
  const lista = 'colocar vários produtos em promoção de uma vez, com começo e fim; ' +
    'ver o que deve acabar antes da data e quanto comprar' +
    (negocio ? '; e, se você vende no carnê, lançar já com a primeira parcela em janeiro.' : '.');
  return carta({
    assunto: 'A Black Friday da sua loja já tem uma página na Aura',
    previa: negocio
      ? 'Promoção em lote, o que vai faltar e o crédito para janeiro, numa página só'
      : 'Promoção em lote e o que vai faltar, numa página só',
    blocos: [
      `Oi, ${d.nome}.`,
      'Deixei tudo da Black Friday e das Festas de Fim de Ano num lugar só no seu painel, na página Black Friday, logo abaixo do Painel: ' + lista,
      'Se alguma coisa não ficar clara ou faltar algo, é só me chamar no WhatsApp. ' +
        'Vamos trabalhar juntos para o seu negócio bater recorde de vendas na Black Friday e nas Festas de Fim de Ano!',
    ],
    botao: { rotulo: 'Abrir a página Black Friday', url: d.link || LINK_PAGINA },
    whatsapp: 'Oi, Caio! Vi o e-mail da página Black Friday na Aura.',
    assinatura: 'nome',
    rodape: d.rodape, // montar com rodapeDoTipo({ descadastro, ajustar, motivo }) tipo 'novidades'
  });
}

// Preço da primeira mensalidade com 50%, plano mensal (Célia, 11/11).
const PRECO = {
  negocio: 'R$ 84,50 (depois R$ 169)',
  essencial: 'R$ 44,50 (depois R$ 89)',
};

function callbackBlackFriday(d) {
  // d: { nome, loja, plano, comCodigo = true, link, rodape }
  // d.plano: 'negocio' | 'essencial'. d.studio=true: conta do app de Studio
  // (vertical_active='studio'): funções que ela realmente tem. Plano segue negocio.
  const negocio = d.plano !== 'essencial';
  const comCodigo = d.comCodigo !== false; // false: em atraso (BLACK50 só vale na 1ª mensalidade)
  const funcoes = d.studio
    ? 'orçamento com prévia da arte, fila de produção e o Caixa no mesmo lugar.'
    : 'promoção com começo e fim, o que vai faltar no estoque' +
      (negocio ? ' e o carnê já com a primeira parcela em janeiro.' : '.');
  const blocos = [
    `Oi, ${d.nome}.`,
    `A Black Friday e as Festas de Fim de Ano estão chegando e eu quero ver a sua loja vender mais. ` +
      `A Aura quer ser o seu braço direito: ${funcoes}`,
  ];
  if (comCodigo) {
    blocos.push(
      'Seus dados continuam guardados: é só entrar. Até 30/11, ou enquanto houver cupons, ' +
      `a primeira mensalidade sai pela metade com o código BLACK50: ${PRECO[negocio ? 'negocio' : 'essencial']}, no plano mensal.`,
      'Se travar em qualquer coisa, me chama no WhatsApp.',
    );
  } else if (d.atraso) {
    // Contas em atraso: sem código, sem cobrança no tom. Frases da
    // régua de 21/10: nunca "nada se perde" nem "tudo volta na hora".
    blocos.push('Seus dados continuam guardados. Se alguma coisa ficou pendente na assinatura, ' +
      'é só me chamar no WhatsApp que a gente resolve junto. Assim que o pagamento for confirmado, o acesso volta.');
  } else {
    blocos.push('Seus dados continuam guardados: é só entrar quando quiser. ' +
      'Se ficou alguma coisa para trás, me chama no WhatsApp que eu ajudo a deixar a loja pronta para a Black Friday e as Festas de Fim de Ano.');
  }
  return carta({
    assunto: 'Black Friday e Festas de Fim de Ano: a Aura quer ser seu braço direito',
    previa: comCodigo
      ? 'Seus dados continuam guardados e a primeira mensalidade sai pela metade'
      : 'Seus dados continuam guardados. Vamos deixar a loja pronta para as vendas de fim de ano',
    blocos,
    botao: { rotulo: 'Voltar para a Aura', url: d.link }, // /checkout da conta (linkDoApp)
    whatsapp: 'Oi, Caio! Vi o e-mail sobre a Black Friday e as Festas de Fim de Ano na Aura.',
    assinatura: 'nome',
    rodape: d.rodape,
  });
}

// Aviso dentro do app (b-mk-36). Mesmo corte por plano.
function avisoNoApp(plano) {
  return {
    titulo: 'Black Friday e Festas de Fim de Ano na sua loja',
    corpo: plano === 'essencial'
      ? 'Promoção com começo e fim e o que vai faltar, numa página só.'
      : 'Promoção com começo e fim, o que vai faltar e o crédito para janeiro, tudo numa página só.',
    botao: 'Ver a página',
    rota: '/black-friday',
  };
}

module.exports = { paginaBlackFriday, callbackBlackFriday, avisoNoApp, PRECO, LINK_PAGINA };
