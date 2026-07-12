// ============================================================
// AURA KARATÊ — Rotas de Dojôs (Track A)
// GET  /federation/:id/dojos
// POST /federation/:id/dojos
// GET  /federation/:id/dojos/:dojoId
// PATCH /federation/:id/dojos/:dojoId
// DELETE /federation/:id/dojos/:dojoId   (soft via PATCH is_active; hard com guarda 409 / cascata)
//
// Status computado (ver karateService.computeDojoStatus):
//   active   → is_active !== false
//   inactive → is_active === false
// (Decisão 02/07/2026: status do dojô é só is_active; inadimplência de
// anuidade é métrica separada, ver karateFinanceService/karateFederation.)
//
// FPKT-NNN gerado com advisory lock por federação (ver karateService).
//
// companies exige owner_id + legal_name (NOT NULL). O dojô pertence a um usuário
// de SISTEMA (não ao admin da federação — evita o bug de login multi-empresa).
//
// Endereço (Fix 5): além do campo `address` (texto livre legado, mantido por
// compat), o dojô usa as colunas estruturadas address_street/address_number/
// address_complement/address_district/address_city/address_state/address_zip —
// as MESMAS já usadas pela NF-e. ATENÇÃO: a coluna de bairro em companies é
// `address_district` (NÃO address_neighborhood). O JSON da API expõe o campo
// como `address_neighborhood` (bairro) e mapeia <-> address_district.
//
// 25/06/2026 — DOJO-RM: federação ganha liberdade de gerenciar dados (editar/excluir).
//   - PATCH passa a aceitar `is_active` (suspender/reativar pela UI) e sincroniza
//     legal_name = name quando o nome muda (legal_name só era setado no POST).
//   - DELETE oferece DOIS caminhos (decisão de produto): se o dojô tem histórico
//     vinculado e a query NÃO tem ?cascade=true → 409 { code:'HAS_HISTORY', counts }
//     (FE oferece Suspender via PATCH is_active=false vs Excluir definitivamente).
//     Com ?cascade=true → hard delete em cascata, em transação, na ordem de FK.
//     Mesmo formato de resposta usado em employees/members (HAS_HISTORY).
//
// 27/06/2026 — migration 193: sensei_name + sensei_practitioner_id.
//   - PATCH aceita sensei_name (texto, '' → null) e sensei_practitioner_id (uuid, '' → null).
//   - POST aceita os mesmos campos opcionais.
//   - GET lista retorna sensei_name e sensei_practitioner_id.
//   - GET detalhe retorna sensei_name, sensei_practitioner_id e sensei_practitioner_name
//     (nome atual do praticante vinculado, via LEFT JOIN customers — best-effort).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const crypto = require('crypto');
const { nextDojoAffiliationId, computeDojoStatus } = require('../services/karateService');

// Colunas de endereço estruturado (compartilhadas com a NF-e).
// Bairro: coluna real = address_district; expomos como address_neighborhood.
const ADDRESS_COLS =
  'c.address, c.address_street, c.address_number, c.address_complement, ' +
  'c.address_district AS address_neighborhood, c.address_city, c.address_state, c.address_zip';

// Migration 206 — is_assistant (papel "Auxiliar" do praticante, customers).
// Backend sobe antes da migration ser aplicada (armadilha_schema_pre_migration
// do CLAUDE.md): cache module-level otimista, vira false em 42703 e a query
// de time técnico cai para a forma sem esta coluna.
let HAS_IS_ASSISTANT_COL = true;

// Migration 226 — karate_annuity_plan (plano de anuidade DO DOJO; NULL =
// federacao ainda nao definiu, ver comentario da migration). Backend sobe
// antes da migration (armadilha_schema_pre_migration do CLAUDE.md): cache
// module-level otimista, vira false em 42703 e as queries caem para a
// forma sem esta coluna (dojo aparece com karate_annuity_plan: null, que
// e o estado real "indefinido" -- degradacao graceful e correta).
let HAS_ANNUITY_PLAN_COL = true;
const KARATE_ANNUITY_PLAN_VALUES = ['anual', 'semestral', 'trimestral'];

// Monta o bloco de endereço da resposta JSON a partir de uma row.
// (a row já vem com address_neighborhood por causa do alias acima / RETURNING)
function addressOut(r) {
  return {
    address: r.address || null,
    address_street: r.address_street || null,
    address_number: r.address_number || null,
    address_complement: r.address_complement || null,
    address_neighborhood: r.address_neighborhood || null,
    address_city: r.address_city || null,
    address_state: r.address_state || null,
    address_zip: r.address_zip || null,
  };
}

// Normaliza string vazia para null (usado em sensei_name).
function strOrNull(v) {
  if (v === undefined || v === null) return undefined; // undefined = "não enviado" (não altera no PATCH)
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Normaliza uuid: string vazia ou inválida → null.
// Aceita apenas o formato 8-4-4-4-12 (hex + hífens). Defensivo: nunca deixa
// uma string malformada chegar ao Postgres.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v) {
  if (v === undefined || v === null) return undefined; // undefined = "não enviado"
  const s = String(v).trim();
  if (s === '' || !UUID_RE.test(s)) return null;
  return s;
}

// ── GET /federation/:id/dojos ───────────────────────────────
router.get('/', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { region, status, affiliation_model, q } = req.query;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset   = (page - 1) * pageSize;

  try {
    const conditions = [`c.federation_id = $1`, `c.vertical_active = 'karate_dojo'`];
    const params = [federationId];
    let n = 2;

    if (region) {
      conditions.push(`c.region ILIKE $${n}`);
      params.push(`%${region}%`);
      n++;
    }
    if (affiliation_model) {
      conditions.push(`c.affiliation_model = $${n}`);
      params.push(affiliation_model);
      n++;
    }
    if (q) {
      conditions.push(`(c.name ILIKE $${n} OR c.fpkt_affiliation_id ILIKE $${n})`);
      params.push(`%${q}%`);
      n++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    // karate_annuity_plan (Migration 226) — incluído na listagem defensivamente
    // (mesmo padrão de HAS_ANNUITY_PLAN_COL usado no resto do arquivo): sem
    // ele, a coluna "Modelo" da listagem só mostrava affiliation_model
    // (metadado decorativo, nunca lido por rota de cobrança — ver
    // DojoFichaModal.tsx) e afirmava "Anual" pra todo mundo mesmo quando o
    // plano de anuidade REAL (o que a campanha usa) está indefinido — a
    // lista prometia uma certeza que a ficha do dojô já desmentia.
    const annuityCol = HAS_ANNUITY_PLAN_COL ? ', c.karate_annuity_plan' : '';

    if (status) {
      // Status agora é só active/inactive (deriva de is_active — ver
      // karateService.computeDojoStatus), mas mantemos o filtro em JS após
      // buscar o conjunto completo, para não duplicar a lógica em SQL.
      // NOTE: aceitável pois queries filtradas por status são tipicamente
      // dashboard-scoped e o resultado por federação é limitado (~centenas).
      let allRes;
      try {
        allRes = await db.query(
          `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.sensei_name, c.sensei_practitioner_id,
                  c.region, c.fpkt_affiliation_id,
                  c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
                  ${ADDRESS_COLS}, c.phone, c.email, c.is_active, c.karate_logo_url${annuityCol},
                  COUNT(cu.id) AS practitioner_count
           FROM companies c
           LEFT JOIN customers cu ON cu.dojo_id = c.id
           ${where}
           GROUP BY c.id
           ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC`,
          params
        );
      } catch (e) {
        if (e.code === '42703') {
          HAS_ANNUITY_PLAN_COL = false;
          console.warn('[karateDojos] karate_annuity_plan ausente na listagem (Migration 226 pendente) — fallback sem coluna');
          allRes = await db.query(
            `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.sensei_name, c.sensei_practitioner_id,
                    c.region, c.fpkt_affiliation_id,
                    c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
                    ${ADDRESS_COLS}, c.phone, c.email, c.is_active, c.karate_logo_url,
                    COUNT(cu.id) AS practitioner_count
             FROM companies c
             LEFT JOIN customers cu ON cu.dojo_id = c.id
             ${where}
             GROUP BY c.id
             ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC`,
            params
          );
        } else throw e;
      }

      const allDojosWithStatus = allRes.rows.map(r => ({
        id: r.id,
        name: r.name,
        cnpj: r.cnpj || null,
        sensei_cpf: r.sensei_cpf || null,
        sensei_name: r.sensei_name || null,
        sensei_practitioner_id: r.sensei_practitioner_id || null,
        region: r.region || null,
        fpkt_affiliation_id: r.fpkt_affiliation_id || null,
        affiliation_model: r.affiliation_model || null,
        affiliation_since: r.affiliation_since || null,
        dojo_founded_year: r.dojo_founded_year || null,
        ...addressOut(r),
        phone: r.phone || null,
        email: r.email || null,
        karate_logo_url: r.karate_logo_url || null,
        is_active: r.is_active !== false,
        status: computeDojoStatus(r.affiliation_model, r.affiliation_since, r.is_active),
        karate_annuity_plan: r.karate_annuity_plan || null,
        practitioner_count: parseInt(r.practitioner_count, 10) || 0,
      }));

      const filtered = allDojosWithStatus.filter(d => d.status === status);
      const total = filtered.length;
      const data  = filtered.slice(offset, offset + pageSize);

      return res.json({ page, page_size: pageSize, total, data });
    }

    // No status filter — use SQL-level COUNT + paginated fetch (fast path)
    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM companies c ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    let dataRes;
    try {
      dataRes = await db.query(
        `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.sensei_name, c.sensei_practitioner_id,
                c.region, c.fpkt_affiliation_id,
                c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
                ${ADDRESS_COLS}, c.phone, c.email, c.is_active, c.karate_logo_url${annuityCol},
                COUNT(cu.id) AS practitioner_count
         FROM companies c
         LEFT JOIN customers cu ON cu.dojo_id = c.id
         ${where}
         GROUP BY c.id
         ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC
         LIMIT $${n} OFFSET $${n + 1}`,
        [...params, pageSize, offset]
      );
    } catch (e) {
      if (e.code === '42703') {
        HAS_ANNUITY_PLAN_COL = false;
        console.warn('[karateDojos] karate_annuity_plan ausente na listagem (Migration 226 pendente) — fallback sem coluna');
        dataRes = await db.query(
          `SELECT c.id, c.name, c.cnpj, c.sensei_cpf, c.sensei_name, c.sensei_practitioner_id,
                  c.region, c.fpkt_affiliation_id,
                  c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
                  ${ADDRESS_COLS}, c.phone, c.email, c.is_active, c.karate_logo_url,
                  COUNT(cu.id) AS practitioner_count
           FROM companies c
           LEFT JOIN customers cu ON cu.dojo_id = c.id
           ${where}
           GROUP BY c.id
           ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC
           LIMIT $${n} OFFSET $${n + 1}`,
          [...params, pageSize, offset]
        );
      } else throw e;
    }

    const dojos = dataRes.rows.map(r => ({
      id: r.id,
      name: r.name,
      cnpj: r.cnpj || null,
      sensei_cpf: r.sensei_cpf || null,
      sensei_name: r.sensei_name || null,
      sensei_practitioner_id: r.sensei_practitioner_id || null,
      region: r.region || null,
      fpkt_affiliation_id: r.fpkt_affiliation_id || null,
      affiliation_model: r.affiliation_model || null,
      affiliation_since: r.affiliation_since || null,
      dojo_founded_year: r.dojo_founded_year || null,
      ...addressOut(r),
      phone: r.phone || null,
      email: r.email || null,
      karate_logo_url: r.karate_logo_url || null,
      is_active: r.is_active !== false,
      status: computeDojoStatus(r.affiliation_model, r.affiliation_since, r.is_active),
      karate_annuity_plan: r.karate_annuity_plan || null,
      practitioner_count: parseInt(r.practitioner_count, 10) || 0,
    }));

    res.json({ page, page_size: pageSize, total, data: dojos });
  } catch (err) {
    console.error('[karateDojos] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar dojôs' });
  }
});

// ── GET /federation/:id/dojos/export ────────────────────────
// 11/07/2026: export de dojôs (mesmo padrão do export de praticantes em
// karatePractitioners.js) — aceita os MESMOS filtros opcionais da listagem
// (GET /): region, affiliation_model, q e status. Sem filtros → exporta
// todos os dojôs da federação.
// ATENÇÃO ordem de rotas: precisa ser registrada ANTES de GET /:dojoId,
// senão a string literal 'export' seria capturada como :dojoId (mesmo
// cuidado documentado em karatePractitioners.js para /practitioners/export).
// status é CALCULADO em JS via computeDojoStatus (não é coluna simples) —
// para bater exatamente com o que a tela mostra, buscamos todas as linhas
// que casam os demais filtros, computamos o status em JS com a MESMA
// função usada pela listagem, e só então filtramos por status (igual ao
// fast path condicional já usado em GET /).
router.get('/export', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { region, status, affiliation_model, q } = req.query;

  try {
    const conditions = [`c.federation_id = $1`, `c.vertical_active = 'karate_dojo'`];
    const params = [federationId];
    let n = 2;

    if (region) {
      conditions.push(`c.region ILIKE $${n}`);
      params.push(`%${region}%`);
      n++;
    }
    if (affiliation_model) {
      conditions.push(`c.affiliation_model = $${n}`);
      params.push(affiliation_model);
      n++;
    }
    if (q) {
      conditions.push(`(c.name ILIKE $${n} OR c.fpkt_affiliation_id ILIKE $${n})`);
      params.push(`%${q}%`);
      n++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await db.query(
      `SELECT c.id, c.name, c.cnpj, c.region, c.fpkt_affiliation_id,
              c.affiliation_model, c.affiliation_since, c.phone, c.email,
              c.address_city, c.address_state, c.is_active,
              COUNT(cu.id) AS practitioner_count,
              COUNT(cu.id) FILTER (WHERE cu.is_active = true) AS active_practitioner_count
       FROM companies c
       LEFT JOIN customers cu ON cu.dojo_id = c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC`,
      params
    );

    let dojos = rows.map(r => ({
      nome: r.name || null,
      codigo_fpkt: r.fpkt_affiliation_id || null,
      status: computeDojoStatus(r.affiliation_model, r.affiliation_since, r.is_active),
      regiao: r.region || null,
      modelo_filiacao: r.affiliation_model || null,
      cnpj: r.cnpj || null,
      telefone: r.phone || null,
      email: r.email || null,
      cidade: r.address_city || null,
      estado: r.address_state || null,
      total_praticantes: parseInt(r.practitioner_count, 10) || 0,
      praticantes_ativos: parseInt(r.active_practitioner_count, 10) || 0,
    }));

    // status é derivado (computeDojoStatus), não coluna: filtra em JS após
    // computar, para bater exatamente com o que a listagem exibe.
    if (status) {
      dojos = dojos.filter(d => d.status === status);
    }

    res.json({ total: dojos.length, dojos });
  } catch (err) {
    console.error('[karateDojos] export error:', err.message);
    res.status(500).json({ error: 'Erro ao exportar dojôs' });
  }
});

// ── POST /federation/:id/dojos ──────────────────────────────
router.post('/', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const {
    name, cnpj, sensei_cpf, region, affiliation_model, affiliation_since,
    dojo_founded_year, address, phone, email,
    address_street, address_number, address_complement,
    address_neighborhood, address_city, address_state, address_zip,
  } = req.body;

  // Novos campos opcionais (migration 193)
  const senseiName           = strOrNull(req.body.sensei_name);          // undefined se ausente
  const senseiPractitionerId = uuidOrNull(req.body.sensei_practitioner_id); // undefined se ausente

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'Campo name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!affiliation_model || !['annual', 'biannual', 'quarterly'].includes(affiliation_model)) {
    return res.status(422).json({
      error: 'affiliation_model deve ser annual, biannual ou quarterly',
      code: 'VALIDATION_ERROR',
    });
  }

  // karate_annuity_plan (Migration 226) — OPCIONAL no cadastro. Ausente/''/null
  // fica NULL (indefinido; a federação decide depois, no preview da campanha
  // ou editando o dojô). NÃO confundir com affiliation_model acima — ver
  // comentário da Migration 226 sobre por que são campos diferentes.
  const rawAnnuityPlan = req.body.karate_annuity_plan;
  const karateAnnuityPlan = rawAnnuityPlan === undefined || rawAnnuityPlan === null || String(rawAnnuityPlan).trim() === ''
    ? null
    : String(rawAnnuityPlan).trim();
  if (karateAnnuityPlan !== null && !KARATE_ANNUITY_PLAN_VALUES.includes(karateAnnuityPlan)) {
    return res.status(422).json({
      error: `karate_annuity_plan inválido. Valores aceitos: ${KARATE_ANNUITY_PLAN_VALUES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica que a federação existe
    const fedRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    // companies.owner_id é NOT NULL. Dojô NÃO pode pertencer ao admin da federação
    // (faz o login do admin cair em "visão consolidada" por ter >1 empresa). Reusa
    // o dono de um dojô já existente da federação (usuário de sistema); senão
    // acha/cria um usuário de sistema dedicado com login travado.
    let systemOwnerId = null;
    const ownerRes = await client.query(
      `SELECT owner_id FROM companies
       WHERE federation_id = $1 AND vertical = 'karate_dojo' AND owner_id IS NOT NULL
       LIMIT 1`,
      [federationId]
    );
    if (ownerRes.rows.length) {
      systemOwnerId = ownerRes.rows[0].owner_id;
    } else {
      const sysEmail = `sistema-dojos-${federationId}@getaura.com.br`;
      const u = await client.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [sysEmail]);
      if (u.rows.length) {
        systemOwnerId = u.rows[0].id;
      } else {
        const c = await client.query(
          `INSERT INTO users (email, password_hash, full_name)
           VALUES ($1, '!locked-system-no-login', 'Sistema Dojôs')
           RETURNING id`,
          [sysEmail]
        );
        systemOwnerId = c.rows[0].id;
      }
    }

    // Gera FPKT-NNN dentro da transação (com advisory lock)
    const fpktId = await nextDojoAffiliationId(client, federationId);

    // companies exige legal_name + owner_id (NOT NULL). legal_name = name.
    // Bairro vai na coluna address_district (companies não tem address_neighborhood).
    const insertRes = await client.query(
      `INSERT INTO companies
         (name, legal_name, cnpj, sensei_cpf, sensei_name, sensei_practitioner_id,
          region, fpkt_affiliation_id, affiliation_model,
          affiliation_since, dojo_founded_year, address, phone, email,
          address_street, address_number, address_complement, address_district,
          address_city, address_state, address_zip,
          federation_id, owner_id, vertical, is_active, created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20,
               $21, $22, 'karate_dojo', true, NOW(), NOW())
       RETURNING id, name, cnpj, sensei_cpf, sensei_name, sensei_practitioner_id,
                 region, fpkt_affiliation_id, affiliation_model,
                 affiliation_since, dojo_founded_year, address,
                 address_street, address_number, address_complement,
                 address_district AS address_neighborhood,
                 address_city, address_state, address_zip,
                 phone, email, is_active`,
      [
        String(name).trim(),
        cnpj || null,
        sensei_cpf || null,
        senseiName !== undefined ? senseiName : null,
        senseiPractitionerId !== undefined ? senseiPractitionerId : null,
        region || null,
        fpktId,
        affiliation_model,
        affiliation_since || null,
        dojo_founded_year || null,
        address || null,
        phone || null,
        email || null,
        address_street || null,
        address_number || null,
        address_complement || null,
        address_neighborhood || null,
        address_city || null,
        address_state ? String(address_state).toUpperCase().slice(0, 2) : null,
        address_zip || null,
        federationId,
        systemOwnerId,
      ]
    );

    // karate_annuity_plan é gravado à parte (UPDATE pontual) para não
    // renumerar os $N do INSERT posicional acima — mesma transação, então
    // se o dojô falhar em algum passo seguinte, o UPDATE também é revertido.
    // Defensivo (armadilha_schema_pre_migration): 42703 não derruba o
    // cadastro do dojô — só o plano fica sem ser salvo desta vez.
    let savedAnnuityPlan = null;
    if (karateAnnuityPlan !== null && HAS_ANNUITY_PLAN_COL) {
      try {
        await client.query(
          `UPDATE companies SET karate_annuity_plan = $1 WHERE id = $2`,
          [karateAnnuityPlan, insertRes.rows[0].id]
        );
        savedAnnuityPlan = karateAnnuityPlan;
      } catch (e) {
        if (e.code === '42703') {
          HAS_ANNUITY_PLAN_COL = false;
          console.warn('[karateDojos] karate_annuity_plan ausente no create (Migration 226 pendente) — ignorado');
        } else throw e;
      }
    }

    await client.query('COMMIT');

    const dojo = insertRes.rows[0];
    res.status(201).json({
      id: dojo.id,
      name: dojo.name,
      cnpj: dojo.cnpj || null,
      sensei_cpf: dojo.sensei_cpf || null,
      sensei_name: dojo.sensei_name || null,
      sensei_practitioner_id: dojo.sensei_practitioner_id || null,
      region: dojo.region || null,
      fpkt_affiliation_id: dojo.fpkt_affiliation_id,
      affiliation_model: dojo.affiliation_model,
      affiliation_since: dojo.affiliation_since || null,
      dojo_founded_year: dojo.dojo_founded_year || null,
      ...addressOut(dojo),
      phone: dojo.phone || null,
      email: dojo.email || null,
      is_active: dojo.is_active !== false,
      status: computeDojoStatus(dojo.affiliation_model, dojo.affiliation_since, dojo.is_active),
      practitioner_count: 0,
      karate_annuity_plan: savedAnnuityPlan,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateDojos] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar dojô', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /federation/:id/dojos/:dojoId ──────────────────────
router.get('/:dojoId', ...guards.dojoScope(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  try {
    // LEFT JOIN com customers para trazer o nome atual do praticante vinculado como sensei.
    // O alias spr é "sensei practitioner row".
    // karate_annuity_plan (Migration 226) buscado defensivamente — cai
    // para a query sem a coluna em 42703 (deploy antes da migration).
    let dojoRes;
    if (HAS_ANNUITY_PLAN_COL) {
      try {
        dojoRes = await db.query(
          `SELECT c.id, c.name, c.cnpj, c.sensei_cpf,
                  c.sensei_name, c.sensei_practitioner_id,
                  spr.name AS sensei_practitioner_name,
                  c.region, c.fpkt_affiliation_id,
                  c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
                  ${ADDRESS_COLS}, c.phone, c.email, c.is_active, c.karate_logo_url,
                  c.karate_annuity_plan,
                  COUNT(cu.id) AS practitioner_count
           FROM companies c
           LEFT JOIN customers spr ON spr.id = c.sensei_practitioner_id
           LEFT JOIN customers cu  ON cu.dojo_id = c.id
           WHERE c.id = $1 AND c.federation_id = $2 AND c.vertical = 'karate_dojo'
           GROUP BY c.id, spr.name`,
          [dojoId, federationId]
        );
      } catch (e) {
        if (e.code === '42703') {
          HAS_ANNUITY_PLAN_COL = false;
          console.warn('[karateDojos] karate_annuity_plan ausente (Migration 226 pendente) — fallback sem coluna');
        } else throw e;
      }
    }
    if (dojoRes === undefined) {
      dojoRes = await db.query(
        `SELECT c.id, c.name, c.cnpj, c.sensei_cpf,
                c.sensei_name, c.sensei_practitioner_id,
                spr.name AS sensei_practitioner_name,
                c.region, c.fpkt_affiliation_id,
                c.affiliation_model, c.affiliation_since, c.dojo_founded_year,
                ${ADDRESS_COLS}, c.phone, c.email, c.is_active, c.karate_logo_url,
                COUNT(cu.id) AS practitioner_count
         FROM companies c
         LEFT JOIN customers spr ON spr.id = c.sensei_practitioner_id
         LEFT JOIN customers cu  ON cu.dojo_id = c.id
         WHERE c.id = $1 AND c.federation_id = $2 AND c.vertical = 'karate_dojo'
         GROUP BY c.id, spr.name`,
        [dojoId, federationId]
      );
    }

    if (!dojoRes.rows.length) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }

    const d = dojoRes.rows[0];

    // Time técnico: praticantes com função
    // Migration 206 — is_assistant incluído defensivamente (cache
    // module-level otimista: vira false em 42703 e a query cai para a forma
    // sem esta coluna, mesmo padrão de karatePractitioners.js).
    //
    // Inclui também o sensei responsável (c.sensei_practitioner_id) via OR no
    // WHERE, mesmo que ele não tenha nenhuma das flags is_arbiter/is_instructor/
    // is_examiner/is_assistant — o papel 'sensei' é adicionado em JS logo abaixo.
    // $3 é sensei_practitioner_id (pode ser null; comparação com null nunca
    // casa, então é seguro passar sempre).
    let teamRes;
    if (HAS_IS_ASSISTANT_COL) {
      try {
        teamRes = await db.query(
          `SELECT cu.id AS practitioner_id, cu.name AS name,
                  cb.belt_level, cb.belt_name,
                  cu.is_arbiter, cu.is_instructor, cu.is_examiner, cu.is_assistant
           FROM customers cu
           LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $1
           WHERE cu.dojo_id = $2
             AND (cu.is_arbiter = true OR cu.is_instructor = true OR cu.is_examiner = true
                  OR cu.is_assistant = true OR cu.id = $3)`,
          [federationId, dojoId, d.sensei_practitioner_id || null]
        );
      } catch (e) {
        if (e.code === '42703') {
          HAS_IS_ASSISTANT_COL = false;
          console.warn('[karateDojos] is_assistant ausente na query de time técnico (migration 206 pendente)');
        } else throw e;
      }
    }
    if (teamRes === undefined) {
      teamRes = await db.query(
        `SELECT cu.id AS practitioner_id, cu.name AS name,
                cb.belt_level, cb.belt_name,
                cu.is_arbiter, cu.is_instructor, cu.is_examiner
         FROM customers cu
         LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $1
         WHERE cu.dojo_id = $2
           AND (cu.is_arbiter = true OR cu.is_instructor = true OR cu.is_examiner = true
                OR cu.id = $3)`,
        [federationId, dojoId, d.sensei_practitioner_id || null]
      );
    }

    const technicalTeam = teamRes.rows.map(r => ({
      practitioner_id: r.practitioner_id,
      name: r.name,
      belt_level: r.belt_level || null,
      roles: [
        ...(r.is_arbiter    ? ['arbiter']    : []),
        ...(r.is_instructor ? ['instructor'] : []),
        ...(r.is_examiner   ? ['examiner']   : []),
        ...(r.is_assistant  ? ['assistant']  : []),
        ...(r.practitioner_id === d.sensei_practitioner_id ? ['sensei'] : []),
      ],
    }));

    // Defensivo: se o sensei_practitioner_id apontar para um praticante fora
    // de qualquer condição acima por algum motivo (ex.: row não retornada),
    // ainda garantimos a presença dele na lista via spr (já carregado no
    // SELECT principal, LEFT JOIN — best-effort, sem query extra).
    if (
      d.sensei_practitioner_id &&
      !technicalTeam.some(m => m.practitioner_id === d.sensei_practitioner_id)
    ) {
      technicalTeam.push({
        practitioner_id: d.sensei_practitioner_id,
        name: d.sensei_practitioner_name || d.sensei_name || null,
        belt_level: null,
        roles: ['sensei'],
      });
    }

    // Histórico de anuidades (tabela karate_dojo_annuity_history — migration 152)
    // Se a tabela não existir ainda, retorna array vazio com degradação graceful
    let annuityHistory = [];
    try {
      const annuityRes = await db.query(
        `SELECT id, reference_period, amount, due_date, paid_at, status, transaction_id
         FROM karate_dojo_annuity_history
         WHERE dojo_id = $1
         ORDER BY reference_period DESC
         LIMIT 20`,
        [dojoId]
      );
      annuityHistory = annuityRes.rows;
    } catch (_) {
      // tabela ainda não aplicada — degradação graceful
    }

    res.json({
      id: d.id,
      name: d.name,
      cnpj: d.cnpj || null,
      sensei_cpf: d.sensei_cpf || null,
      sensei_name: d.sensei_name || null,
      sensei_practitioner_id: d.sensei_practitioner_id || null,
      sensei_practitioner_name: d.sensei_practitioner_name || null,
      region: d.region || null,
      fpkt_affiliation_id: d.fpkt_affiliation_id || null,
      affiliation_model: d.affiliation_model || null,
      affiliation_since: d.affiliation_since || null,
      dojo_founded_year: d.dojo_founded_year || null,
      ...addressOut(d),
      phone: d.phone || null,
      email: d.email || null,
      karate_logo_url: d.karate_logo_url || null,
      is_active: d.is_active !== false,
      status: computeDojoStatus(d.affiliation_model, d.affiliation_since, d.is_active),
      practitioner_count: parseInt(d.practitioner_count, 10) || 0,
      // karate_annuity_plan (Migration 226): plano de anuidade REAL do dojô
      // (anual|semestral|trimestral) — null = federação ainda não definiu.
      // NÃO confundir com affiliation_model acima (decorativo, não usado em billing).
      karate_annuity_plan: d.karate_annuity_plan || null,
      technical_team: technicalTeam,
      annuity_history: annuityHistory,
    });
  } catch (err) {
    console.error('[karateDojos] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dojô' });
  }
});

// ── Cascata de status dojô→praticantes (roster) — 10/07/2026 ────────────
// Escritas em karate_dojo_roster_events/karate_dojo_roster_validation são
// best-effort via SAVEPOINT: se a tabela ainda não existir (42P01, deploy
// parcial — armadilha_schema_pre_migration do CLAUDE.md), fazemos ROLLBACK
// TO SAVEPOINT e seguimos — a cascata em customers (o núcleo) já rodou e
// não pode ser derrubada por essas tabelas auxiliares de auditoria/estado.
async function safeRosterWrite(client, label, fn) {
  await client.query('SAVEPOINT sp_roster_write');
  try {
    await fn();
    await client.query('RELEASE SAVEPOINT sp_roster_write');
  } catch (e) {
    if (e && e.code === '42P01') {
      await client.query('ROLLBACK TO SAVEPOINT sp_roster_write');
      console.warn(`[karateDojos] roster write ignorada (schema pendente): ${label}`);
    } else {
      throw e;
    }
  }
}

// Inativando o dojô: snapshot de TODOS os customers do dojô, registra
// evento 'inactivate_cascade' (affected = só quem estava ativo) e desativa
// esses praticantes.
async function cascadeInactivateDojo(client, { dojoId, federationId, actorId }) {
  const snap = await client.query(
    `SELECT id, is_active FROM customers WHERE dojo_id = $1`,
    [dojoId]
  );
  const affected = snap.rows
    .filter((r) => r.is_active !== false) // COALESCE(is_active, true) === true
    .map((r) => ({ student_id: r.id, was_active: true }));

  await safeRosterWrite(client, 'inactivate_cascade event', () => client.query(
    `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
     VALUES ($1, $2, 'inactivate_cascade', $3::jsonb, $4)`,
    [dojoId, federationId, JSON.stringify(affected), actorId]
  ));

  await client.query(
    `UPDATE customers SET is_active = false, updated_at = NOW()
     WHERE dojo_id = $1 AND COALESCE(is_active, true) = true`,
    [dojoId]
  );

  return { affected_count: affected.length };
}

// Ativando o dojô: restaura SÓ o snapshot do último evento
// 'inactivate_cascade' (evento 'reactivate_restore') e abre validação de
// quadro pendente com token opaco de 30 dias (evento 'validation_requested').
async function cascadeReactivateDojo(client, { dojoId, federationId, actorId }) {
  let restoredCount = 0;
  let lastEventRes = { rows: [] };

  await safeRosterWrite(client, 'find last inactivate_cascade', async () => {
    lastEventRes = await client.query(
      `SELECT affected FROM karate_dojo_roster_events
       WHERE dojo_id = $1 AND event = 'inactivate_cascade'
       ORDER BY created_at DESC LIMIT 1`,
      [dojoId]
    );
  });

  const affected = Array.isArray(lastEventRes.rows[0] && lastEventRes.rows[0].affected)
    ? lastEventRes.rows[0].affected
    : [];

  if (affected.length) {
    // Só os do snapshot — não mexe em praticante que não estava no evento.
    for (const item of affected) {
      if (!item || !item.student_id) continue;
      const wasActive = item.was_active !== false; // default true se ausente
      const r = await client.query(
        `UPDATE customers SET is_active = $1, updated_at = NOW()
         WHERE id = $2 AND dojo_id = $3`,
        [wasActive, item.student_id, dojoId]
      );
      restoredCount += r.rowCount;
    }

    await safeRosterWrite(client, 'reactivate_restore event', () => client.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, 'reactivate_restore', $3::jsonb, $4)`,
      [dojoId, federationId, JSON.stringify(affected), actorId]
    ));
  }

  // Reativação sempre pede confirmação do quadro (mesmo sem snapshot
  // anterior — federação pode querer validar o quadro atual do dojô).
  const token = crypto.randomBytes(24).toString('hex');
  await safeRosterWrite(client, 'validation pending upsert', () => client.query(
    `INSERT INTO karate_dojo_roster_validation
       (dojo_id, federation_id, status, requested_at, validated_at, validated_by,
        token, token_expires_at, updated_at)
     VALUES ($1, $2, 'pending', NOW(), NULL, NULL, $3, NOW() + INTERVAL '30 days', NOW())
     ON CONFLICT (dojo_id) DO UPDATE SET
       federation_id    = EXCLUDED.federation_id,
       status           = 'pending',
       requested_at     = NOW(),
       validated_at     = NULL,
       validated_by     = NULL,
       token            = EXCLUDED.token,
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at       = NOW()`,
    [dojoId, federationId, token]
  ));

  await safeRosterWrite(client, 'validation_requested event', () => client.query(
    `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
     VALUES ($1, $2, 'validation_requested', $3::jsonb, $4)`,
    [dojoId, federationId, JSON.stringify(affected), actorId]
  ));

  return { restored_count: restoredCount };
}

// ── PATCH /federation/:id/dojos/:dojoId ────────────────────
//
// 10/07/2026 — Cascata de status dojô→praticantes + validação de quadro.
// Quando este PATCH ALTERA is_active, roda dentro da MESMA transação da
// atualização de companies:
//   - Inativando (false): snapshot dos customers do dojô, registra evento
//     'inactivate_cascade' (affected = quem estava ativo) e desativa todos
//     os praticantes do dojô.
//   - Ativando (true): restaura (só) o snapshot do último
//     'inactivate_cascade' (evento 'reactivate_restore') e abre validação
//     de quadro pendente (karate_dojo_roster_validation, token opaco de 30
//     dias para o portal público do sensei — evento 'validation_requested').
// As escritas em karate_dojo_roster_events/karate_dojo_roster_validation
// são best-effort (SAVEPOINT + 42P01) — nunca derrubam a cascata de
// customers nem o PATCH em si (deploy parcial / migration pendente).
// Preserva 100% do comportamento anterior do PATCH para os demais campos.
router.patch('/:dojoId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  const fieldMap = {
    name: 'name',
    cnpj: 'cnpj',
    sensei_cpf: 'sensei_cpf',
    region: 'region',
    affiliation_model: 'affiliation_model',
    affiliation_since: 'affiliation_since',
    dojo_founded_year: 'dojo_founded_year',
    address: 'address',
    phone: 'phone',
    email: 'email',
    karate_logo_url: 'karate_logo_url',
    // is_active (DOJO-RM 25/06): suspender/reativar pela UI. Coerção boolean segura.
    is_active: 'is_active',
    // Endereço estruturado (Fix 5) — mesmas colunas da NF-e.
    // bairro (address_neighborhood na API) → coluna real address_district.
    address_street: 'address_street',
    address_number: 'address_number',
    address_complement: 'address_complement',
    address_neighborhood: 'address_district',
    address_city: 'address_city',
    address_state: 'address_state',
    address_zip: 'address_zip',
    // migration 193: nome e vínculo do sensei (tratados manualmente abaixo por
    // precisarem de normalização específica — não entram no fieldMap genérico).
  };

  // Coerção boolean segura: aceita true/'true'/1/'1' como true; false/'false'/0/'0'/''/null como false.
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'sim', 't'].includes(s)) return true;
      if (['false', '0', 'no', 'nao', 'não', 'f', ''].includes(s)) return false;
    }
    return Boolean(v);
  }

  const updates = [];
  const values = [];
  let idx = 1;

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[bodyKey] !== undefined) {
      let v = req.body[bodyKey];
      if (bodyKey === 'address_state' && v) v = String(v).toUpperCase().slice(0, 2);
      else if (bodyKey === 'is_active') v = toBool(v);
      updates.push(`${dbCol} = $${idx}`);
      values.push(v);
      idx++;
      if (bodyKey === 'name') {
        // Sincroniza legal_name = name (legal_name só era setado no POST e ficava defasado).
        updates.push(`legal_name = $${idx}`);
        values.push(v);
        idx++;
      }
    }
  }

  // ── migration 193: sensei_name e sensei_practitioner_id ──
  // Tratados separadamente do fieldMap genérico para aplicar normalização própria.
  if (req.body.sensei_name !== undefined) {
    const v = strOrNull(req.body.sensei_name);
    updates.push(`sensei_name = $${idx}`);
    values.push(v);
    idx++;
  }
  if (req.body.sensei_practitioner_id !== undefined) {
    const v = uuidOrNull(req.body.sensei_practitioner_id);
    updates.push(`sensei_practitioner_id = $${idx}`);
    values.push(v);
    idx++;
  }

  // ── Migration 226: karate_annuity_plan (plano de anuidade DO DOJÔ) ──
  // '' ou null limpa o campo (volta a "indefinido" — decisão deliberada da
  // federação de desfazer a escolha). Qualquer outro valor tem que ser um
  // dos 3 planos válidos — NUNCA aceitamos silenciosamente algo fora disso.
  // Gate em HAS_ANNUITY_PLAN_COL: se a Migration 226 ainda não rodou neste
  // deploy, ignoramos silenciosamente o campo aqui (em vez de 500) — o
  // valor só volta a ser gravável assim que a coluna existir.
  if (req.body.karate_annuity_plan !== undefined && HAS_ANNUITY_PLAN_COL) {
    const raw = req.body.karate_annuity_plan;
    const v = raw === null || String(raw).trim() === '' ? null : String(raw).trim();
    if (v !== null && !KARATE_ANNUITY_PLAN_VALUES.includes(v)) {
      return res.status(422).json({
        error: `karate_annuity_plan inválido. Valores aceitos: ${KARATE_ANNUITY_PLAN_VALUES.join(', ')} (ou null/vazio para limpar)`,
        code: 'VALIDATION_ERROR',
      });
    }
    updates.push(`karate_annuity_plan = $${idx}`);
    values.push(v);
    idx++;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(dojoId, federationId);

  // Cascata só entra em jogo quando is_active vem no body do PATCH.
  const isActiveRequested = req.body.is_active !== undefined;
  const actorId = (req.user && req.user.id) || null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Snapshot do is_active ATUAL (antes do UPDATE) — só quando relevante
    // para a cascata. FOR UPDATE trava a linha p/ evitar corrida entre
    // dois PATCH concorrentes decidindo o antes/depois errado.
    let previousIsActive = null;
    if (isActiveRequested) {
      const prevRes = await client.query(
        `SELECT is_active FROM companies
         WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
         FOR UPDATE`,
        [dojoId, federationId]
      );
      if (!prevRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
      }
      previousIsActive = prevRes.rows[0].is_active !== false; // COALESCE(is_active, true)
    }

    const returningCols = `id, name, cnpj, sensei_cpf, sensei_name, sensei_practitioner_id,
                 region, fpkt_affiliation_id, affiliation_model,
                 affiliation_since, dojo_founded_year, address,
                 address_street, address_number, address_complement,
                 address_district AS address_neighborhood,
                 address_city, address_state, address_zip,
                 phone, email, is_active${HAS_ANNUITY_PLAN_COL ? ', karate_annuity_plan' : ''}`;

    let result;
    try {
      result = await client.query(
        `UPDATE companies
         SET ${updates.join(', ')}
         WHERE id = $${idx} AND federation_id = $${idx + 1} AND vertical = 'karate_dojo'
         RETURNING ${returningCols}`,
        values
      );
    } catch (e) {
      // Defensivo (armadilha_schema_pre_migration do CLAUDE.md): deploy subiu
      // antes da Migration 226. Só socorre o caso karate_annuity_plan — outras
      // colunas ausentes continuam sendo erro real (rethrow).
      if (e.code === '42703' && /karate_annuity_plan/.test(e.message || '')) {
        HAS_ANNUITY_PLAN_COL = false;
        await client.query('ROLLBACK');
        return res.status(503).json({
          error: 'Campo karate_annuity_plan ainda não disponível neste ambiente — tente novamente em instantes.',
          code: 'MIGRATION_PENDING',
        });
      }
      throw e;
    }

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }

    const d = result.rows[0];
    const newIsActive = d.is_active !== false;

    let rosterCascade = null;
    if (isActiveRequested && previousIsActive !== newIsActive) {
      if (newIsActive === false) {
        rosterCascade = await cascadeInactivateDojo(client, { dojoId, federationId, actorId });
        rosterCascade.action = 'inactivate_cascade';
      } else {
        rosterCascade = await cascadeReactivateDojo(client, { dojoId, federationId, actorId });
        rosterCascade.action = 'reactivate_restore';
      }
    }

    await client.query('COMMIT');

    res.json({
      id: d.id,
      name: d.name,
      cnpj: d.cnpj || null,
      sensei_cpf: d.sensei_cpf || null,
      sensei_name: d.sensei_name || null,
      sensei_practitioner_id: d.sensei_practitioner_id || null,
      region: d.region || null,
      fpkt_affiliation_id: d.fpkt_affiliation_id || null,
      affiliation_model: d.affiliation_model || null,
      affiliation_since: d.affiliation_since || null,
      dojo_founded_year: d.dojo_founded_year || null,
      ...addressOut(d),
      phone: d.phone || null,
      email: d.email || null,
      is_active: d.is_active !== false,
      status: computeDojoStatus(d.affiliation_model, d.affiliation_since, d.is_active),
      practitioner_count: 0, // não recomputado no PATCH por performance
      karate_annuity_plan: d.karate_annuity_plan || null,
      ...(rosterCascade ? { roster_cascade: rosterCascade } : {}),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateDojos] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar dojô' });
  } finally {
    client.release();
  }
});

// ── DELETE /federation/:id/dojos/:dojoId ───────────────────
//
// 25/06/2026 — DOJO-RM: a federação tem liberdade total de gerenciar dados.
// Decisão de produto (Caio): oferecer DOIS caminhos para excluir um dojô com
// histórico vinculado — desativar (soft, via PATCH is_active=false) OU excluir
// definitivamente (hard, em cascata). Este endpoint suporta ambos:
//
//   - Sem dependentes              → hard delete direto da linha de companies → 200 { deleted:true }
//   - Com dependentes e SEM cascade → 409 { code:'HAS_HISTORY', counts } (nada é apagado;
//     o FE oferece "Desativar" vs "Excluir definitivamente")
//   - Com dependentes e ?cascade=true → hard delete em CASCATA, em transação,
//     na ordem correta de FK → 200 { deleted:true, cascade:true, counts }
//
// Notas de schema (verificadas via information_schema):
//   - customers.dojo_id → ON DELETE SET NULL (NÃO cascata; orfanaria praticantes).
//     Os praticantes do dojô têm company_id = FEDERAÇÃO (não o dojô), então o
//     cascade de companies NÃO os apaga. Por isso, na cascata, apagamos
//     explicitamente os customers do dojô (e seus filhos caem por CASCADE:
//     karate_belt_history, transfers via practitioner_id, attendance, etc.).
//   - karate_practitioner_transfers.destination_dojo_id → ON DELETE RESTRICT
//     (BLOQUEIA o delete da company). Apagamos as transfers do dojô antes.
//   - karate_dojo_annuity_history.dojo_id e karate_dojo_connections.dojo_id →
//     ON DELETE CASCADE (caem sozinhos), mas as transactions de anuidade têm
//     federation_id=federação (SET NULL) e company_id=federação — NÃO são do
//     dojô — portanto NÃO são apagadas. Cancelamos as transactions de anuidade
//     do dojô (preserva trilha financeira) antes de apagar o annuity_history.
//   - karate_payment_intents.annuity_history_id → SET NULL (não bloqueia).
//   - companies.sensei_practitioner_id → ON DELETE SET NULL (migration 193,
//     não bloqueia a exclusão do dojô).
//   - karate_dojo_roster_events / karate_dojo_roster_validation (tabelas do
//     roster, 10/07/2026) NÃO têm FK pra companies — não bloqueiam o delete,
//     mas ficam órfãs se não forem apagadas explicitamente. Apagadas via
//     safeRosterWrite() (best-effort, 42P01) antes do DELETE FROM companies.
router.delete('/:dojoId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const cascade = String(req.query.cascade || '').toLowerCase() === 'true';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Confere existência + escopo (federação + vertical).
    const found = await client.query(
      `SELECT id, name FROM companies
       WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
      [dojoId, federationId]
    );
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }

    // Conta dependentes (histórico vinculado).
    const cntRes = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE dojo_id = $1)::int AS practitioners,
         (SELECT COUNT(*) FROM karate_dojo_annuity_history WHERE dojo_id = $1)::int AS annuities,
         (SELECT COUNT(*) FROM transactions
            WHERE reference_type = 'karate_dojo' AND reference_id = $1)::int AS transactions,
         (SELECT COUNT(*) FROM karate_belt_history bh
            JOIN customers cu ON cu.id = bh.student_id
            WHERE cu.dojo_id = $1)::int AS belt_history,
         (SELECT COUNT(*) FROM karate_practitioner_transfers
            WHERE origin_dojo_id = $1 OR destination_dojo_id = $1)::int AS transfers,
         (SELECT COUNT(*) FROM karate_dojo_connections WHERE dojo_id = $1)::int AS connections`,
      [dojoId]
    );
    const counts = cntRes.rows[0] || {};
    const totalDeps =
      (counts.practitioners || 0) + (counts.annuities || 0) + (counts.transactions || 0) +
      (counts.belt_history || 0) + (counts.transfers || 0) + (counts.connections || 0);

    // ── Caminho 1: sem dependentes → hard delete direto ──
    if (totalDeps === 0) {
      const del = await client.query(
        `DELETE FROM companies
         WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
         RETURNING id, name`,
        [dojoId, federationId]
      );
      await client.query('COMMIT');
      return res.json({ deleted: true, cascade: false, id: dojoId, name: del.rows[0]?.name, counts });
    }

    // ── Caminho 2: com dependentes e SEM ?cascade=true → 409 HAS_HISTORY ──
    if (!cascade) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Este dojô tem histórico vinculado (praticantes, anuidades, transferências, graduações). ' +
               'Use Desativar para mantê-lo no histórico, ou Excluir definitivamente (cascade) para apagar tudo.',
        code: 'HAS_HISTORY',
        counts,
      });
    }

    // ── Caminho 3: cascata (ordem de FK — filhos antes do pai) ──

    // karate_practitioner_transfers é append-only/imutável (trigger BEFORE
    // UPDATE/DELETE em karate_practitioner_transfers_immutable(), migration 180).
    // Isso impede edição casual de histórico — mas bloqueia também a exclusão
    // definitiva em cascata do dojô: destination_dojo_id é FK RESTRICT (linha 1
    // abaixo) e a exclusão de customers logo adiante (passo 5) dispara o
    // mesmo trigger indiretamente via CASCADE de practitioner_id. A exclusão
    // deliberada em cascata (?cascade=true, com 409 HAS_HISTORY já confirmado
    // pelo caller) É a "correção excepcional" prevista no comentário do
    // trigger. Migration 221 adicionou um escape hatch escopado por GUC:
    // SET LOCAL expira sozinho no COMMIT/ROLLBACK desta transação — não
    // afeta nenhuma outra rota ou sessão (NÃO usar SET global aqui).
    await client.query("SET LOCAL app.allow_transfer_purge = 'on'");

    // 1) Transferências do dojô (origin OU destination). destination_dojo_id é
    //    RESTRICT → tem de sair antes de apagar a company. (origin é SET NULL,
    //    mas apagamos tudo para não deixar registros órfãos pela metade.)
    await client.query(
      `DELETE FROM karate_practitioner_transfers
       WHERE origin_dojo_id = $1 OR destination_dojo_id = $1`,
      [dojoId]
    );

    // 2) Conexões do dojô (CASCADE pela company, mas explícito por clareza).
    await client.query(`DELETE FROM karate_dojo_connections WHERE dojo_id = $1`, [dojoId]);

    // 3) Transactions de anuidade do dojô: NÃO apagar — cancelar (preserva trilha
    //    financeira). São identificadas por reference_type/reference_id (company_id
    //    e federation_id apontam para a federação, não para o dojô).
    await client.query(
      `UPDATE transactions
       SET status = 'cancelled', updated_at = NOW()
       WHERE reference_type = 'karate_dojo' AND reference_id = $1 AND status <> 'cancelled'`,
      [dojoId]
    );

    // 4) Histórico de anuidades do dojô (CASCADE pela company, mas explícito;
    //    karate_payment_intents.annuity_history_id é SET NULL → não bloqueia).
    await client.query(`DELETE FROM karate_dojo_annuity_history WHERE dojo_id = $1`, [dojoId]);

    // 5) Praticantes do dojô. company_id deles = federação (não cai pelo cascade
    //    da company do dojô), e dojo_id é SET NULL → precisamos apagar explicito.
    //    Filhos do customer (karate_belt_history, attendance, certificates,
    //    competition_entries, event_enrollments, transfers via practitioner_id,
    //    credit/dental/etc.) caem por CASCADE definido no schema.
    await client.query(`DELETE FROM customers WHERE dojo_id = $1`, [dojoId]);

    // 5b) Tabelas novas do roster (karate_dojo_roster_events/-validation,
    //     escritas por cascadeInactivateDojo/cascadeReactivateDojo no PATCH).
    //     NÃO têm FK pra companies, então não bloqueiam a exclusão — mas sem
    //     esse DELETE explícito ficam órfãs (dojo_id apontando pra uma
    //     company que não existe mais). safeRosterWrite() é o mesmo helper
    //     best-effort (SAVEPOINT + 42P01) já usado no cascade do PATCH: se as
    //     tabelas ainda não existirem (deploy parcial), ignora e segue — a
    //     cascata principal (o núcleo, acima) não pode ser derrubada por
    //     tabelas auxiliares de auditoria/estado.
    await safeRosterWrite(client, 'delete karate_dojo_roster_events', () => client.query(
      `DELETE FROM karate_dojo_roster_events WHERE dojo_id = $1`, [dojoId]
    ));
    await safeRosterWrite(client, 'delete karate_dojo_roster_validation', () => client.query(
      `DELETE FROM karate_dojo_roster_validation WHERE dojo_id = $1`, [dojoId]
    ));

    // 6) Por fim, a linha de companies (o dojô).
    const del = await client.query(
      `DELETE FROM companies
       WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
       RETURNING id, name`,
      [dojoId, federationId]
    );

    await client.query('COMMIT');
    return res.json({
      deleted: true,
      cascade: true,
      id: dojoId,
      name: del.rows[0]?.name,
      counts,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    // FK inesperada (23503) → orienta desativar em vez de quebrar.
    if (err && err.code === '23503') {
      return res.status(409).json({
        error: 'Este dojô possui registros vinculados que impedem a exclusão. Use Desativar.',
        code: 'HAS_HISTORY',
      });
    }
    console.error('[karateDojos] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao remover dojô', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
