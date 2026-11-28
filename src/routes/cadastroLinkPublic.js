// ============================================================
// AURA. — Cadastro por link: página pública do cliente (p-209, 23/11/2026)
//
// Montado em index.js como /public/cadastro/:token — SEM auth: o token é a
// credencial (mesmo padrão de /acompanhar e /public/roster-self).
//
//   GET  /public/cadastro/:token → {store: {name, logo_url}, expires_at}
//   POST /public/cadastro/:token → {ok: true, store: {name}}
//
// O QUE NÃO SAI DAQUI (a lista importa mais que a de campos aceitos):
//   - NENHUM dado do cliente, nem o que já estava gravado nem o que acabou
//     de ser enviado. O link pode ter sido encaminhado: quem abre não pode
//     descobrir nome, CPF, telefone ou endereço de ninguém.
//   - id do cliente, id do link, id da empresa.
// Só o nome e o logo da LOJA, que já são públicos.
//
// Link desconhecido, usado, vencido ou trocado por outro: 410 com a mesma
// mensagem. A página não distingue "nunca existiu" de "já usado" para quem
// só tem o token.
//
// LIMITES: GET 60 por IP em 10 min; POST 10 por token em 1 h e 20 por IP
// em 10 min. Erro de validação não gasta o link (ele só morre ao gravar).
//
// LOG: nunca o body, nunca err.message (o Postgres cita o valor em
// alguns erros). Só o código.
// ============================================================
'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { sqlNomeDaLoja } = require('../utils/nomeDaLoja');
const {
  CAMPOS_DO_ENDERECO, hashToken, tokenComFormato, lerFormulario, planejarGravacao,
} = require('../services/cadastroPorLink');

const isTestEnv = () => process.env.NODE_ENV === 'test' && !process.env.CADASTRO_LINK_RATE_LIMIT_IN_TEST;

const porIp = (req) => `ip:${req.ip || 'sem-ip'}`;
const porToken = (req) => `tk:${String(req.params.token || '').slice(0, 64)}`;

const leituraLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: porIp, skip: isTestEnv,
});
const envioPorIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: porIp, skip: isTestEnv,
  message: { error: 'Muitas tentativas. Espere alguns minutos e tente de novo.', code: 'MUITAS_TENTATIVAS' },
});
const envioPorTokenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: porToken, skip: isTestEnv,
  message: { error: 'Muitas tentativas. Espere alguns minutos e tente de novo.', code: 'MUITAS_TENTATIVAS' },
});

const INDISPONIVEL = { error: 'Este link já foi usado ou venceu. Peça um novo link à loja.', code: 'LINK_INDISPONIVEL' };

function lojaPublica(row) {
  if (!row) return null;
  return { name: row.store_name || '', logo_url: row.logo_url || null };
}

function linkAberto(l) {
  return l && !l.used_at && !l.revoked_at && new Date(l.expires_at).getTime() > Date.now();
}

function falhar(res, err, contexto) {
  console.error(`[cadastro-link:public:${contexto}]`, (err && err.code) || 'erro');
  if (err && err.code === '42P01') return res.status(410).json(INDISPONIVEL);
  return res.status(500).json({ error: 'Não deu para enviar agora. Tente de novo em instantes.' });
}

const SQL_DO_LINK = `
  SELECT l.id, l.customer_id, l.company_id, l.expires_at, l.used_at, l.revoked_at, l.placeholder_name,
         ${sqlNomeDaLoja('c')} AS store_name, c.logo_url
    FROM customer_signup_links l
    JOIN companies c ON c.id = l.company_id
   WHERE l.token_hash = $1`;

// ─── GET — só a loja ─────────────────────────────────────────
router.get('/:token', leituraLimiter, async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!tokenComFormato(req.params.token)) return res.status(410).json(INDISPONIVEL);
  try {
    const { rows } = await db.query(SQL_DO_LINK, [hashToken(req.params.token)]);
    const link = rows[0];
    if (!link) return res.status(410).json(INDISPONIVEL);
    if (!linkAberto(link)) return res.status(410).json({ ...INDISPONIVEL, store: lojaPublica(link) });
    res.json({ store: lojaPublica(link), expires_at: link.expires_at });
  } catch (err) {
    falhar(res, err, 'GET');
  }
});

// ─── POST — grava e morre ────────────────────────────────────
router.post('/:token', envioPorIpLimiter, envioPorTokenLimiter, async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!tokenComFormato(req.params.token)) return res.status(410).json(INDISPONIVEL);

  const form = lerFormulario(req.body);
  if (!form.ok) {
    return res.status(form.status || 400).json({ error: form.error, field: form.field, code: form.code });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`${SQL_DO_LINK} FOR UPDATE OF l`, [hashToken(req.params.token)]);
    const link = rows[0];
    if (!linkAberto(link)) {
      await client.query('ROLLBACK');
      return res.status(410).json(link ? { ...INDISPONIVEL, store: lojaPublica(link) } : INDISPONIVEL);
    }

    const cli = await client.query(
      `SELECT id, name, birth_date, cpf_cnpj, phone, email, ${CAMPOS_DO_ENDERECO.join(', ')}
         FROM customers WHERE id = $1 FOR UPDATE`,
      [link.customer_id]
    );
    if (!cli.rows.length) {
      await client.query('ROLLBACK');
      return res.status(410).json({ ...INDISPONIVEL, store: lojaPublica(link) });
    }

    const plano = planejarGravacao(cli.rows[0], form.values, { placeholderName: link.placeholder_name });
    const cols = Object.keys(plano.set);
    if (cols.length) {
      await client.query(
        `UPDATE customers SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = NOW()
          WHERE id = $${cols.length + 1}`,
        [...cols.map((k) => plano.set[k]), link.customer_id]
      );
    }

    const temPendencia = Object.keys(plano.pending).length > 0;
    await client.query(
      `UPDATE customer_signup_links
          SET used_at = NOW(), consent_version = $1, consent_at = NOW(),
              filled_fields = $2::text[], pending_changes = $3::jsonb
        WHERE id = $4`,
      [form.consentVersion, plano.filled, temPendencia ? JSON.stringify(plano.pending) : null, link.id]
    );
    // A diferença mais nova vale: a de um envio anterior sai da ficha.
    if (temPendencia) {
      await client.query(
        `UPDATE customer_signup_links
            SET pending_changes = NULL, pending_resolved_at = NOW()
          WHERE customer_id = $1 AND id <> $2 AND pending_changes IS NOT NULL`,
        [link.customer_id, link.id]
      );
    }
    await client.query('COMMIT');

    res.json({ ok: true, store: { name: link.store_name || '' } });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexao ja caiu */ }
    falhar(res, err, 'POST');
  } finally {
    client.release();
  }
});

module.exports = router;
