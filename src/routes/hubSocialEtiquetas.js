// ============================================================
// AURA. — hubSocialEtiquetas.js
// Etiquetas das conversas (criar, apagar, aplicar, tirar) e "É ela": ligar
// o número da conversa a um cadastro de Clientes da MESMA empresa.
// Montado dentro de hubSocial.js (herda requireAuth + company access).
//
// "É ela" grava hub_conversations.customer_id. O nome do cadastro passa a
// aparecer no lugar do nome do perfil por JOIN na leitura (hubSocial.js);
// customer_name não é sobrescrito, porque o webhook reescreve o nome do
// perfil a cada mensagem recebida.
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/database');
const {
  validarNome, isMissingSchema, UUID_RE, COR_RE, COR_PADRAO, MAX_ETIQUETAS_POR_LOJA,
} = require('../services/hubEtiquetas');

const erroSchema = (res) => res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });

// Só conversa e etiqueta da própria loja (multi-CNPJ: nunca cruza empresa).
async function conversaDaLoja(cid, convId) {
  if (!UUID_RE.test(String(convId))) return null;
  const { rows } = await db.query(
    `SELECT id, external_id, customer_id FROM hub_conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [convId, cid]
  );
  return rows[0] || null;
}

// ── Etiquetas da loja ────────────────────────────────────────
router.get('/etiquetas', async (req, res) => {
  try {
    const { rows } = await db.query(
      `-- hub:etiquetas
       SELECT l.id, l.name, l.color,
              (SELECT COUNT(*)::int FROM hub_conversation_labels cl WHERE cl.label_id = l.id) AS n
         FROM hub_labels l
        WHERE l.company_id = $1
        ORDER BY l.name ASC`,
      [req.params.id]
    );
    res.json({ labels: rows });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ labels: [], schema_pending: true });
    console.error('[HUB] etiquetas error:', e.message);
    res.status(500).json({ error: 'Erro ao listar etiquetas' });
  }
});

router.post('/etiquetas', async (req, res) => {
  const cid = req.params.id;
  const v = validarNome(req.body && req.body.name);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const cor = req.body && req.body.color ? String(req.body.color) : COR_PADRAO;
  if (!COR_RE.test(cor)) return res.status(400).json({ error: 'Cor inválida (use #rrggbb)' });
  try {
    const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM hub_labels WHERE company_id = $1`, [cid]);
    if (n >= MAX_ETIQUETAS_POR_LOJA) {
      return res.status(409).json({ error: `Chegou ao limite de ${MAX_ETIQUETAS_POR_LOJA} etiquetas. Apague uma que não usa mais.`, code: 'LIMITE_ETIQUETAS' });
    }
    const { rows } = await db.query(
      `INSERT INTO hub_labels (company_id, name, color) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, lower(name)) DO NOTHING
       RETURNING id, name, color`,
      [cid, v.nome, cor]
    );
    if (!rows.length) return res.status(409).json({ error: 'Você já tem uma etiqueta com esse nome', code: 'ETIQUETA_REPETIDA' });
    res.status(201).json({ label: { ...rows[0], n: 0 } });
  } catch (e) {
    if (isMissingSchema(e)) return erroSchema(res);
    console.error('[HUB] etiqueta criar error:', e.message);
    res.status(500).json({ error: 'Erro ao criar a etiqueta' });
  }
});

router.delete('/etiquetas/:labelId', async (req, res) => {
  if (!UUID_RE.test(String(req.params.labelId))) return res.status(404).json({ error: 'Etiqueta não encontrada' });
  try {
    const { rows } = await db.query(
      `DELETE FROM hub_labels WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.labelId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Etiqueta não encontrada' });
    res.json({ ok: true });
  } catch (e) {
    if (isMissingSchema(e)) return erroSchema(res);
    res.status(500).json({ error: 'Erro ao apagar a etiqueta' });
  }
});

// ── Etiqueta na conversa ─────────────────────────────────────
router.put('/conversations/:convId/etiquetas/:labelId', async (req, res) => {
  const cid = req.params.id;
  try {
    const conv = await conversaDaLoja(cid, req.params.convId);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (!UUID_RE.test(String(req.params.labelId))) return res.status(404).json({ error: 'Etiqueta não encontrada' });
    // O INSERT só passa se a etiqueta for desta loja.
    const { rowCount } = await db.query(
      `INSERT INTO hub_conversation_labels (conversation_id, label_id)
       SELECT $1, l.id FROM hub_labels l WHERE l.id = $2 AND l.company_id = $3
       ON CONFLICT DO NOTHING`,
      [conv.id, req.params.labelId, cid]
    );
    if (!rowCount) {
      const { rows } = await db.query(`SELECT 1 FROM hub_labels WHERE id = $1 AND company_id = $2`, [req.params.labelId, cid]);
      if (!rows.length) return res.status(404).json({ error: 'Etiqueta não encontrada' });
    }
    res.json({ ok: true });
  } catch (e) {
    if (isMissingSchema(e)) return erroSchema(res);
    console.error('[HUB] etiqueta aplicar error:', e.message);
    res.status(500).json({ error: 'Erro ao aplicar a etiqueta' });
  }
});

router.delete('/conversations/:convId/etiquetas/:labelId', async (req, res) => {
  const cid = req.params.id;
  try {
    const conv = await conversaDaLoja(cid, req.params.convId);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (!UUID_RE.test(String(req.params.labelId))) return res.status(404).json({ error: 'Etiqueta não encontrada' });
    await db.query(
      `DELETE FROM hub_conversation_labels cl
        USING hub_labels l
        WHERE cl.label_id = l.id AND cl.conversation_id = $1 AND cl.label_id = $2 AND l.company_id = $3`,
      [conv.id, req.params.labelId, cid]
    );
    res.json({ ok: true });
  } catch (e) {
    if (isMissingSchema(e)) return erroSchema(res);
    res.status(500).json({ error: 'Erro ao tirar a etiqueta' });
  }
});

// ── "É ela": o cadastro de Clientes desta conversa ───────────
// last_purchase_amount: total da última venda NÃO cancelada do cliente nesta loja (mesmo predicado de customers.last_purchase_at, migration 311).
const COLUNAS_CLIENTE = `c.id, c.name, c.phone, c.email, c.birth_date, c.created_at, c.last_purchase_at, c.total_spent,
  (SELECT s.total_amount FROM sales s
    WHERE s.customer_id = c.id AND s.company_id = c.company_id AND COALESCE(s.status, 'completed') != 'cancelled'
    ORDER BY s.created_at DESC LIMIT 1) AS last_purchase_amount`;

function cartao(r) {
  return {
    id: r.id, name: r.name, phone: r.phone || null, email: r.email || null,
    birth_date: r.birth_date || null, since: r.created_at || null,
    last_purchase_at: r.last_purchase_at || null,
    last_purchase_amount: r.last_purchase_amount != null ? Number(r.last_purchase_amount) : null,
    total_spent: r.total_spent != null ? Number(r.total_spent) : null,
  };
}

// Cadastro ligado à conversa; sem ligação, o cadastro de mesmo telefone
// (sugestão para o "Este número é da …?").
router.get('/conversations/:convId/cliente', async (req, res) => {
  const cid = req.params.id;
  try {
    const conv = await conversaDaLoja(cid, req.params.convId);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (conv.customer_id) {
      const { rows } = await db.query(
        `-- hub:cliente-da-conversa
         SELECT ${COLUNAS_CLIENTE} FROM customers c WHERE c.id = $1 AND c.company_id = $2 LIMIT 1`,
        [conv.customer_id, cid]
      );
      return res.json({ cliente: rows[0] ? cartao(rows[0]) : null, sugestao: null });
    }
    const fone = String(conv.external_id || '').replace(/\D+/g, '');
    if (fone.length < 10) return res.json({ cliente: null, sugestao: null });
    const { rows } = await db.query(
      `-- hub:cliente-sugerido
       SELECT ${COLUNAS_CLIENTE} FROM customers c
        WHERE c.company_id = $1 AND COALESCE(c.is_active, true) = true
          AND RIGHT(regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g'), 11) = RIGHT($2, 11)
          AND length(regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g')) >= 10
        ORDER BY c.last_purchase_at DESC NULLS LAST
        LIMIT 1`,
      [cid, fone]
    );
    res.json({ cliente: null, sugestao: rows[0] ? cartao(rows[0]) : null });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ cliente: null, sugestao: null });
    console.error('[HUB] cliente da conversa error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar o cliente' });
  }
});

// Busca de cadastro para o "É ela" (nome, telefone ou e-mail).
router.get('/clientes', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ clientes: [] });
  const digitos = q.replace(/\D+/g, '');
  try {
    const { rows } = await db.query(
      `-- hub:clientes-busca
       SELECT c.id, c.name, c.phone, c.email
         FROM customers c
        WHERE c.company_id = $1 AND COALESCE(c.is_active, true) = true
          AND ( c.name ILIKE $2 OR c.email ILIKE $2
             OR ($3 <> '' AND regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') LIKE '%' || $3 || '%') )
        ORDER BY c.name ASC
        LIMIT 10`,
      [req.params.id, `%${q}%`, digitos.length >= 3 ? digitos : '']
    );
    res.json({ clientes: rows });
  } catch (e) {
    if (isMissingSchema(e)) return res.json({ clientes: [] });
    console.error('[HUB] clientes busca error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar clientes' });
  }
});

// Liga (ou desliga, com null) a conversa a um cadastro da mesma loja.
router.put('/conversations/:convId/cliente', async (req, res) => {
  const cid = req.params.id;
  const alvo = req.body ? req.body.customer_id : undefined;
  if (alvo !== null && !(typeof alvo === 'string' && UUID_RE.test(alvo))) {
    return res.status(400).json({ error: 'customer_id inválido (uuid ou null)' });
  }
  try {
    const conv = await conversaDaLoja(cid, req.params.convId);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    if (alvo !== null) {
      const { rows } = await db.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2 LIMIT 1`, [alvo, cid]);
      if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado nesta loja' });
    }
    await db.query(
      `UPDATE hub_conversations SET customer_id = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [alvo, conv.id, cid]
    );
    res.json({ ok: true, customer_id: alvo });
  } catch (e) {
    if (isMissingSchema(e)) return erroSchema(res);
    console.error('[HUB] ligar cliente error:', e.message);
    res.status(500).json({ error: 'Erro ao ligar o cliente' });
  }
});

module.exports = router;
