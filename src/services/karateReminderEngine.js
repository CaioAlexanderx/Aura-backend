// ============================================================
// AURA KARATÊ — Motor da régua de anuidade (Track I)
// NÚCLEO PURO (sem DB): decide qual lembrete (se algum) disparar HOJE para
// uma anuidade, a partir do vencimento (due_date) + offsets configurados +
// o que já foi enviado.
//
// Offsets em dias relativos ao due_date: negativo=antes, positivo=depois.
// Dispara no máximo 1 lembrete por execução: o estágio mais avançado já
// atingido; se esse estágio já foi enviado, não envia nada (sem backfill de
// estágios anteriores, sem rajada no primeiro run).
// ============================================================
'use strict';

const DEFAULT_OFFSETS = [-7, -1, 3, 15, 30];

function ruleCode(offset) {
  if (offset < 0) return `due_minus_${Math.abs(offset)}`;
  if (offset > 0) return `overdue_${offset}`;
  return 'due_day';
}

// Dias inteiros entre duas datas (b - a), normalizado à meia-noite UTC — estável
// para colunas DATE (sem efeito de hora/timezone).
function daysDiff(a, b) {
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((db - da) / 86400000);
}

// computeReminder({ dueDate, today, paidAt, status, offsets, sentCodes })
//   -> { code, offset } | null
function computeReminder(opts) {
  const { dueDate, today, paidAt, status, offsets, sentCodes } = opts || {};
  if (!dueDate) return null;
  if (paidAt || status === 'paid') return null;
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) return null;
  const now = today ? new Date(today) : new Date();
  if (isNaN(now.getTime())) return null;

  const sent = new Set(sentCodes || []);
  const offs = (Array.isArray(offsets) && offsets.length ? offsets : DEFAULT_OFFSETS)
    .slice()
    .sort((a, b) => a - b);

  const elapsed = daysDiff(due, now); // dias desde o vencimento (negativo = antes)

  // estágio mais avançado cujo gatilho já chegou
  let mostAdvanced = null;
  for (const off of offs) {
    if (elapsed >= off) mostAdvanced = off;
  }
  if (mostAdvanced === null) return null;         // nenhum gatilho ainda
  const code = ruleCode(mostAdvanced);
  if (sent.has(code)) return null;                // estágio atual já enviado
  return { code, offset: mostAdvanced };
}

module.exports = { DEFAULT_OFFSETS, ruleCode, daysDiff, computeReminder };
