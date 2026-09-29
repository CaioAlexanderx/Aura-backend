// ============================================================
// AURA. — Comprovante do lançamento (contas a pagar F3 · 29/09/2026)
//
//   POST   /companies/:id/transactions/:txId/receipt  { content (base64), filename, content_type }
//   GET    /companies/:id/transactions/:txId/receipt  → { url } assinada (1 h)
//   DELETE /companies/:id/transactions/:txId/receipt
//
// Foto ou PDF, até 3,5 MB (o corpo JSON do app tem teto de 5 MB e o base64
// cresce ~1/3). O arquivo vai para o R2 em <empresa>/comprovantes/<ano>/...;
// a tabela guarda só a chave (migration 363). Anexar de novo substitui e
// apaga o arquivo antigo.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const crypto = require('crypto');
const db = require('../config/database');
const { uploadToR2, getSignedUrl, deleteFromR2 } = require('../utils/r2Storage');

const TIPOS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};
const MAX_BYTES = 3.5 * 1024 * 1024;

function chaveDoComprovante(companyId, txId, ext) {
  const ano = new Date().getFullYear();
  return companyId + '/comprovantes/' + ano + '/' + txId + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;
}

function nomeLimpo(nome, ext) {
  const s = String(nome || '').replace(/[\\/\r\n\t]+/g, ' ').trim().slice(0, 120);
  return s || 'comprovante.' + ext;
}

async function linhaDoLancamento(txId, cid) {
  const r = await db.query(
    'SELECT id, receipt_key FROM transactions WHERE id = $1 AND company_id = $2',
    [txId, cid]
  );
  return r.rows[0] || null;
}

router.post('/:txId/receipt', async function(req, res) {
  const cid = req.params.id;
  const txId = req.params.txId;
  const body = req.body || {};
  const tipo = String(body.content_type || '').toLowerCase();
  const ext = TIPOS[tipo];
  if (!ext) return res.status(400).json({ error: 'Envie uma foto (JPG, PNG, WEBP, HEIC) ou um PDF.' });
  const base64 = String(body.content || '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) return res.status(400).json({ error: 'Arquivo vazio.' });
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) return res.status(400).json({ error: 'Arquivo vazio.' });
  if (bytes.length > MAX_BYTES) return res.status(413).json({ error: 'O arquivo passa de 3,5 MB. Tire a foto de novo ou envie o PDF.' });

  try {
    const tx = await linhaDoLancamento(txId, cid);
    if (!tx) return res.status(404).json({ error: 'Lancamento nao encontrado' });

    const key = chaveDoComprovante(cid, txId, ext);
    const up = await uploadToR2(key, bytes, tipo);
    if (!up.success) return res.status(502).json({ error: 'Nao deu para guardar o arquivo. Tente de novo.' });

    const filename = nomeLimpo(body.filename, ext);
    await db.query(
      'UPDATE transactions SET receipt_key = $1, receipt_filename = $2, receipt_content_type = $3, updated_at = NOW() WHERE id = $4 AND company_id = $5',
      [key, filename, tipo, txId, cid]
    );
    // O antigo sai depois que o novo ficou gravado (se falhar, sobra um arquivo, nunca um link quebrado).
    if (tx.receipt_key && tx.receipt_key !== key) {
      deleteFromR2(tx.receipt_key).catch(function() {});
    }
    res.status(201).json({ receipt: { filename: filename, content_type: tipo, size: bytes.length } });
  } catch (err) {
    console.error('[transactions] receipt upload:', err.message);
    res.status(500).json({ error: 'Erro ao anexar o comprovante' });
  }
});

router.get('/:txId/receipt', async function(req, res) {
  try {
    const tx = await linhaDoLancamento(req.params.txId, req.params.id);
    if (!tx) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    if (!tx.receipt_key) return res.status(404).json({ error: 'Este lancamento nao tem comprovante' });
    // A chave e sempre da empresa (montada aqui), mas confere assim mesmo.
    if (!tx.receipt_key.startsWith(req.params.id + '/')) return res.status(403).json({ error: 'Acesso negado' });
    const url = await getSignedUrl(tx.receipt_key, 3600);
    res.json({ url: url });
  } catch (err) {
    console.error('[transactions] receipt url:', err.message);
    res.status(500).json({ error: 'Erro ao abrir o comprovante' });
  }
});

router.delete('/:txId/receipt', async function(req, res) {
  try {
    const tx = await linhaDoLancamento(req.params.txId, req.params.id);
    if (!tx) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    if (!tx.receipt_key) return res.json({ deleted: false });
    await db.query(
      'UPDATE transactions SET receipt_key = NULL, receipt_filename = NULL, receipt_content_type = NULL, updated_at = NOW() WHERE id = $1 AND company_id = $2',
      [req.params.txId, req.params.id]
    );
    deleteFromR2(tx.receipt_key).catch(function() {});
    res.json({ deleted: true });
  } catch (err) {
    console.error('[transactions] receipt delete:', err.message);
    res.status(500).json({ error: 'Erro ao remover o comprovante' });
  }
});

module.exports = router;
module.exports._interno = { TIPOS, MAX_BYTES, chaveDoComprovante, nomeLimpo };
