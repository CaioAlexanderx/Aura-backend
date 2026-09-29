// ============================================================
// AURA Studio · Orçamento em vídeo 3D — regras puras
//
// Desenho: aura-app docs/studio/orcamento-video-3d.md (28/09/2026).
//
// A lojista grava um vídeo da peça girando e manda o vídeo embutido na
// mensagem do WhatsApp do cliente, com os valores e as condições. Sem
// página pública e sem token: o orçamento fica em aberto no painel até
// ela Aprovar (vira pedido) ou Fechar (encerra sem venda).
//
// Decisões do PO (28/09) que moram aqui:
//   - Desconto é SEMPRE da lojista, no orçamento. Sem definição = sem
//     desconto. Nada vem da configuração da loja (pix_discount_pct do
//     canal digital NÃO entra) e nada é empilhado por conta própria.
//   - O vídeo fica guardado 30 dias; "Manter por mais 30 dias" prorroga.
// ============================================================
'use strict';

const { descontoDoPix } = require('./precoDoStudio');

/** Por quantos dias o vídeo fica guardado a cada gravação ou prorrogação. */
const DIAS_DO_VIDEO = 30;
/** Teto da prorrogação, contado de hoje: o vídeo não vira arquivo morto. */
const TETO_DIAS_DO_VIDEO = 365;
const DIA_MS = 86400000;

const TIPOS_DE_VIDEO = ['video/mp4', 'video/webm'];
const FORMATOS = ['mp4-webcodecs', 'mp4-mediarecorder', 'webm'];
const CANAIS = ['compartilhar', 'whatsapp', 'baixar', 'copiar'];

/** Status em que o orçamento ainda está "em aberto" para a lojista. */
const STATUS_ABERTOS = ['draft', 'sent'];

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Lê as condições que a lojista definiu. Campo vazio = condição ausente.
 * @returns {{ ok: true, condicoes: object } | { ok: false, erro: string }}
 */
function lerCondicoes(body) {
  const b = body || {};
  const pix = numero(b.pix_desconto_pct);
  const parcelas = numero(b.parcelas);
  const prazo = numero(b.prazo_dias_uteis);
  const obs = b.observacao == null ? null : String(b.observacao).trim();

  if (Number.isNaN(pix) || (pix !== null && (pix <= 0 || pix > 50))) {
    return { ok: false, erro: 'Desconto no Pix deve ficar entre 0,1% e 50%' };
  }
  if (Number.isNaN(parcelas) || (parcelas !== null && (!Number.isInteger(parcelas) || parcelas < 2 || parcelas > 12))) {
    return { ok: false, erro: 'Parcelas devem ser um número inteiro entre 2 e 12' };
  }
  if (Number.isNaN(prazo) || (prazo !== null && (!Number.isInteger(prazo) || prazo < 1 || prazo > 120))) {
    return { ok: false, erro: 'Prazo deve ser um número inteiro de 1 a 120 dias úteis' };
  }
  if (obs && obs.length > 280) {
    return { ok: false, erro: 'Observação com até 280 caracteres' };
  }

  return {
    ok: true,
    condicoes: {
      pix_desconto_pct: pix,
      parcelas,
      prazo_dias_uteis: prazo,
      observacao: obs || null,
    },
  };
}

/** Tamanho máximo do texto de "O que o cliente pediu". */
const LIMITE_DO_AJUSTE = 500;

/**
 * Lê o pedido de ajuste que a lojista registrou (texto obrigatório).
 * @returns {{ ok: true, texto: string } | { ok: false, erro: string }}
 */
function lerPedidoDeAjuste(body) {
  const texto = String((body && body.texto) || '').trim();
  if (!texto) return { ok: false, erro: 'Escreva o que o cliente pediu' };
  if (texto.length > LIMITE_DO_AJUSTE) {
    return { ok: false, erro: `O pedido deve ter até ${LIMITE_DO_AJUSTE} caracteres` };
  }
  return { ok: true, texto };
}

function reais(v) {
  return 'R$ ' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * As condições com os valores já calculados sobre o total do orçamento.
 * O Pix usa a regra canônica em centavos (precoDoStudio.descontoDoPix)
 * sobre o total que a lojista fechou no orçamento.
 */
function valoresDasCondicoes(quote) {
  const c = (quote && quote.condicoes) || {};
  const total = Number(quote && quote.total) || 0;
  const out = {};
  if (Number(c.pix_desconto_pct) > 0) {
    const desconto = descontoDoPix(total, c.pix_desconto_pct);
    out.pix = { pct: Number(c.pix_desconto_pct), valor: Math.round((total - desconto) * 100) / 100 };
  }
  if (Number(c.parcelas) >= 2) {
    const n = Number(c.parcelas);
    out.cartao = { parcelas: n, valor: Math.round((total / n) * 100) / 100 };
  }
  const sinal = Number(quote && quote.deposit_amount);
  if (sinal > 0) {
    out.sinal = { pct: quote.deposit_pct != null ? Number(quote.deposit_pct) : null, valor: sinal };
  }
  if (Number(c.prazo_dias_uteis) > 0) out.prazo = { dias_uteis: Number(c.prazo_dias_uteis) };
  if (c.observacao) out.observacao = String(c.observacao);
  return out;
}

/**
 * O texto que vai para as notas do pedido quando a lojista aprova: o
 * pedido nasce com o que foi combinado na conversa.
 */
function notasDoPedidoAprovado(quote) {
  const v = valoresDasCondicoes(quote);
  const linhas = [];
  if (v.pix) linhas.push(`Pix: ${reais(v.pix.valor)} (${String(v.pix.pct).replace('.', ',')}% de desconto)`);
  if (v.cartao) linhas.push(`Cartão: até ${v.cartao.parcelas}x de ${reais(v.cartao.valor)} sem juros`);
  if (v.sinal) linhas.push(`Sinal: ${reais(v.sinal.valor)}${v.sinal.pct != null ? ` (${String(v.sinal.pct).replace('.', ',')}%)` : ''}`);
  if (v.prazo) linhas.push(`Prazo: ${v.prazo.dias_uteis} dias úteis depois da aprovação da arte`);
  if (v.observacao) linhas.push(v.observacao);

  const base = quote && quote.notes ? String(quote.notes).trim() : '';
  if (!linhas.length) return base || null;
  const bloco = 'Condições combinadas no orçamento:\n' + linhas.map((l) => '• ' + l).join('\n');
  return base ? base + '\n\n' + bloco : bloco;
}

/** Nova data de expiração do vídeo: +30 dias a partir do que for maior, hoje ou a data atual, com teto. */
function novaExpiracao(atual, agora) {
  const hoje = agora instanceof Date ? agora : new Date(agora || Date.now());
  const base = atual ? new Date(atual) : null;
  const inicio = base && !Number.isNaN(base.getTime()) && base > hoje ? base : hoje;
  const proposta = new Date(inicio.getTime() + DIAS_DO_VIDEO * DIA_MS);
  const teto = new Date(hoje.getTime() + TETO_DIAS_DO_VIDEO * DIA_MS);
  return proposta > teto ? teto : proposta;
}

/**
 * Chave do vídeo no R2. Prefixo próprio (fora de `studio/<id>/…`) para uma
 * regra de ciclo de vida de segurança no bucket, se um dia for criada.
 */
function chaveDoVideo(companyId, quoteId, contentType, agora) {
  const ext = contentType === 'video/webm' ? 'webm' : 'mp4';
  const ts = (agora || Date.now());
  const rand = Math.random().toString(36).slice(2, 10);
  return `orcamento-video/${companyId}/${quoteId}/${ts}-${rand}.${ext}`;
}

module.exports = {
  DIAS_DO_VIDEO,
  TETO_DIAS_DO_VIDEO,
  TIPOS_DE_VIDEO,
  FORMATOS,
  CANAIS,
  STATUS_ABERTOS,
  LIMITE_DO_AJUSTE,
  lerCondicoes,
  lerPedidoDeAjuste,
  valoresDasCondicoes,
  notasDoPedidoAprovado,
  novaExpiracao,
  chaveDoVideo,
};
