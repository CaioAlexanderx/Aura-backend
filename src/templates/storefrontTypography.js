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
const TIPOGRAFIAS = {
  // Elegante — boutique, joalheria
  classic: {
    display: "'Instrument Serif','Cormorant Garamond',Georgia,serif",
    body: "'DM Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Instrument+Serif:ital@0;1', 'DM+Sans:wght@400;500;600;700'],
  },
  // Moderna — streetwear, tecnologia
  modern: {
    display: "'Space Grotesk','Inter',-apple-system,sans-serif",
    body: "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Space+Grotesk:wght@500;600;700', 'Inter:wght@400;500;600;700'],
  },
  // Marcante — atacado, promocao
  editorial: {
    display: "'Archivo Black',Impact,-apple-system,sans-serif",
    body: "'Archivo',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Archivo+Black', 'Archivo:wght@400;500;600;700'],
  },
  // Acolhedora — artesanal, doces, brecho
  humanist: {
    display: "'Fraunces',Georgia,serif",
    body: "'Nunito Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    familias: ['Fraunces:opsz,wght@9..144,400;9..144,600', 'Nunito+Sans:opsz,wght@6..12,400;6..12,600;6..12,700'],
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
