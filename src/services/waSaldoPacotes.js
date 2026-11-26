// ============================================================
// AURA — PACOTES DO SALDO DO WHATSAPP (tela nova, 26/11/2026)
//
//   novidades  100 por R$ 69      avisos  200 por R$ 19      aurinha  300 por R$ 29
//
// Reaproveita o fluxo da Fase 8b: o pedido nasce em wa_marketing_packs
// (332, agora com `bucket` pela 472) como 'pending', a cobranca avulsa
// vai ao Asaas com externalReference wa-pack-<id> e SO o webhook de
// pagamento recebido (ou a Gestao Aura) ativa. Ativar = creditar no
// livro-razao (wa_saldo_lancamentos), no saldo que o pacote comprou.
//
// Idempotente por pacote: ref_key `pacote:<id>` + indice unico por
// pack_id. Webhook reenviado, Gestao + webhook ou retry nao creditam
// duas vezes. Pacote comprado nao vence.
//
// 42P01/42703 (472 pendente): criar pacote fora de 'novidades' devolve
// null (a rota responde SCHEMA_PENDING); creditar so registra no log — a
// migration credita depois os pacotes que ja estavam ativos (backfill).
// ============================================================
'use strict';

const db = require('../config/database');
const { PACOTES, BUCKETS } = require('./waSaldo');

const ROTULO = {
  novidades: 'mensagens de novidades',
  avisos: 'avisos e cobrancas',
  aurinha: 'conversas da Aurinha',
};

function schemaMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

function pacoteDe(bucket) {
  return BUCKETS.includes(bucket) ? PACOTES[bucket] : null;
}

function descricaoCobranca(bucket, qty) {
  return `Aura — pacote de ${qty} ${ROTULO[bucket]} no WhatsApp`;
}

// Cria o pedido. O preco e a quantidade saem DAQUI, nunca do corpo da
// requisicao. null = migration pendente (a rota responde SCHEMA_PENDING).
async function criarPacote(companyId, { bucket, status = 'pending', source = 'app', createdBy = null, qty = null, priceCents = null } = {}) {
  const base = pacoteDe(bucket);
  if (!base) return null;
  try {
    const { rows } = await db.query(
      `-- wa:saldo-pacote-insert
       INSERT INTO wa_marketing_packs
         (company_id, qty, price_cents, status, source, created_by, activated_at, bucket)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $4 = 'active' THEN NOW() END, $7)
       RETURNING *`,
      [companyId, qty || base.qty, priceCents === null ? base.preco_centavos : priceCents,
        status, source, createdBy, bucket]
    );
    const pack = rows[0] || null;
    if (pack && pack.status === 'active') await creditarPacote(pack.id);
    return pack;
  } catch (e) {
    if (schemaMissing(e)) return null;
    throw e;
  }
}

// Credita o pacote ATIVO no livro-razao. Nunca lanca (quem chama e um
// webhook que ja respondeu 200 ao Asaas); devolve { creditado }.
async function creditarPacote(packId) {
  try {
    let pack;
    try {
      const r = await db.query(
        `-- wa:saldo-pacote-ler
         SELECT id, company_id, qty, status, bucket FROM wa_marketing_packs WHERE id = $1`,
        [packId]
      );
      pack = r.rows && r.rows[0];
    } catch (e) {
      if (e.code !== '42703') throw e;
      // 472 pendente: sem `bucket` o pacote e de novidades — mas sem o
      // livro-razao tambem nao ha onde creditar; o backfill da 472 cobre.
      return { creditado: false, motivo: 'MIGRATION_PENDENTE' };
    }
    if (!pack || pack.status !== 'active' || !BUCKETS.includes(pack.bucket)) return { creditado: false };
    const r = await db.query(
      `-- wa:saldo-pacote-credito
       INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, ref_key, pack_id, meta)
       VALUES ($1, $2, 'pacote', 'pacote', $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [pack.company_id, pack.bucket, pack.qty, `pacote:${pack.id}`, pack.id, JSON.stringify({ origem: 'pagamento' })]
    );
    return { creditado: !!(r.rows && r.rows.length) };
  } catch (e) {
    if (!schemaMissing(e)) console.error('[waSaldoPacotes] credito falhou:', e.code || '', e.message);
    return { creditado: false, erro: e.code || 'ERRO' };
  }
}

module.exports = { ROTULO, pacoteDe, descricaoCobranca, criarPacote, creditarPacote };
