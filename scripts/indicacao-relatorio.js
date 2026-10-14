#!/usr/bin/env node
// ============================================================
// AURA. — Relatório semanal da indicação (SOMENTE LEITURA) — 14/10/2026
//
//   node scripts/indicacao-relatorio.js                      (últimos 7 dias)
//   node scripts/indicacao-relatorio.js --desde 2026-10-01
//   node scripts/indicacao-relatorio.js --json               (saída para planilha)
//
// Para a conferência de segunda da Célia (cartão t2-19):
//   1. concessões do período (linha "desconto de indicação" do DRE);
//   2. PAYMENT_DELETED SEM concessão: cobrança excluída na Asaas sem linha
//      no livro (exclusão manual no painel = fora da regra);
//   3. concessões em conferência (gravadas sem confirmação da Asaas);
//   4. indicações pendentes e valor potencial (estimado pela última cobrança
//      paga do indicador; a cobrança real é consultada pelo script de
//      concessão);
//   5. teto do mês: usado e restante.
//
// Só faz SELECT. Não usa a Asaas. Precisa de SUPABASE_DB_URL.
// ============================================================
'use strict';

const lib = require('./indicacao-lib');

const TZ = 'America/Sao_Paulo';

const SQL_CONCESSOES_PERIODO = `-- indicacao:relatorio-concessoes
SELECT k.id, k.tipo, k.status, k.data_concessao::text AS data_concessao, k.valor,
       k.asaas_payment_id, k.cobranca_vencimento::text AS cobranca_vencimento, k.estorno_pay_id,
       COALESCE(a.trade_name, a.legal_name) AS indicador, COALESCE(b.trade_name, b.legal_name) AS indicado,
       k.erro, k.criado_por
  FROM indicacao_concessoes k
  LEFT JOIN companies a ON a.id = k.indicador_company_id
  LEFT JOIN companies b ON b.id = k.indicado_company_id
 WHERE k.data_concessao >= $1::date OR k.status IN ('registrada', 'estornando')
 ORDER BY k.data_concessao, k.criado_em`;

const SQL_EXCLUIDAS_SEM_CONCESSAO = `-- indicacao:relatorio-excluidas
SELECT w.id AS log_id, (w.processed_at AT TIME ZONE '${TZ}')::date::text AS dia,
       COALESCE(c.trade_name, c.legal_name) AS loja, w.company_id,
       x.p->>'id' AS pagamento_id, NULLIF(x.p->>'value', '')::numeric AS valor,
       x.p->>'dueDate' AS vencimento, x.p->>'description' AS descricao
  FROM webhook_logs w
  CROSS JOIN LATERAL (SELECT COALESCE(w.payload->'payment', w.payload) AS p) x
  LEFT JOIN companies c ON c.id = w.company_id
 WHERE w.provider = 'asaas'
   AND w.event = 'PAYMENT_DELETED'
   AND w.processed_at >= ($1::date::timestamp AT TIME ZONE '${TZ}')
   AND NOT EXISTS (
     SELECT 1 FROM indicacao_concessoes k
      WHERE k.asaas_payment_id = x.p->>'id'
        AND k.status IN ('registrada', 'aplicada', 'estornando', 'estornada'))
 ORDER BY w.processed_at DESC`;

const PENDENTES = new Set([
  'aguardando_pagamento_indicado', 'aguardando_assinatura_indicador',
  'aguardando_primeiro_pagamento_indicador', 'indicador_em_atraso', 'elegivel',
]);

async function montarRelatorio({ db, hoje = lib.hojeSP(), desde = null, params = lib.PARAMETROS_PADRAO }) {
  const inicio = desde || lib.somarDias(hoje, -7);
  let concessoes;
  try {
    ({ rows: concessoes } = await db.query(SQL_CONCESSOES_PERIODO, [inicio]));
  } catch (err) {
    if (err.code === '42P01') throw new Error('Tabela indicacao_concessoes não existe: a migration 385 ainda não foi aplicada.');
    throw err;
  }
  const { rows: excluidas } = await db.query(SQL_EXCLUIDAS_SEM_CONCESSAO, [inicio]);

  const dados = await lib.carregarDados(db);
  const itens = dados.candidatos.map((c) => lib.avaliarCandidato(c, { ...dados, hoje, params }));
  const porSituacao = {};
  for (const it of itens) porSituacao[it.situacao] = (porSituacao[it.situacao] || 0) + 1;

  const pendentes = lib.ordenarFila(itens.filter((it) => PENDENTES.has(it.situacao))).map((it) => {
    const ultimo = lib.ultimoRecebimento(dados.eventosPorEmpresa.get(it.indicador_id) || []);
    return { ...it, valor_potencial: ultimo && ultimo.valor != null ? ultimo.valor : null };
  });
  const valorPotencial = pendentes.reduce((s, it) => s + Math.round((it.valor_potencial || 0) * 100), 0) / 100;
  const { usadoMes } = lib.usoDoTeto(dados.concessoes, hoje);

  return {
    hoje, desde: inicio,
    concessoes: concessoes.map((k) => ({ ...k, valor: Number(k.valor) })),
    totalConcedidoPeriodo: concessoes
      .filter((k) => k.status === 'aplicada' && k.data_concessao >= inicio)
      .reduce((s, k) => s + Math.round(Number(k.valor) * 100), 0) / 100,
    emConferencia: concessoes.filter((k) => ['registrada', 'estornando'].includes(k.status)),
    excluidasSemConcessao: excluidas.map((e) => ({ ...e, valor: e.valor == null ? null : Number(e.valor) })),
    pendentes,
    valorPotencial,
    porSituacao,
    teto: {
      mes: hoje.slice(0, 7), usado: usadoMes, teto: params.tetoMensal,
      restante: Math.max(0, Math.round(params.tetoMensal * 100) - Math.round(usadoMes * 100)) / 100,
    },
  };
}

function imprimir(r, log = console.log) {
  log(`Relatório da indicação · ${r.hoje} · período desde ${r.desde}`);
  log(`\n1) Concessões (aplicadas no período: ${lib.reais(r.totalConcedidoPeriodo)})`);
  if (r.concessoes.length) {
    console.table(r.concessoes.map((k) => ({
      data: k.data_concessao, tipo: k.tipo, status: k.status, indicador: k.indicador, indicado: k.indicado || '-',
      valor: lib.reais(k.valor), cobranca: k.asaas_payment_id || '-', estorno: k.estorno_pay_id || '-',
    })));
  } else log('   nenhuma');
  log(`\n2) PAYMENT_DELETED sem concessão: ${r.excluidasSemConcessao.length}`);
  if (r.excluidasSemConcessao.length) {
    console.table(r.excluidasSemConcessao.map((e) => ({
      dia: e.dia, loja: e.loja || '(sem loja)', cobranca: e.pagamento_id, valor: lib.reais(e.valor), vencimento: e.vencimento || '-',
    })));
  }
  log(`\n3) Em conferência (gravadas sem confirmação da Asaas): ${r.emConferencia.length}`);
  for (const k of r.emConferencia) log(`   ${k.id} · ${k.status} · ${k.indicador} · ${k.asaas_payment_id} · ${lib.reais(k.valor)}`);
  log(`\n4) Indicações pendentes: ${r.pendentes.length} · valor potencial estimado ${lib.reais(r.valorPotencial)}`);
  if (r.pendentes.length) {
    console.table(r.pendentes.map((it) => ({
      indicador: it.indicador_nome || '-', indicado: it.indicado_nome || '-', 'indicado pagou': it.indicado_pago_em || '-',
      situacao: lib.ROTULOS[it.situacao] || it.situacao, 'valor potencial': lib.reais(it.valor_potencial),
    })));
  }
  log(`\n5) Teto de ${r.teto.mes}: ${lib.reais(r.teto.usado)} usados de ${lib.reais(r.teto.teto)} (restam ${lib.reais(r.teto.restante)})`);
  log(`\nTodas as indicações por situação: ${JSON.stringify(r.porSituacao)}`);
}

function lerArgs(argv) {
  const a = { json: false, desde: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--desde') { a.desde = argv[i + 1]; i += 1; }
    else throw new Error(`opção desconhecida: ${argv[i]}`);
  }
  if (a.desde && !/^\d{4}-\d{2}-\d{2}$/.test(a.desde)) throw new Error('--desde precisa ser AAAA-MM-DD');
  return a;
}

async function main() {
  const args = lerArgs(process.argv.slice(2));
  const db = require('../src/config/database');
  const r = await montarRelatorio({ db, desde: args.desde });
  if (args.json) console.log(JSON.stringify(r, null, 2)); else imprimir(r);
  await db.end().catch(() => {});
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { montarRelatorio, imprimir, lerArgs };
