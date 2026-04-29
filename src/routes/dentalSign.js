// ============================================================
// AURA. — Pad de Assinatura Digital (BE-25-10)
// Rotas públicas — sem autenticacao JWT (token é a auth)
//
// PR44 #8 (2026-04-29): UAT bug
//  - canvas com width=0 em mobile (resizeCanvas rodava antes do paint).
//    Fix: rodar tambem em window.load + resize listener + fallback width.
//  - Mostrar procedimentos da consulta acima do pad pro paciente
//    visualizar antes de assinar (LGPD-compliant + transparencia).
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
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

  // PR44 #8: buscar procedimentos da consulta + paciente pra exibir no pad
  let appointmentInfo = null;
  let procedures = [];
  try {
    const { rows: aptRows } = await db.query(
      `SELECT a.id, a.scheduled_at, a.duration_min, a.chief_complaint, a.clinical_notes,
              c.name AS patient_name,
              comp.trade_name AS company_name,
              pr.name AS practitioner_name
       FROM dental_appointments a
       JOIN customers c ON c.id = a.customer_id
       JOIN companies comp ON comp.id = a.company_id
       LEFT JOIN dental_practitioners pr ON pr.id = a.practitioner_id
       WHERE a.id = $1
       LIMIT 1`,
      [session.appointment_id]
    );
    appointmentInfo = aptRows[0] || null;

    const { rows: procRows } = await db.query(
      `SELECT id, name, quantity, unit_price, COALESCE(total, quantity * unit_price) AS total, tooth_number, face
       FROM dental_appointment_procedures
       WHERE appointment_id = $1
       ORDER BY created_at`,
      [session.appointment_id]
    );
    procedures = procRows || [];
  } catch (err) {
    // se falhar, segue sem lista (degradacao graceful)
    console.error('[dentalSign /pad] erro buscando appointment:', err.message);
  }

  const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };

  const proceduresHtml = procedures.length > 0
    ? `<div class="procs">
        <h3>Procedimentos realizados</h3>
        <ul>
          ${procedures.map(p => `<li>
            <span class="proc-name">${(p.name || 'Procedimento').replace(/</g, '&lt;')}${p.tooth_number ? ` <small class="tooth">· dente ${p.tooth_number}${p.face ? ' (' + p.face + ')' : ''}</small>` : ''}</span>
            ${p.quantity > 1 ? `<small class="qty">${p.quantity}×</small>` : ''}
            <span class="price">${fmtBRL(p.total)}</span>
          </li>`).join('')}
        </ul>
        <div class="total-row">
          <span>Total</span>
          <strong>${fmtBRL(procedures.reduce((s, p) => s + parseFloat(p.total || 0), 0))}</strong>
        </div>
      </div>`
    : '';

  const headerSubtitle = appointmentInfo
    ? `${appointmentInfo.patient_name || 'Paciente'}${appointmentInfo.practitioner_name ? ' · Dr(a). ' + appointmentInfo.practitioner_name : ''}${appointmentInfo.scheduled_at ? ' · ' + fmtDate(appointmentInfo.scheduled_at) : ''}`
    : 'Confirme o atendimento com sua assinatura';

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
    .card{background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.12);width:100%;max-width:480px;overflow:hidden}
    .header{background:linear-gradient(135deg,#06B6D4,#7c3aed);color:#fff;padding:1.25rem 1.5rem}
    .header h1{font-size:1.1rem;font-weight:600}
    .header p{font-size:.85rem;opacity:.9;margin-top:.25rem;line-height:1.4}
    .body{padding:1.25rem 1.5rem}
    .procs{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:1rem}
    .procs h3{font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:.6rem;font-weight:700}
    .procs ul{list-style:none}
    .procs li{display:flex;align-items:center;gap:.6rem;padding:.45rem 0;border-bottom:1px solid #e2e8f0;font-size:.85rem;color:#1e293b}
    .procs li:last-child{border-bottom:none}
    .proc-name{flex:1}
    .proc-name .tooth{color:#94a3b8;font-size:.72rem;font-weight:500}
    .qty{color:#94a3b8;font-size:.78rem;background:#fff;padding:1px 6px;border-radius:4px;border:1px solid #e2e8f0}
    .price{font-weight:600;color:#06B6D4;font-variant-numeric:tabular-nums}
    .total-row{display:flex;justify-content:space-between;padding-top:.7rem;margin-top:.5rem;border-top:2px solid #e2e8f0;font-size:.95rem}
    .total-row strong{color:#7c3aed;font-weight:700}
    .lgpd{background:#f8f4ff;border:1px solid #e9d8fd;border-radius:8px;padding:.875rem;margin-bottom:1rem;font-size:.78rem;color:#5b21b6;line-height:1.5}
    .lgpd label{display:flex;gap:.5rem;align-items:flex-start;cursor:pointer}
    .lgpd input[type=checkbox]{margin-top:2px;flex-shrink:0;accent-color:#7c3aed;width:18px;height:18px}
    .canvas-wrap{position:relative;border:2px solid #d1d5db;border-radius:10px;background:#fafafa;overflow:hidden;margin:1rem 0;touch-action:none;height:200px}
    canvas{display:block;width:100%;height:100%;cursor:crosshair;background:#fafafa}
    .canvas-label{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#9ca3af;font-size:.875rem;pointer-events:none;text-align:center;line-height:1.4}
    .actions{display:flex;gap:.75rem;margin-top:.5rem}
    .btn{flex:1;padding:.85rem;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s}
    .btn:active{transform:scale(.98)}
    .btn-clear{background:#f3f4f6;color:#374151}
    .btn-sign{background:linear-gradient(135deg,#06B6D4,#7c3aed);color:#fff}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .status{margin-top:1rem;padding:.75rem;border-radius:8px;font-size:.85rem;text-align:center;display:none}
    .status.ok{background:#f0fdf4;color:#166534;display:block;font-weight:600}
    .status.err{background:#fef2f2;color:#991b1b;display:block}
    .status.loading{background:#f0f4ff;color:#1e40af;display:block}
  </style>
</head>
<body>
<div class="card">
  <div class="header"><h1>Assinatura Digital</h1><p>${headerSubtitle.replace(/</g, '&lt;')}</p></div>
  <div class="body">
    ${proceduresHtml}
    <div class="lgpd">
      <label><input type="checkbox" id="consent"><span>Declaro que li os procedimentos acima e concordo com o registro digital deste atendimento. Esta assinatura tem validade como consentimento clínico (Lei 13.709/2018 — LGPD Art. 11).</span></label>
    </div>
    <div class="canvas-wrap" id="canvasWrap">
      <canvas id="signCanvas"></canvas>
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
const wrap=document.getElementById('canvasWrap');
const ctx=canvas.getContext('2d');
const label=document.getElementById('canvasLabel');
const consent=document.getElementById('consent');
const btnSign=document.getElementById('btnSign');
const btnClear=document.getElementById('btnClear');
const status=document.getElementById('status');
let drawing=false,hasSig=false,ws=null;

// PR44 #8: resize robusto. Pega DPR pra alta resolucao em retina.
function resizeCanvas(){
  const dpr=window.devicePixelRatio||1;
  const w=wrap.offsetWidth||380;
  const h=wrap.offsetHeight||200;
  canvas.width=w*dpr;
  canvas.height=h*dpr;
  canvas.style.width=w+'px';
  canvas.style.height=h+'px';
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr,dpr);
  ctx.strokeStyle='#1e1e2e';
  ctx.lineWidth=2.5;
  ctx.lineCap='round';
  ctx.lineJoin='round';
  // se ja tinha assinatura, ela some no resize — limpar estado
  if(hasSig){hasSig=false;label.style.display='block';updateBtn();}
}
// rodar tanto agora (caso layout ja esteja pronto) quanto em load (mobile lazy paint)
resizeCanvas();
window.addEventListener('load',resizeCanvas);
window.addEventListener('resize',()=>{const t=hasSig;ctx.clearRect(0,0,canvas.width,canvas.height);hasSig=false;resizeCanvas();if(t){label.style.display='block';updateBtn();}});

function getPos(e){
  const r=canvas.getBoundingClientRect();
  const t=e.touches?e.touches[0]:e;
  return{x:t.clientX-r.left,y:t.clientY-r.top};
}
canvas.addEventListener('mousedown',e=>{drawing=true;ctx.beginPath();const p=getPos(e);ctx.moveTo(p.x,p.y);});
canvas.addEventListener('mousemove',e=>{if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();showSig();});
canvas.addEventListener('mouseup',()=>drawing=false);
canvas.addEventListener('mouseleave',()=>drawing=false);
canvas.addEventListener('touchstart',e=>{e.preventDefault();drawing=true;ctx.beginPath();const p=getPos(e);ctx.moveTo(p.x,p.y);},{passive:false});
canvas.addEventListener('touchmove',e=>{e.preventDefault();if(!drawing)return;const p=getPos(e);ctx.lineTo(p.x,p.y);ctx.stroke();showSig();},{passive:false});
canvas.addEventListener('touchend',()=>drawing=false);
canvas.addEventListener('touchcancel',()=>drawing=false);

function showSig(){if(!hasSig){hasSig=true;label.style.display='none';updateBtn();}}
function updateBtn(){btnSign.disabled=!(hasSig&&consent.checked);}
consent.addEventListener('change',updateBtn);
btnClear.addEventListener('click',()=>{
  ctx.clearRect(0,0,canvas.width,canvas.height);
  hasSig=false;
  label.style.display='block';
  updateBtn();
});
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
    const { rows } = await db.query(
      `SELECT t.used_at, a.conclusion_signed, a.conclusion_at
       FROM dental_ws_tokens t JOIN dental_appointments a ON a.id=t.appointment_id
       WHERE t.token=$1`, [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Token não encontrado' });
    const row = rows[0];
    const sessionStatus = getSessionStatus(token);

    const isSigned =
      row.conclusion_signed === true ||
      row.conclusion_signed === 1 ||
      row.conclusion_signed === '1' ||
      row.conclusion_signed === 'true' ||
      !!row.conclusion_at ||
      !!row.used_at;

    res.json({
      token,
      signed: isSigned,
      conclusion_at: row.conclusion_at,
      patient_connected: !!sessionStatus?.connected,
      status: isSigned
        ? 'signed'
        : sessionStatus?.connected
          ? 'patient_connected'
          : 'waiting',
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao verificar status' }); }
});

module.exports = router;
