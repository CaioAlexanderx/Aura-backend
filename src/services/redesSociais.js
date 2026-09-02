// ============================================================
// AURA. — Redes sociais da loja, uma fonte para as DUAS lojas
//
// Criado: 02/09/2026
//
// A lojista cadastra o @ e a loja mostra o icone no rodape. Instagram ja
// existia em `digital_channel_config.instagram` e NINGUEM lia: o campo
// estava no painel, ia pro payload em `contact.instagram` e nenhum
// template desenhava. TikTok e Facebook nasceram junto (migration 319).
//
// POR QUE MODULO, e nao regex solta no template: sao duas lojas (comum e
// vitrine Studio) e um painel. Normalizar o @ em tres lugares e como as
// duas lojas divergem — ja aconteceu quatro vezes. Aqui se decide QUAL
// e o perfil e PARA ONDE ele aponta; COMO desenhar e de cada loja.
//
// O QUE A LOJISTA PODE DIGITAR, e tudo isso vira a mesma coisa:
//   @lojinha · lojinha · instagram.com/lojinha · https://www.instagram.com/lojinha/
//   ... e ate "https://instagram.com/lojinha?igsh=abc" (link de partilha)
//
// O QUE NAO PASSA: qualquer coisa fora do alfabeto de perfil da rede.
// Sem isso, um "javascript:..." colado no campo viraria href no rodape de
// uma loja publica.
// ============================================================
'use strict';

/**
 * As tres redes, na ordem em que aparecem no rodape.
 *
 * `alfabeto` e o que a propria rede aceita num nome de perfil:
 *   - Instagram e TikTok: letras, numeros, ponto e sublinhado.
 *   - Facebook: pagina antiga aceita hifen, e ha o perfil numerico
 *     (facebook.com/100064…), entao o alfabeto e mais largo.
 * `dominios` sao os hosts que a lojista pode colar em vez do @.
 */
const REDES = [
  {
    rede: 'instagram',
    nome: 'Instagram',
    base: 'https://instagram.com/',
    alfabeto: /^[A-Za-z0-9._]{1,30}$/,
    dominios: ['instagram.com', 'www.instagram.com', 'instagr.am'],
  },
  {
    rede: 'tiktok',
    nome: 'TikTok',
    base: 'https://tiktok.com/@',
    alfabeto: /^[A-Za-z0-9._]{1,24}$/,
    dominios: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'],
  },
  {
    rede: 'facebook',
    nome: 'Facebook',
    base: 'https://facebook.com/',
    alfabeto: /^[A-Za-z0-9._-]{1,50}$/,
    dominios: ['facebook.com', 'www.facebook.com', 'fb.com', 'm.facebook.com'],
  },
];

const PORNOME = {};
for (const r of REDES) PORNOME[r.rede] = r;

/**
 * O @ limpo, ou null.
 *
 * Devolve NULL — nao string vazia — pra que o template teste uma coisa so
 * e a coluna guarde NULL quando a lojista apagar o campo.
 */
function normalizarHandle(rede, bruto) {
  const spec = PORNOME[String(rede || '').toLowerCase()];
  if (!spec) return null;

  let s = String(bruto == null ? '' : bruto).trim();
  if (!s) return null;

  // Colou um link: fica so o primeiro segmento do caminho. Aceita com e
  // sem protocolo ("instagram.com/lojinha"), e joga fora query e ancora
  // (o link de partilha do app vem com ?igsh=...).
  const comProtocolo = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  const pareceUrl = comProtocolo || spec.dominios.some((d) => s.toLowerCase().startsWith(d + '/') || s.toLowerCase() === d);
  if (pareceUrl) {
    try {
      const u = new URL(comProtocolo ? s : 'https://' + s);
      // Host tem que ser da rede: link de outro site nao vira perfil.
      if (!spec.dominios.includes(u.hostname.toLowerCase())) return null;
      s = decodeURIComponent(u.pathname).split('/').filter(Boolean)[0] || '';
    } catch (_) {
      return null;
    }
  }

  // "@lojinha" e "lojinha" sao a mesma coisa; a barra final tambem cai.
  s = s.replace(/^@+/, '').replace(/\/+$/, '').trim();
  if (!s) return null;

  return spec.alfabeto.test(s) ? s : null;
}

/** O endereco do perfil, ou null quando o @ nao passa. */
function urlDoPerfil(rede, bruto) {
  const spec = PORNOME[String(rede || '').toLowerCase()];
  const handle = normalizarHandle(rede, bruto);
  if (!spec || !handle) return null;
  return spec.base + handle;
}

/**
 * As redes que a loja tem, na ordem do rodape.
 *
 * @param config linha de digital_channel_config
 * @returns [{ rede, nome, handle, url }] — vazio quando nao ha nenhuma,
 *          e ai o rodape simplesmente nao desenha a linha.
 */
function montarRedes(config) {
  const c = config || {};
  const saida = [];
  for (const spec of REDES) {
    const handle = normalizarHandle(spec.rede, c[spec.rede]);
    if (!handle) continue;
    saida.push({ rede: spec.rede, nome: spec.nome, handle, url: spec.base + handle });
  }
  return saida;
}

module.exports = { REDES, normalizarHandle, urlDoPerfil, montarRedes };
