module.exports = `
// ── Compre por categoria (home) ───────────────────────────
//
// Cartoes 4:3 de categoria, um por raiz, com a pilula nome + contagem.
// Redesenhado em 02/09/2026 (fase 3): a "tira" virou a secao "Compre por
// categoria" do design, mas a mecanica e a mesma.
//
// O QUE ENTRA NAO SE DECIDE AQUI. O servidor manda TIRA_CATEGORIAS ja
// resolvida (so o primeiro nivel, minimo de tres) — ver
// services/tiraDeCategorias.js. Vazia = nao desenha. Se esta regra fosse
// escrita aqui E na vitrine Studio, um dia as duas divergiriam.
//
// A capa vem pronta tambem: capa_url e o banner da lojista ou a foto da
// peca mais vendida da categoria (services/homeDaLoja.js). Sem nenhuma
// das duas o cartao ENTRA, com um degrau do gradiente da loja — a mesma
// FUNDO_CAPA do produto sem foto. Decisao de Caio (30/08): sumir com o
// cartao faria a fila mudar de tamanho conforme ela sobe as imagens.
function renderTiraCategorias(){
  var el=document.getElementById('tiraCats'); if(!el) return;
  var lista=(typeof TIRA_CATEGORIAS!=='undefined'&&Array.isArray(TIRA_CATEGORIAS))?TIRA_CATEGORIAS:[];
  if(!lista.length){ el.hidden=true; el.innerHTML=''; return; }
  el.hidden=false;

  el.innerHTML='<div class="home-sec-inner">'
    +(typeof cabecalhoDeSecao==='function'
      ? cabecalhoDeSecao('Compre por categoria','Categorias e contagens vêm direto do estoque — sem peça disponível, a categoria some sozinha.')
      : '')
    +'<div class="tira-cats-inner">'+lista.map(function(c){
      var capa=c.capa_url||c.banner_url;
      var arte=capa
        ? '<img src="'+esc(capa)+'" alt="" loading="lazy">'
        : '';
      // O ladrilho de cor vai no elemento, e nao numa <img> falsa: sem
      // requisicao, sem alt vazio, e o degrau vem do nome como no cartao
      // de produto sem foto.
      var fundo=capa?'':' style="background:'+FUNDO_CAPA(c.nome)+'"';
      return '<button type="button" class="tira-cat" onclick="irParaCategoria(\\''+escJsAttr(c.caminho)+'\\')">'
        +'<div class="tira-cat-arte"'+fundo+'>'+arte+'</div>'
        +'<span class="tira-cat-pill"><span class="tira-cat-nome">'+esc(c.nome)+'</span><span class="mono tira-cat-total">'+c.total+'</span></span>'
        +'</button>';
    }).join('')+'</div></div>';
}

/**
 * Clicar num cartao faz EXATAMENTE o que clicar no menu faz: filterCat,
 * a mesma funcao. Duplicar a troca de estado aqui era a forma garantida
 * de a tira e o menu discordarem sobre qual categoria esta ativa.
 *
 * O segundo argumento e null porque nao ha chip pra marcar; o menu
 * repinta em seguida.
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
