// ============================================================
// AURA. — Textos do prazo de cancelamento da nota (17/11/2026)
// Card b-troca-prazo-nfce. Textos NOVOS de tela, separados para o Caio
// aprovar antes do merge. Nenhum texto antigo foi apagado daqui: os que
// mudaram estão listados no PR.
//
// Tom: gentil, sem culpa, sempre com o caminho. Nada de "erro", "expirado"
// ou "regularização" para a lojista.
// ============================================================
'use strict';

/** "17/11 às 15:51" no fuso de São Paulo. */
function dataHoraCurta(d) {
  const f = (o) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...o });
  return `${f({ day: '2-digit', month: '2-digit' })} às ${f({ hour: '2-digit', minute: '2-digit' })}`;
}

function horaCurta(d) {
  return new Date(d).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

function rotulo(nota) {
  return nota && (nota.tipo === 'nfe' || nota.modelo === '55') ? 'NF-e' : 'NFC-e';
}

function numero(nota) {
  return nota && nota.numero ? ` nº ${nota.numero}` : '';
}

/** Duração legível: 30 → "30 minutos"; 1440 → "24 horas". */
function duracao(minutos) {
  if (minutos % 60 === 0 && minutos >= 60) {
    const h = minutos / 60;
    return `${h} ${h === 1 ? 'hora' : 'horas'}`;
  }
  return `${minutos} minutos`;
}

const TEXTOS_PRAZO_NFCE = Object.freeze({
  // POST /nfce/:id/cancel — NFC-e fora do prazo (antes: "Prazo de cancelamento
  // expirado (30 min após a autorização, regra SEFAZ-SP). Fale com seu
  // contador sobre regularização.").
  cancelarForaDoPrazo: (prazo) =>
    `O prazo para cancelar esta NFC-e já passou: a SEFAZ aceita o cancelamento até ${duracao(prazo.minutos)} depois da autorização`
    + (prazo.ate ? ` (esta venceu em ${dataHoraCurta(prazo.ate)})` : '')
    + '. Se o produto voltou para a loja, faça a devolução pelo Caixa, em Trocar: a NF-e de devolução sai junto.',

  // Motivo que vai para a SEFAZ (xJust, 15 a 255 caracteres) quando a nota é
  // cancelada junto com a venda.
  motivoDaNotaNaVendaCancelada: (reason) => {
    const r = String(reason || '').trim();
    return (`Venda cancelada pela loja${r ? ': ' + r : ''}`).slice(0, 255);
  },

  // Cancelar venda: a nota foi cancelada junto.
  vendaENotaCanceladas: (nota) => `A ${rotulo(nota)}${numero(nota)} também foi cancelada na SEFAZ.`,

  // Cancelar venda: a lojista pediu, mas a SEFAZ não cancelou a nota.
  notaNaoCancelada: (nota, motivo) =>
    `A venda foi cancelada, mas a SEFAZ não cancelou a ${rotulo(nota)}${numero(nota)} agora`
    + (motivo ? ` (${motivo})` : '')
    + '. A nota continua autorizada. Dá para tentar de novo em Notas fiscais enquanto o prazo vale; depois dele, o caminho é a NF-e de devolução.',

  // Cancelar venda: dentro do prazo, a lojista escolheu manter a nota.
  notaMantidaNoPrazo: (nota, prazo) =>
    `A ${rotulo(nota)}${numero(nota)} continua autorizada.`
    + (prazo && prazo.ate ? ` Se precisar, ainda dá para cancelá-la em Notas fiscais até ${horaCurta(prazo.ate)}.` : ''),

  // Cancelar venda: fora do prazo — a venda cancela, a nota fica.
  notaForaDoPrazo: (nota, prazo) =>
    `A ${rotulo(nota)}${numero(nota)} já passou do prazo de cancelamento (${duracao(prazo.minutos)} depois da autorização) e continua autorizada.`
    + ' Se o produto voltou para a loja, a devolução pelo Caixa, em Trocar, emite a NF-e de devolução.',
});

module.exports = { TEXTOS_PRAZO_NFCE, dataHoraCurta, horaCurta, duracao };
