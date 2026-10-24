// ============================================================
// AURA. — "Últimos e-mails enviados" da empresa (tq-87/tq-90, 24/10/2026)
//
// Lê email_log dos últimos 30 dias da empresa: data, assunto, tipo e
// situação. A situação:
//   Falhou    status 'failed' (o provedor recusou)
//   Devolvido bounced_at (aviso do Resend, webhook tq-90)
//   Entregue  delivered_at, SÓ com o webhook do Resend ligado
//             (RESEND_WEBHOOK_SECRET presente). Sem ele nunca aparece.
//   Enviado   o provedor aceitou e não há aviso de entrega
// Linhas 'reserved' (envio em andamento) ficam de fora. E-mails ao cliente
// final da loja e ao portal do Karatê também: não foram enviados à loja.
// ============================================================
'use strict';

const DIAS = 30;
const LIMITE = 50;

const TIPOS_FORA = ['pedido_status_cliente', 'verificacao_portal'];

function webhookResendLigado(env = process.env) {
  return !!(env.RESEND_WEBHOOK_SECRET && String(env.RESEND_WEBHOOK_SECRET).trim());
}

function categoria(tipo) {
  const t = String(tipo || '');
  if (t.startsWith('cobranca_')) return 'cobranca';
  if (t === 'relatorio_semanal') return 'relatorio';
  if (t === 'pedido_novo_lojista') return 'pedido_loja';
  if (['verificacao_email', 'redefinicao_senha', 'convite_equipe', 'confirmacao_endereco'].includes(t)) return 'conta';
  if (['ajuda', 'acompanhamento', 'novidades'].includes(t)) return t;
  if (t.startsWith('ajuda_')) return 'ajuda';
  if (t.startsWith('acompanhamento_')) return 'acompanhamento';
  if (t.startsWith('novidades_')) return 'novidades';
  return 'outro';
}

function situacao(linha, env = process.env) {
  if (linha.status === 'failed') return 'falhou';
  if (linha.bounced_at) return 'devolvido';
  if (linha.delivered_at && webhookResendLigado(env)) return 'entregue';
  return 'enviado';
}

const ROTULOS = Object.freeze({ falhou: 'Falhou', devolvido: 'Devolvido', entregue: 'Entregue', enviado: 'Enviado' });

async function ultimosEmailsDaEmpresa(db, companyId, { env = process.env } = {}) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, tipo, assunto, destinatario, status, sent_at, created_at,
              delivered_at, bounced_at, complained_at
         FROM email_log
        WHERE company_id = $1
          AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
          AND status IN ('sent', 'failed')
          AND tipo <> ALL($3::text[])
        ORDER BY created_at DESC
        LIMIT $4`,
      [companyId, DIAS, TIPOS_FORA, LIMITE]
    ));
  } catch (err) {
    if (err && err.code === '42P01') return { dias: DIAS, webhook_ligado: webhookResendLigado(env), emails: [] };
    throw err;
  }
  return {
    dias: DIAS,
    webhook_ligado: webhookResendLigado(env),
    emails: (rows || []).map((r) => {
      const s = situacao(r, env);
      return {
        id: r.id,
        data: r.sent_at || r.created_at,
        assunto: r.assunto,
        tipo: r.tipo,
        categoria: categoria(r.tipo),
        destinatario: r.destinatario,
        situacao: s,
        situacao_rotulo: ROTULOS[s],
      };
    }),
  };
}

module.exports = { DIAS, TIPOS_FORA, webhookResendLigado, categoria, situacao, ultimosEmailsDaEmpresa };
