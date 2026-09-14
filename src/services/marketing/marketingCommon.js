// ============================================================
// AURA — FASES 7/8: peças comuns do MARKETING pelo WhatsApp oficial
//
// Reativação e aniversário mandam a MESMA coisa em momentos diferentes:
// um cupom com código, desconto e validade, num template de categoria
// MARKETING. O que é igual nas duas mora aqui — o cupom, o texto do
// desconto, o log, o gate das telas de configuração — para as duas
// rotinas não divergirem em silêncio (memória do repo: "as duas lojas
// divergem em silêncio").
//
// Princípio nº 1 da spec continua: CADA MENSAGEM CUSTA DINHEIRO. Aqui
// custa MAIS — marketing é a categoria cara da Meta, tem limite por
// usuário e derruba a qualidade do número quando incomoda. Nenhuma
// guarda nova mora neste arquivo: todas vivem no waOutbox (consentimento,
// frequência de 7 dias, qualidade YELLOW, teto de marketing, bloqueio do
// 131049) e valem no enfileirar E no despachar.
//
// Migration 331 pode não estar aplicada quando o deploy sobe: toda
// consulta nas colunas/tabelas novas é 42703/42P01-safe, e a direção
// segura é sempre "não manda" — sem consentimento gravado, nada sai.
// ============================================================
'use strict';

const db = require('../../config/database');
const waOutbox = require('../waOutbox');
const addons = require('../addons');

const TEMPLATE_REATIVACAO = 'reativacao_cupom';
const TEMPLATE_ANIVERSARIO = 'aniversario_cupom';

const KIND_REATIVACAO = 'reativacao';
const KIND_ANIVERSARIO = 'aniversario';

// Origem do cupom em coupons.source (CHECK da 065/267). Aniversário já
// existia; reativação estava na lista desde a 065 e nunca tinha sido
// usada por ninguém.
const COUPON_SOURCE = {
  [KIND_ANIVERSARIO]: 'birthday',
  [KIND_REATIVACAO]: 'reactivation',
};

// Defaults do cupom por rotina. O de aniversário é o mesmo do fluxo
// manual (birthday.js) — trocar o valor por baixo do lojista seria
// mudar o presente que ele já escolheu. O de reativação tem validade
// mais curta de propósito: a urgência é metade do motivo de voltar.
const DEFAULTS = {
  [KIND_ANIVERSARIO]: {
    discount_type: 'percent', discount_value: 10, validity_days: 7,
    min_order_value: 0, max_uses: 1,
  },
  [KIND_REATIVACAO]: {
    discount_type: 'percent', discount_value: 10, validity_days: 15,
    min_order_value: 0, max_uses: 1,
  },
};

const CODE_PREFIX = {
  [KIND_ANIVERSARIO]: 'ANIV',
  [KIND_REATIVACAO]: 'VOLTA',
};

function schemaMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

// "Hoje" do lojista é o dia dele (America/Sao_Paulo), não o do UTC — um
// aniversário às 22h viraria o dia seguinte e a pessoa receberia o
// parabéns atrasado.
function hojeBRT(today) {
  if (today) return new Date(`${String(today).slice(0, 10)}T12:00:00-03:00`);
  return new Date(Date.now() - 3 * 3600000);
}

function formatDateBR(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const iso = new Date(d.getTime() - 3 * 3600000).toISOString();
  const [y, m, dia] = iso.slice(0, 10).split('-');
  return `${dia}/${m}/${y}`;
}

// O texto que entra no {{3}} do template: a Meta recebe um parâmetro de
// texto, não um número — "10% de desconto" e "R$ 10,00 de desconto" são
// frases diferentes e a errada faz a mensagem parecer golpe.
function describeDiscount(type, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'um desconto especial';
  if (type === 'fixed') {
    return `R$ ${n.toFixed(2).replace('.', ',')} de desconto`;
  }
  const pct = Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
  return `${pct}% de desconto`;
}

// Defaults efetivos do cupom. `reactivation_coupon_defaults` chega na
// 331: com a migration pendente a coluna não existe (42703) e o fallback
// é o do aniversário, que o lojista já configurou — melhor mandar o
// desconto que ele conhece do que inventar um.
async function loadCouponDefaults(companyId, kind) {
  const base = { ...(DEFAULTS[kind] || DEFAULTS[KIND_ANIVERSARIO]) };
  if (kind === KIND_REATIVACAO) {
    try {
      const { rows } = await db.query(
        `-- mkt:coupon-defaults-reativacao
         SELECT reactivation_coupon_defaults, birthday_coupon_defaults
           FROM companies WHERE id = $1 LIMIT 1`,
        [companyId]
      );
      const r = rows[0] || {};
      const proprio = r.reactivation_coupon_defaults || {};
      const usar = Object.keys(proprio).length ? proprio : (r.birthday_coupon_defaults || {});
      return { ...base, ...usar };
    } catch (e) {
      if (!schemaMissing(e)) throw e;
      // 331 pendente: tenta só o do aniversário (065, sempre existe).
      try {
        const { rows } = await db.query(
          `-- mkt:coupon-defaults-legado
           SELECT birthday_coupon_defaults FROM companies WHERE id = $1 LIMIT 1`,
          [companyId]
        );
        return { ...base, ...((rows[0] && rows[0].birthday_coupon_defaults) || {}) };
      } catch (e2) {
        if (!schemaMissing(e2)) throw e2;
        return base;
      }
    }
  }
  try {
    const { rows } = await db.query(
      `-- mkt:coupon-defaults-aniversario
       SELECT birthday_coupon_defaults FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return { ...base, ...((rows[0] && rows[0].birthday_coupon_defaults) || {}) };
  } catch (e) {
    if (!schemaMissing(e)) throw e;
    return base;
  }
}

function generateCode(kind, customerName, attempt = 0) {
  const raw = String(customerName || 'CLIENTE')
    .trim()
    .split(/\s+/)[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  const yy = String(new Date().getFullYear()).slice(-2);
  const suffix = attempt > 0 ? `-${attempt + 1}` : '';
  return `${CODE_PREFIX[kind] || 'CUPOM'}-${raw || 'CLIENTE'}-${yy}${suffix}`;
}

// Cria o cupom que vai DENTRO da mensagem. Tem que existir antes do
// envio (o código é um parâmetro do template), então o cupom nasce só
// depois de as guardas terem dito que a mensagem pode sair — senão cada
// guarda deixaria um cupom órfão no banco.
async function createCoupon(companyId, customer, kind, overrides = {}) {
  const defaults = { ...(await loadCouponDefaults(companyId, kind)), ...overrides };
  const discountType = ['percent', 'fixed'].includes(defaults.discount_type) ? defaults.discount_type : 'percent';
  const discountValue = Number(defaults.discount_value);
  if (!Number.isFinite(discountValue) || discountValue <= 0) return null;
  const validityDays = parseInt(defaults.validity_days, 10) || 7;
  const minOrder = Number(defaults.min_order_value) || 0;
  const maxUses = defaults.max_uses == null ? 1 : parseInt(defaults.max_uses, 10) || 1;

  const expires = new Date();
  expires.setDate(expires.getDate() + validityDays);
  expires.setHours(23, 59, 59, 999);

  const descricao = kind === KIND_ANIVERSARIO
    ? `Aniversário de ${customer.name || 'cliente'}`
    : `Reativação de ${customer.name || 'cliente'}`;

  let code = generateCode(kind, customer.name);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await db.query(
        `-- mkt:cupom-insert
         INSERT INTO coupons (company_id, code, description, discount_type, discount_value,
                              min_order_value, max_uses, expires_at, customer_id, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [companyId, code, descricao, discountType, discountValue, minOrder, maxUses,
         expires.toISOString(), customer.id, COUPON_SOURCE[kind] || 'campaign']
      );
      return rows[0] || null;
    } catch (e) {
      // 23505 = código repetido. Só esse caso ganha nova tentativa; erro
      // de schema ou de constraint diferente sobe (um catch tolerante
      // demais aqui esconderia cupom sendo criado errado).
      if (e.code !== '23505') throw e;
      code = generateCode(kind, customer.name, attempt + 1);
    }
  }
  return null;
}

async function loadCoupon(companyId, couponId) {
  const { rows } = await db.query(
    `-- mkt:cupom-get
     SELECT * FROM coupons WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [couponId, companyId]
  );
  return rows[0] || null;
}

// Histórico do marketing (331). Devolve null com a migration pendente —
// e é por isso que nada de marketing sai nesse estado: sem log não há
// dedupe, e sem dedupe a pessoa receberia a mesma promoção todo dia.
async function logMarketing({ companyId, customerId, kind, segment = null, couponId = null, waOutboxId = null, refYear = null, status = 'queued' }) {
  try {
    const { rows } = await db.query(
      `-- mkt:log-insert
       INSERT INTO wa_marketing_log
         (company_id, customer_id, kind, segment, coupon_id, wa_outbox_id, ref_year, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [companyId, customerId, kind, segment, couponId, waOutboxId, refYear, status]
    );
    return rows[0] || null;
  } catch (e) {
    if (schemaMissing(e)) return null;
    throw e;
  }
}

// Este cliente já recebeu esta rotina de marketing na janela? 331
// pendente → false, mas nesse estado o consentimento também não existe e
// nada chega até aqui.
async function jaRecebeu(companyId, customerId, kind, { days = null, refYear = null } = {}) {
  try {
    const { rows } = await db.query(
      `-- mkt:log-recente
       SELECT 1 FROM wa_marketing_log
        WHERE company_id = $1 AND customer_id = $2 AND kind = $3
          AND ($4::int IS NULL OR created_at > NOW() - ($4::int || ' days')::interval)
          AND ($5::int IS NULL OR ref_year = $5::int)
        LIMIT 1`,
      [companyId, customerId, kind, days, refYear]
    );
    return rows.length > 0;
  } catch (e) {
    if (schemaMissing(e)) return false;
    throw e;
  }
}

// Nome da loja para o {{2}} do template. companies não tem coluna `name`
// (armadilha nº 2 do CLAUDE.md) — sempre COALESCE(trade_name, legal_name).
async function loadStoreName(companyId) {
  try {
    const { rows } = await db.query(
      `-- mkt:store-name
       SELECT COALESCE(trade_name, legal_name) AS store_name FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return (rows[0] && rows[0].store_name) || 'nossa loja';
  } catch (e) {
    if (schemaMissing(e)) return 'nossa loja';
    throw e;
  }
}

// Parâmetro que a Meta ACEITA: nunca vazio, sem quebra de linha, sem
// tabulação e sem 4+ espaços seguidos (erro 132012 queima a tentativa
// paga). Mesma regra do crediário — repetida porque é o contrato da
// Meta, não uma escolha nossa.
function waParam(value, fallback) {
  const txt = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
  return txt || String(fallback);
}

// Os 5 parâmetros dos dois presets de marketing, na mesma ordem:
//   {{1}} cliente · {{2}} loja · {{3}} desconto · {{4}} validade · {{5}} código
function buildComponents({ customerName, storeName, discountText, validUntil, code }) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: waParam(customerName, 'Cliente') },
      { type: 'text', text: waParam(storeName, 'nossa loja') },
      { type: 'text', text: waParam(discountText, 'um desconto especial') },
      { type: 'text', text: waParam(validUntil, 'em breve') },
      { type: 'text', text: waParam(code, 'CUPOM') },
    ],
  }];
}

// ── Gate das telas de configuração ──────────────────────────
// Quatro motivos DIFERENTES para "não pode ligar", cada um com a ação que
// resolve: não está no plano, não conectou, o template não foi aprovado,
// o lojista não declarou o consentimento dos clientes. Um 403 genérico
// deixaria a pessoa clicando no mesmo botão travado.
async function marketingGate(companyId, templateName) {
  if (!(await addons.canAutoWhatsapp(companyId))) {
    return {
      ok: false, status: 403, code: 'ADDON_REQUIRED',
      error: 'O envio automático por WhatsApp não está no seu plano. Fale com a Aura para ativar.',
    };
  }
  const conn = await waOutbox.connectionState(companyId);
  if (!conn.connected) {
    return {
      ok: false, status: 409, code: 'NAO_CONECTADO',
      error: conn.token_expired
        ? 'A conexão com o WhatsApp expirou. Reconecte o número da loja antes de ligar o envio automático.'
        : 'Conecte o número de WhatsApp da loja antes de ligar o envio automático.',
    };
  }
  if (templateName && !(await waOutbox.isTemplateApproved(companyId, templateName, 'pt_BR'))) {
    return {
      ok: false, status: 409, code: 'TEMPLATE_NAO_APROVADO',
      error: 'O template desta mensagem ainda não foi aprovado pela Meta.',
    };
  }
  if (!(await waOutbox.hasMarketingConsent(companyId))) {
    return {
      ok: false, status: 409, code: 'SEM_CONSENTIMENTO',
      error: 'Confirme que os seus clientes autorizaram receber mensagens da loja pelo WhatsApp antes de ligar o envio automático.',
    };
  }
  return { ok: true };
}

// Carimba (ou limpa) a declaração de consentimento. Devolve false com a
// 331 pendente — quem chama responde SCHEMA_PENDING em vez de fingir que
// salvou.
async function setMarketingConsent(companyId, consent) {
  try {
    await db.query(
      `-- mkt:consent-set
       UPDATE companies SET wa_marketing_consent_at = CASE WHEN $2 THEN NOW() ELSE NULL END
        WHERE id = $1`,
      [companyId, !!consent]
    );
    return true;
  } catch (e) {
    if (schemaMissing(e)) return false;
    throw e;
  }
}

// Interruptor das rotinas automáticas. A coluna vem de uma lista fechada
// — nome de coluna nunca entra por interpolação vinda do body.
const AUTO_COLUMNS = new Set(['wa_reactivation_auto', 'wa_birthday_auto']);

async function setAutoFlag(companyId, column, value) {
  if (!AUTO_COLUMNS.has(column)) throw new Error(`coluna de interruptor desconhecida: ${column}`);
  try {
    await db.query(
      `-- mkt:auto-flag-set
       UPDATE companies SET ${column} = $2 WHERE id = $1`,
      [companyId, !!value]
    );
    return true;
  } catch (e) {
    if (schemaMissing(e)) return false;
    throw e;
  }
}

// Estado das duas rotinas + consentimento, para as telas de configuração.
// 42703 (331 pendente) → tudo desligado, que é a verdade.
async function loadMarketingSettings(companyId) {
  try {
    const { rows } = await db.query(
      `-- mkt:settings-get
       SELECT wa_marketing_consent_at, wa_reactivation_auto, wa_birthday_auto,
              reactivation_coupon_defaults
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const r = rows[0] || {};
    return {
      wa_marketing_consent_at: r.wa_marketing_consent_at || null,
      wa_reactivation_auto: r.wa_reactivation_auto === true,
      wa_birthday_auto: r.wa_birthday_auto === true,
      reactivation_coupon_defaults: r.reactivation_coupon_defaults || {},
      schema_pending: false,
    };
  } catch (e) {
    if (!schemaMissing(e)) throw e;
    return {
      wa_marketing_consent_at: null,
      wa_reactivation_auto: false,
      wa_birthday_auto: false,
      reactivation_coupon_defaults: {},
      schema_pending: true,
    };
  }
}

// Companies com a rotina ligada. Lista vazia com a 331 pendente: o job
// vira no-op silencioso em vez de gritar todo dia sobre migration que
// ainda não subiu.
async function listCompaniesWithAuto(column) {
  if (!AUTO_COLUMNS.has(column)) throw new Error(`coluna de interruptor desconhecida: ${column}`);
  try {
    const { rows } = await db.query(
      `-- mkt:auto-companies
       SELECT id FROM companies WHERE ${column} = true AND wa_marketing_consent_at IS NOT NULL`
    );
    return rows.map((r) => r.id);
  } catch (e) {
    if (schemaMissing(e)) return [];
    throw e;
  }
}

module.exports = {
  TEMPLATE_REATIVACAO, TEMPLATE_ANIVERSARIO,
  KIND_REATIVACAO, KIND_ANIVERSARIO,
  COUPON_SOURCE, DEFAULTS,
  schemaMissing, hojeBRT, formatDateBR, describeDiscount, generateCode,
  loadCouponDefaults, createCoupon, loadCoupon,
  logMarketing, jaRecebeu, loadStoreName,
  waParam, buildComponents,
  marketingGate, setMarketingConsent, setAutoFlag,
  loadMarketingSettings, listCompaniesWithAuto,
};
