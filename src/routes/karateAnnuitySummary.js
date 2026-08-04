// ============================================================
// AURA KARATÊ — Fase F2/F3: KPIs do Hub de Anuidades
// GET /federation/:id/financial/annuities/summary?year=YYYY
//
// Os 4 KPIs do hub, agregados NO BANCO (nunca somados no cliente):
//   previsto   = total cobrado na temporada (TODAS as parcelas, pagas ou não)
//   recebido   = SUM(amount_paid) de TODAS as parcelas (F3 — ver nota abaixo)
//   em_aberto  = SALDO em aberto (amount - amount_paid) das parcelas
//                status<>'paid', vencida OU não
//   atrasado   = SALDO em aberto (amount - amount_paid) das parcelas
//                status<>'paid' E JÁ VENCIDA (due_date <= hoje)
// `valor` sempre soma dinheiro (previsto = recebido + em_aberto, sempre);
// `count` sempre soma PARCELAS (nº de linhas), não dinheiro — recebido_count
// conta só as INTEIRAMENTE quitadas (status='paid'); em_aberto_count/
// atrasado_count contam parcelas ainda não fechadas, mesmo as parciais
// (uma parcela com amount_paid>0 mas status='partial' ainda soma em
// em_aberto_count/valor pelo saldo restante — ela só sai de lá quando
// fechar de vez). Segmentado por `dojo`, por `praticante` e o `total`
// (soma dos dois).
//
// ⚠️ F3 (migration 247 já aplicada em produção, ver PR da reforma da
// anuidade): antes desta fase, `recebido`/`em_aberto`/`atrasado` eram
// BINÁRIOS (status='paid' vs status<>'paid', amount_paid não existia).
// Com applyAnnuityPayment aceitando baixa PARCIAL (status='partial',
// amount_paid < amount), o binário ficou incorreto: uma parcela de
// R$500 com R$300 já pagos contava R$0 em recebido e R$500 (o valor
// CHEIO, não o saldo de R$200) em em_aberto — subestimava recebido e
// SUPERESTIMAVA em_aberto/atrasado ao mesmo tempo. Corrigido para somar
// amount_paid/saldo real. previsto = recebido + em_aberto SEMPRE (era
// verdade antes, continua sendo agora — só ficou granular por centavo em
// vez de binário por parcela).
//
// Fonte única da regra ("não reimplemente a regra de status"): os mesmos
// limiares de karate_dojo_standing/karate_member_standing (migration 222) —
// vencida = due_date <= CURRENT_DATE, em_dia = nenhuma parcela vencida em
// aberto. As duas views NÃO são reaproveitadas diretamente aqui porque são
// fixas no ano corrente (EXTRACT(year FROM now())) e este endpoint aceita
// `?year=YYYY` arbitrário — a regra é replicada em SQL sobre
// karate_annuity_installments/karate_dojo_annuity_history, e os thresholds
// batem exatamente com os das views (conferido em produção, ver PR).
//
// Regras de negócio que este endpoint RESPEITA (CLAUDE.md):
//   - Só faixa-preta ATIVA entra no segmento `praticante` (join com
//     customers.is_active + karate_current_belt.belt_level='preta').
//     Praticante que perdeu a faixa preta ou ficou inativo depois de ter
//     sido cobrado SAI do KPI (mesmo comportamento de
//     karate_member_standing, que também filtra por estado atual).
//     Aceita `?member_status=active|inactive|all` (mesmo parâmetro/mesmo
//     default 'active' de GET /financial/annuities/cpf — ver
//     memberStatusToIsActiveValues em karateAnnuityService.js, IMPORTADO
//     daqui, não reimplementado, pra lista×KPI nunca divergirem no
//     critério de ativo/inativo do praticante). belt_level='preta'
//     permanece SEMPRE incondicional, nunca gated por member_status.
//   - Segmento `dojo` FILTRA por companies.is_active (decisão de produto,
//     Caio 21/07/2026: "não temos ação, não podemos cobrar e controlar os
//     inativos [...] o mesmo para indicadores e números absolutos, sempre
//     ativos primeiro"). Default é só dojô ATIVO — dojô inativo com saldo
//     em aberto NÃO infla previsto/recebido/em_aberto/atrasado por padrão.
//     Aceita `?dojo_status=active|inactive|all` (mesmo parâmetro e mesmo
//     default de GET /financial/annuities/dojos — ver dojoStatusToIsActiveValues
//     em karateAnnuityService.js, IMPORTADO daqui, não reimplementado, pra
//     lista×KPI nunca divergirem no critério de ativo/inativo).
//   - Ausência de cobrança nunca aparece aqui como "atrasado" — dojôs/
//     praticantes sem nenhuma parcela no ano simplesmente não somam em
//     nenhum bucket (não existe bucket "sem_cobranca" nos KPIs; ele é
//     visível nas listagens via status no_charge).
//
// Nomes de status ↔ listagens: os buckets `recebido`/`em_aberto`/`atrasado`
// usam os MESMOS nomes aceitos pelo filtro `status` de
// GET /financial/annuities/dojos e GET /financial/annuities/cpf:
//   recebido  → status=paid
//   em_aberto → status=em_aberto (alias: due ∪ overdue ∪ defaulting ∪ suspended)
//   atrasado  → status=atrasado  (alias: overdue ∪ defaulting ∪ suspended)
// `previsto` é o total (sem filtro de status na listagem = "Todos", exceto
// no_charge — a UI deve tratar o clique em Previsto como "limpar filtro").
// Ver STATUS_ALIASES em karateAnnuities.js.
//
// Guard: adminOnly() — financeiro é sensível (RBAC §7.3), mesmo padrão de
// karateAnnuities.js / karateOpenItems.js.
//
// Defensivo 42P01/42703: parcelas/header (migration 222) ou
// karate_current_belt ausentes (deployment parcial) → devolve zeros em vez
// de 500, nunca quebra o hub.
//
// NÃO tem `dojo_id` (Caio, 27/07/2026): este endpoint agrega TODA a
// federação, GROUPING SETS por `dojo`/`praticante`/`total` — filtrar por um
// único dojô quebraria o segmento `praticante` (que não tem noção de
// dojo_id, é por customers/faixa-preta) e o `total` (viraria mistura de um
// dojô + federação inteira de praticantes, sem sentido). Pra página de
// detalhe do dojô (Previsto/Recebido/Saldo daquele dojô), o frontend deve
// DERIVAR os 3 números a partir do registro já filtrado que
// GET /financial/annuities/dojos?dojo_id=<id> devolve, usando a MESMA
// fórmula deste arquivo (linha por linha, sobre `installments[]` do dojô):
//   previsto  = total (== soma de installments[].amount)
//   recebido  = paid_total (== soma de installments[].amount_paid)
//   em_aberto = soma, para installments com status <> 'paid', de
//               (amount - amount_paid)
//   atrasado  = igual a em_aberto, mas só installments com
//               due_date <= hoje
// Isso preserva a régua idêntica (mesma fórmula, mesma fonte de dados —
// karate_annuity_installments) sem inventar uma semântica de single-dojô
// pra um endpoint desenhado pra agregação federação-wide.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const annuitySvc = require('../services/karateAnnuityService');

function emptyBucket() {
  return { valor: 0, count: 0 };
}
function emptySegment() {
  return {
    previsto: emptyBucket(),
    recebido: emptyBucket(),
    em_aberto: emptyBucket(),
    atrasado: emptyBucket(),
  };
}
function emptySummary(year) {
  return {
    year,
    total: emptySegment(),
    dojo: emptySegment(),
    praticante: emptySegment(),
  };
}

function rowToSegment(row) {
  return {
    previsto: { valor: Number(row.previsto_valor || 0), count: parseInt(row.previsto_count || 0, 10) },
    recebido: { valor: Number(row.recebido_valor || 0), count: parseInt(row.recebido_count || 0, 10) },
    em_aberto: { valor: Number(row.em_aberto_valor || 0), count: parseInt(row.em_aberto_count || 0, 10) },
    atrasado: { valor: Number(row.atrasado_valor || 0), count: parseInt(row.atrasado_count || 0, 10) },
  };
}

// GROUPING SETS ((kind), ()) devolve 3 linhas numa query só: 'dojo',
// 'praticante' e uma linha com kind=NULL (o total geral) — evita 3 queries
// separadas e garante que total = dojo + praticante sempre (mesma fonte).
// dojo_status ($3, boolean[] ou NULL): mesmo critério/mesmo parâmetro de
// GET /financial/annuities/dojos (karateAnnuities.js) — companies.is_active
// do dojô. Aplicado só na perna 'dojo' do OR; a perna 'praticante' segue
// intocada (customers.is_active + faixa preta, regra própria dela).
// member_status ($4, boolean[] ou NULL): mesmo critério/mesmo parâmetro de
// GET /financial/annuities/cpf (karateAnnuities.js) — customers.is_active
// do praticante. Aplicado SÓ na perna 'praticante' do OR; a perna 'dojo'
// segue intocada. cb.belt_level = 'preta' permanece SEMPRE incondicional
// (nunca gated por member_status).
const SUMMARY_SQL = `
  WITH elig AS (
    SELECT i.amount, i.amount_paid, i.status, i.due_date,
           CASE WHEN h.dojo_id IS NOT NULL THEN 'dojo' ELSE 'praticante' END AS kind
    FROM karate_annuity_installments i
    JOIN karate_dojo_annuity_history h ON h.id = i.annuity_id
    LEFT JOIN customers cu ON cu.id = h.practitioner_id
    LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id
    LEFT JOIN companies c ON c.id = h.dojo_id
    WHERE h.federation_id = $1
      AND h.reference_period = $2
      AND (
        (
          h.dojo_id IS NOT NULL
          AND ($3::boolean[] IS NULL OR COALESCE(c.is_active, true) = ANY($3::boolean[]))
        )
        OR (
          h.practitioner_id IS NOT NULL
          AND ($4::boolean[] IS NULL OR COALESCE(cu.is_active, true) = ANY($4::boolean[]))
          AND cb.belt_level = 'preta'
        )
      )
  )
  SELECT
    kind,
    COUNT(*)::int AS previsto_count,
    COALESCE(SUM(amount), 0) AS previsto_valor,
    COUNT(*) FILTER (WHERE status = 'paid')::int AS recebido_count,
    COALESCE(SUM(amount_paid), 0) AS recebido_valor,
    COUNT(*) FILTER (WHERE status <> 'paid')::int AS em_aberto_count,
    COALESCE(SUM(amount - amount_paid) FILTER (WHERE status <> 'paid'), 0) AS em_aberto_valor,
    COUNT(*) FILTER (WHERE status <> 'paid' AND due_date IS NOT NULL AND due_date <= CURRENT_DATE)::int AS atrasado_count,
    COALESCE(SUM(amount - amount_paid) FILTER (WHERE status <> 'paid' AND due_date IS NOT NULL AND due_date <= CURRENT_DATE), 0) AS atrasado_valor
  FROM elig
  GROUP BY GROUPING SETS ((kind), ())
`;

// GET /financial/annuities/summary
router.get('/annuities/summary', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const year = (req.query.year && /^\d{4}$/.test(String(req.query.year)))
    ? String(req.query.year)
    : new Date().getFullYear().toString();
  // dojo_status: MESMO parâmetro/MESMO default ('active') de
  // GET /financial/annuities/dojos — parseDojoStatus/dojoStatusToIsActiveValues
  // vêm de karateAnnuityService.js pra garantir que o segmento `dojo` do
  // summary e a listagem usem exatamente o mesmo universo de dojôs.
  const dojoStatus = annuitySvc.parseDojoStatus(req.query.dojo_status);
  if (dojoStatus === null) {
    return res.status(422).json({
      error: `dojo_status inválido. Valores aceitos: ${annuitySvc.DOJO_STATUS_VALUES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const dojoStatusValues = annuitySvc.dojoStatusToIsActiveValues(dojoStatus);

  // member_status: MESMO parâmetro/MESMO default ('active') de
  // GET /financial/annuities/cpf — parseMemberStatus/memberStatusToIsActiveValues
  // vêm de karateAnnuityService.js pra garantir que o segmento `praticante`
  // do summary e a listagem CPF usem exatamente o mesmo universo.
  const memberStatus = annuitySvc.parseMemberStatus(req.query.member_status);
  if (memberStatus === null) {
    return res.status(422).json({
      error: `member_status inválido. Valores aceitos: ${annuitySvc.MEMBER_STATUS_VALUES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const memberStatusValues = annuitySvc.memberStatusToIsActiveValues(memberStatus);

  try {
    const { rows } = await db.query(SUMMARY_SQL, [federationId, year, dojoStatusValues, memberStatusValues]);
    const out = emptySummary(year);
    for (const row of rows) {
      const seg = rowToSegment(row);
      if (row.kind === 'dojo') out.dojo = seg;
      else if (row.kind === 'praticante') out.praticante = seg;
      else out.total = seg; // kind IS NULL -> linha do GROUPING SETS ()
    }
    res.json(out);
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') {
      console.warn('[karateAnnuitySummary] tabela/coluna ausente (', err.code, '), devolvendo zeros:', err.message);
      return res.json(emptySummary(year));
    }
    console.error('[karateAnnuitySummary] summary error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular resumo de anuidades' });
  }
});

module.exports = router;
