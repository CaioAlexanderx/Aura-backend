// ============================================================
// AURA. — Oferta "vamos configurar juntos" (18/10/2026, card f2-04)
//
// Depois do check-in, o Painel mostra um cartão discreto: "Quer configurar
// junto com a gente? Uma conversa de 20 minutos para deixar o Caixa e o
// estoque prontos." com o botão "Marcar pelo WhatsApp" (o app abre o wa.me
// com o texto pronto) e "Agora não". O Caio faz o onboarding pessoalmente
// (decisão de 15/09); o painel mede quantos cadastros pedem a conversa.
//
// Funções puras: nada aqui fala com o banco. A rota é routes/onboardingSetupCall.js.
//
// ESTADO sem migration: vive em audit_log (company_id + action), uma linha por
// ação e por empresa. É também o que o painel conta.
//
//   onboarding.setup_call_shown       a oferta foi mostrada (1a vez)
//   onboarding.setup_call_requested   tocou em "Marcar pelo WhatsApp"
//   onboarding.setup_call_dismissed   tocou em "Agora não"
//
// QUEM VÊ (disponivel === true):
//   - interruptor ligado (SETUP_CALL_ENABLED, padrão ligado);
//   - não é staff (modo admin);
//   - não é filial de dono antigo, nem sede/dojô da federação (mesma regra do
//     check-in: services/checkin.sqlForaDoCheckin) — a oferta é do cadastro novo;
//   - cadastro de até 15 dias (o teto do trial, services/trialRegra.TETO_DIAS):
//     "acabou de se cadastrar", não conta antiga;
//   - não assina: sem billing_status 'active' e sem assinatura na Asaas;
//   - não pediu nem dispensou.
// ============================================================
'use strict';

const ACAO_EXIBIDA = 'onboarding.setup_call_shown';
const ACAO_SOLICITADA = 'onboarding.setup_call_requested';
const ACAO_DISPENSADA = 'onboarding.setup_call_dismissed';

// Corpo do POST: o que a pessoa tocou -> o evento que fica no audit_log.
const ACOES_DO_CLIQUE = Object.freeze({
  solicitou: ACAO_SOLICITADA,
  dispensou: ACAO_DISPENSADA,
});

// Igual ao teto do trial do self-service (services/trialRegra.TETO_DIAS).
const JANELA_DIAS = 15;
const DIA_MS = 86400000;

const DESLIGADO = new Set(['false', '0', 'off', 'no', 'nao', 'não']);

function ligado(env = process.env) {
  const v = env.SETUP_CALL_ENABLED;
  if (v === undefined || v === null || String(v).trim() === '') return true;
  return !DESLIGADO.has(String(v).trim().toLowerCase());
}

// Verdadeiro quando a empresa já é cliente pagante.
function assina(empresa) {
  if (!empresa) return false;
  return String(empresa.billing_status || '').toLowerCase() === 'active' || !!empresa.asaas_subscription_id;
}

function dentroDaJanela(createdAt, agora = new Date()) {
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  return new Date(agora).getTime() - t <= JANELA_DIAS * DIA_MS;
}

// Por que a oferta NÃO vale para esta empresa (perfil, sem olhar o que ela já
// fez com o cartão). null = vale. A rota usa isto também no POST.
function motivoDeFora({ empresa, staff = false, agora = new Date(), env = process.env }) {
  if (!ligado(env)) return 'desligado';
  if (staff) return 'staff';
  if (!empresa) return 'sem_empresa';
  if (empresa.fora) return 'fora';
  if (assina(empresa)) return 'assina';
  if (!dentroDaJanela(empresa.created_at, agora)) return 'antiga';
  return null;
}

// Estado que o cartão do Painel lê:
//   { disponivel, solicitado, dispensado }
// `empresa` = { created_at, billing_status, asaas_subscription_id, fora,
//               solicitado, dispensado } (booleans vindos de EXISTS no audit_log).
function estado({ empresa, staff = false, agora = new Date(), env = process.env }) {
  const solicitado = !!(empresa && empresa.solicitado);
  const dispensado = !!(empresa && empresa.dispensado);
  const fora = motivoDeFora({ empresa, staff, agora, env });
  return {
    disponivel: fora === null && !solicitado && !dispensado,
    solicitado,
    dispensado,
  };
}

// Valida o corpo do POST. Devolve { erro } ou { acao } (nome do evento).
function normalizarClique(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { erro: 'Corpo inválido: envie { "acao": "solicitou" } ou { "acao": "dispensou" }.' };
  }
  const evento = typeof body.acao === 'string' ? ACOES_DO_CLIQUE[body.acao] : undefined;
  if (!evento) return { erro: 'acao deve ser "solicitou" ou "dispensou".' };
  return { acao: evento };
}

module.exports = {
  ACAO_EXIBIDA,
  ACAO_SOLICITADA,
  ACAO_DISPENSADA,
  ACOES_DO_CLIQUE,
  JANELA_DIAS,
  ligado,
  assina,
  dentroDaJanela,
  motivoDeFora,
  estado,
  normalizarClique,
};
