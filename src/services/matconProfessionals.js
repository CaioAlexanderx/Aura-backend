// ============================================================
// AURA. — Matcon M3: pontos do Profissional Parceiro
//
// Schema: migration 353. Contrato: aura-app docs/CONTRACT_MATCON.md (M3).
// Rotas da tela: src/routes/matconProfessionals.js.
//
// Este servico e o que a VENDA chama. Ele NAO e acoplado ao PDV aqui: o
// orquestrador liga as duas funcoes abaixo no ponto de extensao da venda
// (src/services/matconSaleHooks.js), dentro da MESMA transacao que grava
// ou cancela a venda.
//
// ─── creditReferredSale(client, { companyId, saleId, professionalId, total })
//   Chamar DEPOIS do INSERT da venda (com o id dela), antes do COMMIT, quando
//   o POST da venda trouxer `referred_by_professional_id`.
//   - pontos = floor(total / 100) × matcon_points_per_100 (pdv_settings)
//   - grava sales.referred_by_professional_id, um lancamento `sale` no
//     extrato e soma saldo, pontos ganhos, indicacoes, total indicado e
//     last_referral_at no profissional.
//   - valida que o profissional e da empresa e esta ativo, e que o Matcon e
//     o clube estao ligados. Se nao, NAO credita e NAO derruba a venda:
//     devolve { credited: false, reason }.
//   - idempotente: chamar duas vezes para a mesma venda credita uma vez.
//   Devolve { credited: true, points, points_balance, professional_id } ou
//           { credited: false, reason } com reason ∈ INVALID_INPUT |
//           CLUB_DISABLED | PROFESSIONAL_NOT_FOUND | PROFESSIONAL_INACTIVE |
//           SALE_NOT_FOUND | ALREADY_CREDITED | SCHEMA_MISSING.
//
// ─── reverseReferredSale(client, { companyId, saleId })
//   Chamar no cancelamento da venda (DELETE /pdv/sale/:saleId e POST
//   /sales/:sale_id/cancel), dentro da transacao, antes do COMMIT. Desfaz
//   exatamente o que o credito somou (lancamento `adjust` negativo). Sem
//   credito para a venda, nao faz nada. Nao olha os toggles: desligar o
//   clube depois nao pode deixar ponto de venda cancelada no saldo.
//   Devolve { reversed: true, points, points_balance, professional_id } ou
//           { reversed: false, reason } com reason ∈ INVALID_INPUT |
//           NOT_CREDITED | ALREADY_REVERSED | SCHEMA_MISSING.
//
// NUNCA ENVENENA A TRANSACAO DA VENDA: tudo roda dentro de um SAVEPOINT.
// Tabela/coluna ausente (42P01/42703, migration 353 ainda nao aplicada) vira
// { ..., reason: 'SCHEMA_MISSING' }. Qualquer outro erro volta ao savepoint
// e SOBE — a transacao continua usavel e quem chama decide se cancela a
// venda ou so registra o erro (recomendado: registrar e seguir; ponto de
// parceiro nao vale uma venda perdida no balcao).
//
// Saldo pode ficar negativo no estorno (ver cabecalho da migration 353).
// ============================================================
'use strict';

const db = require('../config/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Espelha aura-app services/matconApi.ts (ProfessionalTrade).
const TRADES = [
  'pedreiro', 'mestre_de_obras', 'eletricista', 'encanador', 'pintor',
  'gesseiro', 'azulejista', 'arquiteto', 'engenheiro', 'marceneiro', 'outro',
];

// Defaults espelham src/routes/pdvSettings.js (DEFAULT_SETTINGS) — o jsonb
// salvo so tem o que a loja mexeu.
const CLUB_DEFAULTS = {
  matcon_enabled: false,
  matcon_club_enabled: true,
  matcon_points_per_100: 10,
  matcon_points_to_coupon: 100,
  matcon_coupon_value: 10,
};

function numOr(v, fallback, { min = 0, integer = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) return fallback;
  return integer ? Math.floor(n) : n;
}

/** Regras do clube a partir do pdv_settings cru (objeto ou null). */
function readClubSettings(pdvSettings) {
  const s = pdvSettings && typeof pdvSettings === 'object' ? pdvSettings : {};
  return {
    matcon_enabled: s.matcon_enabled === true,
    matcon_club_enabled: s.matcon_club_enabled !== false,
    matcon_points_per_100: numOr(s.matcon_points_per_100, CLUB_DEFAULTS.matcon_points_per_100, { integer: true }),
    // Cupom com 0 pontos seria cupom infinito: minimo 1.
    matcon_points_to_coupon: numOr(s.matcon_points_to_coupon, CLUB_DEFAULTS.matcon_points_to_coupon, { min: 1, integer: true }),
    matcon_coupon_value: numOr(s.matcon_coupon_value, CLUB_DEFAULTS.matcon_coupon_value),
  };
}

async function loadClubSettings(q, companyId) {
  const { rows } = await q.query('SELECT pdv_settings FROM companies WHERE id = $1', [companyId]);
  if (!rows.length) return null;
  return readClubSettings(rows[0].pdv_settings);
}

/** floor(total / 100) × pontos por R$ 100. Total invalido ou negativo = 0. */
function pointsForTotal(total, pointsPer100) {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.floor(t / 100) * (Number(pointsPer100) || 0);
}

function isSchemaMissing(err) {
  return !!err && (err.code === '42P01' || err.code === '42703');
}

// Roda `fn` dentro de um SAVEPOINT na transacao do chamador.
async function withSavepoint(client, name, fn, schemaMissingResult) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const out = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    if (isSchemaMissing(err)) {
      console.warn(`[matconProfessionals:${name}] tabela/coluna ausente (migration 353?):`, err.code);
      return schemaMissingResult;
    }
    throw err;
  }
}

async function creditReferredSale(client, { companyId, saleId, professionalId, total } = {}) {
  if (!client || !UUID_RE.test(String(companyId || '')) || !UUID_RE.test(String(saleId || ''))
      || !UUID_RE.test(String(professionalId || ''))) {
    return { credited: false, reason: 'INVALID_INPUT' };
  }

  return withSavepoint(client, 'matcon_credit_sale', async () => {
    const settings = await loadClubSettings(client, companyId);
    if (!settings || !settings.matcon_enabled || !settings.matcon_club_enabled) {
      return { credited: false, reason: 'CLUB_DISABLED' };
    }

    // FOR UPDATE: duas vendas indicadas ao mesmo tempo nao perdem soma.
    const pro = await client.query(
      `SELECT id, active FROM matcon_professionals
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [professionalId, companyId]
    );
    if (!pro.rows.length) return { credited: false, reason: 'PROFESSIONAL_NOT_FOUND' };
    if (pro.rows[0].active !== true) return { credited: false, reason: 'PROFESSIONAL_INACTIVE' };

    // A venda tem de ser desta empresa. Grava a indicacao na propria venda
    // (o POST pode ou nao ter gravado a coluna; aqui fica garantido).
    const sale = await client.query(
      `UPDATE sales SET referred_by_professional_id = $1
        WHERE id = $2 AND company_id = $3
        RETURNING created_at`,
      [professionalId, saleId, companyId]
    );
    if (!sale.rows.length) return { credited: false, reason: 'SALE_NOT_FOUND' };
    const saleAt = sale.rows[0].created_at || new Date();

    const saleTotal = Math.max(0, Math.round((Number(total) || 0) * 100) / 100);
    const points = pointsForTotal(saleTotal, settings.matcon_points_per_100);

    // Lancamento mesmo com 0 ponto (venda < R$ 100): a indicacao conta e o
    // estorno precisa saber o total. O extrato da ficha esconde delta 0.
    const led = await client.query(
      `INSERT INTO matcon_professional_points_ledger
              (company_id, professional_id, sale_id, delta, reason, sale_total, note)
       VALUES ($1, $2, $3, $4, 'sale', $5, 'Venda indicada')
       ON CONFLICT (sale_id, reason) WHERE sale_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [companyId, professionalId, saleId, points, saleTotal]
    );
    if (!led.rows.length) return { credited: false, reason: 'ALREADY_CREDITED' };

    const upd = await client.query(
      `UPDATE matcon_professionals
          SET points_balance       = points_balance + $1,
              points_earned_total  = points_earned_total + $1,
              referrals_count      = referrals_count + 1,
              referred_sales_total = referred_sales_total + $2,
              last_referral_at     = GREATEST(COALESCE(last_referral_at, $3::timestamptz), $3::timestamptz),
              updated_at           = NOW()
        WHERE id = $4 AND company_id = $5
        RETURNING points_balance`,
      [points, saleTotal, saleAt, professionalId, companyId]
    );

    return {
      credited: true,
      points,
      points_balance: Number(upd.rows[0] && upd.rows[0].points_balance) || 0,
      professional_id: professionalId,
    };
  }, { credited: false, reason: 'SCHEMA_MISSING' });
}

async function reverseReferredSale(client, { companyId, saleId } = {}) {
  if (!client || !UUID_RE.test(String(companyId || '')) || !UUID_RE.test(String(saleId || ''))) {
    return { reversed: false, reason: 'INVALID_INPUT' };
  }

  return withSavepoint(client, 'matcon_reverse_sale', async () => {
    const credit = await client.query(
      `SELECT professional_id, delta, sale_total
         FROM matcon_professional_points_ledger
        WHERE sale_id = $1 AND company_id = $2 AND reason = 'sale'`,
      [saleId, companyId]
    );
    if (!credit.rows.length) return { reversed: false, reason: 'NOT_CREDITED' };
    const { professional_id: professionalId } = credit.rows[0];
    const points = Number(credit.rows[0].delta) || 0;
    const saleTotal = Number(credit.rows[0].sale_total) || 0;

    // Trava a linha antes de mexer no saldo (mesma ordem do credito).
    await client.query(
      'SELECT id FROM matcon_professionals WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [professionalId, companyId]
    );

    const led = await client.query(
      `INSERT INTO matcon_professional_points_ledger
              (company_id, professional_id, sale_id, delta, reason, sale_total, note)
       VALUES ($1, $2, $3, $4, 'adjust', $5, 'Venda cancelada')
       ON CONFLICT (sale_id, reason) WHERE sale_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [companyId, professionalId, saleId, -points, saleTotal]
    );
    if (!led.rows.length) return { reversed: false, reason: 'ALREADY_REVERSED' };

    // last_referral_at volta para a indicacao valida mais recente (ou NULL).
    const upd = await client.query(
      `UPDATE matcon_professionals p
          SET points_balance       = p.points_balance - $1,
              points_earned_total  = GREATEST(0, p.points_earned_total - $1),
              referrals_count      = GREATEST(0, p.referrals_count - 1),
              referred_sales_total = GREATEST(0, p.referred_sales_total - $2),
              last_referral_at     = (
                SELECT MAX(s.created_at) FROM sales s
                 WHERE s.referred_by_professional_id = p.id
                   AND s.company_id = p.company_id
                   AND s.id <> $3
                   AND COALESCE(s.status, 'completed') <> 'cancelled'
              ),
              updated_at           = NOW()
        WHERE p.id = $4 AND p.company_id = $5
        RETURNING p.points_balance`,
      [points, saleTotal, saleId, professionalId, companyId]
    );

    return {
      reversed: true,
      points,
      points_balance: Number(upd.rows[0] && upd.rows[0].points_balance) || 0,
      professional_id: professionalId,
    };
  }, { reversed: false, reason: 'SCHEMA_MISSING' });
}

// ─── Lista de clientes ───────────────────────────────────────
//
// GET /customers devolve `professional: {id, trade, points_balance,
// referrals_count} | null` por cliente — SO com Matcon + clube ligados.
// Loja sem o modulo: a resposta nao ganha a chave (nenhuma diferenca de
// contrato, checklist M0). Uma query so: a linha da empresa sempre volta
// (diz se o clube esta ligado) e o LEFT JOIN so encontra parceiro quando
// esta. Parceiro desativado nao aparece (o "Marcar como parceiro" da ficha
// reativa). Tabela ausente (42P01) = segue sem a chave. Muta `customers`.
async function attachProfessionalsToCustomers(companyId, customers) {
  if (!companyId || !Array.isArray(customers) || customers.length === 0) return customers;
  const ids = customers.map((c) => c.id).filter(Boolean);
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT (co.pdv_settings->>'matcon_enabled') = 'true'
              AND COALESCE(co.pdv_settings->>'matcon_club_enabled', 'true') <> 'false' AS club_on,
              mp.customer_id, mp.id, mp.trade, mp.points_balance, mp.referrals_count
         FROM companies co
         LEFT JOIN matcon_professionals mp
           ON mp.company_id = co.id
          AND mp.customer_id = ANY($2::uuid[])
          AND mp.active = true
          AND (co.pdv_settings->>'matcon_enabled') = 'true'
          AND COALESCE(co.pdv_settings->>'matcon_club_enabled', 'true') <> 'false'
        WHERE co.id = $1`,
      [companyId, ids]
    ));
  } catch (err) {
    if (isSchemaMissing(err)) return customers;
    // Enfeite da lista: nunca derruba a lista de clientes.
    console.error('[matconProfessionals] professional na lista de clientes:', err.message);
    return customers;
  }
  if (!rows.length || rows[0].club_on !== true) return customers;

  const byCustomer = new Map();
  for (const r of rows) {
    if (!r.customer_id) continue;
    byCustomer.set(String(r.customer_id), {
      id: r.id,
      trade: r.trade,
      points_balance: Number(r.points_balance) || 0,
      referrals_count: Number(r.referrals_count) || 0,
    });
  }
  for (const c of customers) {
    c.professional = byCustomer.get(String(c.id)) || null;
  }
  return customers;
}

module.exports = {
  TRADES,
  CLUB_DEFAULTS,
  readClubSettings,
  loadClubSettings,
  pointsForTotal,
  creditReferredSale,
  reverseReferredSale,
  attachProfessionalsToCustomers,
};
