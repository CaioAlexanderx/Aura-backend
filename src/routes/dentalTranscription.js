// ============================================================
// AURA. — GAP-02: Transcrição de Evolução por Voz (IA)
// Mounted at: /dental/transcribe (Negócio+)
//
// Endpoints:
//   POST /dental/transcribe/text  — texto bruto → Claude estrutura → evolução clínica
//   POST /dental/transcribe/audio — áudio base64 → Whisper → Claude estrutura
//                                   (requer OPENAI_API_KEY no Railway)
//
// Rate limit: 50 transcrições/mês Negócio | ilimitado Expansão
// Controle via ai_activity_log (action = 'dental_transcribe')
// ============================================================

const express = require('express');
const db      = require('../config/database');

const router = express.Router({ mergeParams: true });

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';

// ─── Rate limit helper ────────────────────────────────────────
const MONTHLY_LIMIT_NEGOCIO = 50; // Expansão = sem limite

async function checkRateLimit(companyId, plan) {
  if (plan === 'expansao') return { allowed: true, used: null, limit: null };

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { rows } = await db.query(
    `SELECT COUNT(*) AS used
     FROM ai_activity_log
     WHERE company_id = $1
       AND action = 'dental_transcribe'
       AND created_at >= $2`,
    [companyId, startOfMonth]
  );

  const used  = parseInt(rows[0].used) || 0;
  const limit = MONTHLY_LIMIT_NEGOCIO;
  return { allowed: used < limit, used, limit };
}

async function logUsage(companyId, userId, inputTokens) {
  await db.query(
    `INSERT INTO ai_activity_log (company_id, user_id, action, input_tokens, output_tokens)
     VALUES ($1, $2, 'dental_transcribe', $3, 0)`,
    [companyId, userId, inputTokens || 0]
  ).catch(() => {});
}

// ─── Claude: estrutura texto bruto em evolução clínica ────────
async function structureWithClaude(rawText, patientName) {
  if (!CLAUDE_API_KEY) throw new Error('CLAUDE_API_KEY não configurada');

  const systemPrompt = `Você é um assistente clínico odontológico especializado em redigir evoluções de prontuário.
Receba o texto ditado pelo dentista e transforme-o em uma evolução clínica bem estruturada em português formal.

REGRAS:
- Mantenha todos os fatos clínicos mencionados pelo dentista
- Corrija erros de fala/ditado (concordância, repetições, hesitações)
- Estruture com as seções relevantes (use apenas as que foram mencionadas)
- Use terminologia odontológica adequada
- Tom profissional mas conciso
- Máximo de 400 palavras
- NÃO invente informações que não foram mencionadas

SEÇÕES DISPONÍVEIS (use somente as mencionadas):
• Queixa principal
• Exame clínico
• Procedimento realizado
• Materiais utilizados
• Intercorrências
• Orientações ao paciente
• Próximos passos / Retorno`;

  const userMessage = patientName
    ? `Paciente: ${patientName}\n\nTexto ditado pelo dentista:\n"${rawText}"`
    : `Texto ditado pelo dentista:\n"${rawText}"`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  const structured = data.content?.[0]?.text || '';
  const inputTokens = data.usage?.input_tokens || 0;
  return { structured, inputTokens };
}

// ─── Whisper: transcreve áudio → texto ───────────────────────
async function transcribeWithWhisper(audioBase64, mimeType) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no Railway. Adicione para habilitar transcrição por áudio.');
  }

  // Decodifica base64 → Buffer
  const audioBuffer = Buffer.from(audioBase64, 'base64');

  // Monta multipart form (Node 18+ tem FormData nativo)
  const { Blob } = await import('node:buffer');
  const formData  = new FormData();
  const extension = mimeType === 'audio/mp4' || mimeType === 'audio/m4a' ? 'm4a'
                  : mimeType === 'audio/webm' ? 'webm'
                  : mimeType === 'audio/wav'  ? 'wav'
                  : 'm4a';
  const blob = new Blob([audioBuffer], { type: mimeType || 'audio/m4a' });
  formData.append('file', blob, `recording.${extension}`);
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt');
  formData.append('response_format', 'text');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body:    formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper API error: ${err}`);
  }

  const transcription = await response.text();
  return transcription.trim();
}

// ─────────────────────────────────────────────────────────────
// POST /dental/transcribe/text
// Body: { raw_text: string, patient_name?: string, patient_id?: string, save?: boolean }
// Recebe texto bruto (digitado ou reconhecido pelo teclado) → Claude estrutura
// ─────────────────────────────────────────────────────────────
router.post('/text', async (req, res) => {
  const { companyId, userId, user } = req;
  const plan = user?.plan || 'essencial';
  const { raw_text, patient_name, patient_id, save } = req.body;

  if (!raw_text || raw_text.trim().length < 5) {
    return res.status(400).json({ error: 'raw_text obrigatório (mínimo 5 caracteres)' });
  }

  // Rate limit
  const rate = await checkRateLimit(companyId, plan);
  if (!rate.allowed) {
    return res.status(429).json({
      error: `Limite mensal de transcrições atingido (${rate.limit}/mês no plano Negócio). Faça upgrade para Expansão para uso ilimitado.`,
      used: rate.used, limit: rate.limit,
    });
  }

  try {
    const { structured, inputTokens } = await structureWithClaude(raw_text, patient_name);
    await logUsage(companyId, userId, inputTokens);

    // Salva no prontuário se solicitado
    let savedEntry = null;
    if (save && patient_id) {
      const { rows } = await db.query(
        `INSERT INTO dental_chart_entries
           (company_id, customer_id, entry_type, content, created_by)
         VALUES ($1, $2, 'evolucao_voz', $3, $4)
         RETURNING id, created_at`,
        [companyId, patient_id, structured, userId]
      ).catch(() => ({ rows: [] }));
      savedEntry = rows[0] || null;
    }

    res.json({
      raw_text,
      structured,
      saved: !!savedEntry,
      entry_id: savedEntry?.id || null,
      usage: rate.allowed ? { used: (rate.used || 0) + 1, limit: rate.limit } : null,
    });
  } catch (err) {
    console.error('[TRANSCRIBE/TEXT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /dental/transcribe/audio
// Body: { audio_base64: string, mime_type: string, patient_name?: string, patient_id?: string, save?: boolean }
// Whisper → texto → Claude estrutura (requer OPENAI_API_KEY)
// ─────────────────────────────────────────────────────────────
router.post('/audio', async (req, res) => {
  const { companyId, userId, user } = req;
  const plan = user?.plan || 'essencial';
  const { audio_base64, mime_type, patient_name, patient_id, save } = req.body;

  if (!audio_base64) {
    return res.status(400).json({ error: 'audio_base64 obrigatório' });
  }

  // Rate limit
  const rate = await checkRateLimit(companyId, plan);
  if (!rate.allowed) {
    return res.status(429).json({
      error: `Limite mensal de transcrições atingido (${rate.limit}/mês no plano Negócio).`,
      used: rate.used, limit: rate.limit,
    });
  }

  try {
    // Etapa 1: Whisper transcribe
    const rawTranscription = await transcribeWithWhisper(
      audio_base64,
      mime_type || 'audio/m4a'
    );

    if (!rawTranscription || rawTranscription.length < 3) {
      return res.status(422).json({ error: 'Não foi possível transcrever o áudio. Tente falar mais claramente.' });
    }

    // Etapa 2: Claude estrutura
    const { structured, inputTokens } = await structureWithClaude(rawTranscription, patient_name);
    await logUsage(companyId, userId, inputTokens);

    // Salva no prontuário se solicitado
    let savedEntry = null;
    if (save && patient_id) {
      const { rows } = await db.query(
        `INSERT INTO dental_chart_entries
           (company_id, customer_id, entry_type, content, created_by)
         VALUES ($1, $2, 'evolucao_voz', $3, $4)
         RETURNING id, created_at`,
        [companyId, patient_id, structured, userId]
      ).catch(() => ({ rows: [] }));
      savedEntry = rows[0] || null;
    }

    res.json({
      raw_transcription: rawTranscription,
      structured,
      saved: !!savedEntry,
      entry_id: savedEntry?.id || null,
      usage: rate.allowed ? { used: (rate.used || 0) + 1, limit: rate.limit } : null,
    });
  } catch (err) {
    console.error('[TRANSCRIBE/AUDIO]', err.message);
    // Erro específico de OPENAI_API_KEY não configurada → mensagem clara
    if (err.message.includes('OPENAI_API_KEY')) {
      return res.status(503).json({
        error: err.message,
        fallback: 'Use /dental/transcribe/text com texto digitado ou reconhecido pelo teclado.',
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /dental/transcribe/usage
// Retorna uso mensal do plano
// ─────────────────────────────────────────────────────────────
router.get('/usage', async (req, res) => {
  const { companyId, user } = req;
  const plan = user?.plan || 'essencial';

  if (plan === 'expansao') {
    return res.json({ plan, unlimited: true, used: null, limit: null });
  }

  const rate = await checkRateLimit(companyId, plan);
  res.json({
    plan,
    unlimited: false,
    used:      rate.used,
    limit:     rate.limit,
    remaining: Math.max(0, rate.limit - rate.used),
  });
});

module.exports = router;
