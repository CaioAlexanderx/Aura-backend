// ============================================================
// AURA. — WebSocket Manager — Assinatura Digital (BE-25-10)
// Fluxo: Dentista gera QR → Paciente abre pad → Assina → WS → DB
// ============================================================

const { validateWsToken } = require('./dental');
const db = require('../config/database');

const activeSessions = new Map();

function setupDentalWebSocket(wss) {
  wss.on('connection', async (ws, req) => {
    const urlParts = req.url.split('/');
    const token = urlParts[urlParts.length - 1];

    if (!token) { ws.close(4001, 'Token não informado'); return; }

    let session;
    try { session = await validateWsToken(token); }
    catch (err) { ws.close(4002, 'Erro ao validar token'); return; }

    if (!session) { ws.close(4003, 'Token inválido ou expirado'); return; }

    activeSessions.set(token, {
      ws, appointmentId: session.appointment_id,
      companyId: session.company_id, connectedAt: new Date(), signedAt: null,
    });

    ws.send(JSON.stringify({
      type: 'connected', appointment_id: session.appointment_id,
      expires_at: session.expires_at, message: 'Conexão estabelecida. Aguardando assinatura.',
    }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'signature') {
          ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem inválido' })); return;
        }
        if (!msg.signature_data) {
          ws.send(JSON.stringify({ type: 'error', message: 'Dados da assinatura não encontrados' })); return;
        }
        const sigData = msg.signature_data.substring(0, 500000);
        await db.query(
          `UPDATE dental_appointments
           SET conclusion_sig_url=$2, conclusion_signed=true,
               conclusion_at=NOW(), status='concluido', concluded_at=NOW(), updated_at=NOW()
           WHERE id=$1`,
          [session.appointment_id, sigData]
        );
        await db.query(
          `UPDATE dental_ws_tokens SET used_at=NOW(), signature_url=$1 WHERE token=$2`,
          [sigData.substring(0, 2000), token]
        );
        const sess = activeSessions.get(token);
        if (sess) sess.signedAt = new Date();
        ws.send(JSON.stringify({ type: 'signature_received', message: 'Assinatura registrada com sucesso. Obrigado!' }));
        setTimeout(() => { ws.close(1000, 'Assinatura concluída'); activeSessions.delete(token); }, 3000);
      } catch (err) {
        console.error('dentalWs message error:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Erro ao processar assinatura' }));
      }
    });

    ws.on('close', () => activeSessions.delete(token));
    ws.on('error', (err) => { console.error('dentalWs error:', err.message); activeSessions.delete(token); });
  });
}

function getSessionStatus(token) {
  const sess = activeSessions.get(token);
  if (!sess) return { status: 'waiting', connected: false };
  return { status: sess.signedAt ? 'signed' : 'connected', connected: true, signed: !!sess.signedAt, signed_at: sess.signedAt };
}

module.exports = { setupDentalWebSocket, getSessionStatus };
