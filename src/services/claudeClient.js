// ============================================================
// AURA. — claudeClient.js
// Helper compartilhado pra chamadas ao Anthropic Messages API.
// Antes a logica estava duplicada em aiChat.js + dentalTranscription.js
// (mesmo fetch + headers + tratamento de erro). Centralizar aqui:
//   - facilita trocar modelo (haiku/sonnet) num lugar so
//   - expoe suporte a PDF (content blocks de tipo 'document') que era
//     pre-requisito do fluxo de DANFE
//   - padroniza parse de JSON quando o prompt pede output estruturado
// ============================================================

const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch
  : require('node-fetch');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Modelo default — Sonnet 4 (mesmo usado em aiChat e dentalTranscription).
// Pode trocar pra Haiku 4.5 (mais barato/rapido) caso a tarefa nao precise
// do raciocinio do Sonnet — DANFE deve funcionar bem com Haiku.
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

function getApiKey() {
  const key = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('CLAUDE_API_KEY nao configurado no env');
  return key;
}

// Chamada generica ao Messages API. `messages` segue o formato Anthropic
// (array de { role, content } onde content pode ser string ou array de
// content blocks). Retorna o response.content[0].text quando ha texto.
async function callClaude({ messages, system, model, maxTokens, anthropicBeta }) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages obrigatorio (array nao vazio)');
  }
  const headers = {
    'x-api-key':         getApiKey(),
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type':      'application/json',
  };
  if (anthropicBeta) headers['anthropic-beta'] = anthropicBeta;

  const body = {
    model:      model || DEFAULT_MODEL,
    max_tokens: maxTokens || 1024,
    messages:   messages,
  };
  if (system) body.system = system;

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(`Claude API error ${resp.status}: ${errText.slice(0, 500)}`);
    err.status = resp.status;
    err.body = errText;
    throw err;
  }

  const data = await resp.json();
  // content e array de blocks. Pega o primeiro de tipo 'text'.
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return {
    raw:           data,
    text:          textBlock ? textBlock.text : '',
    inputTokens:   data.usage?.input_tokens || 0,
    outputTokens:  data.usage?.output_tokens || 0,
    stopReason:    data.stop_reason,
    model:         data.model,
  };
}

// Helper especializado pra PDF: monta o content block de document e
// dispara callClaude. PDF chega como base64 (sem prefixo data:application/pdf).
async function extractFromPdf({ pdfBase64, prompt, system, model, maxTokens, anthropicBeta }) {
  if (!pdfBase64) throw new Error('pdfBase64 obrigatorio');
  if (!prompt) throw new Error('prompt obrigatorio');

  // Limpa prefixo data:...;base64, se vier do frontend
  const cleanBase64 = pdfBase64.replace(/^data:[^;]+;base64,/, '');

  const messages = [{
    role: 'user',
    content: [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: cleanBase64,
        },
      },
      { type: 'text', text: prompt },
    ],
  }];

  return callClaude({
    messages,
    system,
    model: model || DEFAULT_MODEL,
    maxTokens: maxTokens || 4096,
    anthropicBeta,
  });
}

// Strip de markdown fences (```json ... ```) + JSON.parse.
// LLM frequentemente envolve respostas estruturadas em fences mesmo quando
// o prompt pede "JSON puro". Tolera os dois casos.
function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Resposta vazia do Claude');
  }
  let s = text.trim();
  // Remove fences ```json...``` ou ```...```
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Caso tenha texto antes/depois do JSON, tenta extrair do primeiro { ate o ultimo }
  if (s[0] !== '{' && s[0] !== '[') {
    const firstBrace = s.indexOf('{');
    const firstBracket = s.indexOf('[');
    let start = -1;
    if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) start = firstBrace;
    else if (firstBracket >= 0) start = firstBracket;
    if (start >= 0) {
      const lastBrace = s.lastIndexOf('}');
      const lastBracket = s.lastIndexOf(']');
      const end = Math.max(lastBrace, lastBracket);
      if (end > start) s = s.slice(start, end + 1);
    }
  }
  return JSON.parse(s);
}

module.exports = {
  DEFAULT_MODEL,
  callClaude,
  extractFromPdf,
  parseJsonResponse,
};
