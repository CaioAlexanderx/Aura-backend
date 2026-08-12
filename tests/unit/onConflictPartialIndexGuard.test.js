// ============================================================
// AURA — TRAVA ESTÁTICA: ON CONFLICT × índice único PARCIAL / por EXPRESSÃO
//
// ── O bug que este teste congela ────────────────────────────
// O Postgres só infere um índice único PARCIAL quando a especificação do
// `ON CONFLICT` REPETE o predicado dele; e só infere um índice por
// EXPRESSÃO quando a especificação REPETE a expressão. Fora disso ele
// devolve **42P10** ("there is no unique or exclusion constraint matching
// the ON CONFLICT specification").
//
// 42P10 é traiçoeiro por três motivos, todos vividos em produção:
//   1. não é 42P01 nem 42703, então os `safeStep`/degradações defensivas
//      espalhadas pelo repo NÃO o reconhecem — o erro sobe;
//   2. sobe de dentro de um BEGIN, então derruba a TRANSAÇÃO INTEIRA:
//      a validação passou, as escritas de negócio passaram, e o ato morre
//      no último passo. Para quem olha de fora, "nada aconteceu";
//   3. a rota traduz para 500 genérico, sem pista nenhuma da causa.
//
// Aconteceu duas vezes:
//   • 11/08/2026 — trilha da assunção do registro federativo (F11):
//     `ON CONFLICT (request_id)` contra
//     `uq_karate_dojo_registry_assumptions_request ... WHERE request_id IS
//     NOT NULL`. Travou o QA da F11 em produção por horas;
//   • import de extrato OFX (`src/routes/transactionsBatch.js`):
//     `ON CONFLICT (company_id, fitid)` contra
//     `idx_transactions_fitid_company ... WHERE fitid IS NOT NULL`.
//     Achado nesta varredura preventiva — nunca havia teste nenhum.
//
// ── Por que uma trava ESTÁTICA ──────────────────────────────
// Nenhum teste de unidade com mock de SQL pega isto: o mock devolve o que
// mandarem, e 42P10 só existe no planejador do Postgres real. O que dá para
// congelar em CI, sem banco, é a SINTAXE — e é exatamente ela que estava
// errada nas duas vezes.
//
// ── O catálogo é um retrato do BANCO, não um palpite ────────
// PARTIAL_INDEXES/EXPRESSION_INDEXES abaixo saíram de uma consulta a
// `pg_index` em PRODUÇÃO (`indpred IS NOT NULL` / `indexprs IS NOT NULL`),
// não de leitura das migrations. Migration não é verdade: a verdade é o
// índice que está lá.
//
// ⚠️ SE UM ÍNDICE MUDAR, MUDE AQUI JUNTO. Um índice que deixa de ser
// parcial faz o `WHERE` do código virar erro; um que PASSA a ser parcial
// precisa entrar nesta lista para o próximo `ON CONFLICT` nascer certo.
//
// ── Escopo, de propósito estreito ───────────────────────────
// A regra só dispara quando o arbiter casa EXATAMENTE com a chave de um
// índice catalogado. `ON CONFLICT (idempotency_key)` em `transactions`, por
// exemplo, é legítimo: além do parcial existe `transactions_idempotency_key_key`,
// UNIQUE TOTAL, e é ele que o Postgres infere. Idem
// `ON CONFLICT (product_id, category_id)` em product_category_links (é a PK).
// Um teste que reclamasse desses seria ruído e seria desligado na primeira
// semana.
//
// `ON CONFLICT DO NOTHING` sem lista (forma "bare") e
// `ON CONFLICT ON CONSTRAINT x` são IMUNES a 42P10 — não fazem inferência
// por especificação. São ignorados, não aprovados.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

// ── Índices únicos PARCIAIS em produção (pg_index.indpred IS NOT NULL) ──
// `arbiter` é a chave normalizada (minúscula, sem espaços). `predicate` é o
// que o `ON CONFLICT` precisa repetir — testado por regex frouxa porque o
// código pode escrever `status='pending'` ou `status = 'pending'`.
const PARTIAL_INDEXES = [
  // ── dojô / federação (as tabelas que o importador dos 484 toca) ──
  { table: 'karate_dojo_students', arbiter: 'dojo_id,cpf', index: 'uq_karate_dojo_students_dojo_cpf', predicate: /cpf\s+is\s+not\s+null/i, human: 'WHERE cpf IS NOT NULL' },
  { table: 'karate_dojo_students', arbiter: 'practitioner_id', index: 'uq_karate_dojo_students_practitioner', predicate: /practitioner_id\s+is\s+not\s+null/i, human: 'WHERE practitioner_id IS NOT NULL' },
  { table: 'karate_dojo_subscriptions', arbiter: 'student_id', index: 'uq_karate_dojo_subscriptions_active_student', predicate: /canceled_at\s+is\s+null/i, human: 'WHERE canceled_at IS NULL' },
  { table: 'karate_dojo_annuity_history', arbiter: 'dojo_id,reference_period', index: 'uq_kdah_dojo_period', predicate: /dojo_id\s+is\s+not\s+null/i, human: 'WHERE dojo_id IS NOT NULL' },
  { table: 'karate_dojo_annuity_history', arbiter: 'practitioner_id,reference_period', index: 'uq_kdah_practitioner_period', predicate: /practitioner_id\s+is\s+not\s+null/i, human: 'WHERE practitioner_id IS NOT NULL' },
  { table: 'karate_dojo_roster_reviews', arbiter: 'dojo_id', index: 'uq_kdrr_one_open_per_dojo', predicate: /status\s*=\s*'in_progress'/i, human: "WHERE status = 'in_progress'" },
  { table: 'karate_affiliation_requests', arbiter: 'dojo_id', index: 'uq_karate_affiliation_requests_pending', predicate: /status\s*=\s*'pending'/i, human: "WHERE status = 'pending'" },
  { table: 'karate_practitioner_requests', arbiter: 'dojo_id,dedup_key', index: 'uq_karate_practitioner_requests_pending_dedup', predicate: /status\s*=\s*'pendente'/i, human: "WHERE status = 'pendente'" },
  { table: 'karate_dojo_registry_assumptions', arbiter: 'request_id', index: 'uq_karate_dojo_registry_assumptions_request', predicate: /request_id\s+is\s+not\s+null/i, human: 'WHERE request_id IS NOT NULL' },
  { table: 'karate_membership_cards', arbiter: 'student_id', index: 'uq_kmc_active_per_student', predicate: /status\s*=\s*'active'/i, human: "WHERE status = 'active'" },
  { table: 'karate_reminder_log', arbiter: 'annuity_id,rule_code,channel', index: 'uq_karate_reminder_once', predicate: /status\s*=\s*'sent'/i, human: "WHERE status = 'sent' AND rule_code <> 'manual'" },
  { table: 'customers', arbiter: 'karate_registration_number', index: 'idx_customers_karate_reg_number', predicate: /karate_registration_number\s+is\s+not\s+null/i, human: 'WHERE karate_registration_number IS NOT NULL' },
  { table: 'customers', arbiter: 'federation_id,karate_registration_number', index: 'uq_customers_federation_fpkt', predicate: /federation_id\s+is\s+not\s+null/i, human: 'WHERE federation_id IS NOT NULL AND ...' },
  { table: 'companies', arbiter: 'owner_id', index: 'uq_companies_primary_per_owner', predicate: /is_primary/i, human: 'WHERE is_primary = true AND is_active = true' },
  { table: 'companies', arbiter: 'slug', index: 'uq_companies_slug_karate_federation', predicate: /vertical/i, human: "WHERE slug IS NOT NULL AND vertical = 'karate_federation'" },

  // ── núcleo (mesma classe de bug, mesmo estrago) ──
  { table: 'transactions', arbiter: 'company_id,fitid', index: 'idx_transactions_fitid_company', predicate: /fitid\s+is\s+not\s+null/i, human: 'WHERE fitid IS NOT NULL' },
  { table: 'bank_statement_entries', arbiter: 'bank_account_id,fitid', index: 'idx_bank_entries_fitid', predicate: /fitid\s+is\s+not\s+null/i, human: 'WHERE fitid IS NOT NULL' },
  { table: 'caixa_sessoes', arbiter: 'company_id', index: 'uq_caixa_sessao_aberta_por_empresa', predicate: /status\s*=\s*'aberta'/i, human: "WHERE status = 'aberta'" },
  { table: 'employees', arbiter: 'company_id,cpf', index: 'employees_company_id_cpf_key', predicate: /cpf\s+is\s+not\s+null/i, human: 'WHERE cpf IS NOT NULL' },
  { table: 'freelancers', arbiter: 'company_id,doc', index: 'uq_freelancers_company_doc_active', predicate: /is_active/i, human: 'WHERE is_active = true AND doc IS NOT NULL' },
  { table: 'coupon_redemptions', arbiter: 'company_id,code_id', index: 'uq_coupon_redemption_company_code', predicate: /code_id\s+is\s+not\s+null/i, human: 'WHERE code_id IS NOT NULL' },
  { table: 'commission_rules', arbiter: 'company_id', index: 'idx_commission_rules_global', predicate: /employee_id\s+is\s+null/i, human: 'WHERE employee_id IS NULL' },
  { table: 'sales_goals', arbiter: 'company_id,period', index: 'idx_sales_goals_global', predicate: /employee_id\s+is\s+null/i, human: 'WHERE employee_id IS NULL' },
  { table: 'products', arbiter: 'company_id,master_sku', index: 'uq_products_master_sku_per_company', predicate: /master_sku\s+is\s+not\s+null/i, human: 'WHERE master_sku IS NOT NULL AND is_active = true' },
  { table: 'product_categories', arbiter: 'company_id,type,path', index: 'product_categories_unique_path', predicate: /path\s+is\s+not\s+null/i, human: 'WHERE path IS NOT NULL' },
  { table: 'product_category_links', arbiter: 'product_id', index: 'product_category_links_one_primary', predicate: /is_primary/i, human: 'WHERE is_primary' },
];

// ── Índices únicos por EXPRESSÃO (pg_index.indexprs IS NOT NULL) ──
// Aqui o erro não é esquecer um WHERE, é escrever a COLUNA CRUA no lugar da
// expressão. `bare` é a forma errada que precisa ser barrada; `right` é o
// que o Postgres consegue inferir.
const EXPRESSION_INDEXES = [
  { table: 'karate_dojo_tags', bare: 'dojo_id,name', right: 'ON CONFLICT (dojo_id, lower(name))', index: 'uq_karate_dojo_tags_dojo_name_ci' },
  { table: 'category_migration_staging', bare: 'company_id,raw_value', right: "ON CONFLICT (company_id, COALESCE(raw_value, '__NULL__'))", index: 'category_migration_staging_unique' },
  { table: 'product_categories', bare: 'company_id,type,parent_id,name_norm', right: "ON CONFLICT (company_id, type, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name_norm)", index: 'product_categories_unique_sibling' },
];

// ── Varredura ───────────────────────────────────────────────
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Parênteses CASADOS na mão. Uma regex `\(([^)]*)\)` cortaria
// `ON CONFLICT (dojo_id, lower(name))` em `dojo_id, lower(name` e o teste
// passaria a mentir exatamente no caso que ele existe para pegar.
function extractOnConflicts(text) {
  const found = [];
  const re = /ON\s+CONFLICT/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    // `ON CONFLICT ON CONSTRAINT nome` — nomeia a constraint, não infere.
    if (text.slice(i, i + 13).toUpperCase() === 'ON CONSTRAINT') continue;
    // forma "bare": `ON CONFLICT DO NOTHING` — não infere por especificação.
    if (text[i] !== '(') continue;

    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') {
        depth -= 1;
        if (depth === 0) { j += 1; break; }
      }
    }
    const arbiterRaw = text.slice(i + 1, j - 1);
    const rest = text.slice(j, j + 400);
    const doAt = rest.search(/\bDO\s+(NOTHING|UPDATE)\b/i);
    const between = doAt >= 0 ? rest.slice(0, doAt) : rest;

    // Tabela alvo = o `INSERT INTO` mais próximo ANTES desta ocorrência.
    const before = text.slice(0, m.index);
    const inserts = before.match(/INSERT\s+INTO\s+[a-zA-Z_][A-Za-z0-9_]*/gi) || [];
    const last = inserts.length ? inserts[inserts.length - 1] : '';
    const table = last ? last.split(/\s+/).pop().toLowerCase() : null;

    found.push({
      table,
      arbiter: arbiterRaw.replace(/\s+/g, '').toLowerCase(),
      arbiterRaw: arbiterRaw.trim(),
      predicate: between.trim(),
      line: before.split('\n').length,
    });
  }
  return found;
}

const FILES = listJsFiles(SRC_DIR);
const SITES = FILES.flatMap((file) =>
  extractOnConflicts(fs.readFileSync(file, 'utf8')).map((s) => ({
    ...s,
    file: path.relative(path.join(__dirname, '..', '..'), file).replace(/\\/g, '/'),
  }))
);

describe('ON CONFLICT × índices PARCIAIS e por EXPRESSÃO (42P10)', () => {
  // Âncora anti-vácuo: se a varredura parar de achar arquivos (refactor de
  // pastas, glob quebrado), os testes abaixo passariam por VÁCUO — zero
  // ocorrência, zero falha. Este caso derruba o CI antes disso.
  test('a varredura enxerga src/ e encontra ON CONFLICT de verdade', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(SITES.length).toBeGreaterThan(5);
  });

  test('todo ON CONFLICT sobre índice PARCIAL repete o predicado do índice', () => {
    const offenders = [];
    for (const site of SITES) {
      if (!site.table) continue;
      for (const idx of PARTIAL_INDEXES) {
        if (idx.table !== site.table || idx.arbiter !== site.arbiter) continue;
        if (!idx.predicate.test(site.predicate)) {
          offenders.push(
            `${site.file}:~${site.line} — INSERT INTO ${site.table} ` +
            `ON CONFLICT (${site.arbiterRaw}) mira o índice PARCIAL ${idx.index}, ` +
            `mas não repete o predicado. Escreva: ON CONFLICT (${site.arbiterRaw}) ${idx.human} DO ...`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('todo ON CONFLICT sobre índice por EXPRESSÃO repete a expressão', () => {
    const offenders = [];
    for (const site of SITES) {
      if (!site.table) continue;
      for (const idx of EXPRESSION_INDEXES) {
        if (idx.table !== site.table || idx.bare !== site.arbiter) continue;
        offenders.push(
          `${site.file}:~${site.line} — INSERT INTO ${site.table} ` +
          `ON CONFLICT (${site.arbiterRaw}) usa a coluna crua, mas o índice ${idx.index} ` +
          `é por EXPRESSÃO. Escreva: ${idx.right}`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  // Sites conhecidos que DEVEM continuar com o predicado — se alguém
  // "limpar" o WHERE achando que é redundante, cai aqui com nome e endereço,
  // não numa falha genérica de lista vazia.
  test('os dois sites já corrigidos continuam com o predicado', () => {
    const trail = SITES.find(
      (s) => s.table === 'karate_dojo_registry_assumptions' && s.arbiter === 'request_id'
    );
    expect(trail).toBeDefined();
    expect(trail.predicate).toMatch(/where\s+request_id\s+is\s+not\s+null/i);

    const ofx = SITES.find((s) => s.table === 'transactions' && s.arbiter === 'company_id,fitid');
    expect(ofx).toBeDefined();
    expect(ofx.file).toBe('src/routes/transactionsBatch.js');
    expect(ofx.predicate).toMatch(/where\s+fitid\s+is\s+not\s+null/i);
  });

  // O parser é a parte que pode mentir em silêncio. Estes casos provam que
  // ele lê o que promete ler — inclusive parêntese aninhado.
  describe('o parser (a parte que poderia mentir em silêncio)', () => {
    test('não corta parêntese aninhado', () => {
      const out = extractOnConflicts(
        "INSERT INTO karate_dojo_tags (dojo_id, name) VALUES ($1,$2) ON CONFLICT (dojo_id, lower(name)) DO UPDATE SET updated_at = now()"
      );
      expect(out).toHaveLength(1);
      expect(out[0].table).toBe('karate_dojo_tags');
      expect(out[0].arbiter).toBe('dojo_id,lower(name)');
    });

    test('lê o predicado entre a lista e o DO', () => {
      const out = extractOnConflicts(
        'INSERT INTO transactions (a) VALUES ($1) ON CONFLICT (company_id, fitid) WHERE fitid IS NOT NULL DO NOTHING'
      );
      expect(out[0].predicate).toMatch(/where\s+fitid\s+is\s+not\s+null/i);
    });

    test('ignora a forma bare e o ON CONSTRAINT (imunes a 42P10)', () => {
      expect(extractOnConflicts('INSERT INTO customers (a) VALUES ($1) ON CONFLICT DO NOTHING')).toHaveLength(0);
      expect(
        extractOnConflicts('INSERT INTO customers (a) VALUES ($1) ON CONFLICT ON CONSTRAINT customers_pkey DO NOTHING')
      ).toHaveLength(0);
    });

    test('aceita ON CONFLICT colado no parêntese (salesGoals.js é minificado)', () => {
      const out = extractOnConflicts(
        'INSERT INTO employee_goals(a) VALUES($1) ON CONFLICT(company_id,employee_id,reference_month) DO UPDATE SET a=1'
      );
      expect(out[0].arbiter).toBe('company_id,employee_id,reference_month');
    });

    test('a regra PEGA a regressão (prova que não passa por vácuo)', () => {
      const bad = extractOnConflicts(
        'INSERT INTO transactions (a) VALUES ($1) ON CONFLICT (company_id, fitid) DO NOTHING'
      )[0];
      const idx = PARTIAL_INDEXES.find(
        (i) => i.table === 'transactions' && i.arbiter === 'company_id,fitid'
      );
      expect(idx.predicate.test(bad.predicate)).toBe(false);
    });
  });
});
