// ============================================================
// Banco em memória para os testes da cobrança e dos e-mails (24/10/2026).
// Emula só as consultas de services/emailLog, services/cobrancaAssinatura
// e services/reguaDeCobranca — o suficiente para provar idempotência
// (chave única do email_log) e as regras de quem recebe.
// ============================================================
'use strict';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function criarBanco({ empresas = [], usuarios = [], cobrancas = [], lembretesAntigos = [] } = {}) {
  const b = {
    empresas: empresas.map((e) => ({ is_active: true, is_sandbox: false, vertical: null, vertical_active: null, billing_status: 'active', ...e })),
    usuarios: usuarios.map((u) => ({ is_staff: false, ...u })),
    cobrancas: cobrancas.map((c) => ({ cartao_recusado_em: null, retentativa_em: null, retentativa_resultado: null, ...c })),
    emailLog: [],
    auditoria: [],
    lembretesAntigos,
    consultas: [],
  };

  const comIso = (c) => ({ ...c, due_iso: c.due_date });
  const FINAIS = ['PAID', 'REFUNDED', 'DELETED', 'CHARGEBACK'];
  const novoEstado = (antigo, novo) => {
    if (FINAIS.includes(antigo) && ['PENDING', 'OVERDUE'].includes(novo)) return antigo;
    if (['REFUNDED', 'DELETED', 'CHARGEBACK'].includes(antigo) && novo === 'PAID') return antigo;
    return novo;
  };

  b.query = jest.fn(async (sql, p = []) => {
    const s = norm(sql);
    b.consultas.push(s);

    // ── email_log ──
    if (s.startsWith('INSERT INTO email_log (chave_idempotencia')) {
      const [chave, tipo, companyId, userId, destinatario, assunto, , max] = p;
      const ex = b.emailLog.find((l) => l.chave_idempotencia === chave);
      if (!ex) {
        const linha = { id: 'log' + (b.emailLog.length + 1), chave_idempotencia: chave, tipo, company_id: companyId, user_id: userId, destinatario, assunto, status: 'reserved', tentativas: 1 };
        b.emailLog.push(linha);
        return { rows: [{ id: linha.id }] };
      }
      if (ex.status === 'failed' && ex.tentativas < max) {
        ex.status = 'reserved'; ex.tentativas += 1;
        return { rows: [{ id: ex.id }] };
      }
      return { rows: [] };
    }
    if (s.startsWith("UPDATE email_log SET status = 'sent'")) {
      const l = b.emailLog.find((x) => x.id === p[0]); if (l) { l.status = 'sent'; l.resend_id = p[1]; }
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE email_log SET status = 'failed'")) {
      const l = b.emailLog.find((x) => x.id === p[0]); if (l) { l.status = 'failed'; l.erro = p[1]; }
      return { rows: [], rowCount: 1 };
    }

    // ── destinatário ──
    if (s.includes('FROM companies c LEFT JOIN users u ON u.id = c.owner_id')) {
      const c = b.empresas.find((e) => e.id === p[0]);
      if (!c) return { rows: [] };
      const u = b.usuarios.find((x) => x.id === c.owner_id) || {};
      return { rows: [{
        id: c.id, loja: c.trade_name || c.legal_name, company_email: c.email || null,
        is_active: c.is_active, is_sandbox: c.is_sandbox, vertical: c.vertical, vertical_active: c.vertical_active,
        user_id: u.id || null, user_email: u.email || null, full_name: u.full_name || null, is_staff: u.is_staff,
      }] };
    }

    // ── espelho: upsert ──
    if (s.startsWith('INSERT INTO assinatura_cobrancas')) {
      const [pid, companyId, sub, estado, due, valor, billingType, invoiceUrl, cartaoFinal, dataPg, recusa, origem] = p;
      let c = b.cobrancas.find((x) => x.asaas_payment_id === pid);
      if (!c) {
        c = { asaas_payment_id: pid, company_id: companyId, asaas_subscription_id: sub, status: estado, due_date: due, valor, billing_type: billingType, invoice_url: invoiceUrl, cartao_final: cartaoFinal, data_pagamento: dataPg, cartao_recusado_em: recusa ? new Date() : null, retentativa_em: null, origem };
        b.cobrancas.push(c);
      } else {
        c.status = novoEstado(c.status, estado);
        c.due_date = due;
        c.valor = valor != null ? valor : c.valor;
        c.billing_type = billingType || c.billing_type;
        c.invoice_url = invoiceUrl || c.invoice_url;
        c.cartao_final = cartaoFinal || c.cartao_final;
        if (recusa && !c.cartao_recusado_em) c.cartao_recusado_em = new Date();
      }
      return { rows: [comIso(c)] };
    }
    if (s.startsWith('UPDATE assinatura_cobrancas SET status = CASE')) {
      const c = b.cobrancas.find((x) => x.asaas_payment_id === p[0]);
      if (!c) return { rows: [] };
      c.status = novoEstado(c.status, p[1]);
      if (p[3] && !c.cartao_recusado_em) c.cartao_recusado_em = new Date();
      return { rows: [comIso(c)] };
    }
    if (s.startsWith('UPDATE assinatura_cobrancas SET retentativa_em = NOW()')) {
      const c = b.cobrancas.find((x) => x.asaas_payment_id === p[0] && !x.retentativa_em);
      if (!c) return { rows: [] };
      c.retentativa_em = new Date();
      return { rows: [{ asaas_payment_id: c.asaas_payment_id }] };
    }
    if (s.startsWith('UPDATE assinatura_cobrancas SET retentativa_em = NULL')) {
      const c = b.cobrancas.find((x) => x.asaas_payment_id === p[0]); if (c) c.retentativa_em = null;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE assinatura_cobrancas SET retentativa_resultado')) {
      const c = b.cobrancas.find((x) => x.asaas_payment_id === p[0]); if (c) c.retentativa_resultado = p[1];
      return { rows: [], rowCount: 1 };
    }

    // ── régua: lembretes ──
    if (s.includes("WHERE o.status = 'PENDING' AND o.due_date BETWEEN")) {
      const hoje = p[0];
      const ate = new Date(Date.parse(hoje + 'T00:00:00Z') + 2 * 86400000).toISOString().slice(0, 10);
      return { rows: b.cobrancas
        .filter((c) => c.status === 'PENDING' && c.due_date >= hoje && c.due_date <= ate && c.billing_type !== 'CREDIT_CARD')
        .map(comIso) };
    }
    // ── régua: atraso ──
    if (s.includes("WHERE o.status = 'OVERDUE' AND c.billing_status::text = 'overdue'")) {
      const hoje = p[0];
      const de = new Date(Date.parse(hoje + 'T00:00:00Z') - 14 * 86400000).toISOString().slice(0, 10);
      const ate = new Date(Date.parse(hoje + 'T00:00:00Z') - 1 * 86400000).toISOString().slice(0, 10);
      const porEmpresa = new Map();
      for (const c of b.cobrancas.filter((x) => x.status === 'OVERDUE' && x.due_date >= de && x.due_date <= ate)) {
        const e = b.empresas.find((x) => x.id === c.company_id);
        if (!e || e.billing_status !== 'overdue') continue;
        const atual = porEmpresa.get(c.company_id);
        if (!atual || c.due_date < atual.due_date) porEmpresa.set(c.company_id, c);
      }
      return { rows: [...porEmpresa.values()].map(comIso) };
    }
    // ── régua: retentativas ──
    if (s.includes('WHERE o.cartao_recusado_em IS NOT NULL AND o.retentativa_em IS NULL')) {
      const agora = Number(p[0]);
      return { rows: b.cobrancas
        .filter((c) => c.cartao_recusado_em && !c.retentativa_em && ['PENDING', 'OVERDUE'].includes(c.status))
        .filter((c) => {
          const t = new Date(c.cartao_recusado_em).getTime();
          return t <= agora - 24 * 3600000 && t >= agora - 72 * 3600000;
        })
        .map(comIso) };
    }
    if (s.startsWith('SELECT 1 FROM invoice_reminders')) {
      return { rows: b.lembretesAntigos.includes(p[0]) ? [{ '?column?': 1 }] : [] };
    }
    if (s.startsWith('SELECT id FROM companies WHERE asaas_customer_id')) {
      const e = b.empresas.find((x) => x.asaas_customer_id === p[0] || x.id === p[1]);
      return { rows: e ? [{ id: e.id }] : [] };
    }

    // ── /auth/me: datas do atraso ──
    if (s.includes('JOIN assinatura_cobrancas o ON o.company_id = COALESCE(c.billing_owner_company_id, c.id)')) {
      const e = b.empresas.find((x) => x.id === p[0]);
      if (!e) return { rows: [{ desde: null }] };
      const pagadora = e.billing_owner_company_id || e.id;
      const datas = b.cobrancas.filter((c) => c.company_id === pagadora && c.status === 'OVERDUE').map((c) => c.due_date).sort();
      return { rows: [{ desde: datas[0] || null }] };
    }
    if (s.includes('JOIN companies p ON p.id = COALESCE(c.billing_owner_company_id, c.id)')) {
      const e = b.empresas.find((x) => x.id === p[0]);
      const pagadora = e && b.empresas.find((x) => x.id === (e.billing_owner_company_id || e.id));
      return { rows: pagadora ? [{ venc: pagadora.next_billing_date || null }] : [] };
    }

    throw new Error('consulta não emulada: ' + s.slice(0, 120));
  });
  return b;
}

/** Envio falso no lugar de mailer.sendMail. */
function criarEnvio() {
  const enviados = [];
  const enviar = jest.fn(async (opts) => { enviados.push(opts); return { id: 're_' + enviados.length }; });
  return { enviar, enviados };
}

module.exports = { criarBanco, criarEnvio };
