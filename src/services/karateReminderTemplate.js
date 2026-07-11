// ============================================================
// AURA KARATÊ — Fase F4: render de template de e-mail de cobrança
// (karate_reminder_config.subject_template / body_template)
//
// Variáveis suportadas (texto editável pela federação):
//   {{nome}} {{competencia}} {{valor}} {{vencimento}} {{planos}} {{pix_copia_cola}}
//
// Substituição SIMPLES e SEGURA: todo valor injetado passa por escapeHtml
// antes de entrar no corpo do e-mail (o corpo é HTML) — nunca interpolar
// texto do operador/variável sem escape (XSS/quebra de layout).
//
// Variável desconhecida (fora da lista acima) usada no template → quem
// chama render()/findUnknownVars() decide o que fazer; a rota PUT
// reminder-config usa findUnknownVars para devolver 422 antes de salvar.
//
// Os blocos de "modalidades" (planos vigentes) e "PIX copia-e-cola"
// também são disponibilizados como variáveis de texto simples aqui
// ({{planos}}, {{pix_copia_cola}}), mas o mailer (karateBillingMailer.js)
// SEMPRE adiciona, além disso, um bloco HTML estruturado equivalente,
// fora do texto editável (ver cabeçalho de karateBillingMailer.js) — a
// federação não precisa referenciar a variável no texto para o dojô/
// praticante ver os planos e o PIX.
// ============================================================
'use strict';

const KNOWN_VARS = ['nome', 'competencia', 'valor', 'vencimento', 'planos', 'pix_copia_cola'];

// Regex literal comum (fora de template literal) — 1 backslash por escape
// basta. Testado com node -e antes de commitar (armadilha #8 do CLAUDE.md).
const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const DEFAULT_SUBJECT_TEMPLATE = 'Lembrete: anuidade {{competencia}} — {{valor}}';
const DEFAULT_BODY_TEMPLATE =
  'Olá, {{nome}}!\n\n' +
  'A anuidade referente a {{competencia}}, no valor de {{valor}}, vence em {{vencimento}}.\n\n' +
  'Para manter o cadastro em dia junto à federação, realize o pagamento e registre o comprovante assim que possível.';

// Escapa caracteres HTML perigosos — SEMPRE aplicado a todo valor injetado.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Retorna a lista (sem duplicatas, na ordem de 1ª ocorrência) de variáveis
// {{x}} usadas no template que NÃO pertencem a KNOWN_VARS. Vazio = OK.
function findUnknownVars(template) {
  const found = [];
  const seen = new Set();
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(String(template || ''))) !== null) {
    const name = m[1];
    if (!KNOWN_VARS.includes(name) && !seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

// Substitui {{var}} pelo valor de vars[var], sempre escapado (HTML). Uma
// variável conhecida ausente em `vars` vira string vazia (nunca quebra o
// render). Variável desconhecida é preservada literalmente (defensivo —
// quem grava o template já validou com findUnknownVars antes).
function renderTemplate(template, vars) {
  const v = vars || {};
  VAR_RE.lastIndex = 0;
  return String(template || '').replace(VAR_RE, (full, name) => {
    if (!KNOWN_VARS.includes(name)) return full;
    const raw = Object.prototype.hasOwnProperty.call(v, name) ? v[name] : '';
    return escapeHtml(raw);
  });
}

// Converte texto plano (com \n) já renderizado (escapado) em HTML de
// parágrafos simples — usado para o body_template (texto puro editável).
function textToHtmlParagraphs(text) {
  const parts = String(text || '').split(/\n{2,}/);
  return parts
    .map((p) => `<p style="margin:0 0 14px;font-size:14px;color:#44403c;line-height:22px;">${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

module.exports = {
  KNOWN_VARS,
  DEFAULT_SUBJECT_TEMPLATE,
  DEFAULT_BODY_TEMPLATE,
  escapeHtml,
  findUnknownVars,
  renderTemplate,
  textToHtmlParagraphs,
};
