// ============================================================
// AURA. — Quem recebe um aviso no celular (04/11/2026)
//
// POR QUE EXISTE: o Web Push nasceu para o pedido da loja online e avisava
// TODO navegador inscrito da empresa, sem olhar quem é. Para "pedido novo"
// isso serve. Para "venda realizada" não: a vendedora que acabou de passar
// a venda receberia o aviso dela mesma, e a operadora de caixa saberia de
// cada venda das colegas. Aqui mora a regra de quem é o destinatário.
//
// A REGRA (uma só, para os três avisos novos):
//   - o dono da empresa (companies.owner_id);
//   - membro ativo com `permissions` NULL (acesso total, ex.: gerente);
//   - membro ativo com alguma das `chaves` pedidas ligada (ex.: financeiro);
//   + `incluir`: quem o evento quer avisar mesmo fora da regra (quem fez o
//     orçamento, por exemplo);
//   - `exceto`: quem causou o evento (não avisar a pessoa do que ela mesma
//     acabou de fazer).
//
// A semântica de `permissions` é a de routes/myPermissions.js: NULL = tudo
// liberado; chave presente só vale quando é `true`. A pseudo-regra do
// painel ("ausente = liberado") NÃO entra aqui de propósito: ela faria quase
// todo membro restrito receber cada venda.
//
// Cache de 60s por empresa+chaves, como o das preferências em lojaEvents:
// o disparo mora no caminho da venda e a alternativa seria um SELECT por
// venda. Falha de leitura devolve só o dono — nunca cala o aviso inteiro.
// ============================================================
'use strict';

const db = require('../config/database');

const TTL_MS = 60 * 1000;
const cache = new Map(); // `${companyId}|${chaves}` -> { at, ids }

async function lerDoBanco(companyId, chaves) {
  const { rows } = await db.query(
    `SELECT owner_id AS user_id FROM companies WHERE id = $1 AND owner_id IS NOT NULL
     UNION
     SELECT cm.user_id
       FROM company_members cm
      WHERE cm.company_id = $1
        AND cm.user_id IS NOT NULL
        AND cm.status = 'active' AND cm.is_active = true
        AND (
          cm.permissions IS NULL
          OR EXISTS (
            SELECT 1 FROM jsonb_each_text(cm.permissions) kv
             WHERE kv.key = ANY($2::text[]) AND kv.value = 'true'
          )
        )`,
    [companyId, chaves]
  );
  return rows.map((r) => String(r.user_id));
}

async function somenteODono(companyId) {
  try {
    const { rows } = await db.query('SELECT owner_id FROM companies WHERE id = $1', [companyId]);
    return rows.length && rows[0].owner_id ? [String(rows[0].owner_id)] : [];
  } catch (_) {
    return [];
  }
}

/**
 * Ids de usuário que devem receber o aviso.
 *
 * @param {string} companyId
 * @param {object} [o]
 * @param {string[]} [o.chaves=['financeiro']] chaves de permissão que liberam o aviso
 * @param {(string|null)[]} [o.incluir]        sempre recebem (além da regra)
 * @param {string|null} [o.exceto]             nunca recebe (quem causou o evento)
 * @returns {Promise<string[]>}
 */
async function destinatarios(companyId, { chaves = ['financeiro'], incluir = [], exceto = null } = {}) {
  if (!companyId) return [];
  const lista = [...new Set((chaves || []).map(String))].sort();
  const chave = `${companyId}|${lista.join(',')}`;
  const hit = cache.get(chave);
  let ids;
  if (hit && Date.now() - hit.at < TTL_MS) {
    ids = hit.ids;
  } else {
    try {
      ids = await lerDoBanco(companyId, lista);
      cache.set(chave, { at: Date.now(), ids });
    } catch (err) {
      console.error('[destinatariosDoAviso] falha ao ler a equipe:', err.message);
      ids = await somenteODono(companyId);
    }
  }
  const out = new Set(ids);
  for (const id of incluir || []) if (id) out.add(String(id));
  if (exceto) out.delete(String(exceto));
  return [...out];
}

/** Limpa o cache (mudança na equipe, ou teste). */
function invalidar(companyId) {
  if (!companyId) { cache.clear(); return; }
  for (const k of cache.keys()) if (k.startsWith(`${companyId}|`)) cache.delete(k);
}

module.exports = { destinatarios, invalidar, _resetCache: () => cache.clear() };
