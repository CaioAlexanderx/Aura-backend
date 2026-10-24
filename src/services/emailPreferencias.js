// ============================================================
// AURA. — Preferências de e-mail por empresa (tq-74 → tq-87/tq-88, 24/10/2026)
//
// Fonte: company_email_prefs (migration 409), uma linha por empresa e tipo.
// Linha AUSENTE vale o padrão (PADROES). Cobrança e segurança não têm
// preferência: sempre saem (tipoLigado devolve true).
//
// Todo envio que respeita preferência chama tipoLigado() NA HORA de mandar,
// sem cache: o descadastro vale imediatamente.
//
// Endereços: o principal é o e-mail do dono (users.email de
// companies.owner_id), lido na hora. Os extras ficam em
// company_email_addresses e só recebem depois de confirmados pelo link.
//
// Cada desligamento pelo e-mail (descadastro, reclamação de spam) grava uma
// linha em audit_log (action 'email.descadastro') por empresa desligada.
//
// Kill switch (padrão ligado): RELATORIO_PADRAO_LIGADO=false ou
// EMAILS_CICLO_ENABLED=false fazem a linha ausente do relatório valer
// DESLIGADO: só recebe quem tem linha explícita ligada (as empresas que já
// recebiam, migradas pela 409, e quem ligou na tela).
// ============================================================
'use strict';

const { linkDescadastro, cabecalhosDescadastro, linkAjustarEmails } = require('./emailLinks');

const TIPOS = Object.freeze({
  relatorio:      { rotulo: 'o relatório semanal' },
  ajuda:          { rotulo: 'os e-mails de ajuda para começar' },
  acompanhamento: { rotulo: 'os e-mails de acompanhamento' },
  novidades:      { rotulo: 'as novidades da Aura' },
  pedido_loja:    { rotulo: 'o aviso de pedido novo da loja online' },
});

// Sem preferência: sempre saem.
const TIPOS_SEMPRE = Object.freeze(['cobranca', 'seguranca']);

// Blocos do relatório (mock da Nina, 21/10). O relatório longo (tq-85) lê
// blocosDoRelatorio(): o que o dono deixou ligado E o plano tem.
const BLOCOS = Object.freeze([
  'vendas',             // Vendas e comparação da semana
  'mais_vendidos',      // Mais vendidos e curva ABC
  'pagamentos_estoque', // Pagamentos, contas e estoque
  'crediario',          // Crediário da semana (Negócio)
  'equipe_margem',      // Equipe e margem (Negócio)
  'clientes',           // Clientes e aniversariantes (Negócio)
  'loja_online',        // Loja online e meta do mês (Negócio)
]);
const BLOCOS_ESSENCIAL = Object.freeze(['vendas', 'mais_vendidos', 'pagamentos_estoque']);

const VERSOES = Object.freeze(['completa', 'resumo']);
const DESTINOS_PEDIDO = Object.freeze(['equipe', 'enderecos']);
const DIAS_DA_SEMANA = Object.freeze(['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']);

function ligadoEnv(valor, padrao) {
  if (valor == null || String(valor).trim() === '') return padrao;
  return !/^(0|false|off|no|nao|não)$/i.test(String(valor).trim());
}

function relatorioPadraoLigado(env = process.env) {
  return ligadoEnv(env.RELATORIO_PADRAO_LIGADO, true) && ligadoEnv(env.EMAILS_CICLO_ENABLED, true);
}

function tipoValido(tipo) {
  return Object.prototype.hasOwnProperty.call(TIPOS, tipo);
}

/** Padrão de quem não tem linha (Caio, 21/10). */
function padrao(tipo, env = process.env) {
  switch (tipo) {
    case 'relatorio':
      return {
        ligado: relatorioPadraoLigado(env),
        config: { dia: 1, hora: 8, versao: 'completa', blocos: [...BLOCOS], destinatarios: null },
      };
    case 'pedido_loja':
      // pedido_destino ausente = 'equipe', o comportamento de hoje (todos os
      // company_members). Só muda quando a loja escolhe na tela.
      return { ligado: true, config: { pedido_destino: 'equipe', destinatarios: null } };
    case 'ajuda':
    case 'acompanhamento':
    case 'novidades':
      return { ligado: true, config: {} };
    default:
      return null;
  }
}

function normalizarEmail(v) {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  return /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/.test(s) && s.length <= 254 ? s : null;
}

/** Junta a linha (ou a falta dela) com o padrão. */
function preferenciaEfetiva(tipo, linha, env = process.env) {
  const p = padrao(tipo, env);
  if (!p) return null;
  const cfg = (linha && linha.config && typeof linha.config === 'object') ? linha.config : {};
  const config = { ...p.config };
  for (const k of Object.keys(p.config)) {
    if (cfg[k] !== undefined) config[k] = cfg[k];
  }
  const out = {
    ligado: linha && typeof linha.ligado === 'boolean' ? linha.ligado : p.ligado,
    config,
    explicito: !!(linha && typeof linha.ligado === 'boolean'),
  };
  if (tipo === 'pedido_loja') out.pedido_destino_escolhido = cfg.pedido_destino !== undefined;
  return out;
}

async function lerLinhas(db, companyIds) {
  const ids = Array.isArray(companyIds) ? companyIds : [companyIds];
  const { rows } = await db.query(
    `SELECT company_id, tipo, ligado, config
       FROM company_email_prefs
      WHERE company_id = ANY($1::uuid[])`,
    [ids]
  );
  return rows || [];
}

/**
 * Preferências efetivas da empresa, todos os tipos. Sem a tabela (42P01,
 * deploy antes da migration): os padrões, com o relatório lido de
 * companies.weekly_report_enabled.
 */
async function preferenciasDaEmpresa(db, companyId, { env = process.env } = {}) {
  let linhas;
  try {
    linhas = await lerLinhas(db, companyId);
  } catch (err) {
    if (err && err.code !== '42P01') throw err;
    linhas = await linhasLegadas(db, companyId);
  }
  return efetivasDasLinhas(linhas, env);
}

function efetivasDasLinhas(linhas, env = process.env) {
  const porTipo = new Map((linhas || []).map((l) => [l.tipo, l]));
  const out = {};
  for (const tipo of Object.keys(TIPOS)) out[tipo] = preferenciaEfetiva(tipo, porTipo.get(tipo), env);
  return out;
}

async function linhasLegadas(db, companyId) {
  try {
    const { rows } = await db.query('SELECT weekly_report_enabled FROM companies WHERE id = $1', [companyId]);
    const r = rows && rows[0];
    return r ? [{ company_id: companyId, tipo: 'relatorio', ligado: r.weekly_report_enabled === true, config: {} }] : [];
  } catch (_) {
    return [];
  }
}

/**
 * O tipo está ligado para a empresa? Lido na hora, sem cache. Cobrança e
 * segurança: sempre true. Tipo desconhecido: false.
 */
async function tipoLigado(db, companyId, tipo, { env = process.env } = {}) {
  if (TIPOS_SEMPRE.includes(tipo)) return true;
  if (!tipoValido(tipo) || !companyId) return false;
  let linha = null;
  try {
    const { rows } = await db.query(
      'SELECT ligado, config FROM company_email_prefs WHERE company_id = $1 AND tipo = $2',
      [companyId, tipo]
    );
    linha = (rows && rows[0]) || null;
  } catch (err) {
    if (err && err.code !== '42P01') throw err;
    if (tipo === 'relatorio') {
      const [l] = await linhasLegadas(db, companyId);
      return !!(l && l.ligado);
    }
  }
  return preferenciaEfetiva(tipo, linha, env).ligado;
}

// ── Endereços ───────────────────────────────────────────────────

/** Dono da empresa: e-mail principal, nome e loja. */
async function donoDaEmpresa(db, companyId) {
  const { rows } = await db.query(
    `SELECT c.id, c.owner_id, COALESCE(c.trade_name, c.legal_name) AS loja, c.plan,
            u.email AS owner_email, u.full_name AS owner_name
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = $1`,
    [companyId]
  );
  const r = rows && rows[0];
  if (!r) return null;
  return {
    companyId: r.id,
    userId: r.owner_id || null,
    email: normalizarEmail(r.owner_email),
    nome: r.owner_name || null,
    loja: r.loja || null,
    plano: r.plan || null,
  };
}

/** Extras da empresa (company_email_addresses). Sem a tabela: []. */
async function enderecosExtras(db, companyId) {
  try {
    const { rows } = await db.query(
      `SELECT id, email, confirmado_em, confirmacao_enviada_em, created_at
         FROM company_email_addresses
        WHERE company_id = $1
        ORDER BY created_at ASC`,
      [companyId]
    );
    return rows || [];
  } catch (err) {
    if (err && err.code === '42P01') return [];
    throw err;
  }
}

/**
 * Endereços que podem receber o tipo, já confirmados: o principal (dono) e
 * os extras confirmados, filtrados por config.destinatarios quando a
 * empresa marcou quem recebe. Sem duplicados, em minúsculas.
 */
function destinatariosDe({ principal, extras, config }) {
  const confirmados = [];
  if (principal) confirmados.push(principal);
  for (const x of extras || []) {
    const e = normalizarEmail(x.email);
    if (e && x.confirmado_em) confirmados.push(e);
  }
  const unicos = [...new Set(confirmados)];
  const marcados = config && Array.isArray(config.destinatarios)
    ? new Set(config.destinatarios.map(normalizarEmail).filter(Boolean))
    : null;
  return marcados ? unicos.filter((e) => marcados.has(e)) : unicos;
}

async function destinatariosDoTipo(db, companyId, tipo, { prefs = null, dono = null, env = process.env } = {}) {
  const p = prefs || await preferenciasDaEmpresa(db, companyId, { env });
  const d = dono || await donoDaEmpresa(db, companyId);
  const extras = await enderecosExtras(db, companyId);
  return destinatariosDe({ principal: d && d.email, extras, config: p[tipo] && p[tipo].config });
}

/**
 * Para onde vai o e-mail de pedido novo da loja online (tq-88):
 *   { ligado: false }                         ninguém
 *   { ligado: true, destino: 'equipe' }       todos os company_members (hoje)
 *   { ligado: true, destino: 'enderecos', emails }  os endereços da tela
 */
async function destinoDoPedido(db, companyId, { env = process.env } = {}) {
  const prefs = await preferenciasDaEmpresa(db, companyId, { env });
  const p = prefs.pedido_loja;
  if (!p.ligado) return { ligado: false, destino: p.config.pedido_destino, emails: [] };
  if (p.config.pedido_destino !== 'enderecos') return { ligado: true, destino: 'equipe', emails: null };
  const emails = await destinatariosDoTipo(db, companyId, 'pedido_loja', { prefs, env });
  return { ligado: true, destino: 'enderecos', emails };
}

/** Blocos que o relatório longo mostra: os ligados que o plano tem. */
function blocosDoPlano(plano) {
  return plano === 'negocio' || plano === 'expansao' ? [...BLOCOS] : [...BLOCOS_ESSENCIAL];
}

function blocosDoRelatorio(config, plano) {
  const doPlano = new Set(blocosDoPlano(plano));
  const escolhidos = config && Array.isArray(config.blocos) ? config.blocos : BLOCOS;
  return BLOCOS.filter((b) => doPlano.has(b) && escolhidos.includes(b));
}

/** "toda segunda, às 8h" (rodapé do relatório). */
function quandoDoRelatorio(config) {
  const dia = Number.isInteger(config && config.dia) ? config.dia : 1;
  const hora = Number.isInteger(config && config.hora) ? config.hora : 8;
  const artigo = dia === 0 || dia === 6 ? 'todo' : 'toda';
  return `${artigo} ${DIAS_DA_SEMANA[dia]}, às ${hora}h`;
}

// ── Escrita pela tela (PUT) ─────────────────────────────────────

const CAMPOS = Object.freeze({
  relatorio: ['ligado', 'dia', 'hora', 'versao', 'blocos', 'destinatarios'],
  pedido_loja: ['ligado', 'pedido_destino', 'destinatarios'],
  ajuda: ['ligado'],
  acompanhamento: ['ligado'],
  novidades: ['ligado'],
});

function erro(codigo, mensagem) {
  return { ok: false, codigo, mensagem };
}

/**
 * Valida o corpo do PUT. `conhecidos`: e-mails da empresa (principal e
 * extras, confirmados ou não) que podem entrar em destinatarios.
 * Devolve { ok: true, mudancas: { tipo: { ligado?, config? } } } ou erro.
 */
function validarMudancas(corpo, conhecidos) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return erro('PREFS_INVALIDAS', 'Corpo inválido.');
  const mudancas = {};
  for (const [tipo, valor] of Object.entries(corpo)) {
    if (TIPOS_SEMPRE.includes(tipo)) return erro('TIPO_SEMPRE_ENVIADO', 'Cobrança e segurança sempre são enviados.');
    if (!tipoValido(tipo)) return erro('TIPO_DESCONHECIDO', `Tipo de e-mail desconhecido: ${tipo}.`);
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return erro('PREFS_INVALIDAS', `Valor inválido em ${tipo}.`);
    const m = { config: {} };
    for (const [campo, v] of Object.entries(valor)) {
      if (!CAMPOS[tipo].includes(campo)) return erro('CAMPO_DESCONHECIDO', `Campo desconhecido em ${tipo}: ${campo}.`);
      if (campo === 'ligado') {
        if (typeof v !== 'boolean') return erro('LIGADO_INVALIDO', `${tipo}.ligado deve ser true ou false.`);
        m.ligado = v;
      } else if (campo === 'dia') {
        if (!Number.isInteger(v) || v < 0 || v > 6) return erro('DIA_INVALIDO', 'dia deve ser de 0 (domingo) a 6 (sábado).');
        m.config.dia = v;
      } else if (campo === 'hora') {
        if (!Number.isInteger(v) || v < 0 || v > 23) return erro('HORA_INVALIDA', 'hora deve ser de 0 a 23.');
        m.config.hora = v;
      } else if (campo === 'versao') {
        if (!VERSOES.includes(v)) return erro('VERSAO_INVALIDA', `versao deve ser ${VERSOES.join(' ou ')}.`);
        m.config.versao = v;
      } else if (campo === 'blocos') {
        if (!Array.isArray(v) || v.some((b) => !BLOCOS.includes(b))) return erro('BLOCOS_INVALIDOS', `blocos aceita: ${BLOCOS.join(', ')}.`);
        m.config.blocos = BLOCOS.filter((b) => v.includes(b));
      } else if (campo === 'pedido_destino') {
        if (!DESTINOS_PEDIDO.includes(v)) return erro('DESTINO_INVALIDO', `pedido_destino deve ser ${DESTINOS_PEDIDO.join(' ou ')}.`);
        m.config.pedido_destino = v;
      } else if (campo === 'destinatarios') {
        if (v === null) { m.config.destinatarios = null; continue; }
        if (!Array.isArray(v) || v.length > 20) return erro('DESTINATARIOS_INVALIDOS', 'destinatarios deve ser uma lista de e-mails.');
        const lista = [];
        for (const e of v) {
          const n = normalizarEmail(e);
          if (!n || !conhecidos.has(n)) return erro('DESTINATARIO_DESCONHECIDO', 'Só dá para marcar os e-mails cadastrados nesta empresa.');
          if (!lista.includes(n)) lista.push(n);
        }
        m.config.destinatarios = lista;
      }
    }
    mudancas[tipo] = m;
  }
  return { ok: true, mudancas };
}

/**
 * Grava as mudanças já validadas. Mantém companies.weekly_report_enabled em
 * espelho do relatório (para um revert do deploy não ligar nem desligar
 * ninguém por engano).
 */
async function salvarPreferencias(db, companyId, mudancas, { userId = null, origem = 'tela', env = process.env } = {}) {
  const linhas = await lerLinhas(db, companyId);
  const atuais = efetivasDasLinhas(linhas, env);
  const configGuardada = new Map(linhas.map((l) => [l.tipo, l.config || {}]));

  for (const [tipo, m] of Object.entries(mudancas)) {
    const ligado = typeof m.ligado === 'boolean' ? m.ligado : atuais[tipo].ligado;
    // Guarda só o que foi escolhido (o resto segue o padrão).
    const config = { ...(configGuardada.get(tipo) || {}), ...(m.config || {}) };
    await db.query(
      `INSERT INTO company_email_prefs (company_id, tipo, ligado, config, origem, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (company_id, tipo) DO UPDATE
          SET ligado = EXCLUDED.ligado,
              config = EXCLUDED.config,
              origem = EXCLUDED.origem,
              updated_by = EXCLUDED.updated_by,
              updated_at = NOW()`,
      [companyId, tipo, ligado, JSON.stringify(config), origem, userId]
    );
    if (tipo === 'relatorio' && typeof m.ligado === 'boolean') {
      await db.query(
        'UPDATE companies SET weekly_report_enabled = $2, updated_at = NOW() WHERE id = $1 AND weekly_report_enabled IS DISTINCT FROM $2',
        [companyId, m.ligado]
      ).catch((e) => console.error('[emailPreferencias] espelho weekly_report_enabled falhou: ' + e.message));
    }
  }
}

// ── Desligar pelo e-mail (descadastro, reclamação) ──────────────

/**
 * Desliga um tipo de e-mail da empresa.
 *
 * @param db
 * @param {string} companyId
 * @param {string} tipo       chave de TIPOS
 * @param {object} [opts]
 * @param {boolean} [opts.grupo]  relatório consolidado (multi-CNPJ): desliga
 *                                todas as empresas do mesmo dono, que recebiam
 *                                o mesmo e-mail
 * @param {string} [opts.origem]  'link' | 'one_click' | 'reclamacao' | ...
 * @param {object} [opts.contexto] { ip, userAgent }
 * @returns {Promise<{ok: boolean, desligadas: string[], jaEstava: boolean}>}
 */
async function desligarTipoDeEmail(db, companyId, tipo, { grupo = false, origem = 'link', contexto = null } = {}) {
  if (!tipoValido(tipo)) return { ok: false, desligadas: [], jaEstava: false };

  const { rows: alvo } = await db.query(
    grupo
      ? `SELECT c.id
           FROM companies c
           JOIN companies p ON p.id = $1
          WHERE c.id = p.id OR (p.owner_id IS NOT NULL AND c.owner_id = p.owner_id)`
      : 'SELECT id FROM companies WHERE id = $1',
    [companyId]
  );
  if (!alvo || !alvo.length) return { ok: false, desligadas: [], jaEstava: false };
  const ids = alvo.map((r) => r.id);

  // Linha nova (estava no padrão) ou linha ligada -> desligada. Linha já
  // desligada não muda e não volta no RETURNING.
  const { rows } = await db.query(
    `INSERT INTO company_email_prefs (company_id, tipo, ligado, origem)
     SELECT unnest($1::uuid[]), $2, false, $3
     ON CONFLICT (company_id, tipo) DO UPDATE
        SET ligado = false, origem = EXCLUDED.origem, updated_by = NULL, updated_at = NOW()
      WHERE company_email_prefs.ligado = true
     RETURNING company_id`,
    [ids, tipo, origemDaPreferencia(origem)]
  );
  const desligadas = (rows || []).map((r) => r.company_id);
  if (!desligadas.length) return { ok: true, desligadas: [], jaEstava: true };

  if (tipo === 'relatorio') {
    await db.query(
      'UPDATE companies SET weekly_report_enabled = false, updated_at = NOW() WHERE id = ANY($1::uuid[]) AND weekly_report_enabled = true',
      [desligadas]
    ).catch((e) => console.error('[emailPreferencias] espelho weekly_report_enabled falhou: ' + e.message));
  }

  for (const id of desligadas) {
    try {
      await db.query(
        `INSERT INTO audit_log (user_id, company_id, action, detail, metadata, ip_address, user_agent)
         VALUES (NULL, $1, 'email.descadastro', $2, $3, $4, $5)`,
        [
          id,
          `Descadastro de ${TIPOS[tipo].rotulo} pelo e-mail (${origem})`,
          JSON.stringify({ tipo, origem, grupo: !!grupo, empresa_do_link: companyId }),
          (contexto && contexto.ip) || null,
          (contexto && contexto.userAgent) ? String(contexto.userAgent).slice(0, 200) : null,
        ]
      );
    } catch (err) {
      console.error('[emailPreferencias] audit_log falhou: ' + err.message);
    }
  }
  return { ok: true, desligadas, jaEstava: false };
}

function origemDaPreferencia(origem) {
  return origem === 'reclamacao' ? 'reclamacao' : 'descadastro';
}

// ── Para quem monta e-mail (relacionamento, relatório) ──────────

/**
 * Link de descadastro de um tipo, os cabeçalhos do RFC 8058 e o link
 * "Ajustar meus e-mails". Para os e-mails de relacionamento (próximo PR):
 *
 *   if (!(await tipoLigado(db, companyId, 'ajuda'))) return;   // não envia
 *   const d = descadastroDoTipo(companyId, 'ajuda');
 *   sendMail({ ..., headers: d.headers })  // e d.link / d.ajustar no rodapé
 */
function descadastroDoTipo(companyId, tipo, { grupo = false, env = process.env } = {}) {
  if (!tipoValido(tipo) || !companyId) return { link: null, headers: null, ajustar: linkAjustarEmails(companyId, env) };
  const link = linkDescadastro(companyId, tipo, { grupo }, env);
  return { link, headers: cabecalhosDescadastro(link), ajustar: linkAjustarEmails(companyId, env) };
}

module.exports = {
  TIPOS,
  TIPOS_SEMPRE,
  BLOCOS,
  BLOCOS_ESSENCIAL,
  VERSOES,
  DESTINOS_PEDIDO,
  tipoValido,
  padrao,
  relatorioPadraoLigado,
  normalizarEmail,
  preferenciaEfetiva,
  preferenciasDaEmpresa,
  tipoLigado,
  donoDaEmpresa,
  enderecosExtras,
  destinatariosDe,
  destinatariosDoTipo,
  destinoDoPedido,
  blocosDoPlano,
  blocosDoRelatorio,
  quandoDoRelatorio,
  validarMudancas,
  salvarPreferencias,
  desligarTipoDeEmail,
  descadastroDoTipo,
};
