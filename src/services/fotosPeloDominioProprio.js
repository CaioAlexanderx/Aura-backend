// ============================================================
// AURA. — As fotos da vitrine pelo dominio proprio (tq-65, 20/10/2026)
//
// ── O QUE FOI MEDIDO ───────────────────────────────────────────────────
// No tema escuro da Felic Adega, capas e fotos apareciam 1 a 3 s depois,
// com cartoes vazios na cor do canvas. As fotos ja eram pequenas (a
// miniatura existe para 153 de 153 produtos e o cartao ja a usa; 6 a 38
// KB). O que pesava era ONDE elas moram: as URLs gravadas no banco usam o
// endereco publico de desenvolvimento do R2 (`pub-<hash>.r2.dev`), que:
//   - nao passa pelo cache da Cloudflare (nenhum cf-cache-status);
//   - nao manda Cache-Control (o navegador nao guarda entre paginas);
//   - levou 0,53 a 1,31 s por foto (mediana 0,59 s), sendo ~0,27 s so
//     para abrir a conexao e ~0,30 s de espera do servidor.
// O MESMO bucket responde em `r2.getaura.com.br` (o padrao do
// R2_PUBLIC_URL em utils/r2Storage.js): com o cache da borda quente,
// 0,06 a 0,13 s por foto (mediana 0,10 s) e Cache-Control max-age=14400.
// Conferido objeto a objeto (34 objetos de 7 lojas, todos os caminhos:
// products, gallery, variants, colors, canal, studio): mesmo status,
// mesmo tamanho, mesmo tipo.
//
// ── POR QUE NA SAIDA, E NAO NO BANCO ───────────────────────────────────
// Trocar as URLs gravadas seria uma escrita em lote em produtos de 12
// lojas. Aqui a troca acontece so no texto que a vitrine manda ao
// navegador: o banco fica como esta, e desligar e uma variavel de
// ambiente (`STOREFRONT_FOTOS_HOST=off`), sem deploy de codigo.
//
// So o host `pub-<32 hex>.r2.dev` e trocado — o unico que existe nas
// lojas publicadas (1.295 URLs) — e nada mais na URL muda: caminho e
// `?v=` seguem iguais, entao a troca de foto continua furando o cache.
// ============================================================
'use strict';

const HOST_DO_R2_DEV = /https:\/\/pub-[0-9a-f]{32}\.r2\.dev\//g;
const PADRAO = 'https://r2.getaura.com.br';

/** O host de destino, ou null quando a troca esta desligada. */
function hostDasFotos() {
  const v = String(process.env.STOREFRONT_FOTOS_HOST == null ? PADRAO : process.env.STOREFRONT_FOTOS_HOST).trim();
  if (!v || v.toLowerCase() === 'off') return null;
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(v.replace(/\/+$/, ''))) return null;
  return v.replace(/\/+$/, '');
}

/** Troca o host do R2 de desenvolvimento pelo dominio proprio num texto (HTML ou JSON). */
function fotosPeloDominioProprio(texto) {
  const host = hostDasFotos();
  if (!host || typeof texto !== 'string') return texto;
  return texto.replace(HOST_DO_R2_DEV, host + '/');
}

/** O mesmo, para um objeto que vai como JSON. */
function fotosPeloDominioProprioNoJson(obj) {
  if (!hostDasFotos() || obj == null) return obj;
  const antes = JSON.stringify(obj);
  const depois = fotosPeloDominioProprio(antes);
  return depois === antes ? obj : JSON.parse(depois);
}

module.exports = { fotosPeloDominioProprio, fotosPeloDominioProprioNoJson, hostDasFotos };
