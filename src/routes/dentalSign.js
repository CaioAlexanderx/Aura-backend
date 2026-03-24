// ============================================================
// AURA. — Pad de Assinatura Digital (BE-25-10)
// Rotas públicas — sem autenticacao JWT (token é a auth)
// ============================================================

const express = require('express');
const router  = express.Router();
const { validateWsToken } = require('../services/dental');
const { getSessionStatus } = require('../services/dentalWs');

router.get('/sign/:token/pad', async (req, res) => {
  const { token } = req.params;
  let session;
  try { session = await validateWsToken(token); }
  catch (err) { return res.status(500).send('<p>Erro ao validar link.</p>'); }

  if (!session) {
    return res.status(410).send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expirado</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}.box{text-align:center;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);}h2{color:#e74c3c}p{color:#666}</style></head><body><div class="box"><h2>Link expirado</h2><p>Este link de assinatura expirou ou já foi utilizado.</p><p>Solicite um novo link ao seu dentista.</p></div></body></html>`);
  }

  const host    = req.headers.host || 'localhost';
  const wsProto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const wsUrl   = `${wsProto}://${host}/ws/sign/${token}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>Assinatura Digital — Aura.</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f0f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1rem}
    .card{background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.12);width:100%;max-width:440px;overflow:hidden}
    .header{background:linear-gradient(135deg,#6d28d9,#a855f7);color:#fff;padding:1.25rem 1.5rem}
    .header h1{font-size:1.1rem;font-weight:600}
    .header p{font-size:.85rem;opacity:.85;margin-top:.25rem}
    .body{padding:1.25rem 1.5rem}
    .lgpd{background:#f8f4ff;border:1px solid #e9d8fd;border-radius:8px;padding:.875rem;margin-bottom:1rem;font-size:.8rem;color:#5b21b6;line-height:1.5}
    .lgpd label{display:flex;gap:.5rem;align-items:flex-start;cursor:pointer}
    .lgpd input[type=checkbox]{margin-top:2px;flex-shrink:0;accent-color:#6d28d9}
    .canvas-wrap{position:relative;border:2px solid #d1d5db;border-radius:10px;background:#fafafa;overflow:hidden;margin:1rem 0;touch-action:none}
    canvas{display:block;width:100%;cursor:crosshair}
    .canvas-label{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#9ca3af;font-size:.875rem;pointer-events:none;text-align:center;line-height:1.4}
    .actions{display:flex;gap:.75rem;margin-top:.5rem}
    .btn{flex:1;padding:.75rem;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s}
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
<div class="card">
  <div class="header"><h1>Assinatura Digital</h1><p>Confirme o atendimento com sua assinatura</p></div>
  <div class="body">
    <div class="lgpd">
      <label><input type="checkbox" id="consent"><span>Declaro que li e concordo com o registro digital desta consulta, incluindo os procedimentos realizados. Esta assinatura tem validade como consentimento clínico (Lei 13.709/2018 — LGPD Art. 11).</span></label>
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
  ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.type==='signature_received'){setStatus('ok','✓ Assinatura registrada! Obrigado.');btnClear.disabled=true;}else if(msg.type==='error'){setStatus('err','Erro: '+msg.message);btnSign.disabled=false;btnClear.disabled=false;}};
  ws.onerror=()=>{setStatus('err','Erro de conexão. Tente novamente.');btnSign.disabled=false;btnClear.disabled=false;};
});
function setStatus(type,msg){status.className='status '+type;status.textContent=msg;}
</script>
</body></html>`);
});

router.get('/sign/:token/status', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows } = await require('../config/database').query(
      `SELECT t.used_at, a.conclusion_signed, a.conclusion_at
       FROM dental_ws_tokens t JOIN dental_appointments a ON a.id=t.appointment_id
       WHERE t.token=$1`, [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Token não encontrado' });
    const row = rows[0];
    const sessionStatus = getSessionStatus(token);
    res.json({
      token, signed: !!row.conclusion_signed, conclusion_at: row.conclusion_at,
      patient_connected: sessionStatus.connected,
      status: row.conclusion_signed ? 'signed' : sessionStatus.connected ? 'patient_connected' : 'waiting',
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao verificar status' }); }
});

module.exports = router;
