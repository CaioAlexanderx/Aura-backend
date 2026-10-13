// ============================================================
// AURA. — Temporada de fim de ano: constantes e regras de data (13/10/2026)
//
// FONTE UNICA das datas do assento de temporada. Quem precisar saber "ate
// quando vale" ou "ainda da pra contratar" pergunta aqui; nenhuma outra
// parte do codigo escreve 2026-11-01 / 2027-01-31 na mao.
//
// Para a temporada seguinte: trocar id/nome/starts_at/ends_at. Os passes ja
// gravados guardam as proprias datas (seat_passes.starts_at/ends_at), entao
// mudar a constante nao reescreve o que foi contratado.
//
// So funcoes puras (sem banco): o servico seatPass.js usa estas regras.
// ============================================================
'use strict';

const { todayBrt } = require('./subscriptionDiscount');
const { SEAT_PRICE_BRL } = require('./memberSeats');

const TEMPORADA = Object.freeze({
  id: '2026-2027',
  nome: 'Temporada de fim de ano 2026/27',
  starts_at: '2026-11-01',
  ends_at: '2027-01-31',
});

// Teto de assentos de passe ativos por empresa. A loja dona pede ate este
// numero; a Gestao Aura pode conceder ate o teto do admin.
const LIMITE_POR_LOJA = 10;
const LIMITE_ADMIN = 50;

function brl(v) {
  return 'R$ ' + (Math.round(Number(v) * 100) / 100).toFixed(2).replace('.', ',');
}

function dataBr(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// Quantos meses-calendario o intervalo toca (01/11 a 31/01 = 3). E o teto de
// mensalidades que levam o assento: cada mensalidade da assinatura que vence
// dentro da validade sai com +R$ 19 por assento.
function mensalidadesAteOFim(inicioIso, fimIso) {
  const [iy, im] = String(inicioIso).slice(0, 7).split('-').map(Number);
  const [fy, fm] = String(fimIso).slice(0, 7).split('-').map(Number);
  return Math.max((fy * 12 + fm) - (iy * 12 + im) + 1, 0);
}

// Em que condicoes um passe contratado HOJE valeria.
//   aberta=false  → passou do fim da temporada (nada a contratar)
//   aplica_agora  → hoje ja esta dentro da temporada: os assentos entram ja
//                   (senao ficam agendados e o job os aplica em starts_at)
function janelaDoPasse(hoje = todayBrt(), temporada = TEMPORADA) {
  if (hoje > temporada.ends_at) {
    return { aberta: false, motivo: 'temporada_encerrada', starts_at: null, ends_at: temporada.ends_at, aplica_agora: false };
  }
  const inicio = hoje > temporada.starts_at ? hoje : temporada.starts_at;
  return {
    aberta: true,
    motivo: null,
    starts_at: inicio,
    ends_at: temporada.ends_at,
    aplica_agora: inicio <= hoje,
  };
}

// O dia (YYYY-MM-DD) esta dentro da validade da temporada? Inclusivo nas duas
// pontas. Usado por quem so roda na temporada (placar do dia no WhatsApp).
function dentroDaTemporada(dia, temporada = TEMPORADA) {
  const d = String(dia || '').slice(0, 10);
  return d >= temporada.starts_at && d <= temporada.ends_at;
}

// O que sera cobrado e ate quando — texto pronto para a tela.
function descreverCobranca({ qty, starts_at, ends_at, cortesia = false, unitPrice = SEAT_PRICE_BRL }) {
  const n = Math.max(parseInt(qty, 10) || 0, 0);
  const meses = mensalidadesAteOFim(starts_at, ends_at);
  const ate = dataBr(ends_at);
  const de = dataBr(starts_at);
  const unit = cortesia ? 0 : unitPrice;
  const mensal = Math.round(unit * n * 100) / 100;
  const maximo = Math.round(mensal * meses * 100) / 100;
  const plural = n === 1 ? 'assento' : 'assentos';

  const texto = cortesia
    ? `Cortesia da Aura: ${n} ${plural} de temporada de ${de} a ${ate}, sem cobrança. No fim da validade o acesso extra expira sozinho.`
    : `${brl(mensal)} por mensalidade (${n} ${plural} × ${brl(unitPrice)}), somados à sua assinatura de ${de} a ${ate}`
      + (meses > 1 ? `: no máximo ${meses} mensalidades, ${brl(maximo)} no total.` : `: no máximo ${brl(maximo)} no total.`)
      + ` Depois de ${ate} o assento expira sozinho e o valor da assinatura volta ao normal.`;

  return {
    forma: cortesia ? 'cortesia' : 'assinatura_asaas',
    valor_unitario: unit,
    valor_mensal: mensal,
    mensalidades_ate_o_fim: meses,
    valor_maximo_total: maximo,
    de: starts_at,
    ate: ends_at,
    texto,
  };
}

module.exports = {
  TEMPORADA,
  LIMITE_POR_LOJA,
  LIMITE_ADMIN,
  janelaDoPasse,
  mensalidadesAteOFim,
  dentroDaTemporada,
  descreverCobranca,
  brl,
  dataBr,
};
