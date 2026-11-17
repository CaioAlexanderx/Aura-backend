// ============================================================
// AURA. — Cache curto do HTML da home da loja
//
// Criado: 10/09/2026 (vitrine Finesse)
//
// A home da loja demorava 4 a 5 s pra mandar o primeiro byte: o banco fica
// em Sao Paulo, o app em us-west, e a pagina faz ~25 idas em fila (~190 ms
// cada). A regiao nao muda; a home muda quando entra peca ou pedido, nao a
// cada visita. Entao a home fica guardada por loja durante TTL_MS, e a
// resposta sai da memoria em milissegundos.
//
// So a HOME (sem query string, sem peca na URL) entra aqui. Categoria,
// busca e paginacao vao pela API e nao passam por esta pagina. Salvar a
// configuracao da loja ou subir uma imagem esquece tudo (routes/
// digitalChannel.js); mudanca de estoque espera o TTL — 60 s de atraso
// numa vitrine e invisivel, 5 s de tela branca nao.
// ============================================================
'use strict';

const TTL_MS = 60 * 1000;
// Trava contra crescimento: cada entrada e uma pagina de ~350 KB.
const MAXIMO_DE_LOJAS = 200;

const _paginas = new Map();

/**
 * A entrada guardada da loja ({ html, csp }), ou null se nao ha ou venceu.
 *
 * A CSP vai junto com o HTML (p-180): a loja com personalizavel vai ganhar
 * uma CSP propria quando o quadro do personalizador entrar (p-182, frame-src
 * do app). Guardar so o HTML e responder o hit com a CSP de todas as lojas
 * serviria, por 60 s, a pagina nova com a politica velha — o quadro seria
 * bloqueado so na segunda visita. `csp` null = quem guardou nao informou, e
 * a rota usa a CSP padrao, como antes.
 */
function entradaLembrada(slug) {
  const hit = _paginas.get(slug);
  if (!hit) return null;
  if (hit.ate <= Date.now()) { _paginas.delete(slug); return null; }
  return { html: hit.html, csp: hit.csp || null };
}

/** O HTML guardado da loja, ou null se nao ha ou venceu. */
function paginaLembrada(slug) {
  const hit = entradaLembrada(slug);
  return hit ? hit.html : null;
}

function lembrarPagina(slug, html, csp) {
  if (!slug || typeof html !== 'string') return;
  if (_paginas.size >= MAXIMO_DE_LOJAS && !_paginas.has(slug)) {
    // Fora a mais antiga: Map guarda a ordem de insercao.
    const primeira = _paginas.keys().next().value;
    _paginas.delete(primeira);
  }
  _paginas.set(slug, { html, csp: typeof csp === 'string' && csp ? csp : null, ate: Date.now() + TTL_MS });
}

/** Sem slug, esquece todas — quem salva config nao sabe o slug de cor. */
function esquecerPagina(slug) {
  if (slug) _paginas.delete(slug);
  else _paginas.clear();
}

module.exports = { paginaLembrada, entradaLembrada, lembrarPagina, esquecerPagina, TTL_MS, MAXIMO_DE_LOJAS };
