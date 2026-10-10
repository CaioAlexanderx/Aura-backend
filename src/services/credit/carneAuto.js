// ============================================================
// AURA. — Crediário: carnê automático (10/10/2026)
//
// Decisão de produto: cada venda no crediário feita no Caixa nasce como um
// carnê novo (credit_accounts), com os itens e as parcelas daquela venda. Até
// aqui NENHUMA venda do Caixa caía em carnê (482 débitos source='sale', zero
// com account_id): tudo ia para o grupo "Sem carnê", e a ficha não conseguia
// mostrar "esta compra, estas parcelas".
//
// Nome automático: "Compra de DD/MM" (dia em America/Sao_Paulo). Se o cliente
// já tem carnê ABERTO com o mesmo nome, vira "Compra de DD/MM (2)", "(3)"...
// O lançamento manual usa o mesmo motor com o prefixo "Lançamento".
//
// A criação roda DENTRO da transação da venda. No Postgres um erro dentro da
// transação aborta a transação inteira — um 42P01/42703 aqui (deploy parcial)
// derrubaria a venda. Por isso tudo passa por SAVEPOINT: deu errado, volta ao
// savepoint e a venda segue SEM carnê (cai no grupo "Sem carnê", como sempre
// foi). A venda nunca falha por causa do carnê.
// ============================================================
'use strict';

const SP_TZ = 'America/Sao_Paulo';

/**
 * Executa `fn` protegido por SAVEPOINT. Em erro, desfaz só o trecho e devolve
 * `fallback` — a transação de quem chamou continua utilizável.
 * `name` é texto fixo do código (nunca entrada do usuário).
 */
async function withSavepoint(client, name, fn, fallback) {
  // Sem o 4o argumento o fallback e null; passado explicitamente (inclusive
  // undefined) vale o que veio -- findCustomerCarne distingue "nao existe"
  // (null) de "nao deu para conferir" (undefined).
  const onFail = arguments.length < 4 ? null : fallback;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const out = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (e) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch (_) { /* transação já perdida: quem chamou vai saber */ }
    if (e && e.code !== '42P01' && e.code !== '42703') {
      console.warn(`[credit/carneAuto] ${name} falhou (segue sem):`, e.code || '', e.message);
    }
    return onFail;
  }
}

/**
 * "DD/MM" do dia em São Paulo.
 * @param {Date|string|null} value instante (Date/ISO) ou dia 'AAAA-MM-DD'.
 *        Dia puro NÃO passa por fuso: '2026-09-13' é 13/09, ponto. Vazio/torto = hoje.
 */
function carneDayLabel(value) {
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) return `${m[3]}/${m[2]}`;
  }
  let d = value instanceof Date ? value : (value ? new Date(value) : new Date());
  if (isNaN(d.getTime())) d = new Date();
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: SP_TZ, day: '2-digit', month: '2-digit' }).formatToParts(d);
  const dia = parts.find(p => p.type === 'day').value;
  const mes = parts.find(p => p.type === 'month').value;
  return `${dia}/${mes}`;
}

/**
 * Nome do carnê automático, sem colidir com os nomes já em uso.
 * @param {string} prefix 'Compra' | 'Lançamento'
 * @param {Date|string|null} date
 * @param {string[]} existingNames nomes dos carnês ABERTOS do cliente
 */
function autoCarneName(prefix, date, existingNames = []) {
  const base = `${prefix} de ${carneDayLabel(date)}`;
  return dedupeCarneName(base, existingNames);
}

/** `base`, ou `base (2)`, `base (3)`... o primeiro livre. Compara sem caixa/espaço. */
function dedupeCarneName(base, existingNames = []) {
  const usados = new Set((existingNames || []).map(n => String(n || '').trim().toLowerCase()));
  if (!usados.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const tentativa = `${base} (${i})`;
    if (!usados.has(tentativa.toLowerCase())) return tentativa;
  }
  return `${base} (${Date.now()})`;
}

/** Nomes dos carnês abertos do cliente que começam com `base` (para o sufixo). */
async function loadOpenNames(client, companyId, customerId, base) {
  const { rows } = await client.query(
    `SELECT name FROM credit_accounts
      WHERE company_id = $1 AND customer_id = $2 AND status = 'open'
        AND name ILIKE $3`,
    [companyId, customerId, base.replace(/[\\%_]/g, '\\$&') + '%']
  );
  return rows.map(r => r.name);
}

/**
 * Cria o carnê automático. Chamar DENTRO de uma transação.
 * @returns {Promise<{id:string, name:string}|null>} null = não deu (schema
 *          antigo ou qualquer erro): quem chamou segue sem carnê.
 */
async function createAutoCarne(client, { companyId, customerId, prefix = 'Compra', date = null }) {
  if (!companyId || !customerId) return null;
  return withSavepoint(client, 'carne_auto', async () => {
    const base = `${prefix} de ${carneDayLabel(date)}`;
    const name = dedupeCarneName(base, await loadOpenNames(client, companyId, customerId, base));
    const { rows } = await client.query(
      `INSERT INTO credit_accounts (company_id, customer_id, name, status)
       VALUES ($1, $2, $3, 'open') RETURNING id, name`,
      [companyId, customerId, name]
    );
    return rows[0] ? { id: rows[0].id, name: rows[0].name || name } : null;
  });
}

/**
 * Confere um carnê escolhido pela lojista (juntar a venda a um carnê que já
 * existe): tem de ser desta empresa, deste cliente e estar aberto.
 * @returns {Promise<{id:string,name:string,status:string}|null|undefined>}
 *          undefined = não deu para conferir (schema antigo); null = não existe.
 */
async function findCustomerCarne(client, { companyId, customerId, accountId }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(accountId || ''))) return null;
  return withSavepoint(client, 'carne_find', async () => {
    const { rows } = await client.query(
      `SELECT id, name, status FROM credit_accounts
        WHERE id = $1 AND company_id = $2 AND customer_id = $3`,
      [accountId, companyId, customerId]
    );
    return rows[0] || null;
  }, undefined);
}

/**
 * Carnê que ficou VAZIO sai da ficha (status 'cancelled').
 *
 * Com um carnê por compra, cancelar a venda (ou trocá-la de carnê na
 * unificação) deixava um carnê aberto sem débito e sem parcela — um fantasma
 * "Compra de 10/10 · R$ 0,00" na ficha. Vazio = nenhum lançamento no razão e
 * nenhuma parcela viva. Carnê que já recebeu pagamento ou tem parcela paga
 * NÃO é vazio e fica como está: o dinheiro entrou e precisa aparecer.
 *
 * Não apaga a linha: parcelas canceladas continuam apontando para ela.
 * @returns {Promise<string[]>} ids marcados
 */
async function cancelEmptyCarnes(client, { companyId, accountIds }) {
  const ids = [...new Set((accountIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return withSavepoint(client, 'carne_vazio', async () => {
    const { rows } = await client.query(
      `UPDATE credit_accounts a
          SET status = 'cancelled', updated_at = NOW()
        WHERE a.id = ANY($1::uuid[]) AND a.company_id = $2 AND a.status = 'open'
          AND NOT EXISTS (
            SELECT 1 FROM customer_credit_transactions t
             WHERE t.account_id = a.id AND t.company_id = a.company_id)
          AND NOT EXISTS (
            SELECT 1 FROM credit_installments i
             WHERE i.account_id = a.id AND i.company_id = a.company_id
               AND i.status <> 'cancelled')
        RETURNING a.id`,
      [ids, companyId]
    );
    return rows.map(r => r.id);
  }, []);
}

module.exports = {
  withSavepoint,
  carneDayLabel,
  autoCarneName,
  dedupeCarneName,
  createAutoCarne,
  findCustomerCarne,
  cancelEmptyCarnes,
};
