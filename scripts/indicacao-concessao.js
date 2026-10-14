#!/usr/bin/env node
// ============================================================
// AURA. — Concessão do mês do indicador (Indique e ganhe) — 14/10/2026
//
//   node scripts/indicacao-concessao.js                       (DRY-RUN: só mostra)
//   node scripts/indicacao-concessao.js --apply               (concede, pedindo confirmação uma a uma)
//   node scripts/indicacao-concessao.js --estornar <id> --apply [--vencimento AAAA-MM-DD]
//   node scripts/indicacao-concessao.js --combinada --indicador <company_id> \
//        --indicado <company_id> --cobranca pay_... [--observacao "texto"] --apply
//
// Opções: --teto-mensal 230 · --max-por-ano 3 · --operador "nome" (fica na linha)
//
// O que faz (cartão t2-19, regras da Célia em 13/10; detalhe em
// docs/indicacao-concessao.md e scripts/indicacao-lib.js):
//   lista as indicações, diz quais estão elegíveis e, com --apply, para cada
//   uma pronta: mostra indicador, indicado, cobrança e valor, pede para
//   DIGITAR O VALOR, confere a cobrança na Asaas, GRAVA a concessão em
//   indicacao_concessoes e SÓ ENTÃO exclui a cobrança na Asaas.
//
// Nunca roda sozinho: sem --apply não escreve nada (nem no banco, nem na
// Asaas); com --apply exige terminal interativo e a confirmação de cada uma.
// Precisa de SUPABASE_DB_URL e, para consultar e excluir
// cobranças, ASAAS_API_KEY (ASAAS_URL aponta para o sandbox no teste).
// ============================================================
'use strict';

const lib = require('./indicacao-lib');

function lerArgs(argv) {
  const a = { apply: false, estornar: null, combinada: false, params: { ...lib.PARAMETROS_PADRAO } };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = () => { i += 1; if (argv[i] === undefined) throw new Error(`${k} precisa de um valor`); return argv[i]; };
    if (k === '--apply') a.apply = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--estornar') a.estornar = v();
    else if (k === '--vencimento') a.vencimento = v();
    else if (k === '--combinada') a.combinada = true;
    else if (k === '--indicador') a.indicador = v();
    else if (k === '--indicado') a.indicado = v();
    else if (k === '--cobranca') a.cobranca = v();
    else if (k === '--observacao') a.observacao = v();
    else if (k === '--operador') a.operador = v();
    else if (k === '--teto-mensal') a.params.tetoMensal = Number(v());
    else if (k === '--max-por-ano') a.params.maxPorAno = Number(v());
    else throw new Error(`opção desconhecida: ${k}`);
  }
  if (a.apply && a.dryRun) throw new Error('Escolha um: --dry-run (padrão) ou --apply.');
  if (!(a.params.tetoMensal > 0) || !(a.params.maxPorAno > 0)) throw new Error('teto e máximo por ano precisam ser positivos');
  if (a.combinada && !(a.indicador && a.indicado && a.cobranca)) {
    throw new Error('--combinada precisa de --indicador, --indicado e --cobranca');
  }
  return a;
}

// Confirmação: a pessoa digita o valor exibido. Qualquer outra coisa pula.
function confere(resposta, valor) {
  let r = String(resposta || '').trim().replace(/^R\$\s*/i, '');
  if (r.includes(',')) r = r.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
  return r !== '' && Number.isFinite(Number(r)) && Math.round(Number(r) * 100) === Math.round(Number(valor) * 100);
}

function textoConfirmacao(item) {
  const valor = Number(item.valor).toFixed(2).replace('.', ',');
  return [
    '',
    `  Indicador : ${item.indicador_nome} (${item.indicador_id})`,
    `  Indicado  : ${item.indicado_nome || '-'} (${item.indicado_id || '-'})` +
      (item.indicado_pago_em ? ` · pagou em ${item.indicado_pago_em}` : ''),
    `  Tipo      : ${item.tipo || 'padrao'}`,
    `  Cobrança  : ${item.cobranca.id} · vence ${item.cobranca.vencimento} · ${item.cobranca.forma || '-'}`,
    `  Valor     : ${lib.reais(item.valor)}`,
    '  A cobrança será EXCLUÍDA na Asaas. Isso não volta (só por estorno).',
    `  Para confirmar, digite o valor (${valor}); qualquer outra coisa pula: `,
  ].join('\n');
}

function imprimirFila(fila, log) {
  log(`Teto do mês: ${lib.reais(fila.usadoMes)} usados de ${lib.reais(fila.tetoMensal)}` +
    ` · projetado com as prontas: ${lib.reais(fila.projetadoMes)}`);
  const linhas = fila.itens.map((it) => ({
    indicador: it.indicador_nome || '-',
    indicado: it.indicado_nome || '-',
    'indicado pagou': it.indicado_pago_em || '-',
    cobranca: it.cobranca ? `${it.cobranca.id} (${it.cobranca.vencimento})` : '-',
    valor: it.valor == null ? '-' : lib.reais(it.valor),
    situacao: lib.ROTULOS[it.situacao] || it.situacao,
    motivo: it.motivo || '',
  }));
  if (linhas.length) console.table(linhas); else log('Nenhuma indicação registrada.');
}

async function executar(argv, deps) {
  const { db, asaas, perguntar, hoje = lib.hojeSP(), log = console.log, interativo = true } = deps;
  const args = lerArgs(argv);
  const operador = args.operador || process.env.USER || process.env.USERNAME || null;

  if (args.apply && !interativo) {
    throw new Error('--apply precisa de terminal interativo (a confirmação é digitada, não pode vir por pipe).');
  }
  if (args.apply && !asaas) throw new Error('--apply precisa de ASAAS_API_KEY.');

  // ── estorno ──
  if (args.estornar) {
    const c = await lib.lerConcessao(db, args.estornar);
    const corpo = lib.planoDeEstorno(c, { hoje, vencimento: args.vencimento });
    log(`Estorno da concessão ${c.id}: nova cobrança avulsa de ${lib.reais(corpo.value)} para ${corpo.dueDate}` +
      ` (cliente ${corpo.customer}, ${corpo.billingType}), ligada à cobrança excluída ${c.asaas_payment_id}.`);
    if (!args.apply) { log('DRY-RUN: nada foi feito. Use --apply para estornar.'); return { modo: 'dry-run' }; }
    const resp = await perguntar(`  Para confirmar, digite o valor (${corpo.value.toFixed(2).replace('.', ',')}): `);
    if (!confere(resp, corpo.value)) { log('Valor não confere: estorno não feito.'); return { modo: 'apply', estornos: 0 }; }
    const r = await lib.estornar({ db, asaas, concessao: c, hoje, vencimento: args.vencimento });
    log(r.ok ? `Estornada: cobrança nova ${r.estornoPayId}.` : `A Asaas recusou o estorno: ${r.erro}. A concessão continua 'aplicada'.`);
    return { modo: 'apply', estornos: r.ok ? 1 : 0, resultado: r };
  }

  // ── combinada ──
  let prontas;
  if (args.combinada) {
    if (!asaas) throw new Error('--combinada precisa de ASAAS_API_KEY para conferir a cobrança.');
    const item = await lib.montarCombinada({
      db, asaas, indicadorId: args.indicador, indicadoId: args.indicado, cobrancaId: args.cobranca,
      observacao: args.observacao || null, hoje,
    });
    log(`Concessão combinada (fora do teto): ${item.indicador_nome} ← ${item.indicado_nome},` +
      ` cobrança ${item.cobranca.id} de ${lib.reais(item.valor)} (vence ${item.cobranca.vencimento}).`);
    prontas = [item];
  } else {
    if (!asaas) log('Sem ASAAS_API_KEY: as cobranças dos indicadores não foram consultadas (valores e tetos ficam em aberto).');
    const fila = await lib.montarFila({ db, asaas, hoje, params: args.params });
    imprimirFila(fila, log);
    prontas = fila.itens.filter((it) => it.situacao === 'pronta');
  }

  if (!args.apply) {
    log(`DRY-RUN: nada foi gravado nem excluído. ${prontas.length} pronta(s). Use --apply para conceder.`);
    return { modo: 'dry-run', prontas: prontas.length };
  }

  const resultados = [];
  for (const item of prontas) {
    const resp = await perguntar(textoConfirmacao(item));
    if (!confere(resp, item.valor)) { log('  Pulada (valor não confere).'); resultados.push({ item, pulada: true }); continue; }
    try {
      const r = await lib.concederUma({ db, asaas, item, hoje, params: args.params, operador });
      if (r.ok) {
        log(`  Concedida: linha ${r.concessaoId}, cobrança ${item.cobranca.id} excluída.` + (r.aviso ? ` ATENÇÃO: ${r.aviso}` : ''));
        log(`  Avisar a Célia hoje: ${item.indicador_nome} ganhou ${lib.reais(item.valor)} (cobrança ${item.cobranca.id}, vencimento ${item.cobranca.vencimento}) pela indicação de ${item.indicado_nome}.`);
      } else {
        log(`  A Asaas recusou a exclusão: ${r.erro}. Linha ${r.concessaoId} marcada como 'falhou'; a cobrança continua lá.`);
      }
      resultados.push({ item, ...r });
    } catch (err) {
      if (!err.recusa) throw err;
      log(`  Recusada: ${err.message}`);
      resultados.push({ item, recusada: err.message });
    }
  }
  return { modo: 'apply', resultados, concedidas: resultados.filter((r) => r.ok).length };
}

function perguntarNoTerminal(texto) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(texto, (r) => { rl.close(); resolve(r); }));
}

async function main() {
  const db = require('../src/config/database');
  const { asaas } = require('../src/services/asaasClient');
  const r = await executar(process.argv.slice(2), {
    db,
    asaas: process.env.ASAAS_API_KEY ? asaas : null,
    perguntar: perguntarNoTerminal,
    interativo: !!(process.stdin.isTTY && process.stdout.isTTY),
  });
  await db.end().catch(() => {});
  return r;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err.recusa ? `Recusado: ${err.message}` : err);
    process.exit(1);
  });
}

module.exports = { executar, lerArgs, confere, textoConfirmacao };
