// ============================================================
// AURA. -- S5: Customers CRUD
// Plan limits: essencial=1000, negocio=5000, expansao=unlimited
// Plan comes from req.user.plan (JWT token), not req.company
//
// MULTICNPJ Sessao 2 Onda 2.3 (03/05/2026): clientes sao
// owner-scoped. GET / lista clientes de TODAS as empresas do
// mesmo dono. POST / continua criando na empresa atual (req.params.id),
// mas o plan limit conta o owner inteiro. PATCH/DELETE permitem
// editar cliente "registrado em outra loja" do mesmo dono.
//
// FEAT 05/05/2026: GET / agora retorna credit_balance (saldo de
// crediario na empresa onde o cliente foi cadastrado), via LEFT JOIN
// com a view customer_credit_balances. Crediario e por (customer_id,
// company_id), entao cada cliente exibe o saldo da sua propria loja.
//
// 13/05/2026: removido gate global requirePlan('negocio'+) que
// bloqueava TODAS as rotas (inclusive GET) para o plano Essencial.
// O plano Essencial tem limite de 1000 clientes, ja aplicado no
// POST via getPlanLimit. GET de listagem nunca deve ser bloqueado
// (armadilha_plan_limit_listagem). requirePlan era overly broad.
//
// 06/06/2026: adicionado parseBirthDate para aceitar tanto
// dd/mm/yyyy (formato do DateInput do app) quanto yyyy-mm-dd,
// validar e retornar null se invalido. Evita o erro Postgres
// "date/time field value out of range" quando o FE enviava
// valores como "1984-95-97" (conversao mal-feita de dd/mm/yyyy).
//
// 29/08/2026 (QA de usabilidade): GET / aceita ?sort=recent. O seletor de
// cliente do PDV abria em ordem alfabetica (Abbey, Abdel, Adamo...), a
// ordenacao menos util possivel com o cliente na frente do balcao. O
// default continua sendo o alfabetico -- a tela de Clientes e uma agenda,
// onde procurar pelo nome faz sentido; o balcao e que precisa de recencia.
//
// Ordenar no BANCO, nao no app: o app so recebe a primeira pagina, entao
// ordenar o que chegou colocaria no topo o cliente mais recente ENTRE OS
// PRIMEIROS ALFABETICAMENTE, nao o mais recente de verdade.
//
// Justificativa em src/utils/ownerScope.js.
//
// 16/09/2026 (Fase 1 · perfil do cliente, migration 341): PATCH aceita
// tags, preferences (substitui o objeto inteiro) e important_dates; cpf_cnpj
// passa a ser validado (digito verificador; vazio apaga) e gravado so com
// digitos. POST e PATCH mantem phone_e164 (src/utils/phone.js) -- o trigger
// da 341 faz o mesmo nos outros caminhos de escrita. Antes da migration as
// colunas novas nao existem: 42703 -> cache module-level e a escrita segue
// sem elas, devolvendo ignored_fields (armadilha 1).
//
// 09/11/2026 (Endereco do cliente para entrega, parte 1): POST e PATCH
// aceitam zip_code, street, number, complement, neighborhood, city, state
// e address_reference (migration 433); GET devolve os mesmos campos mais
// has_address (rua ou CEP + numero + cidade), que o seletor do Caixa usa
// no selo "sem endereco". Canonicos: number e zip_code -- address_number e
// postal_code (073) estao vazios e ficam como estao. Regras em
// src/services/customerAddress.js. O cliente e do DONO (owner-scope): o
// endereco gravado de qualquer loja vale em todas. Sem a 433 aplicada, o
// address_reference cai fora como o perfil da 341 (ignored_fields).
//
// 23/11/2026 (Otica, cadastro completo -- p-204): POST e PATCH aceitam rg,
// gender e occupation (regras em src/services/customerDadosCompletos.js);
// occupation e da migration 463 e cai fora como o address_reference
// (ignored_fields) enquanto ela nao for aplicada. O GET de clientes avisa
// no topo `customer_fields` com o que o POST/PATCH de fato gravam -- o app
// so mostra os campos quando o aviso vem. O POST passa a validar cpf_cnpj
// como o PATCH (digito verificador, so digitos). A LISTA devolve CPF e RG
// MASCARADOS (com docs_masked: true); o valor inteiro sai so no novo
// GET /:cid, que a ficha aberta e o formulario de edicao usam.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');
const { toPhoneE164BR } = require('../utils/phone');
const { normalizarTelefone, mesmoTelefone } = require('../utils/telefone');
const { parseCpfCnpjInput } = require('../utils/cpfCnpj');
const { parseTags, parsePreferences, parseImportantDates } = require('../services/customerProfileFields');
const { attachProfessionalsToCustomers } = require('../services/matconProfessionals');
const {
  parseCustomerAddress, hasDeliveryAddress, addressFromRow, isMissingReferenceColumn,
} = require('../services/customerAddress');
const {
  parseDadosCompletos, isMissingOccupationColumn, mascararDocumento, customerFieldsAceitos, ocupacao,
} = require('../services/customerDadosCompletos');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Colunas da migration 341. null = ainda nao sabemos; false = 42703 visto.
let profileColumnsAvailable = null;
// Coluna da migration 433 (address_reference). Mesma ideia.
let referenceColumnAvailable = null;
// Coluna da migration 463 (occupation): cache em customerDadosCompletos.js
// (ocupacao.get/set), compartilhado com o /me/customers.
function _resetProfileColumnsCache() {
  profileColumnsAvailable = null; referenceColumnAvailable = null; ocupacao.reset();
}

/**
 * Roda a query e, se faltar uma coluna opcional (433 ou 463), marca o cache
 * e tenta de novo sem ela. buildSql le os caches na hora de montar o SQL.
 */
async function queryComColunasOpcionais(buildSql, params) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const r = await db.query(buildSql(), params);
      if (referenceColumnAvailable === null) referenceColumnAvailable = true;
      if (ocupacao.get() === null) ocupacao.set(true);
      return r;
    } catch (e) {
      if (referenceColumnAvailable !== false && isMissingReferenceColumn(e)) {
        referenceColumnAvailable = false;
        continue;
      }
      if (ocupacao.get() !== false && isMissingOccupationColumn(e)) {
        ocupacao.set(false);
        continue;
      }
      throw e;
    }
  }
  return db.query(buildSql(), params);
}

const colReferencia = (a) => (referenceColumnAvailable !== false ? `${a}address_reference` : 'NULL::text AS address_reference');
const colOcupacao = (a) => (ocupacao.get() !== false ? `${a}occupation` : 'NULL::text AS occupation');

function getPlanLimit(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 5000;
    default:              return 1000; // essencial / trial / unknown
  }
}

/**
 * Normaliza birth_date para yyyy-mm-dd antes de mandar ao Postgres.
 * Aceita:
 *   - dd/mm/yyyy  (formato do DateInput do app)
 *   - yyyy-mm-dd  (ISO, ja correto)
 * Retorna null se vazio, invalido ou fora de range razoavel.
 */
function parseBirthDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let year, month, day;

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    // dd/mm/yyyy
    [day, month, year] = s.split('/').map(Number);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // yyyy-mm-dd
    [year, month, day] = s.split('-').map(Number);
  } else {
    return null;
  }

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > new Date().getFullYear()) return null;

  // Validacao real da data (ex: 31/02 seria invalido)
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}


/**
 * ORDER BY da listagem de clientes.
 *
 * 'recent' = atendidos por ultimo primeiro. NULLS LAST porque quem nunca
 * comprou nao pode ocupar o topo do balcao; o desempate alfabetico deixa
 * o bloco dos "sem compra" navegavel. last_purchase_at e confiavel desde
 * a migration 311 (antes era NOW() fixo, que mentia em cancelamento e em
 * venda retroativa).
 *
 * Whitelist fechada: o valor entra concatenado no SQL.
 */
function buildOrderBy(sort, alias) {
  const a = alias ? alias + '.' : '';
  switch (String(sort || '').toLowerCase()) {
    case 'recent':
      return `ORDER BY ${a}last_purchase_at DESC NULLS LAST, ${a}name ASC`;
    default:
      return `ORDER BY ${a}name ASC`;
  }
}

/**
 * Linha do banco -> cliente da API. Lista (docsInteiros=false): CPF/CNPJ e
 * RG mascarados. Ficha (GET /:cid, docsInteiros=true): valor inteiro.
 */
function linhaParaCliente(r, { docsInteiros = false } = {}) {
  return {
    id: r.id, name: r.name || '', email: r.email || '', phone: r.phone || '',
    // 23/11/2026 (p-204): documento mascarado na lista; inteiro no GET /:cid.
    cpf_cnpj: docsInteiros ? (r.cpf_cnpj || '') : mascararDocumento(r.cpf_cnpj),
    rg: r.rg ? (docsInteiros ? r.rg : mascararDocumento(r.rg)) : null,
    gender: r.gender || null,
    occupation: r.occupation || null,
    docs_masked: !docsInteiros,
    birthday: r.birth_date ? new Date(r.birth_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '',
    birth_date: r.birth_date, instagram: r.instagram_handle || '', instagram_handle: r.instagram_handle || '',
    total_spent: parseFloat(r.total_spent) || 0, totalSpent: parseFloat(r.total_spent) || 0,
    visits: parseInt(r.total_purchases) || 0, visit_count: parseInt(r.total_purchases) || 0,
    last_purchase: r.last_purchase_at,
    // Alias explicito: o nome da coluna, pro app nao ter que adivinhar
    // que 'last_purchase' e um timestamp. Aditivo -- last_purchase fica.
    last_purchase_at: r.last_purchase_at,
    first_visit: r.first_purchase_at, first_purchase_at: r.first_purchase_at,
    notes: r.notes || '', is_active: r.is_active !== false, rating: null, created_at: r.created_at,
    // Multi-CNPJ: empresa onde foi cadastrado (FE mostra badge se owner tem 2+ lojas)
    company_id: r.company_id,
    company_name: r.company_trade || r.company_legal || 'Empresa',
    // Crediario: saldo > 0 = cliente deve. Saldo na empresa onde ele foi cadastrado.
    credit_balance: parseFloat(r.credit_balance) || 0,
    // 09/11/2026: endereco para entrega + has_address (selo do Caixa).
    ...addressFromRow(r),
  };
}

// GET / -- list customers (owner-scoped: todas as empresas do owner)
router.get('/', async (req, res) => {
  const companyId = req.params.id;
  const planLimit = getPlanLimit(req.user?.plan);
  const limit = Math.min(parseInt(req.query.limit) || planLimit, planLimit);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search;
  const orderBy = buildOrderBy(req.query.sort, 'c');

  try {
    // MULTICNPJ Onda 2.3: expande pra todas as empresas do owner
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    if (ownerCompanyIds.length === 0) {
      return res.json({
        customers: [], total: 0, limit, offset, plan_limit: planLimit,
        customer_fields: customerFieldsAceitos(),
      });
    }

    let where = 'WHERE c.company_id = ANY($1)';
    const params = [ownerCompanyIds];
    if (search) {
      where += ` AND (c.name ILIKE $${params.length + 1} OR c.email ILIKE $${params.length + 1} OR c.phone ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    const countRes = await db.query(`SELECT COUNT(*) AS total FROM customers c ${where}`, params);

    // JOIN companies pra trazer nome da loja onde foi registrado (info pra UI)
    // LEFT JOIN customer_credit_balances pra trazer saldo do crediario.
    // Match por (customer_id, company_id) pra respeitar o escopo da view.
    // 29/08/2026: o saldo do crediario e ENFEITE nesta tela; a lista de
    // clientes nao pode morrer junto com ele. A view
    // customer_credit_balances some em deploy parcial / banco restaurado
    // sem as migrations de crediario, e ai um 42P01 virava 500 -> a tela
    // inteira em branco com "Total de clientes: 0" (armadilha 10 do
    // CLAUDE.md). Sem a view, lista sem o saldo.
    const selectCustomers = (comCredito) => `
      SELECT c.id, c.name, c.cpf_cnpj, c.email, c.phone, c.birth_date, c.instagram_handle,
             c.total_purchases, c.total_spent, c.last_purchase_at, c.first_purchase_at,
             c.notes, c.is_active, c.created_at, c.company_id,
             c.zip_code, c.street, c.number, c.complement, c.neighborhood, c.city, c.state,
             ${colReferencia('c.')},
             c.rg, c.gender, ${colOcupacao('c.')},
             comp.trade_name AS company_trade, comp.legal_name AS company_legal,
             ${comCredito ? 'COALESCE(cb.balance, 0)' : '0'} AS credit_balance
        FROM customers c
        JOIN companies comp ON comp.id = c.company_id
        ${comCredito ? `LEFT JOIN customer_credit_balances cb
          ON cb.customer_id = c.id AND cb.company_id = c.company_id` : ''}
       ${where}
       ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    // Sem a 433, o address_reference sai da lista e ela segue (o resto do
    // endereco ja existe desde a 001/073). Sem a 463, o mesmo com occupation.
    const queryList = (buildSql) => queryComColunasOpcionais(buildSql, [...params, limit, offset]);

    let dataRes;
    try {
      dataRes = await queryList(() => selectCustomers(true));
    } catch (creditErr) {
      if (creditErr.code !== '42P01' && creditErr.code !== '42703') throw creditErr;
      console.warn('[customers] customer_credit_balances indisponivel, listando sem saldo:', creditErr.code);
      dataRes = await queryList(() => selectCustomers(false));
    }

    const customers = dataRes.rows.map(r => linhaParaCliente(r));

    // 23/09/2026 (Matcon M3): com Matcon + clube do profissional ligados,
    // cada cliente ganha `professional: {id, trade, points_balance,
    // referrals_count} | null` (parceiro DESTA loja). Loja sem o modulo nao
    // ganha a chave. Uma query extra so com a pagina; nunca derruba a lista.
    await attachProfessionalsToCustomers(companyId, customers);

    res.json({
      customers,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit, offset,
      plan_limit: planLimit,
      customer_fields: customerFieldsAceitos(),
    });
  } catch (err) {
    console.error('[customers] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// GET /:cid -- a ficha de UM cliente, com CPF/CNPJ e RG inteiros (p-204).
// Owner-scoped como o PATCH: o cliente cadastrado em outra loja do mesmo
// dono abre aqui tambem. So uuid: /ranking, /birthdays e /retention (crm.js,
// retention.js) moram no mesmo prefixo e seguem para os routers deles.
router.get('/:cid', async (req, res, next) => {
  const { id: companyId, cid } = req.params;
  if (!UUID_RE.test(String(cid || ''))) return next();
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    const sql = () => `
      SELECT c.id, c.name, c.cpf_cnpj, c.email, c.phone, c.birth_date, c.instagram_handle,
             c.total_purchases, c.total_spent, c.last_purchase_at, c.first_purchase_at,
             c.notes, c.is_active, c.created_at, c.company_id,
             c.zip_code, c.street, c.number, c.complement, c.neighborhood, c.city, c.state,
             ${colReferencia('c.')},
             c.rg, c.gender, ${colOcupacao('c.')},
             comp.trade_name AS company_trade, comp.legal_name AS company_legal
        FROM customers c
        JOIN companies comp ON comp.id = c.company_id
       WHERE c.id = $1 AND c.company_id = ANY($2)`;
    const { rows } = await queryComColunasOpcionais(sql, [cid, ownerCompanyIds]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    // credit_balance fica de fora da ficha: o saldo tem rota propria (credito).
    const customer = linhaParaCliente(rows[0], { docsInteiros: true });
    delete customer.credit_balance;
    res.json({ customer, customer_fields: customerFieldsAceitos() });
  } catch (err) {
    console.error('[customers] get error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar cliente' });
  }
});

// POST / -- create customer (na empresa atual, com plan limit do OWNER inteiro)
router.post('/', async (req, res) => {
  const companyId = req.params.id;
  const { name, email, notes, birthday, birth_date, instagram, instagram_handle, cpf_cnpj } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name e obrigatorio' });
  }
  // 10/11/2026: telefone com +55 perde o 55 antes de gravar; com digitos a
  // mais, 400 com mensagem gentil (nunca corta). utils/telefone.
  const tel = normalizarTelefone(req.body.phone);
  if (!tel.ok) return res.status(400).json({ error: tel.error, code: tel.code, field: 'phone' });
  const phone = tel.valor;
  // Endereco: tudo opcional; se vier, CEP com 8 digitos e UF com 2 letras.
  const addr = parseCustomerAddress(req.body);
  if (!addr.ok) return res.status(400).json({ error: addr.error, field: addr.field });
  // 23/11/2026 (p-204): CPF validado como no PATCH (digito verificador, so
  // digitos). Antes ia cru para o banco -- importacao e outros clientes da
  // API gravavam qualquer coisa.
  const doc = parseCpfCnpjInput(cpf_cnpj);
  if (!doc.ok) return res.status(400).json({ error: doc.error, field: 'cpf_cnpj' });
  // RG, sexo e profissao (cadastro completo da otica). Ausente nao grava.
  const extras = parseDadosCompletos(req.body);
  if (!extras.ok) return res.status(400).json({ error: extras.error, field: extras.field });

  // MULTICNPJ Onda 2.3: plan limit conta TODOS os clientes do owner,
  // alinhado com a decisao de lista unica.
  try {
    const planLimit = getPlanLimit(req.user?.plan);
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    if (ownerCompanyIds.length > 0) {
      const countRes = await db.query(
        'SELECT COUNT(*) AS total FROM customers WHERE company_id = ANY($1)',
        [ownerCompanyIds]
      );
      const current = parseInt(countRes.rows[0]?.total) || 0;
      if (current >= planLimit) {
        return res.status(403).json({
          error: `Limite de clientes atingido para o seu plano (${planLimit} registros). Faca upgrade para continuar.`,
          limit: planLimit, current,
        });
      }
    }
  } catch (err) {
    console.error('[customers] count check error:', err.message);
  }

  const finalBirthDate = parseBirthDate(birth_date || birthday);
  const finalInstagram = instagram_handle || instagram || null;

  try {
    const base = [
      ['company_id', companyId], ['name', String(name).trim()], ['email', email || null],
      ['phone', phone || null], ['notes', notes || null], ['birth_date', finalBirthDate],
      ['instagram_handle', finalInstagram], ['cpf_cnpj', doc.value],
    ];
    for (const k of ['rg', 'gender']) {
      if (k in extras.values) base.push([k, extras.values[k]]);
    }
    const pedeOcupacao = 'occupation' in extras.values;
    const addrCols = Object.entries(addr.values);
    const pedeReferencia = addrCols.some(([k]) => k === 'address_reference');
    const ignoredFields = [];
    let withProfile = profileColumnsAvailable !== false;
    let withRef = referenceColumnAvailable !== false;
    if (pedeReferencia && !withRef) ignoredFields.push('address_reference');
    let withOcc = ocupacao.get() !== false;
    if (pedeOcupacao && !withOcc) ignoredFields.push('occupation');

    // Ate 4 tentativas: sem a 433 cai o address_reference; sem a 463 cai o
    // occupation; sem a 341 cai o phone_e164 (qualquer outro 42703, como
    // era antes).
    let result;
    for (let tentativa = 0; tentativa < 4 && !result; tentativa++) {
      const cols = [...base];
      if (withProfile) cols.push(['phone_e164', toPhoneE164BR(phone)]);
      for (const [k, v] of addrCols) {
        if (k === 'address_reference' && !withRef) continue;
        cols.push([k, v]);
      }
      if (pedeOcupacao && withOcc) cols.push(['occupation', extras.values.occupation]);
      try {
        result = await db.query(
          `INSERT INTO customers (${cols.map(c => c[0]).join(', ')})
           VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})
           RETURNING *`,
          cols.map(c => c[1])
        );
        if (withProfile) profileColumnsAvailable = true;
        if (withRef && pedeReferencia) referenceColumnAvailable = true;
        if (withOcc && pedeOcupacao) ocupacao.set(true);
      } catch (e) {
        if (e.code !== '42703') throw e;
        if (withRef && pedeReferencia && isMissingReferenceColumn(e)) {
          withRef = false;
          referenceColumnAvailable = false; // migration 433 ainda nao aplicada
          ignoredFields.push('address_reference');
          continue;
        }
        if (withOcc && pedeOcupacao && isMissingOccupationColumn(e)) {
          withOcc = false;
          ocupacao.set(false); // migration 463 ainda nao aplicada
          ignoredFields.push('occupation');
          continue;
        }
        if (withProfile) {
          withProfile = false;
          profileColumnsAvailable = false; // migration 341 ainda nao aplicada
          continue;
        }
        throw e;
      }
    }
    const row = result.rows[0];
    // has_address so quando o endereco veio no body (contrato antigo intacto).
    const out = addrCols.length ? { ...row, has_address: hasDeliveryAddress(row) } : { ...row };
    if (ignoredFields.length) out.ignored_fields = ignoredFields;
    res.status(201).json(out);
  } catch (err) {
    console.error('[customers] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar cliente' });
  }
});

// PATCH /:cid -- update customer (owner-scoped: pode editar de qualquer loja do owner)
router.patch('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;
  const body = req.body || {};
  // 10/11/2026: telefone com +55 perde o 55 antes de gravar; com digitos a
  // mais, 400 (nunca corta). Excecao: o formulario de edicao reenvia o
  // telefone que JA estava gravado (cadastro antigo, importacao) -- esse
  // segue como esta, para editar o nome nao virar erro de telefone.
  if (body.phone !== undefined) {
    const tel = normalizarTelefone(body.phone);
    if (tel.ok) {
      body.phone = tel.valor;
    } else {
      let atual = null;
      try {
        const { rows } = await db.query('SELECT phone FROM customers WHERE id = $1', [cid]);
        atual = rows && rows[0] ? rows[0].phone : null;
      } catch (_) { atual = null; }
      if (atual == null || !mesmoTelefone(atual, body.phone)) {
        return res.status(400).json({ error: tel.error, code: tel.code, field: 'phone' });
      }
    }
  }
  const fieldMap = {
    name: 'name', email: 'email', phone: 'phone', notes: 'notes',
    cpf_cnpj: 'cpf_cnpj', birth_date: 'birth_date', birthday: 'birth_date',
    instagram: 'instagram_handle', instagram_handle: 'instagram_handle', is_active: 'is_active',
  };
  // { col, val, cast, profile, field } -- profile = coluna da migration 341
  const sets = [];
  const seen = new Set();

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (body[bodyKey] !== undefined && !seen.has(dbCol)) {
      let val = body[bodyKey];
      // Sanitiza datas antes de mandar ao Postgres
      if (dbCol === 'birth_date') val = parseBirthDate(val);
      if (dbCol === 'cpf_cnpj') {
        const doc = parseCpfCnpjInput(val);
        if (!doc.ok) return res.status(400).json({ error: doc.error, field: 'cpf_cnpj' });
        val = doc.value;
      }
      sets.push({ col: dbCol, val });
      seen.add(dbCol);
    }
  }
  if (body.phone !== undefined) {
    sets.push({ col: 'phone_e164', val: toPhoneE164BR(body.phone), profile: true });
  }
  if (body.tags !== undefined) {
    const r = parseTags(body.tags);
    if (!r.ok) return res.status(400).json({ error: r.error, field: 'tags' });
    sets.push({ col: 'tags', val: r.value, cast: 'text[]', profile: true, field: 'tags' });
  }
  if (body.preferences !== undefined) {
    const r = parsePreferences(body.preferences);
    if (!r.ok) return res.status(400).json({ error: r.error, field: 'preferences' });
    sets.push({ col: 'preferences', val: JSON.stringify(r.value), cast: 'jsonb', profile: true, field: 'preferences' });
  }
  if (body.important_dates !== undefined) {
    const r = parseImportantDates(body.important_dates);
    if (!r.ok) return res.status(400).json({ error: r.error, field: 'important_dates' });
    sets.push({ col: 'important_dates', val: JSON.stringify(r.value), cast: 'jsonb', profile: true, field: 'important_dates' });
  }

  // 09/11/2026: endereco para entrega. Campo ausente nao mexe; '' apaga.
  const addr = parseCustomerAddress(body);
  if (!addr.ok) return res.status(400).json({ error: addr.error, field: addr.field });
  for (const [col, val] of Object.entries(addr.values)) {
    sets.push(col === 'address_reference' ? { col, val, ref: true, field: col } : { col, val });
  }
  // 23/11/2026 (p-204): RG, sexo e profissao. Ausente nao mexe; '' apaga.
  const extras = parseDadosCompletos(body);
  if (!extras.ok) return res.status(400).json({ error: extras.error, field: extras.field });
  for (const [col, val] of Object.entries(extras.values)) {
    sets.push(col === 'occupation' ? { col, val, occ: true, field: col } : { col, val });
  }

  if (sets.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  const runUpdate = (ownerCompanyIds, withProfile, withRef, withOcc) => {
    const active = sets.filter(x => (withProfile || !x.profile) && (withRef || !x.ref) && (withOcc || !x.occ));
    if (!active.length) return null;
    const values = [];
    const parts = active.map((x) => {
      values.push(x.val);
      return `${x.col} = $${values.length}${x.cast ? '::' + x.cast : ''}`;
    });
    parts.push('updated_at = NOW()');
    values.push(cid, ownerCompanyIds);
    return db.query(
      `UPDATE customers SET ${parts.join(', ')} WHERE id = $${values.length - 1} AND company_id = ANY($${values.length}) RETURNING *`,
      values
    );
  };

  try {
    // MULTICNPJ Onda 2.3: pode editar cliente "de outra loja" do mesmo owner
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);

    const hasProfile = sets.some(x => x.profile);
    const ignoredFields = [];
    // Sem a 433, o address_reference cai fora e o resto grava.
    const hasRef = sets.some(x => x.ref);
    let withRef = hasRef && referenceColumnAvailable !== false;
    if (hasRef && !withRef) ignoredFields.push('address_reference');
    // Sem a 463, o occupation cai fora do mesmo jeito.
    const hasOcc = sets.some(x => x.occ);
    let withOcc = hasOcc && ocupacao.get() !== false;
    if (hasOcc && !withOcc) ignoredFields.push('occupation');
    const tryUpdate = async (withProfile) => {
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        try {
          const r = await runUpdate(ownerCompanyIds, withProfile, withRef, withOcc);
          if (withRef) referenceColumnAvailable = true;
          if (withOcc) ocupacao.set(true);
          return r;
        } catch (e) {
          if (withRef && isMissingReferenceColumn(e)) {
            withRef = false;
            referenceColumnAvailable = false; // migration 433 ainda nao aplicada
            ignoredFields.push('address_reference');
            continue;
          }
          if (withOcc && isMissingOccupationColumn(e)) {
            withOcc = false;
            ocupacao.set(false); // migration 463 ainda nao aplicada
            ignoredFields.push('occupation');
            continue;
          }
          throw e;
        }
      }
      return runUpdate(ownerCompanyIds, withProfile, withRef, withOcc);
    };
    let result = null;
    if (hasProfile && profileColumnsAvailable !== false) {
      try {
        result = await tryUpdate(true);
        profileColumnsAvailable = true;
      } catch (e) {
        if (e.code !== '42703') throw e;
        profileColumnsAvailable = false; // migration 341 ainda nao aplicada
      }
    }
    if (!result) {
      if (hasProfile) ignoredFields.push(...sets.filter(x => x.profile && x.field).map(x => x.field));
      result = await tryUpdate(false);
      if (!result) {
        return res.status(409).json({
          error: 'Campos do perfil ainda indisponiveis (migration 341 pendente)',
          code: 'PROFILE_COLUMNS_MISSING',
          ignored_fields: ignoredFields,
        });
      }
    }
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    // has_address so quando o endereco veio no body (contrato antigo intacto).
    const row = Object.keys(addr.values).length
      ? { ...result.rows[0], has_address: hasDeliveryAddress(result.rows[0]) }
      : result.rows[0];
    res.json(ignoredFields.length ? { ...row, ignored_fields: ignoredFields } : row);
  } catch (err) {
    console.error('[customers] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
});

// DELETE /:cid (owner-scoped tambem)
router.delete('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;
  try {
    const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
    const result = await db.query(
      'DELETE FROM customers WHERE id = $1 AND company_id = ANY($2) RETURNING id, name',
      [cid, ownerCompanyIds]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
    res.json({ deleted: true, id: cid, name: result.rows[0].name });
  } catch (err) {
    console.error('[customers] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao deletar cliente' });
  }
});

module.exports = router;
module.exports._resetProfileColumnsCache = _resetProfileColumnsCache;
