// ============================================================
// AURA. — hubConvites.js
// Conversa FECHADA do WhatsApp: para falar primeiro, a loja usa um convite
// pronto (modelo UTILITY aprovado pelo WhatsApp). Cada convite gasta 1 dos
// AVISOS do mês. Passou da janela de 24 h, nada sai sem modelo aprovado e
// sem aviso — e sem aviso nada sai, nem por engano.
//
// O convite é uma mensagem do tipo AVISO (UTILITY): o servidor barra texto
// que pareça oferta no catálogo (aqui, fixo e revisado). A lojista só muda os
// trechos marcados como editáveis; o resto do texto é do modelo aprovado.
//
// Reserva do aviso e INSERT na fila acontecem NA MESMA TRANSAÇÃO (regra 1 do
// plano), usando waSaldo.reservar(client, ...) do agente A. Se o saldo não
// existir neste servidor (o módulo ainda não foi mergeado), o envio é
// BLOQUEADO: na dúvida, bloqueia. Com a trava WA_SALDO_ATIVO desligada o
// reservar devolve modo:'desligado' e valem as guardas antigas.
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');
const wa = require('./whatsapp');
const waOutbox = require('./waOutbox');
const hubWhatsapp = require('./hubWhatsapp');

const IDIOMA = 'pt_BR';
const MAX_CAMPO = 60;
const FONTE = 'convite_conversa';

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

function erro(code, message, status = 422, extra = {}) {
  return Object.assign(new Error(message), { code, status, extra });
}

// Campo: { key, rotulo, auto?, exemplo, padrao? }. `auto` = a Aura preenche
// (nome do cliente, nome da loja); os demais a lojista pode mudar.
const CAMPO_NOME = { key: 'nome', rotulo: 'Nome', auto: true, exemplo: 'Bia' };
const CAMPO_LOJA = { key: 'loja', rotulo: 'Nome da loja', auto: true, exemplo: 'Lume Moda' };

function convite(key, titulo, partes, campos, categoria = 'UTILITY') {
  return Object.freeze({
    key, titulo, categoria, idioma: IDIOMA,
    template: `aura_convite_${key}`,
    partes: Object.freeze(partes), campos: Object.freeze(campos),
  });
}

// partes: texto fixo ('...') ou { campo: 'chave' }. A ordem dos campos no
// texto é a ordem dos {{n}} do modelo na Meta.
const CATALOGO = Object.freeze([
  convite('chegou', 'Chegou o que pediu',
    ['Oi, ', { campo: 'nome' }, '. Chegou ', { campo: 'produto' }, ' que você perguntou na ', { campo: 'loja' },
      '. Guardo um para você até ', { campo: 'ate' }, '. Para falar com a gente, é só responder esta mensagem.'],
    [CAMPO_NOME,
      { key: 'produto', rotulo: 'Produto', exemplo: 'o cinto de couro em preto' },
      CAMPO_LOJA,
      { key: 'ate', rotulo: 'Guardo até', exemplo: 'sábado' }]),
  convite('orcamento', 'Orçamento pronto',
    ['Oi, ', { campo: 'nome' }, '. Seu orçamento na ', { campo: 'loja' }, ' ficou pronto: ', { campo: 'valor' },
      ', válido até ', { campo: 'ate' }, '. Responda esta mensagem para ver os detalhes.'],
    [CAMPO_NOME, CAMPO_LOJA,
      { key: 'valor', rotulo: 'Valor', exemplo: 'R$ 189,90' },
      { key: 'ate', rotulo: 'Válido até', exemplo: '03/12' }]),
  convite('retirada', 'Pedido pronto para retirar',
    ['Oi, ', { campo: 'nome' }, '. Seu pedido ', { campo: 'pedido' }, ' está pronto para retirar na ', { campo: 'loja' },
      '. Atendemos ', { campo: 'horario' }, '. Responda esta mensagem se precisar de algo.'],
    [CAMPO_NOME,
      { key: 'pedido', rotulo: 'Pedido', exemplo: 'nº 0042' },
      CAMPO_LOJA,
      { key: 'horario', rotulo: 'Horário', exemplo: 'até as 18h' }]),
  convite('pagamento', 'Lembrete de pagamento',
    ['Oi, ', { campo: 'nome' }, '. Passando para lembrar do pagamento de ', { campo: 'valor' }, ' na ', { campo: 'loja' },
      ', com vencimento ', { campo: 'vencimento' }, '. Se já pagou, pode ignorar esta mensagem.'],
    [CAMPO_NOME,
      { key: 'valor', rotulo: 'Valor', exemplo: 'R$ 120,00' },
      CAMPO_LOJA,
      { key: 'vencimento', rotulo: 'Vencimento', exemplo: 'no sábado, 30/11' }]),
]);

const porChave = (key) => CATALOGO.find((c) => c.key === key) || null;

/** Campos na ordem em que aparecem no texto (= ordem dos {{n}}). */
function camposEmOrdem(c) {
  const vistos = [];
  for (const p of c.partes) {
    if (typeof p !== 'string' && !vistos.includes(p.campo)) vistos.push(p.campo);
  }
  return vistos.map((k) => c.campos.find((f) => f.key === k));
}

/** Corpo para criar o modelo na Meta: {{1}}, {{2}}... + exemplos. */
function corpoDoModelo(c) {
  const ordem = camposEmOrdem(c);
  const texto = c.partes.map((p) => (typeof p === 'string' ? p : `{{${ordem.findIndex((f) => f.key === p.campo) + 1}}}`)).join('');
  return { texto, exemplos: ordem.map((f) => f.exemplo) };
}

/** Texto final (o que a cliente lê) a partir dos valores. */
function montarTexto(c, valores) {
  return c.partes.map((p) => (typeof p === 'string' ? p : valores[p.campo])).join('');
}

// Parâmetro da Meta: sem quebra de linha, tabulação nem 4 espaços seguidos.
function limparCampo(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Valida o que a lojista digitou. `auto` traz o que a Aura preenche.
 * Devolve { valores } ou joga erro de regra (422 CAMPO_INVALIDO).
 */
function validarCampos(c, enviados, auto) {
  const valores = {};
  for (const f of c.campos) {
    const bruto = f.auto ? (auto && auto[f.key]) : (enviados && enviados[f.key]);
    const v = limparCampo(bruto);
    if (!v) throw erro('CAMPO_INVALIDO', `Preencha "${f.rotulo}".`, 422, { campo: f.key });
    if (v.length > MAX_CAMPO) throw erro('CAMPO_INVALIDO', `"${f.rotulo}" tem no máximo ${MAX_CAMPO} letras.`, 422, { campo: f.key });
    valores[f.key] = v;
  }
  return { valores };
}

// ── Banco ────────────────────────────────────────────────────
async function carregarLoja(companyId) {
  try {
    const { rows } = await db.query(
      `-- hubconvite:loja
       SELECT trade_name, legal_name, wa_phone_display, wa_waba_id,
              wa_access_token IS NOT NULL AS has_token
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (e) {
    if (isMissingSchema(e)) return null;
    throw e;
  }
}

const nomeDaLoja = (l) => (l && (l.trade_name || l.legal_name)) || 'nossa loja';

/** "wa.me/5511987650000" a partir do número de exibição da loja; null se não houver. */
function meuLink(loja) {
  const d = String((loja && loja.wa_phone_display) || '').replace(/\D+/g, '');
  if (d.length < 10) return null;
  return `https://wa.me/${d.length <= 11 ? `55${d}` : d}`;
}

async function estadosDosModelos(companyId) {
  const estados = new Map();
  try {
    const { rows } = await db.query(
      `-- hubconvite:modelos
       SELECT name, status FROM wa_templates
        WHERE company_id = $1 AND name LIKE 'aura\\_convite\\_%' AND language = $2`,
      [companyId, IDIOMA]
    );
    for (const r of rows) estados.set(r.name, String(r.status || '').toUpperCase());
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
  }
  return estados;
}

function waSaldo() {
  try { return require('./waSaldo'); } catch (_) { return null; }
}

/** O saldo de AVISOS para a tela, ou null se este servidor não tem saldo. */
async function saldoDeAvisos(companyId) {
  const s = waSaldo();
  if (!s || typeof s.getSaldos !== 'function') return null;
  try {
    const r = await s.getSaldos(companyId);
    const a = r && r.saldos && r.saldos.avisos;
    if (!a) return null;
    return {
      ativo: !!r.ativo, restante: a.restante, total: a.total, esgotado: !!a.esgotado,
      renova_em: a.renova_em || null, mes: r.mes || null, pacote: a.pacote || null,
    };
  } catch (e) {
    console.error('[HUB-CONVITE] saldo indisponível: %s', e.message);
    return null;
  }
}

async function nomeDoCliente(companyId, conversationId) {
  const { rows } = await db.query(
    `-- hubconvite:conv
     SELECT c.id, c.channel, c.external_id, c.last_inbound_at,
            COALESCE(cu.name, c.customer_name) AS nome
       FROM hub_conversations c
       LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.company_id = c.company_id
      WHERE c.id = $1 AND c.company_id = $2 LIMIT 1`,
    [conversationId, companyId]
  );
  return rows[0] || null;
}

const primeiroNome = (nome) => limparCampo(nome).split(' ')[0] || 'cliente';

/**
 * Tudo que a tela da conversa fechada precisa: convites com estado do modelo,
 * valores já preenchidos, saldo de avisos e o link do WhatsApp da loja.
 */
async function listar({ companyId, conversationId }) {
  const conv = await nomeDoCliente(companyId, conversationId);
  if (!conv) throw erro('CONVERSA_NAO_ENCONTRADA', 'Conversa não encontrada', 404);
  const [loja, estados, saldo] = await Promise.all([carregarLoja(companyId), estadosDosModelos(companyId), saldoDeAvisos(companyId)]);
  const auto = { nome: primeiroNome(conv.nome), loja: nomeDaLoja(loja) };
  return {
    aberta: waOutbox.windowOpenAt(conv.last_inbound_at),
    conectado: !!(loja && loja.wa_waba_id && loja.has_token),
    meu_link: meuLink(loja),
    saldo,
    auto,
    convites: CATALOGO.map((c) => {
      const estado = estados.get(c.template) || 'NAO_CRIADO';
      return {
        key: c.key, titulo: c.titulo, estado, pronto: estado === 'APPROVED',
        partes: c.partes,
        campos: c.campos.map((f) => ({ key: f.key, rotulo: f.rotulo, auto: !!f.auto, exemplo: f.exemplo, max: MAX_CAMPO })),
      };
    }),
  };
}

/** Cria na Meta os modelos que ainda não existem (idempotente). */
async function preparar({ companyId }) {
  const loja = await carregarLoja(companyId);
  if (!loja || !loja.wa_waba_id || !loja.has_token) throw erro('NAO_CONECTADO', 'O WhatsApp da loja não está conectado.', 409);
  const { rows: tok } = await db.query('SELECT wa_access_token FROM companies WHERE id = $1 LIMIT 1', [companyId]);
  const token = waOutbox.decryptToken(tok[0] && tok[0].wa_access_token);
  const estados = await estadosDosModelos(companyId);
  const out = { criados: 0, ja_existiam: 0 };
  for (const c of CATALOGO) {
    if (estados.has(c.template)) { out.ja_existiam++; continue; }
    const { texto, exemplos } = corpoDoModelo(c);
    let criado;
    try {
      criado = await wa.createTemplate(loja.wa_waba_id, token, {
        name: c.template, language: c.idioma, category: c.categoria,
        components: [{ type: 'BODY', text: texto, example: { body_text: [exemplos] } }],
      });
    } catch (e) {
      throw erro('META_RECUSOU', 'O WhatsApp recusou o pedido do modelo. Tente de novo em instantes.', 502);
    }
    await waOutbox.applyTemplateStatus(companyId, {
      name: c.template, language: c.idioma,
      status: (criado && criado.status) || 'PENDING',
      metaTemplateId: criado && criado.id != null ? String(criado.id) : null,
    });
    await db.query(
      `UPDATE wa_templates SET body_preview = $1, category = $2, updated_at = NOW()
        WHERE company_id = $3 AND name = $4 AND language = $5`,
      [texto, c.categoria, companyId, c.template, c.idioma]
    ).catch(() => {});
    out.criados++;
  }
  return out;
}

/**
 * Manda o convite: reserva 1 aviso e enfileira o modelo, numa transação só.
 * Devolve { ok, outbox_id, saldo } ou joga erro de regra.
 */
async function enviar({ companyId, conversationId, userId, key, campos }) {
  const c = porChave(key);
  if (!c) throw erro('CONVITE_DESCONHECIDO', 'Convite desconhecido', 404);
  const conv = await nomeDoCliente(companyId, conversationId);
  if (!conv) throw erro('CONVERSA_NAO_ENCONTRADA', 'Conversa não encontrada', 404);
  if (conv.channel !== 'whatsapp') throw erro('CANAL_NAO_SUPORTADO', 'Convite é só para conversas do WhatsApp', 400);
  if (waOutbox.windowOpenAt(conv.last_inbound_at)) {
    throw erro('CONVERSA_ABERTA', 'A conversa está aberta: responda direto, sem gastar aviso.', 409);
  }
  const phone = waOutbox.normalizePhone(conv.external_id);
  if (!phone) throw erro('TELEFONE_INVALIDO', 'Telefone da conversa inválido', 400);

  const loja = await carregarLoja(companyId);
  if (!loja || !loja.wa_waba_id || !loja.has_token) throw erro('NAO_CONECTADO', 'O WhatsApp da loja não está conectado.', 409);
  const estados = await estadosDosModelos(companyId);
  if (estados.get(c.template) !== 'APPROVED') {
    throw erro('MODELO_NAO_APROVADO', 'Este convite ainda não foi aprovado pelo WhatsApp.', 409);
  }

  const contato = await waOutbox.getContact(companyId, phone).catch(() => null);
  if (contato && contato.invalid_at) throw erro('TELEFONE_INVALIDO_META', 'O WhatsApp recusou este número. Nada foi enviado.');
  // Aviso continua com o número "em atenção" (só as novidades pausam); conta
  // restrita ou pausa manual param tudo.
  const pausa = await waOutbox.loadPauseReason(companyId);
  if (pausa && pausa !== 'QUALIDADE_BAIXA') throw erro('PAUSADO', 'O WhatsApp da loja está pausado. Nada foi enviado.');

  const { valores } = validarCampos(c, campos, { nome: primeiroNome(conv.nome), loja: nomeDaLoja(loja) });
  const ordem = camposEmOrdem(c);
  const texto = montarTexto(c, valores);
  const components = [{ type: 'body', parameters: ordem.map((f) => ({ type: 'text', text: valores[f.key] })) }];

  const saldo = waSaldo();
  if (!saldo || typeof saldo.reservar !== 'function') {
    // Sem o módulo de saldo neste servidor não há como garantir o limite.
    throw erro('SALDO_INDISPONIVEL', 'Não consegui conferir seus avisos agora. Nada foi enviado.', 503);
  }

  // Um convite por conversa por dia e por modelo: duplo clique não gasta dois avisos.
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const dedupeKey = `convite:${conversationId}:${c.key}:${hoje}`;
  const outboxId = crypto.randomUUID();

  let client;
  let aberta = false;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    aberta = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    const { rows } = await client.query(
      `-- hubconvite:enfileira
       INSERT INTO wa_outbox
         (id, company_id, to_phone, kind, template_name, template_language, components, text_body,
          status, source_type, source_id, dedupe_key, hub_conversation_id, next_attempt_at)
       VALUES ($1,$2,$3,'template',$4,$5,$6,$7,'pending','humano',$8,$9,$10,NOW())
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [outboxId, companyId, phone, c.template, c.idioma, JSON.stringify(components), texto, userId || null, dedupeKey, conversationId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK'); aberta = false;
      throw erro('CONVITE_REPETIDO', 'Este convite já foi enviado hoje para esta conversa.', 409);
    }
    const r = await saldo.reservar(client, {
      companyId, bucket: 'avisos', refKey: dedupeKey, outboxId, conversaId: conversationId,
    });
    if (!r || !r.ok) {
      await client.query('ROLLBACK'); aberta = false;
      const code = (r && r.code) || 'SALDO_INDISPONIVEL';
      throw erro(code, code === 'SALDO_ESGOTADO'
        ? 'Os avisos do mês acabaram. Nada foi enviado.'
        : 'Não consegui conferir seus avisos agora. Nada foi enviado.', code === 'SALDO_ESGOTADO' ? 409 : 503,
      { saldo: r || null });
    }
    await client.query('COMMIT'); aberta = false;
    await hubWhatsapp.marcarRespostaHumana(companyId, conversationId, userId || null);
    return { ok: true, outbox_id: outboxId, saldo: r };
  } catch (e) {
    if (client && aberta) { try { await client.query('ROLLBACK'); } catch (_) { /* já caiu */ } }
    if (e && e.code === '42703') throw erro('SCHEMA_PENDENTE', 'Hub ainda não disponível (migration pendente)', 409);
    throw e;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  CATALOGO, porChave, camposEmOrdem, corpoDoModelo, montarTexto, validarCampos, limparCampo,
  meuLink, listar, preparar, enviar, FONTE,
};
