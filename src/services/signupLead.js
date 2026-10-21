// ============================================================
// AURA. — Lead do cadastro por etapa (porta de entrada 1/5, tq-66, 21/10/2026)
//
// Pedido da Produto (revisão do mockup): não perder quem abandona o cadastro
// no meio. O app grava o lead ao concluir cada etapa (POST /auth/signup-lead,
// routes/signupLead.js):
//   etapa 1  nome, e-mail, aceite dos Termos e a origem (utm, referrer,
//            landing_page, ref) -> cria ou atualiza o lead do e-mail (upsert)
//   etapa 2  documento (CNPJ ou CPF)
//   etapa 3  WhatsApp digitado, SEMPRE whatsapp_confirmado = false
// e devolve um lead_token. O POST /auth/register recebe esse lead_token,
// liga o lead à conta criada (company_id, user_id, convertido_em) e herda a
// origem quando o corpo do register não traz `origem`.
//
// Por que tabela própria (signup_leads, migration 401) e não sales_leads:
// sales_leads é o CRM de prospecção (~10 consultas, cadências, metas, score),
// alimentado só pelo Worker do site com token (x-site-token). Esta rota é
// PÚBLICA, chamada do navegador: gravar direto no CRM abriria a lista de
// prospecção a qualquer robô. Não havia tabela de onboarding/prospect de
// cadastro para reusar (checkin é por empresa, depois da conta existir).
//
// O lead NÃO cria conta nem usuário. Nada de senha aqui. Nada de dado pessoal
// no log: erros registram só o código do erro.
// ============================================================
'use strict';

const crypto = require('crypto');
const signupOrigem = require('./signupOrigem');
const whatsappCadastro = require('./whatsappCadastro');
const { validateCNPJ } = require('./cnpj');
const { validateCPF, onlyDigits } = require('./documentoEmpresa');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const MAX_NOME = 120;
const MAX_EMAIL = 200;

const novoToken = () => crypto.randomBytes(24).toString('hex');

function textoCurto(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

const erro = (error, code) => ({ erro: { error, code } });

// Valida o corpo. Devolve { erro } ou { valor }.
function normalizar(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return erro('Corpo inválido.', 'LEAD_INVALID');
  const etapa = Number(b.etapa);
  if (![1, 2, 3].includes(etapa)) return erro('etapa deve ser 1, 2 ou 3.', 'LEAD_INVALID');

  const token = typeof b.lead_token === 'string' ? b.lead_token.trim().toLowerCase() : '';
  if (token && !TOKEN_RE.test(token)) return erro('lead_token inválido.', 'LEAD_TOKEN_INVALID');

  const v = { etapa, token: token || null };

  if (etapa === 1) {
    const nome = textoCurto(b.nome !== undefined ? b.nome : b.name, MAX_NOME);
    if (!nome || nome.length < 2) return erro('Informe o seu nome.', 'LEAD_NAME_REQUIRED');
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return erro('E-mail inválido.', 'LEAD_EMAIL_INVALID');
    if (b.terms_accepted !== true) return erro('O aceite dos Termos de Uso é obrigatório.', 'LEAD_TERMS_REQUIRED');
    v.nome = nome;
    v.email = email;
    v.termos_versao = textoCurto(b.terms_version, 20) || 'v1';
    v.origem = signupOrigem.sanitizarOrigem(b.origem);
    return { valor: v };
  }

  // Etapas 2 e 3 só atualizam um lead que já existe.
  if (!v.token) return erro('lead_token é obrigatório a partir da etapa 2.', 'LEAD_TOKEN_REQUIRED');

  if (etapa === 2) {
    const cnpj = onlyDigits(b.cnpj);
    const cpf = onlyDigits(b.cpf);
    if (cnpj) {
      if (!validateCNPJ(cnpj)) return erro('CNPJ inválido. Confira os números.', 'LEAD_CNPJ_INVALID');
      v.documento_tipo = 'cnpj';
      v.documento = cnpj;
    } else if (cpf) {
      if (!validateCPF(cpf)) return erro('CPF inválido. Confira os números.', 'LEAD_CPF_INVALID');
      v.documento_tipo = 'cpf';
      v.documento = cpf;
    } else {
      return erro('Informe o CNPJ ou o CPF.', 'LEAD_DOCUMENT_REQUIRED');
    }
    v.empresa = textoCurto(b.company_name, 200);
    return { valor: v };
  }

  // etapa 3: o WhatsApp digitado. Mesma regra do register; inválido é 400
  // (a tela mostra a mesma mensagem que o cadastro mostraria).
  const cel = whatsappCadastro.validarCelular(b.whatsapp !== undefined ? b.whatsapp : b.phone);
  if (!cel.ok) return erro(cel.error, cel.code);
  v.whatsapp = cel.numero;
  return { valor: v };
}

const migrationPendente = (err) => !!err && (err.code === '42P01' || err.code === '42703');

// Grava a etapa. Devolve { lead_token, etapa } ou null (token desconhecido
// ou lead já convertido, nas etapas 2/3).
async function gravarEtapa(db, v) {
  if (v.etapa === 1) {
    // Upsert por e-mail: um lead por pessoa. Token novo a cada etapa 1 (o
    // anterior deixa de valer). Lead já convertido não volta a ser lead.
    const token = novoToken();
    const { rows } = await db.query(
      `-- lead:etapa1
       INSERT INTO signup_leads (token, email, nome, termos_aceitos_em, termos_versao, origem, etapa)
       VALUES ($1, $2, $3, NOW(), $4, $5::jsonb, 1)
       ON CONFLICT (email) DO UPDATE
          SET token = EXCLUDED.token,
              nome = EXCLUDED.nome,
              termos_aceitos_em = EXCLUDED.termos_aceitos_em,
              termos_versao = EXCLUDED.termos_versao,
              origem = COALESCE(signup_leads.origem, EXCLUDED.origem),
              etapa = GREATEST(signup_leads.etapa, 1),
              atualizado_em = NOW()
        WHERE signup_leads.convertido_em IS NULL
       RETURNING token, etapa`,
      [token, v.email, v.nome, v.termos_versao, v.origem ? JSON.stringify(v.origem) : null]
    );
    // Conflito com lead já convertido: não devolve token (a conta já existe;
    // o register vai responder "e-mail já cadastrado").
    if (!rows.length) return { lead_token: null, etapa: 1, convertido: true };
    return { lead_token: rows[0].token, etapa: rows[0].etapa, convertido: false };
  }

  const sets = v.etapa === 2
    ? 'documento_tipo = $2, documento = $3, empresa = COALESCE($4, empresa)'
    : 'whatsapp = $2, whatsapp_confirmado = false';
  const params = v.etapa === 2 ? [v.token, v.documento_tipo, v.documento, v.empresa] : [v.token, v.whatsapp];
  const { rows } = await db.query(
    `-- lead:etapa${v.etapa}
     UPDATE signup_leads
        SET ${sets}, etapa = GREATEST(etapa, ${v.etapa}), atualizado_em = NOW()
      WHERE token = $1 AND convertido_em IS NULL
      RETURNING token, etapa`,
    params
  );
  if (!rows.length) return null;
  return { lead_token: rows[0].token, etapa: rows[0].etapa, convertido: false };
}

// Dentro da transação do register (atrás de SAVEPOINT). Liga o lead do token
// à conta — só se o e-mail do lead for o do cadastro — e devolve a origem do
// lead (para herdar) ou null. Nunca lança: o cadastro não depende do lead.
async function ligarAoCadastro(client, { token, email, companyId, userId }) {
  const t = typeof token === 'string' ? token.trim().toLowerCase() : '';
  if (!TOKEN_RE.test(t) || !email) return null;
  try {
    await client.query('SAVEPOINT signup_lead');
    const { rows } = await client.query(
      `-- lead:converter
       UPDATE signup_leads
          SET company_id = $3, user_id = $4, convertido_em = NOW(), atualizado_em = NOW()
        WHERE token = $1 AND email = $2 AND convertido_em IS NULL
        RETURNING id, origem`,
      [t, email, companyId || null, userId || null]
    );
    await client.query('RELEASE SAVEPOINT signup_lead');
    return rows[0] ? { id: rows[0].id, origem: rows[0].origem || null } : null;
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT signup_lead'); } catch (_) { /* segue com o chamador */ }
    if (!migrationPendente(err)) console.warn('[register] lead do cadastro não ligado:', err && err.code);
    return null;
  }
}

module.exports = { normalizar, gravarEtapa, ligarAoCadastro, migrationPendente, TOKEN_RE };
