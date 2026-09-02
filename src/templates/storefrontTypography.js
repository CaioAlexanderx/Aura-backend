// ============================================================
// AURA — pares tipograficos da loja (espelho)
//
// FONTE DE VERDADE: aura-app `constants/fonts.ts` → TIPOGRAFIAS.
// Este arquivo e um ESPELHO porque app e backend sao repositorios
// separados e nao ha modulo compartilhado. Ao mexer num, mexer no outro:
// os testes deste arquivo travam as chaves, mas nao conseguem comparar
// com o outro repo.
//
// POR QUE ISTO EXISTE: a lojista escolhe o par no painel; a loja comum
// (este template) e a vitrine Studio (Expo) precisam entender a MESMA
// escolha. Antes divergiam em silencio:
//
//   - o template mapeava `modern` para Fraunces + DM SANS, enquanto o app
//     usa Fraunces + Manrope;
//   - `editorial` nao existia aqui e caia no ramo do `classic` — a
//     lojista escolhia Editorial e recebia Classica, sem erro nenhum;
//   - e o template carregava TRES familias sempre, escolhesse ela o que
//     escolhesse.
// ============================================================
'use strict';

// REESCRITO em 23/08/2026: antes TRES dos quatro pares eram serifados
// (Instrument Serif, Fraunces, Playfair) e o quarto era DM Sans, que ja
// era o CORPO do classic. Ninguem distinguia. Agora cada par e um tipo de
// loja diferente. As CHAVES ficam (estao no banco e no CHECK da 299).
// RE-CURADO em 02/09/2026 (redesign da loja, Claude Design). Os quatro
// TIPOS de loja continuam os mesmos; mudam as familias. Caio sugeriu
// manter os antigos como mais quatro opcoes; ficou decidido que nao:
// cada par novo e gemeo do antigo (serifa fina, geometrica, pesada,
// serifa macia) e oito opcoes que parecem quatro e o mesmo problema que
// motivou a reescrita de 23/08.
const TIPOGRAFIAS = {
  // Elegante — boutique, joalheria
  classic: {
    display: "'Cormorant Garamond',Georgia,serif",
    body: "'Figtree',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Cormorant+Garamond:ital,wght@0,500;0,600;1,500', 'Figtree:wght@400;500;600;700'],
  },
  // Moderna — streetwear, tecnologia
  modern: {
    display: "'Space Grotesk',-apple-system,sans-serif",
    body: "'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Space+Grotesk:wght@500;600;700', 'Manrope:wght@400;500;600;700'],
  },
  // Marcante — atacado, promocao
  editorial: {
    display: "'Anton',Impact,-apple-system,sans-serif",
    body: "'Archivo',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Anton', 'Archivo:wght@400;500;600;700'],
  },
  // Acolhedora — artesanal, doces, brecho
  humanist: {
    display: "'Lora',Georgia,serif",
    body: "'Karla',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Lora:ital,wght@0,400;0,500;0,600;1,400', 'Karla:wght@400;500;600;700'],
  },
};

/** O par escolhido, com queda pro classico se vier chave desconhecida. */
function parTipografico(chave) {
  return TIPOGRAFIAS[String(chave || '').trim()] || TIPOGRAFIAS.classic;
}

/**
 * Link do Google Fonts para UM par + a mono da marca.
 *
 * So o par escolhido entra. Antes o template carregava DM Sans,
 * Instrument Serif e Fraunces em toda loja — inclusive nas que usam so
 * uma delas.
 */
function linkDeFontes(chave) {
  const par = parTipografico(chave);
  const familias = par.familias.concat(['DM+Mono:wght@400;500']);
  return 'https://fonts.googleapis.com/css2?' +
    familias.map((f) => 'family=' + f).join('&') +
    '&display=swap';
}

module.exports = { TIPOGRAFIAS, parTipografico, linkDeFontes };
