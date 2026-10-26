// ============================================================
// AURA. — Cor do texto sobre a cor da loja (tq-56, 26/10/2026)
//
// A vitrine escrevia SEMPRE branco sobre a cor principal (botao de
// comprar, finalizar, chips selecionados...). Com cor clara o botao fica
// ilegivel: na Felic Adega (#C7A956) o contraste do branco e 2,3:1.
//
// Regra (decisao do Caio, 26/10/2026): branco enquanto o branco alcancar
// 3:1 sobre a cor (o minimo do WCAG 2.x para texto grande e componentes);
// abaixo disso, preto. So as cores CLARAS trocam: as medias e saturadas
// (#EF4444, #3B82F6, #16A34A, #EA580C, #8B5CF6), que ficam entre 3:1 e
// 4,5:1 com o branco, continuam brancas como sempre. Quando o branco nao
// alcanca 3:1 o preto da mais de 7:1, entao a troca sempre melhora.
//
// Cor que nao e hex (#rgb ou #rrggbb) fica no branco de sempre: a regra
// nunca muda uma loja que ela nao sabe ler. Para a cor que fica no branco
// o CSS sai byte a byte igual ao de antes.
// ============================================================
'use strict';

const BRANCO = '#fff';
const PRETO = '#000';
const MINIMO_WCAG = 3;

/** '#abc' ou '#aabbcc' -> [r, g, b] (0-255); qualquer outra coisa -> null. */
function rgbDoHex(cor) {
  const s = String(cor == null ? '' : cor).trim();
  let m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return m.slice(1).map((h) => parseInt(h + h, 16));
  m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return m.slice(1).map((h) => parseInt(h, 16));
  return null;
}

/** Luminancia relativa WCAG (0 = preto, 1 = branco); null se nao for hex. */
function luminanciaRelativa(cor) {
  const rgb = rgbDoHex(cor);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razao de contraste WCAG entre duas cores hex (1 a 21); null se alguma nao for hex. */
function contraste(a, b) {
  const la = luminanciaRelativa(a);
  const lb = luminanciaRelativa(b);
  if (la === null || lb === null) return null;
  const [claro, escuro] = la >= lb ? [la, lb] : [lb, la];
  return (claro + 0.05) / (escuro + 0.05);
}

/** A cor do texto sobre `fundo`: '#fff' ou '#000'. */
function textoSobre(fundo) {
  const comBranco = contraste(fundo, '#ffffff');
  if (comBranco === null || comBranco >= MINIMO_WCAG) return BRANCO;
  return PRETO;
}

module.exports = { textoSobre, contraste, luminanciaRelativa, rgbDoHex, MINIMO_WCAG };
