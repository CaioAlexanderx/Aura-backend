// ============================================================
// AURA. — Modelo único dos e-mails (tq-75, 24/10/2026)
//
// Um layout só, com quatro variantes (decisões do Caio e da Nina, 21/10):
//
//   aura-carta         cobrança e relacionamento: logo da Aura, claro,
//                      botão "Falar comigo no WhatsApp" e a assinatura de
//                      punho ("Um abraço," + letra + "Caio Alexander,
//                      fundador da Aura").
//   aura-transacional  segurança e avisos à lojista (verificação, senha,
//                      convite, pedido novo, relatório): logo da Aura,
//                      WhatsApp da Aura, SEM a letra — só "Aura" em texto.
//   loja               vai ao CLIENTE FINAL da loja (status do pedido):
//                      marca e WhatsApp da própria loja, rodapé pequeno
//                      "Enviado pela Aura para {loja}", sem assinatura do
//                      Caio e sem o WhatsApp da Aura.
//   portal             verificação do portal do Karatê: marca do portal,
//                      sem assinatura e sem WhatsApp da Aura.
//
// Modo claro é o padrão. O escuro vem só da adaptação do aplicativo de
// e-mail (prefers-color-scheme no <style>), sem duplicar o HTML: as cores
// claras ficam inline e as classes a-* trocam no escuro.
//
// Imagens por URL fixa e versionada no domínio da Aura (o PR do app publica
// public/email/). Nunca anexo cid.
//
// Nada aqui lê banco, rede ou relógio: tudo é texto -> HTML, testável por
// snapshot.
// ============================================================
'use strict';

const { numeroDaAura } = require('./whatsappCadastro');
const { numeroDoWhatsapp } = require('./whatsappDaLoja');

const LOGO_AURA_URL = 'https://app.getaura.com.br/email/aura-logo-v1.png';
const ASSINATURA_URL = 'https://app.getaura.com.br/email/assinatura-caio-alexander-v1.png';
const APP_URL_PADRAO = 'https://app.getaura.com.br';

const VARIANTES = Object.freeze(['aura-carta', 'aura-transacional', 'loja', 'portal']);

// Paleta do mock da Nina (claro). O escuro está no <style>.
const COR = Object.freeze({
  fundo: '#f4f1fb', cartao: '#ffffff', tinta: '#1b1736', tinta2: '#51497f',
  linha: '#e4def5', violeta: '#6d28d9', suave: '#f1ecfd', verde: '#0f766e',
});
const FONTE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Só http(s) absoluto entra em href; o resto vira '#'. */
function urlSegura(u) {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

/** R$ 1.234,56 (formato brasileiro, sempre com centavos). */
function brl(v) {
  const n = Math.round(Number(v || 0) * 100) / 100;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return (n < 0 ? '-' : '') + 'R$ ' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
}

/** AAAA-MM-DD -> dd/mm (sem new Date: data pura viraria UTC). */
function dataCurta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}` : '';
}

/** AAAA-MM-DD -> dd/mm/aaaa. */
function dataLonga(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

const DIAS_DA_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
function diaDaSemana(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  return DIAS_DA_SEMANA[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}

/** Primeiro nome, para o "Oi, {nome}". */
function primeiroNome(nome) {
  const s = String(nome || '').trim();
  return s ? s.split(/\s+/)[0] : '';
}

/** Link wa.me com a mensagem pronta sobre o assunto do e-mail. */
function linkWhatsapp(numero, mensagem) {
  const n = String(numero || '').replace(/\D/g, '');
  if (!n) return '';
  return `https://wa.me/${n}` + (mensagem ? `?text=${encodeURIComponent(mensagem)}` : '');
}

/** Parágrafo no tom da carta. `texto` é texto puro (escapado aqui). */
function p(texto, estilo = '') {
  return `<p class="a-ink" style="margin:0 0 14px;color:${COR.tinta};font-size:15px;line-height:1.6;${estilo}">${esc(texto)}</p>`;
}

/** Parágrafo com HTML já montado (quem chama escapa o que vem de fora). */
function pHtml(html, estilo = '') {
  return `<p class="a-ink" style="margin:0 0 14px;color:${COR.tinta};font-size:15px;line-height:1.6;${estilo}">${html}</p>`;
}

/** Texto miúdo, secundário. */
function nota(html) {
  return `<p class="a-ink2" style="margin:0 0 12px;color:${COR.tinta2};font-size:12.5px;line-height:1.55;">${html}</p>`;
}

/** Caixa suave com linhas rótulo/valor (recibo). */
function tabela(linhas) {
  const tr = linhas.filter((l) => l && l[1] != null && l[1] !== '').map(([rot, val], i, arr) => {
    const borda = i < arr.length - 1 ? `border-bottom:1px solid ${COR.linha};` : '';
    return `<tr><td class="a-ink2 a-line" style="padding:7px 0;${borda}color:${COR.tinta2};font-size:13.5px;">${esc(rot)}</td>` +
      `<td class="a-ink a-line" align="right" style="padding:7px 0;${borda}color:${COR.tinta};font-size:13.5px;font-weight:700;text-align:right;">${esc(val)}</td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a-soft" style="background:${COR.suave};border:1px solid ${COR.linha};border-radius:12px;margin:0 0 16px;">` +
    `<tr><td style="padding:8px 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tr}</table></td></tr></table>`;
}

/** Caixa em destaque (código, cartão de pedido). */
function caixa(html) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a-soft" style="background:${COR.suave};border:1px solid ${COR.linha};border-radius:12px;margin:0 0 16px;">` +
    `<tr><td style="padding:14px 16px;">${html}</td></tr></table>`;
}

/**
 * Bloco do Pix: QR e o copia e cola. O QR é uma imagem por URL (rota
 * pública /emails/pix-qr/<token>.png, services/emailPixQr): o Gmail não
 * mostra imagem em data: e anexo cid está fora (regra 8). Sem código, não
 * desenha nada; sem URL do QR, só o copia e cola.
 */
function blocoPix({ copiaECola, qrUrl } = {}) {
  const codigo = String(copiaECola || '').trim();
  if (!codigo) return '';
  const src = urlSegura(qrUrl);
  const qr = src
    ? `<td width="104" valign="top" style="padding:0 14px 0 0;"><img src="${esc(src)}" width="92" height="92" alt="QR Code do Pix" style="display:block;width:92px;height:92px;background:#ffffff;border:1px solid ${COR.linha};border-radius:8px;padding:4px;"></td>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a-soft" style="background:${COR.suave};border:1px solid ${COR.linha};border-radius:12px;margin:0 0 16px;">` +
    `<tr><td style="padding:14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${qr}` +
    `<td valign="top"><p class="a-ink2" style="margin:0 0 6px;color:${COR.tinta2};font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;">Pix copia e cola</p>` +
    `<p class="a-ink2" style="margin:0;color:${COR.tinta2};font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;word-break:break-all;">${esc(codigo)}</p></td>` +
    `</tr></table></td></tr></table>`;
}

function botaoPrincipal({ rotulo, url }, cor = COR.violeta) {
  const href = urlSegura(url);
  if (!href || !rotulo) return '';
  return `<a class="a-btn" href="${esc(href)}" style="display:inline-block;background:${cor};color:#ffffff;font-weight:700;font-size:14px;text-decoration:none;padding:11px 18px;border-radius:10px;margin:0 10px 10px 0;">${esc(rotulo)}</a>`;
}

function botaoWhatsapp({ numero, mensagem, rotulo = 'Falar comigo no WhatsApp' }) {
  const href = linkWhatsapp(numero, mensagem);
  if (!href) return '';
  return `<a class="a-wa" href="${esc(href)}" style="display:inline-block;background:transparent;color:${COR.verde};border:1.5px solid ${COR.verde};font-weight:700;font-size:14px;text-decoration:none;padding:9.5px 16px;border-radius:10px;margin:0 10px 10px 0;">${esc(rotulo)}</a>`;
}

function assinaturaDePunho({ abraco = true } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 0;"><tr><td>` +
    (abraco ? `<p class="a-ink" style="margin:0;color:${COR.tinta};font-size:15px;">Um abraço,</p>` : '') +
    `<img class="a-sig" src="${ASSINATURA_URL}" width="170" alt="Caio Alexander" style="display:block;width:170px;height:auto;margin:2px 0 0 -2px;border:0;">` +
    `<p class="a-ink" style="margin:0;color:${COR.tinta};font-size:14px;">Caio Alexander, fundador da Aura</p>` +
    `</td></tr></table>`;
}

function cabecalho({ variante, marca }) {
  if (variante === 'loja' || variante === 'portal') {
    const nome = esc((marca && marca.nome) || '');
    const logo = urlSegura(marca && marca.logoUrl);
    const img = logo
      ? `<img src="${esc(logo)}" height="32" alt="${nome}" style="display:inline-block;height:32px;width:auto;max-width:160px;vertical-align:middle;border:0;margin-right:9px;">`
      : '';
    return `${img}<span class="a-ink" style="font-weight:700;font-size:16px;color:${COR.tinta};vertical-align:middle;">${nome}</span>`;
  }
  return `<img src="${LOGO_AURA_URL}" width="28" height="28" alt="Aura" style="display:inline-block;width:28px;height:28px;vertical-align:middle;border:0;margin-right:9px;">` +
    `<span class="a-ink" style="font-weight:700;font-size:16px;letter-spacing:-.2px;color:${COR.tinta};vertical-align:middle;">Aura.</span>`;
}

function rodapePadrao({ variante, marca }) {
  if (variante === 'loja') return `Enviado pela Aura para ${esc((marca && marca.nome) || 'a loja')}.`;
  if (variante === 'portal') return esc((marca && marca.nome) || 'Portal');
  return 'Aura. Tecnologia para negócios · <a class="a-link" href="https://getaura.com.br" style="color:' + COR.violeta + ';text-decoration:none;">getaura.com.br</a>';
}

/**
 * Monta o HTML de um e-mail.
 *
 * @param {object} o
 * @param {string} o.variante   uma de VARIANTES
 * @param {string} o.assunto    vai no <title>
 * @param {string} [o.previa]   texto da prévia (preheader)
 * @param {string} o.corpo      HTML do miolo (use p(), pHtml(), blocoPix()...)
 * @param {{rotulo,url}} [o.botao]           botão principal
 * @param {{mensagem,numero?,rotulo?}|false} [o.whatsapp]
 *        aura-*: número da Aura por padrão; loja: o número da loja (sem ele,
 *        sem botão); portal: nunca.
 * @param {'abraco'|'nome'|false} [o.assinatura]  só aura-carta usa a letra
 * @param {string} [o.rodape]   HTML do rodapé (substitui o padrão)
 * @param {string} [o.rodapeExtra] HTML acrescentado acima do rodapé padrão
 * @param {{nome,logoUrl}} [o.marca]  loja/portal
 */
function montarEmail(o) {
  const variante = VARIANTES.includes(o.variante) ? o.variante : 'aura-transacional';
  const ehAura = variante === 'aura-carta' || variante === 'aura-transacional';

  let wa = '';
  if (o.whatsapp && variante !== 'portal') {
    const numero = ehAura ? (o.whatsapp.numero || numeroDaAura()) : numeroDoWhatsapp(o.whatsapp.numero || '');
    wa = botaoWhatsapp({
      numero,
      mensagem: o.whatsapp.mensagem,
      rotulo: o.whatsapp.rotulo || (ehAura ? 'Falar comigo no WhatsApp' : 'Falar com a loja no WhatsApp'),
    });
  }
  const principal = o.botao ? botaoPrincipal(o.botao) : '';
  const acoes = (principal || wa) ? `<div style="margin:6px 0 4px;">${principal}${wa}</div>` : '';

  let assinatura = '';
  if (variante === 'aura-carta' && o.assinatura !== false) {
    assinatura = assinaturaDePunho({ abraco: o.assinatura !== 'nome' });
  } else if (variante === 'aura-transacional' && o.assinatura !== false) {
    assinatura = `<p class="a-ink" style="margin:8px 0 0;color:${COR.tinta};font-size:14px;">Aura</p>`;
  }

  const rodape = (o.rodapeExtra ? o.rodapeExtra + '<br>' : '') + (o.rodape != null ? o.rodape : rodapePadrao({ variante, marca: o.marca }));
  const previa = o.previa ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(o.previa)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(o.assunto || 'Aura')}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .a-bg { background: #0c0a16 !important; }
    .a-card { background: #15122a !important; border-color: #2b2650 !important; }
    .a-ink { color: #ece9ff !important; }
    .a-ink2 { color: #b3add8 !important; }
    .a-line { border-color: #2b2650 !important; }
    .a-soft { background: #1d1938 !important; border-color: #2b2650 !important; }
    .a-btn { background: #a78bfa !important; color: #14102b !important; }
    .a-wa { color: #6ee7b7 !important; border-color: #6ee7b7 !important; }
    .a-link { color: #a78bfa !important; }
    .a-sig { filter: invert(1) brightness(1.6); }
  }
</style>
</head>
<body class="a-bg" style="margin:0;padding:0;background:${COR.fundo};font-family:${FONTE};">
${previa}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a-bg" style="background:${COR.fundo};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" class="a-card" style="max-width:560px;width:100%;background:${COR.cartao};border:1px solid ${COR.linha};border-radius:14px;">
      <tr><td class="a-line" style="padding:14px 22px;border-bottom:1px solid ${COR.linha};font-family:${FONTE};">${cabecalho({ variante, marca: o.marca })}</td></tr>
      <tr><td style="padding:22px;font-family:${FONTE};">
${o.corpo || ''}
${acoes}${assinatura}
      </td></tr>
      <tr><td class="a-line a-ink2" style="padding:12px 22px;border-top:1px solid ${COR.linha};color:${COR.tinta2};font-size:11.5px;line-height:1.6;font-family:${FONTE};">${rodape}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

module.exports = {
  montarEmail,
  VARIANTES,
  LOGO_AURA_URL,
  ASSINATURA_URL,
  APP_URL_PADRAO,
  COR,
  esc,
  urlSegura,
  brl,
  dataCurta,
  dataLonga,
  diaDaSemana,
  primeiroNome,
  linkWhatsapp,
  p,
  pHtml,
  nota,
  tabela,
  caixa,
  blocoPix,
};
