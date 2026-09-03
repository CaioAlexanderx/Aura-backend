// ============================================================
// As regras do Worker aura-dominios — sem nenhuma API de Worker dentro.
//
// Elas moram aqui, em CommonJS, por um motivo pratico: o Jest deste repo
// roda CommonJS puro (sem babel), entao logica escrita em ESM ficaria sem
// teste. O entry do Worker (index.mjs) e so a casca que chama estas
// funcoes; a decisao toda esta neste arquivo, e ela e testavel.
//
// POR QUE O WORKER EXISTE
// O Railway roteia pelo cabecalho Host e responde "Application not found"
// a qualquer host que nao conheca. No plano Hobby cabem 2 dominios por
// servico, e os dois ja estao ocupados (loja e api) — o dominio da lojista
// nunca vai poder ser cadastrado la. Reescrever o Host na propria
// Cloudflare resolveria, mas "Host Header" em Origin Rules e exclusivo do
// plano Enterprise. O Worker faz o mesmo de graca.
//
// Do outro lado, src/middleware/customDomain.js le X-Aura-Host — e so
// confia nele quando cf-ray existe, ou seja, quando a requisicao passou
// mesmo pela Cloudflare.
// ============================================================
'use strict';

/** O host que o Railway conhece. Toda requisicao de dominio proprio vira ele. */
const ORIGEM = 'loja.getaura.com.br';

/** O cabecalho onde viaja o dominio que a pessoa digitou. */
const CABECALHO = 'X-Aura-Host';

/**
 * E um host nosso? Entao o Worker nao tem nada a fazer com ele.
 *
 * A regra e o sufixo, nao uma lista: se amanha nascer
 * `admin.getaura.com.br`, ele ja entra aqui sem ninguem lembrar de editar.
 * Sem isso, loja.getaura.com.br cairia no proprio Worker e chamaria a si
 * mesma.
 */
function ehNosso(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'getaura.com.br' || h.endsWith('.getaura.com.br');
}

/**
 * A URL que vai para a origem: mesma rota, mesma query, outro host.
 *
 * O host original nao se perde — volta como `hostDaPessoa` para virar
 * cabecalho. Sempre https e sem porta: a origem so atende assim.
 */
function destino(urlOriginal) {
  const url = new URL(urlOriginal);
  const hostDaPessoa = url.hostname.toLowerCase();
  url.hostname = ORIGEM;
  url.port = '';
  url.protocol = 'https:';
  return { url: url.toString(), hostDaPessoa };
}

module.exports = { ORIGEM, CABECALHO, ehNosso, destino };
