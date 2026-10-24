// ============================================================
// AURA. — E-mails de relacionamento (24/10/2026)
//
// tq-80 (4.1 boas-vindas), tq-81 (4.2 primeira venda que não saiu, 4.3
// teste terminando, 4.4 teste encerrado), tq-79 (assinatura cancelada) e
// tq-82 (faz uns dias que você não aparece).
//
// Textos 4.1 a 4.4: Cassie (cs-emails-textos-21-10.md), sem mudar o miolo.
// {linha_do_teste} diz a verdade do modo da conta (services/trialRegra):
//   - teste que começa na primeira venda e ainda não começou: 7 dias a
//     partir da venda, terminando no máximo no teto (15 dias do cadastro);
//   - teste já em curso (venda feita, ou código com 7 dias fixos): a data.
//
// TEXTO A APROVAR PELO CAIO (não havia texto da Cassie): assinatura
// cancelada e "faz uns dias que você não aparece". Os dois saem atrás de
// flags DESLIGADAS por padrão (EMAIL_ASSINATURA_CANCELADA_ENABLED e
// EMAIL_SUMIU_ENABLED).
//
// Proibido: "nada se perde" e "tudo volta na hora".
//
// Este arquivo só monta conteúdo (puro, testável por snapshot). Quem envia,
// com idempotência pelo email_log, é services/relacionamento.js (4.1 a 4.4
// e o "sumiu") e services/assinaturasAsaas.js (cancelada).
// ============================================================
'use strict';

const L = require('./emailLayout');
const { carta } = require('./emailsCobranca');

const DIA_MS = 86400000;

/** Dia civil em São Paulo (UTC-3), AAAA-MM-DD, de um instante (ISO/Date). */
function diaBrt(instante) {
  if (!instante) return null;
  const t = new Date(instante).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 3600000).toISOString().slice(0, 10);
}

/**
 * {linha_do_teste} do 4.1, a partir do bloco `trial` de
 * trialRegra.montarTrial(). null quando não há teste valendo (assinou, sem
 * data ou já venceu): o parágrafo sai sem a frase.
 */
function linhaDoTeste(trial, { agora = Date.now() } = {}) {
  if (!trial || !trial.ends_at) return null;
  const fim = new Date(trial.ends_at).getTime();
  if (!Number.isFinite(fim) || fim <= agora) return null;
  const data = L.dataCurta(diaBrt(trial.ends_at));
  if (trial.aguardando_primeira_venda) {
    const dias = Number(trial.dias_apos_primeira_venda) || 7;
    return `O seu teste grátis começa a contar na primeira venda e, a partir dela, dura ${dias} dias. ` +
      `Se a primeira venda demorar, ele termina no máximo em ${data}.`;
  }
  return `O seu teste grátis vai até ${data}.`;
}

function plural(n, um, varios) {
  return `${n} ${n === 1 ? um : varios}`;
}

/** Rodapé dos e-mails do tipo "ajuda"/"acompanhamento": ajustar + parar. */
function rodapeDoTipo({ descadastro, ajustar, motivo }) {
  const links = [];
  if (ajustar) links.push(`<a class="a-link" href="${L.esc(ajustar)}" style="color:${L.COR.violeta};">Ajustar meus e-mails</a>`);
  if (descadastro) links.push(`<a class="a-link" href="${L.esc(descadastro)}" style="color:${L.COR.violeta};">Parar de receber</a>`);
  return `${L.esc(motivo)}${links.length ? ' ' + links.join(' · ') : ''} · Aura. Tecnologia para negócios`;
}

function textoDoRodape({ descadastro, ajustar }) {
  return [ajustar ? `Ajustar meus e-mails: ${ajustar}` : null, descadastro ? `Parar de receber: ${descadastro}` : null]
    .filter(Boolean).join('\n');
}

function comRodape(c, d) {
  const extra = textoDoRodape(d);
  return extra ? { ...c, text: `${c.text}\n\n${extra}` } : c;
}

// ── 4.1 Boas-vindas ─────────────────────────────────────────────
// varejo: o shell Negócio (a frase "caixa, estoque, clientes e fiado" é do
// varejo; Odonto, Food e Studio leem só a linha do teste).
function boasVindas(d) {
  const sobre = d.varejo === false
    ? (d.linhaDoTeste || null)
    : ['A Aura reúne caixa, estoque, clientes e fiado num lugar só.', d.linhaDoTeste].filter(Boolean).join(' ');
  const c = carta({
    assunto: `Oi, ${d.nome}, bem-vindo à Aura`,
    previa: 'Sou o Caio. Se precisar de ajuda, é só responder',
    blocos: [
      `Oi, ${d.nome}, tudo bem?`,
      `Sou o Caio, da Aura. Vi que você criou a conta da ${d.loja} e quis te dar as boas-vindas pessoalmente.`,
      sobre,
      'Se quiser ajuda para trazer seus produtos ou seus clientes, ou se ficar qualquer dúvida no caminho, é só responder este e-mail. Eu leio todos.',
    ],
    botao: { rotulo: 'Abrir minha conta', url: d.link },
    whatsapp: `Oi, Caio! Acabei de criar a conta da ${d.loja} na Aura.`,
    rodape: rodapeDoTipo({ ...d, motivo: `Você recebe este e-mail porque criou a conta da ${d.loja} na Aura.` }),
  });
  return comRodape(c, d);
}

// ── 4.2 Primeira venda que não saiu ─────────────────────────────
function oQueJaFez(nProdutos) {
  const n = Number(nProdutos) || 0;
  return n > 0 ? `você já cadastrou ${plural(n, 'produto', 'produtos')}` : 'você já entrou e olhou o sistema';
}

function primeiraVendaNaoSaiu(d) {
  const c = carta({
    assunto: 'Já fez a primeira venda na Aura?',
    previa: 'Se travou em algo, eu ajudo',
    blocos: [
      `Oi, ${d.nome}, tudo bem?`,
      `Passando para saber como está indo a ${d.loja} na Aura. Vi que ${oQueJaFez(d.nProdutos)}, mas a primeira venda ainda não saiu. É comum travar em um detalhe, como cadastrar um produto, achar o Caixa ou imprimir uma etiqueta.`,
      'Me conta onde está empacando, pode ser respondendo este e-mail mesmo, que eu te ajudo.',
    ],
    botao: { rotulo: 'Fazer minha primeira venda', url: d.link },
    whatsapp: `Oi, Caio! Recebi seu e-mail sobre a primeira venda da ${d.loja} na Aura.`,
    rodape: rodapeDoTipo({ ...d, motivo: `Você recebe este e-mail porque está testando a Aura com a ${d.loja}.` }),
  });
  return comRodape(c, d);
}

// ── 4.3 Teste terminando (2 dias antes) ─────────────────────────
/** {quando}: "quinta-feira, dia 26/10" ou, na recuperação, "amanhã, dia 26/10". */
function quandoTermina(fim, hoje) {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fim || ''));
  const m2 = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(hoje || ''));
  const dias = m1 && m2
    ? Math.round((Date.UTC(+m1[1], +m1[2] - 1, +m1[3]) - Date.UTC(+m2[1], +m2[2] - 1, +m2[3])) / DIA_MS)
    : null;
  return `${dias === 1 ? 'amanhã' : L.diaDaSemana(fim)}, dia ${L.dataCurta(fim)}`;
}

function testeTerminando(d) {
  const quando = quandoTermina(d.fim, d.hoje);
  const c = carta({
    assunto: `Seu teste da Aura termina ${quando}`,
    previa: 'O Caixa continua funcionando',
    blocos: [
      `Oi, ${d.nome}, tudo bem?`,
      `O teste da ${d.loja} termina ${quando}. Depois disso o Caixa continua funcionando normalmente, e as outras telas ficam travadas até você escolher um plano.`,
      'Se quiser seguir, é só escolher o plano aqui. E se ficou alguma dúvida ou faltou testar alguma coisa, responde este e-mail que eu te ajudo.',
    ],
    botao: { rotulo: 'Escolher meu plano', url: d.link },
    whatsapp: `Oi, Caio! Recebi seu e-mail sobre o fim do teste da ${d.loja} na Aura.`,
    rodape: rodapeDoTipo({ ...d, motivo: `Você recebe este e-mail porque está testando a Aura com a ${d.loja}.` }),
  });
  return comRodape(c, d);
}

// ── 4.4 Teste encerrado ─────────────────────────────────────────
// A contagem é a real (produtos e clientes ativos). O que é zero sai da
// frase; sem nada cadastrado, a frase do "continua guardado" não aparece.
function oQueFicouGuardado(nProdutos, nClientes) {
  const partes = [];
  const p = Number(nProdutos) || 0;
  const c = Number(nClientes) || 0;
  if (p > 0) partes.push(plural(p, 'produto', 'produtos'));
  if (c > 0) partes.push(plural(c, 'cliente', 'clientes'));
  return partes.join(' e ');
}

function testeEncerrado(d) {
  const guardado = oQueFicouGuardado(d.nProdutos, d.nClientes);
  const c = carta({
    assunto: 'Seu teste da Aura terminou',
    previa: 'O Caixa segue liberado',
    blocos: [
      `Oi, ${d.nome}.`,
      `O teste da ${d.loja} terminou. O Caixa segue liberado para você vender` +
        (guardado ? `, e o que você cadastrou continua guardado: ${guardado}.` : '.') +
        ' As outras telas voltam assim que você escolher o plano.',
      'Se algo ficou faltando, ou se a Aura não era o que você esperava, me conta. Eu quero entender.',
    ],
    botao: { rotulo: 'Escolher meu plano', url: d.link },
    whatsapp: `Oi, Caio! Recebi seu e-mail sobre o fim do teste da ${d.loja} na Aura.`,
    rodape: rodapeDoTipo({ ...d, motivo: `Você recebe este e-mail porque testou a Aura com a ${d.loja}.` }),
  });
  return comRodape(c, d);
}

// ── Assinatura cancelada (tq-79; TEXTO A APROVAR PELO CAIO) ─────
// caixaSegue: só no shell Negócio e fora do atraso (em atraso o Caixa pausa
// no dia 14; Odonto, Food e Studio vão ao checkout). Sem promessa nenhuma:
// nem prazo, nem desconto, nem "volta na hora".
function assinaturaCancelada(d) {
  return carta({
    assunto: 'A assinatura da Aura foi cancelada',
    previa: 'Seus dados continuam guardados',
    blocos: [
      `Oi, ${d.nome}.`,
      `A assinatura da ${d.loja} na Aura foi cancelada. Seus dados continuam guardados` +
        (d.caixaSegue ? ', e o Caixa segue funcionando para você vender.' : '.'),
      'Se foi um engano, ou se quiser me contar o que pesou na decisão, é só responder este e-mail. Eu leio todos e quero entender.',
    ],
    botao: null,
    whatsapp: `Oi, Caio! Recebi o e-mail sobre o cancelamento da assinatura da ${d.loja} na Aura.`,
  });
}

// ── Faz uns dias que você não aparece (tq-82; TEXTO A APROVAR) ──
// Carta curta, sem lista de funções, com pergunta aberta. Nada de "vi que
// você não entrou desde...": a pessoa não pode se sentir monitorada.
function sumiu(d) {
  const c = carta({
    assunto: 'Faz uns dias que você não aparece',
    previa: 'Só passando para saber se está tudo bem',
    blocos: [
      `Oi, ${d.nome}, tudo bem?`,
      `Faz uns dias que você não aparece na Aura e quis passar só para saber como andam as coisas na ${d.loja}.`,
      'Ficou alguma coisa que não funcionou do jeito que você precisava? Pode responder este e-mail mesmo, que chega direto para mim.',
    ],
    botao: null,
    whatsapp: `Oi, Caio! Recebi seu e-mail sobre a ${d.loja} na Aura.`,
    rodape: rodapeDoTipo({ ...d, motivo: `Você recebe este e-mail porque usa a Aura com a ${d.loja}.` }),
  });
  return comRodape(c, d);
}

module.exports = {
  diaBrt,
  linhaDoTeste,
  oQueJaFez,
  quandoTermina,
  oQueFicouGuardado,
  boasVindas,
  primeiraVendaNaoSaiu,
  testeTerminando,
  testeEncerrado,
  assinaturaCancelada,
  sumiu,
};
