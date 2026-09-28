// ============================================================
// AURA. — "Nao achamos essa loja" (loja.getaura.com.br/<slug>)
//
// QA 26/09/2026: slug inexistente e loja despublicada caiam num HTML cru
// ("Loja não encontrada / Verifique o link ou peça ao lojista pra
// publicar a loja."), sem titulo na aba, sem estilo e sem saida. Quem
// chega aqui e a cliente que recebeu um link, nao a lojista: a pagina diz
// o que pode ter acontecido, sem termo tecnico, e oferece um caminho.
//
// A mesma pagina serve os dois casos de proposito: dizer "esta loja
// existe mas esta fechada" entregaria que o endereco e de alguem.
//
// Estatica e sem script: cabe na CSP da loja (STOREFRONT_CSP, que ja
// libera fonts.googleapis.com e fonts.gstatic.com).
// ============================================================
'use strict';

const PAGINA_LOJA_NAO_ENCONTRADA = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Não achamos essa loja</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=DM+Sans:wght@400;600&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    background: #FAF7F2;
    color: #1A1612;
    font-family: 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 420px;
    text-align: center;
  }
  .icone {
    width: 88px;
    height: 88px;
    margin: 0 auto 28px;
    border-radius: 50%;
    background: #ECE7DF;
    color: #6B625A;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  h1 {
    margin: 0 0 12px;
    font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
    font-weight: 600;
    font-size: clamp(26px, 6vw, 32px);
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  p {
    margin: 0 0 32px;
    font-size: 16px;
    line-height: 1.55;
    color: #4A423B;
  }
  .botao {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    height: 48px;
    padding: 0 28px;
    border-radius: 999px;
    background: #1A1612;
    color: #FAF7F2;
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
  }
  .botao:hover { background: #33291F; }
  .botao:focus-visible { outline: 3px solid #B8A58C; outline-offset: 3px; }
  @media (max-width: 380px) {
    .botao { width: 100%; }
  }
</style>
</head>
<body>
<main>
  <div class="icone" aria-hidden="true">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 9.5 4.6 4.8A1.2 1.2 0 0 1 5.7 4h12.6a1.2 1.2 0 0 1 1.1.8L21 9.5"/>
      <path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>
      <path d="M4.5 11.8V20h15v-8.2"/>
      <path d="M9.5 20v-5h5v5"/>
    </svg>
  </div>
  <h1>Não achamos essa loja</h1>
  <p>Confira o link com quem te mandou, ou é possível que a loja ainda não esteja publicada.</p>
  <a class="botao" href="https://getaura.com.br">Ir para a Aura</a>
</main>
</body>
</html>`;

module.exports = { PAGINA_LOJA_NAO_ENCONTRADA };
