// ============================================================
// AURA. — Fase 1: cadastro de fornecedores (migration 342, 16/09/2026)
//
// Contexto: um cliente de trial trocou a Aura por concorrente citando
// "cadastro de fornecedores" -- o unico recurso que pediu e que o
// varejo realmente nao tem (so existe no Studio, como insumo, tabela
// separada -- studio_inputs).
//
// Plano: todas (modulo estoque.fornecedores e Essencial -- src/services/
// modules.js). Sem requirePlan no mount (src/routes/private.js).
//
// Visibilidade: mesma regra de GRUPO ECONOMICO (billing group) de
// products.js, mas SEM a flag is_group_shared por linha -- fornecedor e
// dado de retaguarda, visivel pra qualquer empresa do mesmo grupo sem
// opt-in por registro (ver migrations/342_fornecedores.sql, decisao b,
// e src/utils/companyGroup.js). Escrita (POST/PATCH/DELETE) usa a MESMA
// visibilidade da leitura (CLAUDE.md armadilha 7).
//
// DELETE: soft (is_active=false) se o fornecedor tem produto vinculado
// (supplier_id), hard-delete se nao tem nenhum -- decisao documentada
// no corpo do PR.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { onlyDigits, isValidCnpj } = require('../utils/cnpj');
const { companyGroupWhere } = require('../utils/companyGroup');

function limpar(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// ─── Tela de Fornecedores do app (25/09/2026) ────────────────
//
// O app nao tinha tela nenhuma de fornecedor; a GF Amorim (materiais de
// construcao, 2.019 produtos) tinha zero fornecedores. Duas rotas novas
// para o cadastro ser rapido:
//   GET  /cnpj/:cnpj        -> preenche nome/telefone/e-mail pela Receita
//   POST /:sid/products     -> vincula (ou desvincula) produtos em lote
//
// A consulta publica do onboarding (POST /onboarding/cnpj-lookup) limita
// 10/hora por IP -- pouco pra quem cadastra a lista de fornecedores de uma
// vez. Aqui o limite e por empresa e mais folgado.
let lookupCNPJ = null;
try { ({ lookupCNPJ } = require('../services/cnpj')); } catch (_) { /* sem o servico, a rota responde 503 */ }
let redis = null;
try { redis = require('../config/redis').default || require('../config/redis'); } catch (_) { /* sem cache */ }

const CNPJ_LOOKUP_POR_HORA = 60;
const consultasPorEmpresa = new Map(); // company_id -> { hora, n }

function dentroDoLimite(cid) {
  const hora = Math.floor(Date.now() / 3600000);
  const atual = consultasPorEmpresa.get(cid);
  if (!atual || atual.hora !== hora) {
    consultasPorEmpresa.set(cid, { hora, n: 1 });
    return true;
  }
  atual.n += 1;
  return atual.n <= CNPJ_LOOKUP_POR_HORA;
}

// ─── GET /cnpj/:cnpj — dados da Receita + "ja cadastrado?" ──
// Precisa ficar ANTES do GET /:sid, senao "cnpj" vira um :sid.
router.get('/cnpj/:cnpj', async (req, res) => {
  const cid = req.params.id;
  const digits = onlyDigits(req.params.cnpj);
  if (!isValidCnpj(digits)) return res.status(400).json({ error: 'CNPJ invalido' });

  try {
    // "Ja cadastrado" vem primeiro e nao gasta consulta na Receita.
    const { rows: dup } = await db.query(
      `SELECT id, name FROM suppliers WHERE cnpj = $1 AND ${companyGroupWhere('$2')} LIMIT 1`,
      [digits, cid]
    );
    if (dup.length) return res.json({ cnpj: digits, existing: dup[0] });

    if (!lookupCNPJ) return res.status(503).json({ error: 'Consulta de CNPJ indisponivel. Preencha os dados a mao.' });
    if (!dentroDoLimite(cid)) {
      return res.status(429).json({ error: 'Muitas consultas de CNPJ nesta hora. Preencha os dados a mao ou tente mais tarde.' });
    }

    const rf = await lookupCNPJ(digits, redis);
    res.json({
      cnpj: digits,
      existing: null,
      // Nome de uso no dia a dia: fantasia quando existe, senao a razao social.
      name: rf.trade_name || rf.legal_name || '',
      legal_name: rf.legal_name || '',
      trade_name: rf.trade_name || '',
      phone: rf.phone || '',
      email: rf.email || '',
      city: rf.address_city || '',
      state: rf.address_state || '',
      is_active: rf.is_active !== false,
      situation: rf.rf_situation || '',
    });
  } catch (err) {
    const msg = err && err.message ? err.message : '';
    if (msg.includes('não encontrado')) return res.status(404).json({ error: 'CNPJ nao encontrado na Receita Federal' });
    if (msg.includes('Limite')) return res.status(429).json({ error: 'A Receita esta limitando as consultas agora. Preencha os dados a mao ou tente em alguns minutos.' });
    console.error('[suppliers] cnpj lookup error:', msg);
    res.status(502).json({ error: 'Nao consegui consultar a Receita agora. Preencha os dados a mao.' });
  }
});

// ─── POST /:sid/products — vincular produtos em lote ────────
// Body: { product_ids: [...], unlink?: boolean }
// Mesma visibilidade de produto de products.js (proprio OU compartilhado
// no grupo) -- escrita espelha a leitura (CLAUDE.md armadilha 7). As
// colunas soltas supplier_name/supplier_cnpj acompanham, como no POST de
// produto, pra quem ainda le as duas.
const MAX_VINCULO_LOTE = 1000;

router.post('/:sid/products', async (req, res) => {
  const cid = req.params.id;
  const sid = req.params.sid;
  const ids = Array.isArray(req.body && req.body.product_ids) ? req.body.product_ids.map(String) : null;
  const unlink = req.body && req.body.unlink === true;
  if (!ids || !ids.length) return res.status(400).json({ error: 'product_ids e obrigatorio' });
  if (ids.length > MAX_VINCULO_LOTE) return res.status(400).json({ error: `No maximo ${MAX_VINCULO_LOTE} produtos por vez` });

  try {
    const { rows: sup } = await db.query(
      `SELECT id, name, cnpj FROM suppliers s WHERE id = $1 AND ${companyGroupWhere('$2')}`,
      [sid, cid]
    );
    if (!sup.length) return res.status(404).json({ error: 'Fornecedor nao encontrado' });

    const visivel = `(company_id = $2 OR (is_group_shared = true AND ${companyGroupWhere('$2')}))`;
    const upd = unlink
      ? await db.query(
          `UPDATE products SET supplier_id = NULL, supplier_name = NULL, supplier_cnpj = NULL, updated_at = NOW()
            WHERE id = ANY($1::uuid[]) AND ${visivel} AND supplier_id = $3`,
          [ids, cid, sid]
        )
      : await db.query(
          `UPDATE products SET supplier_id = $3, supplier_name = $4, supplier_cnpj = $5, updated_at = NOW()
            WHERE id = ANY($1::uuid[]) AND ${visivel}`,
          [ids, cid, sid, sup[0].name, sup[0].cnpj]
        );
    res.json({ updated: upd.rowCount, unlink });
  } catch (err) {
    if (err.code === '22P02') return res.status(400).json({ error: 'product_ids invalido' });
    console.error('[suppliers] link products error:', err.message);
    res.status(500).json({ error: 'Erro ao vincular produtos' });
  }
});

// ─── GET / — lista (?q=&active=) ─────────────────────────────
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    let where = `WHERE ${companyGroupWhere('$1', 's.')}`;
    const params = [cid];

    if (req.query.active === 'true') where += ' AND s.is_active = true';
    else if (req.query.active === 'false') where += ' AND s.is_active = false';

    const q = req.query.q ? String(req.query.q).trim() : '';
    if (q) {
      const digits = onlyDigits(q);
      params.push(`%${q}%`);
      const nameIdx = params.length;
      if (digits) {
        params.push(`%${digits}%`);
        where += ` AND (s.name ILIKE $${nameIdx} OR s.cnpj ILIKE $${params.length})`;
      } else {
        where += ` AND s.name ILIKE $${nameIdx}`;
      }
    }

    const { rows } = await db.query(
      `SELECT s.id, s.company_id, s.name, s.cnpj, s.contact_name, s.phone, s.email,
              s.notes, s.is_active, s.created_at, s.updated_at,
              COALESCE((
                SELECT COUNT(*)::int FROM products p
                WHERE p.supplier_id = s.id AND p.is_active = true
              ), 0) AS product_count
       FROM suppliers s
       ${where}
       ORDER BY s.name ASC`,
      params
    );

    res.json({ suppliers: rows, total: rows.length });
  } catch (err) {
    console.error('[suppliers] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar fornecedores' });
  }
});

// ─── GET /:sid — detalhe + produtos vinculados + entradas recentes ──
router.get('/:sid', async (req, res) => {
  const cid = req.params.id;
  const sid = req.params.sid;
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, name, cnpj, contact_name, phone, email, notes,
              is_active, created_at, updated_at
       FROM suppliers s WHERE id = $1 AND ${companyGroupWhere('$2')}`,
      [sid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fornecedor nao encontrado' });
    const supplier = rows[0];

    const { rows: produtos } = await db.query(
      `SELECT id, name, sku, barcode, stock_qty, price, cost_price, is_active
       FROM products WHERE supplier_id = $1 ORDER BY name ASC LIMIT 500`,
      [sid]
    );

    const { rows: movimentos } = await db.query(
      `SELECT sm.id, sm.product_id, p.name AS product_name, sm.type, sm.quantity,
              sm.unit_cost, sm.reference_type, sm.reference_id, sm.notes, sm.created_at
       FROM stock_movements sm
       LEFT JOIN products p ON p.id = sm.product_id
       WHERE sm.supplier_id = $1
       ORDER BY sm.created_at DESC
       LIMIT 20`,
      [sid]
    );

    res.json({
      ...supplier,
      product_count: produtos.length,
      products: produtos,
      recent_stock_movements: movimentos,
    });
  } catch (err) {
    console.error('[suppliers] get error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar fornecedor' });
  }
});

// ─── POST / — criar ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const { name, cnpj, contact_name, phone, email, notes } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }

  let cnpjDigits = null;
  if (cnpj !== undefined && cnpj !== null && String(cnpj).trim() !== '') {
    cnpjDigits = onlyDigits(cnpj);
    if (!isValidCnpj(cnpjDigits)) {
      return res.status(400).json({ error: 'CNPJ invalido' });
    }
  }

  try {
    if (cnpjDigits) {
      // Duplicado em QUALQUER empresa do grupo -- evita cadastro repetido
      // quando a matriz ja tem o mesmo fornecedor (a unicidade no banco,
      // migrations/342, e por empresa -- este check e a camada de UX que
      // impede a duplicata visivel dentro do mesmo grupo).
      const { rows: dup } = await db.query(
        `SELECT id FROM suppliers WHERE cnpj = $1 AND ${companyGroupWhere('$2')}`,
        [cnpjDigits, cid]
      );
      if (dup.length) {
        return res.status(409).json({ error: 'Ja existe um fornecedor com esse CNPJ', id: dup[0].id });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO suppliers (company_id, name, cnpj, contact_name, phone, email, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        cid,
        String(name).trim().slice(0, 200),
        cnpjDigits,
        limpar(contact_name, 200),
        limpar(phone, 30),
        limpar(email, 200),
        limpar(notes, 2000),
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // Corrida: dois POSTs simultaneos com o mesmo CNPJ na mesma empresa
      // (o check acima nao e atomico com o INSERT). O indice unico
      // parcial (company_id, cnpj) da migration 342 e quem garante de
      // verdade -- aqui so devolvemos o 409 com o id ja existente.
      try {
        const { rows: existing } = await db.query(
          `SELECT id FROM suppliers WHERE company_id = $1 AND cnpj = $2`,
          [cid, cnpjDigits]
        );
        if (existing.length) {
          return res.status(409).json({ error: 'Ja existe um fornecedor com esse CNPJ', id: existing[0].id });
        }
      } catch (_) { /* cai no 500 abaixo */ }
    }
    console.error('[suppliers] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar fornecedor' });
  }
});

// ─── PATCH /:sid — atualizar ─────────────────────────────────
router.patch('/:sid', async (req, res) => {
  const cid = req.params.id;
  const sid = req.params.sid;
  const body = req.body || {};

  const updates = [];
  const values = [];
  let idx = 1;

  if (body.name !== undefined) {
    const v = String(body.name).trim();
    if (!v) return res.status(400).json({ error: 'name nao pode ser vazio' });
    updates.push(`name = $${idx}`); values.push(v.slice(0, 200)); idx++;
  }
  if (body.contact_name !== undefined) { updates.push(`contact_name = $${idx}`); values.push(limpar(body.contact_name, 200)); idx++; }
  if (body.phone !== undefined)        { updates.push(`phone = $${idx}`);        values.push(limpar(body.phone, 30));        idx++; }
  if (body.email !== undefined)        { updates.push(`email = $${idx}`);        values.push(limpar(body.email, 200));       idx++; }
  if (body.notes !== undefined)        { updates.push(`notes = $${idx}`);        values.push(limpar(body.notes, 2000));      idx++; }
  if (body.is_active !== undefined)    { updates.push(`is_active = $${idx}`);    values.push(!!body.is_active);              idx++; }

  // undefined = nao mexer no campo; null = limpar CNPJ; string = novo valor validado
  let cnpjDigits;
  if (body.cnpj !== undefined) {
    if (body.cnpj === null || String(body.cnpj).trim() === '') {
      cnpjDigits = null;
    } else {
      const digits = onlyDigits(body.cnpj);
      if (!isValidCnpj(digits)) return res.status(400).json({ error: 'CNPJ invalido' });
      cnpjDigits = digits;
    }
  }

  if (updates.length === 0 && cnpjDigits === undefined) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  try {
    if (cnpjDigits) {
      const { rows: dup } = await db.query(
        `SELECT id FROM suppliers WHERE cnpj = $1 AND id != $2 AND ${companyGroupWhere('$3')}`,
        [cnpjDigits, sid, cid]
      );
      if (dup.length) {
        return res.status(409).json({ error: 'Ja existe um fornecedor com esse CNPJ', id: dup[0].id });
      }
    }
    if (cnpjDigits !== undefined) { updates.push(`cnpj = $${idx}`); values.push(cnpjDigits); idx++; }
    updates.push('updated_at = NOW()');

    const { rows } = await db.query(
      `UPDATE suppliers SET ${updates.join(', ')}
       WHERE id = $${idx} AND ${companyGroupWhere(`$${idx + 1}`)}
       RETURNING *`,
      [...values, sid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fornecedor nao encontrado' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ja existe um fornecedor com esse CNPJ' });
    }
    console.error('[suppliers] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar fornecedor' });
  }
});

// ─── DELETE /:sid ─────────────────────────────────────────────
// Sem produto vinculado: apaga de verdade. Com produto vinculado:
// desativa (is_active=false) -- preserva o historico de estoque/compras
// em vez de deixar supplier_id orfao em massa (FK e ON DELETE SET NULL,
// entao apagar nao quebraria nada tecnicamente, mas perderia a
// informacao "quem fornecia" de todo produto/movimento ja registrado).
router.delete('/:sid', async (req, res) => {
  const cid = req.params.id;
  const sid = req.params.sid;
  try {
    const { rows: visible } = await db.query(
      `SELECT id FROM suppliers WHERE id = $1 AND ${companyGroupWhere('$2')}`,
      [sid, cid]
    );
    if (!visible.length) return res.status(404).json({ error: 'Fornecedor nao encontrado' });

    const { rows: linked } = await db.query(
      `SELECT COUNT(*)::int AS total FROM products WHERE supplier_id = $1`,
      [sid]
    );
    const productCount = linked[0]?.total || 0;

    if (productCount === 0) {
      await db.query(`DELETE FROM suppliers WHERE id = $1`, [sid]);
      return res.json({ deleted: true, soft: false, id: sid });
    }

    const { rows } = await db.query(
      `UPDATE suppliers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [sid]
    );
    res.json({
      deleted: true,
      soft: true,
      id: rows[0].id,
      product_count: productCount,
      message: 'Fornecedor tem produtos vinculados -- desativado em vez de excluido, pra preservar o historico.',
    });
  } catch (err) {
    console.error('[suppliers] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir fornecedor' });
  }
});

module.exports = router;
