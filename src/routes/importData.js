// ============================================================
// AURA. — Importação de Dados
// Features: BE-28b/c (CSV/TSV + mapeador), BE-28d (NF-e XML),
//           BE-28e (histórico + desfazer)
// ============================================================
// Endpoints:
//   POST /companies/:id/customers/import
//     Body: { rows: [...], column_map: {...}, dry_run?: bool }
//
//   POST /companies/:id/products/import
//     Body: { rows: [...], column_map: {...}, dry_run?: bool }
//
//   POST /companies/:id/products/import-nfe
//     Body: { xml_content: '<string do arquivo .xml>' }
//     Query: ?save=true → confirma e salva
//
//   GET  /companies/:id/imports
//     Query: ?module=customers|products|transactions
//
//   DELETE /companies/:id/imports/:batch_id
//     Desfaz uma importação (deleta registros do lote)
//
// Convenção de rows (BE-28b/c):
//   O frontend usa papaparse para converter CSV/TSV em array de objetos
//   e envia column_map para indicar como as colunas da planilha mapeiam
//   para os campos da Aura.
//   Ex: column_map = { "Nome Completo": "name", "Fone": "phone" }
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// ─── Mapeamento de colunas — fuzzy match ────────────────────
// Sugere automaticamente qual campo da Aura corresponde ao header da planilha

const CUSTOMER_FIELDS = {
  name:             ['nome', 'name', 'cliente', 'customer', 'razao social', 'razão social'],
  phone:            ['telefone', 'phone', 'fone', 'celular', 'whatsapp', 'tel'],
  email:            ['email', 'e-mail', 'mail'],
  cpf_cnpj:         ['cpf', 'cnpj', 'cpf/cnpj', 'documento', 'doc'],
  birth_date:       ['nascimento', 'data nascimento', 'aniversario', 'birthday', 'birth_date', 'dt nasc'],
  instagram_handle: ['instagram', 'insta', '@'],
  street:           ['rua', 'endereco', 'endereço', 'logradouro', 'street'],
  city:             ['cidade', 'city'],
  state:            ['estado', 'uf', 'state'],
  zip_code:         ['cep', 'zip', 'postal'],
  notes:            ['observacao', 'observação', 'obs', 'notas', 'notes'],
};

// IMPORTANTE: cost_price DEVE vir antes de price para evitar que o alias
// generico 'preco' capture "Preco de custo (R$)" antes de cost_price ser testado.
// A funcao suggestMapping usa o primeiro match encontrado na ordem de iteracao.
const PRODUCT_FIELDS = {
  cost_price: ['preco de custo', 'preco custo', 'preço custo', 'custo', 'cost', 'cost_price', 'valor custo', 'preco de custo (r$)'],
  name:       ['nome do produto', 'nome', 'produto', 'name', 'descricao', 'descrição', 'description', 'item'],
  price:      ['preco de venda', 'preco venda', 'preço de venda', 'price', 'valor venda', 'valor', 'preco de venda (r$)'],
  stock_qty:  ['estoque atual', 'estoque', 'quantidade', 'qty', 'stock', 'qtd', 'saldo'],
  stock_min:  ['estoque minimo', 'estoque mínimo', 'min', 'minimo', 'stock_min'],
  barcode:    ['codigo de barras', 'codigo barras', 'código barras', 'ean', 'barcode', 'gtin', 'codigo de barras (ean)'],
  sku:        ['sku / codigo interno', 'sku', 'referencia', 'referência', 'cod interno', 'codigo interno'],
  category:   ['categoria', 'category', 'grupo', 'tipo'],
  color:      ['cor', 'color', 'cores'],
  size:       ['tamanho', 'tam', 'grade', 'size'],
  unit:       ['unidade', 'un', 'unit', 'medida'],
  description:['descricao longa', 'descrição longa', 'detalhes', 'observacoes', 'observações'],
  ncm:        ['ncm', 'ncm produto'],
};

function suggestMapping(headers, fieldDefs) {
  const map = {};
  for (const header of headers) {
    const normalized = header.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos
    for (const [field, aliases] of Object.entries(fieldDefs)) {
      if (aliases.some(a => normalized === a || normalized.startsWith(a + " ") || normalized.startsWith(a + "(") || normalized.endsWith(" " + a) || (a.length >= 4 && normalized.includes(a)))) {
        if (!map[header]) map[header] = field;
      }
    }
  }
  return map;
}

// ─── Helpers ─────────────────────────────────────────────────

function parseBRL(value) {
  if (!value) return null;
  let clean = String(value).replace(/[R$\s]/g, '').trim();
  if (!clean) return null;
  // Both dot and comma present: Brazilian format (1.234,56)
  if (clean.includes(',') && clean.includes('.')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
    // Comma only: comma is decimal (49,90)
    clean = clean.replace(',', '.');
  }
  // Dot only: dot is decimal (49.90) - leave as-is
  const n = parseFloat(clean);
  return isNaN(n) || n < 0 ? null : n;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  // DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${m}-${d}`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [d, m, y] = s.split('-');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function applyMap(row, columnMap) {
  const mapped = {};
  for (const [header, field] of Object.entries(columnMap)) {
    if (field && row[header] !== undefined) {
      mapped[field] = String(row[header] || '').trim();
    }
  }
  return mapped;
}

// ─── POST /customers/import ───────────────────────────────────
// BE-28b/c: Importar clientes via CSV/planilha
// Body: { rows: [{...}], column_map: {"Col planilha": "field"}, dry_run?: bool }
// Se column_map for omitido, tenta sugestão automática a partir dos headers da 1ª row

router.post('/customers/import', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const { rows, column_map, dry_run = false } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Campo rows é obrigatório e deve ser um array não-vazio' });
  }
  if (rows.length > 2000) {
    return res.status(400).json({ error: 'Máximo de 2.000 clientes por importação' });
  }

  // Inferir mapeamento se não fornecido
  const headers = Object.keys(rows[0]);
  const map = column_map && Object.keys(column_map).length > 0
    ? column_map
    : suggestMapping(headers, CUSTOMER_FIELDS);

  // Validar e transformar
  const valid = [], errors = [];

  rows.forEach((row, i) => {
    const data = applyMap(row, map);

    if (!data.name || data.name.length === 0) {
      errors.push({ index: i, error: 'Nome obrigatório', row });
      return;
    }
    if (!data.phone && !data.email) {
      errors.push({ index: i, error: 'Telefone ou e-mail obrigatório', row });
      return;
    }

    valid.push({
      name:             data.name,
      phone:            data.phone || null,
      email:            data.email ? data.email.toLowerCase() : null,
      cpf_cnpj:         data.cpf_cnpj || null,
      birth_date:       parseDate(data.birth_date),
      instagram_handle: data.instagram_handle ? data.instagram_handle.replace('@', '') : null,
      street:           data.street || null,
      city:             data.city   || null,
      state:            data.state  ? data.state.substring(0, 2).toUpperCase() : null,
      zip_code:         data.zip_code || null,
      notes:            data.notes || null,
    });
  });

  if (dry_run) {
    return res.json({
      dry_run:      true,
      total:        rows.length,
      valid:        valid.length,
      error_count:  errors.length,
      suggested_map: map,
      errors,
      preview:      valid.slice(0, 5),
    });
  }

  if (valid.length === 0) {
    return res.status(422).json({
      error: 'Nenhum cliente válido para importar',
      error_count: errors.length,
      errors,
    });
  }

  const batchId = uuidv4();
  let saved = 0, dupes = 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const c of valid) {
      // Deduplicação por CPF/CNPJ (se presente) ou por nome+telefone
      let existing = null;
      if (c.cpf_cnpj) {
        const r = await client.query(
          `SELECT id FROM customers WHERE company_id=$1 AND cpf_cnpj=$2 LIMIT 1`,
          [companyId, c.cpf_cnpj]
        );
        existing = r.rows[0];
      }
      if (!existing && c.name && c.phone) {
        const r = await client.query(
          `SELECT id FROM customers WHERE company_id=$1 AND name=$2 AND phone=$3 LIMIT 1`,
          [companyId, c.name, c.phone]
        );
        existing = r.rows[0];
      }

      if (existing) { dupes++; continue; }

      await client.query(
        `INSERT INTO customers
           (company_id, name, phone, email, cpf_cnpj, birth_date,
            instagram_handle, street, city, state, zip_code, notes,
            import_batch_id, total_purchases, total_spent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,0)`,
        [
          companyId, c.name, c.phone, c.email, c.cpf_cnpj, c.birth_date,
          c.instagram_handle, c.street, c.city, c.state, c.zip_code, c.notes,
          batchId,
        ]
      );
      saved++;
    }

    await client.query(
      `INSERT INTO import_logs
         (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta)
       VALUES ($1,'customers','csv',$2,$3,$4,$5,$6,$7)`,
      [companyId, rows.length, saved, errors.length, batchId, req.user?.id || null,
       JSON.stringify({ duplicates_skipped: dupes, column_map: map })]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import-customers] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar clientes', detail: err.message });
  } finally {
    client.release();
  }

  res.status(201).json({
    saved,
    duplicates_skipped: dupes,
    error_count: errors.length,
    batch_id: batchId,
    errors: errors.slice(0, 20), // max 20 erros no response
  });
});

// ─── POST /products/import ────────────────────────────────────
// BE-28b/c: Importar produtos via CSV/planilha

router.post('/products/import', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const { rows, column_map, dry_run = false } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Campo rows é obrigatório e deve ser um array não-vazio' });
  }
  if (rows.length > 5000) {
    return res.status(400).json({ error: 'Máximo de 5.000 produtos por importação' });
  }

  const headers = Object.keys(rows[0]);
  const map = column_map && Object.keys(column_map).length > 0
    ? column_map
    : suggestMapping(headers, PRODUCT_FIELDS);

  const valid = [], errors = [];

  rows.forEach((row, i) => {
    const data = applyMap(row, map);

    if (!data.name || data.name.length === 0) {
      errors.push({ index: i, error: 'Nome do produto obrigatório', row });
      return;
    }

    const price = parseBRL(data.price);
    if (price === null || price < 0) {
      errors.push({ index: i, error: 'Preço de venda inválido ou ausente', row });
      return;
    }

    valid.push({
      name:        data.name,
      price,
      cost_price:  parseBRL(data.cost_price),
      stock_qty:   parseFloat(data.stock_qty) || 0,
      stock_min:   parseFloat(data.stock_min) || null,
      barcode:     data.barcode || null,
      sku:         data.sku     || null,
      category:    data.category || null,
      color:       data.color    || null,
      size:        data.size     || null,
      unit:        data.unit     || 'un',
      description: data.description || null,
      ncm:         data.ncm || null,
    });
  });

  if (dry_run) {
    return res.json({
      dry_run:       true,
      total:         rows.length,
      valid:         valid.length,
      error_count:   errors.length,
      suggested_map: map,
      errors,
      preview:       valid.slice(0, 5),
    });
  }

  if (valid.length === 0) {
    return res.status(422).json({
      error: 'Nenhum produto válido para importar',
      error_count: errors.length,
      errors,
    });
  }

  const batchId = uuidv4();
  let saved = 0, dupes = 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const p of valid) {
      // Deduplicação por código de barras (EAN) ou SKU ou por nome normalizado
      let existing = null;
      if (p.barcode) {
        const r = await client.query(
          `SELECT id FROM products WHERE company_id=$1 AND barcode=$2 LIMIT 1`,
          [companyId, p.barcode]
        );
        existing = r.rows[0];
      }
      if (!existing && p.sku) {
        const r = await client.query(
          `SELECT id FROM products WHERE company_id=$1 AND sku=$2 LIMIT 1`,
          [companyId, p.sku]
        );
        existing = r.rows[0];
      }
      if (!existing) {
        const r = await client.query(
          `SELECT id FROM products WHERE company_id=$1 AND lower(name)=lower($2) LIMIT 1`,
          [companyId, p.name]
        );
        existing = r.rows[0];
      }

      if (existing) { dupes++; continue; }

      await client.query(
        `INSERT INTO products
           (company_id, name, price, cost_price, stock_qty, stock_min,
            barcode, sku, category, color, size, unit, description, ncm, import_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          companyId, p.name, p.price, p.cost_price, p.stock_qty, p.stock_min,
          p.barcode, p.sku, p.category, p.color, p.size, p.unit,
          p.description, p.ncm, batchId,
        ]
      );
      saved++;
    }

    await client.query(
      `INSERT INTO import_logs
         (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta)
       VALUES ($1,'products','csv',$2,$3,$4,$5,$6,$7)`,
      [companyId, rows.length, saved, errors.length, batchId, req.user?.id || null,
       JSON.stringify({ duplicates_skipped: dupes, column_map: map })]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import-products] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar produtos', detail: err.message });
  } finally {
    client.release();
  }

  res.status(201).json({
    saved,
    duplicates_skipped: dupes,
    error_count: errors.length,
    batch_id: batchId,
    errors: errors.slice(0, 20),
  });
});

// ─── Parser NF-e XML nativo ───────────────────────────────────
// Extrai produtos do XML de NF-e de compra emitido pelo fornecedor
// Estrutura SEFAZ: <NFe><infNFe><det><prod>...</prod></det></infNFe></NFe>

function parseNFeXML(xml) {
  const result = { products: [], nfe_info: {} };

  const getTag = (content, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(content);
    return m ? m[1].trim() : null;
  };

  // Dados da nota
  result.nfe_info = {
    numero:       getTag(xml, 'nNF'),
    serie:        getTag(xml, 'serie'),
    data_emissao: getTag(xml, 'dhEmi') || getTag(xml, 'dEmi'),
    cnpj_emitente: null,
    nome_emitente: null,
    valor_total:  null,
  };

  // Emitente (fornecedor)
  const emitMatch = /<emit>([\s\S]*?)<\/emit>/i.exec(xml);
  if (emitMatch) {
    result.nfe_info.cnpj_emitente = getTag(emitMatch[1], 'CNPJ');
    result.nfe_info.nome_emitente = getTag(emitMatch[1], 'xNome');
  }

  // Valor total
  const totalMatch = /<ICMSTot>([\s\S]*?)<\/ICMSTot>/i.exec(xml);
  if (totalMatch) {
    result.nfe_info.valor_total = parseFloat(getTag(totalMatch[1], 'vNF') || '0');
  }

  // Itens da nota — cada <det nItem="N">
  const detRegex = /<det[^>]*>([\s\S]*?)<\/det>/gi;
  let detMatch;

  while ((detMatch = detRegex.exec(xml)) !== null) {
    const det = detMatch[1];
    const prodMatch = /<prod>([\s\S]*?)<\/prod>/i.exec(det);
    if (!prodMatch) continue;
    const prod = prodMatch[1];

    const name       = getTag(prod, 'xProd');
    const ncm        = getTag(prod, 'NCM');
    const barcode    = getTag(prod, 'cEAN');
    const unit       = getTag(prod, 'uCom') || getTag(prod, 'uTrib');
    const qty        = parseFloat(getTag(prod, 'qCom') || getTag(prod, 'qTrib') || '0');
    const unitCost   = parseFloat(getTag(prod, 'vUnCom') || getTag(prod, 'vUnTrib') || '0');
    const sku        = getTag(prod, 'cProd');

    if (!name || qty <= 0) continue;

    result.products.push({
      name,
      ncm:          ncm && ncm !== '0' ? ncm : null,
      barcode:      barcode && barcode !== '0' && barcode !== 'SEM GTIN' ? barcode : null,
      sku:          sku || null,
      unit:         unit ? unit.toLowerCase() : 'un',
      stock_qty:    qty,
      cost_price:   unitCost > 0 ? unitCost : null,
      price:        unitCost > 0 ? Math.ceil(unitCost * 1.3 * 100) / 100 : 0, // sugestão: 30% de margem
      supplier_cnpj: result.nfe_info.cnpj_emitente,
      // price é sugestão — front-end pede confirmação antes de salvar
      _price_is_suggestion: true,
    });
  }

  return result;
}

// ─── POST /products/import-nfe ────────────────────────────────
// BE-28d: Criar estoque a partir de NF-e XML de compra
// Fase 1 (preview): POST sem ?save=true → parseia e retorna
// Fase 2 (salvar):  POST com ?save=true → body inclui produtos com price confirmado

router.post('/products/import-nfe', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const save      = req.query.save === 'true';
  const { xml_content, products: confirmedProducts } = req.body;

  if (!xml_content || typeof xml_content !== 'string') {
    return res.status(400).json({ error: 'Campo xml_content é obrigatório (conteúdo do arquivo .xml da NF-e)' });
  }

  // Parsear XML
  let parsed;
  try {
    parsed = parseNFeXML(xml_content);
  } catch (err) {
    return res.status(422).json({ error: 'Arquivo XML inválido ou não é uma NF-e', detail: err.message });
  }

  if (parsed.products.length === 0) {
    return res.status(422).json({ error: 'Nenhum produto encontrado no XML da NF-e' });
  }

  // Preview
  if (!save) {
    return res.json({
      preview:    true,
      nfe_info:   parsed.nfe_info,
      products:   parsed.products,
      total_items: parsed.products.length,
    });
  }

  // Salvar — usa confirmedProducts (com preço de venda confirmado pelo cliente)
  const toSave = Array.isArray(confirmedProducts) && confirmedProducts.length > 0
    ? confirmedProducts
    : parsed.products;

  const batchId = uuidv4();
  let saved = 0, dupes = 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const p of toSave) {
      if (!p.name) continue;

      // Deduplicação por EAN ou nome
      let existing = null;
      if (p.barcode) {
        const r = await client.query(
          `SELECT id FROM products WHERE company_id=$1 AND barcode=$2 LIMIT 1`,
          [companyId, p.barcode]
        );
        existing = r.rows[0];
      }
      if (!existing) {
        const r = await client.query(
          `SELECT id FROM products WHERE company_id=$1 AND lower(name)=lower($2) LIMIT 1`,
          [companyId, p.name]
        );
        existing = r.rows[0];
        // Produto já existe — atualizar estoque e custo
        if (existing) {
          await client.query(
            `UPDATE products SET
               stock_qty = stock_qty + $1,
               cost_price = $2,
               updated_at = NOW()
             WHERE id = $3`,
            [p.stock_qty || 0, p.cost_price || null, existing.id]
          );
          dupes++;
          continue;
        }
      }

      if (existing) { dupes++; continue; }

      const price = parseFloat(p.price) || 0;
      if (price <= 0) continue; // requer preço confirmado

      await client.query(
        `INSERT INTO products
           (company_id, name, price, cost_price, stock_qty,
            barcode, sku, unit, ncm, supplier_cnpj, import_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          companyId, p.name, price, p.cost_price || null, p.stock_qty || 0,
          p.barcode || null, p.sku || null, p.unit || 'un',
          p.ncm || null, p.supplier_cnpj || null, batchId,
        ]
      );
      saved++;
    }

    // Registrar despesa da nota (opcional — só se valor_total disponível no body)
    if (req.body.create_expense && parsed.nfe_info.valor_total > 0) {
      const dataEmissao = parsed.nfe_info.data_emissao
        ? parsed.nfe_info.data_emissao.substring(0, 10)
        : new Date().toISOString().substring(0, 10);

      await client.query(
        `INSERT INTO transactions
           (company_id, type, amount, description, category, due_date, status, import_batch_id, created_by)
         VALUES ($1,'expense',$2,$3,'purchase',$4,'paid',$5,$6)`,
        [
          companyId,
          parsed.nfe_info.valor_total,
          `NF-e ${parsed.nfe_info.numero || ''}${parsed.nfe_info.nome_emitente ? ' — ' + parsed.nfe_info.nome_emitente : ''}`.trim(),
          dataEmissao,
          batchId,
          req.user?.id || null,
        ]
      );
    }

    await client.query(
      `INSERT INTO import_logs
         (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta)
       VALUES ($1,'products','nfe_xml',$2,$3,$4,$5,$6,$7)`,
      [
        companyId,
        parsed.products.length, saved, 0, batchId, req.user?.id || null,
        JSON.stringify({
          nfe_numero:     parsed.nfe_info.numero,
          nfe_emitente:   parsed.nfe_info.nome_emitente,
          nfe_cnpj:       parsed.nfe_info.cnpj_emitente,
          stock_updated:  dupes,
        }),
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import-nfe] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar produtos da NF-e', detail: err.message });
  } finally {
    client.release();
  }

  res.status(201).json({
    saved,
    stock_updated: dupes, // produtos existentes que tiveram estoque/custo atualizado
    batch_id: batchId,
    nfe_info: parsed.nfe_info,
  });
});

// ─── GET /imports ─────────────────────────────────────────────
// BE-28e: Histórico de importações (todas as módulos)

router.get('/imports', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const { module } = req.query;

  try {
    let query = `
      SELECT
        id, module, format, total_rows, imported_rows, error_rows,
        batch_id, created_at, reverted_at, meta
      FROM import_logs
      WHERE company_id=$1`;
    const params = [companyId];

    if (module) {
      query += ` AND module=$2`;
      params.push(module);
    }

    query += ` ORDER BY created_at DESC LIMIT 100`;

    const result = await db.query(query, params);
    res.json({ imports: result.rows });
  } catch (err) {
    console.error('[imports-history] error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar histórico de importações' });
  }
});

// ─── DELETE /imports/:batch_id ────────────────────────────────
// BE-28e: Desfaz uma importação — deleta registros do lote

router.delete('/imports/:batch_id', requireAuth, async (req, res) => {
  const { id: companyId, batch_id } = req.params;

  try {
    const logRes = await db.query(
      `SELECT module, imported_rows, reverted_at
       FROM import_logs WHERE batch_id=$1 AND company_id=$2`,
      [batch_id, companyId]
    );

    if (!logRes.rows[0]) {
      return res.status(404).json({ error: 'Importação não encontrada' });
    }
    if (logRes.rows[0].reverted_at) {
      return res.status(409).json({ error: 'Esta importação já foi desfeita' });
    }

    const { module } = logRes.rows[0];
    const tableMap = {
      customers:    'customers',
      products:     'products',
      transactions: 'transactions',
    };

    const table = tableMap[module];
    if (!table) {
      return res.status(400).json({ error: `Módulo '${module}' não suporta desfazer` });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const deleted = await client.query(
        `DELETE FROM ${table} WHERE import_batch_id=$1 AND company_id=$2`,
        [batch_id, companyId]
      );

      await client.query(
        `UPDATE import_logs SET reverted_at=NOW() WHERE batch_id=$1 AND company_id=$2`,
        [batch_id, companyId]
      );

      await client.query('COMMIT');

      res.json({
        reverted:      true,
        batch_id,
        module,
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

// ─── GET /import-templates/:type ─────────────────────────────
// Retorna os campos esperados para download de templates
// (os arquivos CSV reais ficam no site estático)

router.get('/import-templates/:type', requireAuth, (req, res) => {
  const templates = {
    customers: {
      filename: 'modelo-importacao-clientes.csv',
      fields: ['nome', 'telefone', 'email', 'cpf_cnpj', 'data_nascimento', 'instagram', 'rua', 'cidade', 'estado', 'cep'],
      required: ['nome'],
      required_one_of: [['telefone', 'email']],
      example_rows: [
        ['Maria Silva', '12991234567', 'maria@email.com', '123.456.789-00', '15/08/1985', '@mariasilva', 'Rua das Flores, 123', 'Jacareí', 'SP', '12300-000'],
        ['Restaurante Bom Sabor', '1233334444', 'contato@bomsabor.com.br', '12.345.678/0001-90', '', '', 'Av. Central, 456', 'Jacareí', 'SP', '12301-000'],
      ],
    },
    products: {
      filename: 'modelo-importacao-produtos.csv',
      fields: ['nome do produto', 'preco de venda (r$)', 'preco de custo (r$)', 'estoque atual', 'estoque minimo', 'codigo de barras (ean)', 'sku / codigo interno', 'categoria', 'cor', 'tamanho', 'unidade'],
      required: ['nome do produto', 'preco de venda (r$)'],
      example_rows: [
        ['Camiseta Azul M', '79.90', '35.00', '50', '10', '7891234567890', 'CAM-AZM', 'Vestuário', '#0000FF', 'M', 'un'],
        ['Vestido Temis', '185.00', '', '4', '', '3125580047102', '18345775', 'Vestido', '#000000', 'U', 'un'],
      ],
    },
  };

  const tpl = templates[req.params.type];
  if (!tpl) {
    return res.status(404).json({ error: 'Template não encontrado. Use: customers ou products' });
  }

  res.json(tpl);
});

module.exports = router;
