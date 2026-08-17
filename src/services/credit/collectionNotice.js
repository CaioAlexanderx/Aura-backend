// =============================================================
// AURA. -- Aviso de cobranca de uma parcela: mensagem + Pix copia-e-cola.
//
// 17/08/2026. Extraido de routes/creditInstallments.js (POST
// /collection/trigger/:iid) SEM mudanca de comportamento, pra ser reusado
// pela cobranca do saldo de encomenda do Studio.
//
// Por que extrair em vez de o Studio chamar a rota de credito: as rotas de
// /credit ficam atras de assertCrediarioEnabled, e o Studio NAO tem
// crediario -- exigir o toggle pra cobrar uma encomenda ja vendida seria
// pedir pra lojista habilitar um produto que ela nao usa. O mecanismo
// (parcela, vencimento, Pix, baixa) e infraestrutura e pode ser
// compartilhado; o PRODUTO crediario (fiado, limite, score, carne,
// renegociacao) continua so no shell Negocio.
// =============================================================

const pool = require('../../config/database');
const creditLedger = require('../creditLedger');
const { buildStaticBrCode, validatePixKey, sanitizeTxid } = require('../staticPixService');

// Chave Pix da loja: MESMO lookup do carne imprimivel (print.js /credit/:cid/carne)
// -- digital_channel_config + fallbacks de nome/cidade em companies.
// Retorna null se nao ha chave configurada/valida (caller decide o erro).
async function resolvePixSetup(companyId) {
  let cfg = null;
  try {
    const { rows } = await pool.query(
      `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city, site_name, address
         FROM digital_channel_config WHERE company_id = $1`,
      [companyId]
    );
    cfg = rows[0] || null;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    return null;
  }
  if (!cfg || !cfg.pix_key || !String(cfg.pix_key).trim()) return null;
  const validation = validatePixKey(cfg.pix_key, cfg.pix_key_type);
  if (!validation.valid) return null;

  // companies NAO tem coluna `name` -- COALESCE(trade_name, legal_name)
  let company = {};
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(trade_name, legal_name) AS display_name, address_city
         FROM companies WHERE id = $1`,
      [companyId]
    );
    company = rows[0] || {};
  } catch (_) { company = {}; }

  let city = cfg.pix_holder_city;
  if (!city && cfg.address) {
    const parts = String(cfg.address).split(',').map(s => s.trim());
    city = parts[parts.length - 2] || parts[parts.length - 1] || '';
  }

  return {
    pixKey:  validation.normalized,
    keyType: cfg.pix_key_type || null,
    name:    cfg.pix_holder_name || cfg.site_name || company.display_name || 'AURA NEGOCIO',
    city:    city || company.address_city || 'BRASIL',
  };
}

// B2: config + profile p/ engine de encargos lazy (defensivo 42703/42P01).
async function loadLateContext(companyId, customerId) {
  let config = null;
  try {
    const cfg = await pool.query(`SELECT * FROM credit_plan_configs WHERE company_id = $1`, [companyId]);
    config = cfg.rows[0] || null;
  } catch (err) {
    if (err.code !== '42703' && err.code !== '42P01') {
      console.warn('[credit/pix] loadLateContext falhou:', err.message);
    }
    config = null;
  }
  let profile = null;
  if (customerId) {
    try {
      const prof = await pool.query(
        `SELECT * FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      );
      profile = prof.rows[0] || null;
    } catch (err) {
      if (err.code !== '42703' && err.code !== '42P01') {
        console.warn('[credit/pix] loadLateContext falhou:', err.message);
      }
      profile = null;
    }
  }
  return { config, profile };
}

// Mensagens do crediario. `encomenda` (17/08/2026) e a variante do Studio:
// mesma funcao, vocabulario do mercado de personalizados -- nada de
// "parcela X/Y", que e linguagem de fiado e o CLIENTE FINAL le.
const TEMPLATES = {
  lembrete:    (p) => `Ola, ${p.customerName}! Lembrete: a parcela ${p.installmentNum}/${p.totalInstallments} de R$ ${p.amount} vence em *${p.dueDate}*. Pague via PIX: ${p.pixLink} -- *${p.storeName}*`,
  confirmacao: (p) => `Ola, ${p.customerName}! Amanha vence sua parcela ${p.installmentNum}/${p.totalInstallments} de R$ ${p.amount}. PIX rapido: ${p.pixLink} -- *${p.storeName}*`,
  vencimento:  (p) => `${p.customerName}, a parcela ${p.installmentNum}/${p.totalInstallments} de R$ ${p.amount} vence *hoje*. Evite juros: ${p.pixLink} -- *${p.storeName}*`,
  atraso_1:    (p) => `${p.customerName}, sua parcela ${p.installmentNum}/${p.totalInstallments} de R$ ${p.amount} esta *${p.daysLate} dias* em atraso. Regularize agora: ${p.pixLink} -- *${p.storeName}*`,
  atraso_2:    (p) => `${p.customerName}, identificamos debito de R$ ${p.amount} com *${p.daysLate} dias* de atraso. Acesse ${p.pixLink} ou entre em contato. -- *${p.storeName}*`,
  bloqueio:    (p) => `${p.customerName}, seu credito em *${p.storeName}* foi suspenso por inadimplencia. Regularize: ${p.pixLink} ou fale com a loja.`,

  // Studio -- saldo de encomenda. Um texto so, com o tom dado pela data.
  encomenda: (p) => {
    const quando = p.daysLateNum > 0
      ? `venceu em *${p.dueDate}*`
      : p.daysLateNum === 0
        ? `vence *hoje*`
        : `vence em *${p.dueDate}*`;
    return `Ola, ${p.customerName}! Sobre a sua encomenda em *${p.storeName}*: o saldo de R$ ${p.amount} ${quando}.`
      + (p.pixLink ? ` Pra facilitar, o Pix copia-e-cola: ${p.pixLink}` : '');
  },
};

function buildMessage(template, params = {}) {
  const p = {
    customerName: 'Cliente', storeName: 'Loja', amount: '0,00',
    dueDate: '', installmentNum: '', totalInstallments: '',
    pixLink: '', daysLate: '', daysLateNum: 0,
    ...params,
  };
  return (TEMPLATES[template] || TEMPLATES.lembrete)(p);
}

// Carrega a parcela + cliente + loja. Escopo por empresa sempre.
async function loadInstallment(client, companyId, installmentId) {
  const { rows } = await client.query(
    `SELECT ci.*, COALESCE(c.name, c.phone) AS customer_name, c.phone,
            COALESCE(co.trade_name, co.legal_name) AS store_name
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ci.company_id
       LEFT JOIN companies co ON co.id = ci.company_id
      WHERE ci.id = $1 AND ci.company_id = $2`,
    [installmentId, companyId]
  );
  return rows[0] || null;
}

// Monta o aviso (mensagem + Pix) e registra o evento de cobranca.
// `client` vem do caller pra participar da transacao dele.
async function buildNotice(client, { companyId, installmentId, template = 'atraso_1', channel = 'whatsapp', row = null }) {
  const inst = row || await loadInstallment(client, companyId, installmentId);
  if (!inst) return null;

  const daysLate = Math.floor((Date.now() - new Date(inst.due_date)) / 86400000);

  // Pix copia-e-cola real (defensivo: qualquer falha => sem Pix, nunca erro).
  let pixCopiaECola = '';
  try {
    const { config, profile } = await loadLateContext(companyId, inst.customer_id);
    const terms = creditLedger.resolveTerms(profile, config);
    const remaining = parseFloat((parseFloat(inst.amount_due) - parseFloat(inst.covered_amount || 0)).toFixed(2));
    const lc = creditLedger.computeLateCharges(inst, terms, config);
    const totalDue = parseFloat((remaining + lc.charges_total).toFixed(2));
    const pix = await resolvePixSetup(companyId);
    if (pix && totalDue > 0) {
      pixCopiaECola = buildStaticBrCode({
        pixKey:          pix.pixKey,
        amount:          totalDue,
        beneficiaryName: pix.name,
        beneficiaryCity: pix.city,
        txid:            sanitizeTxid('CRED' + String(inst.id).replace(/-/g, '')),
      });
    }
  } catch (_) { pixCopiaECola = ''; }

  const message = buildMessage(template, {
    customerName:      inst.customer_name,
    storeName:         inst.store_name || 'Loja',
    amount:            parseFloat(inst.amount_due).toFixed(2).replace('.', ','),
    dueDate:           new Date(inst.due_date).toLocaleDateString('pt-BR'),
    installmentNum:    inst.installment_number,
    totalInstallments: inst.total_installments,
    pixLink:           pixCopiaECola || inst.pix_link || '',
    daysLate:          String(Math.max(0, daysLate)),
    daysLateNum:       daysLate,
  });

  try {
    await client.query(
      `INSERT INTO credit_collection_events
         (installment_id, channel, template, days_relative, status, message_preview)
       VALUES ($1,$2,$3,$4,'sent',$5)`,
      [inst.id, channel, template, Math.max(0, daysLate), message.slice(0, 300)]
    );
    await client.query(
      `UPDATE credit_installments SET collection_stage = collection_stage + 1, updated_at = NOW() WHERE id = $1`,
      [inst.id]
    );
  } catch (e) { if (e.code !== '42P01' && e.code !== '42703') throw e; }

  return {
    installment_id: inst.id,
    channel,
    template,
    message,
    pix_copia_cola: pixCopiaECola || null,
    phone:          inst.phone,
    days_late:      Math.max(0, daysLate),
  };
}

module.exports = {
  resolvePixSetup,
  loadLateContext,
  buildMessage,
  loadInstallment,
  buildNotice,
};
