// ============================================================
// AURA. — Bipe sintético: quando avisar (13/10/2026)
//
// Regras:
//   - duas execuções seguidas falhando → e-mail "caiu" (um falso positivo
//     isolado — blip de rede, deploy — não acorda ninguém);
//   - enquanto continua caído, um lembrete a cada 30 min, nunca a cada 5;
//   - a primeira execução ok depois de uma queda AVISADA → e-mail "voltou".
//     Queda curta que nunca chegou a avisar não manda "voltou" solto;
//   - o painel (painel_alertas, tipo plataforma_caida) fica de pé enquanto
//     durar a queda — o job regrava a cada execução e apaga na recuperação.
//
// O estado do "já avisei" mora em canary_runs.alerta, não na memória: vale
// entre instâncias e sobrevive a deploy. Só é gravado DEPOIS do e-mail sair —
// se o envio falhar, a próxima execução tenta de novo.
//
// WhatsApp: ainda não existe canal na API. Quando existir, entra como mais
// um item de `canais` em avisar(); a decisão acima não muda.
// ============================================================
'use strict';

const REPETICAO_MIN = 30;
const FALHAS_PARA_ALERTAR = 2;
const TIPO_PAINEL = 'plataforma_caida';
const CHAVE_PAINEL = 'canary';
const AVISOS_DE_QUEDA = ['caiu', 'repeticao'];

const destinatario = (env = process.env) => String(env.ALERTA_EMAIL || '').trim() || 'contato@getaura.com.br';

// Pura. `runs`: execuções terminadas, da mais nova (a que acabou de rodar)
// para a mais antiga. → { tipo: 'caiu'|'repeticao'|'voltou', seguidas } | null
function decidir(runs, agora = new Date()) {
  const atual = runs[0];
  if (!atual) return null;

  if (!atual.ok) {
    let seguidas = 0;
    for (const r of runs) { if (r.ok) break; seguidas++; }
    if (seguidas < FALHAS_PARA_ALERTAR) return null;
    const aviso = runs.slice(0, seguidas).find((r) => AVISOS_DE_QUEDA.includes(r.alerta));
    if (!aviso) return { tipo: 'caiu', seguidas };
    const faz = agora.getTime() - new Date(aviso.started_at).getTime();
    if (faz >= REPETICAO_MIN * 60000) return { tipo: 'repeticao', seguidas };
    return null;
  }

  let n = 0;
  for (const r of runs.slice(1)) { if (r.ok) break; n++; }
  if (n >= 1 && runs.slice(1, 1 + n).some((r) => AVISOS_DE_QUEDA.includes(r.alerta))) {
    return { tipo: 'voltou', seguidas: n };
  }
  return null;
}

const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : `${Number(ms).toLocaleString('pt-BR')} ms`);

function quando(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// { subject, text, html } — `escapar` é o escapeHtml do mailer.
function montarEmail({ tipo, runs, seguidas }, escapar = (s) => String(s)) {
  const atual = runs[0];
  const passos = Array.isArray(atual.passos) ? atual.passos : [];
  const falho = passos.find((p) => p && p.ok === false);
  const primeira = runs[seguidas - 1];
  const desde = tipo === 'voltou' ? runs[seguidas] : primeira;
  const linhasPassos = passos.map((p) => `${p.ok ? 'ok   ' : 'FALHA'} ${p.passo} — ${fmtMs(p.ms)}${p.erro ? ` — ${p.erro}` : ''}`);

  let subject;
  let abertura;
  if (tipo === 'voltou') {
    const min = Math.max(1, Math.round((new Date(atual.started_at) - new Date(desde.started_at)) / 60000));
    subject = 'Aura voltou: o bipe sintético está passando';
    abertura = `O Caixa respondeu de novo às ${quando(atual.started_at)}. Ficou ${seguidas} execuções seguidas falhando (cerca de ${min} min desde ${quando(desde.started_at)}).`;
  } else if (tipo === 'repeticao') {
    subject = `Aura segue fora: bipe sintético falhando no passo "${falho ? falho.passo : '?'}"`;
    abertura = `Continua falhando desde ${quando(desde.started_at)} (${seguidas} execuções seguidas). Novo aviso a cada ${REPETICAO_MIN} min.`;
  } else {
    subject = `Aura fora do ar: bipe sintético falhou no passo "${falho ? falho.passo : '?'}"`;
    abertura = `${seguidas} execuções seguidas falharam, desde ${quando(desde.started_at)}. O /health pode estar verde — este teste é o caminho da venda.`;
  }

  const erro = atual.erro || (falho && falho.erro) || null;
  const text = [
    abertura, '',
    ...(tipo === 'voltou' ? [] : [
      `Passo que falhou: ${falho ? falho.passo : '—'}`,
      `Erro: ${erro || '—'}`,
      `Latência do passo: ${falho ? fmtMs(falho.ms) : '—'}`,
      '',
    ]),
    'Última execução:', ...linhasPassos, '',
    `Duração total: ${fmtMs(atual.duracao_ms)}`,
  ].join('\n');

  const html = `<h2 style="color:${tipo === 'voltou' ? '#34d399' : '#f87171'};margin:0 0 10px;font-size:20px;">${escapar(subject)}</h2>`
    + `<p style="color:#8a8aa0;font-size:14px;line-height:1.5;margin:0 0 16px;">${escapar(abertura)}</p>`
    + (tipo === 'voltou' ? '' : `<p style="color:#fff;font-size:14px;margin:0 0 4px;"><b>Passo:</b> ${escapar(falho ? falho.passo : '—')} · <b>Latência:</b> ${escapar(falho ? fmtMs(falho.ms) : '—')}</p>`
      + `<p style="color:#fff;font-size:14px;margin:0 0 16px;"><b>Erro:</b> ${escapar(erro || '—')}</p>`)
    + `<pre style="color:#c9c9d6;font-size:12px;background:#15151f;padding:12px;border-radius:8px;white-space:pre-wrap;">${escapar(linhasPassos.join('\n'))}</pre>`;

  return { subject, text, html };
}

// Envia pelo mailer e devolve o tipo avisado. Lança se o envio falhar (quem
// chama não grava `alerta`, e a próxima execução tenta de novo).
async function avisar({ decisao, runs, mailer, env = process.env }) {
  const m = mailer || require('./mailer');
  const { subject, text, html } = montarEmail({ ...decisao, runs }, m.escapeHtml);
  const corpo = m.emailLayout ? m.emailLayout(html) : html;
  await m.sendMail({ to: destinatario(env), subject, text, html: corpo });
  return decisao.tipo;
}

// ── painel_alertas ──────────────────────────────────────────────
async function gravarNoPainel(db, { dia, alerta }) {
  await db.query(
    `INSERT INTO painel_alertas (dia, tipo, chave, company_id, titulo, detalhe, verbo, bloco)
     VALUES ($1::date, $2, $3, NULL, $4, $5, $6, $7)
     ON CONFLICT (dia, tipo, chave) DO UPDATE SET
       titulo = EXCLUDED.titulo, detalhe = EXCLUDED.detalhe,
       verbo = EXCLUDED.verbo, bloco = EXCLUDED.bloco`,
    [dia, TIPO_PAINEL, CHAVE_PAINEL, alerta.titulo, alerta.detalhe, alerta.verbo, alerta.bloco]
  );
}

async function limparDoPainel(db, { dia }) {
  await db.query(
    `DELETE FROM painel_alertas WHERE dia = $1::date AND tipo = $2 AND chave = $3`,
    [dia, TIPO_PAINEL, CHAVE_PAINEL]
  );
}

module.exports = {
  REPETICAO_MIN, FALHAS_PARA_ALERTAR, TIPO_PAINEL, CHAVE_PAINEL, AVISOS_DE_QUEDA,
  destinatario, decidir, montarEmail, avisar, gravarNoPainel, limparDoPainel,
};
