// ============================================================
// AURA. — Endereco publico do app (links que saem para a cliente)
//
// Por que existe: varios lugares montavam `${APP_PUBLIC_URL || ''}/acompanhar/...`.
// Em producao APP_PUBLIC_URL esta vazia, entao o link saia relativo
// ("/aprovacao/<token>") e nao abria no WhatsApp. Esta funcao e o unico
// ponto: APP_PUBLIC_URL, depois APP_URL, depois o dominio padrao.
// Le o ambiente a cada chamada (testes trocam a variavel).
// ============================================================
'use strict';

const URL_PADRAO = 'https://app.getaura.com.br';

function urlPublicaDoApp() {
  const bruto = [process.env.APP_PUBLIC_URL, process.env.APP_URL]
    .map((v) => String(v == null ? '' : v).trim())
    .find((v) => v !== '');
  return (bruto || URL_PADRAO).replace(/\/+$/, '');
}

module.exports = { urlPublicaDoApp, URL_PADRAO };
