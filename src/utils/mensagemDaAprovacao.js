// ============================================================
// mensagemDaAprovacao: o texto do pedido de aprovação da arte (27/11/2026)
//
// O app manda `custom_message` com o marcador {link} no lugar do link da
// aprovação, porque o link só nasce aqui (o token é gerado no servidor).
// Trocar o marcador faz o `message_text` guardado e o `wa_me_link` serem o
// texto que de fato vai ao WhatsApp da cliente.
//
// Sem o marcador o texto fica como veio (clientes antigos do app, que
// montavam a mensagem inteira), e sem texto vale o padrão da casa.
// ============================================================

const MARCADOR = '{link}';

/** Troca todos os {link} do texto pelo link da aprovação. */
function aplicarLink(texto, url) {
  const t = String(texto || '').trim();
  if (!t) return '';
  return t.split(MARCADOR).join(String(url || ''));
}

/** O texto final: o da lojista (com o link no lugar do marcador) ou o padrão. */
function textoDaAprovacao(customMessage, url, padrao) {
  return aplicarLink(customMessage, url) || padrao;
}

module.exports = { MARCADOR, aplicarLink, textoDaAprovacao };
