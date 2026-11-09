#!/usr/bin/env node
// ============================================================
// AURA. — Categorias do Financeiro: liga os lancamentos antigos (434)
//
//   node scripts/migrar-categorias-financeiro.js
//        DRY-RUN de todas as lojas com lancamento sem categoria ligada.
//        Nao escreve nada.
//   node scripts/migrar-categorias-financeiro.js --empresas <uuid>,<uuid>
//        DRY-RUN so dessas empresas.
//   node scripts/migrar-categorias-financeiro.js --empresas <uuid> --apply [--backup arq.json]
//   node scripts/migrar-categorias-financeiro.js --todas --apply [--backup arq.json]
//        Aplica, uma transacao por empresa.
//   node scripts/migrar-categorias-financeiro.js --desfazer arq.json [--apply]
//        Desliga o que o --apply ligou e tira as categorias que ele criou
//        (sem --apply, so mostra).
//
// ── O QUE FAZ (mockup, secao E) ─────────────────────────────────────────
// Para cada texto de categoria antigo (transactions.category com
// category_id NULL), na regra de src/services/financeCategories.js
// (resolverTexto):
//   - casa com o nome de uma categoria da loja, sem diferenciar maiuscula e
//     acento ("Servicos" -> "Servicos" com cedilha) -> liga;
//   - "Crediario - A Receber/Recebido/(parcial)" -> Crediario; "Troca - ..."
//     e "devolucao" -> Trocas e devolucoes; "Canal Digital" -> Vendas › Loja
//     online; chaves do "Categorizar com IA" e o 'purchase' da NF-e -> a
//     categoria (e subcategoria) equivalente;
//   - nao casa -> vira categoria DA PROPRIA LOJA com o mesmo nome, e liga.
// A loja que ainda nao abriu as categorias ganha a lista padrao antes.
//
// ── A GARANTIA ──────────────────────────────────────────────────────────
// NENHUM TEXTO E REESCRITO: so category_id e preenchido, e so onde ele e
// NULL (rodar de novo nao muda nada). Tudo que casa por texto (Vendas, Taxas
// de cartao, Crediario%A Receber%, fornecedores/troca do resultado do
// periodo) segue casando. Fora: annuity_* e 'anuidade' (federacao de
// karate) e lancamento sem categoria.
//
// ── CAMINHO DE VOLTA ────────────────────────────────────────────────────
// O --apply grava no backup (--backup, ou
// categorias-financeiro-backup-<data>.json na pasta atual) os ids dos
// lancamentos ligados e das categorias criadas, por empresa.
// `--desfazer <arquivo> --apply` desliga esses lancamentos e apaga as
// categorias criadas que nada mais usa (a que ganhou uso depois e so
// arquivada).
//
// Nunca roda sozinho: sem --apply nao escreve, e --apply exige --empresas
// ou --todas. Precisa de SUPABASE_DB_URL (src/config/database.js).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

function lerArgs(argv) {
  const a = { apply: false, empresas: null, todas: false, backup: null, desfazer: null };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '--apply') a.apply = true;
    else if (x === '--todas') a.todas = true;
    else if (x === '--empresas') { a.empresas = String(argv[i + 1] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); i += 1; }
    else if (x === '--backup') { a.backup = argv[i + 1]; i += 1; }
    else if (x === '--desfazer') { a.desfazer = argv[i + 1]; i += 1; }
    else if (x === '--help' || x === '-h') a.help = true;
    else throw new Error('Argumento desconhecido: ' + x);
  }
  return a;
}

function nomeDoBackup() {
  const d = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return path.resolve(process.cwd(), 'categorias-financeiro-backup-' + d + '.json');
}

function imprimirPlano(plano, nome) {
  const nLigar = plano.ligar.reduce(function (a, l) { return a + l.n; }, 0);
  const nCriar = plano.criar.reduce(function (a, c) { return a + c.n; }, 0);
  console.log('\n== ' + (nome || plano.company_id) + ' (' + plano.company_id + ')');
  if (plano.semeia_padroes) console.log('   ganha a lista padrao de categorias (ainda nao tinha nenhuma)');
  console.log('   ' + nLigar + ' lancamento(s) ligam a categorias que ja existem; ' + nCriar + ' vao para ' + plano.criar.length + ' categoria(s) nova(s)');
  plano.ligar.forEach(function (l) {
    console.log('     ' + (l.kind === 'income' ? 'receita' : 'despesa') + '  "' + l.texto + '" x' + l.n + '  ->  ' + l.categoria);
  });
  plano.criar.forEach(function (c) {
    console.log('     ' + (c.kind === 'income' ? 'receita' : 'despesa') + '  "' + c.textos.join('", "') + '" x' + c.n + '  ->  NOVA "' + c.name + '"');
  });
}

async function empresasPendentes(db) {
  const r = await db.query(
    `SELECT t.company_id, COALESCE(c.trade_name, c.legal_name) AS nome, COUNT(*)::int AS n
       FROM transactions t JOIN companies c ON c.id = t.company_id
      WHERE t.category_id IS NULL AND t.category IS NOT NULL AND btrim(t.category) <> ''
      GROUP BY 1, 2 ORDER BY 3 DESC`
  );
  return r.rows;
}

async function nomesDe(db, ids) {
  const r = await db.query('SELECT id, COALESCE(trade_name, legal_name) AS nome FROM companies WHERE id = ANY($1::uuid[])', [ids]);
  const m = new Map(r.rows.map(function (x) { return [x.id, x.nome]; }));
  return ids.map(function (id) { return { company_id: id, nome: m.get(id) || '(empresa nao encontrada)' }; });
}

async function desfazer(db, arquivo, aplicar) {
  const backup = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  for (let i = 0; i < backup.empresas.length; i += 1) {
    const e = backup.empresas[i];
    console.log('\n== ' + (e.nome || e.company_id) + ': ' + e.ligados.length + ' lancamento(s) a desligar, ' + e.criadas.length + ' categoria(s) a tirar');
    if (!aplicar) continue;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE transactions SET category_id = NULL WHERE company_id = $1 AND id = ANY($2::uuid[]) AND category_id = ANY($3::uuid[])',
        [e.company_id, e.ligados, e.categorias_usadas]);
      await client.query(
        `DELETE FROM finance_categories f WHERE f.company_id = $1 AND f.id = ANY($2::uuid[])
            AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.category_id = f.id)
            AND NOT EXISTS (SELECT 1 FROM finance_categories s WHERE s.parent_id = f.id)`,
        [e.company_id, e.criadas]);
      await client.query('UPDATE finance_categories SET archived_at = COALESCE(archived_at, NOW()) WHERE company_id = $1 AND id = ANY($2::uuid[])',
        [e.company_id, e.criadas]);
      await client.query('COMMIT');
      console.log('   desfeito');
    } catch (err) {
      await client.query('ROLLBACK').catch(function () {});
      console.error('   FALHOU (nada mudou nesta empresa): ' + err.message);
    } finally { client.release(); }
  }
  if (!aplicar) console.log('\nDRY-RUN do desfazer. Rode de novo com --apply para gravar.');
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 16).join('\n')); return; }
  const db = require('../src/config/database');
  const svc = require('../src/services/financeCategories');

  if (args.desfazer) { await desfazer(db, args.desfazer, args.apply); return; }
  if (args.apply && !args.todas && !(args.empresas && args.empresas.length)) {
    throw new Error('--apply exige --empresas <uuid,...> ou --todas');
  }

  const alvo = args.empresas && args.empresas.length ? await nomesDe(db, args.empresas) : await empresasPendentes(db);
  console.log((args.apply ? 'APLICANDO' : 'DRY-RUN') + ' em ' + alvo.length + ' empresa(s)');

  const backup = { criado_em: new Date().toISOString(), empresas: [] };
  const arquivo = args.backup ? path.resolve(args.backup) : nomeDoBackup();
  let totalLigados = 0;
  for (let i = 0; i < alvo.length; i += 1) {
    const e = alvo[i];
    try {
      if (!args.apply) {
        imprimirPlano(await svc.planejarMigracao(e.company_id), e.nome);
        continue;
      }
      const out = await svc.aplicarMigracao(e.company_id);
      imprimirPlano(out.plano, e.nome);
      console.log('   GRAVADO: ' + out.ligados.length + ' lancamento(s) ligados, ' + out.criadas.length + ' categoria(s) criadas');
      totalLigados += out.ligados.length;
      const usadas = out.plano.ligar.map(function (l) { return l.category_id; }).concat(out.criadas);
      backup.empresas.push({ company_id: e.company_id, nome: e.nome, ligados: out.ligados, criadas: out.criadas, categorias_usadas: Array.from(new Set(usadas)) });
      fs.writeFileSync(arquivo, JSON.stringify(backup, null, 2));
    } catch (err) {
      console.error('\n== ' + (e.nome || e.company_id) + ': FALHOU (nada mudou nesta empresa): ' + err.message);
    }
  }
  if (args.apply) console.log('\n' + totalLigados + ' lancamento(s) ligados. Backup: ' + arquivo);
  else console.log('\nDRY-RUN: nada foi gravado. Para aplicar: --empresas <uuid,...> --apply (ou --todas --apply).');
}

if (require.main === module) {
  main().then(function () { process.exit(0); }).catch(function (err) { console.error(err.message); process.exit(1); });
}

module.exports = { lerArgs };
