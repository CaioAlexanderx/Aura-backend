// ============================================================
// AURA. — Quem é da equipe Aura (users.is_staff)
//
// A marca de equipe só vem de fonte explícita:
//   1. users.is_staff já gravado no banco: as contas que já são da equipe
//      seguem como estão. O código nunca rebaixa ninguém.
//   2. A lista AURA_STAFF_EMAILS (e-mails separados por vírgula, no
//      Railway), e só depois que a pessoa confirmou o e-mail: a conta da
//      lista com e-mail confirmado ganha is_staff = true na confirmação ou
//      no login seguinte.
//
// O domínio do e-mail sozinho não conta para nada: nem equipe, nem
// isenção de cobrança, nem dispensa da confirmação do e-mail. Sem a
// variável (ou vazia), ninguém é promovido.
// ============================================================
'use strict';

const normalizar = (email) => String(email || '').trim().toLowerCase();

/** E-mails da lista AURA_STAFF_EMAILS, normalizados e sem repetição. */
function listaDaEquipe(env = process.env) {
  const bruto = String((env && env.AURA_STAFF_EMAILS) || '');
  return [...new Set(bruto.split(',').map(normalizar).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e)))];
}

function estaNaLista(email, env = process.env) {
  const e = normalizar(email);
  return !!e && listaDaEquipe(env).includes(e);
}

/**
 * Promove a conta da lista que já confirmou o e-mail. A trava fica no
 * próprio UPDATE (email_verified = true e e-mail na lista), então chamar
 * aqui nunca promove quem não confirmou. Passe `email` quando já o tiver
 * lido, para pular a consulta de quem nem está na lista.
 * Devolve true quando a conta foi promovida agora.
 */
async function promoverSeDaLista(conn, userId, { email, env = process.env } = {}) {
  if (!conn || !userId) return false;
  const lista = listaDaEquipe(env);
  if (!lista.length) return false;
  if (email !== undefined && !lista.includes(normalizar(email))) return false;
  try {
    const r = await conn.query(
      `UPDATE users SET is_staff = true, updated_at = NOW()
        WHERE id = $1
          AND email_verified = true
          AND is_staff IS NOT TRUE
          AND lower(trim(email)) = ANY($2::text[])
        RETURNING id`,
      [userId, lista]
    );
    const promovido = !!(r && r.rows && r.rows.length);
    if (promovido) console.log(`[equipe] user ${userId} marcado como equipe pela lista`);
    return promovido;
  } catch (err) {
    console.error('[equipe] promocao pela lista falhou:', err && err.message);
    return false;
  }
}

module.exports = { listaDaEquipe, estaNaLista, promoverSeDaLista };
