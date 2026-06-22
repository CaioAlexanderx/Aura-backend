// ============================================================
// AURA KARATÊ — Importação em lote de praticantes (Track A)
// POST /federation/:id/practitioners/import            (CSV legado)
// POST /federation/:id/practitioners/import/batch-fpkt (JSON: dojôs + alunos)
//
// CSV legado (handler `handler`):
//   mode=preview → valida e retorna rows+errors sem gravar
//   mode=commit  → grava os praticantes válidos
//   Aceita multipart/form-data (file) ou csv_content.
//
// FPKT batch (handler `batchFpktHandler`): importa a planilha consolidada FPKT
// (abas Academias + Alunos) num fluxo só. Body JSON já normalizado pelo front.
//   upsert "completar o que falta" (COALESCE — nunca sobrescreve dado existente)
//   dojôs:  chave (federation_id, lower(name)); espelha createDojo SEM owner_id
//   alunos: chave (federation_id, karate_registration_number); resolve dojô por nome
//   idempotente por import_batch_id; faixa NÃO entra (sem graduated_at na aba Alunos)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const {
  nextPractitionerRegistrationNumber,
  suggestPractitionerMapping,
  applyMap,
  parseDate,
  parseCSVLine,
} = require('../services/karateService');

// ── Multer (reutiliza padrão do projeto se disponível; fallback raw body) ─
// O projeto usa multer em outros routers. Importamos aqui; se não instalado,
// usamos fallback com body-parser (o app já tem express.json()).
let multer;
try { multer = require('multer'); } catch (_) { multer = null; }

const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }) : null;

// ── Helper: parse CSV string → array de objetos ─────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

// ── Helper: valida e normaliza uma linha de praticante ───────
function validateRow(data, rowIndex) {
  const errors = [];

  if (!data.full_name || !String(data.full_name).trim()) {
    errors.push({ row: rowIndex + 1, field: 'full_name', message: 'Nome obrigatório' });
  }

  const parsedBirth = parseDate(data.birth_date);
  const parsedGrad  = parseDate(data.graduated_at);

  const valid = {
    full_name:     String(data.full_name || '').trim(),
    cpf:           data.cpf || null,
    rg:            data.rg  || null,
    birth_date:    parsedBirth,
    email:         data.email ? String(data.email).toLowerCase() : null,
    phone:         data.phone || null,
    dojo_id:       data.dojo_id || null,
    is_arbiter:    data.is_arbiter === 'true' || data.is_arbiter === '1',
    is_instructor: data.is_instructor === 'true' || data.is_instructor === '1',
    is_examiner:   data.is_examiner === 'true' || data.is_examiner === '1',
    // Dados de faixa histórica (belt_schema=legacy)
    belt_level:    data.belt_level || null,
    belt_name:     data.belt_name  || null,
    graduated_at:  parsedGrad,
  };

  return { valid, errors };
}

// ── Rota principal ────────────────────────────────────────────
const handler = async (req, res) => {
  const federationId = req.params.id;
  const mode = (req.body && req.body.mode) || (req.query && req.query.mode) || 'preview';

  if (!['preview', 'commit'].includes(mode)) {
    return res.status(422).json({ error: 'mode deve ser preview ou commit', code: 'VALIDATION_ERROR' });
  }

  // Verifica federação
  try {
    const fedRes = await db.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }
  } catch (err) {
    console.error('[karateImport] fed check error:', err.message);
    return res.status(500).json({ error: 'Erro ao verificar federação' });
  }

  // Extrai conteúdo CSV
  let csvText = null;
  if (req.file && req.file.buffer) {
    csvText = req.file.buffer.toString('utf-8');
  } else if (req.body && req.body.csv_content) {
    // Fallback: conteúdo enviado como campo de texto (útil em testes)
    csvText = req.body.csv_content;
  }

  if (!csvText || !csvText.trim()) {
    return res.status(422).json({ error: 'Arquivo CSV obrigatório (campo file ou csv_content)', code: 'VALIDATION_ERROR' });
  }

  const { headers, rows: rawRows } = parseCSV(csvText);

  if (!rawRows.length) {
    return res.status(422).json({ error: 'CSV vazio ou sem linhas de dados', code: 'VALIDATION_ERROR' });
  }

  if (rawRows.length > 2000) {
    return res.status(422).json({ error: 'Máximo de 2.000 praticantes por importação', code: 'VALIDATION_ERROR' });
  }

  // Mapeamento de colunas
  let columnMap;
  try {
    const rawMap = req.body && req.body.column_map;
    columnMap = rawMap ? JSON.parse(rawMap) : suggestPractitionerMapping(headers);
  } catch (_) {
    columnMap = suggestPractitionerMapping(headers);
  }

  const validRows = [];
  const allErrors = [];

  rawRows.forEach((row, i) => {
    const mapped = applyMap(row, columnMap);
    const { valid, errors } = validateRow(mapped, i);
    if (errors.length > 0) {
      allErrors.push(...errors);
    } else if (valid.full_name) {
      validRows.push(valid);
    }
  });

  if (mode === 'preview') {
    return res.json({
      mode: 'preview',
      total_rows: rawRows.length,
      valid_rows: validRows.length,
      committed: 0,
      errors: allErrors,
    });
  }

  // mode === 'commit'
  if (validRows.length === 0) {
    return res.status(422).json({
      error: 'Nenhum praticante válido para importar',
      mode: 'commit',
      total_rows: rawRows.length,
      valid_rows: 0,
      committed: 0,
      errors: allErrors,
    });
  }

  const client = await db.connect();
  let committed = 0;

  try {
    await client.query('BEGIN');

    for (const p of validRows) {
      // Gera número de registro para cada praticante
      const regNumber = await nextPractitionerRegistrationNumber(client, federationId);

      // Resolve dojo_id: usa o informado ou null
      const dojoId = p.dojo_id || null;

      const insertRes = await client.query(
        `INSERT INTO customers
           (company_id, name, cpf_cnpj, rg, birth_date, email, phone,
            is_student, federation_id, dojo_id,
            is_arbiter, is_instructor, is_examiner,
            karate_registration_number,
            is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11, $12, $13, true, NOW(), NOW())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          federationId,
          p.full_name,
          p.cpf || null,
          p.rg  || null,
          p.birth_date || null,
          p.email || null,
          p.phone || null,
          federationId,
          dojoId,
          p.is_arbiter,
          p.is_instructor,
          p.is_examiner,
          regNumber,
        ]
      );

      if (!insertRes.rows.length) continue; // conflito — já existia

      const newId = insertRes.rows[0].id;
      committed++;

      // Insere faixa histórica se houver dados
      if (p.belt_level && p.belt_name && p.graduated_at) {
        try {
          await client.query(
            `INSERT INTO karate_belt_history
               (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, created_by)
             VALUES ($1, $2, $3, $4, 'legacy', $5, $6)`,
            [newId, federationId, p.belt_level, p.belt_name, p.graduated_at, req.user ? req.user.id : null]
          );
        } catch (beltErr) {
          // Não aborta o import por erro em belt_history (append-only pode ser difícil em lote)
          console.warn('[karateImport] belt history insert warn:', beltErr.message);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateImport] commit error:', err.message);
    return res.status(500).json({ error: 'Erro ao importar praticantes', detail: err.message });
  } finally {
    client.release();
  }

  res.json({
    mode: 'commit',
    total_rows: rawRows.length,
    valid_rows: validRows.length,
    committed,
    errors: allErrors,
  });
};

// ── Importação FPKT (dojôs + alunos) — JSON ─────────────────────────────────
// Limpa "vazios reais" da base legada: trim + descarta '', 'XX', 'None', '-'.
// Dado ausente é neutro (vira null), NÃO erro.
const cleanCell = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (up === 'XX' || up === 'NONE' || s === '-') return null;
  return s;
};

const batchFpktHandler = async (req, res) => {
  const federationId = req.params.id;
  const body = req.body || {};
  const importBatchId = body.import_batch_id || uuidv4();
  const dojos = Array.isArray(body.dojos) ? body.dojos : [];
  const students = Array.isArray(body.students) ? body.students : [];

  if (!dojos.length && !students.length) {
    return res.status(422).json({ error: 'Envie ao menos dojos[] ou students[]', code: 'VALIDATION_ERROR' });
  }
  if (dojos.length > 500 || students.length > 2000) {
    return res.status(422).json({
      error: 'Lote muito grande (máx 500 dojôs / 2.000 alunos por requisição)',
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  const summary = {
    import_batch_id: importBatchId,
    dojos: { created: 0, updated: 0 },
    students: { created: 0, updated: 0, skipped: 0 },
    skipped_detail: [],
  };

  try {
    await client.query('BEGIN');

    const fedRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    // ── Dojôs (Academias) ──
    for (const d of dojos) {
      const name = cleanCell(d.name);
      if (!name) continue;
      const address = cleanCell(d.address);
      const phone = cleanCell(d.phone);
      const cod = cleanCell(d.cod);
      const fpktId = cod ? `FPKT-${cod.replace(/\D/g, '').padStart(3, '0')}` : null;
      const isActive = d.status === 'active';

      const exists = await client.query(
        `SELECT id FROM companies
         WHERE federation_id = $1 AND vertical = 'karate_dojo' AND lower(name) = lower($2)
         LIMIT 1`,
        [federationId, name]
      );

      if (exists.rows.length) {
        // Completar o que falta — nunca sobrescreve dado já preenchido
        await client.query(
          `UPDATE companies SET
             address = COALESCE(NULLIF(address, ''), $2),
             phone   = COALESCE(NULLIF(phone, ''), $3),
             fpkt_affiliation_id = COALESCE(NULLIF(fpkt_affiliation_id, ''), $4),
             updated_at = NOW()
           WHERE id = $1`,
          [exists.rows[0].id, address, phone, fpktId]
        );
        summary.dojos.updated++;
      } else {
        // Espelha createDojo: SEM owner_id (federação enxerga por federation_id)
        await client.query(
          `INSERT INTO companies
             (name, fpkt_affiliation_id, affiliation_model, address, phone,
              federation_id, vertical, is_active, created_at, updated_at)
           VALUES ($1, $2, 'annual', $3, $4, $5, 'karate_dojo', $6, NOW(), NOW())`,
          [name, fpktId, address, phone, federationId, isActive]
        );
        summary.dojos.created++;
      }
    }

    // Mapa nome→id de TODOS os dojôs da federação (resolve alunos entre lotes)
    const dojoMapRes = await client.query(
      `SELECT id, lower(name) AS lname FROM companies
       WHERE federation_id = $1 AND vertical = 'karate_dojo'`,
      [federationId]
    );
    const dojoMap = new Map(dojoMapRes.rows.map(r => [r.lname, r.id]));

    // ── Alunos ──
    for (const s of students) {
      const reg = cleanCell(s.registration_number);
      const name = cleanCell(s.name);
      if (!reg || !name) {
        summary.students.skipped++;
        if (summary.skipped_detail.length < 50) {
          summary.skipped_detail.push({
            name: name || null,
            registration_number: reg || null,
            reason: !reg ? 'sem Número FPKT (chave)' : 'sem nome',
          });
        }
        continue;
      }
      const academia = cleanCell(s.academia_name);
      const dojoId = academia ? (dojoMap.get(academia.toLowerCase()) || null) : null;

      const f = {
        cpf_cnpj:     cleanCell(s.cpf),
        rg:           cleanCell(s.rg),
        birth_date:   cleanCell(s.birth_date), // ISO (YYYY-MM-DD) ou null — normalizado no front
        email:        cleanCell(s.email),
        phone:        cleanCell(s.phone),
        street:       cleanCell(s.street),
        number:       cleanCell(s.number),
        neighborhood: cleanCell(s.neighborhood),
        city:         cleanCell(s.city),
        state:        cleanCell(s.state),
        zip_code:     cleanCell(s.zip_code),
      };

      const exists = await client.query(
        `SELECT id FROM customers
         WHERE federation_id = $1 AND karate_registration_number = $2 LIMIT 1`,
        [federationId, reg]
      );

      if (exists.rows.length) {
        await client.query(
          `UPDATE customers SET
             cpf_cnpj     = COALESCE(NULLIF(cpf_cnpj, ''), $2),
             rg           = COALESCE(NULLIF(rg, ''), $3),
             birth_date   = COALESCE(birth_date, $4),
             email        = COALESCE(NULLIF(email, ''), $5),
             phone        = COALESCE(NULLIF(phone, ''), $6),
             street       = COALESCE(NULLIF(street, ''), $7),
             number       = COALESCE(NULLIF(number, ''), $8),
             neighborhood = COALESCE(NULLIF(neighborhood, ''), $9),
             city         = COALESCE(NULLIF(city, ''), $10),
             state        = COALESCE(NULLIF(state, ''), $11),
             zip_code     = COALESCE(NULLIF(zip_code, ''), $12),
             dojo_id      = COALESCE(dojo_id, $13),
             import_batch_id = COALESCE(import_batch_id, $14),
             updated_at = NOW()
           WHERE id = $1`,
          [exists.rows[0].id, f.cpf_cnpj, f.rg, f.birth_date, f.email, f.phone,
           f.street, f.number, f.neighborhood, f.city, f.state, f.zip_code,
           dojoId, importBatchId]
        );
        summary.students.updated++;
      } else {
        await client.query(
          `INSERT INTO customers
             (company_id, name, cpf_cnpj, rg, birth_date, email, phone,
              is_student, federation_id, dojo_id, karate_registration_number,
              street, number, neighborhood, city, state, zip_code,
              import_batch_id, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10,
                   $11, $12, $13, $14, $15, $16, $17, true, NOW(), NOW())`,
          [federationId, name, f.cpf_cnpj, f.rg, f.birth_date, f.email, f.phone,
           federationId, dojoId, reg,
           f.street, f.number, f.neighborhood, f.city, f.state, f.zip_code,
           importBatchId]
        );
        summary.students.created++;
      }
    }

    await client.query('COMMIT');
    res.json(summary);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[karateImport] batch-fpkt error:', err.message);
    res.status(500).json({ error: 'Erro na importação FPKT', detail: err.message, ...summary });
  } finally {
    client.release();
  }
};

// Monta a rota com ou sem multer
if (upload) {
  router.post('/', ...guards.staffWrite(), upload.single('file'), handler);
} else {
  router.post('/', ...guards.staffWrite(), handler);
}

// Importação FPKT em lote (JSON) — não usa multer
router.post('/batch-fpkt', ...guards.staffWrite(), batchFpktHandler);

module.exports = router;
