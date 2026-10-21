// ============================================================
// AURA. — WhatsApp da loja na vitrine: numero do wa.me, bloco e politica
//
// tq-61 (21/10/2026): o link do WhatsApp da loja saia sem o 55
// (wa.me/12981365134). O painel grava o numero com mascara, "(12)
// 98136-5134", e cada lugar que montava o wa.me so tirava o que nao era
// digito. Sem o codigo do pais o WhatsApp nao acha a conversa.
//
// UMA regra para todos os lugares que montam wa.me na vitrine e na
// confirmacao do pedido. A mesma fonte roda no servidor e vai serializada
// para o navegador (mesmo padrao de faixasDePreco e fotosDaVitrine): o
// teste e a loja executam o MESMO codigo.
//
// O dado gravado e a mascara do painel NAO mudam — so o link.
// ============================================================

const FONTE = `
/**
 * O numero que vai no wa.me: so digitos, com o 55 do Brasil.
 * 10 ou 11 digitos (DDD + numero) ganham o 55; 12 ou 13 que ja comecam
 * com 55 ficam como estao. Qualquer outra coisa sai so com os digitos.
 * Vazio devolve ''.
 */
function numeroDoWhatsapp(raw) {
  var d = String(raw == null ? '' : raw).replace(/\\D/g, '');
  if (!d) return '';
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}
`;

// eslint-disable-next-line no-new-func
const { numeroDoWhatsapp } = new Function(FONTE + '\nreturn { numeroDoWhatsapp: numeroDoWhatsapp };')();

/** 'https://wa.me/55...' ou '' quando nao ha numero. */
function linkDoWhatsapp(raw) {
  const n = numeroDoWhatsapp(raw);
  return n ? `https://wa.me/${n}` : '';
}

// ── Bloco do WhatsApp da home ───────────────────────────────────
// O texto de hoje, escrito para loja de roupa. Coluna NULL = este texto,
// byte a byte (a loja que nao configurou nao muda nada).
const BLOCO_PADRAO = Object.freeze({
  titulo: 'Dúvida sobre tamanho ou modelo?',
  texto: 'Fale direto com a gente no WhatsApp.',
});

const LIMITES_DO_BLOCO = Object.freeze({ titulo: 80, texto: 200 });

/**
 * O que a lojista mandou para o titulo ou o texto do bloco, pronto para
 * gravar. Sem HTML (as tags saem; o que sobrar de < > tambem), espacos e
 * quebras de linha viram um espaco so, corta no limite. Vazio ou nulo
 * devolve null — que e "voltar ao texto padrao".
 */
function sanearTextoDoBloco(valor, limite) {
  if (valor == null) return null;
  const limpo = String(valor)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpo) return null;
  return limpo.slice(0, limite).trim();
}

// ── Politica de troca com link ───────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A palavra inteira, em qualquer caixa ("WhatsApp", "Whatsapp",
// "WHATSAPP"). "WhatsAppzinho" nao casa.
const PALAVRA_WHATSAPP = /(^|[^A-Za-z0-9_])(whatsapp)(?![A-Za-z0-9_])/gi;

/**
 * O texto da politica escapado, com a palavra "WhatsApp" virando link
 * para o WhatsApp da loja. So a palavra vira <a>: o resto do texto da
 * lojista e escapado por inteiro. Sem numero, ou sem a palavra, devolve
 * exatamente escHtml(texto) — nada e acrescentado.
 */
function politicaComLinkDoWhatsapp(texto, numero) {
  const bruto = String(texto || '');
  const n = numeroDoWhatsapp(numero);
  if (!n) return escHtml(bruto);
  let saida = '';
  let ultimo = 0;
  PALAVRA_WHATSAPP.lastIndex = 0;
  let m;
  while ((m = PALAVRA_WHATSAPP.exec(bruto)) !== null) {
    const inicio = m.index + m[1].length;
    saida += escHtml(bruto.slice(ultimo, inicio));
    saida += `<a href="https://wa.me/${n}" target="_blank" rel="noopener" style="color:var(--sf-pix);font-weight:600;text-decoration:underline;">${escHtml(m[2])}</a>`;
    ultimo = inicio + m[2].length;
  }
  saida += escHtml(bruto.slice(ultimo));
  return saida;
}

module.exports = {
  FONTE,
  numeroDoWhatsapp,
  linkDoWhatsapp,
  BLOCO_PADRAO,
  LIMITES_DO_BLOCO,
  sanearTextoDoBloco,
  politicaComLinkDoWhatsapp,
};
