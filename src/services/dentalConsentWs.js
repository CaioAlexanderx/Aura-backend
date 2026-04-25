// ============================================================
// AURA. — W2-04: WebSocket Manager para TCLE (consent documents)
//
// Fluxo: Dentista gera link -> Paciente abre pad -> assina ->
// WS recebe PNG -> persiste em dental_consent_documents -> fecha.
//
// Diferente do dentalWs.js (W1-04, especifico de appointments):
// este handler trabalha com dental_consent_documents.token e
// atualiza signature_url + signed_at + status='signed'.
//
// NAO altera status do appointment — TCLE e documento independente.
// Uma consulta pode ter varios TCLEs (LGPD + procedimento, por ex)
// e cada um e assinado separadamente.
// ============================================================

const db = require('../config/database');

const activeSessions = new Map();

async function validateConsentToken(token) {
  const { rows } = await db.query(
    `SELECT d.id, d.company_id, d.customer_id, d.title, d.token_expires_at, d.status
     FROM dental_consent_documents d
     WHERE d.token = $1`,
    [token]
  );

  if (!rows.length) return null;
  const doc = rows[0];

  if (doc.status !== 'pending') return null;
  if (new Date(doc.token_expires_at) < new Date()) return null;

  return doc;
}

function setupConsentWebSocket(wss) {
  wss.on('connection', async (ws, req) => {
    const urlParts = req.url.split('/');
    const token = urlParts[urlParts.length - 1];

    if (!token) { ws.close(4001, 'Token nao informado'); return; }

    let session;
    try { session = await validateConsentToken(token); }
    catch (err) {
      console.error('[consentWs validate]', err.message);
      ws.close(4002, 'Erro ao validar token');
      return;
    }

    if (!session) { ws.close(4003, 'Token invalido ou expirado'); return; }

    activeSessions.set(token, {
      ws,
      documentId: session.id,
      customerId: session.customer_id,
      companyId: session.company_id,
      connectedAt: new Date(),
      signedAt: null,
    });

    ws.send(JSON.stringify({
      type: 'connected',
      document_id: session.id,
      title: session.title,
      expires_at: session.token_expires_at,
      message: 'Conexao estabelecida. Aguardando assinatura.',
    }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type !== 'signature') {
          ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem invalido' }));
          return;
        }

        if (!msg.signature_data) {
          ws.send(JSON.stringify({ type: 'error', message: 'Dados da assinatura nao encontrados' }));
          return;
        }

        // Cap em 500KB pra evitar payloads gigantes
        const sigData = msg.signature_data.substring(0, 500000);

        // Captura IP e user-agent pra auditoria forense
        const xfwd = req.headers['x-forwarded-for'];
        const ip = (Array.isArray(xfwd) ? xfwd[0] : (xfwd || '').split(',')[0].trim())
          || req.socket?.remoteAddress
          || null;
        const ua = req.headers['user-agent'] || null;

        await db.query(
          `UPDATE dental_consent_documents
           SET signature_url = $2,
               status = 'signed',
               signed_at = NOW(),
               signer_ip = $3,
               signer_user_agent = $4,
               updated_at = NOW()
           WHERE id = $1 AND status = 'pending'`,
          [session.id, sigData, ip, ua]
        );

        const sess = activeSessions.get(token);
        if (sess) sess.signedAt = new Date();

        ws.send(JSON.stringify({
          type: 'signature_received',
          message: 'Assinatura registrada com sucesso. Obrigado!',
        }));

        setTimeout(() => {
          ws.close(1000, 'Assinatura concluida');
          activeSessions.delete(token);
        }, 3000);
      } catch (err) {
        console.error('[consentWs message]', err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Erro ao processar assinatura' }));
      }
    });

    ws.on('close', () => activeSessions.delete(token));
    ws.on('error', (err) => {
      console.error('[consentWs error]', err.message);
      activeSessions.delete(token);
    });
  });
}

function getConsentSessionStatus(token) {
  const sess = activeSessions.get(token);
  if (!sess) return { status: 'waiting', connected: false };
  return {
    status: sess.signedAt ? 'signed' : 'connected',
    connected: true,
    signed: !!sess.signedAt,
    signed_at: sess.signedAt,
  };
}

module.exports = {
  setupConsentWebSocket,
  getConsentSessionStatus,
  validateConsentToken,
};
