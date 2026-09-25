// ============================================================
// AURA. — "Pedidos pela loja": o que o painel grava (BE-3, 25/09/2026)
//
// A vitrine ja sabia fechar para pedidos (modoDaLoja, migration 321),
// oferecer retirada por app (courierPickup, migration 288) e carregar
// GA4 e Pixel (rastreadores.js) — mas nenhum desses campos tinha rota de
// escrita: a Sheid nao conseguia encerrar o Natal pela loja, e os IDs de
// rastreio so entravam pelo banco.
//
// Aqui mora a validacao, pura e testavel. O PUT de routes/digitalChannel.js
// chama `sanitizarPedidosPelaLoja(req.body)` ANTES de gravar qualquer
// coisa: campo invalido devolve 400 e nada e salvo pela metade.
// ============================================================
'use strict';

const { idGa4, idPixel } = require('./rastreadores');

/** O recado aparece na vitrine inteira; 280 cabe em duas linhas do celular. */
const RECADO_MAX = 280;

/**
 * As colunas que este modulo escreve, na ordem em que o PUT grava.
 * `pedidos_recado` e da migration 355; as outras ja existem.
 */
const COLUNAS = [
  'pedidos_pausados', 'pedidos_ate', 'pedidos_recado',
  'courier_pickup_enabled', 'ga4_measurement_id', 'meta_pixel_id',
];

/**
 * Interruptor: so booleano (ou o texto "true"/"false" de um form). Um
 * `1` ou `"sim"` e erro de quem chamou, nao uma escolha da lojista — e
 * fechar a loja por engano custa venda.
 */
function lerBooleano(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

/** AAAA-MM-DD que existe no calendario (30/02 nao passa). */
function dataValida(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * Valida e normaliza os campos de "Pedidos pela loja" do corpo do PUT.
 *
 * Devolve `{ erro }` (mensagem em portugues, pronta para a lojista) ou
 * `{ campos }` — so as colunas que vieram no corpo, ja no formato do
 * banco. Campo ausente nao entra: o painel manda so o que mudou, e
 * gravar `false` num interruptor que nao veio fecharia/abriria a loja
 * sem ninguem pedir.
 *
 * Texto vazio LIMPA (vira null) nos quatro campos de texto: e assim que
 * a lojista tira a data limite, apaga o recado ou desliga um rastreador.
 */
function sanitizarPedidosPelaLoja(body) {
  const b = body || {};
  const campos = {};

  for (const col of ['pedidos_pausados', 'courier_pickup_enabled']) {
    if (b[col] === undefined) continue;
    const v = lerBooleano(b[col]);
    if (v === undefined) return { erro: `${col} deve ser verdadeiro ou falso.` };
    campos[col] = v;
  }

  if (b.pedidos_ate !== undefined) {
    const s = b.pedidos_ate === null ? '' : String(b.pedidos_ate).trim();
    if (!s) campos.pedidos_ate = null;
    // Data no passado e aceita de proposito: o painel reenvia o formulario
    // inteiro, e depois do Natal a data antiga continua la. Recusar faria a
    // lojista nao conseguir salvar mais nada. A vitrine ja trata data
    // vencida como loja fechada (modoDaLoja).
    else if (dataValida(s)) campos.pedidos_ate = s;
    else return { erro: 'Data limite inválida. Use o formato AAAA-MM-DD (ex.: 2026-12-20).' };
  }

  if (b.pedidos_recado !== undefined) {
    if (b.pedidos_recado !== null && typeof b.pedidos_recado !== 'string') {
      return { erro: 'O recado para o cliente deve ser um texto.' };
    }
    // Caractere de controle nao tem o que fazer num recado; a quebra de
    // linha fica.
    const t = String(b.pedidos_recado || '').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
    // Recusar em vez de cortar: cortado, o recado para no meio da frase
    // na vitrine e a lojista so descobre pelo cliente.
    if (t.length > RECADO_MAX) {
      return { erro: `O recado para o cliente pode ter até ${RECADO_MAX} caracteres (tem ${t.length}).` };
    }
    campos.pedidos_recado = t || null;
  }

  // GA4 e Pixel: as MESMAS funcoes que a vitrine usa para decidir o que
  // injetar. Se o painel aceitasse um formato que a vitrine descarta, a
  // lojista salvaria, veria "salvo" e o Google nunca receberia visita.
  if (b.ga4_measurement_id !== undefined) {
    const s = String(b.ga4_measurement_id == null ? '' : b.ga4_measurement_id).trim();
    if (!s) campos.ga4_measurement_id = null;
    else {
      const id = idGa4(s);
      if (!id) return { erro: 'ID do Google Analytics inválido. O formato é G- seguido de 6 a 14 letras ou números (ex.: G-8Q3FQ2N1KM).' };
      campos.ga4_measurement_id = id;
    }
  }
  if (b.meta_pixel_id !== undefined) {
    const s = String(b.meta_pixel_id == null ? '' : b.meta_pixel_id).trim();
    if (!s) campos.meta_pixel_id = null;
    else {
      const id = idPixel(s);
      if (!id) return { erro: 'ID do Pixel da Meta inválido. O Pixel tem 15 ou 16 números, sem letras nem espaços.' };
      campos.meta_pixel_id = id;
    }
  }

  return { campos };
}

module.exports = { sanitizarPedidosPelaLoja, COLUNAS, RECADO_MAX };
