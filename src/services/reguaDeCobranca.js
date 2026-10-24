// ============================================================
// AURA. — Régua de cobrança da assinatura Aura (24/10/2026)
//
// tq-77: lembrete 2 dias antes (2.1) e no dia (2.2), só para quem paga por
//        Pix/boleto (cartão debita sozinho), com o Pix da cobrança.
// tq-78: atraso de 1, 3 e 7 dias (2.3, 2.4, 2.5), contados do vencimento,
//        e aviso no sino interno da Aura no dia 3.
// tq-93: "Seu Caixa pausa em 3 dias" no dia 11 (2.9) e "Caixa pausado" no
//        dia 14 (2.10).
// tq-84: a nova tentativa no cartão, 24 h depois da recusa, uma vez só —
//        atrás de ASAAS_RETENTATIVA_CARTAO_ENABLED (padrão DESLIGADO).
//
// Uma volta diária (9h de Brasília, jobs/reguaDeCobrancaJob.js):
//   1. varredura: lista na Asaas as cobranças PENDENTES que vencem de hoje
//      a +2 dias e grava no espelho (assinatura_cobrancas). Pega a cobrança
//      criada antes deste código ou cujo PAYMENT_CREATED se perdeu;
//   2. lembretes e 3. régua de atraso, a partir do espelho.
//
// Segurança dos envios:
//   - idempotência pelo email_log (chave por cobrança e etapa): dois ticks,
//     reinício ou duas instâncias não repetem e-mail;
//   - nada retroativo: cada etapa só sai no dia exato, com no máximo 1 dia
//     de recuperação quando o texto continua verdadeiro ("vence hoje" e
//     "Caixa pausado hoje" não têm recuperação);
//   - antes de cada e-mail a cobrança é relida na Asaas: paga, apagada ou
//     estornada não recebe cobrança (e o espelho é corrigido). Asaas fora do
//     ar = não envia nesta volta;
//   - atraso só para empresa ainda 'overdue' e só pela cobrança vencida mais
//     antiga (é dela que contam as pausas, a mesma data do /auth/me);
//   - fora: conta interna, sandbox, inativa, Karatê/dojô (destinatarioDaEmpresa);
//   - multi-CNPJ: a cobrança é da empresa que a tem na Asaas (matriz); as
//     filiais herdam o status e não recebem cópia.
//
// O banner do sino do cliente continua só com o lembreteDeFatura
// (invoice_reminders), que é uma agenda manual de banners: esta régua não
// publica banner, então não há banner em dobro. Cobrança com linha em
// invoice_reminders e send_email=true já recebe o e-mail de lá e fica fora
// dos lembretes daqui.
// ============================================================
'use strict';

const conteudos = require('./emailsCobranca');
const L = require('./emailLayout');
const C = require('./cobrancaAssinatura');
const { reservarEnvio, marcarFalha } = require('./emailLog');

// Empresa da equipe Aura que recebe os avisos internos no sino (a mesma de
// invoice_reminders.alert_company_id, migration 367).
const ALERTA_COMPANY_ID_PADRAO = '645c1325-8865-48be-af6f-430d93fb2b6c';

const PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const EM_ABERTO = new Set(['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS']);

// Etapas do atraso: dias desde o vencimento -> etapa. Cada etapa tem o dia
// exato e, quando o texto aguenta, o dia seguinte como recuperação.
const ETAPAS_ATRASO = [
  { dias: [1, 2], tipo: 'cobranca_atraso_1', chave: 'atraso-1', montar: 'atrasoUmDia' },
  { dias: [3, 4], tipo: 'cobranca_atraso_3', chave: 'atraso-3', montar: 'atrasoTresDias', alertaInterno: true },
  { dias: [7, 8], tipo: 'cobranca_atraso_7', chave: 'atraso-7', montar: 'atrasoSeteDias' },
  { dias: [11, 12], tipo: 'cobranca_caixa_pausa_em_3', chave: 'caixa-pausa-3', montar: 'caixaPausaEmDias' },
  { dias: [14], tipo: 'cobranca_caixa_pausado', chave: 'caixa-pausado', montar: 'caixaPausado' },
];

function etapaDoAtraso(dias) {
  return ETAPAS_ATRASO.find((e) => e.dias.includes(dias)) || null;
}

/** Lembrete: 2 dias antes (com 1 de recuperação) ou no dia. */
function etapaDoLembrete(diasParaVencer) {
  if (diasParaVencer === 2 || diasParaVencer === 1) {
    return { tipo: 'cobranca_lembrete_2_dias', chave: 'lembrete-2-dias', montar: 'lembreteDoisDias' };
  }
  if (diasParaVencer === 0) return { tipo: 'cobranca_vence_hoje', chave: 'vence-hoje', montar: 'venceHoje' };
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ehCobrancaDaAssinatura(p) {
  const ref = String((p && p.externalReference) || '');
  return !ref.startsWith('digital-order-') && !ref.startsWith('wa-pack-');
}

async function empresaDaCobranca(db, payment) {
  const ref = String(payment.externalReference || '');
  const r = await db.query(
    `SELECT id FROM companies WHERE asaas_customer_id = $1 OR id = $2
      ORDER BY (asaas_customer_id = $1) DESC NULLS LAST LIMIT 1`,
    [payment.customer || null, UUID_RE.test(ref) ? ref : null]
  );
  return (r && r.rows && r.rows[0] && r.rows[0].id) || null;
}

// ── 1. Varredura das pendentes ──────────────────────────────────
async function varrerPendentes({ db, asaas, hoje, summary, maxPaginas = 10 }) {
  const ate = C.somarDias(hoje, 2);
  for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
    const r = await asaas('GET', `/payments?status=PENDING&dueDate%5Bge%5D=${hoje}&dueDate%5Ble%5D=${ate}&limit=100&offset=${pagina * 100}`);
    const lista = (r && Array.isArray(r.data)) ? r.data : [];
    for (const p of lista) {
      if (!p || !p.id || p.deleted || !ehCobrancaDaAssinatura(p)) continue;
      const companyId = await empresaDaCobranca(db, p);
      if (!companyId) continue;
      await C.registrarCobranca(db, { companyId, payment: p, estado: 'PENDING', origem: 'varredura' });
      summary.varridas++;
    }
    if (!r || !r.hasMore || !lista.length) return;
  }
}

// Relê a cobrança na Asaas e corrige o espelho. Devolve o pagamento quando
// ainda está em aberto; null quando não deve receber cobrança.
async function cobrancaAindaEmAberto({ db, asaas, linha }) {
  const p = await asaas('GET', '/payments/' + encodeURIComponent(linha.asaas_payment_id));
  if (!p || !p.id) return null;
  if (p.deleted) {
    await C.registrarCobranca(db, { companyId: linha.company_id, payment: { ...p, dueDate: p.dueDate || linha.due_iso }, estado: 'DELETED', origem: 'regua' });
    return null;
  }
  if (PAGO.has(p.status)) {
    await C.registrarCobranca(db, { companyId: linha.company_id, payment: { ...p, dueDate: p.dueDate || linha.due_iso }, estado: 'PAID', origem: 'regua' });
    return null;
  }
  if (!EM_ABERTO.has(p.status)) return null;
  return p;
}

// Lê a cobrança na Asaas antes do e-mail. Se a leitura falhar, NÃO envia
// com valor de outra fonte (regra do Caio, 24/10): registra a chave como
// 'failed' no email_log ("valor indisponível") e a próxima volta tenta de
// novo (linha 'failed' pode ser reservada outra vez).
async function lerOuAdiar({ db, asaas, linha, chave, tipo, destino, summary }) {
  try {
    return await cobrancaAindaEmAberto({ db, asaas, linha });
  } catch (err) {
    summary.adiados++;
    console.warn(`[reguaCobranca] cobrança ${linha.asaas_payment_id} não pôde ser lida na Asaas; e-mail adiado: ${err.message}`);
    if (destino && destino.email) {
      try {
        const id = await reservarEnvio(db, {
          chave, tipo, companyId: destino.companyId, userId: destino.userId, destinatario: destino.email,
          metadata: { asaas_payment_id: linha.asaas_payment_id, adiado: true },
        });
        if (id) await marcarFalha(db, id, 'adiado: valor da cobrança indisponível na Asaas (' + err.message + ')');
      } catch (e) {
        console.error('[reguaCobranca] registro do adiamento falhou: ' + e.message);
      }
    }
    return null;
  }
}

function valorAlerta(p, hoje) {
  const v = conteudos.valorParaEmail(p, { situacao: 'aberta', hoje });
  return v ? ` de ${L.brl(v.valor)}` : '';
}

async function temLembreteAntigoComEmail(db, paymentId) {
  try {
    const r = await db.query(
      `SELECT 1 FROM invoice_reminders WHERE asaas_payment_id = $1 AND send_email = true LIMIT 1`,
      [paymentId]
    );
    return !!(r && r.rows && r.rows.length);
  } catch (err) {
    return false; // 42P01: sem a tabela, não há lembrete antigo
  }
}

// ── 2. Lembretes (tq-77) ────────────────────────────────────────
async function processarLembretes({ db, asaas, enviar, hoje, summary }) {
  const { rows } = await db.query(
    `SELECT o.*, to_char(o.due_date, 'YYYY-MM-DD') AS due_iso
       FROM assinatura_cobrancas o
      WHERE o.status = 'PENDING'
        AND o.due_date BETWEEN $1::date AND ($1::date + 2)
        AND o.billing_type IS DISTINCT FROM 'CREDIT_CARD'
      ORDER BY o.due_date, o.asaas_payment_id`,
    [hoje]
  );
  for (const linha of rows || []) {
    try {
      const etapa = etapaDoLembrete(C.diasEntre(linha.due_iso, hoje));
      if (!etapa) continue;
      if (await temLembreteAntigoComEmail(db, linha.asaas_payment_id)) { summary.ignorados++; continue; }
      const destino = await C.destinatarioDaEmpresa(db, linha.company_id);
      if (!destino || !destino.email) { summary.ignorados++; continue; }
      const chave = `${etapa.chave}:${linha.asaas_payment_id}`;
      const p = await lerOuAdiar({ db, asaas, linha, chave, tipo: etapa.tipo, destino, summary });
      if (!p) { summary.ignorados++; continue; }
      if (String(p.billingType || '').toUpperCase() === 'CREDIT_CARD') { summary.ignorados++; continue; }
      const venc = String(p.dueDate || linha.due_iso).slice(0, 10);
      // O vencimento pode ter mudado na Asaas: a etapa vale pela data de lá.
      const etapaReal = etapaDoLembrete(C.diasEntre(venc, hoje));
      if (!etapaReal || etapaReal.chave !== etapa.chave) { summary.ignorados++; continue; }
      const pix = await C.pixDaCobranca(asaas, linha.asaas_payment_id);
      // Valor: o da cobrança relida agora na Asaas (nunca o do espelho).
      const v = conteudos.valorParaEmail(p, { situacao: 'aberta', hoje });
      const conteudo = conteudos[etapa.montar]({
        nome: destino.nome, loja: destino.loja, valor: v ? v.valor : null, comJuros: !!(v && v.comJuros),
        vencimento: venc, pix, linkFatura: C.linkDaFatura(p, linha),
      });
      const r = await C.enviarCobranca({
        db, enviar, tipo: etapa.tipo, chave, destino, conteudo,
        metadata: { asaas_payment_id: linha.asaas_payment_id, vencimento: venc, com_pix: !!pix, valor: v ? v.valor : null },
      });
      if (r.status === 'sent') summary.emails++;
    } catch (err) {
      summary.falhas++;
      console.error(`[reguaCobranca] lembrete ${linha.asaas_payment_id}: ${err.message}`);
    }
  }
}

// ── 3. Atraso (tq-78, tq-93) ────────────────────────────────────
async function alertarAura({ notifications, alertaCompanyId, destino, linha, p, dias, hoje }) {
  if (!notifications || !alertaCompanyId) return false;
  const venc = String(p.dueDate || linha.due_iso).slice(0, 10);
  const r = await notifications.notifyCompany(alertaCompanyId, {
    title: `Mensalidade em atraso há ${dias} dias: ${destino.loja}`,
    body: `A mensalidade${valorAlerta(p, hoje)} venceu em ${L.dataLonga(venc)} ` +
      `e segue em aberto. As outras telas pausam em ${L.dataLonga(C.somarDias(venc, C.DIAS_ATE_PAUSA_TELAS))} ` +
      `e o Caixa em ${L.dataLonga(C.somarDias(venc, C.DIAS_ATE_PAUSA_CAIXA))}. ` +
      (destino.email ? 'O e-mail do 3º dia vai para o dono.' : 'A empresa não tem e-mail no cadastro.') +
      ' Hora de falar pessoalmente (entre o 3º e o 6º dia).',
    ctaLabel: 'Abrir fatura no Asaas',
    ctaUrl: C.linkDaFatura(p, linha),
    dedupeKey: `atraso-3-dias:${linha.asaas_payment_id}`,
  });
  return !!r;
}

async function processarAtrasos({ db, asaas, enviar, notifications, alertaCompanyId, hoje, summary }) {
  // Só a cobrança vencida mais antiga de cada empresa ainda 'overdue'.
  const { rows } = await db.query(
    `SELECT DISTINCT ON (o.company_id) o.*, to_char(o.due_date, 'YYYY-MM-DD') AS due_iso
       FROM assinatura_cobrancas o
       JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'OVERDUE'
        AND c.billing_status::text = 'overdue'
        AND o.due_date BETWEEN ($1::date - 14) AND ($1::date - 1)
      ORDER BY o.company_id, o.due_date, o.asaas_payment_id`,
    [hoje]
  );
  for (const linha of rows || []) {
    try {
      const dias = C.diasEntre(hoje, linha.due_iso);
      const etapa = etapaDoAtraso(dias);
      if (!etapa) continue;
      const destino = await C.destinatarioDaEmpresa(db, linha.company_id);
      if (!destino) { summary.ignorados++; continue; }
      const chave = `${etapa.chave}:${linha.asaas_payment_id}`;
      const p = await lerOuAdiar({ db, asaas, linha, chave, tipo: etapa.tipo, destino, summary });
      if (!p) { summary.ignorados++; continue; }

      if (etapa.alertaInterno) {
        if (await alertarAura({ notifications, alertaCompanyId, destino, linha, p, dias, hoje })) summary.alertas++;
      }
      if (!destino.email) { summary.ignorados++; continue; }

      const venc = linha.due_iso; // o atraso conta do vencimento do espelho (o mesmo do /auth/me)
      const pix = await C.pixDaCobranca(asaas, linha.asaas_payment_id);
      // Valor: value + interestValue da cobrança relida agora = o que o Pix
      // deste e-mail cobra hoje (multa e juros incluídos).
      const v = conteudos.valorParaEmail(p, { situacao: 'aberta', hoje });
      const conteudo = conteudos[etapa.montar]({
        nome: destino.nome, loja: destino.loja, valor: v ? v.valor : null, comJuros: !!(v && v.comJuros),
        vencimento: venc, pix, linkFatura: C.linkDaFatura(p, linha),
        pausaTelas: C.somarDias(venc, C.DIAS_ATE_PAUSA_TELAS),
        pausaCaixa: C.somarDias(venc, C.DIAS_ATE_PAUSA_CAIXA),
        diasParaPausaDoCaixa: C.DIAS_ATE_PAUSA_CAIXA - dias,
      });
      const r = await C.enviarCobranca({
        db, enviar, tipo: etapa.tipo, chave, destino, conteudo,
        metadata: { asaas_payment_id: linha.asaas_payment_id, vencimento: venc, dias, com_pix: !!pix, valor: v ? v.valor : null },
      });
      if (r.status === 'sent') summary.emails++;
    } catch (err) {
      summary.falhas++;
      console.error(`[reguaCobranca] atraso ${linha.asaas_payment_id}: ${err.message}`);
    }
  }
}

// ── 4. Nova tentativa no cartão (tq-84) ─────────────────────────
// Só com ASAAS_RETENTATIVA_CARTAO_ENABLED. Uma vez por cobrança: a reserva
// (retentativa_em) é gravada ANTES da chamada à Asaas. A cobrança é relida
// antes: paga ou fora de aberto não é cobrada. Sem token do cartão na
// cobrança, não tenta. Resposta inconclusiva: relê a cobrança antes de
// concluir (docs.asaas.com: payWithCreditCard não é idempotente).
async function processarRetentativas({ db, asaas, enviar, hoje, now, summary }) {
  const { rows } = await db.query(
    `SELECT o.*, to_char(o.due_date, 'YYYY-MM-DD') AS due_iso
       FROM assinatura_cobrancas o
      WHERE o.cartao_recusado_em IS NOT NULL
        AND o.retentativa_em IS NULL
        AND o.status IN ('PENDING', 'OVERDUE')
        AND o.cartao_recusado_em <= to_timestamp($1::double precision / 1000) - INTERVAL '24 hours'
        AND o.cartao_recusado_em >= to_timestamp($1::double precision / 1000) - INTERVAL '72 hours'
      ORDER BY o.cartao_recusado_em`,
    [now]
  );
  for (const linha of rows || []) {
    try {
      const reserva = await db.query(
        `UPDATE assinatura_cobrancas SET retentativa_em = NOW(), updated_at = NOW()
          WHERE asaas_payment_id = $1 AND retentativa_em IS NULL RETURNING asaas_payment_id`,
        [linha.asaas_payment_id]
      );
      if (!reserva || !reserva.rows || !reserva.rows.length) continue;
      const marcar = (res) => db.query(
        `UPDATE assinatura_cobrancas SET retentativa_resultado = $2, updated_at = NOW() WHERE asaas_payment_id = $1`,
        [linha.asaas_payment_id, res]
      );

      let p;
      try {
        p = await cobrancaAindaEmAberto({ db, asaas, linha });
      } catch (err) {
        // Nada foi cobrado ainda: devolve a reserva para a próxima volta.
        await db.query(
          `UPDATE assinatura_cobrancas SET retentativa_em = NULL, updated_at = NOW() WHERE asaas_payment_id = $1`,
          [linha.asaas_payment_id]
        );
        throw err;
      }
      if (!p) { await marcar('nao_precisou'); continue; }
      const token = p.creditCard && p.creditCard.creditCardToken;
      if (!token) { await marcar('sem_token'); continue; }

      let aprovada = false;
      try {
        const r = await asaas('POST', '/payments/' + encodeURIComponent(linha.asaas_payment_id) + '/payWithCreditCard', { creditCardToken: token });
        aprovada = !!(r && PAGO.has(r.status));
      } catch (err) {
        console.warn(`[reguaCobranca] nova tentativa recusada/inconclusiva ${linha.asaas_payment_id}: ${err.message}`);
        const relida = await asaas('GET', '/payments/' + encodeURIComponent(linha.asaas_payment_id)).catch(() => null);
        aprovada = !!(relida && PAGO.has(relida.status));
      }
      summary.retentativas++;
      if (aprovada) { await marcar('aprovada'); continue; }
      await marcar('recusada');

      const destino = await C.destinatarioDaEmpresa(db, linha.company_id);
      if (!destino || !destino.email) continue;
      const venc = String(p.dueDate || linha.due_iso).slice(0, 10);
      const pix = await C.pixDaCobranca(asaas, linha.asaas_payment_id);
      const v = conteudos.valorParaEmail(p, { situacao: 'aberta', hoje });
      const conteudo = conteudos.cartaoRecusadoDeNovo({
        nome: destino.nome, loja: destino.loja, valor: v ? v.valor : null, comJuros: !!(v && v.comJuros),
        cartaoFinal: C.cartaoFinal(p) || linha.cartao_final, pix, linkFatura: C.linkDaFatura(p, linha),
        vencimento: venc, pausaTelas: C.somarDias(venc, C.DIAS_ATE_PAUSA_TELAS), hoje,
      });
      const r = await C.enviarCobranca({
        db, enviar, tipo: 'cobranca_cartao_recusado_2', chave: `cartao-recusado-2:${linha.asaas_payment_id}`, destino, conteudo,
        metadata: { asaas_payment_id: linha.asaas_payment_id },
      });
      if (r.status === 'sent') summary.emails++;
    } catch (err) {
      summary.falhas++;
      console.error(`[reguaCobranca] nova tentativa ${linha.asaas_payment_id}: ${err.message}`);
    }
  }
}

function resumoVazio() {
  return { varridas: 0, emails: 0, alertas: 0, retentativas: 0, ignorados: 0, adiados: 0, falhas: 0 };
}

/**
 * Volta diária (varredura, lembretes, atraso). Injetável para teste.
 * @param deps {{ db, asaas, notifications, enviar?, now?, env? }}
 */
async function tickDiarioDaRegua({ db, asaas, notifications, enviar, now = Date.now(), env = process.env }) {
  const summary = resumoVazio();
  if (!C.emailsDeCobrancaLigados(env)) return summary;
  const hoje = C.hojeBrt(now);
  const alertaCompanyId = env.AURA_ALERTA_COMPANY_ID || ALERTA_COMPANY_ID_PADRAO;
  try {
    await varrerPendentes({ db, asaas, hoje, summary });
  } catch (err) {
    summary.falhas++;
    console.error('[reguaCobranca] varredura das pendentes falhou: ' + err.message);
  }
  await processarLembretes({ db, asaas, enviar, hoje, summary });
  await processarAtrasos({ db, asaas, enviar, notifications, alertaCompanyId, hoje, summary });
  return summary;
}

/** Volta frequente: só a nova tentativa no cartão (quando ligada). */
async function tickRetentativas({ db, asaas, enviar, now = Date.now(), env = process.env }) {
  const summary = resumoVazio();
  if (!C.retentativaCartaoLigada(env)) return summary;
  await processarRetentativas({ db, asaas, enviar, hoje: C.hojeBrt(now), now, summary });
  return summary;
}

module.exports = {
  ALERTA_COMPANY_ID_PADRAO,
  ETAPAS_ATRASO,
  etapaDoAtraso,
  etapaDoLembrete,
  tickDiarioDaRegua,
  tickRetentativas,
  // para teste
  varrerPendentes,
  processarLembretes,
  processarAtrasos,
  processarRetentativas,
};
