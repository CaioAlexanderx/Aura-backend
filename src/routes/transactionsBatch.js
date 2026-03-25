// ============================================================
// AURA. — Lançamento em Massa + Importação OFX
// Features: BE-27a (batch), BE-27b (TSV/CSV), BE-27c (OFX)
// ============================================================
// Endpoints:
//   POST /companies/:id/transactions/batch
//     → BE-27a: array de lançamentos de uma vez
//     → BE-27b: mesmo endpoint, payload já parseado (TSV/CSV parseado no frontend)
//     Query: ?partial=true  → salva válidos, reporta erros individualmente
//            ?dry_run=true  → valida sem salvar (preview)
//
//   POST /companies/:id/transactions/import-ofx
//     → BE-27c: upload do arquivo OFX em texto (body.ofx_content)
//     → Detecta duplicatas por fitid, retorna preview
//     Query: ?save=true     → confirma e salva (depois do preview)
//
//   GET  /companies/:id/transactions/import-history
//     → Lista importações anteriores da empresa
//
//   DELETE /companies/:id/transactions/import/:batch_id
//     → Desfaz uma importação (soft delete — marca reverted_at)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// ─── Validação de um lançamento individual ───────────────────

const VALID_TYPES = ['income', 'expense'];

function validateTransaction(tx, index) {
  const errors = [];
  if (!tx.type || !VALID_TYPES.includes(tx.type)) {
    errors.push(`Linha ${index + 1}: tipo inválido (use 'income' ou 'expense')`);
  }
  if (!tx.amount || isNaN(parseFloat(tx.amount)) || parseFloat(tx.amount) <= 0) {
    errors.push(`Linha ${index + 1}: valor inválido ou ausente`);
  }
  if (!tx.description || String(tx.description).trim().length === 0) {
    errors.push(`Linha ${index + 1}: descrição obrigatória`);
  }
  if (!tx.due_date || isNaN(Date.parse(tx.due_date))) {
    errors.push(`Linha ${index + 1}: data inválida ou ausente (use YYYY-MM-DD)`);
  }
  return errors;
}

// ─── Parser OFX nativo ───────────────────────────────────────
// OFX é um formato SGML simples. Extraímos cada <STMTTRN>...</STMTTRN>
// e parseamos os campos necessários sem dependência externa.

function parseOFX(content) {
  const transactions = [];

  // Remover cabeçalho OFXHEADER (linhas antes do primeiro <OFX> ou <ofx>)
  const body = content.replace(/[\s\S]*?(?=<OFX>|<ofx>)/i, '');

  // Extrair todos os blocos de transação
  const trnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match;

  while ((match = trnRegex.exec(body)) !== null) {
    const block = match[1];

    const get = (tag) => {
      const m = new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i').exec(block);
      return m ? m[1].trim() : null;
    };

    const trntype  = get('TRNTYPE');  // CREDIT | DEBIT | CHECK | ...
    const dtposted = get('DTPOSTED'); // 20260105120000[−3:BRT] ou 20260105
    const trnamt   = get('TRNAMT');   // -150.00 ou 150.00
    const fitid    = get('FITID');
    const memo     = get('MEMO') || get('NAME') || get('MEMO2') || '';

    if (!trnamt || !dtposted || !fitid) continue;

    // Normalizar data: pegar apenas os primeiros 8 dígitos (YYYYMMDD)
    const rawDate = dtposted.replace(/[^0-9]/g, '').substring(0, 8);
    if (rawDate.length !== 8) continue;
    const due_date = `${rawDate.substring(0,4)}-${rawDate.substring(4,6)}-${rawDate.substring(6,8)}`;

    const amount = Math.abs(parseFloat(trnamt.replace(',', '.')));
    if (isNaN(amount) || amount === 0) continue;

    // Mapear tipo: CREDIT/DEP = receita, resto = despesa
    // Também usar sinal do valor: positivo = receita, negativo = despesa
    const positiveAmount = parseFloat(trnamt.replace(',', '.')) > 0;
    const creditTypes = ['CREDIT', 'DEP', 'DIRECTDEP', 'INTEREST', 'DIV', 'SRVCHG'];
    const isCredit = creditTypes.includes((trntype || '').toUpperCase()) || positiveAmount;

    transactions.push({
      type:        isCredit ? 'income' : 'expense',
      amount,
      description: memo || `Transação bancária — ${fitid}`,
      due_date,
      status:      'paid',
      fitid,
      category:    null,
      notes:       `Importado via OFX — FITID: ${fitid}`,
    });
  }

  return transactions;
}

// ─── BE-27a/b — POST /batch ──────────────────────────────────
// Aceita array de lançamentos. Frontend pode enviar:
//   - Formulário multi-linha (BE-27a)
//   - Resultado de parse TSV/CSV do papaparse (BE-27b)
//
// Body: { transactions: [...], partial?: boolean, dry_run?: boolean }
// Cada item: { type, amount, description, due_date, status?, category?, notes? }

router.post('/batch', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const partial   = req.query.partial === 'true' || req.body.partial === true;
  const dryRun    = req.query.dry_run === 'true'  || req.body.dry_run  === true;

  const { transactions } = req.body;

  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'Campo transactions deve ser um array não-vazio' });
  }
  if (transactions.length > 500) {
    return res.status(400).json({ error: 'Máximo de 500 lançamentos por lote' });
  }

  // Validar todos
  const validItems   = [];
  const errorItems   = [];

  transactions.forEach((tx, i) => {
    const errs = validateTransaction(tx, i);
    if (errs.length > 0) {
      errorItems.push({ index: i, errors: errs, data: tx });
    } else {
      validItems.push({ index: i, data: tx });
    }
  });

  // Se não for parcial e houver erros, retornar sem salvar
  if (!partial && errorItems.length > 0) {
    return res.status(422).json({
      error:       'Lote contém erros. Use ?partial=true para salvar apenas os válidos.',
      saved:       0,
      total:       transactions.length,
      valid:       validItems.length,
      error_count: errorItems.length,
      errors:      errorItems,
    });
  }

  // Dry run — retornar preview sem salvar
  if (dryRun) {
    return res.json({
      dry_run:     true,
      total:       transactions.length,
      valid:       validItems.length,
      error_count: errorItems.length,
      errors:      errorItems,
      preview:     validItems.map(v => v.data),
    });
  }

  // Salvar em transação DB
  const batchId = uuidv4();
  let saved = 0;
  const dbErrors = [];

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    for (const { index, data } of validItems) {
      try {
        await client.query(
          `INSERT INTO transactions
             (company_id, type, amount, description, category, due_date,
              status, notes, import_batch_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            companyId,
            data.type,
            parseFloat(data.amount),
            String(data.description).trim(),
            data.category || null,
            data.due_date,
            data.status || 'paid',
            data.notes || null,
            batchId,
            req.user?.id || null,
          ]
        );
        saved++;
      } catch (err) {
        dbErrors.push({ index, error: err.message, data });
        if (!partial) throw err; // abortar tudo
      }
    }

    // Registrar log da importação
    await client.query(
      `INSERT INTO import_logs
         (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by)
       VALUES ($1, 'transactions', 'batch', $2, $3, $4, $5, $6)`,
      [
        companyId,
        transactions.length,
        saved,
        errorItems.length + dbErrors.length,
        batchId,
        req.user?.id || null,
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[batch] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar lançamentos', detail: err.message });
  } finally {
    client.release();
  }

  res.status(201).json({
    saved,
    total:       transactions.length,
    error_count: errorItems.length + dbErrors.length,
    batch_id:    batchId,
    errors:      [...errorItems, ...dbErrors].sort((a, b) => a.index - b.index),
  });
});

// ─── BE-27c — POST /import-ofx ───────────────────────────────
// Fase 1 (preview): POST sem ?save=true → analisa e retorna lista
// Fase 2 (salvar):  POST com ?save=true → salva os confirmados
//
// Body fase 1: { ofx_content: '<string do arquivo .ofx>' }
// Body fase 2: { ofx_content: '<string>', confirm_ids: ['fitid1', 'fitid2', ...] }
//   confirm_ids: se ausente, salva todos os novos detectados

router.post('/import-ofx', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const save      = req.query.save === 'true';
  const { ofx_content, confirm_ids } = req.body;

  if (!ofx_content || typeof ofx_content !== 'string' || ofx_content.trim().length === 0) {
    return res.status(400).json({ error: 'Campo ofx_content é obrigatório (conteúdo do arquivo .ofx)' });
  }

  // Parsear OFX
  let parsed;
  try {
    parsed = parseOFX(ofx_content);
  } catch (err) {
    return res.status(422).json({ error: 'Arquivo OFX inválido ou formato não reconhecido', detail: err.message });
  }

  if (parsed.length === 0) {
    return res.status(422).json({ error: 'Nenhuma transação encontrada no arquivo OFX' });
  }

  // Verificar quais FITIDs já existem no banco
  const fitids = parsed.map(t => t.fitid);
  const existingRes = await db.query(
    `SELECT fitid FROM transactions WHERE company_id=$1 AND fitid = ANY($2)`,
    [companyId, fitids]
  );
  const existingFitids = new Set(existingRes.rows.map(r => r.fitid));

  // Anotar status de cada transação
  const annotated = parsed.map(tx => ({
    ...tx,
    status_import: existingFitids.has(tx.fitid) ? 'duplicate' : 'new',
  }));

  const newItems  = annotated.filter(t => t.status_import === 'new');
  const dupeItems = annotated.filter(t => t.status_import === 'duplicate');

  // Preview — retornar sem salvar
  if (!save) {
    return res.json({
      preview:    true,
      total:      annotated.length,
      new:        newItems.length,
      duplicates: dupeItems.length,
      transactions: annotated,
    });
  }

  // Salvar — filtrar pelos confirm_ids (se fornecido) ou todos os novos
  let toSave = newItems;
  if (Array.isArray(confirm_ids) && confirm_ids.length > 0) {
    const confirmSet = new Set(confirm_ids);
    toSave = newItems.filter(t => confirmSet.has(t.fitid));
  }

  if (toSave.length === 0) {
    return res.json({ saved: 0, batch_id: null, message: 'Nenhum lançamento novo para salvar' });
  }

  const batchId = uuidv4();
  let saved = 0;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    for (const tx of toSave) {
      await client.query(
        `INSERT INTO transactions
           (company_id, type, amount, description, category, due_date,
            status, fitid, import_batch_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (company_id, fitid) DO NOTHING`,
        [
          companyId,
          tx.type,
          tx.amount,
          tx.description,
          tx.category,
          tx.due_date,
          tx.status || 'paid',
          tx.fitid,
          batchId,
          tx.notes,
          req.user?.id || null,
        ]
      );
      saved++;
    }

    await client.query(
      `INSERT INTO import_logs
         (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta)
       VALUES ($1, 'transactions', 'ofx', $2, $3, $4, $5, $6, $7)`,
      [
        companyId,
        annotated.length,
        saved,
        dupeItems.length,
        batchId,
        req.user?.id || null,
        JSON.stringify({ duplicates_skipped: dupeItems.length }),
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import-ofx] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar extrato OFX', detail: err.message });
  } finally {
    client.release();
  }

  res.status(201).json({
    saved,
    skipped_duplicates: dupeItems.length,
    batch_id: batchId,
  });
});

// ─── GET /import-history ─────────────────────────────────────
// Lista importações anteriores da empresa (últimas 50)

router.get('/import-history', requireAuth, async (req, res) => {
  const companyId = req.params.id;

  try {
    const result = await db.query(
      `SELECT
         id, module, format, total_rows, imported_rows, error_rows,
         batch_id, created_at, reverted_at,
         meta->>'duplicates_skipped' AS duplicates_skipped
       FROM import_logs
       WHERE company_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [companyId]
    );

    res.json({ imports: result.rows });
  } catch (err) {
    console.error('[import-history] error:', err.message);
    res.status(500).json({ error: 'Erro ao listar histórico de importações' });
  }
});

// ─── DELETE /import/:batch_id ─────────────────────────────────
// Desfaz uma importação — soft delete das transações do lote

router.delete('/import/:batch_id', requireAuth, async (req, res) => {
  const { id: companyId, batch_id } = req.params;

  try {
    // Verificar se o lote pertence à empresa e ainda não foi desfeito
    const logRes = await db.query(
      `SELECT id, imported_rows, reverted_at
       FROM import_logs
       WHERE batch_id=$1 AND company_id=$2`,
      [batch_id, companyId]
    );

    if (!logRes.rows[0]) {
      return res.status(404).json({ error: 'Importação não encontrada' });
    }
    if (logRes.rows[0].reverted_at) {
      return res.status(409).json({ error: 'Esta importação já foi desfeita anteriormente' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Deletar as transações do lote (só desta empresa)
      const deleted = await client.query(
        `DELETE FROM transactions
         WHERE import_batch_id=$1 AND company_id=$2`,
        [batch_id, companyId]
      );

      // Marcar o log como revertido
      await client.query(
        `UPDATE import_logs SET reverted_at=NOW() WHERE batch_id=$1 AND company_id=$2`,
        [batch_id, companyId]
      );

      await client.query('COMMIT');

      res.json({
        reverted:   true,
        batch_id,
        deleted_count: deleted.rowCount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[import-revert] error:', err.message);
    res.status(500).json({ error: 'Erro ao desfazer importação', detail: err.message });
  }
});

module.exports = router;
