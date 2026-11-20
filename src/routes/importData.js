// ============================================================
// AURA. — Importacao de Dados
// Features: BE-28b/c (CSV/TSV + mapeador), BE-28d (NF-e XML),
//           BE-28e (historico + desfazer)
// ============================================================
// FIX products/import: substituiu inserts linha-a-linha por:
//   1. Dedup dentro do proprio batch (barcode; nome + unidade + marca)
//   2. Lookup de existentes em 2 queries com ANY()
//   3. Bulk INSERT em chunks de 100 com ON CONFLICT DO NOTHING
// Isso reduz de ~4.000 queries individuais para ~14 queries
// numa importacao de 1.200 produtos, eliminando o timeout.
//
// 11/05/2026: cap do customers/import baixado de 2000 -> 1000
// para alinhar com o limite do plano Essencial (clientes basico
// movido pro Essencial em 11/05). Importacao continua aberta
// para todos os planos. Negocio/Expansao tem cap de 1000 por
// batch tambem -- multiplos batches sao suportados via batch_id.
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { linkImportedCategories } = require('../services/importCategoryLink');
const { findOrCreateSupplierByCnpj } = require('../services/supplierLookup');
const { avancarSemEsperar } = require('../services/onboardingProgress');
const { gravarUltimaCompra, casarNotaComPedidos } = require('../services/matconPurchases');
// t3-05: NCM fora da tabela da Receita so AVISA (ncm_avisos na resposta), nunca bloqueia a importacao.
const { resumirAvisosNcm } = require('../services/ncmTable');
// 17/11/2026 (b-import-grade): linhas do mesmo SKU com cor/tamanho viram
// um produto com variantes, no formato do PUT /variations.
const { montarGrades } = require('../services/importGrade');
const { coerceColorHex, skuSuffixFromAttrs } = require('./productsVariations');
const { proximosCodigos } = require('./productsBarcodeGenerate');
const { companyGroupWhere } = require('../utils/companyGroup');
// 20/11/2026 (B2, "Em qual loja o produto entra"): lojas/estoque_em e D12.
const nasLojas = require('../services/produtoNasLojas');

// ─── Mapeamento de colunas — fuzzy match ────────────────────

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

// FIX: stock_min deve vir ANTES de stock_qty para que 'Estoque minimo'
// case no match exato de stock_min antes de atingir a alias 'estoque'
// de stock_qty via substring includes(). Se stock_qty vier primeiro,
// 'estoque minimo'.includes('estoque') = true → stock_qty mapeado
// duas vezes → applyMap sobrescreve o valor real com string vazia
// → parseFloat('') = NaN → stock_qty = 0 para todos os produtos.
//
// 22/09/2026 — preco no cartao (migration 351). Planilhas de loja trazem
// "VALOR DIN" e "VALOR CART" lado a lado; as duas casavam `price` pelo
// alias 'valor' e a ultima coluna vencia — a loja importava o preco do
// cartao como preco normal. Agora dinheiro/a vista vao pra `price` e
// cartao pra `card_price` (ver FIELD_YIELDS_TO e suggestMapping).
const PRODUCT_FIELDS = {
  cost_price: ['preco de custo', 'preco custo', 'preço custo', 'custo', 'cost', 'cost_price', 'valor custo', 'preco de custo (r$)'],
  name:       ['nome do produto', 'nome', 'produto', 'name', 'descricao', 'descrição', 'description', 'item'],
  card_price: ['preco no cartao', 'preco cartao', 'valor cartao', 'valor cart', 'cartao', 'card_price'],
  price:      ['preco de venda', 'preco venda', 'preço de venda', 'price', 'valor venda', 'valor', 'preco de venda (r$)',
               'valor din', 'valor dinheiro', 'preco a vista', 'a vista', 'preco unitario', 'preco un'],
  stock_min:  ['estoque minimo', 'estoque mínimo', 'min', 'minimo', 'stock_min'],
  stock_qty:  ['estoque atual', 'estoque', 'quantidade', 'qty', 'stock', 'qtd', 'saldo'],
  barcode:    ['codigo de barras', 'codigo barras', 'código barras', 'ean', 'barcode', 'gtin', 'codigo de barras (ean)'],
  sku:        ['sku / codigo interno', 'sku', 'referencia', 'referência', 'cod interno', 'codigo interno'],
  category:   ['categoria', 'category', 'grupo', 'tipo'],
  color:      ['cor', 'color', 'cores'],
  size:       ['tamanho', 'tam', 'grade', 'size'],
  // 22/09/2026 (Matcon): planilha de deposito traz "UNID." e "MARCA".
  // 'unid' (4 letras) tambem casa por substring — "Preço unid." casaria
  // unit; por isso unit cede pra preco/custo (FIELD_YIELDS_TO).
  unit:       ['unidade', 'un', 'unit', 'medida', 'unid', 'unid.', 'und', 'unidade de medida', 'un.'],
  brand:      ['marca', 'fabricante', 'brand'],
  description:['descricao longa', 'descrição longa', 'detalhes', 'observacoes', 'observações'],
  ncm:        ['ncm', 'ncm produto'],
};

// Campo que CEDE para outro quando o cabecalho casa os dois. "Preco venda
// cartao" casa `price` ('preco venda') e `card_price` ('cartao'); cabecalho
// que fala de cartao nunca pode virar o preco normal.
const FIELD_YIELDS_TO = {
  price: ['card_price'],
  // "Preço unitário", "Preço un.", "Custo unitário": e preco, nao unidade.
  unit:  ['price', 'cost_price', 'card_price'],
};

// Alias FRACO: so vale quando nenhum outro cabecalho da planilha casou o
// mesmo campo por um alias normal. Planilha de deposito traz "ITEM" (numero
// da linha / codigo) ao lado de "NOME": os dois casavam `name` e a coluna
// mais a direita vencia no applyMap — com ITEM depois de NOME o produto
// virava o numero da linha. Com NOME presente, ITEM fica sem campo.
const ALIAS_FRACO = {
  name: ['item'],
};

// Forca de um alias contra o cabecalho normalizado: 3 = igual,
// 2 = palavra inteira no comeco/fim, 1 = contido (so alias >= 4 letras),
// 0 = nao casa. Mesmas regras de casamento de antes, agora graduadas.
function aliasScore(normalized, a) {
  if (normalized === a) return 3;
  if (normalized.startsWith(a + ' ') || normalized.startsWith(a + '(') || normalized.endsWith(' ' + a)) return 2;
  if (a.length >= 4 && normalized.includes(a)) return 1;
  return 0;
}

// 22/09/2026: antes ganhava o PRIMEIRO campo (na ordem do objeto) que
// casasse qualquer alias — "VALOR CART" caia em `price` pelo 'valor'
// antes de chegar em `card_price`. Agora ganha o casamento mais
// especifico: maior forca e, empatado, alias mais longo; empate total
// fica com a ordem do objeto (o comportamento antigo).
function suggestMapping(headers, fieldDefs) {
  const map = {};
  const fraco = {}; // header -> true quando venceu so por alias fraco
  for (const header of headers) {
    const normalized = header.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const candidatos = [];
    for (const [field, aliases] of Object.entries(fieldDefs)) {
      let melhor = null;
      for (const a of aliases) {
        const score = aliasScore(normalized, a);
        if (score && (!melhor || score > melhor.score || (score === melhor.score && a.length > melhor.len))) {
          melhor = { score, len: a.length, alias: a };
        }
      }
      if (melhor) candidatos.push({ field, ...melhor });
    }
    const casados = new Set(candidatos.map(c => c.field));
    let vencedor = null;
    for (const c of candidatos) {
      if ((FIELD_YIELDS_TO[c.field] || []).some(f => casados.has(f))) continue;
      if (!vencedor || c.score > vencedor.score || (c.score === vencedor.score && c.len > vencedor.len)) vencedor = c;
    }
    if (vencedor) {
      map[header] = vencedor.field;
      if ((ALIAS_FRACO[vencedor.field] || []).includes(vencedor.alias)) fraco[header] = true;
    }
  }
  for (const header of Object.keys(fraco)) {
    const field = map[header];
    const temForte = Object.keys(map).some(h => h !== header && map[h] === field && !fraco[h]);
    if (temForte) delete map[header];
  }
  return map;
}

// ─── Helpers ─────────────────────────────────────────────────

function parseBRL(value) {
  if (!value) return null;
  let clean = String(value).replace(/[R$\s]/g, '').trim();
  if (!clean) return null;
  if (clean.includes(',') && clean.includes('.')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
    clean = clean.replace(',', '.');
  }
  const n = parseFloat(clean);
  return isNaN(n) || n < 0 ? null : n;
}

// 22/09/2026 (Matcon): quantidade de estoque em formato BR. Antes era
// parseFloat — "1,5" virava 1 e "1.234,5" virava 1,234. Aceita "1,5",
// "1.234,5", "1,234.5" (o separador mais a direita e o decimal), "1.5",
// numero puro e sujeira depois do numero ("10 un", como o parseFloat
// aceitava). Negativo passa (estoque vendido a descoberto existia antes).
// 3 casas: products.stock_qty/stock_min sao NUMERIC(10,3).
function parseQuantidade(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  const m = String(value).replace(/\s/g, '').match(/^(-?)([\d.,]+)/);
  if (!m) return null;
  let s = m[2];
  const virgula = s.lastIndexOf(','), ponto = s.lastIndexOf('.');
  if (virgula >= 0 && ponto >= 0) {
    const decimal = virgula > ponto ? ',' : '.';
    const milhar = decimal === ',' ? '.' : ',';
    s = s.split(milhar).join('').replace(decimal, '.');
  } else if (virgula >= 0) {
    s = s.split(',').length > 2 ? s.split(',').join('') : s.replace(',', '.');
  } else if (s.split('.').length > 2) {
    s = s.split('.').join('');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((m[1] ? -n : n) * 1000) / 1000;
}

// 23/09/2026 (QA producao): chaveTexto/UNIDADES_IMPORT/resolverUnidadeImport/
// normalizarUnidadeImport/chaveProdutoImport mudaram para
// services/productDedupKey.js -- GET /products/duplicate-groups (banner do
// Estoque) passou a usar a MESMA chave nome+unidade+marca que o import ja
// usava, entao a normalizacao virou codigo compartilhado. Reexportados
// abaixo (mesmos nomes) para nao quebrar quem ja importa daqui.
const {
  chaveTexto,
  UNIDADES_IMPORT,
  resolverUnidadeImport,
  normalizarUnidadeImport,
  chaveProdutoImport,
  chaveSku,
  mesmaPecaNoImport,
} = require('../services/productDedupKey');

// Mesmo tratamento de products.js (sanitizeBrand): trim, null se vazio,
// corte em 120.
function sanitizarMarcaImport(v) {
  return v && String(v).trim() ? String(v).trim().slice(0, 120) : null;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${m}-${d}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [d, m, y] = s.split('-');
    return `${y}-${m}-${d}`;
  }
  return null;
}

// 22/09/2026: duas colunas no mesmo campo (column_map do cliente ou
// sinonimos) — uma celula vazia nao apaga o valor que outra coluna ja
// trouxe. Antes a ultima coluna vencia mesmo vazia.
function applyMap(row, columnMap) {
  const mapped = {};
  for (const [header, field] of Object.entries(columnMap)) {
    if (field && row[header] !== undefined) {
      const valor = String(row[header] || '').trim();
      if (!valor && mapped[field]) continue;
      mapped[field] = valor;
    }
  }
  return mapped;
}

// ─── POST /customers/import ───────────────────────────────────
// 11/05/2026: cap reduzido pra 1000 (alinha com limite Essencial).
// Aberto pra todos os planos -- Essencial usa pra migrar de outra
// plataforma; Negocio/Expansao usa em batches sucessivos.

router.post('/customers/import', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const { rows, column_map, dry_run = false } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Campo rows é obrigatório e deve ser um array não-vazio' });
  }
  if (rows.length > 1000) {
    return res.status(400).json({
      error: 'Máximo de 1.000 clientes por importação. Divida em batches menores se precisar importar mais.',
      max_per_batch: 1000,
    });
  }

  const headers = Object.keys(rows[0]);
  const map = column_map && Object.keys(column_map).length > 0
    ? column_map
    : suggestMapping(headers, CUSTOMER_FIELDS);

  const valid = [], errors = [];

  rows.forEach((row, i) => {
    const data = applyMap(row, map);
    // Unico campo obrigatorio: nome. phone/email sao opcionais — clientes
    // migrando de outras plataformas geralmente vem so com nome.
    const cleanName = (data.name || '').replace(/\s+/g, ' ').trim();
    if (!cleanName) {
      errors.push({ index: i, error: 'Nome obrigatório', row });
      return;
    }
    valid.push({
      name:             cleanName,
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

  // Dedup intra-batch por nome (case-insensitive). Sem isso, um CSV
  // com "Maria" repetido 5 vezes geraria 5 inserts (lookup do banco
  // nao dispara em null=null pra phone). Importacoes nome-only
  // ficariam infladas com duplicatas exatas.
  const seenNames = new Set();

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const c of valid) {
      const nKey = c.name.toLowerCase();
      if (seenNames.has(nKey + '|' + (c.phone || ''))) { dupes++; continue; }
      seenNames.add(nKey + '|' + (c.phone || ''));

      let existing = null;
      if (c.cpf_cnpj) {
        const r = await client.query(
          `SELECT id FROM customers WHERE company_id=$1 AND cpf_cnpj=$2 LIMIT 1`,
          [companyId, c.cpf_cnpj]
        );
        existing = r.rows[0];
      }
      if (!existing && c.name) {
        // Quando phone existe: nome+phone (case-insensitive em nome).
        // Quando nao existe: nome (case-insensitive) + phone IS NULL —
        // em SQL `null = null` retorna unknown/false, entao precisa de
        // comparacao explicita pra dedupar nome-only re-importado.
        const r = c.phone
          ? await client.query(
              `SELECT id FROM customers WHERE company_id=$1 AND lower(name)=lower($2) AND phone=$3 LIMIT 1`,
              [companyId, c.name, c.phone]
            )
          : await client.query(
              `SELECT id FROM customers WHERE company_id=$1 AND lower(name)=lower($2) AND phone IS NULL LIMIT 1`,
              [companyId, c.name]
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
        [companyId, c.name, c.phone, c.email, c.cpf_cnpj, c.birth_date,
         c.instagram_handle, c.street, c.city, c.state, c.zip_code, c.notes, batchId]
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
    errors: errors.slice(0, 20),
  });
});

// ─── POST /products/import ────────────────────────────────────
// FIX: substituiu loop de queries individuais por abordagem em 3 fases:
//   Fase 1 — dedup dentro do batch (barcode; nome + unidade + marca)
//   Fase 2 — lookup de existentes em 2 queries (barcode ANY(); nome/
//            unidade/marca da empresa, chave montada no Node)
//   Fase 3 — bulk INSERT em chunks de 100
// Reduz ~4.000 queries para ~14, eliminando o statement timeout.
//
// LIMITE 02/05/2026: aumentado de 5.000 para 6.000 produtos por
// importação (clientes com catálogo de calçados/vestuário com
// muitas variações de tamanho/cor passam fácil dos 5k).
//
// 20/11/2026 (B2, "Em qual loja o produto entra"):
//   - `lojas` (inclui a loja do caminho) e `estoque_em` opcionais. Depois que
//     a origem gravou, o que entrou vai tambem para as outras lojas marcadas
//     (um produto privado por loja, services/produtoNasLojas.js), cada loja
//     com o SEU lote de importacao (import_logs + import_batch_id): o
//     "desfazer" continua por loja. O estoque da planilha entra em
//     `estoque_em`; as outras lojas nascem com 0. Resposta + `por_loja`.
//     Sem `lojas`: a resposta e o efeito de antes.
//   - D12: loja num grupo de estoque unico cria o produto compartilhado (a
//     regra do POST /products); antes a planilha nascia sempre privada. O
//     INSERT so ganha a coluna is_group_shared nesse caso.

router.post('/products/import', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const { rows, column_map, dry_run = false } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Campo rows é obrigatório e deve ser um array não-vazio' });
  }
  if (rows.length > 6000) {
    return res.status(400).json({ error: 'Máximo de 6.000 produtos por importação' });
  }

  // B2: em quais lojas a planilha entra (ausente = so a loja do caminho)
  let pedidoLojas = null;
  try {
    pedidoLojas = nasLojas.lerLojasDoLote(req.body, companyId);
  } catch (e) {
    if (e instanceof nasLojas.ErroDeLojas) return res.status(e.status).json(e.body);
    throw e;
  }

  const headers = Object.keys(rows[0]);
  const map = column_map && Object.keys(column_map).length > 0
    ? column_map
    : suggestMapping(headers, PRODUCT_FIELDS);

  const valid = [], errors = [];
  // Linha da planilha (indice em `rows`) de cada item de `valid` — o
  // relatorio de duplicatas aponta a linha que o front mostra.
  const linhaDe = [];
  // Unidade fora do mapa: gravada em minusculas como veio, e contada aqui
  // para o front avisar (valor gravado -> quantas linhas).
  const unidadesDesconhecidas = new Map();

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
    // Preco no cartao (351): opcional, mesmo parse do custo. Vazio, zero ou
    // invalido = null (segue o % da loja) — nao derruba a linha.
    const cardPrice = parseBRL(data.card_price);
    const unidade = resolverUnidadeImport(data.unit);
    if (!unidade.conhecida) {
      unidadesDesconhecidas.set(unidade.unit, (unidadesDesconhecidas.get(unidade.unit) || 0) + 1);
    }
    const stockQty = parseQuantidade(data.stock_qty);
    const stockMin = parseQuantidade(data.stock_min);
    linhaDe.push(i);
    valid.push({
      name:        data.name,
      price,
      card_price:  cardPrice > 0 ? Math.round(cardPrice * 100) / 100 : null,
      cost_price:  parseBRL(data.cost_price),
      stock_qty:   stockQty === null ? 0 : stockQty,
      stock_min:   stockMin || null,
      barcode:     data.barcode || null,
      sku:         data.sku     || null,
      category:    data.category || null,
      color:       data.color    || null,
      size:        data.size     || null,
      unit:        unidade.unit,
      brand:       sanitizarMarcaImport(data.brand),
      description: data.description || null,
      ncm:         data.ncm || null,
    });
  });

  const resumoUnidades = {
    total:   [...unidadesDesconhecidas.values()].reduce((a, b) => a + b, 0),
    valores: [...unidadesDesconhecidas.keys()],
  };

  // ── Grade (b-import-grade, 17/11/2026) ──────────────────
  // Linhas com a mesma chave (SKU; sem SKU, nome + unidade + marca) e 2+
  // combinacoes de cor/tamanho viram UM produto com variantes. As linhas da
  // grade saem do caminho simples abaixo; sem grade nenhuma, `naGrade` fica
  // vazio e tudo o que segue roda exatamente como antes (registro em
  // tests/fixtures/importProdutosSemGrade.json).
  const grades = montarGrades(valid, linhaDe, { coerceColorHex, skuSuffixFromAttrs });
  const naGrade = grades.naGrade;
  const avisosGrade = grades.avisos;
  if (grades.erros.length) {
    for (const e of grades.erros) errors.push({ ...e, row: rows[e.index] });
    errors.sort((a, b) => a.index - b.index);
  }

  // ── Duplicatas: dentro do lote e contra o banco ──────────
  // Antes: so o nome em minusculas. Deposito tem o mesmo nome em marcas
  // diferentes e em "pacote x unidade" / "metro x rolo" — 189 das 2.017
  // linhas da primeira planilha Matcon sumiam como duplicata. Agora a chave
  // e nome + unidade + marca (sem acento, espacos colapsados); o codigo de
  // barras continua deduplicando sozinho. Roda tambem no dry_run, para o
  // front mostrar o que NAO vai entrar antes de confirmar.
  // 20/10/2026: SKU preenchido e DIFERENTE dos dois lados = pecas
  // diferentes (loja de roupa: "Blusa" x23, cada uma com o codigo do
  // fornecedor), entram as duas. Se um lado nao tem SKU, segue duplicata
  // como antes -- ver mesmaPecaNoImport (services/productDedupKey.js).
  const duplicatas = [];
  const descrever = (p, index, origem, extra) => ({
    index, origem, ...extra,
    name: p.name, unit: p.unit, brand: p.brand, barcode: p.barcode,
  });

  // Fase 1 — dentro do proprio lote (primeira linha vence).
  const primeiraPorBarcode = new Map();
  const primeiraPorChave   = new Map(); // chave -> [{ sku, index }]
  const candidatos = [];
  // A grade entra primeiro nas chaves do lote: linha avulsa com o mesmo
  // nome/SKU de um modelo, ou com o codigo de barras de uma variante, vira
  // duplicata dele. Codigo repetido entre variantes: a segunda perde o
  // codigo da planilha e ganha um interno (aviso).
  for (const m of grades.modelos) {
    const chaveM = chaveProdutoImport(m.p.name, m.p.unit, m.p.brand);
    if (!primeiraPorChave.has(chaveM)) primeiraPorChave.set(chaveM, []);
    primeiraPorChave.get(chaveM).push({ sku: chaveSku(m.p.sku), index: m.linhas[0] });
    for (const v of m.variantes) {
      if (!v.barcode) continue;
      if (primeiraPorBarcode.has(v.barcode)) {
        avisosGrade.push(avisoCodigo(m, v, 'lote'));
        v.barcode = null;
        continue;
      }
      primeiraPorBarcode.set(v.barcode, v.linhas[0]);
    }
  }
  valid.forEach((p, k) => {
    if (naGrade.has(k)) return;
    const index = linhaDe[k];
    const chave = chaveProdutoImport(p.name, p.unit, p.brand);
    const sku = chaveSku(p.sku);
    if (p.barcode && primeiraPorBarcode.has(p.barcode)) {
      duplicatas.push(descrever(p, index, 'lote', { criterio: 'codigo_de_barras', duplicata_de: primeiraPorBarcode.get(p.barcode) }));
      return;
    }
    const mesma = mesmaPecaNoImport(primeiraPorChave.get(chave), sku);
    if (mesma) {
      duplicatas.push(descrever(p, index, 'lote', { criterio: 'nome_unidade_marca', duplicata_de: mesma.index }));
      return;
    }
    if (p.barcode) primeiraPorBarcode.set(p.barcode, index);
    if (!primeiraPorChave.has(chave)) primeiraPorChave.set(chave, []);
    primeiraPorChave.get(chave).push({ sku, index });
    candidatos.push({ p, index, chave, sku });
  });

  // Fase 2 — contra o banco. Nome sem acento/espacos nao da pra casar com
  // ANY() no SQL, entao vem nome/unidade/marca dos produtos da empresa e a
  // chave e montada aqui, com a MESMA funcao do lote (unidade antiga "MT"
  // no banco casa "m" da planilha). Sem filtro de is_active, como antes:
  // exclusao e DELETE fisico, e produto inativo (filho de variante
  // mesclado) nao pode voltar ativo numa reimportacao.
  const barcodeList = candidatos.filter(c => c.p.barcode).map(c => c.p.barcode);
  const existentesPorBarcode = new Map();
  const existentesPorChave   = new Map(); // chave -> [{ sku, id }]

  try {
    const [barRes, nomeRes] = await Promise.all([
      barcodeList.length > 0
        ? db.query(`SELECT id, barcode FROM products WHERE company_id=$1 AND barcode = ANY($2::text[])`, [companyId, barcodeList])
        : { rows: [] },
      candidatos.length > 0 || grades.modelos.length > 0
        ? db.query(`SELECT id, name, unit, brand, sku FROM products WHERE company_id=$1`, [companyId])
        : { rows: [] },
    ]);
    for (const r of barRes.rows) existentesPorBarcode.set(r.barcode, r.id || null);
    for (const r of nomeRes.rows) {
      const k = chaveProdutoImport(r.name, r.unit, r.brand);
      if (!existentesPorChave.has(k)) existentesPorChave.set(k, []);
      existentesPorChave.get(k).push({ sku: chaveSku(r.sku), id: r.id || null });
    }
  } catch (err) {
    console.error('[import-products] lookup error:', err.message);
    return res.status(500).json({ error: 'Erro ao verificar duplicatas', detail: err.message });
  }

  // Grade contra o banco: modelo que ja existe (mesma chave nome+unidade+
  // marca e SKU, a regra de sempre) sai inteiro, com todas as linhas em
  // `duplicatas`. Codigo de barras de variante que ja existe no grupo (em
  // produto ou variante) nao e regravado: a variante ganha um interno.
  const modelos = [];
  if (grades.modelos.length > 0) {
    const codigosGrade = [];
    for (const m of grades.modelos) for (const v of m.variantes) if (v.barcode) codigosGrade.push(v.barcode);
    let codigosNoBanco = new Set();
    try {
      if (codigosGrade.length > 0) {
        const { rows: usados } = await db.query(
          `SELECT p.barcode AS code FROM products p
            WHERE ${companyGroupWhere('$1', 'p.')} AND p.barcode = ANY($2::text[])
           UNION
           SELECT pv.barcode AS code FROM product_variants pv
             JOIN products p ON p.id = pv.product_id
            WHERE ${companyGroupWhere('$1', 'p.')} AND pv.barcode = ANY($2::text[])`,
          [companyId, codigosGrade]
        );
        codigosNoBanco = new Set(usados.map((r) => r.code));
      }
    } catch (err) {
      console.error('[import-products] lookup grade error:', err.message);
      return res.status(500).json({ error: 'Erro ao verificar duplicatas', detail: err.message });
    }
    for (const m of grades.modelos) {
      const chaveM = chaveProdutoImport(m.p.name, m.p.unit, m.p.brand);
      const existente = mesmaPecaNoImport(existentesPorChave.get(chaveM), chaveSku(m.p.sku));
      if (existente) {
        for (const index of m.linhas) {
          duplicatas.push(descrever({ ...m.p, barcode: null }, index, 'banco', { criterio: 'nome_unidade_marca', produto_id: existente.id }));
        }
        // o que nao entra nao gera aviso de grade
        const fora = new Set(m.linhas);
        for (let i = avisosGrade.length - 1; i >= 0; i--) {
          if (avisosGrade[i].linhas.some((x) => fora.has(x))) avisosGrade.splice(i, 1);
        }
        continue;
      }
      for (const v of m.variantes) {
        if (v.barcode && codigosNoBanco.has(v.barcode)) {
          avisosGrade.push(avisoCodigo(m, v, 'banco'));
          v.barcode = null;
        }
      }
      modelos.push(m);
    }
  }
  const variacoesAInserir = modelos.reduce((a, m) => a + m.variantes.length, 0);

  const toInsert = [];
  for (const { p, index, chave, sku } of candidatos) {
    if (p.barcode && existentesPorBarcode.has(p.barcode)) {
      duplicatas.push(descrever(p, index, 'banco', { criterio: 'codigo_de_barras', produto_id: existentesPorBarcode.get(p.barcode) }));
      continue;
    }
    const existente = mesmaPecaNoImport(existentesPorChave.get(chave), sku);
    if (existente) {
      duplicatas.push(descrever(p, index, 'banco', { criterio: 'nome_unidade_marca', produto_id: existente.id }));
      continue;
    }
    toInsert.push(p);
  }
  duplicatas.sort((a, b) => a.index - b.index);

  // t3-05: NCM que a Receita nao conhece. Conta so o que vai entrar (toInsert);
  // so aparece na resposta quando ha algum.
  const ncmAvisos = resumirAvisosNcm(modelos.length ? [...toInsert, ...modelos.map((m) => m.p)] : toInsert);
  const comNcmAvisos = ncmAvisos ? { ncm_avisos: ncmAvisos } : {};

  // Resumo da grade para a previa ("N modelos com M variacoes"). So aparece
  // quando ha grade: sem ela a resposta e a de sempre.
  const comGrade = modelos.length > 0 || avisosGrade.length > 0 ? {
    grade: {
      modelos:   modelos.length,
      variacoes: variacoesAInserir,
      linhas:    modelos.reduce((a, m) => a + m.linhas.length, 0),
      itens: modelos.slice(0, 50).map((m) => ({
        nome:      m.p.name,
        sku:       m.p.sku,
        categoria: m.p.category,
        preco:     m.p.price,
        estoque:   m.p.stock_qty,
        variacoes: m.variantes.length,
        cores:     [...new Set(m.variantes.filter((v) => v.color_hex).map((v) => v.color_name || v.color_hex))],
        tamanhos:  [...new Set(m.variantes.filter((v) => v.size).map((v) => v.size))],
        linhas:    m.linhas,
      })),
    },
    avisos_grade: avisosGrade,
  } : {};

  // Limite de produtos do plano (o mesmo do POST /products): o modelo com
  // grade conta como UM produto, variacao nao conta. Plano lido da empresa
  // (o do JWT pode estar velho); sem a coluna, vale o do token.
  let limitePlano = null;
  const aImportar = toInsert.length + modelos.length;
  if (aImportar > 0 && !(req.user && req.user.role === 'admin')) {
    try {
      const { rows: lr } = await db.query(
        `SELECT (SELECT plan FROM companies WHERE id = $1) AS plan,
                (SELECT COUNT(*) FROM products WHERE company_id = $1) AS total_produtos`,
        [companyId]
      );
      const limite = limiteDoPlano((lr[0] && lr[0].plan) || (req.user && req.user.plan));
      const atual = parseInt(lr[0] && lr[0].total_produtos, 10) || 0;
      if (atual + aImportar > limite) {
        limitePlano = { limite, atual, a_importar: aImportar, disponivel: Math.max(0, limite - atual) };
      }
    } catch (err) {
      console.error('[import-products] limite do plano:', err.message);
    }
  }
  const comLimite = limitePlano ? { limite_plano: limitePlano } : {};

  if (dry_run) {
    return res.json({
      dry_run:       true,
      ...comNcmAvisos,
      total:         rows.length,
      valid:         valid.length,
      error_count:   errors.length,
      suggested_map: map,
      errors,
      preview:       valid.slice(0, 5),
      a_importar:      aImportar,
      duplicate_count: duplicatas.length,
      duplicatas,
      unidades_desconhecidas: resumoUnidades,
      ...comGrade,
      ...comLimite,
    });
  }

  if (limitePlano) {
    return res.status(403).json({
      error: `Esta importação passa do limite de ${limitePlano.limite} produtos do seu plano. `
        + `Hoje a loja tem ${limitePlano.atual} e a planilha traz ${limitePlano.a_importar}; cabem ${limitePlano.disponivel}.`,
      code: 'LIMITE_DE_PRODUTOS',
      limite_plano: limitePlano,
    });
  }

  if (valid.length === 0) {
    return res.status(422).json({
      error: 'Nenhum produto válido para importar',
      error_count: errors.length,
      errors,
    });
  }

  // D12: grupo de estoque unico cria compartilhado (regra do POST /products).
  const compartilhar = await nasLojas.nasceCompartilhado(db, companyId);

  const batchId = uuidv4();
  let saved = 0;
  const dupes = duplicatas.length;
  // D4: relatorio de taxonomia da importacao (vinculados x pendentes no wizard)
  const categorias = { linked: 0, pending: [], ambiguous: [], skipped: false };

  // ── Fase 3: bulk INSERT em chunks de 100 ─────────────────
  // ON CONFLICT DO NOTHING: seguranca extra contra race conditions;
  // na pratica nunca deve disparar pois ja deduplicamos acima.
  const CHUNK = 100;

  // Preco no cartao (migration 351): a coluna so entra no INSERT quando a
  // planilha trouxe algum valor — sem ela, a query e a mesma de antes. Base
  // atras da 351 (42703): o chunk roda de novo sem a coluna e os chunks
  // seguintes nem tentam; a importacao nao cai por um campo opcional.
  // brand (migration 261) entra sempre, sem degrau: a coluna e anterior a 351.
  let comCardPrice = toInsert.some(p => p.card_price !== null);
  let cardPriceIgnorado = false;

  function montarInsert(chunk, incluirCardPrice) {
    const placeholders = [];
    const params = [companyId, batchId];
    let n = 3;
    for (const p of chunk) {
      const valores = [
        p.name, p.price, p.cost_price, p.stock_qty, p.stock_min,
        p.barcode, p.sku, p.category, p.color, p.size,
        p.unit, p.description, p.ncm, p.brand,
      ];
      if (incluirCardPrice) valores.push(p.card_price);
      placeholders.push(`($1,${valores.map(() => '$' + (n++)).join(',')},$2${compartilhar ? ',true' : ''})`);
      params.push(...valores);
    }
    const colCard = incluirCardPrice ? ', card_price' : '';
    return {
      sql: `INSERT INTO products
           (company_id, name, price, cost_price, stock_qty, stock_min,
            barcode, sku, category, color, size, unit, description, ncm, brand${colCard}, import_batch_id${compartilhar ? ', is_group_shared' : ''})
         VALUES ${placeholders.join(',')}
         ON CONFLICT DO NOTHING
         RETURNING id, category`,
      params,
    };
  }

  // Grade primeiro, numa transacao so (produto + variantes + atributos +
  // codigos internos): se falhar, nada da planilha foi gravado ainda.
  let variacoesCriadas = 0;
  if (modelos.length > 0) {
    try {
      const r = await gravarGrades({ companyId, batchId, modelos, comCardPrice: modelos.some((m) => m.p.card_price !== null), compartilhar });
      saved += r.produtos.length;
      variacoesCriadas = r.variacoes;
      if (r.cardPriceIgnorado) cardPriceIgnorado = true;
      const parcial = await linkImportedCategories(db, companyId, r.produtos);
      categorias.linked += parcial.linked;
      for (const v of parcial.pending)   if (!categorias.pending.includes(v))   categorias.pending.push(v);
      for (const v of parcial.ambiguous) if (!categorias.ambiguous.includes(v)) categorias.ambiguous.push(v);
      if (parcial.skipped) categorias.skipped = true;
    } catch (err) {
      console.error('[import-products] grade DB error:', err.message);
      return res.status(err.status || 500).json({ error: 'Erro ao salvar produtos com grade', detail: err.message });
    }
  }

  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    if (!chunk.length) break;

    try {
      // D4: RETURNING passa a ser necessario -- linkImportedCategories
      // precisa do id real de cada produto inserido. ON CONFLICT DO
      // NOTHING faz o RETURNING trazer SO o que entrou de fato, que e
      // exatamente o conjunto que deve ganhar vinculo.
      let inseridos;
      try {
        const q = montarInsert(chunk, comCardPrice);
        ({ rows: inseridos } = await db.query(q.sql, q.params));
      } catch (e) {
        if (e.code !== '42703' || !comCardPrice) throw e;
        console.warn('[import-products] card_price ignorado: base sem a migration 351');
        comCardPrice = false;
        cardPriceIgnorado = true;
        const q = montarInsert(chunk, false);
        ({ rows: inseridos } = await db.query(q.sql, q.params));
      }
      saved += chunk.length;

      // Nunca derruba a importacao: linkImportedCategories nao lanca, e o
      // analyze do wizard recalcula o staging a partir de products de
      // qualquer forma.
      const parcial = await linkImportedCategories(db, companyId, inseridos);
      categorias.linked += parcial.linked;
      for (const v of parcial.pending)   if (!categorias.pending.includes(v))   categorias.pending.push(v);
      for (const v of parcial.ambiguous) if (!categorias.ambiguous.includes(v)) categorias.ambiguous.push(v);
      if (parcial.skipped) categorias.skipped = true;
    } catch (err) {
      console.error('[import-products] DB error:', err.message);
      return res.status(500).json({ error: 'Erro ao salvar produtos', detail: err.message });
    }
  }

  try {
    await db.query(
      `INSERT INTO import_logs
         (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta)
       VALUES ($1,'products','csv',$2,$3,$4,$5,$6,$7)`,
      [companyId, rows.length, saved, errors.length, batchId, req.user?.id || null,
       JSON.stringify(modelos.length
         ? { duplicates_skipped: dupes, column_map: map, grade: { modelos: modelos.length, variacoes: variacoesCriadas } }
         : { duplicates_skipped: dupes, column_map: map })]
    );
  } catch (err) {
    console.error('[import-products] log error:', err.message);
    // nao falhar o import por causa do log
  }

  // 17/10/2026 (t2-04): o primeiro produto avança o passo do cadastro.
  if (saved > 0) avancarSemEsperar(companyId, 'produto');

  // B2: o que entrou vai tambem para as outras lojas marcadas.
  let porLoja = null;
  if (pedidoLojas) {
    porLoja = await levarImportacaoParaLojas(req, {
      companyId, batchId, pedidoLojas: compartilhar ? { ...pedidoLojas, outras: [] } : pedidoLojas, dupes, map,
    });
  }

  res.status(201).json({
    saved,
    duplicates_skipped: dupes,
    error_count: errors.length,
    batch_id: batchId,
    errors: errors.slice(0, 20),
    // D4: taxonomia. `pendentes` e `ambiguos` sao os valores que ficaram
    // na fila do wizard de migracao -- o lojista tem que VER isso na
    // resposta, senao "deixar pendente" vira silencio.
    categorias: {
      vinculados: categorias.linked,
      pendentes:  categorias.pending,
      ambiguos:   categorias.ambiguous,
    },
    duplicatas,
    unidades_desconhecidas: resumoUnidades,
    // So aparece quando a base ainda nao tem a migration 351.
    ...(cardPriceIgnorado ? { card_price_ignorado: true } : {}),
    ...comNcmAvisos,
    ...(modelos.length || avisosGrade.length ? {
      grade: { modelos: modelos.length, variacoes: variacoesCriadas },
      avisos_grade: avisosGrade,
    } : {}),
    ...(porLoja ? { por_loja: porLoja } : {}),
  });
});

// B2 (20/11/2026): leva o lote recem-importado para as outras lojas marcadas.
// Le do banco o que entrou (o lote da origem, com o estoque e a grade) e
// grava um lote de importacao por loja. Nunca derruba a resposta da origem.
async function levarImportacaoParaLojas(req, { companyId, batchId, pedidoLojas, dupes, map }) {
  let criados = [];
  try {
    const { rows: prods } = await db.query(
      `SELECT id, name, stock_qty FROM products WHERE import_batch_id = $1 AND company_id = $2 ORDER BY created_at, id`,
      [batchId, companyId]
    );
    const { rows: vars } = prods.length ? await db.query(
      `SELECT id, product_id, stock_qty FROM product_variants WHERE product_id = ANY($1::uuid[]) AND is_active = true`,
      [prods.map((p) => p.id)]
    ) : { rows: [] };
    const grade = new Map();
    for (const v of vars) {
      const pid = String(v.product_id).toLowerCase();
      if (!grade.has(pid)) grade.set(pid, new Map());
      grade.get(pid).set(String(v.id).toLowerCase(), Number(v.stock_qty) || 0);
    }
    criados = prods.map((p) => ({
      product_id: p.id, name: p.name, stock_qty: Number(p.stock_qty) || 0,
      variantes: grade.get(String(p.id).toLowerCase()) || null,
    }));
  } catch (err) {
    console.error('[import-products] lote para as outras lojas:', err.message);
    return [
      { company_id: String(companyId).toLowerCase(), nome: null, criados: 0, ja_existiam: dupes, erros: [] },
      ...pedidoLojas.outras.map((id) => ({
        company_id: id, nome: null, criados: 0, ja_existiam: 0,
        erros: [{ product_id: null, name: null, code: 'ERRO_AO_CRIAR', message: 'Não deu para criar os produtos nesta loja. Tente de novo.' }],
      })),
    ];
  }
  const lotes = new Map(pedidoLojas.outras.map((id) => [id, uuidv4()]));
  const porLoja = await nasLojas.levarDepoisDoCadastro(db, {
    origemId: companyId,
    userId: req.user && req.user.id,
    isStaff: !!(req.user && req.user.role === 'admin'),
    pedido: pedidoLojas,
    criados,
    origemJaExistiam: dupes,
    opcoes: { loteDaLoja: (id) => lotes.get(id) || null, notas: 'Estoque inicial da importação' },
    depois: async (client, r) => {
      for (const l of r.porLoja) {
        if (!l.criados) continue;
        await client.query(
          `INSERT INTO import_logs
             (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta)
           VALUES ($1,'products','csv',$2,$3,$4,$5,$6,$7)`,
          [l.company_id, criados.length, l.criados, l.erros.length, lotes.get(l.company_id), req.user?.id || null,
            JSON.stringify({ copia_de: { company_id: companyId, batch_id: batchId }, ja_existiam: l.ja_existiam, column_map: map })]
        );
      }
    },
  });
  // o "criados" da origem e o que ela gravou (o mesmo `saved`)
  porLoja[0].criados = criados.length;
  return porLoja;
}

// ─── Grade da importacao: helpers (b-import-grade, 17/11/2026) ─

// Mesmo limite do POST /products (getPlanLimit em routes/products.js).
function limiteDoPlano(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 7000;
    default:              return 2000;
  }
}

function avisoCodigo(m, v, origem) {
  const onde = [v.color_name || v.color_hex, v.size].filter(Boolean).join(' ');
  return {
    tipo: 'codigo_repetido',
    modelo: m.p.name, sku: m.p.sku || null, linhas: v.linhas, valores: [v.barcode],
    mensagem: origem === 'banco'
      ? `${m.p.name} ${onde}: o código ${v.barcode} já está em outro produto da loja. A variação ganha um código interno.`
      : `${m.p.name} ${onde}: o código ${v.barcode} aparece em outra linha da planilha. A variação ganha um código interno.`,
  };
}

/**
 * Grava os modelos com grade numa transacao: produto pai (estoque = soma),
 * variantes (sku_suffix, color_name, price_override, codigo) e atributos
 * Cor/Tamanho, como o PUT /variations. Variante sem codigo na planilha
 * ganha EAN-13 interno da serie 210 (services/gerarEan13.js), reservado
 * com a mesma trava por grupo do POST /barcodes/generate.
 * Ids gerados aqui: o vinculo pai -> variante nao depende da ordem do
 * RETURNING. O desfazer do lote (DELETE products por import_batch_id)
 * leva variantes e atributos junto (ON DELETE CASCADE).
 */
async function gravarGrades({ companyId, batchId, modelos, comCardPrice, compartilhar = false }) {
  const tentar = async (incluirCardPrice) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const semCodigo = modelos.reduce((a, m) => a + m.variantes.filter((v) => !v.barcode).length, 0);
      let codigos = [];
      if (semCodigo > 0) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('ean13-gerar:' || (
             SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)::text
               FROM companies WHERE id = $1
           )))`,
          [companyId]
        );
        codigos = await proximosCodigos(client, companyId, semCodigo);
      }

      const produtos = [];
      const variantes = [];
      const atributos = [];
      for (const m of modelos) {
        const pid = uuidv4();
        produtos.push({ id: pid, p: m.p });
        for (const v of m.variantes) {
          const vid = uuidv4();
          variantes.push({ id: vid, pid, v, barcode: v.barcode || codigos.shift() });
          if (v.color_hex) atributos.push([vid, 'Cor', v.color_hex]);
          if (v.size) atributos.push([vid, 'Tamanho', v.size]);
        }
      }

      const CH = 100;
      const inseridos = [];
      for (let i = 0; i < produtos.length; i += CH) {
        const chunk = produtos.slice(i, i + CH);
        const params = [companyId, batchId];
        const ph = [];
        for (const { id, p } of chunk) {
          const vals = [id, p.name, p.price, p.cost_price, p.stock_qty, p.stock_min,
            p.sku, p.category, p.unit, p.description, p.ncm, p.brand];
          if (incluirCardPrice) vals.push(p.card_price);
          ph.push(`($1,${vals.map((val) => { params.push(val); return '$' + params.length; }).join(',')},$2${compartilhar ? ',true' : ''})`);
        }
        const { rows: r } = await client.query(
          `INSERT INTO products
             (company_id, id, name, price, cost_price, stock_qty, stock_min,
              sku, category, unit, description, ncm, brand${incluirCardPrice ? ', card_price' : ''}, import_batch_id${compartilhar ? ', is_group_shared' : ''})
           VALUES ${ph.join(',')}
           RETURNING id, category`,
          params
        );
        inseridos.push(...r);
      }
      for (let i = 0; i < variantes.length; i += CH * 2) {
        const chunk = variantes.slice(i, i + CH * 2);
        const params = [];
        const ph = [];
        for (const { id, pid, v, barcode } of chunk) {
          const vals = [id, pid, v.sku_suffix, v.stock_qty, barcode, v.color_name, v.price_override];
          ph.push(`(${vals.map((val) => { params.push(val); return '$' + params.length; }).join(',')},true)`);
        }
        await client.query(
          `INSERT INTO product_variants
             (id, product_id, sku_suffix, stock_qty, barcode, color_name, price_override, is_active)
           VALUES ${ph.join(',')}`,
          params
        );
      }
      for (let i = 0; i < atributos.length; i += CH * 4) {
        const chunk = atributos.slice(i, i + CH * 4);
        const params = [];
        const ph = [];
        for (const vals of chunk) {
          ph.push(`(${vals.map((val) => { params.push(val); return '$' + params.length; }).join(',')})`);
        }
        await client.query(
          `INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ${ph.join(',')}`,
          params
        );
      }
      await client.query('COMMIT');
      return { produtos: inseridos, variacoes: variantes.length };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* conexao ja caiu */ }
      throw err;
    } finally {
      client.release();
    }
  };

  try {
    return await tentar(comCardPrice);
  } catch (e) {
    // Base sem a migration 351: grava sem o preco no cartao, como o simples.
    if (e.code !== '42703' || !comCardPrice) throw e;
    console.warn('[import-products] card_price ignorado na grade: base sem a migration 351');
    const r = await tentar(false);
    return { ...r, cardPriceIgnorado: true };
  }
}

// ─── Parser NF-e XML nativo ───────────────────────────────────

function parseNFeXML(xml) {
  const result = { products: [], nfe_info: {} };
  const getTag = (content, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(content);
    return m ? m[1].trim() : null;
  };
  result.nfe_info = {
    numero:       getTag(xml, 'nNF'),
    serie:        getTag(xml, 'serie'),
    data_emissao: getTag(xml, 'dhEmi') || getTag(xml, 'dEmi'),
    cnpj_emitente: null,
    nome_emitente: null,
    valor_total:  null,
  };
  const emitMatch = /<emit>([\s\S]*?)<\/emit>/i.exec(xml);
  if (emitMatch) {
    result.nfe_info.cnpj_emitente = getTag(emitMatch[1], 'CNPJ');
    result.nfe_info.nome_emitente = getTag(emitMatch[1], 'xNome');
  }
  const totalMatch = /<ICMSTot>([\s\S]*?)<\/ICMSTot>/i.exec(xml);
  if (totalMatch) {
    result.nfe_info.valor_total = parseFloat(getTag(totalMatch[1], 'vNF') || '0');
  }
  const detRegex = /<det[^>]*>([\s\S]*?)<\/det>/gi;
  let detMatch;
  while ((detMatch = detRegex.exec(xml)) !== null) {
    const det = detMatch[1];
    const prodMatch = /<prod>([\s\S]*?)<\/prod>/i.exec(det);
    if (!prodMatch) continue;
    const prod = prodMatch[1];
    const name     = getTag(prod, 'xProd');
    const ncm      = getTag(prod, 'NCM');
    const barcode  = getTag(prod, 'cEAN');
    const unit     = getTag(prod, 'uCom') || getTag(prod, 'uTrib');
    const qty      = parseFloat(getTag(prod, 'qCom') || getTag(prod, 'qTrib') || '0');
    const unitCost = parseFloat(getTag(prod, 'vUnCom') || getTag(prod, 'vUnTrib') || '0');
    const sku      = getTag(prod, 'cProd');
    if (!name || qty <= 0) continue;
    result.products.push({
      name,
      ncm:          ncm && ncm !== '0' ? ncm : null,
      barcode:      barcode && barcode !== '0' && barcode !== 'SEM GTIN' ? barcode : null,
      sku:          sku || null,
      unit:         unit ? unit.toLowerCase() : 'un',
      stock_qty:    qty,
      cost_price:   unitCost > 0 ? unitCost : null,
      price:        unitCost > 0 ? Math.ceil(unitCost * 1.3 * 100) / 100 : 0,
      supplier_cnpj: result.nfe_info.cnpj_emitente,
      _price_is_suggestion: true,
    });
  }
  return result;
}

// ─── Fase 1 fornecedores: registra a entrada no estoque ─────────
//
// stock_movements nasceu (migration 018) so pra vendas ('out') e
// devolucao/troca ('in') -- a importacao de NF-e nunca registrou nada
// aqui, so somava products.stock_qty direto. Agora que existe
// supplier_id + unit_cost (migration 342), o import passa a deixar
// rastro tambem, sem mudar em nada o calculo de quantidade/custo do
// produto (isso continua acima, inalterado).
//
// SAVEPOINT: falha aqui (ex: coluna nao migrada num deploy fora de
// ordem) nao pode abortar a transacao inteira do import -- o produto ja
// salvo e o que importa; o rastro de estoque e best-effort.
async function registrarEntradaDeEstoque(client, { productId, companyId, supplierId, quantity, unitCost, referenceId, notes }) {
  try {
    await client.query('SAVEPOINT sp_stock_mov');
    await client.query(
      `INSERT INTO stock_movements
         (product_id, company_id, type, quantity, unit_cost, supplier_id, reference_id, reference_type, notes)
       VALUES ($1,$2,'in',$3,$4,$5,$6,'nfe_import',$7)`,
      [productId, companyId, quantity, unitCost || null, supplierId || null, referenceId, notes || null]
    );
    await client.query('RELEASE SAVEPOINT sp_stock_mov');
  } catch (err) {
    console.error('[import-nfe] stock_movements insert error:', err.message);
    try { await client.query('ROLLBACK TO SAVEPOINT sp_stock_mov'); } catch (_) { /* ignora */ }
  }
}

// ─── Matcon M4 (23/09/2026): ultima compra + pedido de compra ─────
//
// A nota grava no produto "quem vendeu e por quanto" (products.last_*,
// migration 354) e fecha o pedido de compra ENVIADO ao mesmo CNPJ
// (src/services/matconPurchases.js). Os dois sao best-effort, cada um no
// seu SAVEPOINT, pelo mesmo motivo do rastro de estoque acima: falha aqui
// (ex.: base sem a 354) nunca pode derrubar a importacao da nota.
// Quantidade e custo do produto continuam exatamente como antes.
async function registrarUltimaCompra(client, productId, nfeInfo, unitCost) {
  try {
    await client.query('SAVEPOINT sp_ultima_compra');
    await gravarUltimaCompra(client, productId, {
      supplierName: nfeInfo.nome_emitente,
      supplierCnpj: nfeInfo.cnpj_emitente,
      supplierPhone: null,
      unitCost,
    });
    await client.query('RELEASE SAVEPOINT sp_ultima_compra');
  } catch (err) {
    console.error('[import-nfe] ultima compra error:', err.message);
    try { await client.query('ROLLBACK TO SAVEPOINT sp_ultima_compra'); } catch (_) { /* ignora */ }
  }
}

async function fecharPedidosDeCompra(client, companyId, nfeInfo, chegou) {
  if (!chegou.length) return;
  try {
    await client.query('SAVEPOINT sp_pedido_compra');
    await casarNotaComPedidos(client, companyId, {
      supplierCnpj: nfeInfo.cnpj_emitente,
      invoiceNumber: nfeInfo.numero,
      items: chegou,
    });
    await client.query('RELEASE SAVEPOINT sp_pedido_compra');
  } catch (err) {
    console.error('[import-nfe] pedido de compra error:', err.message);
    try { await client.query('ROLLBACK TO SAVEPOINT sp_pedido_compra'); } catch (_) { /* ignora */ }
  }
}

// ─── POST /products/import-nfe ────────────────────────────────

router.post('/products/import-nfe', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const save      = req.query.save === 'true';
  const { xml_content, products: confirmedProducts } = req.body;

  if (!xml_content || typeof xml_content !== 'string') {
    return res.status(400).json({ error: 'Campo xml_content é obrigatório (conteúdo do arquivo .xml da NF-e)' });
  }

  let parsed;
  try {
    parsed = parseNFeXML(xml_content);
  } catch (err) {
    return res.status(422).json({ error: 'Arquivo XML inválido ou não é uma NF-e', detail: err.message });
  }

  if (parsed.products.length === 0) {
    return res.status(422).json({ error: 'Nenhum produto encontrado no XML da NF-e' });
  }

  // t3-05: NCM que a Receita nao conhece so AVISA, nunca bloqueia a nota.
  const ncmAvisosPreview = resumirAvisosNcm(parsed.products);

  if (!save) {
    return res.json({
      preview:     true,
      nfe_info:    parsed.nfe_info,
      products:    parsed.products,
      total_items: parsed.products.length,
      ...(ncmAvisosPreview ? { ncm_avisos: ncmAvisosPreview } : {}),
    });
  }

  const toSave = Array.isArray(confirmedProducts) && confirmedProducts.length > 0
    ? confirmedProducts
    : parsed.products;
  const ncmAvisosSave = resumirAvisosNcm(toSave);

  const batchId = uuidv4();
  let saved = 0, dupes = 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Fase 1 fornecedores (16/09/2026): acha/cria o supplier UMA vez pelo
    // CNPJ do emitente da NF-e (uma nota tem um unico emitente -- vale
    // pra todos os itens dela). Nao bloqueia o import: sem CNPJ nem nome
    // no XML, supplierId fica null e o resto do fluxo segue igual.
    const supplierId = await findOrCreateSupplierByCnpj(client, companyId, {
      cnpj: parsed.nfe_info.cnpj_emitente,
      name: parsed.nfe_info.nome_emitente,
    });

    // Matcon M4: o que entrou no estoque de produto JA cadastrado, para
    // casar com o pedido de compra enviado ao mesmo fornecedor.
    const chegou = [];

    for (const p of toSave) {
      if (!p.name) continue;
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
        if (existing) {
          // Quantidade e custo: comportamento inalterado. supplier_id so
          // preenche quando o produto ainda nao tinha um (nao sobrescreve
          // fornecedor ja cadastrado manualmente por outro).
          await client.query(
            `UPDATE products SET stock_qty=stock_qty+$1, cost_price=$2,
               supplier_id=COALESCE(supplier_id,$4), updated_at=NOW() WHERE id=$3`,
            [p.stock_qty || 0, p.cost_price || null, existing.id, supplierId]
          );
          if (p.stock_qty > 0) {
            await registrarEntradaDeEstoque(client, {
              productId: existing.id, companyId, supplierId,
              quantity: p.stock_qty, unitCost: p.cost_price || null,
              referenceId: batchId, notes: 'Importacao NF-e',
            });
            chegou.push({ product_id: existing.id, quantity: p.stock_qty });
          }
          await registrarUltimaCompra(client, existing.id, parsed.nfe_info, p.cost_price);
          dupes++; continue;
        }
      }
      if (existing) { dupes++; continue; }
      const price = parseFloat(p.price) || 0;
      if (price <= 0) continue;
      const novo = await client.query(
        `INSERT INTO products
           (company_id, name, price, cost_price, stock_qty,
            barcode, sku, unit, ncm, supplier_cnpj, supplier_id, import_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [companyId, p.name, price, p.cost_price || null, p.stock_qty || 0,
         p.barcode || null, p.sku || null, p.unit || 'un',
         p.ncm || null, p.supplier_cnpj || null, supplierId, batchId]
      );
      if (p.stock_qty > 0) {
        await registrarEntradaDeEstoque(client, {
          productId: novo.rows[0].id, companyId, supplierId,
          quantity: p.stock_qty, unitCost: p.cost_price || null,
          referenceId: batchId, notes: 'Importacao NF-e',
        });
      }
      await registrarUltimaCompra(client, novo.rows[0].id, parsed.nfe_info, p.cost_price);
      saved++;
    }
    await fecharPedidosDeCompra(client, companyId, parsed.nfe_info, chegou);
    if (req.body.create_expense && parsed.nfe_info.valor_total > 0) {
      const dataEmissao = parsed.nfe_info.data_emissao
        ? parsed.nfe_info.data_emissao.substring(0, 10)
        : new Date().toISOString().substring(0, 10);
      await client.query(
        `INSERT INTO transactions
           (company_id, type, amount, description, category, due_date, status, import_batch_id, created_by)
         VALUES ($1,'expense',$2,$3,'purchase',$4,'paid',$5,$6)`,
        [companyId, parsed.nfe_info.valor_total,
         `NF-e ${parsed.nfe_info.numero || ''}${parsed.nfe_info.nome_emitente ? ' — ' + parsed.nfe_info.nome_emitente : ''}`.trim(),
         dataEmissao, batchId, req.user?.id || null]
      );
    }
    await client.query(
      `INSERT INTO import_logs
         (company_id, module, format, total_rows, imported_rows, error_rows, batch_id, created_by, meta)
       VALUES ($1,'products','nfe_xml',$2,$3,$4,$5,$6,$7)`,
      [companyId, parsed.products.length, saved, 0, batchId, req.user?.id || null,
       JSON.stringify({ nfe_numero: parsed.nfe_info.numero, nfe_emitente: parsed.nfe_info.nome_emitente,
                        nfe_cnpj: parsed.nfe_info.cnpj_emitente, stock_updated: dupes })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import-nfe] DB error:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar produtos da NF-e', detail: err.message });
  } finally { client.release(); }

  if (saved > 0) avancarSemEsperar(companyId, 'produto');

  res.status(201).json({
    saved,
    stock_updated: dupes,
    batch_id: batchId,
    nfe_info: parsed.nfe_info,
    ...(ncmAvisosSave ? { ncm_avisos: ncmAvisosSave } : {}),
  });
});

// ─── GET /imports ─────────────────────────────────────────────

router.get('/imports', requireAuth, async (req, res) => {
  const companyId = req.params.id;
  const { module } = req.query;
  try {
    let query = `SELECT id, module, format, total_rows, imported_rows, error_rows,
                        batch_id, created_at, reverted_at, meta
                 FROM import_logs WHERE company_id=$1`;
    const params = [companyId];
    if (module) { query += ` AND module=$2`; params.push(module); }
    query += ` ORDER BY created_at DESC LIMIT 100`;
    const result = await db.query(query, params);
    res.json({ imports: result.rows });
  } catch (err) {
    console.error('[imports-history] error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar histórico de importações' });
  }
});

// ─── DELETE /imports/:batch_id ────────────────────────────────

router.delete('/imports/:batch_id', requireAuth, async (req, res) => {
  const { id: companyId, batch_id } = req.params;
  try {
    const logRes = await db.query(
      `SELECT module, imported_rows, reverted_at FROM import_logs WHERE batch_id=$1 AND company_id=$2`,
      [batch_id, companyId]
    );
    if (!logRes.rows[0]) return res.status(404).json({ error: 'Importação não encontrada' });
    if (logRes.rows[0].reverted_at) return res.status(409).json({ error: 'Esta importação já foi desfeita' });
    const { module } = logRes.rows[0];
    const tableMap = { customers: 'customers', products: 'products', transactions: 'transactions' };
    const table = tableMap[module];
    if (!table) return res.status(400).json({ error: `Módulo '${module}' não suporta desfazer` });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(
        `DELETE FROM ${table} WHERE import_batch_id=$1 AND company_id=$2`,
        [batch_id, companyId]
      );
      await client.query(`UPDATE import_logs SET reverted_at=NOW() WHERE batch_id=$1 AND company_id=$2`, [batch_id, companyId]);
      await client.query('COMMIT');
      res.json({ reverted: true, batch_id, module, deleted_count: deleted.rowCount });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    console.error('[import-revert] error:', err.message);
    res.status(500).json({ error: 'Erro ao desfazer importação', detail: err.message });
  }
});

// ─── GET /import-templates/:type ─────────────────────────────

router.get('/import-templates/:type', requireAuth, (req, res) => {
  const templates = {
    customers: {
      filename: 'modelo-importacao-clientes.csv',
      fields: ['nome', 'telefone', 'email', 'cpf_cnpj', 'data_nascimento', 'instagram', 'rua', 'cidade', 'estado', 'cep'],
      required: ['nome'],
      // Antes exigia required_one_of: [['telefone', 'email']] — removido
      // pra permitir importacao de listas que so tem nome (migracao
      // de outras plataformas).
      example_rows: [
        ['Maria Silva', '12991234567', 'maria@email.com', '123.456.789-00', '15/08/1985', '@mariasilva', 'Rua das Flores, 123', 'Jacareí', 'SP', '12300-000'],
        ['Restaurante Bom Sabor', '1233334444', 'contato@bomsabor.com.br', '12.345.678/0001-90', '', '', 'Av. Central, 456', 'Jacareí', 'SP', '12301-000'],
        ['Joao da Silva', '', '', '', '', '', '', '', '', ''],
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
  if (!tpl) return res.status(404).json({ error: 'Template não encontrado. Use: customers ou products' });
  res.json(tpl);
});

module.exports = router;
// Expostos para teste (22/09/2026): o mapeamento de colunas e puro.
module.exports.suggestMapping = suggestMapping;
module.exports.applyMap = applyMap;
module.exports.PRODUCT_FIELDS = PRODUCT_FIELDS;
module.exports.normalizarUnidadeImport = normalizarUnidadeImport;
module.exports.parseQuantidade = parseQuantidade;
module.exports.chaveProdutoImport = chaveProdutoImport;
