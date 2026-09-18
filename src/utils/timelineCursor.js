// ============================================================
// AURA. — Cursor opaco de linha do tempo
//
// Formato nascido na history do crediário (credit.js, B1 11/06/2026):
// base64 de `<ISO timestamp>|<uuid>`, com a ordem estável
// (instante DESC, uuid DESC) e a página seguinte pedindo
// `(instante, uuid) < (cursor)`. A linha do tempo do cliente (Fase 1) usa o
// MESMO formato — extraído para cá para as duas rotas não divergirem.
// ============================================================
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns {{createdAt: string, id: string}|null} */
function decodeCursor(raw) {
  try {
    const decoded = Buffer.from(String(raw), 'base64').toString('utf8');
    const sep = decoded.lastIndexOf('|');
    if (sep <= 0) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!UUID_RE.test(id)) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch (_) {
    return null;
  }
}

function encodeCursor(at, id) {
  const ts = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64');
}

module.exports = { decodeCursor, encodeCursor, UUID_RE };
