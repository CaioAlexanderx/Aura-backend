// ============================================================
// AURA. — MKT-01: Bank Reconciliation
// Import OFX/CSV bank statements, auto-match transactions
// Mounted at: /companies/:id/bank
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');
const crypto  = require('crypto');

// ===== BANK ACCOUNTS =====

router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM bank_accounts WHERE company_id=$1 ORDER BY is_primary DESC, bank_name',
      [req.params.id]
    );
    res.json({ total: rows.length, accounts: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar contas' }); }
});

router.post('/accounts', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { bank_name, bank_code, agency, account_number, account_type, nickname, initial_balance, is_primary } = req.body;
  if (!bank_name) return res.status(400).json({ error: 'bank_name obrigatorio' });
  try {
    if (is_primary) {
      await db.query('UPDATE bank_accounts SET is_primary=false WHERE company_id=$1', [req.params.id]);
    }
    const { rows } = await db.query(
      `INSERT INTO bank_accounts (company_id, bank_name, bank_code, agency, account_number, account_type, nickname, initial_balance, current_balance, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) RETURNING *`,
      [req.params.id, bank_name, bank_code||null, agency||null, account_number||null,
       account_type||'corrente', nickname||null, initial_balance||0, is_primary||false]
    );
    res.status(201).json({ account: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar conta' }); }
});

// ===== IMPORT BANK STATEMENT (CSV format) =====

router.post('/accounts/:accountId/import', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { entries } = req.body; // Array of { date, description, amount, balance?, reference? }
  if (!entries || !entries.length) return res.status(400).json({ error: 'entries obrigatorio (array)' });

  const batchId = 'IMP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    let imported = 0, duplicates = 0;
    for (const entry of entries) {
      if (!entry.date || !entry.description || entry.amount === undefined) continue;

      // Generate fitid if not provided (hash of date+desc+amount for dedup)
      const fitid = entry.fitid || crypto.createHash('md5')
        .update(`${entry.date}|${entry.description}|${entry.amount}`).digest('hex').substring(0, 20);

      try {
        await client.query(
          `INSERT INTO bank_statement_entries
             (company_id, bank_account_id, date, description, amount, balance, reference, fitid, import_batch)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.params.id, req.params.accountId, entry.date, entry.description,
           entry.amount, entry.balance||null, entry.reference||null, fitid, batchId]
        );
        imported++;
      } catch (err) {
        if (err.code === '23505') { duplicates++; } // Unique violation = duplicate fitid
        else throw err;
      }
    }

    // Update last_import
    await client.query(
      'UPDATE bank_accounts SET last_import=NOW(), updated_at=NOW() WHERE id=$1',
      [req.params.accountId]
    );

    await client.query('COMMIT');

    logAuditAction(req.user.id, req.params.id, 'bank_import',
      `Imported ${imported} entries (${duplicates} duplicates skipped) batch ${batchId}`);

    res.status(201).json({ imported, duplicates, batch_id: batchId, total_entries: entries.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('bank import error:', err);
    res.status(500).json({ error: 'Erro ao importar extrato' });
  } finally { client.release(); }
});

// ===== AUTO-MATCH =====

router.post('/accounts/:accountId/auto-match', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    // Get unmatched statement entries
    const { rows: entries } = await db.query(
      `SELECT id, date, description, amount FROM bank_statement_entries
       WHERE bank_account_id=$1 AND company_id=$2 AND match_status='pendente'
       ORDER BY date`,
      [req.params.accountId, req.params.id]
    );

    // Get unreconciled transactions
    const { rows: transactions } = await db.query(
      `SELECT t.id, t.date, t.description, t.amount, t.type
       FROM transactions t
       LEFT JOIN bank_statement_entries bse ON bse.matched_transaction_id=t.id
       WHERE t.company_id=$1 AND bse.id IS NULL
       ORDER BY t.date`,
      [req.params.id]
    );

    // Get custom rules
    const { rows: rules } = await db.query(
      'SELECT * FROM bank_reconciliation_rules WHERE company_id=$1 AND is_active=true',
      [req.params.id]
    );

    let matched = 0;
    const matches = [];

    for (const entry of entries) {
      // Strategy 1: Exact amount + same date (+-2 days)
      const exactMatch = transactions.find(t => {
        const tAmount = t.type === 'expense' ? -Math.abs(parseFloat(t.amount)) : Math.abs(parseFloat(t.amount));
        const entryAmount = parseFloat(entry.amount);
        const dateDiff = Math.abs(new Date(entry.date).getTime() - new Date(t.date).getTime()) / 86400000;
        return Math.abs(tAmount - entryAmount) < 0.01 && dateDiff <= 2;
      });

      if (exactMatch) {
        await db.query(
          `UPDATE bank_statement_entries SET match_status='automatico', matched_transaction_id=$1, matched_at=NOW(), matched_by='auto'
           WHERE id=$2`,
          [exactMatch.id, entry.id]
        );
        // Remove from pool
        const idx = transactions.indexOf(exactMatch);
        if (idx >= 0) transactions.splice(idx, 1);
        matched++;
        matches.push({ entry_id: entry.id, transaction_id: exactMatch.id, method: 'exact_amount_date' });
        continue;
      }

      // Strategy 2: Custom rules
      for (const rule of rules) {
        let ruleMatch = false;
        const desc = entry.description.toLowerCase();
        if (rule.match_type === 'contains' && desc.includes(rule.match_pattern.toLowerCase())) ruleMatch = true;
        if (rule.match_type === 'starts_with' && desc.startsWith(rule.match_pattern.toLowerCase())) ruleMatch = true;
        if (rule.match_type === 'exact' && desc === rule.match_pattern.toLowerCase()) ruleMatch = true;

        if (ruleMatch && rule.target_category) {
          await db.query(
            'UPDATE bank_statement_entries SET category=$1 WHERE id=$2',
            [rule.target_category, entry.id]
          );
          await db.query(
            'UPDATE bank_reconciliation_rules SET matches_count=matches_count+1 WHERE id=$1',
            [rule.id]
          );
        }
      }
    }

    logAuditAction(req.user.id, req.params.id, 'bank_auto_match',
      `Auto-matched ${matched} of ${entries.length} entries`);

    res.json({
      total_entries: entries.length,
      matched,
      pending: entries.length - matched,
      matches,
    });
  } catch (err) {
    console.error('auto-match error:', err);
    res.status(500).json({ error: 'Erro na conciliacao automatica' });
  }
});

// ===== MANUAL MATCH =====

router.patch('/entries/:entryId/match', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { transaction_id, status } = req.body;
  if (!status) return res.status(400).json({ error: 'status obrigatorio (manual, ignorado)' });

  try {
    const { rows } = await db.query(
      `UPDATE bank_statement_entries SET match_status=$1, matched_transaction_id=$2, matched_at=NOW(), matched_by='manual'
       WHERE id=$3 AND company_id=$4 RETURNING *`,
      [status, transaction_id||null, req.params.entryId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Entrada nao encontrada' });
    res.json({ entry: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao conciliar' }); }
});

// ===== RECONCILIATION DASHBOARD =====

router.get('/reconciliation', requireAuth, async (req, res) => {
  const { account_id, start, end } = req.query;
  try {
    const params = [req.params.id];
    let accountFilter = '';
    if (account_id) { params.push(account_id); accountFilter = ` AND bse.bank_account_id=$${params.length}`; }

    let dateFilter = '';
    if (start) { params.push(start); dateFilter += ` AND bse.date>=$${params.length}`; }
    if (end) { params.push(end); dateFilter += ` AND bse.date<=$${params.length}`; }

    // Summary stats
    const { rows: stats } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE match_status='pendente')::int AS pending,
         COUNT(*) FILTER (WHERE match_status='automatico')::int AS auto_matched,
         COUNT(*) FILTER (WHERE match_status='manual')::int AS manual_matched,
         COUNT(*) FILTER (WHERE match_status='ignorado')::int AS ignored,
         COUNT(*) FILTER (WHERE match_status='divergente')::int AS divergent,
         COUNT(*)::int AS total,
         COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0)::numeric AS total_credits,
         COALESCE(SUM(CASE WHEN amount<0 THEN amount ELSE 0 END),0)::numeric AS total_debits
       FROM bank_statement_entries bse
       WHERE bse.company_id=$1${accountFilter}${dateFilter}`, params
    );

    // Pending entries (for reconciliation UI)
    const pendingParams = [req.params.id];
    let pendingFilter = '';
    if (account_id) { pendingParams.push(account_id); pendingFilter = ` AND bse.bank_account_id=$${pendingParams.length}`; }

    const { rows: pendingEntries } = await db.query(
      `SELECT bse.*, ba.bank_name, ba.nickname AS account_name
       FROM bank_statement_entries bse
       JOIN bank_accounts ba ON ba.id=bse.bank_account_id
       WHERE bse.company_id=$1 AND bse.match_status='pendente'${pendingFilter}
       ORDER BY bse.date DESC
       LIMIT 50`, pendingParams
    );

    // Unmatched transactions (potential matches)
    const { rows: unmatchedTx } = await db.query(
      `SELECT t.id, t.date, t.description, t.amount, t.type, t.category
       FROM transactions t
       LEFT JOIN bank_statement_entries bse ON bse.matched_transaction_id=t.id
       WHERE t.company_id=$1 AND bse.id IS NULL
       ORDER BY t.date DESC
       LIMIT 50`, [req.params.id]
    );

    res.json({
      summary: stats[0] || {},
      conciliation_rate: stats[0]?.total > 0
        ? Math.round(((stats[0].auto_matched + stats[0].manual_matched) / stats[0].total) * 100)
        : 0,
      pending_entries: pendingEntries,
      unmatched_transactions: unmatchedTx,
    });
  } catch (err) {
    console.error('reconciliation dashboard error:', err);
    res.status(500).json({ error: 'Erro ao buscar conciliacao' });
  }
});

// ===== RECONCILIATION RULES =====

router.get('/rules', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM bank_reconciliation_rules WHERE company_id=$1 ORDER BY matches_count DESC',
      [req.params.id]
    );
    res.json({ total: rows.length, rules: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar regras' }); }
});

router.post('/rules', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, match_field, match_pattern, match_type, target_category } = req.body;
  if (!name || !match_pattern) return res.status(400).json({ error: 'name e match_pattern obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO bank_reconciliation_rules (company_id, name, match_field, match_pattern, match_type, target_category)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, name, match_field||'description', match_pattern, match_type||'contains', target_category||null]
    );
    res.status(201).json({ rule: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao criar regra' }); }
});

module.exports = router;
