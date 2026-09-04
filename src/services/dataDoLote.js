// ============================================================
// AURA Studio — a data que a cliente digita no orçamento em lote
//
// ── O QUE ACONTECIA (QA de 04/09/2026) ─────────────────────────────────
// O campo "Para quando?" da vitrine sugere "Ex: 12/10/2026" — o jeito
// brasileiro de escrever data. O POST mandava o texto como veio para a
// coluna DATE do Postgres, que lê "20/09/2026" como mês 20 e estoura. A
// rota devolvia 500 e a tela dizia "Erro ao registrar o orcamento", sem
// dizer o quê: a noiva com 12 nomes colados perdia o pedido no último
// passo, e a lojista nunca ficava sabendo.
//
// ── A REGRA ────────────────────────────────────────────────────────────
// Aceita os dois jeitos — "20/09/2026" e "2026-09-20" — e devolve
// AAAA-MM-DD para o banco. O que não for data de verdade vira erro
// legível (400), nunca 500: quem errou foi a digitação, não o servidor.
// Campo vazio é opcional e passa como null.
// ============================================================
'use strict';

/** Os dias de cada mês; fevereiro decide pelo ano bissexto. */
function diasDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * Normaliza o texto de data para AAAA-MM-DD.
 *
 * Devolve `{ data }` (null quando vazio) ou `{ erro }` com a frase que a
 * tela mostra à cliente.
 */
function normalizarDataDoLote(bruto) {
  if (bruto == null) return { data: null };
  const s = String(bruto).trim();
  if (!s) return { data: null };

  let ano, mes, dia;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) { dia = +m[1]; mes = +m[2]; ano = +m[3]; }
  else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
    if (m) { ano = +m[1]; mes = +m[2]; dia = +m[3]; }
  }

  if (!m || mes < 1 || mes > 12 || dia < 1 || dia > diasDoMes(ano, mes)) {
    return { erro: 'Escreva a data como dia/mês/ano, por exemplo 12/10/2026.' };
  }
  const dd = String(dia).padStart(2, '0');
  const mm = String(mes).padStart(2, '0');
  return { data: `${ano}-${mm}-${dd}` };
}

module.exports = { normalizarDataDoLote };
