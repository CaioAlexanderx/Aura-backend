// ============================================================
// AURA KARATÊ — Serviço de Certificados (Track J)
//
// DECISÃO TRACK J: certificado é um PEDIDO com estados.
// Substituiu o fluxo anterior (emissão sob demanda + URL fictícia).
//
// Estados: requested → in_production → printed → shipped
//          Em qualquer ponto: → refused (com motivo)
//
// Cada transição:
//   1. Atualiza karate_certificate_orders.status
//   2. Insere linha em karate_certificate_order_history
//   3. Dispara sendKarateEmail (best-effort: catch+log, nunca falha a tx)
// ============================================================
'use strict';

const db = require('../config/database');
const { sendKarateEmail } = require('./karateMailer');

// ── Labels de estado (para e-mail e histórico) ────────────────
const STATUS_LABEL = {
  requested:     'Solicitado',
  in_production: 'Em produção',
  printed:       'Impresso',
  shipped:       'Enviado',
  refused:       'Recusado',
};

// ── Sequência válida (para validação de avanço) ───────────────
const VALID_STATUSES = ['requested', 'in_production', 'printed', 'shipped', 'refused'];

// Defensive: se a tabela não existe (pré-migration), lança erro 503-safe.
function safeTable(err) {
  if (err.code === '42P01') {
    const e = new Error('Tabela de pedidos ainda não criada — migration 182 pendente.');
    e.code = 'TABLE_MISSING';
    throw e;
  }
  throw err;
}

// ── Busca dados da federação para e-mails ─────────────────────
async function getFederationEmailData(federationId) {
  try {
    const res = await db.query(
      `SELECT name, slug, email, karate_logo_url, wa_phone_display
       FROM companies WHERE id = $1 LIMIT 1`,
      [federationId]
    );
    const row = res.rows[0] || {};
    return {
      federationName:     row.name || 'Federação',
      federationSlug:     row.slug || null,
      federationLogoUrl:  row.karate_logo_url || null,
      federationWhatsapp: row.wa_phone_display || null,
      federationEmail:    row.email || null,
    };
  } catch (_) {
    return { federationName: 'Federação', federationLogoUrl: null, federationWhatsapp: null, federationEmail: null };
  }
}

// Busca e-mail de contato do dojô
async function getDojoEmail(dojoId) {
  try {
    const res = await db.query(`SELECT email, name FROM companies WHERE id = $1 LIMIT 1`, [dojoId]);
    const row = res.rows[0] || {};
    return { email: row.email || null, name: row.name || 'Dojô' };
  } catch (_) {
    return { email: null, name: 'Dojô' };
  }
}

// ── Disparo de e-mail (best-effort — never throws) ───────────
async function fireTransitionEmail(order, toStatus, { federationData, dojoEmail, dojoName, refusalReason }) {
  try {
    const to = dojoEmail;
    if (!to) return; // sem e-mail cadastrado → silencioso

    const stateLabel = STATUS_LABEL[toStatus] || toStatus;
    const isRefused  = toStatus === 'refused';

    const subjectMap = {
      in_production: 'Certificado em produção — ' + order.nome_impresso,
      printed:       'Certificado impresso — ' + order.nome_impresso,
      shipped:       'Certificado enviado — ' + order.nome_impresso,
      refused:       'Pedido de certificado recusado — ' + order.nome_impresso,
    };
    const subject = subjectMap[toStatus] || `Certificado: ${stateLabel} — ${order.nome_impresso}`;

    const refuseBlock = isRefused && refusalReason
      ? `<p style="font-size:13px;color:#44403c;line-height:22px;margin:16px 0 0;
                  padding:14px 16px;border:1px solid #f5c6c6;border-radius:8px;
                  background:#fff5f5;"><strong style="color:#991b1b;">Motivo:</strong><br/>${
           refusalReason.replace(/</g, '&lt;').replace(/>/g, '&gt;')
         }</p>` : '';

    const bodyHtml = `
      <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">
        Olá, ${dojoName.replace(/</g, '&lt;')}.
      </p>
      <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">
        O pedido <strong style="color:#1c1917;font-family:monospace;">${order.id.slice(0,8).toUpperCase()}</strong>
        de <strong style="color:#1c1917;">${order.nome_impresso.replace(/</g,'&lt;')}</strong>
        (${order.belt_name.replace(/</g,'&lt;')}) está agora:
      </p>
      <p style="font-size:16px;font-weight:700;color:#1c1917;margin:0 0 14px;">→ ${stateLabel}</p>
      ${refuseBlock}
      <p style="font-size:12.5px;color:#78716c;line-height:20px;margin:16px 0 0;">Acompanhe o estado dos pedidos pelo painel do dojô no Aura Karatê.</p>
    `;

    await sendKarateEmail(to, {
      subject,
      heading: 'Certificado: atualização de estado',
      bodyHtml,
      ...federationData,
    });
  } catch (emailErr) {
    // best-effort: log e continua
    console.error('[karateCertificate] e-mail transition error (best-effort):', emailErr.message);
  }
}

// ── createOrder ────────────────────────────────────────────────
// Cria o pedido em status 'requested'.
//
// ⚠️ P0 CORRIGIDO EM 27/07/2026 — LEIA ANTES DE MEXER
// A checagem "advisory" de graduação abaixo consultava DUAS colunas que
// NUNCA existiram em karate_belt_history:
//     WHERE kbh.practitioner_id = $1  ← a coluna é student_id
//       AND (kbh.source = 'exam' OR kbh.source IS NOT NULL)  ← não existe
// O Postgres respondia 42703 (`column kbh.practitioner_id does not exist`),
// o catch só tratava 42P01, o erro subia e virava:
//   • 503 SCHEMA_PENDING em POST /federation/:id/dojo/cert-orders (F5b)
//   • 500 genérico em POST /federation/:id/certificate-orders (Track J)
// Resultado: karate_certificate_orders ficou com ZERO linhas desde a
// migration 182 — nenhum pedido de certificado jamais foi gravado.
// O `beltCheck` sempre teve o resultado DESCARTADO, então a query estava
// derrubando o fluxo inteiro sem sequer decidir nada.
//
// Contrato mantido: a checagem continua ADVISORY (nunca bloqueia o pedido;
// quem decide se a graduação vale é a federação ao processar). O que muda:
// consulta colunas que existem, é escopada pela federação, loga quando não
// encontra e NUNCA deixa um erro de schema/cast derrubar a escrita.
async function createOrder({
  federationId,
  dojoId,
  practitionerId,
  beltLevel,
  beltName,
  examDate,
  examRef,
  nomeImpresso,
  deliveryType,
  addrCep,
  addrLogradouro,
  addrNumero,
  addrComplemento,
  addrCidade,
  observacao,
  createdBy,
  createdByName,
}) {
  // ── Escopo federativo (anti-IDOR) ──────────────────────────────
  // dojo_id e practitioner_id podem chegar do corpo da requisição. Validamos
  // que AMBOS pertencem a ESTA federação antes de gravar — senão um pedido
  // poderia ser forjado em nome de outro dojô / para praticante alheio.
  // companies.federation_id (migration 147) e customers.federation_id/dojo_id
  // (migration 148) são as âncoras. 22P02 (uuid inválido) → trata como ausente.
  const scopeCheck = async (sql, params) => {
    try { const r = await db.query(sql, params); return r.rows.length > 0; }
    catch (e) { if (e.code === '22P02') return false; throw e; }
  };
  const dojoOk = await scopeCheck(
    `SELECT 1 FROM companies
      WHERE id = $1 AND federation_id = $2
        AND (vertical = 'karate_dojo' OR vertical_active = 'karate_dojo')
      LIMIT 1`,
    [dojoId, federationId]
  );
  if (!dojoOk) {
    const e = new Error('Dojô não pertence a esta federação.');
    e.code = 'FORBIDDEN_SCOPE';
    throw e;
  }
  // Praticante: da federação OU do próprio dojô do pedido (cobre praticante
  // ainda sem federation_id populado, mas já vinculado ao dojô).
  const practitionerOk = await scopeCheck(
    `SELECT 1 FROM customers
      WHERE id = $1 AND (federation_id = $2 OR dojo_id = $3)
      LIMIT 1`,
    [practitionerId, federationId, dojoId]
  );
  if (!practitionerOk) {
    const e = new Error('Praticante não pertence a esta federação/dojô.');
    e.code = 'FORBIDDEN_SCOPE';
    throw e;
  }

  // Checagem ADVISORY: o praticante tem essa graduação registrada?
  let beltCheck = { rows: [] };
  try {
    beltCheck = await db.query(
      `SELECT kbh.id
       FROM karate_belt_history kbh
       WHERE kbh.student_id = $1
         AND kbh.belt_level = $2
         AND kbh.federation_id = $3
       LIMIT 1`,
      [practitionerId, beltLevel, federationId]
    );
  } catch (err) {
    // 42P01 tabela ausente / 42703 coluna ausente / 22P02 id fora do formato
    // uuid: nada disso pode derrubar um pedido cujo resultado é informativo.
    if (err.code === '42P01' || err.code === '42703' || err.code === '22P02') {
      console.warn(
        '[karateCertificate] belt check indisponível (segue sem bloquear):',
        err.code, err.message
      );
      beltCheck = { rows: [] };
    } else throw err;
  }
  if (!beltCheck.rows.length) {
    console.warn(
      '[karateCertificate] pedido sem graduação correspondente em karate_belt_history ' +
      `(practitioner=${practitionerId} belt=${beltLevel} fed=${federationId})`
    );
  }

  // Verifica que não há pedido pendente para a mesma graduação
  let dupCheck;
  try {
    dupCheck = await db.query(
      `SELECT id FROM karate_certificate_orders
       WHERE practitioner_id = $1
         AND belt_level = $2
         AND federation_id = $3
         AND status NOT IN ('refused')
       LIMIT 1`,
      [practitionerId, beltLevel, federationId]
    );
  } catch (err) { safeTable(err); }

  if (dupCheck.rows.length) {
    const e = new Error('Já existe um pedido ativo para esta graduação deste praticante.');
    e.code = 'DUPLICATE_ORDER';
    throw e;
  }

  let res;
  try {
    res = await db.query(
      `INSERT INTO karate_certificate_orders
         (federation_id, dojo_id, practitioner_id,
          belt_level, belt_name, exam_date, exam_ref,
          nome_impresso, delivery_type,
          addr_cep, addr_logradouro, addr_numero, addr_complemento, addr_cidade,
          observacao, status, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'requested',$16,$17)
       RETURNING *`,
      [
        federationId, dojoId, practitionerId,
        beltLevel, beltName,
        examDate || null, examRef || null,
        nomeImpresso,
        deliveryType || 'pickup',
        addrCep || null, addrLogradouro || null, addrNumero || null,
        addrComplemento || null, addrCidade || null,
        observacao || null,
        createdBy || null, createdByName || null,
      ]
    );
  } catch (err) { safeTable(err); }

  const order = res.rows[0];

  // Grava histórico
  await db.query(
    `INSERT INTO karate_certificate_order_history
       (order_id, from_status, to_status, who_id, who_name, org_name)
     VALUES ($1, NULL, 'requested', $2, $3, $4)`,
    [order.id, createdBy || null, createdByName || null, 'Dojô']
  ).catch(e => console.error('[cert] history insert error:', e.message));

  return order;
}

// ── getOrder ──────────────────────────────────────────────────
async function getOrder(orderId, federationId) {
  let res;
  try {
    res = await db.query(
      `SELECT o.*,
              COALESCE(
                json_agg(h.* ORDER BY h.created_at) FILTER (WHERE h.id IS NOT NULL),
                '[]'
              ) AS history
       FROM karate_certificate_orders o
       LEFT JOIN karate_certificate_order_history h ON h.order_id = o.id
       WHERE o.id = $1 AND o.federation_id = $2
       GROUP BY o.id`,
      [orderId, federationId]
    );
  } catch (err) { safeTable(err); }
  return res.rows[0] || null;
}

// ── getOrdersByDojo ──────────────────────────────────────────
async function getOrdersByDojo(dojoId, federationId, params) {
  const { status, page = 1, pageSize = 50 } = params || {};
  const offset = (page - 1) * pageSize;
  const conds = ['o.dojo_id = $1', 'o.federation_id = $2'];
  const vals  = [dojoId, federationId];
  if (status) { conds.push(`o.status = $${vals.length + 1}`); vals.push(status); }

  let res;
  try {
    res = await db.query(
      `SELECT o.*
       FROM karate_certificate_orders o
       WHERE ${conds.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, pageSize, offset]
    );
  } catch (err) { safeTable(err); }
  return res.rows;
}

// ── getOrdersByFederation ─────────────────────────────────────
async function getOrdersByFederation(federationId, params) {
  const { status, q, page = 1, pageSize = 100 } = params || {};
  const offset = (page - 1) * pageSize;
  const conds = ['o.federation_id = $1'];
  const vals  = [federationId];

  if (status) { conds.push(`o.status = $${vals.length + 1}`); vals.push(status); }
  if (q) {
    conds.push(
      `(o.nome_impresso ILIKE $${vals.length + 1}
       OR o.belt_name ILIKE $${vals.length + 1}
       OR o.id::text ILIKE $${vals.length + 1})`
    );
    vals.push('%' + q + '%');
  }

  let res;
  try {
    res = await db.query(
      `SELECT o.*
       FROM karate_certificate_orders o
       WHERE ${conds.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, pageSize, offset]
    );
  } catch (err) { safeTable(err); }
  return res.rows;
}

// ── _doAdvanceStatus (internal) ──────────────────────────────
async function _doAdvanceStatus(orderId, federationId, newStatus, opts) {
  if (!VALID_STATUSES.includes(newStatus)) {
    const e = new Error('Estado inválido: ' + newStatus);
    e.code = 'INVALID_STATUS';
    throw e;
  }
  const { whoId, whoName, orgName, note } = opts || {};

  let res;
  try {
    res = await db.query(
      `UPDATE karate_certificate_orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND federation_id = $3
         AND status != 'refused'
         AND status != 'shipped'
       RETURNING *`,
      [newStatus, orderId, federationId]
    );
  } catch (err) { safeTable(err); }

  if (!res.rows.length) {
    const e = new Error('Pedido não encontrado, já encerrado ou não pertence a esta federação.');
    e.code = 'NOT_FOUND_OR_CLOSED';
    throw e;
  }

  const order = res.rows[0];

  // Grava histórico (async, não bloqueia)
  db.query(
    `INSERT INTO karate_certificate_order_history
       (order_id, to_status, who_id, who_name, org_name, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [order.id, newStatus, whoId || null, whoName || null, orgName || null, note || null]
  ).catch(e => console.error('[cert] history error:', e.message));

  return order;
}

// ── advanceStatus (single) ───────────────────────────────────
async function advanceStatus(orderId, federationId, newStatus, opts) {
  const order = await _doAdvanceStatus(orderId, federationId, newStatus, opts);

  // E-mail best-effort pós-commit
  const [fedData, dojoInfo] = await Promise.all([
    getFederationEmailData(federationId),
    getDojoEmail(order.dojo_id),
  ]);
  fireTransitionEmail(order, newStatus, {
    federationData: fedData,
    dojoEmail:      dojoInfo.email,
    dojoName:       dojoInfo.name,
    refusalReason:  opts && opts.note,
  });

  return order;
}

// ── batchAdvanceStatus ───────────────────────────────────────
async function batchAdvanceStatus(orderIds, federationId, newStatus, opts) {
  if (!Array.isArray(orderIds) || !orderIds.length) return [];
  const results = [];
  const errors  = [];

  for (const orderId of orderIds) {
    try {
      const order = await _doAdvanceStatus(orderId, federationId, newStatus, opts);
      results.push(order);
      // E-mail best-effort (não espera)
      getFederationEmailData(federationId).then(fedData =>
        getDojoEmail(order.dojo_id).then(dojoInfo =>
          fireTransitionEmail(order, newStatus, {
            federationData: fedData,
            dojoEmail:      dojoInfo.email,
            dojoName:       dojoInfo.name,
          })
        )
      ).catch(() => {});
    } catch (err) {
      errors.push({ orderId, error: err.message });
    }
  }
  return { updated: results, errors };
}

// ── refuseOrder ──────────────────────────────────────────────
async function refuseOrder(orderId, federationId, reason, opts) {
  if (!reason || !reason.trim()) {
    const e = new Error('Motivo da recusa é obrigatório.');
    e.code = 'MISSING_REASON';
    throw e;
  }

  let res;
  try {
    res = await db.query(
      `UPDATE karate_certificate_orders
       SET status = 'refused', refusal_reason = $1, updated_at = NOW()
       WHERE id = $2 AND federation_id = $3
         AND status NOT IN ('refused','shipped')
       RETURNING *`,
      [reason.trim(), orderId, federationId]
    );
  } catch (err) { safeTable(err); }

  if (!res.rows.length) {
    const e = new Error('Pedido não encontrado, já enviado ou já recusado.');
    e.code = 'NOT_FOUND_OR_CLOSED';
    throw e;
  }

  const order = res.rows[0];

  db.query(
    `INSERT INTO karate_certificate_order_history
       (order_id, to_status, who_id, who_name, org_name, note)
     VALUES ($1, 'refused', $2, $3, $4, $5)`,
    [order.id, opts?.whoId||null, opts?.whoName||null, opts?.orgName||null, reason.trim()]
  ).catch(e => console.error('[cert] history refuse error:', e.message));

  // E-mail best-effort
  const [fedData, dojoInfo] = await Promise.all([
    getFederationEmailData(federationId),
    getDojoEmail(order.dojo_id),
  ]);
  fireTransitionEmail(order, 'refused', {
    federationData: fedData,
    dojoEmail:      dojoInfo.email,
    dojoName:       dojoInfo.name,
    refusalReason:  reason.trim(),
  });

  return order;
}

module.exports = {
  createOrder,
  getOrder,
  getOrdersByDojo,
  getOrdersByFederation,
  advanceStatus,
  batchAdvanceStatus,
  refuseOrder,
  STATUS_LABEL,
};
