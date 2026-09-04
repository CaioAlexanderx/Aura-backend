#!/usr/bin/env node
// ============================================================
// AURA. — Clonar a configuracao de uma loja para a loja de teste
//
//   node scripts/clonar-loja.js --de sheid-mania --para aura-qa
//   node scripts/clonar-loja.js --para aura-qa --zerar
//
// ── POR QUE ────────────────────────────────────────────────────────────
// A conta de demonstracao nao espelha uma loja Studio de verdade: sem
// mockup 3D vinculado, sem arte pronta, sem faixa de lote, sem aviso nem
// SLA. Testar nela e testar outra coisa. Este script traz a configuracao
// de uma loja REAL para a loja de teste, para o QA percorrer o mesmo
// caminho que a cliente percorre.
//
// ── O QUE ELE COPIA ────────────────────────────────────────────────────
// Configuracao do canal digital (cor, tipografia, avisos, entrega,
// pagamento, faixas de lote), os ajustes de Studio (SLA, revisoes) e os
// produtos personalizaveis visiveis, com a personalizacao e o vinculo do
// mockup 3D. As FOTOS nao sao copiadas: as URLs apontam para os mesmos
// arquivos no R2, que sao publicos.
//
// ── O QUE ELE NAO COPIA ────────────────────────────────────────────────
// Pedidos, clientes, financeiro e chaves de pagamento. Levar a chave Pix
// de um cliente para uma loja de teste seria criar um caminho para
// alguem pagar na conta errada.
//
// ── DESTRUTIVO POR OPCAO ───────────────────────────────────────────────
// Antes de copiar, apaga os produtos e a configuracao da loja de teste.
// Rodar de novo devolve o mesmo estado — e essa e a graca: o QA comeca
// toda rodada do mesmo lugar. Por isso ele SO aceita destino com
// `is_sandbox = true`.
// ============================================================
'use strict';

const db = require('../src/config/database');

function arg(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i >= 0 ? process.argv[i + 1] : null;
}
const temFlag = (nome) => process.argv.includes('--' + nome);

/** Campos do canal digital que fazem a loja ser aquela loja. */
const CAMPOS_DO_CANAL = [
  'site_name', 'tagline', 'description', 'primary_color', 'accent_color',
  'font_family', 'card_style', 'dark_mode', 'logo_url', 'cover_url',
  'banners', 'service_cards', 'announcement_bar',
  'whatsapp', 'phone', 'instagram', 'tiktok', 'facebook', 'address',
  'pickup_enabled', 'pickup_address', 'pickup_eta_text',
  'delivery_enabled', 'delivery_fee', 'delivery_eta_text',
  'business_hours', 'always_open',
  'pix_discount_pct', 'card_enabled', 'card_max_installments',
  'pay_on_delivery_enabled', 'politica_troca',
  'featured_product_ids', 'hidden_product_ids',
];

async function lojaPorSlug(slug) {
  const { rows } = await db.query(
    `SELECT dcc.*, c.is_sandbox
       FROM digital_channel_config dcc
       JOIN companies c ON c.id = dcc.company_id
      WHERE dcc.slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

async function apagarLojaDeTeste(cid) {
  // Ordem importa: o que aponta para produto sai antes do produto.
  await db.query(`DELETE FROM product_images WHERE product_id IN
                    (SELECT id FROM products WHERE company_id = $1)`, [cid]);
  await db.query(`DELETE FROM product_category_links WHERE product_id IN
                    (SELECT id FROM products WHERE company_id = $1)`, [cid]);
  await db.query(`DELETE FROM products WHERE company_id = $1`, [cid]);
  await db.query(`DELETE FROM product_categories WHERE company_id = $1`, [cid]);
  console.log('  · catalogo da loja de teste apagado');
}

async function zerarMovimento(cid) {
  // O que uma rodada de QA produz e que precisa sumir para a proxima.
  const alvos = [
    ['digital_order_items', 'order_id IN (SELECT id FROM digital_orders WHERE company_id = $1)'],
    ['digital_orders', 'company_id = $1'],
  ];
  for (const [tabela, onde] of alvos) {
    try {
      const r = await db.query(`DELETE FROM ${tabela} WHERE ${onde}`, [cid]);
      console.log(`  · ${tabela}: ${r.rowCount} linha(s)`);
    } catch (e) {
      // 42P01: tabela nao existe nesta base. Nao e motivo para parar.
      if (e.code !== '42P01') throw e;
    }
  }
}

async function copiarCanal(origem, destinoCid) {
  const campos = CAMPOS_DO_CANAL.filter((c) => c in origem);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => origem[c]);
  await db.query(
    `UPDATE digital_channel_config SET ${sets}, updated_at = NOW() WHERE company_id = $1`,
    [destinoCid, ...valores]
  );
  console.log(`  · canal digital: ${campos.length} campos copiados`);
}

async function copiarStudioSettings(origemCid, destinoCid) {
  const { rows } = await db.query(
    `SELECT COALESCE(studio_settings, '{}'::jsonb) AS s FROM companies WHERE id = $1`,
    [origemCid]
  );
  await db.query(`UPDATE companies SET studio_settings = $2 WHERE id = $1`,
    [destinoCid, rows[0] ? rows[0].s : {}]);
  console.log('  · studio_settings (SLA, revisoes, faixas) copiado');
}

async function copiarCategorias(origemCid, destinoCid) {
  // Duas passadas: primeiro as linhas, depois o parent — a arvore aponta
  // para si mesma e o id novo so existe depois da insercao.
  const { rows: cats } = await db.query(
    `SELECT * FROM product_categories WHERE company_id = $1 ORDER BY depth NULLS FIRST`,
    [origemCid]
  );
  const de_para = new Map();
  for (const c of cats) {
    const { rows } = await db.query(
      `INSERT INTO product_categories (company_id, name, slug, position)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [destinoCid, c.name, c.slug, c.position || 0]
    );
    de_para.set(c.id, rows[0].id);
  }
  for (const c of cats) {
    if (!c.parent_id) continue;
    await db.query(`UPDATE product_categories SET parent_id = $2 WHERE id = $1`,
      [de_para.get(c.id), de_para.get(c.parent_id)]);
  }
  console.log(`  · ${cats.length} categoria(s)`);
  return de_para;
}

async function copiarProdutos(origemCid, destinoCid, de_paraCat) {
  const { rows: prods } = await db.query(
    `SELECT * FROM products
      WHERE company_id = $1 AND is_personalizable = true AND is_active IS NOT false`,
    [origemCid]
  );
  let n = 0;
  for (const p of prods) {
    const { rows } = await db.query(
      `INSERT INTO products
         (company_id, name, description, price, cost_price, sku, is_active,
          is_personalizable, customization_config, visual_template_key,
          image_url, stock_qty)
       VALUES ($1,$2,$3,$4,$5,$6,true,true,$7,$8,$9,$10)
       RETURNING id`,
      [destinoCid, p.name, p.description, p.price, p.cost_price,
       p.sku ? `QA-${p.sku}` : null,
       p.customization_config, p.visual_template_key, p.image_url, p.stock_qty]
    );
    const novoId = rows[0].id;

    const { rows: fotos } = await db.query(
      `SELECT image_url, position FROM product_images WHERE product_id = $1`, [p.id]);
    for (const f of fotos) {
      await db.query(
        `INSERT INTO product_images (product_id, image_url, position) VALUES ($1,$2,$3)`,
        [novoId, f.image_url, f.position || 0]);
    }

    const { rows: links } = await db.query(
      `SELECT category_id, is_primary FROM product_category_links WHERE product_id = $1`, [p.id]);
    for (const l of links) {
      const catNova = de_paraCat.get(l.category_id);
      if (!catNova) continue;
      await db.query(
        `INSERT INTO product_category_links (product_id, category_id, is_primary)
         VALUES ($1,$2,$3)`, [novoId, catNova, l.is_primary === true]);
    }
    n++;
  }
  console.log(`  · ${n} produto(s) personalizavel(is), com foto e categoria`);
}

async function main() {
  const de = arg('de');
  const para = arg('para');
  if (!para) {
    console.error('uso: node scripts/clonar-loja.js --de <slug> --para <slug-de-teste>');
    process.exit(1);
  }

  const destino = await lojaPorSlug(para);
  if (!destino) { console.error(`loja de destino "${para}" nao encontrada`); process.exit(1); }

  // A trava que torna este script seguro de rodar.
  if (destino.is_sandbox !== true) {
    console.error(`RECUSADO: "${para}" nao e loja de teste (companies.is_sandbox != true).`);
    console.error('Este script APAGA o catalogo do destino. So roda em loja de teste.');
    process.exit(1);
  }

  console.log(`Loja de teste: ${para} (${destino.company_id})`);

  if (temFlag('zerar')) {
    console.log('Zerando o movimento da rodada anterior:');
    await zerarMovimento(destino.company_id);
    if (!de) { console.log('Pronto.'); process.exit(0); }
  }

  if (!de) { console.error('faltou --de <slug> para copiar'); process.exit(1); }
  const origem = await lojaPorSlug(de);
  if (!origem) { console.error(`loja de origem "${de}" nao encontrada`); process.exit(1); }

  console.log(`Copiando de: ${de} (${origem.company_id})`);
  await apagarLojaDeTeste(destino.company_id);
  await copiarCanal(origem, destino.company_id);
  await copiarStudioSettings(origem.company_id, destino.company_id);
  const de_paraCat = await copiarCategorias(origem.company_id, destino.company_id);
  await copiarProdutos(origem.company_id, destino.company_id, de_paraCat);

  console.log(`\nPronto. Loja de teste em https://loja.getaura.com.br/${para}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
