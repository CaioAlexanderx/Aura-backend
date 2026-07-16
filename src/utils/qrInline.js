// ============================================================
// AURA. — qrInline: QR Code como SVG inline (sem rede)
//
// PORQUE (16/07/2026 — relato Davi Calcados): a DANFE buscava o QR em
// api.qrserver.com via <img src>. O auto-print disparava antes da imagem
// chegar e o Chrome devolvia "Falha na impressao. Verifique a impressora
// e tente novamente" — e a loja concluia que a impressora tinha quebrado.
//
// Alem do race, era uma dependencia de terceiro no caminho critico do
// cupom fiscal: qrserver.com fora do ar, rede da loja com filtro de
// conteudo ou DNS bloqueado = ninguem imprime nota. Nao ha motivo pra
// isso — o QR e deterministico e da pra gerar aqui.
//
// Geracao local, SINCRONA (QRCode.create) e embutida como SVG: zero
// requests, nada pra esperar, nada pra falhar. Sincrono de proposito,
// pra manter buildDanfeNfceHtml() puro e sem async (as rotas que o
// chamam nao precisam mudar).
// ============================================================
'use strict';

const QRCode = require('qrcode');

/**
 * QR Code como <svg> inline, pronto pra embutir no HTML.
 *
 * @param {string} text — conteudo do QR
 * @param {{ size?: string, margin?: number, ecc?: 'L'|'M'|'Q'|'H' }} [opts]
 *   size:   CSS do lado do SVG (default '28mm')
 *   margin: quiet zone em modulos (default 1 — a NT da NFC-e nao exige 4)
 *   ecc:    nivel de correcao (default 'M', mesmo do layout aprovado)
 * @returns {string} markup <svg>… ou '' se nao der pra gerar
 */
function qrInlineSvg(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';

  const size = opts.size || '28mm';
  const margin = Number.isFinite(opts.margin) ? opts.margin : 1;

  try {
    const qr = QRCode.create(raw, { errorCorrectionLevel: opts.ecc || 'M' });
    const n = qr.modules.size;
    const data = qr.modules.data;
    const dim = n + margin * 2;

    // Um unico <path> com todos os modulos escuros — bem menor que 1 <rect>
    // por modulo (importa: isso vai inline no HTML de cada cupom).
    let path = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (data[y * n + x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
      }
    }

    // shape-rendering=crispEdges: sem antialias, essencial em termica 203dpi.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"`
      + ` width="${size}" height="${size}" shape-rendering="crispEdges"`
      + ` role="img" aria-label="QR Code">`
      + `<rect width="${dim}" height="${dim}" fill="#fff"/>`
      + `<path d="${path}" fill="#000"/>`
      + '</svg>';
  } catch (err) {
    // Nunca derruba a impressao por causa do QR: sem QR o cupom ainda sai
    // com a chave de acesso legivel, que e o fallback da propria NT.
    console.error('[qrInline] falha ao gerar QR:', err.message);
    return '';
  }
}

module.exports = { qrInlineSvg };
