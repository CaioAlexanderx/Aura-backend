// ============================================================
// AURA. — Limpeza das contas pendentes (tq-113, 26/10/2026)
//
// Decisão do Caio (26/10, opção B): a conta continua nascendo na etapa 3 do
// cadastro, antes da confirmação do e-mail. Quem não confirma em 7 dias tem
// a empresa DESATIVADA (companies.is_active = false). Nunca DELETE: a conta,
// os dados e o lead ficam; a empresa só deixa de existir para o login, para
// as listas e para os jobs.
//
// "Pendente" é a definição única de utils/contaPendente.js (dono com e-mail
// não confirmado, sem is_staff, fora conta interna e sandbox).
//
// ── O QUE O JOB FAZ, POR EMPRESA ───────────────────────────────────────
//   1. confere de novo, em JS, todas as travas abaixo (o SQL só pré-filtra);
//   2. garante o lead em signup_leads: cria a partir do usuário (nome,
//      e-mail, WhatsApp, origem do cadastro) quando não existe, e marca
//      motivo = 'nao_confirmou_email';
//   3. desativa: is_active = false, desativada_por = 'conta_pendente',
//      desativada_em = NOW(). O UPDATE repete as travas de dinheiro (venda,
//      assinatura, billing ativo): uma venda que entrou no meio do caminho
//      faz o UPDATE não pegar a linha;
//   4. grava o audit_log da empresa ('conta_pendente.desativada').
// Tudo numa transação por empresa: lead, empresa e histórico andam juntos.
//
// ── NUNCA TOCA (só registra no log) ────────────────────────────────────
//   empresa com venda; com pagamento (assinatura_cobrancas ou evento da
//   Asaas em webhook_logs); com assinatura na Asaas (asaas_subscription_id);
//   billing_status = 'active'; conta interna; sandbox; empresa do canário;
//   Karatê/dojô (vertical, vertical_active ou federation_id); e empresa de
//   dono que tem mais de uma empresa (só a ÚNICA empresa do dono é
//   desativada; com duas, nenhuma é tocada).
//
// ── VOLTA ──────────────────────────────────────────────────────────────
// reativarAoConfirmar(userId): chamado pela confirmação do e-mail
// (routes/verification.js). Reabre SÓ as empresas do dono com
// desativada_por = 'conta_pendente' (nunca uma desativada à mão ou por
// outro motivo), grava 'conta_pendente.reativada' no audit_log e limpa o
// motivo do lead.
//
// ── INTERRUPTORES ──────────────────────────────────────────────────────
//   LIMPEZA_PENDENTES_ENABLED=false   desliga o job (padrão: ligado). Lido a
//                                     cada volta: vale sem deploy.
//   LIMPEZA_PENDENTES_DRY_RUN=true    só loga quem seria desativado.
// Sem a migration 413 (colunas desativada_por e signup_leads.motivo) o job
// não desativa nada: sem a marca, a confirmação não saberia reabrir.
// ============================================================
'use strict';

const { sqlContaPendente, ehContaPendente } = require('../utils/contaPendente');
const { validarCelular } = require('./whatsappCadastro');
const crypto = require('crypto');

const DIAS_PARA_DESATIVAR = 7;
const DESATIVADA_POR = 'conta_pendente';
const MOTIVO_DO_LEAD = 'nao_confirmou_email';
const ACAO_DESATIVADA = 'conta_pendente.desativada';
const ACAO_REATIVADA = 'conta_pendente.reativada';
const VERTICAIS_KARATE = ['karate_dojo', 'karate_federation'];
const LIMITE_POR_VOLTA = 200;
const DIA_MS = 86400000;

function ligado(valor, padrao) {
  if (valor == null || String(valor).trim() === '') return padrao;
  return !/^(0|false|off|no|nao|não)$/i.test(String(valor).trim());
}

function lerConfig(env = process.env) {
  return {
    enabled: ligado(env.LIMPEZA_PENDENTES_ENABLED, true),
    dryRun: ligado(env.LIMPEZA_PENDENTES_DRY_RUN, false),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idDoCanario(env = process.env) {
  const id = String(env.CANARY_COMPANY_ID || '').trim().toLowerCase();
  return UUID_RE.test(id) ? id : null;
}

const schemaAusente = (e) => !!e && (e.code === '42P01' || e.code === '42703');

/**
 * A regra em JS, sobre os fatos de uma empresa. Pura.
 * Devolve { desativar: true } ou { desativar: false, motivo }.
 */
function avaliar(f, { agora = new Date(), env = process.env } = {}) {
  const manter = (motivo) => ({ desativar: false, motivo });
  if (!f) return manter('sem_dados');
  if (f.is_active === false) return manter('ja_inativa');
  if (!ehContaPendente({
    email_verified: f.email_verified, is_staff: f.is_staff, is_sandbox: f.is_sandbox,
    owner_email: f.owner_email, company_email: f.company_email, tem_dono: !!f.owner_id,
  })) return manter('nao_pendente');
  const canario = idDoCanario(env);
  if (canario && String(f.company_id).toLowerCase() === canario) return manter('canario');
  if (VERTICAIS_KARATE.includes(f.vertical) || VERTICAIS_KARATE.includes(f.vertical_active)
    || f.federation_id) return manter('karate');
  if (f.billing_status === 'active') return manter('billing_ativo');
  if (f.asaas_subscription_id) return manter('assinatura_asaas');
  if (f.tem_venda === true) return manter('tem_venda');
  if (f.tem_pagamento === true) return manter('tem_pagamento');
  if (Number(f.empresas_do_dono) > 1) return manter('dono_com_mais_de_uma_empresa');

  // 7 dias desde o cadastro (o mais recente entre usuário e empresa).
  const desde = Math.max(
    new Date(f.user_created_at || 0).getTime() || 0,
    new Date(f.company_created_at || 0).getTime() || 0
  );
  if (!desde || agora.getTime() - desde < DIAS_PARA_DESATIVAR * DIA_MS) return manter('menos_de_7_dias');
  return { desativar: true, motivo: null };
}

// Pré-filtro barato no SQL (pendente, ativa, cadastro com mais de 7 dias);
// o resto da regra é avaliar().
async function buscarCandidatas(db, agora = new Date()) {
  const corte = new Date(agora.getTime() - DIAS_PARA_DESATIVAR * DIA_MS).toISOString();
  const { rows } = await db.query(
    `-- limpezaPendentes:candidatas
     SELECT c.id AS company_id, c.owner_id, c.is_active, c.created_at AS company_created_at,
            COALESCE(c.trade_name, c.legal_name) AS loja,
            c.email AS company_email, c.is_sandbox, c.vertical, c.vertical_active, c.federation_id,
            c.billing_status, c.asaas_subscription_id, c.signup_origin, c.phone AS company_phone,
            u.email AS owner_email, u.full_name, u.phone AS owner_phone,
            u.created_at AS user_created_at, u.email_verified, u.is_staff,
            EXISTS (SELECT 1 FROM sales s WHERE s.company_id = c.id) AS tem_venda,
            EXISTS (SELECT 1 FROM webhook_logs w WHERE w.company_id = c.id) AS tem_evento_asaas,
            (SELECT COUNT(*)::int FROM companies o WHERE o.owner_id = c.owner_id) AS empresas_do_dono
       FROM companies c
       JOIN users u ON u.id = c.owner_id
      WHERE c.is_active = true
        AND ${sqlContaPendente('c')}
        AND u.created_at < $1::timestamptz
        AND c.created_at < $1::timestamptz
      ORDER BY c.created_at, c.id
      LIMIT ${LIMITE_POR_VOLTA}`,
    [corte]
  );
  return rows || [];
}

// Cobrança da assinatura Aura (migration 408). Tabela ausente = sem cobrança.
async function temCobranca(db, companyId) {
  try {
    const { rows } = await db.query(
      `-- limpezaPendentes:cobranca
       SELECT 1 FROM assinatura_cobrancas WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    return !!(rows && rows.length);
  } catch (e) {
    if (schemaAusente(e)) return false;
    throw e;
  }
}

// A migration 413 está aplicada? Sem ela o job não desativa ninguém.
async function migrationAplicada(db) {
  try {
    await db.query('-- limpezaPendentes:schema\n SELECT desativada_por, desativada_em FROM companies LIMIT 0');
    await db.query('-- limpezaPendentes:schema-lead\n SELECT motivo FROM signup_leads LIMIT 0');
    return true;
  } catch (e) {
    if (schemaAusente(e)) return false;
    throw e;
  }
}

function whatsappDe(f) {
  for (const bruto of [f.owner_phone, f.company_phone]) {
    if (!bruto) continue;
    const r = validarCelular(bruto);
    if (r && r.ok) return r.numero;
  }
  return null;
}

// Garante o lead e marca o motivo. Devolve { id, criado }.
async function garantirLead(client, f) {
  const email = String(f.owner_email || '').trim().toLowerCase();
  if (!email) return { id: null, criado: false };
  const token = crypto.randomBytes(24).toString('hex');
  const { rows } = await client.query(
    `-- limpezaPendentes:lead
     INSERT INTO signup_leads (token, email, nome, origem, whatsapp, etapa,
                               company_id, user_id, convertido_em, motivo)
     VALUES ($1, $2, $3, $4::jsonb, $5, 3, $6, $7, $8::timestamptz, $9)
     ON CONFLICT (email) DO UPDATE
        SET motivo = EXCLUDED.motivo,
            company_id = COALESCE(signup_leads.company_id, EXCLUDED.company_id),
            user_id = COALESCE(signup_leads.user_id, EXCLUDED.user_id),
            whatsapp = COALESCE(signup_leads.whatsapp, EXCLUDED.whatsapp),
            origem = COALESCE(signup_leads.origem, EXCLUDED.origem),
            atualizado_em = NOW()
     RETURNING id, (xmax = 0) AS criado`,
    [
      token, email, f.full_name || null,
      f.signup_origin ? JSON.stringify(f.signup_origin) : null,
      whatsappDe(f), f.company_id, f.owner_id, f.user_created_at || null, MOTIVO_DO_LEAD,
    ]
  );
  const r = rows && rows[0];
  return { id: r ? r.id : null, criado: !!(r && r.criado) };
}

// Uma empresa, numa transação. Devolve true quando desativou.
async function desativarEmpresa(pool, f, { agora = new Date() } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lead = await garantirLead(client, f);
    const { rows } = await client.query(
      `-- limpezaPendentes:desativar
       UPDATE companies c
          SET is_active = false, desativada_por = $2, desativada_em = NOW(), updated_at = NOW()
        WHERE c.id = $1
          AND c.is_active = true
          AND c.desativada_por IS NULL
          AND c.asaas_subscription_id IS NULL
          AND c.billing_status IS DISTINCT FROM 'active'
          AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.company_id = c.id)
          AND ${sqlContaPendente('c')}
        RETURNING c.id`,
      [f.company_id, DESATIVADA_POR]
    );
    if (!rows || !rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    const dias = Math.floor((agora.getTime() - new Date(f.user_created_at).getTime()) / DIA_MS);
    await client.query(
      `-- limpezaPendentes:audit
       INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        f.owner_id, f.company_id, ACAO_DESATIVADA,
        `Empresa desativada: o dono não confirmou o e-mail em ${DIAS_PARA_DESATIVAR} dias (tq-113)`,
        JSON.stringify({
          desativada_por: DESATIVADA_POR, dias_desde_o_cadastro: dias,
          lead_id: lead.id, lead_criado: lead.criado, motivo_do_lead: MOTIVO_DO_LEAD,
        }),
      ]
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* segue com o erro original */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Uma volta do job. Nunca lança por causa de uma empresa: a falha de uma
 * vai para o resumo e a próxima segue.
 */
async function rodarLimpeza({ pool, agora = new Date(), env = process.env, log = console.log } = {}) {
  const cfg = lerConfig(env);
  const resumo = { ligado: cfg.enabled, dryRun: cfg.dryRun, candidatas: 0, desativadas: 0, mantidas: {}, falhas: 0 };
  if (!cfg.enabled) return resumo;
  if (!(await migrationAplicada(pool))) {
    resumo.migrationPendente = true;
    return resumo;
  }
  const fatos = await buscarCandidatas(pool, agora);
  resumo.candidatas = fatos.length;
  for (const f of fatos) {
    try {
      f.tem_pagamento = f.tem_evento_asaas === true || await temCobranca(pool, f.company_id);
      const decisao = avaliar(f, { agora, env });
      if (!decisao.desativar) {
        resumo.mantidas[decisao.motivo] = (resumo.mantidas[decisao.motivo] || 0) + 1;
        log(`[limpezaPendentes] mantida ${f.company_id}: ${decisao.motivo}`);
        continue;
      }
      if (cfg.dryRun) {
        log(`[limpezaPendentes] (dry-run) desativaria ${f.company_id}`);
        resumo.desativadas += 1;
        continue;
      }
      const ok = await desativarEmpresa(pool, f, { agora });
      if (ok) {
        resumo.desativadas += 1;
        log(`[limpezaPendentes] desativada ${f.company_id}`);
      } else {
        resumo.mantidas.mudou_no_caminho = (resumo.mantidas.mudou_no_caminho || 0) + 1;
      }
    } catch (e) {
      resumo.falhas += 1;
      log(`[limpezaPendentes] falha em ${f.company_id}: ${e && (e.code || e.message)}`);
    }
  }
  return resumo;
}

/**
 * Confirmação do e-mail: reabre as empresas do dono desativadas por este job.
 * Devolve os ids reabertos. Nunca lança (a confirmação não pode falhar por
 * isto); coluna ausente (413 pendente) = nada a reabrir.
 */
async function reativarAoConfirmar(userId, { db = require('../config/database') } = {}) {
  if (!userId) return [];
  try {
    const { rows } = await db.query(
      `-- limpezaPendentes:reativar
       UPDATE companies
          SET is_active = true, desativada_por = NULL, desativada_em = NULL, updated_at = NOW()
        WHERE owner_id = $1
          AND is_active = false
          AND desativada_por = $2
        RETURNING id`,
      [userId, DESATIVADA_POR]
    );
    const ids = (rows || []).map((r) => r.id);
    for (const id of ids) {
      try {
        await db.query(
          `-- limpezaPendentes:audit-reativada
           INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [userId, id, ACAO_REATIVADA, 'Empresa reativada: o dono confirmou o e-mail (tq-113)',
            JSON.stringify({ desativada_por: DESATIVADA_POR })]
        );
      } catch (e) {
        console.warn('[limpezaPendentes] audit da reativação falhou:', e && (e.code || e.message));
      }
    }
    if (ids.length) {
      try {
        await db.query(
          `-- limpezaPendentes:lead-reativado
           UPDATE signup_leads SET motivo = NULL, atualizado_em = NOW()
            WHERE user_id = $1 AND motivo = $2`,
          [userId, MOTIVO_DO_LEAD]
        );
      } catch (e) {
        if (!schemaAusente(e)) console.warn('[limpezaPendentes] lead da reativação:', e && (e.code || e.message));
      }
    }
    return ids;
  } catch (e) {
    if (!schemaAusente(e)) console.error('[limpezaPendentes] reativação falhou:', e && (e.code || e.message));
    return [];
  }
}

module.exports = {
  DIAS_PARA_DESATIVAR,
  DESATIVADA_POR,
  MOTIVO_DO_LEAD,
  ACAO_DESATIVADA,
  ACAO_REATIVADA,
  lerConfig,
  avaliar,
  buscarCandidatas,
  rodarLimpeza,
  desativarEmpresa,
  reativarAoConfirmar,
};
