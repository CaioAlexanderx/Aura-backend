// ============================================================
// AURA. — Pagamentos da Asaas sem loja (13/10/2026)
//
// O webhook procura a empresa por companies.asaas_customer_id. Quando não
// acha, o evento fica em webhook_logs com company_id NULL — dinheiro que
// entrou e o painel não sabe de quem (29/09, 03/10 e 12/10/2026, R$ 140,83
// cada).
//
// listarOrfaos() mostra esses registros com um PALPITE de empresa: lê o
// cliente na Asaas (GET /customers/{id}) e procura no cadastro pelo mesmo
// CPF/CNPJ ou e-mail, pela referência da cobrança (o checkout grava o id da
// empresa em externalReference) ou pela assinatura. É só palpite: nada é
// gravado aqui.
//
// vincularOrfao() é a ação de quem decide: grava asaas_customer_id na empresa
// (só se estiver vazio) e company_id no registro — e nos outros registros sem
// loja do MESMO cliente da Asaas, que são a mesma decisão. Não mexe em
// billing_status nem em datas de pagamento.
// ============================================================
'use strict';

const pool = require('../config/database');
const cliente = require('./asaasClient');
const AppError = require('../errors/AppError');
const { NOME, TELEFONE, PAGAMENTO_ASAAS: P } = require('./painelBlocos/_base');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const soDigitos = (v) => String(v || '').replace(/[^0-9]/g, '');
const minusculo = (v) => String(v || '').trim().toLowerCase();
const DOC_SQL = `regexp_replace(COALESCE(c.cnpj, ''), '[^0-9]', '', 'g')`;

async function lerClientes(asaas, ids) {
  const clientes = new Map();
  let disponivel = true;
  for (const id of ids) {
    try {
      const c = await asaas('GET', '/customers/' + encodeURIComponent(id));
      clientes.set(id, c && c.id ? {
        nome: c.name || null,
        email: c.email || null,
        cpf_cnpj: c.cpfCnpj || null,
        telefone: c.mobilePhone || c.phone || null,
        referencia: c.externalReference || null,
      } : null);
    } catch (err) {
      disponivel = false;
      clientes.set(id, null);
      console.warn('[asaas] cliente ' + id + ' não pôde ser lido: ' + err.message);
    }
  }
  return { clientes, disponivel };
}

async function listarOrfaos({ db = pool, asaas = cliente.asaas, limite = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT id, event, processed_at,
            ${P}->>'id' AS pagamento_id,
            ${P}->>'customer' AS cliente_asaas,
            ${P}->>'subscription' AS assinatura,
            ${P}->>'externalReference' AS referencia,
            ${P}->>'dueDate' AS vencimento,
            ${P}->>'paymentDate' AS pago_em,
            ${P}->>'billingType' AS forma,
            NULLIF(${P}->>'value', '')::numeric AS valor
       FROM webhook_logs
      WHERE provider = 'asaas' AND company_id IS NULL
      ORDER BY processed_at DESC
      LIMIT $1`,
    [limite]
  );
  const logs = rows || [];
  if (!logs.length) return { total: 0, asaas_disponivel: true, orfaos: [] };

  const { clientes, disponivel } = await lerClientes(
    asaas, [...new Set(logs.map((l) => l.cliente_asaas).filter(Boolean))]
  );

  const docs = new Set();
  const emails = new Set();
  const refs = new Set();
  const assinaturas = new Set();
  for (const l of logs) {
    const c = clientes.get(l.cliente_asaas);
    if (c && soDigitos(c.cpf_cnpj)) docs.add(soDigitos(c.cpf_cnpj));
    if (c && minusculo(c.email)) emails.add(minusculo(c.email));
    for (const r of [l.referencia, c && c.referencia]) if (UUID.test(r || '')) refs.add(r.toLowerCase());
    if (l.assinatura) assinaturas.add(l.assinatura);
  }

  let candidatas = [];
  if (docs.size || emails.size || refs.size || assinaturas.size) {
    ({ rows: candidatas } = await db.query(
      `SELECT c.id AS company_id,
              ${NOME} AS nome,
              ${TELEFONE} AS telefone,
              c.billing_status::text AS status,
              c.asaas_customer_id,
              c.asaas_subscription_id,
              ${DOC_SQL} AS doc,
              lower(COALESCE(c.email, '')) AS email,
              lower(COALESCE(u.email, '')) AS email_dono
         FROM companies c
         LEFT JOIN users u ON u.id = c.owner_id
        WHERE (${DOC_SQL} <> '' AND ${DOC_SQL} = ANY($1::text[]))
           OR lower(c.email) = ANY($2::text[])
           OR lower(u.email) = ANY($2::text[])
           OR c.id::text = ANY($3::text[])
           OR c.asaas_subscription_id = ANY($4::text[])`,
      [[...docs], [...emails], [...refs], [...assinaturas]]
    ));
  }

  const orfaos = logs.map((l) => {
    const c = clientes.get(l.cliente_asaas) || null;
    const doc = c ? soDigitos(c.cpf_cnpj) : '';
    const email = c ? minusculo(c.email) : '';
    const referencias = [l.referencia, c && c.referencia].filter((r) => UUID.test(r || '')).map((r) => r.toLowerCase());
    const palpites = [];
    for (const e of candidatas || []) {
      const motivos = [];
      if (doc && e.doc === doc) motivos.push('cpf_cnpj');
      if (email && (e.email === email || e.email_dono === email)) motivos.push('email');
      if (referencias.includes(String(e.company_id).toLowerCase())) motivos.push('referencia');
      if (l.assinatura && e.asaas_subscription_id === l.assinatura) motivos.push('assinatura');
      if (!motivos.length) continue;
      palpites.push({
        company_id: e.company_id,
        nome: e.nome,
        telefone: e.telefone || null,
        status: e.status,
        motivos,
        // preenchido = a empresa já aponta para OUTRO cliente da Asaas
        asaas_customer_id: e.asaas_customer_id || null,
      });
    }
    palpites.sort((x, y) => y.motivos.length - x.motivos.length);
    return {
      log_id: l.id,
      evento: l.event,
      quando: l.processed_at,
      valor: l.valor === null || l.valor === undefined ? null : Math.round(Number(l.valor) * 100) / 100,
      vencimento: l.vencimento || null,
      pago_em: l.pago_em || null,
      forma: l.forma || null,
      pagamento_id: l.pagamento_id || null,
      cliente_asaas: l.cliente_asaas || null,
      assinatura: l.assinatura || null,
      cliente: c,
      palpites,
    };
  });

  return { total: orfaos.length, asaas_disponivel: disponivel, orfaos };
}

async function vincularOrfao({ db = pool, logId, companyId: informado, userId = null } = {}) {
  const companyId = typeof informado === 'string' ? informado.toLowerCase() : informado;
  if (!UUID.test(logId || '')) throw new AppError('Registro não encontrado', 404);
  if (!UUID.test(companyId || '')) throw new AppError('company_id deve ser o id de uma empresa', 400);

  const { rows: logs } = await db.query(
    `SELECT id, company_id, event, ${P}->>'customer' AS cliente_asaas
       FROM webhook_logs
      WHERE id = $1 AND provider = 'asaas'`,
    [logId]
  );
  const log = logs && logs[0];
  if (!log) throw new AppError('Registro não encontrado', 404);
  if (log.company_id && log.company_id !== companyId) {
    throw new AppError('Este pagamento já está vinculado a outra empresa', 409);
  }

  const { rows: empresas } = await db.query(
    `SELECT c.id, ${NOME} AS nome, c.asaas_customer_id FROM companies c WHERE c.id = $1`,
    [companyId]
  );
  const empresa = empresas && empresas[0];
  if (!empresa) throw new AppError('Empresa não encontrada', 404);

  // O cliente da Asaas só entra no cadastro se o campo estiver vazio: trocar
  // um que já existe mudaria de quem são os próximos pagamentos.
  let clienteGravado = false;
  if (log.cliente_asaas && !empresa.asaas_customer_id) {
    const upd = await db.query(
      `UPDATE companies
          SET asaas_customer_id = $1, updated_at = NOW()
        WHERE id = $2 AND (asaas_customer_id IS NULL OR asaas_customer_id = '')`,
      [log.cliente_asaas, companyId]
    );
    clienteGravado = !!(upd && upd.rowCount);
  }

  // Este registro e os outros sem loja do mesmo cliente da Asaas.
  const vinc = await db.query(
    `UPDATE webhook_logs
        SET company_id = $1
      WHERE provider = 'asaas' AND company_id IS NULL
        AND (id = $2 OR ($3::text IS NOT NULL AND ${P}->>'customer' = $3::text))`,
    [companyId, logId, log.cliente_asaas || null]
  );

  const resultado = {
    log_id: logId,
    company_id: companyId,
    nome: empresa.nome,
    cliente_asaas: log.cliente_asaas || null,
    cliente_gravado: clienteGravado,
    cliente_da_empresa: clienteGravado ? log.cliente_asaas : (empresa.asaas_customer_id || null),
    logs_vinculados: (vinc && vinc.rowCount) || 0,
  };

  await db.query(
    `INSERT INTO admin_audit_log (staff_user_id, company_id, action, payload, reason)
     VALUES ($1, $2, 'asaas_orfao_vinculado', $3, NULL)`,
    [userId, companyId, JSON.stringify(resultado)]
  );

  return resultado;
}

module.exports = { listarOrfaos, vincularOrfao };
