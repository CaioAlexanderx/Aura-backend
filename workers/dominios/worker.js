// ============================================================
// aura-dominios — o Worker que leva o dominio proprio da lojista ate a
// loja dela.
//
// POR QUE ELE EXISTE
// O Railway roteia pelo cabecalho Host e responde "Application not found"
// a qualquer host que nao conheca. No plano Hobby cabem 2 dominios por
// servico, e os dois ja estao ocupados (loja e api) — o dominio da lojista
// nunca vai poder ser cadastrado la. Reescrever o Host na propria
// Cloudflare resolveria, mas "Host Header" em Origin Rules e exclusivo do
// plano Enterprise. Este Worker faz o mesmo de graca.
//
// Do outro lado, src/middleware/customDomain.js le X-Aura-Host — e so
// confia nele quando cf-ray existe, ou seja, quando a requisicao passou
// mesmo pela Cloudflare.
//
// ARQUIVO UNICO, DE PROPOSITO
// O editor do painel da Cloudflare aceita um modulo so. Este arquivo e
// byte-identico ao que esta la, para nao existir uma segunda verdade. Por
// isso as funcoes puras vivem aqui e sao exportadas: o teste
// (__tests__/workerDeDominios.test.js) importa ESTE arquivo pelo loader
// ESM do Node e exercita elas de verdade.
//
// ROTAS, no painel da zona getaura.com.br
//   www.davicalcados2.com.br/*  → aura-dominios
//   (uma linha por loja; o README diz como adicionar)
//   getaura.com.br/*            → SEM Worker   (o site)
//   *.getaura.com.br/*          → SEM Worker   (loja, api, app, www, r2…)
//
// A rota e por dominio, e nao um `*/*` que apanharia a zona inteira: o
// painel (app) e o site vivem nela, e um Worker com defeito derrubaria os
// dois. As duas linhas SEM Worker sao rede de protecao caso alguem
// adicione um curinga um dia. O ehNosso() abaixo e a terceira camada.
// ============================================================

/** O host que o Railway conhece. Toda requisicao de dominio proprio vira ele. */
export const ORIGEM = 'loja.getaura.com.br';

/** O cabecalho onde viaja o dominio que a pessoa digitou. */
export const CABECALHO = 'X-Aura-Host';

/**
 * E um host nosso? Entao o Worker nao tem nada a fazer com ele.
 *
 * A regra e o sufixo, nao uma lista: se amanha nascer
 * `admin.getaura.com.br`, ele ja entra aqui sem ninguem lembrar de editar.
 * Sem isso, loja.getaura.com.br cairia no proprio Worker e chamaria a si
 * mesma.
 */
export function ehNosso(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'getaura.com.br' || h.endsWith('.getaura.com.br');
}

/**
 * A URL que vai para a origem: mesma rota, mesma query, outro host.
 *
 * O host original nao se perde — volta como `hostDaPessoa` para virar
 * cabecalho. Sempre https e sem porta: a origem so atende assim.
 */
export function destino(urlOriginal) {
  const url = new URL(urlOriginal);
  const hostDaPessoa = url.hostname.toLowerCase();
  url.hostname = ORIGEM;
  url.port = '';
  url.protocol = 'https:';
  return { url: url.toString(), hostDaPessoa };
}

export default {
  async fetch(request) {
    const entrada = new URL(request.url);

    if (ehNosso(entrada.hostname)) return fetch(request);

    const { url, hostDaPessoa } = destino(request.url);

    const requisicao = new Request(url, request);
    // set, nunca append: um X-Aura-Host que venha de fora e descartado.
    requisicao.headers.set(CABECALHO, hostDaPessoa);

    return fetch(requisicao);
  },
};
