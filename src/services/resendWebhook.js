// ============================================================
// AURA. — Webhook do Resend (tq-90, 24/10/2026)
//
// Assinatura svix (doc do Resend e docs.svix.com, "verifying payloads
// manually"):
//   cabeçalhos svix-id, svix-timestamp (segundos) e svix-signature
//   ("v1,<base64> v1,<base64>": uma ou mais, separadas por espaço);
//   segredo RESEND_WEBHOOK_SECRET = "whsec_" + base64 da chave;
//   assinatura = base64(HMAC-SHA256(chave, "<id>.<timestamp>.<corpo cru>")).
//   Tolerância de 5 min no timestamp e comparação em tempo constante.
// Sem pacote novo: é o mesmo algoritmo do `svix`, em 20 linhas.
//
// Eventos tratados (o resto responde 200 e é ignorado):
//   email.sent        last_event (sem passar por cima de evento mais novo)
//   email.delivered   delivered_at
//   email.bounced     bounced_at (+ tipo do bounce no metadata)
//   email.complained  complained_at e desliga novidades e acompanhamento da
//                     empresa daquele envio (marcou como spam)
// Tudo pela email_log.resend_id. Evento repetido não muda nada: as datas
// usam COALESCE (vale a primeira) e o desligamento é idempotente.
// ============================================================
'use strict';

const crypto = require('crypto');

const TOLERANCIA_S = 5 * 60;
const EVENTOS = Object.freeze(['email.sent', 'email.delivered', 'email.bounced', 'email.complained']);
const TIPOS_DESLIGADOS_NA_RECLAMACAO = Object.freeze(['novidades', 'acompanhamento']);

function chaveDoSegredo(segredo) {
  const s = String(segredo || '').trim();
  if (!s) return null;
  const b64 = s.startsWith('whsec_') ? s.slice('whsec_'.length) : s;
  const chave = Buffer.from(b64, 'base64');
  return chave.length ? chave : null;
}

/**
 * Verifica a assinatura. `corpo`: Buffer ou string com os bytes EXATOS
 * recebidos. Devolve { ok: true } ou { ok: false, motivo }.
 */
function verificarAssinatura({ segredo, id, timestamp, assinatura, corpo, agora = Date.now() }) {
  const chave = chaveDoSegredo(segredo);
  if (!chave) return { ok: false, motivo: 'sem_segredo' };
  if (!id || !timestamp || !assinatura || corpo == null) return { ok: false, motivo: 'cabecalhos_ausentes' };
  if (!/^\d{1,12}$/.test(String(timestamp))) return { ok: false, motivo: 'timestamp_invalido' };
  const ts = Number(timestamp);
  if (Math.abs(Math.floor(agora / 1000) - ts) > TOLERANCIA_S) return { ok: false, motivo: 'timestamp_fora_da_janela' };

  const bruto = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  const assinado = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), bruto]);
  const esperada = crypto.createHmac('sha256', chave).update(assinado).digest();

  for (const parte of String(assinatura).split(' ')) {
    const [versao, valor] = parte.split(',');
    if (versao !== 'v1' || !valor) continue;
    let recebida;
    try { recebida = Buffer.from(valor, 'base64'); } catch (_) { continue; }
    if (recebida.length === esperada.length && crypto.timingSafeEqual(recebida, esperada)) return { ok: true };
  }
  return { ok: false, motivo: 'assinatura_invalida' };
}

function dataDoEvento(evento) {
  const d = evento && (evento.created_at || (evento.data && evento.data.created_at));
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : new Date().toISOString();
}

/**
 * Aplica o evento no email_log. Nunca lança por evento desconhecido.
 * @returns {Promise<{tratado: boolean, linhas: number, desligou?: string[]}>}
 */
async function aplicarEvento(db, evento) {
  const tipo = evento && evento.type;
  const resendId = evento && evento.data && evento.data.email_id;
  if (!EVENTOS.includes(tipo) || !resendId) return { tratado: false, linhas: 0 };
  const quando = dataDoEvento(evento);

  let sql;
  const params = [String(resendId), tipo, quando];
  switch (tipo) {
    case 'email.sent':
      params.pop(); // sem data própria: o envio já tem sent_at
      sql = `UPDATE email_log
                SET last_event = CASE WHEN last_event IS NULL OR last_event = 'email.sent' THEN $2 ELSE last_event END,
                    updated_at = NOW()
              WHERE resend_id = $1
              RETURNING id, company_id`;
      break;
    case 'email.delivered':
      sql = `UPDATE email_log
                SET delivered_at = COALESCE(delivered_at, $3::timestamptz),
                    last_event = CASE WHEN last_event IN ('email.bounced', 'email.complained') THEN last_event ELSE $2 END,
                    updated_at = NOW()
              WHERE resend_id = $1
              RETURNING id, company_id`;
      break;
    case 'email.bounced': {
      const b = (evento.data && evento.data.bounce) || {};
      params.push(JSON.stringify({ bounce: { type: b.type || null, subType: b.subType || null } }));
      sql = `UPDATE email_log
                SET bounced_at = COALESCE(bounced_at, $3::timestamptz),
                    last_event = $2,
                    metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                    updated_at = NOW()
              WHERE resend_id = $1
              RETURNING id, company_id`;
      break;
    }
    case 'email.complained':
      sql = `UPDATE email_log
                SET complained_at = COALESCE(complained_at, $3::timestamptz),
                    last_event = $2,
                    updated_at = NOW()
              WHERE resend_id = $1
              RETURNING id, company_id`;
      break;
    default:
      return { tratado: false, linhas: 0 };
  }
  const { rows } = await db.query(sql, params);
  const out = { tratado: true, linhas: (rows || []).length };

  if (tipo === 'email.complained') {
    const empresas = new Set((rows || []).map((r) => r.company_id).filter(Boolean));
    // Envio sem empresa no registro: procura pelo endereço que reclamou.
    if (!empresas.size) {
      for (const id of await empresasDoEndereco(db, evento.data.to)) empresas.add(id);
    }
    const { desligarTipoDeEmail } = require('./emailPreferencias');
    out.desligou = [];
    for (const companyId of empresas) {
      for (const t of TIPOS_DESLIGADOS_NA_RECLAMACAO) {
        const r = await desligarTipoDeEmail(db, companyId, t, { origem: 'reclamacao' });
        if (r.desligadas && r.desligadas.length) out.desligou.push(`${companyId}:${t}`);
      }
    }
  }
  return out;
}

async function empresasDoEndereco(db, to) {
  const lista = (Array.isArray(to) ? to : [to])
    .map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@'));
  if (!lista.length) return [];
  try {
    const { rows } = await db.query(
      `SELECT c.id FROM companies c JOIN users u ON u.id = c.owner_id WHERE lower(u.email) = ANY($1::text[])
       UNION
       SELECT a.company_id FROM company_email_addresses a
        WHERE lower(a.email) = ANY($1::text[]) AND a.confirmado_em IS NOT NULL`,
      [lista]
    );
    return (rows || []).map((r) => r.id);
  } catch (err) {
    if (err && err.code === '42P01') return [];
    throw err;
  }
}

module.exports = {
  TOLERANCIA_S,
  EVENTOS,
  TIPOS_DESLIGADOS_NA_RECLAMACAO,
  verificarAssinatura,
  aplicarEvento,
};
