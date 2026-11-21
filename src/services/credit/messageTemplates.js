// ============================================================
// AURA. — Modelos de mensagem do crediário (migration 462, 21/11/2026)
//
// O Cobrar do app abre a prévia com o modelo padrão da situação da parcela
// (a vencer, vence hoje, em atraso). O modelo é da LOJA (company_id), como a
// chave Pix e o nome da loja que entram no texto.
//
// Regras:
//   - até LIMITE (10) modelos por loja; texto de até MAX_BODY (1.000) letras;
//   - um padrão por situação: dar uma situação a um modelo faz dele o padrão
//     dela, e o padrão anterior daquela situação vira "livre" (sem situação);
//   - variáveis só as de VARIAVEIS; outra coisa entre chaves é recusada;
//   - loja sem modelo salvo recebe os PRONTOS da Aura (não são linhas do
//     banco). No primeiro modelo que ela salva, os prontos viram linhas dela
//     (é o que a tela mostra: "5 de 10 modelos"), menos o pronto que o novo
//     substitui (`replaces_aura`, o "Salvar uma cópia").
//   - régua: até 21/11 a tela de Configurações deixava escrever 5 textos na
//     régua (credit_collection_rules.rules[].template) que nenhum caminho
//     usava. Na primeira leitura de uma loja sem modelos que tenha texto
//     DIFERENTE do padrão na régua, esses textos viram modelos dela (junto
//     com os prontos) e ficam como padrão da situação equivalente. Uma vez
//     só por loja (credit_message_template_imports).
//
// O WhatsApp oficial não passa por aqui: o automático continua no template
// aprovado pela Meta (services/credit/collectionAuto.js).
// ============================================================
'use strict';

const pool = require('../../config/database');

const LIMITE = 10;
const MAX_BODY = 1000;
const MAX_NAME = 40;
const SITUACOES = ['a_vencer', 'vence_hoje', 'em_atraso'];
const VARIAVEIS = ['nome', 'loja', 'valor', 'vencimento', 'parcela', 'dias', 'saldo', 'pix'];

// Os mesmos textos estão embutidos no app (utils/crediarioMensagem.ts) como
// reserva para quando esta rota falhar. Mudou aqui, mude lá.
const PRONTOS = [
  {
    key: 'lembrete',
    name: 'Lembrete',
    situation: 'a_vencer',
    body:
      'Oi, {nome}! Tudo bem?\n\n' +
      'Passando só pra lembrar que a parcela {parcela} do seu crediário aqui na {loja}, de {valor}, vence dia {vencimento}.\n\n' +
      'Se quiser pagar por Pix, a chave é {pix}.\n\n' +
      'Qualquer coisa é só me chamar!',
  },
  {
    key: 'vence_hoje',
    name: 'Vence hoje',
    situation: 'vence_hoje',
    body:
      'Oi, {nome}! Tudo bem?\n\n' +
      'Sua parcela {parcela} de {valor} aqui na {loja} vence hoje.\n\n' +
      'Se for mais fácil, pode pagar por Pix: {pix}. Me avisa quando fizer que eu já dou baixa.',
  },
  {
    key: 'passou_do_dia',
    name: 'Passou do dia',
    situation: 'em_atraso',
    body:
      'Oi, {nome}, tudo bem por aí?\n\n' +
      'Vi aqui que a parcela {parcela} de {valor}, que venceu dia {vencimento}, ainda está em aberto. Pode ter passado batido, acontece!\n\n' +
      'Consegue me dizer quando fica bom pra você acertar? Se preferir Pix, a chave é {pix}.',
  },
  {
    key: 'vamos_combinar',
    name: 'Vamos combinar',
    situation: null,
    body:
      'Oi, {nome}, como você está?\n\n' +
      'Queria conversar sobre o seu crediário aqui na {loja}: hoje o valor em aberto é {saldo}.\n\n' +
      'Se estiver apertado, me fala que a gente combina um jeito que caiba pra você. O que acha?',
  },
];

// Os textos que a tela da régua trazia de fábrica (app, crediario/settings.tsx
// DEFAULT_RULES até 21/11/2026). Texto igual a estes não é "da loja".
const REGUA_PADRAO = {
  lembrete: 'Oi {nome}! Passando pra lembrar que sua parcela de {valor} vence em {vencimento}. Pix: {pix}',
  vencimento: 'Olá {nome}, sua parcela de {valor} vence hoje. Pague pelo Pix {pix} :)',
  atraso_1: '{nome}, a parcela de {valor} venceu em {vencimento}. Consegue regularizar?',
  atraso_2: '{nome}, seu débito de {valor} está com {dias} dias de atraso. Pix: {pix}',
  bloqueio: '{nome}, seu crédito na loja foi suspenso por atraso. Regularize pelo Pix {pix}.',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function erro(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code_negocio = code;
  return e;
}

/** Letras como o Postgres conta (char_length): pontos de código, não UTF-16. */
function letras(s) {
  return Array.from(String(s || '')).length;
}

function normalizarTexto(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function variaveisDe(body) {
  const out = [];
  String(body || '').replace(/\{([^{}\s]*)\}/g, (_, k) => { out.push(k); return _; });
  return out;
}

function prontoParaSaida(p, i) {
  return {
    id: 'aura:' + p.key,
    aura_key: p.key,
    origin: 'aura',
    name: p.name,
    body: p.body,
    situation: p.situation,
    is_default: !!p.situation,
    sort: i + 1,
  };
}

function linhaParaSaida(r) {
  return {
    id: r.id,
    origin: 'loja',
    name: r.name,
    body: r.body,
    situation: r.situation || null,
    is_default: r.is_default === true,
    sort: Number(r.sort) || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function prontos() {
  return PRONTOS.map(prontoParaSaida);
}

// ── validação ────────────────────────────────────────────────────────────

function validarNome(v) {
  const nome = String(v == null ? '' : v).trim();
  if (!nome) throw erro(422, 'NOME_OBRIGATORIO', 'Dê um nome ao modelo.');
  if (letras(nome) > MAX_NAME) throw erro(422, 'NOME_LONGO', `O nome passa de ${MAX_NAME} letras.`);
  return nome;
}

function validarTexto(v) {
  const body = String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
  if (!body) throw erro(422, 'TEXTO_OBRIGATORIO', 'Escreva o texto do modelo.');
  if (letras(body) > MAX_BODY) throw erro(422, 'TEXTO_LONGO', 'O texto passa de 1.000 letras.');
  const desconhecidas = variaveisDe(body).filter((k) => !VARIAVEIS.includes(k));
  if (desconhecidas.length) {
    const lista = Array.from(new Set(desconhecidas)).map((k) => '{' + k + '}').join(', ');
    throw erro(422, 'VARIAVEL_DESCONHECIDA',
      `O app não conhece ${lista}. Use ${VARIAVEIS.map((k) => '{' + k + '}').join(' ')}.`);
  }
  return body;
}

function validarSituacao(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'livre') return null;
  if (!SITUACOES.includes(v)) throw erro(422, 'SITUACAO_INVALIDA', 'Situação inválida.');
  return v;
}

// ── régua → modelos ──────────────────────────────────────────────────────

function parseRules(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (_) { return []; }
  }
  return Array.isArray(arr) ? arr : [];
}

function situacaoDaEtapa(days) {
  const d = Number(days);
  if (!Number.isFinite(d)) return null;
  if (d < 0) return 'a_vencer';
  if (d === 0) return 'vence_hoje';
  return 'em_atraso';
}

/**
 * Os textos que a loja escreveu na régua (diferentes do que vinha de
 * fábrica), já no formato de modelo. Pura: recebe `rules` como está no banco.
 * Etapas ligadas vêm antes, para a primeira de cada situação ser o padrão.
 */
function modelosDaRegua(rawRules) {
  const vistos = new Set();
  const nomesUsados = new Set(PRONTOS.map((p) => p.name.toLowerCase()));
  const etapas = parseRules(rawRules)
    .map((r, i) => ({ r: r || {}, i }))
    .sort((a, b) => ((a.r.enabled === false) - (b.r.enabled === false)) || (a.i - b.i));
  const out = [];
  const padraoTomado = new Set();
  for (const { r } of etapas) {
    const texto = String(r.template == null ? '' : r.template).replace(/\r\n/g, '\n').trim();
    if (!texto) continue;
    const norm = normalizarTexto(texto);
    const padrao = REGUA_PADRAO[r.id];
    if (padrao && normalizarTexto(padrao) === norm) continue;
    if (vistos.has(norm)) continue;
    vistos.add(norm);

    let nome = String(r.name || '').trim() || 'Régua';
    if (nomesUsados.has(nome.toLowerCase())) nome = nome + ' (régua)';
    nome = Array.from(nome).slice(0, MAX_NAME).join('');
    nomesUsados.add(nome.toLowerCase());

    const sit = situacaoDaEtapa(r.days_relative);
    const viraPadrao = !!sit && r.enabled !== false && !padraoTomado.has(sit);
    if (viraPadrao) padraoTomado.add(sit);
    out.push({
      name: nome,
      body: Array.from(texto).slice(0, MAX_BODY).join(''),
      situation: viraPadrao ? sit : null,
    });
  }
  return out;
}

// ── banco ────────────────────────────────────────────────────────────────

async function lerLinhas(q, companyId) {
  const { rows } = await q.query(
    `-- cred:msg-templates-list
     SELECT id, name, body, situation, is_default, sort, created_at, updated_at
       FROM credit_message_templates
      WHERE company_id = $1
      ORDER BY sort, created_at, id`,
    [companyId]
  );
  return rows;
}

async function lerReguaDaLoja(q, companyId) {
  try {
    const { rows } = await q.query(
      `-- cred:msg-templates-regua
       SELECT rules FROM credit_collection_rules WHERE company_id = $1`,
      [companyId]
    );
    return rows.length ? rows[0].rules : null;
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

async function inserir(q, companyId, m, sort, userId) {
  const { rows } = await q.query(
    `-- cred:msg-templates-insert
     INSERT INTO credit_message_templates
       (company_id, name, body, situation, is_default, sort, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, body, situation, is_default, sort, created_at, updated_at`,
    [companyId, m.name, m.body, m.situation || null, !!m.situation, sort, userId || null]
  );
  return rows[0];
}

/**
 * Loja sem linha nenhuma: grava os prontos (menos `exceto`) e, se ainda não
 * foram trazidos, os textos dela na régua. Os da régua tomam o padrão da
 * situação equivalente. `soComRegua`: só semeia se houver texto da régua
 * (é o caso da leitura; na criação semeia sempre). Devolve quantos vieram da
 * régua. Roda dentro da transação do chamador, com o lock da loja.
 */
async function semear(q, companyId, { exceto = null, soComRegua = false, userId = null } = {}) {
  let daRegua = [];
  const marca = await q.query(
    `SELECT 1 FROM credit_message_template_imports WHERE company_id = $1`,
    [companyId]
  );
  const jaTrouxe = marca.rows.length > 0;
  if (!jaTrouxe) daRegua = modelosDaRegua(await lerReguaDaLoja(q, companyId));
  if (soComRegua && !daRegua.length) return { semeou: false, daRegua: 0 };

  const tomadas = new Set(daRegua.filter((m) => m.situation).map((m) => m.situation));
  let sort = 0;
  for (const p of PRONTOS) {
    if (p.key === exceto) continue;
    sort += 1;
    await inserir(q, companyId, {
      name: p.name, body: p.body,
      situation: p.situation && !tomadas.has(p.situation) ? p.situation : null,
    }, sort, userId);
  }
  for (const m of daRegua) {
    sort += 1;
    await inserir(q, companyId, m, sort, userId);
  }
  if (daRegua.length) {
    await q.query(
      `INSERT INTO credit_message_template_imports (company_id, imported_count)
       VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING`,
      [companyId, daRegua.length]
    );
  }
  return { semeou: true, daRegua: daRegua.length };
}

async function emTransacao(companyId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Um escritor por loja: contagem do limite e padrão único sem corrida.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['cred-msg-tpl:' + companyId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão caída */ }
    throw e;
  } finally {
    client.release();
  }
}

function saidaDaLista(rows, extra) {
  if (!rows.length) {
    return { source: 'aura', templates: prontos(), limit: LIMITE, max_body: MAX_BODY, variables: VARIAVEIS, ...extra };
  }
  return {
    source: 'loja', templates: rows.map(linhaParaSaida), limit: LIMITE, max_body: MAX_BODY, variables: VARIAVEIS, ...extra,
  };
}

async function listar(companyId) {
  let rows;
  try {
    rows = await lerLinhas(pool, companyId);
  } catch (e) {
    // 462 ainda não aplicada: o Cobrar segue com os prontos.
    if (e.code === '42P01') return saidaDaLista([], { schema_pending: true });
    throw e;
  }
  if (rows.length) return saidaDaLista(rows);

  // Sem modelos: a régua dela tem texto próprio? Só então grava.
  const regua = await lerReguaDaLoja(pool, companyId);
  if (!modelosDaRegua(regua).length) return saidaDaLista([]);
  return emTransacao(companyId, async (client) => {
    const de = await lerLinhas(client, companyId);
    if (de.length) return saidaDaLista(de); // outra leitura chegou antes
    const r = await semear(client, companyId, { soComRegua: true });
    return saidaDaLista(await lerLinhas(client, companyId), { imported_from_regua: r.daRegua });
  });
}

async function liberarSituacao(q, companyId, situation, menosId) {
  await q.query(
    `-- cred:msg-templates-free-situation
     UPDATE credit_message_templates
        SET situation = NULL, is_default = false, updated_at = NOW()
      WHERE company_id = $1 AND situation = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [companyId, situation, menosId || null]
  );
}

async function criar(companyId, body, { userId } = {}) {
  const b = body || {};
  const name = validarNome(b.name);
  const text = validarTexto(b.body);
  let situation = validarSituacao(b.situation);
  const exceto = PRONTOS.some((p) => p.key === b.replaces_aura) ? b.replaces_aura : null;

  return emTransacao(companyId, async (client) => {
    let rows = await lerLinhas(client, companyId);
    if (!rows.length) {
      await semear(client, companyId, { exceto, userId });
      // O pronto substituído deixa a situação para a cópia.
      if (situation === undefined && exceto) situation = PRONTOS.find((p) => p.key === exceto).situation;
      rows = await lerLinhas(client, companyId);
    }
    if (rows.length >= LIMITE) {
      throw erro(422, 'LIMITE_DE_MODELOS', `A loja já tem ${LIMITE} modelos. Exclua um para salvar outro.`);
    }
    if (situation) await liberarSituacao(client, companyId, situation, null);
    const sort = rows.reduce((mx, r) => Math.max(mx, Number(r.sort) || 0), 0) + 1;
    const nova = await inserir(client, companyId, { name, body: text, situation: situation || null }, sort, userId);
    return { template: linhaParaSaida(nova), ...saidaDaLista(await lerLinhas(client, companyId)) };
  });
}

function checarId(id) {
  if (!UUID_RE.test(String(id || ''))) {
    if (String(id || '').startsWith('aura:')) {
      throw erro(409, 'MODELO_DA_AURA', 'Os modelos prontos da Aura não mudam. Salve uma cópia para editar.');
    }
    throw erro(400, 'ID_INVALIDO', 'Modelo inválido.');
  }
}

async function buscarDaLoja(q, companyId, id) {
  const { rows } = await q.query(
    `SELECT id, name, body, situation, is_default, sort, created_at, updated_at
       FROM credit_message_templates WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!rows.length) throw erro(404, 'MODELO_NAO_ENCONTRADO', 'Modelo não encontrado.');
  return rows[0];
}

async function atualizar(companyId, id, patch) {
  checarId(id);
  const p = patch || {};
  const name = p.name !== undefined ? validarNome(p.name) : undefined;
  const text = p.body !== undefined ? validarTexto(p.body) : undefined;
  const situation = validarSituacao(p.situation);

  return emTransacao(companyId, async (client) => {
    const atual = await buscarDaLoja(client, companyId, id);
    if (situation) await liberarSituacao(client, companyId, situation, id);
    const novaSit = situation === undefined ? atual.situation : situation;
    const { rows } = await client.query(
      `-- cred:msg-templates-update
       UPDATE credit_message_templates
          SET name = $3, body = $4, situation = $5, is_default = $6, updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING id, name, body, situation, is_default, sort, created_at, updated_at`,
      [id, companyId, name !== undefined ? name : atual.name, text !== undefined ? text : atual.body,
        novaSit || null, !!novaSit]
    );
    return { template: linhaParaSaida(rows[0]), ...saidaDaLista(await lerLinhas(client, companyId)) };
  });
}

async function definirPadrao(companyId, id, situacao) {
  const situation = validarSituacao(situacao === undefined ? null : situacao);
  return atualizar(companyId, id, { situation });
}

async function excluir(companyId, id) {
  checarId(id);
  return emTransacao(companyId, async (client) => {
    await buscarDaLoja(client, companyId, id);
    await client.query(
      `-- cred:msg-templates-delete
       DELETE FROM credit_message_templates WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    return { deleted: true, ...saidaDaLista(await lerLinhas(client, companyId)) };
  });
}

module.exports = {
  LIMITE, MAX_BODY, MAX_NAME, SITUACOES, VARIAVEIS, PRONTOS, REGUA_PADRAO,
  prontos, modelosDaRegua, validarNome, validarTexto, validarSituacao, variaveisDe, letras,
  listar, criar, atualizar, definirPadrao, excluir,
};
