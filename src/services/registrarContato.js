// ============================================================
// AURA. — Registrar contato (Gestão Aura): regras e gravação (14/10/2026)
//
// O botão "Registrar contato" da ficha do cliente e do verbo dos alertas do
// painel grava aqui (POST /admin/painel/contatos, routes/adminPainel.js). A
// Cassie lê na rodada das 7h30 (GET /admin/painel/contatos?desde=).
//
//   empresa  → company_admin_notes (migration 383)
//   lead     → lead_interactions   (channel, body, autor; o resto em payload)
//
// O corpo pode trazer um objeto `checkin` (como_chegou, fiado, quem_decide):
// vai para companies.checkin (migration 384), o mesmo json da tela de 3
// perguntas do cliente. como_chegou é "uma vez por conta": a primeira
// gravação vale e as seguintes não a trocam.
//
// Aqui só regra: validação por enum (idêntica aos CHECK da migration) e SQL.
// ============================================================
'use strict';

const CANAIS = ['whatsapp', 'ligacao', 'email', 'presencial'];
const RESULTADOS = ['respondeu', 'sem_resposta', 'pediu_tempo', 'combinou_ligacao', 'quer_assinar', 'nao_quer'];
const MOTIVOS = [
  'estoque_na_entrada', 'preco_plano', 'fiscal', 'atrito_produto', 'funcionalidade',
  'frente_errada', 'ritmo_do_cliente', 'concorrente', 'elogio',
  // tq-111 (migration 412): saiu por um motivo de fora da Aura (fechou a
  // loja, mudou de cidade...). Com resultado nao_quer, o fim do teste manda
  // o 4.5 "Sua conta da Aura fica guardada" no lugar do 4.4.
  'motivo_externo',
];
const MARCADORES = ['importacao_assistida_pedida', 'importacao_assistida_entregue'];
const COMO_CHEGOU = [
  'indicacao', 'botao_whatsapp_site', 'cadastro_direto', 'ia', 'google', 'instagram', 'prospeccao_caio', 'outro',
];

const CANAL_ROTULO = { whatsapp: 'WhatsApp', ligacao: 'Ligação', email: 'E-mail', presencial: 'Presencial' };
const RESULTADO_ROTULO = {
  respondeu: 'Respondeu', sem_resposta: 'Sem resposta', pediu_tempo: 'Pediu um tempo',
  combinou_ligacao: 'Combinou ligação', quer_assinar: 'Quer assinar', nao_quer: 'Não quer',
};

const MAX_BODY = 500;
const MAX_PROXIMO = 120;
const MAX_CHECKIN = 40;
const CHAVES_CHECKIN = ['como_chegou', 'fiado', 'quem_decide'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// lead_interactions.channel não tem "presencial" (tem "visita").
const CANAL_DO_LEAD = { whatsapp: 'whatsapp', ligacao: 'ligacao', email: 'email', presencial: 'visita' };

function diaValido(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== s ? null : s;
}

const textoOuNada = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// Valida o corpo do POST. Devolve { erro } ou { valor }.
function normalizar(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { erro: 'Corpo inválido.' };

  const temEmpresa = b.company_id !== undefined && b.company_id !== null && b.company_id !== '';
  const temLead = b.lead_id !== undefined && b.lead_id !== null && b.lead_id !== '';
  if (temEmpresa === temLead) return { erro: 'Envie company_id OU lead_id (um dos dois).' };
  const alvo = temEmpresa ? { company_id: b.company_id } : { lead_id: b.lead_id };
  const idAlvo = temEmpresa ? b.company_id : b.lead_id;
  if (typeof idAlvo !== 'string' || !UUID.test(idAlvo)) {
    return { erro: `${temEmpresa ? 'company_id' : 'lead_id'} inválido.` };
  }

  if (!CANAIS.includes(b.canal)) return { erro: `canal deve ser um de: ${CANAIS.join(', ')}.` };
  if (!RESULTADOS.includes(b.resultado)) return { erro: `resultado deve ser um de: ${RESULTADOS.join(', ')}.` };

  const frase = textoOuNada(b.body);
  if (!frase) return { erro: 'body é obrigatório: uma frase do que aconteceu.' };
  if (frase.length > MAX_BODY) return { erro: `body aceita até ${MAX_BODY} caracteres.` };

  let motivo = null;
  if (b.motivo !== undefined && b.motivo !== null && b.motivo !== '') {
    if (!MOTIVOS.includes(b.motivo)) return { erro: `motivo deve ser um de: ${MOTIVOS.join(', ')}.` };
    motivo = b.motivo;
  }
  if (b.resultado === 'nao_quer' && !motivo) return { erro: 'motivo é obrigatório quando o resultado é nao_quer.' };

  let marcador = null;
  if (b.marcador !== undefined && b.marcador !== null && b.marcador !== '') {
    if (!MARCADORES.includes(b.marcador)) return { erro: `marcador deve ser um de: ${MARCADORES.join(', ')}.` };
    marcador = b.marcador;
  }

  let proximoPasso = null;
  if (b.proximo_passo !== undefined && b.proximo_passo !== null && b.proximo_passo !== '') {
    proximoPasso = textoOuNada(b.proximo_passo);
    if (!proximoPasso) return { erro: 'proximo_passo inválido.' };
    if (proximoPasso.length > MAX_PROXIMO) return { erro: `proximo_passo aceita até ${MAX_PROXIMO} caracteres.` };
  }
  let proximoEm = null;
  if (b.proximo_passo_em !== undefined && b.proximo_passo_em !== null && b.proximo_passo_em !== '') {
    proximoEm = diaValido(b.proximo_passo_em);
    if (!proximoEm) return { erro: 'proximo_passo_em deve ser uma data YYYY-MM-DD.' };
  }

  let prorrogou = null;
  if (b.prorrogou_dias !== undefined && b.prorrogou_dias !== null && b.prorrogou_dias !== '') {
    if (!Number.isInteger(b.prorrogou_dias) || b.prorrogou_dias < 1 || b.prorrogou_dias > 365) {
      return { erro: 'prorrogou_dias deve ser um inteiro entre 1 e 365.' };
    }
    prorrogou = b.prorrogou_dias;
  }

  let checkin = null;
  if (b.checkin !== undefined && b.checkin !== null) {
    if (typeof b.checkin !== 'object' || Array.isArray(b.checkin)) return { erro: 'checkin deve ser um objeto.' };
    const extras = Object.keys(b.checkin).filter((k) => !CHAVES_CHECKIN.includes(k));
    if (extras.length) return { erro: `checkin não aceita: ${extras.join(', ')}.` };
    const c = {};
    for (const k of CHAVES_CHECKIN) {
      const v = b.checkin[k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || !v.trim()) return { erro: `checkin.${k} deve ser texto.` };
      if (v.trim().length > MAX_CHECKIN) return { erro: `checkin.${k} aceita até ${MAX_CHECKIN} caracteres.` };
      c[k] = v.trim();
    }
    if (c.como_chegou && !COMO_CHEGOU.includes(c.como_chegou)) {
      return { erro: `checkin.como_chegou deve ser um de: ${COMO_CHEGOU.join(', ')}.` };
    }
    if (Object.keys(c).length) checkin = c;
  }

  return {
    valor: {
      alvo, canal: b.canal, resultado: b.resultado, body: frase, motivo, marcador,
      proximo_passo: proximoPasso, proximo_passo_em: proximoEm, prorrogou_dias: prorrogou, checkin,
    },
  };
}

// 42703 (coluna que a migration ainda não criou) vira a resposta de "migration
// pendente"; o resto sobe como está.
const migrationPendente = (err) => !!err && (err.code === '42703' || err.code === '42P01');

// Grava o contato de uma empresa. Devolve null se a empresa não existe, ou
// { id, created_at, checkin_gravado? }. Nota e check-in vão no MESMO
// statement (CTE): ou entram os dois ou nenhum.
async function registrarEmpresa(db, autorId, v) {
  const { company_id: cid } = v.alvo;
  const { rows: existe } = await db.query('SELECT id FROM companies WHERE id = $1', [cid]);
  if (!existe.length) return null;

  const colunas = [cid, autorId, v.body, v.canal, v.resultado, v.proximo_passo, v.proximo_passo_em, v.motivo, v.prorrogou_dias, v.marcador];
  const insere = `INSERT INTO company_admin_notes
       (company_id, author_user_id, body, canal, resultado, proximo_passo, proximo_passo_em, motivo, prorrogou_dias, marcador)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10)`;

  if (v.checkin) {
    try {
      const { rows } = await db.query(
        `-- contato:nota+checkin
         WITH nota AS (
           ${insere}
           RETURNING id, created_at
         ), ck AS (
           UPDATE companies
              SET checkin = COALESCE(checkin, '{}'::jsonb)
                || (CASE WHEN COALESCE(checkin, '{}'::jsonb) ? 'como_chegou'
                         THEN $11::jsonb - 'como_chegou' ELSE $11::jsonb END)
            WHERE id = $1
            RETURNING id
         )
         SELECT id, created_at FROM nota`,
        [...colunas, JSON.stringify(v.checkin)]
      );
      return { id: rows[0].id, created_at: rows[0].created_at, checkin_gravado: true };
    } catch (err) {
      // companies.checkin (384) ainda não existe: o contato entra sem ele.
      if (!(err && err.code === '42703')) throw err;
    }
    const { rows } = await db.query(`-- contato:nota\n${insere} RETURNING id, created_at`, colunas);
    return { id: rows[0].id, created_at: rows[0].created_at, checkin_gravado: false };
  }

  const { rows } = await db.query(`-- contato:nota\n${insere} RETURNING id, created_at`, colunas);
  return { id: rows[0].id, created_at: rows[0].created_at };
}

// Grava o contato de um lead. Devolve null se o lead não existe.
async function registrarLead(db, autor, v) {
  const { lead_id: lid } = v.alvo;
  const { rows: existe } = await db.query('SELECT id FROM sales_leads WHERE id = $1', [lid]);
  if (!existe.length) return null;

  const payload = {
    canal: v.canal,
    resultado: v.resultado,
    proximo_passo: v.proximo_passo,
    proximo_passo_em: v.proximo_passo_em,
    motivo: v.motivo,
    marcador: v.marcador,
    prorrogou_dias: v.prorrogou_dias,
    checkin: v.checkin,
  };
  const { rows } = await db.query(
    `-- contato:lead
     INSERT INTO lead_interactions (lead_id, author_id, author_name, body, channel, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, created_at`,
    [lid, autor.id, autor.nome, v.body, CANAL_DO_LEAD[v.canal], JSON.stringify(payload)]
  );

  // O próximo passo com data é o follow-up do lead (9h de Brasília).
  if (v.proximo_passo_em) {
    await db.query(
      `-- contato:lead-followup
       UPDATE sales_leads
          SET next_followup_at = (($2::date)::timestamp + interval '9 hours') AT TIME ZONE 'America/Sao_Paulo'
        WHERE id = $1`,
      [lid, v.proximo_passo_em]
    );
  }
  return { id: rows[0].id, created_at: rows[0].created_at };
}

// Contatos registrados desde um dia (Brasília), do mais recente ao mais antigo.
// Empresas e leads na mesma lista; coluna ausente (383 pendente) = vazio.
async function listarDesde(db, desde, limite = 500) {
  const inicio = `($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
  const tolerante = async (sql, params) => {
    try {
      return { rows: (await db.query(sql, params)).rows, pendente: false };
    } catch (err) {
      if (migrationPendente(err)) return { rows: [], pendente: true };
      throw err;
    }
  };

  const empresas = await tolerante(
    `-- contatos:lista-empresas
     SELECT n.id, n.company_id, COALESCE(c.trade_name, c.legal_name) AS nome,
            n.created_at, n.body, n.canal, n.resultado, n.proximo_passo,
            to_char(n.proximo_passo_em, 'YYYY-MM-DD') AS proximo_passo_em,
            n.motivo, n.prorrogou_dias, n.marcador,
            COALESCE(u.full_name, u.email) AS autor
       FROM company_admin_notes n
       JOIN companies c ON c.id = n.company_id
       LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.created_at >= ${inicio}
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [desde, limite]
  );

  // Só os contatos registrados por esta tela (payload preenchido): o resto do
  // histórico do lead é do CRM de prospecção.
  const leads = await tolerante(
    `-- contatos:lista-leads
     SELECT i.id, i.lead_id, l.name AS nome, i.created_at, i.body, i.channel, i.author_name AS autor, i.payload
       FROM lead_interactions i
       JOIN sales_leads l ON l.id = i.lead_id
      WHERE i.payload IS NOT NULL AND i.created_at >= ${inicio}
      ORDER BY i.created_at DESC
      LIMIT $2`,
    [desde, limite]
  );

  const doLead = leads.rows.map((r) => {
    const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
    return {
      id: r.id,
      origem: 'lead',
      company_id: null,
      lead_id: r.lead_id,
      nome: r.nome || null,
      created_at: r.created_at,
      body: r.body,
      canal: p.canal || null,
      resultado: p.resultado || null,
      proximo_passo: p.proximo_passo || null,
      proximo_passo_em: p.proximo_passo_em || null,
      motivo: p.motivo || null,
      prorrogou_dias: p.prorrogou_dias || null,
      marcador: p.marcador || null,
      checkin: p.checkin || null,
      autor: r.autor || null,
    };
  });
  const daEmpresa = empresas.rows.map((r) => ({
    id: r.id,
    origem: 'empresa',
    company_id: r.company_id,
    lead_id: null,
    nome: r.nome || null,
    created_at: r.created_at,
    body: r.body,
    canal: r.canal || null,
    resultado: r.resultado || null,
    proximo_passo: r.proximo_passo || null,
    proximo_passo_em: r.proximo_passo_em || null,
    motivo: r.motivo || null,
    prorrogou_dias: r.prorrogou_dias === null || r.prorrogou_dias === undefined ? null : r.prorrogou_dias,
    marcador: r.marcador || null,
    checkin: null,
    autor: r.autor || null,
  }));

  const todos = [...daEmpresa, ...doLead]
    .sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime())
    .slice(0, limite);
  return { contatos: todos, migration_pendente: empresas.pendente || leads.pendente };
}

// Item da linha do tempo da ficha (e o rótulo curto dele).
function tituloDoContato(c) {
  if (!c.resultado && !c.canal) return 'Nota da equipe';
  const canal = CANAL_ROTULO[c.canal];
  const resultado = RESULTADO_ROTULO[c.resultado];
  if (canal && resultado) return `Contato por ${canal}: ${resultado}`;
  return canal ? `Contato por ${canal}` : `Contato: ${resultado}`;
}

module.exports = {
  CANAIS, RESULTADOS, MOTIVOS, MARCADORES, COMO_CHEGOU, CHAVES_CHECKIN,
  CANAL_ROTULO, RESULTADO_ROTULO,
  normalizar, registrarEmpresa, registrarLead, listarDesde, tituloDoContato, migrationPendente, diaValido,
};
