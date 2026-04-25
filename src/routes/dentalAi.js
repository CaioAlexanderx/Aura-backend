// ============================================================
// AURA. — W2-05: IA Odonto Persistente (Expansao + vertical odonto)
//
// Diferente do aiChat.js (multi-context, stateless, history vem
// do FE), aqui as conversas sao SALVAS no banco e podem ser
// retomadas. Quando vinculadas a um paciente, a IA recebe
// contexto clinico profundo no system prompt:
//   - anamnese (alergias, medicacoes, historico medico)
//   - odontograma (status de cada dente)
//   - planos de tratamento ativos
//   - ultimas consultas e procedimentos
//   - parcelas pendentes
//
// Endpoints:
//   POST   /companies/:cid/dental/ai/conversations
//   GET    /companies/:cid/dental/ai/conversations
//   GET    /companies/:cid/dental/ai/conversations/:cvid
//   POST   /companies/:cid/dental/ai/conversations/:cvid/messages
//   PATCH  /companies/:cid/dental/ai/conversations/:cvid
//   DELETE /companies/:cid/dental/ai/conversations/:cvid (archive)
//
// Acesso: somente plano 'expansao' + companies.vertical_active='odonto'.
// Plan/vertical sao re-checados via DB (nao confiamos no JWT stale).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || null;
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';
const CLAUDE_URL     = 'https://api.anthropic.com/v1/messages';

const HISTORY_LIMIT  = 20;   // ultimas N mensagens enviadas pra Claude
const MAX_TOKENS_OUT = 1500; // tokens max na resposta
const MSG_MAX_LEN    = 4000; // bytes max na mensagem do user

let redis = null;
try { redis = require('../config/redis').default || require('../config/redis'); } catch (_) {}

// ─────────────────────────────────────────────────────────
// Rate limit: Expansao tem 100/h global pra IA generica.
// Aqui usa um bucket separado pra IA odonto (mesmo limite,
// mas nao consome o bucket geral).
// ─────────────────────────────────────────────────────────
async function checkRateLimit(companyId) {
  const limit = 100;
  if (!redis) return true;
  const key = `rl:dentalAi:${companyId}`;
  try {
    const cnt = await redis.incr(key);
    if (cnt === 1) await redis.expire(key, 3600);
    return cnt <= limit;
  } catch (_) { return true; }
}

// ─────────────────────────────────────────────────────────
// Middleware: gate plan=expansao + vertical=odonto (DB read).
// Roda apos requireAuth + requireCompanyAccess no mount.
// ─────────────────────────────────────────────────────────
async function requireOdontoExpansao(req, res, next) {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT plan, vertical_active FROM companies WHERE id = $1`,
      [cid]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Empresa nao encontrada' });
    }
    const { plan, vertical_active } = rows[0];

    if (plan !== 'expansao') {
      return res.status(403).json({
        error: 'IA Odonto disponivel apenas no plano Expansao',
        required_plan: 'expansao',
        current_plan: plan,
        upgrade_hint: 'Faca upgrade pra Expansao pra acessar a IA Odonto com contexto clinico por paciente.',
      });
    }
    if (vertical_active !== 'odonto') {
      return res.status(403).json({
        error: 'IA Odonto requer o modulo vertical Odonto ativo',
        required_vertical: 'odonto',
        current_vertical: vertical_active || null,
        upgrade_hint: 'Ative o modulo Odonto nas configuracoes ou contate o suporte Aura.',
      });
    }
    next();
  } catch (err) {
    console.error('[dentalAi] gate error:', err);
    res.status(500).json({ error: 'Erro ao verificar acesso' });
  }
}

// ─────────────────────────────────────────────────────────
// SYSTEM PROMPT base — versao mais profunda que a do aiChat
// generico. Foco em conversa continua, com memoria do paciente.
// ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT_BASE = `Voce e a IA Odonto da Aura, uma assistente especializada em gestao de clinicas odontologicas. Conversa persistente e contextual: voce lembra do que foi discutido ao longo da conversa.

PAPEL
Voce ajuda o(a) dentista, recepcionista ou gestor(a) da clinica com:
- Organizacao da agenda e priorizacao de confirmacoes
- Estrategia de cobranca de tratamentos em atraso (tom respeitoso)
- Recall de pacientes para retorno preventivo
- Analise de dados da clinica (faturamento, ticket medio, conversao funil)
- Scripts profissionais para WhatsApp (confirmacao, recall, cobranca, recuperacao de no-show)
- Orientacao operacional sobre fluxo da clinica
- Dicas de gestao de tempo e produtividade clinica

LIMITES CLINICOS (LEIA COM ATENCAO)
- Voce NAO e dentista. NUNCA sugira diagnostico, conduta clinica, prescricao ou plano de tratamento. Se perguntarem qual o melhor tratamento para um caso, responda que essa decisao e exclusiva do(a) cirurgia-dentista responsavel.
- Voce pode comentar sobre dados de saude do paciente APENAS no contexto da gestao da clinica (ex: "paciente com alergia a penicilina, atencao na prescricao") e SEMPRE com o(a) profissional como destinatario, nunca pra ser repassado ao paciente.
- Dados de saude sao sensiveis (LGPD Art. 11). Quando a clinica for compartilhar info clinica com o paciente, sempre orientar a obter consentimento explicito.
- Nao de aconselhamento sobre regras do CFO/CRO. Oriente a consultar o Conselho Regional.

LIMITES FINANCEIROS
- Nao de assessoria tributaria vinculante. Orientacoes de impostos sao informativas.
- Em cobranca, NUNCA tom agressivo. Saude e relacao continua.

ESTILO
- Portugues brasileiro, direto, pratico
- Respostas curtas e acionaveis (max 200 palavras quando possivel)
- Quando fizer script de WhatsApp, formate em bloco proprio pra copiar
- Use emojis com moderacao (max 1-2 por resposta)
- Se nao tiver dados suficientes, peca informacao em vez de inventar`;

// ─────────────────────────────────────────────────────────
// Busca contexto profundo de um paciente especifico.
// Retorna objeto resumido (max ~2KB serializado) pra
// nao explodir tokens de input.
// ─────────────────────────────────────────────────────────
async function fetchPatientContext(cid, patientId) {
  const ctx = { id: patientId };

  // 1. Dados basicos + anamnese
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, name, phone, email, birthday, cpf,
              anamnesis_data, anamnesis_updated_at, notes
         FROM customers
        WHERE id = $1 AND company_id = $2 AND is_patient = true
        LIMIT 1`,
      [patientId, cid]
    );
    if (!rows[0]) return null;
    const p = rows[0];
    ctx.nome              = p.full_name || p.name;
    ctx.telefone          = p.phone || null;
    ctx.email             = p.email || null;
    ctx.nascimento        = p.birthday || null;
    ctx.observacoes       = p.notes || null;
    if (p.anamnesis_data) {
      // Resumo da anamnese — pega so campos relevantes
      const a = p.anamnesis_data;
      ctx.anamnese = {
        alergias:           a.alergias || [],
        medicacoes:         a.medicacoes || [],
        doencas:            a.doencas || [],
        gravidez:           a.gravidez || false,
        cirurgia_recente:   a.cirurgia_recente || false,
        habitos: {
          tabagismo:    a.habitos?.tabagismo || false,
          bruxismo:     a.habitos?.bruxismo || false,
          sangramento:  a.habitos?.sangramento || false,
        },
        atualizado_em: p.anamnesis_updated_at,
      };
    }
  } catch (_) {}

  // 2. Odontograma resumido (so dentes com status != higido)
  try {
    const { rows } = await db.query(
      `SELECT tooth_number, status FROM dental_tooth_chart
        WHERE company_id = $1 AND patient_id = $2 AND status IS NOT NULL AND status != 'higido'
        ORDER BY tooth_number
        LIMIT 32`,
      [cid, patientId]
    );
    if (rows.length) {
      ctx.odontograma_alteracoes = rows.map(r => ({
        dente: r.tooth_number,
        status: r.status,
      }));
    }
  } catch (_) {}

  // 3. Planos de tratamento ativos
  try {
    const { rows } = await db.query(
      `SELECT id, plan_number, status, total, valid_until, created_at
         FROM dental_treatment_plans
        WHERE company_id = $1 AND customer_id = $2
          AND status IN ('rascunho','enviado','aprovado','em_tratamento')
        ORDER BY created_at DESC
        LIMIT 5`,
      [cid, patientId]
    );
    if (rows.length) {
      ctx.planos_ativos = rows.map(r => ({
        numero: r.plan_number,
        status: r.status,
        total:  parseFloat(r.total) || 0,
        validade: r.valid_until,
      }));
    }
  } catch (_) {}

  // 4. Ultimos 3 atendimentos
  try {
    const { rows } = await db.query(
      `SELECT id, scheduled_at, status, total
         FROM dental_appointments
        WHERE company_id = $1 AND customer_id = $2
        ORDER BY scheduled_at DESC
        LIMIT 3`,
      [cid, patientId]
    );
    if (rows.length) {
      ctx.ultimos_atendimentos = rows.map(r => ({
        data:   r.scheduled_at,
        status: r.status,
        total:  parseFloat(r.total) || 0,
      }));
    }
  } catch (_) {}

  // 5. Parcelas vencidas
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS qtd, COALESCE(SUM(amount), 0) AS total
         FROM dental_payments dp
         JOIN dental_treatment_plans dtp ON dtp.id = dp.treatment_plan_id
        WHERE dtp.company_id = $1 AND dtp.customer_id = $2
          AND dp.status = 'pending' AND dp.due_date < CURRENT_DATE`,
      [cid, patientId]
    );
    if (rows[0] && parseInt(rows[0].qtd) > 0) {
      ctx.parcelas_vencidas = {
        quantidade: parseInt(rows[0].qtd),
        total:      parseFloat(rows[0].total) || 0,
      };
    }
  } catch (_) {}

  return ctx;
}

// ─────────────────────────────────────────────────────────
// Busca contexto agregado da clinica (sem paciente especifico).
// Usado quando a conversa nao esta vinculada a paciente.
// ─────────────────────────────────────────────────────────
async function fetchClinicContext(cid) {
  const ctx = {};
  try {
    // Consultas de hoje
    const { rows: hoje } = await db.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'confirmado')   AS confirmados,
         COUNT(*) FILTER (WHERE status = 'agendado')      AS pendentes,
         COUNT(*) FILTER (WHERE status = 'faltou')        AS faltas
       FROM dental_appointments
       WHERE company_id = $1
         AND (scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
      [cid]
    );
    if (hoje[0]) {
      ctx.consultas_hoje = {
        total:       parseInt(hoje[0].total) || 0,
        confirmados: parseInt(hoje[0].confirmados) || 0,
        pendentes:   parseInt(hoje[0].pendentes) || 0,
        faltas:      parseInt(hoje[0].faltas) || 0,
      };
    }
  } catch (_) {}

  try {
    // Pacientes em recall (sem consulta ha 150+ dias)
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT c.id) AS qtd
         FROM customers c
        WHERE c.company_id = $1 AND c.is_patient = true
          AND NOT EXISTS (
            SELECT 1 FROM dental_appointments da
             WHERE da.customer_id = c.id
               AND da.scheduled_at >= NOW() - INTERVAL '150 days'
          )`,
      [cid]
    );
    if (rows[0]) ctx.pacientes_recall = parseInt(rows[0].qtd) || 0;
  } catch (_) {}

  try {
    // Funil: contagem por stage
    const { rows } = await db.query(
      `SELECT stage, COUNT(*) AS qtd
         FROM dental_leads
        WHERE company_id = $1 AND stage NOT IN ('completed','lost')
        GROUP BY stage`,
      [cid]
    );
    if (rows.length) {
      ctx.funil_ativo = rows.reduce((acc, r) => {
        acc[r.stage] = parseInt(r.qtd) || 0;
        return acc;
      }, {});
    }
  } catch (_) {}

  return ctx;
}

// ─────────────────────────────────────────────────────────
// Chama Claude API com system + history + new message.
// Retorna { text, tokens_in, tokens_out, error? }
// ─────────────────────────────────────────────────────────
async function callClaude(systemPrompt, history, newMessage) {
  if (!CLAUDE_API_KEY) {
    return {
      text: '[CLAUDE_API_KEY nao configurada no servidor. Esta e uma resposta simulada.] Configure a variavel CLAUDE_API_KEY no Railway pra ativar a IA Odonto.',
      tokens_in: 0, tokens_out: 0,
    };
  }

  const messages = [
    ...history.slice(-HISTORY_LIMIT).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: newMessage },
  ];

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;

  try {
    const response = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: MAX_TOKENS_OUT,
        system:     systemPrompt,
        messages,
      }),
      signal: controller?.signal,
    });
    if (timer) clearTimeout(timer);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || `HTTP ${response.status}`;
      return { error: `Erro Claude API: ${errMsg}`, status: response.status };
    }

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || 'Sem resposta.';
    return {
      text,
      tokens_in:  data.usage?.input_tokens  || 0,
      tokens_out: data.usage?.output_tokens || 0,
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { error: 'A IA demorou demais para responder (>30s). Tente uma pergunta mais curta.', status: 504 };
    }
    return { error: 'Erro ao chamar Claude: ' + (err.message || ''), status: 500 };
  }
}

// ============================================================
// ROTAS
// ============================================================

// Aplica gate em todas as rotas deste router
router.use(requireRole('client', 'analyst', 'admin'), requireOdontoExpansao);

// ── POST /conversations ─ cria nova conversa ─────────────
router.post('/conversations', async (req, res) => {
  const cid = req.params.id;
  const { patient_id = null, title = null } = req.body || {};

  try {
    // Se vinculado a paciente, captura snapshot pro audit trail
    let snapshot = null;
    if (patient_id) {
      const ctx = await fetchPatientContext(cid, patient_id);
      if (!ctx) {
        return res.status(404).json({ error: 'Paciente nao encontrado nesta clinica' });
      }
      snapshot = {
        nome:       ctx.nome,
        alergias:   ctx.anamnese?.alergias || [],
        medicacoes: ctx.anamnese?.medicacoes || [],
        captured_at: new Date().toISOString(),
      };
    }

    const { rows } = await db.query(
      `INSERT INTO dental_ai_conversations (company_id, user_id, patient_id, title, context_snapshot)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, company_id, user_id, patient_id, title, message_count, created_at, updated_at`,
      [cid, req.user.id, patient_id, title, snapshot ? JSON.stringify(snapshot) : null]
    );

    res.status(201).json({ conversation: rows[0] });
  } catch (err) {
    console.error('[dentalAi] create conv error:', err);
    res.status(500).json({ error: 'Erro ao criar conversa' });
  }
});

// ── GET /conversations ─ lista conversas ────────────────
router.get('/conversations', async (req, res) => {
  const cid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const patientId = req.query.patient_id || null;

  try {
    let q = `
      SELECT c.id, c.user_id, c.patient_id, c.title, c.message_count,
             c.created_at, c.updated_at,
             cu.full_name AS patient_name
        FROM dental_ai_conversations c
        LEFT JOIN customers cu ON cu.id = c.patient_id
       WHERE c.company_id = $1 AND c.archived_at IS NULL`;
    const params = [cid];

    if (patientId) {
      q += ` AND c.patient_id = $${params.length + 1}`;
      params.push(patientId);
    }

    q += ` ORDER BY c.updated_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await db.query(q, params);
    res.json({ conversations: rows, total: rows.length });
  } catch (err) {
    console.error('[dentalAi] list conv error:', err);
    res.status(500).json({ error: 'Erro ao listar conversas' });
  }
});

// ── GET /conversations/:cvid ─ historico completo ──────
router.get('/conversations/:cvid', async (req, res) => {
  const cid = req.params.id;
  const cvid = req.params.cvid;

  try {
    const { rows: cvRows } = await db.query(
      `SELECT c.id, c.user_id, c.patient_id, c.title, c.context_snapshot,
              c.message_count, c.created_at, c.updated_at,
              cu.full_name AS patient_name, cu.phone AS patient_phone
         FROM dental_ai_conversations c
         LEFT JOIN customers cu ON cu.id = c.patient_id
        WHERE c.id = $1 AND c.company_id = $2 AND c.archived_at IS NULL`,
      [cvid, cid]
    );
    if (!cvRows[0]) {
      return res.status(404).json({ error: 'Conversa nao encontrada' });
    }

    const { rows: msgRows } = await db.query(
      `SELECT id, role, content, created_at
         FROM dental_ai_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC`,
      [cvid]
    );

    res.json({
      conversation: cvRows[0],
      messages:     msgRows,
    });
  } catch (err) {
    console.error('[dentalAi] get conv error:', err);
    res.status(500).json({ error: 'Erro ao buscar conversa' });
  }
});

// ── POST /conversations/:cvid/messages ─ envia + recebe ─
router.post('/conversations/:cvid/messages', async (req, res) => {
  const cid  = req.params.id;
  const cvid = req.params.cvid;
  const { message } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message e obrigatorio' });
  }
  if (message.length > MSG_MAX_LEN) {
    return res.status(400).json({ error: `Mensagem muito longa (max ${MSG_MAX_LEN} caracteres)` });
  }

  // Rate limit
  const allowed = await checkRateLimit(cid);
  if (!allowed) {
    return res.status(429).json({ error: 'Limite de 100 mensagens/hora atingido. Tente novamente daqui a pouco.' });
  }

  try {
    // 1. Carrega conversa + valida ownership
    const { rows: cvRows } = await db.query(
      `SELECT id, patient_id, title, message_count
         FROM dental_ai_conversations
        WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`,
      [cvid, cid]
    );
    if (!cvRows[0]) {
      return res.status(404).json({ error: 'Conversa nao encontrada' });
    }
    const conv = cvRows[0];

    // 2. Carrega historico
    const { rows: history } = await db.query(
      `SELECT role, content FROM dental_ai_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [cvid, HISTORY_LIMIT * 2]
    );

    // 3. Monta system prompt enriquecido
    let systemPrompt = SYSTEM_PROMPT_BASE;

    // Contexto da clinica
    try {
      const { rows: coRows } = await db.query(
        `SELECT trade_name, legal_name, address_city, address_state
           FROM companies WHERE id = $1`, [cid]);
      if (coRows[0]) {
        const co = coRows[0];
        systemPrompt += `\n\n=== CLINICA ===\nNome: ${co.trade_name || co.legal_name || 'N/A'}\nLocal: ${co.address_city || ''}/${co.address_state || 'SP'}`;
      }
    } catch (_) {}

    // Se vinculado a paciente, injeta contexto profundo
    if (conv.patient_id) {
      const pctx = await fetchPatientContext(cid, conv.patient_id);
      if (pctx) {
        systemPrompt += `\n\n=== PACIENTE EM FOCO ===\n${JSON.stringify(pctx, null, 2)}\n\nIMPORTANTE: Use estes dados pra dar respostas especificas a este paciente. Se houver alergias ou contraindicacoes na anamnese, sempre alerte. Se houver parcelas vencidas, considere antes de propor mais procedimentos.`;
      }
    } else {
      // Sem paciente, da overview da clinica
      const cctx = await fetchClinicContext(cid);
      if (Object.keys(cctx).length > 0) {
        systemPrompt += `\n\n=== DADOS DA CLINICA HOJE ===\n${JSON.stringify(cctx, null, 2)}`;
      }
    }

    // 4. Salva mensagem do user
    await db.query(
      `INSERT INTO dental_ai_messages (conversation_id, role, content)
       VALUES ($1, 'user', $2)`,
      [cvid, message.trim()]
    );

    // 5. Chama Claude
    const result = await callClaude(systemPrompt, history, message.trim());
    if (result.error) {
      return res.status(result.status || 502).json({ error: result.error });
    }

    // 6. Salva resposta
    await db.query(
      `INSERT INTO dental_ai_messages (conversation_id, role, content, tokens_in, tokens_out)
       VALUES ($1, 'assistant', $2, $3, $4)`,
      [cvid, result.text, result.tokens_in, result.tokens_out]
    );

    // 7. Se for primeira mensagem, gera titulo automatico
    if (!conv.title && conv.message_count === 0) {
      const autoTitle = message.trim().substring(0, 80).replace(/\s+/g, ' ');
      await db.query(
        `UPDATE dental_ai_conversations SET title = $1 WHERE id = $2 AND title IS NULL`,
        [autoTitle, cvid]
      );
    }

    res.json({
      message: {
        role:    'assistant',
        content: result.text,
        tokens_in:  result.tokens_in,
        tokens_out: result.tokens_out,
      },
    });
  } catch (err) {
    console.error('[dentalAi] send msg error:', err);
    res.status(500).json({ error: 'Erro ao processar mensagem' });
  }
});

// ── PATCH /conversations/:cvid ─ rename ─────────────────
router.patch('/conversations/:cvid', async (req, res) => {
  const cid  = req.params.id;
  const cvid = req.params.cvid;
  const { title } = req.body || {};

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title e obrigatorio' });
  }

  try {
    const { rowCount } = await db.query(
      `UPDATE dental_ai_conversations
          SET title = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3 AND archived_at IS NULL`,
      [title.trim().substring(0, 200), cvid, cid]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Conversa nao encontrada' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[dentalAi] patch conv error:', err);
    res.status(500).json({ error: 'Erro ao atualizar conversa' });
  }
});

// ── DELETE /conversations/:cvid ─ archive (soft) ────────
router.delete('/conversations/:cvid', async (req, res) => {
  const cid  = req.params.id;
  const cvid = req.params.cvid;

  try {
    const { rowCount } = await db.query(
      `UPDATE dental_ai_conversations
          SET archived_at = NOW()
        WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`,
      [cvid, cid]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Conversa nao encontrada' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[dentalAi] delete conv error:', err);
    res.status(500).json({ error: 'Erro ao arquivar conversa' });
  }
});

module.exports = router;
