// ============================================================
// AURA DOJÔ — Status de CONEXÃO do dojô com a federação (helper ÚNICO)
//
// MODELO (migration 251, PR #420) — companies.karate_dojo_linked_at:
//   NULL     = dojô self-serve AINDA NÃO conectado à federação
//   NOT NULL = conectado/filiado (timestamp do vínculo)
//
// companies.federation_id é vínculo TÉCNICO (roteamento das rotas
// /federation/:id/dojo/* + guard requireDojoAccess) — NÃO é conexão.
//
// O PR #420 fechou o lado da FEDERAÇÃO (ela não enxerga dojô não
// conectado: listas, contagens, agregados, campanha, régua, saúde da
// rede). Este helper fecha o lado INVERSO, encontrado no QA de produção:
// o dojô não conectado NÃO enxerga nem escreve nas superfícies
// FEDERATIVAS (eventos/exames da federação, anuidade de filiação,
// solicitação de praticante).
//
// NÃO gateia NADA interno do dojô (alunos, turmas, presença,
// mensalidades, Conta Aura/BaaS) — o shell do dojô é 100% funcional
// conectado ou não. Ver a tabela no PR.
//
// FAIL-OPEN por decisão (defensivo 42703/42P01): qualquer erro — coluna
// ausente (migration 251 não aplicada), tabela ausente, falha transitória
// — devolve linked:true. Esconder conteúdo de quem JÁ usa por causa de
// uma coluna que ainda não existe é pior que mostrar demais num caso
// novo: todos os dojôs existentes hoje foram criados PELA federação (o
// backfill da 251 os marca como conectados), então o default correto na
// dúvida é "conectado".
//
// Sem memoização de propósito: a query é um SELECT de 1 coluna por id
// (índice PK) e um flag module-level tornaria o estado dependente da
// ordem dos testes/requisições.
// ============================================================
'use strict';

const db = require('../config/database');

// timestamptz → ISO 8601 UTC (contrato publicado do campo linked_at).
// O driver pg devolve Date; um provider/driver diferente pode devolver
// string — normalizamos os dois. Se não der para interpretar, devolve o
// valor cru em vez de mentir null (o front só precisa exibir a data).
function toIsoOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// getDojoLinkStatus(dojoId) → { linked: boolean, linked_at: string|null }
// linked_at é ISO 8601 UTC (ex.: '2026-07-25T17:12:05.000Z') ou null.
async function getDojoLinkStatus(dojoId) {
  if (!dojoId) return { linked: true, linked_at: null };

  try {
    const result = await db.query(
      `SELECT karate_dojo_linked_at FROM companies WHERE id = $1 LIMIT 1`,
      [dojoId]
    );
    const rows = (result && result.rows) || [];
    // Company inexistente: não é papel deste helper decidir 404 — quem
    // chama já tem (ou terá) o próprio lookup. Fail-open.
    if (!rows.length) return { linked: true, linked_at: null };

    const value = rows[0].karate_dojo_linked_at;
    if (value === null || value === undefined) return { linked: false, linked_at: null };
    return { linked: true, linked_at: toIsoOrNull(value) };
  } catch (err) {
    if (err && err.code === '42703') {
      // Coluna karate_dojo_linked_at ausente → migration 251 pendente.
      console.warn('[karateDojoLinkStatus] karate_dojo_linked_at ausente (migration 251 pendente) — fail-open linked=true');
      return { linked: true, linked_at: null };
    }
    if (err && err.code === '42P01') {
      console.warn('[karateDojoLinkStatus] tabela companies ausente (schema pendente) — fail-open linked=true');
      return { linked: true, linked_at: null };
    }
    console.error('[karateDojoLinkStatus] falha ao ler status de conexão (fail-open):', err.message);
    return { linked: true, linked_at: null };
  }
}

// Açúcar para os pontos que só precisam do booleano.
async function isDojoLinked(dojoId) {
  const status = await getDojoLinkStatus(dojoId);
  return status.linked;
}

module.exports = { getDojoLinkStatus, isDojoLinked };
