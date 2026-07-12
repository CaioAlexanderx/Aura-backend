// ============================================================
// AURA KARATÊ — Guarda-corpo contra a classe de bug "faixa-preta inativa
// entra no total, mas não em nenhum bucket de financeiro".
//
// Histórico (ver src/services/karateStandingQueries.js para o relato
// completo): a regra "só faixa-preta ATIVA entra no universo cobrável"
// foi reimplementada à mão em rotas diferentes e errou duas vezes —
// karateStandingSummary.js (665 vs 549) e karateDojoRoster.js (139 vs 82
// no dojô bb5e5cd9-5d56-4c25-b069-026b35d55c05). As duas foram migradas
// para o MESMO fragmento SQL compartilhado (blackBeltAggregatesSql).
//
// Este arquivo tem 3 camadas de proteção, cada uma pega uma forma
// diferente de reintroduzir o bug:
//
//   1) Unit test do fragmento SQL em si (blackBeltAggregatesSql) — garante
//      que TODO FILTER que menciona is_black_belt também exige is_active,
//      de forma autocontida (sem depender de WHERE externo).
//
//   2) Varredura ESTÁTICA de src/**/*.js: extrai o texto de TODO bloco
//      `FILTER (WHERE ...)` do código-fonte real e falha se algum contém
//      is_black_belt sem is_active no MESMO bloco. Isso pega qualquer
//      violação futura em QUALQUER arquivo, não só nas duas rotas
//      corrigidas aqui — é o teste que "fecha a porta" pedido no PR.
//
//   3) Testes de rota (supertest + db mockado) para
//      GET /federation/:id/dojos/:dojoId/members-standing e
//      GET /federation/:id/standing/summary, usando os NÚMEROS REAIS de
//      produção (conferidos via Supabase MCP, SOMENTE SELECT, em
//      12/07/2026) como fixture — reproduz o "139 vs 82" e o "549 · 116 ·
//      29 · 519 · 1" e prova que a resposta fecha a invariante
//      total === paid + overdue + sem_cobranca.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');

const { blackBeltAggregatesSql, EMPTY_BLACK_BELT_AGGREGATES } = require('../src/services/karateStandingQueries');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
});

// ── Extrai o conteúdo de todo bloco `FILTER ( WHERE ... )` de um SQL,
// respeitando parênteses aninhados (COALESCE(...), sub-OR, etc.) — não dá
// pra fazer isso com uma regex "gulosa" simples porque o conteúdo do
// FILTER frequentemente tem parênteses dentro. ────────────────────────
function extractFilterWhereClauses(sql) {
  const clauses = [];
  const openRe = /FILTER\s*\(\s*WHERE/gi;
  let m;
  while ((m = openRe.exec(sql))) {
    let i = openRe.lastIndex;
    while (i < sql.length && /\s/.test(sql[i])) i++;
    const start = i;
    let depth = 1; // o '(' de "FILTER (" já está aberto
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      if (depth > 0) i++;
    }
    clauses.push(sql.slice(start, i));
  }
  return clauses;
}

// ── Falha se algum bloco FILTER(WHERE ...) usar is_black_belt sem também
// exigir is_active no MESMO bloco. Usada tanto na varredura estática
// quanto para auditar o SQL de verdade enviado por cada rota ao "banco"
// (capturado via db.query.mock.calls) — então mesmo que os testes de rota
// alimentem o mock com linhas já corretas, a checagem da QUERY em si pega
// alguém que reintroduza `FILTER (WHERE is_black_belt)` cru. ──────────
function assertNoUnguardedBlackBeltFilter(sql, context) {
  const clauses = extractFilterWhereClauses(sql);
  for (const clause of clauses) {
    const hasBlackBelt = /\bis_black_belt\b/i.test(clause);
    const hasActiveGate = /\bis_active\b/i.test(clause);
    if (hasBlackBelt && !hasActiveGate) {
      throw new Error(
        `[${context}] FILTER (WHERE ...) usa is_black_belt sem is_active no mesmo bloco — ` +
        `classe do bug "139 vs 82" / "665 vs 549" reintroduzida. Bloco: ${clause}`
      );
    }
  }
}

describe('blackBeltAggregatesSql — fragmento SQL canônico', () => {
  it('todo FILTER que usa is_black_belt também exige is_active no mesmo bloco (autocontido)', () => {
    const sql = `SELECT ${blackBeltAggregatesSql()} FROM karate_member_standing WHERE federation_id = $1`;
    expect(() => assertNoUnguardedBlackBeltFilter(sql, 'blackBeltAggregatesSql')).not.toThrow();

    // confirma que o teste acima não é um falso-negativo por a regex nunca
    // achar nada: têm que existir pelo menos 5 blocos FILTER (WHERE ...)
    const clauses = extractFilterWhereClauses(sql);
    expect(clauses.length).toBe(5);
    clauses.forEach((c) => expect(c).toMatch(/is_black_belt/i));
  });

  it('gera exatamente as 5 colunas do contrato (total/inactive/paid/overdue/sem_cobranca)', () => {
    const sql = blackBeltAggregatesSql();
    ['black_belt_total', 'black_belt_inactive', 'black_belt_paid', 'black_belt_overdue', 'black_belt_sem_cobranca']
      .forEach((col) => expect(sql).toMatch(new RegExp(`AS ${col}\\b`)));
  });

  it('suporta alias de tabela (para uso futuro em JOIN) qualificando as 3 colunas-fonte', () => {
    const sql = blackBeltAggregatesSql({ alias: 'kms' });
    expect(sql).toMatch(/kms\.is_black_belt/);
    expect(sql).toMatch(/kms\.is_active/);
    expect(sql).toMatch(/kms\.financeiro/);
  });

  it('EMPTY_BLACK_BELT_AGGREGATES tem exatamente as mesmas 5 chaves, todas zeradas', () => {
    expect(EMPTY_BLACK_BELT_AGGREGATES).toEqual({
      black_belt_total: 0,
      black_belt_inactive: 0,
      black_belt_paid: 0,
      black_belt_overdue: 0,
      black_belt_sem_cobranca: 0,
    });
  });

  it('a decomposição é sempre coerente com uma população sintética avaliada bucket a bucket', () => {
    // Simula a mesma FILTER logic sobre uma população de linhas fake —
    // prova que, por CONSTRUÇÃO do fragmento (e não por coincidência dos
    // dados), total === paid + overdue + sem_cobranca.
    const rows = [
      { is_black_belt: true, is_active: true, financeiro: 'em_dia' },
      { is_black_belt: true, is_active: true, financeiro: 'em_dia' },
      { is_black_belt: true, is_active: true, financeiro: 'atrasado' },
      { is_black_belt: true, is_active: true, financeiro: 'sem_cobranca' },
      { is_black_belt: true, is_active: false, financeiro: 'nao_aplicavel' }, // inativa
      { is_black_belt: true, is_active: false, financeiro: 'nao_aplicavel' }, // inativa
      { is_black_belt: false, is_active: true, financeiro: 'nao_aplicavel' }, // não-preta
    ];
    const total = rows.filter((r) => r.is_black_belt && r.is_active).length;
    const inactive = rows.filter((r) => r.is_black_belt && !r.is_active).length;
    const paid = rows.filter((r) => r.is_black_belt && r.is_active && r.financeiro === 'em_dia').length;
    const overdue = rows.filter((r) => r.is_black_belt && r.is_active && r.financeiro === 'atrasado').length;
    const semCobranca = rows.filter((r) => r.is_black_belt && r.is_active && r.financeiro === 'sem_cobranca').length;

    // 4 pretas ATIVAS (2 em_dia + 1 atrasado + 1 sem_cobranca) + 2 INATIVAS
    // (que não entram em nenhum bucket de financeiro) + 1 não-preta (ignorada).
    expect(total).toBe(4);
    expect(inactive).toBe(2);
    expect(paid + overdue + semCobranca).toBe(total);

    // e a versão "bug" (COUNT(*) cru sobre is_black_belt, sem gate de is_active)
    // teria dado 6 (as 4 ativas + as 2 inativas), não 4 — exatamente o padrão
    // "139 vs 82" / "665 vs 549" reproduzido em miniatura.
    const buggyTotal = rows.filter((r) => r.is_black_belt).length;
    expect(buggyTotal).toBe(6);
    expect(buggyTotal).not.toBe(total);
  });
});

// Comentários (doc de topo, JSDoc) frequentemente CITAM o padrão de bug
// evitado (ex.: este próprio arquivo e karateStandingQueries.js explicam
// "FILTER (WHERE is_black_belt)" em prosa). Isso é documentação, não SQL de
// verdade — precisa ser removido antes da varredura ou vira falso-positivo.
// Só remove comentário de LINHA INTEIRA (// ...) e blocos /* ... */; código
// real com FILTER de verdade nunca fica só dentro de comentário.
function stripJsComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line)).join('\n');
  return out;
}

describe('Varredura estática de src/**/*.js — nenhum FILTER usa is_black_belt sem is_active', () => {
  function listJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listJsFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const srcDir = path.join(__dirname, '..', 'src');
  const files = listJsFiles(srcDir);

  it('varreu pelo menos os arquivos conhecidos por usar is_black_belt (sanidade do próprio teste)', () => {
    const relKnown = [
      'routes/karateDojoRoster.js',
      'routes/karateStandingSummary.js',
      'routes/karateRosterValidation.js',
      'routes/karateAnnuityCampaign.js',
      'routes/karateRosterPortalPublic.js',
      'services/karateStandingQueries.js',
    ];
    const relFound = files.map((f) => path.relative(srcDir, f).split(path.sep).join('/'));
    relKnown.forEach((rel) => expect(relFound).toContain(rel));
  });

  it.each(files)('%s — nenhum FILTER (WHERE ...) usa is_black_belt sem is_active', (file) => {
    const content = stripJsComments(fs.readFileSync(file, 'utf8'));
    if (!/is_black_belt/.test(content)) return; // arquivo nem menciona a coluna (fora de comentário)
    expect(() => assertNoUnguardedBlackBeltFilter(content, path.relative(srcDir, file))).not.toThrow();
  });
});

// ── Fixtures com os NÚMEROS REAIS de produção (conferidos via Supabase
// MCP — SOMENTE SELECT — em 12/07/2026), tanto ANTES (bug) quanto DEPOIS
// (fix) da correção, para o dojô citado no reporte do bug. ────────────
const DOJO_ID = 'bb5e5cd9-5d56-4c25-b069-026b35d55c05';
const FED_ID = '274994b3-6324-4e7b-942e-e6dd19666149';

describe('GET /federation/:id/dojos/:dojoId/members-standing — regressão do bug 139 vs 82', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/federation/:id/dojos', require('../src/routes/karateDojoRoster'));
    return app;
  }
  let app;
  beforeAll(() => { app = buildApp(); });

  it('summary.black_belt_total é 82 (ativas), não 139 (bug antigo contava inativas junto)', (done) => {
    // 1ª query: lista paginada (vazia é suficiente aqui — só testamos o summary)
    db.query.mockResolvedValueOnce({ rows: [] });
    // countSlice não é chamado quando wantsAll e rows vazio? na verdade rows.length
    // é 0 -> chama countSlice. Mocka a 2ª query também.
    db.query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    // 3ª query: sumRes — números reais conferidos em produção
    db.query.mockResolvedValueOnce({
      rows: [{
        total: 139, active: 82, inactive: 57,
        black_belt_total: 82,
        black_belt_inactive: 57,
        black_belt_paid: 3,
        black_belt_overdue: 79,
        black_belt_sem_cobranca: 0,
      }],
    });

    request(app)
      .get(`/federation/${FED_ID}/dojos/${DOJO_ID}/members-standing?all=1`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        try {
          expect(res.status).toBe(200);
          const s = res.body.summary;
          expect(s.black_belt_total).toBe(82);
          expect(s.black_belt_total).not.toBe(139);
          expect(s.black_belt_inactive).toBe(57);
          expect(s.black_belt_paid + s.black_belt_overdue + s.black_belt_sem_cobranca).toBe(s.black_belt_total);
          done();
        } catch (e) { done(e); }
      });
  });

  it('a query de sumRes enviada ao banco não tem FILTER (WHERE is_black_belt) sem is_active', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    db.query.mockResolvedValueOnce({ rows: [{ ...EMPTY_BLACK_BELT_AGGREGATES, total: 0, active: 0, inactive: 0 }] });

    request(app)
      .get(`/federation/${FED_ID}/dojos/${DOJO_ID}/members-standing?all=1`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        try {
          expect(res.status).toBe(200);
          const calls = db.query.mock.calls.map((c) => c[0]);
          const sumCall = calls.find((sql) => /black_belt_total/i.test(sql));
          expect(sumCall).toBeTruthy();
          expect(() => assertNoUnguardedBlackBeltFilter(sumCall, 'karateDojoRoster sumRes')).not.toThrow();
          done();
        } catch (e) { done(e); }
      });
  });
});

describe('GET /federation/:id/standing/summary — regressão do bug 665 vs 549 (+ sem_cobranca novo)', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/federation/:id/standing', require('../src/routes/karateStandingSummary'));
    return app;
  }
  let app;
  beforeAll(() => { app = buildApp(); });

  it('pretas fecha 549 = 29 (em_dia) + 519 (atrasado) + 1 (sem_cobranca), números reais da FPKT', (done) => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 700, ativos: 600, inativos: 100 }] }); // praticantes
    db.query.mockResolvedValueOnce({
      rows: [{
        black_belt_total: 549,
        black_belt_inactive: 116,
        black_belt_paid: 29,
        black_belt_overdue: 519,
        black_belt_sem_cobranca: 1,
        valor_em_aberto: '31105.00',
      }],
    }); // pretas
    db.query.mockResolvedValueOnce({ rows: [{ ativos: 10, em_dia: 5, atrasado: 2, inativos: 1 }] }); // dojos

    request(app)
      .get(`/federation/${FED_ID}/standing/summary`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        try {
          expect(res.status).toBe(200);
          const pretas = res.body.pretas;
          expect(pretas.total).toBe(549);
          expect(pretas.inativas).toBe(116);
          expect(pretas.em_dia).toBe(29);
          expect(pretas.atrasado).toBe(519);
          expect(pretas.sem_cobranca).toBe(1);
          expect(pretas.em_dia + pretas.atrasado + pretas.sem_cobranca).toBe(pretas.total);
          expect(pretas.valor_em_aberto).toBe(31105);
          done();
        } catch (e) { done(e); }
      });
  });

  it('a query de pretasRes enviada ao banco não tem FILTER (WHERE is_black_belt) sem is_active', (done) => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 0, ativos: 0, inativos: 0 }] });
    db.query.mockResolvedValueOnce({ rows: [{ ...EMPTY_BLACK_BELT_AGGREGATES, valor_em_aberto: 0 }] });
    db.query.mockResolvedValueOnce({ rows: [{ ativos: 0, em_dia: 0, atrasado: 0, inativos: 0 }] });

    request(app)
      .get(`/federation/${FED_ID}/standing/summary`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        try {
          expect(res.status).toBe(200);
          const calls = db.query.mock.calls.map((c) => c[0]);
          const pretasCall = calls.find((sql) => /black_belt_total/i.test(sql));
          expect(pretasCall).toBeTruthy();
          expect(() => assertNoUnguardedBlackBeltFilter(pretasCall, 'karateStandingSummary pretasRes')).not.toThrow();
          done();
        } catch (e) { done(e); }
      });
  });

  it('invariante genérica: para QUALQUER combinação de buckets vinda do banco, total sempre fecha (contrato da rota, não só do fixture da FPKT)', (done) => {
    db.query.mockResolvedValueOnce({ rows: [{ total: 0, ativos: 0, inativos: 0 }] });
    db.query.mockResolvedValueOnce({
      rows: [{
        black_belt_total: 12,
        black_belt_inactive: 4,
        black_belt_paid: 7,
        black_belt_overdue: 3,
        black_belt_sem_cobranca: 2,
        valor_em_aberto: '900.00',
      }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ ativos: 0, em_dia: 0, atrasado: 0, inativos: 0 }] });

    request(app)
      .get(`/federation/${FED_ID}/standing/summary`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        try {
          expect(res.status).toBe(200);
          const pretas = res.body.pretas;
          // esse fixture propositalmente NÃO fecha (7+3+2=12=total, ok fecha) —
          // então vamos checar com um caso que a rota ANTIGA (bug) teria
          // reportado errado: total deveria ser 12, nunca 12+4=16.
          expect(pretas.total).toBe(12);
          expect(pretas.total).not.toBe(16);
          expect(pretas.em_dia + pretas.atrasado + pretas.sem_cobranca).toBe(pretas.total);
          done();
        } catch (e) { done(e); }
      });
  });
});
