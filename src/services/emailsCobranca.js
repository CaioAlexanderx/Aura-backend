// ============================================================
// AURA. — E-mails de cobrança da assinatura Aura (24/10/2026)
//
// tq-76 (recibo 2.7, estorno, contestação), tq-77 (2.1 dois dias antes,
// 2.2 no dia), tq-78 (2.3, 2.4 e 2.5: 1, 3 e 7 dias de atraso), tq-84 (2.8
// e 2.8b: cartão recusado) e tq-93 (2.9 e 2.10: Caixa pausa em 3 dias e
// Caixa pausado).
//
// Textos: Cassie (cs-emails-textos-21-10.md, com a atualização da tarde de
// 21/10). As frases de pausa vêm das decisões do Caio: telas no dia 7 de
// atraso, Caixa no dia 14 (services/cobrancaAssinatura). Proibido: "nada se
// perde" e "tudo volta na hora".
//
// TEXTO A APROVAR PELO CAIO: estorno e contestação (não havia texto da
// Cassie); a variante de 2.1/2.2/2.3... "sem Pix" (quando a Asaas não devolve
// o Pix, o e-mail sai com o link da fatura); 2.8 com a nova tentativa
// automática DESLIGADA (ASAAS_RETENTATIVA_CARTAO_ENABLED), que é o 2.8
// original da Cassie, sem prometer a nova tentativa.
//
// VALOR NO E-MAIL (regra do Caio, 24/10): o número escrito é sempre o da
// própria cobrança da Asaas lida no envio (valorParaEmail), nunca o preço do
// plano nem netValue. Em aberto e vencida, value + interestValue (o que o Pix
// do mesmo e-mail cobra hoje, com multa e juros); paga, value (o efetivamente
// pago). Com desconto antecipado ainda válido, ou sem leitura confiável, o
// e-mail sai SEM número (d.valor = null) — cada frase tem a versão sem valor.
//
// Este arquivo só monta conteúdo (puro, testável por snapshot). Quem envia
// (com idempotência pelo email_log) é services/reguaDeCobranca.js e o
// webhook (services/cobrancaAssinatura.js).
// ============================================================
'use strict';

const L = require('./emailLayout');

const FORMAS = {
  PIX: 'Pix',
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  UNDEFINED: 'Pix ou boleto',
};

function formaDePagamento(billingType) {
  return FORMAS[String(billingType || '').toUpperCase()] || 'Outra forma';
}

function centavos(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * O valor que vai escrito no e-mail, a partir da cobrança da Asaas (o
 * payment daquele e-mail). Nunca netValue (é o que a Aura recebe), nunca o
 * preço do plano.
 *
 *   situacao 'aberta': value + interestValue (multa e juros calculados pela
 *     Asaas para hoje; 0 antes do vencimento) = o que o Pix cobra hoje.
 *     Com desconto (discount.value > 0) e ainda dentro do vencimento, o Pix
 *     pode cobrar menos que value: sem número (null).
 *   situacao 'paga': value (paga com juros, a Asaas guarda o original em
 *     originalValue e value é o pago). Com desconto configurado e sem
 *     originalValue não dá para afirmar o pago: sem número.
 *
 * @returns {{ valor: number, comJuros: boolean } | null}
 */
function valorParaEmail(payment, { situacao = 'aberta', hoje = null } = {}) {
  if (!payment) return null;
  const base = centavos(payment.value);
  if (base == null || base <= 0) return null;
  const temDesconto = !!(payment.discount && Number(payment.discount.value) > 0);
  if (situacao === 'paga') {
    if (temDesconto && payment.originalValue == null) return null;
    const original = centavos(payment.originalValue);
    return { valor: base / 100, comJuros: original != null && base > original };
  }
  const due = String(payment.dueDate || '').slice(0, 10);
  const vencida = payment.status === 'OVERDUE' || !!(hoje && due && due < hoje);
  if (temDesconto && !vencida) return null;
  const juros = centavos(payment.interestValue) || 0;
  return { valor: (base + Math.max(0, juros)) / 100, comJuros: juros > 0 };
}

/** "R$ 169,00" (ou com o aviso de multa e juros); null sem valor. */
function valorTexto(d) {
  if (d.valor == null || !Number.isFinite(Number(d.valor))) return null;
  return L.brl(d.valor) + (d.comJuros ? ' (valor de hoje, já com multa e juros)' : '');
}

function valorSimples(d) {
  return d.valor != null && Number.isFinite(Number(d.valor)) ? L.brl(d.valor) : null;
}

/**
 * Monta uma carta de cobrança no layout aura-carta.
 *   blocos: string (parágrafo de texto puro) | { pix: true } | { html, texto }
 */
function carta({ assunto, previa, blocos, botao, assinatura = 'abraco', rodape, rodapeExtra, whatsapp, pix }) {
  const html = [];
  const texto = [];
  for (const b of blocos) {
    if (b == null || b === false) continue;
    if (typeof b === 'string') {
      html.push(L.p(b));
      texto.push(b);
    } else if (b.pix) {
      if (pix && pix.copiaECola) {
        html.push(L.blocoPix(pix));
        texto.push(`Pix copia e cola: ${pix.copiaECola}`);
      }
    } else if (b.html) {
      html.push(b.html);
      if (b.texto) texto.push(b.texto);
    }
  }
  if (botao && botao.url) texto.push(`${botao.rotulo}: ${botao.url}`);
  texto.push(assinatura === 'abraco' ? 'Um abraço,\nCaio Alexander, fundador da Aura' : 'Caio Alexander, fundador da Aura');

  return {
    assunto,
    previa,
    html: L.montarEmail({
      variante: 'aura-carta',
      assunto,
      previa,
      corpo: html.join('\n'),
      botao: botao && botao.url ? botao : null,
      whatsapp: whatsapp ? { mensagem: whatsapp } : false,
      assinatura,
      rodape,
      rodapeExtra,
    }),
    text: texto.join('\n\n'),
  };
}

const RODAPE_JA_PAGOU = 'Já pagou? Ignore este e-mail, a gente dá baixa sozinho.';

function temPix(d) {
  return !!(d.pix && d.pix.copiaECola);
}

function msgWhats(d) {
  return `Oi, Caio! Recebi seu e-mail sobre a mensalidade da ${d.loja} na Aura.`;
}

// ── 2.1 Lembrete, 2 dias antes ──────────────────────────────────
function lembreteDoisDias(d) {
  const valor = valorTexto(d);
  const pix = temPix(d);
  const pv = valorSimples(d);
  return carta({
    assunto: `Sua mensalidade da Aura vence ${L.diaDaSemana(d.vencimento)}`,
    previa: pix
      ? (pv ? `${pv}, com o Pix pronto para copiar` : 'O Pix está pronto para copiar')
      : (pv ? `${pv}. O link da fatura está aqui` : 'O link da fatura está aqui'),
    blocos: [
      `Oi, ${d.nome}, tudo bem?`,
      `Passando só para lembrar que a mensalidade da ${d.loja} na Aura${valor ? `, de ${valor},` : ''} vence ${L.diaDaSemana(d.vencimento)}, dia ${L.dataCurta(d.vencimento)}.`,
      pix
        ? 'Deixei o Pix logo abaixo. É só copiar e colar no app do seu banco, ou ler o QR Code.'
        : 'Deixei o link da fatura logo abaixo, no botão. Por ela dá para pagar do jeito que preferir.',
      { pix: true },
      'Qualquer dúvida, responde este e-mail que chega direto para mim.',
    ],
    pix: d.pix,
    botao: { rotulo: 'Abrir a fatura', url: d.linkFatura },
    whatsapp: msgWhats(d),
    rodape: RODAPE_JA_PAGOU,
  });
}

// ── 2.2 Vence hoje ──────────────────────────────────────────────
function venceHoje(d) {
  const valor = valorTexto(d);
  const pix = temPix(d);
  const pv = valorSimples(d) ? `${valorSimples(d)}. ` : '';
  return carta({
    assunto: 'Hoje vence a mensalidade da Aura',
    previa: pix ? `${pv}O Pix está aqui` : `${pv}O link da fatura está aqui`,
    blocos: [
      `Oi, ${d.nome}! Hoje é o dia da mensalidade da ${d.loja}${valor ? `, ${valor}` : ''}.`,
      pix
        ? 'O Pix está aqui embaixo, caso ajude. Se você já pagou, pode ignorar este e-mail: assim que o pagamento cair, eu te aviso.'
        : 'O link da fatura está aqui embaixo, caso ajude. Se você já pagou, pode ignorar este e-mail: assim que o pagamento cair, eu te aviso.',
      { pix: true },
    ],
    pix: d.pix,
    botao: { rotulo: 'Abrir a fatura', url: d.linkFatura },
    whatsapp: msgWhats(d),
    rodape: RODAPE_JA_PAGOU,
  });
}

// ── 2.3 Atraso de 1 dia ─────────────────────────────────────────
function atrasoUmDia(d) {
  const valor = valorTexto(d);
  const pix = temPix(d);
  const venc = L.dataCurta(d.vencimento);
  return carta({
    assunto: `A mensalidade da Aura de ${venc} ainda está em aberto`,
    previa: pix ? 'Pode ter passado batido. O Pix continua valendo' : 'Pode ter passado batido. O link da fatura continua valendo',
    blocos: [
      `Oi, ${d.nome}, tudo bem?`,
      `Não vi o pagamento da mensalidade de ${venc} da ${d.loja}${valor ? `, ${valor}` : ''}. Pode ter passado batido, acontece.`,
      pix
        ? 'O Pix continua valendo, aqui embaixo. E se aconteceu alguma coisa por aí, é só me contar.'
        : 'O link da fatura continua valendo, aqui embaixo. E se aconteceu alguma coisa por aí, é só me contar.',
      { pix: true },
    ],
    pix: d.pix,
    botao: { rotulo: 'Pagar agora', url: d.linkFatura },
    whatsapp: msgWhats(d),
    rodape: RODAPE_JA_PAGOU,
  });
}

// ── 2.4 Atraso de 3 dias ────────────────────────────────────────
function atrasoTresDias(d) {
  const valor = valorTexto(d);
  const pix = temPix(d);
  const venc = L.dataCurta(d.vencimento);
  return carta({
    assunto: 'Sobre a mensalidade da Aura: posso ajudar?',
    previa: 'Se a data ficou ruim, a gente combina outra',
    blocos: [
      `Oi, ${d.nome}.`,
      `A mensalidade de ${venc} da ${d.loja}${valor ? `, ${valor},` : ''} segue em aberto. Se ficou difícil pagar nessa data, me responde que a gente combina uma data nova.`,
      `Seus dados continuam guardados. Se a mensalidade continuar em aberto, a partir de ${L.dataCurta(d.pausaTelas)} o acesso às outras telas fica pausado; o Caixa continua funcionando para você vender.`,
      pix ? 'O Pix continua aqui embaixo.' : 'O link da fatura continua aqui embaixo.',
      { pix: true },
    ],
    pix: d.pix,
    botao: { rotulo: 'Pagar agora', url: d.linkFatura },
    whatsapp: msgWhats(d),
    assinatura: 'nome',
    rodape: RODAPE_JA_PAGOU,
  });
}

// ── 2.5 Atraso de 7 dias ────────────────────────────────────────
function atrasoSeteDias(d) {
  const valor = valorTexto(d);
  const pix = temPix(d);
  const venc = L.dataCurta(d.vencimento);
  return carta({
    assunto: 'Preciso falar com você sobre a mensalidade da Aura',
    previa: 'Faz uma semana. Quero resolver junto com você',
    blocos: [
      `Oi, ${d.nome}.`,
      `Faz uma semana que a mensalidade de ${venc} da ${d.loja}${valor ? `, ${valor},` : ''} está em aberto e eu ainda não consegui falar com você. Antes de qualquer coisa: se aconteceu algo, eu prefiro saber e resolver junto.`,
      pix
        ? 'Se quiser pagar, o Pix está aqui embaixo. Se precisar de outra data, é só responder este e-mail com o dia que fica bom.'
        : 'Se quiser pagar, o link da fatura está aqui embaixo. Se precisar de outra data, é só responder este e-mail com o dia que fica bom.',
      `Seus dados continuam guardados. Por enquanto o acesso às outras telas está pausado e o Caixa segue funcionando para você vender até ${L.dataCurta(d.pausaCaixa)}. Assim que o pagamento for confirmado, o acesso volta.`,
      { pix: true },
    ],
    pix: d.pix,
    botao: { rotulo: 'Pagar agora', url: d.linkFatura },
    whatsapp: msgWhats(d),
    assinatura: 'nome',
    rodape: RODAPE_JA_PAGOU,
  });
}

// ── 2.9 Seu Caixa pausa em {n} dias (dia 11) ────────────────────
function caixaPausaEmDias(d) {
  const valor = valorTexto(d);
  const venc = L.dataCurta(d.vencimento);
  const n = Math.max(1, Number(d.diasParaPausaDoCaixa) || 3);
  return carta({
    assunto: `Seu Caixa da Aura pausa em ${n} ${n === 1 ? 'dia' : 'dias'}`,
    previa: `A mensalidade de ${venc} segue em aberto`,
    blocos: [
      `Oi, ${d.nome}.`,
      `A mensalidade de ${venc} da ${d.loja}${valor ? `, ${valor},` : ''} continua em aberto, e eu não queria que o seu Caixa pausasse sem você saber: se o pagamento não entrar até ${L.dataCurta(d.pausaCaixa)}, ele para nesse dia.`,
      'Seus dados continuam guardados. Assim que o pagamento for confirmado, o acesso volta.',
      { pix: true },
      'Se aconteceu alguma coisa, é só responder este e-mail que a gente conversa.',
    ],
    pix: d.pix,
    botao: { rotulo: 'Pagar agora', url: d.linkFatura },
    whatsapp: msgWhats(d),
    assinatura: 'nome',
    rodape: RODAPE_JA_PAGOU,
  });
}

// ── 2.10 Caixa pausado (dia 14) ─────────────────────────────────
function caixaPausado(d) {
  const valor = valorTexto(d);
  const venc = L.dataCurta(d.vencimento);
  return carta({
    assunto: 'O Caixa da Aura está pausado',
    previa: 'Seus dados continuam guardados',
    blocos: [
      `Oi, ${d.nome}.`,
      `Hoje o Caixa da ${d.loja} foi pausado, porque a mensalidade de ${venc}${valor ? `, ${valor},` : ''} continua em aberto. Seus dados continuam guardados, e assim que o pagamento for confirmado o Caixa e o resto voltam.`,
      { pix: true },
      'Se for outra coisa, como uma dificuldade, uma mudança de planos ou a Aura não estar servindo, me conta. Eu quero entender e resolver com você.',
    ],
    pix: d.pix,
    botao: { rotulo: 'Pagar agora', url: d.linkFatura },
    whatsapp: msgWhats(d),
    assinatura: 'nome',
    rodape: RODAPE_JA_PAGOU,
  });
}

// ── 2.7 Pagamento confirmado (recibo) ───────────────────────────
function pagamentoConfirmado(d) {
  const valor = valorSimples(d);
  const forma = formaDePagamento(d.billingType);
  const dataPg = L.dataLonga(d.dataPagamento);
  const comprovante = L.urlSegura(d.linkComprovante);
  return carta({
    assunto: 'Recebi seu pagamento, obrigado!',
    previa: [valor, forma, dataPg].filter(Boolean).join(' · '),
    blocos: [
      `Oi, ${d.nome}.`,
      `Recebi o pagamento da mensalidade da ${d.loja}. Obrigado por estar com a gente.`,
      {
        html: L.tabela([
          ['Valor', valor],
          ['Forma', forma],
          ['Data', dataPg],
          ['Próximo vencimento', L.dataLonga(d.proximoVencimento)],
        ]),
        texto: [
          valor ? `Valor: ${valor}` : null, `Forma: ${forma}`, dataPg ? `Data: ${dataPg}` : null,
          d.proximoVencimento ? `Próximo vencimento: ${L.dataLonga(d.proximoVencimento)}` : null,
        ].filter(Boolean).join('\n') + (comprovante ? `\n\nVer o comprovante: ${comprovante}` : ''),
      },
    ],
    botao: null,
    whatsapp: `Oi, Caio! Recebi o recibo da mensalidade da ${d.loja} na Aura.`,
    rodape: comprovante
      ? `<a class="a-link" href="${L.esc(comprovante)}" style="color:${L.COR.violeta};text-decoration:none;">Ver o comprovante</a> · Aura. Tecnologia para negócios`
      : undefined,
  });
}

// ── Estorno (TEXTO A APROVAR PELO CAIO) ─────────────────────────
function pagamentoEstornado(d) {
  const valor = valorSimples(d);
  return carta({
    assunto: 'Estorno da mensalidade da Aura',
    previa: valor ? `${valor} da mensalidade da ${d.loja}` : `Mensalidade da ${d.loja}`,
    blocos: [
      `Oi, ${d.nome}.`,
      `O pagamento ${valor ? `de ${valor} ` : ''}da mensalidade da ${d.loja} foi estornado. O tempo para o valor aparecer de volta depende da forma de pagamento e do seu banco.`,
      'Se você não esperava esse estorno ou ficou alguma dúvida, responde este e-mail que eu vejo com você.',
    ],
    botao: null,
    whatsapp: `Oi, Caio! Recebi o e-mail sobre o estorno da mensalidade da ${d.loja} na Aura.`,
  });
}

// ── Contestação no cartão (TEXTO A APROVAR PELO CAIO) ───────────
function pagamentoContestado(d) {
  const valor = valorSimples(d);
  return carta({
    assunto: 'Recebi um aviso de contestação da mensalidade da Aura',
    previa: 'Quero entender o que aconteceu',
    blocos: [
      `Oi, ${d.nome}.`,
      `O banco me avisou que o pagamento ${valor ? `de ${valor} ` : ''}da mensalidade da ${d.loja} foi contestado no cartão.`,
      'Se foi você que contestou, me conta o motivo respondendo este e-mail, que eu quero entender. Se você não reconhece essa contestação, me avisa também.',
    ],
    botao: null,
    whatsapp: `Oi, Caio! Recebi o e-mail sobre a contestação da mensalidade da ${d.loja} na Aura.`,
  });
}

// ── 2.8 Cartão que não passou ───────────────────────────────────
// comNovaTentativa: só com ASAAS_RETENTATIVA_CARTAO_ENABLED ligado o e-mail
// promete "vou tentar de novo amanhã". Desligado (padrão), sai o 2.8
// original da Cassie, sem a promessa.
function cartaoRecusado(d) {
  const valor = valorTexto(d);
  const cartao = d.cartaoFinal ? `no cartão final ${d.cartaoFinal}` : 'no cartão cadastrado';
  const pix = temPix(d);
  const pagarPix = pix ? 'pagar agora por Pix, aqui embaixo,' : 'pagar agora pela fatura,';
  return carta({
    assunto: 'O cartão não passou na mensalidade da Aura',
    previa: d.comNovaTentativa ? 'Vou tentar de novo amanhã, uma única vez' : 'Dá para resolver em um minuto',
    blocos: [
      'Oi, ' + d.nome + ', tudo bem?',
      `Tentei cobrar a mensalidade da ${d.loja}${valor ? `, ${valor},` : ''} ${cartao} e não passou. Costuma ser limite, cartão trocado ou bloqueio do banco, nada de grave.`,
      d.comNovaTentativa
        ? `Vou tentar de novo amanhã, uma única vez. Se preferir não esperar, dá para ${pagarPix} ou trocar o cartão por aqui.`
        : `Dá para ${pagarPix} ou trocar o cartão por aqui.`,
      { pix: true },
      'Se precisar de ajuda, responde este e-mail.',
    ],
    pix: d.pix,
    botao: { rotulo: 'Atualizar o cartão', url: d.linkCartao || d.linkFatura },
    whatsapp: msgWhats(d),
  });
}

// ── 2.8b Segunda tentativa também falhou ────────────────────────
function cartaoRecusadoDeNovo(d) {
  const valor = valorTexto(d);
  const cartao = d.cartaoFinal ? `o cartão final ${d.cartaoFinal}` : 'o cartão';
  const pix = temPix(d);
  const pausaFutura = d.pausaTelas && d.hoje && d.hoje < d.pausaTelas;
  return carta({
    assunto: 'O cartão não passou de novo na mensalidade da Aura',
    previa: pix ? 'Não vou insistir. O Pix está aqui' : 'Não vou insistir. O link da fatura está aqui',
    blocos: [
      `Oi, ${d.nome}.`,
      `Tentei de novo e ${cartao} não passou outra vez, então não vou insistir.`,
      `A mensalidade da ${d.loja}${valor ? `, ${valor},` : ''} segue em aberto desde ${L.dataCurta(d.vencimento)}. ` +
        (pix ? 'O jeito mais rápido de resolver é o Pix, aqui embaixo, ou trocar o cartão por aqui.'
          : 'O jeito mais rápido de resolver é pagar pela fatura ou trocar o cartão por aqui.') +
        (pausaFutura ? ` Se continuar em aberto, o acesso às outras telas pausa no dia ${L.dataCurta(d.pausaTelas)}.` : ''),
      { pix: true },
      'Se tiver qualquer dificuldade, responde este e-mail.',
    ],
    pix: d.pix,
    botao: { rotulo: 'Atualizar o cartão', url: d.linkCartao || d.linkFatura },
    whatsapp: msgWhats(d),
  });
}

module.exports = {
  formaDePagamento,
  valorParaEmail,
  valorTexto,
  lembreteDoisDias,
  venceHoje,
  atrasoUmDia,
  atrasoTresDias,
  atrasoSeteDias,
  caixaPausaEmDias,
  caixaPausado,
  pagamentoConfirmado,
  pagamentoEstornado,
  pagamentoContestado,
  cartaoRecusado,
  cartaoRecusadoDeNovo,
};
