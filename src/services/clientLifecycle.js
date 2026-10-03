// ============================================================
// AURA. — Etapa da conta no ciclo de vida (Gestão Aura)
//
// companies.billing_status fica 'trial' para sempre: nada o muda quando
// trial_ends_at passa (o app calcula o vencimento na hora e manda o dono
// para o checkout). Para a Gestão Aura isso junta, no mesmo rótulo, quem
// acabou de se cadastrar, quem venceu ontem e quem nunca aderiu.
//
// A etapa é CALCULADA aqui, só para leitura do admin — billing_status não
// é tocado, porque o gate do app e o checkout dependem dele.
//
//   interno  — sandbox, conta de teste ou empresa da própria Aura
//   cliente  — assinatura ativa, pendente ou em atraso
//   trial    — dentro do prazo de teste
//   vencido  — prazo acabou há até RECOVERY_WINDOW_DAYS dias (recuperável)
//   arquivo  — não aderiu, cancelou ou foi desativada
// ============================================================

const DAY_MS = 86400000;
const RECOVERY_WINDOW_DAYS = 14;

function isInternal(c) {
  if (c.is_sandbox === true || c.owner_is_staff === true) return true;
  const name = String(c.trade_name || c.legal_name || '').trim().toUpperCase();
  return name.startsWith('[TESTE]');
}

function classifyLifecycle(c, now = new Date()) {
  const nowMs = now.getTime();
  const endsMs = c.trial_ends_at ? new Date(c.trial_ends_at).getTime() : null;
  const base = { stage: 'arquivo', archive_reason: null, trial_days_left: null, days_since_expiry: null };

  if (isInternal(c)) return { ...base, stage: 'interno' };
  if (c.is_active === false) return { ...base, archive_reason: 'inativo' };
  if (c.billing_status === 'cancelled') return { ...base, archive_reason: 'cancelado' };
  if (['active', 'pending', 'overdue'].includes(c.billing_status)) return { ...base, stage: 'cliente' };

  if (endsMs !== null && endsMs > nowMs) {
    return { ...base, stage: 'trial', trial_days_left: Math.ceil((endsMs - nowMs) / DAY_MS) };
  }

  // Sem trial_ends_at o app já manda direto ao checkout: conta o prazo a
  // partir do cadastro.
  const refMs = endsMs !== null ? endsMs : new Date(c.created_at).getTime();
  const since = Math.max(0, Math.floor((nowMs - refMs) / DAY_MS));
  if (since <= RECOVERY_WINDOW_DAYS) return { ...base, stage: 'vencido', days_since_expiry: since };
  return { ...base, archive_reason: 'nao_aderiu', days_since_expiry: since };
}

module.exports = { classifyLifecycle, RECOVERY_WINDOW_DAYS };
