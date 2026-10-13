// ============================================================
// AURA. — Corrigir companies.next_billing_date pela Asaas (13/10/2026)
//
// O webhook gravava em next_billing_date o vencimento da cobrança que tinha
// acabado de ser paga (ver routes/webhookAsaas.js). O webhook foi corrigido,
// mas as datas já gravadas continuam um ciclo para trás até o próximo
// pagamento de cada loja. Esta rotina acerta todas de uma vez: para cada
// empresa com asaas_subscription_id, pergunta o próximo vencimento à Asaas
// (services/asaasAssinaturas → proximoVencimento) e grava.
//
// Quem chama:
//   node scripts/corrigirVencimentosAsaas.js [--aplicar]
//   POST /admin/painel/asaas/corrigir-vencimentos { aplicar: true }
//
// Sem `aplicar` nada é gravado: devolve a tabela antes/depois. Rodar de novo
// depois de aplicar devolve tudo como 'igual' — é idempotente. Cada data
// alterada fica em audit_log (action 'billing.next_due_corrected') com o
// valor antigo e o novo.
//
// Situação de cada linha:
//   igual               a data do cadastro já é a da Asaas
//   corrigir            difere (dry-run) — é o que `aplicar` vai mudar
//   corrigido           difere e foi gravada
//   assinatura_inativa  a assinatura não está ACTIVE na Asaas: não mexe
//   erro                a Asaas não respondeu para esta assinatura, ou ela
//                       não tem próxima cobrança (ex.: anual na última parcela)
// ============================================================
'use strict';

const pool = require('../config/database');
const cliente = require('./asaasClient');
const { NOME } = require('./painelBlocos/_base');
const { proximoVencimento, assinaturaAtiva } = require('./asaasAssinaturas');

const ACAO = 'billing.next_due_corrected';

async function corrigirVencimentos({ db = pool, asaas = cliente.asaas, aplicar = false, userId = null } = {}) {
  const { rows } = await db.query(
    `SELECT c.id AS company_id,
            ${NOME} AS nome,
            c.billing_status::text AS status,
            c.asaas_subscription_id,
            to_char(c.next_billing_date, 'YYYY-MM-DD') AS atual
       FROM companies c
      WHERE c.asaas_subscription_id IS NOT NULL
        AND c.asaas_subscription_id <> ''
      ORDER BY 2`
  );

  const linhas = [];
  // Uma por vez: são poucas dezenas de lojas e a Asaas limita requisições.
  for (const r of rows || []) {
    const linha = {
      company_id: r.company_id,
      nome: r.nome,
      status: r.status,
      assinatura: r.asaas_subscription_id,
      antes: r.atual || null,
      depois: null,
      origem: null,
      situacao: 'erro',
    };
    linhas.push(linha);

    const proximo = await proximoVencimento(asaas, r.asaas_subscription_id);
    if (!proximo) continue; // sem resposta ou sem próxima data: cadastro fica como está
    if (!assinaturaAtiva(proximo.assinatura)) {
      linha.situacao = 'assinatura_inativa';
      linha.origem = proximo.assinatura.status || 'deleted';
      continue;
    }
    linha.depois = proximo.data;
    linha.origem = proximo.origem;
    if (linha.depois === linha.antes) { linha.situacao = 'igual'; continue; }
    if (!aplicar) { linha.situacao = 'corrigir'; continue; }

    // A assinatura entra no WHERE: se o cadastro trocou de assinatura entre a
    // leitura e a escrita, a data lida já não é dele.
    const upd = await db.query(
      `UPDATE companies
          SET next_billing_date = $1::date, updated_at = NOW()
        WHERE id = $2 AND asaas_subscription_id = $3`,
      [linha.depois, r.company_id, r.asaas_subscription_id]
    );
    if (!upd || !upd.rowCount) { linha.situacao = 'erro'; continue; }
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        r.company_id,
        ACAO,
        `${linha.antes || 'sem data'} -> ${linha.depois}`,
        JSON.stringify({
          antes: linha.antes,
          depois: linha.depois,
          origem: linha.origem,
          asaas_subscription_id: r.asaas_subscription_id,
        }),
      ]
    );
    linha.situacao = 'corrigido';
  }

  const conta = (s) => linhas.filter((l) => l.situacao === s).length;
  return {
    aplicado: !!aplicar,
    total: linhas.length,
    corrigir: conta('corrigir'),
    corrigidos: conta('corrigido'),
    iguais: conta('igual'),
    inativas: conta('assinatura_inativa'),
    erros: conta('erro'),
    linhas,
  };
}

module.exports = { corrigirVencimentos, ACAO };
