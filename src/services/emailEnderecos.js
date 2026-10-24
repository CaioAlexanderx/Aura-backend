// ============================================================
// AURA. — Endereços de aviso por empresa (tq-87, migration 409)
//
// O principal é o e-mail do dono (sem linha). Os extras ficam em
// company_email_addresses e só recebem depois de confirmar pelo link que
// este módulo manda (token assinado, 7 dias, services/emailLinks).
//
//   adicionarEndereco()  grava (ou reaproveita) a linha e manda o link
//   removerEndereco()    apaga a linha (o link antigo deixa de valer)
//   confirmarPeloToken() GET público /emails/confirmar/:token
//
// O e-mail de confirmação sai por enviarEmailRegistrado, com chave por
// endereço e hora: clicar "adicionar" de novo dentro da mesma hora não
// manda outro.
// ============================================================
'use strict';

const L = require('./emailLayout');
const { linkConfirmacao, lerTokenConfirmacao } = require('./emailLinks');
const { enviarEmailRegistrado } = require('./emailLog');
const { normalizarEmail, donoDaEmpresa, enderecosExtras } = require('./emailPreferencias');

const MAX_EXTRAS = 5;

function horaDaChave(agora = Date.now()) {
  return new Date(agora).toISOString().slice(0, 13); // AAAA-MM-DDTHH (UTC)
}

/** E-mail de confirmação (aura-transacional, sem a letra). */
function montarConfirmacao({ loja, email, link }) {
  const nomeLoja = loja || 'sua loja';
  const assunto = `Confirme este e-mail para receber os avisos da ${nomeLoja}`;
  const corpo = [
    L.p('Olá!'),
    L.pHtml(`Pediram para <strong>${L.esc(email)}</strong> receber os avisos da <strong>${L.esc(nomeLoja)}</strong> na Aura, como o relatório da semana.`),
    L.p('Para começar a receber, confirme no botão abaixo. O link vale por 7 dias.'),
    L.nota('Se você não conhece esta loja, é só ignorar este e-mail: nada chega para você sem a confirmação.'),
  ].join('\n');
  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto,
    previa: 'Um clique para confirmar',
    corpo,
    botao: { rotulo: 'Confirmar este e-mail', url: link },
  });
  const text = `Pediram para ${email} receber os avisos da ${nomeLoja} na Aura. Para confirmar, abra: ${link} (vale por 7 dias). Se você não conhece esta loja, ignore este e-mail.`;
  return { assunto, html, text };
}

async function enviarConfirmacao(db, { endereco, companyId, loja, userId = null, enviar, agora = Date.now() }) {
  const link = linkConfirmacao({ enderecoId: endereco.id, companyId, email: endereco.email }, process.env, agora);
  if (!link) return { status: 'sem_link' };
  const c = montarConfirmacao({ loja, email: endereco.email, link });
  const r = await enviarEmailRegistrado({
    db, enviar,
    chave: `confirmar-endereco:${endereco.id}:${horaDaChave(agora)}`,
    tipo: 'confirmacao_endereco',
    companyId, userId,
    metadata: { endereco_id: endereco.id },
    to: endereco.email,
    subject: c.assunto,
    html: c.html,
    text: c.text,
  });
  if (r.status === 'sent') {
    await db.query(
      'UPDATE company_email_addresses SET confirmacao_enviada_em = NOW(), updated_at = NOW() WHERE id = $1',
      [endereco.id]
    ).catch((e) => console.error('[emailEnderecos] marcar envio falhou: ' + e.message));
  }
  return r;
}

/**
 * Adiciona um endereço extra e manda o link de confirmação.
 * @returns {Promise<{ok, codigo?, mensagem?, endereco?, envio?}>}
 */
async function adicionarEndereco(db, companyId, emailBruto, { userId = null, enviar, agora = Date.now() } = {}) {
  const email = normalizarEmail(emailBruto);
  if (!email) return { ok: false, codigo: 'EMAIL_INVALIDO', mensagem: 'Confira o e-mail digitado.' };

  const dono = await donoDaEmpresa(db, companyId);
  if (!dono) return { ok: false, codigo: 'EMPRESA_NAO_ENCONTRADA', mensagem: 'Empresa não encontrada.' };
  if (dono.email && dono.email === email) {
    return { ok: false, codigo: 'EMAIL_PRINCIPAL', mensagem: 'Este já é o e-mail principal da conta.' };
  }

  const extras = await enderecosExtras(db, companyId);
  let endereco = extras.find((x) => normalizarEmail(x.email) === email) || null;
  if (endereco && endereco.confirmado_em) return { ok: true, endereco, jaConfirmado: true };
  if (!endereco) {
    if (extras.length >= MAX_EXTRAS) {
      return { ok: false, codigo: 'LIMITE_DE_ENDERECOS', mensagem: `Dá para cadastrar até ${MAX_EXTRAS} e-mails além do principal.` };
    }
    const { rows } = await db.query(
      `INSERT INTO company_email_addresses (company_id, email, origem, created_by)
       VALUES ($1, $2, 'tela', $3)
       ON CONFLICT (company_id, lower(email)) DO UPDATE SET updated_at = NOW()
       RETURNING id, email, confirmado_em, confirmacao_enviada_em, created_at`,
      [companyId, email, userId]
    );
    endereco = rows[0];
    if (endereco.confirmado_em) return { ok: true, endereco, jaConfirmado: true };
  }

  const envio = await enviarConfirmacao(db, { endereco, companyId, loja: dono.loja, userId, enviar, agora });
  return { ok: true, endereco, envio: envio.status };
}

async function removerEndereco(db, companyId, enderecoId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(enderecoId || ''))) return false;
  const { rows } = await db.query(
    'DELETE FROM company_email_addresses WHERE id = $1 AND company_id = $2 RETURNING id',
    [enderecoId, companyId]
  );
  return !!(rows && rows.length);
}

/**
 * Confirma pelo token do link. Devolve { ok, motivo?, email, companyId }.
 * Reabrir o link de um endereço já confirmado é ok (idempotente).
 */
async function confirmarPeloToken(db, token, { agora = Date.now() } = {}) {
  const t = lerTokenConfirmacao(token, process.env, agora);
  if (!t) return { ok: false, motivo: 'invalido' };
  if (t.expirado) return { ok: false, motivo: 'expirado', email: t.email, companyId: t.companyId };
  const { rows } = await db.query(
    `UPDATE company_email_addresses
        SET confirmado_em = COALESCE(confirmado_em, NOW()), updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND lower(email) = $3
      RETURNING id, email, confirmado_em`,
    [t.enderecoId, t.companyId, t.email]
  );
  if (!rows || !rows.length) return { ok: false, motivo: 'removido', email: t.email, companyId: t.companyId };
  return { ok: true, email: rows[0].email, companyId: t.companyId };
}

module.exports = {
  MAX_EXTRAS,
  montarConfirmacao,
  enviarConfirmacao,
  adicionarEndereco,
  removerEndereco,
  confirmarPeloToken,
};
