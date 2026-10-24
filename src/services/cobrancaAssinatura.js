// ============================================================
// AURA. — Cobranças da assinatura Aura: espelho, atraso e e-mails do
// webhook (24/10/2026; tq-76, tq-84, tq-86; migration 408)
//
// Espelho: assinatura_cobrancas guarda cada cobrança (pay_...) com o
// vencimento e a situação que a Asaas informou. Dele saem:
//   - datasDoAtraso() -> billing_overdue_since / billing_pause_screens_on /
//     billing_pause_caixa_on do /auth/me (contrato com o app, tq-86). O
//     atraso conta do vencimento da cobrança OVERDUE mais antiga, nunca de
//     companies.next_billing_date;
//   - a régua de cobrança (services/reguaDeCobranca.js).
//
// No webhook (aoEventoDaAssinatura), depois que companies já foi atualizada:
//   CREATED  -> PENDING            (o lembrete sai pelo job das 9h)
//   OVERDUE  -> OVERDUE            (a régua de atraso sai pelo job das 9h)
//   CONFIRMED/RECEIVED -> PAID     + recibo 2.7, UM por cobrança (os dois
//                                    eventos da mesma cobrança dividem a chave)
//   REFUNDED -> REFUNDED           + e-mail de estorno
//   CHARGEBACK_REQUESTED -> CHARGEBACK + e-mail de contestação
//   DELETED  -> DELETED            (a cobrança some do atraso)
//   CREDIT_CARD_CAPTURE_REFUSED    + 2.8 na primeira recusa; 2.8b se a nova
//                                    tentativa da Aura já tinha sido feita
//
// Nada aqui derruba o webhook: toda falha vai ao log.
// ============================================================
'use strict';

const L = require('./emailLayout');
const conteudos = require('./emailsCobranca');
const { enviarEmailRegistrado } = require('./emailLog');
const { linkQrDoPix } = require('./emailLinks');

// Decisões do Caio (21/10/2026): em atraso, as outras telas pausam no dia 7
// e o Caixa no dia 14, contados do vencimento da cobrança OVERDUE mais antiga.
const DIAS_ATE_PAUSA_TELAS = 7;
const DIAS_ATE_PAUSA_CAIXA = 14;

// Recibo de pagamento antigo (evento reenviado ou atrasado) não sai.
const DIAS_MAX_RECIBO = 3;

const FINAIS = ['PAID', 'REFUNDED', 'DELETED', 'CHARGEBACK'];
const ESTADO_POR_EVENTO = {
  PAYMENT_CREATED: 'PENDING',
  PAYMENT_OVERDUE: 'OVERDUE',
  PAYMENT_CONFIRMED: 'PAID',
  PAYMENT_RECEIVED: 'PAID',
  PAYMENT_REFUNDED: 'REFUNDED',
  PAYMENT_CHARGEBACK_REQUESTED: 'CHARGEBACK',
  PAYMENT_DELETED: 'DELETED',
};
const ESTADO_POR_STATUS_ASAAS = {
  PENDING: 'PENDING',
  AWAITING_RISK_ANALYSIS: 'PENDING',
  OVERDUE: 'OVERDUE',
  CONFIRMED: 'PAID',
  RECEIVED: 'PAID',
  RECEIVED_IN_CASH: 'PAID',
  REFUNDED: 'REFUNDED',
  CHARGEBACK_REQUESTED: 'CHARGEBACK',
};

// ── Interruptores ───────────────────────────────────────────────
function ligado(valor, padrao) {
  if (valor == null || String(valor).trim() === '') return padrao;
  return !/^(0|false|off|no|nao|não)$/i.test(String(valor).trim());
}

/** EMAILS_CICLO_ENABLED (geral) e EMAILS_COBRANCA_ENABLED: padrão ligado. */
function emailsDeCobrancaLigados(env = process.env) {
  return ligado(env.EMAILS_CICLO_ENABLED, true) && ligado(env.EMAILS_COBRANCA_ENABLED, true);
}

/** Nova tentativa automática no cartão (tq-84): padrão DESLIGADO. */
function retentativaCartaoLigada(env = process.env) {
  return ligado(env.ASAAS_RETENTATIVA_CARTAO_ENABLED, false);
}

// ── Datas ───────────────────────────────────────────────────────
/** Dia civil em São Paulo (UTC-3, sem horário de verão), AAAA-MM-DD. */
function hojeBrt(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

function horaBrt(now = Date.now()) {
  return new Date(now - 3 * 3600000).getUTCHours();
}

function somarDias(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}

/** Dias de b até a (a - b), datas AAAA-MM-DD. */
function diasEntre(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(a || ''));
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(b || ''));
  if (!pa || !pb) return null;
  return Math.round((Date.UTC(+pa[1], +pa[2] - 1, +pa[3]) - Date.UTC(+pb[1], +pb[2] - 1, +pb[3])) / 86400000);
}

function datasDaPausa(overdueSince) {
  if (!overdueSince) {
    return { billing_overdue_since: null, billing_pause_screens_on: null, billing_pause_caixa_on: null };
  }
  return {
    billing_overdue_since: overdueSince,
    billing_pause_screens_on: somarDias(overdueSince, DIAS_ATE_PAUSA_TELAS),
    billing_pause_caixa_on: somarDias(overdueSince, DIAS_ATE_PAUSA_CAIXA),
  };
}

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * As três datas do /auth/me (tq-86). Só para billing_status 'overdue'; nos
 * demais estados, as três vêm null. A cobrança é da empresa que paga
 * (matriz, billing_owner_company_id): a filial que herda o status herda as
 * datas. Fonte: assinatura_cobrancas; sem linha (ou sem a tabela), o
 * next_billing_date da pagadora quando já passou — que a correção de
 * vencimentos não avança mais além da cobrança vencida.
 * Nunca lança: qualquer falha vira as três null.
 */
async function datasDoAtraso({ db, companyId, billingStatus, now = Date.now() }) {
  if (billingStatus !== 'overdue' || !companyId) return datasDaPausa(null);
  const hoje = hojeBrt(now);
  try {
    let desde = null;
    try {
      const r = await db.query(
        `SELECT to_char(MIN(o.due_date), 'YYYY-MM-DD') AS desde
           FROM companies c
           JOIN assinatura_cobrancas o ON o.company_id = COALESCE(c.billing_owner_company_id, c.id)
          WHERE c.id = $1 AND o.status = 'OVERDUE'`,
        [companyId]
      );
      desde = (r && r.rows && r.rows[0] && r.rows[0].desde) || null;
    } catch (err) {
      if (!err || (err.code !== '42P01' && err.code !== '42703')) throw err;
    }
    if (!desde) {
      const r = await db.query(
        `SELECT to_char(p.next_billing_date, 'YYYY-MM-DD') AS venc
           FROM companies c
           JOIN companies p ON p.id = COALESCE(c.billing_owner_company_id, c.id)
          WHERE c.id = $1`,
        [companyId]
      );
      const venc = r && r.rows && r.rows[0] && r.rows[0].venc;
      if (venc && DATA_RE.test(venc) && venc < hoje) desde = venc;
    }
    return datasDaPausa(desde && DATA_RE.test(desde) ? desde : null);
  } catch (err) {
    console.error('[cobrancaAssinatura] datas do atraso falharam: ' + (err && err.message));
    return datasDaPausa(null);
  }
}

// ── Espelho ─────────────────────────────────────────────────────
function cartaoFinal(payment) {
  const n = payment && payment.creditCard && payment.creditCard.creditCardNumber;
  const d = String(n || '').replace(/\D/g, '');
  return d ? d.slice(-4) : null;
}

function dataDoPagamento(payment) {
  const v = payment && (payment.paymentDate || payment.clientPaymentDate || payment.confirmedDate);
  const s = v ? String(v).slice(0, 10) : '';
  return DATA_RE.test(s) ? s : null;
}

/**
 * Grava/atualiza a cobrança no espelho. Situação final (PAID, REFUNDED,
 * DELETED, CHARGEBACK) não volta para PENDING/OVERDUE por evento atrasado,
 * e PAID não sobrescreve REFUNDED/DELETED/CHARGEBACK.
 * Devolve a linha (ou null sem vencimento / sem tabela).
 */
async function registrarCobranca(db, { companyId, payment, estado, origem = 'webhook', cartaoRecusado = false }) {
  const due = payment && payment.dueDate ? String(payment.dueDate).slice(0, 10) : null;
  if (!payment || !payment.id || !companyId || !estado) return null;
  if (!due || !DATA_RE.test(due)) {
    // Sem vencimento só dá para atualizar uma linha que já existe.
    const r = await db.query(
      `UPDATE assinatura_cobrancas
          SET status = CASE
                WHEN status = ANY($3::text[]) AND $2 IN ('PENDING', 'OVERDUE') THEN status
                WHEN status IN ('REFUNDED', 'DELETED', 'CHARGEBACK') AND $2 = 'PAID' THEN status
                ELSE $2 END,
              cartao_recusado_em = CASE WHEN $4 THEN COALESCE(cartao_recusado_em, NOW()) ELSE cartao_recusado_em END,
              updated_at = NOW()
        WHERE asaas_payment_id = $1
      RETURNING *, to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
      [payment.id, estado, FINAIS, !!cartaoRecusado]
    );
    return (r && r.rows && r.rows[0]) || null;
  }
  const valor = Number(payment.value);
  const r = await db.query(
    `INSERT INTO assinatura_cobrancas
       (asaas_payment_id, company_id, asaas_subscription_id, status, due_date, valor, billing_type,
        invoice_url, cartao_final, vencida_em, paga_em, data_pagamento, cartao_recusado_em, origem)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9,
             CASE WHEN $4 = 'OVERDUE' THEN NOW() END,
             CASE WHEN $4 = 'PAID' THEN NOW() END,
             $10::date,
             CASE WHEN $11 THEN NOW() END,
             $12)
     ON CONFLICT (asaas_payment_id) DO UPDATE SET
       status = CASE
         WHEN assinatura_cobrancas.status = ANY($13::text[]) AND EXCLUDED.status IN ('PENDING', 'OVERDUE') THEN assinatura_cobrancas.status
         WHEN assinatura_cobrancas.status IN ('REFUNDED', 'DELETED', 'CHARGEBACK') AND EXCLUDED.status = 'PAID' THEN assinatura_cobrancas.status
         ELSE EXCLUDED.status END,
       due_date = EXCLUDED.due_date,
       valor = COALESCE(EXCLUDED.valor, assinatura_cobrancas.valor),
       billing_type = COALESCE(EXCLUDED.billing_type, assinatura_cobrancas.billing_type),
       invoice_url = COALESCE(EXCLUDED.invoice_url, assinatura_cobrancas.invoice_url),
       cartao_final = COALESCE(EXCLUDED.cartao_final, assinatura_cobrancas.cartao_final),
       asaas_subscription_id = COALESCE(EXCLUDED.asaas_subscription_id, assinatura_cobrancas.asaas_subscription_id),
       vencida_em = CASE WHEN EXCLUDED.status = 'OVERDUE' THEN COALESCE(assinatura_cobrancas.vencida_em, NOW()) ELSE assinatura_cobrancas.vencida_em END,
       paga_em = CASE WHEN EXCLUDED.status = 'PAID' THEN COALESCE(assinatura_cobrancas.paga_em, NOW()) ELSE assinatura_cobrancas.paga_em END,
       data_pagamento = COALESCE(EXCLUDED.data_pagamento, assinatura_cobrancas.data_pagamento),
       cartao_recusado_em = CASE WHEN $11 THEN COALESCE(assinatura_cobrancas.cartao_recusado_em, NOW()) ELSE assinatura_cobrancas.cartao_recusado_em END,
       updated_at = NOW()
     RETURNING *, to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
    [
      payment.id, companyId, payment.subscription || null, estado, due,
      Number.isFinite(valor) ? valor : null, payment.billingType || null,
      payment.invoiceUrl || null, cartaoFinal(payment), dataDoPagamento(payment),
      !!cartaoRecusado, origem, FINAIS,
    ]
  );
  return (r && r.rows && r.rows[0]) || null;
}

// ── Destinatário ────────────────────────────────────────────────
const VERTICAIS_FORA = ['karate_dojo', 'karate_federation'];

/**
 * Quem recebe o e-mail de cobrança da empresa (o dono), ou null quando a
 * empresa fica fora: inativa, sandbox, Karatê/dojô, conta interna (is_staff
 * ou @getaura.com.br). Sem e-mail no cadastro: o objeto vem com email null.
 */
async function destinatarioDaEmpresa(db, companyId) {
  const r = await db.query(
    `SELECT c.id, COALESCE(c.trade_name, c.legal_name) AS loja, c.email AS company_email,
            c.is_active, c.is_sandbox, c.vertical, c.vertical_active,
            u.id AS user_id, u.email AS user_email, u.full_name, u.is_staff
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = $1`,
    [companyId]
  );
  const c = r && r.rows && r.rows[0];
  if (!c) return null;
  if (c.is_active === false || c.is_sandbox === true) return null;
  if (VERTICAIS_FORA.includes(c.vertical) || VERTICAIS_FORA.includes(c.vertical_active)) return null;
  if (c.is_staff === true) return null;
  const internos = [c.user_email, c.company_email].filter(Boolean).map((e) => String(e).toLowerCase());
  if (internos.some((e) => e.trim().endsWith('@getaura.com.br'))) return null;
  const email = String(c.user_email || c.company_email || '').trim();
  return {
    companyId: c.id,
    userId: c.user_id || null,
    // null = empresa elegível, mas sem e-mail no cadastro: sem e-mail, mas o
    // aviso interno do dia 3 ainda sai.
    email: email && email.includes('@') ? email : null,
    nome: L.primeiroNome(c.full_name) || c.loja || 'tudo bem',
    loja: c.loja || 'sua loja',
  };
}

// ── Pix da cobrança ─────────────────────────────────────────────
/**
 * Pix copia e cola da cobrança (GET /payments/{id}/pixQrCode). Falha vira
 * null: o e-mail sai sem o Pix, com o link da fatura (tq-77).
 */
async function pixDaCobranca(asaas, paymentId) {
  if (!asaas || !paymentId) return null;
  try {
    const pix = await asaas('GET', '/payments/' + encodeURIComponent(paymentId) + '/pixQrCode');
    const codigo = pix && pix.payload ? String(pix.payload).trim() : '';
    if (!codigo) return null;
    return { copiaECola: codigo, qrUrl: linkQrDoPix(codigo) };
  } catch (err) {
    console.warn('[cobrancaAssinatura] Pix da cobrança ' + paymentId + ' indisponível: ' + err.message);
    return null;
  }
}

function linkDaFatura(payment, linha) {
  const u = (payment && payment.invoiceUrl) || (linha && linha.invoice_url);
  if (u) return u;
  const id = (payment && payment.id) || (linha && linha.asaas_payment_id);
  return id ? 'https://www.asaas.com/i/' + String(id).replace(/^pay_/, '') : null;
}

/** Envia um e-mail de cobrança montado, com a chave de idempotência. */
async function enviarCobranca({ db, enviar, tipo, chave, destino, conteudo, metadata }) {
  return enviarEmailRegistrado({
    db, enviar, chave, tipo,
    companyId: destino.companyId, userId: destino.userId, metadata,
    to: destino.email,
    subject: conteudo.assunto,
    html: conteudo.html,
    text: conteudo.text,
  });
}

// ── Webhook ─────────────────────────────────────────────────────
/**
 * Chamado pelo webhook da Asaas (billing de empresa) depois que companies
 * foi atualizada. Nunca lança.
 *
 * @param {object} p
 * @param {string} p.event        nome do evento (PAYMENT_*)
 * @param {object} p.payment      cobrança (do body validado ou relida na Asaas)
 * @param {boolean} p.fromAsaasApi o status vem do GET na Asaas (sem segredo)
 * @param {object} p.company      { id }
 * @param {string|null} p.nextDue próximo vencimento já lido da Asaas
 */
async function aoEventoDaAssinatura({ db, asaas, enviar, event, payment, fromAsaasApi = false, company, nextDue = null, now = Date.now(), env = process.env }) {
  const resultado = { espelho: null, email: null };
  try {
    if (!payment || !payment.id || !company || !company.id) return resultado;
    const recusa = event === 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED';
    let estado;
    if (recusa) {
      estado = ESTADO_POR_STATUS_ASAAS[payment.status] || 'PENDING';
      if (FINAIS.includes(estado)) estado = 'PENDING';
    } else if (fromAsaasApi) {
      estado = ESTADO_POR_STATUS_ASAAS[payment.status] || null;
    } else {
      estado = ESTADO_POR_EVENTO[event] || null;
    }
    if (!estado) return resultado;

    let linha = null;
    try {
      linha = await registrarCobranca(db, { companyId: company.id, payment, estado, cartaoRecusado: recusa });
      resultado.espelho = linha ? linha.status : null;
    } catch (err) {
      if (err && err.code !== '42P01') console.error('[cobrancaAssinatura] espelho falhou: ' + err.message);
    }

    if (!emailsDeCobrancaLigados(env)) return resultado;

    let tipo = null;
    let chave = null;
    let montar = null;
    const hoje = hojeBrt(now);

    if (estado === 'PAID' && !recusa) {
      const dataPg = dataDoPagamento(payment);
      // Recibo só de pagamento recente: reenvio de evento antigo não vira
      // recibo (nada retroativo no primeiro deploy).
      if (dataPg && diasEntre(hoje, dataPg) > DIAS_MAX_RECIBO) return resultado;
      tipo = 'cobranca_pagamento_confirmado';
      chave = `pagamento-confirmado:${payment.id}`;
      // Valor: o pago nesta cobrança (value; nunca netValue nem o plano).
      const v = conteudos.valorParaEmail(payment, { situacao: 'paga' });
      montar = (destino) => conteudos.pagamentoConfirmado({
        nome: destino.nome, loja: destino.loja, valor: v ? v.valor : null,
        billingType: payment.billingType, dataPagamento: dataPg || hoje,
        proximoVencimento: nextDue,
        linkComprovante: payment.transactionReceiptUrl || linkDaFatura(payment, linha),
      });
    } else if (estado === 'REFUNDED' && event === 'PAYMENT_REFUNDED') {
      tipo = 'cobranca_estorno';
      chave = `estorno:${payment.id}`;
      const v = conteudos.valorParaEmail(payment, { situacao: 'paga' });
      montar = (destino) => conteudos.pagamentoEstornado({ nome: destino.nome, loja: destino.loja, valor: v ? v.valor : null });
    } else if (estado === 'CHARGEBACK' && event === 'PAYMENT_CHARGEBACK_REQUESTED') {
      tipo = 'cobranca_contestacao';
      chave = `contestacao:${payment.id}`;
      const v = conteudos.valorParaEmail(payment, { situacao: 'paga' });
      montar = (destino) => conteudos.pagamentoContestado({ nome: destino.nome, loja: destino.loja, valor: v ? v.valor : null });
    } else if (recusa) {
      // Recusa depois da nova tentativa da Aura = 2.8b; antes = 2.8.
      const segunda = !!(linha && linha.retentativa_em);
      const comNovaTentativa = retentativaCartaoLigada(env);
      if (segunda) {
        tipo = 'cobranca_cartao_recusado_2';
        chave = `cartao-recusado-2:${payment.id}`;
      } else {
        tipo = 'cobranca_cartao_recusado';
        chave = `cartao-recusado:${payment.id}`;
      }
      const due = payment.dueDate || (linha && linha.due_iso);
      montar = async (destino) => {
        const pix = await pixDaCobranca(asaas, payment.id);
        // Valor: o que esta cobrança (e o Pix do mesmo e-mail) cobra hoje.
        const v = conteudos.valorParaEmail(payment, { situacao: 'aberta', hoje });
        const base = {
          nome: destino.nome, loja: destino.loja, valor: v ? v.valor : null, comJuros: !!(v && v.comJuros),
          cartaoFinal: cartaoFinal(payment) || (linha && linha.cartao_final),
          pix, linkFatura: linkDaFatura(payment, linha), vencimento: due,
          pausaTelas: due ? somarDias(due, DIAS_ATE_PAUSA_TELAS) : null, hoje,
          comNovaTentativa,
        };
        return segunda ? conteudos.cartaoRecusadoDeNovo(base) : conteudos.cartaoRecusado(base);
      };
    }
    if (!tipo) return resultado;

    const destino = await destinatarioDaEmpresa(db, company.id);
    if (!destino || !destino.email) {
      resultado.email = 'fora';
      return resultado;
    }
    const conteudo = await montar(destino);
    const r = await enviarCobranca({ db, enviar, tipo, chave, destino, conteudo, metadata: { asaas_payment_id: payment.id, evento: event } });
    resultado.email = r.status;
    return resultado;
  } catch (err) {
    console.error('[cobrancaAssinatura] evento ' + event + ' falhou: ' + (err && err.message));
    return resultado;
  }
}

module.exports = {
  DIAS_ATE_PAUSA_TELAS,
  DIAS_ATE_PAUSA_CAIXA,
  DIAS_MAX_RECIBO,
  ESTADO_POR_EVENTO,
  ESTADO_POR_STATUS_ASAAS,
  emailsDeCobrancaLigados,
  retentativaCartaoLigada,
  hojeBrt,
  horaBrt,
  somarDias,
  diasEntre,
  datasDaPausa,
  datasDoAtraso,
  cartaoFinal,
  dataDoPagamento,
  registrarCobranca,
  destinatarioDaEmpresa,
  pixDaCobranca,
  linkDaFatura,
  enviarCobranca,
  aoEventoDaAssinatura,
};
