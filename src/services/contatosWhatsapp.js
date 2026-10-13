// ============================================================
// AURA. — contatosWhatsapp.js
// Quem chamou no WhatsApp da Aura, visto pelo painel da Gestão Aura.
//
// Uma só leitura do hub (hub_messages + hub_conversations +
// hub_agent_events do tenant AURA_COMPANY_ID) que alimenta três coisas:
// o bloco Contatos (painelBlocos/contatos.js), o alerta "contato sem
// resposta" (painelAlertas.js) e o resumo das 8h (resumoDaMadrugada.js).
//
// O que é um "contato": a conversa do hub é uma por telefone, para sempre;
// quem volta uma semana depois é um contato novo. Por isso o contato é a
// JANELA de atendimento: começa numa mensagem do cliente sem nenhuma outra
// mensagem (de ninguém) na conversa nas 24h anteriores — a mesma janela da
// Meta — e vai até 24h de silêncio. Fala nossa sem o cliente ter chamado
// antes (o Caio puxou assunto) não abre contato.
//
// Quem respondeu, por contato:
//   humano  — hub_messages outbound autor 'humano' (eco do app do celular ou
//             resposta pelo painel), evento 'mensagem_humana' e, na janela
//             mais recente, hub_conversations.ultima_mensagem_humana_em;
//   Aurinha — hub_messages autor 'aurinha' e evento 'resposta_enfileirada'
//             que não ficou parado nem foi pulado.
// Situação = quem respondeu primeiro de verdade: humano > Aurinha > ninguém.
//
// Dormente: sem AURA_COMPANY_ID nenhuma consulta é feita e tudo volta zero.
// Tabela/coluna ausente (migration 375 pendente) também zera — b.opcional.
// ============================================================
'use strict';

const b = require('./painelBlocos/_base');
const plantao = require('./plantao');
const hubWhatsapp = require('./hubWhatsapp');

const JANELA_CONTATO_MS = 24 * 3600 * 1000;
const MAX_MENSAGENS = 50000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SITUACAO_ROTULO = { sem_resposta: 'Sem resposta', aurinha: 'Aurinha', humano: 'Caio' };

const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? null : t;
};
const round1 = (v) => Math.round(v * 10) / 10;
const soDigitos = (v) => String(v || '').replace(/\D+/g, '');

// ── telefone ────────────────────────────────────────────────────
// Chave de comparação entre formatos: DDD + os 8 últimos dígitos. Ignora o
// 55, o "9" extra do celular e a pontuação — o mesmo número escrito de
// quatro jeitos no cadastro bate com o que veio da Meta.
function chaveTelefone(raw) {
  let d = soDigitos(raw);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return d.length >= 8 ? d : null;
  return d.slice(0, 2) + d.slice(-8);
}

// +55 12 99999-0001 (cadastro, e-mail). Formato que não é BR sai com "+".
function formatarTelefone(raw) {
  const d = soDigitos(raw);
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const sub = d.slice(4);
    return `+55 ${d.slice(2, 4)} ${sub.slice(0, sub.length - 4)}-${sub.slice(-4)}`;
  }
  return `+${d}`;
}

// +55 12 *****-0001 — só o fim aparece. Lista do painel; o número inteiro
// fica na ficha da conversa.
function mascararTelefone(raw) {
  const d = soDigitos(raw);
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const sub = d.slice(4);
    return `+55 ${d.slice(2, 4)} ${'*'.repeat(sub.length - 4)}-${sub.slice(-4)}`;
  }
  if (d.length <= 6) return `+${'*'.repeat(d.length)}`;
  return `+${d.slice(0, 2)}${'*'.repeat(d.length - 6)}${d.slice(-4)}`;
}

const linkWhatsapp = (raw) => (soDigitos(raw) ? `https://wa.me/${soDigitos(raw)}` : null);

// 5 → "5 min"; 90 → "1 h 30 min"; 120 → "2 h"
function duracao(minutos) {
  const m = Math.round(Number(minutos));
  if (!Number.isFinite(m) || m < 0) return null;
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// Uma linha, sem quebra, com reticências no corte.
function umaLinha(texto, max = 140) {
  const s = String(texto || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// Início do dia (BRT) como Date; n dias antes de `hoje` ('YYYY-MM-DD').
const inicioDoDia = (hoje, n = 0) => new Date(`${b.somaDias(hoje, -n)}T03:00:00.000Z`);

// ── janelas de contato (função pura) ────────────────────────────
// mensagens: [{ conversation_id, direction, author, content, created_at }]
// conversas: Map id → { external_id, customer_name, ultima_mensagem_humana_em }
// eventos:   [{ conversation_id, type, detail, created_at }]
// Devolve os contatos, do mais novo para o mais antigo.
function montarContatos({ mensagens = [], conversas = new Map(), eventos = [] } = {}) {
  const porConversa = new Map();
  for (const m of mensagens) {
    if (!porConversa.has(m.conversation_id)) porConversa.set(m.conversation_id, []);
    porConversa.get(m.conversation_id).push(m);
  }
  const eventosDe = new Map();
  for (const e of eventos) {
    if (!eventosDe.has(e.conversation_id)) eventosDe.set(e.conversation_id, []);
    eventosDe.get(e.conversation_id).push(e);
  }

  const contatos = [];
  for (const [convId, msgs] of porConversa) {
    const conv = conversas.get(convId);
    if (!conv) continue; // sem a conversa não há telefone para mostrar
    const ordenadas = msgs
      .map((m) => ({ ...m, t: toMs(m.created_at) }))
      .filter((m) => m.t !== null)
      // Mesmo instante (a Meta carimba em segundos): o cliente vem antes.
      .sort((x, y) => (x.t - y.t) || ((x.direction === 'inbound' ? 0 : 1) - (y.direction === 'inbound' ? 0 : 1)));

    // 1. janelas
    const janelas = [];
    let atual = null;
    let ultimo = null;
    for (const m of ordenadas) {
      if (atual && m.t - ultimo >= JANELA_CONTATO_MS) atual = null;
      if (m.direction === 'inbound') {
        if (!atual && (ultimo === null || m.t - ultimo >= JANELA_CONTATO_MS)) {
          atual = { inicio: m.t, mensagens: [] };
          janelas.push(atual);
        }
        if (atual) atual.mensagens.push(m);
      } else if (atual) {
        atual.mensagens.push(m);
      }
      ultimo = m.t;
    }

    // 2. o que aconteceu em cada janela
    const eventosDaConversa = (eventosDe.get(convId) || [])
      .map((e) => ({ ...e, t: toMs(e.created_at) }))
      .filter((e) => e.t !== null);
    const ultimaHumana = toMs(conv.ultima_mensagem_humana_em);

    janelas.forEach((j, i) => {
      const fim = i + 1 < janelas.length ? janelas[i + 1].inicio : Infinity;
      const dentro = (t) => t >= j.inicio && t < fim;
      const humanos = [];
      const aurinhas = [];
      let textoAurinha = null;
      const entradas = [];

      for (const m of j.mensagens) {
        if (m.direction === 'inbound') { entradas.push(m); continue; }
        if (m.author === 'humano') humanos.push(m.t);
        else if (m.author === 'aurinha') {
          aurinhas.push(m.t);
          if (textoAurinha === null) textoAurinha = m.content || null;
        }
      }
      for (const e of eventosDaConversa) {
        if (!dentro(e.t)) continue;
        if (e.type === 'mensagem_humana') humanos.push(e.t);
        else if (e.type === 'resposta_enfileirada') {
          const d = typeof e.detail === 'string' ? safeJson(e.detail) : (e.detail || {});
          if (!d.parada && d.status !== 'skipped') aurinhas.push(e.t);
        }
      }
      if (i === janelas.length - 1 && ultimaHumana !== null && dentro(ultimaHumana)) humanos.push(ultimaHumana);

      const primeiraHumana = humanos.length ? Math.min(...humanos) : null;
      const primeiraAurinha = aurinhas.length ? Math.min(...aurinhas) : null;
      // Esperando resposta humana: a primeira fala do cliente depois da
      // última fala de um humano (ou desde o início, se nenhum falou).
      const ultimoHumano = humanos.length ? Math.max(...humanos) : -Infinity;
      const pendente = entradas.find((m) => m.t > ultimoHumano) || null;

      contatos.push({
        conversa_id: convId,
        telefone: soDigitos(conv.external_id) || null,
        nome: conv.customer_name || null,
        chegou_em: new Date(j.inicio),
        primeira_mensagem: entradas.length ? (entradas[0].content || null) : null,
        mensagens_do_cliente: entradas.length,
        resposta_humana_em: primeiraHumana === null ? null : new Date(primeiraHumana),
        resposta_aurinha_em: primeiraAurinha === null ? null : new Date(primeiraAurinha),
        texto_aurinha: textoAurinha,
        espera_min: primeiraHumana === null ? null : round1((primeiraHumana - j.inicio) / 60000),
        pendente_desde: pendente ? new Date(pendente.t) : null,
        situacao: primeiraHumana !== null ? 'humano' : primeiraAurinha !== null ? 'aurinha' : 'sem_resposta',
        empresa: null,
      });
    });
  }
  return contatos.sort((x, y) => y.chegou_em - x.chegou_em);
}

function safeJson(s) {
  try { return JSON.parse(s) || {}; } catch (_) { return {}; }
}

// ── banco ───────────────────────────────────────────────────────
const auraCompanyId = () => hubWhatsapp.auraCompanyId();

// Empresas cadastradas com o telefone do contato: telefone da empresa ou do
// dono. Quem não está no cadastro fica com empresa null.
async function vincularEmpresas(db, contatos) {
  const chaves = new Map(); // chave → contatos
  for (const c of contatos) {
    const k = chaveTelefone(c.telefone);
    if (!k) continue;
    if (!chaves.has(k)) chaves.set(k, []);
    chaves.get(k).push(c);
  }
  if (!chaves.size) return contatos;

  const finais = [...new Set([...chaves.keys()].map((k) => k.slice(-8)))];
  const rows = await b.opcional(
    db,
    `-- contatos:empresas
     SELECT c.id AS company_id, COALESCE(c.trade_name, c.legal_name) AS nome, c.phone AS telefone
       FROM companies c
      WHERE c.phone IS NOT NULL
        AND right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 8) = ANY($1::text[])
      UNION ALL
     SELECT c.id, COALESCE(c.trade_name, c.legal_name), u.phone
       FROM users u
       JOIN companies c ON c.owner_id = u.id
      WHERE u.phone IS NOT NULL
        AND right(regexp_replace(u.phone, '[^0-9]', '', 'g'), 8) = ANY($1::text[])`,
    [finais]
  );
  const porChave = new Map();
  for (const r of rows) {
    const k = chaveTelefone(r.telefone);
    if (k && !porChave.has(k)) porChave.set(k, { company_id: r.company_id, nome: r.nome || null });
  }
  for (const [k, lista] of chaves) {
    const emp = porChave.get(k);
    if (emp) for (const c of lista) c.empresa = emp;
  }
  return contatos;
}

// Contatos que chegaram em [desde, ate). `desde`/`ate` são Date.
async function carregarContatos({ db = b.pool, desde, ate = null, companyId = auraCompanyId(), empresas = true } = {}) {
  if (!companyId) return { ativo: false, contatos: [] };
  const base = new Date(desde.getTime() - JANELA_CONTATO_MS);

  const mensagens = await b.opcional(
    db,
    `-- contatos:mensagens
     SELECT conversation_id, direction, author, content, created_at
       FROM hub_messages
      WHERE company_id = $1 AND channel = 'whatsapp' AND created_at >= $2
      ORDER BY created_at ASC
      LIMIT ${MAX_MENSAGENS}`,
    [companyId, base]
  );
  if (!mensagens.length) return { ativo: true, contatos: [] };

  const ids = [...new Set(mensagens.map((m) => m.conversation_id))];
  const [conversasRows, eventos] = await Promise.all([
    b.opcional(
      db,
      `-- contatos:conversas
       SELECT id, external_id, customer_name, status, last_inbound_at, ultima_mensagem_humana_em
         FROM hub_conversations
        WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, ids]
    ),
    b.opcional(
      db,
      `-- contatos:eventos
       SELECT conversation_id, type, detail, created_at
         FROM hub_agent_events
        WHERE company_id = $1 AND conversation_id = ANY($2::uuid[])
          AND type IN ('mensagem_humana', 'resposta_enfileirada')
          AND created_at >= $3`,
      [companyId, ids, base]
    ),
  ]);

  const conversas = new Map(conversasRows.map((c) => [c.id, c]));
  const contatos = montarContatos({ mensagens, conversas, eventos })
    .filter((c) => c.chegou_em >= desde && (!ate || c.chegou_em < ate));
  if (empresas) await vincularEmpresas(db, contatos);
  return { ativo: true, contatos };
}

// A janela do dia de Brasília `hoje - dias + 1 .. hoje`, fechada em `hoje`.
function janelaDeDias(hoje, dias) {
  return { desde: inicioDoDia(hoje, dias - 1), ate: inicioDoDia(hoje, -1) };
}

// ── ficha da conversa (GET /admin/painel/contatos/:conversaId) ──
const MAX_MENSAGENS_FICHA = 200;

async function detalheDaConversa({ db = b.pool, conversaId, companyId = auraCompanyId() } = {}) {
  if (!companyId || !UUID_RE.test(String(conversaId || ''))) return null;

  const conv = await b.opcional(
    db,
    `-- contatos:conversa
     SELECT id, external_id, customer_name, status, last_inbound_at, last_message_at,
            ultima_mensagem_humana_em, aguardando_resposta_desde, created_at
       FROM hub_conversations
      WHERE id = $1 AND company_id = $2 AND channel = 'whatsapp'
      LIMIT 1`,
    [conversaId, companyId]
  );
  if (!conv.length) return null;
  const c = conv[0];

  const [recentes, eventos] = await Promise.all([
    b.opcional(
      db,
      `-- contatos:thread
       SELECT id, conversation_id, direction, author, content, created_at
         FROM hub_messages
        WHERE conversation_id = $1 AND company_id = $2
        ORDER BY created_at DESC, direction DESC
        LIMIT ${MAX_MENSAGENS_FICHA}`,
      [conversaId, companyId]
    ),
    b.opcional(
      db,
      `-- contatos:eventos-conversa
       SELECT conversation_id, type, detail, created_at
         FROM hub_agent_events
        WHERE conversation_id = $1 AND company_id = $2
          AND type IN ('mensagem_humana', 'resposta_enfileirada')
        ORDER BY created_at DESC
        LIMIT 500`,
      [conversaId, companyId]
    ),
  ]);
  const mensagens = recentes.slice().reverse();

  const janelas = montarContatos({
    mensagens,
    conversas: new Map([[c.id, c]]),
    eventos,
  });
  const atual = janelas[0] || null; // o mais novo
  if (atual) await vincularEmpresas(db, [atual]);

  const telefone = soDigitos(c.external_id) || null;
  return {
    conversa_id: c.id,
    canal: 'whatsapp',
    telefone,
    telefone_formatado: formatarTelefone(telefone),
    telefone_mascarado: mascararTelefone(telefone),
    link_whatsapp: linkWhatsapp(telefone),
    nome: c.customer_name || null,
    empresa: atual ? atual.empresa : null,
    status: c.status,
    primeiro_contato_em: c.created_at || null,
    ultima_mensagem_cliente_em: c.last_inbound_at || null,
    ultima_mensagem_humana_em: c.ultima_mensagem_humana_em || null,
    aguardando_resposta_desde: c.aguardando_resposta_desde || null,
    contato_atual: atual ? {
      chegou_em: atual.chegou_em,
      situacao: atual.situacao,
      situacao_rotulo: SITUACAO_ROTULO[atual.situacao],
      primeira_resposta_humana_em: atual.resposta_humana_em,
      primeira_resposta_aurinha_em: atual.resposta_aurinha_em,
      espera_min: atual.espera_min,
      sem_resposta_humana_desde: atual.pendente_desde,
    } : null,
    contatos_na_conversa: janelas.length,
    mensagens: mensagens.map((m) => ({
      id: m.id,
      direcao: m.direction === 'inbound' ? 'recebida' : 'enviada',
      autor: m.author,
      texto: m.content || null,
      quando: m.created_at,
    })),
    truncada: recentes.length >= MAX_MENSAGENS_FICHA,
  };
}

module.exports = {
  JANELA_CONTATO_MS, SITUACAO_ROTULO,
  chaveTelefone, formatarTelefone, mascararTelefone, linkWhatsapp,
  duracao, umaLinha, inicioDoDia, janelaDeDias,
  montarContatos, vincularEmpresas, carregarContatos, detalheDaConversa,
  auraCompanyId,
};
