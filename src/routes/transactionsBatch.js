// ============================================================
// AURA. — Lancamento em Massa + Importacao OFX
// FIX: db.pool.connect() → db.connect() (4 ocorrencias)
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const VALID_TYPES = ['income', 'expense'];

function validateTransaction(tx, index) {
  const errors = [];
  if (!tx.type || !VALID_TYPES.includes(tx.type)) errors.push(`Linha ${index + 1}: tipo invalido (use 'income' ou 'expense')`);
  if (!tx.amount || isNaN(parseFloat(tx.amount)) || parseFloat(tx.amount) <= 0) errors.push(`Linha ${index + 1}: valor invalido ou ausente`);
  if (!tx.description || String(tx.description).trim().length === 0) errors.push(`Linha ${index + 1}: descricao obrigatoria`);
  if (!tx.due_date || isNaN(Date.parse(tx.due_date))) errors.push(`Linha ${index + 1}: data invalida ou ausente (use YYYY-MM-DD)`);
  return errors;
}

function parseOFX(content) {
  const transactions = [];
  const body = content.replace(/[\s\S]*?(?=<OFX>|<ofx>)/i, '');
  const trnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match;
  while ((match = trnRegex.exec(body)) !== null) {
    const block = match[1];
    const get = (tag) => { const m = new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i').exec(block); return m ? m[1].trim() : null; };
    const trntype = get('TRNTYPE'), dtposted = get('DTPOSTED'), trnamt = get('TRNAMT'), fitid = get('FITID');
    const memo = get('MEMO') || get('NAME') || '';
    if (!trnamt || !dtposted || !fitid) continue;
    const rawDate = dtposted.replace(/[^0-9]/g, '').substring(0, 8);
    if (rawDate.length !== 8) continue;
    const due_date = `${rawDate.substring(0,4)}-${rawDate.substring(4,6)}-${rawDate.substring(6,8)}`;
    const amount = Math.abs(parseFloat(trnamt.replace(',', '.')));
    if (isNaN(amount) || amount === 0) continue;
    const positiveAmount = parseFloat(trnamt.replace(',', '.')) > 0;
    const creditTypes = ['CREDIT', 'DEP', 'DIRECTDEP', 'INTEREST', 'DIV'];
    const isCredit = creditTypes.includes((trntype || '').toUpperCase()) || positiveAmount;
    transactions.push({ type: isCredit ? 'income' : 'expense', amount, description: memo || `Transacao bancaria - ${fitid}`, due_date, status: 'paid', fitid, category: null, notes: `Importado via OFX - FITID: ${fitid}` });
  }
  return transactions;
}

// POST /companies/:id/transactions/batch
router.post('/batch', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const partial = req.query.partial === 'true' || req.body.partial === true;
  const dryRun = req.query.dry_run === 'true' || req.body.dry_run === true;
  const { transactions } = req.body;

  if (!Array.isArray(transactions) || transactions.length === 0) return res.status(400).json({ error: 'Campo transactions deve ser um array nao-vazio' });
  if (transactions.length > 500) return res.status(400).json({ error: 'Maximo de 500 lancamentos por lote' });

  const validItems = [], errorItems = [];
  transactions.forEach((tx, i) => {
    const errs = validateTransaction(tx, i);
    if (errs.length > 0) errorItems.push({ index: i, errors: errs, data: tx });
    else validItems.push({ index: i, data: tx });
  });

  if (!partial && errorItems.length > 0) {
    return res.status(422).json({ error: 'Lote contem erros. Use ?partial=true para salvar apenas os validos.', saved: 0, total: transactions.length, valid: validItems.length, error_count: errorItems.length, errors: errorItems });
  }

  if (dryRun) {
    return res.json({ dry_run: true, total: transactions.length, valid: validItems.length, error_count: errorItems.length, errors: errorItems, preview: validItems.map(v => v.data) });
  }

  const batchId = uuidv4();
  let saved = 0;
  const dbErrors = [];

  // FIX: use db.connect() instead of db.pool.connect()
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const { index, data } of validItems) {
      try {
        await client.query(
          `INSERT INTO transactions (company_id, type, amount, description, category, due_date, status, notes, import_batch_id, created_by, paid_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [companyId, data.type, parseFloat(data.amount), String(data.description).trim(), data.category || null, data.due_date, data.status || 'confirmed', data.notes || null, batchId, req.user?.id || null, data.due_date, data.due_date]
        );
        saved++;
      } catch (err) {
        dbErrors.push({ index, error: err.message, data });
        if (!partial) throw err;
      }
    }
    await client.query(
      `INSERT INTO import_logs (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by) VALUES ($1, 'transactions', 'batch', $2, $3, $4, $5, $6)`,
      [companyId, transactions.length, saved, errorItems.length + dbErrors.length, batchId, req.user?.id || null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[batch] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar lancamentos', detail: err.message });
  } finally {
    client.release();
  }

  res.status(201).json({ saved, total: transactions.length, error_count: errorItems.length + dbErrors.length, batch_id: batchId, errors: [...errorItems, ...dbErrors].sort((a, b) => a.index - b.index) });
});

// POST /companies/:id/transactions/import-ofx
router.post('/import-ofx', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const save = req.query.save === 'true';
  const { ofx_content, confirm_ids } = req.body;

  if (!ofx_content || typeof ofx_content !== 'string' || ofx_content.trim().length === 0) return res.status(400).json({ error: 'Campo ofx_content obrigatorio' });

  let parsed;
  try { parsed = parseOFX(ofx_content); } catch (err) { return res.status(422).json({ error: 'Arquivo OFX invalido', detail: err.message }); }
  if (parsed.length === 0) return res.status(422).json({ error: 'Nenhuma transacao encontrada no OFX' });

  const fitids = parsed.map(t => t.fitid);
  const existingRes = await db.query('SELECT fitid FROM transactions WHERE company_id=$1 AND fitid = ANY($2)', [companyId, fitids]);
  const existingFitids = new Set(existingRes.rows.map(r => r.fitid));

  const annotated = parsed.map(tx => ({ ...tx, status_import: existingFitids.has(tx.fitid) ? 'duplicate' : 'new' }));
  const newItems = annotated.filter(t => t.status_import === 'new');
  const dupeItems = annotated.filter(t => t.status_import === 'duplicate');

  if (!save) return res.json({ preview: true, total: annotated.length, new: newItems.length, duplicates: dupeItems.length, transactions: annotated });

  let toSave = newItems;
  if (Array.isArray(confirm_ids) && confirm_ids.length > 0) {
    const confirmSet = new Set(confirm_ids);
    toSave = newItems.filter(t => confirmSet.has(t.fitid));
  }
  if (toSave.length === 0) return res.json({ saved: 0, batch_id: null, message: 'Nenhum lancamento novo' });

  const batchId = uuidv4();
  let saved = 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const tx of toSave) {
      await client.query(
        `INSERT INTO transactions (company_id, type, amount, description, category, due_date, status, fitid, import_batch_id, notes, created_by, paid_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (company_id, fitid) DO NOTHING`,
        [companyId, tx.type, tx.amount, tx.description, tx.category, tx.due_date, tx.status || 'confirmed', tx.fitid, batchId, tx.notes, req.user?.id || null, tx.due_date, tx.due_date]
      );
      saved++;
    }
    await client.query(
      `INSERT INTO import_logs (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta) VALUES ($1, 'transactions', 'ofx', $2, $3, $4, $5, $6, $7)`,
      [companyId, annotated.length, saved, dupeItems.length, batchId, req.user?.id || null, JSON.stringify({ duplicates_skipped: dupeItems.length })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import-ofx] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar extrato OFX', detail: err.message });
  } finally { client.release(); }

  res.status(201).json({ saved, skipped_duplicates: dupeItems.length, batch_id: batchId });
});

// GET /companies/:id/transactions/import-history
router.get('/import-history', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, module, format, total_rows, imported_rows, error_rows, batch_id, created_at, reverted_at FROM import_logs WHERE company_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ imports: result.rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar historico' }); }
});

// DELETE /companies/:id/transactions/import/:batch_id
router.delete('/import/:batch_id', requireAuth, async (req, res) => {
  const { id: companyId, batch_id } = req.params;
  try {
    const logRes = await db.query('SELECT id, imported_rows, reverted_at FROM import_logs WHERE batch_id=$1 AND company_id=$2', [batch_id, companyId]);
    if (!logRes.rows[0]) return res.status(404).json({ error: 'Importacao nao encontrada' });
    if (logRes.rows[0].reverted_at) return res.status(409).json({ error: 'Importacao ja desfeita' });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query('DELETE FROM transactions WHERE import_batch_id=$1 AND company_id=$2', [batch_id, companyId]);
      await client.query('UPDATE import_logs SET reverted_at=NOW() WHERE batch_id=$1 AND company_id=$2', [batch_id, companyId]);
      await client.query('COMMIT');
      res.json({ reverted: true, batch_id, deleted_count: deleted.rowCount });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) { res.status(500).json({ error: 'Erro ao desfazer importacao' }); }
});

module.exports = router;
