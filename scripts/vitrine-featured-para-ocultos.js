#!/usr/bin/env node
// ============================================================
// AURA. — Vitrine: lista de inclusão -> ocultos (tq-57, 29/10/2026)
//
//   node scripts/vitrine-featured-para-ocultos.js
//        DRY-RUN de todas as lojas com lista de inclusão. Não escreve nada.
//   node scripts/vitrine-featured-para-ocultos.js --lojas felic-adega,qbonita
//        DRY-RUN só dessas lojas.
//   node scripts/vitrine-featured-para-ocultos.js --lojas felic-adega --apply [--backup arq.json]
//        Converte essas lojas (e só elas), uma transação por loja.
//   node scripts/vitrine-featured-para-ocultos.js --desfazer arq.json [--apply]
//        Devolve featured e ocultos como estavam no backup (sem --apply, só mostra).
//
// ── POR QUE ────────────────────────────────────────────────────────────
// `featured_product_ids` cheio é lista de INCLUSÃO: a loja mostra só o
// que está nela. Para esconder 4 peças, a lojista acaba gravando todas as
// outras — e dali em diante produto novo não entra na loja sozinho.
// Desde o tq-57 a vitrine respeita `hidden_product_ids` (ocultar). Este
// script troca a lista de inclusão pelo inverso dela:
//
//   ocultos  = ocultos de hoje ∪ (produtos que a loja enxerga − featured)
//   featured = []
//
// "Produtos que a loja enxerga" é a MESMA regra da vitrine
// (listVisibilityWhere): os da empresa e os compartilhados do grupo,
// ativos ou não — produto inativo fora da lista que for reativado amanhã
// também não pode aparecer.
//
// ── A GARANTIA ─────────────────────────────────────────────────────────
// Nenhuma loja muda o que mostra hoje. O script calcula, produto a
// produto, o fragmento REAL da vitrine (NA_VITRINE) antes e depois:
//   - no dry-run, simulando o depois;
//   - no --apply, DENTRO da transação, lendo a linha já atualizada.
// Uma divergência que seja e a loja volta (ROLLBACK) e o script diz qual.
//
// O que MUDA, de propósito: produto cadastrado depois da conversão entra
// na loja sozinho. E a ORDEM: a lista de inclusão também ordenava a grade;
// depois dela a grade segue a ordem padrão (mais novos primeiro). O
// dry-run avisa por loja.
//
// ── CAMINHO DE VOLTA ───────────────────────────────────────────────────
// Antes de cada UPDATE, featured e ocultos antigos vão para o arquivo de
// backup (--backup, ou vitrine-featured-backup-<data>.json na pasta
// atual). `--desfazer <arquivo> --apply` grava de volta.
//
// Nunca roda sozinho: sem --apply não escreve. --apply exige --lojas com
// os slugs, um a um — não existe "todas".
// Precisa de SUPABASE_DB_URL (src/config/database.js).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const { NA_VITRINE } = require('../src/services/catalogoPaginado');
const { listVisibilityWhere } = require('../src/services/storefrontBuilder');

function lerArgs(argv) {
  const a = { apply: false, lojas: null, backup: null, desfazer: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = () => { i += 1; if (argv[i] === undefined) throw new Error(`${k} precisa de um valor`); return argv[i]; };
    if (k === '--apply') a.apply = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--lojas') a.lojas = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--backup') a.backup = v();
    else if (k === '--desfazer') a.desfazer = v();
    else throw new Error(`opção desconhecida: ${k}`);
  }
  if (a.apply && a.dryRun) throw new Error('Escolha um: --dry-run (padrão) ou --apply.');
  if (a.desfazer && a.lojas) throw new Error('--desfazer usa as lojas do backup; não junte com --lojas.');
  if (a.apply && !a.desfazer && !(a.lojas && a.lojas.length)) {
    throw new Error('--apply precisa de --lojas slug1,slug2 (não existe conversão de todas de uma vez).');
  }
  if (a.lojas && a.lojas.some((s) => s.toLowerCase() === 'todas')) throw new Error('"todas" não é um slug.');
  return a;
}

function listaDeTexto(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  }
  return [];
}

// Lojas com lista de inclusão cheia (opcionalmente só as pedidas).
const SQL_LOJAS = `
  SELECT company_id, slug, is_published, featured_product_ids, hidden_product_ids
    FROM digital_channel_config
   WHERE jsonb_typeof(featured_product_ids) = 'array'
     AND jsonb_array_length(featured_product_ids) > 0
     AND ($1::text[] IS NULL OR slug = ANY($1::text[]))
   ORDER BY slug NULLS LAST`;

// Cada produto que a loja enxerga e se ele está na vitrine AGORA, pela
// regra real (o fragmento lê digital_channel_config na mesma conexão —
// dentro da transação, já com a linha atualizada).
const SQL_PRODUTOS = `
  SELECT products.id::text AS id,
         (products.is_active IS NOT FALSE) AS ativo,
         ${NA_VITRINE} AS na_vitrine
    FROM products
   WHERE ${listVisibilityWhere('$1')}`;

/**
 * O plano de UMA loja, sem escrever nada.
 * `produtos`: [{ id, ativo, na_vitrine }] lidos com SQL_PRODUTOS.
 */
function planejar(cfg, produtos) {
  const featured = listaDeTexto(cfg.featured_product_ids);
  const ocultosHoje = listaDeTexto(cfg.hidden_product_ids);
  const naLista = new Set(featured);

  const ocultos = [...ocultosHoje];
  const jaOculto = new Set(ocultosHoje);
  const novos = [];
  for (const p of produtos) {
    if (!naLista.has(p.id) && !jaOculto.has(p.id)) {
      ocultos.push(p.id); jaOculto.add(p.id); novos.push(p.id);
    }
  }

  // Simula o depois: featured vazio, a vitrine passa a ser "não oculto".
  const divergencias = produtos
    .filter((p) => Boolean(p.na_vitrine) !== !jaOculto.has(p.id))
    .map((p) => p.id);

  const ativosHoje = produtos.filter((p) => p.ativo && p.na_vitrine).length;
  return {
    company_id: cfg.company_id,
    slug: cfg.slug,
    publicada: cfg.is_published === true,
    featured,
    ocultosHoje,
    ocultos,
    novosOcultos: novos.length,
    enxerga: produtos.length,
    ativosNaVitrine: ativosHoje,
    divergencias,
  };
}

function linhaDoRelatorio(p) {
  return {
    loja: p.slug || `(sem slug) ${p.company_id}`,
    publicada: p.publicada ? 'sim' : 'não',
    'na lista': p.featured.length,
    'produtos da loja': p.enxerga,
    'ativos na vitrine': p.ativosNaVitrine,
    'ocultos hoje': p.ocultosHoje.length,
    'ocultos depois': p.ocultos.length,
    divergências: p.divergencias.length,
  };
}

function nomeDoBackup(agora = new Date()) {
  const d = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.resolve(process.cwd(), `vitrine-featured-backup-${d}.json`);
}

async function converterLoja(pool, cfgPedido, { log, guardarBackup }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Trava a linha: o painel não pode gravar featured no meio do caminho.
    const { rows: cfgRows } = await client.query(
      `SELECT company_id, slug, is_published, featured_product_ids, hidden_product_ids
         FROM digital_channel_config WHERE company_id = $1 FOR UPDATE`,
      [cfgPedido.company_id],
    );
    const cfg = cfgRows[0];
    if (!cfg || listaDeTexto(cfg.featured_product_ids).length === 0) {
      await client.query('ROLLBACK');
      return { slug: cfgPedido.slug, resultado: 'pulada: a lista já está vazia' };
    }
    const { rows: antes } = await client.query(SQL_PRODUTOS, [cfg.company_id]);
    const plano = planejar(cfg, antes);
    if (plano.divergencias.length) {
      await client.query('ROLLBACK');
      return { slug: cfg.slug, resultado: `NÃO convertida: ${plano.divergencias.length} divergência(s) na simulação` };
    }

    guardarBackup({
      company_id: cfg.company_id,
      slug: cfg.slug,
      featured_product_ids: plano.featured,
      hidden_product_ids: plano.ocultosHoje,
    });

    await client.query(
      `UPDATE digital_channel_config
          SET hidden_product_ids = $2::text[],
              featured_product_ids = '[]'::jsonb,
              updated_at = NOW()
        WHERE company_id = $1`,
      [cfg.company_id, plano.ocultos],
    );

    // A prova, com a regra real e a linha já atualizada.
    const { rows: depois } = await client.query(SQL_PRODUTOS, [cfg.company_id]);
    const antesPorId = new Map(antes.map((p) => [p.id, Boolean(p.na_vitrine)]));
    const mudou = depois.filter((p) => antesPorId.get(p.id) !== Boolean(p.na_vitrine)).map((p) => p.id);
    if (mudou.length || depois.length !== antes.length) {
      await client.query('ROLLBACK');
      log(`  ${cfg.slug}: ${mudou.length} produto(s) mudariam de estado: ${mudou.slice(0, 10).join(', ')}`);
      return { slug: cfg.slug, resultado: 'NÃO convertida: a vitrine mudaria (ROLLBACK)' };
    }
    await client.query('COMMIT');
    return { slug: cfg.slug, resultado: `convertida: ${plano.novosOcultos} produto(s) foram para os ocultos` };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function desfazer(pool, arquivo, { apply, log, lerArquivo }) {
  const backup = JSON.parse(lerArquivo(arquivo));
  const lojas = Array.isArray(backup.lojas) ? backup.lojas : [];
  if (!lojas.length) throw new Error(`backup sem lojas: ${arquivo}`);
  const resultados = [];
  for (const b of lojas) {
    if (!apply) {
      resultados.push({ slug: b.slug, resultado: `voltaria: ${b.featured_product_ids.length} na lista, ${b.hidden_product_ids.length} ocultos` });
      continue;
    }
    const { rowCount } = await pool.query(
      `UPDATE digital_channel_config
          SET featured_product_ids = $2::jsonb,
              hidden_product_ids = $3::text[],
              updated_at = NOW()
        WHERE company_id = $1`,
      [b.company_id, JSON.stringify(b.featured_product_ids), b.hidden_product_ids],
    );
    resultados.push({ slug: b.slug, resultado: rowCount ? 'restaurada' : 'não encontrada' });
  }
  log(apply ? 'Desfeito.' : 'DRY-RUN do desfazer: nada foi gravado.');
  return resultados;
}

/**
 * @param {string[]} argv
 * @param {{ db, log?, tabela?, escreverArquivo?, lerArquivo?, agora? }} deps
 */
async function executar(argv, deps) {
  const a = lerArgs(argv);
  const log = deps.log || console.log;
  const tabela = deps.tabela || console.table;
  const db = deps.db;

  if (a.desfazer) {
    const r = await desfazer(db, a.desfazer, {
      apply: a.apply, log, lerArquivo: deps.lerArquivo || ((f) => fs.readFileSync(f, 'utf8')),
    });
    tabela(r);
    return { modo: 'desfazer', resultados: r };
  }

  const { rows: lojas } = await db.query(SQL_LOJAS, [a.lojas]);
  if (a.lojas) {
    const achadas = new Set(lojas.map((l) => l.slug));
    const faltam = a.lojas.filter((s) => !achadas.has(s));
    if (faltam.length) throw new Error(`sem lista de inclusão (ou slug inexistente): ${faltam.join(', ')}`);
  }

  const planos = [];
  for (const cfg of lojas) {
    const { rows } = await db.query(SQL_PRODUTOS, [cfg.company_id]);
    planos.push(planejar(cfg, rows));
  }
  log(`${planos.length} loja(s) com lista de inclusão.`);
  tabela(planos.map(linhaDoRelatorio));
  log('Atenção: a lista de inclusão também ordena a grade. Depois da conversão, a ordem passa a ser a padrão (mais novos primeiro).');
  for (const p of planos.filter((x) => x.divergencias.length)) {
    log(`  ${p.slug}: divergência em ${p.divergencias.slice(0, 10).join(', ')} — esta loja não será convertida.`);
  }

  if (!a.apply) {
    log('DRY-RUN: nada foi gravado. Para converter: --lojas <slug> --apply');
    return { modo: 'dry-run', planos };
  }

  const arquivo = a.backup ? path.resolve(a.backup) : nomeDoBackup(deps.agora);
  const escrever = deps.escreverArquivo || ((f, txt) => fs.writeFileSync(f, txt));
  const backup = { criado_em: (deps.agora || new Date()).toISOString(), lojas: [] };
  // Grava o arquivo a cada loja, ANTES do UPDATE dela: se o script cair
  // no meio, o backup já tem tudo que foi mexido.
  const guardarBackup = (item) => { backup.lojas.push(item); escrever(arquivo, JSON.stringify(backup, null, 2)); };

  const resultados = [];
  for (const cfg of lojas) {
    resultados.push(await converterLoja(db, cfg, { log, guardarBackup }));
  }
  tabela(resultados);
  log(`Backup: ${arquivo}`);
  log(`Para desfazer: node scripts/vitrine-featured-para-ocultos.js --desfazer "${arquivo}" --apply`);
  return { modo: 'apply', planos, resultados, arquivo };
}

module.exports = { lerArgs, planejar, executar, SQL_LOJAS, SQL_PRODUTOS };

if (require.main === module) {
  const db = require('../src/config/database');
  executar(process.argv.slice(2), { db })
    .then(() => db.end().catch(() => {}))
    .catch((e) => {
      console.error('Erro:', e.message);
      db.end().catch(() => {});
      process.exitCode = 1;
    });
}
