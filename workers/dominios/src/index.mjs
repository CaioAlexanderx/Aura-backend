// ============================================================
// aura-dominios — a casca do Worker. A decisao esta em regras.js.
//
// ROTAS (importantes; sem elas o Worker se chama em loop)
//   getaura.com.br/*    → SEM Worker   (o site)
//   *.getaura.com.br/*  → SEM Worker   (loja, api, app, www, r2, fpkt…)
//   */*                 → aura-dominios
// O padrao mais especifico ganha, entao os nossos hosts passam direto e so
// o dominio da lojista chega aqui. O ehNosso() abaixo e o cinto de
// seguranca para o caso de alguem apagar uma dessas rotas.
// ============================================================
import regras from './regras.js';

const { CABECALHO, ehNosso, destino } = regras;

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
