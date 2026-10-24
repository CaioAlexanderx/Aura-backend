// ============================================================
// AURA. — Leitura das assinaturas na Asaas (13/10/2026)
//
// A Asaas é a fonte da verdade de duas coisas que o cadastro vinha
// adivinhando: quando vence a próxima cobrança e quanto cada loja paga.
//
// proximoVencimento() existe porque companies.next_billing_date era gravado
// com o dueDate da cobrança que acabou de ser PAGA (webhookAsaas.js) — a data
// ficava sempre um ciclo para trás. O próximo vencimento de verdade é:
//
//   0. com cobrança VENCIDA em aberto, o dueDate da mais antiga (tq-86);
//   1. o menor dueDate entre as cobranças PENDENTES da assinatura; ou,
//   2. sem pendente, o nextDueDate da assinatura.
//
// A ordem importa: a Asaas cria cada cobrança ~40 dias antes de vencer, e ao
// criar já empurra o nextDueDate para o ciclo seguinte. No mensal, logo depois
// de um pagamento, é comum existir a cobrança do mês que vem já pendente e o
// nextDueDate apontando para daqui a dois meses.
//
// Todas as funções recebem o cliente `asaas` (services/asaasClient) por
// parâmetro: quem chama decide a credencial, e o teste troca por um jest.fn.
// ============================================================
'use strict';

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const ehData = (v) => typeof v === 'string' && DATA.test(v);

// Quantos meses cobre cada ciclo de assinatura da Asaas.
const MESES_DO_CICLO = {
  WEEKLY: 12 / 52,
  BIWEEKLY: 12 / 26,
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  SEMIANNUALLY: 6,
  YEARLY: 12,
};

const assinaturaAtiva = (sub) => !!sub && !sub.deleted && (!sub.status || sub.status === 'ACTIVE');

// Próximo vencimento de uma assinatura. Devolve
//   { data, origem: 'cobranca_vencida' | 'cobranca_pendente' | 'assinatura', assinatura }
// ou null quando a Asaas não respondeu / a assinatura não tem próxima data.
// Nunca lança: quem chama trata null como "não sei — não gravar nada".
async function proximoVencimento(asaas, subscriptionId) {
  if (!subscriptionId) return null;
  let assinatura;
  try {
    assinatura = await asaas('GET', '/subscriptions/' + encodeURIComponent(subscriptionId));
  } catch (err) {
    console.error('[asaas] assinatura ' + subscriptionId + ' não pôde ser lida: ' + err.message);
    return null;
  }
  if (!assinatura || !assinatura.id) return null;

  let pendente = null;
  try {
    const lista = await asaas(
      'GET',
      '/subscriptions/' + encodeURIComponent(subscriptionId) + '/payments?status=PENDING&limit=100'
    );
    for (const p of (lista && Array.isArray(lista.data)) ? lista.data : []) {
      if (!p || p.deleted || p.status !== 'PENDING' || !ehData(p.dueDate)) continue;
      if (!pendente || p.dueDate < pendente) pendente = p.dueDate;
    }
  } catch (err) {
    // Sem a lista de cobranças ainda vale o nextDueDate da assinatura.
    console.warn('[asaas] cobranças da assinatura ' + subscriptionId + ' não puderam ser lidas: ' + err.message);
  }

  // tq-86 (24/10/2026): com cobrança VENCIDA em aberto, o próximo vencimento
  // é o dela (a mais antiga) — nunca a pendente seguinte. Foi o que a
  // correção de vencimentos fez com a MHT em 21/10 (20/10 vencida -> 20/11).
  // Se a lista de vencidas não vier, não dá para afirmar a data: null
  // ("não sei — não gravar"), e quem chama mantém a data atual.
  let vencida = null;
  try {
    const lista = await asaas(
      'GET',
      '/subscriptions/' + encodeURIComponent(subscriptionId) + '/payments?status=OVERDUE&limit=100'
    );
    for (const p of (lista && Array.isArray(lista.data)) ? lista.data : []) {
      if (!p || p.deleted || p.status !== 'OVERDUE' || !ehData(p.dueDate)) continue;
      if (!vencida || p.dueDate < vencida) vencida = p.dueDate;
    }
  } catch (err) {
    console.warn('[asaas] cobranças vencidas da assinatura ' + subscriptionId + ' não puderam ser lidas: ' + err.message);
    return null;
  }
  if (vencida) return { data: vencida, origem: 'cobranca_vencida', assinatura };

  const proxima = ehData(assinatura.nextDueDate) ? assinatura.nextDueDate : null;
  if (pendente && (!proxima || pendente <= proxima)) {
    return { data: pendente, origem: 'cobranca_pendente', assinatura };
  }
  if (proxima) return { data: proxima, origem: 'assinatura', assinatura };
  return null;
}

// Todas as assinaturas ativas da conta, página a página. Lança se alguma
// página falhar: meia lista viraria um MRR errado sem ninguém perceber.
async function listarAssinaturasAtivas(asaas, { porPagina = 100, maxPaginas = 50 } = {}) {
  const todas = [];
  for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
    const r = await asaas('GET', `/subscriptions?status=ACTIVE&limit=${porPagina}&offset=${pagina * porPagina}`);
    const dados = (r && Array.isArray(r.data)) ? r.data : null;
    if (!dados) throw new Error('Resposta inesperada da Asaas ao listar assinaturas');
    todas.push(...dados.filter((s) => s && !s.deleted));
    if (!r.hasMore || !dados.length) return todas;
  }
  throw new Error(`Asaas devolveu mais de ${maxPaginas} páginas de assinaturas`);
}

module.exports = {
  ehData,
  MESES_DO_CICLO,
  assinaturaAtiva,
  proximoVencimento,
  listarAssinaturasAtivas,
};
