#!/usr/bin/env node
// ============================================================
// AURA. — Disparo dos e-mails da Black Friday 2026 (11/11/2026)
//
//   node scripts/enviarBlackFriday.js --email=1                 (DRY-RUN: só mostra)
//   node scripts/enviarBlackFriday.js --email=2                 (DRY-RUN)
//   node scripts/enviarBlackFriday.js --email=2 --teste=voce@exemplo.com
//        uma cópia de cada variante para esse endereço, assunto com
//        "[TESTE]", sem ler o público e sem gravar no email_log
//   node scripts/enviarBlackFriday.js --email=1 --enviar        (envia de verdade)
//
// Opções: --intervalo=<segundos> (padrão 2: um e-mail a cada 2 s)
//         --sem-codigo  (e-mail 2 sem o BLACK50; obrigatório quando os usos
//                        do código acabaram)
//
// Em produção: railway run node scripts/enviarBlackFriday.js ... (variáveis
// do serviço de produção: SUPABASE_DB_URL, RESEND_API_KEY, EMAIL_LINK_SECRET
// ou JWT_SECRET, API_URL, APP_URL).
//
// Conteúdo: services/emailsBlackFriday.js (texto aprovado pelo Caio, 11/11).
//
// Públicos (não se sobrepõem). Base comum: o SQL_ELEGIVEL de
// services/relacionamento.js (dono com e-mail confirmado, fora sandbox,
// staff/@getaura, Karatê, filial e conta desativada), mais a conta marcada
// "Não quer" (sqlMarcaNaoQuer) e o tipo de preferência "novidades" desligado
// (descadastro ou "Ajustar meus e-mails"), mais as SEGURADAS abaixo.
//   e-mail 1 (página Black Friday): assinante ativa (billing_status
//     'active') ou teste vigente. Só o shell Negócio: a página
//     /black-friday não existe no Studio, Odonto nem Food. Negócio e
//     Expansão leem o texto inteiro; Essencial, sem a frase do carnê
//     (companies.plan).
//   e-mail 2 (retorno): teste vencido e sem assinatura (BLACK50 e o preço
//     do plano da conta; Studio com as funções do Studio) e conta em atraso
//     (billing_status 'overdue': sem código, com a frase da régua).
//
// Trava contra reenvio: email_log, chave `bf-2026-email<N>:<company_id>`
// (enviarEmailRegistrado reserva a chave antes de enviar). Quem já recebeu
// é pulado. A preferência e o "Não quer" são relidos na hora de cada envio
// (tipoLigado), como nos e-mails de relacionamento.
//
// A saída nunca mostra nome nem e-mail: só o começo do company_id, o plano
// e a variante.
// ============================================================
'use strict';

const { SQL_ELEGIVEL, linkDoApp } = require('../src/services/relacionamento');
const { sqlMarcaNaoQuer, tipoLigado, descadastroDoTipo, normalizarEmail } = require('../src/services/emailPreferencias');
const { rodapeDoTipo, comRodape } = require('../src/services/emailsRelacionamento');
const { enviarEmailRegistrado, MAX_TENTATIVAS } = require('../src/services/emailLog');
const BF = require('../src/services/emailsBlackFriday');
const L = require('../src/services/emailLayout');

// Seguradas por decisão do Caio em 11/11/2026: fora dos dois e-mails até
// ele decidir.
const SEGURADAS = Object.freeze([
  '133ec696-56ce-43cb-806d-3dcdb8fca4d2', // assinante do Studio
  'a609e806-98b0-4138-a61a-d6ce3ac967b2', // teste vigente do Studio
]);

const CAMPANHA = Object.freeze({ 1: 'bf-2026-email1', 2: 'bf-2026-email2' });
const TIPO_LOG = Object.freeze({ 1: 'novidades_bf_2026_email1', 2: 'novidades_bf_2026_email2' });
const TIPO_PREF = 'novidades';
const CODIGO = 'BLACK50';
const INTERVALO_PADRAO_S = 2;

// Variantes de cada e-mail, na ordem do --teste.
const VARIANTES = Object.freeze({
  1: ['negocio', 'essencial'],
  2: ['negocio', 'essencial', 'studio', 'atraso'],
});

// Conta fictícia das cópias de teste: os links do rodapé apontam para uma
// empresa que não existe (clicar não desliga os e-mails de ninguém).
const EMPRESA_DE_TESTE = '00000000-0000-0000-0000-000000000000';

// ── Seleção ─────────────────────────────────────────────────────

function sqlPublico(email) {
  const extra = email === 1
    ? `COALESCE(c.vertical_active, '') <> 'studio'
   AND (c.billing_status = 'active'
        OR (COALESCE(c.billing_status, 'trial') = 'trial' AND c.trial_ends_at > $2::timestamptz))`
    : `((COALESCE(c.billing_status, 'trial') = 'trial'
         AND c.asaas_subscription_id IS NULL
         AND c.trial_ends_at IS NOT NULL
         AND c.trial_ends_at <= $2::timestamptz)
        OR c.billing_status = 'overdue')`;
  return `
SELECT c.id AS company_id, COALESCE(c.trade_name, c.legal_name) AS loja, c.plan, c.billing_status,
       c.vertical_active, u.id AS user_id, u.email, u.full_name
  FROM companies c
  JOIN users u ON u.id = c.owner_id
 WHERE ${SQL_ELEGIVEL}
   AND NOT ${sqlMarcaNaoQuer('c.id')}
   AND NOT EXISTS (SELECT 1 FROM company_email_prefs pref
                    WHERE pref.company_id = c.id AND pref.tipo = '${TIPO_PREF}' AND pref.ligado IS FALSE)
   AND c.id <> ALL($1::uuid[])
   AND COALESCE(c.vertical_active, '') NOT IN ('odonto', 'food')
   AND ${extra}
 ORDER BY c.created_at, c.id`;
}

const PLANOS = ['negocio', 'essencial', 'expansao'];

/** Variante da linha, ou null (fica fora, com o motivo em `fora`). */
function variante(email, r) {
  if (email === 1) return PLANOS.includes(r.plan) ? r.plan : null;
  if (r.billing_status === 'overdue') return 'atraso';
  // O preço do e-mail 2 só existe para Negócio e Essencial (BF.PRECO).
  if (r.plan !== 'negocio' && r.plan !== 'essencial') return null;
  if (r.vertical_active === 'studio') return 'studio';
  return r.plan;
}

function chaveDe(email, companyId) {
  return `${CAMPANHA[email]}:${companyId}`;
}

/**
 * Público do e-mail. Devolve { alvos, fora } — `fora` conta quem a seleção
 * trouxe mas não tem como receber (sem e-mail, plano sem preço).
 */
async function selecionar(db, email, { now = Date.now() } = {}) {
  const { rows } = await db.query(sqlPublico(email), [[...SEGURADAS], new Date(now).toISOString()]);
  const alvos = [];
  const fora = {};
  for (const r of rows || []) {
    if (SEGURADAS.includes(r.company_id)) { fora.segurada = (fora.segurada || 0) + 1; continue; }
    const v = variante(email, r);
    if (!v) { fora.plano_sem_texto = (fora.plano_sem_texto || 0) + 1; continue; }
    const endereco = String(r.email || '').trim();
    if (!endereco.includes('@')) { fora.sem_email = (fora.sem_email || 0) + 1; continue; }
    alvos.push({
      companyId: r.company_id,
      userId: r.user_id,
      email: endereco,
      nome: L.primeiroNome(r.full_name) || r.loja || 'tudo bem',
      loja: r.loja || 'sua loja',
      plano: r.plan,
      variante: v,
    });
  }
  return { alvos, fora };
}

/** Usos restantes do BLACK50, lidos agora. Infinity quando não tem teto. */
async function usosRestantes(db, { now = Date.now() } = {}) {
  const { rows } = await db.query(
    'SELECT max_uses, uses, is_active, expires_at FROM access_codes WHERE upper(code) = $1 LIMIT 1',
    [CODIGO]
  );
  const r = rows && rows[0];
  if (!r || r.is_active === false) return 0;
  if (r.expires_at && new Date(r.expires_at).getTime() <= now) return 0;
  if (r.max_uses == null) return Infinity;
  return Math.max(0, Number(r.max_uses) - Number(r.uses || 0));
}

/** Chaves que já receberam (ou estão travadas): não saem de novo. */
async function jaReceberam(db, email, alvos) {
  if (!alvos.length) return new Set();
  const { rows } = await db.query(
    `SELECT chave_idempotencia FROM email_log
      WHERE chave_idempotencia = ANY($1::text[])
        AND (status IN ('sent', 'reserved') OR tentativas >= $2)`,
    [alvos.map((a) => chaveDe(email, a.companyId)), MAX_TENTATIVAS]
  );
  return new Set((rows || []).map((r) => r.chave_idempotencia));
}

// ── Conteúdo ────────────────────────────────────────────────────

function motivoDoRodape(email, alvo) {
  // Frases dos rodapés de relacionamento já aprovados.
  if (email === 2 && alvo.variante !== 'atraso') return `Você recebe este e-mail porque testou a Aura com a ${alvo.loja}.`;
  return `Você recebe este e-mail porque usa a Aura com a ${alvo.loja}.`;
}

/** { assunto, html, text, headers } de um alvo. */
function montar(email, alvo, { comCodigo = true, env = process.env } = {}) {
  const d = descadastroDoTipo(alvo.companyId, TIPO_PREF, { env });
  const links = { descadastro: d.link, ajustar: d.ajustar };
  const rodape = rodapeDoTipo({ ...links, motivo: motivoDoRodape(email, alvo) });
  let c;
  if (email === 1) {
    c = BF.paginaBlackFriday({ nome: alvo.nome, plano: alvo.plano, link: BF.LINK_PAGINA, rodape });
  } else {
    const extra = alvo.variante === 'atraso'
      ? { comCodigo: false, atraso: true }
      : { comCodigo, studio: alvo.variante === 'studio' };
    c = BF.callbackBlackFriday({
      nome: alvo.nome, loja: alvo.loja, plano: alvo.plano, rodape,
      link: linkDoApp('/checkout', alvo.companyId, env), ...extra,
    });
  }
  const final = comRodape(c, links);
  return { assunto: final.assunto, html: final.html, text: final.text, headers: d.headers || undefined };
}

// ── Argumentos ──────────────────────────────────────────────────

function lerArgs(argv) {
  const a = { email: null, enviar: false, teste: null, semCodigo: false, intervaloS: INTERVALO_PADRAO_S };
  for (const arg of argv) {
    const [k, ...resto] = String(arg).split('=');
    const v = resto.join('=');
    if (k === '--email') a.email = Number(v);
    else if (k === '--enviar' && !v) a.enviar = true;
    else if (k === '--teste') a.teste = v;
    else if (k === '--sem-codigo' && !v) a.semCodigo = true;
    else if (k === '--intervalo') a.intervaloS = Number(v);
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  if (a.email !== 1 && a.email !== 2) throw new Error('--email=1 ou --email=2 é obrigatório');
  if (a.teste != null) {
    const e = normalizarEmail(a.teste);
    if (!e) throw new Error('--teste precisa de um endereço de e-mail válido');
    a.teste = e;
    if (a.enviar) throw new Error('--teste já envia as cópias de teste: não use junto com --enviar');
  }
  if (!Number.isFinite(a.intervaloS) || a.intervaloS < 0) throw new Error('--intervalo precisa ser um número de segundos (>= 0)');
  return a;
}

// ── Execução ────────────────────────────────────────────────────

const curto = (id) => String(id).slice(0, 8);

function contar(lista, campo) {
  const out = {};
  for (const x of lista) out[x[campo]] = (out[x[campo]] || 0) + 1;
  return out;
}

function fmt(obj) {
  const k = Object.keys(obj).sort();
  return k.length ? k.map((x) => `${x} ${obj[x]}`).join(' · ') : '(nenhum)';
}

function canalDeEnvio(env) {
  return !!(env.RESEND_API_KEY || env.SMTP_HOST);
}

async function enviarTeste({ args, enviar, env, log }) {
  const resultado = { enviados: 0, falhas: [] };
  for (const v of VARIANTES[args.email]) {
    const alvo = {
      companyId: EMPRESA_DE_TESTE, nome: 'Caio', loja: 'sua loja',
      plano: v === 'essencial' ? 'essencial' : 'negocio', variante: v,
    };
    const c = montar(args.email, alvo, { comCodigo: !args.semCodigo, env });
    try {
      await enviar({ to: args.teste, subject: `[TESTE] ${c.assunto}`, html: c.html, text: c.text, headers: c.headers });
      resultado.enviados += 1;
      log(`  teste ${v}: enviado`);
    } catch (err) {
      resultado.falhas.push(v);
      log(`  teste ${v}: FALHOU (${err.message})`);
    }
  }
  return resultado;
}

/**
 * Corpo do script (testável: banco, mailer, relógio e espera injetados).
 * Devolve o resumo; `codigo` é o código de saída sugerido.
 */
async function executar({
  args, db, enviar, env = process.env, now = Date.now(), log = console.log,
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const campanha = CAMPANHA[args.email];
  if ((args.enviar || args.teste) && !canalDeEnvio(env)) {
    log('Sem RESEND_API_KEY nem SMTP_HOST: nada sai. Rode com as variáveis de produção (railway run).');
    return { codigo: 1, modo: args.teste ? 'teste' : 'envio', enviados: 0 };
  }
  const enviarMail = enviar || require('../src/services/mailer').sendMail;

  if (args.teste) {
    log(`Cópias de teste do ${campanha} para o endereço informado (${VARIANTES[args.email].length} variantes, sem registro):`);
    const r = await enviarTeste({ args, enviar: enviarMail, env, log });
    return { codigo: r.falhas.length ? 1 : 0, modo: 'teste', ...r };
  }

  const { alvos, fora } = await selecionar(db, args.email, { now });
  const usos = await usosRestantes(db, { now });
  const ja = await jaReceberam(db, args.email, alvos);
  const pendentes = alvos.filter((a) => !ja.has(chaveDe(args.email, a.companyId)));
  const pulados = alvos.length - pendentes.length;
  const comCodigo = args.email === 2 && !args.semCodigo;
  const recebemCodigo = comCodigo ? alvos.filter((a) => a.variante !== 'atraso').length : 0;

  log(`${campanha} — ${args.enviar ? 'ENVIO' : 'DRY-RUN (nada é enviado; use --enviar para enviar)'}`);
  log(`Público: ${alvos.length} contas`);
  log(`  por plano: ${fmt(contar(alvos, 'plano'))}`);
  log(`  por variante: ${fmt(contar(alvos, 'variante'))}`);
  if (Object.keys(fora).length) log(`  fora da seleção: ${fmt(fora)}`);
  log(`  seguradas (fora por decisão do Caio): ${SEGURADAS.map(curto).join(', ')}`);
  log(`${CODIGO}: ${usos === Infinity ? 'sem limite de usos' : `${usos} usos restantes`}` +
    (args.email === 2 ? ` · ${recebemCodigo} contas recebem o código${args.semCodigo ? ' (--sem-codigo: nenhuma)' : ''}` : ''));
  log(`Já receberam (pulados): ${pulados} · a enviar: ${pendentes.length}`);
  log('Lista (company_id curto · plano · variante · situação):');
  for (const a of alvos) {
    log(`  ${curto(a.companyId)} · ${a.plano} · ${a.variante} · ${ja.has(chaveDe(args.email, a.companyId)) ? 'já recebeu' : 'a enviar'}`);
  }

  const resumo = {
    modo: args.enviar ? 'envio' : 'dry-run', campanha, total: alvos.length,
    porPlano: contar(alvos, 'plano'), porVariante: contar(alvos, 'variante'), fora,
    usosRestantes: usos, recebemCodigo, pulados, aEnviar: pendentes.length,
    enviados: 0, desligados: 0, duplicados: 0, falhas: [],
  };

  if (comCodigo && usos === 0) {
    log(`\nO ${CODIGO} não tem mais usos. O e-mail 2 não sai com o código: rode de novo com --sem-codigo.`);
    return { ...resumo, codigo: args.enviar ? 2 : 0 };
  }
  if (!args.enviar) return { ...resumo, codigo: 0 };

  const intervaloMs = Math.round(args.intervaloS * 1000);
  log(`\nEnviando ${pendentes.length} e-mails, um a cada ${args.intervaloS} s...`);
  for (let i = 0; i < pendentes.length; i += 1) {
    const a = pendentes[i];
    if (i > 0 && intervaloMs > 0) await dormir(intervaloMs);
    try {
      // Segunda trava: preferência e "Não quer" relidos agora.
      if (!(await tipoLigado(db, a.companyId, TIPO_PREF, { env }))) {
        resumo.desligados += 1;
        log(`  ${curto(a.companyId)} · desligou os e-mails de novidades: pulado`);
        continue;
      }
      const c = montar(args.email, a, { comCodigo, env });
      const r = await enviarEmailRegistrado({
        db, enviar: enviarMail,
        chave: chaveDe(args.email, a.companyId), tipo: TIPO_LOG[args.email],
        companyId: a.companyId, userId: a.userId,
        metadata: { campanha, variante: a.variante, plano: a.plano, com_codigo: a.variante !== 'atraso' && comCodigo },
        to: a.email, subject: c.assunto, html: c.html, text: c.text, headers: c.headers,
      });
      if (r.status === 'sent') resumo.enviados += 1;
      else if (r.status === 'duplicate') resumo.duplicados += 1;
      else resumo.falhas.push(a.companyId);
      log(`  ${curto(a.companyId)} · ${a.variante} · ${r.status}`);
    } catch (err) {
      resumo.falhas.push(a.companyId);
      log(`  ${curto(a.companyId)} · ${a.variante} · erro (${err.message})`);
    }
  }
  log(`\nFim: ${resumo.enviados} enviados · ${pulados + resumo.duplicados} já tinham recebido · ` +
    `${resumo.desligados} desligados · ${resumo.falhas.length} falhas`);
  if (resumo.falhas.length) log(`Falhas (company_id): ${resumo.falhas.join(', ')}`);
  return { ...resumo, codigo: resumo.falhas.length ? 1 : 0 };
}

async function main() {
  let args;
  try {
    args = lerArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const db = args.teste ? null : require('../src/config/database');
  try {
    const r = await executar({ args, db });
    process.exitCode = r.codigo;
  } catch (err) {
    console.error('Falhou: ' + err.message);
    process.exitCode = 1;
  } finally {
    if (db && typeof db.end === 'function') await db.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = {
  SEGURADAS,
  CAMPANHA,
  TIPO_LOG,
  VARIANTES,
  INTERVALO_PADRAO_S,
  sqlPublico,
  variante,
  chaveDe,
  selecionar,
  usosRestantes,
  jaReceberam,
  montar,
  lerArgs,
  executar,
};
