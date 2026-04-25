// ============================================================
// AURA. — W2-04: Pagina publica de assinatura de TCLE
//
// Rotas (publicas, sem auth, token e a auth):
//   GET /dental/consent/sign/:token/pad     pagina HTML de assinatura
//   GET /dental/consent/sign/:token/status  status pra polling do admin
//
// Visual: copia padrao do dentalSign.js (W1-04) com pequenas mudancas:
//   - Renderiza o markdown do TCLE no card antes do canvas
//   - Texto LGPD especifico de TCLE (consentimento de procedimento)
//   - WS endpoint /ws/consent/:token (nao /ws/sign/:token)
//
// O paciente:
//   1. Le o TCLE renderizado em HTML (parser leve de markdown)
//   2. Marca consent LGPD
//   3. Assina no canvas
//   4. Clica Confirmar -> WS envia PNG
// ============================================================

const router = require('express').Router();
const db = require('../config/database');
const { validateConsentToken, getConsentSessionStatus } = require('../services/dentalConsentWs');

// ──────────────────────────────────────────────────────────
// Markdown parser leve, server-side
// Apenas as features que usamos nos templates: # ## ### **bold**, - lists, paragrafos
// ──────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(md) {
  if (!md) return '';

  const lines = md.split(/\r?\n/);
  const out = [];
  let inList = false;
  let paraBuf = [];

  function flushPara() {
    if (paraBuf.length) {
      let text = paraBuf.join(' ').trim();
      if (text) {
        // **bold**
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        out.push(`<p>${text}</p>`);
      }
      paraBuf = [];
    }
  }

  function closeList() {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  }

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      flushPara();
      closeList();
      continue;
    }

    // Headers
    let m;
    if ((m = /^#\s+(.+)$/.exec(line))) {
      flushPara();
      closeList();
      out.push(`<h2>${escapeHtml(m[1])}</h2>`);
      continue;
    }
    if ((m = /^##\s+(.+)$/.exec(line))) {
      flushPara();
      closeList();
      out.push(`<h3>${escapeHtml(m[1])}</h3>`);
      continue;
    }
    if ((m = /^###\s+(.+)$/.exec(line))) {
      flushPara();
      closeList();
      out.push(`<h4>${escapeHtml(m[1])}</h4>`);
      continue;
    }

    // Lista
    if ((m = /^-\s+(.+)$/.exec(line))) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      let item = escapeHtml(m[1]);
      item = item.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out.push(`<li>${item}</li>`);
      continue;
    }

    // Paragrafo
    closeList();
    paraBuf.push(escapeHtml(line));
  }

  flushPara();
  closeList();

  return out.join('\n');
}

// ──────────────────────────────────────────────────────────
// GET /dental/consent/sign/:token/pad
// ──────────────────────────────────────────────────────────

router.get('/sign/:token/pad', async (req, res) => {
  const { token } = req.params;

  let session;
  try {
    session = await validateConsentToken(token);
  } catch (err) {
    return res.status(500).send('<p>Erro ao validar link.</p>');
  }

  if (!session) {
    return res.status(410).send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expirado</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;padding:1rem;}.box{text-align:center;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:420px;}h2{color:#e74c3c;margin-bottom:.5rem}p{color:#666;line-height:1.5}</style></head><body><div class="box"><h2>Link expirado</h2><p>Este link expirou ou ja foi utilizado.</p><p>Solicite um novo link ao seu dentista.</p></div></body></html>`);
  }

  // Carrega o documento completo (rendered_md)
  const { rows } = await db.query(
    `SELECT d.title, d.rendered_md, c.name AS clinic_name
     FROM dental_consent_documents d
     LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.id = $1`,
    [session.id]
  );

  if (!rows.length) {
    return res.status(404).send('<p>Documento nao encontrado.</p>');
  }

  const doc = rows[0];
  const renderedHtml = renderMarkdown(doc.rendered_md);

  const host = req.headers.host || 'localhost';
  const wsProto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${host}/ws/consent/${token}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>${escapeHtml(doc.title)} — Aura.</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f0f5;min-height:100vh;padding:1rem}
    .container{max-width:520px;margin:0 auto}
    .card{background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.12);overflow:hidden;margin-bottom:1rem}
    .header{background:linear-gradient(135deg,#6d28d9,#a855f7);color:#fff;padding:1.25rem 1.5rem}
    .header h1{font-size:1.05rem;font-weight:600}
    .header p{font-size:.8rem;opacity:.85;margin-top:.25rem}
    .body{padding:1.25rem 1.5rem}
    .doc-content{font-size:.875rem;line-height:1.6;color:#1f2937;max-height:340px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:10px;padding:1rem;background:#fafafa;margin-bottom:1rem}
    .doc-content h2{font-size:1.05rem;color:#6d28d9;margin-top:0;margin-bottom:.75rem}
    .doc-content h3{font-size:.95rem;color:#374151;margin-top:1rem;margin-bottom:.5rem;font-weight:600}
    .doc-content h4{font-size:.875rem;color:#4b5563;margin-top:.75rem;margin-bottom:.25rem;font-weight:600}
    .doc-content p{margin-bottom:.75rem}
    .doc-content ul{padding-left:1.25rem;margin-bottom:.75rem}
    .doc-content li{margin-bottom:.25rem}
    .doc-content strong{color:#1f2937;font-weight:600}
    .scroll-hint{font-size:.75rem;color:#9ca3af;text-align:center;font-style:italic;margin-bottom:.5rem}
    .lgpd{background:#f8f4ff;border:1px solid #e9d8fd;border-radius:8px;padding:.875rem;margin-bottom:1rem;font-size:.8rem;color:#5b21b6;line-height:1.5}
    .lgpd label{display:flex;gap:.5rem;align-items:flex-start;cursor:pointer}
    .lgpd input[type=checkbox]{margin-top:2px;flex-shrink:0;accent-color:#6d28d9;width:16px;height:16px}
    .canvas-wrap{position:relative;border:2px solid #d1d5db;border-radius:10px;background:#fafafa;overflow:hidden;margin:1rem 0;touch-action:none}
    canvas{display:block;width:100%;cursor:crosshair}
    .canvas-label{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#9ca3af;font-size:.875rem;pointer-events:none;text-align:center;line-height:1.4}
    .actions{display:flex;gap:.75rem}
    .btn{flex:1;padding:.875rem;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s}
    .btn-clear{background:#f3f4f6;color:#374151}
    .btn-sign{background:#6d28d9;color:#fff}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .status{margin-top:1rem;padding:.75rem;border-radius:8px;font-size:.85rem;text-align:center;display:none}
    .status.ok{background:#f0fdf4;color:#166534;display:block}
    .status.err{background:#fef2f2;color:#991b1b;display:block}
    .status.loading{background:#f0f4ff;color:#1e40af;display:block}
  </style>
</head>
<body>
<div class="container">
  <div class="card">
    <div class="header">
      <h1>${escapeHtml(doc.title)}</h1>
      <p>${escapeHtml(doc.clinic_name || 'Clinica Odontologica')}</p>
    </div>
    <div class="body">
      <p class="scroll-hint">Leia o termo abaixo. Role ate o final.</p>
      <div class="doc-content" id="docContent">
        ${renderedHtml}
      </div>
      <div class="lgpd">
        <label>
          <input type="checkbox" id="consent">
          <span>Declaro que li e compreendi este Termo de Consentimento. Concordo com o registro digital da minha assinatura como manifestacao livre e esclarecida (Lei 13.709/2018 — LGPD Art. 11).</span>
        </label>
      </div>
      <div class="canvas-wrap" id="canvasWrap">
        <canvas id="signCanvas" height="180"></canvas>
        <div class="canvas-label" id="canvasLabel">Assine aqui com o dedo</div>
      </div>
      <div class="actions">
        <button class="btn btn-clear" id="btnClear">Limpar</button>
        <button class="btn btn-sign" id="btnSign" disabled>Confirmar</button>
      </div>
      <div class="status" id="status"></div>
    </div>
  </div>
</div>
<script>
const WS_URL='${wsUrl}';
const canvas=document.getElementById('signCanvas');
const ctx=canvas.getContext('2d');
const label=document.getElementById('canvasLabel');
const consent=document.getElementById('consent');
const btnSign=document.getElementById('btnSign');
const btnClear=document.getElementById('btnClear');
const status=document.getElementById('status');
let drawing=false,hasSig=false,ws=null;
function resizeCanvas(){const w=document.getElementById('canvasWrap');canvas.width=w.offsetWidth;ctx.strokeStyle='#1e1e2e';ctx.lineWidth=2.5;ctx.lineCap='round';ctx.lineJoin='round';}
resizeCanvas();
window.addEventListener('resize',resizeCanvas);
function getPos(e){const r=canvas.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:(t.clientX-r.left)*(canvas.width/r.width),y:(t.clientY-r.top)*(canvas.height/r.height)};}
canvas.addEventListener('mousedown',e=>{drawing=true;ctx.beginPath();const p=getPos(e);ctx.moveTo(p.x,p.y);});
canvas.addEventListener('mousemove',e=>{if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();showSig();});
canvas.addEventListener('mouseup',()=>drawing=false);
canvas.addEventListener('touchstart',e=>{e.preventDefault();drawing=true;ctx.beginPath();const p=getPos(e);ctx.moveTo(p.x,p.y);},{passive:false});
canvas.addEventListener('touchmove',e=>{e.preventDefault();if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();showSig();},{passive:false});
canvas.addEventListener('touchend',()=>drawing=false);
function showSig(){hasSig=true;label.style.display='none';updateBtn();}
function updateBtn(){btnSign.disabled=!(hasSig&&consent.checked);}
consent.addEventListener('change',updateBtn);
btnClear.addEventListener('click',()=>{ctx.clearRect(0,0,canvas.width,canvas.height);hasSig=false;label.style.display='block';updateBtn();});
btnSign.addEventListener('click',()=>{
  if(!hasSig||!consent.checked)return;
  setStatus('loading','Enviando assinatura...');
  btnSign.disabled=true;btnClear.disabled=true;
  const sigData=canvas.toDataURL('image/png');
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>ws.send(JSON.stringify({type:'signature',signature_data:sigData}));
  ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.type==='signature_received'){setStatus('ok','\u2713 Assinatura registrada! Obrigado.');btnClear.disabled=true;}else if(msg.type==='error'){setStatus('err','Erro: '+msg.message);btnSign.disabled=false;btnClear.disabled=false;}};
  ws.onerror=()=>{setStatus('err','Erro de conexao. Tente novamente.');btnSign.disabled=false;btnClear.disabled=false;};
});
function setStatus(type,msg){status.className='status '+type;status.textContent=msg;}
</script>
</body></html>`);
});

// ──────────────────────────────────────────────────────────
// GET /dental/consent/sign/:token/status — polling do admin
// ──────────────────────────────────────────────────────────

router.get('/sign/:token/status', async (req, res) => {
  const { token } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT id, status, signed_at, token_expires_at
       FROM dental_consent_documents
       WHERE token = $1`,
      [token]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Token nao encontrado' });
    }

    const doc = rows[0];
    const sessionStatus = getConsentSessionStatus(token);
    const isSigned = doc.status === 'signed';
    const isExpired = doc.status === 'expired'
      || (doc.status === 'pending' && new Date(doc.token_expires_at) < new Date());
    const isVoid = doc.status === 'void';

    res.json({
      token,
      document_id: doc.id,
      signed: isSigned,
      signed_at: doc.signed_at,
      patient_connected: !!sessionStatus?.connected,
      status: isSigned
        ? 'signed'
        : isVoid
          ? 'void'
          : isExpired
            ? 'expired'
            : sessionStatus?.connected
              ? 'patient_connected'
              : 'waiting',
    });
  } catch (err) {
    console.error('[consent status]', err.message);
    res.status(500).json({ error: 'Erro ao verificar status' });
  }
});

module.exports = router;
