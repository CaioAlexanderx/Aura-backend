// ============================================================
// AURA KARATÊ — Export de dados do Dojô (Track A, round-trip do import)
// GET /federation/:id/dojos/:dojoId/export-data
//
// Espelha o que o import (POST .../practitioners/import/batch-fpkt) LÊ:
//   abas Academias + Alunos + Histórico (a montagem do .xlsx é no front).
// Aqui devolvemos o JSON cru já com os campos que preenchem as colunas do
// import, para o dojô editar e reimportar (upsert por Número FPKT).
//
// Query params:
//   status           all | active | inactive   (default all) — filtra praticantes
//   include_belts    bool (default true)  — trajetória de faixas
//   include_transfers bool (default true) — transferências
//   belt             opcional — filtra praticantes pela faixa atual (belt_level)
//
// Eficiente: 1 query dojô, 1 praticantes, 1 faixa atual, 1 trajetória, 1 transf.
// guards.read (mesmo nível do GET dojo).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { computeDojoStatus } = require('../services/karateService');

const isTrue = (v, def) => {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'sim';
};

// GET /federation/:id/dojos/:dojoId/export-data
// guards.read() (não dojoScope): dump cadastral completo (CPF, RG, nascimento,
// endereço de todos os praticantes) é visão de GESTÃO da federação. Sob
// dojoScope, um papel de dojô exportava a base de QUALQUER dojô — IDOR de PII
// em massa. O dojô exporta os próprios dados pela superfície /dojo/*.
router.get('/:dojoId/export-data', ...guards.read(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const status = ['all', 'active', 'inactive'].includes(String(req.query.status))
    ? String(req.query.status) : 'all';
  const includeBelts = isTrue(req.query.include_belts, true);
  const includeTransfers = isTrue(req.query.include_transfers, true);
  const beltFilter = req.query.belt ? String(req.query.belt).trim() : null;

  try {
    // ── Dojô (Academia) ──
    const dojoRes = await db.query(
      `SELECT c.id, c.name, c.fpkt_affiliation_id, c.cnpj, c.region,
              c.affiliation_model, c.affiliation_since, c.is_active,
              c.address, c.address_street, c.address_number, c.address_complement,
              c.address_district AS address_neighborhood, c.address_city,
              c.address_state, c.address_zip, c.phone, c.email
       FROM companies c
       WHERE c.id = $1 AND c.federation_id = $2 AND c.vertical = 'karate_dojo'
       LIMIT 1`,
      [dojoId, federationId]
    );
    if (!dojoRes.rows.length) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const d = dojoRes.rows[0];
    const dojoStatus = computeDojoStatus(d.affiliation_model, d.affiliation_since, d.is_active);

    // ── Praticantes (Alunos) deste dojô + faixa atual ──
    const conds = [`cu.dojo_id = $1`, `cu.federation_id = $2`];
    const params = [dojoId, federationId];
    let n = 3;
    if (status === 'active') conds.push(`cu.is_active = true`);
    else if (status === 'inactive') conds.push(`cu.is_active = false`);
    if (beltFilter) {
      conds.push(`cb.belt_level = $${n}`);
      params.push(beltFilter);
      n++;
    }

    const pracRes = await db.query(
      `SELECT cu.id, cu.name, cu.karate_registration_number, cu.cpf_cnpj, cu.rg,
              cu.birth_date, cu.email, cu.phone, cu.is_active,
              cu.street, cu.number, cu.neighborhood, cu.city, cu.state, cu.zip_code,
              cb.belt_level, cb.belt_name
       FROM customers cu
       LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $2
       WHERE ${conds.join(' AND ')}
       ORDER BY cu.name ASC`,
      params
    );

    const isoDate = (v) => {
      if (!v) return null;
      try { return new Date(v).toISOString().slice(0, 10); } catch (_) { return null; }
    };

    const praticantes = pracRes.rows.map((r) => ({
      id: r.id,
      // 'cod' = a chave que a aba Histórico referencia. Usamos o Número FPKT
      // como Cód. Aluno também → round-trip resolve histórico por essa coluna.
      cod_aluno: r.karate_registration_number || null,
      numero_fpkt: r.karate_registration_number || null,
      nome: r.name || null,
      nascimento: isoDate(r.birth_date),
      cpf: r.cpf_cnpj || null,
      rg: r.rg || null,
      email: r.email || null,
      telefone: r.phone || null,
      logradouro: r.street || null,
      numero: r.number || null,
      bairro: r.neighborhood || null,
      cidade: r.city || null,
      estado: r.state || null,
      cep: r.zip_code || null,
      situacao: r.is_active ? 'Ativo' : 'Inativo',
      faixa_atual: r.belt_name || r.belt_level || null,
      faixa_level: r.belt_level || null,
      academia_name: d.name || null,
    }));

    const dojo = {
      id: d.id,
      cod: d.fpkt_affiliation_id || null,
      name: d.name || null,
      fpkt_affiliation_id: d.fpkt_affiliation_id || null,
      status: dojoStatus,
      is_active: d.is_active,
      cnpj: d.cnpj || null,
      region: d.region || null,
      // Endereço: campo livre legado + estruturado (preenche a coluna Endereço)
      address: d.address || null,
      address_street: d.address_street || null,
      address_number: d.address_number || null,
      address_neighborhood: d.address_neighborhood || null,
      address_city: d.address_city || null,
      address_state: d.address_state || null,
      address_zip: d.address_zip || null,
      phone: d.phone || null,
      email: d.email || null,
    };

    // ── Faixas (Histórico: trajetória) ──
    let belt_events = [];
    if (includeBelts && praticantes.length) {
      const regs = praticantes.map((p) => p.numero_fpkt).filter(Boolean);
      if (regs.length) {
        const bh = await db.query(
          `SELECT cu.karate_registration_number AS reg, cu.name AS practitioner_name,
                  bh.belt_level, bh.belt_name, bh.graduated_at
           FROM karate_belt_history bh
           JOIN customers cu ON cu.id = bh.student_id
           WHERE bh.federation_id = $1
             AND cu.karate_registration_number = ANY($2::text[])
           ORDER BY cu.name ASC, bh.graduated_at ASC`,
          [federationId, regs]
        );
        belt_events = bh.rows.map((r) => ({
          practitioner_ref: r.reg,
          practitioner_name: r.practitioner_name || null,
          faixa: r.belt_name || r.belt_level || null,
          belt_level: r.belt_level || null,
          data: isoDate(r.graduated_at),
        }));
      }
    }

    // ── Transferências (Histórico) ──
    let transfers = [];
    if (includeTransfers && praticantes.length) {
      const regs = praticantes.map((p) => p.numero_fpkt).filter(Boolean);
      if (regs.length) {
        // Só exporta transferências ATIVAS (as anuladas somem do relatório).
        const transfersSql = (withVoidFilter) => `
          SELECT cu.karate_registration_number AS reg, cu.name AS practitioner_name,
                 t.origin_dojo_name, t.destination_dojo_name, t.transferred_at
           FROM karate_practitioner_transfers t
           JOIN customers cu ON cu.id = t.practitioner_id
           WHERE t.federation_id = $1
             AND cu.karate_registration_number = ANY($2::text[])
             ${withVoidFilter ? 'AND t.voided_at IS NULL' : ''}
           ORDER BY cu.name ASC, t.transferred_at ASC`;
        let tr;
        try {
          tr = await db.query(transfersSql(true), [federationId, regs]);
        } catch (e) {
          // Coluna voided_at ausente (deploy antes da migration 293): re-tenta
          // sem o filtro para não derrubar o export inteiro.
          if (e.code === '42703') tr = await db.query(transfersSql(false), [federationId, regs]);
          else throw e;
        }
        transfers = tr.rows.map((r) => ({
          practitioner_ref: r.reg,
          practitioner_name: r.practitioner_name || null,
          origem: r.origin_dojo_name || null,
          destino: r.destination_dojo_name || null,
          data: isoDate(r.transferred_at),
        }));
      }
    }

    res.json({
      federation_id: federationId,
      generated_at: new Date().toISOString(),
      filters: { status, include_belts: includeBelts, include_transfers: includeTransfers, belt: beltFilter },
      dojo,
      praticantes,
      belt_events,
      transfers,
    });
  } catch (err) {
    console.error('[karateExportDojo] export error:', err.message);
    res.status(500).json({ error: 'Erro ao exportar dados do dojô', detail: err.message });
  }
});

module.exports = router;
