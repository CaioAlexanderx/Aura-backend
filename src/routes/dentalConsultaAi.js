// ============================================================
// AURA. — IA Modo Consulta · endpoint POST /dental/ai/consulta
// PR18 (2026-04-27)
//
// Endpoint unico com dispatcher por `intent`:
//   - brief       — gera lista curta de alertas pre-consulta
//   - suggestion  — alerta em tempo real durante a consulta
//   - qa          — Q&A livre do dentista
//   - summarize   — resumo da transcricao em texto clinico
//   - prescribe   — receituario pre-preenchido baseado em procedimento
//
// Body:
//   {
//     intent:        'brief' | 'suggestion' | 'qa' | 'summarize' | 'prescribe',
//     appointmentId: uuid (obrigatorio),
//     patientId:     uuid (obrigatorio),
//     query?:        string (intent=qa),
//     context?:      { transcripts?: string[], toothChanges?: [...] }
//   }
//
// Resposta:
//   {
//     ok: true,
//     text: '...',                  // resposta da IA (markdown ou texto)
//     intent, model, tokens_in, tokens_out, cost_usd, latency_ms,
//     quota: { used, total, remaining }
//   }
//
// Gate (mesma logica do dentalAi.js):
//   - plano = 'expansao' (lido do DB, nao do JWT)
//   - vertical_active = 'odonto'
//   - companies.ai_enabled = true (opt-in explicito apos consent LGPD)
//   - quota mensal nao esgotada
//
// Mount: src/routes/dental.js → router.use('/ai/consulta', ...)
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const { callConsultaLLM, checkMonthlyQuota } = require('../services/llmConsulta');

const VALID_INTENTS = new Set(['brief', 'suggestion', 'qa', 'summarize', 'prescribe']);
const MAX_QUERY_LEN     = 2000;
const MAX_CONTEXT_BYTES = 8000;

// ─────────────────────────────────────────────────────────
// Gate: plan=expansao + vertical=odonto + ai_enabled (opt-in).
// ─────────────────────────────────────────────────────────
async function requireConsultaAi(req, res, next) {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT plan, vertical_active, ai_enabled, ai_consent_at
         FROM companies WHERE id = $1`,
      [cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Empresa nao encontrada' });

    const c = rows[0];
    if (c.plan !== 'expansao') {
      return res.status(403).json({
        error: 'IA do Modo Consulta requer plano Expansao',
        required_plan: 'expansao',
        current_plan: c.plan,
      });
    }
    if (c.vertical_active !== 'odonto') {
      return res.status(403).json({
        error: 'IA do Modo Consulta requer vertical Odonto ativa',
        current_vertical: c.vertical_active || null,
      });
    }
    if (!c.ai_enabled) {
      return res.status(403).json({
        error: 'IA do Modo Consulta nao esta ativada nas configuracoes da clinica',
        hint: 'Acesse Configuracoes > IA Aura para ativar.',
        ai_enabled: false,
      });
    }
    if (!c.ai_consent_at) {
      return res.status(403).json({
        error: 'Termo de uso da IA (LGPD) ainda nao foi aceito',
        hint: 'Acesse Configuracoes > IA Aura para revisar e aceitar.',
        consent_required: true,
      });
    }
    next();
  } catch (err) {
    console.error('[dentalConsultaAi] gate error:', err);
    res.status(500).json({ error: 'Erro ao verificar acesso' });
  }
}

router.use(requireRole('client', 'analyst', 'admin'), requireConsultaAi);

// ─────────────────────────────────────────────────────────
// Carrega contexto compacto (~3KB serializado) por consulta.
// Pacote de dados que vai pro system prompt em todos os intents.
// ─────────────────────────────────────────────────────────
async function loadConsultaContext(cid, appointmentId, patientId) {
  const ctx = {};

  // 1. Appointment + dados basicos do paciente
  try {
    const { rows } = await db.query(
      `SELECT a.scheduled_at, a.duration_min, a.chief_complaint, a.status,
              c.name AS patient_name, c.phone, c.birthday,
              c.allergies, c.notes,
              c.anamnesis_data,
              pr.name AS practitioner_name
         FROM dental_appointments a
         JOIN customers c ON c.id = a.customer_id
         LEFT JOIN dental_practitioners pr ON pr.id = a.practitioner_id
        WHERE a.id = $1 AND a.company_id = $2 AND c.id = $3`,
      [appointmentId, cid, patientId]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    ctx.consulta = {
      data:        r.scheduled_at,
      duracao_min: r.duration_min,
      queixa:      r.chief_complaint,
      profissional: r.practitioner_name,
    };
    ctx.paciente = {
      nome:       r.patient_name,
      nascimento: r.birthday,
      alergias:   r.allergies || null,
      observacoes: r.notes || null,
    };
    if (r.anamnesis_data && typeof r.anamnesis_data === 'object') {
      const a = r.anamnesis_data;
      ctx.anamnese = {
        alergias:   a.alergias   || [],
        medicacoes: a.medicacoes || [],
        doencas:    a.doencas    || [],
        gravidez:   !!a.gravidez,
        habitos:    a.habitos    || {},
      };
    }
  } catch (_) { return null; }

  // 2. Odontograma — so dentes com status diferente de higido (compacto)
  try {
    const { rows } = await db.query(
      `SELECT tooth_number, status, notes
         FROM dental_chart_entries
        WHERE company_id = $1 AND customer_id = $2
          AND status IS NOT NULL AND status != 'higido'
        ORDER BY recorded_at DESC
        LIMIT 16`,
      [cid, patientId]
    );
    if (rows.length) {
      // Deduplica por dente (pega o mais recente)
      const byTooth = {};
      for (const r of rows) {
        if (!byTooth[r.tooth_number]) byTooth[r.tooth_number] = { dente: r.tooth_number, status: r.status };
      }
      ctx.odontograma = Object.values(byTooth);
    }
  } catch (_) {}

  // 3. Plano de tratamento ativo
  try {
    const { rows } = await db.query(
      `SELECT plan_number, status, total
         FROM dental_treatment_plans
        WHERE company_id = $1 AND customer_id = $2
          AND status IN ('aprovado','em_tratamento')
        ORDER BY created_at DESC
        LIMIT 1`,
      [cid, patientId]
    );
    if (rows[0]) ctx.plano_ativo = rows[0];
  } catch (_) {}

  // 4. Ultimas 3 consultas
  try {
    const { rows } = await db.query(
      `SELECT scheduled_at, status, chief_complaint
         FROM dental_appointments
        WHERE company_id = $1 AND customer_id = $2
          AND id != $3
        ORDER BY scheduled_at DESC
        LIMIT 3`,
      [cid, patientId, appointmentId]
    );
    if (rows.length) ctx.historico_recente = rows;
  } catch (_) {}

  return ctx;
}

// ─────────────────────────────────────────────────────────
// Builders de prompt por intent.
// Cada um retorna { systemPrompt, userMessage, maxTokens }.
// ─────────────────────────────────────────────────────────

const SYSTEM_BASE = `Voce e a IA Aura do Modo Consulta, assistente clinica para um(a) cirurgiao-dentista durante o atendimento.

LIMITES (LEIA COM ATENCAO):
- Voce NAO substitui o dentista. Diagnostico e conduta sao decisao exclusiva do(a) profissional.
- Suas respostas sao SUGESTOES baseadas em protocolos gerais e nos dados que recebeu. O dentista valida tudo.
- NAO de aconselhamento jurisdicional (CFO/CRO). Oriente a consultar Conselho Regional.
- Sempre alerte sobre alergias e contraindicacoes presentes no contexto.

ESTILO:
- Portugues brasileiro, direto, pratico.
- Respostas curtas (max 200 palavras quando possivel).
- Use markdown leve (negrito, listas) pra escanear rapido.
- Sem emojis (exceto alertas criticos: ⚠️).
- Se nao tiver dado suficiente, peca informacao em vez de inventar.`;

function buildBriefPrompt(ctx) {
  const sys = `${SYSTEM_BASE}

INTENT = brief
Tarefa: gerar um BRIEF PRE-CONSULTA contendo:
1. **Alertas criticos** (alergias, condicoes sistemicas, interacoes potenciais com a queixa)
2. **Pontos de atencao** (medicacoes em uso que afetam o procedimento)
3. **Continuidade** (algo da ultima consulta que o dentista deve rever?)

Formato de saida: 3-5 bullets curtos, prefixados por emoji ⚠️ pra critico ou • pra atencao.
Maximo 150 palavras. Se sem alertas, diga "Sem alertas no prontuario — proceder com protocolo padrao."`;

  const user = `CONTEXTO DA CONSULTA:\n\n${JSON.stringify(ctx, null, 2)}\n\nGere o brief.`;
  return { systemPrompt: sys, userMessage: user, maxTokens: 600 };
}

function buildSuggestionPrompt(ctx, query) {
  const sys = `${SYSTEM_BASE}

INTENT = suggestion
Tarefa: o(a) dentista esta DURANTE a consulta e pediu uma sugestao especifica. Responda de forma extremamente curta (max 80 palavras), pratica, focada na situacao agora. Se a pergunta envolver protocolo de medicacao/anestesia, sempre cite limites de seguranca (max dose, contraindicacoes do paciente).`;

  const user = `CONTEXTO:\n${JSON.stringify(ctx, null, 2)}\n\nPergunta do dentista: "${query || '(em branco — peca clarificacao)'}"`;
  return { systemPrompt: sys, userMessage: user, maxTokens: 400 };
}

function buildQaPrompt(ctx, query) {
  const sys = `${SYSTEM_BASE}

INTENT = qa
Tarefa: responder uma pergunta livre do(a) dentista usando o contexto fornecido. Pode ser detalhe sobre paciente, protocolo geral, dosagem, etc. Responda em ate 200 palavras.`;

  const user = `CONTEXTO:\n${JSON.stringify(ctx, null, 2)}\n\nPergunta: "${query || ''}"`;
  return { systemPrompt: sys, userMessage: user, maxTokens: 800 };
}

function buildSummarizePrompt(ctx, transcripts, toothChanges) {
  const sys = `${SYSTEM_BASE}

INTENT = summarize
Tarefa: gerar um RESUMO CLINICO da consulta em portugues tecnico, formato evolucao odontologica. Inclua:
1. Procedimento realizado (1-2 linhas)
2. Achados clinicos relevantes (do transcript + odontograma)
3. Intercorrencias (se houver)
4. Conduta tomada
5. Orientacao pos-procedimento (se aplicavel)

Formato: paragrafos curtos, separados por linhas em branco. Maximo 250 palavras. NAO invente dados — se algo nao consta no contexto, omita.`;

  const txParts = (transcripts || []).slice(-30).join(' ').slice(0, 3000);
  const tcText = (toothChanges || [])
    .slice(0, 16)
    .map((c) => `Dente ${c.tooth_number}: ${c.prev_status || '—'} → ${c.status}${c.notes ? ' (' + c.notes + ')' : ''}`)
    .join('\n');
  const user = `CONTEXTO:\n${JSON.stringify(ctx, null, 2)}\n\nTRANSCRICAO POR VOZ (ultimas falas):\n${txParts || '(sem transcricao)'}\n\nMUDANCAS NO ODONTOGRAMA NESTA SESSAO:\n${tcText || '(sem mudancas)'}\n\nGere o resumo clinico.`;
  return { systemPrompt: sys, userMessage: user, maxTokens: 1000 };
}

function buildPrescribePrompt(ctx, query) {
  const sys = `${SYSTEM_BASE}

INTENT = prescribe
Tarefa: sugerir um receituario pos-procedimento PRE-PREENCHIDO baseado no procedimento e no perfil do paciente. Sempre considerar:
- Alergias do paciente (NUNCA prescrever algo que ele eh alergico)
- Medicacoes em uso (interacoes)
- Condicoes sistemicas (insuficiencia renal/hepatica, hipertensao etc)

Formato: lista de medicamentos com posologia. Exemplo:
**Pos-operatorio**:
- Paracetamol 750mg — 1cp 6/6h por 2 dias
- Ibuprofeno 600mg — 1cp 8/8h se persistir, max 3 dias

Se houver alergia/contraindicacao bloqueando uma sugestao, cite a alternativa segura.
O dentista revisa antes de emitir. Maximo 150 palavras.`;

  const user = `CONTEXTO:\n${JSON.stringify(ctx, null, 2)}\n\nProcedimento/contexto da prescricao: "${query || ctx.consulta?.queixa || 'pos-operatorio padrao'}"`;
  return { systemPrompt: sys, userMessage: user, maxTokens: 500 };
}

// ─────────────────────────────────────────────────────────
// POST /  →  /companies/:cid/dental/ai/consulta
// ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const cid = req.params.id;
  const userId = req.user?.id || null;
  const { intent, appointmentId, patientId, query, context } = req.body || {};

  // 1. Validacao de input
  if (!intent || !VALID_INTENTS.has(intent)) {
    return res.status(400).json({
      error: 'intent invalido ou ausente',
      valid_intents: Array.from(VALID_INTENTS),
    });
  }
  if (!appointmentId || !patientId) {
    return res.status(400).json({ error: 'appointmentId e patientId sao obrigatorios' });
  }
  if (query && typeof query === 'string' && query.length > MAX_QUERY_LEN) {
    return res.status(400).json({ error: `query muito longa (max ${MAX_QUERY_LEN} caracteres)` });
  }
  if (context && JSON.stringify(context).length > MAX_CONTEXT_BYTES) {
    return res.status(400).json({ error: `context muito grande (max ${MAX_CONTEXT_BYTES} bytes)` });
  }

  // 2. Quota mensal
  const quota = await checkMonthlyQuota(cid);
  if (!quota.ok) {
    return res.status(429).json({
      error: quota.message,
      quota: { used: quota.used, total: quota.total, remaining: 0 },
    });
  }

  // 3. Carrega contexto da consulta
  const ctx = await loadConsultaContext(cid, appointmentId, patientId);
  if (!ctx) {
    return res.status(404).json({ error: 'Consulta/paciente nao encontrado nesta clinica' });
  }

  // 4. Despacha pra builder de prompt do intent
  let prompt;
  switch (intent) {
    case 'brief':      prompt = buildBriefPrompt(ctx); break;
    case 'suggestion': prompt = buildSuggestionPrompt(ctx, query); break;
    case 'qa':         prompt = buildQaPrompt(ctx, query); break;
    case 'summarize':  prompt = buildSummarizePrompt(ctx, context?.transcripts, context?.toothChanges); break;
    case 'prescribe':  prompt = buildPrescribePrompt(ctx, query); break;
    default:           return res.status(400).json({ error: 'intent invalido' });
  }

  // 5. Chama LLM
  const result = await callConsultaLLM({
    companyId: cid,
    userId,
    appointmentId,
    intent,
    systemPrompt: prompt.systemPrompt,
    userMessage:  prompt.userMessage,
    maxTokens:    prompt.maxTokens,
  });

  if (!result.ok) {
    return res.status(result.status || 500).json({
      ok: false,
      error: result.error,
      latency_ms: result.latency_ms,
      quota,
    });
  }

  res.json({
    ok: true,
    intent,
    text:        result.text,
    model:       result.model,
    tokens_in:   result.tokens_in,
    tokens_out:  result.tokens_out,
    cost_usd:    result.cost_usd,
    latency_ms:  result.latency_ms,
    quota: { used: (quota.used || 0) + 1, total: quota.total, remaining: Math.max(0, (quota.remaining || 0) - 1), unlimited: quota.unlimited },
    simulated:   !!result.simulated,
  });
});

// ─────────────────────────────────────────────────────────
// GET /usage — dashboard de uso/custo do mes corrente
// (consumido pela tela de configuracoes IA no frontend)
// ─────────────────────────────────────────────────────────
router.get('/usage', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE status = 'ok')::int AS ok_calls,
         COUNT(*) FILTER (WHERE status = 'error')::int AS error_calls,
         COALESCE(SUM(tokens_in), 0)::int AS tokens_in_total,
         COALESCE(SUM(tokens_out), 0)::int AS tokens_out_total,
         COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS cost_usd_total,
         COALESCE(AVG(latency_ms) FILTER (WHERE status = 'ok'), 0)::int AS avg_latency_ms
       FROM ai_usage_log
      WHERE company_id = $1
        AND feature = 'consulta'
        AND created_at >= date_trunc('month', NOW())`,
      [cid]
    );
    const quota = await checkMonthlyQuota(cid);
    res.json({
      month_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      stats: rows[0] || {},
      quota,
    });
  } catch (err) {
    console.error('[dentalConsultaAi] usage error:', err);
    res.status(500).json({ error: 'Erro ao buscar uso' });
  }
});

module.exports = router;
