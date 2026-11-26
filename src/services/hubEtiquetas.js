// ============================================================
// AURA. — hubEtiquetas.js
// Etiquetas das conversas do hub (migration 474). 42P01/42703 em tudo: o
// backend sobe antes da migration e a lista de conversas nunca pode cair
// por causa de uma etiqueta.
// ============================================================
'use strict';

const db = require('../config/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ETIQUETAS_POR_LOJA = 30;
const COR_RE = /^#[0-9a-fA-F]{6}$/;
const COR_PADRAO = '#7c3aed';

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

/**
 * Põe `labels: [{id,name,color}]` em cada conversa (uma consulta para a
 * lista toda). Sem a migration, todas ficam com [].
 */
async function anexarEtiquetas(conversas) {
  const ids = (conversas || []).map((c) => c.id).filter(Boolean);
  const porConversa = new Map();
  if (ids.length) {
    try {
      const { rows } = await db.query(
        `-- hub:etiquetas-das-conversas
         SELECT cl.conversation_id, l.id, l.name, l.color
           FROM hub_conversation_labels cl
           JOIN hub_labels l ON l.id = cl.label_id
          WHERE cl.conversation_id = ANY($1::uuid[])
          ORDER BY l.name ASC`,
        [ids]
      );
      for (const r of rows) {
        if (!porConversa.has(r.conversation_id)) porConversa.set(r.conversation_id, []);
        porConversa.get(r.conversation_id).push({ id: r.id, name: r.name, color: r.color });
      }
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
    }
  }
  for (const c of conversas || []) c.labels = porConversa.get(c.id) || [];
  return conversas;
}

function validarNome(nome) {
  const n = String(nome == null ? '' : nome).trim().replace(/\s+/g, ' ');
  if (!n) return { ok: false, error: 'Dê um nome para a etiqueta' };
  if (n.length > 30) return { ok: false, error: 'O nome da etiqueta tem no máximo 30 letras' };
  return { ok: true, nome: n };
}

module.exports = {
  anexarEtiquetas, validarNome, isMissingSchema, UUID_RE, COR_RE, COR_PADRAO, MAX_ETIQUETAS_POR_LOJA,
};
