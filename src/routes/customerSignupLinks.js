// ============================================================
// AURA. — Cadastro por link: lado do lojista (p-209, 23/11/2026)
//
// Montado em private.js como /companies/:id/customer-signup-links.
//
//   POST /                       → 201 {link, token, path, customer, customer_created}
//        body {customer_id} ou {phone, name?}. Gera o link de uso único
//        (7 dias) e revoga o que estava aberto para o mesmo cliente. Sem
//        customer_id, acha o cliente pelo telefone entre as lojas do dono
//        ou cria um só com o telefone.
//   GET  /?customer_id=…         → {available, link, pending, pending_link_id}
//        Estado na ficha e no Caixa: enviado · recebido · vencido, e o que
//        o cliente mandou DIFERENTE do cadastro (com o valor atual ao lado).
//   POST /:linkId/resolve        → {pending}
//        body {accept: [bloco], keep: [bloco]}. Aceitar grava no cliente;
//        manter só descarta o que veio. Blocos: name, birth_date, cpf_cnpj,
//        phone, email, address.
//
// ENVIO: nenhum. Esta rota só devolve o token; quem manda é o lojista,
// pelo WhatsApp dele (wa.me). O WhatsApp oficial da ótica segue em espera.
// A mensagem leva SÓ o link: nunca nome completo, CPF ou receita.
//
// MULTI-CNPJ: o cliente é do DONO (owner-scope, como em customers.js). O
// link nasce na loja atual (é o nome e o logo dela que a página mostra),
// mas qualquer loja do mesmo dono vê o estado e resolve as pendências.
//
// GATE: nesta primeira entrega, só com a ótica ligada na loja que gera o
// link (decisão do Caio, 23/11). Abrir para outras frentes = mudar
// podePedirCadastroPorLink. Leitura sem gate (armadilha 3).
//
// LOG: nunca o body, nunca err.message (erro do Postgres pode citar o
// valor). Só o código do erro.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');
const { normalizarTelefone } = require('../utils/telefone');
const { assertOticaEnabled } = require('./otica');
const {
  VALIDADE_DIAS, ROTULOS, BLOCOS, gerarToken, hashToken,
  colunasDaPendencia, valorAtualDoBloco, estadoDoLink,
} = require('../services/cadastroPorLink');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Nome do cliente criado pelo próprio link, até o cliente mandar o dele.
const NOME_PROVISORIO = 'Cadastro por link pendente';

async function podePedirCadastroPorLink(companyId) {
  await assertOticaEnabled(companyId);
}

// Mesmo teto do POST /customers (plano no JWT, como lá).
function limiteDoPlano(plan) {
  switch (String(plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio': return 5000;
    default: return 1000;
  }
}

function falhar(res, err, contexto) {
  if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err && err.code === '42P01') {
    return res.status(503).json({ error: 'O cadastro por link ainda não está disponível.', code: 'CADASTRO_LINK_INDISPONIVEL' });
  }
  console.error(`[cadastro-link:${contexto}]`, (err && err.code) || 'erro');
  return res.status(500).json({ error: 'Não deu para processar o cadastro por link.' });
}

function linkParaApp(l) {
  if (!l) return null;
  return {
    id: l.id,
    status: estadoDoLink(l),
    created_at: l.created_at,
    expires_at: l.expires_at,
    used_at: l.used_at || null,
    filled_fields: Array.isArray(l.filled_fields) ? l.filled_fields : [],
  };
}

function pendenciasParaApp(pending, cliente) {
  if (!pending || typeof pending !== 'object') return [];
  return BLOCOS.filter((b) => pending[b] !== undefined).map((b) => ({
    field: b,
    label: ROTULOS[b],
    current: valorAtualDoBloco(cliente, b),
    received: pending[b],
  }));
}

// ─── POST / — gera o link ────────────────────────────────────
router.post('/', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};
  const customerId = body.customer_id ? String(body.customer_id) : null;
  if (customerId && !UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id inválido', field: 'customer_id' });

  let telefone = null;
  if (!customerId) {
    const tel = normalizarTelefone(typeof body.phone === 'string' ? body.phone.trim() : body.phone);
    const digitos = tel.ok ? String(tel.valor || '').replace(/\D/g, '') : '';
    if (!tel.ok || digitos.length < 10) {
      return res.status(400).json({ error: tel.ok ? 'Informe o telefone do cliente, com DDD.' : tel.error, field: 'phone' });
    }
    telefone = String(tel.valor).trim();
  }
  const nomeDado = typeof body.name === 'string' && body.name.trim() ? body.name.trim().replace(/\s+/g, ' ').slice(0, 200) : null;

  try {
    await podePedirCadastroPorLink(cid);
    const donos = await getOwnerScopedCompanyIds(cid);
    const lojas = donos.length ? donos : [cid];

    let cliente = null;
    let criado = false;
    let placeholder = null;

    if (customerId) {
      const { rows } = await db.query(
        'SELECT id, name, phone FROM customers WHERE id = $1 AND company_id = ANY($2)',
        [customerId, lojas]
      );
      if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
      cliente = rows[0];
    } else {
      const digitos = telefone.replace(/\D/g, '');
      const { rows } = await db.query(
        `SELECT id, name, phone FROM customers
          WHERE company_id = ANY($1)
            AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
          ORDER BY created_at ASC
          LIMIT 2`,
        [lojas, digitos]
      );
      if (rows.length === 1) {
        cliente = rows[0];
      } else if (rows.length > 1) {
        return res.status(409).json({
          error: 'Há mais de um cliente com este telefone. Escolha o cliente e peça o cadastro pela ficha dele.',
          code: 'TELEFONE_AMBIGUO',
        });
      } else {
        const limite = limiteDoPlano(req.user && req.user.plan);
        const cont = await db.query('SELECT COUNT(*) AS total FROM customers WHERE company_id = ANY($1)', [lojas]);
        const atual = parseInt(cont.rows[0] && cont.rows[0].total, 10) || 0;
        if (atual >= limite) {
          return res.status(403).json({
            error: `Limite de clientes atingido para o seu plano (${limite} registros).`,
            limit: limite, current: atual,
          });
        }
        placeholder = nomeDado ? null : NOME_PROVISORIO;
        const ins = await db.query(
          'INSERT INTO customers (company_id, name, phone) VALUES ($1, $2, $3) RETURNING id, name, phone',
          [cid, nomeDado || NOME_PROVISORIO, telefone]
        );
        cliente = ins.rows[0];
        criado = true;
      }
    }

    // Um link aberto por cliente: o novo revoga o anterior.
    await db.query(
      `UPDATE customer_signup_links SET revoked_at = NOW()
        WHERE customer_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [cliente.id]
    );

    const token = gerarToken();
    const { rows: linkRows } = await db.query(
      `INSERT INTO customer_signup_links
         (company_id, customer_id, token_hash, created_by, expires_at, placeholder_name)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $5::int), $6)
       RETURNING id, created_at, expires_at, used_at, revoked_at, filled_fields`,
      [cid, cliente.id, hashToken(token), (req.user && req.user.id) || null, VALIDADE_DIAS, placeholder]
    );

    res.status(201).json({
      link: linkParaApp(linkRows[0]),
      token,
      path: `/cadastro/${token}`,
      customer: { id: cliente.id, name: cliente.name, phone: cliente.phone },
      customer_created: criado,
    });
  } catch (err) {
    falhar(res, err, 'POST');
  }
});

// ─── GET /?customer_id= — estado na ficha e no Caixa ─────────
router.get('/', async function (req, res) {
  const cid = req.params.id;
  const customerId = String(req.query.customer_id || '');
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id inválido', field: 'customer_id' });

  try {
    const donos = await getOwnerScopedCompanyIds(cid);
    const lojas = donos.length ? donos : [cid];
    const cli = await db.query(
      `SELECT id, name, birth_date, cpf_cnpj, phone, email,
              zip_code, street, number, complement, neighborhood, city, state
         FROM customers WHERE id = $1 AND company_id = ANY($2)`,
      [customerId, lojas]
    );
    if (!cli.rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });

    let links;
    try {
      links = await db.query(
        `SELECT id, created_at, expires_at, used_at, revoked_at, filled_fields, pending_changes
           FROM customer_signup_links
          WHERE customer_id = $1 AND company_id = ANY($2)
          ORDER BY created_at DESC
          LIMIT 10`,
        [customerId, lojas]
      );
    } catch (e) {
      if (e.code === '42P01') return res.json({ available: false, link: null, pending: [], pending_link_id: null });
      throw e;
    }

    const ultimo = links.rows.find((l) => !l.revoked_at || l.used_at) || links.rows[0] || null;
    const comPendencia = links.rows.find((l) => l.pending_changes && Object.keys(l.pending_changes).length) || null;
    res.json({
      available: true,
      link: linkParaApp(ultimo),
      pending: comPendencia ? pendenciasParaApp(comPendencia.pending_changes, cli.rows[0]) : [],
      pending_link_id: comPendencia ? comPendencia.id : null,
    });
  } catch (err) {
    falhar(res, err, 'GET');
  }
});

// ─── POST /:linkId/resolve — aceitar ou manter ───────────────
router.post('/:linkId/resolve', async function (req, res) {
  const cid = req.params.id;
  const linkId = String(req.params.linkId || '');
  if (!UUID_RE.test(linkId)) return res.status(404).json({ error: 'Link não encontrado' });
  const body = req.body || {};
  const aceitar = Array.isArray(body.accept) ? body.accept.map(String) : [];
  const manter = Array.isArray(body.keep) ? body.keep.map(String) : [];
  const todos = [...aceitar, ...manter];
  if (!todos.length) return res.status(400).json({ error: 'Diga o que aceitar ou manter.' });
  const fora = todos.find((b) => !BLOCOS.includes(b));
  if (fora) return res.status(400).json({ error: 'Campo desconhecido', field: fora });
  if (aceitar.some((b) => manter.includes(b))) return res.status(400).json({ error: 'O mesmo campo não pode ser aceito e mantido.' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const donos = await getOwnerScopedCompanyIds(cid);
    const lojas = donos.length ? donos : [cid];
    const { rows } = await client.query(
      `SELECT l.id, l.customer_id, l.pending_changes
         FROM customer_signup_links l
         JOIN customers c ON c.id = l.customer_id
        WHERE l.id = $1 AND l.company_id = ANY($2) AND c.company_id = ANY($2)
        FOR UPDATE OF l`,
      [linkId, lojas]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Link não encontrado' }); }
    const link = rows[0];
    const pend = { ...(link.pending_changes || {}) };
    const sumiu = todos.find((b) => pend[b] === undefined);
    if (sumiu) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta diferença já foi resolvida.', code: 'PENDENCIA_RESOLVIDA', field: sumiu });
    }

    const cols = {};
    for (const b of aceitar) Object.assign(cols, colunasDaPendencia(b, pend[b]));
    const nomes = Object.keys(cols);
    if (nomes.length) {
      const vals = nomes.map((k) => cols[k]);
      await client.query(
        `UPDATE customers SET ${nomes.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = NOW()
          WHERE id = $${nomes.length + 1}`,
        [...vals, link.customer_id]
      );
    }
    for (const b of todos) delete pend[b];
    const restou = Object.keys(pend).length > 0;
    await client.query(
      `UPDATE customer_signup_links
          SET pending_changes = $1::jsonb,
              pending_resolved_at = CASE WHEN $2::boolean THEN NULL ELSE NOW() END
        WHERE id = $3`,
      [restou ? JSON.stringify(pend) : null, restou, link.id]
    );
    await client.query('COMMIT');

    let cliente = null;
    if (restou) {
      const r = await db.query(
        `SELECT id, name, birth_date, cpf_cnpj, phone, email,
                zip_code, street, number, complement, neighborhood, city, state
           FROM customers WHERE id = $1`,
        [link.customer_id]
      );
      cliente = r.rows[0] || null;
    }
    res.json({ pending: restou ? pendenciasParaApp(pend, cliente) : [], accepted: aceitar, kept: manter });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexao ja caiu */ }
    falhar(res, err, 'resolve');
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.NOME_PROVISORIO = NOME_PROVISORIO;
