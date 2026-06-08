// ============================================================
// AURA KARATÊ — Serviço de Carteirinha Digital (Track D / Fase 3)
//
// DECISÃO Caio (07/06): NÃO geramos a imagem da carteirinha no app.
//   - "Apenas processar o pedido e trazer as informações para a Federação."
//   - Aqui criamos/renovamos o REGISTRO da carteirinha (dados + verify_token)
//     e expomos os DADOS. A renderização visual (frente/verso, QR) é da
//     camada de design/frontend (DESIGN-14, aprovado).
//
// LGPD (§0.4 U1): o verify público devolve o MÍNIMO. Menores → nome reduzido +
//   foto oculta (registro permanece). Carteirinha SEM validade por tempo; a
//   verificação reflete a anuidade CPF (ver verifyByToken).
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');
const { getPractitionerAnnuityStatus } = require('./karateFinanceService');


function genVerifyToken() {
  return crypto.randomBytes(16).toString('hex'); // 32 chars opacos
}

function computeIsMinor(birthDate) {
  if (!birthDate) return false;
  const b = new Date(birthDate);
  if (isNaN(b.getTime())) return false;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age < 18;
}

function firstName(name) {
  return name ? String(name).trim().split(/\s+/)[0] : null;
}

// Nome reduzido p/ menores no verify publico: "Primeiro S." (1o nome + inicial do 2o)
function reducedName(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}

// Carrega o praticante + faixa atual + dojô (snapshots no momento da emissão)
async function _loadPractitionerSnapshot(client, federationId, studentId) {
  const r = await client.query(
    `SELECT cu.id, cu.name, cu.karate_registration_number, cu.dojo_id,
            cu.birth_date,
            COALESCE(cu.karate_photo_url, cu.photo_url) AS photo_url,
            cb.belt_level AS belt_snapshot,
            cb.belt_name  AS belt_name_snapshot,
            COALESCE(dj.trade_name, dj.legal_name) AS dojo_name
     FROM customers cu
     LEFT JOIN karate_current_belt cb
       ON cb.student_id = cu.id AND cb.federation_id = $2
     LEFT JOIN companies dj ON dj.id = cu.dojo_id
     WHERE cu.id = $1 AND cu.federation_id = $2
     LIMIT 1`,
    [studentId, federationId]
  );
  return r.rows[0] || null;
}

/**
 * issueCard — emite OU renova a carteirinha de um praticante (somente dados).
 * Renovar expira a carteirinha 'active' anterior e cria uma nova.
 * Retorna { card, warnings, renewed }.
 */
async function issueCard({ federation_id, student_id, issued_by }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const p = await _loadPractitionerSnapshot(client, federation_id, student_id);
    if (!p) {
      await client.query('ROLLBACK');
      const err = new Error('Praticante não encontrado nesta federação');
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Evita corrida na emissão concorrente do mesmo praticante
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '-card-' || $2::text))`,
      [federation_id, student_id]
    );

    const warnings = [];
    if (!p.karate_registration_number) {
      warnings.push('Praticante sem número de registro FPKT — carteirinha emitida, mas recomenda-se registrar.');
    }
    if (!p.belt_snapshot) {
      warnings.push('Praticante sem graduação registrada — faixa em branco na carteirinha.');
    }

    // Expira carteirinha ativa anterior (renovação)
    const prev = await client.query(
      `UPDATE karate_membership_cards
       SET status = 'expired', updated_at = NOW()
       WHERE student_id = $1 AND status = 'active'
       RETURNING id`,
      [student_id]
    );
    const renewed = prev.rows.length > 0;

    // Carteirinha SEM validade por tempo (decisao Caio 08/06): valid_until fica NULL.
    const validUntil = null;
    const isMinor = computeIsMinor(p.birth_date);
    const token = genVerifyToken();

    const ins = await client.query(
      `INSERT INTO karate_membership_cards
         (federation_id, student_id, card_number, belt_snapshot, belt_name_snapshot,
          dojo_id, dojo_name_snapshot, photo_url_snapshot, is_minor,
          issued_by, issued_at, valid_until, verify_token, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), $11, $12, 'active', NOW(), NOW())
       RETURNING id, federation_id, student_id, card_number, belt_snapshot,
                 belt_name_snapshot, dojo_id, dojo_name_snapshot, photo_url_snapshot,
                 is_minor, issued_at, valid_until, verify_token, status`,
      [
        federation_id, student_id,
        p.karate_registration_number || null,
        p.belt_snapshot || null,
        p.belt_name_snapshot || null,
        p.dojo_id || null,
        p.dojo_name || null,
        p.photo_url || null,
        isMinor,
        issued_by || null,
        validUntil,
        token,
      ]
    );

    await client.query('COMMIT');

    const c = ins.rows[0];
    return {
      renewed,
      warnings,
      card: {
        id: c.id,
        federation_id: c.federation_id,
        student_id: c.student_id,
        student_name: p.name,
        card_number: c.card_number,
        belt: c.belt_snapshot,
        belt_name: c.belt_name_snapshot,
        dojo_id: c.dojo_id,
        dojo_name: c.dojo_name_snapshot,
        photo_url: c.photo_url_snapshot,
        is_minor: c.is_minor,
        issued_at: c.issued_at,
        verify_token: c.verify_token,
        status: c.status,
      },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/** getCurrentCard — carteirinha mais recente do praticante (visão admin/interna/holder).
 *  Inclui birth_date + cpf (contexto AUTENTICADO) para a arte aprovada da carteirinha. */
async function getCurrentCard({ federation_id, student_id }) {
  const r = await db.query(
    `SELECT kc.*, cu.name AS student_name, cu.birth_date, cu.cpf_cnpj
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     WHERE kc.student_id = $1 AND kc.federation_id = $2
     ORDER BY kc.issued_at DESC
     LIMIT 1`,
    [student_id, federation_id]
  );
  if (!r.rows.length) return null;
  const c = r.rows[0];
  return {
    id: c.id,
    federation_id: c.federation_id,
    student_id: c.student_id,
    student_name: c.student_name,
    birth_date: c.birth_date,   // contexto autenticado/admin (NUNCA no verify publico)
    cpf: c.cpf_cnpj || null,    // contexto autenticado/admin (NUNCA no verify publico)
    card_number: c.card_number,
    belt: c.belt_snapshot,
    belt_name: c.belt_name_snapshot,
    dojo_id: c.dojo_id,
    dojo_name: c.dojo_name_snapshot,
    photo_url: c.photo_url_snapshot,
    is_minor: c.is_minor,
    issued_at: c.issued_at,
    verify_token: c.verify_token,
    status: effectiveStatus(c),
  };
}

function effectiveStatus(card) {
  // Carteirinha SEM validade por tempo: status reflete apenas o estado armazenado
  // (active | revoked). Nao ha 'expired' por vencimento.
  return card.status;
}

/**
 * verifyByToken — DADOS MÍNIMOS para a página pública de verificação (LGPD).
 * Nunca expõe CPF, data de nascimento, contato ou histórico de graduações.
 * Menores: nome reduzido ("Primeiro S.") + foto oculta (frontend); o nº de
 * registro permanece visível (decisão FPKT — é o identificador público).
 *
 * Situação (status): 'valida' | 'vencida' | 'revogada'
 *   - 'revogada' quando a carteirinha foi revogada pela federação.
 *   - senão deriva da ANUIDADE CPF (vencida = anuidade em atraso); validade = due_date.
 * Faixa exibida é a ATUAL (karate_current_belt), com fallback ao snapshot do cartão.
 */
async function verifyByToken(token) {
  if (!token || !/^[a-f0-9]{16,64}$/i.test(token)) return null;
  const r = await db.query(
    `SELECT kc.card_number, kc.is_minor, kc.status AS card_status,
            kc.student_id, kc.federation_id,
            kc.dojo_name_snapshot,
            cu.name AS student_name,
            COALESCE(cb.belt_level, kc.belt_snapshot)      AS belt,
            COALESCE(cb.belt_name,  kc.belt_name_snapshot) AS belt_name,
            cb.current_since AS belt_since,
            COALESCE(fed.trade_name, fed.legal_name) AS federation_name,
            COALESCE(fed.karate_logo_url, fed.logo_url) AS federation_logo
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     LEFT JOIN karate_current_belt cb
       ON cb.student_id = kc.student_id AND cb.federation_id = kc.federation_id
     LEFT JOIN companies fed ON fed.id = kc.federation_id
     WHERE kc.verify_token = $1
     LIMIT 1`,
    [token]
  );
  if (!r.rows.length) return null;
  const c = r.rows[0];

  // Situação: revogada (cartão) tem prioridade; senão anuidade CPF
  let situacao = 'valida';
  let validade = null;
  if (c.card_status === 'revoked') {
    situacao = 'revogada';
  } else {
    const ann = await getPractitionerAnnuityStatus(c.student_id, c.federation_id);
    situacao = ann.situacao;      // 'valida' | 'vencida'
    validade = ann.validade;      // due_date ou null
  }
  const valid = situacao === 'valida';

  const base = {
    valid,
    status: situacao,             // 'valida' | 'vencida' | 'revogada'
    validade,                     // referência da anuidade (due_date) ou null
    belt: c.belt || null,         // nível (ex.: '2dan')
    belt_name: c.belt_name || null,
    belt_since: c.belt_since || null,
    dojo_name: c.dojo_name_snapshot || null,
    federation_name: c.federation_name || null,
    federation_logo: c.federation_logo || null,
    is_minor: c.is_minor,
  };

  if (c.is_minor) {
    // LGPD Art. 14 — nome reduzido + foto oculta (frontend); registro permanece
    return { ...base, display_name: reducedName(c.student_name), card_number: c.card_number || null };
  }
  return { ...base, display_name: c.student_name, card_number: c.card_number || null };
}

/** listCards — listagem interna (admin/staff). */
async function listCards({ federation_id, status, page = 1, pageSize = 25 }) {
  const conds = ['kc.federation_id = $1'];
  const params = [federation_id];
  let n = 2;
  if (status) { conds.push(`kc.status = $${n}`); params.push(status); n++; }
  const where = `WHERE ${conds.join(' AND ')}`;
  const off = (Math.max(1, page) - 1) * pageSize;

  const cnt = await db.query(`SELECT COUNT(*) AS total FROM karate_membership_cards kc ${where}`, params);
  const rows = await db.query(
    `SELECT kc.id, kc.student_id, kc.card_number, kc.belt_name_snapshot,
            kc.dojo_name_snapshot, kc.is_minor, kc.valid_until, kc.status, kc.issued_at,
            cu.name AS student_name
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     ${where}
     ORDER BY kc.issued_at DESC
     LIMIT $${n} OFFSET $${n + 1}`,
    [...params, pageSize, off]
  );
  return {
    page: Math.max(1, page),
    page_size: pageSize,
    total: parseInt(cnt.rows[0].total, 10),
    data: rows.rows.map(c => ({
      id: c.id,
      student_id: c.student_id,
      student_name: c.student_name,
      card_number: c.card_number,
      belt_name: c.belt_name_snapshot,
      dojo_name: c.dojo_name_snapshot,
      is_minor: c.is_minor,
      status: effectiveStatus(c),
      issued_at: c.issued_at,
    })),
  };
}

/**
 * issueBatch — emite/renova carteirinhas em lote para praticantes ativos
 * com número de registro. Não bloqueia por anuidade (decisão: só processa
 * e traz a informação; pendências viram warnings por carteirinha).
 */
async function issueBatch({ federation_id, issued_by, only_missing = true }) {
  const cand = await db.query(
    `SELECT cu.id
     FROM customers cu
     WHERE cu.federation_id = $1
       AND cu.is_active = true
       AND cu.karate_registration_number IS NOT NULL
       ${only_missing ? `AND NOT EXISTS (
         SELECT 1 FROM karate_membership_cards kc
         WHERE kc.student_id = cu.id AND kc.status = 'active'
       )` : ''}`,
    [federation_id]
  );

  let issued = 0;
  const errors = [];
  for (const row of cand.rows) {
    try {
      await issueCard({ federation_id, student_id: row.id, issued_by });
      issued++;
    } catch (e) {
      errors.push({ student_id: row.id, error: e.message });
    }
  }
  return { eligible: cand.rows.length, issued, errors };
}

module.exports = {
  issueCard,
  getCurrentCard,
  verifyByToken,
  listCards,
  issueBatch,
  effectiveStatus,
  computeIsMinor,
};
