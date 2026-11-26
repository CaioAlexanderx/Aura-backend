// ============================================================
// AURA — WhatsApp: os 15 MODELOS das automáticas (aprovados pelo Caio
// em 26/11/2026) e a validação do Editor da lojista.
//
// Parte PURA (sem banco, sem Meta): catálogo, validação, prévia e a
// conversão do texto da lojista ("{Nome}") para o corpo que a Meta
// aceita ("{{1}}"). A mesma função `validar` roda na prévia do Editor
// (POST /whatsapp/modelos/:key/validar) e ao salvar (PUT): o servidor
// nunca confia no cliente.
//
// Categoria: UTILITY = aviso (Crediário: cobrar); MARKETING = novidade
// (Aniversário, Venda+, oferta do Crediário). Aviso com oferta dentro
// vira MARKETING na Meta e passa a custar como novidade — por isso a
// validação barra oferta em modelo UTILITY.
// ============================================================
'use strict';

const LIMITE_CARACTERES = 1024;
const RODAPE = 'Para não receber mais, responda SAIR.';
const PREFIXO_TEMPLATE = 'aura_';

// Exemplos que a Meta exige para cada campo ao criar o template, e que a
// prévia do Editor usa como "cliente de exemplo".
const EXEMPLOS = Object.freeze({
  'Nome': 'Marta',
  'Nome da loja': 'Lume Moda',
  'Presente': '10% de desconto',
  'Validade': '27/12',
  'Código': 'PARABENS-MARTA',
  'Parcela': '2 de 4',
  'Valor': 'R$ 120,00',
  'Vencimento': 'no sábado, 30/11',
  'Pix da loja': 'pix@lumemoda.com.br',
  'Link da loja': 'lumemoda.com.br',
  'Total de parcelas': '4',
  'Última compra': 'Vestido Verde',
  'Mês da última compra': 'agosto',
  'Limite livre': 'R$ 480,00',
});

const C_ANIV = ['Nome', 'Nome da loja', 'Presente', 'Validade', 'Código'];
const C_ANIV_SEM = ['Nome', 'Nome da loja'];
// Botão de resposta rápida dos avisos de parcela (26/11/2026): o toque abre a
// conversa e a Aura responde com o Pix (services/credit/queroPix).
const BOTAO_PIX = Object.freeze([Object.freeze({ tipo: 'QUICK_REPLY', texto: 'Quero o Pix' })]);
const C_CRED = ['Nome', 'Parcela', 'Vencimento', 'Valor', 'Nome da loja', 'Pix da loja', 'Link da loja', 'Total de parcelas'];

function m(key, automatica, titulo, categoria, campos, texto, extra = {}) {
  return Object.freeze({
    key, automatica, titulo, categoria, campos: Object.freeze(campos), texto_padrao: texto,
    template_base: PREFIXO_TEMPLATE + key,
    ...extra,
  });
}

const MODELOS = Object.freeze([
  // ── Aniversário (6 do mock + antes/depois) ──────────────────
  m('aniv_carinhoso_com', 'aniversario', 'Carinhoso, com presente', 'MARKETING', C_ANIV,
    'Feliz aniversário, {Nome}. Para comemorar, a {Nome da loja} te dá {Presente} em qualquer peça até {Validade}. No site, use o código {Código}; na loja, é só dizer seu nome no caixa.'),
  m('aniv_carinhoso_sem', 'aniversario', 'Carinhoso, sem presente', 'MARKETING', C_ANIV_SEM,
    'Feliz aniversário, {Nome}. Obrigada por comprar com a gente na {Nome da loja}. Um ótimo dia para você.'),
  m('aniv_direto_com', 'aniversario', 'Direto, com presente', 'MARKETING', C_ANIV,
    'Parabéns pelo seu dia, {Nome}. Seu presente: {Presente} em qualquer peça da {Nome da loja} até {Validade}. Código {Código} no site, ou seu nome no caixa da loja.'),
  m('aniv_direto_sem', 'aniversario', 'Direto, sem presente', 'MARKETING', C_ANIV_SEM,
    'Parabéns pelo seu dia, {Nome}. Um abraço da equipe da {Nome da loja}.'),
  m('aniv_animado_com', 'aniversario', 'Animado, com presente', 'MARKETING', C_ANIV,
    'Parabéns, {Nome}! Aniversário pede roupa nova: {Presente} em qualquer peça da {Nome da loja} até {Validade}. Código {Código} no site, ou seu nome no caixa.'),
  m('aniv_animado_sem', 'aniversario', 'Animado, sem presente', 'MARKETING', C_ANIV_SEM,
    'Parabéns, {Nome}! Um abraço de toda a equipe da {Nome da loja}, e até a próxima visita.'),
  // Aprovado pelo Caio em 26/11. Serve para "3 dias antes" e "7 dias antes" (texto genérico).
  m('aniv_antes', 'aniversario', 'Antes do aniversário', 'MARKETING', C_ANIV,
    'Oi, {Nome}. Seu aniversário está chegando, e a {Nome da loja} já separou um presente para você: {Presente} em qualquer peça até {Validade}. Código {Código} no site, ou seu nome no caixa.'),

  // ── Venda+ (2 grupos x com/sem presente) ────────────────────
  m('venda_sumindo_com', 'venda_mais', 'Sumindo (31 a 60 dias), com presente', 'MARKETING',
    ['Nome', 'Nome da loja', 'Última compra', 'Presente', 'Validade'],
    'Oi, {Nome}. Faz pouco mais de um mês da sua última compra na {Nome da loja}: {Última compra}. Chegou novidade por aqui, e separei {Presente} para você usar até {Validade}.'),
  m('venda_sumindo_sem', 'venda_mais', 'Sumindo (31 a 60 dias), sem presente', 'MARKETING',
    ['Nome', 'Nome da loja', 'Última compra'],
    'Oi, {Nome}. Faz pouco mais de um mês da sua última compra na {Nome da loja}: {Última compra}. Chegou novidade por aqui. Quer que eu mande fotos?'),
  m('venda_sumiu_com', 'venda_mais', 'Sumiu (mais de 60 dias), com presente', 'MARKETING',
    ['Nome', 'Nome da loja', 'Última compra', 'Mês da última compra', 'Presente', 'Validade'],
    'Oi, {Nome}. Sua última compra na {Nome da loja} foi em {Mês da última compra}: {Última compra}. Muita coisa chegou desde então, e eu queria te dar {Presente} para voltar, até {Validade}.'),
  m('venda_sumiu_sem', 'venda_mais', 'Sumiu (mais de 60 dias), sem presente', 'MARKETING',
    ['Nome', 'Nome da loja', 'Última compra', 'Mês da última compra'],
    'Oi, {Nome}. Sua última compra na {Nome da loja} foi em {Mês da última compra}: {Última compra}. Muita coisa chegou desde então. Quer que eu mande fotos?'),

  // ── Crediário ───────────────────────────────────────────────
  m('cred_antes', 'crediario', 'Antes do vencimento', 'UTILITY', C_CRED,
    "Oi, {Nome}. A parcela {Parcela} do seu crediário na {Nome da loja} vence {Vencimento}: {Valor}. Toque em 'Quero o Pix' que eu te mando o código. Se preferir, dá para pagar na loja.",
    { botoes: BOTAO_PIX, template_base: PREFIXO_TEMPLATE + 'cred_antes_pix' }),
  m('cred_dia', 'crediario', 'No dia', 'UTILITY', C_CRED,
    "Oi, {Nome}. Hoje vence a parcela {Parcela} do crediário na {Nome da loja}, {Valor}. Toque em 'Quero o Pix' que eu te mando o código. Se já pagou, me manda o comprovante que eu dou baixa.",
    { botoes: BOTAO_PIX, template_base: PREFIXO_TEMPLATE + 'cred_dia_pix' }),
  m('cred_atraso', 'crediario', 'Em atraso', 'UTILITY', C_CRED,
    "Oi, {Nome}. A parcela {Parcela} do seu crediário, de {Valor}, venceu {Vencimento} e ainda está em aberto aqui. Toque em 'Quero o Pix' que eu te mando o código. Se precisar de uns dias, me fala por aqui que a gente combina.",
    { botoes: BOTAO_PIX, template_base: PREFIXO_TEMPLATE + 'cred_atraso_pix' }),
  m('cred_oferta', 'crediario', 'Oferta para quem tem limite', 'MARKETING',
    ['Nome', 'Nome da loja', 'Limite livre'],
    'Oi, {Nome}. Chegou novidade aqui na {Nome da loja}, e você tem {Limite livre} livres no crediário. Quer que eu mande fotos do que chegou?'),
]);

const POR_CHAVE = new Map(MODELOS.map((x) => [x.key, x]));

function obter(key) { return POR_CHAVE.get(String(key || '')) || null; }
function listar(automatica = null) {
  return automatica ? MODELOS.filter((x) => x.automatica === automatica) : MODELOS.slice();
}

// ── Texto ────────────────────────────────────────────────────
const TOKEN_RE = /\{([^{}]+)\}/g;

function tokensDe(texto) {
  const out = [];
  String(texto || '').replace(TOKEN_RE, (_, nome) => { out.push(nome.trim()); return ''; });
  return out;
}

function renderizar(texto, valores = EXEMPLOS) {
  return String(texto || '').replace(TOKEN_RE, (_, nome) => {
    const v = valores[nome.trim()];
    return v === undefined || v === null || v === '' ? EXEMPLOS[nome.trim()] || nome.trim() : String(v);
  });
}

// Palavras que fazem a Meta tratar o texto como propaganda.
const OFERTA_RE = /(desconto|promo[cç][aã]o|promocional|oferta|cupom|gr[aá]tis|brinde|ganhe|aproveite|liquida[cç][aã]o|black friday|\d+\s*%|%\s*off|\boff\b)/i;

function trechoDeOferta(texto) {
  const sentencas = String(texto || '').split(/(?<=[.!?])\s+/);
  // Só as palavras da lojista contam: o valor de um campo (ex.: o Presente) não é do texto dela.
  const achada = sentencas.find((s) => OFERTA_RE.test(s.replace(TOKEN_RE, ' ')));
  return achada || null;
}

/**
 * Valida o texto do Editor. Devolve { ok, checks[], previa }.
 * `modelo` = item do catálogo (define campos e categoria).
 */
function validar(modelo, texto) {
  const t = String(texto == null ? '' : texto);
  const checks = [];
  const add = (id, ok, msgOk, msgErro, extra = {}) => checks.push({ id, ok, texto: ok ? msgOk : msgErro, ...extra });
  const limpo = t.trim();

  if (!limpo) {
    add('vazio', false, '', 'Escreva a mensagem antes de mandar para aprovação.');
    return { ok: false, checks, previa: '' };
  }

  const desconhecidos = tokensDe(t).filter((n) => !modelo.campos.includes(n));
  add('campos', desconhecidos.length === 0, 'Só campos que a Aura sabe preencher.',
    `Campo que a Aura não preenche aqui: ${[...new Set(desconhecidos)].map((n) => `"${n}"`).join(', ')}.`,
    desconhecidos.length ? { desconhecidos: [...new Set(desconhecidos)] } : {});

  // Chaves soltas viram texto estranho na mensagem final.
  const semTokens = t.replace(TOKEN_RE, '');
  const soltas = /[{}]/.test(semTokens);
  if (soltas) add('chaves', false, '', 'Há uma chave { ou } sem par. Use só os campos da lista.');

  const comeca = /^\{[^{}]+\}/.test(limpo);
  const termina = /\{[^{}]+\}$/.test(limpo);
  add('comeca', !comeca, 'Começa com palavras suas.', 'O texto não pode começar num campo roxo.');
  add('termina', !termina, 'Termina com palavras suas.', 'O texto não pode terminar num campo roxo.',
    termina ? { correcao: 'PONTO_FINAL' } : {});
  const colados = /\}\{/.test(t);
  add('colados', !colados, 'Campos separados por palavras.', 'Dois campos roxos estão colados.',
    colados ? { correcao: 'SEPARAR' } : {});

  if (modelo.categoria === 'UTILITY') {
    const trecho = trechoDeOferta(t);
    add('oferta', !trecho, 'Sem oferta. Continua sendo aviso.',
      'Aviso não pode ter oferta: o WhatsApp passa a cobrar como novidade.',
      trecho ? { correcao: 'TIRAR_OFERTA', trecho } : {});
  }

  if (modelo.botoes && modelo.botoes.length) {
    const rotulo = modelo.botoes[0].texto;
    const cita = t.toLowerCase().includes(rotulo.toLowerCase());
    add('botao', cita, `O texto avisa do botão "${rotulo}".`, `Mantenha no texto a frase que fala do botão "${rotulo}".`);
  }

  const previa = renderizar(t);
  const usado = Math.max(previa.length, t.length);
  add('tamanho', usado <= LIMITE_CARACTERES,
    `Cabe numa mensagem: ${usado.toLocaleString('pt-BR')} de 1.024 letras.`,
    `Passou do limite: ${usado.toLocaleString('pt-BR')} de 1.024 letras.`,
    { usado, limite: LIMITE_CARACTERES });

  return { ok: checks.every((c) => c.ok), checks, previa };
}

// "{Nome}" -> "{{1}}" na ordem em que aparecem. A mesma ordem monta os
// parâmetros no envio (`parametrosNaOrdem`).
function paraCorpoMeta(texto) {
  let n = 0;
  const ordem = [];
  const corpo = String(texto).replace(TOKEN_RE, (_, nome) => { n += 1; ordem.push(nome.trim()); return `{{${n}}}`; });
  return { corpo, ordem, exemplos: ordem.map((nome) => EXEMPLOS[nome] || 'exemplo') };
}

function limpaValor(v) {
  return v === undefined || v === null ? '' : String(v).replace(/\s*[\r\n\t]+\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// Campos do texto que ficaram sem valor para ESTE cliente. Quem chama
// pula o envio: nunca mandar o exemplo ("Marta") no lugar do dado real.
function camposSemValor(texto, valores) {
  return [...new Set(tokensDe(texto).filter((nome) => !limpaValor(valores[nome])))];
}

function parametrosNaOrdem(texto, valores) {
  return tokensDe(texto).map((nome) => limpaValor(valores[nome]));
}

function componentesDeEnvio(texto, valores) {
  const params = parametrosNaOrdem(texto, valores);
  if (!params.length) return [];
  return [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }];
}

// Componente BUTTONS do template (Meta): QUICK_REPLY de até 25 caracteres.
function componenteBotoes(modelo) {
  if (!modelo || !modelo.botoes || !modelo.botoes.length) return null;
  return { type: 'BUTTONS', buttons: modelo.botoes.map((b) => ({ type: b.tipo, text: b.texto })) };
}

module.exports = {
  componenteBotoes,
  LIMITE_CARACTERES, RODAPE, PREFIXO_TEMPLATE, EXEMPLOS, MODELOS,
  obter, listar, tokensDe, renderizar, validar, trechoDeOferta,
  paraCorpoMeta, parametrosNaOrdem, componentesDeEnvio, camposSemValor,
};
