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
//
// 25/06/2026 (decisão Caio — liberdade total da federação): revogação de
//   carteirinha. revokeCard() seta status='revoked' (+ revoked_at se a coluna
//   existir — migration 191). Idempotente. verifyByToken já trata 'revoked'.
//   Emitir de novo após revogar gera uma nova carteirinha 'active' (issueCard
//   só expira a 'active' anterior; 'revoked' fica preservada no histórico).
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
            to_char(cu.birth_date, 'YYYY-MM-DD') AS birth_date,
            cu.cpf_cnpj,
            COALESCE(cu.karate_photo_url, cu.photo_url) AS photo_url,
            cb.belt_level AS belt_snapshot,
            cb.belt_name  AS belt_name_snapshot,
            COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
            COALESCE(fed.trade_name, fed.legal_name) AS federation_name,
            COALESCE(fed.karate_logo_url, fed.logo_url) AS federation_logo
     FROM customers cu
     LEFT JOIN karate_current_belt cb
       ON cb.student_id = cu.id AND cb.federation_id = $2
     LEFT JOIN companies dj ON dj.id = cu.dojo_id
     LEFT JOIN companies fed ON fed.id = $2
     WHERE cu.id = $1 AND cu.federation_id = $2
     LIMIT 1`,
    [studentId, federationId]
  );
  return r.rows[0] || null;
}

/**
 * issueCard — emite OU renova a carteirinha de um praticante (somente dados).
 * Renovar expira a carteirinha 'active' anterior e cria uma nova.
 * Carteirinhas 'revoked' NÃO são tocadas (ficam no histórico); emitir após
 * uma revogação simplesmente cria uma nova carteirinha ativa.
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

    // 17/07/2026 (decisão Caio, fechando bug pré-existente): matrícula FPKT é
    // pré-requisito DURO para existir carteirinha — o número é emitido pela
    // federação fora do sistema, uma carteirinha com card_number NULL não
    // pode existir. Antes disso era só um warning (issueBatch já filtrava
    // karate_registration_number IS NOT NULL nos candidatos, então nunca
    // pegava isso na prática; mas o botão manual — POST /issue-card — não
    // filtrava nada e deixava passar, gerando carteirinha com número NULL).
    // Bloqueando aqui, na função compartilhada pelos 3 call sites
    // (issue-card manual, issueBatch, e a nova emissão via upload de foto),
    // fecha o buraco pra sempre, e não só no chamador que eu lembrei de
    // consertar hoje.
    if (!p.karate_registration_number) {
      await client.query('ROLLBACK');
      const err = new Error('Praticante sem número de matrícula FPKT — carteirinha não pode ser emitida sem matrícula.');
      err.code = 'FPKT_NUMBER_REQUIRED';
      throw err;
    }

    const warnings = [];
    if (!p.belt_snapshot) {
      warnings.push('Praticante sem graduação registrada — faixa em branco na carteirinha.');
    }

    // Expira carteirinha ativa anterior (renovação). Só a 'active' — uma
    // carteirinha 'revoked' permanece intacta no histórico.
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
        birth_date: p.birth_date || null,   // ja formatado YYYY-MM-DD (tz-safe)
        cpf: p.cpf_cnpj || null,
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
        federation_name: p.federation_name || null,
        federation_logo: p.federation_logo || null,
      },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * revokeCard — revoga a carteirinha ATUAL do praticante (status='revoked').
 * Decisão Caio (25/06): a federação pode invalidar uma carteirinha emitida.
 *   - Idempotente: revogar uma carteirinha já 'revoked' devolve ok (revoked).
 *   - Seta revoked_at se a coluna existir (migration 191); defensivo a 42703
 *     para ser seguro mergear antes da migration ser aplicada.
 *   - Não apaga o registro (histórico/verificação pública preservados);
 *     verifyByToken já retorna situacao='revogada'.
 *   - Sem carteirinha → NOT_FOUND.
 * Retorna { card, alreadyRevoked }.
 */
async function revokeCard({ federation_id, student_id, revoked_by }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Carteirinha mais recente do praticante (trava a linha).
    const cur = await client.query(
      `SELECT id, status FROM karate_membership_cards
       WHERE student_id = $1 AND federation_id = $2
       ORDER BY issued_at DESC
       LIMIT 1
       FOR UPDATE`,
      [student_id, federation_id]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      const err = new Error('Praticante sem carteirinha para revogar');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const card = cur.rows[0];
    const alreadyRevoked = card.status === 'revoked';

    if (!alreadyRevoked) {
      // Tenta gravar revoked_at (migration 191). Se a coluna ainda não existe
      // (42703), faz o update sem ela — comportamento degradado, mas seguro.
      try {
        await client.query(
          `UPDATE karate_membership_cards
           SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [card.id]
        );
      } catch (e) {
        if (e.code === '42703') {
          await client.query(
            `UPDATE karate_membership_cards
             SET status = 'revoked', updated_at = NOW()
             WHERE id = $1`,
            [card.id]
          );
        } else {
          throw e;
        }
      }
    }

    await client.query('COMMIT');

    // Re-lê os dados para devolver a carteirinha já no estado revogado.
    const refreshed = await getCurrentCard({ federation_id, student_id });
    return { card: refreshed, alreadyRevoked };
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
    // Estrutura (faixa/dojô/foto/matrícula) derivada AO VIVO do praticante atual,
    // com fallback ao snapshot da emissão. Assim a carteirinha reflete
    // automaticamente qualquer mudança de dado (troca de dojô, novo Dan, etc.).
    `SELECT kc.*, cu.name AS student_name,
            to_char(cu.birth_date, 'YYYY-MM-DD') AS birth_date,
            cu.cpf_cnpj,
            COALESCE(cb.belt_level, kc.belt_snapshot)                          AS belt_live,
            COALESCE(cb.belt_name,  kc.belt_name_snapshot)                     AS belt_name_live,
            COALESCE(cu.dojo_id, kc.dojo_id)                                   AS dojo_id_live,
            COALESCE(dj.trade_name, dj.legal_name, kc.dojo_name_snapshot)      AS dojo_name_live,
            COALESCE(cu.karate_photo_url, cu.photo_url, kc.photo_url_snapshot) AS photo_url_live,
            COALESCE(cu.karate_registration_number, kc.card_number)           AS card_number_live,
            -- Nº CBKT da faixa VIGENTE (casado pelo belt_name atual) — usado na
            -- carteirinha do faixa-preta. NULL para faixas sem CBKT registrado.
            (SELECT bh.cbkt_number FROM karate_belt_history bh
              WHERE bh.student_id = cu.id AND bh.federation_id = kc.federation_id
                AND bh.belt_name = COALESCE(cb.belt_name, kc.belt_name_snapshot)
                AND bh.cbkt_number IS NOT NULL
              ORDER BY bh.graduated_at DESC NULLS LAST LIMIT 1)             AS cbkt_number_live,
            COALESCE(fed.trade_name, fed.legal_name) AS federation_name,
            COALESCE(fed.karate_logo_url, fed.logo_url) AS federation_logo
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = kc.federation_id
     LEFT JOIN companies dj ON dj.id = cu.dojo_id
     LEFT JOIN companies fed ON fed.id = kc.federation_id
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
    birth_date: c.birth_date,   // contexto autenticado/admin (NUNCA no verify publico); ja YYYY-MM-DD (tz-safe)
    cpf: c.cpf_cnpj || null,    // contexto autenticado/admin (NUNCA no verify publico)
    card_number: c.card_number_live,
    cbkt_number: c.cbkt_number_live || null,
    belt: c.belt_live,
    belt_name: c.belt_name_live,
    dojo_id: c.dojo_id_live,
    dojo_name: c.dojo_name_live,
    photo_url: c.photo_url_live,
    is_minor: computeIsMinor(c.birth_date),
    issued_at: c.issued_at,
    revoked_at: c.revoked_at || null,
    verify_token: c.verify_token,
    status: effectiveStatus(c),
    federation_name: c.federation_name || null,
    federation_logo: c.federation_logo || null,
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
    // Faixa, dojô e matrícula exibidos são os ATUAIS (live), com fallback ao
    // snapshot — a verificação pública também reflete mudanças automaticamente.
    `SELECT COALESCE(cu.karate_registration_number, kc.card_number) AS card_number,
            kc.status AS card_status,
            kc.student_id, kc.federation_id,
            to_char(cu.birth_date, 'YYYY-MM-DD') AS birth_date,
            cu.name AS student_name,
            COALESCE(cb.belt_level, kc.belt_snapshot)      AS belt,
            COALESCE(cb.belt_name,  kc.belt_name_snapshot) AS belt_name,
            to_char(cb.current_since, 'YYYY-MM-DD') AS belt_since,
            (SELECT bh.cbkt_number FROM karate_belt_history bh
              WHERE bh.student_id = kc.student_id AND bh.federation_id = kc.federation_id
                AND bh.belt_name = COALESCE(cb.belt_name, kc.belt_name_snapshot)
                AND bh.cbkt_number IS NOT NULL
              ORDER BY bh.graduated_at DESC NULLS LAST LIMIT 1) AS cbkt_number,
            COALESCE(dj.trade_name, dj.legal_name, kc.dojo_name_snapshot) AS dojo_name,
            COALESCE(fed.trade_name, fed.legal_name) AS federation_name,
            COALESCE(fed.karate_logo_url, fed.logo_url) AS federation_logo
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     LEFT JOIN karate_current_belt cb
       ON cb.student_id = kc.student_id AND cb.federation_id = kc.federation_id
     LEFT JOIN companies dj ON dj.id = cu.dojo_id
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
  // is_minor derivado ao vivo da data de nascimento atual (LGPD depende disso).
  const isMinorLive = computeIsMinor(c.birth_date);

  const base = {
    valid,
    status: situacao,             // 'valida' | 'vencida' | 'revogada'
    validade,                     // referência da anuidade (due_date) ou null
    belt: c.belt || null,         // nível (ex.: '2dan')
    belt_name: c.belt_name || null,
    belt_since: c.belt_since || null,
    cbkt_number: c.cbkt_number || null,
    dojo_name: c.dojo_name || null,
    federation_name: c.federation_name || null,
    federation_logo: c.federation_logo || null,
    is_minor: isMinorLive,
  };

  if (isMinorLive) {
    // LGPD Art. 14 — nome reduzido + foto oculta (frontend); registro permanece
    return { ...base, display_name: reducedName(c.student_name), card_number: c.card_number || null };
  }
  return { ...base, display_name: c.student_name, card_number: c.card_number || null };
}

/**
 * getCardCopyByToken — cópia digital autenticada por identidade (Item 6).
 * O praticante prova quem é informando RG ou CPF; se bater com o cadastro,
 * devolve o cartão COMPLETO (mesma forma de getCurrentCard) para gerar o PDF
 * frente/verso. Se o cadastro não tiver NEM RG NEM CPF, devolve no_identity +
 * WhatsApp da federação (fallback de contato). Nunca vaza dados sem match.
 */
function onlyDigitsCard(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

async function getCardCopyByToken(token, identifier) {
  if (!token || !/^[a-f0-9]{16,64}$/i.test(token)) return { not_found: true };
  const r = await db.query(
    `SELECT kc.id, kc.federation_id, kc.student_id, kc.issued_at, kc.verify_token, kc.status,
            cu.name AS student_name,
            to_char(cu.birth_date, 'YYYY-MM-DD') AS birth_date,
            cu.cpf_cnpj, cu.rg,
            COALESCE(cb.belt_level, kc.belt_snapshot)                          AS belt_live,
            COALESCE(cb.belt_name,  kc.belt_name_snapshot)                     AS belt_name_live,
            COALESCE(dj.trade_name, dj.legal_name, kc.dojo_name_snapshot)      AS dojo_name_live,
            COALESCE(cu.karate_photo_url, cu.photo_url, kc.photo_url_snapshot) AS photo_url_live,
            COALESCE(cu.karate_registration_number, kc.card_number)           AS card_number_live,
            (SELECT bh.cbkt_number FROM karate_belt_history bh
              WHERE bh.student_id = cu.id AND bh.federation_id = kc.federation_id
                AND bh.belt_name = COALESCE(cb.belt_name, kc.belt_name_snapshot)
                AND bh.cbkt_number IS NOT NULL
              ORDER BY bh.graduated_at DESC NULLS LAST LIMIT 1)             AS cbkt_number_live,
            COALESCE(fed.trade_name, fed.legal_name) AS federation_name,
            COALESCE(fed.karate_logo_url, fed.logo_url) AS federation_logo,
            COALESCE(NULLIF(fed.wa_phone_display, ''), fed.phone) AS federation_whatsapp
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = kc.federation_id
     LEFT JOIN companies dj ON dj.id = cu.dojo_id
     LEFT JOIN companies fed ON fed.id = kc.federation_id
     WHERE kc.verify_token = $1
     ORDER BY kc.issued_at DESC
     LIMIT 1`,
    [token]
  );
  if (!r.rows.length) return { not_found: true };
  const c = r.rows[0];

  const cpfDigits = onlyDigitsCard(c.cpf_cnpj);
  const rgDigits  = onlyDigitsCard(c.rg);

  // Sem RG nem CPF no cadastro → fallback WhatsApp da federação.
  if (!cpfDigits && !rgDigits) {
    return { no_identity: true, federation_name: c.federation_name || null, whatsapp: c.federation_whatsapp || null };
  }

  const idDigits = onlyDigitsCard(identifier);
  const match = idDigits.length >= 5 && (idDigits === cpfDigits || idDigits === rgDigits);
  if (!match) return { match: false };

  // Match → devolve o cartão completo (mesma forma consumida pela carteirinha).
  return {
    match: true,
    card: {
      id: c.id,
      federation_id: c.federation_id,
      student_id: c.student_id,
      student_name: c.student_name,
      birth_date: c.birth_date,
      cpf: c.cpf_cnpj || null,
      card_number: c.card_number_live,
      cbkt_number: c.cbkt_number_live || null,
      belt: c.belt_live,
      belt_name: c.belt_name_live,
      dojo_name: c.dojo_name_live,
      photo_url: c.photo_url_live,
      issued_at: c.issued_at,
      verify_token: c.verify_token || token,
      status: c.status,
      federation_name: c.federation_name || null,
      federation_logo: c.federation_logo || null,
    },
  };
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
    `SELECT kc.id, kc.student_id, kc.is_minor, kc.valid_until, kc.status, kc.issued_at,
            COALESCE(cu.karate_registration_number, kc.card_number)      AS card_number,
            COALESCE(cb.belt_name, kc.belt_name_snapshot)                AS belt_name,
            COALESCE(dj.trade_name, dj.legal_name, kc.dojo_name_snapshot) AS dojo_name,
            cu.name AS student_name
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = kc.federation_id
     LEFT JOIN companies dj ON dj.id = cu.dojo_id
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
      belt_name: c.belt_name,
      dojo_name: c.dojo_name,
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


// ============================================================
// Fila de impressão (print_status: to_print | printed | delivered)
// ------------------------------------------------------------
// Decisão de arquitetura (Caio, sisteminha de gestão de impressão):
// reaproveita karate_membership_cards (migration 233) — NÃO cria tabela
// paralela. Cada LINHA da tabela já é "uma emissão física"; a fila de
// impressão é só um estado adicional sobre essa mesma linha.
//
// Três etapas, só andam para frente por ação explícita:
//   'to_print'  → emissão entra aqui automaticamente (issueCard/issueBatch)
//   'printed'   → clique em "Imprimir selecionadas" (markPrinted) — NÃO é
//                 prova de impressão real (papel pode faltar, diálogo pode
//                 ser cancelado) — por isso existe returnToQueue.
//   'delivered' → SÓ confirmação manual da federação (markDelivered).
//
// returnToQueue ("não saiu" / "reimprimir perdeu-rasgou-graduou") devolve
// para 'to_print' sem tocar em print_count — só uma nova passagem por
// markPrinted conta como via nova. Isso é histórico de vias sem tabela de
// auditoria separada: print_count + printed_at já bastam para a copy
// "3ª via, reimpressa em 12/07" (formatada no frontend — tz-safe).
//
// Todas as mutações são em LOTE (ids[]) e retornam por-item {id, ok, error}
// — lote nunca perde ninguém silenciosamente (itens de outra federação ou
// já revogados voltam como error, não travam o restante).
//
// 17/07/2026 (Caio — migration 241): quarta etapa, 'out_of_queue' —
// "tirar da fila", pra federação gerenciar melhor o que deve ser impresso
// de fato. NÃO é revogação: status continua 'active', verifyByToken()
// (verificação pública / QR) não filtra por print_status — o praticante
// segue com carteirinha válida normalmente. Só sai de 'to_print' (ver
// removeFromQueue) — tirar da fila algo já 'printed'/'delivered' é
// semanticamente estranho (o cartão físico já existe ou foi entregue) e
// bagunçaria o histórico de vias; se a federação quer desfazer uma
// impressão/entrega, o caminho já existente é returnToQueue. É reversível:
// returnToQueue aceita voltar de qualquer etapa (não valida origem), então
// já aceita 'out_of_queue' sem mudança nenhuma nela.
// ============================================================

const PRINT_STATUSES = ['to_print', 'printed', 'delivered', 'out_of_queue'];

function orderColumnForQueue(status, includeOutOfQueueAt = true) {
  if (status === 'printed') return 'kc.printed_at';
  if (status === 'delivered') return 'kc.delivered_at';
  if (status === 'out_of_queue') return includeOutOfQueueAt ? 'kc.out_of_queue_at' : 'kc.issued_at';
  return 'kc.issued_at';
}

// ------------------------------------------------------------
// Defensivo (CLAUDE.md armadilha #1 — schema antes da migration): o
// backend sobe ANTES da migration 241 ser aplicada. karate_membership_cards
// .out_of_queue_at é referenciada incondicionalmente no SELECT de
// listPrintQueue (usado pelas 4 abas, não só 'out_of_queue') — sem cache
// defensivo, um deploy sem a migration aplicada quebraria a fila INTEIRA
// (to_print/printed/delivered também) com 42703, não só a aba nova.
//
// Cache module-level (mesmo padrão de src/services/extraSeats.js):
// "existe" fica true até restart; "não existe" expira em 60s pra detectar
// a migration rodando sem precisar reiniciar o processo.
// ------------------------------------------------------------
let _outOfQueueAtExists = null; // null=não testado, true=existe, false=ausente (cache temporário)
let _outOfQueueAtMissingAt = 0;
const OUT_OF_QUEUE_AT_MISS_TTL_MS = 60 * 1000;

function _outOfQueueAtCacheStale() {
  return _outOfQueueAtExists === false && (Date.now() - _outOfQueueAtMissingAt) >= OUT_OF_QUEUE_AT_MISS_TTL_MS;
}
function _shouldTryOutOfQueueAt() {
  return _outOfQueueAtExists !== false || _outOfQueueAtCacheStale();
}
function _markOutOfQueueAtExists() { _outOfQueueAtExists = true; _outOfQueueAtMissingAt = 0; }
function _markOutOfQueueAtMissing() {
  _outOfQueueAtExists = false;
  _outOfQueueAtMissingAt = Date.now();
  console.warn('[karateCardService] karate_membership_cards.out_of_queue_at ainda não existe (migration 241 pendente). Aba "Fora da fila" degradada até a migration rodar. Tentando de novo em 60s.');
}

/**
 * listPrintQueue — cartões ATIVOS de uma etapa da fila, agrupáveis por dojô
 * no frontend (devolve dojo_id/dojo_name por item + breakdown de contagem
 * por dojô nesta etapa). Ordenação: "gerado por último, visualizado
 * primeiro" — mais recente no topo pelo timestamp que fez o cartão ENTRAR
 * nesta etapa (issued_at em to_print, printed_at em printed, delivered_at
 * em delivered), regra explícita do Caio, válida nas três abas.
 */
async function listPrintQueue({ federation_id, print_status = 'to_print', dojo_id, search, page = 1, pageSize = 50 }) {
  const status = PRINT_STATUSES.includes(print_status) ? print_status : 'to_print';
  const conds = ['kc.federation_id = $1', "kc.status = 'active'", 'kc.print_status = $2'];
  const params = [federation_id, status];
  let n = 3;
  if (dojo_id) { conds.push(`kc.dojo_id = $${n}`); params.push(dojo_id); n++; }
  if (search) {
    conds.push(`(cu.name ILIKE $${n} OR COALESCE(cu.karate_registration_number, kc.card_number) ILIKE $${n})`);
    params.push(`%${search}%`);
    n++;
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const pageClamped = Math.max(1, page);
  const pageSizeClamped = Math.min(500, Math.max(1, pageSize));

  // Defensivo: tenta com out_of_queue_at (migration 241); se a coluna ainda
  // não existir (42703 — deploy antes da migration), cai pra uma versão sem
  // ela (NULL no lugar + ORDER BY volta pra issued_at) e cacheia por 60s
  // pra não repetir a tentativa fracassada em todo request (ver cache no
  // topo do arquivo). Isso vale para as 4 abas — a coluna é sempre
  // referenciada no SELECT, não só quando print_status='out_of_queue'.
  async function fetchRows(includeOutOfQueueAt) {
    const orderCol = orderColumnForQueue(status, includeOutOfQueueAt);
    const outOfQueueAtCol = includeOutOfQueueAt ? 'kc.out_of_queue_at' : 'NULL::timestamptz AS out_of_queue_at';
    return db.query(
      `SELECT kc.id, kc.student_id, kc.print_status, kc.printed_at, kc.delivered_at,
              ${outOfQueueAtCol},
              kc.print_count, kc.issued_at, kc.is_minor, kc.dojo_id,
              COALESCE(cu.karate_registration_number, kc.card_number)      AS card_number,
              COALESCE(cb.belt_name, kc.belt_name_snapshot)                AS belt_name,
              COALESCE(dj.trade_name, dj.legal_name, kc.dojo_name_snapshot) AS dojo_name,
              cu.name AS student_name
       FROM karate_membership_cards kc
       JOIN customers cu ON cu.id = kc.student_id
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = kc.federation_id
       LEFT JOIN companies dj ON dj.id = kc.dojo_id
       ${where}
       ORDER BY ${orderCol} DESC NULLS LAST, kc.issued_at DESC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSizeClamped, (pageClamped - 1) * pageSizeClamped]
    );
  }

  let rows;
  if (_shouldTryOutOfQueueAt()) {
    try {
      rows = await fetchRows(true);
      _markOutOfQueueAtExists();
    } catch (e) {
      if (e.code === '42703') {
        _markOutOfQueueAtMissing();
        rows = await fetchRows(false);
      } else {
        throw e;
      }
    }
  } else {
    rows = await fetchRows(false);
  }

  const cnt = await db.query(
    `SELECT COUNT(*) AS total
     FROM karate_membership_cards kc
     JOIN customers cu ON cu.id = kc.student_id
     ${where}`,
    params
  );

  // Contadores da federação inteira (topo da tela: "18 a imprimir · 40
  // impressas · 380 entregues") — independentes do filtro de dojô/busca.
  const counterRows = await db.query(
    `SELECT print_status, COUNT(*) AS n
     FROM karate_membership_cards
     WHERE federation_id = $1 AND status = 'active'
     GROUP BY print_status`,
    [federation_id]
  );
  const counters = { to_print: 0, printed: 0, delivered: 0, out_of_queue: 0 };
  counterRows.rows.forEach((r) => { counters[r.print_status] = parseInt(r.n, 10); });

  // Dojôs presentes NESTA etapa (para o filtro/agrupamento por dojô).
  const dojoRows = await db.query(
    `SELECT kc.dojo_id, COALESCE(dj.trade_name, dj.legal_name, kc.dojo_name_snapshot) AS dojo_name, COUNT(*) AS n
     FROM karate_membership_cards kc
     LEFT JOIN companies dj ON dj.id = kc.dojo_id
     WHERE kc.federation_id = $1 AND kc.status = 'active' AND kc.print_status = $2
     GROUP BY kc.dojo_id, COALESCE(dj.trade_name, dj.legal_name, kc.dojo_name_snapshot)
     ORDER BY dojo_name NULLS LAST`,
    [federation_id, status]
  );

  return {
    page: pageClamped,
    page_size: pageSizeClamped,
    total: parseInt(cnt.rows[0].total, 10),
    print_status: status,
    counters,
    dojos: dojoRows.rows.map((d) => ({
      dojo_id: d.dojo_id,
      dojo_name: d.dojo_name || 'Sem dojô',
      count: parseInt(d.n, 10),
    })),
    data: rows.rows.map((c) => ({
      id: c.id,
      student_id: c.student_id,
      student_name: c.student_name,
      card_number: c.card_number,
      belt_name: c.belt_name,
      dojo_id: c.dojo_id,
      dojo_name: c.dojo_name,
      is_minor: c.is_minor,
      print_status: c.print_status,
      issued_at: c.issued_at,
      printed_at: c.printed_at,
      delivered_at: c.delivered_at,
      out_of_queue_at: c.out_of_queue_at,
      print_count: c.print_count || 0,
    })),
  };
}

/**
 * _transitionCards — aplica uma transição de print_status em lote,
 * validando que cada cartão pertence à federação e está com status='active'.
 * Nunca lança para o chamador por causa de UM item ruim — devolve
 * {ok:[], errors:[{id, error}]} para que o lote nunca perca ninguém
 * silenciosamente (o item ruim aparece explicitamente em errors[]).
 */
async function _transitionCards({ federation_id, card_ids, apply }) {
  const ids = Array.from(new Set((card_ids || []).filter(Boolean)));
  if (ids.length === 0) {
    const err = new Error('Nenhum cartão informado');
    err.code = 'NO_IDS';
    throw err;
  }

  const ok = [];
  const errors = [];
  for (const id of ids) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT id, print_status FROM karate_membership_cards
         WHERE id = $1 AND federation_id = $2 AND status = 'active'
         FOR UPDATE`,
        [id, federation_id]
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        errors.push({ id, error: 'Cartão não encontrado nesta federação (ou revogado)' });
        continue;
      }
      const updated = await apply(client, cur.rows[0]);
      await client.query('COMMIT');
      ok.push(updated.id);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      errors.push({ id, error: e.message });
    } finally {
      client.release();
    }
  }
  return { ok, errors, total: ids.length };
}

/** markPrinted — "Imprimir selecionadas" move para 'printed' e conta uma via. */
async function markPrinted({ federation_id, card_ids }) {
  return _transitionCards({
    federation_id,
    card_ids,
    apply: async (client, row) => {
      const r = await client.query(
        `UPDATE karate_membership_cards
         SET print_status = 'printed', printed_at = NOW(), print_count = print_count + 1, updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [row.id]
      );
      return r.rows[0];
    },
  });
}

/** markDelivered — confirmação manual da federação (única forma de chegar em 'delivered'). */
async function markDelivered({ federation_id, card_ids, delivered_by }) {
  return _transitionCards({
    federation_id,
    card_ids,
    apply: async (client, row) => {
      const r = await client.query(
        `UPDATE karate_membership_cards
         SET print_status = 'delivered', delivered_at = NOW(), delivered_by = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [row.id, delivered_by || null]
      );
      return r.rows[0];
    },
  });
}

/**
 * returnToQueue — "Não saiu / reimprimir" (da etapa 'printed') OU
 * "Reimprimir" por perda/rasgo/graduação (da etapa 'delivered'). Mesma
 * ação nos dois casos: volta para 'to_print' SEM alterar print_count
 * (só a próxima markPrinted conta como via nova).
 */
async function returnToQueue({ federation_id, card_ids }) {
  return _transitionCards({
    federation_id,
    card_ids,
    apply: async (client, row) => {
      const r = await client.query(
        `UPDATE karate_membership_cards
         SET print_status = 'to_print', updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [row.id]
      );
      return r.rows[0];
    },
  });
}

/**
 * removeFromQueue — "Tirar da fila" (migration 241 / decisão Caio
 * 17/07/2026): a federação decide não imprimir um cartão agora. NÃO é
 * revogação — status continua 'active', verifyByToken() (verificação
 * pública / QR) não filtra por print_status, então o praticante segue
 * com carteirinha válida normalmente. Só sai da FILA (aba operacional).
 *
 * Regra de origem, validada aqui no backend (não só escondida na UI, por
 * pedido explícito): SÓ aceita a partir de 'to_print'. Tirar da fila algo
 * já 'printed' ou 'delivered' é semanticamente estranho — o cartão físico
 * já existe ou já foi entregue ao praticante — e bagunçaria o histórico
 * de vias (print_count/printed_at/delivered_at). Se a federação quer
 * desfazer uma impressão ou entrega, o caminho já existente é
 * returnToQueue ("não saiu" / reimprimir). Item com origem inválida vira
 * error por-item (não trava o resto do lote, mesmo comportamento de
 * _transitionCards para qualquer outra falha).
 *
 * Reversível: returnToQueue não valida print_status de origem (aceita
 * qualquer etapa), então já devolve 'out_of_queue' pra 'to_print' sem
 * nenhuma mudança nela.
 *
 * Defensivo (armadilha #1): se a migration 241 ainda não rodou, o UPDATE
 * abaixo falha (coluna out_of_queue_at ausente e/ou CHECK constraint
 * ainda sem 'out_of_queue') — _transitionCards já captura qualquer
 * exceção por item e devolve como {id, error} sem derrubar o lote nem a
 * rota (nunca 500); não há fallback "degradado" que faça sentido aqui,
 * porque a transição em si só passa a existir depois da migration.
 */
async function removeFromQueue({ federation_id, card_ids }) {
  return _transitionCards({
    federation_id,
    card_ids,
    apply: async (client, row) => {
      if (row.print_status !== 'to_print') {
        const err = new Error(
          `Só é possível tirar da fila cartões em 'to_print' (este está em '${row.print_status}'). Use "Não saiu / reimprimir" para desfazer impressão ou entrega.`
        );
        err.code = 'INVALID_TRANSITION';
        throw err;
      }
      const r = await client.query(
        `UPDATE karate_membership_cards
         SET print_status = 'out_of_queue', out_of_queue_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [row.id]
      );
      return r.rows[0];
    },
  });
}


module.exports = {
  issueCard,
  revokeCard,
  getCurrentCard,
  verifyByToken,
  getCardCopyByToken,
  listCards,
  issueBatch,
  effectiveStatus,
  computeIsMinor,
  listPrintQueue,
  markPrinted,
  markDelivered,
  returnToQueue,
  removeFromQueue,
};
