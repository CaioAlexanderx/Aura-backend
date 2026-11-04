// ============================================================
// AURA. — E-mail de fechamento do mês (03/11/2026)
//
// Mockup aprovado: aura-app docs/mockups/relatorio-vendas-por-numeracao.html,
// tela 6. Decisões do PO: e-mail NOVO, separado do semanal; LIGADO para
// todos com opção de desligar (Configurações › E-mails, tipo
// 'fechamento_mes'); planilha .xlsx anexa (services/planilhaXlsx.js).
//
// Quando: dia 1º, a partir das 8h de Brasília (gancho que já existia no
// reportScheduler: "mensal pendente de implementação"). Sem retroativo:
// passou o dia 1º, o mês não sai mais.
//
// Quem recebe: o mesmo público do relatório semanal (empresa ativa, fora de
// sandbox e do Karatê, não marcada "Não quer", dono com e-mail confirmado,
// teste vigente ou assinatura ativa), com a preferência fechamento_mes
// ligada. Grupo do mesmo dono = um e-mail consolidado (a primária decide os
// destinatários), como o semanal. Mês sem nenhuma venda: nada sai.
//
// Idempotência: email_log com a chave fechamento:<primária>:<YYYY-MM>,
// reservada ANTES de gerar (reinício, dois ticks ou duas instâncias nunca
// mandam duas vezes). O "nada a enviar" fica num Set do processo para não
// refazer a conta a cada minuto do dia 1º.
// ============================================================
'use strict';

const db = require('../config/database');
const P = require('./emailPreferencias');
const { semPendente } = require('../utils/contaPendente');
const { reservarEnvio, marcarEnviado, marcarFalha } = require('./emailLog');
const { vendasPorNumeracao, resolverPeriodo, hojeSP, SEM_NUMERACAO } = require('./vendasPorNumeracao');
const { montarXlsx } = require('./planilhaXlsx');

const VERTICAIS_FORA = ['karate_dojo', 'karate_federation'];
const HORA = 8;

function agoraBRT(now = Date.now()) {
  return new Date(now - 3 * 3600000);
}

/** Dia 1º, a partir das 8h (BRT). */
function naJanela(now = Date.now()) {
  const t = agoraBRT(now);
  return t.getUTCDate() === 1 && t.getUTCHours() >= HORA;
}

// ── Planilha ──────────────────────────────────────────────────────

const COLUNAS = [
  { titulo: 'Modelo', largura: 38 },
  { titulo: 'Referência', largura: 14 },
  { titulo: 'Tipo', largura: 16 },
  { titulo: 'Cor', largura: 12 },
  { titulo: 'Numeração', largura: 13 },
  { titulo: 'Vendidos', tipo: 'numero', largura: 10 },
  { titulo: 'Receita (R$)', tipo: 'moeda', largura: 14 },
  { titulo: 'Estoque hoje', tipo: 'numero', largura: 13 },
  { titulo: 'Giro do modelo (%)', tipo: 'inteiro', largura: 17 },
  { titulo: 'Comprar p/ repor', tipo: 'numero', largura: 16 },
];

/** Uma linha por modelo × numeração (a receita fica na 1ª linha do modelo). */
function linhasDaPlanilha(rel) {
  const linhas = [];
  for (const m of rel.modelos || []) {
    m.numeracoes.forEach((c, i) => {
      linhas.push([
        m.nome, m.sku || '', m.tipo, m.cor || '', c.numeracao,
        c.vendidos, i === 0 ? m.receita : null, c.estoque,
        i === 0 ? m.giro_pct : null,
        c.numeracao === SEM_NUMERACAO ? null : Math.max(0, c.vendidos - c.estoque),
      ]);
    });
  }
  return linhas;
}

function nomeDoArquivo(periodo) {
  return `vendas-por-numeracao-${periodo.inicio.slice(0, 7)}.xlsx`;
}

function planilhaDoMes(rel) {
  return montarXlsx({ aba: rel.periodo.rotulo, colunas: COLUNAS, linhas: linhasDaPlanilha(rel) });
}

// ── Quem recebe ───────────────────────────────────────────────────

async function empresasElegiveis({ fimDoPeriodo, env = process.env } = {}) {
  const padraoLigado = P.relatorioPadraoLigado(env);
  const interna = `(COALESCE(u.is_staff, false) = true
                    OR lower(COALESCE(u.email, '')) LIKE '%@getaura.com.br'
                    OR lower(COALESCE(c.email, '')) LIKE '%@getaura.com.br')`;
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.owner_id, c.is_primary, c.created_at,
              COALESCE(c.trade_name, c.legal_name) AS name,
              u.email AS owner_email, p.config AS pref_config
         FROM companies c
         LEFT JOIN users u ON u.id = c.owner_id
         LEFT JOIN company_email_prefs p ON p.company_id = c.id AND p.tipo = 'fechamento_mes'
        WHERE c.is_active = true
          AND COALESCE(c.is_sandbox, false) = false
          AND COALESCE(c.vertical, '') <> ALL($1::text[])
          AND COALESCE(c.vertical_active, '') <> ALL($1::text[])
          AND NOT ${P.sqlMarcaNaoQuer('c.id')}
          AND ${semPendente('c')}
          AND c.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND (p.ligado = true OR (p.ligado IS NULL AND $2::boolean AND NOT ${interna}))
          AND (
                ${interna}
             OR c.billing_status = 'active'
             OR (COALESCE(c.billing_status, 'trial') = 'trial' AND c.trial_ends_at > NOW())
          )
        ORDER BY c.owner_id NULLS LAST, c.is_primary DESC NULLS LAST, c.created_at ASC
        LIMIT 2000`,
      [VERTICAIS_FORA, padraoLigado, fimDoPeriodo]
    );
    return rows;
  } catch (err) {
    // Sem a migration 409 não existe preferência: não manda e-mail novo.
    if (err && err.code === '42P01') return [];
    throw err;
  }
}

function agruparPorDono(rows) {
  const grupos = new Map();
  for (const r of rows) {
    const k = r.owner_id || `solo:${r.id}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(r);
  }
  return [...grupos.values()].map((todas) => {
    const primaria = todas.find((m) => m.is_primary) || todas[0];
    const pref = P.preferenciaEfetiva('fechamento_mes', { ligado: true, config: primaria.pref_config || {} });
    return { primaria, todas, config: pref.config };
  });
}

// ── Envio ─────────────────────────────────────────────────────────

const jaResolvido = new Set(); // chave -> já enviado ou sem nada a enviar (neste processo)

// Antes de gerar (a conta do mês é pesada): a chave já está no email_log?
async function jaNoLog(chave) {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM email_log
        WHERE chave_idempotencia = $1 AND (status IN ('sent', 'reserved') OR tentativas >= $2)
        LIMIT 1`,
      [chave, require('./emailLog').MAX_TENTATIVAS]
    );
    return rows.length > 0;
  } catch (err) {
    if (err && err.code === '42P01') return false;
    throw err;
  }
}

function chaveDoGrupo(primariaId, periodo) {
  return `fechamento:${primariaId}:${periodo.inicio.slice(0, 7)}`;
}

/**
 * Monta e envia o fechamento de um grupo. 'sent' | 'skipped' | 'duplicate'.
 * `enviar` e `gerar` injetáveis nos testes.
 */
async function enviarGrupo(g, { periodo, env = process.env, enviar, gerar = vendasPorNumeracao } = {}) {
  const chave = chaveDoGrupo(g.primaria.id, periodo);
  if (jaResolvido.has(chave)) return 'skipped';
  if (await jaNoLog(chave)) { jaResolvido.add(chave); return 'duplicate'; }
  const ids = g.todas.map((c) => c.id);

  const rel = await gerar(db, { companyId: g.primaria.id, companyIds: ids, periodo });
  if (!rel || !(rel.kpis && rel.kpis.vendidos > 0)) {
    jaResolvido.add(chave);
    return 'skipped';
  }

  const destinatarios = await P.destinatariosDoTipo(db, g.primaria.id, 'fechamento_mes', {
    prefs: { fechamento_mes: { config: g.config } },
    dono: { email: P.normalizarEmail(g.primaria.owner_email) },
    env,
  });
  if (!destinatarios.length) {
    jaResolvido.add(chave);
    return 'skipped';
  }

  const nome = ids.length > 1 ? `${g.primaria.name} (+${ids.length - 1} unid.)` : g.primaria.name;
  const logId = await reservarEnvio(db, {
    chave, tipo: 'fechamento_mes', companyId: g.primaria.id, userId: g.primaria.owner_id || null,
    destinatario: destinatarios, assunto: `Fechamento de ${periodo.rotulo} — ${nome}`,
    metadata: { mes: periodo.inicio.slice(0, 7), empresas: ids.length },
  });
  if (!logId) { jaResolvido.add(chave); return 'duplicate'; }

  try {
    const { montarEmailDoFechamento } = require('../templates/fechamentoDoMes');
    const email = montarEmailDoFechamento({
      rel: { ...rel, periodo }, companyId: g.primaria.id, nome, grupo: ids.length > 1, env,
    });
    const envio = await (enviar || require('./mailer').sendMail)({
      from: 'Aura <contato@getaura.com.br>',
      to: destinatarios,
      subject: email.assunto,
      html: email.html,
      text: email.text,
      headers: email.cabecalhos,
      tipo: 'fechamento_mes',
      companyId: g.primaria.id,
      _registrado: true,
      attachments: [{
        filename: nomeDoArquivo(periodo),
        content: planilhaDoMes({ ...rel, periodo }),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    });
    await marcarEnviado(db, logId, (envio && envio.id) || null).catch(() => {});
    jaResolvido.add(chave);
    console.log(`[fechamentoDoMes] sent company=${g.primaria.id} id=${(envio && envio.id) || '-'}`);
    return 'sent';
  } catch (err) {
    await marcarFalha(db, logId, err.message).catch(() => {});
    throw err;
  }
}

/** Uma volta do agendador. `forcar` (testes): ignora o dia e a hora. */
async function enviarFechamentos({ now = Date.now(), env = process.env, forcar = false, enviar, gerar } = {}) {
  const c = { sent: 0, skipped: 0, duplicate: 0, errors: 0 };
  if (!forcar && !naJanela(now)) return c;
  const periodo = resolverPeriodo('last_month', null, null, hojeSP(now));
  try {
    const grupos = agruparPorDono(await empresasElegiveis({ fimDoPeriodo: periodo.fim, env }));
    for (const g of grupos) {
      try {
        const r = await enviarGrupo(g, { periodo, env, enviar, gerar });
        c[r] = (c[r] || 0) + 1;
      } catch (err) {
        c.errors++;
        console.error(`[fechamentoDoMes] erro em ${g.primaria.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[fechamentoDoMes] fatal:', err.message);
  }
  if (c.sent || c.errors) console.log(`[fechamentoDoMes] ${periodo.rotulo}: sent=${c.sent} skipped=${c.skipped} duplicate=${c.duplicate} errors=${c.errors}`);
  return c;
}

function _limparMemoria() { jaResolvido.clear(); }

module.exports = {
  COLUNAS,
  naJanela,
  linhasDaPlanilha,
  planilhaDoMes,
  nomeDoArquivo,
  empresasElegiveis,
  agruparPorDono,
  enviarGrupo,
  enviarFechamentos,
  _limparMemoria,
};
