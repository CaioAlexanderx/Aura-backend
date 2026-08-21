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

const TIPOGRAFIAS = {
  classic: {
    display: "'Instrument Serif','Cormorant Garamond',Georgia,serif",
    body: "'DM Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Instrument+Serif:ital@0;1', 'DM+Sans:wght@400;500;600;700'],
  },
  modern: {
    display: "'Fraunces','Instrument Serif',Georgia,serif",
    body: "'Manrope','DM Sans',-apple-system,BlinkMacSystemFont,sans-serif",
    familias: ['Fraunces:opsz,wght@9..144,400;9..144,600', 'Manrope:wght@400;500;700;800'],
  },
  editorial: {
    display: "'Playfair Display','Instrument Serif',Georgia,serif",
    body: "'Manrope','DM Sans',-apple-system,BlinkMacSystemFont,sans-serif",
    familias: ['Playfair+Display:ital,wght@0,400;0,600', 'Manrope:wght@400;500;700;800'],
  },
  humanist: {
    display: "'DM Sans','Inter',-apple-system,BlinkMacSystemFont,sans-serif",
    body: "'DM Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['DM+Sans:wght@400;500;600;700;800'],
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
