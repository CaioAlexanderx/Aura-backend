// ============================================================
// AURA. — O endereco publico da API, num lugar so
//
// Criado: 02/09/2026, no dia em que o dominio do provedor caiu.
//
// ── O QUE ACONTECEU ────────────────────────────────────────────────────
// O JavaScript da vitrine chama a API por um endereco ABSOLUTO, escrito
// dentro da pagina que o servidor gera. Esse endereco era, por padrao, o
// dominio publico do Railway (`*.up.railway.app`) — o nome que o PROVEDOR
// da a nossa aplicacao, nao um nome nosso.
//
// Em 02/09 esse dominio passou a devolver 503 enquanto a aplicacao
// continuava viva e respondendo por `loja.getaura.com.br` (que passa pela
// Cloudflare). Resultado: TODAS as lojas abriam — o HTML e renderizado no
// servidor — e nada que dependesse da API funcionava. Categoria,
// paginacao, busca, filtro e o envio do pedido no checkout, todos mudos.
// A loja parecia no ar e nao vendia.
//
// ── A LICAO ────────────────────────────────────────────────────────────
// Enquanto o nome do provedor estiver dentro do produto, trocar de
// provedor e uma obra e uma queda dele e uma queda nossa. O endereco da
// API tem que ser um dominio NOSSO, apontado por DNS pra onde a
// aplicacao estiver. Trocar de nuvem vira mudar um CNAME.
//
// ── COMO CONFIGURAR ────────────────────────────────────────────────────
// `STOREFRONT_API_BASE_URL` no ambiente. Sem ela, cai no dominio proprio
// abaixo — que e nosso e sobrevive a mudanca de provedor. O valor entra
// em dois lugares que precisam concordar: o `API_BASE` que a pagina
// injeta e o `connect-src` do CSP. Se discordarem, o navegador BLOQUEIA a
// chamada e o sintoma e igualzinho ao de servidor fora do ar — por isso
// os dois leem daqui.
// ============================================================
'use strict';

/** Dominio proprio da API. DNS aponta pra onde a aplicacao estiver. */
const PADRAO = 'https://api.getaura.com.br';

function enderecoDaApi() {
  const bruto = String(process.env.STOREFRONT_API_BASE_URL || '').trim();
  if (!bruto) return PADRAO;
  // Sem barra no fim: quem usa concatena '/api/v1/...' e '//' quebraria o
  // casamento de origem do CSP.
  return bruto.replace(/\/+$/, '');
}

/** Grita no boot quando a variavel nao foi definida. */
function avisarSeNaoConfigurado(log) {
  const escrever = log || console.warn;
  if (!String(process.env.STOREFRONT_API_BASE_URL || '').trim()) {
    escrever(
      '[api] STOREFRONT_API_BASE_URL nao definida — usando ' + PADRAO + '. '
      + 'A vitrine chama a API por este endereco; se o DNS dele nao apontar '
      + 'pra esta aplicacao, as lojas abrem e nao vendem.'
    );
  }
}

module.exports = { enderecoDaApi, avisarSeNaoConfigurado, PADRAO };
