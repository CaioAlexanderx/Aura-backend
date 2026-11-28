// ============================================================
// AURA. — Progresso e funil da conexão do WhatsApp
//
// Os dois usam o log de eventos que já existe (audit_log), sem tabela
// nova:
//   wa.conexao.item   { item, estado: rodando|ok|erro, causa?, codigo? }
//   wa.conexao.funil  { passo, causa?, origem? }
//
// O progresso da tela é o último evento de cada item DESDE a conexão
// atual (companies.wa_connected_at): reconectar recomeça do zero.
// Nunca grava token nem telefone.
// ============================================================
'use strict';

const db = require('../../config/database');

const ITENS = ['numero', 'eventos', 'perfil', 'modelos'];
const ESTADOS = ['rodando', 'ok', 'erro'];
// Passos que o app pode informar. Os "item" e "pronto" são do servidor.
const PASSOS_DO_APP = ['abriu', 'entrou_janela', 'terminou_janela', 'erro', 'celular_link_pedido', 'chamou_a_aura'];

async function gravar(companyId, userId, action, metadata) {
  try {
    await db.query(
      'INSERT INTO audit_log (user_id, company_id, action, detail, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [userId || null, companyId, action, metadata.item || metadata.passo || null, JSON.stringify(metadata)]
    );
    return true;
  } catch (e) {
    console.warn(`[waConexao] evento não gravado (${action}): ${e.code || ''} ${String(e.message).slice(0, 80)}`);
    return false;
  }
}

async function registrarItem(companyId, item, estado, extra = {}) {
  if (!ITENS.includes(item) || !ESTADOS.includes(estado)) return false;
  const md = { item, estado };
  if (extra.causa) md.causa = String(extra.causa).slice(0, 40);
  if (extra.codigo) md.codigo = String(extra.codigo).slice(0, 40);
  return gravar(companyId, null, 'wa.conexao.item', md);
}

async function registrarPasso(companyId, userId, passo, extra = {}) {
  const md = { passo };
  if (extra.causa) md.causa = String(extra.causa).slice(0, 40);
  if (extra.origem) md.origem = String(extra.origem).slice(0, 20);
  return gravar(companyId, userId, 'wa.conexao.funil', md);
}

/** { itens: [{item, estado, causa?, codigo?}], pronto, concluido } */
async function lerProgresso(companyId) {
  let rows = [];
  try {
    const r = await db.query(
      `-- wa:conexao-progresso
       SELECT DISTINCT ON (a.metadata->>'item')
              a.metadata->>'item' AS item, a.metadata->>'estado' AS estado,
              a.metadata->>'causa' AS causa, a.metadata->>'codigo' AS codigo
         FROM audit_log a
         JOIN companies c ON c.id = a.company_id
        WHERE a.company_id = $1 AND a.action = 'wa.conexao.item'
          AND (c.wa_connected_at IS NULL OR a.created_at >= c.wa_connected_at - INTERVAL '2 minutes')
        ORDER BY a.metadata->>'item', a.created_at DESC`,
      [companyId]
    );
    rows = r.rows || [];
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  const por = Object.fromEntries(rows.map((x) => [x.item, x]));
  const itens = ITENS.map((item) => {
    const x = por[item];
    if (!x) return { item, estado: 'pendente' };
    const o = { item, estado: x.estado };
    if (x.causa) o.causa = x.causa;
    if (x.codigo) o.codigo = x.codigo;
    return o;
  });
  const concluido = itens.every((i) => i.estado === 'ok' || i.estado === 'erro');
  return { itens, concluido, pronto: concluido && itens.some((i) => i.estado === 'ok') };
}

/** Aviso no sino da lojista quando termina (alert_history). Nunca lança. */
async function avisarNoSino(companyId, { comErro }) {
  try {
    await db.query(
      `INSERT INTO alert_history (company_id, alert_type, severity, title, message, data)
       VALUES ($1, 'wa_conexao_pronta', $2, $3, $4, '{}'::jsonb)`,
      [
        companyId,
        comErro ? 'warning' : 'info',
        'O WhatsApp da loja está na Aura',
        comErro
          ? 'A conexão terminou, mas um item pede atenção. Abra a tela do WhatsApp.'
          : 'Tudo pronto: responda as clientes daqui e ligue as mensagens que saem sozinhas.',
      ]
    );
  } catch (e) {
    console.warn(`[waConexao] sino não gravado: ${e.code || ''} ${String(e.message).slice(0, 80)}`);
  }
}

module.exports = { ITENS, PASSOS_DO_APP, registrarItem, registrarPasso, lerProgresso, avisarNoSino };
