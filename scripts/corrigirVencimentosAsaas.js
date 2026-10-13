#!/usr/bin/env node
// ============================================================
// AURA. — Corrigir os vencimentos das assinaturas pela Asaas
//
//   node scripts/corrigirVencimentosAsaas.js              (dry-run: só mostra)
//   node scripts/corrigirVencimentosAsaas.js --aplicar    (grava)
//
// ── POR QUE ────────────────────────────────────────────────────────────
// Até 13/10/2026 o webhook da Asaas gravava em companies.next_billing_date o
// vencimento da cobrança que tinha acabado de ser paga, não o próximo. As
// datas ficaram um ciclo para trás (Encanto Presentes em 15/09, Finesse em
// 08/08, Davi Villa Branca em 18/06). Este script pergunta o próximo
// vencimento de cada assinatura à Asaas e acerta o cadastro.
//
// ── O QUE ELE FAZ ──────────────────────────────────────────────────────
// Para cada empresa com asaas_subscription_id: lê a assinatura na Asaas e
// compara com next_billing_date. Sem --aplicar imprime a tabela antes/depois
// e sai. Com --aplicar grava a data e registra em audit_log
// (action 'billing.next_due_corrected') o valor antigo e o novo.
//
// Idempotente: rodar de novo depois de aplicar mostra tudo como 'igual'.
// Precisa de DATABASE_URL e ASAAS_API_KEY de produção no ambiente. A mesma
// rotina está em POST /admin/painel/asaas/corrigir-vencimentos.
// ============================================================
'use strict';

const { corrigirVencimentos } = require('../src/services/asaasVencimentos');

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  if (process.argv.includes('--dry-run') && aplicar) {
    console.error('Escolha um: --dry-run (padrão) ou --aplicar.');
    process.exit(1);
  }

  console.log(aplicar ? 'APLICANDO as correções.' : 'DRY-RUN: nada será gravado. Use --aplicar para gravar.');
  const r = await corrigirVencimentos({ aplicar });

  console.table(r.linhas.map((l) => ({
    loja: l.nome,
    status: l.status,
    antes: l.antes || '(vazio)',
    depois: l.depois || '-',
    origem: l.origem || '-',
    situacao: l.situacao,
  })));
  console.log(
    `${r.total} assinaturas · ${r.iguais} já certas · ` +
    (aplicar ? `${r.corrigidos} corrigidas` : `${r.corrigir} a corrigir`) +
    ` · ${r.inativas} inativas na Asaas · ${r.erros} sem resposta`
  );
  process.exit(r.erros ? 2 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
