// ============================================================
// AURA KARATÊ — Rotas de Praticantes (Track A)
// GET    /federation/:id/practitioners
// POST   /federation/:id/practitioners
// GET    /federation/:id/practitioners/:practitionerId
// PATCH  /federation/:id/practitioners/:practitionerId   (edição da ficha)
// DELETE /federation/:id/practitioners/:practitionerId   (excluir / cascata)
// POST   /federation/:id/practitioners/:practitionerId/graduations (graduação manual)
// PATCH  /federation/:id/practitioners/:practitionerId/graduations/:graduationId
// DELETE /federation/:id/practitioners/:practitionerId/graduations/:graduationId
// GET    /federation/:id/practitioners/:practitionerId/courses (P9 — últimos 12 meses)
// POST   /federation/:id/practitioners/:practitionerId/photo   (upload foto R2)
//
// Nota: /practitioners/import é registrado ANTES deste router no index.js
// para que 'import' não seja capturado como :practitionerId.
//
// 22/06/2026: endereço passou a ser persistido (colunas já existiam em
// customers; a rota não gravava) + PATCH de edição da ficha.
// 23/06/2026: PATCH aceita is_active (status ativo/inativo) + POST de
// graduação manual em karate_belt_history (append-only; a view
// karate_current_belt deriva a faixa atual). Faixa NÃO é editável via PATCH
// (vive no histórico imutável) — registra-se uma nova graduação.
// 25/06/2026: liberdade total da federação (decisão Caio) —
//   - DELETE de praticante: soft já existe (PATCH is_active=false); agora há
//     hard delete com guarda 409 HAS_HISTORY e ?cascade=true (igual a
//     funcionários/membros/dojô). Sem dependentes → apaga direto.
//   - Edição/exclusão POR ITEM da trajetória de faixas (karate_belt_history):
//     PATCH/DELETE em /graduations/:graduationId. A view karate_current_belt
//     recalcula a faixa atual sozinha (pode ficar sem faixa se apagar a última).
// 27/06/2026: P7 — campos de responsável legal (guardian_*) no POST/PATCH/GET.
//   Obrigatoriedade para menores validada apenas no FE; BE aceita/retorna.
//   Depende de migration 195 (ADD COLUMN IF NOT EXISTS em customers).
// 27/06/2026: P9 — GET detalhe agora inclui last_exam + course_count_last_year.
//   Tabela de candidatos: karate_belt_exam_candidates (student_id, exam_id).
//   Data do evento: karate_belt_exams.event_date.
//   Degrada para null/0 defensivamente a 42P01.
// 28/06/2026: POST /:practitionerId/photo — upload de foto do praticante.
//   Body JSON: { content: "<base64>", content_type?: "image/jpeg" }.
//   Mesma convenção de productImage.js / variantImage.js (R2 + base64).
//   Sem migration — karate_photo_url já existe em customers.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { nextPractitionerRegistrationNumber } = require('../services/karateService');
const { uploadToR2 } = require('../utils/r2Storage');

// Campos de endereço da ficha (colunas em customers).
const ADDRESS_COLS = ['street', 'number', 'complement', 'neighborhood', 'city', 'state', 'zip_code'];

// ── GET /federation/:id/practitioners ──────────────────────
router.get('/', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { dojo_id, belt_level, affiliation_status, role, q } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const conditions = [`cu.federation_id = $1`];
    const params = [federationId];
    let n = 2;

    if (dojo_id) {
      conditions.push(`cu.dojo_id = $${n}`);
      params.push(dojo_id);
      n++;
    }
    if (belt_level) {
      conditions.push(`cb.belt_level = $${n}`);
      params.push(belt_level);
      n++;
    }
    if (role) {
      const roleColMap = { arbiter: 'is_arbiter', instructor: 'is_instructor', examiner: 'is_examiner' };
      const col = roleColMap[role];
      if (col) {
        conditions.push(`cu.${col} = true`);
      }
    }
    if (q) {
      conditions.push(`(cu.name ILIKE $${n} OR cu.cpf_cnpj ILIKE $${n} OR cu.karate_registration_number ILIKE $${n})`);
      params.push(`%${q}%`);
      n++;
    }

    // affiliation_status: active=is_active true, pending=sem faixa, inactive=is_active false
    if (affiliation_status === 'active') {
      conditions.push('cu.is_active = true');
    } else if (affiliation_status === 'inactive') {
      conditions.push('cu.is_active = false');
    } else if (affiliation_status === 'pending') {
      conditions.push('cb.belt_level IS NULL');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await db.query(
      `SELECT COUNT(DISTINCT cu.id) AS total
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = cu.federation_id
       ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const dataRes = await db.query(
      `SELECT cu.id, cu.name AS full_name, cu.karate_registration_number,
              comp.name AS dojo_name,
              cb.belt_name, cu.is_active
       FROM customers cu
       LEFT JOIN companies comp ON comp.id = cu.dojo_id
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = cu.federation_id
       ${where}
       ORDER BY cu.name ASC
       LIMIT $${n} OFFSET $${n + 1}`,
      [...params, pageSize, offset]
    );

    const practitioners = dataRes.rows.map(r => ({
      id: r.id,
      full_name: r.full_name,
      karate_registration_number: r.karate_registration_number || null,
      dojo_name: r.dojo_name || null,
      belt_name: r.belt_name || null,
      affiliation_status: r.is_active ? 'active' : 'inactive',
    }));

    res.json({
      page,
      page_size: pageSize,
      total,
      data: practitioners,
    });
  } catch (err) {
    console.error('[karatePractitioners] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar praticantes' });
  }
});

// ── POST /federation/:id/practitioners ─────────────────────
router.post('/', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const {
    full_name, cpf, rg, birth_date, email, phone,
    dojo_id, is_student, parent_guardian_id,
    is_arbiter, is_instructor, is_examiner,
    photo_url,
    street, number, complement, neighborhood, city, state, zip_code,
    // P7 — responsável legal
    guardian_name, guardian_cpf, guardian_phone, guardian_relationship,
  } = req.body;

  if (!full_name || !String(full_name).trim()) {
    return res.status(422).json({ error: 'Campo full_name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!dojo_id) {
    return res.status(422).json({ error: 'Campo dojo_id é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica federação
    const fedRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    // Verifica dojô pertence à federação
    const dojoRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
      [dojo_id, federationId]
    );
    if (!dojoRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'dojo_id não pertence a esta federação', code: 'VALIDATION_ERROR' });
    }

    // Gera número de registro (NNNNN-D, continuando a sequência da federação)
    const regNumber = await nextPractitionerRegistrationNumber(client, federationId);

    const insertRes = await client.query(
      `INSERT INTO customers
         (company_id, name, cpf_cnpj, rg, birth_date, email, phone,
          is_student, parent_guardian_id, federation_id, dojo_id,
          is_arbiter, is_instructor, is_examiner,
          karate_photo_url, karate_registration_number,
          street, number, complement, neighborhood, city, state, zip_code,
          guardian_name, guardian_cpf, guardian_phone, guardian_relationship,
          is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21, $22, $23,
               $24, $25, $26, $27,
               true, NOW(), NOW())
       RETURNING id, name, cpf_cnpj, rg, birth_date, email, phone,
                 is_student, parent_guardian_id, federation_id, dojo_id,
                 is_arbiter, is_instructor, is_examiner,
                 karate_photo_url, karate_registration_number, is_active,
                 street, number, complement, neighborhood, city, state, zip_code,
                 guardian_name, guardian_cpf, guardian_phone, guardian_relationship`,
      [
        federationId,                        // company_id = federação (owner do registro)
        String(full_name).trim(),
        cpf || null,
        rg || null,
        birth_date || null,
        email || null,
        phone || null,
        is_student !== false,                 // default true
        parent_guardian_id || null,
        federationId,
        dojo_id,
        is_arbiter === true,
        is_instructor === true,
        is_examiner === true,
        photo_url || null,
        regNumber,
        street || null,
        number || null,
        complement || null,
        neighborhood || null,
        city || null,
        state || null,
        zip_code || null,
        // P7
        (guardian_name && String(guardian_name).trim()) || null,
        (guardian_cpf  && String(guardian_cpf).trim())  || null,
        (guardian_phone && String(guardian_phone).trim()) || null,
        (guardian_relationship && String(guardian_relationship).trim()) || null,
      ]
    );

    await client.query('COMMIT');

    const p = insertRes.rows[0];
    res.status(201).json(shapePractitioner(p));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karatePractitioners] create error:', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar praticante', detail: err.message });
  } finally {
    client.release();
  }
});

// ── PATCH /federation/:id/practitioners/:practitionerId ─────
// Edita a ficha do praticante, incluindo o status (is_active).
// Faixa NÃO entra aqui (karate_belt_history, append-only) — para registrar
// uma graduação use POST /practitioners/:practitionerId/graduations.
router.patch('/:practitionerId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const b = req.body || {};

  // Campo da ficha → coluna em customers
  const FIELD_COL = {
    full_name: 'name', cpf: 'cpf_cnpj', rg: 'rg', birth_date: 'birth_date',
    email: 'email', phone: 'phone', dojo_id: 'dojo_id',
    is_student: 'is_student', is_arbiter: 'is_arbiter',
    is_instructor: 'is_instructor', is_examiner: 'is_examiner',
    is_active: 'is_active', // status ativo/inativo do praticante
    parent_guardian_id: 'parent_guardian_id', photo_url: 'karate_photo_url',
    street: 'street', number: 'number', complement: 'complement',
    neighborhood: 'neighborhood', city: 'city', state: 'state', zip_code: 'zip_code',
    // P7 — responsável legal
    guardian_name: 'guardian_name',
    guardian_cpf: 'guardian_cpf',
    guardian_phone: 'guardian_phone',
    guardian_relationship: 'guardian_relationship',
  };

  // Campos booleanos: normaliza p/ não virar null no tratamento de string vazia.
  const BOOL_FIELDS = new Set(['is_student', 'is_arbiter', 'is_instructor', 'is_examiner', 'is_active']);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT id, dojo_id FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [practitionerId, federationId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    if (b.full_name !== undefined && !String(b.full_name).trim()) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'full_name não pode ser vazio', code: 'VALIDATION_ERROR' });
    }

    // Troca de dojô → valida que o novo dojô pertence à federação
    if (b.dojo_id && b.dojo_id !== cur.rows[0].dojo_id) {
      const d = await client.query(
        `SELECT id FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
        [b.dojo_id, federationId]
      );
      if (!d.rows.length) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'dojo_id não pertence a esta federação', code: 'VALIDATION_ERROR' });
      }
    }

    const sets = [];
    const vals = [];
    let i = 1;
    for (const [field, col] of Object.entries(FIELD_COL)) {
      if (b[field] === undefined) continue;
      let v = b[field];
      if (field === 'full_name') v = String(v).trim();
      if (BOOL_FIELDS.has(field)) {
        v = v === true || v === 'true' || v === 1; // coerção segura p/ boolean
      } else if (typeof v === 'string' && v.trim() === '') {
        // string vazia → null (dado ausente é neutro, não erro)
        v = null;
      }
      sets.push(`${col} = $${i}`); vals.push(v); i++;
    }
    if (!sets.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }
    sets.push('updated_at = NOW()');
    vals.push(practitionerId, federationId);

    await client.query(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = $${i} AND federation_id = $${i + 1}`,
      vals
    );
    await client.query('COMMIT');

    // Retorna a ficha atualizada (com faixa atual)
    const out = await db.query(
      `SELECT cu.id, cu.name, cu.cpf_cnpj, cu.rg, cu.birth_date, cu.email, cu.phone,
              cu.is_student, cu.parent_guardian_id, cu.dojo_id,
              cu.is_arbiter, cu.is_instructor, cu.is_examiner,
              cu.karate_photo_url, cu.karate_registration_number, cu.is_active,
              cu.street, cu.number, cu.complement, cu.neighborhood, cu.city, cu.state, cu.zip_code,
              cu.guardian_name, cu.guardian_cpf, cu.guardian_phone, cu.guardian_relationship,
              cb.belt_level, cb.belt_name, cb.current_since
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $2
       WHERE cu.id = $1 LIMIT 1`,
      [practitionerId, federationId]
    );
    res.json(shapePractitioner(out.rows[0]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[karatePractitioners] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar praticante', detail: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /federation/:id/practitioners/:practitionerId ─────
// Exclusão DEFINITIVA do praticante (linha de customers). A federação tem os
// dois caminhos (decisão Caio):
//   - Desativar (soft): PATCH is_active=false  (não é aqui).
//   - Excluir definitivamente: este endpoint.
//
// Guarda de histórico no mesmo padrão de funcionários/membros/dojô:
//   - Sem dependentes → hard delete direto → 200 { deleted:true }.
//   - Com dependentes e SEM ?cascade=true → 409 { code:'HAS_HISTORY', counts }.
//   - Com dependentes E ?cascade=true → apaga os filhos em transação (faixas,
//     transferências, carteirinhas) e CANCELA as transactions ligadas ao
//     praticante (preserva a trilha financeira; não apaga linha de transação),
//     depois apaga a linha de customers → 200 { deleted:true, cascade:true, counts }.
//
// Dependentes detectados:
//   karate_belt_history (student_id), karate_practitioner_transfers
//   (practitioner_id), karate_membership_cards (student_id) e transactions
//   ligadas ao praticante (reference_type='customer' AND reference_id = id).
router.delete('/:practitionerId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const cascade = req.query.cascade === 'true' || req.query.cascade === '1';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Existência + escopo da federação (trava a linha).
    const cur = await client.query(
      `SELECT id, name FROM customers WHERE id = $1 AND federation_id = $2 FOR UPDATE`,
      [practitionerId, federationId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    // Conta dependentes (defensivo a 42P01 nas tabelas karatê opcionais).
    const counts = { graduations: 0, transfers: 0, cards: 0, transactions: 0 };
    const safeCount = async (sql, params) => {
      try { const r = await client.query(sql, params); return parseInt(r.rows[0].c, 10) || 0; }
      catch (e) { if (e.code === '42P01') return 0; throw e; }
    };
    counts.graduations  = await safeCount(`SELECT COUNT(*)::int AS c FROM karate_belt_history WHERE student_id = $1 AND federation_id = $2`, [practitionerId, federationId]);
    counts.transfers    = await safeCount(`SELECT COUNT(*)::int AS c FROM karate_practitioner_transfers WHERE practitioner_id = $1 AND federation_id = $2`, [practitionerId, federationId]);
    counts.cards        = await safeCount(`SELECT COUNT(*)::int AS c FROM karate_membership_cards WHERE student_id = $1 AND federation_id = $2`, [practitionerId, federationId]);
    counts.transactions = await safeCount(`SELECT COUNT(*)::int AS c FROM transactions WHERE reference_type = 'customer' AND reference_id = $1 AND federation_id = $2`, [practitionerId, federationId]);

    const hasHistory = counts.graduations + counts.transfers + counts.cards + counts.transactions > 0;

    if (hasHistory && !cascade) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'HAS_HISTORY',
        error: 'Este praticante tem histórico vinculado (graduações, transferências, carteirinhas ou cobranças). Desative-o ou confirme a exclusão definitiva em cascata.',
        counts: { graduations: counts.graduations, transfers: counts.transfers, cards: counts.cards, transactions: counts.transactions },
      });
    }

    if (hasHistory && cascade) {
      // Apaga os filhos antes da linha de customers (ordem segura de FK).
      const safeExec = async (sql, params) => {
        try { await client.query(sql, params); }
        catch (e) { if (e.code !== '42P01') throw e; }
      };
      await safeExec(`DELETE FROM karate_belt_history WHERE student_id = $1 AND federation_id = $2`, [practitionerId, federationId]);
      await safeExec(`DELETE FROM karate_practitioner_transfers WHERE practitioner_id = $1 AND federation_id = $2`, [practitionerId, federationId]);
      await safeExec(`DELETE FROM karate_membership_cards WHERE student_id = $1 AND federation_id = $2`, [practitionerId, federationId]);
      // Transactions: NÃO apaga (trilha financeira) — cancela as pendentes/confirmadas.
      await safeExec(
        `UPDATE transactions SET status = 'cancelled', updated_at = NOW()
         WHERE reference_type = 'customer' AND reference_id = $1 AND federation_id = $2 AND status <> 'cancelled'`,
        [practitionerId, federationId]
      );
    }

    await client.query(
      `DELETE FROM customers WHERE id = $1 AND federation_id = $2`,
      [practitionerId, federationId]
    );
    await client.query('COMMIT');

    if (hasHistory && cascade) {
      return res.json({ deleted: true, cascade: true, id: practitionerId, name: cur.rows[0].name, counts });
    }
    return res.json({ deleted: true, id: practitionerId, name: cur.rows[0].name });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    // FK inesperada → orienta desativar/cascata em vez de quebrar.
    if (err && err.code === '23503') {
      return res.status(409).json({
        code: 'HAS_HISTORY',
        error: 'Este praticante possui registros vinculados e não pode ser apagado diretamente. Use cascade=true ou desative-o.',
      });
    }
    console.error('[karatePractitioners] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir praticante', detail: err.message });
  } finally {
    client.release();
  }
});

// ── POST /federation/:id/practitioners/:practitionerId/graduations ──
// Registra uma graduação MANUAL no histórico de faixas (karate_belt_history).
// A tabela é append-only/imutável; a view karate_current_belt deriva a faixa
// atual pelo MAX(graduated_at). Isto é o "editar trajetória" do detalhe:
// adicionar uma faixa + data, sem alterar registros anteriores.
//
// Body: { belt_level (req), belt_name?, belt_schema?, graduated_at? (YYYY-MM-DD), notes? }
router.post('/:practitionerId/graduations', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const b = req.body || {};

  const beltLevel  = b.belt_level != null ? String(b.belt_level).trim() : '';
  const beltName   = b.belt_name != null ? String(b.belt_name).trim() : '';
  const beltSchema = b.belt_schema === 'legacy' ? 'legacy' : 'fpkt_shotokan';
  const notes      = b.notes != null ? String(b.notes).trim() : null;

  if (!beltLevel && !beltName) {
    return res.status(422).json({ error: 'Informe belt_level ou belt_name', code: 'VALIDATION_ERROR' });
  }

  // graduated_at: aceita YYYY-MM-DD; default hoje. Valida formato simples.
  let graduatedAt = (b.graduated_at != null ? String(b.graduated_at).slice(0, 10) : '') || null;
  if (graduatedAt && !/^\d{4}-\d{2}-\d{2}$/.test(graduatedAt)) {
    return res.status(422).json({ error: 'graduated_at deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
  }

  try {
    // Praticante pertence à federação?
    const prac = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [practitionerId, federationId]
    );
    if (!prac.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    const insertRes = await db.query(
      `INSERT INTO karate_belt_history
         (student_id, federation_id, belt_level, belt_name, belt_schema,
          graduated_at, notes, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, NOW())
       RETURNING id, belt_level, belt_name, belt_schema, graduated_at, exam_id, notes`,
      [
        practitionerId,
        federationId,
        beltLevel || beltName,         // belt_level NOT NULL
        beltName || beltLevel,         // belt_name  NOT NULL
        beltSchema,
        graduatedAt,
        notes,
        req.user?.id || null,
      ]
    );

    const r = insertRes.rows[0];
    res.status(201).json({
      id: r.id,
      belt_level: r.belt_level,
      belt_name: r.belt_name,
      belt_schema: r.belt_schema,
      graduated_at: r.graduated_at,
      is_legacy: r.belt_schema === 'legacy',
      exam_id: r.exam_id || null,
      notes: r.notes || null,
    });
  } catch (err) {
    console.error('[karatePractitioners] graduation error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar graduação', detail: err.message });
  }
});

// ── PATCH /federation/:id/practitioners/:practitionerId/graduations/:graduationId ──
// Corrige UMA linha do histórico de faixas (karate_belt_history). Campos
// editáveis: belt_level, belt_name, graduated_at (data). A view
// karate_current_belt recalcula a faixa atual sozinha após a edição.
router.patch('/:practitionerId/graduations/:graduationId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId, graduationId } = req.params;
  const b = req.body || {};

  // Monta o SET dinâmico só com os campos enviados (whitelist).
  const sets = [];
  const vals = [];
  let i = 1;

  if (b.belt_level !== undefined) {
    const v = b.belt_level != null ? String(b.belt_level).trim() : '';
    if (!v) return res.status(422).json({ error: 'belt_level não pode ser vazio', code: 'VALIDATION_ERROR' });
    sets.push(`belt_level = $${i}`); vals.push(v); i++;
  }
  if (b.belt_name !== undefined) {
    const v = b.belt_name != null ? String(b.belt_name).trim() : '';
    if (!v) return res.status(422).json({ error: 'belt_name não pode ser vazio', code: 'VALIDATION_ERROR' });
    sets.push(`belt_name = $${i}`); vals.push(v); i++;
  }
  if (b.graduated_at !== undefined) {
    const v = b.graduated_at != null ? String(b.graduated_at).slice(0, 10) : '';
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return res.status(422).json({ error: 'graduated_at deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
    }
    sets.push(`graduated_at = $${i}::date`); vals.push(v); i++;
  }

  if (!sets.length) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  try {
    // Escopo: a graduação pertence a ESTE praticante E a ESTA federação.
    vals.push(graduationId, practitionerId, federationId);
    const upd = await db.query(
      `UPDATE karate_belt_history
          SET ${sets.join(', ')}
        WHERE id = $${i} AND student_id = $${i + 1} AND federation_id = $${i + 2}
      RETURNING id, belt_level, belt_name, belt_schema, graduated_at, exam_id, notes`,
      vals
    );
    if (!upd.rows.length) {
      return res.status(404).json({ error: 'Graduação não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    const r = upd.rows[0];
    res.json({
      id: r.id,
      belt_level: r.belt_level,
      belt_name: r.belt_name,
      belt_schema: r.belt_schema,
      graduated_at: r.graduated_at,
      is_legacy: r.belt_schema === 'legacy',
      exam_id: r.exam_id || null,
      notes: r.notes || null,
    });
  } catch (err) {
    // P0001 = RAISE EXCEPTION sem código explícito. Antes da migration 199
    // (que remove trg_belt_history_no_update), o trigger de imutabilidade
    // da migration 149 bloqueia este UPDATE — fallback defensivo até a
    // migration ser aplicada no ambiente.
    if (err.code === 'P0001') {
      console.error('[karatePractitioners] graduation update blocked by legacy immutability trigger (apply migration 199):', err.message);
      return res.status(503).json({
        error: 'Edição de graduação indisponível no momento (atualização de banco pendente). Tente novamente em instantes.',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[karatePractitioners] graduation update error:', err.message);
    res.status(500).json({ error: 'Erro ao editar graduação', detail: err.message });
  }
});

// ── DELETE /federation/:id/practitioners/:practitionerId/graduations/:graduationId ──
// Exclui UMA linha do histórico de faixas. A view karate_current_belt
// recalcula a faixa atual sozinha; se era a última graduação, o praticante
// pode ficar sem faixa — comportamento esperado/aceitável.
router.delete('/:practitionerId/graduations/:graduationId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId, graduationId } = req.params;
  try {
    const del = await db.query(
      `DELETE FROM karate_belt_history
        WHERE id = $1 AND student_id = $2 AND federation_id = $3
      RETURNING id`,
      [graduationId, practitionerId, federationId]
    );
    if (!del.rows.length) {
      return res.status(404).json({ error: 'Graduação não encontrada para este praticante', code: 'NOT_FOUND' });
    }
    res.json({ deleted: true, id: graduationId });
  } catch (err) {
    // P0001 = RAISE EXCEPTION sem código explícito. Antes da migration 199
    // (que remove trg_belt_history_no_delete), o trigger de imutabilidade
    // da migration 149 bloqueia este DELETE — fallback defensivo até a
    // migration ser aplicada no ambiente.
    if (err.code === 'P0001') {
      console.error('[karatePractitioners] graduation delete blocked by legacy immutability trigger (apply migration 199):', err.message);
      return res.status(503).json({
        error: 'Exclusão de graduação indisponível no momento (atualização de banco pendente). Tente novamente em instantes.',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[karatePractitioners] graduation delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir graduação', detail: err.message });
  }
});

// ── GET /federation/:id/practitioners/:practitionerId ───────
// P9: inclui last_exam + course_count_last_year.
//   last_exam: graduação mais recente (karate_belt_history, MAX graduated_at,
//     excluindo sentinela 1900-01-01 e datas futuras).
//   course_count_last_year: cursos (exam_type='curso') em que o praticante
//     participou nos últimos 12 meses via karate_belt_exam_candidates JOIN
//     karate_belt_exams.event_date. Degrada para 0 a 42P01.
router.get('/:practitionerId', ...guards.read(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;

  try {
    const pracRes = await db.query(
      `SELECT cu.id, cu.name, cu.cpf_cnpj, cu.rg, cu.birth_date,
              cu.email, cu.phone, cu.is_student, cu.parent_guardian_id,
              cu.dojo_id, cu.is_arbiter, cu.is_instructor, cu.is_examiner,
              cu.karate_photo_url, cu.karate_registration_number,
              cu.is_active,
              cu.street, cu.number, cu.complement, cu.neighborhood, cu.city, cu.state, cu.zip_code,
              cu.guardian_name, cu.guardian_cpf, cu.guardian_phone, cu.guardian_relationship,
              cb.belt_level, cb.belt_name, cb.current_since
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $1
       WHERE cu.id = $2 AND cu.federation_id = $1
       LIMIT 1`,
      [federationId, practitionerId]
    );

    if (!pracRes.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    const p = pracRes.rows[0];

    // Histórico de faixas
    // Tiebreak por created_at: graduated_at sozinho não garante ordem
    // estável quando duas linhas têm a MESMA data (ex.: duas faixas
    // importadas com a data-sentinela 1900-01-01, ou data editada via PATCH
    // para coincidir com outro registro) — sem 2º critério, o Postgres não
    // garante ordem entre empates e a trajetória pode "embaralhar" entre
    // requisições. created_at é sempre populado (NOW() no INSERT, tabela é
    // append-only) e reflete a ordem real de registro.
    const beltHistRes = await db.query(
      `SELECT id, belt_level, belt_name, belt_schema, graduated_at, exam_id
       FROM karate_belt_history
       WHERE student_id = $1 AND federation_id = $2
       ORDER BY graduated_at ASC, created_at ASC`,
      [practitionerId, federationId]
    );

    const beltHistory = beltHistRes.rows.map(r => ({
      id: r.id,
      belt_level: r.belt_level,
      belt_name: r.belt_name,
      belt_schema: r.belt_schema,
      graduated_at: r.graduated_at,
      is_legacy: r.belt_schema === 'legacy',
      exam_id: r.exam_id || null,
    }));

    // P9 — last_exam: graduação mais recente (excluindo sentinela 1900-01-01 e futuro)
    let lastExam = null;
    try {
      const lastExamRes = await db.query(
        `SELECT kbh.graduated_at AS date,
                kbh.belt_name,
                kbe.name AS exam_name,
                kbe.event_date
         FROM karate_belt_history kbh
         LEFT JOIN karate_belt_exams kbe ON kbe.id = kbh.exam_id AND kbe.federation_id = $2
         WHERE kbh.student_id = $1
           AND kbh.federation_id = $2
           AND kbh.graduated_at > '1900-01-01'
           AND kbh.graduated_at <= CURRENT_DATE
         ORDER BY kbh.graduated_at DESC
         LIMIT 1`,
        [practitionerId, federationId]
      );
      if (lastExamRes.rows.length) {
        const r = lastExamRes.rows[0];
        lastExam = {
          date: r.date,
          belt_name: r.belt_name || null,
          exam_name: r.exam_name || null,
          event_date: r.event_date || null,
        };
      }
    } catch (e) {
      // Degrada graciosamente; 42P01 improvável aqui mas seguro
      if (e.code !== '42P01') console.error('[karatePractitioners] last_exam error:', e.message);
      lastExam = null;
    }

    // P9 — course_count_last_year: cursos dos últimos 12 meses
    // Tabela: karate_belt_exam_candidates (student_id, exam_id)
    // JOIN karate_belt_exams (exam_type='curso', event_date >= hoje-1ano)
    let courseCountLastYear = 0;
    try {
      const courseCountRes = await db.query(
        `SELECT COUNT(DISTINCT ec.exam_id)::int AS cnt
         FROM karate_belt_exam_candidates ec
         JOIN karate_belt_exams be
           ON be.id = ec.exam_id
          AND be.federation_id = $2
          AND be.exam_type = 'curso'
          AND be.event_date >= CURRENT_DATE - INTERVAL '1 year'
         WHERE ec.student_id = $1`,
        [practitionerId, federationId]
      );
      courseCountLastYear = courseCountRes.rows[0]?.cnt ?? 0;
    } catch (e) {
      // 42P01: tabela ainda não existe → degrada para 0
      if (e.code !== '42P01') console.error('[karatePractitioners] course_count error:', e.message);
      courseCountLastYear = 0;
    }

    res.json({
      ...shapePractitioner(p),
      belt_history: beltHistory,
      last_exam: lastExam,
      course_count_last_year: courseCountLastYear,
    });
  } catch (err) {
    console.error('[karatePractitioners] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar praticante' });
  }
});

// ── GET /federation/:id/practitioners/:practitionerId/courses ──
// P9 (opcional) — lista de cursos em que o praticante participou nos últimos
// 12 meses. Usa karate_belt_exam_candidates JOIN karate_belt_exams.
// Degrada para [] a 42P01 (tabela inexistente).
router.get('/:practitionerId/courses', ...guards.read(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;

  try {
    // Verifica existência do praticante
    const prac = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [practitionerId, federationId]
    );
    if (!prac.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    let courses = [];
    try {
      const coursesRes = await db.query(
        `SELECT be.id AS exam_id,
                be.name,
                be.event_date,
                be.location,
                ec.status AS enrollment_status,
                ec.created_at AS enrolled_at
         FROM karate_belt_exam_candidates ec
         JOIN karate_belt_exams be
           ON be.id = ec.exam_id
          AND be.federation_id = $2
          AND be.exam_type = 'curso'
          AND be.event_date >= CURRENT_DATE - INTERVAL '1 year'
         WHERE ec.student_id = $1
         ORDER BY be.event_date DESC`,
        [practitionerId, federationId]
      );
      courses = coursesRes.rows.map(r => ({
        exam_id: r.exam_id,
        name: r.name || null,
        event_date: r.event_date,
        location: r.location || null,
        enrollment_status: r.enrollment_status,
        enrolled_at: r.enrolled_at,
      }));
    } catch (e) {
      if (e.code !== '42P01') console.error('[karatePractitioners] courses list error:', e.message);
      // Tabela ausente → retorna lista vazia (degradação)
      courses = [];
    }

    res.json({ practitioner_id: practitionerId, count: courses.length, data: courses });
  } catch (err) {
    console.error('[karatePractitioners] courses error:', err.message);
    res.status(500).json({ error: 'Erro ao listar cursos do praticante' });
  }
});

// ── POST /federation/:id/practitioners/:practitionerId/photo ─
// Upload de foto do praticante. Grava binário no Cloudflare R2 e atualiza
// customers.karate_photo_url com a URL pública resultante.
//
// Body JSON:
//   content      {string}  Imagem codificada em base64 (obrigatório).
//   content_type {string?} MIME da imagem. Default: "image/jpeg".
//                          Aceitos: image/jpeg, image/png, image/webp.
//
// Limite de tamanho: 5 MB — herdado de express.json({ limit: '5mb' }) em
// src/app.js; tentativas acima disso retornam 413 antes de chegar aqui.
//
// Padrão idêntico a productImage.js e variantImage.js (JSON + base64 → R2).
// Sem migration — karate_photo_url já existe na tabela customers.
//
// Retorna: { photo_url: string }
router.post('/:practitionerId/photo', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const { content, content_type } = req.body || {};

  // Validação do payload
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({
      error: 'Campo content (imagem em base64) é obrigatório',
      code: 'VALIDATION_ERROR',
    });
  }

  // Mimetypes aceitos — rejeita tipos claramente não-imagem
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const mime = ((content_type || 'image/jpeg') + '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_TYPES.includes(mime)) {
    return res.status(400).json({
      error: 'Tipo de imagem não suportado: ' + mime + '. Use image/jpeg, image/png ou image/webp.',
      code: 'INVALID_CONTENT_TYPE',
    });
  }

  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

  try {
    // Valida que o praticante pertence à federação
    const pracRes = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [practitionerId, federationId]
    );
    if (!pracRes.rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado', code: 'NOT_FOUND' });
    }

    // Upload para R2 — mesma convenção de productImage.js / variantImage.js.
    // uploadToR2 converte a string base64 para Buffer internamente.
    const key = 'karate/practitioners/' + federationId + '/' + practitionerId + '.' + ext;
    const result = await uploadToR2(key, content, mime);
    if (!result.success) {
      console.error('[karatePractitioners] photo R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no armazenamento da imagem' });
    }

    // Grava URL pública no banco
    await db.query(
      `UPDATE customers SET karate_photo_url = $1, updated_at = NOW()
       WHERE id = $2 AND federation_id = $3`,
      [result.url, practitionerId, federationId]
    );

    res.json({ photo_url: result.url });
  } catch (err) {
    console.error('[karatePractitioners] photo error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar foto do praticante', detail: err.message });
  }
});

// Monta o objeto de resposta do praticante a partir de uma row de customers
// (aceita a coluna de nome como `name` ou `full_name`).
function shapePractitioner(p) {
  return {
    id: p.id,
    full_name: p.name || p.full_name,
    cpf: p.cpf_cnpj || null,
    rg: p.rg || null,
    birth_date: p.birth_date || null,
    email: p.email || null,
    phone: p.phone || null,
    dojo_id: p.dojo_id || null,
    is_student: p.is_student,
    parent_guardian_id: p.parent_guardian_id || null,
    is_arbiter: p.is_arbiter,
    is_instructor: p.is_instructor,
    is_examiner: p.is_examiner,
    photo_url: p.karate_photo_url || null,
    karate_registration_number: p.karate_registration_number || null,
    is_active: p.is_active,
    affiliation_status: p.is_active ? 'active' : 'inactive',
    street: p.street || null,
    number: p.number || null,
    complement: p.complement || null,
    neighborhood: p.neighborhood || null,
    city: p.city || null,
    state: p.state || null,
    zip_code: p.zip_code || null,
    // P7 — responsável legal
    guardian_name: p.guardian_name || null,
    guardian_cpf: p.guardian_cpf || null,
    guardian_phone: p.guardian_phone || null,
    guardian_relationship: p.guardian_relationship || null,
    current_belt: p.belt_level ? {
      belt_level: p.belt_level,
      belt_name: p.belt_name,
      current_since: p.current_since,
    } : null,
  };
}

module.exports = router;
