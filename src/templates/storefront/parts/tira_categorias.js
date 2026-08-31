module.exports = `
// ── Tira de categorias da home ───────────────────────────
//
// Cartoes grandes de categoria antes da grade. A navegacao por categoria
// ja existia na barra de texto, correta e silenciosa; a tira e a versao
// visual dela, e a primeira coisa que a cliente ve depois do banner.
//
// O QUE ENTRA NAO SE DECIDE AQUI. O servidor manda TIRA_CATEGORIAS ja
// resolvida (so o primeiro nivel, minimo de tres) — ver
// services/tiraDeCategorias.js. Vazia = nao desenha. Se esta regra fosse
// escrita aqui E na vitrine Studio, um dia as duas divergiriam.
//
// Sem banner o cartao ENTRA, com um degrau do gradiente da loja: e a
// mesma FUNDO_CAPA do produto sem foto, entao dois cartoes vizinhos nunca
// saem iguais. Decisao de Caio (30/08) — a alternativa era sumir o
// cartao, e sumir faria a tira mudar de tamanho conforme a lojista sobe
// as imagens.
function renderTiraCategorias(){
  var el=document.getElementById('tiraCats'); if(!el) return;
  var lista=(typeof TIRA_CATEGORIAS!=='undefined'&&Array.isArray(TIRA_CATEGORIAS))?TIRA_CATEGORIAS:[];
  if(!lista.length){ el.hidden=true; el.innerHTML=''; return; }
  el.hidden=false;

  el.innerHTML='<div class="tira-cats-inner">'+lista.map(function(c){
    var arte=c.banner_url
      ? '<img src="'+esc(c.banner_url)+'" alt="" loading="lazy">'
      : '';
    // O ladrilho de cor vai no elemento, e nao numa <img> falsa: sem
    // requisicao, sem alt vazio, e o degrau vem do nome como no cartao
    // de produto sem foto.
    var fundo=c.banner_url?'':' style="background:'+FUNDO_CAPA(c.nome)+'"';
    return '<button type="button" class="tira-cat" onclick="irParaCategoria(\\''+escJsAttr(c.caminho)+'\\')">'
      +'<div class="tira-cat-arte"'+fundo+'>'+arte+'</div>'
      +'<div class="tira-cat-nome">'+esc(c.nome)+'</div>'
      +'<div class="tira-cat-total">'+c.total+(c.total===1?' peça':' peças')+'</div>'
      +'</button>';
  }).join('')+'</div>';
}

/**
 * Clicar num cartao faz EXATAMENTE o que clicar na barra faz: filterCat,
 * a mesma funcao. Nao ha pagina de categoria — a tira leva pra grade
 * filtrada, e duplicar a troca de estado aqui era a forma garantida de a
 * tira e a barra discordarem sobre qual categoria esta ativa.
 *
 * O segundo argumento e null porque nao ha chip pra marcar; renderCategorias
 * repinta a barra em seguida.
 */
function irParaCategoria(caminho){
  // SEM rolagem. Rolar aqui tira da tela justamente o menu que a pessoa
  // esta usando: ela clica em "Vestidos", a pagina desce, e a proxima
  // categoria que ela ia clicar sumiu. Quem esta navegando escolhe
  // quando descer. (Caio, 30/08 — o mesmo defeito existe na barra.)
  filterCat(caminho, null);
}

/** Aspas dentro de onclick quebram o atributo antes de virar XSS. */
function escJsAttr(s){ return String(s==null?'':s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'"); }
`;
